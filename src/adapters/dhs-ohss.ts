/**
 * dhs-ohss adapter: DHS Office of Homeland Security Statistics published workbooks (no API, no key).
 *
 * ohss.dhs.gov posts the Yearbook of Immigration Statistics as one page per fiscal year
 * (https://ohss.dhs.gov/topics/immigration/yearbook/<YYYY>) that links one workbook per topic; the file names carry
 * upload dates and suffixes, so they are scraped from the page, never built (verified 2026-10-30). FY2022 on: one
 * .xlsx per topic, one sheet per table ("Table 6", "LPRSuppTable 1") after a "TOC" sheet. FY2015-2021: a .zip per
 * topic holding one .xlsx per table (fy2019_table6.xlsx; sheet "Table 7D"). The quarterly Legal Immigration and
 * Adjustment of Status Report has one .xlsx per fiscal year on its own page.
 *
 * A sheet is read as published:
 *   - title rows (one filled cell) are skipped; the header is the first row with two or more filled cells (or
 *     header_row). A second header row (first cell empty, labels only, under a header with gaps) is joined to it:
 *     "Adjustments of status Quarter 1".
 *   - section label rows (one filled cell, upper case: TOTAL, ADJUSTMENTS OF STATUS, REGION ...) are not rows: their
 *     label goes in a first column `section`.
 *   - the footer (the "Notes:"/"Source:" lines and the footnote lines just above them) is cut from the rows and
 *     written into the notes.
 *   - cells keep their published text: codes (D, X, NA, -) are not blanked, footnote markers stay in labels.
 *
 * manualItems is synchronous here, so it cannot read the year page: it links the workbook a fetch in this process
 * already found on the page (kept for an hour), and otherwise the page itself with the link text to look for.
 */
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { xlsxSheets } from "../core/tabular.js";
import { naturalCompare, pyInt, pyRepr, pyStrip, squash, toTable, unescapeHtml, urljoin, type ORow } from "./_omb_util.js";

const BASE = "https://ohss.dhs.gov";
const INDEX = "/topics/immigration/yearbook";
const LIR_PAGE = "/topics/immigration/legal-immigration-and-adjustment-status-report";
const FIRST_YEAR = 1996; // year pages exist from 1996; data files (xlsx/zip) from FY2015 (verified 2026-10-30)
const FILE_YEARS = 2015;
const DEFAULT_TRIES = 4; // newest year pages tried when fiscal_year is not given

// topic -> pattern on the link text (lower case, spaces collapsed); fallback: the topic whose workbook holds the
// same tables in years without a separate file (FY2022 on, the supplementary tables are in the main workbook)
const TOPICS: Record<string, [RegExp, string | null]> = {
  lpr: [/lawful permanent residents? \d{4} data tables/, null],
  lpr_supplementary: [/lawful permanent residents? \d{4} supplementary/, "lpr"],
  lpr_expanded: [/expanded \d{4} yearbook tables 8-11/, null],
  refugees: [/\brefugees (and asylees )?\d{4} data tables/, null],
  asylees: [/\b(refugees and )?asylees \d{4} data tables/, null],
  refugees_asylees: [/\b(refugees and asylees|refugees|asylees) \d{4} data tables/, null],
  naturalizations: [/naturalizations \d{4} data tables/, null],
  naturalizations_supplementary: [/naturalizations \d{4} supplementary/, "naturalizations"],
  nonimmigrant: [/nonimmigrant admissions \d{4} data tables/, null],
  nonimmigrant_supplementary: [/nonimmigrant admissions \d{4} supplementary/, "nonimmigrant"],
  enforcement: [/enforcement actions \d{4} data tables/, null],
};
const TABLE_EPS = ["yearbook_table", "lir_table"];

// a footnote line: "1 Includes ...", "¹ Includes ...", "- Represents zero.", "X Not applicable.", "D Data withheld"
const FOOTNOTE = /^(\p{Nd}{1,2}|[¹²³⁰-⁹]{1,2}|[^\p{L}\p{N}_\s]|[A-Z]{1,2})\s+\S/u;
const FOOTER = /^\s*(notes?|sources?)\s*:/i;
const NUMERIC = /^-?[\d,]+(\.\d+)?$/;
const CODES = ["D", "X", "NA", "-"];

