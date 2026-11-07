/**
 * actuaries: reading the published tables (the Python adapter's cell cleaning, workbook and CSV reading, tidy(),
 * long layout, ZIP contents and CMS page links). Rows are Maps so that year columns ("1960", "2024") keep the
 * published column order (a JS object would move integer-like keys to the front); asTable() hands them on.
 *
 * Every table is read the same way (tidy()): title lines above the column names and footnote lines below the data
 * go to the fetch notes; the column-name rows are detected (or given with header_row) and joined per column, with
 * merged header cells spread over their columns; a row holding a single label inside the data ("Intermediate:",
 * "Amount in Billions") becomes the `section` column of the rows below it; `row` is the sheet row number. Values
 * are as published with these exceptions, each stated in source.md: cells holding only a dash (not applicable)
 * are empty; CSV "$" and thousands separators are dropped; .xlsx floats are written in their shortest exact form
 * (74.099999999999994 -> 74.1); a cell stored as an Excel percent-format fraction (0.106 shown as 10.6%) is written
 * as displayed (10.6), with a note giving the count. An indented label column gets `indent` (spaces as published),
 * `group` (the nearest row above with no indent) and `parent` (the nearest row above with a smaller indent), and a
 * first column of years ("2033b" with a footnote letter) gets a numeric `year` column. A second header inside the
 * sheet (SSA V.A4: a historical block, then intermediate / low-cost / high-cost columns) renames the columns of the
 * rows below it; a header repeated on a continued page is skipped. header_row overrides the detection.
 */
import { DataError } from "../core/http.js";
import { withColumns } from "../core/package.js";
import { unzip, xlsxSheets } from "../core/tabular.js";

export type MRow = Map<string, unknown>;
type Grid = string[][];

/** Python repr() of a str (or str() of a number). */
export function repr(s: unknown): string {
  if (s === null || s === undefined) return "None";
  if (typeof s === "number") return String(s);
  if (typeof s === "boolean") return s ? "True" : "False";
  const t = String(s);
  const q = t.includes("'") && !t.includes('"') ? '"' : "'";
  return q + t.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n").replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t") + q;
}

/** Python " ".join(s.split()). */
const words = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
/** Python s.strip() (whitespace, not NUL). */
const strip = (s: string) => s.replace(/^\s+|\s+$/g, "");
const basename = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);

// ---------------------------------------------------------------------- cell values
export const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
export const DASH = "\x00dash"; // a published "not applicable" dash: counts as a value while the table is read, written empty
const DASHES = new Set(["-", "—", "–", "−", "--", "�"]);

/** A plain decimal text (sign, digits, optional point) normalized as Decimal.normalize() + format "f" writes it. */
function plain(sign: string, intPart: string, frac: string): string {
  const i = intPart.replace(/^0+/, "") || "0";
  const f = frac.replace(/0+$/, "");
  const s = sign + i + (f ? "." + f : "");
  return s === "-0" || s === "" ? "0" : s;
}

/** Decimal("%.15g" % x) as [sign, integer digits, fraction digits]. */
function sig15(x: number): [string, string, string] {
  if (x === 0) return [Object.is(x, -0) ? "-" : "", "0", ""];
  const [m, es] = Math.abs(x).toExponential(14).split("e");
  const digits = m.replace(".", "");
  const e = Number(es);
  const sign = x < 0 ? "-" : "";
  if (e >= digits.length - 1) return [sign, digits + "0".repeat(e - (digits.length - 1)), ""];
  if (e >= 0) return [sign, digits.slice(0, e + 1), digits.slice(e + 1)];
  return [sign, "0", "0".repeat(-e - 1) + digits];
}

/** Shortest exact text of a stored float; a percent-format cell as displayed (x100). */
function xlsxNum(v: string, pct: boolean): string {
  if (!NUM.test(v)) return v;
  let sign: string, ip: string, fp: string;
  if (v.includes(".") || v.toLowerCase().includes("e")) {
    // Excel keeps 15 significant digits (74.099999999999994 is shown as 74.1, 495.00000000000006 as 495)
    const x = parseFloat(v);
    if (!Number.isFinite(x)) return v;
    [sign, ip, fp] = sig15(x);
  } else {
    sign = v.startsWith("-") ? "-" : "";
    ip = v.replace(/^-/, "");
    fp = "";
  }
  if (pct) {
    const f2 = (fp + "00").slice(0, 2);
    ip += f2;
    fp = fp.slice(2);
  }
  return plain(sign, ip, fp);
}

