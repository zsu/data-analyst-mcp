/**
 * acf: reading ACF's published workbooks (the Python adapter's tidy() and sheet choice).
 *
 * Every sheet is read the same way (tidy()): the first row with a text label and a number is the first data row;
 * the rows above it with two or more cells (or one short cell over a value column, e.g. "State Share of
 * Expenditures") are the column names, a group label spread over the columns to its right; single cells above them
 * are titles. A header that repeats its first column name further right (the caseload fiscal/calendar-year
 * averages: two side-by-side blocks, each starting with "State") is split into blocks stacked as rows with a
 * `block` column holding the block's group label. A single text cell between data rows is the `section` of the
 * rows below it; a row of two or more text cells between data rows is a second table's header and renames the
 * columns of the rows below it (CCDF Table 1b); text rows after the last data row are notes (not written). A month
 * header row stored as Excel dates is a header, not data. U+FFFD in a cell is read as a space. Month columns
 * stored as Excel dates (45566) or as "Oct-20" become "2024-10". Values are as published except: floats in their
 * shortest form (3162142819.8699999 -> 3162142819.87), a cell holding only "-" (data inapplicable) is empty. A
 * `state_code` column (USPS, US for the national total) follows the label column when the labels are states.
 */
import { DataError } from "../core/http.js";
import { withColumns } from "../core/package.js";

/** A row: a Map, so that integer-like column names ("2024") keep their place (see asTable). */
export type Rec = Map<string, unknown>;
type Grid = (string | null | undefined)[][];

export const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december"];

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

/** Python str.split() then " ".join (whitespace runs to one space, trimmed). */
const words = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

// ---------------------------------------------------------------------- cells
const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Decimal("%.15g" % x).normalize() written with format "f": 15 significant digits, no exponent, no trailing zeros. */
function sig15(x: number): string {
  if (x === 0) return "0";
  const [m, es] = Math.abs(x).toExponential(14).split("e");
  const digits = m.replace(".", "").replace(/0+$/, "") || "0";
  const e = Number(es);
  let s: string;
  if (e >= digits.length - 1) s = digits + "0".repeat(e - (digits.length - 1));
  else if (e >= 0) s = digits.slice(0, e + 1) + "." + digits.slice(e + 1);
  else s = "0." + "0".repeat(-e - 1) + digits;
  return (x < 0 ? "-" : "") + s;
}

/** Shortest exact text of a stored number (Excel keeps 15 significant digits). */
export function num(v: string): string {
  let s: string;
  if (v.includes(".") || v.toLowerCase().includes("e")) {
    const x = parseFloat(v);
    if (!Number.isFinite(x)) return v;
    s = sig15(x);
  } else {
    if (!/^[-+]?\d+$/.test(v)) return v;
    s = BigInt(v).toString();
  }
  return s === "-0" || s === "" ? "0" : s;
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = words(String(v).replace(/ /g, " ").replace(/�/g, " ")); // U+FFFD: a lost space or quote
  if (s === "-" || s === "–" || s === "—") return "-";
  return NUM.test(s) ? num(s) : s;
}

const isnum = (s: string) => s === "-" || NUM.test(s);

function excelDate(s: string): Date | null {
  if (/^\d{5}(\.0+)?$/.test(s) && Number(s) >= 20000 && Number(s) <= 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.trunc(Number(s)) * 86400000);
  }
  return null;
}

/** '45566' (an Excel date) or 'Oct-20' / 'October 2020' -> '2024-10'; anything else unchanged. */
export function monthHeader(s: string): string {
  const d = excelDate(s);
  if (d) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const m = /^([A-Za-z]{3})[a-z]*\.?[- ]'?(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS.findIndex((n) => n.startsWith(m[1].toLowerCase()));
    if (mon >= 0) {
      let y = parseInt(m[2], 10);
      y = y < 100 ? y + 2000 : y;
      return `${y}-${String(mon + 1).padStart(2, "0")}`;
    }
  }
  return s;
}

