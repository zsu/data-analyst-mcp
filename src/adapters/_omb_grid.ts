/**
 * Reading a published sheet (a grid of cells from xlsxSheets / xlsSheets / a CSV) as rows, the way the Python omb
 * and pbgc adapters' parse_grid did: title rows above the header go to `top`, the header is the first row with
 * two or more filled cells (or header_row), following rows with an empty first cell are more header rows (their
 * labels joined top-down, a group label spread over the columns it spans), the trailing footer (rows with one
 * filled cell) goes to `footer`, label-only rows stay, `sheet_row` is the 1-based row number, and a number stored
 * with binary noise is written with 15 significant digits.
 */
import { DataError } from "../core/http.js";
import { g15, pyStrip, squash, type ORow } from "./_omb_util.js";

export type Cell = string | null | undefined;
export type Grid = Cell[][];
export type GridMeta = { top: string[]; footer: string[]; header: [number, number] | null };

export function txt(v: Cell): string {
  return v === null || v === undefined || v === "" ? "" : squash(String(v));
}

export function filled(row: Cell[]): number[] {
  const out: number[] = [];
  row.forEach((v, i) => {
    if (txt(v)) out.push(i);
  });
  return out;
}

export const NUM = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const NOISY = /^-?\d+\.\d{9,}$|^-?\d+(\.\d+)?[eE][-+]?\d+$/;

/** 78.900000000000006 -> 78.9; 6.3600000000000004E-2 -> 0.0636 (the same double, 15 significant digits). */
export function numClean(s: string): string {
  if (NOISY.test(s)) {
    const f = g15(Number(s));
    if (!f.includes("e")) return f;
  }
  return s;
}

export function parseGrid(grid: Grid, headerRow?: unknown, headerRows?: unknown,
  o: { stripDots?: boolean; tocCells?: boolean } = {}): [ORow[], GridMeta] {
  const stripDots = o.stripDots ?? true;
  const rows: Cell[][] = grid.map((r) => (o.tocCells ? r.map((v) => (txt(v).toLowerCase() === "return to table of contents" ? null : v)) : [...r]));
  let start: number;
  if (headerRow) {
    start = Number(headerRow) - 1;
    if (!(start >= 0 && start < rows.length)) {
      throw new DataError(`header_row ${headerRow} is outside the sheet (${rows.length} rows)`, "bad_request");
    }
  } else {
    const i = rows.findIndex((r) => filled(r).length >= 2);
    if (i < 0) return [[], { top: rows.flatMap((r) => r.map(txt).filter(Boolean)), footer: [], header: null }];
    start = i;
  }
  const top = rows.slice(0, start).flatMap((r) => r.map(txt).filter(Boolean));
  let end = start + 1;
  if (headerRows) end = start + Number(headerRows);
  else {
    let labelSeen = rows[start].length ? !!txt(rows[start][0]) : false;
    while (end < rows.length) {
      const f = filled(rows[end]);
      if (!f.length) {
        end++;
        continue;
      }
      const nums = f.filter((i) => NUM.test(txt(rows[end][i]).replace(/,/g, ""))).length;
      if ((f.includes(0) && labelSeen) || nums > f.length / 2) break;
      labelSeen = labelSeen || f.includes(0);
      end++;
    }
    while (end > start + 1 && !filled(rows[end - 1]).length) end--;
  }
  const head = rows.slice(start, end);
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const orig = head.map((r) => Array.from({ length: width }, (_, c) => (c < r.length ? txt(r[c]) : "")));
  const lab = orig.map((r) => [...r]);
  for (let k = 0; k < lab.length - 1; k++) {
    for (let c = 1; c < width; c++) {
      if (lab[k][c] || !lab[k][c - 1]) continue;
      if (orig.slice(0, k).some((r) => r[c])) continue; // an upper group starts here
      if (!orig.slice(k + 1).some((r) => r[c])) continue; // nothing below: an empty column, not a spanned one
      lab[k][c] = lab[k][c - 1];
    }
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (let c = 0; c < width; c++) {
    const parts: string[] = [];
    for (let k = 0; k < lab.length; k++) {
      if (lab[k][c] && (!parts.length || parts[parts.length - 1] !== lab[k][c])) parts.push(lab[k][c]);
    }
    let n = parts.join(" ") || `col${c + 1}`;
    if (seen.has(n)) n = `${n}_col${c + 1}`;
    seen.add(n);
    names.push(n);
  }
  const body: [number, Cell[]][] = rows.slice(end).map((r, i) => [end + 1 + i, r]);
  let cut = body.length;
  while (cut > 0 && filled(body[cut - 1][1]).length <= 1) cut--;
  const footer = body.slice(cut).flatMap(([, r]) => r.map(txt).filter(Boolean));
  const out: [number, Map<string, string>][] = [];
  const used = new Set<string>();
  for (const [n, r] of body.slice(0, cut)) {
    if (!filled(r).length) continue;
    const rec = new Map<string, string>();
    r.forEach((v, c) => {
      let s = v !== null && v !== undefined ? pyStrip(String(v)) : "";
      if (c === 0 && stripDots) s = s.replace(/\s*\.{4,}\s*$/, "");
      s = numClean(s);
      rec.set(names[c], s);
      if (s) used.add(names[c]);
    });
    out.push([n, rec]);
  }
  // a column without a header and without a value (trailing empty cells) is dropped
  const cols = names.filter((x, c) => used.has(x) || (orig.length > 0 && orig.some((r) => r[c])));
  const recs = out.map(([n, rec]) => {
    const m: ORow = new Map();
    for (const k of cols) m.set(k, rec.get(k) ?? "");
    m.set("sheet_row", n);
    return m;
  });
  return [recs, { top, footer, header: [start + 1, end] }];
}