const empty = (v: unknown) => v === null || v === undefined || v === "";
type Cell = string | null | undefined;
type Grid = Cell[][];
type Sheets = Record<string, Grid>;
type FileLink = { title: string; url: string; format: string };
type YearFile = { fiscal_year: number; topic: string } & FileLink;
type LirFile = { fiscal_year: number | ""; through_quarter: string; title: string; url: string; format: string };

// ---------------------------------------------------------------------- pages and links
function text(s: string): string {
  return squash(unescapeHtml((s || "").replace(/<[^>]+>/g, " ")).replace(/\xa0/g, " "));
}

/** Data-file links (.xlsx / .zip) on an ohss.dhs.gov page, first occurrence of each URL, in page order. The href is
 * kept as published (some are percent-encoded twice: that is the real file name). */
export function pageLinks(body: string, pageUrl: string): FileLink[] {
  const out: FileLink[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/<a\s[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = unescapeHtml(m[1]), label = text(m[2]);
    if (!/\.(xlsx|zip)$/i.test(href.split("?")[0])) continue;
    const url = urljoin(pageUrl, href);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: label, url, format: url.slice(url.lastIndexOf(".") + 1).toLowerCase() });
  }
  return out;
}

function topicsOf(title: string): string[] {
  const t = title.toLowerCase();
  return Object.entries(TOPICS).filter(([, [pat]]) => pat.test(t)).map(([k]) => k);
}

/** Workbook links found by fetches in this process: [when, files] by year page (for manualItems). */
const FOUND = new Map<string, [number, FileLink[]]>();
const FOUND_TTL = 3600_000;

