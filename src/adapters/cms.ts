/**
 * CMS adapter: two APIs on data.cms.gov.
 *
 * provider  Provider Data Catalog (DKAN): /provider-data/api/1/datastore/query/{dataset_id}/{index}. The dataset id
 *           plus the distribution index is the documented form; index 0 is the dataset's CSV. limit is capped at 1500
 *           by the API; 500 a page is used because large pages take 30-50 s.
 * medicare  data-api: /data-api/v1/dataset/{uuid}/data with size/offset and filter[COLUMN]=value. An unknown filter
 *           column is silently ignored by the API (the whole table comes back) and an unknown column= name is silently
 *           dropped, so filter columns are always requested and normalize() fails the request when a filter or
 *           requested column is not in the returned rows. Suppressed cells arrive as the text "*"; normalize()
 *           empties them and adds a <column>_flag column ("suppressed (*)").
 *
 * Friendly spec parameters (expanded by beforeRequest; manual links get the same expansion):
 *   where      {"state": "VT"}   provider: conditions[i][property|value]; a list value -> IN
 *                                medicare: filter[STATE]=VT; a list value -> one IN condition group
 *   conditions [{"property", "value", "operator"}]   provider only
 *   sort       "col" | "-col" | [..]      provider: sorts[i][property|order]; medicare: sort=col / -col
 *   columns    ["a", "b"]                 provider: properties[i]; medicare: column=a,b
 * Provider columns are stored as text, so < > BETWEEN on numbers or MM/DD/YYYY dates compare characters; checkSpec
 * refuses such conditions unless text_compare_ok is set.
 */
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const OPERATORS = new Set(["=", "<>", "<", "<=", ">", ">=", "LIKE", "IN", "NOT IN", "BETWEEN", "CONTAINS", "STARTS WITH"]);
const ORDERED = new Set(["<", "<=", ">", ">=", "BETWEEN"]);
// numbers and US dates (MM/DD/YYYY) stored as text compare character by character
const TEXT_TRAP = /^\s*(-?\d+(\.\d+)?|\d{1,2}\/\d{1,2}\/\d{4})\s*$/;
const TIMEOUT = 120; // provider-data queries took up to 50 s when tested
const SUPPRESSED = "*"; // data-api text for a suppressed cell (small counts), verified 2026-10-22

/** Python repr() of a value in a message. */
function repr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (Array.isArray(v)) return `[${v.map(repr).join(", ")}]`;
  if (typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => `${repr(k)}: ${repr(x)}`).join(", ") + "}";
  return String(v);
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function kind(ep: any): "provider" | "medicare" {
  return String(ep.path ?? "").includes("/datastore/query/") ? "provider" : "medicare";
}

function sorts(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return [];
  return (Array.isArray(v) ? v : [v]).map(pyStr);
}

function columnsOf(v: unknown): string[] {
  if (typeof v === "string") return v.split(",").map((c) => c.trim());
  return Array.isArray(v) ? v : [];
}

function beforeRequest(_req: SpecRequest, ep: any, params: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = { ...params };
  const pop = (k: string) => {
    const v = p[k];
    delete p[k];
    return v;
  };
  const where: Record<string, any> = (pop("where") as any) || {};
  const conds: any[] = (pop("conditions") as any) || [];
  const sort = sorts(pop("sort"));
  let cols: any = pop("columns") || [];
  if (typeof cols === "string") cols = cols.split(",").map((c) => c.trim()).filter(Boolean);
  if (kind(ep) === "provider") {
    const allc = [...Object.entries(where).map(([k, v]) => ({ property: k, value: v, operator: Array.isArray(v) ? "IN" : "=" })), ...conds];
    allc.forEach((c, i) => {
      p[`conditions[${i}][property]`] = c.property;
      const op = pyStr(c.operator || "=").toUpperCase();
      if (Array.isArray(c.value)) c.value.forEach((v: unknown, j: number) => (p[`conditions[${i}][value][${j}]`] = v));
      else p[`conditions[${i}][value]`] = c.value ?? null;
      if (op !== "=") p[`conditions[${i}][operator]`] = ["IN", "NOT IN", "LIKE", "BETWEEN"].includes(op) ? op.toLowerCase() : op;
    });
    sort.forEach((s, i) => {
      p[`sorts[${i}][property]`] = s.replace(/^-+/, "");
      p[`sorts[${i}][order]`] = s.startsWith("-") ? "desc" : "asc";
    });
    (cols as unknown[]).forEach((c, i) => (p[`properties[${i}]`] = c));
  } else {
    Object.entries(where).forEach(([k, v], i) => {
      if (Array.isArray(v)) {
        // repeated filter[k]=a&filter[k]=b keeps only the LAST value (verified 2026-10-28): send a list as one IN
        // condition group, which the data-api honours alongside the plain equality filters
        const g = `in${i}`;
        p[`filter[${g}][condition][path]`] = k;
        p[`filter[${g}][condition][operator]`] = "IN";
        v.forEach((x, j) => (p[`filter[${g}][condition][value][${j + 1}]`] = x));
      } else p[`filter[${k}]`] = v;
    });
    if (sort.length) p.sort = sort[0];
    if ((cols as unknown[]).length) p.column = [...cols, ...Object.keys(where).filter((k) => !cols.includes(k))].join(",");
  }
  return p;
}

