/**
 * The treasury deep pack's spec, filter, packaging and discovery logic (port of sources/treasury/fetch.py).
 * Output (<workspace>/data/treasury/): <name>.csv per dataset (API field names, values as published, "null" ->
 * empty), fetch_spec.json (provenance) and README.md (data dictionary, values of the code columns, citation).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DataError } from "../core/http.js";
import { dataDir } from "../core/package.js";
import * as pol from "../core/policy.js";
import { pyJsonDumps, pyStr } from "../core/py.js";
import { readCsv, unzip, writeCsv } from "../core/tabular.js";
import { parse } from "csv-parse/sync";
import { BASE, buildUrl, FiscalDataClient, type Filter, filterString, fmtInt, MAX_PAGE, normalizeEndpoint, pyRepr,
  queryParams } from "./_treasury_api.js";

export const SOURCE = "treasury";
export const SEARCH_LIMIT = 20;
export const CATALOG_URL = "https://api.fiscaldata.treasury.gov/services/dtg/metadata/";
export const CITATION = "U.S. Department of the Treasury, Bureau of the Fiscal Service, Fiscal Data " +
  "(https://fiscaldata.treasury.gov), {datasets}; retrieved {date} through the Fiscal Data API.";
/** Website dataset pages (Download button: whole table or a date range, no 10,000-row page limit). */
const DATASET_PAGES: [string, string][] = [["/mts/", "monthly-treasury-statement"], ["/dts/", "daily-treasury-statement"],
  ["debt_to_penny", "debt-to-the-penny"], ["debt_outstanding", "historical-debt-outstanding"],
  ["avg_interest_rates", "average-interest-rates-treasury-securities"],
  ["interest_expense", "interest-expense-debt-outstanding"],
  ["rates_of_exchange", "treasury-reporting-rates-exchange"],
  ["/mspd/", "monthly-statement-public-debt"], ["auctions_query", "treasury-securities-auctions-data"],
  ["record_setting_auction", "record-setting-auction-data"], ["/rcm", "revenue-collections-management"],
  ["gift_contributions", "gift-contributions-reduce-debt-held-by-public"]];

export type Dataset = { name: string; endpoint: string; filter?: Filter; fields?: string[] | null; date_field?: string;
  sort?: string; allow_empty?: boolean; [k: string]: any };
export type TSpec = { description?: string; as_of?: string; datasets: Dataset[]; [k: string]: any };

const clone = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
/** Python str() of a value read from a row (a missing cell is None). */
const s = (v: unknown) => (v === null || v === undefined ? "None" : pyStr(v));
const nowZ = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// --------------------------------------------------------------------------- spec
/** The problems load_spec reported, and the spec with normalized endpoints. */
export function loadSpec(spec0: any): TSpec {
  const spec = clone(spec0) as TSpec;
  const ds = spec?.datasets;
  if (!Array.isArray(ds) || !ds.length) throw new DataError('spec.json needs a non-empty "datasets" list', "spec");
  const names = new Set<string>();
  for (const d of ds) {
    if (!isObj(d)) throw new DataError("each dataset must be an object with name and endpoint", "spec");
    if (!/^[a-z][a-z0-9_]*$/.test(String(d.name ?? ""))) {
      throw new DataError(`dataset name ${pyRepr(d.name)}: lowercase letters, digits and _ only`, "spec");
    }
    if (names.has(d.name)) throw new DataError(`dataset name ${pyRepr(d.name)} is used twice`, "spec");
    names.add(d.name);
    if (typeof d.endpoint !== "string") throw new DataError(`dataset ${pyRepr(d.name)}: "endpoint" is required`, "spec");
    d.endpoint = normalizeEndpoint(d.endpoint);
  }
  return spec;
}

export function dateField(d: Dataset): string {
  return d.date_field || "record_date";
}

/** The dataset filter plus the spec's as_of cut-off (<date_field> <= as_of). */
export function effectiveFilter(spec: TSpec, d: Dataset): Filter {
  let f: any = d.filter || {};
  const df = dateField(d);
  if (typeof f === "string") return f + (spec.as_of ? `,${df}:lte:${spec.as_of}` : "");
  f = clone(f);
  if (spec.as_of) {
    const cur = f[df];
    if (cur === null || cur === undefined) f[df] = { lte: spec.as_of };
    else if (isObj(cur) && !("lte" in cur) && !("lt" in cur) && !("eq" in cur)) cur.lte = spec.as_of;
  }
  return f;
}

// The API mishandles some characters in filter values [live, 2026-10-20]: a value with "&" or "," matches nothing
// (even URL-encoded), and in an "in" list a value with "," or parentheses is silently dropped. Conditions with such
// values are applied locally after the download instead (same rows, no silent loss).
const SAFE_VALUE = /^[A-Za-z0-9 ._/:-]*$/;
const SAFE_EQ_VALUE = /^[A-Za-z0-9 ._/:()-]*$/;