/** Pages fetched once per run. */
class Site {
  c: Client;
  pages = new Map<string, string>();
  constructor(pack: Pack) {
    this.c = gr.clientFor(pack);
  }
  async page(p: string): Promise<string> {
    if (!this.pages.has(p)) this.pages.set(p, (await this.c.get(p)).text());
    return this.pages.get(p)!;
  }
  async years(): Promise<number[]> {
    const ys = new Set([...(await this.page(INDEX)).matchAll(/\/topics\/immigration\/yearbook\/(\d{4})"/g)].map((m) => Number(m[1])));
    return [...ys].sort((a, b) => b - a);
  }
  async yearFiles(year: number): Promise<YearFile[]> {
    const p = `${INDEX}/${year}`;
    let body: string;
    try {
      body = await this.page(p);
    } catch (e) {
      if (e instanceof DataError && e.kind === "not_found") {
        throw new DataError(`no yearbook page for fiscal year ${year} (${BASE}${p} answered 404)`, "not_found");
      }
      throw e;
    }
    const links = pageLinks(body, BASE + p);
    FOUND.set(p, [Date.now(), links]);
    return links.map((f) => ({ fiscal_year: year, topic: topicsOf(f.title).join(", "), ...f }));
  }
  async lirFiles(): Promise<LirFile[]> {
    const links = pageLinks(await this.page(LIR_PAGE), BASE + LIR_PAGE);
    FOUND.set(LIR_PAGE, [Date.now(), links]);
    return links.map(lirFile);
  }
}

function lirFile(f: FileLink): LirFile {
  const fy = /FY ?(\d{4})/.exec(f.title);
  const q = [...f.url.slice(f.url.lastIndexOf("/") + 1).toLowerCase().matchAll(/q(\d)/g)].map((m) => m[1]);
  return { fiscal_year: fy ? Number(fy[1]) : "", through_quarter: q.length ? q.reduce((a, b) => (b > a ? b : a)) : "",
    title: f.title, url: f.url, format: f.format };
}

/** The topic's file among one year's files (falling back to the workbook that holds the same tables). */
function pick<F extends FileLink>(files: F[], topic: string, year: number): [F | null, string] {
  const [pat, fallback] = TOPICS[topic];
  let hits = files.filter((f) => pat.test(f.title.toLowerCase()));
  let note = "";
  if (!hits.length && fallback) {
    hits = files.filter((f) => TOPICS[fallback][0].test(f.title.toLowerCase()));
    note = hits.length ? `FY${year} has no separate ${topic} file; its tables are in the ${fallback} workbook ` +
      `(${hits[0].title})` : "";
  }
  if (hits.length > 1) {
    throw new DataError(`topic ${pyRepr(topic)} matches ${hits.length} FY${year} files: ` +
      hits.map((h) => `${h.title} (${h.url})`).join("; ") + ". Ask for one of: refugees, asylees", "bad_request");
  }
  return [hits.length ? hits[0] : null, note];
}

/** [file, fiscal year, notes] for a topic; without a year, the newest year page that posts the file. */
async function locate(site: Site, topic: string, year: unknown): Promise<[YearFile, number, string[]]> {
  const notes: string[] = [];
  if (!empty(year)) {
    const y = pyInt(year);
    const [f, n] = pick(await site.yearFiles(y), topic, y);
    if (!f) {
      const have = [...new Set((await site.yearFiles(y)).flatMap((x) => topicsOf(x.title)))].sort();
      throw new DataError(`the FY${y} yearbook page (${BASE}${INDEX}/${y}) posts no ${topic} file (it has: ` +
        `${have.join(", ") || "no data files"}); files are posted topic by topic as they are ` +
        "ready, and data files start with FY2015", "not_found");
    }
    return [f, y, n ? [n] : []];
  }
  const skipped: number[] = [];
  for (const y of (await site.years()).filter((x) => x >= FILE_YEARS).slice(0, DEFAULT_TRIES)) {
    const [f, n] = pick(await site.yearFiles(y), topic, y);
    if (f) {
      if (skipped.length) {
        notes.push(`fiscal_year not given: FY${skipped.join(", FY")} has no ${topic} file yet ` +
          `(posted topic by topic), so the newest is FY${y}`);
      }
      return [f, y, [...notes, ...(n ? [n] : [])]];
    }
    skipped.push(y);
  }
  throw new DataError(`no ${topic} file on the newest yearbook pages (FY${skipped.join(", FY")})`, "not_found");
}

function locateLirIn(all: LirFile[], year: unknown): [LirFile, number] {
  const files = all.filter((f) => f.fiscal_year);
  if (!files.length) throw new DataError(`no report workbooks found on ${BASE}${LIR_PAGE}`, "api");
  if (empty(year)) {
    const f = files.reduce((a, b) => ((b.fiscal_year as number) > (a.fiscal_year as number) ? b : a));
    return [f, f.fiscal_year as number];
  }
  for (const f of files) if (f.fiscal_year === pyInt(year)) return [f, pyInt(year)];
  throw new DataError(`no Legal Immigration and Adjustment of Status Report for FY${year} (posted: FY` +
    `${files.map((f) => String(f.fiscal_year)).join(", FY")})`, "not_found");
}

// ---------------------------------------------------------------------- workbooks
/** os.path.splitext(name)[0] (Python's rules: a leading dot is not an extension). */
function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  for (let i = 0; i < dot; i++) if (name[i] !== ".") return name.slice(0, dot);
  return name;
}

/** 'Table 7D' / 'fy2019_table7d.xlsx' / '7' -> 'table7'; 'LPRSuppTable 1' -> 'lprsupptable1'. */
function key(name: string): string {
  let s = stem(path.win32.basename(String(name))).toLowerCase();
  s = s.replace(/^fy\d{4}_?/, "").replace(/[^a-z0-9]/g, "").replace(/(\d)d$/, "$1");
  return /^\d+$/.test(s) ? "table" + s : s;
}

/** {sheet name: grid} of an .xlsx, or of every .xlsx in a .zip (FY2015-2021 yearbook files). */
function workbookSheets(data: Uint8Array, fmt: string): Sheets {
  const names: string[] = [];
  try {
    unzipSync(data, { filter: (f) => (names.push(f.name), false) });
  } catch {
    throw new DataError(`expected an .${fmt} file, got something else (an HTML page, or an old .xls)`, "api");
  }
  if (names.includes("[Content_Types].xml")) return xlsxSheets(data); // an .xlsx (itself a zip)
  const z = unzipSync(data);
  const out: Sheets = {};
  for (const n of [...names].sort(naturalCompare)) {
    if (n.toLowerCase().endsWith(".xlsx") && !n.endsWith("/")) {
      for (const [s, g] of Object.entries(xlsxSheets(z[n]))) out[!(s in out) ? s : `${s} (${path.win32.basename(n)})`] = g;
    }
  }
  if (!Object.keys(out).length) throw new DataError(`no .xlsx in the zip (${names.slice(0, 10).join(", ")})`, "api");
  return out;
}

const cell = (v: Cell) => (v === null || v === undefined ? "" : squash(String(v)));
const nFilled = (r: Cell[]) => r.filter((v) => cell(v)).length;
const isUpper = (s: string) => s.toUpperCase() === s;

function sheetTitle(grid: Grid): string {
  for (const r of grid.slice(0, 8)) {
    const t = r.length ? cell(r[0]) : "";
    if (nFilled(r) === 1 && [...t].length > 25 && isUpper(t)) return t;
  }
  return "";
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

function sheetList(sheets: Sheets): string {
  let toc = new Map<string, string>();
  for (const [name, g] of Object.entries(sheets)) {
    if (["toc", "table of contents", "contents"].includes(name.trim().toLowerCase())) {
      toc = new Map(g.filter((r) => r.length > 1 && cell(r[0]) && cell(r[1])).map((r) => [cell(r[0]), cell(r[1])]));
    }
  }
  const items: string[] = [];
  for (const [name, g] of Object.entries(sheets)) {
    if (name === "TOC") continue;
    const t = toc.get(name) || capitalize(sheetTitle(g));
    items.push(pyRepr(name) + (t ? ` (${t.slice(0, 160)})` : ""));
  }
  return items.join("; ");
}

function chooseSheet(sheets: Sheets, want: unknown): string {
  if (empty(want)) {
    throw new DataError(`no table given: set params.table to one of the workbook's sheets: ${sheetList(sheets)}`, "bad_request");
  }
  if (String(want) in sheets) return String(want);
  const byKey = new Map<string, string>();
  for (const n of Object.keys(sheets)) if (!byKey.has(key(n))) byKey.set(key(n), n);
  const k = key(String(want));
  if (byKey.has(k)) return byKey.get(k)!;
  throw new DataError(`no sheet ${pyRepr(want)} in the workbook; its sheets: ${sheetList(sheets)}`, "bad_request");
}

/** A second header row under `top`: two or more labels and no numbers (years allowed), filling cells that `top`
 * leaves empty, where one of the two rows has an empty first cell. */
function isSubheader(top: Cell[], row: Cell[]): boolean {
  if (!row.length || !top.length || nFilled(row) < 2 || (cell(row[0]) && cell(top[0]))) return false;
  const vals = row.map(cell).filter(Boolean);
  if (vals.some((v) => NUMERIC.test(v) && !/^(19|20)\d{2}$/.test(v))) return false;
  for (let i = 1; i < row.length; i++) if (cell(row[i]) && (i >= top.length || !cell(top[i]))) return true;
  return false;
}

/** [index of the header row, number of header rows: 1 or 2]. */
function findHeader(grid: Grid, headerRow?: unknown): [number, number] {
  let i: number;
  if (!empty(headerRow)) {
    i = pyInt(headerRow) - 1;
    if (!(i >= 0 && i < grid.length)) throw new DataError(`header_row ${headerRow} is outside the sheet (${grid.length} rows)`, "bad_request");
  } else {
    i = grid.findIndex((r) => nFilled(r) >= 2);
    if (i < 0) throw new DataError("no header row found (no row with two or more filled cells): set header_row", "bad_request");
  }
  const two = i + 1 < grid.length && isSubheader(grid[i], grid[i + 1]);
  return [i, two ? 2 : 1];
}

function headerNames(grid: Grid, i: number, n: number): string[] {
  const top = grid[i].map(cell);
  const width = Math.max(top.length, n === 2 ? grid[i + 1].length : 0);
  while (top.length < width) top.push("");
  let names: string[];
  if (n === 2) {
    const low = [...grid[i + 1].map(cell), ...Array(width).fill("")];
    names = [];
    let group = "";
    for (let k = 0; k < width; k++) {
      if (top[k] && k > 0) group = top[k]; // the row-label column starts no group
      const up = top[k] || (k > 0 && low[k] ? group : "");
      if (k === 0) names.push(top[0] || low[0]);
      else if (up && low[k] && up !== low[k]) names.push(`${up} ${low[k]}`);
      else names.push(low[k] || up);
    }
  } else names = top;
  const out: string[] = [];
  const seen = new Set<string>();
  names.forEach((h0, k) => {
    let h = h0 || `col${k + 1}`;
    if (seen.has(h)) h = `${h}_col${k + 1}`;
    seen.add(h);
    out.push(h);
  });
  return out;
}

/** Index (into rows below the header) where the footnotes / Notes / Source block begins. */
function footerStart(rows: Grid): number {
  let end = rows.findIndex((r) => r.length && FOOTER.test(cell(r[0])) && nFilled(r) <= 2);
  if (end < 0) end = rows.length;
  let k = end;
  while (k > 0) {
    const r = rows[k - 1];
    if (nFilled(r) === 0 || (nFilled(r) === 1 && cell(r[0]) && FOOTNOTE.test(cell(r[0])))) {
      k--;
      continue;
    }
    break;
  }
  return k;
}

type Info = { title: string; header_row: number; header_rows: number; footer: string[]; codes: Map<string, number> };

/** [sheet name, rows, info]. */
function readTable(sheets: Sheets, table: unknown, headerRow?: unknown): [string, ORow[], Info] {
  const name = chooseSheet(sheets, table);
  const grid = sheets[name];
  const [i, n] = findHeader(grid, headerRow);
  const head = headerNames(grid, i, n);
  const body = grid.slice(i + n);
  const cut = footerStart(body);
  const footer = body.slice(cut).filter((r) => nFilled(r)).map((r) => r.map(cell).filter(Boolean).join(" "));
  const rows: ORow[] = [];
  const codes = new Map<string, number>();
  let section = "", hasSection = false;
  for (const r of body.slice(0, cut)) {
    if (!nFilled(r)) continue;
    const first = r.length ? cell(r[0]) : "";
    if (nFilled(r) === 1 && first && /[A-Z]/.test(first) && isUpper(first)) {
      section = first;
      hasSection = true;
      continue;
    }
    const row: ORow = new Map([["section", section]]);
    r.forEach((v, k) => {
      const col = k < head.length ? head[k] : `col${k + 1}`;
      const val = v === null || v === undefined ? "" : pyStrip(String(v));
      row.set(col, val);
      if (k && CODES.includes(val)) codes.set(val, (codes.get(val) || 0) + 1);
    });
    for (const col of head) if (!row.has(col)) row.set(col, "");
    rows.push(row);
  }
  if (!hasSection) for (const row of rows) row.delete("section");
  const info = { title: sheetTitle(grid.slice(0, i)) || sheetTitle(grid), header_row: i + 1, header_rows: n, footer, codes };
  return [name, rows, info];
}

function tableNotes(req: string, what: string, url: string, sheet: string, info: Info): string[] {
  const hdr = info.header_rows === 2 ? `rows ${info.header_row}-${info.header_row + 1} joined` : `row ${info.header_row}`;
  const notes = [`${req}: ${what}, sheet ${pyRepr(sheet)}` + (info.title ? ` (${info.title})` : "") + `; header ${hdr}; from ${url}`];
  if (info.footer.length) notes.push(`${req}: published footnotes and notes: ` + info.footer.join(" | "));
  if (info.codes.size) {
    notes.push(`${req}: cells keep the published codes (` +
      [...info.codes].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, k]) => `${c} x${k}`).join(", ") +
      "): D = withheld to limit disclosure, X = not applicable, NA = not available, - = zero " +
      "(or zero or not available, see the footnotes); they are not numbers");
  }
  return notes;
}

