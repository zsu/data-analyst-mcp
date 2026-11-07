/**
 * omb adapter: the President's Budget data files that OMB publishes through GovInfo (no API, no key).
 *
 * GovInfo serves each budget volume as a package BUDGET-<FY>-<PKG> with stable URLs (verified 2026-10-30):
 *   https://www.govinfo.gov/content/pkg/BUDGET-<FY>-<PKG>/xls/BUDGET-<FY>-<PKG>-<granule>.xlsx   one file
 *   https://www.govinfo.gov/content/pkg/BUDGET-<FY>-<PKG>.zip                                    the package
 * A file that does not exist answers HTTP 302 to https://www.govinfo.gov/error, an HTML page with status 200, so
 * every body is checked: a workbook or CSV is read, an HTML page means "not there".
 *   - Historical Tables (PKG=TAB): Table s.t is granule TAB-<s+1>-<t> (Table 1.1 = TAB-2-1). Not every edition
 *     follows it (FY2026 publishes one workbook; FY2015 and earlier use other granule numbers and .xls files), so
 *     the granule is tried first and its title row must name the table; otherwise the package zip is read and the
 *     table found by its title.
 *   - Public Budget Database (PKG=DB): granule 1 budget authority, 2 outlays, 3 receipts (xlsx; older years such
 *     as FY2015 publish them as csv/BUDGET-<FY>-DB-<n>.csv only). FY2026 has no DB package on GovInfo.
 *   - Federal Credit Supplement (PKG=FCS): one workbook BUDGET-<FY>-FCS.xlsx with sheets Table1 ... Table10 (FY2024
 *     on); FY2018-FY2023 publish one granule per table, BUDGET-<FY>-FCS-<n>.xlsx.
 * A sheet is read as published (see _omb_grid.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { decodeText, xlsSheets, xlsxSheets } from "../core/tabular.js";
import { parseGrid, txt, type Grid, type GridMeta } from "./_omb_grid.js";
import { comma, isDigits, naturalCompare, pyInt, pyRepr, pyStrip, toTable, type ORow } from "./_omb_util.js";

const BASE = "https://www.govinfo.gov/content/pkg";
const DB_KINDS: Record<string, number> = { budget_authority: 1, outlays: 2, receipts: 3 };
const DB_UNITS = "thousands of dollars";
const FIRST_FY = 1996; // GovInfo's BUDGET collection starts with the FY1996 budget
const WH_HIST = "https://www.whitehouse.gov/omb/information-resources/budget/historical-tables/";
const WH_SUPP = "https://www.whitehouse.gov/omb/information-resources/budget/supplemental-materials/";

/** The edition (package) does not exist on GovInfo: the next older edition may be tried. */
class NoPackage extends DataError {
  constructor(msg: string) {
    super(msg, "not_found", 404);
  }
}

const empty = (v: unknown) => v === null || v === undefined || v === "";
type Sheets = Record<string, Grid>;

// ---------------------------------------------------------------------- reading published grids
function firstText(grid: Grid, rows = 4): string {
  for (const r of grid.slice(0, rows)) {
    for (const v of r) {
      const t = txt(v);
      if (t && t.toLowerCase() !== "return to table of contents") return t;
    }
  }
  return "";
}

function titlePat(table: string): RegExp {
  const [s, t] = table.split(".");
  return new RegExp(`^\\s*Table\\s+${Number(s)}\\.${Number(t)}(?![\\d.])`, "i");
}

/** [sheet name, grid] of the sheet whose title names Historical Table s.t, or [null, null]. */
function findTable(sheets: Sheets, table: string): [string | null, Grid | null] {
  const pat = titlePat(table);
  for (const [name, grid] of Object.entries(sheets)) if (pat.test(firstText(grid))) return [name, grid];
  return [null, null];
}

