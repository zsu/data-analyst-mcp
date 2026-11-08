/**
 * OPM Federal Workforce Data (FWD / EHRI) files: the deep pack (port of sources/opm/fetch.py).
 *
 * spec:
 *   {"description": "Separations by agency, FY2025",
 *    "datasets": {"employment": {"from": "2015-09", "to": "2025-09", "months": [9]},
 *                 "separations": {"from": "2024-10", "to": "latest"}},       // or "periods": ["2025-09", "latest"]
 *    "columns": ["agency_code", "agency", "separation_category"],          // optional; default all
 *    "filters": {"department_code": ["VA", "HS"]},                         // optional; strings exactly as in the data
 *    "aggregate": {"by": ["agency_code", "agency"]},                       // optional; counts + pay sums
 *    "pin": {"employment_202509": 4}}                                      // optional; exact versions
 * Always kept: count, snapshot_yyyymm (employment), personnel_action_effective_date_yyyymm (actions), plus
 * source_file and file_yyyymm. Output in data/opm/: opm_<dataset>.parquet, opm_<dataset>.csv (up to 1,000,000
 * rows), manifest.json, request.json, data_dictionary.csv, README.md and spec_used.json. Raw files are cached in
 * $OPM_CACHE_DIR or <cache root>/opm-fwd for policy cache.ttl_hours.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import zlib from "node:zlib";
import { trail } from "../core/context.js";
import { cacheRoot } from "../core/env.js";
import { Client, DataError } from "../core/http.js";
import { dataDir, fingerprint } from "../core/package.js";
import type { DeepContext, DeepPack, DeepResult, Pack } from "../core/packs.js";
import { pyFloatRepr, pyJsonDumps, pyUrlencode } from "../core/py.js";
import { readCsv } from "../core/tabular.js";
import * as io from "./_opm_io.js";
import { writeParquet, type WriteColumn } from "../core/parquet.js";
import { closeMatches, pyRepr } from "./_opm_py.js";

const SOURCE = "opm";
export const BASE = "https://data.opm.gov/api/v1/files";
export const DATASETS = ["employment", "accessions", "separations"] as const;
const UA = "data-analyst/1.0 opm pack (+https://data.opm.gov/get-data/api-access)";
const HINTS: Record<number, string> = {
  400: "400 Bad Request: the request is malformed or over the 25 MB request limit.",
  404: "404 Not Found: no file for that dataset/year/month/version. List the files to see what exists.",
  429: "429 Too Many Requests: OPM rate limit reached; wait a minute and retry.",
  500: "500 Internal Server Error at OPM; retry later.",
};
const EST_MB: Record<string, number> = { employment: 70, accessions: 1, separations: 2 };
const PAY_COLS = ["annualized_adjusted_basic_pay", "work_schedule_code", "pay_basis_code"];
const ALWAYS: Record<string, string[]> = { employment: ["count", "snapshot_yyyymm"],
  accessions: ["count", "personnel_action_effective_date_yyyymm"],
  separations: ["count", "personnel_action_effective_date_yyyymm"] };
export const CSV_MAX_ROWS = 1_000_000;
const WRITER = "data-analyst-mcp";
const CITATION = "U.S. Office of Personnel Management, Federal Workforce Data (FWD), Enterprise Human Resources " +
  "Integration (EHRI) {datasets} files, accessed {date} through the FWD API (https://data.opm.gov/get-data/api-access).";
const cite = (datasets: string, date: string) => CITATION.replace("{datasets}", datasets).replace("{date}", date);

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const specError = (m: string) => new DataError(m, "spec");
const commas = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

function localIso(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:` +
    `${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
const utcIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

// ---------------------------------------------------------------- API client
export class OpmClient {
  http: Client;
  constructor(retries = 4) {
    this.http = new Client(BASE, { name: "data.opm.gov", rps: 4, burst: 8, retries, timeout: 60,
      deadline: Math.max(180, 60 * (retries + 1)), userAgent: UA });
  }

  private wrap(e: unknown): never {
    if (e instanceof DataError) {
      if (e.kind === "network" || e.kind === "fixture_missing") {
        throw new DataError(`cannot reach data.opm.gov (${e.message})`, e.kind);
      }
      throw new DataError((e.status && HINTS[e.status]) || e.message, e.kind, e.status, e.retryAfter);
    }
    throw e;
  }

  /** File metadata: [{filename, publishDate, version, current, month, year}, ...]. */
  async listFiles(dataset: string, params: Record<string, unknown> = {}): Promise<any[]> {
    if (!(DATASETS as readonly string[]).includes(dataset)) throw specError(`dataset must be one of ${pyRepr([...DATASETS])}`);
    const q = Object.entries(params).filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, typeof v === "boolean" ? String(v) : v] as [string, unknown]);
    const url = `${BASE}/${dataset}` + (q.length ? "?" + pyUrlencode(q) : "");
    let r;
    try {
      r = await this.http.request("GET", url, null, { okStatuses: [200, 204] });
    } catch (e) {
      this.wrap(e);
    }
    if (r.status === 204 || !r.body.toString("utf8").trim()) return [];
    return r.json();
  }

  downloadUrl(dataset: string, year: number, month: number, version: number): string {
    return `${BASE}/${dataset}/${pad(Number(year), 4)}/${pad(Number(month))}/${Math.trunc(Number(version))}/download`;
  }

  /** One Parquet file to `dest` (atomic). Returns bytes written. */
  async download(dataset: string, year: number, month: number, version: number, dest: string): Promise<number> {
    const url = this.downloadUrl(dataset, year, month, version);
    const t = this.http.timeout;
    this.http.timeout = Math.max(t, 300);
    let n: number;
    try {
      n = (await this.http.download(url, dest)).bytes;
    } catch (e) {
      this.wrap(e);
    } finally {
      this.http.timeout = t;
    }
    const fd = fs.openSync(dest, "r");
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    if (magic.toString("latin1") !== "PAR1") {
      fs.rmSync(dest, { force: true });
      throw new DataError(`${url} did not return a Parquet file`, "http");
    }
    return n!;
  }
}

/** {y*100+m: metadata of the current version}. Falls back to the highest version. */
export function currentIndex(files: any[]): Map<number, any> {
  const out = new Map<number, any>();
  for (const f of files) {
    const k = Number(f.year) * 100 + Number(f.month);
    const old = out.get(k);
    if (!old || (f.current && !old.current) || (!!f.current === !!old.current && Number(f.version) > Number(old.version))) out.set(k, f);
  }
  return out;
}

const key = (y: number, m: number) => y * 100 + m;
const fmtP = (p: number) => `${Math.floor(p / 100)}-${pad(p % 100)}`;

