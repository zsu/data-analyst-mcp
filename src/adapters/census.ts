/**
 * Census Data API adapter (standard pack, own fetch because dataset paths contain slashes).
 *
 * What it adds to the generic REST flow:
 * - datasets: "latest/acs/acs5", "latest/acs/acs1/subject", "latest/pep/charv" (or the catalog aliases acs5,
 *   acs1, ...) resolve to the newest vintage the API actually serves, by asking the dataset discovery document
 *   /data/<year>/<path>.json from last year downward (no hard-coded year).
 * - geography: state (name, USPS or FIPS), county and place names resolve to codes with "Did you mean"
 *   suggestions. Names come from the same dataset's NAME list when a key is set (right vintage); otherwise, or when
 *   that call fails, from the Census 2020 reference files on www2.census.gov (noted in the output; Connecticut's
 *   planning regions used from ACS 2022 on are not in them).
 * - margins of error: for ACS every ...E estimate gets its ...M margin of error (...PE gets ...PM) as its own
 *   column. They are never dropped (moe: false is refused for ACS).
 * - normalize: Census special values (-666666666, -999999999, -888888888, -222222222, -333333333, -555555555;
 *   anything <= -1,000,000) become empty cells with a `<column>_flag` column that says what the code means; null
 *   cells get a flag too; top-coded medians (home value 2000001, gross rent 2001/3501/4001) keep their value and
 *   get a flag. Values are otherwise exactly as published (text).
 * - errors: since 2026-05-12 the API requires a key and redirects keyless data queries to missing_key.html (bad keys
 *   to invalid_key.html); these become key errors. A query that matches no geography answers HTTP 204: "no rows".
 * - microdata (ACS PUMS, CPS): see _census_micro.ts.
 * - search: variables.json of a dataset (default: latest ACS 5-year detailed tables), cached on disk for 30 days
 *   (metadata only; data queries are never cached), plus the catalog of common variables.
 *
 * Differences forced by this server's hook signatures (checkSpec and manualItems are synchronous here):
 * - the county/place name check of the Python check_spec needs the network, so it runs at the start of fetch
 *   (same messages, a "spec" error before any data request);
 * - manualItems resolves "latest" and geography names from what this process has already looked up (a fetch or
 *   manualItemsAsync); otherwise it falls back as the Python version did offline (release-calendar year; FIPS
 *   codes needed for names). manualItemsAsync is the full version.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse } from "csv-parse/sync";
import { Cache } from "../core/cache.js";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { parsePyJson, pyFloatRepr, pyQuote, pyStr } from "../core/py.js";
import { asecRwIndex, asecRwValues, ASEC_REPS, ASEC_RW_DIR, datasetYear, fetchMicro, MAX_VARS, mergeChunks,
  microKind, microPlan } from "./_census_micro.js";
import { censusGet, ensureList, getCloseMatches, given, pyFloat, pyInt, pyRepr, respJson, splitlines, STATES,
  startsWithBrace, stateOf as rawState, title, truthy, ValueErr } from "./_census_util.js";

const WWW2 = "https://www2.census.gov/geo/docs/reference/codes2020";
const SENTINELS = new Map<number, string>([
  [-666666666, "-666666666: estimate could not be computed (too few sample observations, or a median in an open-ended interval)"],
  [-999999999, "-999999999 (N): cannot be displayed, too few sample cases in this area"],
  [-888888888, "-888888888 (X): not applicable or not available"],
  [-222222222, "-222222222 (**): margin of error could not be computed, too few sample observations"],
  [-333333333, "-333333333 (***): margin of error could not be computed, median in an open-ended interval"],
  [-555555555, "-555555555 (*****): estimate is controlled; no sampling error, treat the margin of error as zero"],
]);
const TOPCODES: Record<string, Record<string, string>> = {
  B25077_001E: { "2000001": "top-coded: $2,000,000 or more" },
  B25064_001E: { "2001": "top-coded: $2,000 or more", "3501": "top-coded: $3,500 or more", "4001": "top-coded: $4,000 or more" },
};
// SIPP microdata: one row per person-month; these come with every request (keys to link months, the weight)
const SIPP_KEEP = ["SSUID", "PNUM", "MONTHCODE", "WPFINWGT"];
const MEMO_MS = 24 * 3600 * 1000;
/** newest vintage of each "latest/<rest>" (the Python _LATEST), for a day */
const LATEST = new Map<string, [number, number]>();
/** geography name lists already fetched in this process: "<ds>|<level>|<state fips>" -> [items, note] */
const GEO_MEMO = new Map<string, [GeoItem[], string, number]>();

type GeoItem = { name: string; code: string; incorporated: boolean };
type Lists = (level: string, fips: string) => [GeoItem[], string] | undefined;

/** A geography name list is needed and not at hand (the async callers fetch it and retry). */
class NeedList extends Error {
  constructor(public level: string, public fips: string) {
    super(`the ${level} names of state ${fips} need the Census name list (not fetched here)`);
  }
}

// ---------------------------------------------------------------------- helpers
function stateOf(x: unknown, as: "usps" | "fips" | "name" = "fips"): string {
  try {
    return rawState(x, as);
  } catch (e) {
    if (!(e instanceof ValueErr)) throw e;
    const close = getCloseMatches(title(pyStr(x).trim()), STATES.map(([, , n]) => n), 3, 0.6);
    throw new ValueErr(`${e.message}.` + (close.length ? ` Did you mean: ${close.join("; ")}?` : ""));
  }
}

function clientOf(pack: Pack): Client {
  return gr.clientFor(pack);
}

function checkError(_status: number, body: Buffer): string | null {
  const head = body.subarray(0, 600).toString("latin1").trimStart().toLowerCase();
  if (head.startsWith("<")) {
    if (head.includes("missing key")) {
      return "the Census Data API refused a request without a key (redirect to missing_key.html; a key is " +
        "required for every data query since 2026-05-12): set CENSUS_API_KEY";
    }
    if (head.includes("invalid key")) return "the Census Data API rejected the key (redirect to invalid_key.html): check CENSUS_API_KEY";
  }
  return null;
}

