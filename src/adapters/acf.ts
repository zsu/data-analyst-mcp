/**
 * acf adapter: HHS Administration for Children and Families program data (TANF and MOE financial data, TANF
 * caseload data, CCDF expenditure data). Manual route only.
 *
 * acf.gov (acf.hhs.gov redirects there) answers every non-browser request, including direct .xlsx links, with an AWS
 * WAF JavaScript challenge: HTTP 202, an empty body and the header x-amzn-waf-action: challenge (verified 2026-10-30).
 * The pack never works around it: refusedHosts sends fetch to the manual bundle, fetch raises
 * DataError("blocked"), manualItems lists the acf.gov page and workbook links to open in a browser, and
 * parseUpload reads the saved workbook (see _acf_tidy.ts for how a sheet is read).
 *
 * File names change from year to year (no pattern), so endpoints.json lists the ones verified from Internet Archive
 * captures of the acf.gov pages; for other years the manual item is the year's page (page patterns in
 * endpoints.json "pages") and the user saves the workbook linked there.
 */
import fs from "node:fs";
import path from "node:path";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { xlsSheets, xlsxSheets } from "../core/tabular.js";
import { asTable, pickSheet, type Rec, repr, tidy } from "./_acf_tidy.js";

const REFUSED = "acf.gov (and acf.hhs.gov, which redirects there) answers every script, direct .xlsx links included, " +
  "with an AWS WAF JavaScript challenge (HTTP 202, empty body, x-amzn-waf-action: challenge; verified " +
  "2026-10-30), so ACF files cannot be downloaded from here: open the links in a web browser, save the " +
  "workbook and upload it";
const EPS_NAMES = ["tanf_financial", "tanf_caseload", "ccdf_expenditures"];

const blank = (v: unknown) => v === null || v === undefined || v === "";
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

/** Python int(x), or null when it raises. */
function pyInt(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string" && /^\s*[-+]?\d+\s*$/.test(v)) return parseInt(v.trim(), 10);
  return null;
}

const year = (p: Record<string, any>, key = "fiscal_year") => pyInt(p[key]);

function refusedHosts(spec: Spec): string {
  return (spec.requests || []).some(isObj) ? REFUSED : "";
}

async function fetch(spec: Spec): Promise<[Tables, string[]]> {
  const names = (spec.requests || []).map((r) => (r.name === undefined || r.name === null ? "None" : String(r.name))).join(", ");
  throw new DataError(`${REFUSED} (request(s) ${names})`, "blocked");
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  const thisYear = new Date().getFullYear();
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {}, n = repr(r.name), e = r.endpoint || "";
    if (!EPS_NAMES.includes(e)) continue;
    if (!blank(p.fiscal_year)) {
      const yi = year(p);
      if (yi === null) probs.push(`request ${n}: fiscal_year must be a four-digit year such as 2024`);
      else if (!(yi >= 1997 && yi <= thisYear + 1)) probs.push(`request ${n}: fiscal_year ${yi} is outside the years ACF publishes (1997 on)`);
      else if (e === "ccdf_expenditures" && p.file === "grant_year" && yi < 2018) {
        probs.push(`request ${n}: grant-year CCDF tables start with GY 2018 (OCC began separating ` +
          "fiscal and grant years then); use file all_years");
      }
    }
    if (e !== "ccdf_expenditures" && (!blank(p.file) || !blank(p.as_of))) {
      probs.push(`request ${n}: file and as_of are ccdf_expenditures parameters`);
    }
    if (e === "ccdf_expenditures" && !blank(p.as_of)) {
      const a = year(p, "as_of"), y = year(p);
      if (p.file !== "grant_year") probs.push(`request ${n}: as_of applies only to file grant_year`);
      else if (a === null || (y && !(y <= a && a <= y + 3))) {
        probs.push(`request ${n}: as_of is the year of the 9/30 report date, from the grant year to ` +
          "about three years later");
      }
    }
    if (e !== "tanf_caseload" && !blank(p.program)) probs.push(`request ${n}: program is a tanf_caseload parameter`);
    const hr = p.header_row;
    if (!blank(hr)) {
      const hs = Array.isArray(hr) ? hr : [hr];
      const ok = (h: unknown) => (typeof h === "boolean" ? h : typeof h === "number" ? Number.isInteger(h) && h >= 1
        : typeof h === "string" && /^\d+$/.test(h) && parseInt(h, 10) >= 1);
      if (!hs.every(ok)) probs.push(`request ${n}: header_row is a 1-based row number or a list of them`);
    }
  }
  return probs;
}

const fmt = (pattern: string, y: number | null) => pattern.split("{year}").join(y === null ? "None" : String(y));

