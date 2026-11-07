/**
 * BTS adapter: search also finds Monthly Transportation Statistics columns (130 indicators in one dataset).
 *
 * endpoints.json holds "monthly_stats_fields" {field name: published column title}, taken from the data.bts.gov
 * metadata of crem-w557, so a search for "transit ridership" names the right column (system_use_transit_ridership is
 * urban rail only; buses are system_use_transit_ridership_1).
 */
import * as gr from "../core/generic-rest.js";
import type { Adapter, Pack } from "../core/packs.js";
import { pyStr } from "../core/py.js";

function search(query: string, pack: Pack, limit = 20): any[] {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1);
  const hits: [number, any][] = [];
  for (const [field, title] of Object.entries<any>(pack.endpoints?.monthly_stats_fields || {})) {
    const text = `${field} ${pyStr(title)}`.toLowerCase();
    const s = words.reduce((n, w) => n + text.split(w).length - 1, 0);
    if (s) hits.push([s, { dataset: "monthly_stats", column: field, title }]);
  }
  const ranked = hits.sort((a, b) => b[0] - a[0]).map(([, h]) => h);
  const out = [...gr.searchCatalog(pack, query, limit), ...ranked];
  const note = out.length <= limit ? [] : [{ note: `${out.length} matches; showing ${limit}. Narrow the words.` }];
  return [...out.slice(0, limit), ...note];
}

const adapter: Adapter = { search };
export default adapter;
