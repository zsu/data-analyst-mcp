/**
 * The fred deep pack's spec, download and packaging (ported from the Python skill's sources/fred/fetch.py).
 *
 * spec:
 *   {"description": "Output gap since 2019",
 *    "series": [{"id": "GDPC1", "label": "Real GDP"}, "GDPPOT"],          // or plain IDs
 *    "start": "2018-01-01", "end": null,                                  // end: latest
 *    "recessions": true,          // adds USREC (NBER recession indicator, monthly)
 *    // optional, globally or per series (per series wins):
 *    "frequency": "q", "aggregation_method": "avg", "units": "lin",
 *    "vintage": "latest" | {"as_of": [dates]} | "first_release" | "all",
 *    "regional": [{"series_id": "CAUR", "region_type": "state", "date": "2025-01-01"}],    // GeoFRED, key
 *    "release_dates": {"release_id": 50, "start": "2026-10-01", "end": "2026-12-31"},       // calendar, key
 *    "release_observations": [{"release_id": 53, "limit": 10000, "max_pages": 2, "series": [IDs]}]}  // v2, key
 * Per series also (they do not change the download): "source", "copyright" (public_domain | citation_required |
 * preapproval_required) with "copyright_basis".
 *
 * Output (<workspace>/data/fred/): fred_observations.csv, series.csv, regional.csv, release_dates.csv,
 * release_series.csv / release_observations.csv (when asked), raw/, request.json, README.md.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { trail } from "../core/context.js";
import * as keys from "../core/keys.js";
import { dataDir as coreDataDir } from "../core/package.js";
import type { Pack } from "../core/packs.js";
import * as pol from "../core/policy.js";
import { parsePyJson, pyFloatRepr, pyJsonDumps } from "../core/py.js";
import { writeCsv } from "../core/tabular.js";
import {
  API, API_V2, citation, copyrightFromTag, copyrightStatus, copyrightTagOf, FredClient, FredError, GRAPH_MAX, GRAPH_XLSX,
  graphUrl, isFatal, Keyless, LEGAL_URL, type Meta, NOTICE, observationRows, parseGraphCsv, parseGraphXlsx, parseValue,
  type Point, regionalRows, TERMS_URL,
} from "./_fred_api.js";
import {
  cell, cmp, cmpTuple, dayBeforeFirst, daysBetween, dumpsIndent, isDigits, localToday, nowIso, pstr, PY_SPACE, pyInt,
  pyRepr, pyStrip, PyValueError, roundHalfEven, truthy, tupleRepr, urlencodeSafe,
} from "./_fred_py.js";

export const SOURCE = "fred";
export const FREQS = ["d", "w", "bw", "m", "q", "sa", "a"] as const;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,40}$/;
/** FRED's labels on a series page: "Public Domain: Citation Requested", "Copyrighted: Citation Required",
 * "Copyrighted: Pre-Approval Required". */