function checkSpec(spec: Spec, pack: Pack): string[] {
  const probs: string[] = [];
  const cat = pack.endpoints?.catalog || {};
  for (const r of spec.requests || []) {
    const prm: Record<string, any> = r.params || {};
    const name = repr(r.name ?? null);
    if ("where" in prm && !isObj(prm.where)) probs.push(`request ${name}: where must be an object {column: value}`);
    else if (Object.values(prm.where || {}).some((v) => Array.isArray(v) && !v.length)) {
      probs.push(`request ${name}: a where list must hold at least one value`);
    }
    const conds = prm.conditions;
    if (conds !== undefined && conds !== null) {
      if (!Array.isArray(conds) || !conds.every((c) => isObj(c) && "property" in c)) {
        probs.push(`request ${name}: conditions must be a list of {property, value, operator}`);
      } else {
        for (const c of conds) {
          const op = pyStr(c.operator || "=").toUpperCase();
          const vals = Array.isArray(c.value) ? c.value : [c.value ?? null];
          if (!OPERATORS.has(op)) {
            probs.push(`request ${name}: operator ${repr(c.operator ?? null)} is not one of ${repr([...OPERATORS].sort(cmp))}`);
          } else if (ORDERED.has(op) && !c.text_compare_ok && vals.some((v: unknown) => TEXT_TRAP.test(v === null ? "None" : pyStr(v)))) {
            probs.push(`request ${name}: ${pyStr(c.property)} ${op} ${repr(c.value ?? null)} would compare TEXT, not ` +
              "numbers or dates (the datastore stores these columns as text: '91.06' > '900'). " +
              "Fetch with equality filters and compare in analysis.py, or set " +
              '"text_compare_ok": true on the condition if a text comparison is really meant.');
          }
        }
      }
      if (r.endpoint === "medicare") {
        probs.push(`request ${name}: the medicare endpoint takes where (equality) and keyword, not conditions`);
      }
    }
    const alias = "dataset" in prm ? prm.dataset : r.dataset;
    if (typeof alias === "string" && alias in cat && r.endpoint && cat[alias].endpoint !== r.endpoint) {
      probs.push(`request ${name}: dataset ${repr(alias)} belongs to endpoint ${repr(cat[alias].endpoint)}`);
    }
  }
  return probs;
}

function normalize(req: SpecRequest, ep: any, rows: Row[]): Row[] {
  if (kind(ep) === "medicare" && rows.length) {
    const prm: Record<string, any> = req.params || {};
    const where: Record<string, any> = prm.where || {};
    const cols = columnsOf(prm.columns || []);
    const missing = [...Object.keys(where), ...cols].filter((k) => !(k in rows[0]));
    if (missing.length) {
      throw new DataError(`request ${repr(req.name ?? null)}: column(s) ${repr(missing)} are not in this dataset, and the ` +
        "data-api ignores unknown filter and column names (filters are dropped, so rows come back " +
        "unfiltered). Column names are " +
        `case-sensitive; the returned rows have: ${Object.keys(rows[0]).slice(0, 25).join(", ")}`, "bad_request");
    }
    for (const [k, v] of Object.entries(where)) { // a filter the API dropped would bring back other values: never keep them
      // (the data-api matches case-insensitively: vt finds VT, verified 2026-10-28)
      const allowed = new Set((Array.isArray(v) ? v : [v]).map((x) => pyStr(x).trim().toLowerCase()));
      const stray = [...new Set(rows.map((r) => pyStr(r[k])).filter((s) => !allowed.has(s.trim().toLowerCase())))].sort(cmp);
      if (stray.length) {
        throw new DataError(`request ${repr(req.name ?? null)}: the data-api did not apply the filter on ${repr(k)} (rows ` +
          `with ${repr(stray.slice(0, 5))} came back); fetch one request per value instead`, "api");
      }
    }
    flagSuppressed(rows);
  }
  return rows;
}

/** data-api suppressed cells are the text "*": make them empty and say so in a <column>_flag column. Columns that are
 * themselves flags (Part D prescribers' GE65_Sprsn_Flag holds "*" or "#" next to blank values) keep their text. */
