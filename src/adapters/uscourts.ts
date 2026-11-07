/**
 * U.S. Courts caseload statistics tables: /sites/default/files/document/<file>.xlsx, read by core's published-table
 * reader (verified 2026-11-07: bf_f2_0930.2026, stfj_b_630.2026). File names come from the Data Tables pages; the
 * date part is not zero-padded the same way in every series (0930.2026, 630.2026), so the name is taken as given.
 */
import type { Adapter, Spec } from "../core/packs.js";
import { pyStr } from "../core/py.js";

function checkSpec(spec: Spec): string[] {
  return (spec.requests || []).filter((r) => r.params?.file !== undefined && !/^[a-z0-9_.-]+$/i.test(pyStr(r.params.file)))
    .map((r) => `request ${JSON.stringify(r.name)}: file is the table's file name without .xlsx, e.g. bf_f2_0930.2026`);
}

const adapter: Adapter = { checkSpec };
export default adapter;