export function isAcs(ds: string): boolean {
  return `/${ds.replace(/^\/+|\/+$/g, "")}/`.includes("/acs/");
}

/** SIPP microdata (2024/sipp, latest/sipp): rows are person-months, no geography but the state recode. */
export function isSipp(ds: unknown): boolean {
  return /(^|\/)sipp$/.test(pyStr(ds).trim().replace(/^\/+|\/+$/g, ""));
}

function withSippKeys(vars: string[]): string[] {
  return [...vars, ...SIPP_KEEP.filter((v) => !vars.includes(v))];
}

export function moeOf(v: string): string | null {
  if (/^[A-Z]{1,3}\d{2,6}[A-Z]{0,2}_\d{3,4}PE$/.test(v)) return v.slice(0, -2) + "PM";
  if (/^[A-Z]{1,3}\d{2,6}[A-Z]{0,2}(_C\d{2})?_\d{3,4}[A-Z]?E$/.test(v)) return v.slice(0, -1) + "M";
  return null;
}

export function withMoe(vars: string[]): string[] {
  const out: string[] = [];
  for (const v of vars) {
    if (!out.includes(v)) out.push(v);
    const m = moeOf(v);
    if (m && !vars.includes(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

const stripSlashes = (s: string) => s.replace(/^\/+|\/+$/g, "");

// ---------------------------------------------------------------------- datasets
/** Release-calendar guess (only for offline manual links): ACS 1-year in September, 5-year in December. */
export function guessYear(rest: string, today = new Date()): number {
  const y = today.getFullYear(), m = today.getMonth() + 1;
  if (rest.includes("acs5")) return m === 12 ? y - 1 : y - 2;
  if (rest.includes("acs1") || rest.includes("acsse")) return m >= 10 ? y - 1 : y - 2;
  return y - 2;
}

async function latestYear(client: Client, rest: string): Promise<number> {
  const memo = LATEST.get(rest);
  if (memo && Date.now() - memo[1] < MEMO_MS) return memo[0];
  const thisYear = new Date().getFullYear();
  const first = rest.startsWith("cps/") ? thisYear : thisYear - 1; // a CPS file carries its survey year (ASEC: March)
  for (let y = first; y > thisYear - 8; y--) {
    let r;
    try {
      r = await censusGet(client, `/${y}/${rest}.json`, null, true);
    } catch (e) {
      if (e instanceof DataError && e.kind === "fixture_missing") continue; // offline tests: years not recorded count as absent
      throw e;
    }
    if (r.status === 200 && startsWithBrace(r.body)) {
      LATEST.set(rest, [y, Date.now()]);
      return y;
    }
  }
  throw new DataError(`census: no vintage of ${rest} found on the API for ${thisYear - 7}-${thisYear - 1}`, "not_found");
}

async function resolveDataset(client: Client, ds0: unknown): Promise<[string, string]> {
  const ds = stripSlashes(pyStr(ds0).trim());
  if (ds.startsWith("latest/")) {
    const rest = ds.slice("latest/".length);
    const y = await latestYear(client, rest);
    return [`${y}/${rest}`, `'${ds}' resolved to ${y}/${rest} (newest vintage on the API)`];
  }
  return [ds, ""];
}

/** resolveDataset from what this process already knows; null when "latest" was not looked up yet. */
function resolveDatasetKnown(ds0: unknown): string | null {
  const ds = stripSlashes(pyStr(ds0).trim());
  if (!ds.startsWith("latest/")) return ds;
  const memo = LATEST.get(ds.slice(7));
  return memo && Date.now() - memo[1] < MEMO_MS ? `${memo[0]}/${ds.slice(7)}` : null;
}

// ---------------------------------------------------------------------- geography names
const SUFFIX = /\s+(city and borough|census area|municipality|borough|parish|county|city|town|village|cdp|planning region|municipio)$/;

function base(s: string): string {
  let t = s.toLowerCase().split(",")[0].trim();
  let prev: string | null = null;
  while (prev !== t) {
    prev = t;
    t = t.replace(SUFFIX, "").trim();
  }
  return t;
}

const rsplitFirst = (s: string) => {
  const i = s.lastIndexOf(",");
  return i < 0 ? s : s.slice(0, i);
};

/** [{name, code, incorporated}], note. API NAME list of the dataset when a key is set, else the 2020 files. */
async function geoList(client: Client, ds: string, level: string, stFips: string): Promise<[GeoItem[], string]> {
  let why = "no CENSUS_API_KEY";
  let res: [GeoItem[], string] | null = null;
  if (client.key) {
    try {
      const data = respJson(await censusGet(client, `/${ds}`, { get: "NAME", for: `${level}:*`, in: `state:${stFips}` }));
      if (truthy(data)) {
        const [head, ...rows] = data as any[][];
        const i = head.indexOf("NAME"), j = head.indexOf(level);
        res = [rows.map((r) => ({ name: rsplitFirst(r[i]).trim(), code: r[j],
          incorporated: / (city|town|village|borough|municipality)$/.test(rsplitFirst(r[i])) })), ""];
      }
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      why = `the API name list failed (${e.kind})`;
    }
  }
  if (!res) {
    const usps = stateOf(stFips, "usps").toLowerCase();
    const kind = level === "county" ? "cou" : "place";
    const url = `${WWW2}/${kind}/st${stFips}_${usps}_${kind}2020.txt`;
    const text = (await censusGet(client, url)).text();
    const out: GeoItem[] = [];
    const lines = splitlines(text).filter((ln) => ln.trim());
    const head = lines[0].split("|");
    for (const ln of lines.slice(1)) {
      const vals = ln.split("|");
      const f: Record<string, string> = {};
      head.forEach((h, k) => {
        if (k < vals.length) f[h] = vals[k];
      });
      if (level === "county") out.push({ name: f.COUNTYNAME ?? "", code: f.COUNTYFP ?? "", incorporated: false });
      else out.push({ name: f.PLACENAME ?? "", code: f.PLACEFP ?? "", incorporated: (f.TYPE ?? "").toUpperCase().startsWith("INCORPORATED") });
    }
    res = [out, `${level} names matched against the Census 2020 reference file (${why}); codes that changed after ` +
      "2020 (Connecticut planning regions from ACS 2022 on) are not in it"];
  }
  GEO_MEMO.set(`${ds}|${level}|${stFips}`, [res[0], res[1], Date.now()]);
  return res;
}

function knownLists(ds: string): Lists {
  return (level, fips) => {
    const m = GEO_MEMO.get(`${ds}|${level}|${fips}`);
    return m && Date.now() - m[2] < MEMO_MS ? [m[0], m[1]] : undefined;
  };
}

/** [code, matched name, note] for a county or place given by name or code. */
function resolveGeo(lists: Lists, level: string, value: unknown, stFips: string): [string, string, string] {
  const raw = pyStr(value).trim();
  const digits = level === "county" ? 3 : 5;
  if (raw === "*" || new RegExp(`^\\d{${digits}}$`).test(raw)) return [raw, raw, ""];
  if (level === "county" && /^\d{5}$/.test(raw)) {
    if (raw.slice(0, 2) !== stFips) throw new ValueErr(`county FIPS ${raw} is not in state ${stFips}`);
    return [raw.slice(2), raw, ""];
  }
  const got = lists(level, stFips);
  if (!got) throw new NeedList(level, stFips);
  const [items, note] = got;
  const stName = stateOf(stFips, "name");
  const want = raw.toLowerCase().split(",")[0].trim();
  const exact = items.filter((x) => x.name.toLowerCase() === want);
  let hits = exact.length ? exact : items.filter((x) => base(x.name) === base(raw));
  if (hits.length > 1 && level === "place") {
    const inc = hits.filter((x) => x.incorporated);
    hits = inc.length === 1 ? inc.slice(0, 1) : hits;
  }
  if (hits.length === 1) return [hits[0].code, hits[0].name, note];
  if (hits.length > 1) {
    throw new ValueErr(`${level} ${pyRepr(raw)} is ambiguous in ${stName}: ` +
      hits.slice(0, 8).map((x) => `${x.name} (${x.code})`).join("; ") + ". Give the full name or the code.");
  }
  const names = items.map((x) => x.name);
  const close = names.filter((n) => n.toLowerCase().includes(base(raw))).slice(0, 5);
  const bases = new Map<string, string>();
  for (const n of names) bases.set(base(n), n);
  for (const c of [...getCloseMatches(raw, names, 5, 0.6),
    ...getCloseMatches(base(raw), [...bases.keys()], 5, 0.6).map((b) => bases.get(b)!)]) {
    if (!close.includes(c)) close.push(c);
  }
  throw new ValueErr(`no ${level} named ${pyRepr(raw)} in ${stName}.` +
    (close.length ? ` Did you mean: ${close.slice(0, 6).join("; ")}?` : ""));
}

/** Run fn with geography lists, fetching each list it asks for (fresh for this call, as the Python version did). */
async function withLists<T>(client: Client, ds: string, fn: (lists: Lists) => T): Promise<T> {
  const local = new Map<string, [GeoItem[], string]>();
  for (let i = 0; i < 4; i++) {
    try {
      return fn((level, fips) => local.get(`${level}|${fips}`));
    } catch (e) {
      if (!(e instanceof NeedList)) throw e;
      local.set(`${e.level}|${e.fips}`, await geoList(client, ds, e.level, e.fips));
    }
  }
  return fn((level, fips) => local.get(`${level}|${fips}`));
}

const joinList = (v: unknown) => (Array.isArray(v) ? v.map(pyStr).join(",") : v);

/** API query parameters from the spec's params (convenience names resolved). Throws ValueErr (or NeedList). */
function buildQuery(lists: Lists, ds: string, params: Record<string, any>): [Record<string, unknown>, string[]] {
  const p: Record<string, any> = { ...params };
  const notes: string[] = [];
  const pop = (k: string, d: unknown = undefined) => {
    const v = k in p ? p[k] : d;
    delete p[k];
    return v;
  };
  let vars = ensureList(pop("get", ""));
  const moe = pop("moe", true);
  if (isAcs(ds)) {
    if (moe === false || pyStr(moe).toLowerCase() === "false") throw new ValueErr("ACS margins of error are never dropped: remove moe: false");
    const full = withMoe(vars);
    const added = full.filter((v) => !vars.includes(v));
    if (added.length) notes.push(`margins of error added: ${added.join(", ")}`);
    vars = full;
  }
  const [st, co, pl, z] = ["state", "county", "place", "zcta"].map((k) => pop(k, null)) as any[];
  if (isSipp(ds)) {
    const full = withSippKeys(vars);
    const added = full.filter((v) => !vars.includes(v));
    if (added.length) {
      notes.push(`SIPP person-month keys and weight added: ${added.join(", ")} (weight every estimate by WPFINWGT)`);
    }
    const q: Record<string, unknown> = { get: full.join(",") };
    if ([co, pl, z].some(given) || truthy(p.for) || truthy(p.in)) {
      throw new ValueErr("SIPP has no geography below the state (the API has none at all): use state, " +
        "which filters on TST_INTV, the state of the interview address");
    }
    if (given(st) && st !== "*") {
      q.TST_INTV = stateOf(st, "fips");
      notes.push(`state ${pyRepr(st)} -> TST_INTV=${q.TST_INTV} (state of the interview address; SIPP is ` +
        "designed for national estimates, so state figures from small samples are unreliable)");
    }
    for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined && v !== "") q[k] = joinList(v);
    if (!("MONTHCODE" in q)) {
      notes.push("no MONTHCODE filter: each person appears once per reference month (up to 12 rows); " +
        "filter MONTHCODE (12 = December) or average over months");
    }
    return [q, notes];
  }
  const q: Record<string, unknown> = { get: vars.join(",") };
  let fips: string | null = null;
  if (given(st) && pyStr(st).trim() !== "*") fips = stateOf(st, "fips");
  if (given(z)) {
    if (!/^(\d{5}|\*)$/.test(pyStr(z).trim())) throw new ValueErr(`zcta must be a 5-digit ZIP code area or *, not ${pyRepr(z)}`);
    q.for = `zip code tabulation area:${pyStr(z).trim()}`;
  } else if (given(pl)) {
    if (!fips) throw new ValueErr("place needs a state");
    const [code, name, note] = resolveGeo(lists, "place", pl, fips);
    [q.for, q.in] = [`place:${code}`, `state:${fips}`];
    notes.push(`place ${pyRepr(pl)} -> ${name} (${fips}${code})`, ...(note ? [note] : []));
  } else if (given(co)) {
    if (!fips) throw new ValueErr("county needs a state");
    const [code, name, note] = resolveGeo(lists, "county", co, fips);
    if (truthy(p.for)) [q.for, q.in] = [pop("for"), `state:${fips} county:${code}`]; // e.g. tract:* within the county
    else [q.for, q.in] = [`county:${code}`, `state:${fips}`];
    if (code !== "*") notes.push(`county ${pyRepr(co)} -> ${name} (${fips}${code})`, ...(note ? [note] : []));
  } else if (given(st)) {
    if (truthy(p.for)) {
      q.for = pop("for");
      q.in = pop("in", null) || `state:${fips}`;
    } else q.for = `state:${fips || "*"}`;
  }
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined || v === "") continue;
    q[k] = joinList(v);
  }
  return [q, notes];
}

// ---------------------------------------------------------------------- spec checks
function datasetOf(pack: Pack, r: SpecRequest): string {
  const p = r.params || {};
  const ds = pyStr(p.dataset || r.dataset || "");
  const cat = pack.endpoints?.catalog || {};
  return ds in cat ? cat[ds].id : ds;
}

function checkSpec(spec: Spec, pack: Pack): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    if ((r.endpoint || "query") !== "query") continue;
    const name = pyRepr(r.name ?? null);
    const p: Record<string, any> = r.params || {};
    const ds = datasetOf(pack, r);
    const vars = ensureList(p.get);
    if (microKind(ds)) {
      try {
        microPlan(ds, p);
      } catch (e) {
        if (!(e instanceof ValueErr)) throw e;
        probs.push(`request ${name}: ${e.message}`);
      }
      continue;
    }
    if (!vars.length) probs.push(`request ${name}: 'get' needs at least one variable (NAME,B19013_001E)`);
    const n = (isAcs(ds) ? withMoe(vars) : isSipp(ds) ? withSippKeys(vars) : vars).length;
    if (n > MAX_VARS) {
      probs.push(`request ${name}: ${n} variables (margins of error or SIPP keys included); the API takes ` +
        `at most ${MAX_VARS} per call: split the request`);
    }
    if (isAcs(ds) && pyStr(p.moe ?? true).toLowerCase() === "false") {
      probs.push(`request ${name}: ACS margins of error are never dropped: remove moe: false`);
    }
    if (isSipp(ds)) {
      if (["county", "place", "zcta", "for", "in", "ucgid"].some((k) => given(p[k]))) {
        probs.push(`request ${name}: SIPP has no geography below the state: use state (it filters ` +
          "TST_INTV) or no geography for national estimates");
      }
      continue;
    }
    if (stripSlashes(ds).startsWith("timeseries/intltrade")) {
      if (!truthy(p.time)) {
        probs.push(`request ${name}: international trade needs a time (2026-08, or 'from 2025-01 to ` +
          "2025-12'); it has no for= geography (filter CTY_CODE, COMM_LVL, I_COMMODITY)");
      }
      continue;
    }
    if (stripSlashes(ds).startsWith("timeseries/") && !truthy(p.time) && !truthy(p.YEAR)) {
      probs.push(`request ${name}: a time series needs time (2026, 2026-Q2, 2026-08, or 'from 2024 to ` +
        "2026'); without it the API returns every period");
    }
    if (!["for", "ucgid", "state", "zcta"].some((k) => given(p[k]))) {
      probs.push(`request ${name}: give a geography: for (state:*, county:*), state, or zcta`);
    }
    if ((truthy(p.county) || truthy(p.place)) && !truthy(p.state)) probs.push(`request ${name}: county and place need a state`);
    const geo = `${pyStr(p.for ?? "")} ${pyStr(p.zcta ?? "")}`.toLowerCase();
    if ((ds.includes("acs1") && ["tract", "block group", "zip code"].some((g) => geo.includes(g))) || (ds.includes("acs1") && truthy(p.zcta))) {
      probs.push(`request ${name}: ACS 1-year has no tracts, block groups or ZCTAs (areas of 65,000+ ` +
        "only): use the 5-year dataset (acs5)");
    }
    if (given(p.state) && p.state !== "*") {
      try {
        stateOf(p.state, "fips");
      } catch (e) {
        if (!(e instanceof ValueErr)) throw e;
        probs.push(`request ${name}: ${e.message}`);
      }
      // county and place names: geoProblems, at the start of fetch (they need the name lists)
    }
  }
  return probs;
}

