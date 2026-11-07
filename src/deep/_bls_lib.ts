/**
 * The bls deep pack's spec, parsing and packaging (port of sources/bls/fetch.py).
 *
 * Output (<workspace>/data/bls/):
 *   bls_series.csv  one row per series and period: series_id, label, year, period, period_name, freq, date, value
 *                   (empty when BLS shows "-"), value_raw, preliminary, footnote_codes, footnotes, latest
 *                   (+ BLS calculations columns when requested)
 *   series.csv      one row per series: id, label, title, survey, seasonal, frequency, first/last period, counts
 *   raw/            every API response (request bodies without the key)
 *   request.json    the spec, API version, query plan, credential-free request log, retrieval time and route
 *   README.md       what is in the data, the gaps and flags, the citation and the BLS terms of use
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { trail } from "../core/context.js";
import * as keys from "../core/keys.js";
import { dataDir } from "../core/package.js";
import type { Pack } from "../core/packs.js";
import * as pol from "../core/policy.js";
import { pyFloatRepr, pyJsonDumps, pyStr } from "../core/py.js";
import { parse } from "csv-parse/sync";
import { writeCsv } from "../core/tabular.js";
import { BlsError, type BySeries, describe, LIMITS, planQueries, type Raw, URLS, type Version } from "./_bls_api.js";
import { build, decode, pyRepr, SpecError } from "./_bls_ids.js";

export const SOURCE = "bls";
const DESCRIBE_MAX = 60;          // series looked up on data.bls.gov when there is no v2 catalog

export type NSpec = { description: string; series: { id: string; label: string }[]; start_year: number; end_year: number;
  annual_average: boolean; catalog: boolean; calculations: boolean; aspects: boolean };

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Python truthiness of a JSON value. */
const truthy = (v: unknown) => !(v === null || v === undefined || v === false || v === 0 || v === "" ||
  (Array.isArray(v) && !v.length) || (typeof v === "object" && v !== null && !Array.isArray(v) && !Object.keys(v).length));
/** Python str() of a value that may be None. */
const s = (v: unknown) => (v === null ? "None" : pyStr(v));
/** dict.get(k, d): a key present with null stays null. */
const get = (o: any, k: string, d: unknown) => (o && typeof o === "object" && k in o ? o[k] : d);
const fmtInt = (n: number) => (n < 0 ? "-" : "") + String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function pyInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v.trim());
  throw new SpecError(`invalid literal for int() with base 10: ${pyRepr(pyStr(v))}`);
}

/** The spec with defaults filled in and built IDs expanded; throws SpecError on a problem. */
export function normSpec(spec: any): NSpec {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new SpecError("spec must be a JSON object");
  const series: { id: string; label: string }[] = [];
  for (const x of spec.series || []) {
    if (typeof x === "string") series.push({ id: x.trim().toUpperCase(), label: "" });
    else {
      if (!x || typeof x !== "object" || !("id" in x)) throw new SpecError("each series is an ID or {\"id\": ..., \"label\": ...}: 'id' is missing");
      series.push({ id: s(x.id).trim().toUpperCase(), label: x.label ?? "" });
    }
  }
  for (const b0 of spec.build || []) {
    if (!b0 || typeof b0 !== "object" || Array.isArray(b0)) throw new SpecError("each build entry is an object such as {\"kind\": \"laus\", \"state\": \"MD\"}");
    const { kind = "", ...kw } = b0;
    for (const x of build(String(kind), kw)) series.push({ id: x.id, label: x.label });
  }
  if (!series.length) throw new SpecError('spec.json has no series (give "series" or "build")');
  const ids = series.map((x) => x.id);
  const dup = [...new Set(ids.filter((i) => ids.indexOf(i) !== ids.lastIndexOf(i)))].sort(cmpStr);
  if (dup.length) throw new SpecError(`duplicate series in spec.json: ${pyRepr(dup)}`);
  const bad = ids.filter((i) => !/^[A-Z0-9]{5,40}$/.test(i));
  if (bad.length) throw new SpecError(`not BLS series IDs (capital letters and digits only): ${pyRepr(bad)}`);
  const end = pyInt(truthy(spec.end_year) ? spec.end_year : new Date().getFullYear());
  const start = pyInt(truthy(spec.start_year) ? spec.start_year : end - 9);
  if (start > end) throw new SpecError(`start_year ${start} is after end_year ${end}`);
  return { description: spec.description ?? "", series, start_year: start, end_year: end,
    annual_average: truthy(spec.annual_average), catalog: "catalog" in spec ? truthy(spec.catalog) : true, calculations: truthy(spec.calculations),
    aspects: truthy(spec.aspects) };
}

