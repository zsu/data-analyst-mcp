/**
 * Reading published files: CSV text (as Python's csv.DictReader reads it), .xlsx workbooks (values as stored:
 * numbers unformatted, dates as serial numbers) and zip members. Legacy .xls is not read (convert it to CSV).
 */
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { DataError } from "./http.js";
import { pyFloatRepr, pyStr } from "./py.js";

export type Row = Record<string, unknown>;

const COLUMNS = Symbol("columns");

/** The rows, marked with the column order to write (Python's dict order, for keys JS would reorder). */
export function withColumns<T extends Row[]>(rows: T, columns: string[]): T {
  Object.defineProperty(rows, COLUMNS, { value: [...columns], enumerable: false, configurable: true });
  return rows;
}

export function columnsOf(rows: unknown): string[] | undefined {
  return Array.isArray(rows) ? (rows as any)[COLUMNS] : undefined;
}

const SHEETS = Symbol("sheets");
type Sheets = Record<string, (string | null)[][]>;

/** Sheet names in workbook order (a JS object would list "2024"-like names first). */
export function sheetNames(sheets: Sheets): string[] {
  return (sheets as any)[SHEETS] ?? Object.keys(sheets);
}

function inOrder(sheets: Sheets, names: string[]): Sheets {
  Object.defineProperty(sheets, SHEETS, { value: [...names], enumerable: false, configurable: true });
  return sheets;
}

/** UTF-8 (with or without BOM), else Windows-1252: agency CSVs come in both. */
export function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** Rows as csv.DictReader gives them: the first row names the columns; a short row's missing cells are null. */
export function readCsv(text: string): Row[] {
  const grid: string[][] = parse(text.replace(/^﻿/, ""), {
    relax_column_count: true, relax_quotes: true, skip_empty_lines: true,
  });
  if (!grid.length) return [];
  const [head, ...rows] = grid;
  return rows.map((r) => {
    const o: Row = {};
    head.forEach((h, i) => (o[h] = i < r.length ? r[i] : null));
    return o;
  });
}

/** The header and rows of a CSV (Python's csv module: CRLF line ends, minimal quoting). */
export function writeCsv(rows: Row[], cols: string[]): string {
  const body = rows.map((r) => cols.map((c) => pyStr(r[c])));
  return stringify([cols, ...body], { record_delimiter: "\r\n", quoted_match: /[\r\n]/ });
}

export function fnmatch(name: string, glob: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const j = glob.indexOf("]", i + 1);
      if (j < 0) re += "\\[";
      else {
        let set = glob.slice(i + 1, j);
        if (set.startsWith("!")) set = "^" + set.slice(1);
        re += `[${set.replace(/\\/g, "\\\\")}]`;
        i = j;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s").test(name);
}

export function unzip(data: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(data);
  } catch {
    throw new DataError("expected a .zip file, got something else (an HTML page?)", "api");
  }
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unxml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? all);
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unxml(m[2]);
  return out;
}

const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join("");

/**
 * What a cell's style prints beside its value, for published tables that mark cells by format only: `fmt` = the
 * literal text of the number format's section for the value's sign ("* " for `"* "#,##0`: an estimate with high
 * sampling variability), `indent` = the alignment indent (a row's level in a stub column). Fill characters
 * (`* ` unquoted, as in accounting formats) and `$ ( ) - % , .` are not literals that mark a cell.
 */
export type CellMark = { fmt?: string; indent?: number };
export type Marks = Record<string, (CellMark | null)[][]>;

/** The marking literal text of a number format code for a value (see CellMark), or "". */
export function formatMark(code: string | undefined, value?: string | null): string {
  if (!code || code === "General" || code === "@") return "";
  const sections: string[] = [];
  let cur = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      const j = code.indexOf('"', i + 1);
      cur += code.slice(i, j < 0 ? code.length : j + 1);
      i = j < 0 ? code.length : j;
    } else if (ch === "\\" || ch === "_" || ch === "*") {
      cur += code.slice(i, i + 2);
      i++;
    } else if (ch === ";") {
      sections.push(cur);
      cur = "";
    } else cur += ch;
  }
  sections.push(cur);
  const n = Number(value);
  const sec = value === undefined || value === null || value === "" || !Number.isFinite(n) ? sections[sections.length > 3 ? 3 : 0]
    : n < 0 && sections.length > 1 ? sections[1] : n === 0 && sections.length > 2 ? sections[2] : sections[0];
  let lit = "";
  for (let i = 0; i < sec.length; i++) {
    const ch = sec[i];
    if (ch === '"') {
      const j = sec.indexOf('"', i + 1);
      lit += sec.slice(i + 1, j < 0 ? sec.length : j);
      i = j < 0 ? sec.length : j;
    } else if (ch === "\\") lit += sec[++i] ?? "";
    else if (ch === "_" || ch === "*") i++; // padding / fill character
    else if (ch === "[") i = Math.max(i, sec.indexOf("]", i)); // [Red], [<0], [$-409]
  }
  return lit.replace(/[\s$()\-%,.]/g, "");
}

