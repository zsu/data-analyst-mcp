/**
 * The in-memory table compute works on: column names in order, and rows of typed cells.
 *
 * Reading a workspace CSV, a column is numeric when every non-empty cell is a plain number literal ("1234",
 * "-0.5", "1e-05") with no leading zero ("01" stays text, so FIPS codes keep their zeros) and integers fit a
 * double exactly; "True"/"False" columns are booleans; an empty cell is null (a gap); anything else is text, so
 * "1,234" stays text unless converted with number(). Writing follows the Python csv conventions (writeCsv): CRLF,
 * minimal quoting, True/False, integers without ".0", other floats as Python's repr.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { pyFloatRepr } from "../core/py.js";
import { readCsv, writeCsv } from "../core/tabular.js";

export type Value = string | number | boolean | null;
export type Row = Record<string, Value>;
export type Table = { cols: string[]; rows: Row[] };

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOM = /^﻿/;

function numericText(s: string): boolean {
  if (!NUM.test(s)) return false;
  const body = s.replace(/^[+-]/, "");
  if (/^0\d/.test(body)) return false;
  if (/^\d+$/.test(body) && !Number.isSafeInteger(Number(body))) return false;
  return true;
}

export function newRow(): Row {
  return Object.create(null);
}

/** Rows of a CSV text typed column by column (see the module comment). */
export function parseTable(text: string): Table {
  const t = text.replace(BOM, "");
  const cols = headerOf(t);
  const raw = readCsv(t);
  const kinds: Record<string, "num" | "bool" | "text"> = Object.create(null);
  for (const c of cols) {
    let k: "num" | "bool" | "text" | null = null;
    for (const r of raw) {
      const v = r[c];
      if (v === null || v === undefined || v === "") continue;
      const s = String(v);
      const kind = numericText(s) ? "num" : s === "True" || s === "False" ? "bool" : "text";
      if (k === null) k = kind;
      else if (k !== kind) k = "text";
      if (k === "text") break;
    }
    kinds[c] = k ?? "text";
  }
  const rows = raw.map((r) => {
    const o = newRow();
    for (const c of cols) {
      const v = r[c];
      if (v === null || v === undefined || v === "") o[c] = null;
      else if (kinds[c] === "num") o[c] = Number(v);
      else if (kinds[c] === "bool") o[c] = v === "True";
      else o[c] = String(v);
    }
    return o;
  });
  return { cols, rows };
}

/** The first `n` records of a CSV text as arrays (csv.reader). */
export function readCsvGrid(text: string, n?: number): string[][] {
  return parse(text.replace(BOM, ""), { relax_column_count: true, relax_quotes: true, skip_empty_lines: true,
    ...(n ? { to: n } : {}) }) as string[][];
}

/** The header row of a CSV text (readCsv drops it when there are no data rows). */
export function headerOf(text: string): string[] {
  return readCsvGrid(text, 1)[0] || [];
}

export function readTable(file: string): Table {
  return parseTable(fs.readFileSync(file, "utf8"));
}

/** A cell as the CSV writes it. */
export function cellText(v: Value | undefined): string {
  if (v === null || v === undefined) return "";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(v) : pyFloatRepr(v);
  }
  return v;
}

export function tableCsv(t: Table): string {
  const rows = t.rows.map((r) => Object.fromEntries(t.cols.map((c) => [c, cellText(r[c])])));
  if (t.cols.length !== 1) return writeCsv(rows, t.cols);
  // Python's csv writer quotes a row whose only field is empty ("" rather than a blank line a reader skips)
  return stringify([t.cols, ...rows.map((r) => [r[t.cols[0]]])], { record_delimiter: "\r\n", quoted_match: /[\r\n]/,
    quoted_empty: true });
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
