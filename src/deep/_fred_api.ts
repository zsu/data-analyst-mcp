/**
 * FRED / ALFRED / GeoFRED client for the fred deep pack (ported from fred_api.py).
 *
 *   FredClient   the FRED API (api.stlouisfed.org) with the user's own key: data, vintages (ALFRED), series
 *                metadata, the release and source behind a series (for the citation), search, GeoFRED regional
 *                cross-sections, the release calendar (release/dates, releases/dates) and whole releases (v2
 *                release/observations, cursor-paged).
 *   Keyless      the CSV and XLSX files that FRED's own graph pages download (fredgraph.csv, .xlsx;
 *                alfredgraph.csv). No key, but no source, notes or copyright status; titles, units, frequency,
 *                seasonal adjustment and the last update come from the XLSX README sheet.
 *
 * The key comes from core keys.findKey("FRED_API_KEY", "fred") and is never shown. FRED v1 takes it as the api_key
 * query parameter, which core http drops from every recorded URL; FRED v2 takes it as "Authorization: Bearer <key>"
 * (checked live 2026-10-20: api_key in the query answers HTTP 401). Every request goes through core http.Client,
 * so offline fixtures, the restricted switch and the request trail apply.
 *
 * Facts checked live on 2026-10-20: a bad key answers HTTP 400 with a JSON error_message naming api_key; the API
 * allows 120 requests a minute; missing values are "." in the API and empty cells in fredgraph.csv; an unknown ID
 * in fredgraph.csv answers 404 with an HTML page; several IDs of mixed frequencies come back as a zip with one CSV
 * per frequency, so one ID is asked per CSV request; a graph download holds at most 12 series (GRAPH_MAX) and
 * silently drops the rest; v2 error bodies arrive gzip-compressed.
 */
import { gunzipSync } from "node:zlib";
import { inspect } from "node:util";
import { parse } from "csv-parse/sync";
import { Client, DataError, type ErrorKind, type Response } from "../core/http.js";
import * as keys from "../core/keys.js";
import { parsePyJson } from "../core/py.js";
import { unzip, xlsxSheets } from "../core/tabular.js";
import { localToday, pstr, pyFloat, pyRepr, pyStrip, urlencodeSafe } from "./_fred_py.js";

export const API = "https://api.stlouisfed.org/fred/";
export const API_V2 = "https://api.stlouisfed.org/fred/v2/";
export const GEO = "https://api.stlouisfed.org/geofred/";
export const GRAPH_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv";
export const GRAPH_XLSX = "https://fred.stlouisfed.org/graph/fredgraph.xlsx";
export const ALFRED_CSV = "https://alfred.stlouisfed.org/graph/alfredgraph.csv";
export const seriesUrl = (sid: string) => `https://fred.stlouisfed.org/series/${sid}`;
export const KEY_URL = "https://fredaccount.stlouisfed.org/apikeys";
export const TERMS_URL = "https://fred.stlouisfed.org/docs/api/terms_of_use.html";
export const LEGAL_URL = "https://fred.stlouisfed.org/legal/";
export const NOTICE = "This product uses the FRED\u00ae API but is not endorsed or certified by the Federal Reserve Bank " +
  "of St. Louis.";
const UA = "data-analyst-mcp/0.1 (fred pack; Node.js)";
/** A FRED graph (and so its CSV/XLSX download) holds at most 12 series; more are silently dropped (checked live 2026-10-20). */
export const GRAPH_MAX = 12;
export const KEY_ENV = "FRED_API_KEY", KEY_HOME = "fred";
const AUTH_V1: keys.Auth = { env: KEY_ENV, home: KEY_HOME, placement: "query", param: "api_key" };
const AUTH_V2: keys.Auth = { env: KEY_ENV, home: KEY_HOME, placement: "header", param: "Authorization", prefix: "Bearer " };
const RPS = 1.8, BURST = 4; // under FRED's 120 requests a minute

export const FREQ_NAMES: Record<string, string> = { d: "Daily", w: "Weekly", bw: "Biweekly", m: "Monthly", q: "Quarterly",
  sa: "Semiannual", a: "Annual" };
