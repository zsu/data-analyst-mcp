/**
 * Census microdata on the API: ACS PUMS (acs/acs1/pums, acs/acs5/pums, acs/acs1/pumspr) and the CPS (cps/asec/mar,
 * cps/basic/<month>). Every request gets the person keys and the weights; columns past the 50-variable limit
 * (replicate weights) are fetched in further calls and joined on the keys; a national ACS request is fetched state
 * by state. Rows stream to a CSV on disk, values exactly as published, and a <request>_codebook table gives every
 * code's label. ASEC replicate weights are joined from Census's replicate weight file, through gates.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { parse } from "csv-parse/sync";
import { Cache } from "../core/cache.js";
import { Client, DataError } from "../core/http.js";
import { FileTable } from "../core/package.js";
import type { Pack, Row, SpecRequest } from "../core/packs.js";
import { parsePyJson, pyStr } from "../core/py.js";
import { censusGet, csvLine, ensureList, given, pyFloat, pyInt, pyRepr, pyTuple, STATES, stateOf, startsWithBrace,
  ValueErr } from "./_census_util.js";

export const MAX_VARS = 50;

type MicroSpec = { keys: string[]; weights: string[]; replicates?: { person: string[]; household: string[] }; join?: string[] };
const range = (pre: string, n: number) => Array.from({ length: n }, (_, i) => `${pre}${i + 1}`);
export const MICRO: Record<string, MicroSpec> = {
  acs_pums: { keys: ["SERIALNO", "SPORDER"], weights: ["PWGTP", "WGTP"],
    replicates: { person: range("PWGTP", 80), household: range("WGTP", 80) } },
  cps_asec: { keys: ["H_SEQ", "A_LINENO", "PERIDNUM"], weights: ["MARSUPWT", "HSUP_WGT"] }, // PERIDNUM alone repeats within a household
  cps_basic: { keys: ["HRHHID", "HRHHID2", "PULINENO"], weights: ["PWSSWGT", "PWCMPWGT"] },
};
const MICRO_NOT_PARAMS = ["dataset", "get", "state", "replicates", "moe", "county", "place", "zcta"];

export const ASEC_RW_DIR = (year: number) => `https://www2.census.gov/programs-surveys/cps/datasets/${year}/march/`;
export const ASEC_RW_FIRST = 2005;
export const ASEC_REPS = range("PWWGT", 160);

/** 'acs_pums', 'cps_asec' or 'cps_basic' for a microdata dataset path (with or without the year). */
export function microKind(ds: unknown): string | null {
  const d = pyStr(ds).trim().replace(/^\/+|\/+$/g, "");
  if (/(^|\/)acs\/acs[15]\/pums(pr)?$/.test(d)) return "acs_pums";
  if (/(^|\/)cps\/asec\/mar$/.test(d)) return "cps_asec";
  if (/(^|\/)cps\/basic\/[a-z]{3}$/.test(d)) return "cps_basic";
  return null;
}

export function datasetYear(ds: string): number | null {
  const m = /^(\d{4})\//.exec(ds);
  return m ? Number(m[1]) : null;
}

const off = (v: unknown) => v === undefined || v === null || v === false || v === 0 || v === "" ||
  v === "false" || v === "False" || v === "none";

/** replicates: true / "person" -> person replicate weights; "household"; "both". */
export function replicateSets(kind: string, value: unknown): string[] {
  if (off(value)) return [];
  const sets = MICRO[kind].replicates;
  const v = value === true || pyStr(value).toLowerCase() === "true" ? "person" : pyStr(value).toLowerCase();
  if (kind === "cps_asec") { // not API columns: joined from Census's replicate weight file
    if (!["person", "household", "both"].includes(v)) throw new ValueErr(`replicates must be true for the ASEC, not ${pyRepr(value)}`);
    return [];
  }
  if (!sets) {
    throw new ValueErr("the CPS basic monthly files have no replicate weights: drop replicates and give an " +
      "approximate standard error, saying so");
  }
  if (!["person", "household", "both"].includes(v)) {
    throw new ValueErr(`replicates must be true, "person", "household" or "both", not ${pyRepr(value)}`);
  }
  return [...(["person", "both"].includes(v) ? sets.person : []), ...(["household", "both"].includes(v) ? sets.household : [])];
}