// ---------------------------------------------------------------- spec
export function ym(s: unknown): number {
  const m = /^(\d{4})-?(\d{1,2})$/.exec(String(s ?? "None").trim());
  if (!m) throw specError(`period ${pyRepr(s)}: use YYYY-MM`);
  const [y, mo] = [Number(m[1]), Number(m[2])];
  if (mo < 1 || mo > 12) throw specError(`period ${pyRepr(s)}: month must be 1-12`);
  return key(y, mo);
}

/** The spec with the list shorthand expanded: ["employment"] + top-level periods. */
export function normalize(spec0: any): any {
  const spec = JSON.parse(JSON.stringify(spec0 ?? {}));
  if (Array.isArray(spec.datasets)) {
    spec.datasets = Object.fromEntries(spec.datasets.map((d: string) =>
      [d, Object.fromEntries(["from", "to", "months", "periods"].filter((k) => k in spec).map((k) => [k, spec[k]]))]));
  }
  return spec;
}

function dictionaryPath(pack: Pack): string | null {
  const p = path.join(pack.dir, "lib", "data_dictionary.csv");
  return fs.existsSync(p) ? p : null;
}

/** {dataset: columns the data dictionary defines for it} (empty when the dictionary is missing). */
export function datasetColumns(pack: Pack): Record<string, Set<string>> {
  const p = dictionaryPath(pack);
  if (!p) return {};
  const out: Record<string, Set<string>> = Object.fromEntries(DATASETS.map((d) => [d, new Set<string>()]));
  for (const r of readCsv(fs.readFileSync(p, "utf8"))) for (const d of DATASETS) if (r[d] === "Y") out[d].add(String(r.field));
  return out;
}

function periodProblems(ds: string, rule: any): string[] {
  const out: string[] = [];
  const tryYm = (v: unknown) => {
    try {
      ym(v);
    } catch (e: any) {
      out.push(`${ds}: ${e.message}`);
    }
  };
  if (!isObj(rule)) return rule === null || rule === undefined ? [] : [`${ds}: the rule must be an object such as {"periods": ["2025-09"]}`];
  if (rule.periods) {
    if (!Array.isArray(rule.periods)) return [`${ds}: "periods" must be a list such as ["2025-09", "latest"]`];
    for (const p of rule.periods) if (String(p).toLowerCase() !== "latest") tryYm(p);
  } else {
    if (rule.from) tryYm(rule.from);
    if (String(rule.to ?? "latest").toLowerCase() !== "latest") tryYm(rule.to);
    for (const m of rule.months || []) if (!(Number(m) >= 1 && Number(m) <= 12 && Number.isInteger(Number(m)))) out.push(`${ds}: months must be 1-12, not ${pyRepr(m)}`);
  }
  return out;
}

/** What load_spec refused (fix_spec), before any request. */
export function checkSpec(spec0: any, pack: Pack): string[] {
  const spec = normalize(spec0);
  const ds = spec.datasets;
  if (!isObj(ds) || !Object.keys(ds).length) {
    return ['spec needs "datasets": {"employment": {"from": "2024-09", "to": "2025-09"}, ...}'];
  }
  const bad = Object.keys(ds).filter((d) => !(DATASETS as readonly string[]).includes(d));
  if (bad.length) return [`unknown dataset(s) ${pyRepr(bad)}; use ${pyRepr([...DATASETS])}`];
  const out: string[] = [];
  for (const [col, vals] of Object.entries<any>(spec.filters || {})) {
    const nums = (Array.isArray(vals) ? vals : [vals]).filter((v) => typeof v !== "string");
    if (nums.length) {
      out.push(`filter ${pyRepr(col)}: values must be strings exactly as in the data (for example "08" or "0343", ` +
        `not ${pyRepr(nums[0])})`);
    }
  }
  const known = datasetColumns(pack);
  if (Object.keys(known).length) {
    const have = new Set<string>(["file_yyyymm", "source_file"]);
    for (const d of Object.keys(ds)) {
      for (const c of known[d] || []) have.add(c);
      for (const c of ALWAYS[d] || []) have.add(c);
    }
    const named = [...(spec.columns || []), ...Object.keys(spec.filters || {}), ...((spec.aggregate || {}).by || [])];
    const badCols = [...new Set<string>(named)].filter((c) => !have.has(c));
    if (badCols.length) {
      const sorted = [...have].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const near = badCols.map((c) => {
        const sub = sorted.filter((h) => c.split("_").some((w) => w.length > 4 && h.includes(w)));
        const v = [...new Set([...closeMatches(c, sorted, 3, 0.5), ...sub])].slice(0, 4);
        return `${c} -> ${v.length ? pyRepr(v) : "none"}`;
      });
      out.push(`unknown column(s) ${pyRepr(badCols)} for ${pyRepr(Object.keys(ds).sort())} (lib/data_dictionary.csv); close: ` +
        near.join("; "));
    }
  }
  const agg = spec.aggregate;
  if (agg && spec.columns?.length) {
    const auto = new Set([...Object.values(ALWAYS).flat(), ...PAY_COLS]);
    const lost = spec.columns.filter((c: string) => !(agg.by || []).includes(c) && !auto.has(c));
    if (lost.length) {
      out.push(`aggregate keeps only the aggregate.by columns, so ${pyRepr(lost)} would be dropped: add them to ` +
        "aggregate.by (they stay empty for datasets without them) or remove them from columns");
    }
  }
  for (const [d, rule] of Object.entries(ds)) out.push(...periodProblems(d, rule));
  return out;
}

export function specFingerprint(spec: any): string {
  const keep = Object.fromEntries(["datasets", "columns", "filters", "aggregate", "pin"].map((k) => [k, spec[k] ?? null]));
  return sha256(pyJsonDumps(keep, true)).slice(0, 16);
}

/** Periods wanted by one dataset rule, and the ones that do not exist. */
export function resolvePeriods(rule: any, available: number[]): [number[], string[]] {
  const avail = [...available].sort((a, b) => a - b);
  if (!avail.length) return [[], ["no files listed"]];
  const set = new Set(avail);
  const latest = avail[avail.length - 1];
  if (rule.periods?.length) {
    const want = rule.periods.map((p: unknown) => (String(p).toLowerCase() === "latest" ? latest : ym(p)));
    const missing = want.filter((p: number) => !set.has(p)).map(fmtP);
    // a period listed twice would load the same file twice and double its counts
    return [[...new Set<number>(want.filter((p: number) => set.has(p)))].sort((a, b) => a - b), missing];
  }
  const lo = rule.from ? ym(rule.from) : avail[0];
  const hi = String(rule.to ?? "latest").toLowerCase() === "latest" ? latest : ym(rule.to);
  const months = new Set<number>((rule.months?.length ? rule.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).map(Number));
  const want = avail.filter((p) => lo <= p && p <= hi && months.has(p % 100));
  if (!want.length) {
    return [[], [`nothing available from ${fmtP(lo)} to ${fmtP(hi)} (available: ${fmtP(avail[0])} to ${fmtP(latest)})`]];
  }
  const missing: string[] = [];
  let [y, m] = [Math.floor(lo / 100), lo % 100];
  while (key(y, m) <= hi) {
    if (months.has(m) && !set.has(key(y, m)) && key(y, m) <= latest) missing.push(`${y}-${pad(m)}`);
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
  }
  return [want, missing];
}