export const UNITS = ["lin", "chg", "ch1", "pch", "pc1", "pca", "cch", "cca", "log"];
export const AGGREGATION = ["avg", "sum", "eop"];

export function findApiKey(): [string | null, string | null] {
  return keys.findKey(KEY_ENV, KEY_HOME);
}

/**
 * Why a call failed (the Python FredError kinds), so callers pick the right recovery:
 *   key_missing  no key in any location        auth      FRED rejected the key
 *   network      the host could not be reached  not_found the series (or release, group) does not exist
 *   rate         HTTP 429 after retries         http      any other HTTP error
 *   request      FRED refused the request (a bad parameter)   unavailable  FRED answered with a maintenance page
 */
export type FredKind = "key_missing" | "auth" | "network" | "not_found" | "rate" | "http" | "request" | "unavailable";
const AS_DATA: Record<FredKind, ErrorKind> = { key_missing: "key_missing", auth: "auth", network: "network",
  not_found: "not_found", rate: "rate", http: "http", request: "bad_request", unavailable: "http" };

/** An error whose message is always scrubbed of the key; fk is the Python kind, kind the core one. */
export class FredError extends DataError {
  fk: FredKind;
  constructor(msg: string, fk: FredKind = "request") {
    super(msg, AS_DATA[fk]);
    this.fk = fk;
  }
}

/** The kinds a fetch does not turn into a per-series problem: the whole run stops. */
export const FATAL = new Set<FredKind>(["auth", "network", "rate", "unavailable"]);
export const isFatal = (e: unknown) => e instanceof FredError && FATAL.has(e.fk);

function wrap(e: DataError, what: string): FredError {
  const kind: FredKind = e.kind === "network" ? "network" : e.kind === "rate" || e.kind === "rate_limit" ? "rate"
    : e.kind === "not_found" ? "not_found" : e.kind === "auth" ? "auth" : e.kind === "key_missing" ? "key_missing" : "http";
  return new FredError(`${what}: ${e.message}`, kind);
}

function text(body: Buffer): string {
  if (body[0] === 0x1f && body[1] === 0x8b) { // FRED v2 sends gzip error bodies unasked
    try {
      body = gunzipSync(body);
    } catch {
      /* keep as is */
    }
  }
  return body.toString("utf8").replace(/^\ufeff/, "");
}

/** FRED's "." (API) and "" (CSV) mean no value. */
export function parseValue(v: unknown): number | null {
  const s = pyStrip(v === null || v === undefined ? "" : pstr(v));
  if (["", ".", "#N/A", "NA"].includes(s)) return null;
  return pyFloat(s.replaceAll(",", ""));
}

/** FRED's terms: copyrighted series contain the word "Copyright" in their notes. Without the API's notes (the
 * keyless route) the status is unknown and must be checked on the series page. */
export function copyrightStatus(notes: string | null | undefined, fromApi: boolean): string {
  if (!fromApi) return "unknown";
  if (notes && /copyright/i.test(notes)) return "copyrighted";
  return "no_copyright_notice";
}

/** The copyright tag in a series/tags reply (group "cc"): the series page's "Copyrighted: Citation Required" label.
 * Series notes often say nothing about copyright (T10Y2Y), so the tag is the record. */
export function copyrightTagOf(tags: any): string {
  for (const t of (tags || {}).tags || []) {
    const n = pstr(t.name ?? "").toLowerCase();
    if (t.group_id === "cc" || n.startsWith("copyrighted") || n.startsWith("public domain")) return t.name ?? "";
  }
  return "";
}

/** FRED v2's copyright_id ("public domain: citation requested", "copyrighted: citation required", "copyrighted:
 * pre-approval required") -> the spec's labels. */
export function copyrightFromTag(tag: string | null | undefined): string {
  const t = (tag || "").toLowerCase();
  if (t.includes("pre-approval") || t.includes("preapproval")) return "preapproval_required";
  if (t.startsWith("copyrighted")) return "citation_required";
  if (t.startsWith("public domain")) return "public_domain";
  return "";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];

