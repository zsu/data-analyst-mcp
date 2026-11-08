/**
 * The in-memory table compute works on: column names in order, and rows of typed cells.
 *
 * Reading a workspace CSV, a column is numeric when every non-empty cell is a plain number literal ("1234",
 * "-0.5", "1e-05") with no leading zero ("01" stays text, so FIPS codes keep their zeros) and integers fit a
 * double exactly; "True"/"False" columns are booleans; an empty cell is null (a gap); anything else is text, so
 * "1,234" stays text unless converted with number(). Writing follows the Python csv conventions (writeCsv): CRLF,
 * minimal quoting, True/False, integers without ".0", other floats as Python's repr.
 * A Parquet input (readParquetTable) is read as the cell texts the CSV of the same table holds and typed the same
 * way, so compute gives the same result from either file.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { ParquetFile } from "../core/parquet.js";
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

type Kind = "num" | "bool" | "text";
type Cell = string | null | undefined;

/** The kind of a column from its cell texts: num or bool when every non-empty cell is one, else text. */
function kindOf(n: number, at: (i: number) => Cell): Kind {
  let k: Kind | null = null;
  for (let i = 0; i < n; i++) {
    const v = at(i);
    if (v === null || v === undefined || v === "") continue;
    const s = String(v);
    const kind = numericText(s) ? "num" : s === "True" || s === "False" ? "bool" : "text";
    if (k === null) k = kind;
    else if (k !== kind) k = "text";
    if (k === "text") break;
  }
  return k ?? "text";
}

function typed(v: Cell, kind: Kind): Value {
  if (v === null || v === undefined || v === "") return null;
  if (kind === "num") return Number(v);
  if (kind === "bool") return v === "True";
  return String(v);
}

/** Rows of a CSV text typed column by column (see the module comment). */
export function parseTable(text: string): Table {
  const t = text.replace(BOM, "");
  const cols = headerOf(t);
  const raw = readCsv(t);
  const kinds: Record<string, Kind> = Object.create(null);
  for (const c of cols) kinds[c] = kindOf(raw.length, (i) => raw[i][c] as Cell);
  const rows = raw.map((r) => {
    const o = newRow();
    for (const c of cols) o[c] = typed(r[c] as Cell, kinds[c]);
    return o;
  });
  return { cols, rows };
}

/** A table from columns of cell texts (null = a gap), typed exactly as parseTable types the same CSV. */
export function tableFromColumns(cols: string[], data: Record<string, Cell[]>, n: number): Table {
  const kinds = cols.map((c) => kindOf(n, (i) => data[c][i]));
  const rows: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = newRow();
    cols.forEach((c, j) => (o[c] = typed(data[c][i], kinds[j])));
    rows[i] = o;
  }
  return { cols, rows };
}

/** The most cells (rows x columns) compute decodes from one Parquet input; above it, name the columns needed.
 * Measured: 1M rows x 30 string columns (30M cells) took 3.1 GB of heap and 28 s, against a default heap of
 * about 4 GB, and later steps copy rows. 25M cells leaves room for those copies: a 2M-row OPM month with 12 columns. */
export const PARQUET_MAX_CELLS = { value: 25_000_000 };

export class ParquetInputError extends Error {}

/** A Parquet file's table: only `columns` (in that order) when given, else every column in the file's order. */
export function readParquetTable(buf: Buffer, file: string, columns?: string[] | null): Table {
  const pq = new ParquetFile(file, buf);
  const have = pq.columns();
  const cols = columns && columns.length ? [...new Set(columns)] : have;
  const miss = cols.filter((c) => !have.includes(c));
  if (miss.length) throw new ParquetInputError(`no column${miss.length > 1 ? "s" : ""} ${miss.join(", ")}; the columns are ${have.join(", ")}`);
  const cells = pq.numRows * cols.length;
  if (cells > PARQUET_MAX_CELLS.value) {
    throw new ParquetInputError(`${pq.numRows.toLocaleString("en-US")} rows x ${cols.length} columns is more than compute ` +
      `reads at once (${PARQUET_MAX_CELLS.value.toLocaleString("en-US")} cells): name the columns you need ` +
      `(inputs {alias: {path, columns: [...]}}), or narrow the fetch (filters, aggregate)`);
  }
  const data: Record<string, Cell[]> = Object.create(null);
  for (const c of cols) data[c] = [];
  let n = 0;
  for (const g of pq.rowGroups(cols)) {
    for (const c of cols) {
      const xs = g.data[c] ?? new Array(g.rows).fill(null);
      for (let i = 0; i < g.rows; i++) data[c].push(xs[i]);
    }
    n += g.rows;
  }
  return tableFromColumns(cols, data, n);
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