/** The county/place name part of the Python check_spec (it needs the Census name lists). */
async function geoProblems(spec: Spec, pack: Pack, client: Client): Promise<string[]> {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    if ((r.endpoint || "query") !== "query") continue;
    const p: Record<string, any> = r.params || {};
    const ds = datasetOf(pack, r);
    if (microKind(ds) || isSipp(ds) || stripSlashes(ds).startsWith("timeseries/intltrade")) continue;
    if (!given(p.state) || p.state === "*") continue;
    let fips: string;
    try {
      fips = stateOf(p.state, "fips");
    } catch {
      continue; // checkSpec reported it
    }
    for (const level of ["county", "place"]) {
      if (!given(p[level])) continue;
      const yearDs = !ds.startsWith("latest/") ? ds : `${guessYear(ds)}/${ds.slice(7)}`;
      try {
        await withLists(client, yearDs, (lists) => resolveGeo(lists, level, p[level], fips));
      } catch (e) {
        if (e instanceof ValueErr) probs.push(`request ${pyRepr(r.name ?? null)}: ${e.message}`);
        else if (!(e instanceof DataError)) throw e; // unreachable here: the fetch resolves it later
      }
    }
  }
  return probs;
}

// ---------------------------------------------------------------------- normalize
function isVar(col: string): boolean {
  return col === col.toUpperCase() && /\d/.test(col) && col !== "NAME" && col !== "GEO_ID";
}