export const COPYRIGHT_LABELS = ["public_domain", "citation_required", "preapproval_required"] as const;
/** fields that do not change the download */
const NOT_DATA = ["label", "copyright", "copyright_basis", "source", "auto"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --------------------------------------------------------------------------- spec
export type Vintage = { kind: "latest" | "first_release" | "all" | "as_of"; dates: string[] };
export type Series = { id: string; label: unknown; copyright?: string; copyright_basis?: unknown; source?: string;
  start: any; end: any; frequency: string | null; aggregation_method: string | null; units: string | null; vintage: Vintage;
  auto?: string };
export type ReleaseDates = { release_id: number | null; start: any; end: any; limit: number };
export type ReleaseObs = { release_id: number; limit: number; max_pages: number; series: string[]; label: unknown };
export type NSpec = { description: unknown; series: Series[]; regional: Record<string, any>[]; recessions: boolean;
  release_dates: ReleaseDates | null; release_observations: ReleaseObs[] };

const isDict = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o: Record<string, any>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const get = (o: Record<string, any>, k: string, d: unknown = null) => (has(o, k) ? o[k] : d);
const blank = (v: unknown) => v === null || v === undefined || v === "";

/** dict(x) of a spec entry (Python raises TypeError on anything else). */
function asDict(x: unknown): Record<string, any> {
  if (isDict(x)) return { ...x };
  const t = x === null || x === undefined ? "NoneType" : typeof x === "number" ? (Number.isInteger(x) ? "int" : "float")
    : typeof x === "boolean" ? "bool" : Array.isArray(x) ? "list" : "str";
  throw new PyValueError(Array.isArray(x) ? "cannot convert dictionary update sequence element #0 to a sequence"
    : `'${t}' object is not iterable`);
}

export function normVintage(v: unknown): Vintage {
  if (v === null || v === undefined || v === "" || v === "latest") return { kind: "latest", dates: [] };
  if (v === "first_release" || v === "initial") return { kind: "first_release", dates: [] };
  if (v === "all" || v === "all_vintages") return { kind: "all", dates: [] };
  if (isDict(v) && has(v, "as_of")) {
    const raw = Array.isArray(v.as_of) ? v.as_of : [v.as_of];
    const dates = [...new Set(raw.map((d: unknown) => pstr(d).slice(0, 10)))].sort(cmp);
    const bad = dates.filter((d) => !DATE_RE.test(d));
    if (bad.length || !dates.length) throw new PyValueError(`vintage as_of needs YYYY-MM-DD dates, got ${pyRepr(v.as_of)}`);
    return { kind: "as_of", dates };
  }
  throw new PyValueError(`vintage must be "latest", {"as_of": [dates]}, "first_release" or "all", got ${pyRepr(v)}`);
}

export function normSpec(spec: any): NSpec {
  if (!isDict(spec)) throw new PyValueError("spec must be a JSON object");
  const G = ["start", "end", "frequency", "aggregation_method", "units"];
  const g: Record<string, any> = Object.fromEntries(G.map((k) => [k, get(spec, k)]));
  const gv = get(spec, "vintage");
  const series: Series[] = [];
  const list = (v: unknown): unknown[] => (truthy(v) ? (Array.isArray(v) ? v : isDict(v) ? Object.keys(v) : typeof v === "string" ? [...v] : [v]) : []);
  for (const x0 of list(spec.series)) {
    const x = typeof x0 === "string" ? { id: x0 } : asDict(x0);
    if (!has(x, "id")) throw new PyValueError("'id'");
    const sid = pyStrip(pstr(x.id)).toUpperCase();
    if (!ID_RE.test(sid)) throw new PyValueError(`not a FRED series ID: ${pyRepr(x.id)}`);
    const item: any = { id: sid, label: get(x, "label", "") };
    if (truthy(x.copyright)) { // read on the series page when the keyless route gave no notes
      if (!COPYRIGHT_LABELS.includes(x.copyright)) throw new PyValueError(`${sid}: copyright must be one of ${tupleRepr(COPYRIGHT_LABELS)}`);
      item.copyright = x.copyright;
      item.copyright_basis = truthy(x.copyright_basis) ? x.copyright_basis : "set in spec.json";
    }
    if (truthy(x.source)) item.source = pstr(x.source); // the source agency, for the citation (keyless route)
    for (const k of G) {
      const val = has(x, k) ? x[k] : g[k];
      item[k] = blank(val) ? null : pyStrip(pstr(val));
    }
    item.vintage = normVintage(has(x, "vintage") ? x.vintage : gv);
    for (const k of ["start", "end"]) {
      if (item[k] && !DATE_RE.test(item[k])) throw new PyValueError(`${sid}: ${k} must be YYYY-MM-DD, got ${pyRepr(item[k])}`);
    }
    if (item.frequency && !(FREQS as readonly string[]).includes(item.frequency.toLowerCase())) {
      throw new PyValueError(`${sid}: frequency must be one of ${tupleRepr(FREQS)}`);
    }
    if (item.frequency) item.frequency = item.frequency.toLowerCase();
    if (item.aggregation_method && !["avg", "sum", "eop"].includes(item.aggregation_method)) {
      throw new PyValueError(`${sid}: aggregation_method must be avg, sum or eop`);
    }
    if (item.units === "lin") item.units = null;
    series.push(item);
  }
  if (truthy(spec.recessions) && !series.some((s) => s.id === "USREC")) {
    // the same entry as an explicit {"id": "USREC"} would get, so listing it later (to add its source and copyright)
    // is the same request
    series.push({ id: "USREC", label: "NBER recession indicator", start: g.start, end: g.end, frequency: null,
      aggregation_method: null, units: null, vintage: normVintage(gv), auto: "recessions" });
  }
  const keyOf = (s: Series) => pyJsonDumps([s.id, s.units, s.frequency, s.vintage.kind, s.vintage.dates]);
  const counts = new Map<string, number>();
  for (const s of series) counts.set(keyOf(s), (counts.get(keyOf(s)) || 0) + 1);
  const dup = [...new Set(series.filter((s) => counts.get(keyOf(s))! > 1).map((s) => s.id))].sort(cmp);
  if (dup.length) throw new PyValueError(`duplicate series in spec.json: ${pyRepr(dup)}`);
  const regional: Record<string, any>[] = [];
  for (const r0 of list(spec.regional)) {
    if (!isDict(r0)) throw new PyValueError(`'${typeof r0 === "string" ? "str" : typeof r0}' object has no attribute 'get'`);
    if (!(truthy(r0.series_id) || truthy(r0.series_group))) {
      throw new PyValueError("each regional block needs series_id (any series of the group) or series_group");
    }
    const r: Record<string, any> = {};
    for (const k of ["series_id", "series_group", "region_type", "date", "start_date", "season", "units", "frequency",
      "aggregation_method", "transformation", "label"]) if (!blank(r0[k])) r[k] = r0[k];
    regional.push(r);
  }
  let rdates: ReleaseDates | null = null;
  if (truthy(spec.release_dates)) {
    const rd0 = spec.release_dates;
    const rd = typeof rd0 === "number" || typeof rd0 === "string" || typeof rd0 === "boolean" ? { release_id: rd0 } : asDict(rd0);
    for (const k of ["start", "end"]) {
      if (truthy(rd[k]) && !DATE_RE.test(pstr(rd[k]))) throw new PyValueError(`release_dates ${k} must be YYYY-MM-DD, got ${pyRepr(rd[k])}`);
    }
    if (!blank(rd.release_id) && !isDigits(pstr(rd.release_id))) {
      throw new PyValueError(`release_dates release_id must be a number, got ${pyRepr(rd.release_id)}`);
    }
    rdates = { release_id: !blank(rd.release_id) ? pyInt(rd.release_id) : null, start: get(rd, "start"), end: get(rd, "end"),
      limit: pyInt(truthy(rd.limit) ? rd.limit : 10000) };
  }
  const robs: ReleaseObs[] = [];
  for (const ro0 of list(spec.release_observations)) {
    const ro = typeof ro0 === "number" || typeof ro0 === "string" || typeof ro0 === "boolean" ? { release_id: ro0 } : asDict(ro0);
    if (!isDigits(pstr(get(ro, "release_id", "")))) {
      throw new PyValueError(`release_observations needs a numeric release_id, got ${pyRepr(get(ro, "release_id"))}`);
    }
    const lim = pyInt(truthy(ro.limit) ? ro.limit : 10000), pages = pyInt(truthy(ro.max_pages) ? ro.max_pages : 5);
    if (!(lim >= 1 && lim <= 500000) || !(pages >= 1 && pages <= 50)) {
      throw new PyValueError("release_observations: limit 1-500000 observations per page, max_pages 1-50");
    }
    const keep = list(ro.series).map((x) => pyStrip(pstr(x)).toUpperCase());
    robs.push({ release_id: pyInt(ro.release_id), limit: lim, max_pages: pages, series: keep, label: get(ro, "label", "") });
  }
  if (!series.length && !regional.length && !rdates && !robs.length) {
    throw new PyValueError("spec.json has no series, regional, release_dates or release_observations block");
  }
  return { description: get(spec, "description", ""), series, regional, recessions: truthy(spec.recessions),
    release_dates: rdates, release_observations: robs };
}

const sha16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const omit = (o: Record<string, any>, drop: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)));
const byJson = (a: unknown, b: unknown) => cmp(pyJsonDumps(a, true), pyJsonDumps(b, true));

/** Two specs asking for the same data hash the same (labels and description do not matter). */
export function fingerprint(s: NSpec): string {
  const core: Record<string, unknown> = {
    series: s.series.map((x) => omit(x, NOT_DATA)).sort(byJson),
    regional: s.regional.map((r) => omit(r, ["label"])).sort(byJson),
  };
  if (s.release_dates) core.release_dates = s.release_dates;
  if (s.release_observations.length) core.release_observations = s.release_observations.map((r) => omit(r, ["label"]));
  return sha16(pyJsonDumps(core, true));
}

/** The spec fields that change only the packaging (labels, sources, copyright). */
export function metaFingerprint(s: NSpec): string {
  const core = s.series.map((x) => [x.id, ...NOT_DATA.map((k) => get(x, k))]);
  return sha16(pyJsonDumps(core, true));
}

/** What in this request only the API (with a key) can deliver. */
export function keyOnlyNeeds(s: NSpec): string[] {
  const out = s.series.filter((x) => x.vintage.kind === "first_release" || x.vintage.kind === "all")
    .map((x) => `${x.id}: ${x.vintage.kind.replaceAll("_", " ")} vintages`);
  if (s.regional.length) out.push(`${s.regional.length} GeoFRED regional cross-section(s)`);
  if (s.release_dates) out.push("the release calendar (release/dates)");
  for (const r of s.release_observations) out.push(`release ${r.release_id} observations (v2 release/observations)`);
  return out;
}

/** The as-of dates of one series in groups of GRAPH_MAX: one keyless graph download holds at most 12 columns and FRED
 * drops the rest silently (checked live: 14 as-of dates returned 12 vintages). [null] = latest only. */
export function vintageChunks(x: Series): (string[] | null)[] {
  const d = x.vintage.dates;
  if (!d.length) return [null];
  const out: string[][] = [];
  for (let i = 0; i < d.length; i += GRAPH_MAX) out.push(d.slice(i, i + GRAPH_MAX));
  return out;
}

export function chunkFile(x: Series, n: number, of: number): string {
  return of === 1 ? `${tag(x)}.csv` : `${tag(x)}_p${n}.csv`;
}

/** A file-name-safe name for one requested series variant. */
export function tag(x: Series): string {
  const parts = [x.id];
  if (x.units) parts.push(x.units);
  if (x.frequency) parts.push(x.frequency + (x.aggregation_method || "avg"));
  if (x.vintage.kind !== "latest") parts.push(x.vintage.kind !== "as_of" ? x.vintage.kind : "asof");
  return parts.join("_");
}

export function dataDir(out: string): string {
  return coreDataDir(out, SOURCE);
}

