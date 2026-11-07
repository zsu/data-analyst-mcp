/**
 * snapqc adapter: the SNAP Quality Control public-use database (snapqcdata.net, Mathematica for USDA FNS).
 *
 * There is no API (verified 2026-10-31). The site lists one group of files per fiscal year on /datafiles?page=N
 * (a "Year YYYY" heading, then rows Resource Type | Data format | File); the file URLs sit in upload folders by
 * month (/sites/default/files/2026-08/qcfy2024_csv.zip), so a fetch reads the listing and never builds a URL. CSV
 * zips exist from FY 2014; earlier years are SAS, Stata and SPSS files this pack does not read.
 *
 *   - FY 2018 lists two CSV zips; the later upload is the reweighted file. Several CSVs of one database: the latest
 *     upload folder wins and a note names the other; two in the same folder is an error (no guessing).
 *   - FY 2020 has three databases: qcfy2020, qcfy2020_per1 (Oct-Feb) and qcfy2020_per2 (Jun-Sep). In the period
 *     files FYWGT is the full FY 2020 file's weight (HWGT / 9).
 *   - FY 2021 holds July-September 2021 only (FYWGT = HWGT / 3).
 * Each zip must hold one CSV named qc_pub_fy<YYYY>[_perN].csv. Gates on every read (a failure stops the request):
 * the required columns, unique column names, every row as long as the header, unique HHLDNO, YRMONTH inside the
 * fiscal year, positive numeric weights. summary also checks, in full-year files, that HWGT divided by the state's
 * number of sample months equals FYWGT on every row, and for FY 2024 compares the national totals with the
 * technical documentation.
 */
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import * as gr from "../core/generic-rest.js";
import { PACKS_DIR } from "../core/env.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyFloatRepr } from "../core/py.js";
import { comma, commaFixed, pyFloat, pyInt, pyRepr, pyRound, pyStrip, toTable, unescapeHtml, type ORow } from "./_omb_util.js";

const EPS: any = readJson(path.join(PACKS_DIR, "snapqc"), "endpoints.json") || {};

// The 53 SNAP state agencies in the file (STATE is the FIPS code without a leading zero; FY 2024 tech doc Table E.1)
const AREAS: [string, number, string][] = [["AL", 1, "Alabama"], ["AK", 2, "Alaska"], ["AZ", 4, "Arizona"], ["AR", 5, "Arkansas"],
  ["CA", 6, "California"], ["CO", 8, "Colorado"], ["CT", 9, "Connecticut"], ["DE", 10, "Delaware"],
  ["DC", 11, "District of Columbia"], ["FL", 12, "Florida"], ["GA", 13, "Georgia"], ["HI", 15, "Hawaii"],
  ["ID", 16, "Idaho"], ["IL", 17, "Illinois"], ["IN", 18, "Indiana"], ["IA", 19, "Iowa"], ["KS", 20, "Kansas"],
  ["KY", 21, "Kentucky"], ["LA", 22, "Louisiana"], ["ME", 23, "Maine"], ["MD", 24, "Maryland"],
  ["MA", 25, "Massachusetts"], ["MI", 26, "Michigan"], ["MN", 27, "Minnesota"], ["MS", 28, "Mississippi"],
  ["MO", 29, "Missouri"], ["MT", 30, "Montana"], ["NE", 31, "Nebraska"], ["NV", 32, "Nevada"],
  ["NH", 33, "New Hampshire"], ["NJ", 34, "New Jersey"], ["NM", 35, "New Mexico"], ["NY", 36, "New York"],
  ["NC", 37, "North Carolina"], ["ND", 38, "North Dakota"], ["OH", 39, "Ohio"], ["OK", 40, "Oklahoma"],
  ["OR", 41, "Oregon"], ["PA", 42, "Pennsylvania"], ["RI", 44, "Rhode Island"], ["SC", 45, "South Carolina"],
  ["SD", 46, "South Dakota"], ["TN", 47, "Tennessee"], ["TX", 48, "Texas"], ["UT", 49, "Utah"],
  ["VT", 50, "Vermont"], ["VA", 51, "Virginia"], ["WA", 53, "Washington"], ["WV", 54, "West Virginia"],
  ["WI", 55, "Wisconsin"], ["WY", 56, "Wyoming"], ["GU", 66, "Guam"], ["VI", 78, "Virgin Islands"]];
