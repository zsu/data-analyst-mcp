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

/** Sheets of an .xlsx as lists of row values, in workbook order. */
export function xlsxSheets(src: Uint8Array, only?: Set<string>): Record<string, (string | null)[][]> {
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
  const out: Record<string, (string | null)[][]> = {};
  for (const m of read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (only && !only.has(a.name)) continue;
    let tgt = (target[a["r:id"]] || "").replace(/^\/+/, "");
    if (!tgt.startsWith("xl/")) tgt = "xl/" + tgt;
    const rows: (string | null)[][] = [];
    for (const rm of read(tgt).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const vals = new Map<number, string | null>();
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
      }
      const n = vals.size ? Math.max(...vals.keys()) + 1 : 0;
      rows.push(Array.from({ length: n }, (_, i) => vals.get(i) ?? null));
    }
    out[a.name] = rows;
  }
  return out;
}

/** The sheet ep.sheet (name or 1-based number, default 1) as dicts, header at ep.header_row (1-based). */
export function gridRecords(ep: any, sheets: Record<string, (string | null)[][]>): Row[] {
  const want = ep.sheet ?? 1;
  let grid: (string | null)[][];
  const names = Object.keys(sheets);
  if (typeof want === "number" || /^\d+$/.test(String(want))) {
    const n = Number(want);
    if (n < 1 || n > names.length) throw new DataError(`the workbook has ${names.length} sheet(s), not sheet ${want}`, "api");
    grid = sheets[names[n - 1]];
  } else if (want in sheets) grid = sheets[want];
  else throw new DataError(`no sheet ${JSON.stringify(want)} in the workbook (sheets: ${names.join(", ")})`, "api");
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
  for (const r of grid.slice(hr + 1)) {
    if (!r.some((v) => v !== null && v !== "")) continue;
    const o: Row = {};
    r.forEach((v, i) => (o[i < head.length ? head[i] : `col${i + 1}`] = v));
    out.push(o);
  }
  return out;
}

export function sheetRecords(ep: any, src: Uint8Array): Row[] {
  return gridRecords(ep, xlsxSheets(src));
}

/**
 * Sheets of a legacy .xls (BIFF) workbook as lists of row values, the way the Python skill's xlrd reader gave
 * them: every row from the first to the last used one, padded to the sheet's width with null; whole-number
 * floats as integers ("2024"), other floats as Python writes them, text as is, booleans "1"/"0".
 */
export function xlsSheets(src: Uint8Array): Record<string, (string | null)[][]> {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(src, { type: "buffer", cellDates: false, cellText: false, cellNF: false, cellHTML: false });
  } catch {
    throw new DataError("expected an .xls workbook, got something else (an HTML page?)", "api");
  }
  const out: Record<string, (string | null)[][]> = {};
  for (const name of wb.SheetNames) {
    const sh = wb.Sheets[name];
    const rows: (string | null)[][] = [];
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
        for (let c = 0; c <= maxC; c++) {
          const cell = sh[XLSX.utils.encode_cell({ r, c })];
          const v = cell?.v;
          if (v === undefined || v === null || v === "") vals.push(null);
          else if (cell!.t === "n") vals.push(Number.isInteger(v) ? String(v) : pyFloatRepr(v as number));
          else if (cell!.t === "b") vals.push(v ? "1" : "0");
          else vals.push(String(v));
        }
        rows.push(vals);
      }
    }
    out[name] = rows;
  }
  return out;
}

export function xlsRecords(ep: any, src: Uint8Array): Row[] {
  return gridRecords(ep, xlsSheets(src));
}
