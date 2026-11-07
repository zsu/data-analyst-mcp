/**
 * irs-soi adapter: IRS Statistics of Income individual income tax files (ZIP code, county, state, migration).
 *
 * SOI publishes each product as one all-states CSV per tax year (or filing-year pair) under
 * https://www.irs.gov/pub/irs-soi/ (verified 2026-10-30; no key, plain GET):
 *   zip_agi     {yy}zpallagi.csv / {yy}zpallnoagi.csv        TY2011-2023, 216 MB for TY2022 (streamed to a temp file)
 *   county_agi  {yy}incyallagi.csv / {yy}incyallnoagi.csv    TY2011-2023, 36 MB
 *   state_agi   {yy}in55cmcsv.csv (19-23), 18in55cmagi.csv, {yy}in54cmcsv.csv (12, 14-17)   0.8 MB; 2013 is .xlsx only
 *   migration   {state|county}{inflow|outflow}{y1y2}.csv     pairs 2011-2012 to 2022-2023; 0.1 MB (state), 4.5 MB (county)
 * A year not posted answers HTTP 404 (an HTML page).
 *
 * This adapter
 *   - maps the spec (tax_year or start_year/end_year; migration y1 or start_y1/end_y1, level, direction) to file names,
 *   - keeps only the asked rows while reading (state, zipcode, county, agi_stub; migration: the focus state/county),
 *     so a 216 MB file never becomes a table, and optionally only the asked variables (columns),
 *   - upper-cases the column names and puts TAX_YEAR (or Y1_YEAR, Y2_YEAR for migration) first,
 *   - writes numbers without thousands separators and trailing zero decimals; values are otherwise as published,
 *   - migration: the documented suppression code -1 in N1/N2/AGI becomes an empty cell named in SUPPRESSED, and
 *     ROW_TYPE says what each row is (totals, non-migrants, a flow, other flows).
 * The files are cp1252 text (Do\u00f1a Ana County); they are decoded as UTF-8 when valid, else cp1252.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyStr } from "../core/py.js";
import { pyRepr, state, StateError } from "./_dol_states.js";

const BASE = "https://www.irs.gov/pub/irs-soi";
const INDEX: Record<string, string> = {
  zip_agi: "https://www.irs.gov/statistics/soi-tax-stats-individual-income-tax-statistics-zip-code-data-soi",
  county_agi: "https://www.irs.gov/statistics/soi-tax-stats-county-data",
  state_agi: "https://www.irs.gov/statistics/soi-tax-stats-historic-table-2",
  migration: "https://www.irs.gov/statistics/soi-tax-stats-migration-data",
};
const STATE_FILES: Record<number, string> = { 2012: "12in54cmcsv.csv", 2014: "14in54cmcsv.csv", 2015: "15in54cmcsv.csv",
  2016: "16in54cmcsv.csv", 2017: "17in54cmcsv.csv", 2018: "18in55cmagi.csv" }; // 2019+: yyin55cmcsv.csv
const STATE_ONLY_XLSX: Record<number, string> = { 2013: "13in54cmcsv.xlsx" };
const YEAR_KEYS = ["tax_year", "start_year", "end_year"];
const PAIR_KEYS = ["y1", "start_y1", "end_y1"];
const MIG_VALUES = ["N1", "N2", "AGI"];
const NUM = /^(?:-?\d{1,3}(,\d{3})+(\.\d+)?|-?\d+\.\d+)$/;
const ID_COLS = new Set(["STATEFIPS", "STATE", "ZIPCODE", "COUNTYFIPS", "COUNTYNAME", "AGI_STUB"]);

let EPS_: Record<string, any> | null = null;
function EPS(): Record<string, any> {
  if (!EPS_) {
    try {
      EPS_ = readJson(path.join(PACKS_DIR, "irs-soi"), "endpoints.json")?.endpoints || {};
    } catch {
      EPS_ = {};
    }
  }
  return EPS_!;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const blank = (v: unknown) => v === null || v === undefined || v === "";
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const zfill = (s: string, n: number) => s.padStart(n, "0");

/** Python's ValueError/TypeError of int(). */
class IntError extends Error {}

function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new IntError(`cannot convert float ${v} to integer`);
    return Math.trunc(v);
  }
  if (typeof v !== "string") throw new IntError(`int() argument must be a string or a number, not ${pyRepr(v)}`);
  const s = v.trim();
  if (!/^[-+]?\d+(_\d+)*$/.test(s)) throw new IntError(`invalid literal for int() with base 10: ${pyRepr(v)}`);
  return Number(s.replace(/_/g, ""));
}

