/**
 * usda-outlook adapter: WASDE monthly CSVs (USDA OCE/WAOB), ERS farm income releases and the USDA Agricultural
 * Baseline (ERS). Published files only, no key (verified 2026-10-30).
 *
 * - WASDE: one long-format CSV per report month at a predictable name,
 *   https://www.usda.gov/sites/default/files/documents/oce-wasde-report-data-YYYY-MM.csv (2021-01 on; HEAD answers
 *   Content-Length 0, so it is fetched with GET). Months with no CSV at that name: 2025-10 (no October 2025 report,
 *   lapse in federal funding) and 2026-05 / 2026-06 (reissued as corrected "v2" reports; HTTP 404 at the name).
 *   "latest" = the newest report date on the ESMIS publication page (esmis.nal.usda.gov), stepping back a month when
 *   its CSV is not posted yet (USDA posts it the day after the release). The usda.gov WASDE web pages answer scripts
 *   with HTTP 403 (Akamai "Access Denied"); the files do not, and the pack never reads those pages.
 * - Farm income (ERS): the data-files page links one ZIP per release whose media id changes ("September 3, 2026
 *   release" -> /media/29517/september-3-2026-release.zip), so links are scraped by their text. The ZIP holds one
 *   CSV of 111 MB (cp1252: unit_desc is padded with non-breaking spaces), read row by row and filtered. Releases up
 *   to November 2017 are plain CSVs. The same page links the one-page summary workbook ("U.S. farm sector financial
 *   indicators, 2019-2026F") and the forecast archive ZIP.
 * - Baseline (ERS): the Agricultural Baseline Database page links each edition's ZIP under "Most Recent Early-Release",
 *   "Most Recent Full-Release" and "Historic Full-Release" headings; both 2035 ZIPs share a file name and differ by
 *   media id, so the heading decides which is which.
 *
 * Values are as published, except: unit_desc is stripped of the padding spaces; .xlsx floats are written in their
 * shortest exact form (369.31670200000002 -> 369.316702). Added columns: farm_income `release_date` (from the
 * file's PublicationDate) and `estimate_type` (forecast/estimate by ERS's stated rule), farm_income_summary
 * `section` and `unit`.
 */