/** [api_part, local_part] of a friendly filter. A string filter is already API syntax: sent as is. */
export function splitFilter(filt: Filter): [Filter, Record<string, any>] {
  if (!filt || typeof filt === "string" || (isObj(filt) && !Object.keys(filt).length)) return [filt, {}];
  const api: Record<string, any> = {}, local: Record<string, any> = {};
  for (const [field, cond] of Object.entries(filt)) {
    let vals: [string, unknown][];
    if (isObj(cond)) vals = Object.entries(cond).flatMap(([op, v]) => (op === "in" && Array.isArray(v) ? v : [v]).map((x) => [op, x] as [string, unknown]));
    else if (Array.isArray(cond)) vals = cond.map((x) => ["in", x]);
    else vals = [["eq", cond]];
    const safe = vals.every(([op, x]) => (op === "in" ? SAFE_VALUE : SAFE_EQ_VALUE).test(s(x).trim()));
    (safe ? api : local)[field] = cond;
  }
  return [api, local];
}

export function defaultSort(d: Dataset, labels?: Record<string, unknown> | null): string {
  if (d.sort) return d.sort;
  let srt = dateField(d);
  if (labels && "src_line_nbr" in labels && srt !== "src_line_nbr") srt += ",src_line_nbr"; // a stable tiebreaker
  return srt;
}

export type Query = { name: string; endpoint: string; fields: any; date_field: string; filter: string;
  local_filter: Record<string, any>; sort: string; url_json: string; url_csv: string };

export function datasetQueries(spec: TSpec): Query[] {
  return spec.datasets.map((d) => {
    const filt = effectiveFilter(spec, d);
    const [apiF, localF] = splitFilter(filt);
    const sort = defaultSort(d);
    return { name: d.name, endpoint: d.endpoint, fields: d.fields ?? null, date_field: dateField(d), filter: filterString(filt),
      local_filter: localF, sort, url_json: buildUrl(d.endpoint, queryParams(d.fields, apiF, sort)),
      url_csv: buildUrl(d.endpoint, queryParams(d.fields, apiF, sort, MAX_PAGE, 1, "csv")) };
  });
}

export function fingerprint(spec: TSpec): string {
  const q = datasetQueries(spec).map((x) => ({ endpoint: x.endpoint, fields: x.fields, filter: x.filter, sort: x.sort }));
  return createHash("sha256").update(pyJsonDumps(q, true)).digest("hex").slice(0, 16);
}

const sha256 = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** Plain-language unit warning for the README (amount units differ by dataset). A field is in millions when the
 * API's own dataFormats says "$1,000,000" or its name says mil_. */
export function unitHint(endpoint: string, labels: Record<string, unknown> | null, types: Record<string, string> | null,
  formats?: Record<string, string> | null): string {
  const cols = Object.keys(labels && Object.keys(labels).length ? labels : types || {});
  const t = types || {};
  const fm = formats || {};
  const ty = (c: string) => String(t[c] ?? "");
  const money = cols.filter((c) => ty(c).startsWith("CURRENCY") || ((c.endsWith("_amt") || c.endsWith("_bal")) &&
    !(ty(c).startsWith("PERCENTAGE") || ty(c).startsWith("NUMBER"))));
  if (endpoint.includes("/dts/")) return "DTS amounts are in MILLIONS of dollars (rounded to the nearest million).";
  const mil = money.filter((c) => c.includes("mil_") || c.endsWith("_mil_amt") || fm[c] === "$1,000,000");
  if (endpoint.includes("rates_of_exchange")) return "exchange_rate is FOREIGN currency units per one U.S. dollar.";
  const pct = cols.filter((c) => ty(c).startsWith("PERCENTAGE"));
  const other = money.filter((c) => !mil.includes(c));
  let note = mil.length ? `Fields ${mil.join(", ")} are in MILLIONS of dollars.` : "";
  if (other.length && Object.keys(fm).length) note += mil.length ? " Other amounts are in dollars and cents." : "Amounts are in dollars and cents.";
  else if (other.length) {
    note += " Amount units were not confirmed from API metadata: before scaling, check the dataset's data " +
      "dictionary on fiscaldata.treasury.gov (format $1,000,000 = millions; e.g. MSPD table 3 and the " +
      "Schedules of Federal Debt are in millions).";
  }
  if (pct.length) note += ` Percentage fields (${pct.join(", ")}) are already in percent (3.870 means 3.87 percent).`;
  return note.trim();
}

// --------------------------------------------------------------------------- value summaries
const CATEGORY_COL = /(_cd|_desc|_type|_catg|_category|_nm|_name|_txt|_term|_security|reopening)$/;
const NOT_CATEGORY = /(_id|_date|_dt|_amt|_bal|_rate|_pct|_nbr)$/;
export const MAX_VALUES = 40;        // README: list a column's values when it has at most this many distinct ones
export const MAX_VALUES_CLI = 200;   // values query: list values up to this many per column (the most frequent)
const MAX_CODE_VALUES = 12;          // columns with at most this many values form the code combinations

export type ColSummary = Map<string, number> | { distinct: number; values: Map<string, number>; more: string }
  | { distinct: number; examples: string[]; all_values: string };
