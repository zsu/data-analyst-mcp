/**
 * usda-fna Program Data: FNA's XLSX workbooks (SNAP, WIC, child nutrition) read into tidy rows (the Python
 * adapter's "Program Data (XLSX)" section, unchanged in meaning).
 *
 * The listing pages (/pd/supplemental-nutrition-assistance-program-snap, /pd/wic-program, /pd/child-nutrition-tables)
 * link one workbook per table, named <stem>-<release>.xlsx (e.g. snap-persons-10.xlsx); the release number changes,
 * so the adapter reads the current name from the listing page. Layouts (verified 2026-10-30):
 *   annual        national annual summary: "Fiscal Year" header, one row per year (1969-)
 *   monthly       national monthly: ANNUAL SUMMARY (FY rows) then MONTHLY DATA ("FY 2023" headings, "Oct 2022" rows)
 *   state_fy      one measure by state, five fiscal years ("FY 2021" ... columns); WIC indents its tribal parts
 *   state_latest  one measure by state for three months (a year ago, last month, this month) and percent changes
 *   snap_zip      snap-zip-fy69tocurrent-NN.zip: FYyy.xlsx (FY 2020-) by region sheet, state blocks of months
 *   wic_agency    wicagencies<FY>ytd.xlsx: sixteen sheets (one per measure), agencies x months
 * Gates (a mismatch drops the data and says so, never guesses): the title row must match the table, every column used
 * must carry the label endpoints.json gives it, a value under an unlabeled visible column fails the table (hidden
 * columns are skipped), months must fall in their fiscal year in order, and month headers of state_latest tables
 * must be a year ago / last month / this month. Agency sums are compared with the printed totals (a note, not a fix).
 * The workbook reader here keeps what core's xlsxSheets drops: hidden columns and sheet row numbers (empty rows kept).
 */
import { unzipSync } from "fflate";
import { INCOMPLETE } from "../core/generic-rest.js";
import { pyFloatRepr } from "../core/py.js";

export type Cell = string | null;
export type Grid = Cell[][];
export type Sheet = [string, Grid, Set<number>];
export type Row = Record<string, any>;

// ---------------------------------------------------------------------- Python text forms
/** Python's whitespace (str.isspace / re \s), not JS's (which adds U+FEFF and lacks U+001C-U+001F, U+0085). */
const WS = "\\t-\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${WS}]+`, "g");
const WS_EDGE = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");

export function pyStrip(s: string): string {
  return s.replace(WS_EDGE, "");
}

