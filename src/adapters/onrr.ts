/**
 * Office of Natural Resources Revenue data downloads (revenuedata.onrr.gov/downloads/<file>.csv; revenuedata.doi.gov
 * redirects there). Verified 2026-11-07: revenue (fiscal, calendar, monthly), disbursements (fiscal) and production
 * (fiscal, calendar) as CSV. Files are read whole and filtered here (state, years, commodity, revenue type, land
 * class, fund type, product), values as published.
 */
import type { Adapter, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v])
  .map((x) => pyStr(x).trim().toLowerCase()).filter(Boolean);
const FILTERS: [string, string][] = [["state", "State"], ["commodity", "Commodity"], ["revenue_type", "Revenue Type"],
  ["land_class", "Land Class"], ["fund_type", "Fund Type"], ["product", "Product"]];

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    for (const k of ["from", "to"]) {
      const v = r.params?.[k];
      if (v !== undefined && v !== "" && !/^\d{4}$/.test(pyStr(v))) bad.push(`request ${JSON.stringify(r.name)}: ${k} is a year, e.g. 2020`);
    }
  }
  return bad;
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  const p = req.params || {};
  const wants = FILTERS.map(([k, col]) => [col, list(p[k])] as [string, string[]]).filter(([, v]) => v.length);
  const from = p.from ? Number(p.from) : null, to = p.to ? Number(p.to) : null;
  if (!wants.length && from === null && to === null) return rows;
  return rows.filter((r) => {
    // monthly_revenue has Date as MM/DD/YYYY (verified 2026-11-07)
    const y = Number(pyStr(r["Fiscal Year"] ?? r["Calendar Year"] ?? (/(\d{4})$/.exec(pyStr(r.Date ?? "")) || ["", ""])[1]));
    if (from !== null && !(y >= from)) return false;
    if (to !== null && !(y <= to)) return false;
    return wants.every(([col, v]) => v.includes(pyStr(r[col] ?? "").trim().toLowerCase()));
  });
}

const adapter: Adapter = { checkSpec, normalize };
export default adapter;