export type PlanFile = { dataset: string; year: number; month: number; version: number; filename: string;
  publishDate: string | null; current: boolean | null; url: string; identified_by?: string };
export type Plan = { files: PlanFile[]; missing: Record<string, string[]>; est_mb: number };

export async function buildPlan(spec: any, client: OpmClient): Promise<Plan> {
  const plan: Plan = { files: [], missing: {}, est_mb: 0 };
  for (const [ds, rule] of Object.entries<any>(spec.datasets)) {
    const listing = await client.listFiles(ds);
    const idx = currentIndex(listing);
    const byVersion = new Map(listing.map((f: any) => [`${Number(f.year)}-${Number(f.month)}-${Number(f.version)}`, f]));
    const [periods, missing] = resolvePeriods(rule || {}, [...idx.keys()]);
    if (missing.length) plan.missing[ds] = missing;
    for (const p of periods) {
      const [y, m] = [Math.floor(p / 100), p % 100];
      let meta = { ...idx.get(p) };
      const pin = (spec.pin || {})[`${ds}_${y}${pad(m)}`];
      if (pin && Number(pin) !== Number(meta.version)) {
        // the pinned version's own metadata (publish date), not the current version's
        meta = { ...(byVersion.get(`${y}-${m}-${Math.trunc(Number(pin))}`) ||
          { version: Math.trunc(Number(pin)), filename: `${ds}_${y}${pad(m)}_${Math.trunc(Number(pin))}`, publishDate: null }) };
        meta.current = false;
      }
      plan.files.push({ dataset: ds, year: y, month: m, version: Number(meta.version), filename: meta.filename,
        publishDate: meta.publishDate ?? null, current: !!meta.current, url: client.downloadUrl(ds, y, m, meta.version) });
      plan.est_mb += EST_MB[ds];
    }
  }
  return plan;
}

/** The --list summary of a dataset: periods available (current versions). */
export async function listSummary(dataset: string, client = new OpmClient()): Promise<any> {
  const idx = currentIndex(await client.listFiles(dataset));
  const ks = [...idx.keys()].sort((a, b) => a - b);
  const years = [...new Set(ks.map((k) => Math.floor(k / 100)))].sort((a, b) => a - b);
  const monthsOf = (y: number) => ks.filter((k) => Math.floor(k / 100) === y).map((k) => k % 100);
  const quarterly = (y: number) => monthsOf(y).every((m) => [3, 6, 9, 12].includes(m));
  return { dataset, files: ks.length, first: ks.length ? fmtP(ks[0]) : null, latest: ks.length ? fmtP(ks[ks.length - 1]) : null,
    // years with only quarter-end files (employment before 2011), and other incomplete years
    quarterly_years: years.filter(quarterly),
    partial_years: Object.fromEntries(years.filter((y) => monthsOf(y).length < 12 && !quarterly(y)).map((y) => [String(y), monthsOf(y)])),
    latest_files: ks.slice(-3).map((k) => idx.get(k)) };
}

// ---------------------------------------------------------------- tables
type Kind = "int" | "float";
type Table = { cols: string[]; rows: number; data: Record<string, (string | number | null)[]>; kinds: Record<string, Kind> };

function emptyTable(cols: string[]): Table {
  return { cols: [...cols], rows: 0, data: Object.fromEntries(cols.map((c) => [c, []])), kinds: {} };
}

/** pd.to_numeric(errors="coerce") of one value, and whether its text is an integer. */
function num(v: string | number | null): [number | null, boolean] {
  if (v === null) return [null, true];
  if (typeof v === "number") return [v, Number.isInteger(v)];
  const s = v.trim();
  if (/^[+-]?\d+$/.test(s)) return [Number(s), true];
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return [Number(s), false];
  return [null, true];
}

/**
 * Collapse microdata to counts per group, with what pay statistics can be summed. pay_n / pay_sum cover the pay
 * universe of stats.pay_summary (full-time, per annum, pay reported and positive), so pay_sum / pay_n is comparable
 * to its mean; pay_redacted counts every redacted record in the group.
 */
function aggregate(d: Table, ds: string, agg: any): Table {
  const period = ds === "employment" ? "snapshot_yyyymm" : "personnel_action_effective_date_yyyymm";
  const by = [...new Set<string>([period, "file_yyyymm", "source_file", ...(agg.by || [])])];
  const n = d.rows;
  const cnt = d.data.count.map((v) => num(v as string | null));
  const nKind: Kind = cnt.every(([, i]) => i) ? "int" : "float";
  const nv = cnt.map(([x]) => (x === null ? 1 : x));
  const payCol = d.data.annualized_adjusted_basic_pay;
  let red: number[], payn: number[], pays: number[], payKind: Kind = "int";
  if (payCol) {
    const parsed = payCol.map((v) => num(v as string | null));
    payKind = parsed.every(([, i]) => i) ? "int" : "float";
    const pay = parsed.map(([x]) => (x !== null && x > 0 ? x : null));
    for (const [col, val] of [["work_schedule_code", "F"], ["pay_basis_code", "PA"]]) {
      const c = d.data[col];
      if (c) for (let i = 0; i < n; i++) if (c[i] !== val) pay[i] = null;
    }
    red = payCol.map((v) => (v === "REDACTED" ? 1 : 0));
    payn = pay.map((x) => (x === null ? 0 : 1));
    pays = pay.map((x) => x ?? 0);
  } else {
    red = payn = pays = new Array(n).fill(0);
  }
  const groups = new Map<string, { key: (string | null)[]; h: number; hc: number; r: number; pn: number; ps: number; pc: number }>();
  for (let i = 0; i < n; i++) {
    const k = by.map((c) => (d.data[c][i] ?? null) as string | null);
    const id = JSON.stringify(k);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { key: k, h: 0, hc: 0, r: 0, pn: 0, ps: 0, pc: 0 }));
    // floats: Kahan-compensated sums, as pandas' groupby sum
    if (nKind === "float") {
      const y = nv[i] - g.hc, t = g.h + y;
      g.hc = t - g.h - y;
      g.h = t;
    } else g.h += nv[i];
    g.r += red[i];
    g.pn += payn[i];
    if (payKind === "float") {
      const y = pays[i] - g.pc, t = g.ps + y;
      g.pc = t - g.ps - y;
      g.ps = t;
    } else g.ps += pays[i];
  }
  const cmp = (a: (string | null)[], b: (string | null)[]) => {
    for (let i = 0; i < a.length; i++) {
      const [x, y] = [a[i], b[i]];
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? -1 : 1;
    }
    return 0;
  };
  const sorted = [...groups.values()].sort((a, b) => cmp(a.key, b.key));
  const cols = [...by, "headcount", "pay_redacted", "pay_n", "pay_sum"];
  const t = emptyTable(cols);
  for (const g of sorted) {
    by.forEach((c, i) => t.data[c].push(g.key[i]));
    t.data.headcount.push(g.h);
    t.data.pay_redacted.push(g.r);
    t.data.pay_n.push(g.pn);
    t.data.pay_sum.push(g.ps);
  }
  t.rows = sorted.length;
  t.kinds = { headcount: nKind, pay_redacted: "int", pay_n: "int", pay_sum: payKind };
  return t;
}