const BY_FIPS = new Map<number, [string, string]>(AREAS.map(([a, f, n]) => [f, [a, n]]));
const LOOKUP = new Map<string, number>([
  ...AREAS.map(([a, f]) => [a.toLowerCase(), f] as [string, number]),
  ...AREAS.map(([, f, n]) => [n.toLowerCase(), f] as [string, number]),
  ...AREAS.map(([, f]) => [String(f), f] as [string, number]),
  ...AREAS.map(([, f]) => [String(f).padStart(2, "0"), f] as [string, number]),
  ["u.s. virgin islands", 78], ["us virgin islands", 78], ["washington dc", 11]]);
const NAME = /^[A-Z][A-Z0-9_]*\*?$/;

/** Python's ValueError: a spec value check_spec reports. */
class SpecError extends Error {}

const blank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
const pyS = (v: unknown) => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unique = <T>(xs: T[]) => [...new Set(xs)];

// ---------------------------------------------------------------------- spec parameters
function years(v: unknown): number[] {
  const lo = EPS.csv_first_year;
  const vals = Array.isArray(v) ? v : [v];
  const out: number[] = [];
  for (const x of vals) {
    let y: number;
    try {
      y = pyInt(pyStrip(pyS(x)));
    } catch {
      throw new SpecError(`fiscal_year ${pyRepr(x)} is not a year`);
    }
    if (!(lo <= y && y <= 2100)) {
      throw new SpecError(`fiscal_year ${y}: CSV files exist from FY ${lo} (FY 1996-${lo - 1} are SAS, Stata and ` +
        "SPSS files only; source.md Access)");
    }
    out.push(y);
  }
  if (!out.length) throw new SpecError("fiscal_year is required");
  return unique(out);
}

function database(fy: number, period0: unknown): string {
  const period = pyStrip(pyS(period0 || "full")).toLowerCase();
  if (!["full", "per1", "per2"].includes(period)) throw new SpecError(`period ${pyRepr(period)} is not full, per1 or per2`);
  if (period !== "full" && fy !== 2020) throw new SpecError(`period ${pyRepr(period)} exists for FY 2020 only`);
  return `qcfy${fy}` + (period === "full" ? "" : `_${period}`);
}

function states(v: unknown): Set<number> | null {
  if (blank(v)) return null;
  const out = new Set<number>();
  for (const x of Array.isArray(v) ? v : [v]) {
    const f = LOOKUP.get(pyStrip(pyS(x)).toLowerCase());
    if (f === undefined) {
      throw new SpecError(`state ${pyRepr(x)} is not one of the 53 SNAP state agencies (50 states, DC, Guam, Virgin ` +
        "Islands; USPS code, FIPS code or name)");
    }
    out.add(f);
  }
  return out;
}

function fyMonths(fy: number): string[] {
  return [...[10, 11, 12].map((m) => `${fy - 1}${m}`), ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => `${fy}0${m}`)];
}

function month(v: unknown, fy: number): string | null {
  if (v === null || v === undefined || v === "") return null;
  const m = pyStrip(pyS(v));
  if (!/^\d{6}$/.test(m) || !fyMonths(fy).includes(m)) {
    throw new SpecError(`month ${pyRepr(v)}: give YYYYMM inside FY ${fy} (${fy - 1}10 to ${fy}09)`);
  }
  return m;
}

function names(v: unknown, what: string): string[] | "all" | null {
  if (blank(v)) return null;
  if (typeof v === "string" && pyStrip(v).toLowerCase() === "all") return "all";
  const vals = Array.isArray(v) ? v : pyStrip(pyS(v)).split(/[\s,]+/);
  return vals.map((x0) => {
    const x = pyStrip(pyS(x0)).toUpperCase();
    if (!NAME.test(x)) throw new SpecError(`${what}: ${pyRepr(x)} is not a variable name (letters, digits, _; a stem may end in *)`);
    return x;
  });
}

