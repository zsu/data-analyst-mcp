/**
 * USAspending adapter (port of the Python adapter.py): fiscal-year periods, award type groups, agency and state
 * names, POST paging links.
 *
 * - checkSpec: fiscal years before FY2008 and dates before 2007-10-01 are refused before any request (the search
 *   API answers HTTP 422 for them); award type codes must come from ONE group; the awards endpoint needs an award type.
 * - beforeRequest: the convenience parameters (fiscal_year, start_date/end_date, award_type, keyword, state,
 *   agency, funding_agency, recipient) become the API's "filters" object; an explicit "filters" object is merged
 *   over them. Agencies are given by toptier code, catalog alias or name; states by USPS code, FIPS or name.
 * - normalize: over_time rows get `fiscal_period` and `period_start`; award rows get `award_url`.
 * - manualItems: POST links with page/limit in the JSON body.
 * Errors are never swallowed: a failing call stops the fetch.
 */
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyStr, pyUrlencode } from "../core/py.js";
import { pyRepr, state as stateCode, StateError } from "./_usaspending_state.js";

const FLOOR = "2007-10-01";

/** Python's ValueError inside this adapter (bad agency, state or year). */
class ValueError extends Error {}

const eps = (): any => readJson(path.join(PACKS_DIR, "usaspending"), "endpoints.json") || {};

function st(x: unknown, as: "usps" | "fips" = "usps"): string {
  try {
    return stateCode(x, as);
  } catch (e) {
    if (e instanceof StateError) throw new ValueError(e.message);
    throw e;
  }
}

function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v.trim(), 10);
  throw new ValueError(`invalid literal for int(): ${pyRepr(v)}`);
}

function groups(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const c of Object.values<any>(eps().catalog)) if (c.kind === "award_type") m.set(c.id, c.codes);
  return m;
}

function awardCodes(v0: unknown): string[] {
  const g = groups();
  let v: any = v0;
  if (typeof v === "string" && g.has(v.trim().toLowerCase())) return [...g.get(v.trim().toLowerCase())!];
  if (typeof v === "string") v = v.split(",").map((s) => s.trim()).filter(Boolean);
  return [...v].map(pyStr);
}

