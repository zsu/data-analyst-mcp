/**
 * Declarative fetching for JSON/CSV REST APIs (Socrata, DKAN, CKAN, plain REST) from a pack's endpoints.json.
 * The endpoints.json format:
 *
 * {
 *   "base_url": "https://data.cdc.gov/resource", "timeout": 30, "retry_html_400": 3, "headers": {...},
 *   "endpoints": {
 *     "<name>": {
 *       "path": "/{dataset}.json", "method": "GET" | "POST", "description": "...",
 *       "params": {"dataset": {"in": "path", "required": true, "desc": "...", "catalog": true},
 *                  // "in": "query" (GET default) | "path" | "body" (POST default) | "spec" (never sent) | "records"
 *                  // "flag": true (a bare ?flagName, sent only when true), "raw": true (path value keeps slashes)
 *                  "$where": {"desc": "SoQL filter"}, "state": {"desc": "...", "enum": [...]}},
 *       "defaults": {"$order": ":id"}, "body": {...},
 *       "records": "results" | "" | "$table" | "$csv" | "$xlsx" | "$xls" | "$zip:<glob>",
 *       "sheet": "Table 1", "header_row": 1, "total": "meta.count",
 *       "paging": {"type": "offset", "limit_param": "$limit", "offset_param": "$offset", "size": 1000, "manual_size": 50000}
 *               | {"type": "page", "page_param": "page", "size_param": "per_page", "size": 100, "start": 1, "min_size": 5}
 *               | {"type": "cursor", "cursor_param": "cursor", "next": "pagination.next_cursor", "size_param": "limit"}
 *               | {"type": "link", "next": "links.next"} | {"type": "none"},
 *       "max_rows": 100000, "unique_key": "appl_id", "truncated_note": {"when_default": "sort_field", "text": "..."},
 *       "missing": ["", "(NA)", "."], "flatten": true
 *     }
 *   },
 *   "catalog": {"<alias>": {"id": "bi63-dtpu", "name": "...", "description": "...", "endpoint": "<name>"}}
 * }
 *
 * spec: {"description": "...", "requests": [{"name": "deaths", "endpoint": "query",
 *   "params": {"dataset": "leading_death", "$where": "year = '2017'"}, "max_rows": 5000}]}
 */
import fs from "node:fs";
import path from "node:path";
import { Cache } from "./cache.js";
import { Client, DataError } from "./http.js";
import type { Pack, Row, Spec, SpecRequest, Tables } from "./packs.js";
import { parsePyJson, pyJsonDumps, pyQuote, pyStr, pyUrlencode, sleep } from "./py.js";
import { decodeText, fnmatch, readCsv, sheetRecords, unzip, xlsRecords } from "./tabular.js";

/** A note containing this marks its table incomplete (status partial), like a max_rows cut. */
export const INCOMPLETE = ": incomplete:";
export const FOR_EACH_MAX = 2000;

export function dig(obj: any, p: string | null | undefined): any {
  if (p === "" || p === null || p === undefined) return obj;
  for (const part of p.split(".")) {
    if (obj === null || obj === undefined) return null;
    if (Array.isArray(obj)) {
      const i = Number(part);
      obj = Number.isInteger(i) && i >= 0 && i < obj.length ? obj[i] : null;
    } else obj = obj && typeof obj === "object" ? obj[part] ?? null : null;
  }
  return obj;
}

const scalar = (x: unknown) => typeof x === "string" || typeof x === "number" || typeof x === "boolean";

export function flatten(rec: unknown, prefix = ""): Row {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { [prefix || "value"]: rec };
  const out: Row = {};
  for (const [k, v] of Object.entries(rec)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else if (Array.isArray(v)) {
      out[key] = v.length && !v.every(scalar) ? pyJsonDumps(v, false, false) : v.map(pyStr).join("; ");
    } else out[key] = v;
  }
  return out;
}