/** Two specs asking for the same data hash the same (labels and description do not matter). */
export function fingerprint(sp: NSpec): string {
  const core = { series: sp.series.map((x) => x.id).sort(cmpStr), start: sp.start_year, end: sp.end_year,
    annual_average: sp.annual_average, calculations: sp.calculations };
  return createHash("sha256").update(pyJsonDumps(core, true)).digest("hex").slice(0, 16);
}

export function existingData(out: string, fp: string): any | null {
  const d = dataDir(out, SOURCE);
  const rq = path.join(d, "request.json"), csvPath = path.join(d, "bls_series.csv");
  if (!fs.existsSync(rq)) return null;
  let saved: any;
  try {
    saved = JSON.parse(fs.readFileSync(rq, "utf8"));
  } catch {
    return null;
  }
  const t = Date.parse(saved.retrieved || "");
  return { path: csvPath, csv_exists: fs.existsSync(csvPath), matches: saved.fingerprint === fp, retrieved: saved.retrieved || "",
    age_days: Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null, api_version: saved.api_version,
    route: saved.route, latest_period: saved.latest_period, problems: saved.problems || [], saved };
}

// --------------------------------------------------------------------------- parse + package
const pad2 = (n: number) => String(n).padStart(2, "0");

/** [freq, date] for a BLS period code. Annual averages get freq 'A' and the mid-year date. */
export function periodInfo(year: number, period: string): [string, string] {
  const p = period.toUpperCase();
  const n = () => parseInt(p.slice(1), 10);
  if (p === "M13" || p === "Q05" || p === "S03" || p.startsWith("A")) return ["A", `${year}-07-01`];
  if (p.startsWith("M")) return ["M", `${year}-${pad2(n())}-01`];
  if (p.startsWith("Q")) return ["Q", `${year}-${pad2(3 * n() - 2)}-01`];
  if (p.startsWith("S")) return ["S", `${year}-${pad2(p === "S01" ? 1 : 7)}-01`];
  return ["?", `${year}-01-01`];
}

/** Last month a period covers (M09 -> 9, Q03 -> 9, S01 -> 6), to order periods of mixed frequencies. */
function periodEndMonth(freq: string, period: string): number {
  if (!/^\s*[+-]?\d+\s*$/.test(period.slice(1))) return 0;
  const n = parseInt(period.slice(1), 10);
  return ({ M: n, Q: 3 * n, S: 6 * n } as Record<string, number>)[freq] ?? 0;
}

export type Row = { series_id: string; label: string; year: number; period: string; period_name: string; freq: string;
  date: string; value: string; value_raw: string; preliminary: number; footnote_codes: string; footnotes: string;
  latest: number; [k: string]: any };

/** Periods between a series' first and last row that BLS returned no row for at all (not even "-"). */
export function absentPeriods(sub: Row[]): string[] {
  const out: string[] = [];
  for (const [f, k] of [["M", 12], ["Q", 4], ["S", 2]] as [string, number][]) {
    const have = new Set(sub.filter((r) => r.freq === f && /^\d+$/.test(r.period.slice(1))).map((r) => r.year * k + parseInt(r.period.slice(1), 10) - 1));
    if (!have.size) continue;
    const lo = Math.min(...have), hi = Math.max(...have);
    for (let i = lo; i <= hi; i++) if (!have.has(i)) out.push(`${Math.floor(i / k)} ${f}${pad2((i % k) + 1)}`);
  }
  return out;
}

/** Python float() of a BLS value; null when it is not a number. */
function pyFloat(t: string): number | null {
  const x = t.trim();
  if (/^[+-]?(nan|inf|infinity)$/i.test(x)) return x.toLowerCase().includes("nan") ? NaN : x.startsWith("-") ? -Infinity : Infinity;
  if (!/^[+-]?((\d(_?\d)*)?\.?\d(_?\d)*|\d(_?\d)*\.)([eE][+-]?\d(_?\d)*)?$/.test(x)) return null;
  return Number(x.replace(/_/g, ""));
}