function titles(sheets: Sheets): string[] {
  const out: string[] = [];
  for (const g of Object.values(sheets)) {
    const m = /^\s*Table\s+(\d+\.\d+)/i.exec(firstText(g));
    if (m) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------- bodies
function zipNames(body: Uint8Array): string[] | null {
  const names: string[] = [];
  try {
    unzipSync(body, { filter: (f) => (names.push(f.name), false) });
  } catch {
    return null;
  }
  return names;
}

const XLS_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function kindOf(body: Buffer): string {
  if (body.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1"))) {
    const names = zipNames(body);
    if (names === null) return "other";
    return names.includes("xl/workbook.xml") ? "xlsx" : "zip";
  }
  if (body.subarray(0, 8).equals(XLS_MAGIC)) return "xls";
  const head = body.subarray(0, 400).toString("latin1").replace(/^[ \t\n\r\v\f]+/, "").toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<html")) return "html";
  return "text";
}

function sheetsOf(body: Uint8Array, kind: string): Sheets {
  if (kind === "xlsx") return xlsxSheets(body);
  if (kind === "xls") return xlsSheets(body);
  throw new DataError(`expected a workbook, got ${kind}`, "api");
}

function csvGrid(body: Buffer): Grid {
  const text = decodeText(body);
  return parse(text, { relax_column_count: true, relax_quotes: true, skip_empty_lines: false }) as string[][];
}

/** [body, kind] of a GovInfo file, or [null, "missing"] when GovInfo answers its error page or 404. */
async function get(c: Client, url: string): Promise<[Buffer | null, string]> {
  let body: Buffer;
  try {
    body = (await c.get(url)).body;
  } catch (e) {
    if (e instanceof DataError && e.kind === "not_found") return [null, "missing"];
    throw e;
  }
  const k = kindOf(body);
  return k === "html" ? [null, "missing"] : [body, k];
}

function* zipMembers(body: Uint8Array): Generator<[string, Uint8Array]> {
  const z = unzipSync(body);
  for (const n of Object.keys(z).sort(naturalCompare)) {
    const low = n.toLowerCase();
    if ((low.endsWith(".xlsx") || low.endsWith(".xls")) && !n.endsWith("/")) yield [n, z[n]];
  }
}

const memberKind = (member: string) => (member.toLowerCase().endsWith(".xls") ? "xls" : "xlsx");

// ---------------------------------------------------------------------- the three products
type Got = [Grid, string, string[]];

async function histTable(c: Client, fy: number, table: string): Promise<Got> {
  const [s, t] = table.split(".").map(Number);
  const url = `${BASE}/BUDGET-${fy}-TAB/xls/BUDGET-${fy}-TAB-${s + 1}-${t}.xlsx`;
  const notes: string[] = [];
  const [body, k] = await get(c, url);
  if (body !== null && (k === "xlsx" || k === "xls")) {
    const [, grid] = findTable(sheetsOf(body, k), table);
    if (grid !== null) return [grid, url, notes];
    notes.push(`${url} holds ${pyRepr(firstText(Object.values(sheetsOf(body, k))[0]).slice(0, 60))}, not Table ` +
      `${table}: the table was looked up by its title in the package zip`);
  }
  const zurl = `${BASE}/BUDGET-${fy}-TAB.zip`;
  const [zbody, zk] = await get(c, zurl);
  if (zbody === null || zk !== "zip") {
    throw new NoPackage(`GovInfo has no Historical Tables for the FY${fy} budget (BUDGET-${fy}-TAB): ${url} and ` +
      `${zurl} answer GovInfo's error page`);
  }
  const found: string[] = [];
  for (const [member, data] of zipMembers(zbody)) {
    const sh = sheetsOf(data, memberKind(member));
    const [name, grid] = findTable(sh, table);
    if (grid !== null) {
      const multi = Object.keys(sh).length > 1;
      if (body === null) {
        notes.push(`the FY${fy} edition has no file ${url.split("/").pop()} (GovInfo answers its error ` +
          `page): Table ${table} was read from ${member} in ${zurl}` + (multi ? `, sheet ${name}` : ""));
      }
      return [grid, `${zurl}#${member}` + (multi ? `!${name}` : ""), notes];
    }
    found.push(...titles(sh));
  }
  const key = (x: string) => x.split(".").map(Number);
  const have = [...new Set(found)].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return ka.length - kb.length;
  });
  throw new DataError(`Table ${table} is not in the FY${fy} Historical Tables (GovInfo package BUDGET-${fy}-TAB); ` +
    `its tables: ${have.join(", ") || "none found"}. Check the number against source.md (Table ` +
    "s.t, e.g. 1.1, 3.2, 8.5)", "not_found", 404);
}

