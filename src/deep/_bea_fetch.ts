/**
 * The bea deep pack's fetch (port of sources/bea/fetch.py): spec -> requests, the API route,
 * BEA's public bulk files (NIPA flat files, Regional zips, GDP-by-industry workbooks), and one tidy CSV.
 *
 * Output (<workspace>/data/bea/):
 *   bea_data.csv   tidy long format, one row per series x area x period (COLUMNS); BEA's non-numeric cells
 *                  ((D), (NA), (NM), (L) ...) leave value empty and keep the code in flag
 *   notes.csv      request_id, table, note_ref, note_text (BEA's table notes)
 *   request.json   the spec, the exact API calls (key removed) or bulk files, route, vintage, checksums
 *   README.md      what is in the file, units, special values, citation and source line
 *   raw/           the API responses (key removed)
 * Bulk files are cached in <cache_root>/bea/bulk and revalidated by Last-Modified.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { trail } from "../core/context.js";
import { cacheRoot, mode } from "../core/env.js";
import { Client, DataError } from "../core/http.js";
import { dataDir } from "../core/package.js";
import * as pol from "../core/policy.js";
import { pyFloatRepr, pyJsonDumps, pyQuote, pyStr } from "../core/py.js";
import { unzip, writeCsv, xlsxSheets } from "../core/tabular.js";
import { BeaClient, BeaError, DATASETS, GUID, UA, datasetProblems, findApiKey, firstError, policy, redact, scrubResponse,
  valueKey } from "./_bea_api.js";
import { byCodePoint, csvRows, decodeSigLatin1, htmlUnescape, pyFloat, pyS, truthy } from "./_bea_util.js";

export const SOURCE = "bea";
export const COLUMNS = ["request_id", "dataset", "table", "line", "series_code", "description", "geo_fips", "geo_name",
  "geo_level", "industry", "time_period", "date", "year", "subperiod", "frequency", "value", "flag", "unit", "metric",
  "unit_mult", "note_ref", "dims"];
export const NOTE_COLUMNS = ["request_id", "table", "note_ref", "note_text"];
export const NIPA_TXT = "https://apps.bea.gov/national/Release/TXT/";
export const MONTHLY_TITLE = /\bmonth/i;
export const REGIONAL_ZIP = "https://apps.bea.gov/regional/zip/";
export const INDUSTRY_XLS = "https://apps.bea.gov/industry/Release/XLS/GDPxInd/";
export const WORKBOOKS: Record<string, string> = { TVA: "ValueAdded.xlsx", TGO: "GrossOutput.xlsx", TII: "IntermediateInputs.xlsx" };
export const WORKBOOK_TABLE = /^T(VA|GO|II)\d+$/i;
const GUID_RE = new RegExp(GUID, "g");

export const ZIP_ALIASES: Record<string, string[]> = { SARPI: ["SARPP"], SAIRPD: ["SARPP"], MAIRPD: ["MARPP"], SAOVA: ["SAOR"],
  SAORSA: ["SAOR"] };
export const NIPA_LIKE = ["NIPA", "NIUnderlyingDetail", "FixedAssets"];
const GEO_KEYWORDS = ["STATE", "COUNTY", "MSA", "MIC", "CSA", "PORT", "DIV", "TERR"];
export const STATE_FIPS: Record<string, string> = { AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22",
  ME: "23", MD: "24", MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34",
  NM: "35", NY: "36", NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47",
  TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55", WY: "56" };
export const SPEC_KEYS = new Set(["id", "dataset", "table", "frequency", "years", "line_code", "geo_fips", "params", "description"]);
const CITATION = "U.S. Bureau of Economic Analysis, @TABLES@, @ROUTE@ (accessed @DATE@). BEA data are in the public domain; " +
  "cite BEA as the source.";
export const API_NOTICE = "This product uses the Bureau of Economic Analysis (BEA) Data API but is not endorsed or certified by BEA.";
const FLAG_TEXT: Record<string, string> = { "(D)": "suppressed to avoid disclosure of confidential information",
  "(NA)": "not available", "(NM)": "not meaningful", "(L)": "less than $50,000 or less than 10 jobs (Regional) - the " +
  "estimate is included in higher-level totals", "(S)": "suppressed: does not meet publication standards",
  "(X)": "not applicable", "---": "not available / not applicable", "(T)": "suppressed (see the table notes)",
  "(*)": "MNE: a nonzero value that rounds to zero", "n.s.": "MNE: not shown", "n.a.": "not available" };

export type Row = Record<string, any>;
export type Req = { id: string; dataset: string; table: string; frequency: string; years: string; line_codes: string[];
  geo: string | null; calls: Record<string, string>[]; bulk_only: boolean };
export type Manifest = Record<string, Record<string, any>>;
export type Files = Record<string, string>;

/** A spec the pack cannot read (Python's ValueError): reported as fix_spec. */
export class SpecError extends DataError {
  constructor(msg: string) {
    super(msg, "spec");
  }
}

// --------------------------------------------------------------------------- spec -> requests
/** '2019-2025' / [2019, 2020] / 'ALL' / 'LAST5' -> the API's Year value. */
export function yearsParam(years: unknown, dataset: string): string {
  if (years === null || years === undefined || ["ALL", "X", "*"].includes(pyS(years).toUpperCase())) {
    return NIPA_LIKE.includes(dataset) ? "X" : "ALL";
  }
  if (Array.isArray(years)) {
    return years.map((y) => {
      const n = typeof y === "number" ? Math.trunc(y) : /^\s*[+-]?\d+\s*$/.test(pyS(y)) ? parseInt(pyS(y), 10) : NaN;
      if (!Number.isFinite(n)) throw new SpecError(`invalid literal for int() with base 10: ${JSON.stringify(pyS(y))}`);
      return String(n);
    }).join(",");
  }
  const s = pyS(years).trim();
  if (s.toUpperCase().startsWith("LAST")) return s.toUpperCase();
  const out: string[] = [];
  for (let part of s.split(",")) {
    part = part.trim();
    const m = /^(\d{4})\s*[-:–]\s*(\d{4})$/.exec(part);
    if (m) for (let y = Number(m[1]); y <= Number(m[2]); y++) out.push(String(y));
    else if (/^\d{4}$/.test(part)) out.push(part);
    else if (part) throw new SpecError(`years: cannot read '${part}'; use '2019-2025', a list of years, 'ALL' or 'LAST5'`);
  }
  return out.join(",");
}

/** The years an API Year value stands for (null = all; LASTn handled by the caller). */
export function yearSet(v: string): Set<number> | null {
  const u = v.toUpperCase();
  if (u === "X" || u === "ALL" || u.startsWith("LAST")) return null;
  return new Set(v.split(",").filter(Boolean).map((y) => parseInt(y, 10)));
}

/** Spec geo_fips -> the API's GeoFips: keywords and postal codes upper-cased, codes padded. */
export function normGeo(geo: unknown): string {
  const items = Array.isArray(geo) ? geo : pyS(geo).split(",");
  const out: string[] = [];
  for (const g of items) {
    let s = pyS(g).trim();
    if (/^\d{1,2}$/.test(s)) s = s.padStart(2, "0") + "000";
    else if (/^\d{3,5}$/.test(s)) s = s.padStart(5, "0");
    else s = s.toUpperCase();
    if (s) out.push(s);
  }
  return out.join(",");
}

const get = (o: Record<string, any>, k: string, d: any) => (k in o ? o[k] : d);