function csvNum(v: string): string {
  const s = strip(v);
  const t = strip(s.replace(/\$/g, "").replace(/,/g, ""));
  if (t && NUM.test(t) && /\d/.test(t) && (s.includes(",") || s.includes("$"))) return t;
  return v;
}

export function clean(v: unknown, pct = false, fromCsv = false): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (DASHES.has(strip(s))) return DASH;
  if (fromCsv) return csvNum(s);
  return NUM.test(strip(s)) ? xlsxNum(strip(s), pct) : s;
}

// ---------------------------------------------------------------------- workbook reading
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

function members(data: Uint8Array): Record<string, Uint8Array> {
  return unzip(data);
}

const text = (z: Record<string, Uint8Array>, n: string) => (z[n] ? new TextDecoder().decode(z[n]) : "");

export function sheetNames(data: Uint8Array): string[] {
  const wb = text(members(data), "xl/workbook.xml");
  return [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescapeHtml(m[1]));
}

/** [merged ranges as 0-based [r1, c1, r2, c2], cells stored with a percent number format ("r,c")] of one sheet. */
function sheetMeta(data: Uint8Array, sheet: string): [[number, number, number, number][], Set<string>] {
  const z = members(data);
  const target: Record<string, string> = {};
  for (const m of text(z, "xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    target[a.Id] = a.Target;
  }
  let p: string | null = null;
  for (const m of text(z, "xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.name === sheet) {
      p = (target[a["r:id"]] || "").replace(/^\/+/, "");
      p = p.startsWith("xl/") ? p : "xl/" + p;
    }
  }
  if (p === null) return [[], new Set()];
  const pctStyles = new Set<number>();
  if (z["xl/styles.xml"]) {
    const st = text(z, "xl/styles.xml");
    const fmts = new Set([9, 10]);
    for (const m of st.matchAll(/<numFmt\b[^>]*>/g)) {
      const a = attrs(m[0]);
      const code = (a.formatCode || "").replace(/"[^"]*"|\\.|_./g, "");
      if (code.includes("%")) fmts.add(parseInt(a.numFmtId, 10));
    }
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(st);
    if (xfs) {
      let i = 0;
      for (const m of xfs[1].matchAll(/<xf\b[^>]*>/g)) {
        if (fmts.has(parseInt(attrs(m[0]).numFmtId || "0", 10))) pctStyles.add(i);
        i++;
      }
    }
  }
  const rc = (ref: string): [number, number] => {
    const m = /^([A-Z]+)(\d+)/.exec(ref)!;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
    return [parseInt(m[2], 10) - 1, col - 1];
  };
  const sh = text(z, p);
  const merges: [number, number, number, number][] = [];
  for (const m of sh.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]+\d+:[A-Z]+\d+)"/g)) {
    const [a, b] = m[1].split(":");
    const [r1, c1] = rc(a), [r2, c2] = rc(b);
    merges.push([r1, c1, r2, c2]);
  }
  const pct = new Set<string>();
  if (pctStyles.size) {
    for (const m of sh.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*\bs="(\d+)"/g)) if (pctStyles.has(parseInt(m[2], 10))) pct.add(rc(m[1]).join(","));
    for (const m of sh.matchAll(/<c\b[^>]*\bs="(\d+)"[^>]*\br="([A-Z]+\d+)"/g)) if (pctStyles.has(parseInt(m[1], 10))) pct.add(rc(m[2]).join(","));
  }
  return [merges, pct];
}