/** repr() of a str, int, float, None, bool or list (what Python prints for {x!r} and {list}). */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let s = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
      .replace(/[\x00-\x1f\x7f]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
    if (q === "'") s = s.replace(/'/g, "\\'");
    return q + s + q;
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.entries(v as object).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  return String(v);
}

/** float(s) as Python parses text (None when it would raise ValueError/TypeError). */
const PY_FLOAT = /^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i;
export function pyFloat(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const s = pyStrip(v);
  if (!PY_FLOAT.test(s)) return null;
  const t = s.replace(/_/g, "").toLowerCase();
  if (t.endsWith("inf") || t.endsWith("infinity")) return t.startsWith("-") ? -Infinity : Infinity;
  if (t.endsWith("nan")) return NaN;
  return Number(t);
}

/** sum() of floats as CPython 3.12+ adds them (Neumaier compensated summation). */
export function pySum(xs: number[]): number {
  if (!xs.length) return 0;
  let f = xs[0], c = 0;
  for (let i = 1; i < xs.length; i++) {
    const x = xs[i];
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

/** f"{x:,.0f}": rounded half to even, with thousands separators. */
export function fmt0(x: number): string {
  if (!Number.isFinite(x)) return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  const fl = Math.floor(x);
  let r = x - fl === 0.5 ? (fl % 2 === 0 ? fl : fl + 1) : Math.round(x);
  const neg = r < 0 || (r === 0 && (x < 0 || Object.is(x, -0)));
  r = Math.abs(r);
  return (neg ? "-" : "") + BigInt(r).toLocaleString("en-US");
}

/** f"{n:,}" of an int. */
export const comma = (n: number) => n.toLocaleString("en-US");
export const pad2 = (n: number) => String(n).padStart(2, "0");

/** f"{f:.15g}", and f"{f:.15f}".rstrip("0").rstrip(".") where %g would write an exponent. */
function num15(f: number): string {
  if (f === 0) return Object.is(f, -0) ? "-0" : "0";
  const exp = Number(f.toExponential(14).split("e")[1]);
  if (exp < -4 || exp >= 15) {
    const s = Math.abs(f) >= 1e21 ? BigInt(f).toString() + ".000000000000000" : f.toFixed(15);
    return s.replace(/0+$/, "").replace(/\.$/, "");
  }
  let s = f.toPrecision(15);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

export class LayoutError extends Error {
  /** The workbook does not have the layout endpoints.json describes: its rows are dropped. */
}

// ---------------------------------------------------------------------- XLSX reader
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unxml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? all);
}
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = unxml(m[2] ?? m[3]);
  return out;
}
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join("");

export function zipMembers(body: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(body, { filter: (f) => (names.push(f.name), false) });
  return names;
}

export function zipRead(body: Uint8Array, name: string): Uint8Array {
  return unzipSync(body, { filter: (f) => f.name === name })[name];
}

/** [(sheet name, rows, hidden column indexes)]; a row is a list of cell texts (null for empty), in sheet row
 * order with empty rows kept, so rows[i] is sheet row i + 1. */
export function readBook(body: Uint8Array): Sheet[] {
  let z: Record<string, Uint8Array>;
  try {
    z = unzipSync(body);
  } catch {
    throw new LayoutError("not an XLSX file (the server may have returned an HTML page)");
  }
  const read = (n: string) => {
    if (!z[n]) throw new LayoutError(`not an XLSX file (no ${n} in the zip)`);
    return new TextDecoder().decode(z[n]).replace(/\r\n?/g, "\n");
  };
  const shared = z["xl/sharedStrings.xml"]
    ? [...read("xl/sharedStrings.xml").matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : [];
  const target: Record<string, string> = {};
  for (const m of read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    target[a.Id] = a.Target;
  }
  const out: Sheet[] = [];
  for (const m of read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    let p = target[a["r:id"]] ?? "";
    p = p.startsWith("/") ? p.replace(/^\/+/, "") : "xl/" + p;
    const xml = read(p);
    const hidden = new Set<number>();
    for (const c of xml.matchAll(/<col\b[^>]*>/g)) {
      const ca = attrs(c[0]);
      if (ca.hidden === "1" || ca.hidden === "true") {
        for (let i = parseInt(ca.min, 10) - 1; i < parseInt(ca.max, 10); i++) hidden.add(i);
      }
    }
    const rows: Grid = [];
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const vals = new Map<number, Cell>();
      for (const cm of (rm[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(cm[1]);
        let col = 0;
        for (const ch of (/^[A-Z]+/.exec(ca.r || "") || ["A"])[0]) col = col * 26 + ch.charCodeAt(0) - 64;
        const inner = cm[2] || "";
        const v = /<v(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/v>)/.exec(inner);
        const t = ca.t;
        if (t === "s" && v) vals.set(col - 1, shared[parseInt(v[1] ?? "", 10)] ?? null);
        else if (t === "inlineStr") vals.set(col - 1, texts(inner));
        else if (v) vals.set(col - 1, v[1] ? unxml(v[1]) : null);
      }
      const ra = attrs(rm[1]);
      const n = parseInt(ra.r || "", 10) || rows.length + 1;
      while (rows.length < n - 1) rows.push([]);
      const width = vals.size ? Math.max(...vals.keys()) + 1 : 0;
      rows.push(Array.from({ length: width }, (_, i) => vals.get(i) ?? null));
    }
    out.push([a.name, rows, hidden]);
  }
  return out;
}

export function norm(x: unknown): string {
  return pyStrip(String(x !== null && x !== undefined ? x : "").replace(/\xa0/g, " ").replace(WS_RUN, " "));
}

const PD_MISSING = ["--", "-", "—", "–", "N/A", "NA", "#DIV/0!", "#N/A", "#VALUE!"];
const NUM = /^(-?\d+(?:\.\d+)?(?:E[-+]?\d+)?)\s*(\*+|\d\])?$/i;

/** [value, value_num, value_flag, footnote] of a published cell. Numbers are written with up to 15 significant
 * digits (Excel's own precision: 549.70000000000005 is 549.7); codes go to the flag and are never a zero. */
export function cell(v: unknown): [string, string, string, string] {
  const s = norm(v);
  if (!s) return ["", "", "blank", ""];
  if (PD_MISSING.includes(s)) return [s, "", s, ""];
  const m = NUM.exec(s);
  if (!m) return [s, "", s, ""]; // "1]" (a footnote standing for a value, e.g. included with free)
  const num = num15(Number(m[1]));
  return [num, num, "", m[2] || ""];
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december"];
const DAYS = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function isoDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/** datetime.strptime(s, "%B %d, %Y").date().isoformat(), or null where strptime would raise. */
function strptimeLong(s: string): string | null {
  const m = /^([A-Za-z]+)\s+(3[01]|[12]\d|0[1-9]|[1-9]|\s[1-9]),\s+(\d{4})$/.exec(s);
  if (!m) return null;
  const mo = MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1;
  const d = parseInt(m[2].trim(), 10), y = parseInt(m[3], 10);
  if (!mo || y < 1 || d > DAYS(y, mo)) return null;
  return isoDate(y, mo, d);
}

export function asOf(rows: Grid): string {
  for (const r of rows.slice(0, 6)) {
    const m = /Data as of\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/.exec(r.filter((x) => x).map(norm).join(" "));
    if (m) return strptimeLong(m[1].replace(/,\s*/g, ", ")) ?? m[1];
  }
  return "";
}

/** A note when "Data as of" precedes the table's own latest data (the month after its latest month; for fiscal
 * years, November of the year's first month): the printed date is wrong. 27wilatest-5 to -9 print 2025 for 2026. */
export function asofNotes(key: string, rows: Row[]): string[] {
  const asof = rows.find((x) => x.data_as_of)?.data_as_of ?? "";
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asof);
  if (!dm) return [];
  const d = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  let latest: [number, number] | null = null;
  for (const x of rows) {
    if (!x.value_num) continue;
    const ym: [number, number] = x.period_type === "month" ? [parseInt(x.period.slice(0, 4), 10), parseInt(x.period.slice(5, 7), 10)]
      : [x.fiscal_year - 1, 10];
    if (!latest || ym[0] > latest[0] || (ym[0] === latest[0] && ym[1] > latest[1])) latest = ym;
  }
  if (!latest) return [];
  const [y, m] = latest;
  const need = [y + (m === 12 ? 1 : 0), (m % 12) + 1, 1];
  const cmp = d[0] - need[0] || d[1] - need[1] || d[2] - need[2];
  if (cmp >= 0) return [];
  const per = rows.some((x) => x.period_type === "month") ? `${y}-${pad2(m)}` : `FY ${y + 1}`;
  return [`${key}: the workbook says "Data as of" ${asof}, before its own latest data (${per}): the printed date ` +
    "is wrong (most likely its year). data_as_of keeps the date as printed; cite the release by its file " +
    "name and the date you retrieved it rather than that date"];
}

export function labelOk(head: unknown, label: string): boolean {
  const h = norm(head).replace(new RegExp(`[${WS}]+`, "g"), "").toLowerCase();
  return !!h && (label.match(/[A-Za-z0-9]+/g) || []).every((w) => h.includes(w.toLowerCase()));
}

const MONTHS: Record<string, number> = Object.fromEntries(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map((m, i) => [m, i + 1]));

/** [year, month] of "Oct 2022", "July 2026 Initial", "June\n2026\nPreliminary"; null otherwise. */
export function month(s: unknown): [number, number] | null {
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})\b/.exec(norm(s));
  if (m && m[1].toLowerCase() in MONTHS) return [parseInt(m[2], 10), MONTHS[m[1].toLowerCase()]];
  return null;
}