import fs from "node:fs";
import path from "node:path";
import * as gr from "../core/generic-rest.js";
import { type Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { unzip } from "../core/tabular.js";
import {
  asTable, baselineEditions, basename, blank, cp1252, dateOf, type Day, day, dictReader, ERS, fiwLink, fiwReleases, fnmatch,
  gridRecords, type MRow, noNone, NUM, num, orderedSheets, pickEdition, pickRelease, pstr, pyInt, repr, strip, utf8OrCp1252,
  words,
} from "./_usda-outlook_read.js";

const WASDE_CSV = (ym: string) => `https://www.usda.gov/sites/default/files/documents/oce-wasde-report-data-${ym}.csv`;
const WASDE_HIST = "https://www.usda.gov/oce/commodity-markets/wasde/historical-wasde-report-data";
const ESMIS = "https://esmis.nal.usda.gov/publication/world-agricultural-supply-and-demand-estimates";
const FIW_PAGE = ERS + "/data-products/farm-income-and-wealth-statistics/data-files-us-and-state-level-farm-income-and-wealth-statistics";
const BASE_PAGE = ERS + "/data-products/agricultural-baseline-database";
const WASDE_FIRST = "2021-01";
const NO_REPORT: Record<string, string> = { "2025-10": "no October 2025 WASDE was issued (lapse in federal funding)" };
// known HTTP 404s at the usual CSV name (verified 2026-10-30); still requested, in case USDA posts them later
const WASDE_GAPS: Record<string, string> = { ...NO_REPORT,
  "2026-05": "the May 2026 report was reissued as a corrected v2 report; no CSV at the usual name",
  "2026-06": "the June 2026 report was reissued as a corrected v2 report; no CSV at the usual name" };
const WASDE_MAX_MONTHS = 72;
const WASDE_COLS = ["WasdeNumber", "ReportDate", "ReportTitle", "Attribute", "Commodity", "Region", "MarketYear",
  "ProjEstFlag", "Value", "Unit"];
const FI_FIRST = "2014-08";
const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const has = (o: Record<string, string>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const fmtInt = (n: number) => n.toLocaleString("en-US");

// ---------------------------------------------------------------------- small helpers
const norm = (v: unknown) => words(pstr(v || "")).toLowerCase();

/** ProjEstFlag 'Proj.', '(Proj.)', 'Est.', '(Est.)', '' -> proj / est / none. */
export function flag(v: unknown): string {
  return pstr(v || "").replace(/[().\s]/g, "").toLowerCase() || "none";
}

function list(v: unknown): unknown[] {
  if (blank(v)) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => !blank(x));
}

function match(value: unknown, wanted: unknown[]): boolean {
  return !wanted.length || new Set(wanted.map(norm)).has(norm(value));
}

function ymAdd(ym: string, k: number): string {
  const y = parseInt(ym.slice(0, 4), 10), m = parseInt(ym.slice(5, 7), 10) - 1 + k;
  return `${String(y + Math.floor(m / 12)).padStart(4, "0")}-${String((((m % 12) + 12) % 12) + 1).padStart(2, "0")}`;
}

function ymRange(a: string, b: string): string[] {
  const out: string[] = [];
  let cur = a;
  while (cur <= b && out.length <= WASDE_MAX_MONTHS) {
    out.push(cur);
    cur = ymAdd(cur, 1);
  }
  return out;
}

/** Python _years: [lo, hi]; throws (as int() does) on a value that is not a whole number. */
function years(p: Record<string, any>): [number | null, number | null] {
  const int = (v: unknown) => {
    const n = pyInt(v);
    if (n === null) throw new TypeError(`invalid literal for int(): ${repr(v)}`);
    return n;
  };
  if (!blank(p.year)) return [int(p.year), int(p.year)];
  return [!blank(p.start_year) ? int(p.start_year) : null, !blank(p.end_year) ? int(p.end_year) : null];
}

function inYears(y: unknown, lo: number | null, hi: number | null): boolean {
  const n = pyInt(pstr(y).slice(0, 4));
  if (n === null) return lo === null && hi === null;
  return (lo === null || n >= lo) && (hi === null || n <= hi);
}

/** The index pages, each read once per fetch. */
class Site {
  c: Client;
  private pages = new Map<string, string>();
  constructor(pack: Pack) {
    this.c = gr.clientFor(pack);
  }
  async page(url: string): Promise<string> {
    if (!this.pages.has(url)) this.pages.set(url, (await this.c.get(url)).text());
    return this.pages.get(url)!;
  }
  async wasdeLatest(): Promise<string> {
    const body = await this.page(ESMIS);
    const ds = [...body.matchAll(/\/publication\/world-agricultural-supply-and-demand-estimates\/(\d{4}-\d{2})-\d{2}/g)].map((m) => m[1]);
    if (!ds.length) throw new DataError("no WASDE release dates found on the ESMIS publication page", "api");
    return ds.reduce((a, b) => (b > a ? b : a));
  }
}

// ---------------------------------------------------------------------- WASDE
function wasdeRows(data: Uint8Array, label: string): MRow[] {
  const text = new TextDecoder("utf-8").decode(data).replace(/^﻿/, "");
  const [names, rows] = dictReader(text);
  const miss = WASDE_COLS.filter((c) => !names.includes(c));
  if (miss.length) {
    throw new DataError(`${label} is not a WASDE data CSV (no ${miss.join(", ")} column; an HTML page in its place?)`, "api");
  }
  return [...rows].map(noNone);
}

const sget = (r: MRow, k: string) => (r.has(k) ? r.get(k) : null);

function wasdeFilter(rows: MRow[], p: Record<string, any>): MRow[] {
  const keepRel = ["true", "1", "yes"].includes(pstr(p.include_reliability ?? "").toLowerCase());
  const pe = list(p.proj_est);
  const peSet = new Set(pe.map((x) => pstr(x).toLowerCase()));
  return rows.filter((r) => {
    if (!keepRel && String(r.get("ReportTitle") ?? "").toLowerCase().startsWith("reliability")) return false;
    if (!(match(sget(r, "Commodity"), list(p.commodity)) && match(sget(r, "Region"), list(p.region)) &&
      match(sget(r, "Attribute"), list(p.attribute)) && match(sget(r, "ReportTitle"), list(p.report_title)) &&
      match(sget(r, "MarketYear"), list(p.market_year)))) return false;
    if (pe.length && !peSet.has(flag(sget(r, "ProjEstFlag")))) return false;
    return true;
  });
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function wasdeNotes(name: string, rows: MRow[]): string[] {
  const notes: string[] = [];
  const tables = [...new Set(rows.map((r) => String(r.has("ReportTitle") ? r.get("ReportTitle") : "")))].sort(cmp);
  const units = [...new Set(rows.map((r) => String(r.has("Unit") ? r.get("Unit") : "")))].sort(cmp);
  if (tables.length > 1 && rows.length <= 5000) {
    const groups = new Map<string, [unknown[], Set<unknown>]>();
    for (const r of rows) {
      const key = ["Commodity", "Region", "Attribute", "MarketYear", "WasdeNumber", "AnnualQuarterFlag"].map((k) => sget(r, k));
      const k = JSON.stringify(key);
      if (!groups.has(k)) groups.set(k, [key, new Set()]);
      groups.get(k)![1].add(sget(r, "ReportTitle"));
    }
    const dup = [...groups.values()].filter(([, v]) => v.size > 1);
    if (dup.length) {
      const [c, rg, a] = dup[0][0].map(pstr);
      notes.push(`${name}: the same item comes from ${tables.length} report tables (${tables.slice(0, 4).join("; ")}` +
        `${tables.length > 4 ? " ..." : ""}), e.g. ${c} / ${rg} / ${a}; units: ${units.join(", ")}. ` +
        "Do not add or compare across tables: set report_title (U.S. tables are in U.S. units such " +
        "as million bushels, world tables in million metric tons).");
    }
  }
  if (rows.some((r) => flag(sget(r, "ProjEstFlag")) === "proj")) {
    notes.push(`${name}: rows flagged Proj. are projections for the current marketing year and Est. are ` +
      "estimates for the year before; they are revised in every monthly report (blank = history).");
  }
  return notes;
}

async function wasdeMonths(site: Site, p: Record<string, any>): Promise<[string[], boolean]> {
  if (!blank(p.start_report)) {
    const end = blank(p.end_report) || p.end_report === "latest" ? await site.wasdeLatest() : pstr(p.end_report);
    return [ymRange(pstr(p.start_report), end), false];
  }
  if (blank(p.report) || p.report === "latest") return [[await site.wasdeLatest()], true];
  return [[pstr(p.report)], false];
}

async function fetchWasde(site: Site, r: SpecRequest, p: Record<string, any>, maxRows: number): Promise<[MRow[], string[]]> {
  const [months, latest] = await wasdeMonths(site, p);
  const notes: string[] = [], missing: string[] = [];
  let rows: MRow[] = [];
  if (latest) {
    const tried: string[] = [];
    let done = false;
    for (let k = 0; k < 3; k++) {
      const ym = ymAdd(months[0], -k);
      if (has(NO_REPORT, ym)) {
        tried.push(`${ym} (${NO_REPORT[ym]})`);
        continue;
      }
      let got: MRow[];
      try {
        got = wasdeRows((await site.c.get(WASDE_CSV(ym))).body, `the ${ym} WASDE CSV`);
      } catch (e) {
        if (!(e instanceof DataError) || !["not_found", "fixture_missing"].includes(e.kind)) throw e;
        tried.push(`${ym} (${has(WASDE_GAPS, ym) ? WASDE_GAPS[ym] : "CSV not posted yet"})`);
        continue;
      }
      if (tried.length) {
        notes.push(`${r.name}: newest report listed is ${months[0]}, but its CSV is not available ` +
          `(${tried.join("; ")}); used the ${ym} report`);
      }
      notes.push(`${r.name}: report = ${ym} (WASDE ${got.length ? pstr(got[0].get("WasdeNumber")) : "?"}, released ` +
        `${got.length ? pstr(got[0].has("ReleaseDate") ? got[0].get("ReleaseDate") : "") : "?"})`);
      rows = wasdeFilter(got, p);
      done = true;
      break;
    }
    if (!done) {
      throw new DataError(`request ${repr(r.name)}: no WASDE CSV found for the latest months (${tried.join("; ")})`, "not_found");
    }
  } else {
    for (const ym of months) {
      if (has(NO_REPORT, ym)) {
        missing.push(`${ym}: ${NO_REPORT[ym]}`);
        continue;
      }
      let got: MRow[];
      try {
        got = wasdeRows((await site.c.get(WASDE_CSV(ym))).body, `the ${ym} WASDE CSV`);
      } catch (e) {
        if (!(e instanceof DataError) || e.kind !== "not_found") throw e;
        missing.push(`${ym}: ${has(WASDE_GAPS, ym) ? WASDE_GAPS[ym] : "no CSV at " + WASDE_CSV(ym) + " (HTTP 404)"}`);
        continue;
      }
      rows = rows.concat(wasdeFilter(got, p));
      if (rows.length >= maxRows) break;
    }
    if (missing.length && missing.length === months.length) {
      throw new DataError(`request ${repr(r.name)}: no WASDE CSV for ${months.join(", ")} (${missing.join("; ")}). ` +
        `Older or reissued months are in the consolidated CSV on ${WASDE_HIST} (a browser page; ` +
        "download it and upload it for ingest)", "not_found");
    }
    if (missing.length) {
      notes.push(`${r.name}: report month(s) skipped: ${missing.join("; ")}. The consolidated CSV on ` +
        `${WASDE_HIST} (browser download, then ingest) may hold them (unverified)`);
    }
  }
  if (rows.length > maxRows) {
    notes.push(`${r.name}: stopped at ${fmtInt(maxRows)} rows (max_rows); the reports have more. Narrow the filter ` +
      "or raise max_rows.");
    rows = rows.slice(0, maxRows);
  }
  return [rows, [...notes, ...wasdeNotes(r.name, rows)]];
}

// ---------------------------------------------------------------------- farm income
/**
 * ERS (archive readme, Sept 2026): a year is first forecast in February of that year, updated in late
 * August/early September, late November/early December and the next February, and becomes an estimate in the
 * late August/early September release of the next year.
 */
export function estimateType(year: unknown, rel: Day | null): string {
  if (!rel) return "";
  const y = pyInt(pstr(year).slice(0, 4));
  if (y === null) return "";
  return y >= rel.y || (y === rel.y - 1 && rel.m <= 4) ? "forecast" : "estimate";
}

/** The text of a release's CSV (a ZIP with one CSV member, or the CSV itself), and the member name. */
function csvText(data: Uint8Array, label: string): [string, string] {
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    const z = unzip(data);
    const members = Object.keys(z).filter((n) => n.toLowerCase().endsWith(".csv"));
    if (!members.length) throw new DataError(`${label}: no CSV in the ZIP (${Object.keys(z).slice(0, 5).join(", ")})`, "api");
    return [cp1252(z[members[0]]), members[0]];
  }
  let i = 0;
  while (i < data.length && [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c].includes(data[i])) i++;
  if (data[i] === 0x3c) throw new DataError(`${label}: an HTML page came back instead of the data file`, "api");
  return [cp1252(data), label];
}

type FiInfo = { member: string; read: number; truncated: boolean; release: Day | null };

function farmIncomeRows(data: Uint8Array, p: Record<string, any>, maxRows: number, label: string): [MRow[], FiInfo] {
  const [text, member] = csvText(data, label);
  const [names, rd] = dictReader(text, true);
  const need = ["Year", "State", "artificialKey", "VariableDescriptionTotal", "Amount"];
  const miss = need.filter((c) => !names.includes(c));
  if (miss.length) throw new DataError(`${label}: not an ERS farm income CSV (no ${miss.join(", ")} column)`, "api");
  const vr = new Set(list(p.variable).map(norm));
  const key = new Set(list(p.key).map((v) => strip(pstr(v)).toUpperCase()));
  const st = new Set(list(p.state).map((v) => strip(pstr(v)).toUpperCase()));
  const srch = !blank(p.search) ? norm(p.search) : "";
  const [lo, hi] = years(p);
  const out: MRow[] = [];
  let read = 0, truncated = false, rel: Day | null = null;
  const g = (row: MRow, k: string, dflt: unknown = "") => (row.has(k) ? row.get(k) : dflt);
  for (const row of rd) {
    read++;
    if (st.size && !st.has(strip(pstr(g(row, "State"))).toUpperCase())) continue;
    if (key.size && !key.has(strip(pstr(g(row, "artificialKey"))).toUpperCase())) continue;
    const d = norm(g(row, "VariableDescriptionTotal", null));
    if (vr.size && !vr.has(d)) continue;
    if (srch && !d.includes(srch)) continue;
    if (!inYears(g(row, "Year", null), lo, hi)) continue;
    if (out.length >= maxRows) {
      truncated = true;
      break;
    }
    rel = rel || dateOf(String(g(row, "PublicationDate") || ""));
    const rec: MRow = new Map([...row].map(([k, v]) => [k, v === null ? "" : k === "unit_desc" ? strip(String(v)) : v]));
    rec.set("unit_desc", strip(String(rec.has("unit_desc") ? rec.get("unit_desc") : "").replace(/ /g, " ")));
    rec.set("release_date", rel ? rel.iso : "");
    rec.set("estimate_type", estimateType(g(row, "Year", null), rel));
    out.push(rec);
  }
  return [out, { member, read, truncated, release: rel }];
}

async function fetchFarmIncome(site: Site, r: SpecRequest, p: Record<string, any>, maxRows: number): Promise<[MRow[], string[]]> {
  const rel = pickRelease(fiwReleases(await site.page(FIW_PAGE)), p.release);
  const data = (await site.c.get(rel.url)).body;
  const [rows, info] = farmIncomeRows(data, p, maxRows, basename(rel.url.split("?")[0]));
  const notes = [`${r.name}: ERS farm income release of ${rel.date.iso} (${rel.label}; ${info.member}); ` +
    "amounts are nominal (ChainType_GDP_Deflator, latest year = 100, deflates them); estimate_type follows " +
    "ERS's rule (forecast until the late-August/September release of the next year)"];
  const fc = [...new Set(rows.filter((x) => x.get("estimate_type") === "forecast").map((x) => String(x.get("Year"))))].sort(cmp);
  if (fc.length) {
    notes.push(`${r.name}: forecast year(s) ${fc.join(", ")} (ERS marks them F); a forecast is revised in ` +
      "the next releases");
  }
  if (info.truncated) {
    notes.push(`${r.name}: stopped at ${fmtInt(maxRows)} rows (max_rows); the release has more matching rows. ` +
      "Narrow variable, state or years.");
  }
  return [rows, notes];
}

function archiveRows(data: Uint8Array, p: Record<string, any>, label: string): MRow[] {
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    const z = unzip(data);
    const names = Object.keys(z).filter((n) => n.toLowerCase().endsWith(".csv"));
    if (!names.length) throw new DataError(`${label}: no CSV in the ZIP`, "api");
    data = z[names[0]];
  }
  const [fieldnames, rd] = dictReader(cp1252(data));
  if (!fieldnames.includes("release_number")) {
    throw new DataError(`${label}: not the ERS farm income forecast archive (no release_number column)`, "api");
  }
  const items = new Set(list(p.item).map((x) => pstr(x).toLowerCase()));
  const [lo, hi] = years(p);
  const out: MRow[] = [];
  for (const x of rd) {
    if ((!items.size || items.has(String(x.get("item") ?? "").toLowerCase())) &&
      inYears(x.has("year") ? x.get("year") : null, lo, hi)) out.push(noNone(x));
  }
  return out;
}

