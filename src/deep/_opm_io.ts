/**
 * Read raw OPM workforce files in chunks (port of the Python pack's opm_io.py).
 *
 * Formats:
 *   .parquet   from the API (the only format it serves); read by _opm_parquet.ts.
 *   .txt/.csv  from the FWD Data Downloads web page ("Download .TXT"). Delimiter sniffed (comma, pipe, tab,
 *              semicolon, caret); the first row must be the field names. Streamed.
 *   .json      from the web page ("Download .JSON"): a JSON array of records, JSON Lines, or an object wrapping
 *              the array (e.g. {"data": [...]}). Arrays and JSON Lines are streamed.
 *   .gz / .zip of any of these.
 * Every value is returned as a string (codes keep leading zeros), like the Parquet files; empty text fields are
 * nulls, as Parquet stores them.
 */
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";
import { parse } from "csv-parse";
import { unzipSync } from "fflate";
import { parsePyJson, pyStr } from "../core/py.js";
import { ParquetFile } from "./_opm_parquet.js";

export const CHUNK_ROWS = 250_000;
export const DATASET_MARKERS: Record<string, string> = { separations: "separation_category",
  accessions: "accession_category", employment: "snapshot_yyyymm" };

export type Frame = { rows: number; data: Record<string, (string | null)[]> };

// ---------------------------------------------------------------- text sources
function zipMembers(p: string): Record<string, Uint8Array> {
  return unzipSync(fs.readFileSync(p));
}

function firstMember(p: string): string {
  const name = Object.keys(zipMembers(p)).find((n) => !n.endsWith("/"));
  if (!name) throw new Error(`${path.basename(p)}: the ZIP is empty`);
  return name;
}

/** Raw bytes of a plain, .gz or single-member .zip file, in chunks. */
async function* rawChunks(p: string): AsyncGenerator<Buffer> {
  const low = p.toLowerCase();
  if (low.endsWith(".zip")) {
    const m = zipMembers(p);
    const data = m[firstMember(p)];
    for (let i = 0; i < data.length; i += 1 << 20) yield Buffer.from(data.subarray(i, i + (1 << 20)));
    return;
  }
  const s = fs.createReadStream(p, { highWaterMark: 1 << 20 });
  const src = low.endsWith(".gz") ? s.pipe(zlib.createGunzip()) : s;
  for await (const c of src) yield c as Buffer;
}

/** Text of the file in chunks (UTF-8, BOM removed, invalid bytes replaced). */
async function* textChunks(p: string): AsyncGenerator<string> {
  const dec = new StringDecoder("utf8");
  let first = true;
  for await (const c of rawChunks(p)) {
    let t = dec.write(c);
    if (first && t) {
      t = t.replace(/^﻿/, "");
      first = false;
    }
    if (t) yield t;
  }
  const t = dec.end();
  if (t) yield t;
}

async function head(p: string, n: number): Promise<string> {
  let s = "";
  for await (const t of textChunks(p)) {
    s += t;
    if (s.length >= n) break;
  }
  return s.slice(0, n);
}

async function lines(p: string, n: number): Promise<string[]> {
  const out: string[] = [];
  let rest = "";
  for await (const t of textChunks(p)) {
    const parts = (rest + t).split(/(?<=\n)/);
    rest = parts.pop() || "";
    for (const l of parts) {
      out.push(l);
      if (out.length >= n) return out;
    }
  }
  if (rest) out.push(rest);
  return out.slice(0, n);
}

/** File name that tells the format: the member of a .zip, or the name without .gz. */
export function innerName(p: string): string {
  const low = p.toLowerCase();
  if (low.endsWith(".zip")) return firstMember(p);
  return low.endsWith(".gz") ? p.slice(0, -3) : p;
}

export async function fileKind(p: string): Promise<"parquet" | "json" | "text"> {
  const name = innerName(p).toLowerCase();
  if (name.endsWith(".parquet")) return "parquet";
  if (name.endsWith(".json") || name.endsWith(".jsonl")) return "json";
  if ([".txt", ".csv", ".tsv", ".dat"].some((e) => name.endsWith(e))) return "text";
  const h = (await head(p, 2048)).trimStart();
  return h && "[{".includes(h[0]) ? "json" : "text";
}

// ---------------------------------------------------------------- delimiter sniffing (csv.Sniffer, simplified)
const DELIMS = [",", "|", "\t", ";", "^"];
const PREFERRED = [",", "\t", ";", "|", "^"];

function countOutsideQuotes(line: string, d: string): number {
  let n = 0, q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === d && !q) n++;
  }
  return n;
}

