/**
 * Client for the U.S. Treasury Fiscal Data API (the treasury deep pack; port of sources/treasury/treasury_api.py).
 *
 * API facts this client relies on (https://fiscaldata.treasury.gov/api-documentation/; docs/api_guide.md):
 *   - Base URL https://api.fiscaldata.treasury.gov/services/api/fiscal_service/ + endpoint path; no key.
 *   - Parameters: fields=a,b  filter=f:op:value,f2:in:(x,y)  sort=-f,g  format=json|csv
 *     page[number]=1  page[size]=N (at most 10000). Operators: eq, lt, lte, gt, gte, in.
 *   - Every value comes back as a string; missing values are the string "null".
 * Errors are DataError with kind "network" (cannot reach the API), "bad_request" (400: a field, filter or sort the
 * endpoint does not have), "not_found" (404: wrong endpoint path), "http" (anything else), "spec" (the spec itself).
 */
import { Client, DataError } from "../core/http.js";
import { parsePyJson, pyQuote, pyStr } from "../core/py.js";

export const BASE = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/";
export const MAX_PAGE = 10000;
export const OPERATORS = ["eq", "lt", "lte", "gt", "gte", "in"];
const USER_AGENT = "data-analyst/1.0 treasury pack (+https://fiscaldata.treasury.gov/api-documentation/)";

export type Filter = Record<string, any> | string | null | undefined;

/** Python repr() of a str (single quotes unless the text has one and no double quote). */
export function pyRepr(s: unknown): string {
  if (s === null || s === undefined) return "None";
  if (typeof s !== "string") return Array.isArray(s) ? "[" + s.map(pyRepr).join(", ") + "]" : pyStr(s);
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n") + q;
}

/** Accept a bare path ("v2/accounting/od/debt_to_penny"), one with a leading slash, or a full URL. */
export function normalizeEndpoint(endpoint: string): string {
  let e = String(endpoint ?? "").trim();
  if (e.startsWith("http")) {
    const i = e.indexOf("/fiscal_service/");
    if (i >= 0) e = e.slice(i + "/fiscal_service/".length);
  }
  e = e.split("?")[0].replace(/^\/+|\/+$/g, "");
  if (!e.startsWith("v1/") && !e.startsWith("v2/")) {
    throw new DataError(`endpoint ${pyRepr(endpoint)} should look like v1/accounting/mts/mts_table_1`, "spec");
  }
  return e;
}

const val = (v: unknown) => pyStr(v).trim();

/** Friendly filter -> API filter string (bare value = eq, list = in); a string is passed through unchanged. */
export function filterString(filters: Filter): string {
  if (!filters || (typeof filters === "object" && !Array.isArray(filters) && !Object.keys(filters).length)) return "";
  if (typeof filters === "string") return filters;
  const parts: string[] = [];
  for (const [field, cond] of Object.entries(filters)) {
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, v] of Object.entries(cond)) {
        if (!OPERATORS.includes(op)) {
          throw new DataError(`filter operator ${pyRepr(op)} on ${field}: use one of ${OPERATORS.join(", ")}`, "spec");
        }
        if (op === "in") parts.push(`${field}:in:(${(Array.isArray(v) ? v : [v]).map(val).join(",")})`);
        else parts.push(`${field}:${op}:${val(v)}`);
      }
    } else if (Array.isArray(cond)) parts.push(`${field}:in:(${cond.map(val).join(",")})`);
    else parts.push(`${field}:eq:${val(cond)}`);
  }
  return parts.join(",");
}

export function queryParams(fields?: string[] | string | null, filters?: Filter, sort?: string | string[] | null,
  pageSize = MAX_PAGE, pageNumber = 1, fmt = "json"): Record<string, string> {
  const p: Record<string, string> = {};
  if (fields && (!Array.isArray(fields) || fields.length)) p.fields = Array.isArray(fields) ? fields.join(",") : String(fields);
  const f = filterString(filters);
  if (f) p.filter = f;
  if (sort && (!Array.isArray(sort) || sort.length)) p.sort = Array.isArray(sort) ? sort.join(",") : String(sort);
  if (fmt && fmt !== "json") p.format = fmt;
  p["page[number]"] = String(pageNumber);
  p["page[size]"] = String(Math.min(Math.trunc(pageSize), MAX_PAGE));
  return p;
}

/** Brackets as %5B %5D (curl and PowerShell alike), spaces as %20; , : ( ) - kept. */
export function buildUrl(endpoint: string, params: Record<string, string>): string {
  const safe = ",:()-";
  return BASE + normalizeEndpoint(endpoint) + "?" +
    Object.entries(params).map(([k, v]) => `${pyQuote(k, safe)}=${pyQuote(v, safe)}`).join("&");
}

export class FiscalDataClient {
  private c: Client | null = null;
  constructor(public timeout = 60, public retries = 4, public log: (m: string) => void = () => undefined) {}

