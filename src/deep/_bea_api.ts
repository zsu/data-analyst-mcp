/**
 * BEA Data API client for the bea deep pack (port of the Python skill's bea_api.py).
 *
 * The key ("UserID" in the URL) comes from core keys (BEA_API_KEY, keys.json, ...); every call goes through the core
 * Client (fixtures, restricted mode, the request trail). BEA echoes the key in every reply, so scrubResponse()
 * removes the echo before anything is saved, and any GUID outside a path segment is redacted.
 *
 * BEA's per-key limits (user guide, 2026): 100 requests, 100 MB and 30 errors a minute; going over any of them
 * blocks the key. This client keeps a 0.75 s floor between calls, waits before a call that could cross 100 MB in
 * the last minute, stops after 30 errors a minute (core error budget) or 10 in one run, never retries an API
 * error code, and turns HTTP 429 into kind "rate_limit" without retrying. Metadata calls are cached for a day
 * under <cache_root>/bea/meta.
 */
import path from "node:path";
import { Cache } from "../core/cache.js";
import { PACKS_DIR, setupCommand } from "../core/env.js";
import { Client, DataError, type ErrorKind } from "../core/http.js";
import * as keys from "../core/keys.js";
import * as pol from "../core/policy.js";
import type { Policy } from "../core/policy.js";
import { parsePyJson, pyJsonDumps, pyStr, sleep } from "../core/py.js";

export const BASE = "https://apps.bea.gov/api/data";
export const KEY_VAR = "BEA_API_KEY";
export const KEY_HOME = "bea";
export const SIGNUP_URL = "https://apps.bea.gov/API/signup/";
export const UA = "Mozilla/5.0 (compatible; data-analyst bea pack)";
const AUTH: keys.Auth = { env: KEY_VAR, home: KEY_HOME, placement: "query", param: "UserID" };

export const MIN_INTERVAL_S = 0.75;
export const MAX_ERRORS_PER_RUN = 10;
export const ERRORS_PER_MIN = 30;
export const BYTES_PER_MIN = 100e6;
const META_METHODS = new Set(["getdatasetlist", "getparameterlist", "getparametervalues", "getparametervaluesfiltered"]);
export const GUID = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";

// A BEA key is a 36-character GUID: redact any GUID in messages, so a key pasted into an uploaded reply cannot leak
// either. A GUID that is a whole path segment (a session or temp folder) is a folder name, not a key.
keys.addPattern(String.raw`(?<![\\/])` + GUID + String.raw`(?![\\/])`, "bea");

let POLICY: Policy | null = null;
export function policy(): Policy {
  return (POLICY ??= pol.load(path.join(PACKS_DIR, "bea")));
}

export function findApiKey(): [string | null, string | null] {
  return keys.findKey(KEY_VAR, KEY_HOME);
}

/** core redact plus BEA's echoed request parameter ("ParameterName": "USERID", "ParameterValue": ...). */
export function redact(text: unknown): string {
  return keys.withPackScope("bea", () => keys.redact(text)).replace(/("ParameterName"\s*:\s*"USERID"\s*,\s*"ParameterValue"\s*:\s*")[^"]*/gi, "$1[REDACTED]");
}

/** A copy of a decoded BEA response with the echoed UserID removed and every string redacted. */
export function scrubResponse(obj: any): any {
  if (Array.isArray(obj)) return obj.map(scrubResponse);
  if (obj && typeof obj === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && k.toLowerCase() === "parametervalue" && pyStr(obj.ParameterName ?? "").toUpperCase() === "USERID") {
        out[k] = "[REDACTED]";
      } else out[k] = scrubResponse(v);
    }
    return out;
  }
  if (typeof obj === "string") return redact(obj);
  return obj;
}

/** The Python BeaError kinds. */
export type BeaKind = "key_missing" | "auth" | "rate_limit" | "budget" | "network" | "api" | "http" | "bad_request" | "other";
const TO_DATA: Record<BeaKind, ErrorKind> = { key_missing: "key_missing", auth: "auth", rate_limit: "rate_limit",
  budget: "rate_limit", network: "network", api: "api", http: "http", bad_request: "bad_request", other: "spec" };