export type ValueSummary = { rows: number; columns: Map<string, ColSummary>; code_combinations: Record<string, any>[] };

const blank = (v: unknown) => v === "" || v === null || v === undefined || v === "null";
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Distinct values (with counts) of the category columns, and the combinations of the low-cardinality code
 * columns with an example description each. */
export function valueSummary(rows: Record<string, unknown>[], columns: string[], types?: Record<string, string> | null,
  maxValues = MAX_VALUES): ValueSummary {
  const t = types || {};
  const cols = columns.filter((c) => CATEGORY_COL.test(c) && !NOT_CATEGORY.test(c) && String(t[c] || "STRING").toUpperCase() === "STRING");
  const perCol = new Map<string, ColSummary>();
  const codes: string[] = [];
  for (const c of cols) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = blank(r[c]) ? "(empty)" : pyStr(r[c]);
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    const ranked = new Map([...counts].sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0])));
    if (counts.size <= maxValues) perCol.set(c, ranked);
    else if (maxValues >= MAX_VALUES_CLI) {
      perCol.set(c, { distinct: counts.size, values: new Map([...ranked].slice(0, maxValues)),
        more: `+${fmtInt(counts.size - maxValues)} more: narrow the filter (one record_date, or a code column such as a ` +
          "type or category) to list them" });
    } else {
      perCol.set(c, { distinct: counts.size, examples: [...counts.keys()].slice(0, 8),
        all_values: "request_schema search \"<endpoint> <filter JSON> values\"" });
    }
    if (counts.size > 1 && counts.size <= MAX_CODE_VALUES && c.endsWith("_cd")) codes.push(c);
  }
  const desc = cols.find((c) => c.endsWith("_desc"));
  const combos = new Map<string, { k: string[]; rows: number; examples: unknown[] }>();
  if (codes.length) {
    for (const r of rows) {
      const k = codes.map((c) => (blank(r[c]) ? "(empty)" : pyStr(r[c])));
      const key = JSON.stringify(k);
      if (!combos.has(key)) combos.set(key, { k, rows: 0, examples: [] });
      const e = combos.get(key)!;
      e.rows++;
      if (desc && !blank(r[desc]) && !e.examples.includes(r[desc]) && e.examples.length < 3) e.examples.push(r[desc]);
    }
  }
  const eg = desc ? `e.g. ${desc}` : "e.g.";
  return { rows: rows.length, columns: perCol,
    code_combinations: [...combos.values()].sort((a, b) => b.rows - a.rows).map((v) => ({
      ...Object.fromEntries(codes.map((c, i) => [c, v.k[i]])), rows: v.rows, [eg]: v.examples })) };
}

/** A value summary as JSON (value lists as [value, rows] pairs, so the order by frequency survives). */
export function summaryJson(vs: ValueSummary): any {
  const pairs = (m: Map<string, number>) => [...m];
  const columns: Record<string, any> = {};
  for (const [c, v] of vs.columns) {
    if (v instanceof Map) columns[c] = pairs(v);
    else if ("values" in v) columns[c] = { distinct: v.distinct, values: pairs(v.values), more: v.more };
    else columns[c] = v;
  }
  return { rows: vs.rows, columns, code_combinations: vs.code_combinations };
}

// --------------------------------------------------------------------------- local filters
/** API filter syntax ("record_date:gte:2020-01-01,type:in:(Bills,Notes)") as a friendly filter. */
export function parseFilterString(flt: string): Record<string, Record<string, any>> {
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of flt) {
    depth += (ch === "(" ? 1 : 0) - (ch === ")" ? 1 : 0);
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const out: Record<string, Record<string, any>> = {};
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    const bits = part.split(":");
    const field = bits[0], op = bits[1] ?? "";
    let v: any = bits.length > 2 ? bits.slice(2).join(":") : "";
    if (!["eq", "lt", "lte", "gt", "gte", "in"].includes(op)) {
      throw new DataError(`filter condition ${pyRepr(part)}: the operator must be one of eq, lt, lte, gt, gte, in`, "spec");
    }
    if (op === "in") v = String(v).trim().replace(/^[()]+|[()]+$/g, "").split(",").map((x: string) => x.trim());
    (out[field.trim()] ??= {})[op] = v;
  }
  return out;
}

/** Python float(): null when the text is not a number. */
function pyFloat(x: unknown): number | null {
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x !== "string") return null;
  const t = x.trim();
  if (/^[+-]?(nan|inf|infinity)$/i.test(t)) return t.toLowerCase().includes("nan") ? NaN : t.startsWith("-") ? -Infinity : Infinity;
  if (!/^[+-]?((\d(_?\d)*)?\.?\d(_?\d)*|\d(_?\d)*\.)([eE][+-]?\d(_?\d)*)?$/.test(t)) return null;
  return Number(t.replace(/_/g, ""));
}

/** Apply a friendly filter (or an API filter string) locally. String compare works for YYYY-MM-DD dates; numbers
 * compare as floats. */