export function normalize(_req: SpecRequest | Record<string, unknown>, _ep: any, rows: Row[]): Row[] {
  if (!rows.length) return rows;
  const cols = Object.keys(rows[0]).filter((c) => isVar(c) && !c.endsWith("EA") && !c.endsWith("MA") && !c.endsWith("_flag"));
  const flagged = new Set<string>();
  for (const r of rows) {
    for (const c of cols) {
      let v = r[c];
      let flag = "";
      if (v === null || v === undefined || v === "") {
        flag = "null: no data for this geography";
        v = "";
      } else {
        const x = pyFloat(pyStr(v));
        if (x !== null && x <= -1_000_000) {
          const i = Math.trunc(x);
          flag = SENTINELS.get(i) ?? `${i}: Census special value (not a number)`;
          v = "";
        } else if (pyStr(v) in (TOPCODES[c] || {})) flag = TOPCODES[c][pyStr(v)];
      }
      r[c] = v;
      if (flag) {
        r[`${c}_flag`] = flag;
        flagged.add(c);
      }
    }
  }
  if (!flagged.size) return rows;
  return rows.map((r) => {
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (k.endsWith("_flag") && flagged.has(k.slice(0, -5))) continue;
      o[k] = v;
      if (flagged.has(k)) o[`${k}_flag`] = r[`${k}_flag`] ?? "";
    }
    return o;
  });
}