// ---------------------------------------------------------------------- hooks
function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  const thisYear = new Date().getFullYear();
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {}, n = pyRepr(r.name ?? null), ep = r.endpoint;
    const years = p.fiscal_year;
    let ys: any[] = Array.isArray(years) ? years : empty(years) ? [] : [years];
    try {
      ys = ys.map(pyInt);
    } catch {
      probs.push(`request ${n}: fiscal_year is a four-digit fiscal year such as 2024`);
      continue;
    }
    if (Array.isArray(years) && ep !== "yearbook_files") {
      probs.push(`request ${n}: one fiscal_year per request for ${ep ?? "None"} (a list works for yearbook_files)`);
    }
    for (const y of ys as number[]) {
      if (y > thisYear + 1 || y < FIRST_YEAR) probs.push(`request ${n}: fiscal_year ${y} is outside ${FIRST_YEAR}-${thisYear}`);
      else if ((ep === "yearbook_table" || ep === "yearbook_files") && y < FILE_YEARS) {
        probs.push(`request ${n}: yearbook data files (xlsx/zip) start with FY${FILE_YEARS}; FY${y} is ` +
          `published as a PDF only (${BASE}${INDEX})`);
      } else if (ep === "lir_table" && y < 2016) {
        probs.push(`request ${n}: the Legal Immigration and Adjustment of Status Report starts with FY2016`);
      }
    }
    const t = p.topic;
    if (ep === "yearbook_files" && !empty(t) && !(t in TOPICS)) {
      probs.push(`request ${n}: topic ${pyRepr(t)} is not one of ${pyRepr(Object.keys(TOPICS).sort())}`);
    }
    const hr = p.header_row;
    if (!empty(hr) && !/^\d+$/.test(String(hr))) probs.push(`request ${n}: header_row is a 1-based row number`);
  }
  return probs;
}