type FileInfo = { rows_raw: number; rows_kept: number; missing_columns: string[]; filters_not_applied: string[];
  source_format: string };

/** Read one raw file (Parquet, TXT/CSV or JSON) in chunks, keep columns and rows. */
async function processFile(p: string, ds: string, meta: PlanFile, spec: any): Promise<[Table, FileInfo]> {
  const haveList = await io.columnsOf(p);
  const have = new Set(haveList);
  const wanted: string[] | undefined = spec.columns?.length ? spec.columns : undefined;
  const filters: Record<string, any> = spec.filters || {};
  const agg = spec.aggregate;
  let cols: string[];
  if (wanted) {
    cols = [...new Set<string>([...ALWAYS[ds], ...wanted, ...Object.keys(filters), ...((agg || {}).by || []),
      ...(agg ? PAY_COLS : [])])].filter((c) => c !== "file_yyyymm" && c !== "source_file");
  } else cols = [...haveList];
  const readCols = cols.filter((c) => have.has(c));
  const missingCols = cols.filter((c) => !have.has(c));
  const fvals = Object.entries(filters).map(([c, v]) => [c, new Set((Array.isArray(v) ? v : [v]).map(String))] as const);
  let rowsRaw = 0;
  const t = emptyTable([...cols, "file_yyyymm", "source_file"]);
  for await (const f of io.iterFrames(p, readCols)) {
    rowsRaw += f.rows;
    const active = fvals.filter(([c]) => c in f.data);
    for (let i = 0; i < f.rows; i++) {
      if (active.some(([c, vs]) => { const v = f.data[c][i]; return v === null || !vs.has(v); })) continue;
      for (const c of readCols) t.data[c].push(f.data[c]?.[i] ?? null);
      t.rows++;
    }
  }
  const fileYm = `${meta.year}${pad(Number(meta.month))}`;
  for (const c of missingCols) t.data[c] = new Array(t.rows).fill(null);
  t.data.file_yyyymm = new Array(t.rows).fill(fileYm);
  t.data.source_file = new Array(t.rows).fill(meta.filename);
  const out = agg ? aggregate(t, ds, agg) : t;
  return [out, { rows_raw: rowsRaw, rows_kept: out.rows, missing_columns: missingCols,
    filters_not_applied: Object.keys(filters).filter((c) => !have.has(c)), source_format: await io.fileKind(p) }];
}

function concat(parts: Table[]): Table {
  const cols: string[] = [];
  for (const p of parts) for (const c of p.cols) if (!cols.includes(c)) cols.push(c);
  const t = emptyTable(cols);
  for (const p of parts) {
    for (const c of cols) {
      const src = p.data[c];
      const dst = t.data[c];
      if (src) for (const v of src) dst.push(v);
      else for (let i = 0; i < p.rows; i++) dst.push(null);
    }
    t.rows += p.rows;
    for (const [c, k] of Object.entries(p.kinds)) if (t.kinds[c] !== "float") t.kinds[c] = k;
  }
  return t;
}

/** A cell as pandas writes it: missing empty, floats as repr, minimal quoting. */
function cell(v: string | number | null, kind?: Kind): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return kind === "float" ? pyFloatRepr(v) : String(v);
  return /[,"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function writeTableCsv(file: string, t: Table, gz = false): void {
  const lines: string[] = [t.cols.map((c) => cell(c)).join(",")];
  const chunks: Buffer[] = [];
  const fd = gz ? null : fs.openSync(file, "w");
  const flush = () => {
    const b = Buffer.from(lines.join("\r\n") + "\r\n", "utf8");
    lines.length = 0;
    if (fd !== null) fs.writeSync(fd, b);
    else chunks.push(b);
  };
  try {
    for (let i = 0; i < t.rows; i++) {
      lines.push(t.cols.map((c) => cell(t.data[c][i], t.kinds[c])).join(","));
      if (lines.length >= 20000) flush();
    }
    flush();
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  if (gz) fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(chunks)));
}

function writeTableParquet(file: string, t: Table): void {
  const cols: WriteColumn[] = t.cols.map((c) => ({ name: c, values: t.data[c],
    kind: t.kinds[c] === "float" ? "double" : t.kinds[c] === "int" ? "int64" : "string" }));
  writeParquet(file, cols, t.rows, WRITER);
}

// ---------------------------------------------------------------- package
type Ctx = { pack: Pack; out: string };

