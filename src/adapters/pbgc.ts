/**
 * pbgc adapter: PBGC Pension Insurance Data Tables (one workbook per edition, no API, no key).
 *
 * The index page https://www.pbgc.gov/about/reports/pension-insurance-data lists one row per edition ("2024
 * Pension Insurance Data Tables (1st Installment) (08/04/2026)") with a PDF and an Excel link. The file paths
 * follow no one pattern (verified 2026-10-30; 2011 is an .xls), so the Excel link is scraped from the page, never
 * built. A workbook holds one sheet per table: S-1 ... S-49 (single-employer program), M-1 ... M-21
 * (multiemployer program), plus "DATA BOOK LISTING" (the table titles), "Overview" and "GLANCE". An installment
 * edition holds only some tables; the listing still names them all.
 *
 * A sheet is read as published, with the same rules as the omb pack (_omb_grid.ts), without cutting leader dots.
 */
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { xlsSheets, xlsxSheets } from "../core/tabular.js";
import { parseGrid, txt, type Grid, type GridMeta } from "./_omb_grid.js";
import { comma, isDigits, pyInt, pyRepr, pyStrip, squash, toTable, unescapeHtml as unescape, urljoin, type ORow } from "./_omb_util.js";

const SITE = "https://www.pbgc.gov";
const INDEX = SITE + "/about/reports/pension-insurance-data";

type Sheets = Record<string, Grid>;
type Edition = { year: number; label: string; url: string; format: string };
const empty = (v: unknown) => v === null || v === undefined || v === "";

// ---------------------------------------------------------------------- the index page
/** One row per edition on the index page: year, label, url (the Excel link), format; newest first. */
export function editions(body: string): Edition[] {
  const out: Edition[] = [];
  for (const tr of body.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (!cells.length) continue;
    const label = squash(unescape(cells[0].replace(/<[^>]+>/g, " ")).replace(/\xa0/g, " "));
    const m = /^(\d{4})\b/.exec(label);
    const link = [...tr.matchAll(/href="([^"]+)"/gi)].map((x) => x[1]).find((h) => /\.xlsx?$/i.test(h.split("?")[0]));
    if (!m || !link) continue;
    const url = urljoin(INDEX, unescape(link));
    out.push({ year: Number(m[1]), label, url, format: url.split(".").pop()!.toLowerCase() });
  }
  // sorted(key=-year) is stable
  return out.map((e, i) => [e, i] as const).sort((a, b) => b[0].year - a[0].year || a[1] - b[1]).map(([e]) => e);
}

/** The index page and workbooks, fetched once per run. */
class Site {
  c: Client;
  private eds: Edition[] | null = null;
  private books = new Map<string, Sheets>();
  constructor(pack: Pack) {
    this.c = gr.clientFor(pack);
  }
  async editions(): Promise<Edition[]> {
    if (this.eds === null) {
      this.eds = editions((await this.c.get(INDEX)).text());
      if (!this.eds.length) {
        throw new DataError(`no Excel links found on ${INDEX} (the page layout changed?): open it in a browser ` +
          "and use the manual route", "api");
      }
    }
    return this.eds;
  }
  async edition(year: unknown): Promise<Edition> {
    const eds = await this.editions();
    if (empty(year)) return eds[0];
    const hit = eds.filter((e) => e.year === pyInt(year));
    if (!hit.length) {
      throw new DataError(`no ${year} edition of the Pension Insurance Data Tables on ${INDEX} (editions with an ` +
        `Excel file: ${eds.map((e) => String(e.year)).join(", ")})`, "not_found", 404);
    }
    return hit[0];
  }
  async book(ed: Edition): Promise<Sheets> {
    if (!this.books.has(ed.url)) this.books.set(ed.url, readBook((await this.c.get(ed.url)).body, ed.url));
    return this.books.get(ed.url)!;
  }
}

function readBook(body: Buffer, where: string): Sheets {
  if (body.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1"))) {
    const names: string[] = [];
    let ok = true;
    try {
      unzipSync(body, { filter: (f) => (names.push(f.name), false) });
    } catch {
      ok = false;
    }
    if (ok && names.includes("xl/workbook.xml")) return xlsxSheets(body);
  } else if (body.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return xlsSheets(body);
  }
  throw new DataError(`${where} is not an Excel workbook (an HTML page in its place?)`, "api");
}