function pickSheet(names: string[], want: unknown, label: string): string {
  if (want === null || want === undefined || want === "") {
    const rest = names.filter((n) => strip(n).toLowerCase() !== "notes");
    return (rest.length ? rest : names)[0];
  }
  if ((typeof want === "number" && Number.isInteger(want)) || /^\d+$/.test(strip(String(want)))) {
    const i = parseInt(strip(String(want)), 10);
    if (!(i >= 1 && i <= names.length)) {
      throw new DataError(`${label} has ${names.length} sheet(s), not sheet ${want} (sheets: ${names.join(", ")})`, "bad_request");
    }
    return names[i - 1];
  }
  for (const n of names) if (n === want || strip(n).toLowerCase() === strip(String(want)).toLowerCase()) return n;
  throw new DataError(`no sheet ${repr(want)} in ${label} (sheets: ${names.join(", ")})`, "bad_request");
}

/** [sheet name, cleaned grid, merges, percent cells converted] of one sheet. */
export function xlsxGrid(data: Uint8Array, sheet: unknown): [string, Grid, [number, number, number, number][], number] {
  const names = sheetNames(data);
  const name = pickSheet(names, sheet, "the workbook");
  const raw = xlsxSheets(data, new Set([name]))[name];
  const [merges, pct] = sheetMeta(data, name);
  let nPct = 0;
  const grid = raw.map((r, i) => r.map((v, j) => {
    const p = pct.has(`${i},${j}`) && v !== null && v !== undefined && NUM.test(strip(String(v)));
    if (p) nPct++;
    return clean(v, p);
  }));
  return [name, grid, merges, nPct];
}

/** Python's csv.reader (excel dialect, not strict) over text iterated by lines ending in "\n". */
export function pyCsvRows(text: string): string[][] {
  const out: string[][] = [];
  let fields: string[] = [];
  let field = "";
  type S = "start_record" | "start_field" | "in_field" | "in_quoted" | "quote_in_quoted" | "eat_crnl";
  let st: S = "start_record";
  const save = () => {
    fields.push(field);
    field = "";
  };
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  for (const line of lines) {
    for (const ch of [...line, null]) {
      const eol = ch === null;
      switch (st) {
        case "start_record":
          if (eol) break;
          if (ch === "\n" || ch === "\r") {
            st = "eat_crnl";
            break;
          }
          st = "start_field";
        // falls through
        case "start_field":
          if (eol || ch === "\n" || ch === "\r") {
            save();
            st = eol ? "start_record" : "eat_crnl";
          } else if (ch === '"') st = "in_quoted";
          else if (ch === ",") save();
          else {
            field += ch;
            st = "in_field";
          }
          break;
        case "in_field":
          if (eol || ch === "\n" || ch === "\r") {
            save();
            st = eol ? "start_record" : "eat_crnl";
          } else if (ch === ",") {
            save();
            st = "start_field";
          } else field += ch;
          break;
        case "in_quoted":
          if (eol) break;
          if (ch === '"') st = "quote_in_quoted";
          else field += ch;
          break;
        case "quote_in_quoted":
          if (ch === '"') {
            field += ch;
            st = "in_quoted";
          } else if (ch === ",") {
            save();
            st = "start_field";
          } else if (eol || ch === "\n" || ch === "\r") {
            save();
            st = eol ? "start_record" : "eat_crnl";
          } else {
            field += ch;
            st = "in_field";
          }
          break;
        case "eat_crnl":
          if (ch === "\n" || ch === "\r") break;
          if (eol) st = "start_record";
          else throw new DataError("new-line character seen in unquoted field - do you need to open the file with newline=''?", "api");
          break;
      }
    }
    if (st === "start_record") {
      out.push(fields);
      fields = [];
    }
  }
  // end of input inside a field (no line end after the last quoted field, or a quote left open)
  if (field.length || (st as string) === "in_quoted") {
    save();
    out.push(fields);
  }
  return out;
}

export function csvGrid(data: Uint8Array): Grid {
  let t: string;
  try {
    t = new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    t = new TextDecoder("windows-1252").decode(data);
  }
  return pyCsvRows(t).map((r) => r.map((v) => clean(v, false, true)));
}

// ---------------------------------------------------------------------- table structure
function cells(r: string[]): [number, string][] {
  const out: [number, string][] = [];
  r.forEach((v, i) => {
    if (v !== null && v !== undefined && strip(String(v))) out.push([i, v]);
  });
  return out;
}

