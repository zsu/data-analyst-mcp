/**
 * DOL API v4 adapter: dataset paths, filter_object building, case-tolerant name search, key-only needs.
 *
 * - Datasets are addressed as AGENCY/api_url (OSHA/inspection) or by catalog alias (osha_inspection); the
 *   catalog was built from the keyless Datasets API (https://apiprod.dol.gov/v4/datasets).
 * - filter_object: DOL takes one JSON object of {field, operator, value} conditions joined by {"and": [...]}
 *   or {"or": [...]}; operators eq, neq, gt, lt, in, not_in, like (DOL API User Guide). The pack builds it
 *   from `filters` ({field: value} eq, lists -> in, {"gt": ..} etc.), `search` and `state`, ANDed with any
 *   raw `filter_object`.
 * - search: DOL's "like" is case-sensitive and has no implicit wildcards, and there is no case-insensitive
 *   operator, so {field: text} becomes an OR of %text% in the spelling given, UPPER, lower and Title case.
 * - sort: defaults to the dataset's date field, descending (newest first), as listed in the catalog.
 * - Empty bodies (no match) count as zero rows. The key goes in the X-API-KEY query parameter.
 * - keyOnlyNeeds: everything except the keyless catalog endpoints (datasets, dataset_info) and the OUI files
 *   needs a key.
 * - Field names are checked against DOL's keyless field dictionary. checkSpec is synchronous here, so it checks
 *   the names of a dataset whose dictionary this process has already read; fetch reads the dictionary first and
 *   refuses unknown names before any data request.
 *
 * Unemployment insurance files of the Office of Unemployment Insurance (oui.doleta.gov, keyless, fixed names
 * refreshed in place; endpoints with "host": "oui"):
 * - ui_trust_fund: ETA 2112 (UI financial transaction summary), /unemploy/csv/ar2112.csv, one row per state and
 *   month since 1979, columns coded c1..c136, renamed from the data map (ET Handbook 402, table ar2112;
 *   endpoints.json "columns"): <line item>_<account>, account total, clearing, utf or bpa. The whole file (23 MB)
 *   is downloaded once per fetch and filtered here by state, month and fields.
 * - ui_data_summary: the UI Data Summary workbook (SummaryTables.xlsx, latest calendar-year quarter). Read from row
 *   1 so the quarter in the title row is kept (cyq); the header row is found by its first cell ("State").
 * These go to oui.doleta.gov with a client that has no credentials: the DOL API key is never sent there.
 */
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import { Client, DataError, Response } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { parsePyJson, pyFloatRepr, pyQuote, pyStr, pyUrlencode } from "../core/py.js";
import { readCsv, sheetRecords } from "../core/tabular.js";
import { pyRepr, state, StateError } from "./_dol_states.js";

const OUI = ["ui_trust_fund", "ui_data_summary"];
const KEYLESS = ["datasets", "dataset_info", ...OUI];
const OUI_BASE = "https://oui.doleta.gov";

const fmt = (n: number) => n.toLocaleString("en-US");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const blank = (v: unknown) => v === null || v === undefined || v === "";
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

let EPS: any = null;
function eps(): any {
  EPS ??= readJson(path.join(PACKS_DIR, "dol"), "endpoints.json");
  return EPS;
}

function entry(ds: unknown): any | null {
  const cat = eps().catalog;
  const k = pyStr(ds);
  if (typeof ds === "string" && ds in cat) return cat[ds];
  for (const c of Object.values<any>(cat)) if (String(c.id).toLowerCase() === k.toLowerCase()) return c;
  return null;
}

function keyOnlyNeeds(spec: Spec): string[] {
  const reqs = (spec.requests || []).filter((r) => !KEYLESS.includes(r.endpoint || "query"));
  if (!reqs.length) return [];
  const names = [...new Set(reqs.map((r) => (r.name === undefined ? "?" : pyStr(r.name))))].sort(cmp);
  return [`data queries (${names.join(", ")}); only the dataset catalog (datasets, dataset_info) is keyless`];
}

const FIELDS = new Map<string, Set<string> | null>();