const bool = (v: unknown) => v === true || ["true", "1", "yes"].includes(pyStrip(pyS(v)).toLowerCase());

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {}, e = r.endpoint || "", n = pyRepr(r.name ?? null);
    if (!["units", "persons", "summary"].includes(e)) continue;
    try {
      for (const fy of years(p.fiscal_year)) {
        database(fy, p.period);
        month(p.month, fy);
      }
      states(p.state);
      names(p.variables, "variables");
      if (e === "persons") {
        const pv = names(p.person_variables, "person_variables");
        if (pv === "all" || (pv || []).some((x) => x.endsWith("*"))) {
          probs.push(`request ${n}: person_variables are stems without a number or * (AGE, SEX)`);
        }
      }
    } catch (ex) {
      if (!(ex instanceof SpecError)) throw ex;
      probs.push(`request ${n}: ${ex.message}`);
    }
  }
  return probs;
}

// ---------------------------------------------------------------------- the listing
export type Listed = { year: number; resource: string; format: string; path: string; size: string };

const strip = (s: string) => unescapeHtml(s.replace(/<[^>]+>/g, " "));

/** Rows of one /datafiles page: {year, resource, format, path, size}, in page order. */
export function listingFiles(pageHtml: string): Listed[] {
  const start = pageHtml.indexOf("view-content");
  const out: Listed[] = [];
  let year: number | null = null;
  for (const m of pageHtml.slice(Math.max(start, 0)).matchAll(/<h3>([\s\S]*?)<\/h3>|<tr>([\s\S]*?)<\/tr>/g)) {
    if (m[1] !== undefined) {
      const y = /^\s*Year\s+(\d{4})\b/.exec(strip(m[1]));
      year = y ? Number(y[1]) : null;
      continue;
    }
    const tr = m[2];
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => pyStrip(strip(c[1]).replace(/\s+/g, " ")));
    const a = /href="https?:\/\/snapqcdata\.net(\/sites\/default\/files\/[^"]+)"/.exec(tr);
    if (year === null || cells.length < 3 || !a) continue;
    out.push({ year, resource: cells[0], format: cells[1], path: a[1], size: (/length=(\d+)/.exec(tr) || [null, ""])[1] as string });
  }
  return out;
}

/** The listing's QC Data CSV rows of one database (qcfy2020_per1 is not qcfy2020). */
export function csvCandidates(rows: Listed[], fy: number, db: string): Listed[] {
  return rows.filter((r) => {
    const name = r.path.slice(r.path.lastIndexOf("/") + 1).toLowerCase();
    const m = /^(qcfy\d{4}(?:_per\d)?)_csv(?:_\d+)?\.zip$/.exec(name);
    return r.year === fy && r.resource === "QC Data" && r.format === "CSV" && !!m && m[1] === db;
  });
}

export function pickCsv(cands: Listed[], db: string): [Listed, string[]] {
  if (!cands.length) {
    throw new DataError(`snapqc: the snapqcdata.net listing has no CSV file for ${db} (CSV zips exist from FY ` +
      `${EPS.csv_first_year}; a year not yet released is not listed)`, "not_found");
  }
  const folder = (r: Listed) => /\/files\/(\d{4}-\d{2})\//.exec(r.path)?.[1] ?? "";
  const newest = cands.map(folder).reduce((a, b) => (b > a ? b : a));
  const byPath = new Map<string, Listed>();
  for (const r of cands) if (folder(r) === newest) byPath.set(r.path, r);
  const top = [...byPath.values()];
  if (top.length > 1) {
    throw new DataError(`snapqc: the listing has several ${db} CSV files uploaded in ${newest} ` +
      `(${top.map((r) => r.path).join(", ")}); not guessing which is current`, "api");
  }
  const older = unique(cands.map((r) => r.path)).filter((p) => p !== top[0].path).sort((a, b) => (a < b ? -1 : 1));
  return [top[0], older.length ? [`the listing also has ${older.join(", ")} for ${db}; used the latest upload, ${top[0].path}`] : []];
}

