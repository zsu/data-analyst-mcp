/**
 * BLS Public Data API client for the bls deep pack (port of sources/bls/bls_api.py).
 *
 * The key comes from core keys (BLS_API_KEY, home "bls") and is never printed. Without a key the client uses API v1
 * (no registration, lower limits); with a key, v2.
 *
 * Limits (https://www.bls.gov/developers/api_faqs.htm, read 2026-10-19):
 *                          v2 (registered)   v1 (no key)
 *     queries per day            500             25
 *     series per query            50             25
 *     years per query             20             10
 * BLS answers HTTP 200 even for most errors: the outcome is in "status" and "message". A rejected key is echoed
 * in the message, so the pack registers a 32-hex redaction pattern.
 */
import { Client, DataError, type ErrorKind } from "../core/http.js";
import * as keys from "../core/keys.js";
import { sleep } from "../core/py.js";

export const URLS = { v1: "https://api.bls.gov/publicAPI/v1/timeseries/data/",
  v2: "https://api.bls.gov/publicAPI/v2/timeseries/data/" } as const;
export type Version = keyof typeof URLS;
export const LIMITS = { v2: { series: 50, years: 20, daily: 500 }, v1: { series: 25, years: 10, daily: 25 } };
export const REGISTER_URL = "https://data.bls.gov/registrationEngine/";
export const AUTH: keys.Auth = { env: "BLS_API_KEY", home: "bls", placement: "body", param: "registrationkey" };
const UA = "data-analyst/1.0 (bls pack; Node.js)";

// BLS echoes a rejected key inside its error message: scrub every 32-hex token as well as known keys.
keys.addPattern(/(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])/, "bls");

export const findApiKey = () => keys.findKey("BLS_API_KEY", "bls");

/** Why a BLS call failed: auth (key rejected or expired), quota (daily limit), network, http, request (BLS refused
 * the request), unavailable (the BLS site is busy or down). */
export type BlsKind = "auth" | "quota" | "network" | "http" | "request" | "unavailable";
const KIND: Record<BlsKind, ErrorKind> = { auth: "auth", quota: "rate", network: "network", http: "http", request: "api",
  unavailable: "http" };

export class BlsError extends DataError {
  constructor(msg: string, public blsKind: BlsKind = "request") {
    super(msg, KIND[blsKind]);
  }
}

export type Plan = [string[], number, number][];

/** Split a request into queries that respect the per-query limits: [(series_chunk, y0, y1), ...]. */
export function planQueries(series: string[], start: number, end: number, version: Version): Plan {
  const lim = LIMITS[version];
  const windows: [number, number][] = [];
  for (let y = start; y <= end; y += lim.years) windows.push([y, Math.min(end, y + lim.years - 1)]);
  const chunks: string[][] = [];
  for (let i = 0; i < series.length; i += lim.series) chunks.push(series.slice(i, i + lim.series));
  return windows.flatMap(([y0, y1]) => chunks.map((c) => [c, y0, y1] as [string[], number, number]));
}

export type BySeries = Map<string, { data: any[]; catalog: any }>;
export type Raw = { request: any; response: any }[];

export class BlsClient {
  key: string | null;
  keySource: string | null;
  version: Version;
  queriesSent = 0;
  http: Client;

  constructor(o: { apiKey?: string | null; useKey?: boolean; timeout?: number } = {}) {
    if (o.apiKey) {
      keys.remember(o.apiKey);
      [this.key, this.keySource] = [o.apiKey, "argument"];
    } else if (o.useKey !== false) [this.key, this.keySource] = findApiKey();
    else [this.key, this.keySource] = [null, null];
    this.version = this.key ? "v2" : "v1";
    // v1 sends no key at all; v2 puts it in the JSON body as registrationkey
    this.http = new Client(URLS[this.version], { name: "bls", auth: this.key ? AUTH : {}, key: this.key, rps: 4, burst: 5,
      retries: 3, timeout: o.timeout ?? 60, userAgent: UA });
  }

  toString(): string {
    return `BlsClient(version=${this.version}, key=[REDACTED])`;
  }
  toJSON(): string {
    return this.toString();
  }

