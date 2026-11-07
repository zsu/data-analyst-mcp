/**
 * A published HUD workbook read the way the Python skill read it: pandas.read_excel(path, dtype=str) (openpyxl for
 * .xlsx, xlrd for .xls), then .fillna("") and .to_dict("records"). That means:
 *   - the first row is the header: text as is, a number as its Python str ("2020", "1.5"), an empty cell
 *     "Unnamed: <i>" (0-based), a repeated name "<name>.1", "<name>.2", ...;
 *   - a cell is text as is; a number is an integer when it is whole ("1530", also for 2.0 and 1E+20: pandas makes
 *     whole floats integers) and str(float) otherwise ("948.5"); a boolean "True"/"False"; an empty cell, an error
 *     cell and pandas' default NA strings ("NA", "N/A", "#N/A", "NULL", "nan", ...) become "";
 *   - the columns run to the last cell with a value in any row ("Unnamed: <i>" past the header); blank rows
 *     between data rows are kept (all ""), blank rows at the end are dropped.
 * (Checked against pandas 3.0.2 with openpyxl.)
 * Cells formatted as dates are numbers here (pandas gave "2026-01-01 00:00:00"): HUD's FMR and income-limits files
 * have none. docProps/core.xml is never read, so a malformed creation date (FY26_FMRs_revised.xlsx) does not matter.
 */
import { unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { withColumns } from "../core/package.js";
import { pyFloatRepr } from "../core/py.js";

type Cell = { kind: "text" | "number" | "bool" | "empty"; raw: string };

const NA = new Set(["", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan", "1.#IND", "1.#QNAN", "<NA>",
  "N/A", "NA", "NULL", "NaN", "None", "n/a", "nan", "null"]);

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

/** Python int(s) / float(s) as openpyxl casts a stored number, then str(). */
function numberText(raw: string): string {
  const s = raw.trim();
  if (/^[-+]?\d+$/.test(s)) return BigInt(s).toString();
  const n = parseFloat(s);
  if (Number.isNaN(n)) return s;
  return Number.isInteger(n) ? BigInt(n).toString() : pyFloatRepr(n);
}

/** The first sheet of an .xlsx, as typed cells (openpyxl's view). */
function xlsxGrid(src: Uint8Array): Cell[][] {
  const z = unzipSync(src);
  const read = (n: string) => (z[n] ? new TextDecoder().decode(z[n]).replace(/\r\n?/g, "\n") : "");
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  const target: Record<string, string> = {};
  for (const m of read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    target[a.Id] = a.Target;
  }
  const first = /<sheet\b[^>]*>/.exec(read("xl/workbook.xml"));
  if (!first) throw new Error("no sheet in the workbook");
  let tgt = (target[attrs(first[0])["r:id"]] || "").replace(/^\/+/, "");
  if (!tgt.startsWith("xl/")) tgt = "xl/" + tgt;
  const grid: Cell[][] = [];
  for (const rm of read(tgt).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rm[1]);
    const rowIdx = ra.r ? parseInt(ra.r, 10) - 1 : grid.length;
    while (grid.length < rowIdx) grid.push([]);
    const row: Cell[] = [];
    for (const cm of (rm[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]);
      let col = 0;
      if (ca.r) for (const ch of (/^[A-Z]+/.exec(ca.r) || ["A"])[0]) col = col * 26 + ch.charCodeAt(0) - 64;
      else col = row.length + 1;
      const inner = cm[2] || "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      let cell: Cell;
      if (ca.t === "s") cell = v ? { kind: "text", raw: shared[parseInt(v[1], 10)] ?? "" } : { kind: "empty", raw: "" };
      else if (ca.t === "inlineStr") cell = { kind: "text", raw: texts(inner) };
      else if (ca.t === "str") cell = v ? { kind: "text", raw: unxml(v[1]) } : { kind: "empty", raw: "" };
      else if (ca.t === "b") cell = v ? { kind: "bool", raw: unxml(v[1]).trim() === "1" ? "True" : "False" } : { kind: "empty", raw: "" };
      else if (ca.t === "e") cell = { kind: "empty", raw: "" };
      else cell = v && unxml(v[1]).trim() !== "" ? { kind: "number", raw: numberText(unxml(v[1])) } : { kind: "empty", raw: "" };
      while (row.length < col - 1) row.push({ kind: "empty", raw: "" });
      row[col - 1] = cell;
    }
    grid[rowIdx] = row;
  }
  return grid;
}

/** The first sheet of a legacy .xls (xlrd's view: numbers are floats, whole ones written as integers). */
function xlsGrid(src: Uint8Array): Cell[][] {
  const wb = XLSX.read(src, { type: "buffer", cellDates: false, cellText: false, cellNF: false, cellHTML: false });
  const sh = wb.Sheets[wb.SheetNames[0]];
  const grid: Cell[][] = [];
  for (const addr of Object.keys(sh)) {
    if (addr[0] === "!") continue;
    const c = sh[addr];
    if (c?.v === undefined || c.t === "z") continue;
    const { r, c: col } = XLSX.utils.decode_cell(addr);
    let cell: Cell;
    if (c.t === "n") cell = { kind: "number", raw: Number.isInteger(c.v) ? BigInt(c.v as number).toString() : pyFloatRepr(c.v as number) };
    else if (c.t === "b") cell = { kind: "bool", raw: c.v ? "True" : "False" };
    else if (c.t === "e") cell = { kind: "empty", raw: "" };
    else cell = { kind: "text", raw: String(c.v) };
    (grid[r] ??= [])[col] = cell;
  }
  for (let i = 0; i < grid.length; i++) grid[i] ??= [];
  return grid.map((row) => Array.from({ length: row.length }, (_, i) => row[i] ?? { kind: "empty", raw: "" }));
}

/** The workbook's first sheet as pandas.read_excel(dtype=str).fillna("").to_dict("records") gave it. */
export function readExcel(src: Uint8Array, xls: boolean): Record<string, string>[] {
  const grid = xls ? xlsGrid(src) : xlsxGrid(src);
  const used = (row: Cell[] | undefined) => {
    let n = 0;
    (row || []).forEach((c, i) => {
      if (c && c.kind !== "empty") n = i + 1;
    });
    return n;
  };
  const width = Math.max(0, ...grid.map(used));
  let last = grid.length;
  while (last > 1 && !used(grid[last - 1])) last--;
  const headRow = grid[0] || [];
  const head: string[] = [];
  const count = new Map<string, number>();
  for (let i = 0; i < width; i++) {
    const c = headRow[i];
    let name = !c || c.kind === "empty" ? `Unnamed: ${i}` : c.raw;
    const n = count.get(name) || 0;
    count.set(name, n + 1);
    if (n) {
      let k = n, alt = `${name}.${k}`;
      while (count.has(alt)) alt = `${name}.${++k}`;
      count.set(alt, 1);
      name = alt;
    }
    head.push(name);
  }
  const rows = grid.slice(1, last).map((row) => {
    const m: Record<string, string> = {};
    head.forEach((h, i) => {
      const c = row?.[i];
      m[h] = !c || c.kind === "empty" || (c.kind === "text" && NA.has(c.raw)) ? "" : c.raw;
    });
    return m;
  });
  // the header's order, which a JS object loses for integer-like names ("2020")
  return withColumns(rows, head);
}