  client(): Client {
    if (!this.c || this.c.retries !== this.retries) {
      this.c = new Client("https://api.fiscaldata.treasury.gov", { name: "treasury", rps: 4, burst: 8, retries: this.retries,
        timeout: this.timeout, deadline: this.timeout * (this.retries + 2), userAgent: USER_AGENT });
    }
    return this.c;
  }

  async getRaw(url: string): Promise<Buffer> {
    let r;
    try {
      r = await this.client().request("GET", url, null, { okStatuses: [200, 400, 404] });
    } catch (e) {
      if (e instanceof DataError) {
        if (e.kind === "network") throw new DataError(`cannot reach api.fiscaldata.treasury.gov: ${e.message}`, "network");
        throw new DataError(e.message, "http", e.status);
      }
      throw e;
    }
    if (r.status === 200) return r.body;
    const body = r.body.toString("utf8").slice(0, 600);
    let msg: string = body;
    try {
      const j = JSON.parse(body);
      let m = j?.message || j?.error || body;
      if (m && typeof m === "object") m = JSON.stringify(m);
      msg = String(m);
    } catch {
      /* not JSON */
    }
    if (r.status === 404) {
      msg = "no such endpoint. Each endpoint has one fixed version (v1 or v2); find the exact path with request_schema search";
      throw new DataError(`HTTP 404 for ${url}: ${msg}`, "not_found", 404);
    }
    throw new DataError(`HTTP ${r.status} for ${url}: ${msg}`, "bad_request", r.status);
  }

  async getJson(endpoint: string, params: Record<string, string>): Promise<any> {
    const raw = await this.getRaw(buildUrl(endpoint, params));
    try {
      return parsePyJson(raw.toString("utf8").replace(/^﻿/, ""));
    } catch {
      throw new DataError(`the API returned something that is not JSON: b'${raw.subarray(0, 200).toString("latin1")}'`, "http");
    }
  }

  /** One tiny request: {reachable, detail}. */
  async ping(): Promise<{ reachable: boolean; detail: string; kind?: string }> {
    const saved = this.retries;
    this.retries = 1;
    try {
      await this.getJson("v2/accounting/od/debt_to_penny", { fields: "record_date", "page[size]": "1", sort: "-record_date" });
      return { reachable: true, detail: "ok" };
    } catch (e: any) {
      if (!(e instanceof DataError)) throw e;
      return { reachable: false, detail: e.message.slice(0, 300), kind: e.kind };
    } finally {
      this.retries = saved;
    }
  }

  /** labels, dataTypes, dataFormats, total-count (under the filter and fields) and the first and last row by
   * dateField (when the endpoint has that column). */
  async meta(endpoint: string, filters?: Filter, dateField: string | null = "record_date", fields?: string[] | null): Promise<any> {
    const j = await this.getJson(endpoint, queryParams(fields, filters, null, 1));
    const m: any = { ...(j?.meta || {}) };
    m.first_row = m.last_row = null;
    if (dateField && dateField in (m.labels || {})) {
      for (const [key, sort] of [["first_row", dateField], ["last_row", "-" + dateField]]) {
        try {
          const r = await this.getJson(endpoint, queryParams(fields, filters, sort, 1));
          m[key] = (r?.data && r.data.length ? r.data : [null])[0];
        } catch (e) {
          if (e instanceof DataError && e.kind === "network") throw e;
          if (!(e instanceof DataError)) throw e;
        }
      }
    }
    return m;
  }

  /** Every row that matches, across pages; checks the row count against meta.total-count. */
  async fetchAll(endpoint: string, fields?: string[] | null, filters?: Filter, sort?: string | null,
    pageSize = MAX_PAGE, maxRows?: number | null): Promise<[any[], any]> {
    let rows: any[] = [];
    let page = 1;
    let meta: any = {};
    for (;;) {
      const j = await this.getJson(endpoint, queryParams(fields, filters, sort, pageSize, page));
      meta = j?.meta || meta;
      const data: any[] = j?.data || [];
      rows = rows.concat(data);
      const total = Number(meta["total-count"] || 0);
      const pages = Number(meta["total-pages"] || 1);
      this.log(`[fiscaldata] ${normalizeEndpoint(endpoint)}: page ${page}/${pages}, ${fmtInt(rows.length)}/${fmtInt(total)} rows`);
      if (maxRows && rows.length >= maxRows) {
        rows = rows.slice(0, maxRows);
        break;
      }
      if (page >= pages || !data.length) break;
      page++;
    }
    const total = Number(meta["total-count"] || rows.length);
    if (!maxRows && rows.length !== total) {
      throw new DataError(`row count check failed for ${endpoint}: got ${fmtInt(rows.length)}, the API reports ` +
        `${fmtInt(total)}. The data may have been updated during the download; run again.`, "http");
    }
    return [rows, meta];
  }
}

/** f"{n:,}" for an integer. */
export function fmtInt(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  return (n < 0 ? "-" : "") + s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