/** Column names of one dataset from DOL's keyless field dictionary, or null when it cannot be read (then no name is
 * refused: the check is skipped, and a wrong name surfaces as the API's own HTTP 400). */
async function datasetFields(pack: Pack, datasetId: unknown): Promise<Set<string> | null> {
  const key = pyStr(datasetId);
  if (FIELDS.has(key)) return FIELDS.get(key)!;
  let cols = new Set<string>();
  try {
    const n = Number(datasetId);
    if (!Number.isInteger(n)) throw new TypeError("not an id");
    const doc = await gr.clientFor(pack, undefined, { retries: 0, timeout: 10 }).getJson(`/datasets/${n}`, null, { useKey: false });
    const meta = gr.dig(doc, "dataset.dataset_metadatum") || [];
    cols = new Set(meta.filter((m: any) => m?.column_name).map((m: any) => pyStr(m.column_name)));
  } catch (e) {
    if (!(e instanceof DataError || e instanceof TypeError || e instanceof SyntaxError)) throw e;
    cols = new Set();
  }
  FIELDS.set(key, cols.size ? cols : null);
  return FIELDS.get(key)!;
}

/** Every field a query request names: filters, search, sort_by and fields. */
function namedFields(p: any): string[] {
  const names: string[] = [...(isObj(p.filters) ? Object.keys(p.filters) : []), ...(isObj(p.search) ? Object.keys(p.search) : [])];
  if (p.sort_by) names.push(pyStr(p.sort_by));
  const f = p.fields;
  if (f) names.push(...(Array.isArray(f) ? f : pyStr(f).split(",")).map((x: unknown) => pyStr(x).trim()).filter(Boolean));
  return [...new Set(names)];
}

/** The field-name problem of one request, given the dataset's columns (null: none known). */
function fieldProblem(r: SpecRequest, e: any, named: string[], cols: Set<string> | null): string | null {
  const bad = named.filter((f) => cols && !cols.has(f));
  if (!bad.length || !cols) return null;
  return `request ${pyRepr(r.name ?? null)}: ${bad.map(pyRepr).join(", ")} not a field of ${e.id} (its fields: ` +
    `${[...cols].sort(cmp).join(", ")}). Field names are DOL's own (dataset_info lists them with meanings); ` +
    'if the API does have the field and the dictionary lacks it, set "check_fields": false on the request';
}

function fieldCheck(r: SpecRequest): [any, string[]] | null {
  if ((r.endpoint || "query") !== "query") return null;
  const p: any = r.params || {};
  const ds = p.dataset || r.dataset;
  const e = ds ? entry(ds) : null;
  const named = r.check_fields ?? true ? namedFields(p) : [];
  return named.length && e && e.dataset_id ? [e, named] : null;
}

function checkSpec(spec: Spec, _pack: Pack): string[] {
  let probs: string[] = [];
  for (const r of spec.requests || []) {
    if (r.endpoint && OUI.includes(r.endpoint)) {
      probs = probs.concat(checkOui(r));
      continue;
    }
    if ((r.endpoint || "query") !== "query") continue;
    const p: any = r.params || {};
    const n = pyRepr(r.name ?? null);
    const ds = p.dataset || r.dataset;
    const e = ds ? entry(ds) : null;
    if (ds && !e && !pyStr(ds).includes("/")) {
      probs.push(`request ${n}: unknown dataset ${pyRepr(ds)}: use a catalog alias (request_schema search) or AGENCY/api_url`);
    }
    if (p.state && !(e || {}).state_field) {
      probs.push(`request ${n}: 'state' is only known for datasets with a state field ` +
        "(osha_inspection, whd_enforcement, eta_ui_state_weekly_claims); use filters instead");
    }
    const fo = p.filter_object;
    if (typeof fo === "string") {
      try {
        JSON.parse(fo);
      } catch {
        probs.push(`request ${n}: filter_object is not valid JSON`);
      }
    }
    if (r.max_rows && Number(r.max_rows) > 100000) probs.push(`request ${n}: max_rows above 100,000: narrow the filters`);
    // field names: DOL's field dictionary is keyless; a dictionary already read is checked here (fetch reads it)
    const fc = fieldCheck(r);
    if (fc && FIELDS.has(pyStr(fc[0].dataset_id))) {
      const prob = fieldProblem(r, fc[0], fc[1], FIELDS.get(pyStr(fc[0].dataset_id))!);
      if (prob) probs.push(prob);
    }
  }
  return probs;
}

