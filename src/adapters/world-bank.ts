/**
 * World Bank adapter (port of the Python adapter.py): errors inside HTTP 200, country groups, aggregate flag,
 * indicator search.
 *
 * - checkError: the API answers HTTP 200 with [{"message": [{"id", "key", "value"}]}] for an unknown or archived
 *   indicator or a bad parameter; that becomes an error instead of an empty table.
 * - beforeRequest: "country" takes a list, lower case, or a group alias from endpoints.json "groups"; "indicator"
 *   takes a code, a catalog alias, or a list of them (or the request's "dataset"). Several indicators go
 *   ';'-joined in one call, which the API accepts only with a source database id: source=2 (WDI) unless set.
 * - checkSpec: each indicator request needs an indicator (or dataset), and every list item must be a code.
 * - normalize: adds `is_aggregate` (Y/N) from the list of regional and income aggregates.
 * - search: the catalog first, then (when the API answers) the World Development Indicators by name, code and
 *   definition.
 */
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyStr } from "../core/py.js";

const eps = (): any => readJson(path.join(PACKS_DIR, "world-bank"), "endpoints.json") || {};

/** Python repr() of a JSON-like value (for messages). */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/'/g, "\\'")}'`;
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  return String(v);
}

function checkError(_status: number, body: Buffer): string | null {
  if (body.subarray(0, 2).toString("latin1") !== "[{" || !body.subarray(0, 200).toString("latin1").includes('"message"')) {
    return null;
  }
  let text: string;
  try {
    const data = JSON.parse(body.toString("utf8").replace(/^\uFEFF/, ""));
    const msgs: any[] = data[0].message || [];
    text = msgs.map((m) => `${m.key ?? ""}: ${m.value ?? ""} (id ${m.id ?? ""})`).join("; ");
  } catch {
    return null;
  }
  return `World Bank API error: ${text}. Check the indicator code (a request_schema search) and the country codes.`;
}

const WDI_SOURCE = "2";

const blank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);

function indicatorList(req: SpecRequest, params: Record<string, unknown>): unknown[] {
  let v: unknown = params.indicator;
  if (blank(v)) v = req.dataset;
  if (blank(v)) return [];
  const items: unknown[] = Array.isArray(v) ? v : pyStr(v).split(";");
  return items.filter((x) => !(typeof x === "string" && !x.trim())).map((x) => (typeof x === "string" ? x.trim() : x));
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const ep = "endpoint" in r ? r.endpoint : r.dataset ? "indicator" : null;
    if (ep !== "indicator" && ep !== "indicator_info") continue;
    const items = indicatorList(r, r.params || {});
    if (!items.length) {
      probs.push(`request ${pyRepr(r.name)}: parameter 'indicator' is required (a code such as ` +
        "NY.GDP.PCAP.CD, a catalog alias, or a list of them)");
    } else if (items.some((x) => typeof x !== "string")) {
      probs.push(`request ${pyRepr(r.name)}: 'indicator' must be a code, an alias or a list of them (text), not ${pyRepr(items)}`);
    } else if (r.endpoint === "indicator_info" && items.length > 1) {
      probs.push(`request ${pyRepr(r.name)}: indicator_info takes one indicator; use one request each`);
    }
  }
  return probs;
}

function beforeRequest(req: SpecRequest, ep: any, params: Record<string, unknown>): Record<string, unknown> {
  const groups: Record<string, string> = eps().groups || {};
  let c: unknown = params.country;
  if (c !== null && c !== undefined) {
    if (Array.isArray(c)) c = c.map(pyStr).join(";");
    let s = pyStr(c).trim();
    s = groups[s.toLowerCase()] ?? s;
    params.country = s.toLowerCase() === "all" ? s : s.toUpperCase().replaceAll(",", ";");
  }
  if (String(ep.path ?? "").includes("{indicator}")) {
    const cat: Record<string, any> = eps().catalog || {};
    const codes = indicatorList(req, params).map((x) => (typeof x === "string" && x in cat ? cat[x].id : x));
    params.indicator = codes.map(pyStr).join(";");
    if (codes.length > 1 && (params.source === null || params.source === undefined || params.source === "")) {
      params.source = WDI_SOURCE; // the API refuses several indicators without a source id
    }
  }
  return params;
}

function normalize(_req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  if (!rows.length || !("countryiso3code" in rows[0])) return rows;
  const agg = new Set<string>(eps().aggregates_iso3 || []);
  for (const r of rows) r.is_aggregate = agg.has(r.countryiso3code as string) ? "Y" : "N";
  return rows;
}

async function search(query: string, pack: Pack): Promise<any[]> {
  const words = (query.toLowerCase().match(/[a-z0-9.]+/g) || []).filter((w) => w.length > 1);
  const scored: [number, any][] = [];
  for (const h of gr.searchCatalog(pack, query, 200)) {
    const text = Object.values(h).map(pyStr).join(" ").toLowerCase();
    const n = words.filter((w) => text.includes(w)).length;
    if ("alias" in h && n >= Math.max(1, words.length - 1)) scored.push([n, h]);
  }
  let hits: any[] = scored.sort((a, b) => b[0] - a[0]).map(([, h]) => h);
  try {
    const c = gr.clientFor(pack);
    const data: any = await c.getJson("/source/2/indicator", { format: "json", per_page: 2000 });
    const live: [number, any][] = [];
    const count = (t: string, w: string) => t.split(w).length - 1;
    for (const i of Array.isArray(data) && data.length > 1 && data[1] ? data[1] : []) {
      const name: string = i.name || "", iid: string = i.id || "", note: string = i.sourceNote || "";
      const s = words.reduce((t, w) => t + 3 * count(name.toLowerCase(), w) + 3 * count(iid.toLowerCase(), w) +
        count(note.toLowerCase(), w), 0);
      if (s && words.every((w) => `${name} ${iid} ${note}`.toLowerCase().includes(w))) {
        live.push([s, { id: iid, name, source: "World Development Indicators", unit: i.unit || "" }]);
      }
    }
    const known = new Set(hits.map((h) => h.id));
    hits = hits.concat(live.sort((a, b) => b[0] - a[0]).map(([, h]) => h).filter((h) => !known.has(h.id)));
  } catch (e) {
    if (!(e instanceof DataError) && !(e instanceof SyntaxError)) throw e;
    hits.push({ note: `live indicator search unavailable (${e instanceof DataError ? e.kind : "error"}); ` +
      "catalog results only. Browse https://data.worldbank.org/indicator" });
  }
  const out = hits.slice(0, 20);
  if (hits.length > 20) out.push({ note: `${hits.length - 20} more results: narrow the words` });
  return out;
}

/** The generic links, after the same name resolution the fetch applies (group aliases, lists). */
function manualItems(spec: Spec, pack: Pack): any[] {
  const spec2: Spec = structuredClone(spec);
  for (const r of spec2.requests || []) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (!probs.length) r.params = beforeRequest(r, ep, { ...params });
  }
  return gr.manualItems(pack, spec2);
}

// search is async (it may ask the API); tools.ts awaits it, the Adapter type declares it sync.
const adapter: Adapter = { checkError, checkSpec, beforeRequest, normalize, search: search as unknown as Adapter["search"],
  manualItems };
export default adapter;
