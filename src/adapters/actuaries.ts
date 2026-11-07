/**
 * actuaries adapter: Medicare Trustees Report and National Health Expenditure tables (CMS), Social Security
 * Trustees Report single-year tables (SSA, manual route only).
 *
 * CMS publishes these as ZIP files linked from three pages (verified 2026-10-30, see endpoints.json "pages"):
 *   - Trustees Report & Trust Funds: "<year> Expanded and Supplementary Tables and Figures (ZIP)" for 2022 on; the
 *     file names change from year to year, so the pack reads the link from the page (endpoints.json
 *     "medicare_known" holds the names seen on 2026-10-30, used for manual-download links). Each ZIP holds one
 *     .xlsx per table (a table sheet and a "Notes" sheet), the same tables as display-formatted CSV + .txt notes
 *     under CSV/ (not read: the .xlsx has the unformatted numbers), and "<year>TR Figures.xlsx".
 *   - NHE historical and projected pages: fixed-name ZIPs (endpoints.json "nhe_downloads"); the summary and the
 *     type-of-service-by-source-of-funds files are CSV, the tables are one .xlsx per table.
 *   - www.ssa.gov answers every script with HTTP 403 (Akamai "Access Denied"), so SSA requests are never fetched:
 *     refusedHosts sends fetch to the manual route, fetch raises DataError("blocked"), and parseUpload reads the
 *     workbook the user saves from a browser (SingleYearTRTables_TR<year>.xlsx, one sheet per table).
 * How a table is read: _actuaries_read.ts.
 */
import fs from "node:fs";
import path from "node:path";
import * as gr from "../core/generic-rest.js";
import { type Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import {
  asTable, csvGrid, listZip, longLayout, type MRow, pageLinks, pickMember, readMember, repr, tidy, xlsxGrid, zipTables,
} from "./_actuaries_read.js";

const SSA_REFUSED = "www.ssa.gov answers every script with HTTP 403 (Akamai 'Access Denied' bot filter, verified " +
  "2026-10-30; no API key is involved), so Social Security Trustees Report tables (ssa_tr_table) " +
  "cannot be fetched from here";
const MAX_NOTE_LINES = 6;

const blank = (v: unknown) => v === null || v === undefined || v === "";
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const basename = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
const fmtYear = (pattern: string, y: number) => pattern.split("{year}").join(String(y));

/** Python int(x), or null when it raises. */
function pyInt(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string" && /^\s*[-+]?\d+\s*$/.test(v)) return parseInt(v.trim(), 10);
  return null;
}

// ---------------------------------------------------------------------- CMS pages
type Cache = Map<string, Buffer>;

async function get(client: Client, cache: Cache, p: string): Promise<Buffer> {
  if (!cache.has(p)) cache.set(p, (await client.get(p)).body);
  return cache.get(p)!;
}

const rel = (href: string) => href.replace(/^https?:\/\/www\.cms\.gov/, "");
/** Python re.compile(pattern, re.I).match(text): anchored at the start. */
const pyMatch = (pattern: string, t: string) => new RegExp("^(?:" + pattern + ")", "i").exec(t);
const decode = (b: Buffer) => new TextDecoder("utf-8").decode(b);

async function medicareZips(client: Client, cache: Cache, eps: any): Promise<Map<number, string>> {
  const text = decode(await get(client, cache, eps.pages.medicare));
  const found = new Map<number, string>();
  for (const [href, t] of pageLinks(text)) {
    const m = pyMatch(eps.medicare_link, t);
    if (m && href.toLowerCase().endsWith(".zip") && !found.has(parseInt(m[1], 10))) found.set(parseInt(m[1], 10), rel(href));
  }
  if (!found.size) {
    throw new DataError("the CMS Trustees Report page lists no 'Expanded and Supplementary Tables and Figures (ZIP)' " +
      "link (the page changed): see source.md, Access", "api");
  }
  return found;
}

async function nheZip(client: Client, cache: Cache, eps: any, key: string): Promise<[string, string]> {
  const d = eps.nhe_downloads[key];
  if (!d) throw new DataError(`KeyError: ${repr(key)}`, "bad_request");
  const text = decode(await get(client, cache, eps.pages[d.page]));
  for (const [href, t] of pageLinks(text)) if (pyMatch(d.link, t) && href.toLowerCase().endsWith(".zip")) return [rel(href), t];
  throw new DataError(`the CMS NHE ${d.page} page has no link matching ${repr(d.link)} (the page changed): see ` +
    "source.md, Access", "api");
}

function medicareYear(p: Record<string, any>, years: Map<number, string>, name: string): number {
  if (blank(p.report_year)) return Math.max(...years.keys());
  const y = pyInt(p.report_year);
  if (y === null) throw new DataError(`invalid literal for int(): ${repr(p.report_year)}`, "bad_request");
  if (!years.has(y)) {
    throw new DataError(`request ${repr(name)}: no ${y} Medicare Trustees Report tables ZIP on the CMS page (years: ` +
      `${[...years.keys()].sort((a, b) => a - b).join(", ")})`, "not_found");
  }
  return y;
}

// ---------------------------------------------------------------------- hooks
const isSsa = (r: SpecRequest) => r.endpoint === "ssa_tr_table";

function refusedHosts(spec: Spec): string {
  const reqs = (spec.requests || []).filter(isObj) as SpecRequest[];
  if (!reqs.some(isSsa)) return "";
  const other = reqs.filter((r) => !isSsa(r)).map((r) => (r.name === undefined || r.name === null ? "None" : String(r.name)));
  return SSA_REFUSED + (other.length ? `; the CMS requests (${other.join(", ")}) can be fetched: put them in their own spec` : "");
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  const thisYear = new Date().getFullYear();
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {}, n = repr(r.name);
    let y: unknown = p.report_year;
    if (!blank(y)) {
      const yi = pyInt(y);
      if (yi === null) probs.push(`request ${n}: report_year must be a four-digit year`);
      else {
        y = yi;
        if (!(yi >= 2000 && yi <= thisYear)) probs.push(`request ${n}: report_year ${yi} is not a published report year`);
      }
    }
    if (r.endpoint === "medicare_tr_files" || r.endpoint === "medicare_tr_table") {
      if (typeof y === "number" && Number.isInteger(y) && y < 2022) {
        probs.push(`request ${n}: the CMS page has the tables ZIP for 2022 on (asked ${y}); older ` +
          "reports are PDFs on the 'Trustees Reports (current and prior)' page");
      }
    }
    const hr = p.header_row;
    if (!blank(hr)) {
      const hs = Array.isArray(hr) ? hr : [hr];
      const ok = (h: unknown) => (typeof h === "boolean" ? h : typeof h === "number" ? Number.isInteger(h) && h >= 1
        : typeof h === "string" && /^\d+$/.test(h) && parseInt(h, 10) >= 1);
      if (!hs.every(ok)) probs.push(`request ${n}: header_row is a 1-based row number or a list of them`);
    }
    if (isSsa(r) && p.table && !/^[IVX]+\.[A-Z]\d+$/.test(String(p.table).trim())) {
      probs.push(`request ${n}: SSA table is a table number such as 'IV.B1', 'V.A3' or 'VI.G2'`);
    }
  }
  return probs;
}

