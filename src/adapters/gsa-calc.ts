/**
 * GSA CALC+ adapter (port of the Python adapter.py): friendly filter parameters, the CSV export, aggregation
 * tables, uploads.
 *
 * - beforeRequest: education_level, price_range, worksite, ... become repeated `filter=field:value` parameters,
 *   with the case each field needs (worksite lower case, education_level and business_size upper case; a wrong
 *   case is silently ignored or matches nothing). suggest_* turn `prefix` into `suggest-contains=<field>:<prefix>`.
 * - fetch: `rates_export` (export=y) answers CSV with a few lines of search and filter values before the header;
 *   it is parsed here and its columns are renamed to the JSON names (values recoded where the export spells them
 *   differently). An export with no matches is only that preamble: zero rows. Other endpoints use the generic fetch.
 * - checkSpec: the API ignores an unknown filter field (HTTP 200, unfiltered) and answers HTTP 406 with an empty
 *   body to an unknown search or ordering field and to a page past row 10,000, so raw `filter` entries must name
 *   a field in FILTERS and `search` one of SEARCH_FIELDS.
 * - normalize: JSON hits lose the `_source.` prefix and the search-engine metadata; rate_stats and rate_facets
 *   become small tables from the aggregations.
 * - manualItems / parseUpload: one export CSV link per request (all rows, no paging; identical rows once).
 */
import fs from "node:fs";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { parsePyJson, pyStr, pyUrlencode } from "../core/py.js";
import { readCsv } from "../core/tabular.js";

const FILTERS = ["education_level", "experience_range", "min_years_experience", "price_range", "current_price",
  "worksite", "business_size", "security_clearance", "sin", "category", "subcategory"];
const SUGGEST: Record<string, string> = { suggest_labor_category: "labor_category", suggest_vendor_name: "vendor_name",
  suggest_contract: "idv_piid" };
const SEARCH_FIELDS = ["labor_category", "vendor_name", "idv_piid"];
const PREAMBLE = ["SEARCH VALUES", "FILTER VALUES"];
const EDU = new Set(["HS", "AA", "BA", "MA", "PHD"]);
const WORKSITE = new Set(["customer", "contractor", "virtual"]);
const EXPORT_COLS: Record<string, string> = { "Contract #": "idv_piid", "Labor Category": "labor_category",
  "Business Size": "business_size", Schedule: "schedule", Site: "worksite", "Security Clearance": "security_clearance",
  Category: "category", Subcategory: "subcategory", "Begin Date": "contract_start", "End Date": "contract_end",
  SIN: "sin", "Vendor Name": "vendor_name", "Education Level": "education_level",
  "Minimum Years Experience": "min_years_experience", "Current Year Labor Price": "current_price",
  "Next Year Labor Price": "next_year_price", "Second Year Labor Price": "second_year_price" };
const RECODE: Record<string, Record<string, string>> = {
  business_size: { "small business": "S", "other than small business": "O" },
  security_clearance: { Yes: "True", No: "False" } };
const FACETS = ["education_level", "worksite", "business_size", "security_clearance", "min_years_experience",
  "labor_category"];

/** Python repr() of a str. */
function repr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n").replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t") + q;
}

const endpointOf = (req: SpecRequest) => req.endpoint || "";

function beforeRequest(req: SpecRequest, _ep: any, params: Record<string, unknown>): Record<string, unknown> {
  const name = endpointOf(req);
  if (name in SUGGEST) {
    const prefix = params.prefix;
    delete params.prefix;
    params["suggest-contains"] = `${SUGGEST[name]}:${pyStr(prefix)}`;
    return params;
  }
  let filt0: any = params.filter;
  delete params.filter;
  filt0 = filt0 || [];
  const filt: string[] = typeof filt0 === "string" ? [filt0] : [...filt0];
  for (const k of FILTERS) {
    let v: any = params[k];
    delete params[k];
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v = v.map(pyStr).join(k.endsWith("_range") ? "," : "|");
    v = pyStr(v);
    if (k === "worksite") v = v.toLowerCase().replace("_facility", "");
    else if (k === "education_level" || k === "business_size") v = v.toUpperCase();
    else if (k === "security_clearance") v = ({ true: "yes", false: "no" } as Record<string, string>)[v.toLowerCase()] ?? v.toLowerCase();
    filt.push(`${k}:${v}`);
  }
  if (filt.length) params.filter = filt;
  return params;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    const n = repr(String(r.name));
    const edu = p.education_level;
    if (edu) {
      const bad = (Array.isArray(edu) ? edu.join("|") : pyStr(edu)).toUpperCase().split("|").filter((x) => !EDU.has(x));
      if (bad.length) probs.push(`request ${n}: education_level codes are HS, AA, BA, MA, PHD (got [${bad.map(repr).join(", ")}])`);
    }
    const ws = p.worksite;
    if (ws && !WORKSITE.has(pyStr(ws).toLowerCase().replace("_facility", ""))) {
      probs.push(`request ${n}: worksite is customer, contractor or virtual`);
    }
    const bs = p.business_size;
    if (bs && !["S", "O"].includes(pyStr(bs).toUpperCase())) probs.push(`request ${n}: business_size is S (small) or O (other than small)`);
    for (const k of ["keyword", "prefix"]) {
      if (k in p && pyStr(p[k]).trim().length < 2) probs.push(`request ${n}: ${k} needs at least 2 characters`);
    }
    const s = p.search;
    if (s && !pyStr(s).includes(":")) probs.push(`request ${n}: search is field:value, e.g. labor_category:Data Scientist`);
    else if (s && !SEARCH_FIELDS.includes(pyStr(s).split(":")[0])) {
      probs.push(`request ${n}: search field must be one of ${SEARCH_FIELDS.join(", ")} (the API answers ` +
        `HTTP 406 to others; got ${repr(pyStr(s).split(":")[0])})`);
    }
    const raw = p.filter || [];
    for (const f of typeof raw === "string" ? [raw] : raw) {
      const field = pyStr(f).split(":")[0];
      if (!pyStr(f).includes(":") || !FILTERS.includes(field)) {
        probs.push(`request ${n}: filter ${repr(pyStr(f))} is not field:value with a known field (` +
          `${FILTERS.join(", ")}); the API ignores unknown filter fields and would return ` +
          "every rate. Labor category, vendor and contract go in search.");
      }
    }
  }
  return probs;
}