// ---------------------------------------------------------------------- fetch
function table(data: any): Row[] {
  if (!truthy(data)) return [];
  const [head, ...rows] = data as any[][];
  return rows.map((r) => {
    const o: Row = {};
    const n = Math.min(head.length, r.length);
    for (let i = 0; i < n; i++) o[head[i]] = r[i];
    return o;
  });
}

const CLEAN = { missing: [""] };
const CLEAN_FLAT = { missing: [""], flatten: false };

async function fetchOne(client: Client, pack: Pack, r: SpecRequest): Promise<[Row[] | Tables, string[]]> {
  const [ep, params, probs] = gr.resolve(pack, r);
  if (probs.length) throw new DataError(probs.join("; "), "bad_request");
  const kind = r.endpoint || "query";
  const dsIn = params.dataset;
  delete params.dataset;
  const [ds, note] = await resolveDataset(client, dsIn);
  const notes = note ? [`${r.name}: ${note}`] : [];
  if (kind === "group_variables") {
    const data = respJson(await censusGet(client, `/${ds}/groups/${pyStr(params.group)}.json`)) || {};
    const vars: Record<string, any> = data.variables || {};
    const rows = Object.keys(vars).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => ({ variable: k, ...gr.flatten(vars[k]) }));
    return [gr.clean(rows, CLEAN), notes];
  }
  if (kind === "groups") {
    const data = respJson(await censusGet(client, `/${ds}/groups.json`)) || {};
    return [gr.clean(data.groups || [], CLEAN), notes];
  }
  if (microKind(ds)) {
    const [tables, mnotes] = await fetchMicro(client, pack, r, ds, params);
    return [tables, [...notes, ...mnotes]];
  }
  let q: Record<string, unknown>, gnotes: string[];
  try {
    [q, gnotes] = await withLists(client, ds, (lists) => buildQuery(lists, ds, params));
  } catch (e) {
    if (e instanceof ValueErr) throw new DataError(`request ${pyRepr(r.name)}: ${e.message}`, "bad_request");
    throw e;
  }
  notes.push(...gnotes.map((n) => `${r.name}: ${n}`));
  const data = respJson(await censusGet(client, `/${ds}`, q));
  if (data === null) {
    throw new DataError(`request ${pyRepr(r.name)}: the Census API returned no rows (HTTP 204: no geography matched ` +
      `for=${q.for === undefined || q.for === null ? "None" : pyStr(q.for)} in=${pyStr(q.in ?? "")}); check the codes`, "bad_request");
  }
  // SIPP microdata has no geography sentinels: blanks mean "not in universe", values stay as published
  const rows = isSipp(ds) ? table(data) : normalize(r, ep, table(data));
  return [gr.clean(rows, CLEAN_FLAT), notes];
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const client = clientOf(pack);
  const probs = await geoProblems(spec, pack, client);
  if (probs.length) throw new DataError(`census: the request has problems: ${probs.join("; ")}`, "spec");
  const tables: Tables = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [got0, n] = await fetchOne(client, pack, r);
    const got: Tables = Array.isArray(got0) ? { [r.name]: got0 } : got0;
    if (!got[r.name].length && !r.allow_empty) {
      throw new DataError(`request ${pyRepr(r.name)} returned no rows: check the variables and geography` +
        (Object.keys(got).length > 1 ? " (and the filters: no person matched them)" : ""), "bad_request");
    }
    Object.assign(tables, got);
    notes.push(...n);
  }
  return [tables, notes];
}