function isnum(v: string): boolean {
  return v === DASH || NUM.test(strip(String(v)));
}

const YEAR = /^(1[89]|2[01])\d\d$/;

function yearHeader(r: string[]): boolean {
  const ne = cells(r);
  if (!ne.length || (isnum(ne[0][1]) && ne[0][0] === 0)) return false;
  const nums = ne.filter(([, v]) => isnum(v)).map(([, v]) => strip(v));
  if (nums.length < 3 || !nums.every((v) => YEAR.test(v))) return false;
  const ys = nums.map(Number);
  return ys.slice(1).every((b, i) => b > ys[i]);
}

const YEAR_ROW = /^(1[89]|2[01])\d\d[a-z]{0,2}$/;

/** A row of values: a label or year and at least one number, or a year alone (its values all published as dashes). */
function isData(r: string[]): boolean {
  const ne = cells(r);
  if (ne.length && ne[0][0] === 0 && YEAR_ROW.test(strip(String(ne[0][1]))) && ne.slice(1).every(([, v]) => isnum(v))) return true;
  return ne.length >= 2 && ne.slice(1).some(([, v]) => isnum(v)) && !yearHeader(r);
}

export function label(v: unknown): string {
  if (v === DASH) return "";
  return words(String(v).replace(/ /g, " "));
}

const joinCells = (c: [number, string][]) => c.map(([, v]) => v).join(" ");