// ---------------------------------------------------------------------- CSV export
/** Python str.splitlines(). */
function splitlines(text: string): string[] {
  const parts = text.split(new RegExp("\r\n|[\n\r\v\f\x1c\x1d\x1e\x85" + String.fromCharCode(0x2028, 0x2029) + "]"));
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function parseExport(text: string): Row[] {
  const lines = splitlines(text);
  const start = lines.findIndex((l) => l.startsWith("Contract #"));
  if (start < 0) {
    const first = lines.map((l) => l.trim()).find((l) => l) ?? "";
    if (!first || PREAMBLE.includes(first)) return []; // no matches: the export is only the preamble
    return readCsv(text);
  }
  return readCsv(lines.slice(start).join("\n")).map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) {
      const col = EXPORT_COLS[k] ?? k;
      out[col] = typeof v === "string" && RECODE[col] && v in RECODE[col] ? RECODE[col][v] : v;
    }
    return out;
  });
}

const BOM = new RegExp("^" + String.fromCharCode(0xfeff));
const fmt = (n: number) => n.toLocaleString("en-US");

/** The export writes one line per distinct row of its 17 columns: rates identical in all of them collapse, so it
 * can hold fewer rows than the search matches. One count request (rate_stats) says by how many. */
export async function exportShortfall(client: { get: Client["get"] } | any, pack: Pack, params: Record<string, unknown>,
  n: number): Promise<string | null> {
  if (!n) return null;
  const [ep] = gr.resolve(pack, { name: "count", endpoint: "rate_stats" });
  const q: Record<string, unknown> = { ...(ep.defaults || {}),
    ...Object.fromEntries(Object.entries(params).filter(([k]) => k !== "export")) };
  let total: any;
  try {
    const [p, query] = gr.split(ep, q);
    const data = (await client.get(p, query)).json();
    total = ((data?.aggregations || {}).wage_stats || {}).count;
  } catch (e) {
    if (e instanceof DataError || e instanceof SyntaxError || e instanceof TypeError) return null;
    throw e;
  }
  if (!total || Math.trunc(Number(total)) <= n) return null;
  const t = Math.trunc(Number(total));
  return `the export has ${fmt(n)} rows but the search matches ${fmt(t)} rates: the export writes rates that ` +
    `are identical in every exported column once (${fmt(t - n)} fewer). Count rates with rate_stats, or ` +
    "use rates (JSON, one row per rate with its id, at most 10,000) when every rate must be a row.";
}