export function clientFor(pack: Pack, eps?: any, extra: Record<string, unknown> = {}): Client {
  const P = pack.policy;
  const e = eps ?? pack.endpoints ?? {};
  const L = P.limits;
  return new Client(e.base_url || P.routes?.api?.base || "", {
    name: pack.id, auth: P.auth, rps: L.rps || 5, burst: L.burst || 10,
    checkError: pack.adapter?.checkError ?? null, errorsPerMin: L.errors_per_min ?? null,
    bytesPerMin: L.bytes_per_min ?? null, headers: e.headers ?? null, timeout: e.timeout ?? 30,
    retryHtml400: e.retry_html_400 ?? 0,
    // a persistent cache only where the source's terms allow it (cache.mode "persistent"); never for test fixtures
    cache: P.cache.mode === "persistent" && !process.env.DATA_ANALYST_FIXTURES ? new Cache(pack.id, P) : null, ...extra,
  });
}

// ---------------------------------------------------------------------- spec -> requests
/** [endpoint definition, merged params, problems] for one spec request. */
export function resolve(pack: Pack, req: SpecRequest): [any, Record<string, unknown>, string[]] {
  const eps = pack.endpoints?.endpoints || {};
  const cat = pack.endpoints?.catalog || {};
  const probs: string[] = [];
  let name = req.endpoint;
  if (!name && req.dataset && cat[req.dataset]) name = cat[req.dataset].endpoint;
  const ep = eps[name || ""];
  if (!ep) {
    return [{}, {}, [`request ${JSON.stringify(req.name)}: unknown endpoint ${JSON.stringify(name ?? null)} (known: ${Object.keys(eps).sort().join(", ")})`]];
  }
  const given = req.params || {};
  const defaults: Record<string, unknown> = { ...(ep.defaults || {}) };
  if ("$group" in given && !("$order" in given)) delete defaults.$order; // SoQL: an aggregate cannot keep a row-id order
  const params: Record<string, unknown> = { ...defaults, ...given };
  for (const [pname, d] of Object.entries<any>(ep.params || {})) {
    if (d.catalog) {
      let v: any = pname in params ? params[pname] : req.dataset;
      if (typeof v === "string" && cat[v]) v = cat[v].id;
      if (v !== undefined && v !== null) params[pname] = v;
    }
    const v = params[pname];
    if (d.required && (v === undefined || v === null || v === "")) {
      probs.push(`request ${JSON.stringify(req.name)}: parameter ${JSON.stringify(pname)} is required (${d.desc || ""})`);
    }
    if (d.enum && v !== undefined && v !== null && v !== "" && !d.enum.map(String).includes(pyStr(v))) {
      probs.push(`request ${JSON.stringify(req.name)}: ${pname}=${JSON.stringify(v)} is not one of ${JSON.stringify(d.enum)}`);
    }
  }
  if (!req.name || !/^[A-Za-z0-9_-]+$/.test(String(req.name))) {
    probs.push("every request needs a name of letters, digits, _ or - (it names the CSV file)");
  }
  return [ep, params, probs];
}

/** [endpoint path with {x} filled, query params, JSON body]. */
export function split(ep: any, params: Record<string, unknown>): [string, Record<string, unknown>, any] {
  const pdefs = ep.params || {};
  let p: string = ep.path;
  const query: Record<string, unknown> = {};
  let body: any = ep.body !== undefined && ep.body !== null ? structuredClone(ep.body) : null;
  const flags: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    const d = pdefs[k] || {};
    const where = d.in || (ep.method === "POST" ? "body" : "query");
    if (where === "spec" || where === "records") continue;
    if (d.flag) {
      if (v === true || ["true", "1", "yes"].includes(String(v).trim().toLowerCase())) flags.push(pyQuote(k));
      continue;
    }
    if (where === "path" || p.includes(`{${k}}`)) p = p.replace(`{${k}}`, pyQuote(pyStr(v), d.raw ? "/" : ""));
    else if (where === "body") {
      body ??= {};
      body[k] = v;
    } else query[k] = v;
  }
  if (flags.length) p += (p.includes("?") ? "&" : "?") + flags.join("&");
  return [p, query, body];
}