/** Each request -> {id, dataset, table, frequency, years, line_codes, geo, calls: [api params], bulk_only}. */
export function normalizeRequests(spec: any, notes: string[] = []): Req[] {
  const reqs: any[] = truthy(spec?.requests) ? spec.requests : spec?.dataset ? [spec] : [];
  if (!reqs.length || !Array.isArray(reqs)) throw new SpecError("spec.json needs a 'requests' list");
  const out: Req[] = [];
  const seen = new Set<string>();
  reqs.forEach((r: Record<string, any>, i0: number) => {
    const i = i0 + 1;
    const ds: string = truthy(r.dataset) ? pyS(r.dataset) : "NIPA";
    const raw: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.params || {})) raw[k] = pyS(v);
    const table = truthy(r.table) ? pyS(r.table) : raw.TableName || raw.TableID || "";
    const freq = (truthy(r.frequency) ? pyS(r.frequency) : raw.Frequency || "").toUpperCase();
    const yv = raw.Year || yearsParam(r.years, ds);
    const apiYear = ds !== "Regional" && yv.toUpperCase().startsWith("LAST") ? (NIPA_LIKE.includes(ds) ? "X" : "ALL") : yv;
    const base0 = truthy(r.id) ? pyS(r.id) : `${ds}_${table}_${freq}`.replace(/^_+|_+$/g, "");
    let rid = base0.replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "").toLowerCase();
    if (seen.has(rid)) rid = `${rid}_${i}`;
    seen.add(rid);
    const workbook = ds === "GDPbyIndustry" && WORKBOOK_TABLE.test(table || "");
    const ignored = new Set(Object.keys(r).filter((k) => !SPEC_KEYS.has(k)));
    if ("geo_fips" in r && ds !== "Regional") ignored.add("geo_fips");
    if ("line_code" in r && ![...NIPA_LIKE, "Regional"].includes(ds)) ignored.add("line_code");
    const friendly = NIPA_LIKE.includes(ds) || ds === "Regional" || workbook;
    if (!friendly) for (const k of ["frequency", "years"]) if (k in r) ignored.add(k);
    if (ignored.size) {
      notes.push(`request ${rid}: ${[...ignored].sort(byCodePoint).join(", ")} not used for ${ds}` +
        (!friendly ? ' (pass API parameters in "params")' : "") + "; see request_schema for the spec keys");
    }
    let base: Record<string, string> = {};
    let lineCodes: string[] = [];
    let geo: string | null = null;
    if (NIPA_LIKE.includes(ds)) {
      base = { TableName: table, Year: apiYear };
      if (ds !== "FixedAssets") base.Frequency = freq || "A";
      const lc = r.line_code;
      if (lc !== null && lc !== undefined && pyS(lc).toUpperCase() !== "ALL") lineCodes = Array.isArray(lc) ? lc.map(pyS) : [pyS(lc)];
    } else if (workbook) {
      base = { Table: table.toUpperCase(), Frequency: freq || "A", Year: yv };
    } else if (ds === "Regional") {
      const lc = get(r, "line_code", get(raw, "LineCode", "1"));
      lineCodes = Array.isArray(lc) ? lc.map(pyS) : [pyS(lc)];
      geo = normGeo(get(r, "geo_fips", get(raw, "GeoFips", "STATE")));
      if ("GeoFips" in raw) raw.GeoFips = normGeo(raw.GeoFips);
      base = { TableName: table, GeoFips: geo, Year: yv };
    }
    Object.assign(base, raw);
    let calls: Record<string, string>[];
    if (ds === "Regional") {
      delete base.LineCode;
      calls = lineCodes.map((lc) => ({ ...base, LineCode: lc }));
    } else calls = [base];
    out.push({ id: rid, dataset: ds, table, frequency: freq || base.Frequency || "", years: yv, line_codes: lineCodes, geo,
      calls, bulk_only: ds === "GDPbyIndustry" && WORKBOOK_TABLE.test(table || "") });
  });
  return out;
}

/** Requests BEA would refuse (every refusal counts against 30 errors a minute): check them first. */
export function specProblems(reqs: Req[]): string[] {
  const probs: string[] = [];
  for (const q of reqs) {
    if (q.bulk_only) continue;
    for (const call of q.calls) probs.push(...datasetProblems(q.dataset, call).map((p) => `request ${q.id}: ${p}`));
  }
  return [...new Set(probs)];
}

const stopKinds = (e: unknown) => e instanceof BeaError && ["auth", "rate_limit", "budget"].includes(e.bea);

/** Check table names (and Regional line codes) against BEA's cached metadata before GetData. */
export async function validateWithMetadata(client: BeaClient, reqs: Req[]): Promise<string[]> {
  const probs: string[] = [];
  const names = new Map<string, Set<string> | null>();
  for (const q of reqs) {
    const ds = q.dataset;
    if (q.bulk_only || ![...NIPA_LIKE, "Regional"].includes(ds) || !q.table) continue;
    if (!names.has(ds)) {
      try {
        const s = new Set((await client.parameterValues(ds, "TableName")).map((v) => valueKey(v).toUpperCase()));
        names.set(ds, s.size ? s : null);
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        if (stopKinds(e)) throw e;
        names.set(ds, null);
      }
    }
    const known = names.get(ds);
    const t = q.table.toUpperCase();
    if (known && !known.has(t) && !((ds === "Regional" && known.has(t + "N")) || known.has(t.replace(/N+$/, "")))) {
      const near = [...known].filter((k) => k.slice(0, 4) === t.slice(0, 4)).sort(byCodePoint).slice(0, 8);
      probs.push(`request ${q.id}: ${ds} has no table ${q.table}` + (near.length ? ` (similar: ${near.join(", ")})` : "") +
        `; list them with request_schema search "${ds} <words>"`);
      continue;
    }
    if (ds === "Regional" && q.line_codes.length && !q.line_codes.map((x) => x.toUpperCase()).includes("ALL")) {
      let lines = new Set<string>();
      try {
        lines = new Set((await client.parameterValuesFiltered("Regional", "LineCode", { TableName: q.table })).map(valueKey));
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        if (stopKinds(e)) throw e;
      }
      const bad = q.line_codes.filter((lc) => lines.size && !lines.has(lc));
      if (bad.length) {
        probs.push(`request ${q.id}: ${q.table} has no line ${bad.join(", ")} (request_schema search "values Regional LineCode ` +
          `TableName=${q.table}")`);
      }
    }
  }
  return probs;
}

export function fingerprint(reqs: Req[]): string {
  const parts: any[] = [...reqs.map((r) => r.calls), reqs.map((r) => r.dataset)];
  const filters = reqs.filter((r) => NIPA_LIKE.includes(r.dataset) && r.line_codes.length).map((r) => [r.id, r.line_codes]);
  if (filters.length) parts.push(filters);
  return createHash("sha256").update(pyJsonDumps(parts, true)).digest("hex").slice(0, 16);
}

// --------------------------------------------------------------------------- shared helpers
/** [number, ""] for a numeric DataValue ("1,337" -> 1337); [null, the published code] for BEA's special values. */
export function parseValue(v: unknown): [number | null, string] {
  const s = pyStr(v ?? "").trim();
  const n = pyFloat(s.replaceAll(",", ""));
  return n === null ? [null, s] : [n, ""];
}

const valueText = (n: number | null) => (n === null ? "" : pyFloatRepr(n));

/** '2024' / '2024Q1' / '2024:Q1' / '2024M01' -> [time_period, year, subperiod, frequency]. */
export function parsePeriod(tp: unknown, freq: string | null = ""): [string, number | null, string, string] {
  let s = pyStr(tp).trim().replaceAll(":", "");
  const m = /^(\d{4})(Q[1-4]|M\d{1,2})?$/.exec(s);
  if (!m) return [s, null, "", freq ?? ""];
  let sub = m[2] || "";
  if (sub.startsWith("M") && sub.length === 2) {
    sub = `M${String(parseInt(sub.slice(1), 10)).padStart(2, "0")}`;
    s = m[1] + sub;
  }
  const f = sub.startsWith("Q") ? "Q" : sub.startsWith("M") ? "M" : freq || "A";
  return [s, parseInt(m[1], 10), sub, f];
}

/** nation, region, state, county, or the requested area type (msa, port ...). */
export function geoLevel(fips: unknown, requested?: string | null): string {
  const req = (requested || "").toUpperCase();
  const f = pyStr(fips).trim().replace(/^"+|"+$/g, "");
  if (f === "00000" || f === "00") return "nation";
  if (["MSA", "MIC", "CSA", "PORT", "DIV"].includes(req)) return req.toLowerCase();
  if (/^9[1-8]000$/.test(f)) return "region";
  if (/^\d{2}000$/.test(f)) return "state";
  if (/^\d{5}$/.test(f)) return "county";
  return "";
}

/** A GDP-by-industry table's combined unit narrowed by the section the line sits in. */
export function sectionUnit(unit: string, section: string): string {
  const sec = (section || "").toLowerCase();
  if ((unit || "").toLowerCase().includes(" and ")) {
    if (sec.startsWith("percentage point")) return "Percentage points";
    if (sec.startsWith("percent")) return "Percent";
  }
  return unit;
}

/** BEA's unit for a NIPA level is just "Level": name it from the metric and the scale. */
export function plainUnit(unit: string, metric: string, unitMult: unknown): string {
  const u = (unit || "").trim().toLowerCase();
  if (u !== "level" && u !== "level change") return unit;
  const scale = ({ "3": "thousands of ", "6": "millions of ", "9": "billions of " } as Record<string, string>)[pyStr(unitMult).trim()] ?? "";
  const m = (metric || "").toLowerCase();
  const rate = m.includes("period rate") ? "not at annual rates (period rate)" : "quarterly and monthly values at annual rates";
  const change = u === "level change" ? "change in " : "";
  if (m.includes("contribution")) return "percentage points (contribution to the percent change; quarterly at an annual rate)";
  if (m.includes("share")) return "percent (a share of the total)";
  if (m.includes("ratio")) return "a ratio: percent or dollars per person, as the line description says";
  if (m.includes("ipd")) return "implicit price deflator, reference year = 100";
  if (m.includes("index")) return "index, reference year = 100";
  if (m.includes("chained")) return `${change}${scale}chained dollars (reference year in the table title); ${rate}`;
  if (m.includes("dollar")) return `${change}${scale}current dollars; ${rate}`;
  if (m.includes("person")) return `${scale}persons`;
  return metric ? `${scale}${metric.toLowerCase()} (see the line description)` : unit;
}