export function applyFilter<R extends Record<string, unknown>>(rows: R[], flt0: Filter): R[] {
  const flt = typeof flt0 === "string" ? parseFilterString(flt0) : flt0;
  if (!flt || !Object.keys(flt).length) return rows;
  const cmp = (v: unknown, op: string, x: unknown): boolean => {
    let a: any = pyFloat(v), b: any = pyFloat(x);
    if (a === null || b === null) [a, b] = [s(v), s(x)];
    return op === "eq" ? a === b : op === "lt" ? a < b : op === "lte" ? a <= b : op === "gt" ? a > b : op === "gte" ? a >= b
      : (() => { throw new DataError(`filter operator ${pyRepr(op)}: use one of eq, lt, lte, gt, gte, in`, "spec"); })();
  };
  return rows.filter((r) => {
    let ok = true;
    for (const [field, cond] of Object.entries(flt)) {
      const v = r[field];
      const conds = isObj(cond) ? cond : Array.isArray(cond) ? { in: cond } : { eq: cond };
      for (const [op, x] of Object.entries(conds)) {
        const hit = op === "in" ? (Array.isArray(x) ? x : [...String(x)]).map(s).includes(s(v)) : !blank(v) && cmp(v, op, x);
        ok = ok && hit;
      }
    }
    return ok;
  });
}

// --------------------------------------------------------------------------- writing
function writeTable(p: string, rows: Record<string, unknown>[], fields: string[]): void {
  const clean = rows.map((r) => Object.fromEntries(fields.map((k) => [k, blank(r[k]) ? "" : r[k]])));
  fs.writeFileSync(p, writeCsv(clean, fields));
}

function describeCsv(p: string, dfield: string): { rows: number; columns: string[]; first_date: string | null; last_date: string | null } {
  const text = fs.readFileSync(p, "utf8");
  const rows = readCsv(text);
  let first = null as string | null, last = null as string | null;
  for (const r of rows) {
    const dt = (r[dfield] as string) || "";
    if (dt) {
      first = first === null || dt < first ? dt : first;
      last = last === null || dt > last ? dt : last;
    }
  }
  return { rows: rows.length, columns: headerOf(text), first_date: first, last_date: last };
}

/** The header row of a CSV text (csv.DictReader fieldnames). */
function headerOf(text: string): string[] {
  const grid: string[][] = parse(text.replace(/^﻿/, ""), { relax_column_count: true, relax_quotes: true,
    skip_empty_lines: true, to_line: 1 });
  return grid[0] || [];
}

export type Result = { total: number | null; labels: Record<string, string>; types: Record<string, string>;
  formats: Record<string, string>; sort?: string; url?: string };