  async post(body: Record<string, unknown>, retries?: number): Promise<any> {
    if (retries !== undefined) this.http.retries = retries;
    let r;
    try {
      r = await this.http.request("POST", URLS[this.version], null, { jsonBody: body }); // full URL: keep the trailing /
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      if (e.status && [500, 502, 503, 504].includes(e.status)) {   // "The BLS website is busy" (HTML page)
        throw new BlsError(`BLS API: HTTP ${e.status}: the BLS site is busy or down (after retries)`, "unavailable");
      }
      const kind = ({ network: "network", rate: "quota", auth: "auth", key_missing: "auth" } as Record<string, BlsKind>)[e.kind] ?? "http";
      throw new BlsError(`BLS API: ${e.message}`, kind);
    }
    let out: any;
    try {
      out = r.body.length ? JSON.parse(r.body.toString("utf8")) : {};
    } catch {
      throw new BlsError(`BLS API answered with something that is not JSON: ${r.text().slice(0, 200)}`, "http");
    }
    this.queriesSent++;
    const status = out.status ?? "";
    const msgs = (out.message || []).map((m: unknown) => keys.withPackScope("bls", () => keys.redact(m)));
    if (status !== "REQUEST_SUCCEEDED") {
      const text = msgs.join(" ") || status;
      const low = text.toLowerCase();
      const kind: BlsKind = low.includes("key") && (low.includes("invalid") || low.includes("expired") || low.includes("not valid")) ? "auth"
        : low.includes("threshold") || low.includes("daily") || low.includes("limit") ? "quota" : "request";
      throw new BlsError(`BLS refused the request (${status}): ${text}`, kind);
    }
    out.message = msgs;
    return out;
  }

  /** Download every series for start..end, split into as many queries as the limits require. v2-only options are
   * dropped on v1. Returns [bySeries, messages, raw (request bodies without the key, and responses)]. */
  async fetch(series0: string[], start: number, end: number, o: { catalog?: boolean; annualaverage?: boolean;
    calculations?: boolean; aspects?: boolean } = {}): Promise<[BySeries, string[], Raw]> {
    const series = series0.map((s) => s.trim().toUpperCase());
    const plan = planQueries(series, start, end, this.version);
    const extras: Record<string, boolean> = {};
    if (this.version === "v2") {
      for (const [k, v] of [["catalog", o.catalog], ["annualaverage", o.annualaverage], ["calculations", o.calculations],
        ["aspects", o.aspects]] as const) if (v) extras[k] = true;
    }
    const by: BySeries = new Map(series.map((s) => [s, { data: [], catalog: null }]));
    const messages: string[] = [];
    const raw: Raw = [];
    for (let i = 0; i < plan.length; i++) {
      const [chunk, y0, y1] = plan[i];
      const body = { seriesid: chunk, startyear: String(y0), endyear: String(y1), ...extras };
      const out = await this.post(body);
      raw.push({ request: body, response: out });
      for (const m of out.message || []) {
        if (m.toLowerCase().includes("reduced to the system-allowed limit")) {
          throw new BlsError(`BLS truncated the year range (${m}); the query plan is wrong`, "request");
        }
        messages.push(m);
      }
      for (const s of out.Results?.series || []) {
        const sid = String(s.seriesID ?? "").toUpperCase();
        if (!by.has(sid)) by.set(sid, { data: [], catalog: null });
        const rec = by.get(sid)!;
        rec.data.push(...(s.data || []));
        if (s.catalog && !rec.catalog) rec.catalog = s.catalog;
      }
      if (i < plan.length - 1 && !process.env.DATA_ANALYST_FIXTURES) await sleep(250); // far below 50 requests per 10 s
    }
    return [by, messages, raw];
  }
}

// ------------------------------------------------------------------ series metadata without a key
export const DESCRIBE_URL = (sid: string) => `https://data.bls.gov/timeseries/${sid}`;
let describeClient: Client | null = null;

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–",
  mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®" };