function fileSha(p: string): string {
  const h = createHash("sha256");
  const fd = fs.openSync(p, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function writeRequestJson(d: string, spec: any, route: string, acquired: string, tables: any[], files: any[]): string {
  const retrieved = utcIso();
  const vintage = [...new Set(files.map((f) => `${f.dataset}_${f.year}${pad(Number(f.month))}_v${f.version ?? "None"}`))]
    .sort().join(", ").slice(0, 400);
  const reqs = trail().filter((s) => s.url.includes("data.opm.gov"));
  const req = { source: SOURCE, spec, fingerprint: fingerprint(spec), route, acquired, retrieved, vintage,
    requests: reqs.length ? reqs : files.map((f) => ({ method: "GET", url: f.url, sha256: f.sha256 })),
    tables, problems: [], notes: [], policy: { redistribution: "allowed", cache: "persistent" } };
  fs.writeFileSync(path.join(d, "request.json"), JSON.stringify(req, null, 2));
  return retrieved;
}

function writeReadme(d: string, M: any): void {
  const ds = [...new Set<string>(M.files.map((f: any) => f.dataset))].sort().join(", ");
  const date = M.downloaded.slice(0, 10);
  const late = M.files.filter((f: any) => f.current === false);
  const miss = [...new Set<string>(M.files.flatMap((f: any) => f.missing_columns || []))].sort();
  const lines = [`# OPM Federal Workforce Data: ${M.spec.description || ds}`, "",
    `Retrieved ${M.downloaded} by route \`${M.route}\` (${M.acquired || ""}) from ${M.api_base}.`, "",
    "## Citation", "", cite(ds, date), "",
    "## Files", "", "| Dataset | Period | Version | Published | Rows kept | SHA-256 (raw) |", "|---|---|---|---|---|---|"];
  for (const f of M.files) {
    lines.push(`| ${f.dataset} | ${f.year}-${pad(Number(f.month))} | ${f.version ?? "None"}${f.current !== false ? "" : " (pinned)"} | ` +
      `${(f.publishDate || "").slice(0, 10)} | ${f.rows_kept !== undefined ? commas(f.rows_kept) : ""} | \`${(f.sha256 || "").slice(0, 16)}…\` |`);
  }
  lines.push("", "## Things to know before analyzing", "",
    "- Pay (`annualized_adjusted_basic_pay`), duty-station location, CBSA/CSA, locality pay area, " +
    "bargaining unit and personnel office are `REDACTED` for all Department of Defense employees and for " +
    "security/sensitive agencies and occupations (about 45 to 48 percent of employment records). " +
    "Never average pay over the unredacted records and call it a governmentwide figure.",
    "- Coverage: EHRI excludes USPS, the intelligence agencies (CIA, NSA, DIA, NGA, ODNI), the White House " +
    "Office, Foreign Service at State, TVA, the Fed Board of Governors, PHS Commissioned Corps, " +
    "nonappropriated-fund staff, foreign nationals overseas, and most of the legislative and judicial " +
    "branches (the Government Publishing Office, `LP`, and some judicial-branch records, `JL`, do appear: " +
    "drop them by `agency_code` for an executive-branch count).",
    "- Accession and separation files hold actions processed in the file month; some are effective in " +
    "earlier months (`personnel_action_effective_date_yyyymm`). Recent months gain late actions in later files.",
    "- OPM revises files: `manifest.json` records each version; put its versions in the spec's `pin` " +
    "(`{\"<dataset>_<YYYYMM>\": <version>}`) to re-fetch exactly these.",
    "- Agency names change (e.g. Department of Defense / Department of War); group by `*_code` columns.",
    "- No sex, race, ethnicity, disability or individual identifiers are in the public files.");
  if (miss.length) lines.push(`- Columns absent from some (older) files and filled with nulls: ${miss.join(", ")}.`);
  if (late.length) lines.push(`- ${late.length} file(s) are pinned to a non-current version.`);
  lines.push("", "## Use and redistribution", "",
    "Rule: **allowed**. OPM publishes these files as public data under its Public Data Release Policy; " +
    "the filtered files may ship with a report and its replication package. Fields OPM withholds for " +
    "privacy or security are published as `REDACTED`: disclose the coverage of every pay or location " +
    "figure (`exhibits/coverage.csv`).");
  fs.writeFileSync(path.join(d, "README.md"), lines.join("\n") + "\n");
}

function packageData(c: Ctx, spec: any, tables: Map<string, Table[]>, infos: any[], route: string, acquired: string) {
  const d = dataDir(c.out, SOURCE);
  fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(d)) if (/^opm_\w+\.(parquet|csv|csv\.gz)$/.test(f)) fs.rmSync(path.join(d, f));
  const outputs: string[] = [], dsInfo: Record<string, any> = {}, tablesMeta: any[] = [];
  for (const [ds, parts] of tables) {
    if (!parts.length) continue;
    const t = concat(parts);
    const info: any = { rows: t.rows, parquet: null, csv: null };
    writeTableParquet(path.join(d, `opm_${ds}.parquet`), t);
    outputs.push(`opm_${ds}.parquet`);
    info.parquet = `opm_${ds}.parquet`;
    if (t.rows <= CSV_MAX_ROWS) {
      writeTableCsv(path.join(d, `opm_${ds}.csv`), t);
      outputs.push(`opm_${ds}.csv`);
      info.csv = `opm_${ds}.csv`;
    }
    dsInfo[ds] = info;
    tablesMeta.push({ name: `opm_${ds}`, file: info.csv || info.parquet, rows: t.rows, columns: t.cols });
  }
  const dict = dictionaryPath(c.pack);
  if (dict) fs.copyFileSync(dict, path.join(d, "data_dictionary.csv"));
  const M = { source: "U.S. Office of Personnel Management, Federal Workforce Data (EHRI)", api_base: BASE, route, acquired,
    downloaded: localIso(), spec_fingerprint: specFingerprint(spec),
    spec: Object.fromEntries(["description", "datasets", "columns", "filters", "aggregate", "pin"].map((k) => [k, spec[k] ?? null])),
    columns: spec.columns || [], filters: spec.filters || {}, aggregate: spec.aggregate ?? null,
    rows: Object.values(dsInfo).reduce((s, i: any) => s + i.rows, 0), datasets: dsInfo, outputs, files: infos,
    parquet_writer: WRITER };
  fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify(M, null, 2));
  fs.writeFileSync(path.join(d, "spec_used.json"), JSON.stringify(spec, null, 2));
  const retrieved = writeRequestJson(d, spec, route, acquired, tablesMeta, infos);
  writeReadme(d, M);
  return { M, tablesMeta, retrieved, dir: d };
}

function rawCacheRoot(): string {
  return process.env.OPM_CACHE_DIR || path.join(cacheRoot(), "opm-fwd");
}

function cachedFresh(p: string, pack: Pack): boolean {
  try {
    const ttl = Number(pack.policy.cache?.ttl_hours) || 720;
    return fs.existsSync(p) && Date.now() - fs.statSync(p).mtimeMs < ttl * 3600 * 1000;
  } catch {
    return false;
  }
}

