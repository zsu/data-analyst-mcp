/**
 * EPA adapter (port of the Python adapter.py): Envirofacts DMAP (data.epa.gov/dmapservice) and ECHO
 * (echodata.epa.gov), two hosts.
 *
 * - Envirofacts tables are queried by path: /<schema.table>/<column>/<operator>/<value>/.../<first>:<last>/JSON.
 *   The pack builds the path from "filters" and pages with row ranges of 5,000.
 * - ECHO searches take two steps: <program>_rest_services.get_facilities (or get_systems, get_case_info)
 *   returns a QueryID and counts; <program>_rest_services.get_qid returns the rows, page by page
 *   (pageno; the page size is the responseset of the first call). The first call's summary (counts,
 *   total penalties) goes into the fetch notes. When ECHO echoes the parameters it understood
 *   (QueryParameters), a spec parameter it did not understand stops the fetch instead of silently
 *   returning nationwide rows (p_st on case searches does exactly that). Facility searches do not echo them,
 *   so checkSpec refuses the parameters known to be ignored (IGNORED).
 */
import fs from "node:fs";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { parsePyJson, pyJsonDumps, pyQuote, pyStr, pyUrlencode } from "../core/py.js";
import { readCsv } from "../core/tabular.js";

const DMAP = "https://data.epa.gov/dmapservice";
const PAGE = 5000;
const ECHO_PAGE = 1000;
const PAGE_PARAMS = ["qcolumns"]; // ECHO parameters that shape the rows: sent to get_qid as well as the search
const OPS = ["equals", "notEquals", "lessThan", "lessThanEqual", "greaterThan", "greaterThanEqual", "beginsWith",
  "endsWith", "contains"];
const ROW_KEYS = ["Facilities", "WaterSystems", "Cases"];
// parameters ECHO accepts without filtering (verified 2026-10): the search would silently return every row
const IGNORED: Record<string, Record<string, string>> = {
  echo_cases: {
    p_st: "is ignored by case searches (every state comes back): use p_state",
    p_fy: "is ignored by ECHO: use p_milestone_fy (one fiscal year)",
    p_crim: "is ignored by ECHO: use p_civil_criminal_indicator (CI civil, CR criminal, ALL)",
    p_name: "is accepted by ECHO but does not filter: fetch by state, law or year and filter CaseName",
  },
  echo_facilities: {
    p_naics: "is ignored by ECHO facility searches (every facility comes back): use p_ncs (NAICS, 2-6 " +
      "digits) or p_sic",
  },
};

const isDict = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

/** Python repr() of a JSON value (for messages). */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    return q + v.replace(/\\/g, "\\\\").replace(q === "'" ? /'/g : /(?!)/g, "\\'").replace(/\n/g, "\\n") + q;
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (isDict(v)) return "{" + Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  return pyStr(v);
}
/** Python str() (a dict or list shows as its repr). */
const pyText = (v: unknown) => (v !== null && typeof v === "object" ? pyRepr(v) : v === null || v === undefined ? "None" : pyStr(v));