// --------------------------------------------------------------------------- what is on disk
export type ExistingData = { path: string; csv_exists: boolean; matches: boolean; meta_fingerprint: string | null;
  acquired: string; retrieved: string; age_days: number | null; route: string | null; latest: any; problems: string[] };

export function existingData(out: string, fp: string): ExistingData | null {
  const d = dataDir(out);
  const rq = path.join(d, "request.json"), csvPath = path.join(d, "fred_observations.csv");
  if (!fs.existsSync(rq)) return null;
  let saved: any;
  try {
    saved = JSON.parse(fs.readFileSync(rq, "utf8"));
  } catch {
    return null;
  }
  const retrieved = saved.retrieved || "";
  const t = Date.parse(retrieved);
  return { path: csvPath, csv_exists: fs.existsSync(csvPath), matches: saved.fingerprint === fp,
    meta_fingerprint: saved.meta_fingerprint ?? null, acquired: saved.acquired || "", retrieved,
    age_days: Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null, route: saved.route ?? null,
    latest: saved.latest ?? null, problems: saved.problems || [] };
}

// --------------------------------------------------------------------------- manual items
export type PyItem = { file: string; url: string; keyed: boolean; what: string; bearer?: boolean; pages?: number;
  then?: { file: string; url: string } };

function apiUrl(p: string, params: Record<string, unknown>, geo = false): string {
  const q: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!blank(v)) q[k] = v;
  q.api_key = "__FRED_KEY__";
  q.file_type = "json";
  const base = geo ? API.replace("/fred/", "/geofred/") : API;
  return `${base}${p}?${urlencodeSafe(q)}`;
}

/** Every file the user downloads: FRED's keyless graph files where they serve, API calls otherwise (the Python
 * manifest; keyed URLs carry the __FRED_KEY__ placeholder). */
export function pyManualItems(s: NSpec): PyItem[] {
  const items: PyItem[] = [];
  for (const x of s.series) {
    const kind = x.vintage.kind;
    if (kind === "latest" || kind === "as_of") {
      const chunks = vintageChunks(x);
      chunks.forEach((dates, i) => {
        const url = graphUrl(x.id, { start: x.start, end: x.end, frequency: x.frequency,
          aggregation_method: x.aggregation_method, units: x.units, vintage_dates: dates });
        items.push({ file: chunkFile(x, i + 1, chunks.length), url, keyed: false,
          what: (truthy(x.label) ? pstr(x.label) : x.id) + (chunks.length > 1 ? ` (vintages ${dates![0]} to ${dates![dates!.length - 1]})` : "") });
      });
      continue;
    }
    const p: Record<string, unknown> = { series_id: x.id, observation_start: x.start, observation_end: x.end, units: x.units,
      frequency: x.frequency, aggregation_method: x.aggregation_method, realtime_start: "1776-07-04",
      realtime_end: "9999-12-31" };
    if (kind === "first_release") p.output_type = 4;
    items.push({ file: `${tag(x)}.json`, url: apiUrl("series/observations", p), keyed: true,
      what: `${x.id} ${kind.replaceAll("_", " ")}` });
    items.push({ file: `${x.id}__series.json`, url: apiUrl("series", { series_id: x.id }), keyed: true,
      what: `${x.id} notes (source, copyright)` });
  }
  const ids = [...new Set(s.series.map((x) => x.id))].sort(cmp); // the XLSX gives titles and units without a key
  for (let i = 0; i < ids.length; i += GRAPH_MAX) {
    const chunk = ids.slice(i, i + GRAPH_MAX);
    items.push({ file: `metadata_${String(i / GRAPH_MAX + 1).padStart(2, "0")}.xlsx`, keyed: false, what: "titles, units, frequency",
      url: `${GRAPH_XLSX}?${urlencodeSafe({ id: chunk.join(",") })}` });
  }
  s.regional.forEach((rb, j0) => {
    const j = String(j0 + 1).padStart(2, "0");
    const p = omit(rb, ["label", "series_id"]);
    if (has(p, "series_group")) {
      items.push({ file: `regional_${j}.json`, keyed: true, what: "GeoFRED cross-section", url: apiUrl("regional/data", p, true) });
      return;
    }
    // two steps: the group of the member series, then the cross-section; the download scripts fill the __GROUP_*__
    // placeholders from the first reply
    const tpl = { series_group: "__GROUP_SERIES_GROUP__", region_type: "__GROUP_REGION_TYPE__", season: "__GROUP_SEASON__",
      units: "__GROUP_UNITS__", frequency: "__GROUP_FREQUENCY__", date: "__GROUP_MAX_DATE__", ...p };
    items.push({ file: `regional_${j}__group.json`, keyed: true, what: "GeoFRED group",
      url: apiUrl("series/group", { series_id: rb.series_id }, true),
      then: { file: `regional_${j}.json`, url: apiUrl("regional/data", tpl, true) } });
  });
  const rd = s.release_dates;
  if (rd) {
    const start = rd.start || localToday();
    const end = rd.end || (rd.release_id ? "9999-12-31" : localToday(14));
    let p: Record<string, unknown> = { realtime_start: start, realtime_end: end, include_release_dates_with_no_data: "true",
      sort_order: "asc", limit: rd.limit };
    const pth = rd.release_id ? "release/dates" : "releases/dates";
    if (rd.release_id) p = { release_id: rd.release_id, ...p };
    items.push({ file: "release_dates.json", keyed: true, what: "release calendar", url: apiUrl(pth, p) });
  }
  for (const ro of s.release_observations) {
    const q = urlencodeSafe({ release_id: ro.release_id, format: "json", limit: ro.limit }).replaceAll(",", "%2C");
    items.push({ file: `release_${ro.release_id}.json`, keyed: true, bearer: true, pages: ro.max_pages,
      what: `release ${ro.release_id} observations (FRED API v2)`, url: `${API_V2}release/observations?${q}` });
  }
  const seen = new Set<string>();
  return items.filter((it) => (seen.has(it.file) ? false : (seen.add(it.file), true))); // one notes file per series
}

/** The items as src/core/manual.ts takes them ({API_KEY} where the key goes). The core scripts send a key only as
 * a query parameter and make one request per item, so a v2 whole-release page (Bearer header, cursor pages) and the
 * second GeoFRED step are listed with a note instead of being fetched blind. */
export function coreManualItems(s: NSpec): any[] {
  return pyManualItems(s).map((it) => {
    const url = it.url.replace("__FRED_KEY__", "{API_KEY}");
    if (it.bearer) {
      return { name: it.file, url, filename: it.file, needs_key: false, method: "GET", optional: true,
        note: `${it.what}: FRED API v2 takes the key as an "Authorization: Bearer" header, which this script does not send ` +
          "(the request answers HTTP 401 without it). Download it where a key is set up (fetch with a key), saving page 2 " +
          `on as release_${it.file.slice(8, -5)}__p02.json and so on.` };
    }
    if (it.then) {
      return { name: it.file, url, filename: it.file, needs_key: true, method: "GET", optional: false,
        note: `${it.what} (step 1 of 2): the cross-section ${it.then.file} needs this reply's series_group, region_type, ` +
          "season, units, frequency and max_date. Put series_group in the spec's regional block to download it in one step." };
    }
    return { name: it.file, url, filename: it.file, needs_key: it.keyed, method: "GET", optional: false, note: it.what };
  });
}