const asRow = (o: Record<string, unknown>): ORow => new Map(Object.entries(o));

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const site = new Site(pack);
  const tables: Record<string, ORow[]> = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const e = r.endpoint;
    let rows: ORow[];
    try {
      if (e === "yearbook_files") {
        const y0: any = params.fiscal_year;
        const ys: unknown[] = Array.isArray(y0) ? y0 : !empty(y0) ? [y0]
          : (await site.years()).filter((y) => y >= FILE_YEARS).slice(0, 1);
        const files: YearFile[] = [];
        for (const y of ys) files.push(...(await site.yearFiles(pyInt(y))));
        const kept = params.topic ? files.filter((x) => x.topic.split(", ").includes(String(params.topic))) : files;
        rows = kept.map(asRow);
        notes.push(`${r.name}: data files on the FY${ys.map(String).join(", FY")} yearbook page(s); ` +
          "topic is the pack's topic name(s) for the file (empty: not a table workbook)");
      } else if (e === "lir_files") {
        rows = (await site.lirFiles()).map(asRow);
      } else {
        let f: FileLink & { through_quarter?: string }, y: number, extra: string[], what: string;
        if (e === "yearbook_table") {
          [f, y, extra] = await locate(site, String(params.topic), params.fiscal_year);
          what = `FY${y} yearbook, ${params.topic} (${f.title})`;
        } else {
          [f, y] = locateLirIn(await site.lirFiles(), params.fiscal_year);
          extra = params.fiscal_year ? [] : [`fiscal_year not given: newest report is FY${y}`];
          what = `FY${y} Legal Immigration and Adjustment of Status Report` +
            (f.through_quarter ? ` (through quarter ${f.through_quarter})` : "");
        }
        const data = (await site.c.get(f.url)).body;
        const [sheet, got, info] = readTable(workbookSheets(data, f.format), params.table, params.header_row);
        rows = got;
        notes.push(...extra.map((x) => `${r.name}: ${x}`), ...tableNotes(r.name, what, f.url, sheet, info));
        if (e === "lir_table") {
          notes.push(`${r.name}: quarterly report figures are preliminary (data available one month ` +
            "after the quarter) and are revised; final annual counts are in the yearbook");
        }
      }
    } catch (err) {
      if (!(err instanceof DataError)) throw err;
      throw new DataError(`request ${pyRepr(r.name)} (${e ?? "None"}): ${err.message}`, err.kind, err.status);
    }
    if (!rows.length && !r.allow_empty) throw new DataError(`request ${pyRepr(r.name)} returned no rows`, "bad_request");
    tables[r.name] = rows;
  }
  return [Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, toTable(v, "dhs-ohss")])), notes];
}