// ---------------------------------------------------------------------- states
const STATES: [string, string, string][] = [
  ["AL", "01", "Alabama"], ["AK", "02", "Alaska"], ["AZ", "04", "Arizona"], ["AR", "05", "Arkansas"],
  ["CA", "06", "California"], ["CO", "08", "Colorado"], ["CT", "09", "Connecticut"], ["DE", "10", "Delaware"],
  ["DC", "11", "District of Columbia"], ["FL", "12", "Florida"], ["GA", "13", "Georgia"], ["HI", "15", "Hawaii"],
  ["ID", "16", "Idaho"], ["IL", "17", "Illinois"], ["IN", "18", "Indiana"], ["IA", "19", "Iowa"], ["KS", "20", "Kansas"],
  ["KY", "21", "Kentucky"], ["LA", "22", "Louisiana"], ["ME", "23", "Maine"], ["MD", "24", "Maryland"],
  ["MA", "25", "Massachusetts"], ["MI", "26", "Michigan"], ["MN", "27", "Minnesota"], ["MS", "28", "Mississippi"],
  ["MO", "29", "Missouri"], ["MT", "30", "Montana"], ["NE", "31", "Nebraska"], ["NV", "32", "Nevada"],
  ["NH", "33", "New Hampshire"], ["NJ", "34", "New Jersey"], ["NM", "35", "New Mexico"], ["NY", "36", "New York"],
  ["NC", "37", "North Carolina"], ["ND", "38", "North Dakota"], ["OH", "39", "Ohio"], ["OK", "40", "Oklahoma"],
  ["OR", "41", "Oregon"], ["PA", "42", "Pennsylvania"], ["RI", "44", "Rhode Island"], ["SC", "45", "South Carolina"],
  ["SD", "46", "South Dakota"], ["TN", "47", "Tennessee"], ["TX", "48", "Texas"], ["UT", "49", "Utah"],
  ["VT", "50", "Vermont"], ["VA", "51", "Virginia"], ["WA", "53", "Washington"], ["WV", "54", "West Virginia"],
  ["WI", "55", "Wisconsin"], ["WY", "56", "Wyoming"], ["AS", "60", "American Samoa"], ["GU", "66", "Guam"],
  ["MP", "69", "Northern Mariana Islands"], ["PR", "72", "Puerto Rico"], ["VI", "78", "U.S. Virgin Islands"],
];
const BY = new Map<string, string>();
for (const [u, f, n] of STATES) for (const k of [u.toLowerCase(), f, n.toLowerCase(), String(parseInt(f, 10))]) BY.set(k, u);

/** The Python skill's analysis.combine.state(x, "usps"); null when unknown. */
function stateUsps(x: string): string | null {
  let key = x.trim().toLowerCase();
  if (/^\d+$/.test(key)) key = key.length <= 2 ? key.padStart(2, "0") : key;
  return BY.get(key) || BY.get(key.replace(/^0+/, "")) || null;
}

const STATE_ALIASES: Record<string, string> = { "dist of columbia": "DC", "district of columbia": "DC", "virgin islands": "VI",
  "u s total": "US", "u s totals": "US", "u s": "US", total: "US", "national total": "US", "united states": "US" };

export function stateCode(label: unknown): string {
  const key = words(String(label ?? "").replace(/[. ]/g, " ").toLowerCase());
  if (Object.prototype.hasOwnProperty.call(STATE_ALIASES, key)) return STATE_ALIASES[key];
  if (!key) return "";
  return stateUsps(key) ?? "";
}

// ---------------------------------------------------------------------- table structure
function cellsOf(r: string[]): [number, string][] {
  const out: [number, string][] = [];
  r.forEach((v, i) => {
    if (v !== "") out.push([i, v]);
  });
  return out;
}

/** A header of month columns stored as Excel dates: whole numbers one month (28-31 days) apart. */
function monthSerials(vals: string[]): boolean {
  if (vals.length < 2 || !vals.every((v) => excelDate(v))) return false;
  const xs = vals.map((v) => Math.trunc(Number(v)));
  return xs.slice(1).every((b, i) => b - xs[i] >= 28 && b - xs[i] <= 31);
}

function isData(r: string[]): boolean {
  const c = cellsOf(r);
  if (c.length < 2 || isnum(c[0][1])) return false;
  const nums = c.slice(1).map(([, v]) => v).filter(isnum);
  return nums.length > 0 && !monthSerials(nums);
}

const TITLE = /^(?:[A-F](?:\.\d+)?\.?:|Table \d|CHILD CARE|FISCAL YEAR|Quarter End)/i;

/** Rows above the first data row that name the columns (bottom-up, contiguous). */
function headerRows(grid: string[][], start: number): number[] {
  const hrs: number[] = [];
  let i = start - 1;
  while (i >= 0) {
    const c = cellsOf(grid[i]);
    if (!c.length) {
      if (hrs.length) break;
      i--;
      continue;
    }
    if (c.length >= 2 || (hrs.length && c.length === 1 && c[0][0] > 0 && [...c[0][1]].length <= 45 && !TITLE.test(c[0][1]))) {
      hrs.unshift(i);
      i--;
      continue;
    }
    break;
  }
  return hrs;
}

const pad = (r: string[], width: number) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : [...r]);
const padCut = (r: string[], width: number) => pad(r, width).slice(0, width);

/**
 * [column names, the last header row alone, group label per column]. A group label (a header row above the last
 * one) covers the columns to its right that have a name in the last row, until the next group label.
 */
