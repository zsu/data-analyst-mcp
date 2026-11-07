/**
 * Federal Register pack hooks.
 *
 * - normalize: facet counts arrive as one object keyed by group; they become rows. Document lists are de-duplicated
 *   on document_number: page-number paging over a non-unique order (order=oldest, many documents per date) can repeat
 *   a document on two pages and skip another (2 of 10,000 on 2026-10-22).
 */
import type { Adapter, Row } from "../core/packs.js";
import { pyStr } from "../core/py.js";

function dedupe(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of rows) {
    const k = r.document_number;
    if (k !== undefined && k !== null && k !== "") {
      const key = JSON.stringify(k);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

export function normalize(_req: unknown, ep: any, rows: Row[]): Row[] {
  const p = String(ep.path ?? "");
  if (p === "/documents.json") return dedupe(rows);
  if (!p.startsWith("/documents/facets/")) return rows;
  const out: Row[] = [];
  for (const r of rows) { // one flattened row: {"2025-01-01.count": 5, "2025-01-01.name": "2025"}
    const groups = new Map<string, Record<string, unknown>>();
    for (const [k, v] of Object.entries(r)) {
      const s = pyStr(k);
      const i = s.lastIndexOf(".");
      const key = i < 0 ? "" : s.slice(0, i), field = i < 0 ? s : s.slice(i + 1);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, {});
      groups.get(key)![field] = v;
    }
    for (const [key, g] of groups) out.push({ key, name: g.name ?? "", count: g.count ?? "" });
  }
  return out;
}

const adapter: Adapter = { normalize };
export default adapter;
