/**
 * treasury-yields adapter (port of the Python adapter.py): one CSV request per calendar year, stacked into one
 * tidy table per request.
 *
 * home.treasury.gov serves each interest-rate feed as one CSV per calendar year:
 *   .../interest-rates/daily-treasury-rates.csv/<year>/all?type=<feed>&field_tdr_date_value=<year>&_format=csv
 * Rows come newest first with a "Date" column in MM/DD/YYYY. This adapter
 *   - requests every year from start_year to end_year (default: the current year),
 *   - writes `date` as YYYY-MM-DD and keeps every maturity column with the published header,
 *   - stacks the years oldest first; maturities a year did not publish are empty cells; a published 0.00 is kept.
 */
import fs from "node:fs";
import path from "node:path";
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { decodeText, readCsv } from "../core/tabular.js";

const SPEC_ONLY = ["start_year", "end_year", "year"];

/** Python int() of a spec value (throws as int() raises). */
function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v.trim(), 10);
  throw new TypeError(`invalid literal for int(): ${String(v)}`);
}

const thisYear = () => new Date().getFullYear();
const given = (v: unknown) => v !== null && v !== undefined && v !== "";

function years(req: SpecRequest): number[] {
  const p: Record<string, any> = req.params || {};
  const now = thisYear();
  let y0: number, y1: number;
  if (given(p.year)) y0 = y1 = pyInt(p.year);
  else {
    y0 = pyInt(p.start_year || now);
    y1 = pyInt(p.end_year || (p.start_year ? now : y0));
  }
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) out.push(y);
  return out;
}

function iso(v: unknown): string {
  const s = String(v ?? "").trim();
  const parts = s.split("/");
  if (parts.length === 3 && parts.every((x) => /^\d+$/.test(x))) {
    const [m, d, y] = parts.map((x) => parseInt(x, 10));
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return s;
}

/** Stack yearly chunks (each newest first) into one table, oldest first, with `date` first and the union of the
 * maturity columns in the order the latest year publishes them. */
function tidy(chunks: Row[][]): Row[] {
  const cols: string[] = [];
  const latest = (rs: Row[]) => rs.map((r) => iso(r.Date ?? "")).reduce((a, b) => (b > a ? b : a), "");
  for (const rows of [...chunks].sort((a, b) => { const x = latest(a), y = latest(b); return x === y ? 0 : x < y ? 1 : -1; })) {
    for (const r of rows) for (const k of Object.keys(r)) if (k !== "Date" && !cols.includes(k)) cols.push(k);
  }
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const rows of chunks) {
    for (const r of rows) {
      const d = iso(r.Date ?? "");
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push({ date: d, ...Object.fromEntries(cols.map((c) => [c, c in r ? r[c] : ""])) });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? 0 : (a.date as string) < (b.date as string) ? -1 : 1));
}

function checkSpec(spec: Spec, pack: Pack): string[] {
  const probs: string[] = [];
  const now = thisYear();
  const eps = pack?.endpoints?.endpoints || {};
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    try {
      for (const k of SPEC_ONLY) if (given(p[k])) pyInt(p[k]);
    } catch {
      probs.push(`request '${r.name}': year, start_year and end_year are four-digit years`);
      continue;
    }
    const ep = eps[r.endpoint || ""] || {};
    const ys = years(r);
    if (!ys.length) {
      probs.push(`request '${r.name}': end_year is before start_year`);
      continue;
    }
    const first = ep.first_year;
    if (first && ys[0] < first) probs.push(`request '${r.name}': ${r.endpoint} starts in ${first} (asked from ${ys[0]})`);
    if (ys[ys.length - 1] > now) probs.push(`request '${r.name}': ${ys[ys.length - 1]} is in the future`);
    if (ys.length > 40) probs.push(`request '${r.name}': ${ys.length} years is one request each; split it or narrow it`);
  }
  return probs;
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const client = gr.clientFor(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const base = Object.fromEntries(Object.entries(params).filter(([k]) => !SPEC_ONLY.includes(k)));
    const chunks: Row[][] = [], empty: number[] = [];
    for (const y of years(r)) {
      const [rows] = await gr.fetchRequest(client, ep, { ...base, year: y, field_tdr_date_value: y });
      if (rows.length) chunks.push(rows);
      else empty.push(y);
    }
    if (empty.length) notes.push(`${r.name}: no rows published for ${empty.join(", ")}`);
    const rows = tidy(chunks);
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request '${r.name}' returned no rows for [${years(r).join(", ")}] (see source.md: feed ` +
        "start years)", "bad_request");
    }
    if (rows.length) {
      notes.push(`${r.name}: ${rows[0].date} to ${rows[rows.length - 1].date}, ${rows.length.toLocaleString("en-US")} days`);
    }
    tables[r.name] = rows;
  }
  return [tables, notes];
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const base = String(pack.endpoints?.base_url || "").replace(/\/+$/, "");
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const feed = params.type;
    for (const y of years(r)) {
      items.push({ name: `${r.name}#${y}`, request: r.name,
        url: `${base}/daily-treasury-rates.csv/${y}/all?type=${feed}&field_tdr_date_value=${y}&_format=csv`,
        filename: `${r.name}_${y}.csv`, needs_key: false, method: "GET", body: null,
        note: "or: Interest Rate Statistics page > choose the rate type and the year > Download CSV" });
    }
  }
  return items;
}

function parseUpload(_pack: Pack, _req: SpecRequest, files: string[]): Row[] {
  const chunks: Row[][] = [];
  for (const p of files) {
    const rows = readCsv(decodeText(fs.readFileSync(p)));
    if (rows.length && !("Date" in rows[0])) {
      throw new DataError(`${path.basename(p)} has no Date column: upload the CSV from the download link`, "bad_request");
    }
    chunks.push(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [k, v === null || v === undefined || ["", "N/A"].includes(String(v).trim()) ? "" : v]))));
  }
  return tidy(chunks);
}

const adapter: Adapter = { checkSpec, fetch, manualItems, parseUpload };
export default adapter;