export function checkSpec(pack: Pack, spec: Spec): string[] {
  const probs: string[] = [];
  const reqs = spec.requests || [];
  if (!reqs.length) probs.push('spec needs a non-empty "requests" list');
  const names = reqs.map((r) => r.name);
  if (new Set(names).size !== names.length) probs.push("request names must be unique");
  for (const r of reqs) probs.push(...resolve(pack, r)[2]);
  if (pack.adapter?.checkSpec) probs.push(...(pack.adapter.checkSpec(spec, pack) || []));
  return probs;
}

// ---------------------------------------------------------------------- one request per row of a table
/** for_each requests as one request per distinct value (or combination) of a column of an earlier fetch's CSV. */
export function expandForEach(spec: Spec, base: string): Spec {
  const reqs: SpecRequest[] = [];
  for (const r of spec.requests || []) {
    const fe = r.for_each;
    if (!fe) {
      reqs.push(r);
      continue;
    }
    const csvPath = path.isAbsolute(fe.csv || "") ? fe.csv : path.join(base, fe.csv || "");
    if (!fs.existsSync(csvPath)) {
      throw new DataError(`request ${JSON.stringify(r.name)}: for_each csv ${JSON.stringify(fe.csv)} not found (fetch that ` +
        "table first; the path is relative to the workspace)", "bad_request");
    }
    const pairs: Record<string, string> = fe.map && Object.keys(fe.map).length ? { ...fe.map } : { [fe.param || fe.column]: fe.column };
    const rows = readCsv(decodeText(fs.readFileSync(csvPath)));
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const miss = Object.values(pairs).filter((c) => !cols.includes(c));
    if (miss.length) {
      throw new DataError(`request ${JSON.stringify(r.name)}: for_each column(s) ${JSON.stringify(miss)} not in ${fe.csv} ` +
        `(columns: ${JSON.stringify(cols)})`, "bad_request");
    }
    const low = !!fe.lower, pre = String(fe.strip || "");
    const combos = new Map<string, string[]>();
    for (const x of rows) {
      let vals = Object.values(pairs).map((c) => (low ? String(x[c] ?? "").trim().toLowerCase() : String(x[c] ?? "").trim()));
      vals = vals.map((v) => (pre && v.startsWith(pre) ? v.slice(pre.length) : v));
      if (vals.every(Boolean)) combos.set(JSON.stringify(vals), vals);
    }
    const max = Number(fe.max ?? FOR_EACH_MAX);
    if (combos.size > max) {
      throw new DataError(`request ${JSON.stringify(r.name)}: for_each gives ${combos.size} requests (max ${max}): filter the ` +
        'table first, or set "max"', "bad_request");
    }
    const names = Object.keys(pairs);
    let i = 0;
    for (const vals of combos.values()) {
      i++;
      const { for_each: _drop, ...rest } = r;
      const key = names.map((n, j) => [n, vals[j]] as [string, string]);
      reqs.push({ ...rest, name: `${r.name}__${i}`, params: { ...(r.params || {}), ...Object.fromEntries(key) },
        _group: r.name, _key: key, _orig: r });
    }
  }
  return { ...spec, requests: reqs };
}

/** The spec as written (each for_each request once). */
export function collapseForEach(spec: Spec): Spec {
  const reqs: SpecRequest[] = [];
  const seen = new Set<string>();
  for (const r of spec.requests || []) {
    if (r._group === undefined) reqs.push(r);
    else if (!seen.has(r._group)) {
      seen.add(r._group);
      reqs.push(r._orig);
    }
  }
  return { ...spec, requests: reqs };
}