// ---------------------------------------------------------------------- spec helpers
function list(v: unknown): unknown[] {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined && x !== "");
}

/** Tax years (or migration y1 years) of a request; default the latest verified one. */
function years(r: SpecRequest): number[] {
  const p: any = r.params || {};
  const ep = EPS()[r.endpoint || ""] || {};
  const [one, start, end] = r.endpoint === "migration" ? PAIR_KEYS : YEAR_KEYS;
  if (!blank(p[one])) return [pyInt(p[one])];
  if (!blank(p[start]) || !blank(p[end])) {
    const y0 = pyInt(p[start] || p[end]);
    const y1 = pyInt(p[end] || ep.last_year_verified || y0);
    const out: number[] = [];
    for (let y = y0; y <= y1; y++) out.push(y);
    return out;
  }
  return [pyInt(ep.last_year_verified || new Date().getFullYear() - 3)];
}

function agiClasses(p: any): boolean {
  const v = "agi_classes" in p ? p.agi_classes : true;
  return !(v === false || ["false", "0", "no"].includes(pyStr(v === null ? "None" : v).trim().toLowerCase()));
}

const yy = (y: number) => zfill(String(((y % 100) + 100) % 100), 2);

function file(endpoint: string, year: number, p: any): string {
  if (endpoint === "zip_agi") return `${yy(year)}zpall${agiClasses(p) ? "agi" : "noagi"}.csv`;
  if (endpoint === "county_agi") return `${yy(year)}incyall${agiClasses(p) ? "agi" : "noagi"}.csv`;
  if (endpoint === "state_agi") return STATE_FILES[year] ?? `${yy(year)}in55cmcsv.csv`;
  if (endpoint === "migration") return `${pyStr(p.level ?? "None")}${pyStr(p.direction ?? "None")}${yy(year)}${yy(year + 1)}.csv`;
  throw new DataError(`unknown endpoint ${pyRepr(endpoint)}`, "bad_request");
}

/** [USPS codes, FIPS codes] of the spec's state filter; throws StateError for an unknown state. */
function states(p: any, endpoint: string): [Set<string>, Set<string>] {
  const usps = new Set<string>(), fips = new Set<string>();
  for (const s of list(p.state)) {
    const k = pyStr(s).trim().toUpperCase();
    if (endpoint === "state_agi" && (k === "US" || k === "OA")) {
      usps.add(k);
      continue;
    }
    usps.add(state(s, "usps"));
    fips.add(state(s, "fips"));
  }
  return [usps, fips];
}

/** [5-digit FIPS, 3-digit county codes, lower-case names] of the spec's county filter. */
function counties(p: any): [Set<string>, Set<string>, Set<string>] {
  const full = new Set<string>(), code = new Set<string>(), names = new Set<string>();
  for (const c of list(p.county)) {
    const s = pyStr(c).trim();
    if (/^\d+$/.test(s) && s.length === 5) full.add(s);
    else if (/^\d+$/.test(s) && s.length <= 3) code.add(zfill(s, 3));
    else names.add(s.toLowerCase());
  }
  return [full, code, names];
}