/** A DataError scrubbed of the key, with BEA's own kind (bea) beside the core kind the server maps to a failure. */
export class BeaError extends DataError {
  bea: BeaKind;
  code?: string;
  constructor(msg: string, kind: BeaKind = "other", o: { code?: string; dataKind?: ErrorKind; retryAfter?: number } = {}) {
    super(redact(msg), o.dataKind ?? TO_DATA[kind], undefined, o.retryAfter ?? (kind === "rate_limit" || kind === "budget" ? 60 : undefined));
    this.bea = kind;
    this.code = o.code;
  }
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const truthy = (x: unknown) => (Array.isArray(x) ? x.length > 0 : isObj(x) ? Object.keys(x).length > 0 : !!x);

/** BEA puts errors in BEAAPI.Error or BEAAPI.Results.Error (a dict or a list). */
export function firstError(payload: any): Record<string, any> | null {
  const b = isObj(payload) ? payload.BEAAPI ?? payload : {};
  let res = isObj(b) ? b.Results : undefined;
  if (Array.isArray(res)) res = res.length ? res[0] : {};
  for (const holder of [b, isObj(res) ? res : {}]) {
    let err = isObj(holder) ? holder.Error : undefined;
    if (Array.isArray(err) && err.length) err = err[0];
    if (isObj(err) && Object.keys(err).length) return err;
  }
  return null;
}

/** APIErrorDescription plus ErrorDetail, which can be a string, {Description} or [{Description}]. */
export function errorDetail(err: Record<string, any>): string {
  let desc = pyStr(err.APIErrorDescription || "");
  let d: any = err.ErrorDetail;
  if (Array.isArray(d)) d = d.map((x) => (isObj(x) ? pyStr(x.Description ?? pyJsonDumps(x)) : pyStr(x))).join("; ");
  else if (isObj(d)) d = d.Description || pyJsonDumps(d);
  if (truthy(d)) desc = desc ? `${desc} (${d})` : pyStr(d);
  return desc || pyJsonDumps(err);
}

export function isAuthError(code: string, desc: string): boolean {
  const d = desc.toLowerCase();
  return ["1", "3", "4"].includes(code) || d.includes("userid") || d.includes("user id") || d.includes("api key") || d.includes("not active");
}

/** BEAAPI.Results as a dict: a one-item list is unwrapped, IIP's BEAAPI.Data moved inside, metadata returned whole. */
export function unwrapResults(payload: any): Record<string, any> {
  const b = isObj(payload) ? payload.BEAAPI ?? {} : {};
  let res = b.Results;
  if (Array.isArray(res)) res = res.length ? res[0] : {};
  res = { ...(isObj(res) ? res : {}) };
  if ("Data" in b && !("Data" in res)) res.Data = b.Data;
  if (!Object.keys(res).length && isObj(b)) res = Object.fromEntries(Object.entries(b).filter(([k]) => k !== "Request"));
  return res;
}

export function asList(v: unknown): any[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export const keyLocations = () => keys.keyLocations(KEY_VAR, KEY_HOME);

/** Decode a reply as Python did: utf-8-sig, else iso-8859-1. */
function decodeReply(raw: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/^﻿/, "");
  } catch {
    return raw.toString("latin1");
  }
}

export class BeaClient {
  key: string;
  keySource: string;
  client: Client;
  timeout: number;
  errors = 0;
  calls = 0;
  /** [monotonic seconds, bytes] of replies in the last minute */
  bytes: [number, number][] = [];
  metaCache: Cache;
  /** waits (tests replace it) */
  sleeper: (ms: number) => Promise<void> = sleep;

  toString(): string {
    return "BeaClient(key=[REDACTED])";
  }
  toJSON(): string {
    return this.toString();
  }