export function unitMultFromText(unit: string): number {
  const u = unit.toLowerCase();
  for (const [word, p] of [["trillion", 12], ["billion", 9], ["million", 6], ["thousand", 3]] as const) if (u.includes(word)) return p;
  return 0;
}

/** 'Hawaii *' -> 'Hawaii' (BEA marks areas with a footnote by a trailing star). */
export function cleanGeoName(name: unknown): string {
  return pyStr(name || "").replace(/\s*\*+\s*$/, "").trim();
}

const sha256File = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const pad2 = (n: number) => String(n).padStart(2, "0");
function localIso(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
const today = () => localIso().slice(0, 10);
const utcIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (d = new Date()) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
const fmtInt = (n: number) => n.toLocaleString("en-US");

// --------------------------------------------------------------------------- API rows -> tidy rows
const USED = new Set(["TableName", "SeriesCode", "LineNumber", "LineDescription", "TimePeriod", "METRIC_NAME", "CL_UNIT",
  "UNIT_MULT", "DataValue", "NoteRef", "Code", "GeoFips", "GeoName", "TableID", "Frequency", "Year", "Quarter", "Industry",
  "IndustrYDescription", "IndustryDescription", "TimeSeriesId", "TimeSeriesDescription", "AreaOrCountry", "Indicator"]);
const or = (...xs: unknown[]) => xs.find((x) => truthy(x)) ?? xs[xs.length - 1];

export function tidyApiRows(req: Partial<Req> & { id: string; dataset: string; table: string }, call: Record<string, any>,
  rows: Row[]): Row[] {
  const ds = req.dataset;
  const out: Row[] = [];
  for (const r of rows) {
    const [value, flag] = parseValue(r.DataValue);
    let tp: any = r.TimePeriod;
    if (!truthy(tp) && truthy(r.Year)) {
      let q = pyStr(r.Quarter || "").trim().toUpperCase().replace(/^Q+/, "");
      q = ({ I: "1", II: "2", III: "3", IV: "4" } as Record<string, string>)[q] ?? q;
      tp = ["1", "2", "3", "4"].includes(q) ? `${pyStr(r.Year)}Q${q}` : pyStr(r.Year);
    }
    const [tp2, year, sub, freq] = parsePeriod(truthy(tp) ? tp : "", or(req.frequency, get(r, "Frequency", "")) as string);
    let table: any = or(r.TableName, r.TableID, req.table);
    let line: any = get(r, "LineNumber", "");
    if (truthy(r.Code) && pyStr(r.Code).includes("-")) {
      const c = pyStr(r.Code);
      const k = c.lastIndexOf("-");
      [table, line] = [c.slice(0, k), c.slice(k + 1)];
    } else if (ds === "Regional") line = get(call, "LineCode", "");
    const dims: Row = {};
    for (const [k, v] of Object.entries(r)) if (!USED.has(k) && v !== null && v !== undefined && v !== "") dims[k] = v;
    const reqGeo = req.geo ?? null;
    const lvl = truthy(r.GeoFips)
      ? geoLevel(r.GeoFips, pyStr(req.table).toUpperCase().startsWith("MA") && !GEO_KEYWORDS.includes((reqGeo || "").toUpperCase())
        ? "MSA" : reqGeo)
      : [...NIPA_LIKE, "GDPbyIndustry", "UnderlyingGDPbyIndustry"].includes(ds) ? "nation" : "";
    out.push({
      request_id: req.id, dataset: ds, table, line,
      series_code: or(r.SeriesCode, r.TimeSeriesId, ""),
      description: or(r.LineDescription, r.TimeSeriesDescription, r.IndustrYDescription, r.IndustryDescription, r.Indicator, ""),
      geo_fips: get(r, "GeoFips", ""), geo_name: cleanGeoName(or(r.GeoName, r.AreaOrCountry, "")), geo_level: lvl,
      industry: get(r, "Industry", ""), time_period: tp2, year: year ?? "", subperiod: sub, frequency: freq,
      value: valueText(value), flag, unit: get(r, "CL_UNIT", ""), metric: get(r, "METRIC_NAME", ""),
      unit_mult: get(r, "UNIT_MULT", ""), note_ref: get(r, "NoteRef", ""),
      dims: Object.keys(dims).length ? pyJsonDumps(dims, false, false) : "",
    });
  }
  return out;
}

export function tidyNotes(req: { id: string; table: string }, notes: unknown[]): Row[] {
  return (notes || []).filter((n): n is Row => !!n && typeof n === "object" && !Array.isArray(n)).map((n) => ({
    request_id: req.id, table: req.table, note_ref: get(n, "NoteRef", ""), note_text: redact(pyStr(get(n, "NoteText", ""))) }));
}

// --------------------------------------------------------------------------- bulk files
let BULK: Client | null = null;
function bulkClient(): Client {
  return (BULK ??= new Client("", { name: "bea-bulk", rps: 4, burst: 4, retries: 2, timeout: 300, deadline: 1800, userAgent: UA }));
}

/**
 * Where bulk files are kept between runs: <cache_root>/bea/bulk (DATA_ANALYST_CACHE sets the root). On a hosted
 * server without an operator cache, inside the session's workspace instead (nothing is shared across users).
 */
export function cacheDir(workspace?: string): string {
  pol.checkCache(policy(), "persistent");
  const root = mode() === "remote" && !process.env.DATA_ANALYST_CACHE && workspace ? path.join(path.resolve(workspace), ".cache")
    : cacheRoot();
  const d = path.join(root, "bea", "bulk");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function httpGet(url: string, dest: string): Promise<Record<string, any>> {
  let r;
  try {
    r = await bulkClient().get(url);
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    throw new BeaError(`${url}: ${e.message}`, e.kind === "network" ? "network" : ["not_found", "fixture_missing"].includes(e.kind)
      ? "api" : "http");
  }
  const tmp = dest + ".part";
  fs.writeFileSync(tmp, r.body);
  fs.renameSync(tmp, dest);
  return { url, last_modified: r.headers["last-modified"] ?? "", status: r.status };
}

async function head(url: string): Promise<Record<string, any>> {
  if (process.env.DATA_ANALYST_FIXTURES) return {};
  try {
    const r = await bulkClient().request("HEAD", url);
    return { status: r.status, last_modified: r.headers["last-modified"] ?? "", length: Number(r.headers["content-length"] || 0),
      type: r.headers["content-type"] ?? "" };
  } catch (e) {
    if (e instanceof DataError) return {};
    throw e;
  }
}

/** Download a bulk file into the cache, reusing a copy whose Last-Modified has not changed. */
export async function fetchSource(url: string, srcDir: string, manifest: Manifest): Promise<string> {
  fs.mkdirSync(srcDir, { recursive: true });
  const name = url.slice(url.lastIndexOf("/") + 1);
  const dest = path.join(srcDir, name);
  const metaPath = dest + ".meta.json";
  if (fs.existsSync(dest) && fs.existsSync(metaPath)) {
    const old = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const lm = (await head(url)).last_modified;
    if (!lm || lm === old.last_modified) {
      manifest[name] = old;
      return dest;
    }
  }
  const meta = await httpGet(url, dest);
  const fd = fs.openSync(dest, "r");
  const magic = Buffer.alloc(4);
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);
  if (name.endsWith(".zip") && magic.subarray(0, 2).toString("latin1") !== "PK") {
    fs.rmSync(dest);
    throw new BeaError(`${url} is not a zip file (BEA answers a missing bulk file with an HTML page).`, "api");
  }
  Object.assign(meta, { sha256: sha256File(dest), bytes: fs.statSync(dest).size, retrieved: localIso(), path: dest });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1));
  manifest[name] = meta;
  return dest;
}

export function readTextMember(p: string): string {
  return decodeSigLatin1(fs.readFileSync(p));
}

const isDigits = (s: string) => /^\d+$/.test(s);
const cmpRowLine = (a: Row, b: Row) => {
  const la = isDigits(pyStr(a.line)) ? parseInt(a.line, 10) : 0, lb = isDigits(pyStr(b.line)) ? parseInt(b.line, 10) : 0;
  return la - lb || byCodePoint(a.time_period, b.time_period);
};

function keepLastN(rows: Row[], n: number): Row[] {
  const keep = new Set([...new Set(rows.map((r) => r.year))].sort((a, b) => a - b).slice(-n));
  return rows.filter((r) => keep.has(r.year));
}