/** The one-sheet 'U.S. farm sector financial indicators' table: header row = the row starting with years. */
function summaryRows(data: Uint8Array): [MRow[], string[]] {
  const grid = orderedSheets(data)[0]?.[1] ?? [];
  const s = (v: unknown) => strip(v === null || v === undefined ? "" : String(v));
  const hi = grid.findIndex((row) => row.slice(1).filter((v) => /^\d{4}F?$/.test(s(v))).length >= 3);
  if (hi < 0) throw new DataError("the farm sector indicators workbook has no row of years", "api");
  const cols = grid[hi].slice(1).filter((v) => !blank(v)).map((v) => strip(String(v)));
  const notes: string[] = [], out: MRow[] = [];
  const asofRow = grid.slice(0, hi).find((row) => row.length > 2 && String(row[1] || "").startsWith("Data as of"));
  const asof = asofRow ? asofRow[2] : null;
  if (asof && /^\d+$/.test(String(asof))) {
    const t = new Date(Date.UTC(1899, 11, 30) + parseInt(String(asof), 10) * 86400000);
    notes.push(`data as of ${day(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()).iso}`);
  }
  let section = "", unit = "";
  for (const row of grid.slice(hi + 1)) {
    const label = row.length ? strip(String(row[0] || "")) : "";
    const vals = Array.from({ length: cols.length }, (_, k) => (k + 1 < row.length ? row[k + 1] : null));
    const texts = vals.filter((v) => !blank(v) && !NUM.test(s(v)) && !["NA", ""].includes(s(v))).map(s);
    const nums = vals.filter((v) => !blank(v) && (NUM.test(s(v)) || s(v) === "NA"));
    if (!label && !nums.length && !texts.length) continue;
    if (texts.length && !nums.length) {
      unit = texts[0];
      if (label) section = label;
      continue;
    }
    if (label && !nums.length) {
      if (label.startsWith("Note:") || /^\d+\//.test(label)) notes.push(label);
      else section = label;
      continue;
    }
    const rec: MRow = new Map<string, unknown>([["section", section], ["item", label], ["unit", unit]]);
    cols.forEach((c, k) => rec.set(c, num(vals[k])));
    out.push(rec);
  }
  return [out, notes];
}

function xlsxHeader(grid: (string | null)[][], headerRow: unknown): number {
  if (!blank(headerRow)) return (pyInt(headerRow) as number) - 1;
  const i = grid.findIndex((row) => row.filter((v) => !blank(v)).length >= 3);
  return i < 0 ? 0 : i;
}

/** The member of a baseline ZIP the request names, as rows; z = {member name: bytes} in the ZIP's order. */
function baselineMemberRows(z: Record<string, Uint8Array>, p: Record<string, any>, label: string): [MRow[], string] {
  const glob = pstr(p.member || "Projections*.csv").toLowerCase();
  const names = Object.keys(z).filter((n) => !n.endsWith("/"));
  const hit = names.filter((n) => fnmatch(n.toLowerCase(), glob) || fnmatch(basename(n).toLowerCase(), glob));
  if (hit.length !== 1) {
    throw new DataError(`${label}: member ${repr(p.member || "Projections*.csv")} matches ${hit.length} files; members: ` +
      `${names.join("; ")}`, "bad_request");
  }
  const m = hit[0];
  if (m.toLowerCase().endsWith(".csv")) {
    const [, rd] = dictReader(utf8OrCp1252(z[m]));
    const com = list(p.commodity), att = list(p.attribute), yr = list(p.year);
    const g = (x: MRow, k: string) => (x.has(k) ? x.get(k) : null);
    return [[...rd].filter((x) => match(g(x, "commodity"), com) && match(g(x, "attribute"), att) && match(g(x, "year"), yr))
      .map(noNone), m];
  }
  if (m.toLowerCase().endsWith(".xlsx")) {
    const sheets = orderedSheets(z[m]);
    const want = p.sheet || 1;
    let grid: (string | null)[][] | undefined;
    if (/^\d+$/.test(pstr(want))) {
      const i = parseInt(pstr(want), 10) - 1;
      grid = sheets[i < 0 ? sheets.length + i : i]?.[1];
    } else grid = sheets.find(([n]) => n === want)?.[1];
    if (!grid) throw new DataError(`${m}: no sheet ${repr(want)} (sheets: ${sheets.map(([n]) => n).join(", ")})`, "bad_request");
    const h = xlsxHeader(grid, p.header_row);
    return [gridRecords(grid, h + 1).map((x) => new Map([...x].map(([k, v]) => [k, num(v)]))), m];
  }
  const ext = /\.[^./\\]*$/.exec(basename(m));
  throw new DataError(`${m}: only the CSV and .xlsx members are read (this is ${ext ? ext[0] : ""})`, "bad_request");
}

function zipMembers(data: Uint8Array, what: string): Record<string, Uint8Array> {
  try {
    return unzip(data);
  } catch {
    throw new DataError(`${what}: not a ZIP file (an HTML page in its place?)`, "api");
  }
}

async function fetchBaseline(site: Site, r: SpecRequest, p: Record<string, any>): Promise<[MRow[], string[]]> {
  const ed = pickEdition(baselineEditions(await site.page(BASE_PAGE)), p.edition);
  const data = (await site.c.get(ed.url)).body;
  const z = zipMembers(data, ed.url);
  const [rows, m] = baselineMemberRows(z, p, basename(ed.url.split("?")[0]));
  const notes = [`${r.name}: USDA Agricultural Projections to ${ed.to_year} (${ed.kind} release` +
    `${ed.updated ? ", last updated " + ed.updated : ""}), ${m}. A conditional baseline under ` +
    "current law and policy, not a forecast; the first years follow the WASDE of the November before"];
  if (ed.kind === "early") {
    notes.push(`${r.name}: early-release tables (before the full report); the full release in February ` +
      "can differ and adds farm income, trade and horticulture tables");
  }
  return [rows, notes];
}

// ---------------------------------------------------------------------- hooks
function nowYm(): string {
  const t = new Date();
  return `${String(t.getFullYear()).padStart(4, "0")}-${String(t.getMonth() + 1).padStart(2, "0")}`;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  const now = nowYm();
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {}, n = repr(r.name), e = r.endpoint;
    if (e === "wasde") {
      for (const k of ["report", "start_report", "end_report"]) {
        const v = p[k];
        if (blank(v) || (k !== "start_report" && v === "latest")) continue;
        const sv = pstr(v);
        if (!YM.test(sv)) probs.push(`request ${n}: ${k} must be YYYY-MM such as 2026-10` + (k !== "start_report" ? ' or "latest"' : ""));
        else if (sv < WASDE_FIRST) {
          probs.push(`request ${n}: ${k} ${sv}: the monthly WASDE CSVs start with ${WASDE_FIRST}; earlier ` +
            `reports are in the consolidated CSV on ${WASDE_HIST} (browser download, then ingest)`);
        } else if (sv > now) probs.push(`request ${n}: ${k} ${sv} is in the future`);
      }
      if (!blank(p.report) && !blank(p.start_report)) probs.push(`request ${n}: give report or start_report/end_report, not both`);
      if (!blank(p.end_report) && blank(p.start_report)) probs.push(`request ${n}: end_report needs start_report`);
      const s = pstr(p.start_report || ""), t = pstr(p.end_report || now);
      const t2 = t !== "latest" ? t : now;
      if (YM.test(s) && YM.test(t2)) {
        if (ymRange(s, t2).length > WASDE_MAX_MONTHS) probs.push(`request ${n}: a range of more than ${WASDE_MAX_MONTHS} reports; split it`);
        else if (t !== "latest" && s > t) probs.push(`request ${n}: end_report is before start_report`);
      }
    }
    if (e === "farm_income") {
      if (!["variable", "key", "search"].some((k) => !(blank(p[k]) || (Array.isArray(p[k]) && !p[k].length)))) {
        probs.push(`request ${n}: farm_income needs variable, key or search (the release holds about ` +
          '470,000 rows); e.g. "variable": "Net farm income"');
      }
      for (const s of list(p.state)) if (!/^[A-Za-z]{2}$/.test(pstr(s))) probs.push(`request ${n}: state ${repr(s)} must be US or a two-letter state code`);
      const rel = pstr(p.release || "latest");
      if (rel !== "latest" && !/^\d{4}-\d{2}(-\d{2})?$/.test(rel)) probs.push(`request ${n}: release must be "latest", YYYY-MM-DD or YYYY-MM`);
      else if (rel !== "latest" && rel.slice(0, 7) < FI_FIRST) {
        probs.push(`request ${n}: release files on the ERS page start with August 2014; older vintages ` +
          "of net farm income, net cash income and cash receipts are in farm_income_archive");
      }
    }
    if (e === "farm_income" || e === "farm_income_archive") {
      try {
        years(p);
      } catch {
        probs.push(`request ${n}: year, start_year and end_year are four-digit years`);
      }
    }
    if (e === "baseline") {
      const ed = pstr(p.edition || "latest").toLowerCase();
      if (!["latest", "early"].includes(ed) && !/^20\d\d$/.test(ed)) {
        probs.push(`request ${n}: edition must be "latest", "early" or the last projection year (e.g. 2035)`);
      }
      if (!blank(p.header_row) && !/^\d+$/.test(pstr(p.header_row))) probs.push(`request ${n}: header_row is a 1-based row number`);
    }
  }
  return probs;
}