async function ping(client: Client): Promise<{ auth_ok: boolean; kind: string; detail: string }> {
  try {
    await censusGet(client, "/2023/acs/acs5", { get: "NAME", for: "us:1" });
    return { auth_ok: true, kind: "", detail: "data query answered with the key" };
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    return { auth_ok: !["auth", "key_missing"].includes(e.kind), kind: e.kind, detail: e.message };
  }
}

// ---------------------------------------------------------------------- manual route
/** urllib.parse.urlencode(q, safe=":*,()") */
function urlencodeSafe(q: Record<string, unknown>): string {
  const qp = (s: string) => pyQuote(s, ":*,() ").replace(/ /g, "+");
  return Object.entries(q).map(([k, v]) => `${qp(k)}=${qp(pyStr(v))}`).join("&");
}

type Resolve = { dataset: (raw: string) => [string, string[]]; lists: (ds: string) => Lists };

function manualItemsWith(spec: Spec, pack: Pack, how: Resolve): any[] {
  const baseUrl = String(pack.endpoints.base_url).replace(/\/+$/, "");
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [, params0, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const params: Record<string, any> = structuredClone(params0);
    const rawDs = stripSlashes(pyStr(params.dataset));
    delete params.dataset;
    const [ds, note] = how.dataset(rawDs);
    const kind = r.endpoint || "query";
    let url: string, needs: boolean;
    if (kind === "group_variables") [url, needs] = [`${baseUrl}/${ds}/groups/${pyStr(params.group ?? null)}.json`, false];
    else if (kind === "groups") [url, needs] = [`${baseUrl}/${ds}/groups.json`, false];
    else if (microKind(ds)) {
      let plan;
      try {
        plan = microPlan(ds, params);
      } catch (e) {
        if (e instanceof ValueErr) continue; // the fetch reports it as a spec problem
        throw e;
      }
      const calls = plan.geos.flatMap((g) => plan.chunks.map((c) => [g, c] as const));
      calls.forEach(([g, chunk], i0) => {
        const i = i0 + 1;
        const q = { get: chunk.join(","), ...plan.preds, ...g };
        items.push({ name: `${r.name}#${i}`, request: r.name, url: `${baseUrl}/${ds}?` + urlencodeSafe(q) + "&key={API_KEY}",
          filename: `${r.name}_${String(i).padStart(3, "0")}.json`, also_ext: [], needs_key: true, method: "GET", body: null,
          note: [...note, ...(calls.length > 1 ? [`call ${i} of ${calls.length}; ingest joins the files on ${plan.join.join(", ")}`] : [])].join("; ") });
      });
      const y = datasetYear(ds);
      if (plan.asec_reps && y) { // Census's replicate weight file and its layout, no key
        const stem = ASEC_RW_DIR(y) + `CPS_ASEC_ASCII_REPWGT_${y}`;
        for (const [ext, fname] of [[y >= 2020 ? ".DAT.GZ" : ".dat.gz", `${r.name}_repwgt.dat.gz`], [".SAS", `${r.name}_repwgt.sas`]]) {
          items.push({ name: `${r.name}#${fname}`, request: r.name, url: stem + ext, filename: fname, also_ext: [],
            needs_key: false, method: "GET", body: null, note: "ASEC replicate weights (about 70 MB) and the layout with " +
            "their totals; ingest joins them on PH_SEQ and PPPOS" });
        }
      }
      continue;
    } else {
      let q: Record<string, unknown>;
      try {
        [q] = buildQuery(how.lists(ds), ds, params);
      } catch (e) {
        if (!(e instanceof ValueErr || e instanceof NeedList || e instanceof DataError)) throw e;
        q = Object.fromEntries(Object.entries(params).filter(([k]) => !["county", "place", "moe"].includes(k)));
        q.get = (isAcs(ds) ? withMoe(ensureList(params.get)) : ensureList(params.get)).join(",");
        note.push(`geography names could not be resolved here (${e.message}); put the FIPS codes in for/in`);
      }
      url = `${baseUrl}/${ds}?` + urlencodeSafe(q) + "&key={API_KEY}";
      needs = true;
    }
    items.push({ name: `${r.name}#1`, request: r.name, url, filename: `${r.name}.json`, also_ext: [".csv"],
      needs_key: needs, method: "GET", body: null, note: note.join("; ") });
  }
  return items;
}

const guessed = (rawDs: string): [string, string[]] => {
  if (!rawDs.startsWith("latest/")) return [rawDs, []];
  const ds = `${guessYear(rawDs)}/${rawDs.slice(7)}`;
  return [ds, [`year ${ds.slice(0, 4)} guessed from the release calendar: if the link fails, try one year earlier`]];
};

/** Download links (synchronous: "latest" and names from what this process has looked up, else the offline fallback). */
function manualItems(spec: Spec, pack: Pack): any[] {
  return manualItemsWith(spec, pack, {
    dataset: (raw) => {
      const known = resolveDatasetKnown(raw);
      return known ? [known, []] : guessed(raw);
    },
    lists: knownLists,
  });
}