/** The expanded requests' tables as one table per for_each request; each row keeps the value it was asked for. */
export function mergeForEach(spec: Spec, tables: Tables): Tables {
  const out: Tables = {};
  for (const r of spec.requests || []) {
    const rows = tables[r.name] || [];
    if (r._group === undefined) {
      out[r.name] = rows;
      continue;
    }
    if (!Array.isArray(rows)) throw new DataError(`request '${r.name}': for_each cannot merge a streamed table`, "spec");
    const asked = Object.fromEntries(r._key as [string, string][]);
    const merged = (out[r._group] ??= []) as Row[];
    for (const row of rows) {
      const add = Object.fromEntries(Object.entries(asked).filter(([k]) => !(k in row)));
      merged.push({ ...add, ...row });
    }
  }
  const named = new Set((spec.requests || []).map((r) => r.name));
  for (const [name, rows] of Object.entries(tables)) if (!named.has(name) && !(name in out)) out[name] = rows;
  return out;
}

// ---------------------------------------------------------------------- fetching
type Body = { body: Buffer; text(): string; json(): any };

export function records(ep: any, resp: Body): any[] {
  const p: string = ep.records ?? "";
  if (p === "$csv") return readCsv(resp.text());
  if (p === "$xlsx") return sheetRecords(ep, resp.body);
  if (p === "$xls") {
    if (resp.body.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1"))) return sheetRecords(ep, resp.body);
    if (!resp.body.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
      throw new DataError("expected an .xls workbook, got something else (an HTML page?)", "api");
    }
    return xlsRecords(ep, resp.body);
  }
  if (p.startsWith("$zip:")) {
    const z = unzip(resp.body);
    const glob = p.slice(5).toLowerCase() || "*";
    const members = Object.keys(z).filter((n) => fnmatch(n.toLowerCase(), glob) && !n.endsWith("/")).sort();
    if (!members.length) {
      throw new DataError(`no member matching ${JSON.stringify(p.slice(5))} in the zip (${Object.keys(z).slice(0, 10).join(", ")})`, "api");
    }
    const rows: any[] = [];
    for (const n of members) {
      if (n.toLowerCase().endsWith(".xlsx")) rows.push(...sheetRecords(ep, z[n]));
      else if (n.toLowerCase().endsWith(".xls")) rows.push(...xlsRecords(ep, z[n]));
      else rows.push(...readCsv(decodeText(z[n])));
    }
    return rows;
  }
  const data = resp.json();
  if (p === "$table") {
    if (!data || !data.length) return [];
    const [head, ...rows] = data;
    return rows.map((r: any[]) => Object.fromEntries(head.map((h: string, i: number) => [h, r[i]])));
  }
  const recs = dig(data, p);
  if (recs === null || recs === undefined) return [];
  return Array.isArray(recs) ? recs : [recs];
}

export function clean(rows: any[], ep: any): Row[] {
  const missing = new Set<string>(ep.missing ?? [""]);
  return rows.map((r0) => {
    const r = ep.flatten ?? true ? flatten(r0) : r0 && typeof r0 === "object" ? r0 : { value: r0 };
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) {
      o[k] = v === null || v === undefined || (typeof v === "string" && missing.has(v.trim())) ? "" : v;
    }
    return o;
  });
}

/** The endpoint with the spec's file-reading params ("in": "records": sheet, header_row) applied. */
export function withRecordParams(ep: any, params: Record<string, unknown>): any {
  const pdefs = ep.params || {};
  const over = Object.fromEntries(Object.entries(params).filter(([k, v]) => pdefs[k]?.in === "records" && v !== null && v !== undefined && v !== ""));
  return Object.keys(over).length ? { ...ep, ...over } : ep;
}

export type Meta = { pages: number; total: number | null; truncated: boolean; repeated_page?: boolean };