async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const site = new Site(pack);
  const tables: Tables = {};
  let notes: string[] = [];
  const defaultMax = Number(pack.policy.limits?.max_rows || 50000);
  for (const r of spec.requests) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const e = r.endpoint;
    const mx = Math.trunc(Number(r.max_rows || defaultMax));
    let rows: MRow[], nn: string[];
    try {
      if (e === "wasde") [rows, nn] = await fetchWasde(site, r, params, mx);
      else if (e === "farm_income") [rows, nn] = await fetchFarmIncome(site, r, params, mx);
      else if (e === "farm_income_summary") {
        const a = fiwLink(await site.page(FIW_PAGE), "U.S. farm sector financial indicators");
        if (!a) throw new DataError("no 'U.S. farm sector financial indicators' workbook on the data-files page", "api");
        let extra: string[];
        [rows, extra] = summaryRows((await site.c.get(a.url)).body);
        nn = [`${r.name}: ${a.text} (${a.url}); ${extra.slice(0, 1).join("; ")}; values in the unit column ` +
          "(billion dollars or percent); F = forecast"];
      } else if (e === "farm_income_archive") {
        const a = fiwLink(await site.page(FIW_PAGE), "ERS Farm Income and Wealth Statistics Data Archive");
        if (!a) throw new DataError("no data archive ZIP on the data-files page", "api");
        rows = archiveRows((await site.c.get(a.url)).body, params, basename(a.url));
        nn = [`${r.name}: ERS archive of past forecasts and estimates (${a.url}); release_number 1-4 are ` +
          "forecasts, 5 on estimates; ERS says it is a research file, not an official record"];
      } else if (e === "baseline") [rows, nn] = await fetchBaseline(site, r, params);
      else throw new DataError(`unknown endpoint ${repr(e)}`, "bad_request");
    } catch (err) {
      if (!(err instanceof DataError)) throw err;
      throw new DataError(`request ${repr(r.name)} (${pstr(e)}): ${err.message}`, err.kind, err.status);
    }
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${repr(r.name)} returned no rows: check the filter values against the ` +
        "published names (case is ignored; see source.md)", "bad_request");
    }
    notes = notes.concat(nn);
    tables[r.name] = asTable(rows);
  }
  return [tables, notes];
}

// ---------------------------------------------------------------------- manual route
/**
 * Download links. Python read the index pages here when it could (latest WASDE month, release and edition links)
 * and fell back to the pages themselves when it could not; this hook is synchronous, so it always gives the
 * fallback: WASDE months from the request (this month for "latest"), and the ERS pages for the other files.
 */
function manualItems(spec: Spec, pack: Pack): any[] {
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const e = r.endpoint, n = r.name;
    if (e === "wasde") {
      const rep = params.report;
      let months = [!blank(rep) && rep !== "latest" ? pstr(rep) : nowYm()];
      if (params.start_report) {
        const end = blank(params.end_report) || params.end_report === "latest" ? nowYm() : pstr(params.end_report);
        months = ymRange(pstr(params.start_report), end);
      }
      for (const ym of months) {
        if (has(NO_REPORT, ym)) continue;
        const url = WASDE_CSV(ym);
        items.push({ name: `${n}#${ym}`, request: n, url, filename: `${n}_${ym}.csv`, alt_filenames: [basename(url)],
          needs_key: false, method: "GET", body: null,
          note: `the ${ym} WASDE data CSV (if it answers 404, take the previous month; for ` +
            `older or reissued months download the consolidated CSV on ${WASDE_HIST})` });
      }
      continue;
    }
    const url = e === "baseline" ? BASE_PAGE : FIW_PAGE;
    const note = ({ farm_income: "open the page and download the release ZIP (e.g. 'September 3, 2026 release'); " +
      "upload it unchanged",
      farm_income_summary: "open the page and download 'U.S. farm sector financial indicators' (.xlsx)",
      farm_income_archive: "open the page and download the 'ERS Farm Income and Wealth Statistics Data Archive' ZIP",
      baseline: "open the page and download the ZIP under 'Most Recent Full-Release' (or the edition asked for)" } as
      Record<string, string>)[e || ""] ?? "";
    const ext = e === "farm_income_summary" ? "xlsx" : "zip";
    const base = basename(url.split("?")[0]);
    items.push({ name: `${n}#1`, request: n, url, filename: `${n}.${ext}`, also_ext: [".csv", ".zip", ".xlsx"],
      alt_filenames: base.includes(".") ? [base] : [], needs_key: false, method: "GET", body: null, note });
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [, p] = gr.resolve(pack, req);
  const e = req.endpoint;
  const mx = Math.trunc(Number(req.max_rows || pack.policy.limits?.max_rows || 50000));
  let rows: MRow[] = [];
  for (const f of [...files].sort(cmp)) {
    const data = fs.readFileSync(f);
    const label = path.basename(f);
    try {
      if (e === "wasde") {
        let got = wasdeRows(data, label);
        let months: string[] = [];
        if (p.start_report) months = ymRange(pstr(p.start_report), pstr(p.end_report || "9999-12"));
        else if (!blank(p.report) && p.report !== "latest") months = [pstr(p.report)];
        const ym = (x: MRow) => {
          const fy = pstr(x.has("ForecastYear") ? x.get("ForecastYear") : ""), fm = pstr(x.has("ForecastMonth") ? x.get("ForecastMonth") : "");
          return /^\d+$/.test(fy) && /^\d+$/.test(fm)
            ? `${String(parseInt(fy || "0", 10)).padStart(4, "0")}-${String(parseInt(fm || "0", 10)).padStart(2, "0")}` : "";
        };
        if (months.length) got = got.filter((x) => months.includes(ym(x)));
        else if (got.length && got.some((x) => ym(x))) {
          const newest = got.map(ym).reduce((a, b) => (b > a ? b : a));
          got = got.filter((x) => ym(x) === newest);
        }
        rows = rows.concat(wasdeFilter(got, p));
      } else if (e === "farm_income") rows = rows.concat(farmIncomeRows(data, p, mx, label)[0]);
      else if (e === "farm_income_archive") rows = rows.concat(archiveRows(data, p, label));
      else if (e === "farm_income_summary") rows = rows.concat(summaryRows(data)[0]);
      else if (e === "baseline") {
        if (data.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1")) && label.toLowerCase().endsWith(".zip")) {
          rows = rows.concat(baselineMemberRows(unzip(data), p, label)[0]);
        } else { // the member itself (CSV or .xlsx) uploaded on its own
          rows = rows.concat(baselineMemberRows({ [label]: data }, { ...p, member: label }, label)[0]);
        }
      }
    } catch (err) {
      if (!(err instanceof DataError)) throw err;
      throw new DataError(`${label}: ${err.message}`, "bad_request");
    }
  }
  if (!rows.length) throw new DataError(`request ${repr(req.name)}: the uploaded file(s) have no rows matching the request`, "bad_request");
  return asTable(rows);
}

const adapter: Adapter = { checkSpec, fetch, manualItems, parseUpload };
export default adapter;
