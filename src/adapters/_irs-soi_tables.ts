/**
 * irs-soi published tables: the SOI statistical tables irs.gov publishes as .xls/.xlsx workbooks (Publication 1304,
 * Publication 16, partnerships, sole proprietorships, the IRS Data Book, historical tables, estate, gift and wealth,
 * exempt organizations, international). packs/irs-soi/tables.json is the catalog: each entry names the index page that
 * links the files and a regular expression on the file name (two-digit year first).
 *
 * File names change over the years (Data Book tables renumbered in 2006, 97in11.xls, ccr/nr/tabl), so a file is never
 * built from a pattern: the index page is read once per run and its links are matched (checked 2026-11-08).
 *
 * The workbooks share one layout, read here without per-table settings:
 *   title lines (one filled cell each), a headnote ("[All figures are estimates based on samples--money amounts are in
 *   thousands of dollars]"), 1-7 stacked header lines with merged groups, a row of column numbers (1, 2, ... or
 *   "(1)", or -1, -2 shown as "(1)" by the cell format), label-only section lines, data lines, footnote lines
 *   ([1] ..., * ..., d ..., NOTE:, SOURCE:).
 *   Cells carry markers: "[2]" (a footnote, e.g. less than 0.05 percent), "d" / "[d]" (not shown to avoid disclosure),
 *   "*" / "**" (estimate based on few sample returns, or combined), "n.a.", "--"; in newer workbooks "*" is only in the
 *   number format (read with the cell marks of src/core/tabular.ts). A row's level is its indent (style or spaces).
 *   Older workbooks repeat the label column side by side (panels): each cell takes the label of the nearest label
 *   column to its left.
 */
import { DataError } from "../core/http.js";
import { unzip, xlsSheets, xlsxSheets, type CellMark, type Marks } from "../core/tabular.js";
import { numClean } from "./_omb_grid.js";
import { squash, unescapeHtml, urljoin } from "./_omb_util.js";

export type Grid = (string | null)[][];
export type MarkGrid = (CellMark | null)[][];

// ---------------------------------------------------------------------- index pages
export type Link = { file: string; url: string; text: string; year: number | null };

/** Two-digit year of a file name ("23in11si.xls" -> 2023, "98in11si.xls" -> 1998), or null. */
export function fileYear(file: string): number | null {
  const m = /^(\d\d)/.exec(file);
  if (!m) return null;
  const yy = Number(m[1]);
  return yy >= 80 ? 1900 + yy : 2000 + yy;
}

/** The spreadsheet, zip and CSV links of an index page, in page order. */
export function pageLinks(html: string, page: string): Link[] {
  const out: Link[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*"([^"]+)"/i.exec(m[1])?.[1];
    if (!href) continue;
    let h = unescapeHtml(href).trim();
    if (!/\.(xlsx?|zip|csv)$/i.test(h.split(/[?#]/)[0])) continue;
    // a link written without its path ("https://www.irs.gov11in02tr.xls", seen 2026-11-08) is under /pub/irs-soi/
    const bad = /^https?:\/\/www\.irs\.gov([^/].*)$/i.exec(h);
    if (bad) h = "https://www.irs.gov/pub/irs-soi/" + bad[1];
    const url = urljoin(page, h);
    const file = decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "");
    const text = squash(unescapeHtml(m[2].replace(/<[^>]+>/g, " ")));
    const y4 = /\b(19\d\d|20\d\d)\b/.exec(text);
    out.push({ file, url, text, year: fileYear(file) ?? (y4 ? Number(y4[1]) : null) });
  }
  return out;
}

// ---------------------------------------------------------------------- reading a workbook
/** Sheets and cell marks of a downloaded table file (.xls, .xlsx, or a zip holding one). */
export function readWorkbook(body: Uint8Array, name: string): { sheets: Record<string, Grid>; marks: Marks; order: string[] } {
  let data = body, file = name;
  if (/\.zip$/i.test(name)) {
    const z = unzip(body);
    const member = Object.keys(z).filter((k) => /\.xlsx?$/i.test(k) && !k.startsWith("__MACOSX")).sort()[0];
    if (!member) throw new DataError(`${name}: the zip holds no .xls or .xlsx file (members: ${Object.keys(z).join(", ")})`, "api");
    data = z[member];
    file = member;
  }
  const head = Buffer.from(data.subarray(0, 300)).toString("latin1").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    throw new DataError(`${name}: got an HTML page instead of the workbook (the file moved or the host refused the request)`, "api");
  }
  const marks: Marks = {};
  // the extension can be wrong: try the format the bytes say (zip = xlsx, OLE = xls)
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  const sheets = isZip ? xlsxSheets(data, undefined, marks) : xlsSheets(data, marks);
  void file;
  return { sheets, marks, order: Object.keys(sheets) };
}