// --------------------------------------------------------------------------- download
/** GeoFRED's series-group frequency ("a", "Annual", "Semiannual", "bw" ...) as the regional/data code (d, w, bw, m, q,
 * sa, a). The first letter alone turns "sa" into "s" and "bw" into "b". */
export function geoFreq(f: unknown): string {
  const s = pyStrip(pstr(truthy(f) ? f : "a")).toLowerCase();
  if ((FREQS as readonly string[]).includes(s)) return s;
  const words: [string, string][] = [["daily", "d"], ["weekly", "w"], ["biweekly", "bw"], ["monthly", "m"], ["quarterly", "q"],
    ["semiannual", "sa"], ["annual", "a"]];
  return words.find(([w]) => s.replaceAll("-", "").startsWith(w))?.[1] ?? "a";
}

export function vintageLabel(x: Series, rtStart = "", column = ""): string {
  const k = x.vintage.kind;
  if (k === "latest") return "latest";
  if (k === "first_release") return "first_release";
  if (k === "all") return rtStart;
  const m = /_(\d{8})$/.exec(column);
  return m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}` : "";
}

type Row = Record<string, any>;
export type Raw = { name: string; request: string; response?: unknown; bytes?: Buffer };
export type Parts = { obs: [Series, Row[]][]; meta: Map<string, Meta>; raw: Raw[]; regional: Row[]; problems: string[];
  calls: string[]; release_dates: Row[]; release_series: Row[]; release_obs: Row[]; notes: string[] };

export function newParts(calls: string[]): Parts {
  return { obs: [], meta: new Map(), raw: [], regional: [], problems: [], calls, release_dates: [], release_series: [],
    release_obs: [], notes: [] };
}

/** The series' copyright tag ("copyrighted: citation required" ...), "" when the tags cannot be read. */
export async function seriesCopyrightTag(c: FredClient, sid: string): Promise<string> {
  try {
    return copyrightTagOf(await c.get("series/tags", { series_id: sid }));
  } catch (e) {
    if (isFatal(e) || !(e instanceof FredError)) throw e;
    return "";
  }
}

/** A per-series failure becomes a problem; auth, network, rate and outage failures stop the run. */
function problem(e: unknown, parts: Parts, what: string): void {
  if (isFatal(e) || !(e instanceof FredError)) throw e;
  parts.problems.push(`${what}: ${e.message}`);
}

/** Everything through the API. Returns the collected parts for packageData(). */
export async function fetchApi(s: NSpec, c: FredClient): Promise<Parts> {
  const parts = newParts(c.calls);
  const sources = new Map<unknown, any[]>();
  for (const x of s.series) {
    const sid = x.id;
    try {
      if (!parts.meta.has(sid)) {
        const m = await c.series(sid);
        const rel = await c.releaseOf(sid);
        const rid = rel.id ?? null;
        if (rid !== null && !sources.has(rid)) sources.set(rid, await c.releaseSources(rid));
        const srcs = sources.get(rid) || [];
        const ctag = await seriesCopyrightTag(c, sid);
        Object.assign(m, { release: rel.name ?? "", release_id: rid, copyright_tag: ctag,
          source: srcs.filter((z) => truthy(z.name)).map((z) => z.name ?? "").join("; "), metadata_source: "api" });
        parts.meta.set(sid, m);
        parts.raw.push({ name: `${sid}__series.json`, request: `series, series/release, release/sources for ${sid}`,
          response: { seriess: [m] } });
      }
      const p: Record<string, unknown> = { observation_start: x.start, observation_end: x.end, units: x.units,
        frequency: x.frequency, aggregation_method: x.aggregation_method };
      const k = x.vintage.kind;
      if (k === "as_of") p.vintage_dates = x.vintage.dates.join(",");
      else if (k === "first_release") { // needs the whole real-time window (checked live 2026-10-20)
        Object.assign(p, { output_type: 4, realtime_start: "1776-07-04", realtime_end: "9999-12-31" });
      } else if (k === "all") Object.assign(p, { realtime_start: "1776-07-04", realtime_end: "9999-12-31" });
      const obs = await c.observations(sid, p);
      parts.raw.push({ name: `${tag(x)}.json`, request: c.calls[c.calls.length - 1], response: { observations: obs } });
      let rows: Row[] = observationRows(sid, obs);
      if (k === "as_of") { // assign each real-time period to the vintages it covers
        const exp: Row[] = [];
        for (const r of rows) {
          for (const v of x.vintage.dates) {
            if (r.realtime_start <= v && (!r.realtime_end || v <= r.realtime_end)) exp.push({ ...r, vintage: v });
          }
        }
        rows = exp;
      } else for (const r of rows) r.vintage = vintageLabel(x, r.realtime_start);
      parts.obs.push([x, rows]);
    } catch (e) {
      problem(e, parts, tag(x));
    }
  }
  for (let j = 1; j <= s.regional.length; j++) {
    const rb = s.regional[j - 1];
    try {
      const p = omit(rb, ["label", "series_id"]);
      if (!has(p, "series_group")) {
        const grp = await c.seriesGroup(rb.series_id);
        p.series_group = grp.series_group ?? null;
        for (const k of ["region_type", "season", "units"]) if (!has(p, k)) p[k] = grp[k] ?? null;
        if (!has(p, "frequency")) p.frequency = geoFreq(grp.frequency);
        if (!has(p, "date")) p.date = grp.max_date ?? null;
      }
      const payload = await c.regional(p);
      parts.raw.push({ name: `regional_${String(j).padStart(2, "0")}.json`, request: c.calls[c.calls.length - 1], response: payload });
      for (const r of regionalRows(payload)) {
        parts.regional.push({ group: p.series_group, label: get(rb, "label", ""), ...r, units: get(p, "units", ""),
          season: get(p, "season", ""), frequency: get(p, "frequency", "") });
      }
    } catch (e) {
      problem(e, parts, `regional block ${j}`);
    }
  }
  const rd = s.release_dates;
  if (rd) {
    try {
      const j = await c.releaseDates(rd.release_id, rd.start, rd.end, rd.limit);
      parts.raw.push({ name: "release_dates.json", request: c.calls[c.calls.length - 1], response: j });
      parts.release_dates = releaseDateRows(j);
      if (rd.release_id && parts.release_dates.some((r) => !truthy(r.release_name))) {
        let name: unknown = "";
        try { // release/dates for one release carries no name: look it up once
          const rel = await c.get("release", { release_id: rd.release_id });
          name = ((rel.releases && rel.releases.length ? rel.releases : [{}])[0]).name ?? "";
        } catch (e) {
          if (isFatal(e) || !(e instanceof FredError)) throw e;
          name = "";
        }
        for (const r of parts.release_dates) r.release_name = truthy(r.release_name) ? r.release_name : name;
      }
      if (pyInt(truthy(j.count) ? j.count : 0) > parts.release_dates.length) {
        parts.problems.push(`release_dates: ${pstr(j.count ?? null)} dates exist, ${parts.release_dates.length} kept (limit ` +
          `${rd.limit}); narrow start/end or raise limit`);
      }
    } catch (e) {
      problem(e, parts, "release_dates");
    }
  }
  for (const ro of s.release_observations) {
    try {
      const [rel, series] = await c.releaseObservations(ro.release_id, ro.limit, ro.max_pages);
      parts.raw.push({ name: `release_${ro.release_id}.json`, request: c.calls[c.calls.length - 1],
        response: { release: rel, series } });
      addReleaseRows(parts, ro, rel, series);
    } catch (e) {
      problem(e, parts, `release ${ro.release_id} observations`);
    }
  }
  return parts;
}

export function releaseDateRows(j: any): Row[] {
  return (j.release_dates || []).map((d: any) => ({ release_id: get(d, "release_id", ""), release_name: get(d, "release_name", ""),
    date: get(d, "date", "") }));
}

/** Uploaded v2 release/observations pages in order (one file per page, or one merged reply) -> [release, series], as
 * FredClient.releaseObservations returns them. A page can end inside a series: the next page continues it. */
export function mergeReleasePages(pages: any[]): [any, any[]] {
  let release: any = {};
  const series: any[] = [];
  for (const j of pages) {
    if (!truthy(release)) release = { ...(j.release || {}) };
    for (const x of j.series || []) {
      if (series.length && series[series.length - 1].series_id === x.series_id) {
        const last = series[series.length - 1];
        last.observations = [...(last.observations || []), ...(x.observations || [])];
      } else series.push({ ...x });
    }
  }
  const last = pages.length ? pages[pages.length - 1] : {};
  if (has(last, "has_more")) { // a raw page; a merged reply keeps these in its release
    const cursor = truthy(last.has_more) ? last.next_cursor : null;
    Object.assign(release, { has_more: truthy(cursor), next_cursor: truthy(cursor) ? cursor : "" });
  }
  return [release, series];
}

const floatCell = (v: number | null) => (v === null ? "" : pyFloatRepr(v));

/** v2 release/observations -> release_series rows (one per series, with FRED's copyright tag) and release_observations
 * rows (one per series and date). */
export function addReleaseRows(parts: Parts, ro: { release_id: number; series?: string[]; max_pages: number }, rel: any,
  series: any[]): void {
  const keep = new Set(ro.series || []);
  let n = 0;
  for (const x of series) {
    const sid = pstr(get(x, "series_id", "")).toUpperCase();
    if (keep.size && !keep.has(sid)) continue;
    n++;
    const tg = get(x, "copyright_id", "");
    const rid = get(rel, "release_id", ro.release_id);
    parts.release_series.push({ release_id: rid, release: get(rel, "name", ""), series_id: sid, title: get(x, "title", ""),
      units: get(x, "units", ""), frequency: get(x, "frequency", ""), seasonal_adjustment: get(x, "seasonal_adjustment", ""),
      last_updated: get(x, "last_updated", ""), copyright_tag: tg,
      copyright: copyrightFromTag(tg as string) || copyrightStatus(x.notes, true), n_obs: (x.observations || []).length });
    for (const o of x.observations || []) {
      parts.release_obs.push({ release_id: rid, series_id: sid, date: get(o, "date", ""), value: floatCell(parseValue(o.value)) });
    }
  }
  if (keep.size && !n) parts.problems.push(`release ${ro.release_id}: none of ${pyRepr([...keep].sort(cmp))} in the pages downloaded`);
  if (truthy(rel.has_more)) {
    parts.notes.push(`release ${ro.release_id}: stopped after max_pages=${ro.max_pages} (more pages exist; next_cursor ` +
      `${pstr(rel.next_cursor ?? null)}). Raise max_pages or filter with series.`);
  }
}

/** Graph-CSV columns -> observation rows. An as-of vintage ends where that vintage's data ended: the empty cells after
 * its last value are dates not yet published then, not missing values. */
export function graphRows(x: Series, cols: Map<string, Point[]>): Row[] {
  const rows: Row[] = [];
  for (const [col, pts0] of cols) {
    const v = vintageLabel(x, "", col);
    let pts = pts0;
    if (x.vintage.kind === "as_of") {
      let last = -1;
      pts.forEach((p, i) => { if (p.value !== null) last = i; });
      pts = pts.slice(0, last + 1);
    }
    for (const p of pts) rows.push({ ...p, realtime_start: "", realtime_end: "", vintage: v });
  }
  return rows;
}

export async function fetchKeyless(s: NSpec, k: Keyless): Promise<Parts> {
  const parts = newParts(k.calls);
  for (const need of keyOnlyNeeds(s)) parts.problems.push(`needs a FRED API key, not downloaded: ${need}`);
  const ids = [...new Set(s.series.map((x) => x.id))].sort(cmp);
  for (let i = 0; i < ids.length; i += GRAPH_MAX) {
    const chunk = ids.slice(i, i + GRAPH_MAX);
    try {
      const [meta, body] = await k.metadata(chunk);
      parts.raw.push({ name: `metadata_${String(i / GRAPH_MAX + 1).padStart(2, "0")}.xlsx`, request: k.calls[k.calls.length - 1], bytes: body });
      for (const [sid, m] of meta) {
        m.metadata_source = "fredgraph.xlsx";
        parts.meta.set(sid, m);
      }
    } catch (e) {
      if ((e instanceof FredError && e.fk === "network") || !(e instanceof FredError)) throw e;
      parts.problems.push(`metadata for ${chunk.join(", ")}: ${e.message}`);
    }
  }
  for (const x of s.series) {
    if (x.vintage.kind !== "latest" && x.vintage.kind !== "as_of") continue;
    const chunks = vintageChunks(x);
    const rows: Row[] = [];
    for (let n = 1; n <= chunks.length; n++) {
      const dates = chunks[n - 1];
      let cols: Map<string, Point[]>, body: Buffer, lastMod: string;
      try {
        [cols, body, lastMod] = await k.csv(x.id, { start: x.start, end: x.end, frequency: x.frequency,
          aggregation_method: x.aggregation_method, units: x.units, vintage_dates: dates });
      } catch (e) {
        if ((e instanceof FredError && e.fk === "network") || !(e instanceof FredError)) throw e;
        parts.problems.push(x.id + (dates ? ` vintages ${dates[0]} to ${dates[dates.length - 1]}` : "") + `: ${e.message}`);
        continue;
      }
      parts.raw.push({ name: chunkFile(x, n, chunks.length), request: k.calls[k.calls.length - 1], bytes: body });
      rows.push(...graphRows(x, cols));
      if (lastMod && parts.meta.has(x.id)) {
        const m = parts.meta.get(x.id)!;
        if (!has(m, "http_last_modified")) m.http_last_modified = lastMod;
      }
    }
    if (rows.length) parts.obs.push([x, rows]);
    if (x.vintage.kind === "as_of") {
      const got = new Set(rows.map((r) => r.vintage));
      const missing = [...new Set(x.vintage.dates)].filter((d) => !got.has(d)).sort(cmp);
      if (missing.length) parts.problems.push(`${x.id}: no data for as-of vintage(s) ${missing.join(", ")}`);
    }
  }
  return parts;
}

// --------------------------------------------------------------------------- package
/** csv.DictWriter: the header, then each row's fields (None empty, extras ignored); no fields = an empty header line. */
function writeCsvFile(file: string, rows: Row[], fields?: string[]): string[] {
  const cols = fields ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (!cols.length) {
    fs.writeFileSync(file, "\r\n".repeat(1 + rows.length));
    return cols;
  }
  fs.writeFileSync(file, writeCsv(rows.map((r) => Object.fromEntries(cols.map((c) => [c, cell(r[c])]))), cols));
  return cols;
}

export const CREDIT = "Data from FRED\u00ae, Federal Reserve Bank of St. Louis (downloaded without the API); this product is " +
  "not endorsed or certified by the Federal Reserve Bank of St. Louis.";

/** Last day of the period an observation stands for: FRED dates most periods by their first day (2026-10-01 = 2026 Q4,
 * which has not ended on 2026-10-20) and fiscal-year dollar series by their last day. */
export function periodEndIso(d: string, dated: string[]): string {
  if (!d || d.slice(8, 10) !== "01" || dated.length < 2) return d;
  const days = daysBetween(dated[0], dated[1]);
  if (Number.isNaN(days)) throw new PyValueError(`Invalid isoformat string: ${pyRepr(Number.isNaN(daysBetween(dated[0], dated[0])) ? dated[0] : dated[1])}`);
  if (days < 28) return d; // daily, weekly, biweekly: the date is the observation itself
  const step = roundHalfEven(days / 30.4);
  if (![1, 3, 6, 12].includes(step)) return d;
  let y = Number(d.slice(0, 4)), mth = Number(d.slice(5, 7)) + step;
  [y, mth] = [y + Math.floor((mth - 1) / 12), ((mth - 1) % 12) + 1];
  return dayBeforeFirst(y, mth);
}

export const TRANSFORM_UNITS: Record<string, string> = { chg: "Change", ch1: "Change from Year Ago", pch: "Percent Change",
  pc1: "Percent Change from Year Ago", pca: "Compounded Annual Rate of Change", cch: "Continuously Compounded Rate of Change",
  cca: "Continuously Compounded Annual Rate of Change", log: "Natural Log" };

/** Federal fiscal-year series: FRED says so in the frequency ("Annual, Fiscal Year"), and the annual OMB/Treasury series
 * it does not label (FYOIGDA188S, FYFSGDA188S ...) start with FY. */
export function isFiscal(m: Meta, sid = ""): boolean {
  const t = ["frequency", "sheet", "title", "notes"].map((k) => pstr(get(m, k, ""))).join(" ");
  if (t.toLowerCase().includes("fiscal year")) return true;
  return sid.toUpperCase().startsWith("FY") && pstr(get(m, "frequency", "")).toLowerCase().startsWith("annual");
}

/** Lines in a text file, as Python's `for _ in open(f)` counts them (universal newlines). */
function lineCount(file: string): number {
  const t = fs.readFileSync(file, "utf8");
  if (!t) return 0;
  const n = t.split(/\r\n|\r|\n/).length;
  return /(\r\n|\r|\n)$/.test(t) ? n - 1 : n;
}

const sha256File = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export type Packaged = { req: Record<string, any>; columns: Record<string, string[]>; meta: Row[] };

export function packageData(pack: Pack, parts: Parts, s: NSpec, out: string, route: string, acquired: string,
  retrieved: string | null = null, n0 = 0): Packaged {
  const P = pack.policy;
  const d = dataDir(out);
  const rawDir = path.join(d, "raw");
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });
  for (const x of parts.raw) {
    const p = path.join(rawDir, x.name);
    if (x.bytes) fs.writeFileSync(p, x.bytes);
    else fs.writeFileSync(p, keys.redact(dumpsIndent({ request: x.request, response: x.response }, 1)));
  }
  const now = retrieved || nowIso();
  const today = localToday();
  const rows: Row[] = [];
  const problems = [...parts.problems];
  for (const [x, obs] of parts.obs) {
    if (!obs.length) problems.push(`${x.id}: no observations returned for ${x.start || "start"} to ${x.end || "latest"}`);
    for (const o of obs) {
      rows.push({ series_id: x.id, label: x.label, variant: tag(x), vintage: o.vintage, date: o.date,
        value: floatCell(o.value), realtime_start: o.realtime_start ?? "", realtime_end: o.realtime_end ?? "" });
    }
  }
  const sk = (r: Row) => [r.series_id, r.variant, r.vintage, r.date].map((v) => pstr(v));
  rows.sort((a, b) => cmpTuple(sk(a), sk(b)));
  const columns: Record<string, string[]> = {};
  columns.fred_observations = writeCsvFile(path.join(d, "fred_observations.csv"), rows,
    ["series_id", "label", "variant", "vintage", "date", "value", "realtime_start", "realtime_end"]);
  const regionalPath = path.join(d, "regional.csv");
  if (parts.regional.length) {
    columns.regional = writeCsvFile(regionalPath, parts.regional.map((r) => ({ ...r,
      value: r.value === null || typeof r.value === "number" ? floatCell(r.value) : r.value })),
    ["group", "label", "title", "date", "region", "code", "series_id", "value", "units", "season", "frequency"]);
  } else fs.rmSync(regionalPath, { force: true });
  for (const [name, key, cols] of [
    ["release_dates", "release_dates", ["release_id", "release_name", "date"]],
    ["release_series", "release_series", ["release_id", "release", "series_id", "title", "units", "frequency",
      "seasonal_adjustment", "last_updated", "copyright_tag", "copyright", "n_obs"]],
    ["release_observations", "release_obs", ["release_id", "series_id", "date", "value"]],
  ] as [string, keyof Parts, string[]][]) {
    const p = path.join(d, `${name}.csv`);
    const list = parts[key] as Row[];
    if (list.length) columns[name] = writeCsvFile(p, list, cols);
    else fs.rmSync(p, { force: true });
  }

  const metaRows: Row[] = [];
  for (const x of s.series) {
    const m: Meta = parts.meta.get(x.id) || {};
    const mine = rows.filter((r) => r.variant === tag(x));
    const dated = [...new Set(mine.map((r) => r.date as string))].sort(cmp); // vintages repeat dates
    const fromApi = m.metadata_source === "api";
    const notes = pyStrip(pstr(truthy(m.notes) ? m.notes : ""));
    const title = get(m, "title", "");
    if (!Object.keys(m).length) problems.push(`${x.id}: no metadata (title, units) could be read; check the ID`);
    const mUnits = get(m, "units", "");
    const u = x.units || "lin";
    const source = truthy(get(m, "source", "")) ? m.source : x.source ?? "";
    metaRows.push({
      series_id: x.id, label: x.label, variant: tag(x),
      vintage: x.vintage.kind + (x.vintage.dates.length ? ":" + x.vintage.dates.join(",") : ""),
      title, units: (u !== "lin" ? (TRANSFORM_UNITS[u] ?? "") + ` (of ${pstr(mUnits)})` : cell(mUnits)) +
        (x.vintage.kind !== "latest" && truthy(mUnits)
          ? " (as FRED labels the series today; this vintage may use an earlier base year or definition)" : ""),
      frequency: get(m, "frequency", ""), seasonal_adjustment: get(m, "seasonal_adjustment", ""),
      last_updated: get(m, "last_updated", ""), fiscal_year: isFiscal(m, x.id) ? 1 : 0, transformation: x.units || "",
      converted_to: x.frequency ? `${x.frequency} (${x.aggregation_method || "avg"})` : "",
      first_date: dated.length ? dated[0] : "", last_date: dated.length ? dated[dated.length - 1] : "",
      n_obs: mine.length, n_missing: mine.filter((r) => r.value === "").length,
      n_future: mine.filter((r) => periodEndIso(r.date, dated) > today).length,
      source, release: get(m, "release", ""),
      copyright: x.copyright || copyrightFromTag(m.copyright_tag) || copyrightStatus(notes, fromApi),
      copyright_basis: truthy(x.copyright_basis) ? x.copyright_basis : truthy(m.copyright_tag)
        ? `series tag "${pstr(m.copyright_tag)}" (FRED API)` : fromApi ? "series notes (FRED API)" : "",
      metadata_source: get(m, "metadata_source", ""),
      citation: citation(x.id, truthy(title) ? pstr(title) : "", truthy(source) ? pstr(source) : "", now),
      notes: [...notes.replace(PY_SPACE, " ")].slice(0, 600).join(""),
    });
  }
  columns.series = writeCsvFile(path.join(d, "series.csv"), metaRows);
  const latest: Record<string, string> = {};
  const byVariant = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!byVariant.has(r.variant)) byVariant.set(r.variant, new Set());
    byVariant.get(r.variant)!.add(r.date);
  }
  const firstTwo = new Map([...byVariant].map(([v, ds]) => [v, [...ds].sort(cmp).slice(0, 2)]));
  for (const r of rows) {
    if (r.value !== "" && (r.vintage === "latest" || r.vintage === "first_release") &&
      periodEndIso(r.date, firstTwo.get(r.variant)!) <= today) { // an in-progress quarter is not data
      const prev = latest[r.variant] ?? "";
      latest[r.variant] = prev > r.date ? prev : r.date;
    }
  }
  const tables: Row[] = [];
  for (const name of ["fred_observations", "series", "regional", "release_dates", "release_series", "release_observations"]) {
    const p = path.join(d, `${name}.csv`);
    if (fs.existsSync(p)) tables.push({ name, file: `${name}.csv`, rows: Math.max(0, lineCount(p) - 1), sha256: sha256File(p) });
  }
  const req: Record<string, any> = { source: SOURCE, fingerprint: fingerprint(s), meta_fingerprint: metaFingerprint(s),
    retrieved: retrieved || now, route, acquired,
    keyless: route !== "api" && ![...parts.meta.values()].some((m) => m.metadata_source === "api"),
    spec: s, requests: parts.calls.map((u) => keys.redact(u)), n_requests: parts.calls.length,
    request_log: trail().slice(n0), tables, notes: parts.notes, problems, latest, rows: rows.length,
    regional_rows: parts.regional.length, release_rows: parts.release_obs.length,
    release_date_rows: parts.release_dates.length,
    policy: { redistribution: P.redistribution.mode, cache: P.cache.mode } };
  fs.writeFileSync(path.join(d, "request.json"), keys.redact(dumpsIndent(req, 2)));
  writeReadme(pack, d, s, metaRows, rows, req);
  return { req, columns, meta: metaRows };
}

const commas = (n: number) => n.toLocaleString("en-US");

export function writeReadme(pack: Pack, d: string, s: { description?: unknown }, meta: Row[], rows: Row[], req: Record<string, any>): void {
  const P = pack.policy;
  const keyless = req.keyless;
  const m0 = (m: Row, k: string) => pstr(m[k] ?? null);
  const lines = [
    `# FRED data: ${truthy(s.description) ? pstr(s.description) : meta.map((m) => m0(m, "series_id")).join(", ")}`,
    "",
    `- Retrieved: ${pol.localStamp(req.retrieved)} (${pstr(req.acquired)}; route \`${pstr(req.route)}\`)`,
    `- Rows: ${commas(rows.length)} in \`fred_observations.csv\` (one per series variant, vintage and date); series ` +
    "details in `series.csv`" + (truthy(req.regional_rows) ? "; GeoFRED cross-sections in `regional.csv`" : ""),
    "- Raw responses: `raw/`; the exact requests (without the key): `request.json`" +
    (truthy(req.release_date_rows) ? "; release calendar in `release_dates.csv`" : "") +
    (truthy(req.release_rows) ? "; whole-release downloads in `release_observations.csv` and `release_series.csv`" : ""),
    "",
    "## Series",
    "| Series ID | Label | Title | Units | Freq | SA | Vintage | Dates | Missing | Future | Updated | Copyright |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...meta.map((m) => `| \`${m0(m, "series_id")}\` | ${m0(m, "label")} | ${m0(m, "title")} | ${m0(m, "units")} | ${m0(m, "frequency")}` +
      `${truthy(m.fiscal_year) && !m0(m, "frequency").toLowerCase().includes("fiscal") ? " (fiscal year)" : ""} | ` +
      `${m0(m, "seasonal_adjustment")} | ${m0(m, "vintage")} | ${m0(m, "first_date")} to ${m0(m, "last_date")} (${m0(m, "n_obs")}) | ` +
      `${m0(m, "n_missing")} | ${m0(m, "n_future")} | ${m0(m, "last_updated")} | ${m0(m, "copyright")} |`),
    "",
    "## Read this before analyzing",
    "- `value` is empty where FRED has no value (`.` in the API): a day without trading, a month not collected " +
    "(October 2025 for the CPI, CPS and LAUS). A change across a gap needs both endpoints.",
    "- **Future dates are projections, not data.** `n_future` > 0 (for example CBO's GDPPOT, NGDPPOT and NROU run 10 " +
    "years ahead): cut those series at the last actual date of the series you compare them with.",
    "- **Fiscal years.** `fiscal_year` = 1 marks federal fiscal-year series (October to September). FRED dates dollar " +
    "amounts at the end of the fiscal year (2025-09-30 = FY2025) and some percent-of-GDP series at January 1 of the fiscal " +
    "year's number (2025-01-01 = FY2025). Use `tsstats.fiscal_year_label`.",
    "- `variant` names any FRED-side conversion (`_pc1`, `_qavg` ...). FRED's own frequency conversion averages whatever " +
    "observations exist, so a quarter with a missing month still gets a value; prefer native-frequency data and " +
    "`tsstats.to_frequency`, which refuses incomplete periods.",
    "- `vintage` is `latest`, an as-of date (ALFRED: the data as published on that date), `first_release`, or for full " +
    "histories the date a value was first published (`realtime_start`).",
  ];
  if (keyless) {
    lines.push("- These data came from FRED's keyless graph downloads: `source` and `copyright` are not known. Read them " +
      "on each series page (links in the citations) before publishing.");
  }
  for (const m of meta) { // FRED posts some series late at the publisher's request (UMCSENT: one month)
    const late = /[^.]*\b(?:delayed|embargoed)\b[^.]*\.?/i.exec(pstr(truthy(m.notes) ? m.notes : ""));
    if (late) {
      lines.push(`- **\`${m0(m, "series_id")}\` reaches FRED late:** "${pyStrip(late[0])}" The publisher's own site has ` +
        "newer values: when the question asks for the latest, read them there, save them in published/ with source_url " +
        "and accessed, and say which month FRED ends on.");
    }
  }
  if (truthy(req.regional_rows)) {
    lines.push("- **`regional.csv` (GeoFRED):** one row per region and date; `units`, `season` and `frequency` as " +
      "requested. `title` is GeoFRED's group title and can name another month than `date` (\"2026 September ... \" for " +
      "2026-08-01 data): trust `date`. The regional series are not in `series.csv`: cite GeoFRED with the group title and " +
      "retrieval date, and the source agency named on any one series page (e.g. BLS LAUS for state unemployment rates); " +
      "recent LAUS months are preliminary.");
  }
  if (truthy(req.notes)) lines.push("", "## Notes", ...req.notes.map((n: string) => `- ${n}`));
  if (truthy(req.problems)) lines.push("", "## Problems", ...req.problems.map((p: string) => `- ${p}`));
  const pre = meta.filter((m) => m.copyright === "preapproval_required");
  lines.push(
    "",
    "## Reading the data",
    "```python",
    "import pandas as pd",
    "df = pd.read_csv('fred_observations.csv', parse_dates=['date'])",
    "w = df[df.vintage == 'latest'].pivot(index='date', columns='variant', values='value')",
    "```",
    "",
    "## Citations",
    ...[...new Set(meta.map((m) => m0(m, "citation")))].map((c) => `- ${c}`),
    "",
    "## FRED terms of use",
    req.route === "api" ? NOTICE : CREDIT,
    "",
    `FRED's terms (${TERMS_URL}, ${LEGAL_URL}) require each user to use their own API key, forbid wholesale downloading ` +
    "and building an archive of FRED content, and ask that each series be cited. Series whose notes carry a copyright " +
    "(`copyright` = preapproval_required) need the owner's permission before they are redistributed; public-domain series " +
    "may be shared with a citation. An `unknown` status must be checked on the series page before the data are shared." +
    (!pre.length ? "" : " **Pre-approval required here:** " + pre.map((m) => `\`${m0(m, "series_id")}\``).join(", ") +
      ": say in the answer that these values may not be republished without the owner's permission."),
    "",
    "## Use and redistribution",
    `Rule: **${P.redistribution.mode}**. ${P.redistribution.why ?? ""} Cache: **${P.cache.mode}** (${P.cache.why ?? ""})`,
  );
  fs.writeFileSync(path.join(d, "README.md"), lines.join("\n") + "\n");
}

