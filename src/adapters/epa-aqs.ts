/**
 * EPA AQS Data Mart adapter (aqs.epa.gov/data/api), a port of the Python adapter.py.
 *
 * - Credentials: AQS needs two query parameters, key (AQS_API_KEY) and email (AQS_EMAIL); policy.json maps
 *   both (auth.param and auth.extra) so core http adds them and keeps them out of recorded URLs.
 * - AQS answers with {"Header": [{"status": ...}], "Data": [...]} ("Body" in the documentation's
 *   examples); "Failed" is an error, "No data matched your selection" is an empty result.
 * - bdate and edate must fall in the same year (except for monitors): a longer range is split into one
 *   call per year here, and the rows are concatenated. The API asks for at most 10 requests a minute and
 *   a 5-second pause between them; policy limits (0.2 requests a second, burst 1) enforce that.
 * - States may be given as FIPS, USPS code or name; counties and sites are zero-padded.
 * - Keyless route: EPA's AirData yearly files (annualData, dailyData) go through ingest as downloaded (.zip or
 *   its .csv); parseUpload keeps the request's rows and uses the API's column names (see AIRDATA_FILES).
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { parsePyJson, pyStr, pyUrlencode } from "../core/py.js";
import { unzip } from "../core/tabular.js";
import { pyRepr, state, StateError } from "./_usaspending_state.js";

const BASE = "https://aqs.epa.gov/data/api";
const NEEDS: Record<string, string[]> = { byState: ["state"], byCounty: ["state", "county"],
  bySite: ["state", "county", "site"], byCBSA: ["cbsa"], byBox: ["minlat", "maxlat", "minlon", "maxlon"] };

const isDict = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const empty = (v: unknown) => v === undefined || v === null || v === "";
/** Python str(): None as "None". */
const str = (v: unknown) => (v === null || v === undefined ? "None" : pyStr(v));
const isDigits = (s: string) => /^\d+$/.test(s);
/** Python str.zfill. */
function zfill(s: string, n: number): string {
  const sign = s[0] === "+" || s[0] === "-" ? s[0] : "";
  const body = sign ? s.slice(1) : s;
  return s.length >= n ? s : sign + body.padStart(n - sign.length, "0");
}
/** Python float() of a str, or null where it would raise ValueError. */
function pyFloat(v: string): number | null {
  const t = v.trim().replace(/_(?=\d)/g, "");
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  return null;
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function header(d: unknown): Record<string, any> {
  const h = isDict(d) ? d.Header : null;
  const x = Array.isArray(h) && h.length ? h[0] : h;
  return isDict(x) ? x : {};
}

function checkError(_status: number, body: Buffer): string | null {
  if (body.toString("latin1").replace(/^[ \t\n\r\x0b\x0c]+/, "").slice(0, 1) !== "{") return null;
  let h: Record<string, any>;
  try {
    h = header(parsePyJson(body.toString("utf8").replace(/^\uFEFF/, "")));
  } catch {
    return null;
  }
  if (pyStr(h.status ?? "").toLowerCase() === "failed") {
    return "AQS request failed: " + ((h.error || []) as unknown[]).map(str).join("; ").slice(0, 400);
  }
  return null;
}

function stateFips(v: unknown): string {
  const s = pyStr(v).trim();
  if (isDigits(s)) return zfill(s, 2);
  try {
    return state(s, "fips");
  } catch (e) {
    if (e instanceof StateError) return s;
    throw e;
  }
}

function beforeRequest(_req: SpecRequest, _ep: any, params: Record<string, unknown>): Record<string, unknown> {
  if (!empty(params.state)) params.state = stateFips(params.state);
  for (const [k, n] of [["county", 3], ["site", 4]] as [string, number][]) {
    if (!empty(params[k]) && isDigits(pyStr(params[k]))) params[k] = zfill(pyStr(params[k]), n);
  }
  return params;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    if (r.endpoint !== "data") continue;
    const p: Record<string, any> = r.params || {};
    const name = pyRepr(r.name);
    for (const k of ["bdate", "edate", "cbdate", "cedate"]) {
      if (!empty(p[k]) && !/^\d{8}$/.test(str(p[k]))) probs.push(`request ${name}: ${k} must be YYYYMMDD, e.g. 20230101`);
    }
    if (str(p.param ?? "").split(",").length > 5) probs.push(`request ${name}: at most 5 parameter codes per request`);
    const missing = (NEEDS[p.geo] || []).filter((k) => empty(p[k]));
    if (missing.length) probs.push(`request ${name}: ${str(p.geo)} needs ${missing.join(", ")}`);
    if (p.service === "sampleData" && str(p.bdate ?? "").slice(0, 4) !== str(p.edate ?? "").slice(0, 4)) {
      probs.push(`request ${name}: sampleData is very large; ask for at most one year at a time`);
    }
  }
  return probs;
}

