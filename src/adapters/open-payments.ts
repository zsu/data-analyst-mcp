/**
 * Open Payments adapter (DKAN datastore on openpaymentsdata.cms.gov).
 *
 * - Queries go to /api/1/datastore/query/{dataset_id}/0 (dataset id + distribution index). The pack names
 *   datasets by alias or id.
 * - limit is capped at 500 by this API (HTTP 400 above it, verified).
 * - Every column is stored as text, so sort and < > BETWEEN compare characters: checkSpec refuses comparisons
 *   against numbers or MM/DD/YYYY dates unless the condition sets text_compare_ok.
 * - The payment files are large (millions of rows a year): a filter is required on them (checkSpec).
 *
 * Friendly spec parameters (expanded by beforeRequest; manual links get the same expansion):
 *   where {"recipient_state": "VT"} (list value -> IN), conditions [{property, value, operator}],
 *   sort "col" | "-col" | [..], columns ["a", "b"].
 */
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyStr } from "../core/py.js";
import { pyRepr, pySplit, truthy } from "./_govinfo_py.js";

const HERE = path.join(PACKS_DIR, "open-payments");
const OPERATORS = new Set(["=", "<>", "<", "<=", ">", ">=", "LIKE", "IN", "NOT IN", "BETWEEN", "CONTAINS", "STARTS WITH"]);
const ORDERED = new Set(["<", "<=", ">", ">=", "BETWEEN"]);
const TEXT_TRAP = /^\s*(-?\d+(\.\d+)?|\d{1,2}\/\d{1,2}\/\d{4})\s*$/;
const BIG = /^(general|research|ownership)_\d{4}$/;
const TIMEOUT = 120;

function catalog(): Record<string, any> {
  return readJson(HERE, "endpoints.json")?.catalog || {};
}

function list(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  return (Array.isArray(v) ? v : [v]).map(pyStr);
}