function itemFor(r: SpecRequest, eps: any): any {
  const p: Record<string, any> = r.params || {};
  const e = r.endpoint;
  const y = year(p);
  const base = String(eps.base_url).replace(/\/+$/, "");
  const pages = eps.pages;
  let url: string | null = null, page: string, what = "";
  if (e === "tanf_financial") {
    page = base + fmt(pages.tanf_financial, y);
    const f = eps.tanf_financial_files?.[String(y)];
    url = f ? base + f : null;
    what = `the 'FY ${y} TANF Financial Data Tables (XLSX)' link`;
  } else if (e === "tanf_caseload") {
    const prog = p.program || "tanf";
    page = base + fmt(pages.tanf_caseload, y);
    const f = (eps.tanf_caseload_files?.[String(y)] || {})[prog];
    url = f ? base + f : null;
    const label = ({ tanf: "TANF Caseload", ssp: "SSP-MOE Caseload", tanf_ssp: "TANF & SSP-MOE Caseload" } as Record<string, string>)[prog];
    if (label === undefined) throw new DataError(`KeyError: ${repr(prog)}`, "bad_request");
    what = `the 'FY${y} ${label} (XLSX)' link (the '15 Months' one when the page has two)`;
  } else {
    const kind = p.file || "all_years";
    const yearPage = base + fmt((y as number) >= 2018 ? pages.ccdf_year : pages.ccdf_year_2011_2017, y);
    let d: any;
    if (kind === "all_years") {
      d = eps.ccdf_files.all_years[String(y)];
      what = `'CCDF Expenditures for FY ${y} (all appropriation years)', then its XLSX link`;
    } else {
      const byyear: Record<string, any> = eps.ccdf_files.grant_year[String(y)] || {};
      const ks = Object.keys(byyear);
      const max = ks.length ? ks.reduce((m, k) => (k > m ? k : m)) : "";
      const a = String(p.as_of || max);
      d = byyear[a];
      what = a ? `'CCDF Expenditures for GY ${y} as of 9/30/${a} (Tables 1b-...)', then its XLSX link`
        : `the latest 'CCDF Expenditures for GY ${y} as of 9/30/<year> (Tables 1b-...)', then its XLSX link`;
    }
    page = d ? base + d.page : yearPage;
    url = d ? base + d.file : null;
    if (!d) what += ` (from ${yearPage})`;
  }
  let fname: string, note: string;
  if (url) {
    fname = url.slice(url.lastIndexOf("/") + 1).split("%20").join(" ");
    note = "open in a web browser (acf.gov refuses scripts, so the download script will get an empty " +
      `HTTP 202 challenge page); if the link has moved, open ${page} and click ${what}. Upload the .xlsx ` +
      "as saved.";
  } else {
    fname = `${r.name}_${e}_${y}.xlsx`;
    url = page;
    note = `no verified file link for this year: open ${page} in a web browser, click ${what}, save the ` +
      "workbook and upload it (any file name when it is the only file uploaded; else rename it to " +
      `${fname}). Some older years publish only PDF or web tables, which ingest cannot read.`;
  }
  return { name: `${r.name}#1`, request: r.name, url, filename: fname, also_ext: [".xlsx", ".xls"], needs_key: false,
    method: "GET", body: null, note };
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const eps = pack.endpoints;
  return (spec.requests || []).filter((r) => isObj(r) && EPS_NAMES.includes(r.endpoint || "") && year(r.params || {}))
    .map((r) => itemFor(r, eps));
}

function headerRowOf(p: Record<string, any>): number | number[] | null {
  const hr = p.header_row;
  if (Array.isArray(hr)) return hr.map((h) => pyInt(h) as number);
  return blank(hr) ? null : pyInt(hr);
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const p: Record<string, any> = req.params || {};
  const rows: Rec[] = [];
  for (const f of [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const base = path.basename(f);
    const data = fs.readFileSync(f);
    let sheets: Record<string, (string | null)[][]>;
    if (data.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1"))) sheets = xlsxSheets(data);
    else if (data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) sheets = xlsSheets(data);
    else {
      throw new DataError(`${base}: not an Excel workbook (a saved web page or the empty challenge page?): open ` +
        "the link in a web browser and save the .xlsx itself", "bad_request");
    }
    const sheet = pickSheet(req.endpoint || "", sheets, p, base, pack.endpoints?.caseload_tables || {});
    const got = tidy(sheets[sheet], headerRowOf(p));
    for (const r of got) r.set("sheet", sheet);
    rows.push(...got);
  }
  return asTable(rows);
}

const adapter: Adapter = { refusedHosts, fetch, checkSpec, manualItems, parseUpload };
export default adapter;