/** The full manual_items of the Python adapter: resolves "latest" and geography names over the network first. */
export async function manualItemsAsync(spec: Spec, pack: Pack): Promise<any[]> {
  const client = clientOf(pack);
  const ds = new Map<string, [string, string[]]>();
  const lists = new Map<string, Map<string, [GeoItem[], string]>>();
  for (const r of spec.requests || []) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const raw = stripSlashes(pyStr(params.dataset));
    let d: [string, string[]];
    try {
      d = [(await resolveDataset(client, raw))[0], []];
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      d = guessed(raw);
    }
    ds.set(raw, d);
    if ((r.endpoint || "query") !== "query" || microKind(d[0])) continue;
    const local = lists.get(d[0]) ?? new Map<string, [GeoItem[], string]>();
    lists.set(d[0], local);
    const p = { ...params };
    delete p.dataset;
    for (let i = 0; i < 4; i++) {
      try {
        buildQuery((level, fips) => local.get(`${level}|${fips}`), d[0], p);
        break;
      } catch (e) {
        if (!(e instanceof NeedList)) break;
        try {
          local.set(`${e.level}|${e.fips}`, await geoList(client, d[0], e.level, e.fips));
        } catch (e2) {
          if (!(e2 instanceof DataError)) throw e2;
          break;
        }
      }
    }
  }
  return manualItemsWith(spec, pack, {
    dataset: (raw) => {
      const d = ds.get(raw) ?? guessed(raw);
      return [d[0], [...d[1]]];
    },
    lists: (d) => (level, fips) => lists.get(d)?.get(`${level}|${fips}`),
  });
}

// ---------------------------------------------------------------------- uploads
/** A data.census.gov "Download Table" CSV: one row per label, columns "<geography>!!<measure>". Returned long:
 * label, geography, measure, value (a number: commas, %, ± removed; empty when not one) and value_text. */
function dcgCsv(file: string): Row[] {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const rd: string[][] = parse(text, { relax_column_count: true, relax_quotes: true });
  if (!rd.length || !rd[0].slice(1).join("").includes("!!")) {
    throw new DataError(`${path.basename(file)}: not a data.census.gov table export (its columns read ` +
      '"<geography>!!Estimate"); upload that CSV or the API JSON', "bad_request");
  }
  const [head, ...rest] = rd;
  const out: Row[] = [];
  for (const row of rest) {
    const label = (row.length ? row[0] : "").replace(/\xa0/g, " ").trim();
    const n = Math.min(head.length, row.length);
    for (let i = 1; i < n; i++) {
      const col = head[i];
      const j = col.indexOf("!!");
      const [geo, measure] = j < 0 ? [col, ""] : [col.slice(0, j), col.slice(j + 2)];
      const t = String(row[i]).trim();
      const num = t.replace(/[,%±+]/g, "").trim();
      const f = num ? pyFloat(num) : null;
      let val: unknown = "";
      if (f !== null) {
        const repr = pyFloatRepr(f); // a Python float: a whole number is written "29.0"
        val = repr === String(f) ? f : repr;
      }
      out.push({ label, geography: geo.trim(), measure: measure.replace(/!!/g, " ").trim(), value: val, value_text: t });
    }
  }
  return out;
}

/** The year and product of a data.census.gov table JSON, kept on every row; a file of another product or year than
 * the spec asks is refused, so a 5-year table is never ingested as a 1-year one. */
function uploadVintage(resp: any, req: SpecRequest, file: string): Record<string, string> {
  const m = /\/data\/(\d{4})\/([\w/]+?)(?:\?|$)/.exec(pyStr(resp.dataAPIURI || ""));
  if (!m) return {};
  const [, year, product] = m;
  const want = pyStr((req.params || {}).dataset || req.dataset || "");
  const wy = /^(\d{4})\//.exec(want);
  const wp = /acs[135]/.exec(want), gp = /acs[135]/.exec(product);
  if ((wp && gp && wp[0] !== gp[0]) || (wy && wy[1] !== year)) {
    throw new DataError(`${path.basename(file)} is ${resp.objectId || product + " " + year}, but request ` +
      `${pyRepr(req.name ?? null)} asks for ${want}: upload the matching table`, "bad_request");
  }
  return { vintage: year, census_dataset: product, table_id: pyStr(resp.objectId || "") };
}

/** The uploaded ASEC rows with PWWGT1-160 from the uploaded replicate weight file (.dat.gz or .dat) and its .sas
 * layout, through the same gates as the API route. */
function uploadAsecReps(files: string[], rows: Row[]): Row[] {
  const dat = files.filter((p) => /\.(dat\.gz|gz|dat)$/i.test(p));
  const sas = files.filter((p) => p.toLowerCase().endsWith(".sas"));
  if (dat.length !== 1 || sas.length !== 1) {
    throw new DataError("replicates: true needs the year's replicate weight file (CPS_ASEC_ASCII_REPWGT_<year>" +
      ".DAT.GZ) and its .SAS layout among the uploads, one of each", "bad_request");
  }
  let blob = fs.readFileSync(dat[0]);
  if (blob[0] === 0x1f && blob[1] === 0x8b) blob = zlib.gunzipSync(blob); // gzip magic
  const idx = asecRwIndex(blob, fs.readFileSync(sas[0]).toString("latin1"));
  const out: Row[] = [];
  let bad = 0;
  for (const r of rows) {
    const got = asecRwValues(blob, idx, [pyInt(pyStr(r.PH_SEQ)), pyInt(pyStr(r.PPPOS))]);
    if (got === null || Math.abs(got[0] - (r.MARSUPWT ? pyFloat(r.MARSUPWT) ?? NaN : 0)) > 0.01) {
      bad++;
      continue;
    }
    out.push({ ...r, ...Object.fromEntries(ASEC_REPS.map((k, i) => [k, got[1][i]])) });
  }
  if (bad) {
    throw new DataError(`${bad} persons are missing from the replicate weight file or have a PWWGT0 other than their ` +
      "MARSUPWT: upload the file of the same year (2020: try the _2020BASE file)", "bad_request");
  }
  return out;
}