function checkSpec(spec: Spec, _pack: Pack): string[] {
  const probs: string[] = [];
  const thisYear = new Date().getFullYear();
  for (const r of spec.requests || []) {
    const name = pyRepr(r.name ?? null), endpoint = r.endpoint || "";
    if (!(endpoint in EPS())) continue; // generic resolve() names the unknown endpoint
    const p: any = r.params || {};
    const ep = EPS()[endpoint];
    const keys = endpoint === "migration" ? PAIR_KEYS : YEAR_KEYS;
    const other = endpoint === "migration" ? YEAR_KEYS : PAIR_KEYS;
    const wrong = other.filter((k) => !blank(p[k]));
    if (wrong.length) {
      probs.push(`request ${name}: ${endpoint} takes ${keys.join(", ")}, not ${wrong.join(", ")}` +
        (endpoint === "migration" ? " (y1 = the first filing year of the pair: 2022 for 2022-2023)" : ""));
      continue;
    }
    let ys: number[];
    try {
      for (const k of keys) if (!blank(p[k])) pyInt(p[k]);
      ys = years(r);
    } catch (e) {
      if (!(e instanceof IntError)) throw e;
      probs.push(`request ${name}: ${keys.join(", ")} must be four-digit years`);
      continue;
    }
    if (!ys.length) {
      probs.push(`request ${name}: the end year is before the start year`);
      continue;
    }
    const first = ep.first_year, last = ep.last_year_verified;
    const what = endpoint === "migration" ? "filing-year pairs" : "tax years";
    if (ys[0] < first) {
      probs.push(`request ${name}: ${endpoint} CSV files cover ${what} from ${first}` + (endpoint === "migration" ? `-${first + 1}` : "") +
        ` (asked ${ys[0]}); older years are zipped Excel files on ${INDEX[endpoint]} (manual)`);
    }
    if (ys[ys.length - 1] > thisYear - 1) probs.push(`request ${name}: ${ys[ys.length - 1]} cannot be posted yet (latest verified: ${last})`);
    if (ys.length > 15) probs.push(`request ${name}: ${ys.length} years is one file each; narrow the range`);
    if (endpoint === "state_agi") {
      for (const y of ys) {
        if (y in STATE_ONLY_XLSX) {
          probs.push(`request ${name}: state data for tax year ${y} is published only as ` +
            `${BASE}/${STATE_ONLY_XLSX[y]} (not read here); use another year or the manual route`);
        }
      }
    }
    let usps: Set<string>, fips: Set<string>;
    try {
      [usps, fips] = states(p, endpoint);
    } catch (e) {
      if (!(e instanceof StateError)) throw e;
      probs.push(`request ${name}: ${e.message}`);
      continue;
    }
    const zips = list(p.zipcode).map((z) => pyStr(z).trim());
    if (endpoint === "zip_agi") {
      if (!usps.size && !zips.length) {
        probs.push(`request ${name}: zip_agi needs state (or zipcode): the all-states file has about ` +
          "166,000 rows of 165 columns");
      }
      const bad = zips.filter((z) => !/^\d{5}$/.test(z));
      if (bad.length) probs.push(`request ${name}: zipcode must be 5-digit strings (got ${pyRepr(bad)})`);
    } else if (zips.length) probs.push(`request ${name}: zipcode applies to zip_agi only`);
    if (!(blank(p.county) || (Array.isArray(p.county) && !p.county.length))) {
      if (!["county_agi", "migration"].includes(endpoint) || (endpoint === "migration" && p.level !== "county")) {
        probs.push(`request ${name}: county applies to county_agi and to migration with level county`);
      }
      const [, code, names] = counties(p);
      if ((code.size || names.size) && !fips.size) {
        probs.push(`request ${name}: a 3-digit county code or county name needs state (or give the ` +
          "5-digit state+county FIPS, e.g. 24031)");
      }
      if (names.size && endpoint === "migration") {
        probs.push(`request ${name}: migration takes county FIPS codes, not names (${pyRepr([...names].sort(cmp))})`);
      }
    }
    const stubs = list(p.agi_stub);
    if (stubs.length) {
      if (endpoint === "migration") probs.push(`request ${name}: agi_stub does not apply to migration files`);
      else {
        const top = ({ zip_agi: 6, county_agi: 8, state_agi: 10 } as Record<string, number>)[endpoint];
        const low = endpoint === "state_agi" ? 0 : 1;
        if (stubs.some((s) => !/^\d+$/.test(pyStr(s).trim()) || !(low <= pyInt(s) && pyInt(s) <= top))) {
          probs.push(`request ${name}: agi_stub for ${endpoint} is ${low}-${top} (see source.md)`);
        }
        if ((endpoint === "zip_agi" || endpoint === "county_agi") && !agiClasses(p)) {
          probs.push(`request ${name}: agi_stub needs agi_classes true (the no-class file has AGI_STUB 0 only)`);
        }
      }
    }
    if (!(blank(p.columns) || (Array.isArray(p.columns) && !p.columns.length)) && endpoint === "migration") {
      probs.push(`request ${name}: columns does not apply to migration files (9 columns)`);
    }
  }
  return probs;
}

// ---------------------------------------------------------------------- reading and filtering
function isUtf8File(file: string): boolean {
  const dec = new TextDecoder("utf-8", { fatal: true });
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      dec.decode(buf.subarray(0, n), { stream: true });
    }
    dec.decode();
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** The text of a downloaded file, in chunks: UTF-8 when the whole file is valid UTF-8, else cp1252. */
async function* fileText(file: string): AsyncGenerator<string> {
  const dec = new TextDecoder(isUtf8File(file) ? "utf-8" : "windows-1252");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) yield dec.decode(chunk as Buffer, { stream: true });
  const tail = dec.decode();
  if (tail) yield tail;
}