/** The geography parameters of each call: one state, a PUMA list, or (national ACS) one call per state. */
export function microGeos(ds: string, kind: string, p: Record<string, any>): [Record<string, string>[], string[]] {
  const st = p.state;
  const notes: string[] = [];
  for (const k of ["county", "place", "zcta"]) {
    if (given(p[k])) {
      throw new ValueErr("microdata have no county, place or ZIP geography: the smallest area is the PUMA " +
        '(ACS: for "public use microdata area:*" with a state); CPS has states only');
    }
  }
  const fips = given(st) && st !== "*" ? stateOf(st, "fips") : null;
  const year = datasetYear(pyStr(ds).replace(/^\/+|\/+$/g, ""));
  if (kind === "cps_asec" && year && year < 2001 && (fips || p.for || p.ucgid)) {
    throw new ValueErr("the API's ASEC files before 2001 take no state geography (HTTP 500; checked 2026-11-04): " +
      `fetch the nation (no state) and filter on the file's state variable (--search ` +
      `"${year}/cps/asec/mar: state"), or use the ipums pack (STATEFIP)`);
  }
  if (p.ucgid) return [[{ ucgid: p.ucgid }], notes];
  if (p.for) {
    const g: Record<string, string> = { for: p.for };
    if (p.in || fips) g.in = p.in || `state:${fips}`;
    return [[g], notes];
  }
  if (fips) return [[{ for: `state:${fips}` }], notes];
  if (kind === "acs_pums" && !pyStr(ds).replace(/\/+$/, "").endsWith("pumspr")) {
    const states = STATES.map(([, f]) => f).filter((f) => parseInt(f, 10) <= 56);
    notes.push(`national ACS PUMS fetched state by state (${states.length} calls: 50 states and DC; Puerto ` +
      "Rico is the separate pumspr dataset)");
    return [states.map((f) => ({ for: `state:${f}` })), notes];
  }
  return [[{}], notes]; // the nation: CPS files answer without a geography (any year)
}

export type Plan = { kind: string; cols: string[]; chunks: string[][]; join: string[]; geos: Record<string, string>[];
  preds: Record<string, unknown>; asec_reps: boolean; notes: string[] };

/** The columns asked for, keys and weights added, split into calls of at most MAX_VARS variables (each later call
 * repeats the join keys), with the predicates (AGEP=25:54) every call repeats so all chunks cover the same persons. */