function flagSuppressed(rows: Row[]): void {
  for (const r of rows) {
    for (const [c, v] of Object.entries(r)) {
      if (typeof v === "string" && v.trim() === SUPPRESSED && !c.toLowerCase().includes("flag")) {
        r[c] = "";
        r[`${c}_flag`] = "suppressed (*)";
      }
    }
  }
  // Python fills the missing flags in set order (it varies from run to run); here: in the order of their columns
  const order: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), order.push(k));
  const flagged = order.filter((k) => k.endsWith("_flag") && rows.some((r) => k in r && k.slice(0, -5) in r))
    .sort((a, b) => order.indexOf(a.slice(0, -5)) - order.indexOf(b.slice(0, -5)));
  for (const r of rows) for (const k of flagged) if (!(k in r)) r[k] = "";
}

/** Every column a request names: where, conditions, sort and columns. */
function namedColumns(prm: Record<string, any>): string[] {
  const cols = typeof prm.columns === "string" ? prm.columns.split(",").map((c: string) => c.trim()) : [...(prm.columns || [])];
  return [...new Set([...Object.keys(prm.where || {}),
    ...(prm.conditions || []).filter(isObj).map((c: any) => c.property),
    ...sorts(prm.sort).map((s) => s.replace(/^-+/, "")), ...cols])];
}

/** [named columns the Provider Data dataset does not have, its columns], from a one-row schema query. */
async function unknownColumns(client: Client, pack: Pack, req: SpecRequest): Promise<[string[], string[]]> {
  const [ep, params] = gr.resolve(pack, req);
  const p = String(ep.path).replace("{dataset}", pyStr(params.dataset ?? null) || "None").replace("{index}", pyStr(params.index ?? 0));
  const d = await client.getJson(p, { limit: 1, schema: "true" });
  const fields = Object.values<any>(d.schema || {}).flatMap((s) => Object.keys(s.fields || {}));
  return [namedColumns(req.params || {}).filter((c) => !fields.includes(c)), fields];
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const client = gr.clientFor(pack, undefined, { timeout: TIMEOUT });
  try {
    return await gr.fetchSpec(pack, spec, client);
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    // Provider Data answers HTTP 400 {"message": "Column not found."} without naming the column
    const m = /^request '([^']+)'/.exec(e.message);
    const req = m ? spec.requests.find((r) => r.name === m[1]) : undefined;
    if (e.status !== 400 || !e.message.toLowerCase().includes("column not found") || !req) throw e;
    let bad: string[], fields: string[];
    try {
      [bad, fields] = await unknownColumns(client, pack, req);
    } catch (e2) {
      if (e2 instanceof DataError) throw e;
      throw e2;
    }
    if (!bad.length) throw e;
    throw new DataError(`request ${repr(req.name)}: column(s) ${repr(bad)} are not in this dataset (used in where, conditions, ` +
      `sort or columns); its columns are: ${fields.slice(0, 40).join(", ")}`, "bad_request", 400);
  }
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items = gr.manualItems(pack, spec); // core applies beforeRequest to the links
  for (const it of items) {
    it.note = (it.note ? it.note.replace(/\.+$/, "") + ". " : "") + "JSON page; or open the dataset page and use its Download button " +
      "(full CSV, display-style column names).";
  }
  return items;
}

/** Live search of the Provider Data Catalog (237 datasets), plus the pack's catalog (Medicare data-api). */
async function search(query: string, pack: Pack): Promise<any[]> {
  const hits = gr.searchCatalog(pack, query);
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  let items: any;
  try {
    items = await gr.clientFor(pack, undefined, { timeout: 60 }).getJson("/provider-data/api/1/metastore/schemas/dataset/items");
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    return [...hits, { note: `live Provider Data search unavailable (${e.kind}); catalog results only` }];
  }
  const live: [number, any][] = [];
  const known = new Set(hits.map((h) => h.id));
  const text = (xs: any[]) => (xs || []).map((k) => (isObj(k) ? k.data ?? "" : pyStr(k))).join(" ");
  for (const it of Array.isArray(items) ? items : []) {
    const kw = text(it.keyword), theme = text(it.theme);
    const t = `${pyStr(it.title ?? "")} ${pyStr(it.description ?? "")} ${kw} ${theme}`.toLowerCase();
    const s = words.reduce((n, w) => n + t.split(w).length - 1, 0);
    if (s && !known.has(it.identifier)) {
      live.push([s, { id: it.identifier ?? null, name: it.title ?? null, endpoint: "provider", modified: it.modified ?? null, theme,
        page: `https://data.cms.gov/provider-data/dataset/${pyStr(it.identifier ?? null) || "None"}` }]);
    }
  }
  const ranked = live.sort((a, b) => b[0] - a[0]).map(([, h]) => h);
  const out = [...hits, ...ranked].slice(0, 20);
  if (hits.length + ranked.length > 20) out.push({ note: "more than 20 matches; narrow the words" });
  return out;
}

const adapter: Adapter = {
  fetch, checkSpec, beforeRequest, normalize, manualItems,
  search,
};
export default adapter;