// ---------------------------------------------------------------------- the grid
const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";
const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const FOOT = /^\s*(\[\s*[\w ,]+\s*\]|\(\s*\d+\s*\)\s|\*{1,3}\s*[A-Za-z(=-]|\[?d\]?\s*[-–—=:]|\(?[dxz]\)?\s*[-–—=]|n\.\s*a\.\s*[-–—=]|N\/A\s*[-–—=]|NA\s*[-–—=]|--\s*[-–—=A-Za-z]|NOTES?\b|Notes?\s*:|SOURCES?\b|Source\s*:|Footnotes?\b)/;

export type SoiColumn = { idx: number; col: number | null; name: string };
export type SoiCell = { idx: number; col: number | null; name: string; value: string; flag: string };
export type SoiRow = { line: number; level: number; section: string; parent: string; label: string; cells: SoiCell[] };
export type SoiTable = {
  title: string; headnote: string; units: string; header: number[]; numberRows: number[];
  columns: SoiColumn[]; rows: SoiRow[]; footer: string[]; notes: string[];
};

/** A title, headnote or page-break cell ("Table 1.1--1998 ...", "(All figures are ...", "Footnotes at end of table."). */
const TITLEISH = /^\s*(Table\s+\d|RETURNS OF ACTIVE CORPORATIONS|\(All figures|\[All figures|\[Money amounts|\(Money amounts|All figures are|money amounts are in|Footnotes at end of table|Scroll over)/i;

function text(v: unknown): string {
  return v === null || v === undefined ? "" : squash(unescapeHtml(String(v)));
}

/** A column-number cell: 1, "1", "(1)", -1 (shown as (1)) -> 1; else null. */
function colNumber(v: unknown): number | null {
  const m = /^\(?\s*-?(\d{1,3})\s*\)?$/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) : null;
}

/** Index of the column-number row between from and to (0-based, inclusive), or -1. */
function findNumberRow(grid: Grid, from: number, to: number): number {
  for (let r = from; r <= Math.min(to, grid.length - 1); r++) {
    const row = grid[r];
    if (filled(row[0])) continue;
    const nums: number[] = [];
    let other = false;
    for (let i = 1; i < row.length; i++) {
      if (!filled(row[i])) continue;
      const n = colNumber(row[i]);
      if (n === null) {
        other = true;
        break;
      }
      nums.push(n);
    }
    if (other || nums.length < 2) continue;
    if (nums.every((n, k) => k === 0 || n === nums[k - 1] + 1)) return r;
  }
  return -1;
}

const isNumeric = (v: unknown) => NUMBER.test(String(v ?? "").trim().replace(/,/g, ""));

/** Value and marker of one cell: "* 1,335" -> 1335 / "*"; "[2]" -> "" / "[2]"; "d" -> "" / "d". */
export function parseCell(raw: unknown, fmt?: string): { value: string; flag: string } | null {
  let s = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!s && !fmt) return null;
  const flags: string[] = [];
  for (const t of (fmt || "").match(/\*+|\[[^\]]*\]|[A-Za-z]+/g) || []) flags.push(t);
  s = s.replace(/\[[^\]]*\]/g, (t) => (flags.push(t.replace(/\s+/g, "")), " ")).trim();
  const star = /^(\*{1,3})\s*/.exec(s);
  if (star) {
    flags.push(star[1]);
    s = s.slice(star[0].length);
  }
  const num = s.replace(/,/g, "").replace(/\s+/g, "");
  if (s && NUMBER.test(num)) return { value: numClean(num), flag: flags.join(" ") };
  if (/^\$\s*-?[\d,]+(\.\d+)?$/.test(s)) return { value: numClean(s.replace(/[$,\s]/g, "")), flag: flags.join(" ") };
  if (s) flags.push(s);
  if (!flags.length) return null;
  return { value: "", flag: flags.join(" ") };
}

/**
 * Column names from stacked header lines (1-based): each column's cells joined top-down with " | ". A filled cell of a
 * line spans to the right over blank cells while the line above stays the same (a group label over its columns, a
 * merged cell written in its first column only); the last line never spans. Label columns take no part.
 */
export function headerNames(grid: Grid, lines: number[], width: number, labelCols: number[]): string[] {
  const levels: string[][] = [];
  lines.forEach((ln, k) => {
    const row = grid[ln - 1] || [];
    const own = Array.from({ length: width }, (_, i) => (labelCols.includes(i) ? "" : text(row[i])));
    if (k === lines.length - 1) return levels.push(own);
    const out: string[] = [];
    let cur = "", parent = "";
    for (let i = 0; i < width; i++) {
      const above = k ? levels[k - 1][i] : "";
      if (labelCols.includes(i)) (cur = "", out.push(""));
      else if (own[i]) (cur = own[i], parent = above, out.push(cur));
      else {
        if (above !== parent) cur = "";
        out.push(cur);
      }
    }
    levels.push(out);
  });
  return Array.from({ length: width }, (_, i) => {
    const parts: string[] = [];
    for (const l of levels) if (l[i] && parts[parts.length - 1] !== l[i]) parts.push(l[i]);
    return parts.join(" | ");
  });
}

/**
 * Reads one sheet of an SOI table. A sheet can hold several blocks (the pages of a printed table, each with its own
 * header and column numbers: 1998 Table 1.1 numbers columns 1-20 on page 1 and 21-40 on page 2); each block starts
 * after the last data line of the one before. headerLines (1-based, from the catalog) replaces the layout reading of
 * the header for a table without column numbers.
 */
export function readSoiGrid(grid0: Grid, marks: MarkGrid | undefined, headerLines?: number[]): SoiTable {
  const grid: Grid = grid0.map((r) => r.map((v) => (filled(v) ? v : null)));
  const titleCells: string[] = [];
  // the title, headnote and page-break cells are not table cells
  const body: Grid = grid.map((r) => r.map((v) => {
    if (v !== null && TITLEISH.test(String(v))) {
      const t = text(v);
      if (!titleCells.includes(t)) titleCells.push(t);
      return null;
    }
    return v;
  }));
  const notes: string[] = [];
  // the header starts at the first line with a filled cell beyond the label column, other than a title line
  // repeated over side-by-side panels (every filled cell the same text)
  const h0 = body.findIndex((r) => {
    const t = r.filter(filled).map(text);
    return r.some((v, i) => i > 0 && filled(v)) && !(t.length > 1 && t.every((x) => x === t[0]));
  });
  if (h0 < 0) throw new DataError("the sheet has no table (no line with more than one filled cell)", "api");
  for (let r = 0; r < h0; r++) {
    const t = [...new Set(body[r].filter(filled).map(text))].join(" ");
    if (t && !titleCells.includes(t)) titleCells.push(t);
  }
  const heads = titleCells.filter((t) => /^[[(]|figures are|amounts are/i.test(t));
  const title = titleCells.filter((t) => !heads.includes(t) && !/^Footnotes at end|^Scroll over/i.test(t)).slice(0, 6).join(" ");
  const headnote = heads.slice(0, 2).join(" ");
  const u = /(?:money )?amounts? (?:are |is )?in (thousands|millions|billions) of dollars|amounts? (?:are )?in (whole )?dollars|money amounts are in (thousands|millions|billions)/i
    .exec(titleCells.join(" ").replace(/\s+/g, " "));
  const units = u ? (u[1] || u[3] ? `${(u[1] || u[3]).toLowerCase()} of dollars` : "dollars") : "";
  const width = Math.max(0, ...grid.map((r) => r.length));
  const hasNumber = (r: number, from = 1) => body[r].some((v, i) => i >= from && isNumeric(String(v ?? "").replace(/^\*+\s*/, "")));

  // blocks: [header lines (1-based), number row (0-based or -1), data start, data end (exclusive)]
  type Block = { header: number[]; numberRow: number; start: number; end: number };
  const blocks: Block[] = [];
  const numberRows: number[] = [];
  if (headerLines?.length) {
    const last = headerLines[headerLines.length - 1];
    const nr = findNumberRow(body, last, last) === last ? last : -1;
    numberRows.push(...(nr >= 0 ? [nr] : []));
    blocks.push({ header: headerLines, numberRow: nr, start: nr >= 0 ? nr + 1 : last, end: grid.length });
  } else {
    for (let r = h0; r < grid.length; r++) {
      const n = findNumberRow(body, r, r);
      if (n >= 0) numberRows.push(n);
    }
    if (numberRows.length) {
      let from = h0;
      numberRows.forEach((nr, k) => {
        const header: number[] = [];
        for (let r = from; r < nr; r++) if (body[r].some(filled)) header.push(r + 1);
        const next = numberRows[k + 1] ?? grid.length;
        let lastData = nr;
        for (let r = nr + 1; r < next; r++) if (hasNumber(r)) lastData = r;
        blocks.push({ header, numberRow: nr, start: nr + 1, end: lastData + 1 });
        from = lastData + 1;
      });
    } else {
      // no column numbers (Publication 16 Table 2.1 for 2014, some historical tables): the header runs to the line
      // before the first line with a label and a number
      let r = h0 + 1;
      while (r < grid.length && !(filled(body[r][0]) && hasNumber(r))) r++;
      const header: number[] = [];
      for (let k = h0; k < r; k++) if (body[k].some((v, i) => i > 0 && filled(v))) header.push(k + 1);
      let lastData = r;
      for (let k = r; k < grid.length; k++) if (hasNumber(k)) lastData = k;
      blocks.push({ header, numberRow: -1, start: r, end: lastData + 1 });
      notes.push(`no column-number row: header read from line(s) ${header.join(", ")}`);
    }
  }
  if (blocks.length > 1) notes.push(`${blocks.length} blocks (printed pages), each with its own header and column numbers`);
  const lastEnd = blocks[blocks.length - 1].end;
  const footer = grid.slice(lastEnd).flatMap((r) => r.filter(filled).flatMap((v) => String(v).split(/\r?\n/))).map(text)
    .filter((t) => t && !/^Footnotes at end of table/i.test(t));

  const columns: SoiColumn[] = [];
  const colKey = new Set<string>();
  const rows: SoiRow[] = [];
  const raw = (r: number, c: number) => (grid0[r]?.[c] === null || grid0[r]?.[c] === undefined ? "" : String(grid0[r][c]));
  const lead = (r: number, c: number) => /^[  ]*/.exec(raw(r, c))![0].length;
  const indentAt = (r: number, c: number) => marks?.[r]?.[c]?.indent ?? 0;

  for (const b of blocks) {
    const numAt = b.numberRow >= 0 ? body[b.numberRow] : [];
    // a data line that only repeats a footnote ("Footnotes at end of table") is not a row
    const dataLines: number[] = [];
    for (let r = b.start; r < b.end; r++) {
      const first = body[r].findIndex(filled);
      if (first < 0) continue;
      if (!hasNumber(r, 0) && FOOT.test(String(body[r][first])) && first === 0 && !body[r].some((v, i) => i > first && filled(v))) {
        notes.push(`line ${r + 1} read as a note: ${text(body[r][first]).slice(0, 80)}`);
        continue;
      }
      dataLines.push(r);
    }
    // label columns: column 0, and any column (no column number) whose data cells are mostly text: a repeated stub
    const labelCols = [0];
    for (let i = 1; i < width; i++) {
      if (b.numberRow >= 0 && filled(numAt[i])) continue;
      let t = 0, n = 0;
      for (const r of dataLines) {
        const v = body[r][i];
        if (!filled(v)) continue;
        if (isNumeric(String(v).replace(/^\*+\s*/, ""))) n++;
        else if (!/^\s*(\[[^\]]*\]|\*+|d|n\.a\.|N\/A|--?|x)\s*$/i.test(String(v))) t++;
      }
      if (t >= 3 && t > n * 2) labelCols.push(i);
    }
    if (labelCols.length > 1) notes.push(`side-by-side panels: label columns ${labelCols.map((c) => c + 1).join(", ")}`);

    // column names: the header lines joined top-down (a group label spread over the columns it spans)
    const names = headerNames(body, b.header, width, labelCols);
    const colOf = new Map<number, SoiColumn>();
    for (let i = 0; i < width; i++) {
      if (labelCols.includes(i)) continue;
      colOf.set(i, { idx: i, col: b.numberRow >= 0 ? colNumber(numAt[i]) : null, name: names[i] || "" });
    }

    // levels: the style indent where the workbook has one, else the rank of the leading spaces
    let anyIndent = false;
    const spaces = new Set<number>();
    for (const r of dataLines) {
      for (const c of labelCols) {
        if (!filled(body[r][c])) continue;
        if (indentAt(r, c)) anyIndent = true;
        spaces.add(lead(r, c));
      }
    }
    const rank = [...spaces].sort((a, c) => a - c);
    const levelOf = (r: number, c: number) => (anyIndent ? indentAt(r, c) : Math.max(0, rank.indexOf(lead(r, c))));
    const hasLevels = anyIndent || rank.length > 1;

    // rows: per label column (panel), the cells to its right. Two label columns side by side are one two-level stub
    // (Historical Table 24: year, then bracket): the outer one, carried down, heads the rows as a section.
    const panels: [number, number, number][] = []; // [label column, stop, outer label column or -1]
    labelCols.forEach((c, k) => {
      const stop = labelCols[k + 1] ?? width;
      if (stop === c + 1 && k + 1 < labelCols.length) return; // no data column of its own: the next panel's outer stub
      panels.push([c, stop, k > 0 && labelCols[k - 1] === c - 1 ? c - 1 : -1]);
    });
    const blockRows: SoiRow[] = [];
    for (const [lc, stop, outerCol] of panels) {
      const stack: { level: number; label: string }[] = [];
      const chain: { level: number; label: string }[] = [];
      let prevSection = -1; // the line of the section label just read (a label can run over two lines)
      let outer = "";
      for (const r of dataLines) {
        const row = body[r];
        if (outerCol >= 0 && filled(row[outerCol])) {
          outer = text(row[outerCol]);
          stack.length = 0;
          stack.push({ level: -1, label: outer });
        }
        const label = text(row[lc]).replace(/\s*\.{3,}\s*$/, "");
        const cells: SoiCell[] = [];
        for (let i = lc + 1; i < stop && i < row.length; i++) {
          const c = parseCell(row[i], marks?.[r]?.[i]?.fmt);
          const col = colOf.get(i);
          if (c && col) cells.push({ idx: i, col: col.col, name: col.name, ...c });
        }
        if (!label && !cells.length) continue;
        const level = label ? levelOf(r, lc) : 0;
        const clean = label.replace(/\s*:\s*(?=(\[[\w ,]+\]\s*)?$)/, " ").replace(/\s+$/, "");
        if (!cells.length) {
          // a section line: it heads the lines below it (the deeper ones, where the table has levels); a label that
          // continues on the next line ("Accumulated from Smallest Size" / "of Adjusted Gross Income") is joined
          const top = stack[stack.length - 1];
          if (top && prevSection >= 0 && dataLines[dataLines.indexOf(r) - 1] === prevSection && top.level === level &&
            /^[a-z(]/.test(clean)) {
            top.label = `${top.label} ${clean}`;
            chain[chain.length - 1].label = top.label;
            prevSection = r;
            continue;
          }
          prevSection = r;
          while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
          stack.push({ level, label: clean });
          while (chain.length && chain[chain.length - 1].level >= level) chain.pop();
          chain.push({ level, label: clean });
          continue;
        }
        prevSection = -1;
        if (hasLevels) {
          while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
          while (chain.length && chain[chain.length - 1].level >= level) chain.pop();
        }
        blockRows.push({ line: r + 1, level, section: stack.map((s) => s.label).join(" > "),
          parent: hasLevels ? chain[chain.length - 1]?.label ?? "" : "", label, cells });
        if (hasLevels) chain.push({ level, label: clean });
      }
    }
    blockRows.sort((a, c) => a.line - c.line);
    rows.push(...blockRows);
    // the columns that hold a value somewhere, in sheet order
    const used = new Set(blockRows.flatMap((r) => r.cells.map((c) => c.idx)));
    for (const c of colOf.values()) {
      const k = `${c.col}|${c.name}|${c.idx}`;
      if (used.has(c.idx) && !colKey.has(k)) (colKey.add(k), columns.push(c));
    }
  }
  return { title, headnote, units, header: blocks[0].header, numberRows: numberRows.map((n) => n + 1), columns, rows, footer, notes };
}

// ---------------------------------------------------------------------- filters and output
export type TableFilter = { rows?: string[]; columns?: string[]; section?: string[] };


/** Does a column match a `columns` filter item: a column number (7, "7", "(7)") or a header substring? */
export function columnHit(c: SoiColumn, want: string[]): boolean {
  return want.some((w) => {
    const n = colNumber(w);
    if (n !== null && c.col !== null) return n === c.col;
    return c.name.toLowerCase().includes(String(w).toLowerCase());
  });
}

export type LongRow = Record<string, string | number>;

/**
 * A label filter: each item matches the labels equal to it (case and spacing aside); an item equal to no label
 * matches the labels containing it. "All returns" is then that row only, and "Size of adjusted" still finds its
 * section.
 */
function matcher(items: string[] | undefined, labels: string[]): ((s: string) => boolean) | null {
  if (!items?.length) return null;
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const all = new Set(labels.map(n));
  const exact = items.map(n).filter((i) => all.has(i));
  const loose = items.map(n).filter((i) => !all.has(i));
  return (s) => exact.includes(n(s)) || loose.some((i) => n(s).includes(i));
}

function keeper(t: SoiTable, f: TableFilter): (r: SoiRow) => boolean {
  const row = matcher(f.rows, t.rows.map((r) => r.label));
  const sec = matcher(f.section, t.rows.map((r) => r.section));
  return (r) => (!row || row(r.label)) && (!sec || sec(r.section));
}
const cellName = (c: SoiCell) => c.name || `column ${c.idx + 1}`;

/** One row per cell (long): the identifiers, SECTION ... ROW_LABEL, then COL, COLUMN, VALUE, FLAG, UNITS. */
export function longRows(t: SoiTable, id: Record<string, string | number>, f: TableFilter): LongRow[] {
  const keep = keeper(t, f);
  const out: LongRow[] = [];
  for (const r of t.rows) {
    if (!keep(r)) continue;
    for (const c of r.cells) {
      if (f.columns?.length && !columnHit({ idx: c.idx, col: c.col, name: c.name }, f.columns)) continue;
      out.push({ ...id, SECTION: r.section, LINE: r.line, LEVEL: r.level, PARENT: r.parent, ROW_LABEL: r.label,
        COL: c.col ?? "", COLUMN: cellName(c), VALUE: c.value, FLAG: c.flag, UNITS: t.units });
    }
  }
  return out;
}

/** One row per line (wide): the identifiers, SECTION ... ROW_LABEL, then one column per table column ("(n) name")
 * and, where a cell carries a marker, "(n) name FLAG". */
export function wideRows(t: SoiTable, id: Record<string, string | number>, f: TableFilter): [LongRow[], string[]] {
  const key = (c: { col: number | null; name: string; idx: number }) => (c.col !== null ? `(${c.col}) ` : "") + (c.name || `column ${c.idx + 1}`);
  const keep = keeper(t, f);
  const order: string[] = [];
  const owner = new Map<string, number>();
  const flagged = new Set<string>();
  const out: LongRow[] = [];
  for (const r of t.rows) {
    if (!keep(r)) continue;
    const o: LongRow = { ...id, SECTION: r.section, LINE: r.line, LEVEL: r.level, PARENT: r.parent, ROW_LABEL: r.label };
    let any = false;
    for (const c of r.cells) {
      if (f.columns?.length && !columnHit({ idx: c.idx, col: c.col, name: c.name }, f.columns)) continue;
      let k = key(c);
      // two columns with one name and no column number: the sheet column tells them apart
      if (owner.has(k) && owner.get(k) !== c.idx) k = `${k} [sheet column ${c.idx + 1}]`;
      owner.set(k, c.idx);
      if (!order.includes(k)) order.push(k);
      o[k] = c.value;
      if (c.flag) (o[k + " FLAG"] = c.flag, flagged.add(k));
      any = true;
    }
    if (any) out.push(o);
  }
  const head = [...Object.keys(id), "SECTION", "LINE", "LEVEL", "PARENT", "ROW_LABEL"];
  for (const k of order) head.push(k, ...(flagged.has(k) ? [k + " FLAG"] : []));
  for (const o of out) for (const h of head) if (!(h in o)) o[h] = "";
  return [out, head];
}

/** The meaning of the markers a table's footer defines, e.g. "d = not shown to avoid disclosure ...". */
export function markerNotes(t: SoiTable): string[] {
  return t.footer.filter((l) => /^(\[\s*[\w ,]+\s*\]|\*{1,3}|\[?d\]?\s*[-–—=:]|n\.\s*a\.|N\/A|--)/.test(l)).slice(0, 12);
}
