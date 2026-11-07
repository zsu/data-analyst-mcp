/**
 * Philadelphia Fed Real-Time Data Research Center: published .xlsx workbooks read by the generic $xlsx reader.
 *
 * The site answers a file that does not exist with HTTP 200 and an HTML page titled "Error - 404" (verified
 * 2026-10-30, e.g. .../historical-data/doesnotexist.xlsx), so checkError turns that page into a clear message
 * instead of the reader's "not an .xlsx workbook". normalize adds readable date columns next to the published
 * ones (never replacing them): SPF `survey` (2026Q3 from YEAR/QUARTER), Livingston `survey_date` (the Date
 * column is an Excel serial day number), Greenbook `greenbook_date` (GBdate yyyymmdd).
 */
import type { Adapter, Row, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const FILES_PAGE = "https://www.philadelphiafed.org/surveys-and-data/real-time-data-research";
const PY_FLOAT = /^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i;

function checkError(status: number, body: Buffer): string | null {
  const head = body.subarray(0, 2048).toString("latin1").replace(/^[ \t\n\r\v\f]+/, "").toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    const what = body.subarray(0, 4096).toString("latin1").toLowerCase().includes("error - 404") ? "an 'Error - 404' page" : "an HTML page";
    return `the Philadelphia Fed answered with ${what} (HTTP ${status}) instead of the workbook: no file by that ` +
      "name. Check the endpoint's file/measure value against source.md (file names are fixed, e.g. " +
      `medianLevel, Dispersion_2, ROUTPUTQvQd), or find the file on the data pages under ${FILES_PAGE}.`;
  }
  return null;
}

/** float(str(v).strip()), or null where Python raises. */
function num(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return null;
  const s = pyStr(v).trim();
  if (!PY_FLOAT.test(s)) return null;
  const t = s.replace(/_/g, "").toLowerCase();
  if (t.includes("inf")) return t.startsWith("-") ? -Infinity : Infinity;
  if (t.includes("nan")) return NaN;
  return Number(t);
}

function survey(row: Row): string {
  const y = num(row.YEAR), q = num(row.QUARTER);
  return y !== null && q !== null ? `${Math.trunc(y)}Q${Math.trunc(q)}` : "";
}

function excelDate(v: unknown): string {
  const n = num(v);
  if (n === null || !(0 < n && n < 100000)) return "";
  const d = new Date(Date.UTC(1899, 11, 30) + Math.trunc(n) * 86400000);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function yyyymmdd(v: unknown): string {
  const s = (v === null || v === undefined || v === "" || v === 0 || v === false ? "" : pyStr(v)).trim().split(".")[0];
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "";
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  const name = req.endpoint;
  return rows.map((r) => {
    if ((name === "spf" || name === "spf_prob") && "YEAR" in r) return { survey: survey(r), ...r };
    if (name === "livingston" && "Date" in r) return { survey_date: excelDate(r.Date), ...r };
    if (name === "greenbook" && "GBdate" in r) return { greenbook_date: yyyymmdd(r.GBdate), ...r };
    return r;
  });
}

const adapter: Adapter = { checkError, normalize };
export default adapter;