/** Rebuild a NIPA table from the flat files: SeriesRegister maps TableId:LineNo -> SeriesCode. */
export async function nipaFromFlat(req: Pick<Req, "id" | "table" | "frequency" | "years">, srcDir: string, manifest: Manifest,
  files: Files = {}): Promise<[Row[], Row[]]> {
  const f = req.frequency || "A";
  const reg = files["SeriesRegister.txt"] || await fetchSource(NIPA_TXT + "SeriesRegister.txt", srcDir, manifest);
  let tablesReg: string | null = files["TablesRegister.txt"] || null;
  if (!tablesReg) {
    try {
      tablesReg = await fetchSource(NIPA_TXT + "TablesRegister.txt", srcDir, manifest);
    } catch (e) {
      if (!(e instanceof BeaError) && !(e as any)?.code) throw e;
      tablesReg = null;
    }
  }
  const table = req.table.toUpperCase();
  const titles: Record<string, string> = {};
  if (tablesReg) for (const row of csvRows(readTextMember(tablesReg))) if (row.length > 1) titles[row[0].toUpperCase()] = row[1];
  const lines = new Map<string, Row[]>();
  const homes = new Map<string, Set<string>>();
  for (const row of csvRows(readTextMember(reg))) {
    if (!row.length || row[0].startsWith("%") || row.length < 6) continue;
    const [code, label, metric, calc, scale, locs] = row;
    homes.set(code, new Set(locs.split("|").filter((x) => x.includes(":")).map((x) => x.split(":")[0].toUpperCase())));
    for (const loc of locs.split("|")) {
      if (loc.includes(":") && loc.split(":")[0].toUpperCase() === table) {
        if (!lines.has(code)) lines.set(code, []);
        lines.get(code)!.push({ line: loc.split(":")[1], label, metric, calc,
          unit_mult: /^\d+$/.test(scale.replace(/^-+/, "")) ? String(-parseInt(scale, 10) || 0) : "" });
      }
    }
  }
  if (!lines.size) {
    throw new BeaError(`NIPA table ${table} is not in SeriesRegister.txt (check the name with request_schema search).`, "api");
  }
  if (f === "M" && table.startsWith("T") && Object.hasOwn(titles, table) && !MONTHLY_TITLE.test(titles[table])) {
    const alt = [...new Set([...lines.keys()].flatMap((c) => [...(homes.get(c) || [])])
      .filter((t) => MONTHLY_TITLE.test(titles[t] ?? "")))].sort(byCodePoint);
    throw new BeaError(`NIPA ${table} (${titles[table]}) is published annually and quarterly, not monthly. ` +
      (alt.length ? `Its series' monthly values are in ${alt.join(", ")}: request that table with frequency M (check its line ` +
        `numbers with request_schema search "lines ${alt[0]}").` : "Use frequency A or Q."), "api");
  }
  const dat = files[`NipaData${f}.txt`] || await fetchSource(NIPA_TXT + `NipaData${f}.txt`, srcDir, manifest);
  const ys = yearSet(req.years);
  const lastn = req.years.toUpperCase().startsWith("LAST") ? parseInt(req.years.slice(4), 10) : null;
  let out: Row[] = [];
  const seenYears = new Set<number | null>();
  for (const row of csvRows(readTextMember(dat))) {
    if (!row.length || row[0].startsWith("%") || !lines.has(row[0]) || row.length < 3) continue;
    const [tp, year, sub, freq] = parsePeriod(row[1], f);
    seenYears.add(year);
    if (ys !== null && (year === null || !ys.has(year))) continue;
    const [value, flag] = parseValue(row[2]);
    for (const info of lines.get(row[0])!) {
      out.push({ request_id: req.id, dataset: "NIPA", table, line: info.line, series_code: row[0], description: info.label,
        geo_fips: "", geo_name: "United States", geo_level: "nation", industry: "", time_period: tp, year, subperiod: sub,
        frequency: freq, value: valueText(value), flag, unit: info.calc, metric: info.metric, unit_mult: info.unit_mult,
        note_ref: "", dims: "" });
    }
  }
  if (!out.length) {
    const have = [...seenYears].filter((y): y is number => y !== null).sort((a, b) => a - b);
    throw new BeaError(`No rows for NIPA ${table}, frequency ${f}, years ${req.years}: ` +
      (have.length ? `NipaData${f}.txt holds ${table} for ${have[0]}-${have[have.length - 1]}.`
        : `${table} is not published at frequency ${f} (try A, Q or M; request_schema search "lines ${table}").`), "api");
  }
  if (lastn) out = keepLastN(out, lastn);
  out.sort(cmpRowLine);
  const title = titles[table] ?? "";
  const notes = [{ request_id: req.id, table, note_ref: table, note_text: (title ? title + ". " : "") + "Rebuilt from the NIPA " +
    "flat files (SeriesRegister.txt TableId:LineNo); line descriptions are BEA's series labels, which can differ slightly " +
    "from the table's indented stub." }];
  return [out, notes];
}

function regionalCsvRows(text: string): [string[], string[][], string[]] {
  const rows = csvRows(text);
  const header = rows[0].map((h) => h.trim());
  const data: string[][] = [], foot: string[] = [];
  for (const r of rows.slice(1)) {
    if (r.length >= header.length - 1 && r.length && /^\s*\d{5}\s*$/.test(r[0].trim().replace(/^"+|"+$/g, "") || "x")) {
      data.push(r.map((c) => c.trim()));
    } else if (r.length && r.some((c) => c.trim())) foot.push(r.map((c) => c.trim()).join(" "));
  }
  return [header, data, foot];
}

/** BEA's footnotes for a Regional table, from <TABLE>__Footnotes.html in the zip: [[ref, text]]. */
function regionalFootnotes(z: Record<string, Uint8Array>, names: Set<string>): [string, string][] {
  const want = new Set([...names].map((nm) => `${nm.toLowerCase()}__footnotes.html`));
  const member = Object.keys(z).find((n) => want.has(n.toLowerCase()));
  if (!member) return [];
  const text = decodeSigLatin1Strict(z[member]);
  const out: [string, string][] = [];
  for (const m of text.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const s = htmlUnescape(m[1].replace(/<[^>]+>/g, " ")).replaceAll(" ", " ").replace(/\s+/g, " ").trim();
    if (!s) continue;
    const mm = /^(\d+)\.\s*(.*)$|^(\([A-Z]+\))\s*(.*)$/.exec(s);
    out.push(mm ? [mm[1] ?? mm[3], mm[1] !== undefined ? mm[2] : mm[4]] : ["", s]);
  }
  return out;
}

/** bytes.decode("utf-8") else latin-1 (no BOM strip: the footnote page is read as Python read it). */
function decodeSigLatin1Strict(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    return Buffer.from(b).toString("latin1");
  }
}

/** Geographies regionalFromZip can select: STATE, COUNTY, a postal code (its counties), 5-digit codes, any MA* area. */
export function bulkGeoOk(geo: string, table: string): boolean {
  const g = geo.toUpperCase();
  const codes = g.split(",").filter(Boolean);
  const t = table.toUpperCase();
  return t.startsWith("MA") || g === "STATE" || g === "COUNTY" || (Object.hasOwn(STATE_FIPS, g) && t.startsWith("CA")) ||
    (codes.length > 0 && codes.every((c) => /^\d{5}$/.test(c)));
}

export function zipCandidates(table: string): string[] {
  let t = table.toUpperCase();
  const fam = t.replace(/\d.*$/, "");
  const ca = t.startsWith("CA");
  if (!ca) t = t.replace(/(?<=\d)N$/, "");
  const c = [...(ca ? [t] : []), fam, ...(ZIP_ALIASES[t] || []), ...(ZIP_ALIASES[fam] || [])];
  if (!ca) c.push(t);
  return [...new Set(c)];
}

/** Can BEA's public bulk files serve this request? [true, files] or [false, why not]. */
export function bulkCoverage(req: Pick<Req, "dataset" | "table" | "frequency" | "geo" | "bulk_only">): [boolean, string] {
  const ds = req.dataset, t = req.table.toUpperCase(), f = req.frequency;
  if (ds === "NIPA") {
    if (!["A", "Q", "M"].includes(f)) return [false, `frequency '${f}' not in the NIPA flat files`];
    return [true, `NIPA flat files NipaData${f}.txt + SeriesRegister.txt`];
  }
  if (ds === "Regional") {
    const geo = pyStr(req.geo || "").toUpperCase();
    if (["MSA", "MIC", "CSA", "PORT", "DIV"].includes(geo) && !t.startsWith("MA")) {
      return [false, `${geo} areas are not in the bulk zip files; the API is needed. Note: since February 2026 BEA no longer ` +
        "produces GDP or personal income for metro areas in the county tables (CAINC*, CAGDP*); sum the component counties " +
        "instead (docs/datasets.md)"];
    }
    if (!/^(SA|SQ|CA|MA)[A-Z]/.test(t)) return [false, `no bulk file known for Regional table ${t}`];
    if (!bulkGeoOk(geo || "STATE", t)) return [false, `GeoFips ${geo} cannot be selected from the bulk zip files; the API is needed`];
    return [true, "Regional bulk zip " + zipCandidates(t).join(", ")];
  }
  if (ds === "GDPbyIndustry" && req.bulk_only) return [true, `GDP-by-industry workbook ${WORKBOOKS[t.slice(0, 3)]} (sheet ${t}-${f || "A"})`];
  if (ds === "GDPbyIndustry") {
    return [false, "GDPbyIndustry with API TableIDs needs a key; the same national tables are in BEA's public workbooks under " +
      'codes TVA101-TVA113, TGO101-TGO107, TII1xx: use "table": "TVA105" etc. (docs/datasets.md), which needs no key'];
  }
  return [false, `${ds} has no public bulk file this server can read; the API is needed`];
}