const isDict = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const adapter: Adapter = {
  beforeRequest(_req, _ep, params) {
    const p: Record<string, unknown> = { ...params };
    const where = (truthy(p.where) ? p.where : {}) as Record<string, unknown>;
    delete p.where;
    const conds: any[] = Object.entries(where).map(([k, v]) => ({ property: k, value: v, operator: Array.isArray(v) ? "IN" : "=" }));
    conds.push(...((truthy(p.conditions) ? p.conditions : []) as any[]));
    delete p.conditions;
    conds.forEach((c, i) => {
      p[`conditions[${i}][property]`] = c.property;
      const op = pyStr(c.operator || "=").toUpperCase();
      if (Array.isArray(c.value)) c.value.forEach((v: unknown, j: number) => (p[`conditions[${i}][value][${j}]`] = v));
      else p[`conditions[${i}][value]`] = c.value ?? null;
      if (op !== "=") p[`conditions[${i}][operator]`] = ["IN", "NOT IN", "LIKE", "BETWEEN"].includes(op) ? op.toLowerCase() : op;
    });
    list(p.sort).forEach((s, i) => {
      p[`sorts[${i}][property]`] = s.replace(/^-+/, "");
      p[`sorts[${i}][order]`] = s.startsWith("-") ? "desc" : "asc";
    });
    delete p.sort;
    const cols = (truthy(p.columns) ? p.columns : []) as unknown;
    delete p.columns;
    (typeof cols === "string" ? cols.split(",").map((c) => c.trim()) : (cols as unknown[])).forEach((c, i) => {
      p[`properties[${i}]`] = c;
    });
    return p;
  },

  checkSpec(spec) {
    const probs: string[] = [];
    const cat = catalog();
    for (const r of spec.requests || []) {
      const prm = r.params || {};
      const name = pyRepr(r.name);
      if ("where" in prm && !isDict(prm.where)) probs.push(`request ${name}: where must be an object {column: value}`);
      let conds: any = prm.conditions;
      if (conds !== null && conds !== undefined && (!Array.isArray(conds) || !conds.every((c: any) => isDict(c) && "property" in c))) {
        probs.push(`request ${name}: conditions must be a list of {property, value, operator}`);
        conds = null;
      }
      for (const c of conds || []) {
        const op = pyStr(c.operator || "=").toUpperCase();
        const vals = Array.isArray(c.value) ? c.value : [c.value ?? null];
        if (!OPERATORS.has(op)) {
          probs.push(`request ${name}: operator ${pyRepr(c.operator ?? null)} is not one of ${pyRepr([...OPERATORS].sort((a, b) => (a < b ? -1 : 1)))}`);
        } else if (ORDERED.has(op) && !truthy(c.text_compare_ok) && vals.some((v: unknown) => TEXT_TRAP.test(v === null ? "None" : pyStr(v)))) {
          probs.push(`request ${name}: ${pyStr(c.property)} ${op} ${pyRepr(c.value ?? null)} would compare TEXT, not ` +
            "numbers or dates (every Open Payments column is stored as text: '91.06' > '900'). " +
            "Filter with equality (program_year, recipient_state, NPI) and compare with compute, " +
            'or set "text_compare_ok": true on the condition.');
        }
      }
      const alias = "dataset" in prm ? prm.dataset : r.dataset;
      if (typeof alias === "string" && BIG.test(alias) && !truthy(prm.where) && !truthy(conds)) {
        probs.push(`request ${name}: ${alias} has millions of rows; add a where or conditions filter ` +
          "(recipient_state, covered_recipient_npi, applicable_manufacturer_or_applicable_gpo_making_payment_name), " +
          "or use a summary table (state_totals, by_reporting_entity)");
      }
      if (typeof alias === "string" && !(alias in cat) && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(alias)) {
        probs.push(`request ${name}: dataset ${pyRepr(alias)} is neither a catalog alias nor a dataset UUID ` +
          "(see source_brief or a request_schema search)");
      }
    }
    return probs;
  },

  async fetch(spec, pack, _route) {
    return gr.fetchSpec(pack, spec, gr.clientFor(pack, undefined, { timeout: TIMEOUT }));
  },

  manualItems(spec, pack) {
    const items = gr.manualItems(pack, spec);          // core applies beforeRequest to the links
    for (const it of items) {
      it.note = (it.note ? it.note.replace(/\.+$/, "") + ". " : "") + "JSON page; or use the dataset page's Download button " +
        "(https://openpaymentsdata.cms.gov/dataset/<id>; payment files are several GB) and upload only the rows needed.";
    }
    return items;
  },
};

/** Live search of the Open Payments metastore (74 datasets), plus the catalog. */
export async function searchLive(query: string, pack: any): Promise<any[]> {
  const hits = gr.searchCatalog(pack, query);
  const words = pySplit(query.toLowerCase()).filter((w) => w.length > 1);
  let items: any;
  try {
    items = await gr.clientFor(pack, undefined, { timeout: 60 }).getJson("/api/1/metastore/schemas/dataset/items");
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    return [...hits, { note: `live metastore search unavailable (${e.kind}); catalog results only` }];
  }
  const known = new Set(hits.map((h: any) => h.id ?? null));
  const live: [number, any][] = [];
  for (const it of Array.isArray(items) ? items : []) {
    const text = `${it.title ?? ""} ${it.description ?? ""} ${(it.keyword || []).map(pyStr).join(" ")}`.toLowerCase();
    const s = words.reduce((n, w) => n + (text.split(w).length - 1), 0);
    if (s && !known.has(it.identifier ?? null)) {
      live.push([s, { id: it.identifier ?? null, name: it.title ?? null, endpoint: "query", modified: it.modified ?? null,
        temporal: it.temporal ?? null, page: `https://openpaymentsdata.cms.gov/dataset/${pyStr(it.identifier ?? "None")}` }]);
    }
  }
  const out = [...hits, ...live.sort((a, b) => b[0] - a[0]).map(([, h]) => h)].slice(0, 20);
  if (hits.length + live.length > 20) out.push({ note: "more than 20 matches; narrow the words" });
  return out;
}

// the Adapter type declares search synchronous; request_schema awaits its result, so the live search is used
adapter.search = searchLive as unknown as Adapter["search"];

export default adapter;