function variants(text: string): string[] {
  const out: string[] = [];
  const title = text.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  for (const v of [text, text.toUpperCase(), text.toLowerCase(), title]) {
    const w = v.includes("%") ? v : `%${v}%`;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** json.dumps(obj, separators=(",", ":")) (ensure_ascii). */
function compactJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : v > 0 ? "Infinity" : v < 0 ? "-Infinity" : "NaN";
  if (typeof v === "string") return JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  if (Array.isArray(v)) return "[" + v.map(compactJson).join(",") + "]";
  return "{" + Object.entries(v as object).map(([k, x]) => `${compactJson(k)}:${compactJson(x)}`).join(",") + "}";
}

class KeyErr extends Error {}

function buildFilter(params: Record<string, any>, e: any | null): string | null {
  const conds: any[] = [];
  const filters = params.filters || {};
  delete params.filters;
  for (const [field, v] of Object.entries<any>(filters)) {
    if (isObj(v)) for (const [op, val] of Object.entries(v)) conds.push({ field, operator: op, value: val });
    else if (Array.isArray(v)) conds.push({ field, operator: "in", value: [...v] });
    else conds.push({ field, operator: "eq", value: v });
  }
  const search = params.search || {};
  delete params.search;
  for (const [field, text] of Object.entries<any>(search)) {
    const alts = variants(pyStr(text)).map((w) => ({ field, operator: "like", value: w }));
    conds.push(alts.length === 1 ? alts[0] : { or: alts });
  }
  const st = params.state;
  delete params.state;
  if (st) {
    if (!e || !("state_field" in e)) throw new KeyErr("'state_field'");
    conds.push({ field: e.state_field, operator: "eq", value: pyStr(st).trim().toUpperCase() });
  }
  const raw = params.filter_object;
  delete params.filter_object;
  if (raw) conds.push(typeof raw === "string" ? JSON.parse(raw) : raw);
  if (!conds.length) return null;
  return compactJson(conds.length === 1 ? conds[0] : { and: conds });
}

/** [endpoint with the path filled in, query params, notes] for one request. */
function prepare(req: SpecRequest, ep: any, params0: Record<string, unknown>): [any, Record<string, unknown>, string[]] {
  const params: Record<string, any> = { ...params0 };
  const kind = req.endpoint || "query";
  const notes: string[] = [];
  if (kind === "dataset_info") {
    let v = pyStr(params.dataset_id === undefined ? "None" : params.dataset_id);
    if (!/^\d+$/.test(v)) {
      const e = entry(v) || entry((req.params || {}).dataset_id ?? "");
      if (!e) throw new KeyErr(`dataset_id ${pyRepr(v)} is not a numeric id or catalog alias`);
      v = pyStr(e.dataset_id);
    }
    return [{ ...ep, path: `/datasets/${v}`, params: {} }, {}, notes];
  }
  if (kind !== "query") return [ep, params, notes];
  const raw = (req.params || {}).dataset || req.dataset;
  const e = entry(raw) || entry(params.dataset ?? "");
  const ds = e ? String(e.id) : pyStr(params.dataset === undefined ? "None" : params.dataset);
  delete params.dataset;
  const i = ds.indexOf("/");
  const [agency, endpoint] = i < 0 ? [ds, ""] : [ds.slice(0, i), ds.slice(i + 1)];
  if ("sort_by" in params && blank(params.sort_by)) { // explicit: the API's own order
    delete params.sort_by;
    delete params.sort;
  } else if (e && e.sort_by && !params.sort_by) {
    params.sort_by = e.sort_by;
    if (!("sort" in params)) params.sort = "desc";
  } else if (params.sort_by) {
    if (!("sort" in params)) params.sort = "desc";
  }
  const fo = buildFilter(params, e);
  if (fo) {
    params.filter_object = fo;
    notes.push(`${req.name}: filter_object ${fo}`);
  }
  if (e && e.columns && Object.keys(e.columns).length) {
    notes.push(`${req.name}: column meanings: ` + Object.entries(e.columns).map(([k, v]) => `${k} = ${pyStr(v)}`).join("; "));
  }
  return [{ ...ep, path: `/get/${pyQuote(agency)}/${pyQuote(endpoint)}/json`, params: {} }, params, notes];
}

/** Client wrapper: an empty 200/204 body means no rows. */
function emptyOk(c: Client): Client {
  const w = Object.create(c) as Client;
  w.request = async (method: string, p = "", params?: Record<string, unknown> | null, o: any = {}): Promise<Response> => {
    const r = await c.request(method, p, params, { jsonBody: o.jsonBody, okStatuses: [200, 204] });
    if (r.status === 204 || !r.body.toString("latin1").trim()) r.body = Buffer.from('{"data": [], "datasets": []}');
    return r;
  };
  return w;
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  // the field dictionary first (keyless): unknown names are refused before any data request
  const probs0: string[] = [];
  for (const r of spec.requests) {
    const fc = fieldCheck(r);
    if (!fc) continue;
    const prob = fieldProblem(r, fc[0], fc[1], await datasetFields(pack, fc[0].dataset_id));
    if (prob) probs0.push(prob);
  }
  if (probs0.length) throw new DataError(`${pack.id}: the request has problems: ${probs0.join("; ")}`, "spec");
  const client = emptyOk(gr.clientFor(pack));
  const tables: Tables = {};
  let notes: string[] = [];
  const files = new Map<string, Buffer>();
  for (const r of spec.requests) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    if (r.endpoint && OUI.includes(r.endpoint)) {
      const [rows, n] = await fetchOui(pack, r, ep, params, files);
      tables[r.name] = rows;
      notes = notes.concat(n);
      continue;
    }
    let ep2: any, q: Record<string, unknown>, n: string[];
    try {
      [ep2, q, n] = prepare(r, ep, params);
    } catch (e) {
      if (e instanceof KeyErr || e instanceof SyntaxError) throw new DataError(`request ${pyRepr(r.name)}: ${e.message}`, "bad_request");
      throw e;
    }
    const [rows, meta] = await gr.fetchRequest(client, ep2, q, r.max_rows);
    if (meta.truncated) notes.push(`${r.name}: stopped at ${fmt(rows.length)} rows (max_rows); narrow the filters or raise max_rows`);
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${pyRepr(r.name)} returned no rows: DOL 'eq' and 'like' are exact and ` +
        "case-sensitive; check the values (or use search) and the field names (dataset_info)", "bad_request");
    }
    tables[r.name] = rows;
    notes = notes.concat(n);
  }
  return [tables, notes];
}

/** urllib.parse.urlencode(q) without doseq: a list is sent as its Python str(). */
function urlencodeNoSeq(q: Record<string, unknown>): string {
  return pyUrlencode(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) || isObj(v) ? pyRepr(v) : v] as [string, unknown]));
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const base = String(pack.endpoints.base_url).replace(/\/+$/, "");
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    if (r.endpoint && OUI.includes(r.endpoint)) {
      items.push({ name: `${r.name}#1`, request: r.name, url: ep.path, filename: String(ep.path).split("/").pop(), needs_key: false,
        method: "GET", body: null, note: "the whole file (ar2112.csv is about 23 MB); the ingest filters it as the spec says" });
      continue;
    }
    let ep2: any, q: Record<string, unknown>;
    try {
      [ep2, q] = prepare(r, ep, params);
    } catch (e) {
      if (e instanceof KeyErr || e instanceof SyntaxError) continue;
      throw e;
    }
    const keyed = !KEYLESS.includes(r.endpoint || "query");
    const pg = ep2.paging || { type: "none" };
    const size = Number(pg.size || 1000);
    let pages = 1;
    if (pg.type === "offset") pages = Math.min(25, Math.max(1, Math.ceil(Number(r.max_rows || ep2.max_rows || size) / size)));
    for (let i = 0; i < pages; i++) {
      const qq: Record<string, unknown> = { ...q };
      if (pg.type === "offset") [qq[pg.limit_param], qq[pg.offset_param]] = [size, i * size];
      let url = `${base}${ep2.path}` + (Object.keys(qq).length ? "?" + urlencodeNoSeq(qq) : "");
      if (keyed) url += (url.includes("?") ? "&" : "?") + "X-API-KEY={API_KEY}";
      items.push({ name: `${r.name}#${i + 1}`, request: r.name, url, filename: pages === 1 ? `${r.name}.json` : `${r.name}_${i + 1}.json`,
        needs_key: keyed, method: "GET", body: null,
        note: pages === 1 ? "" : `page ${i + 1} of up to ${pages}; stop when "data" comes back empty` });
    }
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [ep, params] = gr.resolve(pack, req);
  const sorted = [...files].sort(cmp);
  if (req.endpoint && OUI.includes(req.endpoint)) {
    const p = sorted[sorted.length - 1];
    return tidyOui(req, ep, params, fs.readFileSync(p), path.basename(p))[0];
  }
  let rows: any[] = [];
  for (const p of sorted) {
    const data = fs.readFileSync(p);
    if (!data.toString("latin1").trim()) continue;
    const doc = parsePyJson(data.toString("utf8").replace(/^\ufeff/, ""));
    rows = rows.concat(gr.dig(doc, ep.records ?? "data") || []);
  }
  return gr.clean(rows, ep);
}