async function runDownload(c: Ctx, spec: any, plan: Plan, o: { route: string; local?: Record<string, string>;
  acquired: string; warnings?: string[] }): Promise<DeepResult> {
  const client = new OpmClient();
  const cdir = rawCacheRoot();
  if (!o.local) fs.mkdirSync(cdir, { recursive: true });
  const tables = new Map<string, Table[]>();
  const infos: any[] = [];
  for (const f of plan.files) {
    const raw = o.local?.[f.filename] || path.join(cdir, f.filename + ".parquet");
    const fresh = o.local !== undefined || cachedFresh(raw, c.pack);
    if (!fs.existsSync(raw) || !fresh) {
      if (o.local) throw new DataError(`${f.filename} was not among the ingested files`, "not_found");
      await client.download(f.dataset, f.year, f.month, f.version, raw);
    }
    const [t, info] = await processFile(raw, f.dataset, f, spec);
    if (!tables.has(f.dataset)) tables.set(f.dataset, []);
    tables.get(f.dataset)!.push(t);
    infos.push({ ...f, ...info, bytes: fs.statSync(raw).size, sha256: fileSha(raw) });
  }
  const applies = datasetColumns(c.pack);
  for (const f of infos) {
    f.missing_columns = f.missing_columns.filter((x: string) => !Object.keys(applies).length || applies[f.dataset]?.has(x));
  }
  const { M, tablesMeta, retrieved, dir } = packageData(c, spec, tables, infos, o.route, o.acquired);
  const warn: string[] = [];
  for (const f of infos) {
    if (f.missing_columns.length) warn.push(`${f.filename}: columns not in this file (nulls): ${f.missing_columns.slice(0, 8).join(", ")}`);
    if (f.filters_not_applied.length) {
      warn.push(`${f.filename}: filter column(s) ${pyRepr(f.filters_not_applied)} absent, so rows were NOT filtered`);
    } else if (spec.filters && Object.keys(spec.filters).length && f.rows_raw && !f.rows_kept) {
      warn.push(`${f.filename}: the filters kept 0 of ${f.rows_raw} rows; check the codes in spec.json`);
    }
  }
  const empty = infos.length > 0 && !!spec.filters && Object.keys(spec.filters).length > 0 && !infos.some((f) => f.rows_kept);
  if (empty) {
    throw new DataError("the filters kept no rows in any file: check the codes in spec.json (data_dictionary.csv " +
      "has sample values; filter values are strings exactly as in the data)", "spec");
  }
  const vintage = [...new Set(infos.map((f) => `${f.dataset}_${f.year}${pad(Number(f.month))}_v${f.version ?? "None"}`))]
    .sort().join(", ").slice(0, 400);
  return { data_dir: dir, tables: tablesMeta, notes: [...(o.warnings || []), ...warn].slice(0, 30), problems: [], retrieved,
    citation: cite(Object.keys(M.datasets).sort().join(", "), M.downloaded.slice(0, 10)), vintage, route: o.route,
    files: [path.join(dir, "manifest.json"), path.join(dir, "spec_used.json"), ...M.outputs.filter((x: string) => x.endsWith(".parquet"))
      .map((x: string) => path.join(dir, x))] };
}

function existing(out: string, spec: any): { matches: boolean; manifest: any } | null {
  const d = dataDir(out, SOURCE);
  const mp = path.join(d, "manifest.json");
  if (!fs.existsSync(mp)) return null;
  let M: any;
  try {
    M = JSON.parse(fs.readFileSync(mp, "utf8"));
  } catch {
    return null;
  }
  const filesOk = (M.outputs || []).every((f: string) => fs.existsSync(path.join(d, f)));
  return { matches: M.spec_fingerprint === specFingerprint(spec) && filesOk, manifest: M };
}

function csvHeader(file: string): string[] {
  if (!file.endsWith(".csv") || !fs.existsSync(file)) return [];
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(65536);
  const n = fs.readSync(fd, b, 0, b.length, 0);
  fs.closeSync(fd);
  const line = b.subarray(0, n).toString("utf8").split(/\r?\n/)[0];
  const row = readCsv(line + "\r\nx")[0];
  return row ? Object.keys(row) : [];
}

function fromManifest(out: string, M: any, route: string, notes: string[]): DeepResult {
  const d = dataDir(out, SOURCE);
  let req: any = {};
  try {
    req = JSON.parse(fs.readFileSync(path.join(d, "request.json"), "utf8"));
  } catch {
    /* request.json is optional here */
  }
  const tables = Object.entries<any>(M.datasets || {}).map(([ds, v]) => {
    const file = (v || {}).csv || (v || {}).parquet;
    return { name: `opm_${ds}`, file, rows: (v || {}).rows ?? 0, columns: csvHeader(path.join(d, file)) };
  });
  return { data_dir: d, tables, notes, problems: [], retrieved: req.retrieved || M.downloaded, vintage: req.vintage || "",
    citation: cite(Object.keys(M.datasets || {}).sort().join(", "), String(M.downloaded || "").slice(0, 10)), route,
    files: [path.join(d, "manifest.json"), path.join(d, "spec_used.json"), ...(M.outputs || [])
      .filter((x: string) => x.endsWith(".parquet")).map((x: string) => path.join(d, x))] };
}

async function fetch(ctx: DeepContext): Promise<DeepResult> {
  const spec = normalize(ctx.spec);
  const probs = checkSpec(spec, ctx.pack);
  if (probs.length) throw specError(probs.join("; "));
  const c: Ctx = { pack: ctx.pack, out: ctx.workspace };
  const ex = existing(c.out, spec);
  if (ex && ex.matches && !ctx.force) {
    const M = ex.manifest;
    return fromManifest(c.out, M, "reuse_existing", [`${dataDir(c.out, SOURCE)} already holds this request ` +
      `(${commas(M.rows || 0)} rows, downloaded ${M.downloaded}). Use force: true to download again (for example after ` +
      "OPM publishes revised versions)."]);
  }
  const plan = await buildPlan(spec, new OpmClient());
  if (Object.keys(plan.missing).length && !plan.files.length) {
    throw specError(`Requested periods do not exist: ${pyRepr(plan.missing)}. request_schema lists the periods each ` +
      "dataset has.");
  }
  const warnings = Object.keys(plan.missing).length ? [`Not available and skipped: ${pyRepr(plan.missing)}.`] : [];
  return runDownload(c, spec, plan, { route: "api", acquired: "FWD API download", warnings });
}

// ---------------------------------------------------------------- ingest (hand-downloaded files)
const RAW_EXT = [".parquet", ".txt", ".csv", ".tsv", ".dat", ".json", ".jsonl", ".gz", ".zip"];

function prebuilt(c: Ctx, spec: any, src: string): DeepResult {
  const dst = dataDir(c.out, SOURCE);
  if (path.resolve(src) !== path.resolve(dst)) fs.cpSync(src, dst, { recursive: true });
  const M = JSON.parse(fs.readFileSync(path.join(dst, "manifest.json"), "utf8"));
  [M.route, M.acquired] = ["manual_download", "manual_prebuilt"];
  fs.writeFileSync(path.join(dst, "manifest.json"), JSON.stringify(M, null, 2));
  const tables = Object.entries<any>(M.datasets || {}).map(([ds, v]) =>
    ({ name: `opm_${ds}`, file: (v || {}).csv || (v || {}).parquet, rows: (v || {}).rows }));
  writeRequestJson(dst, spec, "manual_download", "manual_prebuilt", tables, M.files || []);
  const warn = M.spec_fingerprint === specFingerprint(spec) ? [] : ["the uploaded data/ folder was built from a different spec.json"];
  return fromManifest(c.out, M, "manual_download", warn);
}