export function microPlan(ds: string, params: Record<string, any>, meta: Record<string, any> | null = null,
  absent: Set<string> = new Set()): Plan {
  const kind = microKind(ds)!;
  const spec = MICRO[kind];
  const p = { ...params };
  const user: string[] = [];
  for (const v of ensureList(p.get)) {
    if (v.toUpperCase() !== v) throw new ValueErr(`microdata variable names are upper case: ${pyRepr(v)}`);
    if (!user.includes(v)) user.push(v);
  }
  if (!user.length) throw new ValueErr("'get' needs at least one variable (AGEP,HICOV)");
  const notes: string[] = [];
  const adj: string[] = [];
  for (const v of user) { // dollar amounts need the adjustment factor beside them
    const label = pyStr((meta || {})[v]?.label ?? "");
    for (const f of ["ADJINC", "ADJHSG"]) if (label.includes(f) && !user.includes(f) && !adj.includes(f)) adj.push(f);
  }
  if (adj.length) {
    notes.push(`added ${adj.join(", ")}: the dollar variables say to multiply by it (value * ${adj[0]} / ` +
      "1,000,000 gives the survey year's dollars)");
  }
  const reps = replicateSets(kind, p.replicates);
  const asecReps = kind === "cps_asec" && !off(p.replicates);
  const year = datasetYear(pyStr(ds).replace(/^\/+|\/+$/g, ""));
  if (asecReps && year && year < ASEC_RW_FIRST) {
    throw new ValueErr(`Census's ASEC replicate weight files start with ${ASEC_RW_FIRST}: use the ipums pack ` +
      `(REPWTP) for ${year}, or drop replicates`);
  }
  const keys = [...spec.keys, ...(asecReps ? ["PH_SEQ", "PPPOS"] : [])];
  const added = [...keys, ...spec.weights, ...adj].filter((v) => !user.includes(v) && !absent.has(v));
  if (absent.size) {
    notes.push(`not in this file, so not added: ${[...absent].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ")} ` +
      "(older years lack some keys and weights)");
  }
  notes.push(`microdata keys and weights added: ${added.join(", ")} (weight every estimate; never count rows)`);
  if (reps.length) {
    notes.push(`${reps.length} replicate weights added (${reps[0]}-${reps[reps.length - 1]}): SE = sqrt(4/80 * sum over r of ` +
      "(estimate_r - estimate)^2), Census's method for ACS PUMS");
  }
  if (asecReps) {
    notes.push("160 replicate weights PWWGT1-PWWGT160 joined from Census's ASEC replicate weight file " +
      "(CPS_ASEC_ASCII_REPWGT_<year>) on PH_SEQ and PPPOS: SE = sqrt(4/160 * sum over r of " +
      "(estimate_r - estimate)^2); household estimates: the reference person's row (A_EXPRRP 1-2) " +
      "with HSUP_WGT and the same replicates");
  }
  const cols = [...user, ...added, ...reps.filter((r) => !user.includes(r))];
  const join = (spec.join || spec.keys).filter((k) => !absent.has(k));
  const first = cols.filter((c) => keys.includes(c) || spec.weights.includes(c));
  let rest = cols.filter((c) => !first.includes(c));
  const room = MAX_VARS - first.length;
  const chunks = [[...rest.slice(0, room), ...first]];
  rest = rest.slice(room);
  while (rest.length) {
    const n = MAX_VARS - join.length;
    chunks.push([...rest.slice(0, n), ...join]);
    rest = rest.slice(n);
  }
  if (chunks.length > 1) {
    notes.push(`${cols.length} columns in ${chunks.length} calls of at most ${MAX_VARS} variables, joined on ${join.join(", ")}`);
  }
  const preds: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if ([...MICRO_NOT_PARAMS, "for", "in", "ucgid"].includes(k) || !given(v)) continue;
    preds[k] = Array.isArray(v) ? v.map(pyStr).join(",") : v;
  }
  for (const k of Object.keys(preds)) {
    if (k.toUpperCase() !== k) {
      throw new ValueErr(`unknown parameter ${pyRepr(k)} for microdata: filters are variable names in upper case ` +
        '(AGEP: "25:54", HICOV: 2)');
    }
  }
  const [geos, gnotes] = microGeos(ds, kind, p);
  return { kind, cols, chunks, join, geos, preds, asec_reps: asecReps, notes: [...notes, ...gnotes] };
}

// ---------------------------------------------------------------------- rows of the API's JSON arrays
/** Rows of a Census API JSON array, one line at a time (the API writes one row per line), so a large body is
 * never parsed whole; a body on one line (hand-written fixtures) is parsed at once. */
export function* iterRows(body: Buffer): Generator<any[]> {
  const text = body.toString("utf8").replace(/^\uFEFF/, "");
  if ((text.match(/\n/g) || []).length < 2) {
    yield* (parsePyJson<any[][]>(text) || []);
    return;
  }
  let pos = 0;
  while (pos <= text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    let s = text.slice(pos, end).trim();
    pos = end + 1;
    if (!s) continue;
    if (s.startsWith("[[")) s = s.slice(1);
    if (s.endsWith("]]")) s = s.slice(0, -1);
    s = s.replace(/,+$/, "");
    if (s) yield parsePyJson(s);
  }
}