/** The links a fetch in this process found on a page (within the hour), or null. */
function found(p: string): FileLink[] | null {
  const hit = FOUND.get(p);
  return hit && Date.now() - hit[0] < FOUND_TTL ? hit[1] : null;
}

/** For tests: forget the links earlier fetches found. */
export function forgetPages(): void {
  FOUND.clear();
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const e = r.endpoint;
    const y: any = params.fiscal_year;
    if (e === "yearbook_files" || e === "lir_files") {
      const page = e === "lir_files" ? LIR_PAGE : !empty(y) && !Array.isArray(y) ? `${INDEX}/${y}` : INDEX;
      items.push({ name: `${r.name}#1`, request: r.name, url: BASE + page, filename: `${r.name}.html`, needs_key: false,
        method: "GET", body: null, note: "a list of files, not data: open the page and read the links (save it as " +
          "HTML only if asked)", also_ext: [".htm"] });
      continue;
    }
    let url: string, note: string, ext = "xlsx";
    let hit: [FileLink, number] | null = null;
    try {
      if (e === "yearbook_table" && !empty(y)) {
        const links = found(`${INDEX}/${pyInt(y)}`);
        const f = links && pick(links, String(params.topic), pyInt(y))[0];
        if (f) hit = [f, pyInt(y)];
      } else if (e !== "yearbook_table") {
        const links = found(LIR_PAGE);
        if (links) hit = locateLirIn(links.map(lirFile), y);
      }
    } catch (err) {
      if (!(err instanceof DataError)) throw err;
    }
    if (hit) {
      const [f, fy] = hit;
      url = f.url;
      ext = f.format;
      note = `the FY${fy} file "${f.title}"; the request reads sheet ${pyRepr(params.table)}`;
    } else if (e === "yearbook_table") {
      url = BASE + (!empty(y) ? `${INDEX}/${y}` : INDEX);
      note = `open the page${!empty(y) ? "" : ", choose the newest year"}, and download the ` +
        `${params.topic} data tables workbook (.xlsx, or .zip up to FY2021); the request reads ` +
        `sheet ${pyRepr(params.table)}`;
    } else {
      url = BASE + LIR_PAGE;
      note = `open the page and download the FY${y || " (newest)"} report workbook (.xlsx); the request ` +
        `reads sheet ${pyRepr(params.table)}`;
    }
    items.push({ name: `${r.name}#1`, request: r.name, url, filename: `${r.name}.${ext}`,
      also_ext: [ext === "xlsx" ? ".zip" : ".xlsx"], needs_key: false, method: "GET", body: null, note });
  }
  return items;
}