export function tidy(grid: Grid, merges: [number, number, number, number][] = [], headerRow: number | number[] | null = null):
  [MRow[], string[], string] {
  const n = grid.length;
  let hrs: number[], start: number, titles: string[], firstSection: string;
  if (headerRow !== null && headerRow !== undefined && (headerRow as unknown) !== "") {
    hrs = (Array.isArray(headerRow) ? headerRow : [headerRow]).map((h) => Math.trunc(Number(h)) - 1);
    if (!hrs.length || Math.min(...hrs) < 0 || Math.max(...hrs) >= n) {
      const shown = Array.isArray(headerRow) ? `[${headerRow.join(", ")}]` : String(headerRow);
      throw new DataError(`header_row ${shown} is outside the sheet's ${n} rows`, "bad_request");
    }
    start = Math.max(...hrs) + 1;
    titles = [];
    for (let i = 0; i < Math.min(...hrs); i++) {
      const c = cells(grid[i]);
      if (c.length === 1) titles.push(label(c[0][1]));
    }
    firstSection = "";
  } else {
    const s = grid.findIndex(isData);
    if (s < 0) { // a notes sheet: one text column
      const rows: MRow[] = [];
      grid.forEach((r, i) => {
        const t = label(joinCells(cells(r)));
        if (t) rows.push(new Map<string, unknown>([["row", i + 1], ["text", t]]));
      });
      return [rows, [], rows.length ? String(rows[0].get("text")) : ""];
    }
    start = s;
    hrs = [];
    titles = [];
    firstSection = "";
    for (let i = 0; i < start; i++) {
      const c = cells(grid[i]);
      const nums = c.some(([, v]) => isnum(v)) && !yearHeader(grid[i]);
      const idx = new Set(c.map(([j]) => j));
      if (c.length === 2 && !nums && idx.size === 2 && idx.has(0) && idx.has(1) && hrs.some((h) => cells(grid[h]).length >= 3)) {
        firstSection = label(joinCells(c)); // "Year 2017 | Amount in Billions"
      } else if (c.length >= 2) {
        hrs.push(i);
        firstSection = "";
      } else if (c.length === 1) {
        if (hrs.length) firstSection = label(c[0][1]);
        else if (c[0][0] > 0 && titles.length) hrs.push(i); // a group label over columns ("Projected")
        else titles.push(label(c[0][1]));
      }
    }
  }
  let width = 0;
  for (let i = start; i < n; i++) width = Math.max(width, grid[i].length);
  for (const h of hrs) width = Math.max(width, grid[h].length);

  const columnNames = (block: number[]): [string[], Set<string>] => {
    const head = new Map<number, string[]>();
    for (const h of block) {
      const r = grid[h].map((v) => (label(v) ? v : ""));
      while (r.length < width) r.push("");
      head.set(h, r);
    }
    for (const [r1, c1, r2, c2] of merges) { // spread merged header cells over their columns and rows
      const top = r1 < n && c1 < grid[r1].length ? grid[r1][c1] : "";
      for (const h of block) {
        if (r1 <= h && h <= r2) {
          const hr = head.get(h)!;
          for (let c = c1; c <= Math.min(c2, width - 1); c++) if (!hr[c]) hr[c] = top;
        }
      }
    }
    if (block.length) { // a label over year columns ("Projected") covers the years to its right
      const last = head.get(block[block.length - 1])!;
      for (const h of block.slice(0, -1)) {
        const hr = head.get(h)!;
        for (let c = 1; c < width; c++) {
          if (!hr[c] && hr[c - 1] && YEAR.test(strip(String(last[c]))) && YEAR.test(strip(String(last[c - 1])))) hr[c] = hr[c - 1];
        }
      }
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (let c = 0; c < width; c++) {
      const parts: string[] = [];
      for (const h of block) {
        const p = label(head.get(h)![c]);
        if (p && (!parts.length || parts[parts.length - 1] !== p)) parts.push(p);
      }
      let nm = parts.join(" ") || `col${c + 1}`;
      nm = !seen.has(nm) ? nm : `${nm}_col${c + 1}`;
      seen.add(nm);
      out.push(nm);
    }
    const txt = new Set<string>();
    for (const h of block) txt.add(JSON.stringify(head.get(h)!.map(label).filter(Boolean)));
    for (const h of block) txt.add(JSON.stringify(grid[h].map(label).filter(Boolean)));
    return [out, txt];
  };

  let [names, headerText] = columnNames(hrs);
  const order = [...names];
  type Pending = [number, string, MRow];
  const rows: Pending[] = [];
  let pending: string[] = [], block: number[] = [], section = firstSection;
  const notes: string[] = [];
  for (let i = start; i < n; i++) {
    const r = grid[i];
    const c = cells(r);
    if (!c.length) continue;
    if (headerText.has(JSON.stringify(c.map(([, v]) => label(v))))) continue; // a header repeated on a continued page
    const blankRow = c.length === 1 && c[0][0] === 0 && rows.length > 0 && String(c[0][1]).replace(/ /g, " ").startsWith(" ");
    if (!isData(r) && !blankRow && (c.length === 1 || !c.some(([, v]) => isnum(v)))) {
      if (c.length >= 3) block.push(i); // a new header inside the sheet (a second block of columns)
      else pending.push(label(joinCells(c)));
      continue;
    }
    if (block.length) {
      let txt: Set<string>;
      [names, txt] = columnNames(block);
      for (const t of txt) headerText.add(t);
      for (const nm of names) if (!order.includes(nm)) order.push(nm);
      block = [];
    }
    if (pending.length) {
      section = pending[pending.length - 1];
      notes.push(...pending.slice(0, -1));
      pending = [];
    }
    const rec: MRow = new Map();
    for (let j = 0; j < width; j++) rec.set(names[j], j < r.length ? r[j] : "");
    rows.push([i, section, rec]);
  }
  notes.push(...pending);
  names = order;
  const full: Pending[] = rows.map(([i, sec, rec]) => [i, sec, new Map(names.map((nm) => [nm, rec.has(nm) ? rec.get(nm) : ""]))]);
  let used = names.filter((nm) => full.some(([, , rec]) => label(rec.get(nm))));
  if (!used.length) used = names;
  const hasSection = full.some(([, s]) => s);
  const first = used.length ? used[0] : null;
  let lab: string | null = null;
  for (const cand of used.slice(0, 2)) {
    if (full.some(([, , rec]) => String(rec.get(cand)).replace(/ /g, " ").startsWith(" ") && label(rec.get(cand)))) {
      lab = cand;
      break;
    }
  }
  const vals = first ? full.map(([, , rec]) => strip(String(rec.get(first)))).filter(Boolean) : [];
  // a first column of years with footnote letters ("2033b"): add a plain `year` column
  const yearcol = vals.length && vals.every((v) => /^(1[89]|2[01])\d\d[a-z ,]*$/.test(v)) && vals.some((v) => v.length > 4) ? first : null;
  const out: MRow[] = [];
  let stack: [string, number, string][] = [];
  let group = "";
  for (const [i, sec, rec] of full) {
    const o: MRow = new Map<string, unknown>([["row", i + 1]]);
    if (hasSection) o.set("section", strip(sec.replace(/:+$/, "")));
    for (const nm of used) {
      const v = rec.get(nm);
      if (nm === lab) {
        const raw = v === DASH ? "" : String(v).replace(/ /g, " ");
        const ind = raw.length - raw.replace(/^ +/, "").length;
        const lb = label(raw);
        const scope = JSON.stringify([sec, lab !== used[0] ? rec.get(used[0]) : ""]);
        stack = stack.filter(([s, k]) => s === scope && k < ind);
        const parent = stack.length ? stack[stack.length - 1][2] : "";
        stack.push([scope, ind, lb]);
        if (ind === 0 && lab === used[0]) group = lb;
        o.set(nm, lb);
        o.set("indent", ind);
        if (lab === used[0]) o.set("group", ind ? group : lb);
        o.set("parent", parent);
      } else o.set(nm, typeof v === "string" ? label(v) : v);
      if (nm === yearcol) o.set("year", label(v).slice(0, 4));
    }
    out.push(o);
  }
  return [out, [...titles, ...notes], titles.length ? titles[0] : ""];
}

const YEAR_COL = /^(?:([A-Za-z][A-Za-z ]*?) )?((?:1[89]|2[01])\d\d)(?: ([A-Za-z][A-Za-z ]*))?$/;

/** [year, label] of a year column ("2024", "2025 Projected", "Projected 2025"), else null. */
function yearCol(name: string): [string, string] | null {
  const m = YEAR_COL.exec(name);
  if (!m) return null;
  const lb = [m[1], m[3]].filter(Boolean).join(" ");
  return lb.split(/\s+/).filter(Boolean).length <= 2 ? [m[2], lb] : null;
}

/** Melt year columns ("2024", "2025 Projected", "Projected 2025") into year / value rows. */
export function longLayout(rows: MRow[]): [MRow[], boolean] {
  if (!rows.length) return [rows, true];
  const ycols = new Map<string, [string, string]>();
  for (const k of rows[0].keys()) {
    const y = yearCol(k);
    if (y) ycols.set(k, y);
  }
  if (!ycols.size) return [rows, false];
  const ids = [...rows[0].keys()].filter((k) => !ycols.has(k));
  const labelled = [...ycols.values()].some(([, lb]) => lb);
  const out: MRow[] = [];
  for (const r of rows) {
    for (const [k, [yr, lb]] of ycols) {
      const o: MRow = new Map(ids.map((i) => [i, r.get(i)]));
      o.set("year", yr);
      if (labelled) o.set("year_label", lb);
      o.set("value", r.get(k));
      out.push(o);
    }
  }
  return [out, true];
}

// ---------------------------------------------------------------------- ZIP contents
const stem = (n: string) => {
  const b = basename(n);
  const i = b.lastIndexOf(".");
  return (i > 0 ? b.slice(0, i) : b).toLowerCase();
};

/** [member, kind] of the tables in a ZIP: .xlsx members, and .csv members that have no .xlsx twin. */
export function zipTables(data: Uint8Array): [string, string][] {
  const z = members(data);
  const nms = Object.keys(z).filter((n) => !n.endsWith("/"));
  const stems = new Set(nms.filter((n) => n.toLowerCase().endsWith(".xlsx")).map(stem));
  const key = (s: string): [number, string] => [s.split("/").length - 1, s.toLowerCase()];
  const sorted = [...nms].sort((a, b) => {
    const [ca, la] = key(a), [cb, lb] = key(b);
    return ca !== cb ? ca - cb : la < lb ? -1 : la > lb ? 1 : 0;
  });
  const out: [string, string][] = [];
  for (const n of sorted) {
    const low = n.toLowerCase();
    if (low.endsWith(".xlsx")) out.push([n, "xlsx"]);
    else if (low.endsWith(".csv") && !stems.has(stem(n))) out.push([n, "csv"]);
  }
  return out;
}

export function norm(s: unknown): string {
  return words(basename(String(s)).replace(/\.(xlsx|csv)$/i, "").toLowerCase());
}

export function pickMember(tables: [string, string][], want: unknown, lbl: string): [string, string] {
  if (!tables.length) throw new DataError(`${lbl} holds no .xlsx or .csv table`, "api");
  if (want === null || want === undefined || want === "") {
    if (tables.length === 1) return tables[0];
    throw new DataError(`${lbl} holds ${tables.length} tables: name one with "table" (` +
      tables.slice(0, 40).map(([m]) => norm(m)).join("; ") + ")", "bad_request");
  }
  const q = norm(want);
  const exact = tables.filter((t) => norm(t[0]) === q);
  if (exact.length) return exact[0];
  const pre = tables.filter((t) => norm(t[0]).startsWith(q) && (norm(t[0]).length === q.length || norm(t[0])[q.length] === " "));
  if (pre.length === 1) return pre[0];
  const sub = tables.filter((t) => norm(t[0]).includes(q));
  if (sub.length === 1) return sub[0];
  const hits = pre.length ? pre : sub;
  if (hits.length) {
    throw new DataError(`table ${repr(want)} matches ${hits.length} files in ${lbl}: ` +
      hits.slice(0, 20).map(([m]) => norm(m)).join("; ") + ". Give more of the name.", "bad_request");
  }
  throw new DataError(`no table ${repr(want)} in ${lbl} (tables: ` + tables.slice(0, 40).map(([m]) => norm(m)).join("; ") + ")",
    "bad_request");
}

export function readMember(data: Uint8Array, member: string, kind: string, sheet: unknown):
  [string, Grid, [number, number, number, number][], number] {
  const raw = members(data)[member];
  if (kind === "csv") {
    if (!(sheet === null || sheet === undefined || sheet === "" || sheet === 1 || sheet === "1" || sheet === true)) {
      throw new DataError(`${basename(member)} is a CSV file: it has no sheets`, "bad_request");
    }
    return ["", csvGrid(raw), [], 0];
  }
  return xlsxGrid(raw, sheet);
}

export function listZip(data: Uint8Array): MRow[] {
  const rows: MRow[] = [];
  const z = members(data);
  const firstLabel = (g: Grid) => {
    for (const r of g) for (const [, v] of cells(r)) return label(v);
    return "";
  };
  for (const [member, kind] of zipTables(data)) {
    const raw = z[member];
    if (kind === "csv") {
      const g = csvGrid(raw);
      rows.push(new Map<string, unknown>([["table", norm(member)], ["sheet", ""], ["title", firstLabel(g)], ["format", "csv"],
        ["member", member], ["grid_rows", g.length]]));
      continue;
    }
    const sheets = xlsxSheets(raw);
    for (const name of sheetNames(raw)) {
      const g = sheets[name];
      if (!g) continue;
      const cl = g.map((r) => r.map((v) => clean(v)));
      rows.push(new Map<string, unknown>([["table", norm(member)], ["sheet", name], ["title", firstLabel(cl)], ["format", "xlsx"],
        ["member", member], ["grid_rows", g.length]]));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------- CMS pages
const HTML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–",
  mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", copy: "©",
  reg: "®", trade: "™", middot: "·", bull: "•", eacute: "é", shy: "­", sect: "§" };

/** Python html.unescape for numeric references and the common named ones. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (all, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
    }
    return HTML_ENT[e] ?? all;
  });
}

export function pageLinks(html: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>(.*?)<\/a>/gis)) {
    out.push([unescapeHtml(m[1]), label(unescapeHtml(m[2].replace(/<[^>]+>/g, " ")))]);
  }
  return out;
}

// ---------------------------------------------------------------------- output
/** Rows as package.write takes them: objects, with the columns in the rows' own key order (withColumns). */
export function asTable(rows: Map<string, unknown>[]): Record<string, unknown>[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of r.keys()) if (!seen.has(k)) (seen.add(k), cols.push(k));
  return withColumns(rows.map((r) => Object.fromEntries(r)), cols);
}