const readJson = (file: string) => parsePyJson(fs.readFileSync(file).toString("utf8").replace(/^\uFEFF/, ""));
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const params: Record<string, any> = req.params || {};
  const ds = datasetOf(pack, req);
  if (microKind(ds)) { // the manual links' files, <request>_001.json ...: each geography's calls joined
    let plan;
    try {
      plan = microPlan(ds, params);
    } catch (e) {
      if (e instanceof ValueErr) throw new DataError(`request ${pyRepr(req.name ?? null)}: ${e.message}`, "bad_request");
      throw e;
    }
    const js = files.filter((p) => p.toLowerCase().endsWith(".json")).sort(byCodePoint);
    const k = plan.chunks.length;
    let rows: Row[] = [];
    if (!js.length || js.length % k) {
      throw new DataError(`${js.length} JSON files for request ${pyRepr(req.name ?? null)}, but each geography takes ${k} ` +
        "calls: upload every file the instructions list", "bad_request");
    }
    for (let i = 0; i < js.length; i += k) {
      const parts: [string[], Iterable<any[]>][] = js.slice(i, i + k).map((fp) => {
        const d0 = readJson(fp);
        const data = (truthy(d0) ? d0 : [[]]) as any[][];
        return [data[0], data.slice(1)];
      });
      const [cols, it] = mergeChunks(parts, plan.join);
      for (const r of it) rows.push(Object.fromEntries(cols.map((c, j) => [c, r[j]])));
    }
    if (plan.asec_reps) rows = uploadAsecReps(files, rows);
    return rows;
  }
  let rows: Row[] = [];
  for (const p of [...files].sort(byCodePoint)) {
    if (p.toLowerCase().endsWith(".csv")) {
      rows = rows.concat(dcgCsv(p));
      continue;
    }
    const data: any = readJson(p);
    if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data.response || {}).data)) {
      // data.census.gov's own table JSON: the API layout with every column of the table; keep the asked ones
      const vintage = uploadVintage(data.response, req, p);
      const want = ensureList((req.params || {}).get);
      const keep = ["GEO_ID", "NAME", ...want.flatMap((v) => (v.endsWith("E") ? [v, v.slice(0, -1) + "M"] : [v]))];
      const t = table(data.response.data).map((r) => ({
        ...(want.length ? Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, r[k]])) : r),
        geo_fips: pyStr(r.GEO_ID ?? "").split("US").pop(), ...vintage }));
      rows = rows.concat(normalize(req, {}, t));
    } else if (Array.isArray(data)) rows = rows.concat(normalize(req, {}, table(data)));
    else if (data && typeof data === "object" && "variables" in data) {
      rows = rows.concat(Object.keys(data.variables).sort(byCodePoint).map((k) => ({ variable: k, ...gr.flatten(data.variables[k]) })));
    } else if (data && typeof data === "object" && "groups" in data) rows = rows.concat(data.groups);
    else { // never report an unreadable file as an empty table
      throw new DataError(`${path.basename(p)}: not a Census API response (a JSON array with a header row) nor ` +
        "a data.census.gov table JSON or CSV", "bad_request");
    }
  }
  return gr.clean(rows, CLEAN_FLAT);
}

// ---------------------------------------------------------------------- search
async function variables(client: Client, pack: Pack, ds: string): Promise<any> {
  const url = `${client.base}/${ds}/variables.json`;
  const cache = process.env.DATA_ANALYST_FIXTURES ? null : new Cache("census", pack.policy);
  const hit = cache ? cache.get(url) : null;
  if (hit) return parsePyJson(hit[0].toString("utf8"));
  const r = await censusGet(client, `/${ds}/variables.json`);
  if (cache) cache.put(url, r.body, { dataset: ds });
  return r.json();
}

/** 'median household income' searches the latest ACS 5-year tables; prefix a dataset to choose another:
 * '2020/dec/pl: total population', 'acs1_subject: poverty'. */
export async function search(query: string, pack: Pack): Promise<any[]> {
  const m = /^\s*([\w/]+)\s*:\s*([\s\S]+)$/.exec(query);
  const cat = pack.endpoints?.catalog || {};
  let [dsIn, text] = m ? [m[1], m[2]] : ["latest/acs/acs5", query];
  dsIn = dsIn in cat ? cat[dsIn].id : dsIn;
  const words = (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => w.length > 1);
  const hits = gr.searchCatalog(pack, text, 200).filter((h) => "alias" in h &&
    words.every((w) => Object.values(h).map(pyStr).join(" ").toLowerCase().includes(w)));
  const out: any[] = hits.slice(0, 5);
  const client = clientOf(pack);
  try {
    const [ds] = await resolveDataset(client, dsIn);
    const vs: Record<string, any> = (await variables(client, pack, ds)).variables || {};
    const scored: [number, any][] = [];
    for (const [vid, v] of Object.entries(vs)) {
      const label = pyStr(v.label ?? "").replace(/!!/g, " > ").replace(/^[ >]+|[ >]+$/g, "");
      const concept = pyStr(v.concept ?? "");
      const hay = `${vid} ${label} ${concept}`.toLowerCase();
      if (words.length && words.every((w) => hay.includes(w))) {
        const s = words.filter((w) => label.toLowerCase().includes(w)).length * 1000 - label.length - 0.1 * concept.length;
        const attrs = pyStr(v.attributes ?? "");
        scored.push([s, { variable: vid, label, concept, group: v.group ?? "",
          moe: attrs.split(",").find((a) => a.endsWith("M") && !a.endsWith("MA")) ?? "", dataset: ds }]);
      }
    }
    scored.sort((a, b) => b[0] - a[0]);
    out.push(...scored.slice(0, Math.max(0, 20 - out.length)).map(([, h]) => h));
    if (scored.length > 20 - hits.slice(0, 5).length) {
      out.push({ note: `${scored.length} variables match in ${ds}: add words, or list a table with the group_variables endpoint` });
    }
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    out.push({ note: `variable search needs api.census.gov (${e.kind}): ${e.message}` });
  }
  return out;
}

const adapter: Adapter = {
  fetch, checkSpec, checkError, normalize, ping, manualItems, manualItemsAsync, parseUpload,
  search,
};
export default adapter;