function checkError(_status: number, body: Buffer): string | null {
  const head = body.toString("latin1").replace(/^[ \t\n\r\x0b\x0c]+/, "");
  if (head.slice(0, 1) !== "{") return null;
  let d: any;
  try {
    d = parsePyJson(body.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (isDict(d)) {
    const err = isDict(d.Results) ? d.Results.Error : null;
    if (err) return "ECHO: " + pyText(isDict(err) ? err.ErrorMessage : err).slice(0, 400);
    if (d.error) return "Envirofacts: " + pyText(d.error).slice(0, 400);
  }
  return null;
}

function filters(f: any): [unknown, unknown, unknown][] {
  if (!f || (Array.isArray(f) && !f.length) || (isDict(f) && !Object.keys(f).length)) return [];
  if (isDict(f)) return Object.entries(f).map(([k, v]) => [k, "equals", v]);
  return (f as any[]).map((item) => (item.length === 2 ? [item[0], "equals", item[1]] : [item[0], item[1], item[2]]));
}

function dmapPath(table: unknown, f: any): string {
  const segs = [pyStr(table)];
  for (const [col, op, val] of filters(f)) segs.push(pyQuote(pyStr(col), ""), pyStr(op), pyQuote(pyStr(val), ""));
  return "/" + segs.join("/");
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    const name = pyRepr(r.name);
    if (r.endpoint === "envirofacts") {
      const f = p.filters;
      if (f !== undefined && f !== null && !(isDict(f) || Array.isArray(f))) {
        probs.push(`request ${name}: filters must be an object or a list of [column, operator, value]`);
        continue;
      }
      for (const item of isDict(f) || !f ? [] : (f as any[])) {
        if (!Array.isArray(item) || ![2, 3].includes(item.length)) {
          probs.push(`request ${name}: each filter is [column, value] or [column, operator, value]`);
        } else if (item.length === 3 && !OPS.includes(item[1])) {
          probs.push(`request ${name}: operator ${pyRepr(item[1])} is not one of ${OPS.join(", ")}`);
        }
      }
    }
    for (const [k, why] of Object.entries(IGNORED[r.endpoint ?? ""] || {})) if (k in p) probs.push(`request ${name}: ${k} ${why}`);
    if (r.endpoint === "echo_facilities" && p.program === "air" && "p_co" in p) {
      probs.push(`request ${name}: p_co returns no rows on air searches (verified 2026-10); ` +
        "use p_fips (5-digit state+county FIPS) instead");
    }
  }
  return probs;
}

async function dmap(c: Client, ep: any, params: Record<string, unknown>, maxRows: unknown): Promise<[Row[], boolean]> {
  const limit = Math.trunc(Number(maxRows || ep.max_rows || 200000));
  const base = dmapPath(params.table, params.filters);
  let rows: any[] = [];
  let first = 1;
  while (rows.length < limit) {
    const n = Math.min(PAGE, limit - rows.length);
    let got = await c.getJson(`${DMAP}${base}/${first}:${first + n - 1}/JSON`);
    got = Array.isArray(got) ? got : [];
    rows = rows.concat(got);
    if (got.length < n) return [gr.clean(rows, ep), false];
    first += n;
  }
  return [gr.clean(rows.slice(0, limit), ep), true];
}

function echoPaths(ep: any, params: Record<string, unknown>): [string, string] {
  let [p] = gr.split(ep, Object.fromEntries(Object.entries(params).filter(([k]) => k === "program")));
  if (params.program === "sdw") p = p.replace(".get_facilities", ".get_systems");
  const qid = p.slice(0, p.lastIndexOf(".") < 0 ? p.length : p.lastIndexOf(".")) + ".get_qid";
  return [p, qid];
}

const echoQuery = (params: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(params).filter(([k]) => !["program", "output", "responseset"].includes(k)));

async function echo(c: Client, ep: any, params: Record<string, unknown>, maxRows: unknown, name: string,
  notes: string[]): Promise<[Row[], boolean]> {
  const limit = Math.trunc(Number(maxRows || ep.max_rows || 100000));
  const q = echoQuery(params);
  const [first, qidPath] = echoPaths(ep, params);
  const res: Record<string, any> = (await c.getJson(first, { output: "JSON", ...q, responseset: ECHO_PAGE })).Results || {};
  const understood = new Set<unknown>(((res.QueryParameters || []) as any[]).filter(isDict).map((p) => p.QP ?? null));
  if (understood.size) {
    const ignored = Object.keys(q).filter((k) => !understood.has(k) && !PAGE_PARAMS.includes(k));
    if (ignored.length) {
      const known = [...understood].map((x) => pyStr(x)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      throw new DataError(`ECHO did not understand ${ignored.join(", ")} (it understood: ${known.join(", ")}); ` +
        "see source.md for the parameter names", "bad_request");
    }
  }
  const total = Math.trunc(Number(pyStr(res.QueryRows || "0").replace(/,/g, "") || 0));
  const summary = Object.fromEntries(Object.entries(res).filter(([k]) => k.endsWith("Rows") || k === "TotalPenalties"));
  notes.push(`${name}: ECHO matched ${total.toLocaleString("en-US")} rows; summary ${pyJsonDumps(summary)}`);
  if (total === 0 || !res.QueryID) return [[], false];
  let rows: any[] = [];
  let page = 1;
  const want = Math.min(total, limit);
  // the rows come from get_qid, which returns its default columns unless it is given the column selection too
  // (qcolumns on get_facilities alone changes nothing in the rows; verified 2026-10-28)
  const keep = Object.fromEntries(PAGE_PARAMS.filter((k) => q[k] !== undefined && q[k] !== null && q[k] !== "").map((k) => [k, q[k]]));
  while (rows.length < want) {
    const data: Record<string, any> = (await c.getJson(qidPath, { output: "JSON", qid: res.QueryID, pageno: page, ...keep })).Results || {};
    const k = ROW_KEYS.find((x) => Array.isArray(data[x]));
    const got: any[] = k ? data[k] : [];
    if (!got.length) break;
    rows = rows.concat(got);
    page++;
  }
  return [gr.clean(rows.slice(0, want), ep), total > want];
}

/** Python float() accepts it. */
const PY_FLOAT = /^[+-]?((\d+(_\d+)*)?\.?\d+(_\d+)*([eE][+-]?\d+(_\d+)*)?|\d+(_\d+)*\.|inf(inity)?|nan)$/i;

function num(v: unknown): string {
  const t = pyStr(v || "").trim().replace(/\$/g, "").replace(/,/g, "");
  return PY_FLOAT.test(t.trim()) ? t : "";
}

function mdy(v: unknown): string {
  const parts = pyStr(v || "").trim().split("/");
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p)) && parts[2].length === 4) {
    return `${parts[2]}-${String(Number(parts[0])).padStart(2, "0")}-${String(Number(parts[1])).padStart(2, "0")}`;
  }
  return "";
}

