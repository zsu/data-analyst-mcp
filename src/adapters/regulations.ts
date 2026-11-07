/**
 * Regulations.gov pack hooks.
 *
 * - normalize: JSON:API rows come as id/type/attributes.*; drop the "attributes." prefix from column names (values
 *   unchanged) so tables read naturally.
 * - manualItems: links carry api_key=DEMO_KEY, which works in any browser at low limits (api.data.gov's public demo
 *   key); the user may replace it with their own key.
 * - keyOnlyNeeds: DEMO_KEY allows only about 10 requests an hour on this API, so large requests need a key.
 */
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import type { Adapter, Pack, Row, Spec } from "../core/packs.js";
import { readJson } from "../core/policy.js";

const DEMO_LIMIT = 8;

export function normalize(req: { params?: Record<string, unknown> }, ep: any, rows: Row[]): Row[] {
  if (ep.records === "meta") { // comment_count: the filters asked for and the total
    const filters = Object.fromEntries(Object.entries(req.params || {}).filter(([k]) => k.startsWith("filter[")));
    return rows.map((r) => ({ ...filters, totalElements: r.totalElements ?? "" }));
  }
  return rows.map((r) => {
    const n: Row = {};
    for (const [k, v] of Object.entries(r)) {
      let k2 = k.startsWith("attributes.") ? k.slice("attributes.".length) : k;
      if (k2 in n && k2 !== k) k2 = k;
      n[k2] = v;
    }
    return n;
  });
}

function calls(spec: Spec): number {
  const eps = readJson(path.join(PACKS_DIR, "regulations"), "endpoints.json").endpoints;
  let n = 0;
  for (const r of spec.requests || []) {
    const pg = (eps[r.endpoint || ""] || {}).paging || {};
    if (pg.type === "page" && r.max_rows) n += Math.max(1, Math.ceil(Math.trunc(Number(r.max_rows)) / Math.trunc(Number(pg.size || 250))));
    else n += 1;
  }
  return n;
}

function keyOnlyNeeds(spec: Spec): string[] {
  const n = calls(spec);
  return n > DEMO_LIMIT ? [`about ${n} API calls (the keyless DEMO_KEY allows about 10 an hour on Regulations.gov)`] : [];
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items = gr.manualItems(pack, spec);
  for (const it of items) {
    it.url += (it.url.includes("?") ? "&" : "?") + "api_key=DEMO_KEY";
    it.note = (it.note ? it.note + "; " : "") +
      "DEMO_KEY is api.data.gov's public demo key (about 10 requests an hour); replace it with your own key for more";
  }
  return items;
}

const adapter: Adapter = { normalize, keyOnlyNeeds, manualItems };
export default adapter;