/** fetch_spec.json + README.md next to the CSV files. */
export function writePackage(spec: TSpec, out: string, results: Record<string, Result>, route: string): { prov: any; citation: string } {
  const d = dataDir(out, SOURCE);
  const now = nowZ();
  const qs = Object.fromEntries(datasetQueries(spec).map((q) => [q.name, q]));
  const prov: any = { source: SOURCE, publisher: "U.S. Treasury Fiscal Data API", base_url: BASE, retrieved: now, route,
    fingerprint: fingerprint(spec), spec, datasets: {} };
  for (const [name, r] of Object.entries(results)) {
    const q = qs[name];
    const p = path.join(d, `${name}.csv`);
    const info = describeCsv(p, q.date_field);
    const labels = r.labels && Object.keys(r.labels).length ? r.labels : Object.fromEntries(info.columns.map((k) => [k, k]));
    prov.datasets[name] = {
      endpoint: q.endpoint, filter: q.filter, local_filter: q.local_filter, sort: r.sort || q.sort,
      date_field: q.date_field, query_url: r.url || q.url_json,
      file: `data/${SOURCE}/${name}.csv`, sha256: sha256(p), ...info, api_total_count: r.total,
      units: unitHint(q.endpoint, labels, r.types || {}, r.formats || {}),
      labels: r.labels || {}, data_types: r.types || {}, data_formats: r.formats || {} };
  }
  prov.tables = Object.entries<any>(prov.datasets).map(([k, v]) => ({ name: k, file: `${k}.csv`, rows: v.rows }));
  fs.writeFileSync(path.join(d, "fetch_spec.json"), JSON.stringify(prov, null, 2));
  const names = [...new Set(Object.values<any>(prov.datasets).map((v) => v.endpoint as string))].sort(cmpStr).join(", ");
  const citation = CITATION.replace("{datasets}", names).replace("{date}", now.slice(0, 10));
  const how = route === "manual_download" ? "downloaded by hand with the bundled links, then packaged with ingest" : "Fiscal Data API";
  const lines = [`# Treasury Fiscal Data download: ${spec.description ?? ""}`, "",
    `- Retrieved: ${pol.localStamp(now)} (${how})`,
    `- Data cut-off (as_of): ${spec.as_of || "none (latest available at retrieval)"}`,
    `- Source: ${BASE}`, "",
    "Values are exactly as published. The API returns every value as a string; its \"null\" is an empty " +
    "cell here. Units differ by dataset: read the unit line under each file before scaling.", ""];
  for (const [name, x] of Object.entries<any>(prov.datasets)) {
    const hasLocal = Object.keys(x.local_filter || {}).length > 0;
    const local = hasLocal ? ["- Applied locally after the download (the API mishandles `&`, `,` or parentheses in these " +
      `values): \`${pyJsonDumps(x.local_filter, false, false)}\``] : [];
    lines.push(`## ${name}.csv`, "", `- Endpoint: \`${x.endpoint}\``, `- Filter: \`${x.filter || "none"}\``, ...local,
      `- Rows: ${fmtInt(x.rows)}` + (Number.isInteger(x.api_total_count)
        ? ` (API total-count${hasLocal ? " before the local filter" : ""}: ${fmtInt(x.api_total_count)})` : ""),
      `- ${x.date_field} range: ${x.first_date ?? "None"} to ${x.last_date ?? "None"}`,
      `- Units: ${x.units || "see the field types below"}`,
      `- SHA-256: \`${x.sha256}\``, `- Query: ${x.query_url}`, "",
      "| Field | Label | Type | Format |", "|---|---|---|---|");
    for (const c of x.columns) lines.push(`| \`${c}\` | ${x.labels[c] ?? ""} | ${x.data_types[c] ?? ""} | ${x.data_formats[c] ?? ""} |`);
    lines.push("");
    const vs = valueSummary(readCsv(fs.readFileSync(path.join(d, `${name}.csv`), "utf8")), x.columns, x.data_types);
    if (vs.columns.size) {
      lines.push("### Values in this file", "", "Filter on the column a value actually appears in (exact text, case-sensitive).", "",
        "| Field | Values (rows) |", "|---|---|");
      for (const [c, v] of vs.columns) {
        const txt = v instanceof Map ? [...v].map(([k, n]) => `${k} (${fmtInt(n)})`).join("; ")
          : `${fmtInt(v.distinct)} distinct, e.g. ` + ("examples" in v ? v.examples : [...v.values.keys()]).map(String).join("; ");
        lines.push(`| \`${c}\` | ${txt.replaceAll("|", "/")} |`);
      }
      lines.push("");
    }
    if (vs.code_combinations.length) {
      const keys = Object.keys(vs.code_combinations[0]).filter((k) => k !== "rows");
      lines.push("Code combinations:", "", "| " + keys.join(" | ") + " | rows |", "|" + "---|".repeat(keys.length + 1));
      for (const cmb of vs.code_combinations.slice(0, 30)) {
        lines.push("| " + keys.map((k) => (Array.isArray(cmb[k]) ? cmb[k].map(String).join("; ") : pyStr(cmb[k]))).join(" | ") +
          ` | ${fmtInt(cmb.rows)} |`);
      }
      lines.push("");
    }
  }
  lines.push("## Citation", "", citation, "",
    "Fiscal Data is published by the U.S. government and is in the public domain; redistribution is " +
    "permitted. Cite the source and the retrieval date, because Treasury revises some series.", "");
  fs.writeFileSync(path.join(d, "README.md"), lines.join("\n"));
  return { prov, citation };
}

// --------------------------------------------------------------------------- download
export function emptyMessage(name: string, endpoint: string, filt: Filter): string {
  return `${name}: the filter ${filterString(filt) || "(none)"} matches no rows in ${endpoint}. Filter values must ` +
    "match exactly (case, spelling, YYYY-MM-DD dates; a malformed date returns no rows, not an error), and " +
    "the value must be in the column you filter on (MTS: data_type_cd D/S/T vs record_type_cd). See which " +
    `column holds which value: request_schema search "${endpoint} {"record_date": "<one date>"} values". ` +
    "If no rows is a valid result, set \"allow_empty\": true on the dataset.";
}

export type Download = { prov: any; citation: string; warnings: string[]; notes: string[] };