export const fyOf = (ym: [number, number]) => (ym[1] >= 10 ? ym[0] + 1 : ym[0]);
const ymLe = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
const ymEq = (a: [number, number] | null, b: [number, number]) => !!a && a[0] === b[0] && a[1] === b[1];

function excelMonth(v: unknown): [number, number] | null {
  const f = pyFloat(v);
  if (f === null || !Number.isFinite(f)) return month(v);
  const t = Date.UTC(1899, 11, 30) + Math.trunc(f) * 86400000;
  const d = new Date(t);
  if (!Number.isFinite(t) || d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) return month(v);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1];
}

function prelimYears(rows: Grid): Set<number> {
  const text = rows.flatMap((r) => r.filter((x) => typeof x === "string").map(norm)).join(" ");
  return new Set([...text.matchAll(/FY ?(\d{4}) data are preliminary/gi)].map((m) => parseInt(m[1], 10)));
}

// ---------------------------------------------------------------------- areas
const EXTRA_AREAS: [string, string][] = [["AS", "American Samoa"], ["PR", "Puerto Rico"], ["MP", "Northern Mariana Islands"]];
const AREA_ALIASES: Record<string, string> = { "commonwealth of northern mariana islands": "MP", "northern marianas": "MP",
  "u.s. virgin islands": "VI", "us virgin islands": "VI" };
export const REGIONS: Record<string, string> = { NERO: "Northeast", MARO: "Mid-Atlantic", SERO: "Southeast", MWRO: "Midwest",
  SWRO: "Southwest", MPRO: "Mountain Plains", WRO: "Western" };

/** The states, DC and territories under the names the workbooks use (USPS codes; AS, PR, MP added). */
export class Areas {
  name: Map<string, string>;
  abbr: Map<string, string>;
  constructor(agencies: [string, string][]) {
    this.name = new Map([...agencies, ...EXTRA_AREAS]);
    this.abbr = new Map([...this.name].map(([a, n]) => [n.toLowerCase(), a]));
    for (const [k, v] of Object.entries(AREA_ALIASES)) this.abbr.set(k, v);
  }

  code(x: unknown): string | null {
    const k = pyStrip(norm(x).toLowerCase().replace(/\*+$/, ""));
    if (this.name.has(k.toUpperCase())) return k.toUpperCase();
    return this.abbr.get(k) ?? null;
  }

  codes(v: unknown): string[] {
    const vals = Array.isArray(v) ? v : String(v).split(",").filter((x) => pyStrip(x));
    const out: string[] = [];
    for (const x of vals) {
      const c = this.code(x);
      if (!c) {
        throw new SpecError(`unknown state or territory ${pyRepr(x)}: give a USPS code (TX) or a name (Texas); ` +
          "territories: AS, GU, MP, PR, VI");
      }
      if (!out.includes(c)) out.push(c);
    }
    return out;
  }

  /** [row_type, state, state_abbr] of a state-table row name. */
  classify(raw: unknown): [string, string, string] {
    const n = norm(raw);
    if (n.toUpperCase() === "TOTAL") return ["total", "Total", ""];
    if (n.startsWith("DOD") || n.startsWith("Dept. of Defense")) return ["dod", n, ""];
    const c = this.code(n);
    if (c) return ["state", n, c];
    return ["other", n, ""];
  }
}

/** Python's ValueError from a spec helper (check_spec reports it as a problem). */
export class SpecError extends Error {}