/** [[bdate, edate]] per calendar year (monitors take any range). */
function yearWindows(params: Record<string, unknown>): [string, string][] {
  const b = str(params.bdate ?? ""), e = str(params.edate ?? "");
  if (params.service === "monitors" || !(isDigits(b.slice(0, 4)) && isDigits(e.slice(0, 4))) || b.slice(0, 4) === e.slice(0, 4)) {
    return [[b, e]];
  }
  const out: [string, string][] = [];
  const y0 = Number(b.slice(0, 4)), y1 = Number(e.slice(0, 4));
  for (let y = y0; y <= y1; y++) out.push([y === y0 ? b : `${y}0101`, y === y1 ? e : `${y}1231`]);
  return out;
}

function rowsOf(d: unknown): any[] {
  if (isDict(d)) {
    const rows = "Data" in d ? d.Data : d.Body;
    return Array.isArray(rows) ? rows : [];
  }
  return Array.isArray(d) ? d : [];
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const c = gr.clientFor(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [ep, params0, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const params = beforeRequest(r, ep, params0);
    const wins: [string | null, string | null][] = "bdate" in params ? yearWindows(params) : [[null, null]];
    let rows: any[] = [];
    for (const [b, e] of wins) {
      const p: Record<string, unknown> = { ...params };
      if (b !== null) Object.assign(p, { bdate: b, edate: e });
      const [pth, query] = gr.split(ep, p);
      const d = await c.getJson(pth, query, { allow404: true });
      const status = pyStr(header(d).status ?? "");
      const got = rowsOf(d);
      if (!got.length && status && !status.toLowerCase().includes("no data") && status.toLowerCase() !== "success") {
        notes.push(`${r.name}: AQS status ${pyRepr(status)} for ${str(b)}-${str(e)}`);
      }
      rows = rows.concat(got);
    }
    if (wins.length > 1) notes.push(`${r.name}: ${wins.length} calls, one per year (AQS needs bdate and edate in the same year)`);
    let out = gr.clean(rows, ep);
    if (r.max_rows) out = out.slice(0, Math.trunc(Number(r.max_rows)));
    if (!out.length && !r.allow_empty) {
      throw new DataError(`request ${pyRepr(r.name)}: no data matched (check parameter code, dates and geography; ` +
        "AQS data lag about 6 months)", "bad_request");
    }
    tables[r.name] = out;
  }
  return [tables, notes];
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [ep, params0, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const params = beforeRequest(r, ep, params0);
    const wins: [string | null, string | null][] = "bdate" in params ? yearWindows(params) : [[null, null]];
    wins.forEach(([b, e], i) => {
      const p: Record<string, unknown> = { ...params };
      if (b !== null) Object.assign(p, { bdate: b, edate: e });
      const [pth, query] = gr.split(ep, p);
      const url = `${BASE}${pth}?` + pyUrlencode(query) + "&email={AQS_EMAIL}&key={API_KEY}";
      const fn = wins.length === 1 ? `${r.name}.json` : `${r.name}_${i + 1}.json`;
      const alt = airdataNames(params, (b || "").slice(0, 4));
      items.push({ name: `${r.name}#${i + 1}`, request: r.name, url, filename: fn, needs_key: true, method: "GET",
        body: null, alt_filenames: alt,
        note: "replace {AQS_EMAIL} with the email your AQS key is registered to" +
          (wins.length === 1 ? "" : `; year ${str(b).slice(0, 4)}`) +
          (alt.length ? `; without a key, the AirData file ${AIRDATA_URL}${alt[0]} (as downloaded) holds the same rows` : "") });
    });
  }
  return items;
}

// ---------------------------------------------------------------------- AirData files (the keyless route)
// EPA's pre-generated yearly files hold the same AQS summaries for every monitor in the country: daily files
// per parameter (daily_<code>_<year>.zip, 2-10 MB zipped) and one annual file for all parameters
// (annual_conc_by_monitor_<year>.zip, about 4 MB; hourly files are 70+ MB and not used here; sizes checked
// 2026-10-28). ingest reads the zip as downloaded (or its CSV), keeps the rows the request asks for (state,
// county, site or box, parameter, dates) and names the columns as the API does where the two differ.
const AIRDATA_URL = "https://aqs.epa.gov/aqsweb/airdata/";
const AIRDATA_FILES: Record<string, string> = { dailyData: "daily_{param}_{year}", annualData: "annual_conc_by_monitor_{year}" };
const AIRDATA_COLS: Record<string, string> = { site_num: "site_number", parameter_name: "parameter", method_name: "method",
  address: "site_address", state_name: "state", county_name: "county", city_name: "city",
  cbsa_name: "cbsa", arithmetic_standard_dev: "standard_deviation",
  "99th_percentile": "ninety_ninth_percentile", "98th_percentile": "ninety_eighth_percentile",
  "95th_percentile": "ninety_fifth_percentile", "90th_percentile": "ninetieth_percentile",
  "75th_percentile": "seventy_fifth_percentile", "50th_percentile": "fiftieth_percentile",
  "10th_percentile": "tenth_percentile" };
const ORDINALS: Record<string, string> = { "1st": "first", "2nd": "second", "3rd": "third", "4th": "fourth" };

const fill = (pat: string, param: string, year: string) => pat.replace("{param}", param).replace("{year}", year);

function codes(params: Record<string, unknown>): string[] {
  return pyStr(params.param || "").split(",").map((c) => c.trim()).filter(Boolean);
}

/** The AirData file names that hold this request's rows for one year ([] when no file does). */
function airdataNames(params: Record<string, unknown>, year: string): string[] {
  const pat = AIRDATA_FILES[String(params.service)];
  const cs = codes(params);
  if (!pat || !isDigits(year) || (pat.includes("{param}") && cs.length !== 1)) return []; // daily files hold one parameter each
  const stem = fill(pat, cs.length ? cs[0] : "", year);
  return [stem + ".zip", stem + ".csv"];
}

function airdataCol(h: string): string {
  let c = h.trim().toLowerCase().replace(/[^0-9a-z]+/g, "_").replace(/^_+|_+$/g, "");
  c = AIRDATA_COLS[c] ?? c;
  const first = c.split("_")[0];
  return first in ORDINALS ? ORDINALS[first] + c.slice(first.length) : c;
}

/** Rows of one AirData CSV text, with API-style column names. */
function airdataCsv(text: string): Record<string, string>[] {
  const grid: string[][] = parse(text, { relax_column_count: true, relax_quotes: true, skip_empty_lines: true });
  if (!grid.length) return [];
  const head = grid[0].map(airdataCol);
  return grid.slice(1).map((row) => {
    const o: Record<string, string> = {};
    for (let i = 0; i < Math.min(head.length, row.length); i++) o[head[i]] = row[i];
    return o;
  });
}

const utf8sig = (b: Uint8Array) => new TextDecoder("utf-8").decode(b).replace(/^\uFEFF/, "");

function airdataRows(file: string): Record<string, string>[] {
  if (file.toLowerCase().endsWith(".zip")) {
    const z = unzip(fs.readFileSync(file));
    const out: Record<string, string>[] = [];
    for (const [n, data] of Object.entries(z)) if (n.toLowerCase().endsWith(".csv")) out.push(...airdataCsv(utf8sig(data)));
    return out;
  }
  return airdataCsv(utf8sig(fs.readFileSync(file)));
}

/** A test that keeps the AirData rows this request asks for (the file covers every U.S. monitor). */
function airdataFilter(params: Record<string, unknown>, name: string): (r: Record<string, string>) => boolean {
  const service = params.service, geo = params.geo;
  if (!(String(service) in AIRDATA_FILES)) {
    throw new DataError(`request ${pyRepr(name)}: AirData files hold annualData and dailyData only (not ${str(service)}); ` +
      "the other services need the AQS key", "bad_request");
  }
  if (geo === "byCBSA") {
    throw new DataError(`request ${pyRepr(name)}: AirData files carry CBSA names, not codes: ask byCounty (one request per ` +
      "county of the CBSA) or byBox", "bad_request");
  }
  const want0: [string, string | null][] = [
    ["state_code", !empty(params.state) ? stateFips(params.state) : null],
    ["county_code", !empty(params.county) ? zfill(pyStr(params.county || ""), 3) : null],
    ["site_number", !empty(params.site) ? zfill(pyStr(params.site || ""), 4) : null]];
  const want = want0.filter(([, v]) => v && ["byState", "byCounty", "bySite"].includes(String(geo))) as [string, string][];
  const cs = new Set(codes(params));
  const b = pyStr(params.bdate || ""), e = pyStr(params.edate || "");
  const lo = `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}`, hi = `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}`;
  let box: number[] | null = null;
  if (geo === "byBox") {
    box = ["minlat", "maxlat", "minlon", "maxlon"].map((k) => {
      const f = typeof params[k] === "number" ? (params[k] as number) : pyFloat(str(params[k]));
      if (f === null) throw new Error(`could not convert string to float: ${pyRepr(str(params[k]))}`);
      return f;
    });
  }
  return (r) => {
    if (want.some(([k, v]) => zfill(pyStr(r[k] ?? ""), v.length) !== v)) return false;
    if (cs.size && !cs.has(r.parameter_code as string)) return false;
    if (service === "dailyData") {
      const d = pyStr(r.date_local ?? "");
      if (!(cmp(lo, d) <= 0 && cmp(d, hi) <= 0)) return false;
    } else {
      const y = pyStr(r.year ?? "");
      if (!(cmp(b.slice(0, 4), y) <= 0 && cmp(y, e.slice(0, 4)) <= 0)) return false;
    }
    if (box) {
      if (!("latitude" in r) || !("longitude" in r)) return false;
      const lat = pyFloat(r.latitude), lon = pyFloat(r.longitude);
      if (lat === null || lon === null) return false;
      return box[0] <= lat && lat <= box[1] && box[2] <= lon && lon <= box[3];
    }
    return true;
  };
}

/** API pages saved as JSON (the keyed manual route), or AirData files (.zip as downloaded, or its .csv). */
function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [ep, params0] = gr.resolve(pack, req);
  const params = beforeRequest(req, ep, params0);
  let rows: any[] = [];
  for (const p of [...files].sort(cmp)) {
    const low = p.toLowerCase();
    if (low.endsWith(".zip") || low.endsWith(".csv")) {
      const keep = airdataFilter(params, req.name);
      const service = String(params.service);
      const mark = service === "dailyData" ? "date_local" : "metric_used";
      airdataRows(p).forEach((r, i) => {
        if (i === 0 && !(mark in r)) { // an annual file for a daily request, or another CSV
          throw new DataError(`request ${pyRepr(req.name)}: ${path.basename(p)} is not an AirData ${service} file (` +
            `${fill(AIRDATA_FILES[service], "<code>", "<year>")}.zip)`, "bad_request");
        }
        if (keep(r)) rows.push(r);
      });
      continue;
    }
    rows = rows.concat(rowsOf(parsePyJson(utf8sig(fs.readFileSync(p)))));
  }
  if (!rows.length && !req.allow_empty) {
    throw new DataError(`request ${pyRepr(req.name)}: no row of ${files.map((p) => path.basename(p)).join(", ")} matches ` +
      "the request (state, county, site, parameter, dates): check them, or that the file is the " +
      "right year and parameter", "bad_request");
  }
  return gr.clean(rows, ep);
}

async function ping(client: Client): Promise<{ auth_ok: boolean; kind: string; detail: string }> {
  let d: any;
  try {
    d = await client.getJson("/list/classes", null, { allow404: true });
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    // a 400 or a "Failed" header on a list call means the key or email was not accepted
    const kind = ["api", "bad_request"].includes(e.kind) ? "auth" : e.kind;
    return { auth_ok: !["auth", "key_missing"].includes(kind), kind, detail: e.message };
  }
  const st = pyStr(header(d).status ?? "");
  return { auth_ok: st.toLowerCase() === "success", kind: st.toLowerCase() === "success" ? "" : "auth", detail: `AQS status: ${st}` };
}

const adapter: Adapter = { checkError, beforeRequest, checkSpec, fetch, manualItems, parseUpload, ping,
  yearWindows, airdataNames };
export default adapter;