/** Listing pages and zips, read once per fetch. */
class Site {
  c: Client;
  pages = new Map<number, string>();
  zips = new Map<string, Buffer>();
  constructor(pack: Pack) {
    this.c = gr.clientFor(pack);
  }
  async page(i: number): Promise<string> {
    if (!this.pages.has(i)) {
      const L = EPS.listing;
      this.pages.set(i, (await this.c.get(L.path, { [L.page_param]: i })).body.toString("utf8"));
    }
    return this.pages.get(i)!;
  }
  async findCsv(fy: number, db: string): Promise<[Listed, string[]]> {
    const rows: Listed[] = [];
    for (let i = 0; i < EPS.listing.max_pages; i++) {
      const got = listingFiles(await this.page(i));
      rows.push(...got);
      if (!got.length || Math.min(...got.map((r) => r.year)) < fy) break; // the year's group is complete
    }
    return pickCsv(csvCandidates(rows, fy, db), db);
  }
  async zip(p: string): Promise<Buffer> {
    if (!this.zips.has(p)) {
      const body = (await this.c.get(p)).body;
      if (body.subarray(0, 2).toString("latin1") !== "PK") {
        throw new DataError(`snapqc: ${p} did not return a zip file (see the listing at ` +
          `${EPS.base_url}${EPS.listing.path})`, "api");
      }
      this.zips.set(p, body);
    }
    return this.zips.get(p)!;
  }
}

// ---------------------------------------------------------------------- reading one database
export function memberName(db: string): string {
  return "qc_pub_" + db.slice(2) + ".csv"; // qcfy2020_per1 -> qc_pub_fy2020_per1.csv
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
const base = (n: string) => n.slice(n.lastIndexOf("/") + 1);

function zipNames(body: Uint8Array): string[] {
  const out: string[] = [];
  try {
    unzipSync(body, { filter: (f) => (out.push(f.name), false) });
  } catch {
    throw new DataError("snapqc: the upload is not a readable zip file", "api");
  }
  return out;
}

/** The database's CSV from a zip (or a bare CSV upload), as text (Latin-1). */
function csvText(body: Uint8Array, db: string): string {
  const want = memberName(db);
  if (isZip(body)) {
    const all = zipNames(body);
    const hits = all.filter((n) => base(n).toLowerCase() === want);
    if (hits.length !== 1) throw new DataError(`snapqc: the ${db} zip should hold one ${want}; it holds ${pyRepr(all)}`, "api");
    return Buffer.from(unzipSync(body, { filter: (f) => f.name === hits[0] })[hits[0]]).toString("latin1");
  }
  return Buffer.from(body).toString("latin1");
}

/** Records of a CSV text as Python's csv.reader gives them (excel dialect, not strict; a blank line is []). */
function* csvRecords(s: string): Generator<string[]> {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const row: string[] = [];
    let c = s.charCodeAt(i);
    if (c === 10 || c === 13) {
      i += c === 13 && s.charCodeAt(i + 1) === 10 ? 2 : 1;
      yield row;
      continue;
    }
    for (;;) {
      // one field, starting at i
      let f = "";
      if (s.charCodeAt(i) === 34) {
        i++;
        for (;;) {
          const q = s.indexOf('"', i);
          if (q < 0) {
            f += s.slice(i);
            i = n;
            break;
          }
          f += s.slice(i, q);
          i = q + 1;
          if (s.charCodeAt(i) === 34) {
            f += '"';
            i++;
            continue;
          }
          break;
        }
      }
      // unquoted text, or text after a closing quote (kept, as the non-strict reader does)
      let j = i;
      while (j < n) {
        c = s.charCodeAt(j);
        if (c === 44 || c === 10 || c === 13) break;
        j++;
      }
      f += s.slice(i, j);
      row.push(f);
      i = j;
      if (i >= n) break;
      c = s.charCodeAt(i);
      if (c === 44) {
        i++;
        if (i >= n) {
          row.push("");
          break;
        }
        continue;
      }
      i += c === 13 && s.charCodeAt(i + 1) === 10 ? 2 : 1; // end of the record
      break;
    }
    yield row;
  }
}

/** str.strip(), fast for the usual cell with no whitespace at either end. */
function cellStrip(s: string): string {
  if (!s) return s;
  const a = s.charCodeAt(0), b = s.charCodeAt(s.length - 1);
  return a > 32 && a < 127 && b > 32 && b < 127 ? s : pyStrip(s);
}

type DbRow = Record<string, string>;