/** The user's calendar day of a retrieval stamp (an evening in the U.S. is tomorrow in UTC); null if not a stamp. */
function longDay(retrieved: string): string | null {
  const s = retrieved.replaceAll("Z", "+00:00");
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:\.\d+)?)?)?(?:([+-]\d{2}):?(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  let y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (m[7]) {
    const sign = m[7].startsWith("-") ? -1 : 1;
    const off = sign * (Math.abs(Number(m[7])) * 60 + Number(m[8] || 0));
    const t = Date.UTC(y, mo - 1, d, Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)) - off * 60000;
    const local = new Date(t);
    [y, mo, d] = [local.getFullYear(), local.getMonth() + 1, local.getDate()];
  }
  return `${MONTHS[mo - 1]} ${d}, ${y}`;
}

/** FRED's suggested citation: "<Source>, <Title> [ID], retrieved from FRED, Federal Reserve Bank of St. Louis; <url>,
 * <Month D, YYYY>." */
export function citation(sid: string, title: string, source: string, retrieved: string): string {
  const when = longDay(String(retrieved)) ?? String(retrieved);
  const lead = source ? `${source}, ` : "";
  return `${lead}${title || sid} [${sid}], retrieved from FRED, Federal Reserve Bank of St. Louis; ${seriesUrl(sid)}, ${when}.`;
}

type Getter = { get(url: string, params?: Record<string, unknown> | null, o?: any): Promise<Response> };

// ------------------------------------------------------------------ the API
export class FredClient {
  key: string;
  keySource: string | null;
  http: Client;
  http2: Client;
  /** credential-free URLs, for request.json */
  calls: string[] = [];

  constructor(apiKey?: string | null, timeout = 60) {
    let src: string | null;
    let key: string | null;
    if (apiKey) {
      keys.remember(apiKey);
      [key, src] = [apiKey, "argument"];
    } else [key, src] = findApiKey();
    if (!key) {
      throw new FredError(`No ${KEY_ENV} key found. Get a free key at ${KEY_URL}, then store it with the setup command ` +
        "(npx -y data-analyst-mcp setup fred); it writes keys.json, which this server reads at once.", "key_missing");
    }
    this.key = key;
    this.keySource = src;
    this.http = new Client(API, { name: "fred", auth: AUTH_V1, key, rps: RPS, burst: BURST, timeout, userAgent: UA });
    this.http2 = new Client(API_V2, { name: "fred-v2", auth: AUTH_V2, key, rps: RPS, burst: BURST, timeout, userAgent: UA });
    Object.defineProperty(this, "key", { enumerable: false });
  }

  toString(): string {
    return "FredClient(key=[REDACTED])";
  }
  toJSON(): string {
    return this.toString();
  }
  [inspect.custom](): string {
    return this.toString();
  }

  async json(client: Getter, url: string, params: Record<string, unknown>, what: string): Promise<any> {
    let r: Response;
    try {
      r = await client.get(url, params, { okStatuses: [200, 400, 401, 403, 404] });
    } catch (e) {
      if (e instanceof DataError) throw wrap(e, what);
      throw e;
    }
    this.calls.push(r.url);
    const t = text(r.body);
    let j: any;
    try {
      j = t.trim() ? parsePyJson(t) : {};
    } catch {
      if (t.trimStart().startsWith("<")) { // a maintenance or error page, not an API answer
        throw new FredError(`${what}: FRED answered with an HTML page (HTTP ${r.status}) instead of data: the service is ` +
          "probably down for maintenance; try again later", "unavailable");
      }
      j = {};
    }
    const obj = j && typeof j === "object" && !Array.isArray(j) ? j : {};
    if (r.status === 200 && !("error_code" in obj)) return j;
    const msg = pstr(obj.error_message || obj.message || t.slice(0, 300));
    const low = msg.toLowerCase();
    if (r.status === 401 || r.status === 403 || (low.includes("api_key") && (low.includes("not registered") ||
      low.includes("not set") || low.includes("invalid")))) {
      throw new FredError(`FRED rejected the API key: ${msg}`, "auth");
    }
    if (low.includes("does not exist") || r.status === 404) throw new FredError(`${what}: ${msg}`, "not_found");
    throw new FredError(`${what} failed (HTTP ${r.status}): ${msg}`, r.status === 400 ? "request" : "http");
  }

