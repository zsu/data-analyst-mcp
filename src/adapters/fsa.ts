/**
 * Federal Student Aid Data Center library workbooks (.xls) as tidy rows.
 *
 * The Data Center pages (studentaid.gov/data-center) are an Angular app with no scrapable links, but the library
 * files have fixed names (portfolio reports, refreshed in place) or names built from the award year and quarter
 * (Title IV volume by school: dl-dashboard-ay2025-2026-q4.xls, grants-ay24-25-q4.xls; verified for 2018-19 through
 * 2025-26 in 2026-10). Only the .xls files exist (the .xlsx names return 404).
 *
 * Every workbook has title rows, a two-row header and notes under the table:
 *   row: title ("Federal Student Aid Portfolio Summary"), source, "Data as of ..." lines
 *   group row: one label per block of columns (Direct Loans, In-School, 25 to 34, DL SUBSIDIZED, ...)
 *   measure row: Federal Fiscal Year | (quarter) | Dollars Outstanding (in billions) | Recipients (in millions) ...
 *                or OPE ID | School | State | Zip Code | School Type | Recipients | # of Loans Originated ...
 *   data rows, then footnotes.
 * The endpoints read each sheet from its first row ("header_row": 1), so normalize sees the whole sheet. It finds
 * the measure row by its first cell (a layout change fails loudly instead of shifting columns), pairs each column
 * with its group, and returns one row per period (or school) and group, the measures as columns named from the
 * header with the unit (dollars_outstanding_billions, recipients_millions, loans_originated_dollars).
 * Footnote marks (Total1, Recipients3, Cumulative in Default*) are dropped from labels; the published "-" and
 * NA** cells are empty (endpoints.json "missing"). School rows where every measure of a program is empty (the
 * file shows "-": no activity) are left out.
 */
import { DataError } from "../core/http.js";
import type { Adapter, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyRepr, pyStrip, squash } from "./_omb_util.js";

const FIRST_AY = 2018; // earliest award year whose volume files carry these names (verified 2026-10)
const QEND: Record<string, [number, number, number]> = { Q1: [-1, 12, 31], Q2: [0, 3, 31], Q3: [0, 6, 30], Q4: [0, 9, 30] };

const err = (msg: string) => new DataError(msg, "api");

/** str(v) as Python writes the values a spec carries. */
function pyS(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

// ---------------------------------------------------------------------- request parameters
function awardYear(v: unknown): [number, number] | null {
  const m = /^\s*(\d{4})\s*[-/]\s*(\d{2}|\d{4})\s*$/.exec(v ? pyS(v) : "");
  if (!m) return null;
  const a = Number(m[1]);
  let b = Number(m[2]);
  b = b > 99 ? b : Math.floor(a / 100) * 100 + b;
  return b === a + 1 ? [a, b] : null;
}

function quarter(v: unknown): number | null {
  const m = /^\s*[qQ]?([1-4])\s*$/.exec(v !== null && v !== undefined ? pyS(v) : "");
  return m ? Number(m[1]) : null;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    if (!["dl_volume_by_school", "grant_volume_by_school"].includes(r.endpoint || "")) continue;
    const p: Record<string, any> = r.params || {};
    const n = pyRepr(r.name ?? null);
    const has = (k: string) => p[k] !== undefined && p[k] !== null;
    const ay = awardYear(p.award_year);
    if (has("award_year") && !ay) {
      probs.push(`request ${n}: award_year ${pyRepr(p.award_year)}: write it as 2025-26 ` +
        "(July 1, 2025 - June 30, 2026); a bare year is ambiguous");
    } else if (ay && ay[0] < FIRST_AY) {
      probs.push(`request ${n}: award_year ${pyS(p.award_year)}: the volume-by-school files under ` +
        `these names start with ${FIRST_AY}-${String((FIRST_AY + 1) % 100).padStart(2, "0")}; older years are on the Data ` +
        "Center page (manual download)");
    }
    if (has("quarter") && !quarter(p.quarter)) {
      probs.push(`request ${n}: quarter ${pyRepr(p.quarter)} must be 1-4 (award-year quarter)`);
    }
  }
  return probs;
}