// ---------------------------------------------------------------------- tables
/** "s1", "S1", "s-1", "s_1", "Table S-1" -> "S-1"; "glance" -> "GLANCE"... anything else as given. */
export function normTable(v: unknown): string {
  const s = pyStrip(v === null || v === undefined || v === "" || v === 0 || v === false ? "" : String(v));
  const m = /^(?:table\s*)?([SM])\s*[-_]?\s*(\d{1,2})$/i.exec(s);
  return m ? `${m[1].toUpperCase()}-${Number(m[2])}` : s;
}

type Listed = { table: string; title: string; program: string; section: string };

/** The DATA BOOK LISTING sheet(s): table, title, program, section; in workbook order. */
function listing(sheets: Sheets): Listed[] {
  const out: Listed[] = [];
  let program = "", section = "";
  for (const [name, grid] of Object.entries(sheets)) {
    if (!name.toUpperCase().includes("LISTING")) continue;
    for (const r of grid) {
      const cells = r.map(txt).filter(Boolean);
      if (!cells.length) continue;
      const t = cells.join(" "); // 2018 and earlier: "S-1" and the title in two cells
      const m = /^(?:Table\s+)?([SM])\s*-\s*(\d{1,2})\s+(.+)$/.exec(t);
      if (m) out.push({ table: `${m[1]}-${Number(m[2])}`, title: m[3].trim(), program, section });
      else if (/single-employer program/i.test(t)) program = "single-employer";
      else if (/multiemployer program/i.test(t)) program = "multiemployer";
      else if (cells.length === 1 && t.length < 90 && program) section = t;
    }
  }
  const seen = new Set<string>();
  return out.filter((x) => !seen.has(x.table) && (seen.add(x.table), true));
}

function findSheet(sheets: Sheets, table: unknown): string | null {
  const want = normTable(table);
  for (const name of Object.keys(sheets)) {
    if (normTable(name) === want || name.trim().toLowerCase() === want.toLowerCase()) return name;
  }
  return null;
}

async function dataTable(site: Site, params: Record<string, any>): Promise<[ORow[], GridMeta, Edition, string, Listed | undefined]> {
  const ed = await site.edition(params.year);
  const sheets = await site.book(ed);
  const want = normTable(params.table);
  const name = findSheet(sheets, want);
  const lst = new Map(listing(sheets).map((x) => [x.table, x]));
  if (name === null) {
    const tabs = Object.keys(sheets).filter((s) => /^[SM]-\d+$/.test(s.trim()));
    const listed = lst.get(want);
    const why = listed ? `it is listed ("${listed.title}") but not in this workbook: the edition "${ed.label}" holds ` +
      "only some tables; ask for the previous year's edition" : "no such table";
    throw new DataError(`table ${pyRepr(want)} is not a sheet of the ${ed.year} edition (${ed.url}): ${why}. Its ` +
      `table sheets: ${tabs.join(", ")}`, "not_found", 404);
  }
  const [rows, meta] = parseGrid(sheets[name], params.header_row, params.header_rows, { stripDots: false });
  return [rows, meta, ed, name, lst.get(normTable(name))];
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {}, n = pyRepr(r.name);
    if (!empty(p.year) && !/^(19|20)\d\d$/.test(String(p.year).trim())) probs.push(`request ${n}: year is the edition year, e.g. 2024`);
    for (const k of ["header_row", "header_rows"]) {
      if (!empty(p[k]) && !isDigits(p[k])) probs.push(`request ${n}: ${k} is a positive whole number`);
    }
    if (r.endpoint === "data_table" && !empty(p.table)) {
      const t = normTable(p.table);
      if (!(/^[SM]-\d{1,2}$/.test(t) || ["GLANCE", "OVERVIEW"].includes(t.toUpperCase()))) {
        probs.push(`request ${n}: table ${pyRepr(p.table)} is not a table name like "S-1" or "M-4" ` +
          "(single-employer S-, multiemployer M-)");
      }
    }
  }
  return probs;
}