export async function regionalFromZip(req: Pick<Req, "id" | "table" | "years" | "line_codes" | "geo">, srcDir: string,
  manifest: Manifest, files: Files = {}): Promise<[Row[], Row[]]> {
  const table = req.table.toUpperCase();
  const names = new Set([table, table.replace(/(?<=\d)N$/, "")]);
  let chosen: [Record<string, Uint8Array>, string[]] | null = null;
  const errors: string[] = [];
  for (const cand of zipCandidates(table)) {
    let local = files[`${cand}.zip`];
    if (!local) {
      try {
        local = await fetchSource(REGIONAL_ZIP + `${cand}.zip`, srcDir, manifest);
      } catch (e) {
        if (e instanceof BeaError) {
          if (e.bea === "network") throw e;
          errors.push(`${cand}.zip: ${e.message.slice(0, 80)}`);
          continue;
        }
        if ((e as any)?.code) {
          errors.push(`${cand}.zip: ${String((e as Error).message).slice(0, 80)}`);
          continue;
        }
        throw e;
      }
    }
    const z = unzip(fs.readFileSync(local));
    const members = Object.keys(z).filter((n) => n.toLowerCase().endsWith(".csv") &&
      [...names].some((nm) => new RegExp(`^${nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_`, "i").test(n)));
    if (members.length) {
      chosen = [z, members];
      break;
    }
    errors.push(`${cand}.zip has no ${table} file`);
  }
  let footnotes: [string, string][] = [];
  let texts: string[];
  if (!chosen && files[`${table}.csv`]) texts = [readTextMember(files[`${table}.csv`])];
  else if (chosen) {
    const [z, members] = chosen;
    const allf = members.filter((m) => m.toUpperCase().includes("ALL_AREAS"));
    texts = (allf.length ? allf : members).map((m) => Buffer.from(z[m]).toString("latin1"));
    footnotes = regionalFootnotes(z, names);
  } else {
    throw new BeaError(`Regional table ${table} was not found in BEA's bulk files (${errors.join("; ")}). Use the API route (it ` +
      "needs a key) or check the table name.", "api");
  }
  const ys = yearSet(req.years);
  const lastn = req.years.toUpperCase().startsWith("LAST") ? parseInt(req.years.slice(4), 10) : null;
  const lcs = new Set((req.line_codes?.length ? req.line_codes : ["ALL"]).map((x) => pyStr(x).toUpperCase()));
  const geo = normGeo(req.geo || "STATE");
  if (!bulkGeoOk(geo, table)) {
    throw new BeaError(`GeoFips ${geo} cannot be selected from the bulk files for ${table}; use STATE, COUNTY, a state postal ` +
      "code, a list of FIPS codes, or the API route.", "api");
  }
  const geoList = /^\d/.test(geo) ? new Set(geo.split(",")) : null;
  const postal = Object.hasOwn(STATE_FIPS, geo) ? STATE_FIPS[geo] : undefined;
  let out: Row[] = [];
  const notes: Row[] = [];
  const seen = new Set<string>();
  const haveYears = new Set<number | null>();
  for (const text of texts) {
    const [header, data, foot] = regionalCsvRows(text);
    const periods = header.slice(8);
    for (const r of data) {
      const fips = r[0].trim().replace(/^"+|"+$/g, "").trim();
      const lvl = geoLevel(fips, table.startsWith("MA") ? "MSA" : "");
      if (geoList !== null) {
        if (!geoList.has(fips)) continue;
      } else if (postal) {
        if (lvl !== "county" || !fips.startsWith(postal)) continue;
      } else if (geo === "STATE" && !["state", "nation"].includes(lvl)) continue;
      else if (geo === "COUNTY" && !["county", "state", "nation"].includes(lvl)) continue;
      const line = r[4].trim();
      if (!lcs.has("ALL") && !lcs.has(line)) continue;
      const unit = r[7].trim();
      periods.forEach((p, k) => {
        const [tp, year, sub, freq] = parsePeriod(p, p.includes(":") ? "Q" : "A");
        haveYears.add(year);
        if (ys !== null && (year === null || !ys.has(year))) return;
        const key = `${fips}\u0000${line}\u0000${tp}`;
        if (seen.has(key)) return;
        seen.add(key);
        const [value, flag] = parseValue(8 + k < r.length ? r[8 + k] : "");
        const ind = r[5].trim().replace(/^"+|"+$/g, "");
        out.push({ request_id: req.id, dataset: "Regional", table: r[3].trim() || table, line, series_code: `${table}-${line}`,
          description: r[6].trim().replace(/\s+\d+\/\s*$/, ""), geo_fips: fips, geo_name: cleanGeoName(r[1]), geo_level: lvl,
          industry: ind === "..." ? "" : ind, time_period: tp, year, subperiod: sub, frequency: freq, value: valueText(value),
          flag, unit, metric: "", unit_mult: String(unitMultFromText(unit)), note_ref: "", dims: "" });
      });
    }
    for (const line of foot) {
      if (footnotes.length && /see the included footnote file/i.test(line)) continue;
      notes.push({ request_id: req.id, table, note_ref: "", note_text: line });
    }
  }
  for (const [ref, text] of footnotes) {
    if (!notes.some((n) => n.note_text === text)) notes.push({ request_id: req.id, table, note_ref: ref, note_text: text });
  }
  if (lastn) out = keepLastN(out, lastn);
  if (!out.length) {
    const have = [...haveYears].filter((y): y is number => y !== null).sort((a, b) => a - b);
    if (have.length && ys !== null && ![...ys].some((y) => have.includes(y))) {
      throw new BeaError(`No rows for ${table}, years ${req.years}: the bulk file holds ${have[0]}-${have[have.length - 1]} (BEA ` +
        `has not published later years of ${table} yet; RPPs lag state income by about a year).`, "bad_request");
    }
    throw new BeaError(`No rows for ${table} with lines ${pyListRepr([...lcs].sort(byCodePoint))}, geography ${geo}, years ` +
      `${req.years} in the bulk file. Check the line code (request_schema search "values Regional LineCode TableName=${table}" ` +
      "needs a key; the bulk zip's definition.xml lists the lines).", "api");
  }
  return [out, notes];
}

const pyListRepr = (xs: string[]) => "[" + xs.map((x) => `'${x}'`).join(", ") + "]";

/** '[Millions of dollars] Seasonally adjusted at annual rates' -> 'Millions of dollars; seasonally adjusted at annual rates'. */
export function workbookUnit(text: string): string {
  const m = /^\[([^\]]*)\]\s*(.*)$/.exec(text.trim());
  if (!m) return text.trim();
  const rest = m[2].trim();
  return m[1].trim() + (rest ? `; ${rest.slice(0, 1).toLowerCase()}${rest.slice(1)}` : "");
}

/** A GDP-by-industry table (TVA105 ...) from BEA's public workbook: sheet '<table>-<A|Q>'. */
export async function industryFromXlsx(req: Pick<Req, "id" | "table" | "frequency" | "years">, srcDir: string, manifest: Manifest,
  files: Files = {}): Promise<[Row[], Row[]]> {
  const table = req.table.toUpperCase(), f = (req.frequency || "A").toUpperCase();
  const wbname = WORKBOOKS[table.slice(0, 3)];
  const local = files[wbname] || await fetchSource(INDUSTRY_XLS + wbname, srcDir, manifest);
  const sheet = `${table}-${f}`;
  const sheets = xlsxSheets(fs.readFileSync(local), new Set([sheet, "Contents"]));
  if (!(sheet in sheets)) throw new BeaError(`${wbname} has no sheet ${sheet}; list the tables with request_schema search "GDPbyIndustry"`, "api");
  const rows = sheets[sheet];
  const hdrI = rows.findIndex((r) => r.length && pyStr(r[0]).trim() === "Line");
  if (hdrI < 0) throw new BeaError(`${wbname} sheet ${sheet} has no header row ("Line")`, "api");
  const header = rows[hdrI];
  const meta = rows.slice(0, hdrI).filter((r) => r.length && truthy(r[0])).map((r) => pyStr(r[0]));
  const unit = meta.filter((m) => m.startsWith("[")).map(workbookUnit)[0] ?? "";
  const ys = yearSet(req.years);
  const lastn = req.years.toUpperCase().startsWith("LAST") ? parseInt(req.years.slice(4), 10) : null;
  let out: Row[] = [];
  const notes: Row[] = [{ request_id: req.id, table, note_ref: table, note_text: meta.join(" | ") }];
  let section = "";
  for (const r of rows.slice(hdrI + 1)) {
    if (r.length && r[0] === null && r.length > 1 && pyStr(r[1] || "").trim().endsWith(":")) {
      section = pyStr(r[1]).trim().replace(/:+$/, "").trim();
      continue;
    }
    if (!r.length || r[0] === null) continue;
    const line = pyStr(r[0]).trim();
    if (!isDigits(line)) {
      notes.push({ request_id: req.id, table, note_ref: "", note_text: line });
      continue;
    }
    const rawDesc = pyStr(r[1] || "");
    const indent = rawDesc.length - rawDesc.replace(/^ +/, "").length;
    const desc = rawDesc.trim().replace(/\\\d+\\$/, "").trim();
    for (let k = 3; k < header.length; k++) {
      if (header[k] === null) continue;
      const [tp, year, sub, freq] = parsePeriod(pyStr(header[k]).trim(), f);
      if (ys !== null && (year === null || !ys.has(year))) continue;
      const [value, flag] = parseValue(k < r.length ? r[k] : "");
      out.push({ request_id: req.id, dataset: "GDPbyIndustry", table, line, series_code: `${table}-${line}`, description: desc,
        geo_fips: "00000", geo_name: "United States", geo_level: "nation", industry: desc, time_period: tp, year, subperiod: sub,
        frequency: freq, value: valueText(value), flag, unit: sectionUnit(unit, section), metric: "",
        unit_mult: String(unitMultFromText(unit)), note_ref: "", dims: pyJsonDumps({ indent, section }) });
    }
  }
  if (lastn) out = keepLastN(out, lastn);
  if (!out.length) throw new BeaError(`No rows for ${table} ${f} in years ${req.years}`, "api");
  return [out, notes];
}