function beforeRequest(_req: SpecRequest, ep: any, params: Record<string, unknown>): Record<string, unknown> {
  const p: string = ep.path || "";
  if (!p.includes("{ay_long}") && !p.includes("{ay_short}")) return params;
  const ay = awardYear(params.award_year), q = quarter(params.quarter);
  if (!ay || !q) return params; // checkSpec has said why
  const two = (x: number) => String(x % 100).padStart(2, "0");
  const names: Record<string, unknown> = { ay_long: `${ay[0]}-${ay[1]}`, ay_short: `${two(ay[0])}-${two(ay[1])}`, q };
  // only the placeholders this path has: any other key would be sent as a query parameter
  return { ...params, ...Object.fromEntries(Object.entries(names).filter(([k]) => p.includes(`{${k}}`))) };
}

// ---------------------------------------------------------------------- labels
const text = (v: unknown) => squash(v !== null && v !== undefined ? pyS(v) : "");

/** A group label without footnote marks: 'Total1' -> 'Total', 'Cumulative in Default*' -> 'Cumulative in Default'. */
export function label(v: unknown): string {
  const s = pyStrip(text(v).replace(/\*+$/, ""));
  return pyStrip(s.replace(/(?<=[a-z])\d$/, ""));
}

/** 'Dollars Outstanding (in billions)' -> dollars_outstanding_billions; '# of Loans Originated' ->
 * loans_originated_count; '$ of Disbursements' -> disbursements_dollars; 'Sum of Recipients' -> recipients. */
export function measure(v: unknown): string {
  let s = text(v).replace(/(?<=[A-Za-z])\d+\b/g, ""); // footnote numbers: Recipients3
  let unit = "";
  const m = /\(\s*in\s+(billions|millions|thousands)\s*\)/i.exec(s);
  if (m) {
    unit = m[1].toLowerCase();
    s = s.slice(0, m.index) + s.slice(m.index + m[0].length);
  }
  s = pyStrip(s).replace(/^(sum of|ytd)\s+/i, "");
  let suffix = "";
  if (s.startsWith("#")) {
    s = s.replace(/^#\s*(of\s+)?/, "");
    suffix = "count";
  } else if (s.startsWith("$")) {
    s = s.replace(/^\$\s*(of\s+)?/, "");
    suffix = "dollars";
  } else if (s.toLowerCase() === "disbursements") suffix = "dollars"; // grant files: "Sum of Disbursements" is dollars
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return [slug, suffix, unit].filter(Boolean).join("_");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const FULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const D = "(3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])", Y = "(\\d{4})", M = "(1[0-2]|0[1-9]|[1-9])";

function iso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** datetime.strptime with "%b. %d, %Y", "%b %d, %Y", "%B %d, %Y", "%m/%d/%Y" (the first that fits), as ISO. */
function dateOf(t0: string): string {
  const t = pyStrip(t0).replace(/\.+$/, "");
  const tries: [RegExp, (m: RegExpExecArray) => string | null][] = [
    [new RegExp(`^(${MONTHS.join("|")})\\.\\s+${D},\\s+${Y}$`, "i"), (m) => iso(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2])],
    [new RegExp(`^(${MONTHS.join("|")})\\s+${D},\\s+${Y}$`, "i"), (m) => iso(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2])],
    [new RegExp(`^(${FULL.join("|")})\\s+${D},\\s+${Y}$`, "i"), (m) => iso(+m[3], FULL.indexOf(m[1].toLowerCase()) + 1, +m[2])],
    [new RegExp(`^${M}/${D}/${Y}$`, "i"), (m) => iso(+m[3], +m[1], +m[2])],
  ];
  for (const [re, f] of tries) {
    const m = re.exec(t);
    const r = m && f(m);
    if (r) return r;
  }
  return pyStrip(t0);
}

// ---------------------------------------------------------------------- the sheet
type G = string[][];

