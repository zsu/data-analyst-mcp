/**
 * One HTTP client for every source pack.
 *
 *   const c = new Client("https://api.example.gov/v1", { name: "example", auth: { env: "EXAMPLE_KEY",
 *     placement: "query", param: "api_key" }, rps: 5, burst: 10 });
 *   const data = await c.getJson("/series", { id: "X" });
 *
 * - auth: the key goes where policy.json says (query parameter, header with optional prefix, or JSON body field);
 *   it is read at call time and never appears in a message, a recorded URL or a cache key.
 * - a token bucket per host (rps, burst), optional per-minute error and byte budgets (BEA locks keys out).
 * - retries on 429/500/502/503/504 and network errors with jittered exponential backoff; Retry-After is honoured
 *   up to MAX_RETRY_AFTER seconds, beyond that the call fails at once (kind "rate", with retryAfter set).
 * - redirects are followed by hand so credentials never go to another host or from https to http.
 * - checkError(status, body) catches APIs that answer HTTP 200 with an error.
 * - every request is recorded (credential-free URL, status, bytes, sha256) in the call's trail (context.ts).
 * - DATA_ANALYST_FIXTURES=<dir> serves responses from <dir>/index.json (offline tests;
 *   the recorded fixture format); DATA_ANALYST_RECORD=<dir> records live responses; DATA_ACCESS_FORCE=restricted
 *   makes every request a network error.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { trail } from "./context.js";
import * as keys from "./keys.js";
import { parseQsl, parsePyJson, pyJsonDumps, pyUrlencode, sleep, urlsplit, urlunsplit } from "./py.js";

export const UA = "data-analyst-mcp/0.1 (Node.js)"; // no URL: SEC refuses User-Agents that contain one
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "cookie"];
export const RETRYABLE = new Set([429, 500, 502, 503, 504]);
export const MAX_RETRY_AFTER = 20;
export const MAX_FIXTURE = 200_000;

export type ErrorKind = "key_missing" | "auth" | "network" | "not_found" | "rate" | "rate_limit" | "bad_request" |
  "api" | "http" | "fixture_missing" | "blocked" | "install_deps" | "spec" | "unexpected";

/** An error whose message is always scrubbed of keys; kind tells the caller which recovery applies. */
export class DataError extends Error {
  kind: ErrorKind;
  status?: number;
  retryAfter?: number;
  constructor(msg: string, kind: ErrorKind = "http", status?: number, retryAfter?: number) {
    super(keys.redact(msg));
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function htmlPage(body: Buffer): boolean {
  const head = body.subarray(0, 300).toString("latin1").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<html");
}

/** A short, redacted excerpt of an error body; an HTML error page is reduced to its <title>. */
export function errorSnippet(body: Buffer, limit = 400): string {
  const text = keys.redact(body.subarray(0, 20000).toString("utf8")).trim();
  const head = text.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<html")) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    const title = m ? m[1].split(/\s+/).filter(Boolean).join(" ") : "";
    return title ? `HTML page: ${title.slice(0, 200)}` : "HTML error page (no title)";
  }
  return text.slice(0, limit);
}

export class Response {
  constructor(public status: number, public headers: Record<string, string>, public body: Buffer,
    public url: string, public cached = false) {}
  text(): string {
    return this.body.toString("utf8").replace(/^﻿/, "");
  }
  json<T = any>(): T {
    return parsePyJson<T>(this.text());
  }
}

class TokenBucket {
  rate: number; cap: number; tokens: number; t: number;
  chain: Promise<void> = Promise.resolve();
  constructor(rps: number, burst: number) {
    this.rate = Math.max(rps, 0.01);
    this.cap = Math.max(burst, 1);
    this.tokens = this.cap;
    this.t = performance.now() / 1000;
  }
  take(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const now = performance.now() / 1000;
        this.tokens = Math.min(this.cap, this.tokens + (now - this.t) * this.rate);
        this.t = now;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await sleep(((1 - this.tokens) / this.rate) * 1000);
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** Per-minute budget (errors or bytes). spend() throws once the limit would be crossed. */
class Budget {
  events: [number, number][] = [];
  constructor(public limit: number | null | undefined, public what: string) {}
  spend(n = 1): void {
    if (!this.limit) return;
    const now = performance.now() / 1000;
    this.events = this.events.filter(([t]) => now - t < 60);
    if (this.events.reduce((s, [, v]) => s + v, 0) + n > this.limit) {
      throw new DataError(`stopped before the source's limit of ${this.limit} ${this.what} a minute was crossed (the API ` +
        "locks keys out above it); wait a minute and run again", "rate_limit", undefined, 60);
    }
    this.events.push([now, n]);
  }
}

/** URL without credentials: secret query parameters dropped, known keys redacted. */
export function cleanUrl(url: string, secretParams: string[] = []): string {
  const parts = urlsplit(url);
  const drop = new Set(secretParams.map((p) => p.toLowerCase()));
  const q = parseQsl(parts.query).filter(([k]) => !drop.has(k.toLowerCase()));
  return keys.redact(urlunsplit({ ...parts, query: pyUrlencode(q) }));
}

function norm(u: string): string {
  const p = urlsplit(u);
  const pairs = parseQsl(p.query).sort((a, b) => (a[0] + "\0" + a[1] < b[0] + "\0" + b[1] ? -1 : 1));
  return urlunsplit({ ...p, query: "" }) + "\n" + JSON.stringify(pairs);
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function fixture(method: string, url: string, body: Buffer | null): Response {
  const d = process.env.DATA_ANALYST_FIXTURES as string;
  const idx: Record<string, any> = JSON.parse(fs.readFileSync(path.join(d, "index.json"), "utf8"));
  const key = `${method} ${url}`;
  let hit = idx[key];
  if (hit === undefined && body) hit = idx[`${key} ${sha(body).slice(0, 12)}`];
  if (hit === undefined) {
    const want = norm(url);
    for (const [k, v] of Object.entries(idx)) {
      const i = k.indexOf(" ");
      if (k.slice(0, i) === method && norm(k.slice(i + 1).split(" ")[0]) === want) {
        hit = v;
        break;
      }
    }
  }
  if (hit === undefined) throw new DataError(`no fixture for ${key}`, "fixture_missing");
  if (typeof hit === "string") hit = { file: hit };
  const data = hit.file ? fs.readFileSync(path.join(d, hit.file)) : Buffer.from(String(hit.body ?? ""));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(hit.headers || {})) headers[k.toLowerCase()] = String(v);
  return new Response(hit.status ?? 200, headers, data, url);
}

/** DATA_ANALYST_RECORD=<dir>: save a live response as a fixture (refuses bodies that contain a known key). */
export function recordFixture(d: string, method: string, r: Response, body: Buffer | null): void {
  if (r.body.length > MAX_FIXTURE || keys.secretValues().some((k) => r.body.includes(k))) return;
  fs.mkdirSync(d, { recursive: true });
  const ip = path.join(d, "index.json");
  const idx: Record<string, any> = fs.existsSync(ip) ? JSON.parse(fs.readFileSync(ip, "utf8")) : {};
  const key = `${method} ${r.url}` + (body ? ` ${sha(body).slice(0, 12)}` : "");
  const ctype = r.headers["content-type"] || "";
  const head = r.body.subarray(0, 1).toString("latin1");
  const ext = ctype.includes("json") || head === "{" || head === "[" ? "json" : ctype.includes("csv") ? "csv"
    : ctype.includes("xml") || head === "<" ? "xml" : "bin";
  const prev = idx[key];
  let name: string;
  if (prev) name = typeof prev === "string" ? prev : prev.file;
  else {
    const nums = fs.readdirSync(d).filter((f) => /^r\d{3}/.test(f)).map((f) => parseInt(f.slice(1, 4), 10));
    name = `r${String(Math.max(0, ...nums) + 1).padStart(3, "0")}.${ext}`;
  }
  fs.writeFileSync(path.join(d, name), r.body);
  idx[key] = r.status !== 200 ? { file: name, status: r.status } : name;
  fs.writeFileSync(ip, JSON.stringify(idx, null, 1));
}

const BUCKETS = new Map<string, TokenBucket>();

export type ClientOptions = {
  name: string; auth?: keys.Auth; key?: string | null; rps?: number; burst?: number; retries?: number;
  timeout?: number; deadline?: number; checkError?: ((status: number, body: Buffer) => string | null | undefined) | null;
  headers?: Record<string, string> | null; userAgent?: string; errorsPerMin?: number | null; bytesPerMin?: number | null;
  retryHtml400?: number;
  /** A response cache (core/cache.ts), only for packs whose terms allow persistent copies (cache.mode "persistent"). */
  cache?: ResponseCache | null;
};

/** What Client needs of a cache: Cache from core/cache.ts fits. */
export type ResponseCache = {
  get(key: string): [Buffer, any] | null;
  put(key: string, data: Buffer, meta?: Record<string, unknown>): unknown;
};

export type RequestOptions = {
  jsonBody?: unknown; headers?: Record<string, string>; useKey?: boolean; okStatuses?: number[]; allow404?: boolean;
};

export class Client {
  base: string; name: string; auth: keys.Auth; retries: number; timeout: number; deadline: number;
  retryHtml400: number; checkError: ClientOptions["checkError"]; headers: Record<string, string>; ua: string;
  errorBudget: Budget; byteBudget: Budget; bucket: TokenBucket; key: string | null; keySource: string | null;
  cache: ResponseCache | null;

  constructor(baseUrl = "", o: ClientOptions) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.name = o.name;
    this.auth = { ...(o.auth || {}) };
    this.retries = o.retries ?? 2;
    this.timeout = o.timeout ?? 30;
    this.deadline = o.deadline ?? 180;
    this.cache = o.cache ?? null;
    this.retryHtml400 = Number(o.retryHtml400 || 0);
    this.checkError = o.checkError;
    this.headers = { ...(o.headers || {}) };
    this.ua = o.userAgent || UA;
    this.errorBudget = new Budget(o.errorsPerMin, "errors");
    this.byteBudget = new Budget(o.bytesPerMin, "bytes");
    const host = urlsplit(this.base || "http://x").netloc || o.name;
    if (!BUCKETS.has(host)) BUCKETS.set(host, new TokenBucket(o.rps || 5, o.burst || 10));
    this.bucket = BUCKETS.get(host)!;
    if (o.key) {
      keys.remember(o.key);
      [this.key, this.keySource] = [o.key, "argument"];
    } else [this.key, this.keySource] = keys.findAuthKey(this.auth);
  }

  toString(): string {
    return `Client(${this.name}, key=[REDACTED])`;
  }
  toJSON(): string {
    return this.toString();
  }

  url(p: string, params?: Record<string, unknown> | null): string {
    let url = /^https?:\/\//.test(p) ? p : p ? `${this.base}/${p.replace(/^\/+/, "")}` : this.base;
    const q = Object.entries(params || {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (q.length) url += (url.includes("?") ? "&" : "?") + pyUrlencode(q);
    return url;
  }

  secretParams(): string[] {
    const a = this.auth;
    return [a.placement === "query" ? a.param || "api_key" : null, ...Object.keys(a.extra || {})].filter(Boolean) as string[];
  }

  private withKey(url: string, headers: Record<string, string>, body: any): [string, Record<string, string>, any] {
    const a = this.auth;
    for (const [param, env] of Object.entries(a.extra || {})) {
      const [v] = keys.findKey(env);
      if (v) url += (url.includes("?") ? "&" : "?") + pyUrlencode({ [param]: v });
    }
    let k = this.key;
    if (!k && a.demo_key) k = a.demo_key;
    if (!k || !a.placement || a.placement === "none") return [url, headers, body];
    if (a.placement === "query") url += (url.includes("?") ? "&" : "?") + pyUrlencode({ [a.param || "api_key"]: k });
    else if (a.placement === "header") headers[a.param || "X-Api-Key"] = (a.prefix || "") + k;
    else if (a.placement === "body" && body !== null && body !== undefined) body = { ...body, [a.param || "registrationkey"]: k };
    return [url, headers, body];
  }

  /** fetch with redirects followed by hand: credentials are dropped when a redirect leaves the host or https. */
  private async open(url: string, init: RequestInit): Promise<globalThis.Response> {
    const a = this.auth;
    const secretHeaders = new Set([...CREDENTIAL_HEADERS, ...(a.placement === "header" ? [(a.param || "X-Api-Key").toLowerCase()] : [])]);
    const secretParams = new Set(this.secretParams().map((p) => p.toLowerCase()));
    let cur = url;
    let headers = { ...(init.headers as Record<string, string>) };
    let method = init.method || "GET";
    let body = init.body;
    for (let hop = 0; hop < 10; hop++) {
      const resp = await fetch(cur, { ...init, method, body, headers, redirect: "manual",
        signal: AbortSignal.timeout(this.timeout * 1000) });
      const loc = resp.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(resp.status) || !loc) return resp;
      await resp.arrayBuffer().catch(() => undefined);
      const next = new URL(loc, cur).toString();
      const from = urlsplit(cur), to = urlsplit(next);
      if (from.netloc.toLowerCase() !== to.netloc.toLowerCase() || (from.scheme === "https" && to.scheme !== "https")) {
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !secretHeaders.has(k.toLowerCase())));
        if (secretParams.size && to.query) {
          const q = parseQsl(to.query).filter(([k]) => !secretParams.has(k.toLowerCase()));
          cur = urlunsplit({ ...to, query: pyUrlencode(q) });
        } else cur = next;
      } else cur = next;
      if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
    }
    throw new DataError(`${this.name}: too many redirects`, "network");
  }