export function periodDate(tp: string): string {
  const m = /^(\d{4})(?:Q([1-4])|M(\d{2}))?$/.exec(pyStr(tp));
  if (!m) return "";
  const month = m[2] ? (Number(m[2]) - 1) * 3 + 1 : m[3] ? Number(m[3]) : 1;
  return `${m[1]}-${pad2(month)}-01`;
}

// --------------------------------------------------------------------------- package
/** What the API cannot do, applied on every route: requested lines, the last n years, and loud empty results. */
export function finalizeRows(reqs: Pick<Req, "id" | "dataset" | "table" | "years" | "line_codes" | "geo">[], rows: Row[]): Row[] {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    if (!by.has(r.request_id)) by.set(r.request_id, []);
    by.get(r.request_id)!.push(r);
  }
  const out: Row[] = [];
  for (const q of reqs) {
    let rs = by.get(q.id) || [];
    if (NIPA_LIKE.includes(q.dataset) && q.line_codes?.length && rs.length) {
      const want = new Set(q.line_codes);
      const have = new Set(rs.map((r) => pyStr(r.line)));
      const miss = [...want].filter((x) => !have.has(x));
      if (miss.length) {
        const lines = [...have].sort((a, b) => (isDigits(a) ? parseInt(a, 10) : 0) - (isDigits(b) ? parseInt(b, 10) : 0));
        throw new BeaError(`Request ${q.id}: ${q.table} has no line ${miss.sort(byCodePoint).join(", ")}. Its lines: ` +
          `${lines.join(", ")} (request_schema search "lines ${q.table}").`, "api");
      }
      rs = rs.filter((r) => want.has(pyStr(r.line)));
    }
    if (pyStr(q.years).toUpperCase().startsWith("LAST") && rs.length) {
      const n = parseInt(pyStr(q.years).slice(4), 10);
      const keep = new Set([...new Set(rs.map((r) => r.year).filter((y) => typeof y === "number"))].sort((a, b) => a - b).slice(-n));
      rs = rs.filter((r) => keep.has(r.year));
    }
    if (!rs.length) {
      throw new BeaError(`Request ${q.id} (${q.dataset} ${q.table}, years ${q.years}) returned no rows: check the years, frequency, ` +
        "lines and areas.", "api");
    }
    if (q.dataset === "Regional") {
      const asked = new Set(pyStr(q.geo || "").split(",").filter((g) => /^\d{5}$/.test(g)));
      const got = new Set(rs.map((r) => r.geo_fips));
      const missing = [...asked].filter((g) => !got.has(g));
      if (missing.length) {
        throw new BeaError(`Request ${q.id}: no ${q.table} rows for GeoFips ${missing.sort(byCodePoint).join(", ")} (states are ` +
          "SS000, counties SSCCC; see docs/datasets.md section 4).", "api");
      }
    }
    out.push(...rs);
  }
  return out;
}

/** {request id: years the request names explicitly that no row has}. */
export function missingYears(reqs: { id: string; years?: unknown }[], rows: Row[]): Record<string, number[]> {
  const have = new Map<string, Set<unknown>>();
  for (const r of rows) {
    if (!have.has(r.request_id)) have.set(r.request_id, new Set());
    have.get(r.request_id)!.add(r.year);
  }
  const out: Record<string, number[]> = {};
  for (const q of reqs) {
    const ys = yearSet(pyStr(truthy(q.years) ? q.years : "X"));
    const miss = ys && ys.size && have.has(q.id) ? [...ys].filter((y) => !have.get(q.id)!.has(y)).sort((a, b) => a - b) : [];
    if (miss.length) out[q.id] = miss;
  }
  return out;
}

export const ROUTE_TEXT: Record<string, string> = { api: "retrieved through the BEA Data API", bulk: "downloaded from BEA's public bulk files",
  manual_download: "downloaded by the user and uploaded" };

export type Packaged = { data_dir: string; rows: number; rows_by_request: Record<string, number>; tables: { name: string;
  file: string; rows: number; columns: string[] }[]; citation: string; retrieved: string; vintage: string[]; notes: string[];
  files: string[]; route: string };