function headerRowOf(p: Record<string, any>): number | number[] | null {
  const hr = p.header_row;
  if (Array.isArray(hr)) return hr.map((h) => pyInt(h) as number);
  return blank(hr) ? null : pyInt(hr);
}

function addNotes(name: string, lines: string[], notes: string[]): void {
  for (const t of lines.slice(0, MAX_NOTE_LINES)) notes.push(`${name}: table note: ${t.slice(0, 300)}` + (t.length > 300 ? "..." : ""));
  if (lines.length > MAX_NOTE_LINES) notes.push(`${name}: ${lines.length - MAX_NOTE_LINES} more footnote line(s) in the sheet`);
}

function tableRows(data: Uint8Array, p: Record<string, any>, req: SpecRequest, lbl: string, notes: string[]): MRow[] {
  const [member, kind] = pickMember(zipTables(data), p.table, lbl);
  const [sheet, grid, merges, nPct] = readMember(data, member, kind, p.sheet);
  let [rows, extra, title] = tidy(grid, merges, headerRowOf(p));
  const where = basename(member) + (sheet ? `, sheet ${sheet}` : "");
  notes.push(`${req.name}: ${lbl}: ${where}` + (title ? ` (${title})` : ""));
  addNotes(req.name, title ? extra.slice(1) : extra, notes);
  if (nPct) {
    notes.push(`${req.name}: ${nPct} cell(s) were stored as Excel percent-format fractions (0.106 shown as ` +
      "10.6%) and are written as displayed (10.6)");
  }
  if (p.layout === "long") {
    let ok: boolean;
    [rows, ok] = longLayout(rows);
    if (!ok) notes.push(`${req.name}: layout long ignored: the table has no year columns (its years are rows)`);
  }
  return rows;
}