const cell = (v: unknown) => (v === null || v === undefined ? "" : v);

/** [(header, row iterator)] of the calls for one geography -> (columns, joined row iterator). The calls return the
 * persons in the same order, so rows are joined in step and every row's keys are checked; from the first row out of
 * step on, the rest is joined through a key index; a person missing from a call is an error, never a silent blank. */
export function mergeChunks(parts: [string[], Iterable<any[]>][], join: string[]): [string[], Iterable<unknown[]>] {
  const cols: string[] = [];
  const picks: number[][] = [];
  for (const [head] of parts) {
    const pick: number[] = [];
    head.forEach((c, i) => {
      if (!cols.includes(c)) {
        cols.push(c);
        pick.push(i);
      }
    });
    picks.push(pick);
  }
  if (parts.length === 1) {
    const [, rows] = parts[0];
    return [cols, (function* () {
      for (const row of rows) yield picks[0].map((i) => cell(row[i]));
    })()];
  }
  const kidx = parts.map(([head]) => join.map((k) => head.indexOf(k)));
  const its = parts.map(([, rows]) => rows[Symbol.iterator]());
  const take = (j: number, row: any[]) => picks[j].map((i) => cell(row[i]));
  const keyv = (j: number, row: any[]) => kidx[j].map((i) => row[i]);
  const key = (j: number, row: any[]) => JSON.stringify(keyv(j, row));
  const next = (it: Iterator<any[]>) => {
    const r = it.next();
    return r.done ? null : r.value;
  };
  function* gen(): Generator<unknown[]> {
    let pending: [any[], (any[] | null)[]] | null = null;
    for (;;) {
      const row0 = next(its[0]);
      if (row0 === null) break;
      const others = its.slice(1).map(next);
      if (others.every((o, j) => o !== null && key(j + 1, o) === key(0, row0))) {
        yield [...take(0, row0), ...others.flatMap((o, j) => take(j + 1, o!))];
        continue;
      }
      pending = [row0, others];
      break;
    }
    if (pending === null) {
      if (its.slice(1).some((it) => next(it) !== null)) {
        throw new DataError(`census microdata: a later call returned persons the first did not (${join.join(", ")})`, "api");
      }
      return;
    }
    const [row0, others] = pending;
    const idx: Map<string, any[]>[] = [];
    its.slice(1).forEach((it, j0) => {
      const m = new Map<string, any[]>();
      const o = others[j0];
      if (o !== null) m.set(key(j0 + 1, o), o);
      for (let x = next(it); x !== null; x = next(it)) m.set(key(j0 + 1, x), x);
      idx.push(m);
    });
    const rows0: any[][] = [row0];
    for (let x = next(its[0]); x !== null; x = next(its[0])) rows0.push(x);
    for (const r0 of rows0) {
      const k0 = key(0, r0);
      const got = idx.map((m) => {
        const g = m.get(k0) ?? null;
        m.delete(k0);
        return g;
      });
      if (got.some((g) => g === null)) {
        throw new DataError(`census microdata: person ${pyTuple(keyv(0, r0))} is missing from a later call; fetch again`, "api");
      }
      yield [...take(0, r0), ...got.flatMap((g, j) => take(j + 1, g!))];
    }
  }
  return [cols, gen()];
}

// ---------------------------------------------------------------------- ASEC replicate weights
/** [(data url, SAS layout url)] of the year's replicate weight files, from the folder listing: the main file first,
 * then variants (2020: ..._2020BASE, weights controlled to the 2020 Census). */