/** One database's rows, gated. rows: only the columns asked for plus the ids. */
export class Database {
  header: string[];
  rows: DbRow[] = [];
  months: string[];
  constructor(body: Uint8Array, public fy: number, public db: string, keep: (h: string[]) => string[]) {
    const mn = memberName(db);
    const rd = csvRecords(csvText(body, db));
    const first = rd.next();
    if (first.done) throw new DataError(`snapqc: ${mn} is empty`, "api");
    this.header = first.value.map((h) => pyStrip(h).toUpperCase());
    if (new Set(this.header).size !== this.header.length) throw new DataError(`snapqc: ${mn} repeats column names; not reading it`, "api");
    const miss = (EPS.required_columns as string[]).filter((c) => !this.header.includes(c));
    if (miss.length) throw new DataError(`snapqc: ${mn} lacks ${pyRepr(miss)}: not the SNAP QC layout this pack reads`, "api");
    const cols = unique(keep(this.header));
    const ix = new Map(this.header.map((c, i) => [c, i]));
    const at = cols.map((c) => ix.get(c)!);
    const months = new Set(fyMonths(fy));
    const seen = new Set<string>();
    const k = this.header.length;
    const [iM, iH, iW, iF] = ["YRMONTH", "HHLDNO", "HWGT", "FYWGT"].map((c) => ix.get(c)!);
    let n = 1;
    for (const row of rd) {
      n++;
      if (!row.length) continue;
      if (row.length !== k) {
        throw new DataError(`snapqc: ${mn} line ${n} has ${row.length} fields, the header ${k}; not ` +
          "reading a misaligned file", "api");
      }
      if (!months.has(pyStrip(row[iM]))) {
        throw new DataError(`snapqc: ${mn} line ${n}: YRMONTH ${pyRepr(row[iM])} is outside FY ${fy}: wrong file`, "api");
      }
      const hh = pyStrip(row[iH]);
      if (seen.has(hh)) throw new DataError(`snapqc: ${mn}: HHLDNO ${hh} repeats (line ${n})`, "api");
      seen.add(hh);
      for (const [w, i] of [["HWGT", iW], ["FYWGT", iF]] as const) {
        let ok: boolean;
        try {
          ok = pyFloat(row[i]) > 0;
        } catch {
          ok = false;
        }
        if (!ok) throw new DataError(`snapqc: ${mn} line ${n}: ${w} ${pyRepr(row[i])} is not a positive number`, "api");
      }
      const rec: DbRow = {};
      cols.forEach((c, j) => (rec[c] = cellStrip(row[at[j]])));
      this.rows.push(rec);
    }
    if (!this.rows.length) throw new DataError(`snapqc: ${mn} has no rows`, "api");
    this.months = unique(this.rows.map((r) => r.YRMONTH)).sort();
  }
}

/** Variables to keep, in the file's order for stems: [columns, notes]. Unknown names asked for: an error. */
export function resolveVars(specVars: string[] | "all" | null, header: string[], defaults: string[], fy: number): [string[], string[]] {
  if (specVars === "all") return [[...header], []];
  const H = new Set(header);
  if (specVars === null) {
    const missing = defaults.filter((v) => !H.has(v));
    return [defaults.filter((v) => H.has(v)), missing.length ? [`default variables not in the FY ${fy} file: ${missing.join(", ")}`] : []];
  }
  const out: string[] = [], bad: string[] = [];
  for (const v of specVars) {
    if (v.endsWith("*")) {
      const re = new RegExp(`^${escapeRe(v.slice(0, -1))}\\d+$`);
      const hits = header.filter((c) => re.test(c));
      out.push(...hits);
      if (!hits.length) bad.push(v);
    } else if (H.has(v)) out.push(v);
    else bad.push(v);
  }
  if (bad.length) {
    throw new DataError(`snapqc: not in the FY ${fy} file: ${bad.join(", ")} (variables change by year: --search ` +
      "the catalog, and read that year's technical documentation)", "bad_request");
  }
  return [unique(out), []];
}

export const ids = (header: string[]): string[] => (EPS.id_columns as string[]).filter((c) => header.includes(c));

function fips(v: string): number | null {
  try {
    const x = pyFloat(v);
    return Number.isFinite(x) ? Math.trunc(x) : null;
  } catch {
    return null;
  }
}

const abbr = (v: string) => BY_FIPS.get(fips(v) as number)?.[0] ?? "";

function filter(rows: DbRow[], st: Set<number> | null, mo: string | null): DbRow[] {
  return rows.filter((r) => (st === null || st.has(fips(r.STATE) as number)) && (mo === null || r.YRMONTH === mo));
}