async function budgetDb(c: Client, fy: number, kind: string): Promise<Got> {
  const n = DB_KINDS[kind];
  const tried: string[] = [];
  for (const [url, fmt] of [[`${BASE}/BUDGET-${fy}-DB/xls/BUDGET-${fy}-DB-${n}.xlsx`, "xlsx"],
    [`${BASE}/BUDGET-${fy}-DB/csv/BUDGET-${fy}-DB-${n}.csv`, "csv"]]) {
    const [body, k] = await get(c, url);
    tried.push(url);
    if (body === null) continue;
    if (fmt === "csv" && k === "text") return [csvGrid(body), url, [`FY${fy} publishes this file as CSV only (${url})`]];
    if (k === "xlsx" || k === "xls") return [Object.values(sheetsOf(body, k))[0], url, []];
  }
  throw new NoPackage(`GovInfo has no Public Budget Database ${kind} file for the FY${fy} budget (${tried.join(" and ")} ` +
    "answer GovInfo's error page; the FY2026 budget published no database there)");
}

function fcsN(table: unknown): number {
  const m = /^\s*(?:table\s*)?(\d{1,2})\s*$/i.exec(pyStrFor(table));
  if (!m) {
    throw new DataError(`credit_supplement table ${pyRepr(table)}: give the table number, e.g. 1 (Table 1)`, "bad_request");
  }
  return Number(m[1]);
}

/** str(v) as Python writes it for the values a spec carries. */
function pyStrFor(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

function fcsSheet(sheets: Sheets, n: number): [string | null, Grid | null] {
  for (const [name, grid] of Object.entries(sheets)) {
    if (new RegExp(`^table\\s*${n}$`, "i").test(name.trim())) return [name, grid];
  }
  const pat = new RegExp(`^\\s*Table\\s+${n}\\.`, "i");
  for (const [name, grid] of Object.entries(sheets)) if (pat.test(firstText(grid))) return [name, grid];
  return [null, null];
}

async function creditTable(c: Client, fy: number, table: unknown): Promise<Got> {
  const n = fcsN(table);
  const url = `${BASE}/BUDGET-${fy}-FCS/xls/BUDGET-${fy}-FCS.xlsx`;
  let [body, k] = await get(c, url);
  if (body !== null && (k === "xlsx" || k === "xls")) {
    const sh = sheetsOf(body, k);
    const [name, grid] = fcsSheet(sh, n);
    if (grid === null) {
      throw new DataError(`the FY${fy} Federal Credit Supplement has no Table ${n} (sheets: ${Object.keys(sh).join(", ")})`,
        "not_found", 404);
    }
    return [grid, `${url}!${name}`, []];
  }
  const url2 = `${BASE}/BUDGET-${fy}-FCS/xls/BUDGET-${fy}-FCS-${n}.xlsx`;
  [body, k] = await get(c, url2);
  if (body !== null && (k === "xlsx" || k === "xls")) {
    const sh = sheetsOf(body, k);
    let [, grid] = fcsSheet(sh, n);
    if (grid === null) grid = Object.values(sh)[0];
    return [grid, url2, [`FY${fy} publishes one file per credit supplement table (${url2})`]];
  }
  throw new NoPackage(`GovInfo has no Federal Credit Supplement Table ${n} for the FY${fy} budget (${url} and ${url2} ` +
    "answer GovInfo's error page)");
}

// ---------------------------------------------------------------------- spec handling
function fyCandidates(params: Record<string, unknown>): number[] {
  if (!empty(params.fy)) return [pyInt(params.fy)];
  const y = new Date().getFullYear();
  return [y + 1, y, y - 1]; // the budget for FY y+1 is released early in calendar year y
}

export function normTable(v: unknown): string {
  const m = /^\s*(?:table\s*)?(\d{1,2})\s*[.\-_ ]\s*(\d{1,2})\s*$/i.exec(pyStrFor(v));
  return m ? `${Number(m[1])}.${Number(m[2])}` : "";
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  const hi = new Date().getFullYear() + 1;
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {}, n = pyRepr(r.name);
    if (!empty(p.fy)) {
      try {
        const fy = pyInt(p.fy);
        if (!(FIRST_FY <= fy && fy <= hi)) {
          probs.push(`request ${n}: fy ${fy} is outside ${FIRST_FY}-${hi} (the budget's fiscal year, ` +
            "e.g. 2027 for the budget released in 2026)");
        }
      } catch {
        probs.push(`request ${n}: fy is a four-digit budget fiscal year, e.g. 2027`);
      }
    }
    for (const k of ["header_row", "header_rows"]) {
      if (!empty(p[k]) && !isDigits(pyStrFor(p[k]))) probs.push(`request ${n}: ${k} is a positive whole number`);
    }
    const ep = r.endpoint;
    if (ep === "historical_table" && !empty(p.table) && !normTable(p.table) && !pyStrFor(p.table).startsWith("table_")) {
      probs.push(`request ${n}: table ${pyRepr(p.table)} is not a Historical Table number like "1.1" or ` +
        '"8.5" (section.table)');
    }
    if (ep === "credit_supplement" && !empty(p.table)) {
      try {
        fcsN(p.table);
      } catch (e) {
        probs.push(`request ${n}: ${(e as Error).message}`);
      }
    }
  }
  return probs;
}

