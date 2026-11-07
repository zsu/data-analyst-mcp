/**
 * FHFA adapter: published files (no API), read whole and filtered to the spec.
 *
 * FHFA publishes its House Price Index, conforming loan limits and Public Use Databases as files with stable names
 * (overwritten in place) on www.fhfa.gov. The generic reader fetches a file ($csv / $xlsx); this adapter then
 *   - names the columns of headerless files (endpoint "header": hpi_at_state.csv has no header row),
 *   - renames loan-limit columns to snake_case ("One-Unit\nLimit" in 2026, "One_Unit_Limit" in 2025 -> one_unit_limit),
 *     makes "$832,750 " a plain 832750 and zero-pads FIPS codes (2025 has "1"/"1", 2026 "01"/"001"),
 *   - writes .xlsx numbers stored as binary floats in their shortest form ("69.150000000000006" -> "69.15"),
 *   - keeps the rows that match the spec's filters: params declared with "column", "where" {column: value or list}
 *     and min_year / max_year on the endpoint's "year_column". Matching ignores case and surrounding spaces; a
 *     filter column the file lacks is an error naming its columns.
 * max_rows applies AFTER filtering (the files are read whole), so fetch() runs the generic fetch without the spec's
 * max_rows and cuts each table afterwards, with the usual "stopped at" note.
 */
import * as gr from "../core/generic-rest.js";
import { DataError, Response } from "../core/http.js";
import { parse } from "csv-parse/sync";
import fs from "node:fs";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { parsePyJson, pyFloatRepr, pyStr } from "../core/py.js";
import { decodeText, readCsv } from "../core/tabular.js";

const LONG_FLOAT = /^-?\d+\.\d{9,}$|^-?\d+(\.\d+)?[eE][-+]?\d+$/;
const MONEY = /^\$?\s*-?[\d,]+(\.\d+)?$/;

/** Python repr() of a str. */
function repr(s: unknown): string {
  if (s === null || s === undefined) return "None";
  const t = String(s);
  const q = t.includes("'") && !t.includes('"') ? '"' : "'";
  return q + t.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n").replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t") + q;
}

const blank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
const isDigits = (s: string) => /^\d+$/.test(s);
const norm = (v: unknown) => pyStr(v).split(/\s+/).filter(Boolean).join(" ").toLowerCase();
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

function filters(ep: any, prm: Record<string, any>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [k, d] of Object.entries<any>(ep.params || {})) {
    if (d.column && !blank(prm[k])) out.set(d.column, new Set(asList(prm[k]).map(norm)));
  }
  for (const [k, v] of Object.entries(prm.where || {})) out.set(k, new Set(asList(v).map(norm)));
  return out;
}

function checkSpec(spec: Spec, pack: Pack): string[] {
  const probs: string[] = [];
  const eps = pack.endpoints?.endpoints || {};
  for (const r of spec.requests || []) {
    const prm: Record<string, any> = r.params || {};
    if ("where" in prm && (!prm.where || typeof prm.where !== "object" || Array.isArray(prm.where))) {
      probs.push(`request ${repr(r.name)}: where must be an object {column: value or list}`);
    }
    for (const k of ["min_year", "max_year"]) {
      if (prm[k] !== null && prm[k] !== undefined && prm[k] !== "" && !isDigits(pyStr(prm[k]).trim())) {
        probs.push(`request ${repr(r.name)}: ${k} must be a year (e.g. 2020)`);
      }
    }
    const ep = eps[r.endpoint || ""];
    if (ep && ("min_year" in prm || "max_year" in prm) && !ep.year_column) {
      probs.push(`request ${repr(r.name)}: endpoint ${repr(r.endpoint)} has no year column; use where`);
    }
    if (r.endpoint === "loan_limits" && isDigits(pyStr(prm.year ?? "")) && Number(prm.year) < 2024) {
      probs.push(`request ${repr(r.name)}: loan limit CSV files start with 2024; earlier years are .xlsx ` +
        "files on https://www.fhfa.gov/data/conforming-loan-limit (manual download)");
    }
  }
  return probs;
}