function names(grid: string[][], hrs: number[], width: number): [string[], string[], string[]] {
  const rows = hrs.map((h) => pad(grid[h], width));
  const last = rows.length ? rows[rows.length - 1] : Array(width).fill("");
  const spread: string[][] = [];
  for (const r of rows.slice(0, -1)) {
    const out: string[] = [];
    let cur = "";
    for (let c = 0; c < width; c++) {
      if (r[c]) cur = r[c];
      else if (!last[c]) cur = "";
      out.push(cur);
    }
    spread.push(out);
  }
  const nms: string[] = [];
  for (let c = 0; c < width; c++) {
    const parts: string[] = [];
    for (const r of [...spread, last]) if (r[c] && (!parts.length || parts[parts.length - 1] !== r[c])) parts.push(r[c]);
    nms.push(parts.map(monthHeader).join(" "));
  }
  return [nms, last.map(monthHeader), spread.length ? spread[spread.length - 1] : Array(width).fill("")];
}

export function tidy(gridRaw: Grid, headerRow?: number | number[] | null): Rec[] {
  const grid = gridRaw.map((r) => r.map(cell));
  const n = grid.length;
  let hrs: number[], start: number;
  if (headerRow !== null && headerRow !== undefined && (headerRow as unknown) !== "") {
    hrs = (Array.isArray(headerRow) ? headerRow : [headerRow]).map((h) => Math.trunc(Number(h)) - 1);
    if (!hrs.length || Math.min(...hrs) < 0 || Math.max(...hrs) >= n) {
      const shown = Array.isArray(headerRow) ? `[${headerRow.join(", ")}]` : String(headerRow);
      throw new DataError(`header_row ${shown} is outside the sheet's ${n} rows`, "bad_request");
    }
    start = Math.max(...hrs) + 1;
  } else {
    const s = grid.findIndex(isData);
    if (s < 0) {
      throw new DataError("no table found in the sheet (no row with a label and a number): pick another table " +
        "or give header_row", "bad_request");
    }
    start = s;
    hrs = headerRows(grid, start);
  }
  const dataIdx: number[] = [];
  for (let i = start; i < n; i++) if (isData(grid[i])) dataIdx.push(i);
  if (!dataIdx.length) throw new DataError("no data rows below the header rows (check header_row)", "bad_request");
  const width = Math.max(...[...dataIdx, ...hrs].map((i) => grid[i].length));
  let [nms, last, groups] = names(grid, hrs, width);
  let section = "";
  if (!hrs.length) { // a list without column names (A.5): label / value
    nms = ["label", ...Array.from({ length: width - 1 }, (_, k) => (k + 1 === 1 ? "value" : `value_${k + 1}`))];
    const above = start ? cellsOf(grid[start - 1]) : [];
    section = above.length === 1 && !isnum(above[0][1]) ? above[0][1] : "";
  }
  // side-by-side blocks: the first column's name repeated further right (each block starts with "State")
  const first = last.length && last[0] ? last[0] : "";
  const starts = [0];
  for (let c = 1; c < width; c++) if (first && last[c] === first) starts.push(c);
  if (starts.length > 1) nms = last;
  const out: Rec[] = [];
  starts.forEach((s, k) => {
    const e = k + 1 < starts.length ? starts[k + 1] : width;
    const raw = hrs.length > 1 ? padCut(grid[hrs[hrs.length - 2]], width) : groups; // the group cells as written
    let label = "";
    if (starts.length > 1) for (let c = s; c < e; c++) if (raw[c]) { label = raw[c]; break; }
    const cols: number[] = [];
    for (let c = s; c < e; c++) if (nms[c] || dataIdx.some((i) => c < grid[i].length && grid[i][c])) cols.push(c);
    const columnNames = (ns: string[]) => {
      const m = new Map<number, string>();
      const seen = new Set<string>();
      for (const c of cols) {
        let nm = ns[c] || (c === s ? "label" : `col${c + 1}`);
        nm = !seen.has(nm) ? nm : `${nm}_col${c + 1}`;
        seen.add(nm);
        m.set(c, nm);
      }
      return m;
    };
    let cname = columnNames(nms);
    let sec = section;
    for (let i = start; i <= dataIdx[dataIdx.length - 1]; i++) {
      const r = padCut(grid[i], width);
      const part = r.slice(s, e);
      const c = cellsOf(part);
      if (!c.length) continue;
      if (!isData(part)) {
        if (c.length === 1 && !isnum(c[0][1])) sec = c[0][1]; // a label row inside the table ("Carryover from Prior Years")
        else if (c.length >= 2 && !c.some(([, v]) => isnum(v))) {
          cname = columnNames(r.map(monthHeader)); // a second table below the first
          sec = "";
        }
        continue;
      }
      const rec: Rec = new Map<string, unknown>([["row", i + 1]]);
      if (label) rec.set("block", label);
      rec.set("section", sec);
      for (const col of cols) rec.set(cname.get(col)!, r[col] === "-" ? "" : r[col]);
      out.push(rec);
    }
  });
  if (!out.some((r) => r.get("section"))) for (const r of out) r.delete("section");
  addStateCodes(out);
  return out;
}