// ---------------------------------------------------------------------- table rows
function mkRow(t: string, title: string, asof: string, state: string, abbr: string, agency: string, rtype: string,
  period: string, ptype: string, fy: number, meas: string, unit: string, raw: unknown, status: string): Row {
  const [v, num, flag, foot] = cell(raw);
  return { table: t, table_title: title, data_as_of: asof, state, state_abbr: abbr, agency, row_type: rtype, period,
    period_type: ptype, fiscal_year: fy, measure: meas, unit, value: v, value_num: num, value_flag: flag, status,
    footnote: foot };
}

const at = (r: Cell[], j: number): Cell => (j < r.length ? r[j] : null);

export function titleOf(rows: Grid): string {
  for (const r of rows) if (r.length && r[0] && norm(r[0])) return norm(r[0]);
  return "";
}

function layoutOf(rows: Grid): string {
  const firsts = rows.slice(0, 12).filter((r) => r.length && r[0]).map((r) => norm(r[0]));
  if (firsts.map((f) => f.toUpperCase()).includes("ANNUAL SUMMARY")) return "monthly";
  for (const r of rows.slice(0, 8)) {
    if (r.length && r[0] && norm(r[0]).toLowerCase().startsWith("state")) {
      const c = r.slice(1).filter((x) => x).map(norm);
      if (c.length && /^FY \d{4}/.test(c[0])) return "state_fy";
      if (c.length && month(c[0])) return "state_latest";
    }
    if (r.length && r[0] && norm(r[0]).toLowerCase().startsWith("fiscal year")) return "annual";
  }
  return "";
}

/** The [name, rows, hidden] sheet holding table d: its title matches and its layout is d's. */
export function findSheet(book: Sheet[], d: any): Sheet | null {
  for (const s of book) if (new RegExp(d.title, "i").test(titleOf(s[1])) && layoutOf(s[1]) === d.layout) return s;
  return null;
}

function header(rows: Grid, first: string): number {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const r = rows[i];
    if (r.length && r[0] && norm(r[0]).toLowerCase().startsWith(first)) return i;
  }
  throw new LayoutError(`no header row starting with ${pyRepr(first)}`);
}

/** A value under a visible column the table does not use means the columns moved: fail. */
function checkColumns(rows: Grid, start: number, hidden: Set<number>, used: Set<number>, what: string): void {
  for (const r of rows.slice(start)) {
    for (let j = 1; j < r.length; j++) {
      const x = r[j];
      if (!used.has(j) && !hidden.has(j) && norm(x) && cell(x)[1]) {
        throw new LayoutError(`${what}: a value in unlabeled column ${j + 1} (${pyRepr(norm(r[0]))} row)`);
      }
    }
  }
}

/** [[column index, [measure, label, unit]]]: the visible header cells in order, each matching its label. */
function labeled(head: Cell[], cols: string[][], hidden: Set<number>, what: string): [number, string[]][] {
  const vis: number[] = [];
  for (let j = 1; j < head.length; j++) if (!hidden.has(j) && norm(head[j])) vis.push(j);
  if (vis.length !== cols.length) throw new LayoutError(`${what}: ${vis.length} labeled columns, endpoints.json lists ${cols.length}`);
  vis.forEach((j, i) => {
    if (!labelOk(head[j], cols[i][1])) {
      throw new LayoutError(`${what}: column ${j + 1} is ${pyRepr(norm(head[j]))}, expected ${pyRepr(cols[i][1])}`);
    }
  });
  return vis.map((j, i) => [j, cols[i]]);
}

function parseAnnual(key: string, d: any, rows: Grid, hidden: Set<number>): Row[] {
  const title = titleOf(rows), asof = asOf(rows), pre = prelimYears(rows);
  const h = header(rows, "fiscal year");
  const cols = labeled(rows[h], d.columns, hidden, key);
  checkColumns(rows, h + 1, hidden, new Set(cols.map(([j]) => j)), key);
  const out: Row[] = [];
  let last = 0;
  for (const r of rows.slice(h + 1)) {
    const m = /^(\d{4})(?:\.0)?\s*(\d\])?$/.exec(r.length ? norm(r[0]) : "");
    if (!m) continue;
    const fy = parseInt(m[1], 10);
    if (fy <= last) throw new LayoutError(`${key}: fiscal year ${fy} after ${last}`);
    last = fy;
    for (const [j, [meas, , unit]] of cols) {
      const row = mkRow(key, title, asof, "U.S.", "", "", "national", `FY ${fy}`, "fiscal_year", fy, meas, unit, at(r, j),
        pre.has(fy) ? "preliminary" : "");
      row.footnote = [m[2] || "", row.footnote].filter((x) => x).join(" ");
      out.push(row);
    }
  }
  if (!out.length) throw new LayoutError(`${key}: no fiscal-year rows`);
  return out;
}