/**
 * A headerless file is read with its header line put first. Python's reader took the first data line as the header
 * and the adapter put it back as a row; a JS object moves integer-like keys ("1975", "1") to the front and so loses
 * that line's order, so here the header line is added to the file before parsing instead. The body stays as is
 * (and normalize then fails with Python's message) when the layout changed: a first line of another width, or a
 * longer line (Python's reader put its extra cells under None).
 */
function withHeader(ep: any, body: Buffer): Buffer | null {
  const names: string[] = ep.header;
  let grid: string[][];
  try {
    grid = parse(decodeText(body), { relax_column_count: true, relax_quotes: true, skip_empty_lines: true });
  } catch {
    return null;
  }
  if (!grid.length) return body;
  if (grid[0].length !== names.length || grid.some((r) => r.length > names.length)) return null;
  const bom = body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  return Buffer.concat([Buffer.from(names.join(",") + "\n", "utf8"), body.subarray(bom)]);
}

/**
 * Line ends outside quoted fields made "
". The 2026 loan-limit file ends its header with LF (inside and after
 * quoted names) and its rows with CRLF; Python's csv reads both, while core's reader (csv-parse) takes the first
 * line end it meets for the whole file and then reads a quoted last cell plus the CR as text. Quoted cells keep
 * their line ends, as in Python.
 */
function unifyEols(body: Buffer): Buffer {
  if (!body.includes(0x0d)) return body;
  const out = Buffer.alloc(body.length);
  let n = 0, quoted = false;
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b === 0x22) quoted = !quoted;
    else if (b === 0x0d && !quoted) {
      out[n++] = 0x0a;
      if (body[i + 1] === 0x0a) i++;
      continue;
    }
    out[n++] = b;
  }
  return out.subarray(0, n);
}

function reshape(ep: any, rows: Row[]): Row[] {
  if (ep.header && rows.length) {
    const names: string[] = ep.header;
    const have = Object.keys(rows[0]);
    if (have.length !== names.length || !names.every((n) => n in rows[0])) {
      throw new DataError(`the file no longer has ${names.length} columns (${names.join(", ")}): its layout changed; ` +
        "check it on FHFA's HPI datasets page", "api");
    }
    rows = rows.map((r) => Object.fromEntries(names.map((n) => [n, r[n]])));
  }
  if (ep.snake_columns) {
    rows = rows.map((r) => {
      const o: Row = {};
      for (const [k, v] of Object.entries(r)) o[k.toLowerCase().replace(/[^0-9a-z]+/g, "_").replace(/^_+|_+$/g, "")] = v;
      return o;
    });
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) {
        if (k.endsWith("_limit") && typeof v === "string" && MONEY.test(v.trim())) {
          r[k] = v.trim().replace(/^\$+/, "").replace(/,/g, "").trim();
        }
      }
      for (const [k, w] of [["fips_state_code", 2], ["fips_county_code", 3]] as [string, number][]) {
        const s = pyStr(r[k] ?? "").trim();
        if (isDigits(s)) r[k] = s.padStart(w, "0");
      }
    }
  }
  if (ep.records === "$xlsx") {
    for (const r of rows) {
      for (const [k, v] of Object.entries(r)) if (typeof v === "string" && LONG_FLOAT.test(v)) r[k] = pyFloatRepr(Number(v));
    }
  }
  return rows;
}

function normalize(req: SpecRequest, ep: any, rows: Row[]): Row[] {
  rows = reshape(ep, rows);
  const prm: Record<string, any> = req.params || {};
  const flt = filters(ep, prm);
  if (rows.length && flt.size) {
    const missing = [...flt.keys()].filter((c) => !(c in rows[0]));
    if (missing.length) {
      throw new DataError(`request ${repr(req.name)}: column(s) [${missing.map(repr).join(", ")}] are not in this file; its ` +
        `columns are: ${Object.keys(rows[0]).join(", ")}`, "bad_request");
    }
    rows = rows.filter((r) => [...flt].every(([c, vals]) => vals.has(norm(r[c] ?? ""))));
  }
  const yc = ep.year_column;
  const lo = prm.min_year, hi = prm.max_year;
  const none = (v: unknown) => v === null || v === undefined || v === "";
  if (yc && (!none(lo) || !none(hi))) {
    rows = rows.filter((r) => {
      const y = pyStr(r[yc] ?? "").trim();
      if (!isDigits(y)) return false;
      return (none(lo) || Number(y) >= parseInt(pyStr(lo), 10)) && (none(hi) || Number(y) <= parseInt(pyStr(hi), 10));
    });
  }
  return rows;
}