/** [grid, url, notes, fy, label] for one request, trying older editions when fy is not given. */
async function one(c: Client, epName: string, params: Record<string, any>): Promise<[Grid, string, string[], number, string]> {
  let last: DataError | null = null;
  for (const fy of fyCandidates(params)) {
    try {
      if (epName === "historical_table") {
        const [g, u, n] = await histTable(c, fy, normTable(params.table));
        return [g, u, n, fy, `Historical Table ${normTable(params.table)}`];
      }
      if (epName === "budget_database") {
        const [g, u, n] = await budgetDb(c, fy, params.kind);
        return [g, u, n, fy, `Public Budget Database, ${String(params.kind).replace(/_/g, " ")}`];
      }
      if (epName === "credit_supplement") {
        const [g, u, n] = await creditTable(c, fy, params.table);
        return [g, u, n, fy, `Federal Credit Supplement Table ${fcsN(params.table)}`];
      }
    } catch (e) {
      if (!(e instanceof NoPackage)) throw e;
      last = e;
      if (!empty(params.fy)) throw e;
    }
  }
  throw last ?? new DataError(`unknown endpoint ${pyRepr(epName)}`, "bad_request");
}

const UNIT_BLOCK = /^(in|as)\b.*\b(dollars|percent|percentages)\b.*:$/i;

/**
 * Tables 3.1 and 6.1 stack blocks in different units under label rows ("In millions of dollars:", "As
 * percentages of GDP:"), so "Total, Federal outlays" appears once per block: add `units_block` (the label of the
 * block a row is in) when a table has such label rows.
 */
function unitBlocks(rows: ORow[]): ORow[] {
  if (!rows.length) return rows;
  const first = rows[0].keys().next().value as string;
  const blank = (r: ORow) => ![...r].some(([k, v]) => k !== first && k !== "sheet_row" && v);
  const label = (r: ORow) => pyStrip(String(r.get(first)));
  if (!rows.some((r) => blank(r) && UNIT_BLOCK.test(label(r)))) return rows;
  let cur = "";
  return rows.map((r) => {
    if (blank(r) && UNIT_BLOCK.test(label(r))) cur = label(r).replace(/:+$/, "");
    const m: ORow = new Map([...r].filter(([k]) => k !== "sheet_row"));
    m.set("units_block", cur);
    m.set("sheet_row", r.get("sheet_row"));
    return m;
  });
}