function parseMonthly(key: string, d: any, rows: Grid, hidden: Set<number>): Row[] {
  const title = titleOf(rows), asof = asOf(rows), pre = prelimYears(rows);
  const h = header(rows, "fiscal year");
  const cols = labeled(rows[h], d.columns, hidden, key);
  checkColumns(rows, h + 1, hidden, new Set(cols.map(([j]) => j)), key);
  const out: Row[] = [];
  let section = "", cur: number | null = null, prev: [number, number] | null = null;
  for (const r of rows.slice(h + 1)) {
    const f = r.length ? norm(r[0]) : "";
    if (f.toUpperCase() === "ANNUAL SUMMARY" || f.toUpperCase() === "MONTHLY DATA") {
      section = f.toUpperCase();
      continue;
    }
    const has = r.slice(1).some((x) => norm(x));
    const mfy = /^FY ?(\d{4})$/.exec(f);
    const ym = month(f);
    let fy: number, period: string, ptype: string;
    if (mfy && section === "MONTHLY DATA" && !has) {
      cur = parseInt(mfy[1], 10);
      prev = null;
      continue;
    }
    if (mfy && section === "ANNUAL SUMMARY") {
      fy = parseInt(mfy[1], 10);
      [period, ptype] = [`FY ${fy}`, "fiscal_year"];
    } else if (ym && section === "MONTHLY DATA") {
      if (cur === null || fyOf(ym) !== cur || (prev && ymLe(ym, prev))) {
        throw new LayoutError(`${key}: month ${pyRepr(f)} is out of place (under FY ${cur === null ? "None" : cur})`);
      }
      prev = ym;
      fy = cur;
      [period, ptype] = [`${ym[0]}-${pad2(ym[1])}`, "month"];
    } else continue;
    for (const [j, [meas, , unit]] of cols) {
      out.push(mkRow(key, title, asof, "U.S.", "", "", "national", period, ptype, fy, meas, unit, at(r, j),
        pre.has(fy) ? "preliminary" : ""));
    }
  }
  if (!out.some((x) => x.period_type === "month")) throw new LayoutError(`${key}: no monthly rows`);
  return out;
}

/** [[row_type, state, abbr, agency, row]] down to the TOTAL row; indented names are parts of the state above. */
function stateRows(rows: Grid, start: number, areas: Areas): [string, string, string, string, Cell[]][] {
  const out: [string, string, string, string, Cell[]][] = [];
  let parent: [string, string] | null = null;
  for (const r of rows.slice(start)) {
    if (!r.length || !r[0] || !norm(r[0])) continue;
    const raw = String(r[0]);
    const [rtype, state, abbr] = areas.classify(raw);
    if (rtype !== "total" && raw.slice(0, 1) === " " && parent) {
      out.push(["sub_agency", parent[0], parent[1], norm(raw), r]);
      continue;
    }
    out.push([rtype, state, abbr, "", r]);
    if (rtype === "total") return out;
    parent = [state, abbr];
  }
  throw new LayoutError("no TOTAL row");
}

/** Agency sums vs the printed totals (and WIC tribal parts vs their state), per period and measure. */
function sumNotes(key: string, rows: Row[], tolRel = 0.0005): string[] {
  const notes: string[] = [];
  const by = new Map<string, Row[]>();
  for (const x of rows) {
    const k = JSON.stringify([x.measure, x.period]);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(x);
  }
  for (const [k, xs] of by) {
    const [meas, period] = JSON.parse(k);
    const tot = xs.filter((x) => x.row_type === "total" && x.value_num);
    const parts = xs.filter((x) => ["state", "dod", "other"].includes(x.row_type) && x.value_num).map((x) => Number(x.value_num));
    if (tot.length && parts.length && !meas.includes("avg") && !meas.includes("share")) {
      const t = Number(tot[0].value_num);
      const s = pySum(parts);
      if (Math.abs(s - t) > Math.max(2.0, tolRel * Math.abs(t))) {
        notes.push(`${key} ${meas} ${period}: agency sum ${fmt0(s)} vs printed total ${fmt0(t)}`);
      }
    }
  }
  return notes;
}

function subNotes(key: string, rows: Row[]): string[] {
  const notes: string[] = [];
  const by = new Map<string, Map<string, number[]>>();
  for (const x of rows) {
    if ((x.row_type === "state" || x.row_type === "sub_agency") && x.value_num) {
      const k = JSON.stringify([x.state, x.period]);
      if (!by.has(k)) by.set(k, new Map());
      const g = by.get(k)!;
      if (!g.has(x.row_type)) g.set(x.row_type, []);
      g.get(x.row_type)!.push(Number(x.value_num));
    }
  }
  for (const [k, g] of by) {
    if (rows.slice(0, 1).some((x) => x.measure.includes("avg"))) break;
    const [st, period] = JSON.parse(k);
    if (g.has("sub_agency") && g.has("state")) {
      const s = pySum(g.get("sub_agency")!), t = g.get("state")![0];
      if (Math.abs(s - t) > Math.max(2.0, 0.0005 * Math.abs(t))) {
        notes.push(`${key} ${st} ${period}: its agencies sum to ${fmt0(s)}, the state row is ${fmt0(t)}`);
      }
    }
  }
  return notes;
}