function requestNote(req: SpecRequest, ep: any): string | null {
  if (ep.snake_columns) {
    return `${req.name}: columns renamed to snake_case, dollar limits written as plain numbers ("$832,750" -> ` +
      "832750) and FIPS codes zero-padded, so every year's file has the same layout.";
  }
  return null;
}

function checkError(status: number, body: Buffer): string | null {
  const head = (body || Buffer.alloc(0)).subarray(0, 200).toString("latin1").trimStart().toLowerCase();
  if (status === 200 && (head.startsWith("<!doctype") || head.startsWith("<html"))) {
    return "FHFA answered with a web page instead of the data file (the file may have moved: see source.md)";
  }
  return null;
}

/** An endpoint path ("/document/d/pud/{year}-pudb.csv") as a pattern for the request paths it gives. */
function pathPattern(p: string): RegExp {
  const parts = p.split(/\{\w+\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("^" + parts.join("[^/]*") + "$");
}

/** The generic fetch with max_rows applied after filtering (the files are read whole). */
async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const caps = new Map((spec.requests || []).map((r) => [r.name, r.max_rows] as [string, number | undefined]));
  const plain: Spec = { ...spec, requests: (spec.requests || []).map(({ max_rows: _m, ...rest }) => rest as SpecRequest) };
  const client = gr.clientFor(pack);
  // each endpoint path is fixed but for {year}/{geography}: match the request path against it
  const eps = Object.values<any>(pack.endpoints?.endpoints || {}).filter((ep) => ep.records === "$csv")
    .map((ep) => [pathPattern(String(ep.path)), ep] as [RegExp, any]);
  const request = client.request.bind(client);
  client.request = async (method, p, params, o) => {
    const r = await request(method, p, params, o);
    const ep = eps.find(([re]) => re.test(p ?? ""))?.[1];
    if (!ep || r.status !== 200) return r;
    let body = unifyEols(r.body);
    if (ep.header) body = withHeader(ep, body) ?? body;
    return body === r.body ? r : new Response(r.status, r.headers, body, r.url, r.cached);
  };
  const [tables, notes] = await gr.fetchSpec(pack, plain, client);
  for (const [name, cap] of caps) {
    const t = tables[name];
    if (cap && Array.isArray(t) && t.length > Number(cap)) {
      const n = t.length, c = Math.trunc(Number(cap));
      tables[name] = t.slice(0, c);
      notes.push(`${name}: stopped at ${c.toLocaleString("en-US")} rows (max_rows); ${n.toLocaleString("en-US")} rows ` +
        "matched the filters. Narrow the filters or raise max_rows.");
    }
  }
  return [tables, notes];
}

/** Rows from uploaded files (gr.parseUpload, with a headerless file's header line put first). */
function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [ep0, params] = gr.resolve(pack, req);
  const ep = gr.withRecordParams(ep0, params);
  const natural = (s: string) => s.split(/(\d+)/).map((x) => (/^\d+$/.test(x) ? x.padStart(20, "0") : x)).join("");
  let rows: any[] = [];
  for (const f of [...files].sort((a, b) => (natural(a) < natural(b) ? -1 : 1))) {
    let data: Buffer = fs.readFileSync(f);
    if (ep.records === "$csv" || f.toLowerCase().endsWith(".csv")) data = unifyEols(data);
    if (ep.header) data = withHeader(ep, data) ?? data;
    const r = { body: data, text: () => decodeText(data), json: () => parsePyJson(data.toString("utf8").replace(/^﻿/, "")) };
    rows = rows.concat(f.toLowerCase().endsWith(".csv") && ep.records !== "$csv" ? readCsv(r.text()) : gr.records(ep, r));
  }
  return normalize(req, ep, gr.clean(rows, ep));
}

const adapter: Adapter = { checkSpec, normalize, requestNote, checkError, fetch, parseUpload };
export default adapter;