/** The sheet back as rows of cells: the header-row names (row 1) then each record's values, by position. */
function gridOf(rows: Row[]): G {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), keys.push(k));
  const head = keys.map((k) => (/^col\d+$/.test(k) ? "" : k));
  return [head, ...rows.map((r) => keys.map((k) => text(k in r ? r[k] : "")))];
}

function find(grid: G, pattern: RegExp, what: string, hint: string): number {
  const i = grid.findIndex((row) => row.length && pattern.test(row[0] || ""));
  if (i >= 0) return i;
  throw err(`the workbook layout changed: no ${what} header row found (${hint}); open the file, check the ` +
    "layout, and report it");
}

/** [column, group, measure] for each measure column at or after `start`; groups fill right. */
function groups(groupRow: string[], labelRow: string[], start: number): [number, string, string][] {
  const out: [number, string, string][] = [];
  let cur = "";
  for (let j = start; j < labelRow.length; j++) {
    const g = j < groupRow.length ? label(groupRow[j]) : "";
    cur = g || cur;
    if (labelRow[j] && cur) out.push([j, cur, measure(labelRow[j])]);
  }
  return out;
}

function periodEnd(fy: number, q: string): string {
  if (!q) return iso(fy, 9, 30)!;
  const [dy, m, d] = QEND[q];
  return iso(fy + dy, m, d)!;
}

const at = (row: string[], j: number) => (j < row.length ? row[j] : "");

function byGroup(cols: [number, string, string][], row: string[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [j, g, m] of cols) {
    if (!out.has(g)) out.set(g, new Map());
    out.get(g)!.set(m, at(row, j));
  }
  return out;
}

function portfolio(grid: G, hint: string): Row[] {
  const title = grid.length && grid[0].length ? grid[0][0] : "";
  const li = find(grid, /^Federal Fiscal Year/i, "'Federal Fiscal Year'", hint);
  if (li === 0) throw err(`the workbook layout changed: no group row above the header (${hint})`);
  const cols = groups(grid[li - 1], grid[li], 2);
  if (!cols.length) throw err(`the workbook layout changed: no measure columns under the group row (${hint})`);
  const out: Row[] = [];
  let fy: number | null = null;
  for (const row of grid.slice(li + 1)) {
    const y = at(row, 0);
    let q = at(row, 1);
    if (/^\d{4}$/.test(y)) fy = Number(y);
    else if (y) continue; // a note
    q = q.toUpperCase();
    if (fy === null || (q && !(q in QEND)) || (!q && !y)) continue;
    for (const [g, vals] of byGroup(cols, row)) {
      if (![...vals.values()].some((v) => v !== "")) continue;
      out.push({ report: title, fiscal_year: String(fy), quarter: q, period_end: periodEnd(fy, q), category: g,
        ...Object.fromEntries(vals) });
    }
  }
  return out;
}

function asOf(grid: G, upto: number): string {
  for (const row of grid.slice(0, upto)) {
    const m = /^\s*Data as of\s+(.+)/i.exec(row[0] || "");
    if (m) return dateOf(m[1]);
  }
  return "";
}

function snapshot(grid: G, hint: string): Row[] {
  const title = grid.length && grid[0].length ? grid[0][0] : "";
  const li = find(grid, /^Location\s*$/i, "'Location'", hint);
  const names = ["location", ...grid[li].slice(1).filter(Boolean).map(measure)];
  const asof = asOf(grid, li);
  const out: Row[] = [];
  for (const row of grid.slice(li + 1)) {
    if (!row.length || !row[0] || row[0].startsWith("*") || !row.slice(1, names.length).some((v) => v !== "")) continue;
    const rec: Row = { report: title, as_of: asof };
    names.slice(0, Math.min(names.length, row.length)).forEach((n, i) => (rec[n] = row[i]));
    out.push(rec);
  }
  return out;
}