function parseStateFy(key: string, d: any, rows: Grid, hidden: Set<number>, areas: Areas): [Row[], string[]] {
  const title = titleOf(rows), asof = asOf(rows);
  const h = header(rows, "state");
  const cols: [number, number][] = [];
  rows[h].forEach((x, j) => {
    const m = /^FY (\d{4})/.exec(norm(x));
    if (j && !hidden.has(j) && m) cols.push([j, parseInt(m[1], 10)]);
  });
  if (!cols.length || cols.some(([, y], i) => y !== cols[0][1] + i)) {
    throw new LayoutError(`${key}: fiscal-year columns ${pyRepr(rows[h].slice(1).map(norm))}`);
  }
  checkColumns(rows, h + 1, hidden, new Set(cols.map(([j]) => j)), key);
  const status = new Map<number, string>();
  for (const r of rows.slice(h + 1, h + 3)) {
    if (r.length && !norm(r.length ? r[0] : "")) {
      for (const [j] of cols) if (j < r.length && /prelim/i.test(norm(r[j]))) status.set(j, "preliminary");
    }
  }
  const pre = prelimYears(rows);
  const out: Row[] = [];
  for (const [rtype, state, abbr, agency, r] of stateRows(rows, h + 1, areas)) {
    for (const [j, fy] of cols) {
      out.push(mkRow(key, title, asof, state, abbr, agency, rtype, `FY ${fy}`, "fiscal_year", fy, d.measure, d.unit, at(r, j),
        status.get(j) || (pre.has(fy) ? "preliminary" : "")));
    }
  }
  return [out, [...sumNotes(key, out), ...subNotes(key, out)]];
}

function parseStateLatest(key: string, d: any, rows: Grid, hidden: Set<number>, areas: Areas): [Row[], string[]] {
  const title = titleOf(rows), asof = asOf(rows);
  const h = header(rows, "state");
  const head = rows[h];
  const cols: [number, [number, number], string][] = [];
  head.forEach((x, j) => {
    const ym = month(x);
    if (j && !hidden.has(j) && ym) cols.push([j, ym, norm(x)]);
  });
  const used = new Set<number>(cols.map(([j]) => j));
  head.forEach((x, j) => {
    if (/^percent change/i.test(norm(x))) used.add(j);
  });
  checkColumns(rows, h + 1, hidden, used, key);
  if (cols.length !== 3) throw new LayoutError(`${key}: ${cols.length} month columns, expected 3`);
  const notes: string[] = [], keep: [number, [number, number], string][] = [];
  const [y, m] = cols[2][1];
  const want: [number, number][] = [[y - 1, m], [m > 1 ? y : y - 1, m > 1 ? m - 1 : 12], [y, m]];
  cols.forEach(([j, ym, lab], i) => {
    const w = want[i];
    if (!ymEq(ym, w)) {
      notes.push(`${key}${INCOMPLETE} column ${pyRepr(lab)} dropped: its month is not ${w[0]}-${pad2(w[1])} (a year ` +
        `before / the month before ${y}-${pad2(m)}), so the header cannot be trusted`);
    } else {
      const st = /initial/i.test(lab) ? "initial" : /prelim/i.test(lab) ? "preliminary" : "";
      keep.push([j, ym, st]);
    }
  });
  const out: Row[] = [];
  for (const [rtype, state, abbr, agency, r] of stateRows(rows, h + 1, areas)) {
    for (const [j, ym, st] of keep) {
      out.push(mkRow(key, title, asof, state, abbr, agency, rtype, `${ym[0]}-${pad2(ym[1])}`, "month", fyOf(ym),
        d.measure, d.unit, at(r, j), st));
    }
  }
  return [out, [...notes, ...sumNotes(key, out), ...subNotes(key, out)]];
}

/** Rows and notes of catalog table key from its workbook; LayoutError when it does not match. */
export function parseTable(key: string, d: any, body: Uint8Array, areas: Areas): [Row[], string[]] {
  const found = findSheet(readBook(body), d);
  if (!found) throw new LayoutError(`${key}: no sheet titled like ${pyRepr(d.title)} with the ${d.layout} layout`);
  const [, rows, hidden] = found;
  let out: Row[], notes: string[];
  if (d.layout === "annual") [out, notes] = [parseAnnual(key, d, rows, hidden), []];
  else if (d.layout === "monthly") [out, notes] = [parseMonthly(key, d, rows, hidden), []];
  else if (d.layout === "state_fy") [out, notes] = parseStateFy(key, d, rows, hidden, areas);
  else [out, notes] = parseStateLatest(key, d, rows, hidden, areas);
  return [out, [...asofNotes(key, out), ...notes]];
}

// ---------------------------------------------------------------------- SNAP state monthly (zip of FYyy.xlsx)
const SNAP_COLS: [string, string][] = [["households", "households (monthly)"], ["persons", "persons (monthly)"],
  ["benefits", "dollars"], ["benefit_per_household", "dollars per household per month"],
  ["benefit_per_person", "dollars per person per month"]];

const base = (n: string) => n.slice(n.lastIndexOf("/") + 1);

/** The FYyy.xlsx member of a zip (given its member names), or null. */
export function snapZipMember(body: Uint8Array, names: string[], fy: number): Uint8Array | null {
  const rx = new RegExp(`^FY${pad2(fy % 100)}\\.xlsx$`, "i");
  for (const n of names) if (rx.test(base(n))) return zipRead(body, n);
  return null;
}

