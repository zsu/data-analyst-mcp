/**
 * FHWA Highway Statistics tables: /policyinformation/statistics/<year>/xls/<table>.xlsx, read by core's published-
 * table reader (verified 2026-11-07 for 2023 and 2024: vm2, dl22, mv1, hm20, mf1, fe9; mf2 is not a 2023 file).
 * Several workbooks carry a hidden report-tool sheet (CRYSTAL_PERSIST) first; skip_sheets leaves it out of the
 * sheet numbering. This adapter only checks the spec.
 */
import type { Adapter, Spec } from "../core/packs.js";
import { pyStr } from "../core/py.js";

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    if (p.year !== undefined && !/^(19|20)\d{2}$/.test(pyStr(p.year))) bad.push(`request ${JSON.stringify(r.name)}: year is the edition year, e.g. 2023`);
    if (p.table !== undefined && !/^[a-z]{1,3}\d{1,3}[a-z]?$/.test(pyStr(p.table))) {
      bad.push(`request ${JSON.stringify(r.name)}: table is the id in lower case without the hyphen (VM-2 -> vm2)`);
    }
  }
  return bad;
}

const adapter: Adapter = { checkSpec };
export default adapter;