export function packageData(out: string, reqs: Req[], spec: any, rows0: Row[], notes: Row[], route: string, callsLog: any[],
  manifest: Manifest, acquired: string, extraNotes: string[] = []): Packaged {
  const rows = finalizeRows(reqs, rows0);
  const ddir = dataDir(out, SOURCE);
  fs.mkdirSync(ddir, { recursive: true });
  for (const r of rows) r.date = periodDate(r.time_period ?? "");
  const csvPath = path.join(ddir, "bea_data.csv");
  fs.writeFileSync(csvPath + ".part", writeCsv(rows, COLUMNS));
  fs.renameSync(csvPath + ".part", csvPath);
  fs.writeFileSync(path.join(ddir, "notes.csv"), writeCsv(notes, NOTE_COLUMNS));
  const vintage = [...new Set(notes.map((n) => pyStr(n.note_text)).filter((t) => /last (?:updated|revised)|release/i.test(t)))].sort(byCodePoint);
  vintage.push(...Object.entries(manifest).filter(([, v]) => v.last_modified).map(([k, v]) => `${k}: Last-Modified ${v.last_modified}`));
  const flags = new Map<string, number>();
  for (const r of rows) if (r.flag) flags.set(r.flag, (flags.get(r.flag) || 0) + 1);
  const byReq = new Map<string, number>();
  for (const r of rows) byReq.set(r.request_id, (byReq.get(r.request_id) || 0) + 1);
  const gaps = missingYears(reqs, rows);
  const gapNotes = Object.entries(gaps).map(([k, v]) => `${k}: no rows for year(s) ${v.join(", ")}, which the spec asks for (BEA ` +
    "has not published them, or the table does not hold them); the data end earlier: say so");
  const retrieved = utcIso();
  const tables = [{ name: "bea_data", file: "bea_data.csv", rows: rows.length, columns: COLUMNS },
    { name: "notes", file: "notes.csv", rows: notes.length, columns: NOTE_COLUMNS }];
  const tableNames = [...new Set(reqs.map((q) => `${q.dataset} ${q.table}`))].sort(byCodePoint);
  const cite = CITATION.replace("@TABLES@", tableNames.join("; ")).replace("@ROUTE@", ROUTE_TEXT[route] ?? route)
    .replace("@DATE@", longDate());
  const P = policy();
  const rec = { source: SOURCE, description: spec?.description ?? "", fingerprint: fingerprint(reqs), route, acquired,
    downloaded: today(), retrieved, rows: rows.length, rows_by_request: Object.fromEntries(byReq), missing_years: gaps,
    notes: [...extraNotes, ...gapNotes], flags: Object.fromEntries(flags), vintage, spec, requests: reqs, api_calls: callsLog,
    bulk_files: manifest, csv_sha256: sha256File(csvPath), tables, citation: cite, http_requests: trail().slice(),
    policy: { redistribution: P.redistribution.mode, cache: P.cache.mode } };
  fs.writeFileSync(path.join(ddir, "request.json"), redact(JSON.stringify(rec, null, 2)));
  const unitKeys = new Map<string, [string, string, string]>();
  for (const r of rows) {
    const t: [string, string, string] = [pyStr(r.table), plainUnit(pyStr(r.unit ?? ""), pyStr(r.metric ?? ""), r.unit_mult ?? ""),
      pyStr(r.unit_mult)];
    unitKeys.set(t.join("\u0000"), t);
  }
  const units = [...unitKeys.values()].sort((a, b) => byCodePoint(a[0], b[0]) || byCodePoint(a[1], b[1]) || byCodePoint(a[2], b[2]));
  const unitTables = [...new Set(units.map(([t]) => t))].slice(0, 40);
  const lines = [
    `# BEA data: ${spec?.description ?? ""}`, "",
    `- Downloaded: ${today()} (${acquired})`,
    `- Route: ${route}`,
    `- Rows: ${fmtInt(rows.length)} (` + [...byReq].map(([k, v]) => `${k}: ${fmtInt(v)}`).join(", ") + ")",
    ...Object.entries(gaps).map(([k, v]) => `- **Years asked for but not in the data**: \`${k}\`: ${v.join(", ")} (not published ` +
      "yet, or not in this table): say so wherever the period is given"),
    "- File: `bea_data.csv`, tidy long format (one row per series, area and period)",
    "- Notes from BEA: `notes.csv`; exact request and checksums: `request.json`", "",
    "## Requests",
    ...reqs.map((q) => `- \`${q.id}\`: ${q.dataset} ${q.table}` + (q.frequency ? `, frequency ${q.frequency}` : "") +
      `, years ${pyStr(q.years).toUpperCase() === "X" ? "ALL" : q.years}` + (q.line_codes.length ? `, lines ${q.line_codes.join(",")}` : "") +
      (q.geo ? `, areas ${q.geo}` : "")), "",
    "## Columns",
    "- `value` is numeric as BEA publishes it; multiply by 10**`unit_mult` for base units (for example unit_mult 6 = millions " +
    "of dollars): amount = value x 10**unit_mult.",
    "- `unit` is BEA's kind of figure (Level, Percent change, annual rate, Index ...) and `metric` the measure (Current " +
    "Dollars, Chained Dollars, Persons, Fisher Quantity Index; Ratio is a percent or dollars per person, as the line " +
    "description says). Check both before combining series.",
    "- `flag` holds BEA's non-numeric codes ((D), (NA), (NM), (L) ...); `value` is then empty. Never treat a flagged cell as zero.",
    "- `time_period`: 2024, 2024Q1 or 2024M01; `date` is the first day of that period (for dashboards); `year`, `subperiod` " +
    "and `frequency` split it.",
    "- Chained-dollar series use 2017 as the reference year (since BEA's 2023 comprehensive update); the NIPA bulk files say " +
    "only \"Chained Dollars\", so state the year from the table header when you cite it.",
    "- GDP-by-industry rows keep the table's indentation in `dims` ({\"indent\": n}); line numbers differ between tables " +
    "(TVA106 has an extra line), so match industries across tables by description and order.",
    "", "## Bulk files",
    ...(Object.keys(manifest).length ? Object.entries(manifest).map(([k, v]) => `- ${k}: ${v.url ?? ""} (Last-Modified ` +
      `${v.last_modified ?? ""}; cached at ${v.path ?? ""})`) : ["- none (API or upload)"]), "",
    "## Units by table",
    ...unitTables.map((t) => `- ${t}: ` + units.filter(([t2]) => t2 === t).map(([, u, m]) => `${u || "(see notes)"}` +
      (m !== "" && m !== "0" ? ` (unit_mult ${m})` : "")).join("; ")),
    "", "## Special values found",
    ...(flags.size ? [...flags].map(([k, v]) => `- \`${k}\` x ${fmtInt(v)}: ${Object.hasOwn(FLAG_TEXT, k) ? FLAG_TEXT[k] : "see the table notes"}`) : ["- none"]),
    "", "## Vintage",
    ...(vintage.length ? vintage.map((v) => `- ${v}`) : ["- BEA serves only the latest estimates; the download date above is the vintage."]),
    "Estimates are revised: annual updates each September and comprehensive updates every five years or so. Rerunning later " +
    "can change the numbers; the checksum in `request.json` identifies this vintage.", "",
    "## Citation", cite, "",
    "Suggested source line: \"Analyst calculations using data from the Bureau of Economic Analysis.\" (or \"<Organization>, " +
    "using data from the Bureau of Economic Analysis\")",
    "", "## Use and redistribution", "",
    `Rule: **${P.redistribution.mode}**. ${P.redistribution.why ?? ""}`,
  ];
  if (route === "api") lines.push("", `Required notice for products built with the API: "${API_NOTICE}"`);
  fs.writeFileSync(path.join(ddir, "README.md"), lines.join("\n") + "\n");
  const raw = path.join(ddir, "raw");
  const rawFiles = callsLog.map((c) => path.join(ddir, c.file)).filter((p) => fs.existsSync(p) && p.startsWith(raw));
  return { data_dir: ddir, rows: rows.length, rows_by_request: Object.fromEntries(byReq), tables, citation: cite, retrieved,
    vintage, notes: [...extraNotes, ...gapNotes], files: rawFiles, route };
}