/** ECHO publishes money as "$40,000.00" and dates as MM/DD/YYYY: add *_usd and *_iso columns. */
function normalize(_req: SpecRequest, ep: any, rows: Row[]): Row[] {
  if (ep?.kind !== "echo") return rows;
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      const v = r[k];
      if (typeof v === "string" && v.startsWith("$")) r[k + "_usd"] = num(v);
      else if (typeof v === "string" && (k.startsWith("Date") || k.endsWith("Date")) && mdy(v)) r[k + "_iso"] = mdy(v);
    }
  }
  return rows;
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const c = gr.clientFor(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  const miss = new gr.Misses();
  for (const r of spec.requests) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const kind = ep.kind;
    let rows: Row[], more: boolean;
    if (kind === "dmap") [rows, more] = await dmap(c, ep, params, r.max_rows);
    else if (kind === "echo") {
      [rows, more] = await echo(c, ep, params, r.max_rows, r.name, notes);
      rows = normalize(r, ep, rows);
    } else {
      const [got, meta] = await gr.fetchRequest(c, ep, params, r.max_rows);
      [rows, more] = [got, meta.truncated];
    }
    if (more) notes.push(`${r.name}: stopped at ${rows.length.toLocaleString("en-US")} rows (max_rows); the source has more.`);
    miss.checkEmpty(r, rows);
    tables[r.name] = rows;
  }
  miss.raiseIfAny("", "check table, column names and values (see source.md)");
  return [tables, notes];
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const kind = ep.kind;
    if (kind === "dmap") {
      const limit = Math.trunc(Number(r.max_rows || PAGE));
      const base = dmapPath(params.table, params.filters);
      const pages = Math.max(1, Math.min(25, Math.ceil(limit / PAGE)));
      for (let i = 0; i < pages; i++) {
        const a = i * PAGE + 1;
        items.push({ name: `${r.name}#${i + 1}`, request: r.name, url: `${DMAP}${base}/${a}:${a + PAGE - 1}/CSV`,
          filename: pages === 1 ? `${r.name}.csv` : `${r.name}_${i + 1}.csv`, needs_key: false, method: "GET", body: null,
          note: pages === 1 ? "" : `rows ${a}-${a + PAGE - 1}; stop when a file is empty` });
      }
    } else if (kind === "echo") {
      const [first, qid] = echoPaths(ep, params);
      const q = echoQuery(params);
      const url = first + "?" + pyUrlencode({ output: "JSON", ...q, responseset: ECHO_PAGE });
      const keep = PAGE_PARAMS.filter((k) => q[k]).map((k) => `&${k}=${pyQuote(pyStr(q[k]), ",")}`).join("");
      items.push({ name: `${r.name}#1`, request: r.name, url, filename: `${r.name}.json`, needs_key: false, method: "GET",
        body: null, note: `Two steps: this link returns a QueryID; then open ${qid}?output=JSON&qid=<QueryID>&pageno=1${keep} ` +
          `(pageno=2, 3 ... for more) and save those pages as ${r.name}.json, ${r.name}_2.json. ` +
          "Or use https://echo.epa.gov/facilities/facility-search (Download Data)." });
    } else {
      const [p, query] = gr.split(ep, params);
      let url = p.startsWith("http") ? p : DMAP + p;
      if (Object.keys(query).length) url += "?" + pyUrlencode(query);
      items.push({ name: `${r.name}#1`, request: r.name, url, filename: `${r.name}.json`, needs_key: false, method: "GET",
        body: null, note: "" });
    }
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [ep] = gr.resolve(pack, req);
  let rows: any[] = [];
  for (const p of [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const data = new TextDecoder("utf-8").decode(fs.readFileSync(p)).replace(/^\uFEFF/, "");
    if (p.toLowerCase().endsWith(".csv")) {
      rows = rows.concat(readCsv(data));
      continue;
    }
    const d = parsePyJson(data);
    if (Array.isArray(d)) rows = rows.concat(d);
    else if (isDict(d)) {
      const res: Record<string, any> = isDict(d.Results) ? d.Results : d;
      const k = ROW_KEYS.find((x) => Array.isArray(res[x]));
      rows = rows.concat(k ? res[k] : [res]);
    }
  }
  return normalize(req, ep, gr.clean(rows, ep));
}

const adapter: Adapter = { checkError, checkSpec, normalize, fetch, manualItems, parseUpload };
export default adapter;