/** All pages of one request. */
export async function fetchRequest(client: Client, ep0: any, params: Record<string, unknown>,
  maxRows?: number | null): Promise<[Row[], Meta]> {
  const ep = withRecordParams(ep0, params);
  const pg = ep.paging || { type: "none" };
  const kind: string = pg.type || "none";
  const limit = Math.min(Number(maxRows || ep.max_rows || 100000), Number(ep.max_rows || 1e9));
  const size = Number(pg.size || 1000);
  const floor = Number(pg.min_size || 1);
  const [p, query, body] = split(ep, params);
  const method = ep.method || "GET";
  let rows: any[] = [];
  const meta: Meta = { pages: 0, total: null, truncated: false };
  let page = Number(pg.start ?? 1);
  let offset = kind === "offset" ? Number(query[pg.offset_param || ""] || 0) || 0 : 0;
  let cursor: any = null, nextUrl: any = null, prev: string | null = null;
  for (;;) {
    const q: Record<string, unknown> = { ...query };
    const b = body !== null ? { ...body } : null;
    const tgt: Record<string, unknown> = method === "POST" && (pg.in ?? "body") === "body" && b ? b : q;
    const put = (k: string | undefined, v: unknown) => {
      if (k) tgt[k] = v;
    };
    const asked = kind === "offset" ? Math.min(size, limit - rows.length) : Math.min(size, limit);
    if (kind === "offset") {
      put(pg.limit_param, asked);
      put(pg.offset_param, offset);
    } else if (kind === "page") {
      put(pg.page_param, page);
      put(pg.size_param, Math.max(Math.min(size, limit), floor));
    } else if (kind === "cursor") {
      put(pg.size_param, Math.max(Math.min(size, limit), floor));
      if (cursor) put(pg.cursor_param, cursor);
    }
    const resp = nextUrl ? await client.request(method, nextUrl, null, { jsonBody: b ?? undefined })
      : await client.request(method, p, q, { jsonBody: b ?? undefined });
    meta.pages++;
    const got = records(ep, resp);
    const sig = JSON.stringify(got);
    if (got.length && (kind === "offset" || kind === "page") && sig === prev) {
      meta.truncated = meta.repeated_page = true;
      break;
    }
    prev = sig;
    rows = rows.concat(got);
    const head = resp.body.subarray(0, 1).toString("latin1");
    if (ep.total && (head === "{" || head === "[")) {
      const t = Number(dig(resp.json(), ep.total));
      if (Number.isFinite(t)) meta.total = Math.trunc(t);
    }
    if (rows.length >= limit) {
      meta.truncated = (meta.total || 0) > limit || (kind !== "none" && got.length >= asked) || (kind === "none" && got.length > limit);
      rows = rows.slice(0, limit);
      break;
    }
    if (kind === "none" || !got.length) break;
    if (kind === "offset") {
      if (got.length < Math.min(size, limit)) break;
      offset += got.length;
    } else if (kind === "page") {
      if (got.length < Math.min(size, limit) || (meta.total !== null && rows.length >= meta.total)) break;
      page++;
    } else if (kind === "cursor") {
      cursor = dig(resp.json(), pg.next);
      if (!cursor) break;
    } else if (kind === "link") {
      nextUrl = dig(resp.json(), pg.next);
      if (!nextUrl) break;
    }
    if (meta.pages >= Number(pg.max_pages ?? 1000)) {
      meta.truncated = true;
      break;
    }
  }
  return [clean(rows, ep), meta];
}

