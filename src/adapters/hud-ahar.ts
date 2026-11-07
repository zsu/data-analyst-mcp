/**
 * HUD AHAR data files: Point-in-Time (PIT) counts and Housing Inventory Counts (HIC), by CoC and by state, from
 * the 2025 AHAR Part 1 page on HUD User. Manual only.
 *
 * www.huduser.gov answers scripts with HTTP 202 and an empty body (a WAF challenge; verified 2026-11-07 on the
 * AHAR pages and the .xlsb/.xlsx files), so refusedHosts sends every request to manual_bundle. The file names come
 * from the 2025 edition's page (verified 2026-11-07). parseUpload reads the saved workbook:
 * - .xlsb (binary, the PIT files) and .xls through SheetJS, .xlsx with the core reader;
 * - the sheet named for the requested year (or `sheet`), header at `header_row` (default 1);
 * - columns as published.
 * The workbook layout was not checked against a downloaded copy (the files cannot be fetched from here): a
 * missing sheet fails with the list of sheets, and source.md says to read the columns before use.
 */
import fs from "node:fs";
import path from "node:path";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";
import { columnsOf, gridRecords, sheetNames, withColumns, xlsSheets, xlsxSheets } from "../core/tabular.js";

const PAGE = "https://www.huduser.gov/portal/datasets/ahar/2025-ahar-part-1-pit-estimates-of-homelessness-in-the-us.html";
const REFUSED = "www.huduser.gov answers scripts with an empty HTTP 202 challenge (verified 2026-11-07), so the AHAR " +
  "workbooks cannot be downloaded from here: use manual_bundle; the user opens the links in a web browser, saves " +
  "the workbook and uploads it; then ingest";

const refusedHosts = (_spec: Spec): string => REFUSED;

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    if (!/^(19|20)\d{2}$/.test(pyStr(p.year ?? "")) && !pyStr(p.sheet ?? "").trim()) {
      bad.push(`request ${JSON.stringify(r.name)}: give year (the count year, e.g. 2025) or sheet`);
    }
    if (p.header_row !== undefined && !/^\d+$/.test(pyStr(p.header_row))) bad.push(`request ${JSON.stringify(r.name)}: header_row is a line number`);
  }
  return bad;
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const base = String(pack.endpoints?.base_url || "").replace(/\/+$/, "");
  const files: Record<string, string> = pack.endpoints?.files || {};
  return (spec.requests || []).filter((r) => files[r.endpoint || ""]).map((r) => {
    const f = files[r.endpoint!];
    return { name: `${r.name}#1`, request: r.name, url: `${base}/${f}`, filename: f, also_ext: [".xlsb", ".xlsx", ".xls"],
      needs_key: false, method: "GET", body: null,
      note: `open in a web browser (huduser.gov refuses scripts); if the link has moved, find it on ${PAGE}. ` +
        "Upload the workbook as saved." };
  });
}

function parseUpload(_pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const p = req.params || {};
  const want = pyStr(p.sheet ?? "").trim() || pyStr(p.year ?? "").trim();
  const rows: Row[] = [];
  const order: string[] = [];
  for (const f of files) {
    const data = fs.readFileSync(f);
    const low = f.toLowerCase();
    let sheets: Record<string, (string | null)[][]>;
    try {
      sheets = low.endsWith(".xlsx") ? xlsxSheets(data) : xlsSheets(data);
    } catch {
      throw new DataError(`${path.basename(f)}: not a workbook (a saved web page or the empty challenge page?): open the ` +
        "link in a web browser and save the file itself", "bad_request");
    }
    const names = sheetNames(sheets);
    const name = names.find((n) => n.trim() === want) ?? names.find((n) => n.trim().toLowerCase() === want.toLowerCase());
    if (!name) {
      throw new DataError(`${path.basename(f)} has no sheet ${JSON.stringify(want)} (sheets: ${names.join(", ")}); give ` +
        "the year of a sheet, or sheet", "bad_request");
    }
    const got = gridRecords({ sheet: name, header_row: Number(p.header_row ?? 1) }, sheets);
    for (const c of columnsOf(got) || []) if (!order.includes(c)) order.push(c);
    rows.push(...got);
  }
  const out = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? "" : v])));
  return order.length ? withColumns(out, order) : out;
}

const adapter: Adapter = { refusedHosts, checkSpec, manualItems, parseUpload };
export default adapter;