async function fetchOne(client: Client, r: SpecRequest, ep: any, params: Record<string, unknown>): Promise<[Row[], gr.Meta | null]> {
  if (endpointOf(r) === "rates_export") {
    const [p, query] = gr.split(ep, params);
    return [gr.clean(parseExport((await client.get(p, query)).text()), ep), null];
  }
  return gr.fetchRequest(client, ep, params, r.max_rows);
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const client = gr.clientFor(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [ep, params0, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const params = beforeRequest(r, ep, params0);
    let rows: Row[], meta: gr.Meta | null;
    try {
      [rows, meta] = await fetchOne(client, r, ep, params);
    } catch (e) {
      if (!(e instanceof DataError) || e.status !== 406) throw e;
      throw new DataError(`request ${repr(r.name)}: HTTP 406 with an empty body. CALC+ answers 406 to an unsupported ` +
        "ordering or search field and to a page past row 10,000 (use rates_export or " +
        "rate_stats for more rows).", "bad_request", 406);
    }
    if (endpointOf(r) === "rates_export") {
      const limit = Math.trunc(Number(r.max_rows || ep.max_rows || 200000));
      const short = await exportShortfall(client, pack, params, rows.length);
      if (short) notes.push(`${r.name}: ${short}`);
      if (rows.length > limit) {
        notes.push(`${r.name}: stopped at ${fmt(limit)} of ${fmt(rows.length)} rows (max_rows).`);
        rows = rows.slice(0, limit);
      }
    } else if (meta!.truncated) {
      const capped = (meta!.total || 0) >= 10000;
      notes.push(`${r.name}: stopped at ${fmt(rows.length)} rows` +
        (meta!.total ? ` of ${capped ? "10,000 or more" : fmt(meta!.total)}` : "") +
        " (max_rows; the JSON search returns at most 10,000). Use rates_export for every distinct row, " +
        "or rate_stats for summary statistics over every match.");
    }
    rows = normalize(r, ep, rows);
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${repr(r.name)} returned no rows: check the search and filter values ` +
        "(search is exact and case-sensitive; see source.md)", "bad_request");
    }
    tables[r.name] = rows;
  }
  return [tables, notes];
}

// ---------------------------------------------------------------------- aggregations and hits
function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  const name = endpointOf(req);
  const get = (a: Row, k: string) => (k in a ? a[k] : null);
  if (name === "rate_stats" && rows.length) {
    const a = rows[0];
    if (!("wage_stats.count" in a)) return rows;
    const out: Row = { count: get(a, "wage_stats.count"), min: get(a, "wage_stats.min"), max: get(a, "wage_stats.max"),
      mean: get(a, "wage_stats.avg"), std_dev_sample: get(a, "wage_stats.std_deviation_sampling"),
      median: get(a, "median_price.values.50.0") };
    for (const p of ["10.0", "25.0", "50.0", "75.0", "90.0"]) out[`p${p.split(".")[0]}`] = get(a, `histogram_percentiles.values.${p}`);
    return [out];
  }
  if (name === "rate_facets" && rows.length) {
    const a = rows[0];
    const out: Row[] = [];
    for (const f of FACETS) {
      const raw = a[`${f}.buckets`];
      let buckets: any[];
      try {
        buckets = typeof raw === "string" ? parsePyJson(raw) : ((raw as any[]) || []);
      } catch {
        buckets = [];
      }
      for (const b of buckets) {
        out.push({ facet: f, key: "key_as_string" in b ? b.key_as_string : b.key ?? null, doc_count: b.doc_count ?? null });
      }
    }
    return out.length ? out : rows;
  }
  return rows.map((r) => {
    if (!Object.keys(r).some((k) => k.startsWith("_source."))) return r;
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (["_index", "_score", "sort", "_id"].includes(k)) continue;
      o[k.startsWith("_source.") ? k.slice("_source.".length) : k] = v;
    }
    return o;
  });
}

// ---------------------------------------------------------------------- manual route
function manualItems(spec: Spec, pack: Pack): any[] {
  const base = String(pack.endpoints.base_url).replace(/\/+$/, "");
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [ep, params0, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const name = endpointOf(r);
    const params = beforeRequest(r, ep, { ...params0 });
    let p: string, query: Record<string, unknown>, fn: string, note: string;
    if (name in SUGGEST || name === "rate_stats" || name === "rate_facets") {
      [p, query] = gr.split(ep, params);
      [fn, note] = [`${r.name}.json`, ""];
    } else {
      delete params.page;
      delete params.page_size;
      params.export = "y";
      [p, query] = gr.split(ep, params);
      [fn, note] = [`${r.name}.csv`, "CSV export of every matching rate, identical rates once (the browser saves it as ceilingrates_results.csv: rename it)"];
    }
    const url = `${base}/${p.replace(/^\/+/, "")}?` + pyUrlencode(query);
    items.push({ name: `${r.name}#1`, request: r.name, url, filename: fn, needs_key: false, method: "GET", body: null, note });
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [ep] = gr.resolve(pack, req);
  let rows: Row[] = [];
  for (const f of files) {
    const data = fs.readFileSync(f);
    const head = data.subarray(0, 1).toString("latin1");
    if (f.toLowerCase().endsWith(".csv") || (head !== "{" && head !== "[")) {
      rows = rows.concat(gr.clean(parseExport(new TextDecoder("utf-8").decode(data).replace(BOM, "")), ep));
    } else rows = rows.concat(gr.parseUpload(pack, req, [f])); // runs normalize
  }
  return rows;
}

const adapter: Adapter = { beforeRequest, checkSpec, fetch, normalize, manualItems, parseUpload, parseExport, exportShortfall };
export default adapter;
