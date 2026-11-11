/**
 * USDA Risk Management Agency public files (pubfs-rma.fpac.usda.gov/pub/Web_Data_Files). Verified 2026-11-11:
 * Summary_of_Business/state_county_crop/sobcov_<year>.zip (1989 on) holds one pipe-delimited .txt with no header,
 * 28 fields as the layout document SOB_State_County_Crop_with_Coverage_Level_1989_Forward.pdf lists them
 * (endpoints.json names them); Reinsurance_Reports/standard_reinsurance_agreement_reports/<year>_Standard_
 * Reinsurance_Report_<National|State>.xls (2014 on) has its header on row 7, then footnotes. Filters here.
 */
import type { Adapter, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v])
  .map((x) => pyStr(x).trim().toLowerCase()).filter(Boolean);
// each filter matches any of its columns (a name or its code)
const FILTERS: [string, string[]][] = [["state", ["Location State Abbreviation", "Location State Code", "State"]],
  ["county", ["Location County Code"]], ["commodity", ["Commodity Name", "Commodity Code"]],
  ["plan", ["Insurance Plan Name Abbreviation", "Insurance Plan Code"]], ["coverage_category", ["Coverage Category"]],
  ["delivery_type", ["Delivery Type"]]];

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    if ((r.endpoint === "coverage" || r.endpoint === "reinsurance") && !/^\d{4}$/.test(pyStr(p.year ?? ""))) {
      bad.push(`request ${JSON.stringify(r.name)}: year is a 4-digit year, e.g. 2024`);
    }
    if (r.endpoint === "reinsurance" && !["National", "State"].includes(pyStr(p.level ?? ""))) {
      bad.push(`request ${JSON.stringify(r.name)}: level is National or State`);
    }
  }
  return bad;
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  // the files pad names with spaces (county, commodity, plan, state); the reinsurance sheets end in footnotes
  let out = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim(), typeof v === "string" ? v.trim() : v])) as Row);
  if (req.endpoint === "reinsurance") {
    // a fund row has its gross liability; the sheet's blank first column comes through unnamed (col1)
    out = out.filter((r) => /^-?\d/.test(pyStr(r["Gross Liability"] ?? "")));
    const blank = Object.keys(out[0] || {}).filter((k) => /^col\d+$/.test(k) && out.every((r) => pyStr(r[k] ?? "") === ""));
    if (blank.length) out = out.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !blank.includes(k))) as Row);
  }
  const p = req.params || {};
  const wants = FILTERS.map(([k, cols]) => [cols, list(p[k])] as [string[], string[]]).filter(([, v]) => v.length);
  if (!wants.length) return out;
  return out.filter((r) => wants.every(([cols, v]) => cols.some((c) => c in r && v.includes(pyStr(r[c] ?? "").toLowerCase()))));
}

const adapter: Adapter = { checkSpec, normalize };
export default adapter;