  get(p: string, params: Record<string, unknown> = {}, base = API): Promise<any> {
    const q: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") q[k] = v;
    q.file_type = "json";
    return this.json(this.http, base + p, q, p);
  }

  /** One small call. Returns {auth_ok, kind, detail}; never throws. */
  async ping(): Promise<{ auth_ok: boolean; kind: string; detail: string }> {
    try {
      await this.get("series", { series_id: "GNPCA" });
      return { auth_ok: true, kind: "ok", detail: "" };
    } catch (e: any) {
      return { auth_ok: false, kind: e instanceof FredError ? e.fk : "http", detail: String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 300) };
    }
  }

  // -- metadata
  async series(sid: string, rt: Record<string, unknown> = {}): Promise<any> {
    const r = await this.get("series", { series_id: sid, ...rt });
    const s = (r.seriess && r.seriess.length ? r.seriess : [{}])[0];
    if (!s || !Object.keys(s).length) throw new FredError(`series ${sid}: no metadata returned`, "not_found");
    return s;
  }

  async releaseOf(sid: string): Promise<any> {
    const r = await this.get("series/release", { series_id: sid });
    return (r.releases && r.releases.length ? r.releases : [{}])[0];
  }

  async releaseSources(releaseId: unknown): Promise<any[]> {
    return (await this.get("release/sources", { release_id: releaseId })).sources || [];
  }

  async vintagedates(sid: string): Promise<string[]> {
    const out: string[] = [];
    let offset = 0;
    for (;;) {
      const r = await this.get("series/vintagedates", { series_id: sid, realtime_start: "1776-07-04",
        realtime_end: "9999-12-31", limit: 10000, offset });
      const got: string[] = r.vintage_dates || [];
      out.push(...got);
      if (got.length < 10000) return out;
      offset += got.length;
    }
  }

  async search(text: string, limit = 25, orderBy = "popularity", filters: Record<string, unknown> = {}): Promise<any[]> {
    const r = await this.get("series/search", { search_text: text, limit, order_by: orderBy, sort_order: "desc", ...filters });
    return r.seriess || [];
  }

  // -- data
  /** All observations (paged by 100,000). Params as the API names them: observation_start, units, frequency,
   * aggregation_method, realtime_start, realtime_end, vintage_dates, output_type. */
  async observations(sid: string, params: Record<string, unknown> = {}): Promise<any[]> {
    const out: any[] = [];
    let offset = 0;
    for (;;) {
      const r = await this.get("series/observations", { series_id: sid, limit: 100000, offset, ...params });
      const got: any[] = r.observations || [];
      out.push(...got);
      if (got.length < 100000) return out;
      offset += got.length;
    }
  }

  async seriesGroup(sid: string): Promise<any> {
    return (await this.get("series/group", { series_id: sid }, GEO)).series_group || {};
  }

  /** geofred/regional/data: series_group, region_type, date, season, units are required. */
  regional(params: Record<string, unknown>): Promise<any> {
    return this.get("regional/data", params, GEO);
  }

  // -- releases
  /** Release calendar, scheduled future dates included. One release: its dates from start (default today) on; all
   * releases: the dates between start and end (default the next 14 days). */
  async releaseDates(releaseId: number | null, start?: string | null, end?: string | null, limit = 10000): Promise<any> {
    start = start || localToday();
    if (!end) end = releaseId ? "9999-12-31" : localToday(14);
    const p = { realtime_start: start, realtime_end: end, include_release_dates_with_no_data: "true", sort_order: "asc" };
    const [pth, extra] = releaseId ? ["release/dates", { release_id: releaseId }] : ["releases/dates", {}];
    let j: any = {};
    const got: any[] = [];
    while (got.length < limit) { // paged by offset; FRED's count says how many exist
      const page = await this.get(pth, { ...extra, ...p, limit: Math.min(10000, limit - got.length),
        ...(got.length ? { offset: got.length } : {}) });
      j = page;
      got.push(...(page.release_dates || []));
      if (!(page.release_dates || []).length || got.length >= Number(page.count || 0)) break;
    }
    return { ...j, offset: 0, limit, release_dates: got };
  }

  /** FRED v2 release/observations: every series of a release with its observations, paged by cursor. Returns
   * [release, series] and stops after maxPages pages (has_more / next_cursor recorded in the release). limit is
   * observations per page (FRED allows up to 500,000). */
  async releaseObservations(releaseId: number, limit = 10000, maxPages = 5, nextCursor: string | null = null): Promise<[any, any[]]> {
    let release: any = {};
    const series: any[] = [];
    let cursor = nextCursor;
    for (let i = 0; i < Math.max(1, maxPages); i++) {
      const p: Record<string, unknown> = { release_id: releaseId, format: "json", limit };
      if (cursor) p.next_cursor = cursor;
      const j = await this.json(this.http2, API_V2 + "release/observations", p, "v2 release/observations");
      if (!Object.keys(release).length) release = { ...(j.release || {}) };
      for (const x of j.series || []) { // a page can end inside a series: the next page continues it
        if (series.length && series[series.length - 1].series_id === x.series_id) {
          const last = series[series.length - 1];
          last.observations = [...(last.observations || []), ...(x.observations || [])];
        } else series.push({ ...x });
      }
      cursor = j.has_more ? j.next_cursor : null;
      Object.assign(release, { has_more: !!cursor, next_cursor: cursor || "" });
      if (!cursor) break;
    }
    return [release, series];
  }
}