export function zipXlsxYears(names: string[]): number[] {
  const out: number[] = [];
  for (const n of names) {
    const m = /^FY(\d{2})\.(xlsx?)$/i.exec(base(n));
    if (m) out.push((parseInt(m[1], 10) < 69 ? 2000 : 1900) + parseInt(m[1], 10));
  }
  return out.sort((a, b) => a - b);
}

export function parseSnapYear(body: Uint8Array, fy: number, areas: Areas): [Row[], string[]] {
  const out: Row[] = [], notes: string[] = [];
  const t = "snap_state_monthly";
  for (const [sheet, rows] of readBook(body)) {
    const head = rows.slice(0, 3).flatMap((r) => r.filter((x) => x).map(norm)).join(" ");
    if (!new RegExp(`Fiscal Year ${fy}\\b`).test(head)) {
      throw new LayoutError(`FY${pad2(fy % 100)}.xlsx sheet ${pyRepr(sheet)} is not fiscal year ${fy}: ${pyRepr(head.slice(0, 120))}`);
    }
    const title = rows.length > 1 && rows[1].length ? norm(rows[1][0]) : head;
    let h: number | null = null;
    for (let i = 0; i < Math.min(12, rows.length); i++) {
      const r = rows[i];
      if (r.length && norm(r[0]).toLowerCase().startsWith("fiscal year and month")) {
        h = i;
        break;
      }
    }
    const sub = h !== null && h + 1 < rows.length ? rows[h + 1] : [];
    const labs = sub.length ? sub.slice(1, 6).map((x) => norm(x).toLowerCase()) : [];
    const wantLabs = ["household", "persons", "", "household", "persons"];
    if (h === null || labs.length !== wantLabs.length || labs.some((x, i) => x !== wantLabs[i]) ||
      !labelOk(rows[h].length > 3 ? rows[h][3] : "", "Cost")) {
      throw new LayoutError(`FY ${fy} sheet ${pyRepr(sheet)}: the header is not Participation (Household, Persons), ` +
        `Cost, Cost Per (Household, Persons): ${pyRepr(labs)}`);
    }
    let block: [string, string, string, string] | null = null;
    let prev: [number, number] | null = null;
    for (const r of rows.slice(h + 2)) {
      const f = r.length ? norm(r[0]) : "";
      if (!f) continue;
      if (f.toLowerCase().startsWith("footnotes")) break;
      const ym = month(f);
      if (!ym && f !== "Total") {
        if (Object.prototype.hasOwnProperty.call(REGIONS, f)) block = ["region", REGIONS[f] + " Region", "", f];
        else if (f.toLowerCase() === "us summary") block = ["national", "U.S.", "", ""];
        else {
          const [rt, st, ab] = areas.classify(f);
          block = [rt, st, ab, ""];
        }
        prev = null;
        continue;
      }
      if (block === null) throw new LayoutError(`FY ${fy} sheet ${pyRepr(sheet)}: ${pyRepr(f)} before any state name`);
      let period: string, ptype: string;
      if (ym) {
        if (fyOf(ym) !== fy || (prev && ymLe(ym, prev))) {
          throw new LayoutError(`FY ${fy} sheet ${pyRepr(sheet)} ${block[1]}: month ${pyRepr(f)} is out of place`);
        }
        prev = ym;
        [period, ptype] = [`${ym[0]}-${pad2(ym[1])}`, "month"];
      } else [period, ptype] = [`FY ${fy}`, "fiscal_year"];
      SNAP_COLS.forEach(([meas, unit], i) => {
        const j = i + 1;
        out.push(mkRow(t, title, "", block![1], block![2], block![3], block![0], period, ptype, fy, meas,
          ptype === "month" || meas !== "benefits" ? unit : "dollars (fiscal year)", at(r, j), ""));
      });
    }
  }
  // sums: states of a region vs the region, regions vs the U.S., per month
  const by = new Map<string, Map<string, number[]>>();
  for (const x of out) {
    if (x.period_type === "month" && ["persons", "households", "benefits"].includes(x.measure) && x.value_num) {
      const k = JSON.stringify([x.measure, x.period]);
      if (!by.has(k)) by.set(k, new Map());
      const g = by.get(k)!;
      if (!g.has(x.row_type)) g.set(x.row_type, []);
      g.get(x.row_type)!.push(Number(x.value_num));
    }
  }
  const keys = [...by.keys()].sort((a, b) => {
    const [x, y] = [JSON.parse(a), JSON.parse(b)];
    return x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0;
  });
  for (const k of keys) {
    const [meas, period] = JSON.parse(k);
    const g = by.get(k)!;
    const nat = g.get("national"), reg = g.get("region"), sta = g.get("state");
    if (nat && reg && Math.abs(pySum(reg) - nat[0]) > 2) {
      notes.push(`snap_state_monthly FY ${fy} ${meas} ${period}: regions sum to ${fmt0(pySum(reg))}, U.S. ${fmt0(nat[0])}`);
    }
    if (reg && sta && Math.abs(pySum(sta) - pySum(reg)) > 2) {
      notes.push(`snap_state_monthly FY ${fy} ${meas} ${period}: states sum to ${fmt0(pySum(sta))}, regions ${fmt0(pySum(reg))}`);
    }
  }
  if (!out.some((x) => x.row_type === "state")) throw new LayoutError(`FY ${fy}: no state rows`);
  return [out, notes];
}

