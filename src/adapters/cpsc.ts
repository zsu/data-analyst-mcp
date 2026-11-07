/**
 * Consumer Product Safety Commission: the SaferProducts.gov Recall API (JSON) and NEISS injury data (manual only).
 *
 * Recall API, verified 2026-11-07:
 * - With no filter it returns an empty list. An unknown parameter is ignored: it returns what the other filters
 *   give, which would look like an answer, so checkSpec refuses a request with no API filter.
 * - These filters work (part of the field, case-insensitive): RecallNumber, RecallDateStart/End,
 *   LastPublishDateStart, ProductName, ProductType, RecallTitle, RecallDescription, Manufacturer, Retailer,
 *   Importer, Injury, Remedy.
 * - Hazard, ManufacturerCountry and ProductModel are accepted but match nothing, so hazard and country are
 *   filtered here instead.
 * normalize turns the nested lists (Products, Hazards, Remedies ...) into one row per recall with joined text.
 *
 * NEISS: www.cpsc.gov answers scripts with HTTP 403 (the query system, the archived files and the NEISS pages;
 * verified 2026-11-07). The archived yearly files sit behind a form. So the neiss endpoint is refused before any
 * request (refusedHosts), manualItems points at the query page, and parseUpload reads the saved Tab Delimited Text
 * or Excel file.
 */
import fs from "node:fs";
import path from "node:path";
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";
import { decodeText, sheetRecords, tsvRecords } from "../core/tabular.js";

const NEISS_PAGE = "https://www.cpsc.gov/cgibin/NEISSQuery/home.aspx";
const REFUSED = "www.cpsc.gov answers scripts with HTTP 403 (verified 2026-11-07), and NEISS's archived yearly files " +
  "are behind a form, so NEISS data cannot be fetched from here. Use manual_bundle: the user downloads the year " +
  "from the NEISS query page (Archived Annual NEISS Data, file format Tab Delimited Text) and uploads it; then " +
  "ingest. Fetch recall requests in a separate spec.";
const API_FILTERS = ["RecallNumber", "RecallDateStart", "RecallDateEnd", "LastPublishDateStart", "ProductName",
  "ProductType", "RecallTitle", "RecallDescription", "Manufacturer", "Retailer", "Importer", "Injury", "Remedy"];

const blank = (v: unknown) => v === undefined || v === null || pyStr(v).trim() === "";
const list = (v: unknown) => (Array.isArray(v) ? v : blank(v) ? [] : [v]).map((x) => pyStr(x).trim().toLowerCase()).filter(Boolean);

function refusedHosts(spec: Spec): string {
  return (spec.requests || []).some((r) => r.endpoint === "neiss") ? REFUSED : "";
}

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    if (r.endpoint === "recalls" && !API_FILTERS.some((k) => !blank(p[k]))) {
      bad.push(`request ${JSON.stringify(r.name)}: give at least one of ${API_FILTERS.join(", ")} (the API returns ` +
        "nothing without a filter); e.g. RecallDateStart for a period");
    }
    for (const k of ["RecallDateStart", "RecallDateEnd", "LastPublishDateStart"]) {
      if (!blank(p[k]) && !/^\d{4}-\d{2}-\d{2}$/.test(pyStr(p[k]))) bad.push(`request ${JSON.stringify(r.name)}: ${k} must be YYYY-MM-DD`);
    }
    if (r.endpoint === "neiss" && !/^(19|20)\d{2}$/.test(pyStr(p.year ?? ""))) {
      bad.push(`request ${JSON.stringify(r.name)}: neiss needs year (e.g. 2024)`);
    }
  }
  return bad;
}

/** The names of a recall's list field (Products, Hazards ...), joined with " | ". */
function names(v: unknown, key = "Name"): string {
  if (!Array.isArray(v)) return "";
  return v.map((x) => (x && typeof x === "object" ? pyStr((x as any)[key] ?? "") : pyStr(x)).replace(/\s+/g, " ").trim())
    .filter(Boolean).join(" | ");
}

const day = (v: unknown) => pyStr(v ?? "").slice(0, 10);

export function recallRow(r: Row): Row {
  return {
    recall_number: pyStr(r.RecallNumber ?? ""), recall_date: day(r.RecallDate), title: r.Title ?? "",
    products: names(r.Products), product_types: names(r.Products, "Type"),
    number_of_units: names(r.Products, "NumberOfUnits"), hazards: names(r.Hazards), injuries: names(r.Injuries),
    remedies: names(r.Remedies), remedy_options: names(r.RemedyOptions, "Option"), manufacturers: names(r.Manufacturers),
    importers: names(r.Importers), distributors: names(r.Distributors), retailers: names(r.Retailers),
    manufacturer_countries: names(r.ManufacturerCountries, "Country"), upcs: names(r.ProductUPCs, "UPC"),
    description: pyStr(r.Description ?? "").replace(/\s+/g, " ").trim(), url: r.URL ?? "",
    last_publish_date: day(r.LastPublishDate), recall_id: pyStr(r.RecallID ?? ""),
  };
}

function neissRows(req: SpecRequest, rows: Row[]): Row[] {
  const want = list(req.params?.product);
  if (!want.length) return rows;
  return rows.filter((r) => ["Product_1", "Product_2", "Product_3"].some((k) => want.includes(pyStr(r[k] ?? "").trim())));
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  if (req.endpoint === "neiss") return neissRows(req, rows);
  if (req.endpoint !== "recalls") return rows;
  const hz = pyStr(req.params?.hazard ?? "").trim().toLowerCase();
  const countries = list(req.params?.country);
  return rows.map(recallRow).filter((r) => (!hz || pyStr(r.hazards).toLowerCase().includes(hz)) &&
    (!countries.length || pyStr(r.manufacturer_countries).toLowerCase().split(" | ").some((c) => countries.includes(c))));
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items: any[] = [];
  const recalls = (spec.requests || []).filter((r) => r.endpoint !== "neiss");
  if (recalls.length) items.push(...gr.manualItems(pack, { ...spec, requests: recalls }));
  for (const r of spec.requests || []) {
    if (r.endpoint !== "neiss") continue;
    const y = pyStr(r.params?.year ?? "");
    items.push({ name: `${r.name}#1`, request: r.name, url: NEISS_PAGE, filename: `${r.name}.tsv`,
      also_ext: [".txt", ".tsv", ".xlsx"], needs_key: false, method: "GET", body: null,
      note: `open in a web browser, pick a User Affiliation, then under 'Archived Annual NEISS Data' choose Year ${y} and ` +
        "File Format 'Tab Delimited Text', click Find Data and save the file (Excel also works). Upload it as saved." });
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  if (req.endpoint !== "neiss") return gr.parseUpload(pack, req, files);
  const rows: Row[] = [];
  for (const f of [...files].sort()) {
    const data = fs.readFileSync(f);
    const got = data.subarray(0, 4).equals(Buffer.from("PK\x03\x04", "latin1"))
      ? sheetRecords({ sheet: 1, header_row: 1 }, data) : tsvRecords({ header_row: 1 }, decodeText(data));
    if (got.length && !("CPSC_Case_Number" in got[0])) {
      throw new DataError(`${path.basename(f)}: not a NEISS data file (no CPSC_Case_Number column; columns: ` +
        `${Object.keys(got[0]).slice(0, 8).join(", ")}). Save the archived year's Tab Delimited Text file.`, "bad_request");
    }
    rows.push(...got);
  }
  return gr.clean(neissRows(req, rows), {});
}

const adapter: Adapter = { refusedHosts, checkSpec, normalize, manualItems, parseUpload };
export default adapter;