function unitRows(db: Database, cols: string[], st: Set<number> | null, mo: string | null): ORow[] {
  const idc = ids(db.header), rest = cols.filter((c) => !EPS.id_columns.includes(c));
  return filter(db.rows, st, mo).map((r) => new Map<string, unknown>([["fiscal_year", db.fy], ["database", db.db],
    ...idc.map((c) => [c, r[c]] as [string, unknown]), ["state_abbr", abbr(r.STATE)], ...rest.map((c) => [c, r[c]] as [string, unknown])]));
}

function personStems(header: string[], stems: string[], fy: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const bad: string[] = [];
  for (const s of stems) {
    const re = new RegExp(`^${escapeRe(s)}\\d+$`);
    const nums = header.filter((c) => re.test(c)).map((c) => Number(/(\d+)$/.exec(c)![1])).sort((a, b) => a - b);
    if (nums.length) out.set(s, nums);
    else bad.push(s);
  }
  if (bad.length) {
    throw new DataError(`snapqc: no person-level columns ${bad.map((s) => s + "1..").join(", ")} in the FY ${fy} file ` +
      "(--search the catalog; DIS64_ is a stem with its underscore)", "bad_request");
  }
  return out;
}

/** One row per person slot that has any value in FSAFIL or the asked stems. */
function personRows(db: Database, stems: Map<string, number[]>, unitCols: string[], st: Set<number> | null, mo: string | null,
  participantsOnly: boolean): ORow[] {
  const top = Math.max(...[...stems.values()].flat());
  const idc = ids(db.header), rest = unitCols.filter((c) => !EPS.id_columns.includes(c));
  const out: ORow[] = [];
  for (const r of filter(db.rows, st, mo)) {
    const baseRow: [string, unknown][] = [["fiscal_year", db.fy], ["database", db.db], ...idc.map((c) => [c, r[c]] as [string, unknown]),
      ["state_abbr", abbr(r.STATE)], ...rest.map((c) => [c, r[c]] as [string, unknown])];
    for (let i = 1; i <= top; i++) {
      const vals = [...stems.keys()].map((s) => [s, r[`${s}${i}`] ?? ""] as [string, string]);
      if (!vals.some(([, v]) => v)) continue;
      if (participantsOnly && (r[`FSAFIL${i}`] ?? "") !== "1") continue;
      out.push(new Map<string, unknown>([...baseRow, ["person", i], ...vals]));
    }
  }
  return out;
}

