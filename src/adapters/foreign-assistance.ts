/**
 * ForeignAssistance.gov aggregate data files (the Data page's CSV downloads under /static/, refreshed with the
 * site). Manual only: on 2026-11-07 foreignassistance.gov answered this server's requests with HTTP 403 (its
 * documented Data API at /data-api/ answered 404), so refusedHosts sends fetch to manual_bundle; the user
 * downloads the CSV in a browser and ingest filters it here by country, fiscal year and transaction type.
 */
import type { Adapter, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v])
  .map((x) => pyStr(x).trim().toLowerCase()).filter(Boolean);

const REFUSED = "foreignassistance.gov answers this server with HTTP 403 (verified 2026-11-07), so its files cannot " +
  "be fetched from here: use manual_bundle; the user downloads the CSV from https://foreignassistance.gov/data " +
  "(Data Download) in a web browser and uploads it; then ingest applies the filters";

const refusedHosts = (_spec: Spec): string => REFUSED;

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    for (const k of ["from", "to"]) {
      if (p[k] !== undefined && p[k] !== "" && !/^\d{4}$/.test(pyStr(p[k]))) bad.push(`request ${JSON.stringify(r.name)}: ${k} is a fiscal year, e.g. 2024`);
    }
  }
  return bad;
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  const p = req.params || {};
  const countries = list(p.country), years = list(p.fiscal_year), types = list(p.transaction_type);
  const from = p.from ? Number(p.from) : null, to = p.to ? Number(p.to) : null;
  return rows.filter((r) => {
    const fy = Number(pyStr(r["Fiscal Year"] ?? ""));
    if (countries.length && !countries.includes(pyStr(r["Country Code"] ?? "").toLowerCase()) &&
      !countries.includes(pyStr(r["Country Name"] ?? "").toLowerCase())) return false;
    if (years.length && !years.includes(pyStr(r["Fiscal Year"] ?? "").toLowerCase())) return false;
    if (from !== null && !(fy >= from)) return false;
    if (to !== null && !(fy <= to)) return false;
    if (types.length && !types.includes(pyStr(r["Transaction Type Name"] ?? "").toLowerCase()) &&
      !types.includes(pyStr(r["Transaction Type ID"] ?? "").toLowerCase())) return false;
    return true;
  });
}

const adapter: Adapter = { refusedHosts, checkSpec, normalize };
export default adapter;