export async function sniffDelimiter(p: string): Promise<string> {
  const sample = (await lines(p, 20)).map((l) => l.replace(/\r?\n$/, "")).filter((l) => l.length);
  const ok: string[] = [];
  for (const d of DELIMS) {
    const counts = sample.map((l) => countOutsideQuotes(l, d));
    if (counts.length && counts[0] > 0 && counts.every((c) => c === counts[0])) ok.push(d);
  }
  if (ok.length) return PREFERRED.find((d) => ok.includes(d))!;
  const first = sample[0] || "";
  let best = DELIMS[0], n = -1;
  for (const d of DELIMS) {
    const c = first.split(d).length - 1;
    if (c > n) [best, n] = [d, c];
  }
  return best;
}

const normCol = (c: string) => c.trim().replace(/^"+|"+$/g, "").toLowerCase();

function csvRecords(p: string, d: string): AsyncIterable<string[]> {
  const parser = parse({ delimiter: d, relax_column_count: true, relax_quotes: true, skip_empty_lines: true });
  (async () => {
    try {
      for await (const t of textChunks(p)) if (!parser.write(t)) await new Promise((r) => parser.once("drain", r));
      parser.end();
    } catch (e) {
      parser.destroy(e as Error);
    }
  })();
  return parser;
}

export async function textColumns(p: string): Promise<string[]> {
  const d = await sniffDelimiter(p);
  for await (const rec of csvRecords(p, d)) return rec.map(normCol);
  return [];
}

async function* iterText(p: string, columns: string[] | null): AsyncGenerator<Frame> {
  const d = await sniffDelimiter(p);
  let head: string[] | null = null;
  let idx: [string, number][] = [];
  let frame: Frame | null = null;
  const fresh = (): Frame => ({ rows: 0, data: Object.fromEntries(idx.map(([c]) => [c, []])) });
  for await (const rec of csvRecords(p, d)) {
    if (!head) {
      head = rec.map(normCol);
      const want = new Set((columns || head).filter((c) => head!.includes(c)));
      idx = head.map((c, i) => [c, i] as [string, number]).filter(([c]) => want.has(c));
      frame = fresh();
      continue;
    }
    for (const [c, i] of idx) {
      const v = rec[i];
      frame!.data[c].push(v === undefined || v === "" ? null : v);
    }
    frame!.rows++;
    if (frame!.rows >= CHUNK_ROWS) {
      yield frame!;
      frame = fresh();
    }
  }
  if (frame && frame.rows) yield frame;
}

// ---------------------------------------------------------------- JSON
/** Stream records from a JSON array, JSON Lines, or {"<key>": [records]} file. */
async function* jsonRecords(p: string): AsyncGenerator<Record<string, unknown>> {
  const h = (await head(p, 1 << 20)).trimStart();
  if (h.startsWith("{")) {
    const firstLine = h.split("\n", 1)[0].trim();
    let isLines = true;
    try {
      // a one-line wrapper object ({"data": [...]}) is not JSON Lines: OPM records hold only scalar values
      const first = JSON.parse(firstLine);
      if (first && typeof first === "object" && Object.values(first).some((v) => Array.isArray(v))) isLines = false;
    } catch {
      isLines = false;
    }
    if (isLines) {
      let rest = "";
      for await (const t of textChunks(p)) {
        const parts = (rest + t).split("\n");
        rest = parts.pop() || "";
        for (const l of parts) if (l.trim()) yield parsePyJson(l.trim());
      }
      if (rest.trim()) yield parsePyJson(rest.trim());
      return;
    }
    let all = "";
    for await (const t of textChunks(p)) all += t;
    const obj = parsePyJson<Record<string, unknown>>(all);
    const arr = Object.values(obj).find((v) => Array.isArray(v)) as Record<string, unknown>[] | undefined;
    yield* arr || [];
    return;
  }
  // an array of records: cut each top-level element out by depth, across chunk boundaries
  let depth = 0, inStr = false, esc = false, buf = "", start = -1, from = 0;
  for await (const t of textChunks(p)) {
    buf += t;
    for (let i = from; i < buf.length; i++) {
      const c = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") {
        depth++;
        if (depth === 2) start = i;
      } else if (c === "}" || c === "]") {
        if (depth === 2 && start >= 0) {
          yield parsePyJson(buf.slice(start, i + 1));
          buf = buf.slice(i + 1);
          i = -1;
          start = -1;
        }
        depth--;
        if (depth === 0) return;
      }
    }
    if (start < 0) [buf, from] = ["", 0];
    else {
      buf = buf.slice(start);
      start = 0;
      from = buf.length;
    }
  }
}