  constructor(o: { apiKey?: string | null; timeout?: number; useCache?: boolean } = {}) {
    const timeout = o.timeout ?? 120;
    let key: string | null, src: string | null;
    if (o.apiKey) {
      keys.remember(o.apiKey);
      [key, src] = [o.apiKey, "argument"];
    } else [key, src] = findApiKey();
    if (!key) {
      throw new BeaError("No BEA API key found. Looked in: " + keyLocations().join("; ") + `. Get a free key at ${SIGNUP_URL} ` +
        `(BEA emails it; click the activation link), then store it with \`${setupCommand("bea")}\` in your own terminal.`, "key_missing");
    }
    this.key = key;
    this.keySource = src || "";
    this.client = new Client(BASE, { name: "bea", auth: AUTH, key, rps: 1 / MIN_INTERVAL_S, burst: 1, retries: 0, timeout,
      deadline: timeout * 3, userAgent: UA, errorsPerMin: ERRORS_PER_MIN, bytesPerMin: BYTES_PER_MIN,
      headers: { Accept: "application/json" } });
    this.timeout = timeout;
    try {
      this.metaCache = new Cache(path.join("bea", "meta"), policy(), o.useCache ?? true);
    } catch {
      this.metaCache = new Cache(path.join("bea", "meta"), policy(), false);
    }
  }

  // ---- budgets
  /** Pause before a call that could push the last minute's download over 100 MB (headroom: the largest reply). */
  async waitForBytes(): Promise<void> {
    for (;;) {
      const now = performance.now() / 1000;
      this.bytes = this.bytes.filter(([t]) => now - t < 60);
      const used = this.bytes.reduce((s, [, n]) => s + n, 0);
      const head = Math.max(0, ...this.bytes.map(([, n]) => n));
      if (!this.bytes.length || used + head <= BYTES_PER_MIN * 0.95) return;
      const wait = 60 - (now - this.bytes[0][0]) + 0.5;
      process.stderr.write(`[bea] ${(used / 1e6).toFixed(0)} MB in the last minute: waiting ${wait.toFixed(0)} s to stay under ` +
        "BEA's 100 MB a minute\n");
      await this.sleeper(Math.max(wait, 0.5) * 1000);
    }
  }

  private spendError(): void {
    this.errors++;
    try {
      this.client.errorBudget.spend();
    } catch (e) {
      if (e instanceof DataError) throw new BeaError(e.message, "budget");
      throw e;
    }
  }