function addStateCodes(rows: Rec[]): void {
  if (!rows.length) return;
  const keys = [...rows[0].keys()].filter((k) => !["row", "block", "section"].includes(k));
  if (!keys.length) return;
  const lab = keys[0];
  const codes = rows.map((r) => stateCode(r.get(lab) ?? ""));
  if (codes.filter(Boolean).length < Math.max(3, Math.floor(rows.length / 2))) return;
  rows.forEach((r, j) => {
    const items = [...r.entries()];
    const pos = items.findIndex(([k]) => k === lab) + 1;
    items.splice(pos, 0, ["state_code", codes[j]]);
    r.clear();
    for (const [k, v] of items) r.set(k, items.filter(([x]) => x === k).pop()![1]);
  });
}

// ---------------------------------------------------------------------- sheet choice
export function norm(s: unknown): string {
  return words(String(s).replace(/ /g, " ").toLowerCase());
}

/** The title lines of a sheet: rows near the top holding a single cell. */
function titleText(grid: Grid, rows = 4): string {
  const lines: string[] = [];
  for (const r of grid.slice(0, rows)) {
    const c = r.filter((v) => v !== null && v !== undefined && v !== "" && String(v).trim());
    if (c.length === 1) lines.push(String(c[0]));
  }
  return norm(lines.join(" | "));
}

const sheetList = (sheets: Record<string, Grid>) => Object.keys(sheets).slice(0, 80).join("; ");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function pickSheet(endpoint: string, sheets: Record<string, Grid>, p: Record<string, any>, label: string,
  caseloadTables: Record<string, string>): string {
  let table: any = p.table;
  const nms = Object.keys(sheets);
  if (endpoint === "tanf_caseload") table = table || "families";
  else if (endpoint === "tanf_financial") table = table || "A.1";
  else table = table || (p.file === "grant_year" ? "1b" : "4a");
  const t = norm(table);
  const exact = nms.filter((n) => norm(n) === t);
  if (exact.length) return exact[0];
  if (endpoint === "tanf_financial") {
    const m = /^([a-f])(?:\.?(\d+))?\.?$/.exec(t);
    if (m) {
      const code = m[1] + (m[2] ? "." + m[2] : "");
      const hits = nms.filter((n) => new RegExp("^" + esc(code) + "(?:[ .:]|$)").test(norm(n)) &&
        !(!m[2] && new RegExp("^" + esc(code) + "\\.\\d").test(norm(n))));
      if (hits.length === 1) return hits[0];
    }
    const code = stateCode(table);
    if (code && code !== "US") for (const n of nms) if (stateCode(n) === code) return n;
  } else if (endpoint === "tanf_caseload") {
    const tk = t.replace(/ /g, "_").replace(/-/g, "_");
    const key = Object.prototype.hasOwnProperty.call(caseloadTables, tk) ? caseloadTables[tk] : undefined;
    if (key) {
      const hits = nms.filter((n) => titleText(sheets[n]).includes(key));
      if (hits.length) return hits[0];
    }
    const m = /^(\d{4})-(\d{1,2})$/.exec(t);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
      const want = `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
      const firstVal = (g: Grid) => {
        for (const r of g.slice(0, 2)) for (const v of r) if (v !== null && v !== undefined && v !== "") return v;
        return "";
      };
      const hits = nms.filter((n) => norm(firstVal(sheets[n])) === want);
      if (hits.length) return hits[0];
      throw new DataError(`${label} has no sheet for ${table} (the workbook covers the months named in its ` +
        `sheets: ${sheetList(sheets)})`, "not_found");
    }
  } else {
    const m = /^(?:table\s*)?(\d+)\s*([ab])$/.exec(t);
    if (m) {
      const want = `table ${m[1]}${m[2]}`;
      let hits = nms.filter((n) => norm(n) === want);
      if (!hits.length) hits = nms.filter((n) => new RegExp("\\b" + want + "\\b").test(titleText(sheets[n])));
      if (hits.length) return hits[0];
    }
  }
  const sub = nms.filter((n) => norm(n).includes(t));
  if (sub.length === 1) return sub[0];
  throw new DataError(`no table ${repr(table)} in ${label} (sheets: ${sheetList(sheets)})`, "bad_request");
}

// ---------------------------------------------------------------------- output
/** Rows as package.write takes them: objects, with the columns in the rows' own key order (withColumns). */
export function asTable(rows: Map<string, unknown>[]): Record<string, unknown>[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of r.keys()) if (!seen.has(k)) (seen.add(k), cols.push(k));
  return withColumns(rows.map((r) => Object.fromEntries(r)), cols);
}