// --------------------------------------------------------------------------- ingest uploaded files
const OWN_CSVS = new Set(["fred_observations.csv", "series.csv", "regional.csv", "release_dates.csv", "release_series.csv",
  "release_observations.csv", "data_dictionary.csv"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Package files the user downloaded (graph CSV/XLSX, API JSON as the download scripts or the API route saved them:
 * wrapped as {"request", "response"} or the API's own reply). */
export function ingest(pack: Pack, paths: string[], s: NSpec, out: string, route = "manual_download",
  acquired = "downloaded by the user and uploaded", retrieved: string | null = null): Packaged {
  const files: string[] = [];
  for (const p of paths) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) files.push(...walk(p).sort(cmp));
    else if (fs.existsSync(p)) files.push(p);
    else throw new FredError(`Not found: ${p}`, "request");
  }
  const byTag = new Map(s.series.map((x) => [tag(x), x]));
  const parts = newParts([]);
  const got = new Map<string, Row[]>();
  const apiObs = new Map<string, any[]>(), groups: string[] = [];
  const releasePages = new Map<unknown, [number, any][]>();
  for (const fp of files) {
    const name = path.basename(fp);
    const low = name.toLowerCase();
    const body = fs.readFileSync(fp);
    try {
      if (low.endsWith(".xlsx")) {
        for (const [sid, m] of parseGraphXlsx(body)) {
          m.metadata_source = "fredgraph.xlsx";
          if (!parts.meta.has(sid)) parts.meta.set(sid, m);
        }
        parts.raw.push({ name, request: "uploaded", bytes: body });
      } else if (low.endsWith(".csv") || low.endsWith(".zip")) {
        if (OWN_CSVS.has(name)) continue;
        const cols = parseGraphCsv(body);
        const t = path.parse(name).name.replace(/_p\d+$/, ""); // vintage chunk files <tag>_pN.csv
        const x = byTag.get(t) ?? s.series.find((v) => [...cols.keys()].some((c) => c === v.id || c.startsWith(v.id + "_")));
        if (!x) continue; // no spec series matches its columns: skipped
        if (!got.has(tag(x))) got.set(tag(x), []);
        got.get(tag(x))!.push(...graphRows(x, cols));
        parts.raw.push({ name, request: "uploaded", bytes: body });
      } else if (low.endsWith(".json")) {
        const j = parsePyJson(body.toString("utf8").replace(/^\ufeff/, ""));
        if (!isDict(j) || name === "manifest.json" || name === "request.json") continue;
        const wrapped = has(j, "response");
        const resp: any = wrapped ? j.response : j;
        if (!isDict(resp)) continue;
        parts.raw.push({ name, request: wrapped ? keys.redact(pstr(get(j, "request", ""))) : "uploaded", response: resp });
        if (has(resp, "seriess")) {
          const m = resp.seriess[0];
          m.metadata_source = "api";
          parts.meta.set(pstr(m.id).toUpperCase(), m);
        } else if (has(resp, "observations")) apiObs.set(path.parse(name).name, resp.observations);
        else if (has(resp, "series_group")) groups.push(name);
        else if (has(resp, "release_dates")) parts.release_dates = releaseDateRows(resp);
        else if (has(resp, "series") && has(resp, "release")) { // v2 pages: release_<id>.json, __p02.json, ...
          const m = /__p(\d+)\.json$/.exec(low);
          const rid = (resp.release || {}).release_id ?? null;
          if (!releasePages.has(rid)) releasePages.set(rid, []);
          releasePages.get(rid)!.push([m ? Number(m[1]) : 1, resp]);
        } else parts.regional.push(...regionalRows(resp).map((r) => ({ group: "", label: "", ...r })));
      }
    } catch (e: any) {
      parts.problems.push(`${name}: could not read (${e?.message ?? e})`);
    }
  }
  for (const [rid, pages] of releasePages) {
    const [rel, series] = mergeReleasePages([...pages].sort((a, b) => a[0] - b[0]).map(([, r]) => r));
    const ro = s.release_observations.find((r) => r.release_id === rid) ??
      { release_id: rid as number, series: [], max_pages: pages.length };
    addReleaseRows(parts, ro, rel, series);
  }
  if (groups.length && !parts.regional.length) {
    parts.problems.push(`${groups.join(", ")}: a GeoFRED group lookup but no cross-section; download regional_NN.json ` +
      "(the regional/data reply for that group) too, or give the regional block a series_group, then ingest again");
  }
  for (const [t, obs] of apiObs) {
    const x = byTag.get(t);
    if (x) got.set(t, observationRows(x.id, obs).map((r) => ({ ...r, vintage: vintageLabel(x, r.realtime_start) })));
  }
  for (const x of s.series) {
    if (got.has(tag(x))) parts.obs.push([x, got.get(tag(x))!]);
    else parts.problems.push(`${x.id} (${tag(x)}): no uploaded file holds it`);
  }
  if (!got.size && !parts.regional.length && !parts.release_dates.length && !parts.release_obs.length) {
    throw new FredError("None of the uploaded files holds FRED data for this spec.", "request");
  }
  parts.calls = route === "manual_download" ? pyManualItems(s).map((f) => f.url) : [];
  return packageData(pack, parts, s, out, route, acquired, retrieved);
}

/** Labels, sources or copyright changed in the spec, the data did not: rebuild data/fred/ from data/fred/raw/ without
 * downloading again, keeping the original route and retrieval time. */
export function repackage(pack: Pack, s: NSpec, out: string): Packaged {
  const raw = path.join(dataDir(out), "raw");
  const tmp = path.join(dataDir(out), "_raw_prev");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(raw, tmp, { recursive: true });
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir(out), "request.json"), "utf8"));
    const res = ingest(pack, [tmp], s, out, saved.route ?? "", saved.acquired ?? "", saved.retrieved ?? null);
    res.req.requests = saved.requests ?? [];
    res.req.n_requests = saved.n_requests ?? 0;
    fs.writeFileSync(path.join(dataDir(out), "request.json"), keys.redact(dumpsIndent(res.req, 2)));
    return res;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The header of a CSV written here. */
export function csvColumns(file: string): string[] {
  const first = fs.readFileSync(file, "utf8").split(/\r?\n/)[0];
  return first ? (parse(first) as string[][])[0] ?? [] : [];
}