function wanted(params: Record<string, any>): (rec: Record<string, string>) => boolean {
  const st = params.state;
  const list: unknown[] = typeof st === "string" ? [st] : Array.isArray(st) ? st : st ? [st] : [];
  const states = new Set(list.map((s) => pyStrip(String(s)).toUpperCase()).filter((s, i) => pyStrip(String(list[i]))));
  const school = pyStrip(String(params.school || "")).toLowerCase();
  return (rec) => (!states.size || states.has((rec.state ?? "").toUpperCase())) &&
    (!school || (rec.school ?? "").toLowerCase().includes(school));
}

function school(grid: G, hint: string, params: Record<string, any>): Row[] {
  const title = grid.length && grid[0].length ? grid[0][0] : "";
  const li = find(grid, /^OPE ID/i, "'OPE ID'", hint);
  const groupRow = li ? grid[li - 1] : [], labelRow = grid[li];
  let first: number | null = null;
  for (let j = 0; j < labelRow.length; j++) {
    if (j < groupRow.length && label(groupRow[j])) {
      first = j;
      break;
    }
  }
  if (first === null) throw err(`the workbook layout changed: no program row above the header (${hint})`);
  const ids: [number, string][] = [];
  for (let j = 0; j < first; j++) if (labelRow[j]) ids.push([j, measure(labelRow[j])]);
  const cols = groups(groupRow, labelRow, first);
  const m = /^(\d{4})-(\d{4})/.exec(title);
  const ay = m ? `${m[1]}-${m[2].slice(2)}` : "";
  let activity = "", start = "", end = "";
  for (const row of grid.slice(0, li)) {
    const t = row[0] || "";
    if (t.includes("Quarterly Activity")) {
      activity = "quarter";
      const d = t.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
      [start, end] = d.length === 2 ? [dateOf(d[0]), dateOf(d[1])] : ["", ""];
    } else if (t.includes("Cumulative")) {
      activity = "award year to date";
      const d = t.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
      end = d.length ? dateOf(d[d.length - 1]) : "";
      start = m ? `${m[1]}-07-01` : "";
    }
  }
  const asof = asOf(grid, li);
  const keep = wanted(params);
  const out: Row[] = [];
  for (const row of grid.slice(li + 1)) {
    if (!row.length || !row[0] || !row.slice(first).some((v) => v !== "")) continue;
    const rec: Record<string, string> = {};
    for (const [j, name] of ids) rec[name] = at(row, j);
    if (!keep(rec)) continue;
    for (const [g, vals] of byGroup(cols, row)) {
      if ([...vals.values()].some((v) => v !== "")) {
        out.push({ award_year: ay, activity, period_start: start, period_end: end, as_of: asof, ...rec, program: g,
          ...Object.fromEntries(vals) });
      }
    }
  }
  return out;
}

export function normalize(req: SpecRequest, ep: any, rows: Row[]): Row[] {
  if (!rows.length) return rows;
  const layout = ep.layout;
  if (!["portfolio", "snapshot", "school"].includes(layout)) return rows;
  const grid = gridOf(rows);
  const hint = `${ep.path ?? ""}, sheet ${(req.params || {}).sheet || (ep.sheet ?? 1)}`;
  if (layout === "portfolio") return portfolio(grid, hint);
  if (layout === "snapshot") return snapshot(grid, hint);
  return school(grid, hint, req.params || {});
}

function requestNote(req: SpecRequest, ep: any, params: Record<string, unknown>): string | null {
  if (ep.layout === "school") {
    return `${req.name}: award-year quarter ${pyS(params.quarter)} of ${pyS(params.award_year)} ` +
      "(award years run July 1-June 30: quarter 1 = Jul-Sep, 4 = Apr-Jun); one row per school and " +
      "program with any activity; recipients are counted per program (do not add them across programs)";
  }
  if (ep.layout === "portfolio") {
    return `${req.name}: federal fiscal-year quarters (Q1 ends Dec 31 of the prior calendar year, Q4 ends ` +
      "Sep 30); dollars outstanding are principal plus interest in billions, recipients in millions";
  }
  return null;
}

const adapter: Adapter = { checkSpec, beforeRequest, normalize, requestNote };
export default adapter;