/** Python's sum() of floats (3.12 on: Neumaier compensated summation). */
function pySum(xs: number[]): number {
  let f = 0, c = 0;
  for (const x of xs) {
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

/** Weighted totals by state and U.S.: average month over the file's months (HWGT / the state's months), or one month (HWGT). */
export function summaryRows(db: Database, st: Set<number> | null, mo: string | null): [ORow[], string[]] {
  const per = db.db.includes("_per");
  const monthsOf = new Map<number | null, Set<string>>();
  for (const r of db.rows) {
    const f = fips(r.STATE);
    if (!monthsOf.has(f)) monthsOf.set(f, new Set());
    monthsOf.get(f)!.add(r.YRMONTH);
  }
  const notes: string[] = [];
  if (mo === null && !per) {
    let bad = 0;
    for (const r of db.rows) {
      const w = pyFloat(r.HWGT) / monthsOf.get(fips(r.STATE))!.size;
      const fy = pyFloat(r.FYWGT);
      if (Math.abs(w - fy) > 1e-6 * fy + 1e-6) bad++;
    }
    if (bad) {
      throw new DataError(`snapqc: in ${db.db}, HWGT / the state's sample months differs from FYWGT on ${comma(bad)} rows: ` +
        "the weights no longer follow the documented definition; not computing totals", "api");
    }
  }
  const groups = new Map<number | null, [number, number, number][]>();
  for (const r of filter(db.rows, st, mo)) {
    const f = fips(r.STATE);
    const w = mo ? pyFloat(r.HWGT) : pyFloat(r.HWGT) / monthsOf.get(f)!.size;
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f)!.push([w, pyFloat(r.FSUSIZE || 0), pyFloat(r.FSBEN || 0)]);
  }
  if (!groups.size) throw new DataError(`snapqc: no rows in ${db.db} for that state/month`, "bad_request");
  if (st === null) groups.set(0, [...groups.values()].flat());
  const span = mo ? `${mo}` : `${db.months[0]}-${db.months[db.months.length - 1]} (${db.months.length} months)`;
  const basis = mo ? "HWGT (one month)" : "HWGT / the state's sample months (= FYWGT in full-year files)";
  const sortKey = (x: number | null): [number, string] => [x === 0 ? 1 : 0, BY_FIPS.get(x as number)?.[0] ?? "ZZ"];
  const order = [...groups.keys()].sort((a, b) => {
    const [ka, kb] = [sortKey(a), sortKey(b)];
    return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
  });
  const rows: ORow[] = [];
  const usVals = new Map<string, number>();
  for (const f of order) {
    const g = groups.get(f)!;
    const units = pySum(g.map(([w]) => w)), persons = pySum(g.map(([w, s]) => w * s)), ben = pySum(g.map(([w, , b]) => w * b));
    const [a, nm] = f === 0 ? ["US", "United States"] : BY_FIPS.get(f as number) ?? ["", `FIPS ${pyS(f)}`];
    for (const [m, v, u] of [["units", units, "SNAP units, average month"], ["persons", persons, "persons, average month"],
      ["benefits", ben, "dollars a month"], ["benefit_per_unit", ben / units, "dollars a month"],
      ["benefit_per_person", persons ? ben / persons : null, "dollars a month"]] as [string, number | null, string][]) {
      const val = v === null ? null : pyRound(v, 4);
      if (a === "US" && val !== null) usVals.set(m, val);
      rows.push(new Map<string, unknown>([["fiscal_year", db.fy], ["database", db.db], ["months", span],
        ["state_fips", f === 0 ? "" : f], ["state_abbr", a], ["state_name", nm], ["measure", m],
        ["value", val === null ? "" : pyFloatRepr(val)], ["unit", u], ["sample_units", g.length], ["weight", basis]]));
    }
  }
  const vt = (EPS.verified_totals || {})[db.db];
  if (vt && st === null && mo === null) {
    const off = ["units", "persons", "benefits"].filter((k) => Math.abs(usVals.get(k)! - vt[k]) > 1)
      .map((k) => `${k} ${commaFixed(usVals.get(k)!, 0)} vs ${comma(vt[k])}`);
    notes.push(off.length ? `U.S. totals differ from ${vt.source.split(",")[0]} (${off.join("; ")}): the file may have been ` +
      "reissued; read the current technical documentation" : `U.S. units, persons and benefits equal ${vt.source.split(";")[0]}`);
  }
  if (per) {
    notes.push(`${db.db} is a period file: its FYWGT is the full FY 2020 file's weight (HWGT / 9), so these ` +
      "totals use HWGT / the state's sample months in this period");
  }
  const small = rows.filter((r) => r.get("measure") === "units" && (r.get("sample_units") as number) < 100)
    .map((r) => String(r.get("state_abbr"))).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  if (small.length) notes.push(`fewer than 100 sample units: ${small.join(", ")} (wide sampling error; no standard errors here)`);
  return [rows, notes];
}

// ---------------------------------------------------------------------- the fetch
function cap(rows: ORow[], req: SpecRequest, pack: Pack): [ORow[], string[]] {
  const c = Number(req.max_rows || pack.policy.limits.max_rows);
  if (rows.length > c) {
    return [rows.slice(0, c), [`${req.name}: stopped at ${comma(c)} rows (max_rows); the file has ${comma(rows.length)} for this ` +
      "request: filter by state or month, or raise max_rows"]];
  }
  return [rows, []];
}

function rowsFor(req: SpecRequest, p: Record<string, any>, fy: number, body: Uint8Array, notes: string[]): ORow[] {
  const e = req.endpoint || "", name = req.name;
  const dbName = database(fy, p.period);
  const st = states(p.state), mo = month(p.month, fy);
  let db: Database, rows: ORow[], ns: string[];
  if (e === "summary") {
    db = new Database(body, fy, dbName, (h) => [...ids(h), "FSUSIZE", "FSBEN"]);
    [rows, ns] = summaryRows(db, st, mo);
  } else if (e === "units") {
    let cols: string[] = [];
    ns = [];
    db = new Database(body, fy, dbName, (h) => {
      [cols, ns] = resolveVars(names(p.variables, "variables"), h, EPS.default_variables, fy);
      return unique([...ids(h), ...cols]);
    });
    rows = unitRows(db, cols, st, mo);
  } else {
    let cols: string[] = [];
    let stems = new Map<string, number[]>();
    ns = [];
    const po = bool(p.participants_only);
    db = new Database(body, fy, dbName, (h) => {
      [cols, ns] = resolveVars(names(p.variables, "variables"), h, ["FSUSIZE", "FSBEN"], fy);
      const asked = (names(p.person_variables, "person_variables") as string[] | null) || EPS.default_person_variables;
      stems = personStems(h, unique([...(po ? ["FSAFIL"] : []), ...asked]), fy);
      return unique([...ids(h), ...cols, ...[...stems].flatMap(([s, nums]) => nums.map((i) => `${s}${i}`))]);
    });
    rows = personRows(db, stems, cols, st, mo, po);
  }
  notes.push(...ns.map((x) => `${name}: check: ${x}`));
  const span = `${db.months[0]}-${db.months[db.months.length - 1]}, ${db.months.length} months`;
  notes.push(`${name}: ${dbName} (${memberName(dbName)}, ${comma(db.rows.length)} sample units, ${span}): ${comma(rows.length)} rows`);
  return rows;
}

function problemsOf(pack: Pack, r: SpecRequest): [Record<string, any>, string[]] {
  const [, p, probs] = gr.resolve(pack, r);
  return [p, [...probs, ...checkSpec({ requests: [r] })]];
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const site = new Site(pack);
  const tables: Record<string, ORow[]> = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [p, probs] = problemsOf(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const rows: ORow[] = [];
    for (const fy of years(p.fiscal_year)) {
      const dbName = database(fy, p.period);
      const [hit, ns] = await site.findCsv(fy, dbName);
      notes.push(...ns.map((n) => `${r.name}: check: ${n}`));
      rows.push(...rowsFor(r, p, fy, await site.zip(hit.path), notes));
    }
    const [kept, cut] = cap(rows, r, pack);
    tables[r.name] = kept;
    notes.push(...cut);
  }
  return [Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, toTable(v, "snapqc")])), notes];
}