export async function asecRwCandidates(client: Client, year: number): Promise<[string, string][]> {
  const base = ASEC_RW_DIR(year);
  const text = (await censusGet(client, base)).text();
  const hrefs = [...text.matchAll(/href="([^"?/][^"]*)"/g)].map((m) => m[1]);
  const re = new RegExp(`^CPS_ASEC_ASCII_REPWGT_${year}(_\\w+)?\\.(dat\\.gz|gz)$`, "i");
  const dats = hrefs.filter((h) => re.test(h));
  const out: [string, string][] = [];
  const sorted = [...dats].sort((a, b) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0));
  for (const d of sorted) {
    const stem = d.replace(/(\.dat)?\.gz$/i, "");
    const sas = hrefs.filter((h) => h.toLowerCase() === `${stem.toLowerCase()}.sas`);
    if (sas.length) out.push([base + d, base + sas[0]]);
  }
  if (!out.length) {
    throw new DataError(`census: no ASEC replicate weight file (CPS_ASEC_ASCII_REPWGT_${year}) in ${base}`, "not_found");
  }
  return out;
}

export type RwIndex = { layout: Record<string, [number, number, number]>; offsets: Map<string, number>; records: number };

const latin = (b: Buffer, s: number, e: number) => b.toString("latin1", s, Math.min(e, b.length));

/** The layout and offsets {(h_seq, pppos): start of line} of a replicate weight file (fixed width, layout and weight
 * totals from the year's SAS file). Gate: the sums of PWWGT0, PWWGT1 and PWWGT160 over every record must equal the
 * totals the SAS file states, so a misread layout or a cut download never reaches an estimate. */
export function asecRwIndex(blob: Buffer, sas: string): RwIndex {
  const lay: Record<string, [number, number, number]> = {};
  for (const m of sas.matchAll(/@\s*(\d+)\s+(\w+)\s+(\$char|f)?(\d+)\.(\d*)/gi)) {
    lay[m[2].toUpperCase()] = [Number(m[1]) - 1, Number(m[4]), Number(m[5] || 0)];
  }
  const totals: Record<string, number> = {};
  for (const m of sas.matchAll(/(PWWGT\d+)\s*=\s*(-?[\d.]+)/gi)) totals[m[1].toUpperCase()] = Number(m[2]);
  const need = ["PWWGT0", ...ASEC_REPS, "H_SEQ", "PPPOS"];
  if (need.some((k) => !(k in lay)) || !["PWWGT0", "PWWGT1", "PWWGT160"].every((k) => k in totals)) {
    throw new DataError("census: the ASEC replicate weight SAS file has no layout or totals for PWWGT0-160, H_SEQ, " +
      "PPPOS: the file format changed; use the ipums pack for ASEC standard errors", "api");
  }
  const check = ["PWWGT0", "PWWGT1", "PWWGT160"];
  const sums: Record<string, number> = { PWWGT0: 0.0, PWWGT1: 0.0, PWWGT160: 0.0 };
  const [hs, hw] = lay.H_SEQ, [ps, pw] = lay.PPPOS;
  const offsets = new Map<string, number>();
  let pos = 0;
  const n = blob.length;
  while (pos < n) {
    let end = blob.indexOf(0x0a, pos);
    end = end < 0 ? n : end;
    let lend = end;
    while (lend > pos && blob[lend - 1] === 0x0d) lend--;
    const line = latin(blob, pos, lend);
    if (line.trim()) {
      for (const k of check) {
        const [st, w, dec] = lay[k];
        sums[k] += pyInt(line.slice(st, st + w)) / 10 ** dec;
      }
      offsets.set(`${pyInt(line.slice(hs, hs + hw))}|${pyInt(line.slice(ps, ps + pw))}`, pos);
    }
    pos = end + 1;
  }
  const bad = check.filter((k) => Math.abs(sums[k] - totals[k]) > 0.05);
  if (bad.length) {
    const diff = "{" + bad.map((k) => `'${k}': ${pyRound2(sums[k] - totals[k])}`).join(", ") + "}";
    throw new DataError(`census: the ASEC replicate weight file does not add up to its stated totals (difference ` +
      `${diff}): a cut download or a changed layout; fetch again`, "api");
  }
  return { layout: lay, offsets, records: offsets.size };
}