export async function download(spec: TSpec, out: string, client: FiscalDataClient): Promise<Download> {
  const d = dataDir(out, SOURCE);
  fs.mkdirSync(d, { recursive: true });
  const results: Record<string, Result> = {};
  const warnings: string[] = [], notes: string[] = [];
  for (const ds of spec.datasets) {
    const { name, endpoint: ep } = ds;
    let fields = ds.fields;
    const filt = effectiveFilter(spec, ds);
    const [apiF, localF] = splitFilter(filt);                   // values the API mishandles are filtered here
    const full = await client.meta(ep, apiF, null);             // all columns: labels, types, row count
    const labels: Record<string, string> = full.labels || {};
    const df = dateField(ds);
    if (!(df in labels)) {
      const dates = Object.entries<string>(full.dataTypes || {}).filter(([, t]) => t === "DATE").map(([k]) => k);
      throw new DataError(`${name}: ${ep} has no ${pyRepr(df)} column; set "date_field" to one of ${pyRepr(dates)} ` +
        "and use it in the filter", "spec");
    }
    const unknown = Object.keys(localF).filter((f) => !(f in labels));
    if (unknown.length) throw new DataError(`${name}: filter fields not in ${ep}: ${pyRepr(unknown)}. Fields: ${pyRepr(Object.keys(labels))}`, "spec");
    if (Number(full["total-count"] || 0) === 0 && !ds.allow_empty) throw new DataError(emptyMessage(name, ep, filt), "spec");
    if (fields && fields.length) {
      fields = [...fields, ...Object.keys(localF).filter((f) => !fields!.includes(f))]; // the local filter needs its columns
      const bad = fields.filter((f) => !(f in labels));
      if (bad.length) throw new DataError(`${name}: fields not in ${ep}: ${pyRepr(bad)}. Fields: ${pyRepr(Object.keys(labels))}`, "spec");
      const sub = await client.meta(ep, apiF, null, fields);
      if (Number(sub["total-count"] || 0) !== Number(full["total-count"] || 0)) {
        throw new DataError(`${name}: requesting only ${pyRepr(fields)} returns ${sub["total-count"] ?? "None"} rows instead of ` +
          `${full["total-count"] ?? "None"}: the API grouped and summed rows (it does this when the fields leave ` +
          "out the columns that identify a row, and the sums can mix totals with details). Add the " +
          "row-identity columns (descriptions, src_line_nbr, type codes) or drop \"fields\".", "spec");
      }
    }
    const sort = defaultSort(ds, labels);
    let [rows, meta] = await client.fetchAll(ep, fields, apiF, sort);
    if (Object.keys(localF).length) {
      const nApi = rows.length;
      rows = applyFilter(rows, localF);
      notes.push(`${name}: filtered locally on ${pyRepr(Object.keys(localF).sort(cmpStr))}: kept ${fmtInt(rows.length)} of ${fmtInt(nApi)} rows`);
      if (!rows.length && !ds.allow_empty) throw new DataError(emptyMessage(name, ep, filt), "spec");
    }
    const cols = fields && fields.length ? fields : Object.keys(labels);
    const tmp = path.join(d, `.${name}.csv.part`);
    writeTable(tmp, rows, cols);
    fs.renameSync(tmp, path.join(d, `${name}.csv`));
    if (!rows.length) warnings.push(`${name}: the query matched no rows (allowed by "allow_empty").`);
    results[name] = { total: Number(meta["total-count"] || rows.length), labels, types: full.dataTypes, formats: full.dataFormats,
      sort, url: buildUrl(ep, queryParams(fields, apiF, sort)) };
  }
  const { prov, citation } = writePackage(spec, out, results, "api");
  return { prov, citation, warnings, notes };
}

/** What is already in data/treasury/ for this spec. */
export function existingData(out: string, spec: TSpec): any | null {
  const p = path.join(dataDir(out, SOURCE), "fetch_spec.json");
  if (!fs.existsSync(p)) return null;
  let saved: any;
  try {
    saved = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  const filesOk = spec.datasets.every((d) => fs.existsSync(path.join(dataDir(out, SOURCE), `${d.name}.csv`)));
  return { retrieved: saved.retrieved, route: saved.route, files_ok: filesOk, spec_matches: saved.fingerprint === fingerprint(spec),
    as_of: saved.spec?.as_of, prov: saved };
}

// --------------------------------------------------------------------------- manual route
export function datasetPage(endpoint: string): string {
  for (const [key, slug] of DATASET_PAGES) if (("/" + endpoint).includes(key)) return `https://fiscaldata.treasury.gov/datasets/${slug}/`;
  return "https://fiscaldata.treasury.gov/datasets/ (search for the table)";
}

/** The CSV links of a spec, one per dataset (10,000 rows per page; later pages name_2.csv ...). */
export function manualItems(spec0: any): any[] {
  const spec = loadSpec(spec0);
  return datasetQueries(spec).map((q) => ({ name: q.name, filename: `${q.name}.csv`, url: q.url_csv, needs_key: false,
    method: "GET", optional: false,
    note: `Endpoint ${q.endpoint}; filter ${q.filter || "none"}` +
      (Object.keys(q.local_filter).length ? `; the assistant applies the rest of the filter after upload: ${pyJsonDumps(q.local_filter)}` : "") +
      `. At most 10,000 rows per file: if it has exactly 10,000, get the next page with page%5Bnumber%5D=2 and save it as ` +
      `${q.name}_2.csv. Whole table: the Download button on ${datasetPage(q.endpoint)}` }));
}

function collectCsvs(paths: string[], tmpdir: string): string[] {
  const files: string[] = [];
  const walk = (p: string) => {
    for (const n of fs.readdirSync(p)) {
      const f = path.join(p, n);
      if (fs.statSync(f).isDirectory()) walk(f);
      else if (/\.(csv|zip)$/i.test(n)) files.push(f);
    }
  };
  for (const p of paths) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) walk(p);
    else if (fs.existsSync(p)) files.push(p);
    else throw new DataError(`not found: ${p}`, "spec");
  }
  const out: string[] = [];
  for (const f of files) {
    if (/\.zip$/i.test(f)) {
      for (const [m, data] of Object.entries(unzip(fs.readFileSync(f)))) {
        if (/\.csv$/i.test(m) && !m.includes("..") && !m.startsWith("/") && !m.startsWith("\\")) {
          const target = path.join(tmpdir, path.basename(m));
          fs.writeFileSync(target, data);
          out.push(target);
        }
      }
    } else out.push(f);
  }
  return out;
}