/** Names of the search-API groups (the set the API validates against) the codes fall in. */
function codeGroup(codes: string[]): string[] {
  const base = [...groups()].filter(([k]) => k !== "insurance").map(([k, v]) => [k, new Set(v)] as const);
  const out = new Set<string>();
  for (const c of codes) for (const [g, s] of base) if (s.has(c)) out.add(g);
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function fyBounds(fy: unknown): [string, string] {
  let a: number, b: number;
  if (Array.isArray(fy)) {
    if (!fy.length) throw new ValueError("empty fiscal_year list");
    [a, b] = [pyInt(fy[0]), pyInt(fy[fy.length - 1])];
  } else a = b = pyInt(fy);
  return [`${a - 1}-10-01`, `${b}-09-30`];
}

function agencyName(x: unknown): string {
  const cat: Record<string, any> = eps().catalog;
  const s = pyStr(x).trim();
  const byCode = new Map<string, any>();
  for (const c of Object.values<any>(cat)) if (c.kind === "agency") byCode.set(c.id, c);
  if (byCode.has(s)) return byCode.get(s).name;
  if (s.toLowerCase() in cat && cat[s.toLowerCase()].kind === "agency") return cat[s.toLowerCase()].name;
  const names: string[] = [...byCode.values()].map((c) => c.name);
  const exact = names.filter((n) => n.toLowerCase() === s.toLowerCase());
  if (exact.length) return exact[0];
  const part = names.filter((n) => n.toLowerCase().includes(s.toLowerCase()));
  if (part.length === 1) return part[0];
  const hint = part.length ? ` Did you mean: ${part.slice(0, 6).join("; ")}?` : " Search the catalog with request_schema.";
  throw new ValueError(`agency ${pyRepr(x)} is not a toptier agency code, alias or unique name.${hint}`);
}

function toptierCode(x: unknown): string {
  const cat: Record<string, any> = eps().catalog;
  const s = pyStr(x).trim();
  if (/^\d{3,4}$/.test(s)) return s;
  if (s.toLowerCase() in cat && cat[s.toLowerCase()].kind === "agency") return cat[s.toLowerCase()].id;
  const n = agencyName(s);
  return Object.values<any>(cat).find((c) => c.kind === "agency" && c.name === n).id;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  const E = eps().endpoints;
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    const ep = E[r.endpoint || ""] || {};
    const name = pyRepr(r.name);
    const fy = p.fiscal_year;
    if (fy !== null && fy !== undefined) {
      try {
        const [start] = fyBounds(fy);
        if (start < FLOOR) {
          probs.push(`request ${name}: fiscal_year ${Array.isArray(fy) ? pyRepr(fy) : pyStr(fy)} is before FY2008; the ` +
            "search API starts at 2007-10-01 (older data: the bulk download files on usaspending.gov)");
        }
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        probs.push(`request ${name}: fiscal_year must be a year (2024) or [first, last]`);
      }
    }
    const sd = p.start_date;
    if (sd && pyStr(sd) < FLOOR) {
      probs.push(`request ${name}: start_date ${pyStr(sd)} is before 2007-10-01, the earliest date the search API takes`);
    }
    if (p.award_type !== null && p.award_type !== undefined) {
      const codes = awardCodes(p.award_type);
      const gs = codeGroup(codes);
      const unknown = codes.filter((c) => !codeGroup([c]).length);
      if (unknown.length) {
        probs.push(`request ${name}: unknown award type code(s) ${pyRepr(unknown)}; groups: ${[...groups().keys()].join(", ")}`);
      } else if (gs.length > 1) {
        probs.push(`request ${name}: award_type mixes groups ${pyRepr(gs)}; the API takes codes from one group ` +
          "per request: split it into one request per group");
      }
    }
    if (r.endpoint === "awards" && (p.award_type === null || p.award_type === undefined) &&
        !(p.filters || {}).award_type_codes?.length) {
      probs.push(`request ${name}: the awards endpoint needs award_type (contracts, grants, loans, ...)`);
    }
    for (const k of ["agency", "funding_agency"]) {
      if (p[k] !== null && p[k] !== undefined) {
        try {
          agencyName(p[k]);
        } catch (e) {
          if (!(e instanceof ValueError)) throw e;
          probs.push(`request ${name}: ${e.message}`);
        }
      }
    }
    if (p.state !== null && p.state !== undefined) {
      try {
        st(p.state);
      } catch (e) {
        if (!(e instanceof ValueError)) throw e;
        probs.push(`request ${name}: ${e.message}`);
      }
    }
    if (ep.method === "POST" && r.endpoint !== "awards" && !(p.fiscal_year || p.start_date || (p.filters || {}).time_period)) {
      probs.push(`request ${name}: give fiscal_year (or start_date/end_date); without it the API chooses a default period silently`);
    }
  }
  return probs;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const has = (p: Record<string, unknown>, k: string) => p[k] !== null && p[k] !== undefined;
function pop(p: Record<string, unknown>, k: string): any {
  const v = p[k];
  delete p[k];
  return v;
}

function before(req: SpecRequest, ep: any, params0: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, any> = { ...params0 };
  if (ep.method === "POST") {
    const f: Record<string, any> = {};
    if (has(params, "fiscal_year")) {
      const [s, e] = fyBounds(pop(params, "fiscal_year"));
      f.time_period = [{ start_date: s, end_date: e }];
    }
    if (params.start_date) {
      const s = pop(params, "start_date");
      const e = pop(params, "end_date");
      f.time_period = [{ start_date: s, end_date: e || "9999-12-31" }];
      if (f.time_period[0].end_date === "9999-12-31") f.time_period[0].end_date = today();
    }
    delete params.end_date;
    if (has(params, "award_type")) f.award_type_codes = awardCodes(pop(params, "award_type"));
    let kw = pop(params, "keyword");
    if (!kw) kw = pop(params, "keywords");
    if (kw) f.keywords = typeof kw === "string" ? [kw] : [...kw];
    if (has(params, "state")) f.place_of_performance_locations = [{ country: "USA", state: st(pop(params, "state")) }];
    const ags: any[] = [];
    if (has(params, "agency")) ags.push({ type: "awarding", tier: "toptier", name: agencyName(pop(params, "agency")) });
    if (has(params, "funding_agency")) {
      ags.push({ type: "funding", tier: "toptier", name: agencyName(pop(params, "funding_agency")) });
    }
    if (ags.length) f.agencies = ags;
    if (params.recipient) {
      const rcp = pop(params, "recipient");
      f.recipient_search_text = typeof rcp === "string" ? [rcp] : [...rcp];
    }
    Object.assign(f, pop(params, "filters") || {});
    params.filters = f;
    const codes: string[] = f.award_type_codes || [];
    const cg = codeGroup(codes);
    if (req.endpoint === "awards" && !("sort" in (req.params || {})) && cg.length === 1 && cg[0] === "loans") {
      params.sort = "Loan Value";
      params.fields = ep.body.fields.map((x: string) => (x === "Award Amount" ? "Loan Value" : x));
    }
  } else {
    if ("toptier_code" in params) params.toptier_code = toptierCode(params.toptier_code);
    if (String(ep.path ?? "").includes("{fips}") && has(params, "state")) params.fips = st(pop(params, "state"), "fips");
  }
  return params;
}

function beforeRequest(req: SpecRequest, ep: any, params: Record<string, unknown>): Record<string, unknown> {
  try {
    return before(req, ep, params);
  } catch (e) {
    if (e instanceof ValueError) throw new DataError(`request ${pyRepr(req.name)}: ${e.message}`, "bad_request");
    throw e;
  }
}

function fiscal(fy0: unknown, quarter: unknown, month: unknown): [string, string] {
  if (!fy0) return ["", ""];
  const fy = pyInt(fy0);
  if (month) {
    const m = pyInt(month);
    const cal = ((m + 8) % 12) + 1;
    const year = m <= 3 ? fy - 1 : fy;
    return [`FY${fy} M${String(m).padStart(2, "0")}`, `${year}-${String(cal).padStart(2, "0")}`];
  }
  if (quarter) {
    const q = pyInt(quarter);
    const cal = [10, 1, 4, 7].at(q - 1)!;
    return [`FY${fy} Q${q}`, `${q === 1 ? fy - 1 : fy}-${String(cal).padStart(2, "0")}`];
  }
  return [`FY${fy}`, `${fy - 1}-10`];
}

function normalize(_req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  for (const r of rows) {
    if ("time_period.fiscal_year" in r) {
      [r.fiscal_period, r.period_start] = fiscal(r["time_period.fiscal_year"], r["time_period.quarter"], r["time_period.month"]);
    }
    const gid = r.generated_internal_id;
    if (gid) r.award_url = `https://www.usaspending.gov/award/${pyStr(gid)}`;
  }
  return rows;
}

/** One link per page; POST bodies carry page and limit (the bundle's download scripts send them). */
function manualItems(spec: Spec, pack: Pack): any[] {
  const base = String(pack.endpoints?.base_url || "").replace(/\/+$/, "");
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [ep, params0, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    let params: Record<string, unknown>;
    try {
      params = before(r, ep, params0);
    } catch (e) {
      if (e instanceof ValueError) continue;
      throw e;
    }
    const [p, query, body] = gr.split(ep, params);
    let url = `${base}/${p.replace(/^\/+/, "")}`;
    if (Object.keys(query).length) url += "?" + pyUrlencode(query);
    const pg = ep.paging || { type: "none" };
    if (ep.method === "POST" && pg.type === "page") {
      const size = pyInt(pg.size);
      const pages = Math.min(25, Math.max(1, Math.ceil(pyInt(r.max_rows || size) / size)));
      for (let i = 0; i < pages; i++) {
        const b: Record<string, any> = structuredClone(body || {});
        [b[pg.page_param], b[pg.size_param]] = [i + 1, size];
        items.push({ name: `${r.name}#${i + 1}`, request: r.name, url,
          filename: pages === 1 ? `${r.name}.json` : `${r.name}_${i + 1}.json`, needs_key: false, method: "POST", body: b,
          note: pages === 1 ? "" : `page ${i + 1} of up to ${pages}; stop when a page comes back with an empty results list` });
      }
    } else {
      items.push({ name: `${r.name}#1`, request: r.name, url, filename: `${r.name}.json`, needs_key: false,
        method: ep.method || "GET", body, note: "" });
    }
  }
  return items;
}

/** Catalog search (agencies, award type groups) and endpoints, ranked by words matched. */
function search(query: string, pack: Pack): any[] {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1);
  const hits = gr.searchCatalog(pack, query, 500);
  const scored: [number, any][] = hits.map((h) => {
    const text = Object.values(h).map((v) => pyStr(v)).join(" ").toLowerCase();
    return [words.filter((w) => text.includes(w)).length, h];
  });
  const out = scored.sort((a, b) => b[0] - a[0]).map(([, h]) => h).slice(0, 20);
  if (hits.length > 20) out.push({ note: `${hits.length - 20} more results: narrow the words` });
  return out;
}

const adapter: Adapter = { checkSpec, beforeRequest, normalize, manualItems, search };
export default adapter;