function pyRound2(x: number): string {
  const r = Math.round(x * 100) / 100;
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

/** (PWWGT0, [PWWGT1..160 as text with 4 decimals]) of one person, or null when the person is not in the file. */
export function asecRwValues(blob: Buffer, idx: RwIndex, key: [number, number]): [number, string[]] | null {
  const pos = idx.offsets.get(`${key[0]}|${key[1]}`);
  if (pos === undefined) return null;
  const val = (k: string) => {
    const [st, w, dec] = idx.layout[k];
    return pyInt(latin(blob, pos + st, pos + st + w)) / 10 ** dec;
  };
  return [val("PWWGT0"), ASEC_REPS.map((k) => val(k).toFixed(4))];
}

/** Copy the streamed CSV `src` to `dst` with PWWGT1-160 appended. Gate: every person must be in the file and its
 * full-sample weight PWWGT0 must equal the API's MARSUPWT; otherwise DataError (the caller tries the next candidate
 * file). Returns [columns, rows, first 500 rows]. */
export function asecJoin(src: string, dst: string, cols: string[], blob: Buffer, idx: RwIndex): [string[], number, Row[]] {
  const iH = cols.indexOf("PH_SEQ"), iP = cols.indexOf("PPPOS"), iW = cols.indexOf("MARSUPWT");
  const outCols = [...cols, ...ASEC_REPS];
  let n = 0, missing = 0, offw = 0;
  const sample: Row[] = [];
  const grid: string[][] = parse(fs.readFileSync(src, "utf8"), { relax_column_count: true });
  const fd = fs.openSync(dst, "w");
  try {
    let buf = csvLine(outCols);
    for (const row0 of grid.slice(1)) {
      const got = asecRwValues(blob, idx, [pyInt(row0[iH]), pyInt(row0[iP])]);
      if (got === null) {
        missing++;
        continue;
      }
      const w = row0[iW] ? pyFloat(row0[iW]) : 0;
      if (w === null) throw new Error(`could not convert string to float: ${pyRepr(row0[iW])}`);
      if (Math.abs(got[0] - w) > 0.01) offw++;
      const row = [...row0, ...got[1]];
      buf += csvLine(row);
      if (buf.length > 1 << 20) {
        fs.writeSync(fd, buf);
        buf = "";
      }
      n++;
      if (sample.length < 500) sample.push(Object.fromEntries(outCols.map((c, i) => [c, row[i]])));
    }
    fs.writeSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  if (missing || offw) {
    throw new DataError(`census: ${missing} persons not in the ASEC replicate weight file and ${offw} whose PWWGT0 ` +
      "differs from MARSUPWT", "api");
  }
  return [outCols, n, sample];
}

// ---------------------------------------------------------------------- variable metadata and codebook
/** {variable: metadata} from /variables/<VAR>.json (cached 30 days); an unknown name is a spec error (strict), else
 * left out of the result. */
export async function microMeta(client: Client, pack: Pack, ds: string, vars: string[], strict = true): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  const bad: string[] = [];
  const useCache = !(process.env.DATA_ANALYST_FIXTURES || process.env.DATA_ANALYST_RECORD);
  const cache = useCache ? new Cache("census", pack.policy) : null;
  for (const v of vars) {
    const url = `${client.base}/${ds}/variables/${v}.json`;
    const hit = cache ? cache.get(url) : null;
    if (hit) {
      out[v] = parsePyJson(hit[0].toString("utf8"));
      continue;
    }
    const r = await censusGet(client, `/${ds}/variables/${v}.json`, null, true);
    if (r.status === 404 || !startsWithBrace(r.body)) {
      bad.push(v);
      continue;
    }
    out[v] = r.json();
    if (cache) cache.put(url, r.body, { dataset: ds });
  }
  if (bad.length && strict) {
    throw new DataError(`not variables of ${ds}: ${bad.join(", ")}; find names with --search "${ds}: <words>"`, "bad_request");
  }
  return out;
}

/** One row per code (variable, label, value, value_label); ranges as "min..max"; weights and keys one row. */
export function microCodebook(meta: Record<string, any>): Row[] {
  const order = (x: string): [number, number, string] => {
    const f = pyFloat(x);
    return f === null ? [1, 0.0, x] : [0, f, ""];
  };
  const cmp = (a: [number, number, string], b: [number, number, string]) =>
    a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
  const rows: Row[] = [];
  for (const [v, m] of Object.entries<any>(meta)) {
    const base = { variable: v, label: m.label ?? "", predicate_type: m.predicateType ?? "",
      suggested_weight: m["suggested-weight"] ?? "" };
    const vals = m.values || {};
    const items = Object.entries<any>(vals.item || {}).sort((a, b) => cmp(order(a[0]), order(b[0])));
    const rng: any[] = vals.range || [];
    for (const [code, lab] of items) rows.push({ ...base, value: code, value_label: lab });
    for (const r of rng) rows.push({ ...base, value: `${pyStr(r.min ?? "")}..${pyStr(r.max ?? "")}`, value_label: r.description ?? "" });
    if (!items.length && !rng.length) rows.push({ ...base, value: "", value_label: "" });
  }
  return rows;
}

// ---------------------------------------------------------------------- fetch
function tmpFile(prefix: string): string {
  const p = path.join(os.tmpdir(), `${prefix}${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(p, "");
  return p;
}

/** Join PWWGT1-160 to the streamed ASEC CSV; tries each candidate file of the year until one passes the gates. */
async function withAsecReps(client: Client, ds: string, tmp: string, cols: string[], nonmiss: Record<string, number>):
  Promise<[string, string[], number, Row[], Record<string, number>, string]> {
  const year = datasetYear(ds)!;
  const errors: string[] = [];
  for (const [dat, sasUrl] of await asecRwCandidates(client, year)) {
    const old = client.timeout;
    client.timeout = Math.max(old, 300); // about 70 MB
    let blob: Buffer, sas: string;
    try {
      blob = zlib.gunzipSync((await censusGet(client, dat)).body);
      sas = (await censusGet(client, sasUrl)).text();
    } finally {
      client.timeout = old;
    }
    let idx: RwIndex, out: string, res: [string[], number, Row[]];
    try {
      idx = asecRwIndex(blob, sas);
      out = tmpFile("census_asec_rw_");
      try {
        res = asecJoin(tmp, out, cols, blob, idx);
      } catch (e) {
        fs.rmSync(out, { force: true });
        throw e;
      }
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      errors.push(`${dat.split("/").pop()}: ${e.message}`);
      continue;
    }
    fs.rmSync(tmp, { force: true });
    const [outCols, m, sample] = res;
    const nm = { ...nonmiss, ...Object.fromEntries(ASEC_REPS.map((c) => [c, m])) };
    return [out, outCols, m, sample, nm,
      `replicate weights from ${dat} (${idx.records.toLocaleString("en-US")} records; their sums match the totals in ` +
      `${sasUrl.split("/").pop()}, and every person's PWWGT0 equals MARSUPWT)`];
  }
  fs.rmSync(tmp, { force: true });
  throw new DataError(`census: no ASEC replicate weight file of ${year} matched the API's records: ` + errors.join("; ") +
    ". Use the ipums pack (REPWTP) for ASEC standard errors", "api");
}

/** {name: FileTable, name_codebook: rows}, notes. Streams each geography's joined rows to a temp CSV. */
export async function fetchMicro(client: Client, pack: Pack, r: SpecRequest, ds: string, params: Record<string, any>):
  Promise<[Record<string, Row[] | FileTable>, string[]]> {
  const name = r.name;
  const kind = microKind(ds)!;
  const asked = ensureList(params.get);
  const meta = await microMeta(client, pack, ds, asked.filter((v) => v === v.toUpperCase()));
  let plan: Plan;
  try {
    plan = microPlan(ds, params, meta);
  } catch (e) {
    if (e instanceof ValueErr) throw new DataError(`request ${pyRepr(name)}: ${e.message}`, "bad_request");
    throw e;
  }
  const reps = new Set(replicateSets(kind, params.replicates));
  const extra = plan.cols.filter((c) => !(c in meta) && !reps.has(c));
  const found = await microMeta(client, pack, ds, extra, false);
  Object.assign(meta, found);
  const missing = new Set(extra.filter((c) => !(c in found)));
  if (missing.size) { // an older file without HRHHID2 or PWCMPWGT: plan again without them
    plan = microPlan(ds, params, meta, missing);
    if (plan.chunks.length > 1 && !plan.join.length) {
      throw new DataError(`request ${pyRepr(name)}: ${ds} has none of the join keys, so its columns cannot be split ` +
        `across calls: ask for at most ${MAX_VARS} variables`, "bad_request");
    }
  }
  let tmp = tmpFile(`census_${name}_`);
  let cols: string[] | null = null;
  let n = 0, emptyGeos = 0;
  let nonmiss: Record<string, number> = {};
  let sample: Row[] = [];
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      for (const g of plan.geos) {
        let parts: [string[], Iterable<any[]>][] | null = [];
        for (const chunk of plan.chunks) {
          const resp = await censusGet(client, `/${ds}`, { get: chunk.join(","), ...plan.preds, ...g });
          if (resp.status === 204 || !resp.body.toString("latin1").trim()) {
            parts = null;
            break;
          }
          const it = iterRows(resp.body);
          const head = it.next();
          parts.push([head.done ? [] : head.value, { [Symbol.iterator]: () => it }]);
        }
        if (!parts || !parts.length) {
          emptyGeos++;
          continue;
        }
        const [gcols, rows] = mergeChunks(parts, plan.join);
        if (cols === null) { // asked order: variables, keys, weights, replicates, then geography
          cols = [...plan.cols.filter((c) => gcols.includes(c)), ...gcols.filter((c) => !plan.cols.includes(c))];
          fs.writeSync(fd, csvLine(cols));
          nonmiss = Object.fromEntries(cols.map((c) => [c, 0]));
        }
        const order = cols.map((c) => (gcols.includes(c) ? gcols.indexOf(c) : null));
        let buf = "";
        for (const row of rows) {
          const out = order.map((i) => (i !== null ? row[i] : ""));
          buf += csvLine(out);
          if (buf.length > 1 << 20) {
            fs.writeSync(fd, buf);
            buf = "";
          }
          n++;
          cols.forEach((c, i) => {
            if (out[i] !== "") nonmiss[c]++;
          });
          if (sample.length < 500) sample.push(Object.fromEntries(cols.map((c, i) => [c, out[i]])));
        }
        fs.writeSync(fd, buf);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  const notes = plan.notes.map((x) => `${name}: ${x}`);
  if (plan.asec_reps && cols !== null) {
    let rwNote: string;
    [tmp, cols, n, sample, nonmiss, rwNote] = await withAsecReps(client, ds, tmp, cols, nonmiss);
    notes.push(`${name}: ${rwNote}`);
  }
  if (emptyGeos) notes.push(`${name}: ${emptyGeos} of ${plan.geos.length} geographies had no matching persons`);
  if (cols === null) {
    fs.rmSync(tmp, { force: true });
    return [{ [name]: [], [`${name}_codebook`]: microCodebook(meta) }, notes];
  }
  notes.push(`${name}: codebook (every code's label, from the API's variable metadata) in ${name}_codebook.csv`);
  return [{ [name]: new FileTable(tmp, cols, n, sample, nonmiss), [`${name}_codebook`]: microCodebook(meta) }, notes];
}