export function tidy(by: BySeries, labels: Map<string, string>): Row[] {
  const rows: Row[] = [];
  for (const [sid, rec] of by) {
    for (const o of rec.data) {
      const year = parseInt(String(o.year), 10), period = String(o.period);
      const [freq, dt] = periodInfo(year, period);
      const raw = s(get(o, "value", "")).trim();
      const val = pyFloat(raw.replaceAll(",", ""));
      const fns = (o.footnotes || []).filter((f: any) => truthy(f) && (truthy(f.code) || truthy(f.text)));
      const codes = fns.map((f: any) => s(get(f, "code", ""))).join(";");
      const texts = fns.map((f: any) => s(get(f, "text", ""))).join(" | ");
      const prelim = fns.some((f: any) => s(get(f, "code", "")).toUpperCase() === "P" || s(get(f, "text", "")).toLowerCase().includes("preliminary"));
      const row: Row = { series_id: sid, label: labels.get(sid) ?? "", year, period, period_name: get(o, "periodName", ""), freq, date: dt,
        value: val === null ? "" : pyFloatRepr(val), value_raw: raw, preliminary: prelim ? 1 : 0, footnote_codes: codes,
        footnotes: texts, latest: s(get(o, "latest", "")) === "true" ? 1 : 0 };
      const calc = o.calculations || {};
      for (const kind of ["net_changes", "pct_changes"]) {
        for (const [k, v] of Object.entries(calc[kind] || {})) row[`bls_${kind.endsWith("_changes") ? kind.slice(0, -8) : kind}_${k}m`] = v;
      }
      rows.push(row);
    }
  }
  const seen = new Set<string>(), out: Row[] = [];
  const sorted = rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) =>
    cmpStr(a.series_id, b.series_id) || cmpStr(a.date, b.date) || cmpStr(a.period, b.period) || i - j).map(([r]) => r);
  for (const r of sorted) {
    const k = JSON.stringify([r.series_id, r.year, r.period]);
    if (!seen.has(k)) {                  // overlapping query windows never duplicate a period
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

const sha256 = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
/** json.dumps(x, indent=n): ASCII only. */
const jsonIndent = (x: unknown, n: number) => JSON.stringify(x, null, n).replace(/[\u0080-￿]/g,
  (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

export type Packaged = { req: any; meta: any[]; rows: Row[] };

export async function packageData(pack: Pack, by: BySeries, messages: string[], raw: Raw, sp: NSpec, out: string,
  apiVersion: Version, acquired: string, route: string, extraProblems: string[] = []): Promise<Packaged> {
  const d = dataDir(out, SOURCE);
  fs.mkdirSync(path.join(d, "raw"), { recursive: true });
  for (const f of fs.readdirSync(path.join(d, "raw"))) if (/^response_.*\.json$/.test(f)) fs.rmSync(path.join(d, "raw", f));
  raw.forEach((x, i) => fs.writeFileSync(path.join(d, "raw", `response_${pad2(i + 1)}.json`), keys.redact(jsonIndent(x, 1))));
  const labels = new Map(sp.series.map((x) => [x.id, x.label]));
  const rows = tidy(new Map([...by].filter(([k, v]) => labels.has(k) || v.data.length)), labels);
  const base = ["series_id", "label", "year", "period", "period_name", "freq", "date", "value", "value_raw", "preliminary",
    "footnote_codes", "footnotes", "latest"];
  const extra = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => !base.includes(k)).sort(cmpStr);
  fs.writeFileSync(path.join(d, "bls_series.csv"), writeCsv(rows, [...base, ...extra]));

  const meta: any[] = [];
  const problems = [...extraProblems];
  let lookedUp = 0;
  let describeTitles = true;
  for (const x of sp.series) {
    const sid = x.id;
    const mine = rows.filter((r) => r.series_id === sid);
    const nonA = mine.filter((r) => r.freq !== "A");
    const sub = nonA.length ? nonA : mine;
    const cat = by.get(sid)?.catalog || {};
    const dec = decode(sid);
    let title: string = cat.series_title || "", seasonal: string = cat.seasonality || dec.seasonal, source = "catalog";
    if (!title && describeTitles && lookedUp < DESCRIBE_MAX) {
      lookedUp++;
      const info = await describe(sid);
      if (info.error && !String(info.error).includes("not found")) describeTitles = false; // data.bls.gov unreachable
      title = info.title || Object.entries<string>(info.fields || {}).filter(([k]) => k.toLowerCase() !== "series id")
        .map(([k, v]) => `${k}: ${v}`).join("; ");
      seasonal = seasonal || info.seasonal || "";
      source = title ? "data.bls.gov" : "";
    }
    if (!title) source = "";
    const sidMsgs = messages.filter((m) => m.toUpperCase().includes(sid));
    if (!mine.length) problems.push(`${sid}: no data returned` + (sidMsgs.length ? ` (${sidMsgs.join("; ")})` : ""));
    const freqs = [...new Set(sub.map((r) => r.freq))].sort(cmpStr);
    const absent = absentPeriods(sub);
    meta.push({ series_id: sid, label: x.label, title, title_source: source, survey: dec.survey, seasonal,
      frequency: freqs.join("/"), first_period: sub.length ? `${sub[0].year} ${sub[0].period}` : "",
      last_period: sub.length ? `${sub[sub.length - 1].year} ${sub[sub.length - 1].period}` : "",
      n_obs: sub.length, n_missing: sub.filter((r) => r.value === "").length + absent.length, absent_periods: absent.join(" "),
      n_preliminary: sub.reduce((a, r) => a + r.preliminary, 0),
      has_annual_average: mine.some((r) => r.freq === "A") && JSON.stringify(freqs) !== '["A"]' ? 1 : 0,
      bls_messages: sidMsgs.join(" | ") });
  }
  const metaFields = ["series_id", "label", "title", "title_source", "survey", "seasonal", "frequency", "first_period",
    "last_period", "n_obs", "n_missing", "absent_periods", "n_preliminary", "has_annual_average", "bls_messages"];
  fs.writeFileSync(path.join(d, "series.csv"), writeCsv(meta, metaFields));

  const nonA = rows.filter((r) => r.freq !== "A");
  const sub = nonA.length ? nonA : rows;       // annual-only pulls (OEWS) report their year
  let best: [number, number, string] = [0, 0, ""];
  for (const r of sub) {
    const t: [number, number, string] = [r.year, periodEndMonth(r.freq, r.period), `${r.year} ${r.period}`];
    if (t[0] > best[0] || (t[0] === best[0] && (t[1] > best[1] || (t[1] === best[1] && t[2] > best[2])))) best = t;
  }
  const latest = best[2];
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const tables = ["bls_series", "series"].map((name) => ({ name, file: `${name}.csv`,
    rows: name === "bls_series" ? rows.length : meta.length, sha256: sha256(path.join(d, `${name}.csv`)) }));
  const P = pack.policy;
  const req = { source: SOURCE, fingerprint: fingerprint(sp), retrieved: now, api_version: apiVersion, route, acquired, spec: sp,
    queries: raw.map((x) => x.request), n_queries: raw.length, requests: trail().slice(), tables, messages, problems,
    latest_period: latest, rows: rows.length,
    v2_options_dropped: apiVersion === "v2" ? [] : (["annual_average", "calculations", "catalog"] as const).filter((o) => sp[o]),
    policy: { redistribution: P.redistribution.mode, cache: P.cache.mode } };
  fs.writeFileSync(path.join(d, "request.json"), keys.redact(jsonIndent(req, 2)));
  writeReadme(pack, d, sp, meta, rows, req);
  return { req, meta, rows };
}

function writeReadme(pack: Pack, d: string, sp: NSpec, meta: any[], rows: Row[], req: any): void {
  const P = pack.policy;
  const statement = P.notices?.length ? P.notices[0] : "";
  const retrieved = pol.localDay(req.retrieved);
  const missing = rows.filter((r) => r.value === "");
  const prelim = rows.filter((r) => r.preliminary);
  const lines = [
    `# BLS time series: ${sp.description || meta.map((m) => m.series_id).join(", ")}`,
    "",
    `- Retrieved: ${pol.localStamp(req.retrieved)} from the BLS Public Data API ${req.api_version} (${req.acquired}; ` +
    `route \`${req.route}\`)`,
    `- Years requested: ${sp.start_year} to ${sp.end_year}; latest period in the data: ${req.latest_period}`,
    `- Rows: ${fmtInt(rows.length)} in \`bls_series.csv\` (one per series and period); series details in \`series.csv\``,
    "- Raw API responses: `raw/`; the exact requests: `request.json`",
    "",
    "## Series",
    "| Series ID | Label | Title | Seasonal | Freq | Periods | Missing | Preliminary |",
    "|---|---|---|---|---|---|---|---|",
    ...meta.map((m) => `| \`${m.series_id}\` | ${m.label} | ${m.title} | ${m.seasonal} | ${m.frequency} | ` +
      `${m.first_period} to ${m.last_period} (${m.n_obs}) | ${m.n_missing} | ${m.n_preliminary} |`),
    "",
    "## Read this before analyzing",
    "- `value` is empty where BLS shows `-` (not collected or not published); `footnotes` says why. Never fill " +
    "these by interpolation without saying so; a change across a gap needs both endpoints.",
    "- `preliminary` = 1 marks estimates BLS will revise (CES: the two latest months; JOLTS and LAUS: the " +
    "latest month). Say so when citing them.",
    "- Rows with `freq` = A are annual: M13, Q05 and S03 are BLS-published annual averages, not a month; A01 " +
    "is a survey published once a year (OEWS refers to May of that year, not an average). `date` is July 1 " +
    "for all of them: describe the period from `period` and the survey, not from `date`.",
  ];
  if (missing.length) {
    const gaps = [...new Set(missing.map((r) => `${r.year} ${r.period_name}`))].sort(cmpStr);
    lines.push(`- Missing values in this pull: ${missing.length} (${gaps.slice(0, 8).join(", ")}${gaps.length > 8 ? ", ..." : ""}).`);
  }
  if (prelim.length) lines.push(`- Preliminary values in this pull: ${prelim.length}.`);
  const dropped = (req.v2_options_dropped || []).filter((o: string) => o !== "catalog"); // titles come from data.bls.gov
  if (dropped.length) {
    lines.push(`- Requested but not available without a key: ${dropped.join(", ")}. ` +
      "Annual averages must be computed from the monthly data (state it in the methods).");
  }
  if (req.problems?.length) lines.push("", "## Problems", ...req.problems.map((p: string) => `- ${p}`));
  lines.push(
    "",
    "## Reading the data",
    "```python",
    "import pandas as pd",
    "df = pd.read_csv('bls_series.csv', parse_dates=['date'])",
    "m = df[df.freq == 'M'].pivot(index='date', columns='series_id', values='value')",
    "```",
    "",
    "## Citation and terms of use",
    `Source: U.S. Bureau of Labor Statistics, series ${meta.map((m) => m.series_id).join(", ")}, retrieved ` +
    `${retrieved} through the BLS Public Data API (https://www.bls.gov/developers/).`,
    "",
    "BLS terms of service (https://www.bls.gov/developers/termsOfService.htm) require citing the date the " +
    `data were retrieved and stating: "${statement}" The BLS logo may not be used.`,
    "",
    "## Use and redistribution",
    `Rule: **${P.redistribution.mode}**. ${P.redistribution.why ?? ""}`,
  );
  fs.writeFileSync(path.join(d, "README.md"), lines.join("\n") + "\n");
}

// --------------------------------------------------------------------------- manual route and ingest
/** The manual download plan: keyless v1 whenever it fits the daily limit, else v2 (needs the user's key). */
export function manualPlan(sp: NSpec): { version: Version; bodies: Record<string, unknown>[] } {
  const ids = sp.series.map((x) => x.id);
  const v1 = planQueries(ids, sp.start_year, sp.end_year, "v1");
  const version: Version = v1.length > LIMITS.v1.daily ? "v2" : "v1";
  const v2opts: Record<string, boolean> = {};
  for (const [k, opt] of [["annualaverage", "annual_average"], ["calculations", "calculations"], ["catalog", "catalog"]] as const) {
    if (sp[opt]) v2opts[k] = true;
  }
  const bodies = planQueries(ids, sp.start_year, sp.end_year, version).map(([chunk, y0, y1]) => ({
    seriesid: chunk, startyear: String(y0), endyear: String(y1), ...(version === "v2" ? v2opts : {}) }));
  return { version, bodies };
}

export function manualItems(spec: any): any[] {
  const { version, bodies } = manualPlan(normSpec(spec));
  return bodies.map((body, i) => ({ name: `response_${pad2(i + 1)}`, filename: `response_${pad2(i + 1)}.json`,
    url: URLS[version], method: "POST", body, needs_key: version === "v2",
    note: version === "v2" ? "needs a free BLS registration key: there are more than the 25 keyless queries a day"
      : "no key needed (fits the keyless limits, 25 queries a day)" }));
}

/** Spec series/years that no successful request asked for (an upload missing some responses). */
export function uncoveredYears(sp: NSpec, requests: any[]): string[] {
  const covered = new Map<string, Set<number>>();
  for (const q of requests) {
    const y0 = parseInt(q?.startyear, 10), y1 = parseInt(q?.endyear, 10);
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    for (const sid of q.seriesid || []) {
      const k = String(sid).toUpperCase();
      if (!covered.has(k)) covered.set(k, new Set());
      for (let y = y0; y <= y1; y++) covered.get(k)!.add(y);
    }
  }
  const out: string[] = [];
  for (const x of sp.series) {
    const have = covered.get(x.id) || new Set<number>();
    const miss: number[] = [];
    for (let y = sp.start_year; y <= sp.end_year; y++) if (!have.has(y)) miss.push(y);
    if (miss.length) {
      const span = miss.length === 1 ? `${miss[0]}` : `${miss[0]}-${miss[miss.length - 1]}`;
      out.push(`${x.id}: no successful response covers ${span} (${miss.length} year(s)); upload every response_*.json`);
    }
  }
  return out;
}

export async function ingest(pack: Pack, paths: string[], sp: NSpec, out: string): Promise<{ pk: Packaged; notes: string[] }> {
  const files: string[] = [];
  const walk = (p: string): string[] => fs.readdirSync(p).flatMap((n) => {
    const f = path.join(p, n);
    return fs.statSync(f).isDirectory() ? walk(f) : /\.json$/i.test(n) ? [f] : [];
  });
  for (const p of paths) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) files.push(...walk(p).sort(cmpStr));
    else if (fs.existsSync(p)) files.push(p);
    else throw new BlsError(`Not found: ${p}`, "request");
  }
  // the server's download scripts save each reply under the request's file name (response_NN.json)
  const plan = manualPlan(sp).bodies;
  const by: BySeries = new Map();
  const messages: string[] = [], refused: string[] = [], notes: string[] = [];
  const raw: Raw = [];
  for (const fp of files) {
    let j: any;
    try {
      j = JSON.parse(fs.readFileSync(fp, "utf8").replace(/^﻿/, ""));
    } catch {
      notes.push(`skipped ${path.basename(fp)}: not JSON`);
      continue;
    }
    if (j && typeof j === "object" && !Array.isArray(j) && j.response && typeof j.response === "object" && !Array.isArray(j.response)) {
      j = { ...j.response, _request: j.request };       // our own raw/ wrapper
    }
    if (!j || typeof j !== "object" || Array.isArray(j) || (!("Results" in j) && !("status" in j))) continue; // a query file or another file
    if (j.status !== "REQUEST_SUCCEEDED") {
      refused.push(keys.redact(`${path.basename(fp)}: BLS refused the request (${s(j.status ?? null)}) ${(j.message || []).join(" ")}`));
      continue;
    }
    let req = j._request;
    delete j._request;
    if (req === undefined) {
      const m = /^response_(\d+)\.json$/i.exec(path.basename(fp));
      const q: any = m ? plan[Number(m[1]) - 1] : undefined;
      const got = (j.Results?.series || []).map((x: any) => String(x.seriesID ?? "").toUpperCase());
      req = q && got.every((sid: string) => q.seriesid.includes(sid)) ? q : { file: path.basename(fp) };
    }
    raw.push({ request: req, response: j });
    messages.push(...(j.message || []).map((m: unknown) => keys.redact(m)));
    for (const ser of j.Results?.series || []) {
      const sid = String(ser.seriesID ?? "").toUpperCase();
      if (!by.has(sid)) by.set(sid, { data: [], catalog: null });
      const rec = by.get(sid)!;
      rec.data.push(...(ser.data || []));
      rec.catalog = rec.catalog || ser.catalog || null;
    }
  }
  if (refused.length) notes.push("BLS refused some uploaded requests: " + refused.join("; "));
  if (!raw.length) throw new BlsError("No successful BLS API responses among the uploaded files.", "request");
  const v2 = [...by.values()].some((r) => r.catalog) ||
    [...by.values()].some((r) => r.data.some((o: any) => ["M13", "Q05", "S03"].includes(o.period) || truthy(o.calculations)));
  const reqs = raw.map((x) => x.request);
  let problems: string[];
  if (reqs.every((q) => q && typeof q === "object" && "seriesid" in q)) problems = uncoveredYears(sp, reqs);
  else {
    problems = refused;                  // cannot tell what is missing: every refusal counts
    notes.push("some uploaded responses do not say which request they answer; check that every response_*.json was uploaded");
  }
  const pk = await packageData(pack, by, messages, raw, sp, out, v2 ? "v2" : "v1", "downloaded by the user and uploaded",
    "manual_download", problems);
  return { pk, notes };
}

export function readHeader(p: string): string[] {
  const grid: string[][] = parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""), { relax_column_count: true, relax_quotes: true,
    skip_empty_lines: true, to_line: 1 });
  return grid[0] || [];
}
