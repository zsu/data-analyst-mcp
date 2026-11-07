/**
 * NSF Award Search API. Verified 2026-11-07:
 * - offset is 1-based (the default sets it), rpp is at most 25, and response.metadata.totalCount gives the
 *   total; printFields is ignored, so every field comes back.
 * - Date filters are MM/DD/YYYY.
 * normalize drops the people's contact fields (PI and program officer e-mail and phone): names are public award
 * data, personal contact details are not needed for analysis. Amounts stay as published text.
 */
import type { Adapter, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const CONTACT = new Set(["piEmail", "poEmail", "poPhone", "awardeePhone"]);
const DATES = ["dateStart", "dateEnd", "startDateStart", "startDateEnd", "expDateStart", "expDateEnd"];
const FILTERS = ["keyword", "awardeeName", "awardeeStateCode", "perfStateCode", "pdPIName", "fundProgramName", "id", ...DATES];

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    for (const k of DATES) {
      if (p[k] !== undefined && p[k] !== "" && !/^\d{2}\/\d{2}\/\d{4}$/.test(pyStr(p[k]))) {
        bad.push(`request ${JSON.stringify(r.name)}: ${k} must be MM/DD/YYYY (got ${JSON.stringify(p[k])})`);
      }
    }
    if (!FILTERS.some((k) => p[k] !== undefined && p[k] !== "")) {
      bad.push(`request ${JSON.stringify(r.name)}: give at least one filter (${FILTERS.join(", ")}); all NSF awards is too many`);
    }
  }
  return bad;
}

function normalize(_req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !CONTACT.has(k))));
}

const adapter: Adapter = { checkSpec, normalize };
export default adapter;