function walk(d: string): string[][] {
  const out: string[][] = [];
  const rec = (dir: string) => {
    const names = fs.readdirSync(dir);
    out.push([dir, ...names.filter((n) => fs.statSync(path.join(dir, n)).isFile())]);
    for (const n of names) if (fs.statSync(path.join(dir, n)).isDirectory()) rec(path.join(dir, n));
  };
  rec(d);
  return out;
}

async function ingest(ctx: DeepContext & { files: string[] }): Promise<DeepResult> {
  const spec = normalize(ctx.spec);
  const probs = checkSpec(spec, ctx.pack);
  if (probs.length) throw specError(probs.join("; "));
  const c: Ctx = { pack: ctx.pack, out: ctx.workspace };
  const found: string[] = [];
  const tmpRoot = path.join(dataDir(c.out, SOURCE), "_ingest");
  fs.rmSync(tmpRoot, { recursive: true, force: true }); // never re-read files from an earlier upload
  try {
    const scan = (d: string): DeepResult | null => {
      for (const [root, ...files] of walk(d)) {
        if (files.includes("manifest.json") && files.some((f) => /^opm_\w+\.(parquet|csv|csv\.gz)$/.test(f))) return prebuilt(c, spec, root);
        found.push(...files.filter((f) => RAW_EXT.some((e) => f.toLowerCase().endsWith(e)) && f !== "data_dictionary.csv")
          .map((f) => path.join(root, f)));
      }
      return null;
    };
    for (const [i, p] of ctx.files.entries()) {
      if (fs.statSync(p).isDirectory()) {
        const r = scan(p);
        if (r) return r;
      } else if (p.toLowerCase().endsWith(".zip") && Object.keys(unzipSync(fs.readFileSync(p))).filter((n) => !n.endsWith("/")).length > 1) {
        const dst = path.join(tmpRoot, `zip${i}`); // one folder per ZIP, alongside the other arguments
        for (const [n, data] of Object.entries(unzipSync(fs.readFileSync(p)))) {
          if (n.endsWith("/")) continue;
          const t = path.resolve(dst, n);
          if (!t.startsWith(path.resolve(dst) + path.sep)) continue; // no paths outside the folder
          fs.mkdirSync(path.dirname(t), { recursive: true });
          fs.writeFileSync(t, data);
        }
        const r = scan(dst);
        if (r) return r;
      } else found.push(p);
    }
    // a single Parquet file inside .zip or .gz: unpack it, since the Parquet reader needs the plain file
    for (const [k, f] of found.entries()) {
      if (/\.(zip|gz)$/i.test(f) && (await io.fileKind(f)) === "parquet") {
        const member = io.innerName(f);
        const dst = path.join(tmpRoot, `pq${k}`);
        fs.mkdirSync(dst, { recursive: true });
        const target = path.join(dst, path.basename(member));
        fs.writeFileSync(target, f.toLowerCase().endsWith(".zip") ? unzipSync(fs.readFileSync(f))[member] : zlib.gunzipSync(fs.readFileSync(f)));
        found[k] = target;
      }
    }
    if (!found.length) {
      throw new DataError("no data files found (expected .parquet, .txt, .csv or .json, optionally zipped, or a data/ " +
        "folder built by fetch)", "not_found");
    }
    const files: PlanFile[] = [], local: Record<string, string> = {}, problems: string[] = [], warn: string[] = [];
    const best = new Map<string, [string, io.Who]>(); // one file per dataset and month
    for (const p of found) {
      const who = await io.identify(p);
      if (!who.dataset || !who.year) {
        problems.push(`${path.basename(p)}: cannot tell the dataset and month; rename it like separations_202608_1.txt`);
        continue;
      }
      const k = `${who.dataset}\t${who.year}\t${who.month}`;
      const old = best.get(k);
      if (old) {
        // two copies of one month (two versions, or a website file and an API file) would double the counts: keep
        // the highest version; an API file (versioned) beats a website file
        const [keep, drop] = (who.version || 0) > (old[1].version || 0) ? [[p, who] as [string, io.Who], old] : [old, [p, who] as [string, io.Who]];
        warn.push(`${path.basename(drop[0])} and ${path.basename(keep[0])} are both ${who.dataset} ${who.year}-${pad(who.month!)}; ` +
          `kept ${path.basename(keep[0])}`);
        best.set(k, keep);
      } else best.set(k, [p, who]);
    }
    const keys = [...best.keys()].sort((a, b) => {
      const [x, y] = [a.split("\t"), b.split("\t")];
      return x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : Number(x[1]) - Number(y[1]) || Number(x[2]) - Number(y[2]);
    });
    for (const k of keys) {
      const [p, who] = best.get(k)!;
      const [ds, y, m] = [who.dataset!, who.year!, who.month!];
      const name = `${ds}_${y}${pad(m)}_${who.version ?? "web"}`;
      if (who.how === "content") {
        warn.push(`${path.basename(p)}: dataset and month inferred from the content (${ds} ${y}-${pad(m)}); check that ` +
          "this is the month OPM labels the file with");
      }
      const rule = spec.datasets[ds];
      if (rule === undefined) {
        warn.push(`${path.basename(p)}: ${ds} is not in spec.json; skipped`);
        continue;
      }
      // "latest" means the latest month among the uploaded files of this dataset
      const avail = [...best.values()].filter(([, w]) => w.dataset === ds).map(([, w]) => key(w.year!, w.month!));
      const [wanted] = resolvePeriods(rule || {}, avail);
      if (!wanted.includes(key(y, m))) {
        warn.push(`${path.basename(p)}: ${y}-${pad(m)} is outside the periods in spec.json; skipped`);
        continue;
      }
      local[name] = p;
      files.push({ dataset: ds, year: y, month: m, version: who.version as number, filename: name, publishDate: null,
        current: null, identified_by: who.how,
        url: who.version ? `${BASE}/${ds}/${y}/${pad(m)}/${who.version}/download` : "https://data.opm.gov/get-data/data-downloads" });
    }
    if (problems.length && !files.length) throw new DataError(problems.join("; "), "not_found");
    files.sort((a, b) => (a.dataset !== b.dataset ? (a.dataset < b.dataset ? -1 : 1) : key(a.year, a.month) - key(b.year, b.month)));
    return await runDownload(c, spec, { files, missing: {}, est_mb: 0 }, { route: "manual_download", local,
      acquired: "manual_ingest (files downloaded by hand by the user and uploaded)", warnings: [...warn, ...problems] });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- manual route
/** The request as the download scripts read it (tab-separated): periods / range / pin rows per dataset. */
export function scriptRules(spec0: any): string[] {
  const spec = normalize(spec0);
  const rows: string[] = [];
  const ymText = (x: unknown) => {
    const p = ym(x);
    return `${pad(Math.floor(p / 100), 4)}${pad(p % 100)}`;
  };
  for (const [ds, rule0] of Object.entries<any>(spec.datasets)) {
    const rule = rule0 || {};
    if (rule.periods?.length) {
      rows.push(`${ds}\tperiods\t${rule.periods.map((x: unknown) => (String(x).toLowerCase() === "latest" ? "latest" : ymText(x))).join(",")}`);
    } else {
      const lo = rule.from ? ymText(rule.from) : "first";
      const hi = String(rule.to ?? "latest").toLowerCase() === "latest" ? "latest" : ymText(rule.to);
      const months = (rule.months?.length ? rule.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).map((x: unknown) => String(Math.trunc(Number(x)))).join(",");
      rows.push(`${ds}\trange\t${lo}\t${hi}\t${months}`);
    }
  }
  for (const [k, version] of Object.entries<any>(spec.pin || {})) {
    const m = /^([a-z]+)_(\d{6})$/.exec(k);
    if (m) rows.push(`${m[1]}\tpin\t${m[2]}\t${Math.trunc(Number(version))}`);
  }
  return rows;
}

/** download_opm.sh / .ps1 with the request built in: they list OPM's current files, pick the requested months
 * and download them (curl / Windows PowerShell, no key). */
export function writeDownloadScripts(d: string, spec: any, pack: Pack): { bash?: string; powershell?: string } {
  const rules = scriptRules(spec).join("\n");
  const out: { bash?: string; powershell?: string } = {};
  for (const [kind, name] of [["bash", "download_opm.sh"], ["powershell", "download_opm.ps1"]] as const) {
    const src = path.join(pack.dir, "assets", name);
    if (!fs.existsSync(src)) continue;
    let text = fs.readFileSync(src, "ascii").replace(/\r\n/g, "\n").replace("@RULES@", rules);
    if (kind === "powershell") text = text.replace(/\n/g, "\r\n");
    const p = path.join(d, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(p, text, { encoding: "ascii", mode: kind === "bash" ? 0o755 : 0o644 });
    out[kind] = p;
  }
  return out;
}

/** Items for the manual bundle: only months whose file is known without listing OPM's files (a pinned version). */
function manualItems(spec0: any): any[] {
  const spec = normalize(spec0);
  const client = new OpmClient(0);
  const out: any[] = [];
  for (const [k, v] of Object.entries<any>(spec.pin || {})) {
    const m = /^([a-z]+)_(\d{4})(\d{2})$/.exec(k);
    if (!m || !(m[1] in (spec.datasets || {}))) continue;
    const [ds, y, mo, ver] = [m[1], Number(m[2]), Number(m[3]), Math.trunc(Number(v))];
    out.push({ name: `${ds}_${y}${pad(mo)}_${ver}`, url: client.downloadUrl(ds, y, mo, ver), filename: `${ds}_${y}${pad(mo)}_${ver}.parquet`,
      needs_key: false, method: "GET", note: `OPM ${ds} file for ${y}-${pad(mo)}, version ${ver} (pinned)` });
  }
  return out;
}

// ---------------------------------------------------------------- schema, search
const SUMMARY: Record<string, string> = {
  employment: "Monthly status snapshot: every employee on board on the last day of the month (~2 million rows, 26-75 MB a file); quarterly 2005 to March 2011, monthly from June 2011.",
  accessions: "Personnel actions that brought people in, processed in the month (10k-60k rows); monthly from 2005-01.",
  separations: "Personnel actions that took people out, processed in the month (10k-120k rows); monthly from 2005-01.",
};

function dictionaryRows(pack: Pack): Record<string, string>[] {
  const p = dictionaryPath(pack);
  return p ? (readCsv(fs.readFileSync(p, "utf8")) as Record<string, string>[]) : [];
}

/** A column definition as the compact schema shows it. */
function shortDef(s: string, max = 90): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 3).replace(/\s+\S*$/, "") + "...";
}

async function schema(names: string[], pack: Pack, opts: { detail?: boolean } = {}): Promise<any[]> {
  const dict = dictionaryRows(pack);
  const out: any[] = [];
  for (const n of names) {
    if (!(DATASETS as readonly string[]).includes(n)) {
      out.push({ name: n, error: `unknown dataset; use one of ${DATASETS.join(", ")}` });
      continue;
    }
    let available: any;
    try {
      available = await listSummary(n);
    } catch (e: any) {
      available = { error: `the file listing could not be read now (${e?.message || e}); the fetch lists it again` };
    }
    out.push({ name: n, summary: SUMMARY[n],
      spec: { datasets: { [n]: { from: "YYYY-MM (optional; default the first file)", to: "YYYY-MM or \"latest\" (default)",
        months: "optional list of months, e.g. [9] for September snapshots", periods: "or a list of single months: [\"2025-09\", \"latest\"]" } },
        columns: "optional list of column names below (default all); always kept: " + [...ALWAYS[n], "file_yyyymm", "source_file"].join(", "),
        filters: "optional {column: [values]}; values are strings exactly as in the data (\"08\", \"0343\")",
        aggregate: "optional {\"by\": [columns]}: counts (headcount), pay_redacted, pay_n and pay_sum per group instead of microdata; keeps only the by columns",
        pin: "optional {\"<dataset>_<YYYYMM>\": version}: exact file versions (from an earlier manifest.json)" },
      always_kept: ALWAYS[n],
      columns: opts.detail
        ? dict.filter((r) => r[n] === "Y").map((r) => ({ name: r.field, definition: r.definition, example: r.sample_value }))
        : Object.fromEntries(dict.filter((r) => r[n] === "Y").map((r) => [r.field, shortDef(r.definition)])),
      ...(opts.detail ? {} : { columns_note: "definitions shortened: request_schema with detail: true gives them in full, with an example value" }),
      available });
  }
  return out;
}

function search(query: string, pack: Pack): any[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const scored = dictionaryRows(pack).map((r) => {
    const text = `${r.field} ${r.definition}`.toLowerCase();
    return [words.filter((w) => text.includes(w)).length, r] as const;
  }).filter(([s]) => s > 0);
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 25).map(([, r]) => ({ column: r.field, definition: r.definition, example: r.sample_value,
    datasets: DATASETS.filter((d) => r[d] === "Y") }));
}

function uses(spec: any): string[] {
  const ds = normalize(spec).datasets;
  return isObj(ds) ? Object.keys(ds).filter((d) => (DATASETS as readonly string[]).includes(d)) : [];
}

const pack: DeepPack = {
  operations: DATASETS.map((d) => ({ name: d, summary: SUMMARY[d] })),
  schema,
  uses,
  specExample: { description: "September headcount by department, 2015-2025",
    datasets: { employment: { from: "2015-09", to: "2025-09", months: [9] } },
    columns: ["department_code", "department"], aggregate: { by: ["department_code", "department"] } },
  search,
  checkSpec,
  fetch,
  ingest,
  manualItems: (spec) => manualItems(spec),
};
export default pack;