// ---------------------------------------------------------------------- manual route
function manualItems(spec: Spec, pack: Pack): any[] {
  const b = String(EPS.base_url).replace(/\/+$/, "");
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [p, probs] = problemsOf(pack, r);
    if (probs.length || !["units", "persons", "summary"].includes(r.endpoint || "")) continue;
    years(p.fiscal_year).forEach((fy, k) => {
      const db = database(fy, p.period);
      const csvPath = EPS.csv_files[db];
      items.push({ request: r.name, name: `${r.name}#${k + 1}`, needs_key: false, method: "GET", body: null,
        url: b + (csvPath || EPS.listing.path), filename: `${r.name}_${db}_csv.zip`,
        note: `SNAP QC public-use data, FY ${fy}${db === `qcfy${fy}` ? "" : ` (${db})`}, CSV zip. ` +
          `If the link is gone, open ${b}${EPS.listing.path}, find 'Year ${fy}' and download 'QC Data | CSV'` });
    });
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, paths: string[]): Row[] {
  const [p, probs] = problemsOf(pack, req);
  if (probs.length) throw new DataError(probs.join("; "), "bad_request");
  const bodies = new Map<number, Buffer>();
  const want = years(p.fiscal_year);
  for (const f of [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const body = fs.readFileSync(f);
    for (const fy of want) {
      const db = database(fy, p.period);
      if (isZip(body)) {
        if (zipNames(body).some((n) => base(n).toLowerCase() === memberName(db))) bodies.set(fy, body);
      } else if (path.basename(f).toLowerCase().endsWith(memberName(db))) bodies.set(fy, body);
    }
  }
  const have = [...bodies.keys()].sort((a, b) => a - b);
  if (have.join() !== [...want].sort((a, b) => a - b).join()) {
    throw new DataError(`request ${pyRepr(req.name)} needs the SNAP QC CSV zip for FY ${pyRepr(want)} (holding ` +
      `${want.map((fy) => memberName(database(fy, p.period))).join(", ")}); the upload has ` +
      `${have.length ? pyRepr(have) : "none of them"}`, "bad_request");
  }
  const rows: ORow[] = [];
  for (const fy of want) rows.push(...rowsFor(req, p, fy, bodies.get(fy)!, []));
  return toTable(rows, "snapqc") as unknown as Row[];
}

const adapter: Adapter = { fetch, checkSpec, manualItems, parseUpload };
export default adapter;
