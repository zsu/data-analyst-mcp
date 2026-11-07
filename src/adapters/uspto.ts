/**
 * USPTO ODP adapter: manual items say that the key goes in a header (browser links cannot send it), and spec checks
 * for the ODP query conventions.
 */
import * as gr from "../core/generic-rest.js";
import type { Adapter, Pack, Spec } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const HEADER_NOTE = "needs USPTO_API_KEY in the X-API-KEY header: use download_data.sh / .ps1 (a browser link " +
  "alone answers 401 Unauthorized)";

function repr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v !== "string") return pyStr(v);
  return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items = gr.manualItems(pack, spec);
  for (const it of items) it.note = (it.note ? it.note + "; " : "") + HEADER_NOTE;
  return items;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    const name = repr(r.name ?? null);
    const n = p.applicationNumberText;
    // str.isdigit(): at least one character, all digits
    if (n !== undefined && n !== null && !/^\p{Nd}+$/u.test(pyStr(n))) {
      probs.push(`request ${name}: applicationNumberText is digits only (14412875, not 14/412,875); ` +
        "PCT and other forms: search with q=applicationNumberText:...");
    }
    for (const k of ["filters", "rangeFilters"]) {
      const v = p[k];
      if (v && !pyStr(v).trim().includes(" ")) {
        probs.push(`request ${name}: ${k} is 'field value' with a space, e.g. ` +
          (k === "filters" ? "'applicationMetaData.applicationTypeCode UTL'" : "'applicationMetaData.grantDate 2020-01-01:2020-12-31'"));
      }
    }
    if (p.limit || p.offset) probs.push(`request ${name}: do not set limit/offset; paging is automatic (use max_rows)`);
  }
  return probs;
}

const adapter: Adapter = { manualItems, checkSpec };
export default adapter;