/** html.unescape for the entities BLS pages use. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (all, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? all;
  });
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const OEWS_TYPES: Record<string, string> = { "01": "employment", "02": "employment percent relative standard error",
  "03": "hourly mean wage", "04": "annual mean wage", "05": "wage percent relative standard error",
  "06": "hourly 10th percentile wage", "07": "hourly 25th percentile wage", "08": "hourly median wage",
  "09": "hourly 75th percentile wage", "10": "hourly 90th percentile wage", "11": "annual 10th percentile wage",
  "12": "annual 25th percentile wage", "13": "annual median wage", "14": "annual 75th percentile wage",
  "15": "annual 90th percentile wage", "16": "employment per 1,000 jobs", "17": "location quotient" };

/** OEWS IDs read by their layout: OE + seasonal + area type + area (7) + industry (6) + SOC (6) + data type (2). */
function oewsDecoded(sid: string, url: string): any {
  const [areaType, area, ind, soc, dt] = [sid[3], sid.slice(4, 11), sid.slice(11, 17), sid.slice(17, 23), sid.slice(23, 25)];
  const where = ({ N: "national", S: "state", M: "metropolitan or nonmetropolitan area" } as Record<string, string>)[areaType];
  const fields: Record<string, string> = { "Area type": where, "Area code": area, "Industry code": ind,
    "Occupation code (SOC)": soc !== "000000" ? `${soc.slice(0, 2)}-${soc.slice(2)}` : "00-0000 (all occupations)",
    "Data type": OEWS_TYPES[dt] ?? `code ${dt} (unknown)` };
  return { series_id: sid, title: `OEWS ${fields["Data type"]}, SOC ${fields["Occupation code (SOC)"]}, ${where} area ${area}`,
    fields, url, note: "decoded from the ID layout: data.bls.gov has no catalog page for OEWS series, so the ID is not " +
      "verified here. A wrong OEWS ID returns no data at fetch time; check the SOC code against the OEWS occupation list (bls.gov/oes)." };
}

/** The describe result from a data.bls.gov series page. */
export function describePage(sid: string, url: string, page: string): any {
  const m = /<table[^>]*catalog[\s\S]*?<\/table>/.exec(page);
  const seg = m ? m[0] : "";
  let cells = [...seg.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((x) => unescapeHtml(x[1].replace(/<[^>]+>/g, " ")).trim());
  cells = cells.filter((c) => c.trim()).map((c) => c.replace(/\s+/g, " "));
  cells = cells.map((c) => c.replace(new RegExp(`^(${esc(sid)})\\s*\\(\\w{1,2}\\)$`), "$1")); // "ID (3)": footnote
  const fields: Record<string, string> = {};
  let seasonal = "";
  cells.forEach((c, i) => {
    if (c.endsWith(":") && i + 1 < cells.length) fields[c.slice(0, -1).trim()] = cells[i + 1];
    if (["seasonally adjusted", "not seasonally adjusted"].includes(c.toLowerCase())) seasonal = c;
  });
  const none = !Object.keys(fields).length;
  if (none && /^OE[US][NSM]\d{7}\d{6}\d{6}\d{2}$/.test(sid)) return oewsDecoded(sid, url);
  if (none && /^C[UW][US][RS]A\d{3}\w+$/.test(sid)) {
    // FRED keeps BLS's pre-2018 metro area codes in its CPI IDs (CUURA101SA0); BLS now uses S-codes
    return { series_id: sid, url, error: "series not found. If the ID came from FRED: FRED keeps " +
      "pre-2018 metro area codes in many CPI IDs (FRED CUURA101SA0 = BLS CUURS12ASA0, New York; " +
      "CUURA207SA0 = CUURS23ASA0, Chicago); take the current area code (here " + sid.slice(4, 8) + ") from " +
      "https://download.bls.gov/pub/time.series/cu/cu.area and check the title" };
  }
  if (none) return { series_id: sid, url, error: "series not found, or the page layout changed" };
  let title = Object.entries(fields).find(([k]) => k.toLowerCase() === "series title")?.[1] ?? "";
  if (!title) title = Object.entries(fields).filter(([k]) => k.toLowerCase() !== "series id").map(([k, v]) => `${k}: ${v}`).join("; ");
  return { series_id: sid, title, seasonal, fields, url };
}

/** Series title and dimensions from https://data.bls.gov/timeseries/<id> (no key, no API query). */
export async function describe(seriesId: string): Promise<any> {
  const sid = seriesId.trim().toUpperCase();
  const url = DESCRIBE_URL(sid);
  describeClient ??= new Client("https://data.bls.gov", { name: "bls-describe", rps: 2, burst: 3, retries: 1, timeout: 30,
    userAgent: "Mozilla/5.0 (data-analyst bls pack)" });
  let page: string;
  try {
    page = (await describeClient.get(url)).text();
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    const err = e.kind === "not_found" ? "series not found" : `${e.kind}: ${e.message}`;
    return { series_id: sid, url, error: err.slice(0, 200) };
  }
  return describePage(sid, url, page);
}