/** Rows repeated across page boundaries (same unique_key) are dropped, with a note that as many may be missing. */
export function dedupePages(rows: Row[], ep: any, meta: Meta, name: string): [Row[], string | null] {
  const col = ep.unique_key;
  if (!col || meta.pages < 2 || !rows.length || rows.some((r) => !(col in r))) return [rows, null];
  const seen = new Set<string>();
  const out = rows.filter((r) => {
    const k = pyStr(r[col]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (out.length === rows.length) return [rows, null];
  const gap = rows.length - out.length;
  return [out, `${name}: ${gap.toLocaleString("en-US")} row(s) came back twice across page boundaries (same ${col}), so the ` +
    "source's order shifted while paging and about as many rows may be missing; the repeats were dropped " +
    `(${out.length.toLocaleString("en-US")} rows kept` + (meta.total ? ` of ${meta.total.toLocaleString("en-US")}` : "") +
    "). Sort by a unique field (or narrow the request to one page) and fetch again (force)."];
}

/** fetchRequest, waiting out a server that stays busy past the client's own retries. */
async function fetchPatiently(c: Client, ep: any, params: Record<string, unknown>, maxRows?: number | null,
  waits = [20, 60]): Promise<[Row[], Meta]> {
  for (const wait of [...waits, null]) {
    try {
      return await fetchRequest(c, ep, params, maxRows);
    } catch (e) {
      if (wait === null || !(e instanceof DataError) || e.kind !== "http" || ![500, 502, 503, 504].includes(e.status ?? 0) ||
        process.env.DATA_ANALYST_FIXTURES) throw e;
      await sleep(wait * 1000);
    }
  }
  throw new Error("unreachable");
}

/** Every request runs; the missing (404) and empty ones are named together at the end. */
export class Misses {
  missing: string[] = [];
  empty: string[] = [];
  notFound(r: SpecRequest, tables: Tables, notes: string[]): void {
    if (r.allow_empty) {
      notes.push(`${r.name}: not found at the source (404); kept as an empty table (allow_empty).`);
      tables[r.name] = [];
    } else this.missing.push(r.name);
  }
  checkEmpty(r: SpecRequest, rows: Row[]): void {
    if (!rows.length && !r.allow_empty) {
      const key = r._key as [string, string][] | undefined;
      this.empty.push(r.name + (key ? ` (${key.map(([k, v]) => `${k}=${v}`).join(", ")})` : ""));
    }
  }
  raiseIfAny(missingHint = "", emptyHint = ""): void {
    const msgs: string[] = [];
    if (this.missing.length) {
      msgs.push(`request(s) ${this.missing.map((m) => `'${m}'`).join(", ")} were not found at the source (404): ` +
        `${missingHint || "check the IDs"}. If the item really does not exist yet (e.g. a volume not yet published), add ` +
        '"allow_empty": true to that request and run again; the answer must say it is missing.');
    }
    if (this.empty.length) {
      msgs.push(`request(s) ${this.empty.map((m) => `'${m}'`).join(", ")} returned no rows: ` +
        `${emptyHint || "check the filter values (see source.md)"}. If none is a correct answer (e.g. no private laws in ` +
        'that Congress), add "allow_empty": true to that request and run again.');
    }
    if (msgs.length) throw new DataError(msgs.join(" "), this.missing.length ? "not_found" : "bad_request");
  }
}

/** Every request in the spec: [{name: rows}, notes]. */
export async function fetchSpec(pack: Pack, spec: Spec, client?: Client): Promise<[Tables, string[]]> {
  const c = client ?? clientFor(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  const miss = new Misses();
  for (const r of spec.requests) {
    const [ep, params0, probs] = resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    let params = params0;
    const extra = Object.keys(r.params || {}).filter((k) => !(k in (ep.params || {})) && !(k in (ep.defaults || {})));
    if (extra.length) {
      notes.push(`${r.name}: parameter(s) ${extra.join(", ")} not declared for endpoint '${r.endpoint}' (endpoints.json); ` +
        "the API may ignore them: check the rows");
    }
    if (pack.adapter?.beforeRequest) params = pack.adapter.beforeRequest(r, ep, params) || params;
    let rows: Row[], meta: Meta;
    try {
      [rows, meta] = await fetchPatiently(c, ep, params, r.max_rows);
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      if (e.kind === "not_found") {
        miss.notFound(r, tables, notes);
        continue;
      }
      throw new DataError(`request '${r.name}' (${r.endpoint}): ${e.message}`, e.kind, e.status, e.retryAfter);
    }
    let dup: string | null;
    [rows, dup] = dedupePages(rows, ep, meta, r.name);
    if (dup) notes.push(dup);
    if (pack.adapter?.requestNote) {
      const n = pack.adapter.requestNote(r, ep, params);
      if (n) notes.push(n);
    }
    if (pack.adapter?.normalize) rows = pack.adapter.normalize(r, ep, rows);
    if (meta.repeated_page) {
      notes.push(`${r.name}${INCOMPLETE} stopped at ${rows.length.toLocaleString("en-US")} rows: page ${meta.pages} repeated ` +
        "the page before it (the API ignored the paging parameter), so later rows may be missing. Narrow the request so it fits one page.");
    } else if (meta.truncated) {
      const tn = ep.truncated_note || {};
      const k = tn.when_default;
      const own = !!(tn.text && k && params[k] !== undefined && params[k] !== null && params[k] !== "" &&
        ((r.params || {})[k] === undefined || (r.params || {})[k] === null || (r.params || {})[k] === ""));
      notes.push(`${r.name}: stopped at ${rows.length.toLocaleString("en-US")} rows (max_rows); the source has more` +
        (meta.total ? ` (${meta.total.toLocaleString("en-US")} in total)` : "") + ". Narrow the filter or raise max_rows." +
        (own ? " " + tn.text : ""));
    }
    miss.checkEmpty(r, rows);
    tables[r.name] = rows;
  }
  miss.raiseIfAny();
  return [tables, notes];
}

// ---------------------------------------------------------------------- manual download
/** One link per page the request would need (up to 25), with the key as {API_KEY}. */
export function manualItems(pack: Pack, spec: Spec): any[] {
  const eps = pack.endpoints || {};
  const base = String(eps.base_url || pack.policy.routes?.api?.base || "").replace(/\/+$/, "");
  const a = pack.policy.auth;
  const needsKey = a.required === "required";
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [ep, params0, probs] = resolve(pack, r);
    if (probs.length) continue;
    const params = (pack.adapter?.beforeRequest && pack.adapter.beforeRequest(r, ep, params0)) || params0;
    const [p, query, body] = split(ep, params);
    const pg = ep.paging || { type: "none" };
    const size = Number(pg.manual_size || pg.size || 1000);
    const limit = Number(r.max_rows || size);
    const pages = ["none", "cursor", "link"].includes(pg.type) ? 1 : Math.min(25, Math.max(1, Math.ceil(limit / size)));
    const rec: string = ep.records || "";
    const ext = ({ $csv: "csv", $xlsx: "xlsx", $xls: "xls" } as Record<string, string>)[rec] ?? (rec.startsWith("$zip:") ? "zip" : "json");
    for (let i = 0; i < pages; i++) {
      const q: Record<string, unknown> = { ...query };
      const b = body !== null ? { ...body } : null;
      const tgt = ep.method === "POST" && (pg.in ?? "body") === "body" && b ? b : q;
      if (pg.type === "offset") [tgt[pg.limit_param], tgt[pg.offset_param]] = [size, i * size];
      else if (pg.type === "page") [tgt[pg.page_param], tgt[pg.size_param]] = [Number(pg.start ?? 1) + i, size];
      let url = /^https?:\/\//.test(p) ? p : `${base}/${p.replace(/^\/+/, "")}`;
      if (Object.keys(q).length) url += (url.includes("?") ? "&" : "?") + pyUrlencode(q);
      if (needsKey && a.placement === "query") url += (url.includes("?") ? "&" : "?") + `${a.param}={API_KEY}`;
      else if (a.required === "optional" && a.demo_key && a.placement === "query") url += (url.includes("?") ? "&" : "?") + `${a.param}=${a.demo_key}`;
      const filename = pages === 1 ? `${r.name}.${ext}` : `${r.name}_${i + 1}.${ext}`;
      let note = pages === 1 ? "" : `page ${i + 1} of up to ${pages}; only needed if the previous page held ${size.toLocaleString("en-US")} rows`;
      if (pages === 1 && ["offset", "page"].includes(pg.type)) {
        note = `holds up to ${size.toLocaleString("en-US")} rows; if it holds exactly that many, more rows exist: narrow the filter`;
      }
      if (["cursor", "link"].includes(pg.type)) note = "first page only: this API pages with a cursor, so the script route is needed for more rows";
      items.push({ name: `${r.name}#${i + 1}`, request: r.name, url, filename, also_ext: ext === "json" ? [".csv"] : [],
        needs_key: needsKey, method: ep.method || "GET", body: b, note, optional: i > 0 });
    }
  }
  return items;
}

/** Rows from uploaded files for one request (its pages in natural order). */
export function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [ep0, params] = resolve(pack, req);
  const ep = withRecordParams(ep0, params);
  const natural = (s: string) => s.split(/(\d+)/).map((x) => (/^\d+$/.test(x) ? x.padStart(20, "0") : x)).join("");
  let rows: any[] = [];
  for (const f of [...files].sort((a, b) => (natural(a) < natural(b) ? -1 : 1))) {
    const data = fs.readFileSync(f);
    const r: Body = { body: data, text: () => decodeText(data), json: () => parsePyJson(data.toString("utf8").replace(/^﻿/, "")) };
    rows = rows.concat(f.toLowerCase().endsWith(".csv") && ep.records !== "$csv" ? readCsv(r.text()) : records(ep, r));
  }
  let out = clean(rows, ep);
  if (pack.adapter?.normalize) out = pack.adapter.normalize(req, ep, out);
  return out;
}

// ---------------------------------------------------------------------- describing the API to the model
/** One line per endpoint: the request index of source_brief. */
export function endpointIndex(pack: Pack): { name: string; summary: string }[] {
  return Object.entries<any>(pack.endpoints?.endpoints || {}).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, e]) => ({ name, summary: String(e.description || "").split(/(?<=\.)\s/)[0].slice(0, 200) }));
}