// --------------------------------------------------------------------------- routes
export async function runApi(client: BeaClient, reqs: Req[], out: string): Promise<[Row[], Row[], any[]]> {
  const rawDir = path.join(dataDir(out, SOURCE), "raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const rows: Row[] = [], notes: Row[] = [], log: any[] = [];
  for (const q of reqs) {
    for (let k = 0; k < q.calls.length; k++) {
      const call = q.calls[k];
      const ds = q.dataset;
      const [data, nts, info] = await client.getData(ds, call);
      rows.push(...tidyApiRows(q, call, data));
      notes.push(...tidyNotes(q, nts));
      const name = `${q.id}${q.calls.length > 1 ? "_" + (k + 1) : ""}.json`;
      fs.writeFileSync(path.join(rawDir, name), redact(JSON.stringify(scrubResponse({ request: { ...call, DataSetName: ds }, Data: data,
        ...info }), null, 1)));
      log.push({ request_id: q.id, dataset: ds, params: call, rows: data.length, file: `raw/${name}` });
    }
  }
  return [rows, notes, log];
}

export async function runBulk(reqs: Req[], srcDir: string, files?: Files): Promise<[Row[], Row[], Manifest]> {
  const rows: Row[] = [], notes: Row[] = [];
  const manifest: Manifest = {};
  for (const q of reqs) {
    const [ok, why] = bulkCoverage(q);
    if (!ok) throw new BeaError(`Request ${q.id}: ${why}`, "api");
    let r: [Row[], Row[]];
    if (q.dataset === "NIPA") r = await nipaFromFlat(q, srcDir, manifest, files);
    else if (q.dataset === "Regional") r = await regionalFromZip(q, srcDir, manifest, files);
    else if (q.dataset === "GDPbyIndustry" && q.bulk_only) r = await industryFromXlsx(q, srcDir, manifest, files);
    else throw new BeaError(`${q.dataset} has no bulk route`, "api");
    rows.push(...r[0]);
    notes.push(...r[1]);
  }
  return [rows, notes, manifest];
}

export type Existing = { path: string; csv_exists: boolean; route: string; downloaded: string; rows: number; spec_matches: boolean;
  saved: any };

export function existingData(out: string, reqs: Req[]): Existing | null {
  const ddir = dataDir(out, SOURCE);
  const rp = path.join(ddir, "request.json"), cp = path.join(ddir, "bea_data.csv");
  if (!fs.existsSync(rp)) return null;
  let saved: any;
  try {
    saved = JSON.parse(fs.readFileSync(rp, "utf8"));
  } catch {
    return null;
  }
  const ids = (saved.requests || []).map((q: any) => q.id);
  const sameIds = ids.length === reqs.length && ids.every((x: string, i: number) => x === reqs[i].id);
  return { path: cp, csv_exists: fs.existsSync(cp), route: saved.route, downloaded: saved.downloaded, rows: saved.rows,
    spec_matches: saved.fingerprint === fingerprint(reqs) && sameIds, saved };
}

/** The GetData URL for one call. keyExpr null leaves UserID out. */
export function apiUrl(dataset: string, call: Record<string, string>, keyExpr: string | null = null): string {
  const q = Object.entries(call).map(([k, v]) => `${k}=${pyQuote(pyStr(v), ",")}`).join("&");
  const user = keyExpr === null ? "" : `UserID=${keyExpr}&`;
  return `https://apps.bea.gov/api/data?${user}method=GetData&DataSetName=${dataset}&${q}&ResultFormat=JSON`;
}

export function bulkUrls(q: Req): string[] {
  if (q.dataset === "GDPbyIndustry") return [INDUSTRY_XLS + WORKBOOKS[q.table.toUpperCase().slice(0, 3)]];
  if (q.dataset === "NIPA") {
    return [NIPA_TXT + `NipaData${q.frequency || "A"}.txt`, NIPA_TXT + "SeriesRegister.txt", NIPA_TXT + "TablesRegister.txt"];
  }
  return [REGIONAL_ZIP + `${zipCandidates(q.table)[0]}.zip`];
}

export const apiFileName = (q: Req, k: number) => `${q.id}${q.calls.length > 1 ? "_" + (k + 1) : ""}.json`;

/** The files a user downloads by hand (core manual.ts items): public bulk files, and API replies with the key. */
export function manualItems(reqs: Req[]): any[] {
  const bulk: string[] = [];
  const api: any[] = [];
  for (const q of reqs) {
    if (bulkCoverage(q)[0]) bulk.push(...bulkUrls(q));
    else {
      q.calls.forEach((call, k) => {
        const name = apiFileName(q, k);
        api.push({ name, url: apiUrl(q.dataset, call, "{API_KEY}"), filename: name, needs_key: true, method: "GET",
          note: `BEA ${q.dataset} GetData for request ${q.id}. BEA repeats the key inside the reply: it is removed when the ` +
            "file is ingested.", optional: false });
      });
    }
  }
  const files = [...new Set(bulk)].map((u) => {
    const name = u.slice(u.lastIndexOf("/") + 1);
    return { name, url: u, filename: name, needs_key: false, method: "GET", note: "BEA public bulk file (no key)", optional: false };
  });
  return [...files, ...api];
}

// --------------------------------------------------------------------------- ingest
const BULK_NAME = /^(NipaData[AQM]\.txt|SeriesRegister\.txt|TablesRegister\.txt|[A-Z0-9]+\.zip|[A-Z0-9]+\.csv|[A-Za-z]+\.xlsx)$/i;

export async function ingestFiles(paths: string[], spec: any, reqs: Req[], out: string, extraNotes: string[] = []): Promise<Packaged> {
  if (!paths.length) throw new BeaError("ingest needs the downloaded files or their folder.", "other");
  const files: string[] = [];
  const walk = (p: string) => {
    if (fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    else files.push(p);
  };
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new BeaError(`Not found: ${p}`, "other", { dataKind: "not_found" });
    walk(p);
  }
  const byName = new Map(files.map((f) => [path.basename(f), f]));
  const src = path.join(dataDir(out, SOURCE), "source");
  fs.mkdirSync(src, { recursive: true });
  const rows: Row[] = [], notes: Row[] = [], log: any[] = [];
  const manifest: Manifest = {};
  const warn: string[] = [];
  for (const q of reqs) {
    const [ok] = bulkCoverage(q);
    const jsons = q.calls.map((_, k) => byName.get(apiFileName(q, k)));
    if (jsons.every(Boolean)) {
      for (let k = 0; k < q.calls.length; k++) {
        const jp = jsons[k]!, call = q.calls[k];
        const text = readTextMember(jp);
        let payload: any;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new BeaError(`${path.basename(jp)} is not a BEA JSON reply.`, "other");
        }
        if (new RegExp(GUID).test(text)) {
          warn.push(`${path.basename(jp)} still held the user's key; it was removed from the saved copy.`);
        }
        const err = firstError(payload);
        if (err) throw new BeaError(`${path.basename(jp)} holds a BEA error: ${pyStr(err.APIErrorDescription)}`, "api");
        let res: any = payload?.BEAAPI?.Results ?? {};
        if (Array.isArray(res) && res.length) res = res[0];
        const data = truthy(res?.Data) ? res.Data : payload?.BEAAPI?.Data ?? [];
        const list = Array.isArray(data) ? data : [data];
        rows.push(...tidyApiRows(q, call, list));
        notes.push(...tidyNotes(q, res?.Notes ?? []));
        const rawDir = path.join(dataDir(out, SOURCE), "raw");
        fs.mkdirSync(rawDir, { recursive: true });
        fs.writeFileSync(path.join(rawDir, path.basename(jp)), redact(JSON.stringify(scrubResponse(payload), null, 1)).replace(GUID_RE, "[REDACTED]"));
        log.push({ request_id: q.id, dataset: q.dataset, params: call, rows: list.length, file: `raw/${path.basename(jp)}` });
      }
      continue;
    }
    if (ok) {
      const local: Files = {};
      for (const [name, fp] of byName) {
        if (BULK_NAME.test(name)) {
          const dest = path.join(src, name);
          if (path.resolve(fp) !== path.resolve(dest)) fs.copyFileSync(fp, dest);
          local[name] = dest;
          manifest[name] = { file: name, sha256: sha256File(dest), bytes: fs.statSync(dest).size, acquired: "uploaded by the user" };
        }
      }
      let r: [Row[], Row[]];
      try {
        if (q.dataset === "NIPA") r = await nipaFromFlat(q, src, {}, local);
        else if (q.dataset === "GDPbyIndustry") r = await industryFromXlsx(q, src, {}, local);
        else r = await regionalFromZip(q, src, {}, local);
      } catch (e) {
        if (!(e instanceof DataError) && !(e as any)?.code) throw e;
        throw new BeaError(`Request ${q.id}: the uploaded files do not hold it (${String((e as Error).message).slice(0, 200)}). ` +
          "Expected " + bulkUrls(q).map((u) => u.slice(u.lastIndexOf("/") + 1)).join(", "), "other");
      }
      rows.push(...r[0]);
      notes.push(...r[1]);
      continue;
    }
    throw new BeaError(`Request ${q.id}: no uploaded file for it. Expected ` + q.calls.map((_, k) => apiFileName(q, k)).join(", ") +
      " (from the download script).", "other", { dataKind: "not_found" });
  }
  return packageData(out, reqs, spec, rows, notes, "manual_download", log, manifest, "downloaded by the user and uploaded",
    [...extraNotes, ...warn]);
}

// --------------------------------------------------------------------------- discovery
export type Hit = { dataset: string; table: string; title: string };

/** Table names: NIPA titles and the GDP-by-industry workbooks (no key); other datasets through the API (key). */
export async function findTables(text: string, dataset: string | null, workspace?: string): Promise<[Hit[], string[]]> {
  const words = text.split(/\s+/).filter(Boolean).map((w) => w.toLowerCase());
  const hits: Hit[] = [];
  const problems: string[] = [];
  if (dataset === null || dataset === "NIPA") {
    try {
      const reg = await fetchSource(NIPA_TXT + "TablesRegister.txt", cacheDir(workspace), {});
      for (const row of csvRows(readTextMember(reg))) {
        if (row.length >= 2 && words.every((w) => (row[0] + " " + row[1]).toLowerCase().includes(w))) {
          hits.push({ dataset: "NIPA", table: row[0], title: row[1] });
        }
      }
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      problems.push(`NIPA table list unavailable: ${e.message}`);
    }
  }
  if (dataset === null || dataset === "GDPbyIndustry") {
    for (const wb of Object.values(WORKBOOKS)) {
      try {
        const local = await fetchSource(INDUSTRY_XLS + wb, cacheDir(workspace), {});
        for (const row of xlsxSheets(fs.readFileSync(local), new Set(["Contents"])).Contents ?? []) {
          if (row.length > 2 && row[1] && WORKBOOK_TABLE.test(pyStr(row[1])) &&
            words.every((w) => (pyStr(row[1]) + " " + pyStr(row[2])).toLowerCase().includes(w))) {
            hits.push({ dataset: "GDPbyIndustry", table: pyStr(row[1]), title: `${pyStr(row[2])} (workbook ${wb}; A and Q sheets; no key)` });
          }
        }
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        problems.push(`${wb} unavailable: ${e.message}`);
      }
    }
  }
  if (dataset !== null && dataset !== "NIPA" && dataset !== "GDPbyIndustry") {
    const c = new BeaClient();
    const param = ["UnderlyingGDPbyIndustry", "InputOutput"].includes(dataset) ? "TableID" : "TableName";
    for (const v of await c.parameterValues(dataset, param)) {
      const k = valueKey(v);
      const d = pyStr(v.Desc || v.Description || "");
      if (words.every((w) => (k + " " + d).toLowerCase().includes(w))) hits.push({ dataset, table: k, title: d });
    }
  }
  return [hits, problems];
}

/** The lines of a NIPA table (SeriesRegister.txt, no key): [line, series code, label, metric, calculation]. */
export async function listLines(table: string, workspace?: string): Promise<{ line: number; series_code: string; label: string;
  metric: string; calculation: string }[]> {
  const reg = await fetchSource(NIPA_TXT + "SeriesRegister.txt", cacheDir(workspace), {});
  const found: [number, string, string, string, string][] = [];
  for (const row of csvRows(readTextMember(reg))) {
    if (row.length < 6 || row[0].startsWith("%")) continue;
    for (const loc of row[5].split("|")) {
      if (loc.includes(":") && loc.split(":")[0].toUpperCase() === table.toUpperCase()) {
        found.push([parseInt(loc.split(":")[1], 10), row[0], row[1], row[2], row[3]]);
      }
    }
  }
  found.sort((a, b) => a[0] - b[0] || byCodePoint(a[1], b[1]) || byCodePoint(a[2], b[2]) || byCodePoint(a[3], b[3]) || byCodePoint(a[4], b[4]));
  return found.map(([line, series_code, label, metric, calculation]) => ({ line, series_code, label, metric, calculation }));
}

export { DATASETS, findApiKey };