// ---------------------------------------------------------------------- OUI unemployment insurance files
class OuiError extends Error {}

function usps(x: unknown): string {
  const s = pyStr(x).trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  try {
    return state(s, "usps");
  } catch (e) {
    if (e instanceof StateError) throw new OuiError(`unknown state ${pyRepr(x)}: use a two-letter code (WY)`);
    throw e;
  }
}

function states(v: unknown): Set<string> {
  const vals = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
  return new Set(vals.filter((x) => pyStr(x).trim()).map(usps));
}

function bound(v: unknown, end: boolean): string | null {
  if (blank(v)) return null;
  const s = pyStr(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return s + (end ? "-31" : "-01");
  if (/^\d{4}$/.test(s)) return s + (end ? "-12-31" : "-01-01");
  throw new OuiError(`${end ? "end" : "start"} ${pyRepr(v)}: use YYYY-MM or YYYY-MM-DD`);
}

function fieldList(f: unknown): string[] {
  return Array.isArray(f) ? f.map((x) => pyStr(x)) : pyStr(f).split(",");
}

function checkOui(r: SpecRequest): string[] {
  const p: any = r.params || {}, name = pyRepr(r.name ?? null), probs: string[] = [];
  if (r.endpoint !== "ui_trust_fund") return probs;
  try {
    states(p.state);
  } catch (e) {
    if (!(e instanceof OuiError)) throw e;
    probs.push(`request ${name}: ${e.message}`);
  }
  for (const k of ["start", "end"]) {
    try {
      bound(p[k], k === "end");
    } catch (e) {
      if (!(e instanceof OuiError)) throw e;
      probs.push(`request ${name}: ${e.message}`);
    }
  }
  if (p.fields) {
    const cols = eps().endpoints.ui_trust_fund.columns;
    const vals = new Set(Object.values(cols));
    const bad = fieldList(p.fields).map((x) => x.trim()).filter((x) => x && !(x in cols) && !vals.has(x) && x !== "st" && x !== "rptdate");
    if (bad.length) {
      probs.push(`request ${name}: unknown field(s) ${bad.map(pyRepr).join(", ")}: ui_trust_fund columns are ` +
        "<line item>_<account> names such as balance_close_utf, dep_ui_contributions_total, " +
        "dis_ui_benefits_total, dep_treasury_interest_utf (endpoints.json 'columns' lists all), or the file's c-codes");
    }
  }
  return probs;
}

/** One OUI file (downloaded once per fetch, keyless) filtered and renamed as the request says. */
async function fetchOui(pack: Pack, r: SpecRequest, ep: any, params: Record<string, any>, files: Map<string, Buffer>): Promise<[Row[], string[]]> {
  const url: string = ep.path;
  if (!files.has(url)) {
    const L = pack.policy.limits;
    const c = new Client(OUI_BASE, { name: "dol (oui.doleta.gov)", auth: {}, rps: L.rps || 2, burst: L.burst || 4, timeout: 120,
      deadline: 600 });
    try {
      files.set(url, (await c.request("GET", url)).body);
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      throw new DataError(`request ${pyRepr(r.name)} (${r.endpoint}): ${e.message}`, e.kind, e.status);
    }
  }
  let out: [Row[], string[]];
  try {
    out = tidyOui(r, ep, params, files.get(url)!, url.split("/").pop()!);
  } catch (e) {
    if (e instanceof OuiError) throw new DataError(e.message, "bad_request");
    throw e;
  }
  if (!out[0].length && !r.allow_empty) {
    throw new DataError(`request ${pyRepr(r.name)} returned no rows: check state and the month range (the file runs ` +
      "from 1979-01 to the latest month each state has reported)", "bad_request");
  }
  return out;
}

const TRUE = (v: unknown) => v === true || v === 1 || v === "true" || v === "True" || v === "1";

export function tidyOui(req: SpecRequest, ep: any, params: Record<string, any>, body: Buffer, fname: string): [Row[], string[]] {
  if (req.endpoint === "ui_data_summary") return dataSummary(req, ep, params, body);
  const text = new TextDecoder("utf-8").decode(body);
  const first = text.trim() ? text.slice(0, 200).split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)[0] : "";
  if ((!first.includes('"st"') && !first.startsWith("st,")) || !first.includes("rptdate")) {
    throw new DataError(`${fname}: expected the ETA 2112 CSV (header st, rptdate, c1, ...), got something else (an HTML page?)`, "api");
  }
  const cols: Record<string, string> = ep.columns || {};
  const sts = states(params.state);
  const lo = bound(params.start, false), hi = bound(params.end, true);
  let want: Set<string> | null = null;
  if (params.fields) want = new Set(fieldList(params.fields).map((x) => cols[x.trim()] ?? x.trim()));
  const missing = new Set<string>(ep.missing || [""]);
  let rows: Row[] = [];
  for (const rec of readCsv(text)) {
    const st = (rec.st ?? "") as string, d = (rec.rptdate ?? "") as string;
    if ((sts.size && !sts.has(st)) || (lo && d < lo) || (hi && d > hi)) continue;
    const out: Row = { st, rptdate: d };
    for (const [k, v] of Object.entries(rec)) {
      if (k === "st" || k === "rptdate") continue;
      const name = cols[k] ?? k;
      if (want === null || want.has(name)) out[name] = v === null || v === undefined || missing.has(String(v).trim()) ? "" : v;
    }
    rows.push(out);
  }
  const notes: string[] = [];
  if (TRUE(params.latest)) {
    const last = new Map<string, string>();
    for (const x of rows) {
      const cur = last.get(x.st as string) ?? "";
      last.set(x.st as string, (x.rptdate as string) > cur ? (x.rptdate as string) : cur);
    }
    rows = rows.filter((x) => x.rptdate === last.get(x.st as string));
    const top = [...last.values()].reduce((m, v) => (v > m ? v : m), "");
    const lag = [...last].filter(([, d]) => d !== top).map(([s, d]) => `${s} ${d.slice(0, 7)}`).sort(cmp);
    if (lag.length) {
      notes.push(`${req.name}: latest month per state; the newest month in the file is ${top.slice(0, 7)}, these ` +
        `states have not reported it yet: ${lag.join(", ")}`);
    }
  }
  if (rows.length) {
    const ds = rows.map((x) => x.rptdate as string);
    const mn = ds.reduce((m, v) => (v < m ? v : m)), mx = ds.reduce((m, v) => (v > m ? v : m));
    notes.push(`${req.name}: ETA 2112 (${fname}), ${fmt(rows.length)} state-months ${mn.slice(0, 7)} to ${mx.slice(0, 7)}; amounts in ` +
      "dollars; the state's trust fund balance at month end is balance_close_utf (c87); " +
      "<item>_total is the sum of the clearing, utf and bpa accounts (column C of the report)");
  }
  return [rows, notes];
}