/** Full argument schema of named endpoints (what request_schema returns). */
export function endpointSchema(pack: Pack, name: string): any | null {
  const e = pack.endpoints?.endpoints?.[name];
  if (!e) return null;
  const pg = e.paging || { type: "none" };
  return {
    name, method: e.method || "GET", description: e.description || "",
    params: Object.fromEntries(Object.entries<any>(e.params || {}).map(([k, d]) => [k, {
      desc: d.desc || "", ...(d.required ? { required: true } : {}), ...(d.enum ? { enum: d.enum } : {}),
      ...(d.catalog ? { catalog: "an alias from the catalog (search with request_schema search) or a dataset id" } : {}),
      ...(d.in === "spec" ? { note: "read by the pack, never sent" } : {}),
    }])),
    defaults: e.defaults || {}, paging: pg.type, max_rows: e.max_rows ?? 100000,
    returns: e.records?.startsWith?.("$") ? e.records : "json records",
  };
}

export function searchCatalog(pack: Pack, query: string, limit = 20): any[] {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1);
  const count = (text: string, w: string) => text.split(w).length - 1;
  const hits: [number, any][] = [];
  for (const [alias, c] of Object.entries<any>(pack.endpoints?.catalog || {})) {
    const text = `${alias} ${c.id ?? ""} ${c.name ?? ""} ${c.description ?? ""}`.toLowerCase();
    const s = words.reduce((n, w) => n + count(text, w), 0);
    if (s) hits.push([s, { alias, ...c }]);
  }
  for (const [n, e] of Object.entries<any>(pack.endpoints?.endpoints || {})) {
    const text = `${n} ${e.description ?? ""}`.toLowerCase();
    const s = words.reduce((k, w) => k + count(text, w), 0);
    if (s) hits.push([s, { endpoint: n, description: e.description || "" }]);
  }
  return hits.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, h]) => h);
}