// ---------------------------------------------------------------------- WIC agency monthly (wicagencies<FY>ytd.xlsx)
export function wicSheetKey(name: string, sheets: Record<string, any>): string | null {
  for (const [k, d] of Object.entries(sheets)) if (new RegExp(d.sheet, "i").test(name)) return k;
  return null;
}

export function parseWicSheet(key: string, d: any, rows: Grid, hidden: Set<number>, fy: number, areas: Areas): [Row[], string[]] {
  const title = titleOf(rows);
  const top = rows.slice(0, 4).flatMap((r) => r.filter((x) => x).map(norm)).join(" ");
  if (!new RegExp(`FISCAL YEAR ${fy}\\b`, "i").test(top)) {
    throw new LayoutError(`${key}: the sheet is not fiscal year ${fy} (${pyRepr(top.slice(0, 80))})`);
  }
  const asof = asOf(rows);
  const pre = /all data are preliminary/i.test(rows.slice(-8).flatMap((r) => r.filter((x) => x).map(norm)).join(" "))
    ? "preliminary" : "";
  const h = header(rows, "state agency");
  const head = rows[h];
  const months: [number, [number, number]][] = [];
  let total: [number, string] | null = null;
  for (let j = 1; j < head.length; j++) {
    const x = head[j];
    if (hidden.has(j) || !norm(x)) continue;
    if (/^(average|cumulative)/i.test(norm(x))) {
      total = [j, norm(x)];
      continue;
    }
    const ym = excelMonth(x);
    if (!ym) throw new LayoutError(`${key}: header cell ${pyRepr(norm(x))} is neither a month nor the year column`);
    months.push([j, ym]);
  }
  const want: [number, number][] = [[fy - 1, 10], [fy - 1, 11], [fy - 1, 12]];
  for (let m = 1; m < 10; m++) want.push([fy, m]);
  if (months.length > want.length || months.some(([, ym], i) => !ymEq(ym, want[i]))) {
    throw new LayoutError(`${key}: month columns ${"[" + months.map(([, ym]) => `(${ym[0]}, ${ym[1]})`).join(", ") + "]"} ` +
      `are not October ${fy - 1} onward`);
  }
  if (total === null) throw new LayoutError(`${key}: no average or cumulative column`);
  checkColumns(rows, h + 1, hidden, new Set([...months.map(([j]) => j), total[0]]), key);
  const out: Row[] = [], notes: string[] = [], agencies: [string, Cell[]][] = [];
  const regionNames = new Set(Object.values(REGIONS));
  for (const r of rows.slice(h + 1)) {
    const f = r.length && r[0] ? norm(r[0]) : "";
    if (!f || !r.slice(1).some((x) => norm(x))) continue;
    const m = /^(.+), ([A-Z]{2})$/.exec(f);
    let rt: string, st: string, ab: string, ag: string;
    if (f.toUpperCase() === "TOTAL") [rt, st, ab, ag] = ["total", "Total", "", ""];
    else if (regionNames.has(f.endsWith(" Region") ? f.slice(0, -" Region".length) : f)) [rt, st, ab, ag] = ["region", f, "", ""];
    else if (m && areas.code(m[2])) {
      const c = areas.code(m[2])!;
      [rt, st, ab, ag] = ["tribal_org", areas.name.get(c)!, c, m[1]];
    } else {
      [rt, st, ab] = areas.classify(f);
      [rt, ag] = rt === "state" ? ["state_agency", ""] : [rt, ""];
    }
    for (const [j, ym] of months) {
      out.push(mkRow("wic_agency_monthly", title, asof, st, ab, ag, rt, `${ym[0]}-${pad2(ym[1])}`, "month", fy, key,
        d.unit, at(r, j), pre));
    }
    out.push(mkRow("wic_agency_monthly", title, asof, st, ab, ag, rt, `FY ${fy}`, "fiscal_year", fy, key,
      d.unit + (" (" + total[1].split(":")[0].toLowerCase() + ")"), at(r, total[0]), pre));
    agencies.push([rt, r]);
  }
  // agencies since the last region add up to that region; regions add up to TOTAL
  if (!key.includes("avg")) {
    for (const [j] of [...months, [total[0], null] as const]) {
      let run = 0.0, regions = 0.0;
      for (const [rt, r] of agencies) {
        const s = cell(at(r, j))[1];
        const v = s ? Number(s) : 0.0;
        if (rt === "region") {
          if (Math.abs(run - v) > Math.max(2.0, 0.0005 * Math.abs(v))) {
            notes.push(`wic_agency_monthly FY ${fy} ${key} ${norm(r[0])} column ${j + 1}: agencies sum to ${fmt0(run)}, region ${fmt0(v)}`);
          }
          [regions, run] = [regions + v, 0.0];
        } else if (rt === "total") {
          if (Math.abs(regions - v) > Math.max(2.0, 0.0005 * Math.abs(v))) {
            notes.push(`wic_agency_monthly FY ${fy} ${key} column ${j + 1}: regions sum to ${fmt0(regions)}, TOTAL ${fmt0(v)}`);
          }
        } else run += v;
      }
    }
  }
  return [out, [...asofNotes(`wic_agency_monthly FY ${fy} ${key}`, out), ...notes]];
}
