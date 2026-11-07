/**
 * OpenFEC pack hooks.
 *
 * - fetch: Schedules A, B and E page with keyset ("seek") pagination: each response's pagination.last_indexes
 *   (last_index plus the sort column's last value) goes into the next request. Other endpoints use the generic page
 *   paging.
 * - checkSpec: itemized schedules need at least one narrowing filter (the unfiltered tables hold hundreds of millions
 *   of rows).
 * - manualItems: links carry the public DEMO_KEY; seek endpoints give the first page only.
 * - keyOnlyNeeds: DEMO_KEY allows only a few requests an hour.
 */
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, Tables } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyJsonDumps, pyStr } from "../core/py.js";

const SEEK_FILTERS: Record<string, string[]> = {
  schedule_a: ["committee_id", "contributor_name", "contributor_employer", "contributor_occupation", "contributor_zip",
    "contributor_city"],
  schedule_b: ["committee_id", "recipient_name", "recipient_committee_id"],
  schedule_e: ["candidate_id", "committee_id"],
};
const DEMO_LIMIT = 8;

function repr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v !== "string") return pyStr(v);
  return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function eps(): Record<string, any> {
  return readJson(path.join(PACKS_DIR, "fec"), "endpoints.json").endpoints;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const need = SEEK_FILTERS[r.endpoint || ""];
    if (need && !need.some((k) => (r.params || {})[k])) {
      probs.push(`request ${repr(r.name ?? null)}: ${r.endpoint} needs one of ${need.join(", ")} (the unfiltered table is far too large)`);
    }
  }
  return probs;
}

type Meta = { pages: number; total: number | null; truncated: boolean };

async function seek(client: Client, ep: any, params0: Record<string, unknown>, maxRows: unknown): Promise<[Row[], Meta]> {
  const params = { ...params0 };
  const pp = params.per_page;
  delete params.per_page;
  const size = Math.min(Math.trunc(Number(pp || ep.paging.size || 100)), 100);
  const limit = Math.min(Math.trunc(Number(maxRows || ep.max_rows || 50000)), Math.trunc(Number(ep.max_rows || 50000)));
  const [p, query] = gr.split(ep, params);
  const q: Record<string, unknown> = { ...query, per_page: size };
  let rows: any[] = [];
  const meta: Meta = { pages: 0, total: null, truncated: false };
  const seen = new Set<string>();
  for (;;) {
    const data = (await client.get(p, q)).json();
    meta.pages++;
    const got: any[] = data.results || [];
    const pag = data.pagination || {};
    if (meta.total === null && pag.count !== undefined && pag.count !== null) meta.total = Math.trunc(Number(pag.count));
    rows = rows.concat(got);
    if (rows.length >= limit) {
      meta.truncated = (meta.total || 0) > limit || got.length >= size;
      rows = rows.slice(0, limit);
      break;
    }
    const last = pag.last_indexes || {};
    const key = pyJsonDumps(last, true);
    if (!got.length || got.length < size || !Object.keys(last).length || seen.has(key)) break;
    seen.add(key);
    for (const [k, v] of Object.entries(last)) if (v !== null && v !== undefined) q[k] = v;
  }
  return [gr.clean(rows, ep), meta];
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const tables: Tables = {};
  const notes: string[] = [];
  let client: Client | null = null;
  for (const r of spec.requests) {
    const [ep, params] = gr.resolve(pack, r);
    if (ep.paging?.type !== "seek") {
      const [t, n] = await gr.fetchSpec(pack, { requests: [r] });
      Object.assign(tables, t);
      notes.push(...n);
      continue;
    }
    client ??= gr.clientFor(pack);
    const [rows, meta] = await seek(client, ep, params, r.max_rows);
    if (meta.truncated) {
      notes.push(`${r.name}: stopped at ${rows.length.toLocaleString("en-US")} rows (max_rows); FEC reports about ` +
        `${(meta.total || 0).toLocaleString("en-US")} matching rows. Narrow the filter or raise max_rows.`);
    }
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${repr(r.name)} returned no rows: check the ids, cycle and filters (see source.md)`, "bad_request");
    }
    tables[r.name] = rows;
  }
  return [tables, notes];
}

function calls(spec: Spec): number {
  const all = eps();
  let n = 0;
  for (const r of spec.requests || []) {
    const ep = all[r.endpoint || ""] || {};
    const pg = ep.paging || {};
    const size = Math.trunc(Number((r.params || {}).per_page || pg.size || 100));
    const dflt = pg.type === "seek" ? ep.max_rows : size; // seek: no total known in advance
    n += Math.max(1, Math.ceil(Math.trunc(Number(r.max_rows || dflt || size)) / size));
  }
  return n;
}

function keyOnlyNeeds(spec: Spec): string[] {
  const n = calls(spec);
  return n > DEMO_LIMIT ? [`about ${n} API calls (the keyless DEMO_KEY allows only about 10 an hour on OpenFEC)`] : [];
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [ep, , probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const isSeek = ep.paging?.type === "seek";
    const rr = isSeek ? { ...r, max_rows: Math.min(Math.trunc(Number(r.max_rows || 100)), 100) } : r;
    for (const it of gr.manualItems(pack, { requests: [rr] })) {
      it.url += (it.url.includes("?") ? "&" : "?") + (isSeek ? "per_page=100&" : "") + "api_key=DEMO_KEY";
      let note = "DEMO_KEY is api.data.gov's public demo key (a few requests an hour); replace it with your own key";
      if (isSeek) note = "first 100 rows only (keyset paging needs the script route for more); " + note;
      it.note = (it.note ? it.note + "; " : "") + note;
      items.push(it);
    }
  }
  return items;
}

const adapter: Adapter = { fetch, checkSpec, keyOnlyNeeds, manualItems };
export default adapter;