  private record(r: Response, method: string, body: Buffer | null): void {
    trail().push({ method, url: r.url, status: r.status, bytes: r.body.length, sha256: sha(r.body), cached: r.cached,
      fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00") });
    const rec = process.env.DATA_ANALYST_RECORD;
    if (rec && !process.env.DATA_ANALYST_FIXTURES) recordFixture(rec, method, r, body);
  }

  private static backoff(attempt: number): number {
    return 2 ** attempt * (0.5 + Math.random() * 0.5);
  }

  private static retryAfter(v: string | undefined): number | null {
    if (!v) return null;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : null;
  }

  async request(method: string, p = "", params?: Record<string, unknown> | null, o: RequestOptions = {}): Promise<Response> {
    const ok = o.okStatuses || [200];
    let url = this.url(p, params);
    const shown = cleanUrl(url, this.secretParams());
    let hdrs: Record<string, string> = { "User-Agent": this.ua, Accept: "*/*", ...this.headers, ...(o.headers || {}) };
    let body: any = o.jsonBody;
    if (o.useKey !== false) [url, hdrs, body] = this.withKey(url, hdrs, body);
    const data = body !== undefined && body !== null ? Buffer.from(JSON.stringify(body)) : undefined;
    const recBody = o.jsonBody !== undefined && o.jsonBody !== null ? Buffer.from(pyJsonDumps(o.jsonBody, true)) : null;
    if (data) hdrs["Content-Type"] ??= "application/json";
    if (process.env.DATA_ANALYST_FIXTURES) return this.finish(fixture(method, shown, recBody), method, ok, !!o.allow404, recBody);
    if (keys.restricted()) throw new DataError(`${this.name}: DATA_ACCESS_FORCE=restricted: network access is switched off`, "network");
    // the cache key is the credential-free URL (and the body hash): no secret is ever part of it
    const cacheKey = this.cache ? `${method} ${shown}` + (recBody ? ` ${sha(recBody).slice(0, 16)}` : "") : "";
    const hit = this.cache ? this.cache.get(cacheKey) : null;
    if (hit) {
      const r = new Response(200, hit[1]?.headers || {}, hit[0], shown, true);
      return this.finish(r, method, ok, !!o.allow404, recBody);
    }
    const start = performance.now() / 1000;
    let last = "";
    for (let attempt = 0; attempt <= Math.max(this.retries, this.retryHtml400); attempt++) {
      if (performance.now() / 1000 - start > this.deadline) break;
      await this.bucket.take();
      let r: Response;
      try {
        const resp = await this.open(url, { method, headers: hdrs, body: data });
        const h: Record<string, string> = {};
        resp.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
        r = new Response(resp.status, h, Buffer.from(await resp.arrayBuffer()), shown);
      } catch (e: any) {
        if (e instanceof DataError) throw e;
        last = keys.redact(String(e?.cause?.code || e?.cause?.message || e?.message || e)) || "network error";
        if (attempt < this.retries) {
          await sleep(Client.backoff(attempt) * 1000);
          continue;
        }
        break;
      }
      if (ok.includes(r.status) || (o.allow404 && r.status === 404)) {
        this.byteBudget.spend(r.body.length);
        const done = this.finish(r, method, ok, !!o.allow404, recBody);
        if (this.cache && r.status === 200) {
          const ct = r.headers["content-type"];
          this.cache.put(cacheKey, r.body, { url: shown, headers: ct ? { "content-type": ct } : {} });
        }
        return done;
      }
      if (RETRYABLE.has(r.status) && attempt < this.retries) {
        const wait = Client.retryAfter(r.headers["retry-after"]);
        if (wait !== null && wait > MAX_RETRY_AFTER) {
          this.record(r, method, recBody);
          throw new DataError(`${this.name}: HTTP ${r.status}, Retry-After ${wait.toFixed(0)}s exceeds ${MAX_RETRY_AFTER}s; ` +
            "wait and run again", "rate", r.status, Math.ceil(wait));
        }
        await sleep((wait ?? Client.backoff(attempt)) * 1000);
        continue;
      }
      if (r.status === 400 && attempt < this.retryHtml400 && htmlPage(r.body)) {
        await sleep(Client.backoff(attempt + 1) * 1000);
        continue;
      }
      return this.finish(r, method, ok, !!o.allow404, recBody);
    }
    throw new DataError(`${method} ${shown.split("?")[0]}: network error: ${last || "deadline exceeded"}`, "network");
  }

  private finish(r: Response, method: string, ok: number[], allow404: boolean, recBody: Buffer | null): Response {
    this.record(r, method, recBody);
    const snippet = errorSnippet(r.body);
    if (ok.includes(r.status) || (allow404 && r.status === 404)) {
      const msg = this.checkError ? this.checkError(r.status, r.body) : null;
      if (msg) {
        this.errorBudget.spend();
        throw new DataError(`${this.name}: ${msg}`, "api", r.status);
      }
      return r;
    }
    this.errorBudget.spend();
    const a = this.auth;
    if (r.status === 401 || r.status === 403) {
      if (!a.env) {
        const host = urlsplit(r.url).netloc;
        throw new DataError(`${this.name}: HTTP ${r.status} from ${host}: the host refused this request (access denied, ` +
          "usually a bot filter or a network block; no API key is involved)", "blocked", r.status);
      }
      if (!this.key) throw new DataError(`${this.name}: API key required (HTTP ${r.status}). ${a.env} is not set up.`,
        "key_missing", r.status);
      throw new DataError(`${this.name}: HTTP ${r.status} (key rejected or access denied): ${snippet}`, "auth", r.status);
    }
    if (r.status === 404) throw new DataError(`${this.name}: not found (HTTP 404) ${r.url.split("?")[0]}`, "not_found", 404);
    if (r.status === 429) throw new DataError(`${this.name}: rate limited (HTTP 429) after retries`, "rate", 429,
      Client.retryAfter(r.headers["retry-after"]) ?? undefined);
    if (r.status === 400 && this.retryHtml400 && htmlPage(r.body)) {
      throw new DataError(`${this.name}: HTTP 400 (${snippet}) on ${this.retryHtml400 + 1} tries. This host's front server ` +
        "sometimes answers a valid request with such an HTML page (the API's own parameter errors are JSON or text): run " +
        "again in a few minutes; if it persists, check the parameters against source.md", "bad_request", 400);
    }
    if (r.status === 400 && !this.key && a.env && a.required === "required") {
      const envs = [a.env, ...Object.values(a.extra || {})];
      throw new DataError(`${this.name}: credentials required (HTTP 400: ${snippet}). ${envs.join(" and ")} not set up.`,
        "key_missing", r.status);
    }
    if (r.status >= 400 && r.status < 500) throw new DataError(`${this.name}: HTTP ${r.status}: ${snippet}`, "bad_request", r.status);
    if (RETRYABLE.has(r.status)) {
      throw new DataError(`${this.name}: HTTP ${r.status} after ${this.retries} retries: ${snippet}. Either the server is ` +
        "busy or down (wait a few minutes and run again), or this request makes it fail: if a simpler request to the " +
        "same endpoint answers, fix the request instead of waiting", "http", r.status,
        Client.retryAfter(r.headers["retry-after"]) ?? undefined);
    }
    throw new DataError(`${this.name}: HTTP ${r.status}: ${snippet}`, "http", r.status);
  }

  /** Download a large file to dest (atomic .part rename), with the same auth, throttle, fixtures and trail. */
  async download(p: string, dest: string, params?: Record<string, unknown> | null, sha256?: string): Promise<{
    path: string; bytes: number; sha256: string; url: string }> {
    const url0 = this.url(p, params);
    const shown = cleanUrl(url0, this.secretParams());
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    const part = dest + ".part";
    let buf: Buffer;
    if (process.env.DATA_ANALYST_FIXTURES) {
      buf = this.finish(fixture("GET", shown, null), "GET", [200], false, null).body;
    } else {
      if (keys.restricted()) throw new DataError(`${this.name}: DATA_ACCESS_FORCE=restricted: network access is switched off`, "network");
      let [url, hdrs] = this.withKey(url0, { "User-Agent": this.ua, ...this.headers }, null);
      await this.bucket.take();
      let resp: globalThis.Response;
      try {
        resp = await this.open(url, { headers: hdrs });
      } catch (e: any) {
        if (e instanceof DataError) throw e;
        throw new DataError(`GET ${shown.split("?")[0]}: network error: ${e?.cause?.code || e?.message || e}`, "network");
      }
      if (resp.status !== 200) {
        this.finish(new Response(resp.status, {}, Buffer.from(await resp.arrayBuffer()), shown), "GET", [200], false, null);
      }
      buf = Buffer.from(await resp.arrayBuffer());
      this.byteBudget.spend(buf.length);
      trail().push({ method: "GET", url: shown, status: resp.status, bytes: buf.length, sha256: sha(buf), cached: false,
        fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00") });
    }
    const digest = sha(buf);
    if (sha256 && digest.toLowerCase() !== sha256.toLowerCase()) {
      throw new DataError(`${this.name}: checksum mismatch for ${path.basename(dest)}`, "http");
    }
    fs.writeFileSync(part, buf);
    fs.renameSync(part, dest);
    return { path: dest, bytes: buf.length, sha256: digest, url: shown };
  }

  get(p = "", params?: Record<string, unknown> | null, o: RequestOptions = {}): Promise<Response> {
    return this.request("GET", p, params, o);
  }
  async getJson<T = any>(p = "", params?: Record<string, unknown> | null, o: RequestOptions = {}): Promise<T> {
    return (await this.get(p, params, o)).json<T>();
  }
  async postJson<T = any>(p = "", body: unknown = {}, params?: Record<string, unknown> | null, o: RequestOptions = {}): Promise<T> {
    return (await this.request("POST", p, params, { ...o, jsonBody: body ?? {} })).json<T>();
  }
}

/** Does the host answer at all? Any HTTP status counts; network errors and restricted mode do not. */
export async function reachable(url: string, timeout = 12): Promise<[boolean, string]> {
  if (process.env.DATA_ANALYST_FIXTURES) return [true, ""];
  if (keys.restricted()) return [false, "DATA_ACCESS_FORCE=restricted"];
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeout * 1000) });
    await r.arrayBuffer().catch(() => undefined);
    if (r.status >= 400) {
      const why = r.status === 401 || r.status === 403 ? " (the host answers; this probe sends no key, so a key check is separate)" : "";
      return [true, `HTTP ${r.status}${why}`];
    }
    return [true, ""];
  } catch (e: any) {
    return [false, keys.redact(String(e?.cause?.code || e?.message || e)).slice(0, 200)];
  }
}