/** csv.reader over text chunks (any of CRLF, LF, CR ends a record). */
function csvReader(chunks: AsyncIterable<string>): AsyncIterable<string[]> {
  return Readable.from(chunks).pipe(parse({ relax_column_count: true, relax_quotes: true, skip_empty_lines: false,
    record_delimiter: ["\r\n", "\n", "\r"] }));
}

function decodeBody(data: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

function clean(v0: string | null | undefined): string {
  let v = (v0 || "").trim();
  if (NUM.test(v)) {
    v = v.replaceAll(",", "");
    if (v.includes(".")) {
      v = v.replace(/0+$/, "").replace(/\.$/, "");
      v = ["", "-", "-0"].includes(v) ? "0" : v;
    }
  }
  return v;
}

/** What a migration row is. Focus = the state/county whose inflow (Y2) or outflow (Y1) the file lists. */
function rowType(row: Row, direction: unknown, level: unknown): string {
  const [f, o] = direction === "inflow" ? ["Y2", "Y1"] : ["Y1", "Y2"];
  const g = (k: string) => (k in row ? (row[k] as string) : "");
  const fs_ = g(`${f}_STATEFIPS`), os_ = g(`${o}_STATEFIPS`);
  const fc = g(`${f}_COUNTYFIPS`), oc = g(`${o}_COUNTYFIPS`);
  const otherName = String(row[`${o}_STATE_NAME`] || row[`${o}_COUNTYNAME`] || "").toLowerCase();
  if (level === "county" && fc === "000") return "state_summary"; // 2011-2017 county files carried state header rows
  if (os_ === "96") return "total_us_and_foreign";
  if (os_ === "98") return "total_foreign";
  if (os_ === "97") {
    if (level === "county") return ({ "000": "total_us", "001": "total_same_state", "003": "total_different_state" } as Record<string, string>)[oc] ?? "total";
    return otherName.includes("same state") ? "total_same_state" : "total_us";
  }
  if (os_ === "57") return "foreign";
  if (os_ === "58" || os_ === "59") return "other_flows";
  if (os_ === fs_ && (level === "state" || oc === fc)) return "non_migrants";
  return "flow";
}

/** County name match. The county files cut COUNTYNAME to 20 characters ("Prince George's Coun", TY2022), so a
 * published name of that length also matches an asked name it begins. */
export function nameHit(published: string, names: Set<string>): boolean {
  const pub = published.trim().toLowerCase();
  const bare = pub.endsWith(" county") ? pub.slice(0, -" county".length) : pub;
  return [...names].some((n) => pub === n || bare === n || (pub.length >= 18 && n.startsWith(pub)));
}

/** A predicate on raw CSV rows for the spec's filters, given the upper-cased header. */
function filter(endpoint: string, p: any, head: string[]): (r: string[]) => boolean {
  const ix = new Map<string, number>();
  head.forEach((h, i) => ix.set(h, i));
  const [usps, fips] = states(p, endpoint);
  const tests: ((r: string[]) => boolean)[] = [];
  const col = (...names: string[]): number => {
    for (const n of names) if (ix.has(n)) return ix.get(n)!;
    throw new DataError(`the file has no ${names[0]} column (columns: ${head.slice(0, 8).join(", ")} ...): the layout ` +
      "changed; see source.md", "api");
  };
  const cell = (r: string[], i: number) => (r[i] ?? "").trim();
  if (endpoint === "migration") {
    const f = p.direction === "inflow" ? "Y2" : "Y1";
    const si = col(`${f}_STATEFIPS`);
    if (fips.size) tests.push((r) => fips.has(zfill(cell(r, si), 2)));
    if (p.level === "county" && list(p.county).length) {
      const ci = col(`${f}_COUNTYFIPS`);
      const [full, code] = counties(p);
      tests.push((r) => full.has(zfill(cell(r, si), 2) + zfill(cell(r, ci), 3)) || code.has(zfill(cell(r, ci), 3)));
    }
  } else {
    if (usps.size || fips.size) {
      const si = col("STATE");
      const fi = ix.get("STATEFIPS");
      tests.push((r) => usps.has(cell(r, si).toUpperCase()) || (fi !== undefined && fips.has(zfill(cell(r, fi), 2))));
    }
    const zips = new Set(list(p.zipcode).map((z) => pyStr(z).trim()));
    if (zips.size && endpoint === "zip_agi") {
      const zi = col("ZIPCODE");
      tests.push((r) => zips.has(zfill(cell(r, zi), 5)));
    }
    if (endpoint === "county_agi" && list(p.county).length) {
      const [full, code, names] = counties(p);
      const sfi = col("STATEFIPS"), ci = col("COUNTYFIPS"), ni = col("COUNTYNAME");
      tests.push((r) => full.has(zfill(cell(r, sfi), 2) + zfill(cell(r, ci), 3)) || code.has(zfill(cell(r, ci), 3)) ||
        nameHit(r[ni] ?? "", names));
    }
    const stubs = new Set(list(p.agi_stub).map((s) => String(pyInt(s))));
    if (stubs.size) {
      const ai = col("AGI_STUB");
      tests.push((r) => stubs.has(cell(r, ai)));
    }
  }
  return (r) => tests.every((t) => t(r));
}

/** Filtered, tidied rows of one file (CSV rows, header first). Returns [rows, truncated]. */
async function read(endpoint: string, p: any, year: number, textRows: AsyncIterable<string[]>, limit: number, notes: string[],
  name: string): Promise<[Row[], boolean]> {
  const it = textRows[Symbol.asyncIterator]();
  const rows: Row[] = [];
  let truncated = false;
  try {
    const first = await it.next();
    if (first.done) return [[], false];
    const head = first.value.map((h) => h.trim().toUpperCase());
    if (head.length && head[0].startsWith("<")) {
      throw new DataError(`${name}: got an HTML page instead of the CSV (the file moved or the host refused the request)`, "api");
    }
    if (endpoint !== "migration" && !head.includes("AGI_STUB")) {
      throw new DataError(`${name}: tax year ${year} file has no AGI_STUB column (columns: ${head.slice(0, 6).join(", ")} ...); ` +
        "the layout changed", "api");
    }
    let keep: number[] | null = null;
    const want = list(p.columns).map((c) => pyStr(c).trim().toUpperCase());
    if (want.length) {
      const missing = want.filter((c) => !head.includes(c));
      if (missing.length) {
        notes.push(`${name}: tax year ${year} has no ${missing.join(", ")} (variables change between years; ` +
          "see the year's users guide)");
      }
      keep = head.map((h, i) => [h, i] as [string, number]).filter(([h]) => ID_COLS.has(h) || want.includes(h)).map(([, i]) => i);
    }
    const ok = filter(endpoint, p, head);
    const direction = p.direction, level = p.level;
    const idx = keep ?? head.map((_, i) => i);
    for (;;) {
      const n = await it.next();
      if (n.done) break;
      const raw = n.value;
      if (!raw.length || !raw.some((x) => x.trim())) continue;
      if (!ok(raw)) continue;
      if (rows.length >= limit) {
        truncated = true;
        break;
      }
      const rec: Row = {};
      for (const i of idx) rec[head[i]] = clean(i < raw.length ? raw[i] : "");
      if (endpoint === "migration") {
        const sup = MIG_VALUES.filter((k) => rec[k] === "-1");
        for (const k of sup) rec[k] = "";
        rows.push({ Y1_YEAR: year, Y2_YEAR: year + 1, ...rec, SUPPRESSED: sup.join(";"), ROW_TYPE: rowType(rec, direction, level) });
      } else rows.push({ TAX_YEAR: year, ...rec });
    }
  } finally {
    await it.return?.();
  }
  return [rows, truncated];
}

function label(endpoint: string, p: any, y: number): string {
  if (endpoint === "migration") return `${pyStr(p.level ?? "None")} ${pyStr(p.direction ?? "None")} ${y}-${y + 1}`;
  return `tax year ${y}`;
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const client = gr.clientFor(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "data-analyst-irs-soi-")); // outside the package; removed below
  const got = new Map<string, string>(); // file name -> local path (one download per run)
  try {
    for (const r of spec.requests) {
      const [ep, , probs] = gr.resolve(pack, r);
      if (probs.length) throw new DataError(probs.join("; "), "bad_request");
      const endpoint = r.endpoint!;
      const p: any = r.params || {};
      const limit = Number(r.max_rows || ep.max_rows || pack.policy.limits.max_rows || 200000);
      let rows: Row[] = [];
      const missing: string[] = [];
      for (const y of years(r)) {
        const fname = file(endpoint, y, p);
        if (!got.has(fname)) {
          const dest = path.join(tmp, fname);
          try {
            if (ep.stream) await client.download(`/${fname}`, dest);
            else fs.writeFileSync(dest, decodeBody((await client.get(`/${fname}`)).body), "utf8");
          } catch (e) {
            if (!(e instanceof DataError)) throw e;
            if (e.kind !== "not_found") throw new DataError(`request ${pyRepr(r.name)} (${fname}): ${e.message}`, e.kind, e.status);
            missing.push(`${label(endpoint, p, y)} (${fname})`);
            continue;
          }
          got.set(fname, dest);
        }
        const [part, cut] = await read(endpoint, p, y, csvReader(fileText(got.get(fname)!)), limit - rows.length, notes, r.name);
        rows = rows.concat(part);
        if (cut) {
          notes.push(`${r.name}: stopped at ${fmt(limit)} rows (max_rows); narrow the filter (state, county, agi_stub) or raise max_rows`);
          break;
        }
      }
      if (missing.length) {
        const last = (EPS()[endpoint] || {}).last_year_verified;
        throw new DataError(`request ${pyRepr(r.name)}: not posted on irs.gov (HTTP 404): ${missing.join(", ")}. ` +
          `Latest verified on 2026-10-30: ${label(endpoint, p, last)}; see ${INDEX[endpoint]}`, "not_found");
      }
      if (!rows.length && !r.allow_empty) {
        throw new DataError(`request ${pyRepr(r.name)} matched no rows: check state/county/zipcode/agi_stub ` +
          '(see source.md); add "allow_empty": true if none is a correct answer', "bad_request");
      }
      notes.push(`${r.name}: ${fmt(rows.length)} rows from ${years(r).map((y) => file(endpoint, y, p)).join(", ")}` +
        (endpoint !== "migration" ? "; amounts in thousands of dollars" : "; AGI in thousands of dollars; SUPPRESSED names cells published as -1"));
      tables[r.name] = rows;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return [tables, notes];
}

// ---------------------------------------------------------------------- manual route
function manualItems(spec: Spec, _pack: Pack): any[] {
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const endpoint = r.endpoint || "";
    if (!(endpoint in EPS())) continue;
    const p: any = r.params || {};
    let ys: number[];
    try {
      ys = years(r);
    } catch (e) {
      if (e instanceof IntError) continue;
      throw e;
    }
    for (const y of ys) {
      const fname = file(endpoint, y, p);
      items.push({ name: `${r.name}#${y}`, request: r.name, url: `${BASE}/${fname}`, filename: fname, needs_key: false,
        method: "GET", body: null, note: `${label(endpoint, p, y)}: the all-states CSV, uploaded unchanged (ingest keeps ` +
          `the asked rows); listed on ${INDEX[endpoint]}` });
    }
  }
  return items;
}

async function parseUpload(_pack: Pack | null, req: SpecRequest, files: string[]): Promise<Row[]> {
  const endpoint = req.endpoint || "";
  const p: any = req.params || {};
  const ys = years(req);
  const byName = new Map(ys.map((y) => [file(endpoint, y, p).toLowerCase(), y] as [string, number]));
  let rows: Row[] = [];
  const notes: string[] = [];
  const limit = Number(req.max_rows || (EPS()[endpoint] || {}).max_rows || 200000);
  for (const f of [...files].sort(cmp)) {
    const base = path.basename(f).toLowerCase();
    let y = byName.get(base);
    if (!y) {
      const hit = [...byName].find(([n]) => base.startsWith(n.replace(/\.[^.]*$/, "")));
      y = hit ? hit[1] : ys.length === 1 ? ys[0] : undefined;
    }
    if (y === undefined) {
      throw new DataError(`${path.basename(f)}: cannot tell its year; upload the file under its published ` +
        `name (${[...byName.keys()].sort(cmp).join(", ")})`, "bad_request");
    }
    const [part] = await read(endpoint, p, y, csvReader(fileText(f)), limit - rows.length, notes, req.name);
    rows = rows.concat(part);
  }
  return rows;
}

const adapter: Adapter = { checkSpec, fetch, manualItems, parseUpload: parseUpload as Adapter["parseUpload"], nameHit,
  parseUploadDirect: parseUpload };
export default adapter;