function shape(epName: string, grid: Grid, params: Record<string, unknown>): [ORow[], GridMeta] {
  const [rows, meta] = parseGrid(grid, params.header_row, params.header_rows,
    { stripDots: epName !== "budget_database", tocCells: true });
  return [epName === "historical_table" ? unitBlocks(rows) : rows, meta];
}

function notesFor(name: string, epName: string, label: string, fy: number, url: string, meta: GridMeta, rows: ORow[]): string[] {
  const out: string[] = [];
  const top = meta.top.join(" | ").slice(0, 400);
  const head = meta.header;
  const span = !!head && head[1] > head[0];
  out.push(`${name}: ${label}, FY${fy} budget (${url})` + (top ? `: ${top}` : "") +
    (head ? `; header row${span ? "s" : ""} ${head[0]}${span ? "-" + head[1] : ""} of the sheet` : ""));
  if (epName === "budget_database") {
    out.push(`${name}: amounts are in ${DB_UNITS}; columns 1962 (1976 for budget authority) ... are fiscal ` +
      `years and TQ is the 1976 transition quarter; years after FY${fy - 2} are estimates (FY${fy - 1} ` +
      `the current-year estimate, FY${fy} on the President's proposals)`);
  }
  if (epName === "historical_table" && rows.length) {
    const first = rows[0].keys().next().value as string;
    const estRows = rows.filter((r) => String(r.get(first) ?? "").toLowerCase().includes("estimate")).map((r) => String(r.get(first)));
    const estCols = [...rows[0].keys()].filter((k) => k.toLowerCase().includes("estimate"));
    if (estRows.length || estCols.length) {
      const e = estRows.length ? estRows : estCols;
      out.push(`${name}: ${e.length} ${estRows.length ? "rows" : "columns"} marked estimate (${e[0]} to ${e[e.length - 1]}): ` +
        "projections of the President's budget, not actual results; the budget year and later are proposals");
    } else out.push(`${name}: no estimate years in this table (this edition's table ends with actual years)`);
  }
  if (meta.footer.length) out.push(`${name}: footnotes: ` + meta.footer.join(" | ").slice(0, 1200));
  return out;
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const c = gr.clientFor(pack);
  const tables: Record<string, ORow[]> = {};
  const notes: string[] = [];
  const cap = Number(pack.policy.limits.max_rows || 50000);
  for (const r of spec.requests) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    let epName = r.endpoint || "";
    if (!epName) epName = pack.endpoints?.catalog?.[r.dataset ?? ""]?.endpoint ?? "";
    let got: [Grid, string, string[], number, string];
    try {
      got = await one(c, epName, params);
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      throw new DataError(`request ${pyRepr(r.name)} (${epName}): ${e.message}`, e.kind, e.status);
    }
    const [grid, url, extra, fy, label] = got;
    let [rows, meta] = shape(epName, grid, params);
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${pyRepr(r.name)}: ${label} (FY${fy}, ${url}) has no data rows under the detected ` +
        "header: set header_row (the 1-based row of the column names)", "bad_request");
    }
    const limit = Math.min(Number(r.max_rows || cap), cap);
    if (rows.length > limit) {
      notes.push(`${r.name}: stopped at ${comma(limit)} rows (max_rows) of ${comma(rows.length)}. Raise max_rows.`);
      rows = rows.slice(0, limit);
    }
    notes.push(...extra.map((x) => `${r.name}: ${x}`), ...notesFor(r.name, epName, label, fy, url, meta, rows));
    tables[r.name] = rows;
  }
  return [Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, toTable(v, "omb")])), notes];
}

// ---------------------------------------------------------------------- manual route
function manualItems(spec: Spec, pack: Pack): any[] {
  const items: any[] = [];
  const y = new Date().getFullYear();
  for (const r of spec.requests || []) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const name = r.name, epn = r.endpoint;
    const fy = !empty(params.fy) ? pyInt(params.fy) : y + 1;
    let url: string, note: string, ext: string[];
    if (epn === "historical_table") {
      const t = normTable(params.table);
      if (!t) continue;
      const [s, tt] = t.split(".");
      url = `${BASE}/BUDGET-${fy}-TAB/xls/BUDGET-${fy}-TAB-${Number(s) + 1}-${tt}.xlsx`;
      note = `Table ${t} of the FY${fy} Historical Tables. If GovInfo shows an error page (some editions, e.g. ` +
        `FY2026, have one workbook instead), download ${BASE}/BUDGET-${fy}-TAB.zip and upload it as ` +
        `${name}.zip, or save hist${String(Number(s)).padStart(2, "0")}z${tt}_fy${fy}.xlsx from ${WH_HIST} as ${name}.xlsx`;
      ext = [".zip", ".xls"];
    } else if (epn === "budget_database") {
      const n = DB_KINDS[String(params.kind)] ?? 2;
      url = `${BASE}/BUDGET-${fy}-DB/xls/BUDGET-${fy}-DB-${n}.xlsx`;
      note = `Public Budget Database (${pyStrFor(params.kind)}), FY${fy}. Older editions publish CSV: ` +
        `${BASE}/BUDGET-${fy}-DB/csv/BUDGET-${fy}-DB-${n}.csv (upload as ${name}.csv). The same file is on ` +
        `${WH_SUPP} (budauth/outlays/receipts_fy${fy}.xlsx)`;
      ext = [".csv"];
    } else {
      let n: number;
      try {
        n = fcsN(params.table);
      } catch {
        continue;
      }
      url = `${BASE}/BUDGET-${fy}-FCS/xls/BUDGET-${fy}-FCS.xlsx`;
      note = `Federal Credit Supplement, FY${fy} (the pack reads Table ${n}). FY2018-FY2023: ` +
        `${BASE}/BUDGET-${fy}-FCS/xls/BUDGET-${fy}-FCS-${n}.xlsx. Also on ${WH_SUPP} (cr_supp_fy${fy}.xlsx)`;
      ext = [];
    }
    items.push({ name: `${name}#1`, request: name, url, filename: `${name}.xlsx`, also_ext: ext, needs_key: false,
      method: "GET", body: null, note });
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, paths: string[]): Row[] {
  const [, params, probs] = gr.resolve(pack, req);
  if (probs.length) throw new DataError(probs.join("; "), "bad_request");
  const epn = req.endpoint || "";
  const rows: ORow[] = [];
  for (const p of paths) {
    const body = fs.readFileSync(p);
    const k = kindOf(body);
    const base = path.basename(p);
    let grid: Grid | null = null;
    if (epn === "historical_table") {
      const t = normTable(params.table);
      if (k === "xlsx" || k === "xls") grid = findTable(sheetsOf(body, k), t)[1];
      else if (k === "zip") {
        for (const [member, data] of zipMembers(body)) {
          grid = findTable(sheetsOf(data, memberKind(member)), t)[1];
          if (grid !== null) break;
        }
      }
      if (grid === null) {
        throw new DataError(`${base}: no sheet titled "Table ${t} - ..." (upload the Historical Tables file ` +
          "for that table, or the package zip)", "bad_request");
      }
    } else if (epn === "budget_database") {
      if (k === "text") grid = csvGrid(body);
      else if (k === "xlsx" || k === "xls") grid = Object.values(sheetsOf(body, k))[0];
      else throw new DataError(`${base}: not a Public Budget Database .xlsx or .csv file`, "bad_request");
    } else {
      if (k !== "xlsx" && k !== "xls") throw new DataError(`${base}: not a Federal Credit Supplement workbook`, "bad_request");
      const sh = sheetsOf(body, k);
      const n = fcsN(params.table);
      grid = fcsSheet(sh, n)[1];
      if (grid === null && Object.keys(sh).length === 1) grid = Object.values(sh)[0];
      if (grid === null) throw new DataError(`${base}: no sheet Table${n} (sheets: ${Object.keys(sh).join(", ")})`, "bad_request");
    }
    rows.push(...shape(epn, grid, params)[0]);
  }
  // a FileTable when the columns are years (package.write takes either)
  return toTable(rows, "omb") as unknown as Row[];
}

export const _test = { parseGrid, normTable, kindOf, findTable };

const adapter: Adapter = { fetch, checkSpec, manualItems, parseUpload };
export default adapter;