  // ---- one call
  /** One API call. Returns BEAAPI.Results (a dict). Throws BeaError with a kind on failure. */
  async request(method: string, params: Record<string, unknown> = {}, o: { retries?: number; cache?: boolean } = {}): Promise<Record<string, any>> {
    const retries = o.retries ?? 2;
    if (this.errors >= MAX_ERRORS_PER_RUN) {
      throw new BeaError(`Stopped after ${this.errors} failed calls in this run, to stay under BEA's limit of 30 errors a ` +
        "minute (going over locks the key out). Fix the request first.", "budget");
    }
    const q: Record<string, unknown> = { method, ResultFormat: "JSON" };
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") q[k] = v;
    const useCache = o.cache ?? META_METHODS.has(method.toLowerCase());
    const ckey = pyJsonDumps(Object.fromEntries(Object.entries(q).map(([k, v]) => [k.toLowerCase(), pyStr(v)])), true);
    if (useCache && this.metaCache.on) {
      const hit = this.metaCache.get(ckey);
      if (hit) {
        try {
          return parsePyJson(hit[0].toString("utf8"));
        } catch {
          /* a bad entry is refetched */
        }
      }
    }
    const shown = `${method} ${redact(pyJsonDumps(params))}`;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.waitForBytes();
      this.calls++;
      let r;
      try {
        r = await this.client.request("GET", "", q, { okStatuses: [200, 429, 500, 502, 503, 504] });
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        if (e.kind === "network") {
          if (attempt < retries && !keys.restricted()) {
            await this.sleeper(5 * 2 ** attempt * 1000);
            continue;
          }
          throw new BeaError(`BEA (apps.bea.gov) could not be reached: ${e.message}`, "network");
        }
        if (e.kind === "rate_limit") throw new BeaError(e.message, "budget");
        if (e.kind === "fixture_missing") throw new BeaError(e.message, "other", { dataKind: "fixture_missing" });
        this.errors++;
        throw new BeaError(`${shown} failed: ${e.message}`, "http");
      }
      this.bytes.push([performance.now() / 1000, r.body.length]);
      if (r.status === 429) {
        this.spendError();
        const retry = r.headers["retry-after"] ?? "unknown";
        throw new BeaError(`HTTP 429 from BEA: the key is rate-limited (Retry-After ${retry} s). BEA allows 100 requests, ` +
          "100 MB and 30 errors a minute. The guide says the block lasts a minute; BEA's own client plans for up to an " +
          "hour. Wait at least Retry-After, then rerun once; retrying during the block extends it.", "rate_limit",
        { retryAfter: Number(retry) || 60 });
      }
      if (r.status >= 500) {
        if (attempt < retries) {
          await this.sleeper(5 * 2 ** attempt * 1000);
          continue;
        }
        this.spendError();
        throw new BeaError(`${shown} failed: HTTP ${r.status}`, "http");
      }
      const raw = r.body;
      if (!raw.toString("latin1").trim()) {
        this.spendError();
        throw new BeaError(`BEA returned an empty reply for ${shown}. That usually means the request timed out on BEA's side ` +
          "(or the UserID was missing): narrow it (fewer years, a GeoFips list instead of COUNTY, one line) and try again.", "api");
      }
      let payload: any;
      try {
        payload = parsePyJson(decodeReply(raw));
      } catch {
        this.spendError();
        throw new BeaError(`BEA returned something that is not JSON for ${shown}: ${JSON.stringify(raw.subarray(0, 300).toString("latin1"))}`,
          "http");
      }
      const err = firstError(payload);
      if (err) {
        this.spendError();
        const code = pyStr(err.APIErrorCode ?? "").trim();
        const desc = errorDetail(err);
        if (isAuthError(code, desc)) {
          throw new BeaError(`BEA rejected the API key: ${desc} (APIErrorCode ${code}). The key may be mistyped or not yet ` +
            `activated (BEA emails an activation link): ${SIGNUP_URL}`, "auth", { code });
        }
        const dl = desc.toLowerCase();
        if (code === "7" || dl.includes("quota") || (dl.includes("limit") && dl.includes("exceed"))) {
          throw new BeaError(`BEA rate limit: ${desc}`, "rate_limit", { code });
        }
        throw new BeaError(`BEA could not answer ${shown}: ${desc} (APIErrorCode ${code})`, "api", { code });
      }
      const res = scrubResponse(unwrapResults(payload));
      if (useCache && this.metaCache.on) this.metaCache.put(ckey, Buffer.from(JSON.stringify(res), "utf8"), { method });
      return res;
    }
    throw new BeaError("unreachable");
  }

  /** One cheap, uncached call (GetDataSetList). Never throws. */
  async ping(): Promise<{ reachable: boolean; auth_ok: boolean | null; kind: string; detail: string }> {
    try {
      await this.request("GetDataSetList", {}, { retries: 1, cache: false });
      return { reachable: true, auth_ok: true, kind: "ok", detail: "" };
    } catch (e) {
      if (!(e instanceof BeaError)) throw e;
      const reachable = e.bea !== "network";
      return { reachable, auth_ok: reachable && e.bea === "auth" ? false : null, kind: e.bea,
        detail: e.message.split("\n")[0].slice(0, 300) };
    }
  }

  // ---- metadata (cached)
  async datasets(): Promise<any[]> {
    return asList((await this.request("GetDataSetList")).Dataset);
  }
  async parameters(dataset: string): Promise<any[]> {
    return asList((await this.request("GetParameterList", { DataSetName: dataset })).Parameter);
  }
  async parameterValues(dataset: string, parameter: string): Promise<any[]> {
    return asList((await this.request("GetParameterValues", { DataSetName: dataset, ParameterName: parameter })).ParamValue);
  }
  async parameterValuesFiltered(dataset: string, target: string, filters: Record<string, unknown>): Promise<any[]> {
    return asList((await this.request("GetParameterValuesFiltered", { DataSetName: dataset, TargetParameter: target, ...filters })).ParamValue);
  }

  // ---- data
  /** GetData: [rows, notes, results-without-Data] (the last holds Dimensions, Statistic, etc.). */
  async getData(dataset: string, params: Record<string, unknown>): Promise<[any[], any[], Record<string, any>]> {
    const res = await this.request("GetData", { DataSetName: dataset, ...params });
    const info = Object.fromEntries(Object.entries(res).filter(([k]) => k !== "Data"));
    return [asList(res.Data), asList(res.Notes), info];
  }
}