export async function jsonColumns(p: string): Promise<string[]> {
  for await (const rec of jsonRecords(p)) return Object.keys(rec).map((k) => String(k).toLowerCase());
  return [];
}

async function* iterJson(p: string, columns: string[] | null): AsyncGenerator<Frame> {
  const want = columns ? new Set(columns) : null;
  let batch: Record<string, string | null>[] = [];
  const flush = (): Frame => {
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const r of batch) for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), cols.push(k));
    const data: Record<string, (string | null)[]> = {};
    for (const c of cols) data[c] = batch.map((r) => r[c] ?? null);
    const f = { rows: batch.length, data };
    batch = [];
    return f;
  };
  for await (const rec of jsonRecords(p)) {
    const row: Record<string, string | null> = {};
    for (const [k0, v] of Object.entries(rec)) {
      const k = String(k0).toLowerCase();
      if (want && !want.has(k)) continue;
      row[k] = v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v)) ? null : pyStr(v);
    }
    batch.push(row);
    if (batch.length >= CHUNK_ROWS) yield flush();
  }
  if (batch.length) yield flush();
}

// ---------------------------------------------------------------- dispatch
export async function columnsOf(p: string): Promise<string[]> {
  const k = await fileKind(p);
  if (k === "parquet") return new ParquetFile(p).columns();
  return k === "text" ? textColumns(p) : jsonColumns(p);
}

export async function* iterFrames(p: string, columns: string[] | null = null): AsyncGenerator<Frame> {
  const k = await fileKind(p);
  if (k === "parquet") {
    const f = new ParquetFile(p);
    for (const g of f.rowGroups(columns)) yield { rows: g.rows, data: g.data };
  } else if (k === "text") yield* iterText(p, columns);
  else yield* iterJson(p, columns);
}

export type Who = { dataset: string | null; year: number | null; month: number | null; version: number | null;
  how: "name" | "content" };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december"];

/**
 * Guess dataset, year, month and version of a hand-downloaded file: from its name first
 * (employment_202608_1.parquet, 'Federal Separations Raw Data (August 2026).txt'), then from its content.
 */
export async function identify(p: string): Promise<Who> {
  const name = path.basename(innerName(p));
  const out: Who = { dataset: null, year: null, month: null, version: null, how: "name" };
  let m = /(employment|accessions|separations)_(\d{4})(\d{2})_(\d+)/i.exec(name);
  if (m) {
    return { dataset: m[1].toLowerCase(), year: Number(m[2]), month: Number(m[3]), version: Number(m[4]), how: "name" };
  }
  const low = name.toLowerCase();
  for (const ds of Object.keys(DATASET_MARKERS)) if (low.includes(ds)) out.dataset = ds;
  // Month names as whole words only, after removing the dataset words: "separations" starts with "sep".
  const bare = low.replace(/employment|accessions|separations/g, " ");
  const names = [...MONTHS, ...MONTHS.map((x) => x.slice(0, 3)), "sept"];
  m = new RegExp("(?<![a-z])(" + names.join("|") + ")(?![a-z])[\\s_.,-]*(\\d{4})(?!\\d)").exec(bare);
  if (m) {
    const mm = m[1];
    out.month = MONTHS.findIndex((x) => x.startsWith(mm.slice(0, 3))) + 1;
    out.year = Number(m[2]);
  } else {
    m = /(?<!\d)(20\d{2})[-_]?(0[1-9]|1[0-2])(?!\d)/.exec(bare);
    if (m) [out.year, out.month] = [Number(m[1]), Number(m[2])];
  }
  m = /(?:version|ver|(?<![a-z])v)[\s_.-]*(\d+)(?!\d)/.exec(bare);
  if (m) out.version = Number(m[1]);
  if (out.dataset && out.year) return out;
  out.how = "content";
  const cols = new Set(await columnsOf(p));
  for (const [ds, marker] of Object.entries(DATASET_MARKERS)) if (cols.has(marker) && !out.dataset) out.dataset = ds;
  const pcol = out.dataset === "employment" ? "snapshot_yyyymm" : "personnel_action_effective_date_yyyymm";
  if (cols.has(pcol) && !out.year) {
    let top: string | null = null;
    for await (const f of iterFrames(p, [pcol])) {
      for (const v of f.data[pcol] || []) if (v !== null && /^\d{6}$/.test(v) && (top === null || v > top)) top = v;
      if (out.dataset === "employment" && top) break;
    }
    if (top) [out.year, out.month] = [Number(top.slice(0, 4)), Number(top.slice(4))];
  }
  return out;
}