export type ObsRow = { date: string; value: number | null; realtime_start: string; realtime_end: string; [k: string]: any };

/** API observations -> rows {date, value, realtime_start, realtime_end}. output_type 2/3 put each vintage in a column
 * named <ID>_<YYYYMMDD>; those become one row per vintage with realtime_start = the vintage. */
export function observationRows(sid: string, obs: any[]): ObsRow[] {
  const rows: ObsRow[] = [];
  const esc = sid.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const re = new RegExp(`^_?${esc}_(\\d{8})$`, "i");
  for (const o of obs) {
    if ("value" in o) {
      rows.push({ date: o.date ?? "", value: parseValue(o.value), realtime_start: o.realtime_start ?? "",
        realtime_end: o.realtime_end ?? "" });
      continue;
    }
    for (const [k, v] of Object.entries(o)) {
      const m = re.exec(k);
      if (m) {
        const d = m[1];
        rows.push({ date: o.date ?? "", value: parseValue(v), realtime_start: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`,
          realtime_end: "" });
      }
    }
  }
  return rows;
}

const isDict = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function regionItem(it: any): Record<string, unknown> {
  return { region: it.region ?? "", code: pstr("code" in it ? it.code : ""), series_id: it.series_id ?? "",
    value: parseValue(it.value) };
}

/** geofred regional/data JSON ({title: {date: [{region, code, value, series_id}]}}) -> flat rows. */
export function regionalRows(payload: any): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const meta = isDict(payload.meta) ? payload.meta : null;
  const body = meta && isDict(meta.data) ? meta.data : payload;
  const title = (meta || {}).title ?? "";
  for (const [k, v] of Object.entries<any>(body)) {
    if (isDict(v)) { // {title: {date: [...]}}
      for (const [d, items] of Object.entries<any>(v)) for (const it of items || []) rows.push({ title: k, date: d, ...regionItem(it) });
    } else if (Array.isArray(v) && /^\d{4}/.test(k)) { // {date: [...]} under meta
      for (const it of v) rows.push({ title, date: k, ...regionItem(it) });
    }
  }
  return rows;
}

// ------------------------------------------------------------------ keyless downloads
export type GraphKw = { start?: string | null; end?: string | null; frequency?: string | null;
  aggregation_method?: string | null; units?: string | null; vintage_dates?: string[] | null };

/** Query parameters of FRED's graph download. Several vintages of one series are asked as repeated IDs with one
 * vintage_date each (checked live: alfredgraph returns one <ID>_<YYYYMMDD> column per vintage). */
export function graphParams(sid: string, kw: GraphKw = {}): Record<string, string> {
  const n = Math.max(1, (kw.vintage_dates || []).length);
  const rep = (v: string) => Array(n).fill(v).join(",");
  const p: Record<string, string> = { id: rep(sid) };
  if (kw.start) p.cosd = rep(kw.start);
  if (kw.end) p.coed = rep(kw.end);
  if (kw.frequency) {
    p.fq = rep(FREQ_NAMES[kw.frequency] ?? kw.frequency);
    p.fam = rep(kw.aggregation_method || "avg");
  }
  if (kw.units && kw.units !== "lin") p.transformation = rep(kw.units);
  if (kw.vintage_dates?.length) p.vintage_date = kw.vintage_dates.join(",");
  return p;
}

export function graphUrl(sid: string, kw: GraphKw = {}): string {
  const base = kw.vintage_dates?.length ? ALFRED_CSV : GRAPH_CSV;
  return `${base}?${urlencodeSafe(graphParams(sid, kw))}`;
}

export type Point = { date: string; value: number | null };

/** fredgraph.csv / alfredgraph.csv (or the zip FRED sends for mixed frequencies) -> {column: [{date, value}]}. Columns
 * are the series ID, <ID>_<TRANSFORM> or <ID>_<YYYYMMDD> (a vintage). */
export function parseGraphCsv(data: Buffer): Map<string, Point[]> {
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const out = new Map<string, Point[]>();
    for (const [n, b] of Object.entries(unzip(data))) {
      if (n.toLowerCase().endsWith(".csv")) for (const [k, v] of parseGraphCsv(Buffer.from(b))) out.set(k, v);
    }
    return out;
  }
  const t = data.toString("utf8").replace(/^\ufeff/, "");
  if (t.trimStart().startsWith("<")) throw new FredError("FRED returned an HTML page instead of CSV (unknown series ID?)", "not_found");
  let grid: string[][];
  try {
    grid = parse(t, { relax_column_count: true, relax_quotes: true, skip_empty_lines: false });
  } catch (e: any) {
    throw new FredError(`not a FRED graph CSV (${e?.message ?? e})`, "request");
  }
  const head = grid[0] || [];
  if (!head.length || !["observation_date", "date"].includes(pyStrip(head[0]).toLowerCase())) {
    throw new FredError(`not a FRED graph CSV (header ${pyRepr(head.slice(0, 3))})`, "request");
  }
  const cols = head.slice(1).map(pyStrip);
  const out = new Map<string, Point[]>(cols.map((c) => [c, []]));
  for (const row of grid.slice(1)) {
    if (!row.length || !pyStrip(row[0])) continue;
    const date = pyStrip(row[0]).slice(0, 10);
    for (let i = 0; i < Math.min(cols.length, row.length - 1); i++) out.get(cols[i])!.push({ date, value: parseValue(row[i + 1]) });
  }
  return out;
}

export type Meta = Record<string, any>;

/** 'Federal Outlays: Interest, Millions of Dollars, Annual, Not Seasonally Adjusted' -> parts. The title can contain
 * commas, so the parts are taken from the right: seasonal adjustment, frequency, units. */
export function splitDescription(desc: string, updated: string): Meta {
  const parts = desc.split(",").map(pyStrip);
  const seas = parts.length && parts[parts.length - 1].toLowerCase().includes("season") ? parts.pop()! : "";
  let freq = "";
  if (parts.length && /^(daily|weekly|biweekly|monthly|quarterly|semiannual|annual)/i.test(parts[parts.length - 1])) {
    freq = parts.pop()!;
    if (freq.toLowerCase() === "annual" && parts.length && parts[parts.length - 1].toLowerCase().startsWith("fiscal")) {
      freq = "Annual, " + parts.pop()!;
    }
  }
  const [title, units] = parts.length > 1 ? [parts.slice(0, -1).join(", "), parts[parts.length - 1]] : [parts.join(", "), ""];
  const m = /(\d{4}-\d{2}-\d{2})/.exec(updated);
  return { title, units, frequency: freq, seasonal_adjustment: seas, last_updated: m ? m[1] : "", description: desc };
}

/** fredgraph.xlsx -> metadata {id: {title, units, frequency, seasonal_adjustment, last_updated}}. The README sheet
 * lists one line per series: 'ID', 'Title, Units, Frequency, Seasonal adjustment', 'Data Updated: YYYY-MM-DD'; a data
 * sheet holding the series names its frequency ("sheet"). */
export function parseGraphXlsx(data: Buffer): Map<string, Meta> {
  const sheets = xlsxSheets(data);
  const meta = new Map<string, Meta>();
  for (const [name, rows] of Object.entries(sheets)) {
    if (name.toLowerCase() === "readme") {
      for (const r of rows) {
        if (r.length >= 2 && r[0] && r[1] && /^[A-Z0-9_.\-]+$/.test(String(r[0]))) {
          meta.set(String(r[0]), splitDescription(String(r[1]), r.length > 2 ? String(r[2] || "") : ""));
        }
      }
      continue;
    }
    if (!rows.length) continue;
    for (const sid of rows[0].slice(1).map((h) => String(h ?? ""))) if (meta.has(sid)) meta.get(sid)!.sheet = name;
  }
  return meta;
}

export class Keyless {
  http: Client;
  calls: string[] = [];

  constructor(timeout = 60) {
    this.http = new Client("", { name: "fred-graph", rps: RPS, burst: BURST, timeout, userAgent: UA });
  }

  private async getUrl(url: string): Promise<[Buffer, Record<string, string>]> {
    let r: Response;
    try {
      r = await this.http.get(url, null, { okStatuses: [200], allow404: true });
    } catch (e) {
      if (e instanceof DataError) throw wrap(e, url.split("?")[0]);
      throw e;
    }
    this.calls.push(r.url);
    const html = r.body.toString("latin1").replace(/^[\t\n\v\f\r ]+/, "").startsWith("<");
    if (r.status !== 404 && html && /maintenance|unavailable|try again/i.test(r.body.subarray(0, 20000).toString("latin1"))) {
      throw new FredError(`${url}: FRED answered with a maintenance page (HTTP ${r.status}); try again later`, "unavailable");
    }
    if (r.status === 404 || html) {
      throw new FredError(`${url}: no such series on FRED (HTTP ${r.status}, an HTML page came back)`, "not_found");
    }
    return [r.body, r.headers];
  }

  async csv(sid: string, kw: GraphKw = {}): Promise<[Map<string, Point[]>, Buffer, string]> {
    const [body, headers] = await this.getUrl(graphUrl(sid, kw));
    return [parseGraphCsv(body), body, headers["last-modified"] || ""];
  }

  /** Titles, units, frequency, seasonal adjustment and last update for up to GRAPH_MAX IDs per request. */
  async metadata(ids: string[]): Promise<[Map<string, Meta>, Buffer]> {
    if (ids.length > GRAPH_MAX) throw new Error(`at most ${GRAPH_MAX} IDs per graph download (FRED drops the rest silently)`);
    const [body] = await this.getUrl(`${GRAPH_XLSX}?${urlencodeSafe({ id: ids.join(",") })}`);
    return [parseGraphXlsx(body), body];
  }
}

// ---------------------------------------------------------------------- key check (the setup command)
export type KeyReply = { status: number; body: Buffer };

/** Key check: GET series?series_id=GNPCA with the key; HTTP 200 = accepted, HTTP 400 whose body names api_key =
 * rejected. Network errors throw DataError(kind "network"). The key is never shown (the client drops api_key from
 * every recorded URL; details are redacted). `get` replaces the HTTP call (tests). */
export async function verify(key: string, get?: () => Promise<KeyReply>): Promise<[boolean | null, string]> {
  const r = get ? await get() : await new Client(API, { name: "fred-keycheck", auth: AUTH_V1, key, rps: RPS, retries: 1,
    timeout: 30, userAgent: UA }).get("series", { series_id: "GNPCA", file_type: "json" }, { okStatuses: [200, 400, 401, 403] });
  const body = r.body.toString("utf8").toLowerCase();
  if (r.status === 200 && body.trimStart().startsWith("<")) {
    return [null, "FRED answered with an HTML page (maintenance?): the key could not be checked; try again later."];
  }
  if (r.status === 200) return [true, "FRED accepted the key."];
  if (r.status === 400 && body.includes("api_key")) return [false, keys.redact(`FRED rejected the key (HTTP 400): ${body.slice(0, 200)}`)];
  return [null, keys.redact(`FRED answered HTTP ${r.status}; the key may still be valid: ${body.slice(0, 200)}`)];
}