/** The code in a GetParameterValues row (attribute names differ by dataset). */
export function valueKey(v: Record<string, any>): string {
  for (const k of ["Key", "TableName", "TableID", "TableNumber", "Code"]) {
    if (v[k] !== null && v[k] !== undefined && v[k] !== "") return pyStr(v[k]);
  }
  return pyStr(Object.values(v)[0] ?? "");
}

// ------------------------------------------------------------------ datasets and their GetData rules
export type DatasetInfo = { required: string[]; about: string; bulk?: boolean; freq_only?: string[]; one_of_many?: [string, string] };
export const DATASETS: Record<string, DatasetInfo> = {
  NIPA: { required: ["TableName", "Frequency", "Year"], bulk: true,
    about: "National income and product accounts; TableName T10101 ...; Frequency A, Q, M; Year list or X" },
  NIUnderlyingDetail: { required: ["TableName", "Frequency", "Year"],
    about: "Underlying detail tables (U20305 ...); lower quality than published aggregates; API only (the flat files hold only the lines shared with published tables)" },
  FixedAssets: { required: ["TableName", "Year"],
    about: "Fixed assets (FAAt101 ...); annual only; updated late August to early October" },
  Regional: { required: ["TableName", "LineCode", "GeoFips"], bulk: true,
    about: "State, county and metro tables (SAGDP9, CAINC1 ...); LineCode ALL allows one GeoFips only" },
  GDPbyIndustry: { required: ["TableID", "Frequency", "Year", "Industry"],
    about: "API TableIDs (1 value added, 5 contributions, 6 shares, 25 real value added); Q from 2005; prefer the keyless workbook codes TVA1xx/TGO1xx/TII1xx" },
  UnderlyingGDPbyIndustry: { required: ["TableID", "Frequency", "Year", "Industry"], freq_only: ["A"],
    about: "More industry detail, annual only (Q is error 206), from 1997" },
  ITA: { required: [], one_of_many: ["Indicator", "AreaOrCountry"],
    about: "International transactions: Indicator (BalGds, BalServ, BalCurrAcct, ExpGds, ImpGds ...), AreaOrCountry (AllCountries = total, All = every area, China ...), Frequency A/QSA/QNSA, Year" },
  IIP: { required: [], one_of_many: ["TypeOfInvestment", "Year"],
    about: "International investment position: TypeOfInvestment (FinAssetsExclFinDeriv, FinLiabsExclFinDeriv, DirInvAssets ...), Component (Pos, ChgPosTrans, ChgPosPrice, ChgPosXRate), Frequency A/QNSA, Year" },
  IntlServTrade: { required: [], one_of_many: ["TypeOfService", "AreaOrCountry"],
    about: "Trade in services, annual: TypeOfService, TradeDirection (Exports, Imports, Balance, SupplementalIns), Affiliation, AreaOrCountry, Year" },
  IntlServSTA: { required: [], about: "Services supplied through affiliates: Channel, Destination, Industry, AreaOrCountry, Year" },
  MNE: { required: ["DirectionOfInvestment", "Classification", "Year"],
    about: "Direct investment (DI) and activities of multinationals (AMNE): DirectionOfInvestment Outward/Inward (DI and AMNE) or State/Parent (AMNE), Classification (Country, Industry, CountryByIndustry); AMNE also needs OwnershipLevel (0/1) and NonBankAffiliatesOnly (0/1)" },
  InputOutput: { required: ["TableID", "Year"],
    about: "Make, use and requirements tables (TableID 56, 57 ...); values change: list them first" },
  APIDatasetMetaData: { required: ["dataset"],
    about: "Release dates and line structure of NIPA, NIUnderlyingDetail and FixedAssets tables (not wrapped in Results)" },
};
const ALL_WORDS = new Set(["all", "allcountries", "x", ""]);