function summaryCol(h: string): string {
  let s = h.replaceAll("*", "").trim();
  let unit = "";
  if (s.includes("(000)")) [s, unit] = [s.replaceAll("(000)", ""), "thousands"];
  s = s.replaceAll("(%)", " pct").replaceAll("%", " pct ");
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return [slug, unit].filter(Boolean).join("_");
}

/** A number as the workbook stores it ('319139.59999999998') in its shortest form ('319139.6'). Text is kept as is. */
function num(v: string): string {
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v || "")) return v;
  const f = Number(v);
  if (Number.isInteger(f) && !v.toLowerCase().includes("e") && !v.includes(".")) return BigInt(f).toString();
  return pyFloatRepr(f);
}

/** SummaryTables.xlsx, one sheet: the quarter from the title row, the header found by its first cell. */
function dataSummary(req: SpecRequest, ep: any, params: Record<string, any>, body: Buffer): [Row[], string[]] {
  const e2 = gr.withRecordParams(ep, params);
  const rows = gr.clean(sheetRecords(e2, body), e2);
  const keys: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const head = keys.map((k) => (/^col\d+$/.test(k) ? "" : k));
  const grid: string[][] = [head, ...rows.map((r) => keys.map((k) => pyStr(k in r ? r[k] : "").trim()))];
  const cyq = head.find((c) => /^\d{4}\.[1-4]$/.test(c)) ?? "";
  const li = grid.findIndex((g) => g.length && g[0] === "State");
  if (li < 0) {
    throw new DataError(`SummaryTables.xlsx sheet ${pyRepr(e2.sheet ?? null)}: the layout changed (no 'State' header row); ` +
      "open the file and check", "api");
  }
  const names = ["state", ...grid[li].slice(1).filter(Boolean).map(summaryCol)];
  const data: Record<string, string>[] = [];
  const foot: string[] = [];
  for (const g of grid.slice(li + 1)) {
    if (!g.slice(1, names.length).some(Boolean)) {
      if (g.length && g[0]) foot.push(g[0]);
      continue;
    }
    const vals = [g[0], ...g.slice(1, names.length).map(num)];
    const d: Record<string, string> = {};
    for (let i = 0; i < Math.min(names.length, vals.length); i++) d[names[i]] = vals[i];
    data.push(d);
  }
  const starred = foot.find((f) => f.startsWith("*"));
  const star = starred !== undefined ? starred.replace(/^\*+/, "").trim() : "";
  let quarterEnd = "";
  if (cyq) {
    const [y, q] = cyq.split(".");
    quarterEnd = `${y}-${["03-31", "06-30", "09-30", "12-31"][Number(q) - 1]}`;
  }
  const out: Row[] = data.map((d) => {
    let name = d.state;
    const flagged = name.endsWith("*");
    name = name.replace(/\*+$/, "").trim();
    let code: string;
    try {
      code = name === "United States" ? "US" : usps(name === "Virgin Islands" ? "U.S. Virgin Islands" : name);
    } catch (e) {
      if (!(e instanceof OuiError)) throw e;
      code = "";
    }
    const rest = Object.fromEntries(Object.entries(d).filter(([k]) => k !== "state"));
    return { cyq, quarter_end: quarterEnd, state: name, st: code, ...rest, note: flagged ? star : "" };
  });
  const notes = [`${req.name}: UI Data Summary, sheet ${pyStr(e2.sheet ?? "None")}, calendar-year quarter ${cyq}` +
    (foot.length ? ": " + foot.join(" ") : "")];
  return [out, notes];
}

function search(query: string, pack: Pack): any[] {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1);
  const scored: [number, any][] = [];
  for (const h0 of gr.searchCatalog(pack, query, 500)) {
    const h = Object.fromEntries(Object.entries(h0).filter(([k]) => k !== "columns"));
    const text = Object.values(h).map((v) => pyStr(v)).join(" ").toLowerCase();
    scored.push([words.filter((w) => text.includes(w)).length, h]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, h]) => h).slice(0, 20);
}

const adapter: Adapter = { keyOnlyNeeds, checkSpec, fetch, manualItems, parseUpload, search, tidyOui, fetchOui, prepare };
export default adapter;