const editionRow = (e: Edition): ORow => new Map<string, unknown>([["year", e.year], ["label", e.label], ["url", e.url], ["format", e.format]]);
const listedRow = (x: Listed, sheets: Sheets): ORow =>
  new Map<string, unknown>([...Object.entries(x), ["in_workbook", findSheet(sheets, x.table) ? "yes" : "no"]]);

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const site = new Site(pack);
  const tables: Record<string, ORow[]> = {};
  const notes: string[] = [];
  const cap = Number(pack.policy.limits.max_rows || 50000);
  for (const r of spec.requests) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const name = r.name, epn = r.endpoint;
    let rows: ORow[];
    try {
      if (epn === "editions") {
        rows = (await site.editions()).map(editionRow);
        notes.push(`${name}: editions listed on ${INDEX}`);
      } else if (epn === "table_list") {
        const ed = await site.edition(params.year);
        const sheets = await site.book(ed);
        rows = listing(sheets).map((x) => listedRow(x, sheets));
        notes.push(`${name}: tables listed in the ${ed.label} workbook (${ed.url}); in_workbook = no ` +
          "means the edition does not hold that sheet");
      } else {
        const [got, meta, ed, sheet, lst] = await dataTable(site, params);
        rows = got;
        const title = lst ? `Table ${sheet}: ${lst.title}` : meta.top.join(" | ") || `sheet ${sheet}`;
        const prog = lst?.program || (sheet.startsWith("S-") ? "single-employer" : sheet.startsWith("M-") ? "multiemployer" : "");
        const h = meta.header;
        notes.push(`${name}: ${title}` + (prog ? `, ${prog} program` : "") +
          `; ${ed.label} (${ed.url}, sheet ${pyRepr(sheet)}); header row` +
          (h && h[1] > h[0] ? `s ${h[0]}-${h[1]}` : ` ${h ? h[0] : "?"}`));
        if (meta.top.length && lst) notes.push(`${name}: rows above the header (title, units): ` + meta.top.join(" | ").slice(0, 300));
        if (meta.footer.length) notes.push(`${name}: source and notes: ` + meta.footer.join(" | ").slice(0, 1500));
      }
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      throw new DataError(`request ${pyRepr(name)} (${epn}): ${e.message}`, e.kind, e.status);
    }
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${pyRepr(name)}: no data rows under the detected header: set header_row (the 1-based ` +
        "row of the column names)", "bad_request");
    }
    const limit = Math.min(Number(r.max_rows || cap), cap);
    if (rows.length > limit) {
      notes.push(`${name}: stopped at ${comma(limit)} rows (max_rows) of ${comma(rows.length)}. Raise max_rows.`);
      rows = rows.slice(0, limit);
    }
    tables[name] = rows;
  }
  return [Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, toTable(v, "pbgc")])), notes];
}

// ---------------------------------------------------------------------- manual route
function manualItems(spec: Spec, pack: Pack): any[] {
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const name = r.name, epn = r.endpoint;
    if (epn === "editions") {
      items.push({ name: `${name}#1`, request: name, url: INDEX, filename: `${name}.html`, needs_key: false,
        method: "GET", body: null, note: "save the page (File > Save as, HTML only)" });
      continue;
    }
    const y = params.year;
    const what = !empty(y) ? `the ${y} edition's Excel file` : "the newest edition's Excel file";
    items.push({ name: `${name}#1`, request: name, url: INDEX, filename: `${name}.xlsx`, also_ext: [".xls"],
      needs_key: false, method: "GET", body: null,
      note: `open the page, click the Excel link of ${what} (row "<year> Pension Insurance Data ` +
        `Tables") and save it as ${name}.xlsx` + (epn === "data_table" ? `; the pack reads sheet ${normTable(params.table)}` : "") });
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, paths: string[]): Row[] {
  const [, params, probs] = gr.resolve(pack, req);
  if (probs.length) throw new DataError(probs.join("; "), "bad_request");
  const epn = req.endpoint;
  const rows: ORow[] = [];
  for (const p of paths) {
    const body = fs.readFileSync(p);
    if (epn === "editions") {
      rows.push(...editions(body.toString("utf8")).map(editionRow));
      continue;
    }
    const sheets = readBook(body, path.basename(p));
    if (epn === "table_list") {
      rows.push(...listing(sheets).map((x) => listedRow(x, sheets)));
      continue;
    }
    const name = findSheet(sheets, params.table);
    if (name === null) {
      throw new DataError(`${path.basename(p)} has no sheet ${pyRepr(normTable(params.table))} (sheets: ` +
        `${Object.keys(sheets).join(", ")})`, "bad_request");
    }
    rows.push(...parseGrid(sheets[name], params.header_row, params.header_rows, { stripDots: false })[0]);
  }
  // a FileTable when the columns are years (package.write takes either)
  return toTable(rows, "pbgc") as unknown as Row[];
}

const adapter: Adapter = { fetch, checkSpec, manualItems, parseUpload };
export default adapter;