/** Sheets of an .xlsx as lists of row values, in workbook order. With `marks`, also each cell's CellMark. */
export function xlsxSheets(src: Uint8Array, only?: Set<string>, marks?: Marks): Record<string, (string | null)[][]> {
  let z: Record<string, Uint8Array>;
  try {
    z = unzipSync(src);
  } catch {
    throw new DataError("not an .xlsx workbook (an old .xls, or an HTML page in its place)", "api");
  }
  // XML end-of-line handling: a literal CR LF or CR is read as LF (an escaped &#13; stays a CR)
  const read = (n: string) => (z[n] ? new TextDecoder().decode(z[n]).replace(/\r\n?/g, "\n") : "");
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const target: Record<string, string> = {};
  for (const m of read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    target[a.Id] = a.Target;
  }
  // cell styles (only when marks are asked): cellXfs index -> [number format code, indent]
  const xfs: [string | undefined, number][] = [];
  if (marks) {
    const styles = read("xl/styles.xml");
    const fmts = new Map<string, string>();
    for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
      const a = attrs(m[0]);
      fmts.set(a.numFmtId, a.formatCode);
    }
    const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] || "";
    for (const m of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)) {
      const a = attrs(m[1]);
      const al = /<alignment\b[^>]*>/.exec(m[2] || "");
      xfs.push([fmts.get(a.numFmtId), al ? Number(attrs(al[0]).indent || 0) : 0]);
    }
  }
  const out: Record<string, (string | null)[][]> = {};
  const order: string[] = [];
  for (const m of read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (only && !only.has(a.name)) continue;
    order.push(a.name);
    let tgt = (target[a["r:id"]] || "").replace(/^\/+/, "");
    if (!tgt.startsWith("xl/")) tgt = "xl/" + tgt;
    const rows: (string | null)[][] = [];
    const markRows: (CellMark | null)[][] = [];
    for (const rm of read(tgt).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const vals = new Map<number, string | null>();
      const mk = new Map<number, CellMark>();
      for (const cm of (rm[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(cm[1]);
        let col = 0;
        for (const ch of (/^[A-Z]+/.exec(ca.r || "A") || ["A"])[0]) col = col * 26 + ch.charCodeAt(0) - 64;
        const inner = cm[2] || "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        let val: string | null;
        if (ca.t === "s" && v) val = shared[parseInt(v[1], 10)] ?? null;
        else if (ca.t === "inlineStr") val = texts(inner);
        else val = v ? unxml(v[1]) : null;
        vals.set(col - 1, val);
        if (marks && ca.s !== undefined && xfs[Number(ca.s)]) {
          const [code, indent] = xfs[Number(ca.s)];
          const fmt = val === null || ca.t === "s" || ca.t === "inlineStr" || ca.t === "str" ? "" : formatMark(code, val);
          if (fmt || indent) mk.set(col - 1, { ...(fmt ? { fmt } : {}), ...(indent ? { indent } : {}) });
        }
      }
      const n = vals.size ? Math.max(...vals.keys()) + 1 : 0;
      rows.push(Array.from({ length: n }, (_, i) => vals.get(i) ?? null));
      if (marks) markRows.push(Array.from({ length: n }, (_, i) => mk.get(i) ?? null));
    }
    out[a.name] = rows;
    if (marks) marks[a.name] = markRows;
  }
  return inOrder(out, order);
}

/**
 * The sheet ep.sheet (name or 1-based number, default 1) as dicts, header at ep.header_row (1-based). A text value
 * that names a sheet is that sheet ("2025"), else digits are its position, counted without the sheets whose name
 * matches ep.skip_sheets (a regex, e.g. a report tool's hidden sheet).
 */
export function gridRecords(ep: any, sheets: Record<string, (string | null)[][]>): Row[] {
  const want = ep.sheet ?? 1;
  let grid: (string | null)[][];
  const skip = ep.skip_sheets ? new RegExp(String(ep.skip_sheets), "i") : null;
  const names = sheetNames(sheets).filter((n) => !skip || !skip.test(n));
  if (typeof want === "string" && Object.hasOwn(sheets, want)) grid = sheets[want];
  else if (typeof want === "number" || /^\d+$/.test(String(want))) {
    const n = Number(want);
    if (n < 1 || n > names.length) throw new DataError(`the workbook has ${names.length} sheet(s), not sheet ${want}`, "api");
    grid = sheets[names[n - 1]];
  } else if (want in sheets) grid = sheets[want];
  else throw new DataError(`no sheet ${JSON.stringify(want)} in the workbook (sheets: ${names.join(", ")})`, "api");
  if (ep.header_lines !== undefined && ep.header_lines !== null && ep.header_lines !== "") {
    return publishedTable(grid, headerLines(ep.header_lines), ep.carry ?? "top");
  }
  if (Number(ep.header_row ?? 1) === 0) return rawGrid(grid);
  const hr = Number(ep.header_row ?? 1) - 1;
  if (grid.length <= hr) return [];
  const head: string[] = [];
  const seen = new Set<string>();
  grid[hr].forEach((h, i) => {
    let name = h !== null && h !== "" ? String(h).split(/\s+/).filter(Boolean).join(" ") : `col${i + 1}`;
    if (seen.has(name)) name = `${name}_col${i + 1}`;
    seen.add(name);
    head.push(name);
  });
  const out: Row[] = [];
  let width = head.length;
  for (const r of grid.slice(hr + 1)) {
    if (!r.some((v) => v !== null && v !== "")) continue;
    const o: Row = {};
    r.forEach((v, i) => (o[i < head.length ? head[i] : `col${i + 1}`] = v));
    width = Math.max(width, r.length);
    out.push(o);
  }
  // header order, as Python keeps it (a JS object would list "2024"-like names first)
  return withColumns(out, [...head, ...Array.from({ length: width - head.length }, (_, k) => `col${head.length + k + 1}`)]);
}

// ---------------------------------------------------------------------- published tables (title lines, stacked headers)
/**
 * Every record of a grid, numbered: `row` (1-based record number in the file or sheet) then col1..colN; blank
 * records are kept, so an adapter can read stacked blocks and a reader can find the header lines.
 */
export function rawGrid(grid: (string | null)[][]): Row[] {
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const rows = grid.map((r, i) => ({ row: i + 1, ...Object.fromEntries(r.map((v, j) => [`col${j + 1}`, v ?? ""])) }));
  return withColumns(rows, ["row", ...Array.from({ length: width }, (_, j) => `col${j + 1}`)]);
}

/** "11-13", "11,12", 11 or [11, 12] as sorted 1-based line numbers. */
export function headerLines(v: unknown): number[] {
  const parts = Array.isArray(v) ? v.map(String) : String(v).split(",");
  const out = new Set<number>();
  for (const p of parts) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(p);
    if (!m) throw new DataError(`header_lines: ${JSON.stringify(v)} is not a line number, a range like 11-13, or a list`, "bad_request");
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A published table whose header spans several lines (agency report CSVs and workbooks): the column names join
 * the header cells top to bottom with " | ". Which header cells span to the right, until the next filled cell of
 * their line (a merged or centered cell comes out filled in its first column only), is `carry`:
 *   "top" (default)  only the top header line spans: a year or group over its columns
 *   "all"            every line but the last spans (each lower span stops where the line above changes)
 *   "none"           nothing spans
 * The spans are a reading of the layout, not data: check the names against the numbered lines. Rows are the
 * records after the last header line, with their `row` number first; blank records are dropped. A column whose
 * header cells are all carried from a span to its left (a footnote-mark column such as "†") is named
 * <span>_colN; a name that repeats gets _colN; an empty one is colN. Names that look like numbers ("2024") keep
 * their place.
 */
export function publishedTable(grid: (string | null)[][], lines: number[], carry: string = "top"): Row[] {
  if (!lines.length) return rawGrid(grid);
  if (!["top", "all", "none"].includes(carry)) throw new DataError(`carry must be top, all or none (got ${JSON.stringify(carry)})`, "bad_request");
  const last = lines[lines.length - 1];
  if (grid.length < last) throw new DataError(`header_lines ${lines.join(",")}: the table has only ${grid.length} lines`, "bad_request");
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const clean = (v: unknown) => (v === null || v === undefined ? "" : String(v).split(/\s+/).filter(Boolean).join(" "));
  const levels = lines.map((ln, k) => {
    const cells = Array.from({ length: width }, (_, i) => clean(grid[ln - 1][i]));
    const spans = carry === "all" ? k < lines.length - 1 : carry === "top" ? k === 0 && lines.length > 1 : false;
    if (!spans) return cells;
    let c0 = "";
    return cells.map((c, i) => (c ? (c0 = c) : i === 0 ? "" : c0));
  });
  // with carry "all", a lower span stops where the line above it changes (a sub-header belongs to one parent)
  for (let k = 1; carry === "all" && k < levels.length - 1; k++) {
    for (let i = 1; i < width; i++) {
      if (!clean(grid[lines[k] - 1][i]) && levels[k - 1][i] !== levels[k - 1][i - 1]) levels[k][i] = "";
    }
  }
  const seen = new Set<string>(["row"]);
  const head = Array.from({ length: width }, (_, i) => {
    const parts: string[] = [];
    for (const l of levels) if (l[i] && parts[parts.length - 1] !== l[i]) parts.push(l[i]);
    const own = lines.some((ln) => clean(grid[ln - 1][i]) !== "");
    let name = parts.join(" | ") || `col${i + 1}`;
    if (!own && parts.length) name = `${name}_col${i + 1}`;
    if (seen.has(name)) name = `${name}_col${i + 1}`;
    seen.add(name);
    return name;
  });
  const out: Row[] = [];
  let extra = width;
  grid.slice(last).forEach((r, j) => {
    if (!r.some((v) => v !== null && v !== "" && String(v).trim() !== "")) return;
    const o: Row = { row: last + j + 1 };
    head.forEach((h, i) => (o[h] = r[i] ?? ""));
    for (let i = width; i < r.length; i++) o[`col${i + 1}`] = r[i];
    extra = Math.max(extra, r.length);
    out.push(o);
  });
  return withColumns(out, ["row", ...head, ...Array.from({ length: extra - width }, (_, k) => `col${width + k + 1}`)]);
}

const delimited = (text: string, delimiter: string): (string | null)[][] =>
  parse(text.replace(/^﻿/, ""), { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: false })
    .map((r: string[]) => r.map((v) => v.trim()));

/**
 * A tab-delimited text table (title lines above the header are common) as dicts: header at ep.header_row
 * (1-based, default 1), header_row 0 for every record numbered (rawGrid), or header_lines for a stacked header.
 */
export function tsvRecords(ep: any, text: string): Row[] {
  return gridRecords({ ...ep, sheet: 1 }, { tsv: delimited(text, "\t") });
}

/**
 * A CSV: as csv.DictReader reads it (readCsv) unless the endpoint names its header (header_row, header_lines),
 * as published report tables need.
 */
export function csvRecords(ep: any, text: string): Row[] {
  const named = (ep.header_row !== undefined && ep.header_row !== null) ||
    (ep.header_lines !== undefined && ep.header_lines !== null && ep.header_lines !== "");
  return named ? gridRecords({ ...ep, sheet: 1 }, { csv: delimited(text, ",") }) : readCsv(text);
}

export function sheetRecords(ep: any, src: Uint8Array): Row[] {
  return gridRecords(ep, xlsxSheets(src));
}

/**
 * Sheets of a legacy .xls (BIFF) workbook as lists of row values, the way Python's xlrd reader gives
 * them: every row from the first to the last used one, padded to the sheet's width with null; whole-number
 * floats as integers ("2024"), other floats as Python writes them, text as is, booleans "1"/"0".
 */
export function xlsSheets(src: Uint8Array, marks?: Marks): Record<string, (string | null)[][]> {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(src, { type: "buffer", cellDates: false, cellText: false, cellNF: !!marks, cellHTML: false });
  } catch {
    throw new DataError("expected an .xls workbook, got something else (an HTML page?)", "api");
  }
  const out: Record<string, (string | null)[][]> = {};
  for (const name of wb.SheetNames) {
    const sh = wb.Sheets[name];
    const rows: (string | null)[][] = [];
    const markRows: (CellMark | null)[][] = [];
    // the extent of the cells that hold a value (xlrd's nrows/ncols), not the declared dimensions, which
    // also count blank formatted cells
    let maxR = -1, maxC = -1;
    for (const addr of Object.keys(sh)) {
      if (addr[0] === "!") continue;
      const cell = sh[addr];
      if (cell?.v === undefined || cell.t === "z") continue;
      const { r, c } = XLSX.utils.decode_cell(addr);
      maxR = Math.max(maxR, r);
      maxC = Math.max(maxC, c);
    }
    if (maxR >= 0) {
      for (let r = 0; r <= maxR; r++) {
        const vals: (string | null)[] = [];
        const mk: (CellMark | null)[] = [];
        for (let c = 0; c <= maxC; c++) {
          const cell = sh[XLSX.utils.encode_cell({ r, c })];
          const v = cell?.v;
          if (v === undefined || v === null || v === "") vals.push(null);
          else if (cell!.t === "n") vals.push(Number.isInteger(v) ? String(v) : pyFloatRepr(v as number));
          else if (cell!.t === "b") vals.push(v ? "1" : "0");
          else vals.push(String(v));
          if (marks) {
            const fmt = cell?.t === "n" ? formatMark(cell.z as string | undefined, vals[vals.length - 1]) : "";
            mk.push(fmt ? { fmt } : null);
          }
        }
        rows.push(vals);
        if (marks) markRows.push(mk);
      }
    }
    out[name] = rows;
    if (marks) marks[name] = markRows;
  }
  return inOrder(out, wb.SheetNames);
}

export function xlsRecords(ep: any, src: Uint8Array): Row[] {
  return gridRecords(ep, xlsSheets(src));
}