const reEsc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Package files the user downloaded by hand: API CSV links (maybe several pages) or a website download (whole
 * table: the spec's filter is applied here). Headers must be API field names. */
export function ingest(paths: string[], spec: TSpec, out: string): Download {
  const d = dataDir(out, SOURCE);
  fs.mkdirSync(d, { recursive: true });
  const results: Record<string, Result> = {};
  const warnings: string[] = [];
  if (!paths.length) throw new DataError("ingest needs the downloaded files or their folder", "spec");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "treasury-ingest-"));
  try {
    const files = collectCsvs(paths, tmp);
    for (const ds of spec.datasets) {
      const want = new Set<string>(ds.fields || []);
      let mine = files.filter((f) => new RegExp(`^${reEsc(ds.name)}(_p?\\d+)?\\.csv$`, "i").test(path.basename(f)));
      if (!mine.length && spec.datasets.length === 1) mine = files;
      if (!mine.length) {
        throw new DataError(`no uploaded file for dataset ${pyRepr(ds.name)}; expected ${ds.name}.csv ` +
          `(pages: ${ds.name}_2.csv ...). Got: ${pyRepr(files.map((f) => path.basename(f)))}`, "spec");
      }
      let rows: Record<string, unknown>[] = [];
      let header: string[] | null = null;
      for (const f of [...mine].sort(cmpStr)) {
        const text = fs.readFileSync(f, "utf8");
        const h = headerOf(text);
        if (header && JSON.stringify(h) !== JSON.stringify(header)) throw new DataError(`${f}: columns differ from the other files of ${ds.name}`, "spec");
        header = h;
        for (const r of readCsv(text)) {    // API CSV guards against formula injection: '-123.45 -> -123.45
          rows.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^'[-+=@]/.test(v) ? v.slice(1) : v])));
        }
      }
      const hdr = header || [];
      if (hdr.some((c) => c.includes(" "))) {
        throw new DataError(`${ds.name}: the headers are display labels (${pyRepr(hdr.slice(0, 3))} ...), not API field ` +
          "names. Ask the user to use the CSV links from manual_bundle.", "spec");
      }
      const lack = [...want].filter((c) => !hdr.includes(c)).sort(cmpStr);
      if (lack.length) warnings.push(`${ds.name}: requested fields missing from the upload: ${pyRepr(lack)}`);
      const n0 = rows.length;
      rows = applyFilter(rows, effectiveFilter(spec, ds));
      if (rows.length < n0) {
        warnings.push(`${ds.name}: applied the spec filter locally: kept ${fmtInt(rows.length)} of ${fmtInt(n0)} rows (a whole-table website download)`);
      }
      if (!rows.length && !ds.allow_empty) {
        throw new DataError(emptyMessage(ds.name, ds.endpoint, effectiveFilter(spec, ds)) + ` (${fmtInt(n0)} rows were uploaded before filtering.)`, "spec");
      }
      const seen = new Set<string>();
      const uniq: Record<string, unknown>[] = [];
      for (const r of rows) {                     // a page uploaded twice would double count
        const key = JSON.stringify(hdr.map((c) => r[c] ?? null));
        if (!seen.has(key)) {
          seen.add(key);
          uniq.push(r);
        }
      }
      if (uniq.length !== rows.length) warnings.push(`${ds.name}: dropped ${rows.length - uniq.length} duplicate rows (overlapping pages)`);
      const sortCols = defaultSort(ds, Object.fromEntries(hdr.map((c) => [c, c]))).split(",");
      const key = (r: Record<string, unknown>) => sortCols.map((c) => (c in r ? s(r[c]) : ""));
      uniq.sort((a, b) => {
        const ka = key(a), kb = key(b);
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return cmpStr(ka[i], kb[i]);
        return 0;
      });
      writeTable(path.join(d, `${ds.name}.csv`), uniq, hdr);
      if (n0 && n0 % MAX_PAGE === 0) {
        warnings.push(`${ds.name}: ${fmtInt(n0)} rows uploaded, a multiple of the 10,000-row page size; a page ` +
          "may be missing. Ask the user whether there is one more page.");
      }
      results[ds.name] = { total: null, labels: {}, types: {}, formats: {} };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { prov, citation } = writePackage(spec, out, results, "manual_download");
  return { prov, citation, warnings, notes: [] };
}

// --------------------------------------------------------------------------- discovery
export async function fieldsInfo(endpoint: string, filters?: Filter, dfield = "record_date"): Promise<any> {
  const [apiF, localF] = splitFilter(filters);
  const c = new FiscalDataClient();
  let m = await c.meta(endpoint, apiF, dfield);
  let types: Record<string, string> = m.dataTypes || {};
  const dates = Object.entries(types).filter(([, t]) => t === "DATE").map(([k]) => k);
  if (!m.first_row && dates.length && !dates.includes(dfield)) {    // e.g. I bonds: earning_period_start
    m = await c.meta(endpoint, apiF, dates[0]);
    types = m.dataTypes || types;
  }
  const note = Object.keys(localF).length ? { note: `total_count ignores ${pyRepr(Object.keys(localF).sort(cmpStr))}: the API ` +
    "mishandles those values (&, comma or parentheses); fetch applies that part locally. Use values for exact counts." } : {};
  const ep = normalizeEndpoint(endpoint);
  return { endpoint: ep, ...note, total_count: m["total-count"] ?? null,
    units: unitHint(ep, m.labels || {}, types, m.dataFormats || {}),
    date_columns: Object.entries(types).filter(([, t]) => t === "DATE").map(([k]) => k),
    fields: Object.entries<string>(m.labels || {}).map(([k, v]) => ({ field: k, label: v, type: types[k] ?? null,
      format: (m.dataFormats || {})[k] ?? null })),
    first_row: m.first_row, last_row: m.last_row };
}

/** The rows under the filter (refuses above `limit`), summarized: which values each code column holds. */
export async function valuesInfo(endpoint: string, filters?: Filter, limit = 20000): Promise<any> {
  const client = new FiscalDataClient();
  const [apiF, localF] = splitFilter(filters);
  const m = await client.meta(endpoint, apiF, null);
  const total = Number(m["total-count"] || 0);
  if (total > limit) {
    throw new DataError(`${fmtInt(total)} rows match; values reads at most ${fmtInt(limit)}. Narrow the filter, e.g. ` +
      "{\"record_date\": \"<one date>\"}", "spec");
  }
  let [rows] = await client.fetchAll(endpoint, null, apiF, null);
  rows = applyFilter(rows, localF);
  return { endpoint: normalizeEndpoint(endpoint), filter: filters ?? null,
    ...summaryJson(valueSummary(rows, Object.keys(m.labels || {}), m.dataTypes || {}, MAX_VALUES_CLI)) };
}

let catalogCache: any[] | null = null;
export function loadCatalog(packDir: string): any[] {
  if (!catalogCache) catalogCache = pol.readJson(packDir, "catalog.json")!.endpoints;
  return catalogCache!;
}

/** catalog.json: endpoint registry merged with the live catalog snapshot and the curated guidance. Stale entries
 * (HTTP 404) are listed last. */
export function searchBundled(packDir: string, words: string[]): any[] {
  const hits = loadCatalog(packDir).filter((e) => {
    const g = e.guidance || {};
    const text = [e.dataset, e.table, e.description, e.endpoint, g.question, g.rows_to_use].map((x) => (x === undefined || x === null ? "None" : String(x))).join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const k = (e: any): [number, number, string] => ["status" in e ? 1 : 0, e.guidance ? 0 : 1, e.endpoint];
  return hits.sort((a, b) => {
    const x = k(a), y = k(b);
    return x[0] - y[0] || x[1] - y[1] || cmpStr(x[2], y[2]);
  });
}

/** Search the live dataset catalog (all words must match); fall back to the bundled catalog.json. */
export async function searchCatalog(packDir: string, term: string): Promise<[any[], string]> {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  try {
    const raw = await new FiscalDataClient(60, 1).getRaw(CATALOG_URL);
    const cat = JSON.parse(raw.toString("utf8"));
    const guided = Object.fromEntries(loadCatalog(packDir).filter((e) => e.guidance).map((e) => [e.endpoint, e.guidance]));
    const hits: any[] = [];
    for (const ds of Array.isArray(cat) ? cat : cat.data || []) {
      for (const api of ds.apis || []) {
        if (!api.endpoint_txt) continue;
        const text = [ds.title, ds.short_description, api.table_name, api.table_description, api.endpoint_txt]
          .map((x) => (x === undefined || x === null ? "None" : String(x))).join(" ").toLowerCase();
        if (words.every((w) => text.includes(w))) {
          const ep = String(api.endpoint_txt).split("/fiscal_service/").pop()!.replace(/^\/+|\/+$/g, "");
          hits.push({ dataset: ds.title, table: api.table_name, endpoint: ep, frequency: api.update_frequency,
            earliest: api.earliest_date, latest: api.latest_date, rows: api.row_count,
            page: `https://fiscaldata.treasury.gov/datasets/${String(ds.dataset_path || "").replace(/^\/+|\/+$/g, "")}/`,
            description: String(api.table_description || "").slice(0, 240), ...(ep in guided ? { guidance: guided[ep] } : {}) });
        }
      }
    }
    hits.sort((a, b) => (a.guidance ? 0 : 1) - (b.guidance ? 0 : 1));
    return [hits, "live catalog"];
  } catch (e) {
    if (!(e instanceof DataError) && !(e instanceof SyntaxError) && !(e instanceof TypeError)) throw e;
  }
  return [searchBundled(packDir, words), "bundled catalog.json (snapshot; confirm with the endpoint's fields)"];
}