async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const eps = pack.endpoints;
  const ssa = spec.requests.filter(isSsa).map((r) => r.name);
  if (ssa.length) {
    throw new DataError(`${SSA_REFUSED} (request(s) ${ssa.join(", ")}): save the workbook from a web browser and ` +
      "upload it (manual route)", "blocked");
  }
  const client = gr.clientFor(pack);
  const cache: Cache = new Map();
  const tables: Tables = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [, p, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const e = r.endpoint || "";
    let data: Buffer, lbl: string;
    try {
      if (e.startsWith("medicare_tr")) {
        const years = await medicareZips(client, cache, eps);
        const y = medicareYear(p, years, r.name);
        data = await get(client, cache, years.get(y)!);
        lbl = `${y} Medicare Trustees Report tables ZIP (${basename(years.get(y)!)})`;
      } else {
        const [zp, t] = await nheZip(client, cache, eps, String(p.file));
        data = await get(client, cache, zp);
        lbl = `NHE download '${t}' (${basename(zp)})`;
      }
    } catch (x) {
      if (!(x instanceof DataError) || x.kind === "not_found") throw x;
      throw new DataError(`request ${repr(r.name)} (${e}): ${x.message}`, x.kind, x.status);
    }
    let rows: MRow[];
    if (e.endsWith("_files")) {
      rows = listZip(data);
      notes.push(`${r.name}: ${lbl}: ${rows.length} sheet(s)`);
    } else rows = tableRows(data, p, r, lbl, notes);
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${repr(r.name)}: the table has no rows (check table, sheet and header_row)`, "bad_request");
    }
    tables[r.name] = asTable(rows);
  }
  return [tables, notes];
}

/**
 * Download links. Python looked the newest ZIP links up on the CMS pages first (falling back to the names in
 * endpoints.json when a page could not be read); this hook is synchronous, so it always gives the known names.
 */
function manualItems(spec: Spec, pack: Pack): any[] {
  const eps = pack.endpoints;
  const base = String(eps.base_url).replace(/\/+$/, "");
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    const e = r.endpoint;
    if (e === "ssa_tr_table") {
      const y = pyInt(p.report_year || eps.ssa_latest_known) as number;
      const url = fmtYear(eps.ssa_workbook, y);
      items.push({ name: `${r.name}#1`, request: r.name, url, filename: basename(url), also_ext: [".xlsx"], needs_key: false,
        method: "GET", body: null,
        note: "open in a web browser (www.ssa.gov refuses scripts, so the download script will " +
          `likely get HTTP 403); the page ${fmtYear(eps.ssa_index, y)} links it as ` +
          "'Single-Year Tables ... Excel'. Upload the .xlsx as saved." });
      continue;
    }
    let url: string | null = null, page: string, hint: string;
    if (e === "medicare_tr_files" || e === "medicare_tr_table") {
      page = base + eps.pages.medicare;
      const known: Record<string, string> = eps.medicare_known;
      const ks = Object.keys(known);
      const y = !blank(p.report_year) ? String(p.report_year) : ks.reduce((m, k) => (k > m ? k : m));
      url = Object.prototype.hasOwnProperty.call(known, y) ? base + known[y] : null;
      hint = `'${y} Expanded and Supplementary Tables and Figures (ZIP)'`;
    } else if ((e === "nhe_files" || e === "nhe_table") && Object.prototype.hasOwnProperty.call(eps.nhe_downloads, p.file)) {
      const d = eps.nhe_downloads[p.file];
      page = base + eps.pages[d.page];
      url = base + d.known;
      hint = `the link for ${d.what}`;
    } else continue;
    const fname = url ? basename(url) : `${r.name}.zip`;
    items.push({ name: `${r.name}#1`, request: r.name, url: url || page, filename: fname, also_ext: [".zip"], needs_key: false,
      method: "GET", body: null, note: `the ZIP from ${page} (${hint}); upload it as downloaded` });
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const p: Record<string, any> = req.params || {};
  const notes: string[] = [];
  let rows: MRow[] = [];
  for (const f of [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const data = fs.readFileSync(f);
    const base = path.basename(f);
    const low = base.toLowerCase();
    if (isSsa(req)) {
      if (!low.endsWith(".xlsx")) {
        throw new DataError(`${base}: upload the SSA single-year tables workbook (.xlsx) as saved from ` +
          "the lrIndex page; a saved HTML page cannot be read", "bad_request");
      }
      const [, grid, merges] = xlsxGrid(data, String(p.table || "").trim() || null);
      rows = rows.concat(tidy(grid, merges, headerRowOf(p))[0]);
      continue;
    }
    if (low.endsWith(".zip")) {
      rows = rows.concat((req.endpoint || "").endsWith("_files") ? listZip(data) : tableRows(data, p, req, base, notes));
    } else if (low.endsWith(".xlsx") || low.endsWith(".csv")) { // one table taken out of the ZIP
      let grid: string[][], merges: [number, number, number, number][];
      if (low.endsWith(".xlsx")) [, grid, merges] = xlsxGrid(data, p.sheet);
      else [grid, merges] = [csvGrid(data), []];
      const got = tidy(grid, merges, headerRowOf(p))[0];
      rows = rows.concat(p.layout === "long" ? longLayout(got)[0] : got);
    } else {
      throw new DataError(`${base}: upload the CMS ZIP as downloaded (or one .xlsx / .csv table from it)`, "bad_request");
    }
  }
  return asTable(rows);
}

const adapter: Adapter = { refusedHosts, checkSpec, fetch, manualItems, parseUpload };
export default adapter;