/** An uploaded workbook (.xlsx, or the .zip of FY2015-2021) read like the fetched one. */
function parseUpload(pack: Pack, req: SpecRequest, paths: string[]): Row[] {
  const [, params] = gr.resolve(pack, req);
  if (!TABLE_EPS.includes(req.endpoint || "")) {
    throw new DataError(`request ${pyRepr(req.name)}: ${req.endpoint ?? "None"} lists files from a web page; run it on the ` +
      "script route, or read the page in a browser", "bad_request");
  }
  const rows: ORow[] = [];
  for (const p of [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const data = fs.readFileSync(p);
    const fmt = p.toLowerCase().endsWith(".zip") ? "zip" : "xlsx";
    if (data.toString("latin1", 0, 2048).replace(/^[ \t\n\r\v\f]+/, "").startsWith("<")) { // the page saved in place of the workbook
      throw new DataError(`${path.basename(p)} is a web page, not the workbook: open the link in a browser and ` +
        "download the data tables file it lists (.xlsx, or .zip up to FY2021), then upload that", "bad_request");
    }
    try {
      rows.push(...readTable(workbookSheets(data, fmt), params.table, params.header_row)[1]);
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      throw new DataError(`${path.basename(p)}: ${e.message}`, "bad_request");
    }
  }
  // a FileTable when the columns are years (package.write takes either)
  return toTable(rows, "dhs-ohss") as unknown as Row[];
}

const adapter: Adapter = { fetch, checkSpec, manualItems, parseUpload };
export default adapter;