/** The DATASETS name for a dataset written in any case, or null. */
export function datasetName(dataset: unknown): string | null {
  const d = pyStr(dataset).toLowerCase();
  return Object.keys(DATASETS).find((k) => k.toLowerCase() === d) ?? null;
}

/** Problems BEA would answer with an error (each error counts against 30 a minute). */
export function datasetProblems(dataset: string, params: Record<string, unknown>): string[] {
  const probs: string[] = [];
  const name = datasetName(dataset);
  if (!name) return [`unknown dataset ${pyRepr(dataset)}; BEA's datasets are ${Object.keys(DATASETS).join(", ")}`];
  const spec = DATASETS[name];
  const have: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) have[k.toLowerCase()] = pyStr(v);
  for (const p of spec.required) {
    if (!(p.toLowerCase() in have)) probs.push(`${dataset} needs the parameter ${p} (see request_schema for ${name})`);
  }
  if (spec.freq_only && have.frequency) {
    const f = new Set(have.frequency.toUpperCase().split(","));
    if ([...f].some((x) => !spec.freq_only!.includes(x))) probs.push(`${dataset} has frequency ${spec.freq_only.join(", ")} only`);
  }
  if (spec.one_of_many) {
    const [pa, pb] = spec.one_of_many;
    const a = have[pa.toLowerCase()] ?? "", b = have[pb.toLowerCase()] ?? "";
    const manyA = a.includes(",") || ALL_WORDS.has(a.toLowerCase());
    const manyB = b.includes(",") || ALL_WORDS.has(b.toLowerCase());
    if ((a.includes(",") && manyB) || (b.includes(",") && manyA)) {
      probs.push(`${dataset}: several ${pa} values need exactly one specific ${pb} (and vice versa); BEA refuses both lists at once`);
    }
  }
  if (dataset.toLowerCase() === "mne" && ["state", "parent"].includes((have.directionofinvestment ?? "").toLowerCase())) {
    for (const p of ["OwnershipLevel", "NonBankAffiliatesOnly"]) {
      if (!(p.toLowerCase() in have)) probs.push(`MNE AMNE requests (${have.directionofinvestment}) need ${p}`);
    }
  }
  if (dataset.toLowerCase() === "regional" && (have.linecode ?? "").toUpperCase() === "ALL" && (have.geofips ?? "").includes(",")) {
    probs.push("Regional: LineCode ALL allows only one GeoFips");
  }
  return probs;
}

/** Python repr() of a string (for messages). */
export function pyRepr(s: unknown): string {
  const t = pyStr(s);
  return t.includes("'") && !t.includes('"') ? `"${t}"` : `'${t.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// ---------------------------------------------------------------------- key check
/**
 * Key check (the Python setup scripts' verify): one GetDataSetList call with the key. [true, ...] accepted,
 * [false, ...] rejected (codes 1, 3, 4), [null, ...] unclear; no connection throws a network DataError.
 */
export async function verify(key: string): Promise<[boolean | null, string]> {
  let p;
  try {
    p = await new BeaClient({ apiKey: String(key).trim(), timeout: 30, useCache: false }).ping();
  } catch (e) {
    if (e instanceof BeaError) return [null, e.message];
    throw e;
  }
  if (p.kind === "ok") return [true, "BEA accepted the key (GetDataSetList answered)."];
  if (p.kind === "network") throw new DataError(p.detail, "network");
  if (p.kind === "auth") return [false, "BEA rejected the key: it is mistyped, or not activated yet (click the link in BEA's email)."];
  if (p.kind === "rate_limit" || p.kind === "budget") return [null, "BEA is rate-limiting this key right now (HTTP 429); try again in an hour."];
  return [null, p.detail];
}
