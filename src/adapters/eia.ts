/**
 * EIA API v2 adapter: route paths, bracket parameters, state facets, withheld-value flags.
 *
 * - Routes are paths in the v2 tree (electricity/retail-sales, seds, petroleum/pri/spt) or catalog aliases;
 *   the pack fills /{route}/data/ itself because routes contain slashes.
 * - data params: `data` (list of columns, default ["value"] or the catalog's), `facets` ({facet: [values]}),
 *   `frequency`, `start`, `end`, `sort` ([{"column", "direction"}] or "period:desc"; default period desc)
 *   become EIA's bracket parameters data[0]=, facets[stateid][]=, sort[0][column]=. Raw bracket params
 *   pass through unchanged. `state` fills the route's state facet (stateid, stateId or location, from the
 *   catalog) with the USPS code; `msn` fills the route's MSN facet (seriesId in SEDS, msn in total-energy);
 *   a bare year as start/end of a sub-annual series is widened to the whole year.
 * - normalize: values stay as published; non-numeric markers in data columns ("W" withheld, "NA", "--",
 *   "NM") become empty cells with a `<column>_flag` column holding the marker.
 * - checkError: {"error": ...} bodies (bad facet, bad route, missing key) become errors.
 * - Without EIA_API_KEY the client sends api.data.gov's DEMO_KEY.
 * - keylessFiles / parseUpload: a petroleum request for one series (facets {"series": [id]}) is also in EIA's
 *   keyless history file www.eia.gov/dnav/pet/hist_xls/<series><d|w|m|a>.xls, which ingest reads (with the xlsx
 *   package, the cells as Python's xlrd gave them) and cuts to the request's dates.
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { PACKS_DIR } from "../core/env.js";
import { readJson } from "../core/policy.js";
import { parsePyJson, pyQuote, pyStr, pyUrlencode } from "../core/py.js";
import { pyRepr, state, StateError } from "./_dol_states.js";

const MARKERS = new Set(["W", "NA", "--", "NM", "(s)", "*", "-", "w", "na"]);
const fmt = (n: number) => n.toLocaleString("en-US");
const has = (o: any, k: string) => o !== null && o !== undefined && o[k] !== undefined && o[k] !== null;

let EPS: any = null;
/** The pack's endpoints.json (core.packfiles.read_json in Python). */
function catalog(): Record<string, any> {
  EPS ??= readJson(path.join(PACKS_DIR, "eia"), "endpoints.json");
  return EPS.catalog || {};
}

function usps(x: unknown): string {
  const s = String(x ?? "None").trim();
  if (s.toUpperCase() === "US") return "US";
  return state(s, "usps");
}

export function normRoute(r: unknown): string {
  const s = String(r || "").trim().replace(/^\/+|\/+$/g, "");
  return s.replace(/\/data$/, "");
}

function entry(route: string): any | null {
  for (const c of Object.values<any>(catalog())) if (c.kind === "route" && c.id === route) return c;
  return null;
}

function checkError(_status: number, body: Buffer): string | null {
  const head = body.subarray(0, 400).toString("latin1").trimStart();
  if (!head.startsWith("{") || !head.includes('"error"')) return null;
  let e: any;
  try {
    const d = parsePyJson(body.toString("utf8").replace(/^\ufeff/, ""));
    e = d && typeof d === "object" ? d.error ?? null : null;
  } catch {
    return null;
  }
  if (e && typeof e === "object" && !Array.isArray(e)) e = `${pyStr(e.code ?? "")}: ${pyStr(e.message ?? "")}`;
  return e ? `EIA API error: ${pyStr(e)}` : null;
}

function checkSpec(spec: Spec, pack: Pack): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: any = r.params || {};
    if ((r.endpoint || "data") !== "data") continue;
    const cat = catalog();
    const raw = p.route || r.dataset;
    const route = normRoute(typeof raw === "string" && cat[raw] ? cat[raw].id : raw);
    const e = entry(route);
    const n = pyRepr(r.name ?? null);
    if (!route) probs.push(`request ${n}: give a route (electricity/retail-sales, seds, ...)`);
    if (has(p, "state") && !(e || {}).state_facet) {
      probs.push(`request ${n}: 'state' is only known for routes with a state facet ` +
        "(seds, electricity/retail-sales, ...); use facets with the route's facet id");
    }
    if (has(p, "state")) {
      try {
        for (const s of Array.isArray(p.state) ? p.state : [p.state]) usps(s);
      } catch (ex) {
        if (!(ex instanceof StateError)) throw ex;
        probs.push(`request ${n}: ${ex.message}`);
      }
    }
    if (e && p.frequency && e.frequency && !e.frequency.includes(p.frequency)) {
      probs.push(`request ${n}: frequency ${pyRepr(p.frequency)} is not offered by ${route} (${e.frequency.join(", ")})`);
    }
  }
  return probs;
}

// A bare year as start/end of a sub-annual series is read by the API as that year's first period, so
// end=2023 on monthly data stops at 2023-01 without a warning (verified 2026-10). Widen it to the whole year.
const YEAR_BOUNDS: Record<string, [string, string]> = { monthly: ["-01", "-12"], quarterly: ["-Q1", "-Q4"],
  weekly: ["-01-01", "-12-31"], daily: ["-01-01", "-12-31"], hourly: ["-01-01T00", "-12-31T23"],
  "local-hourly": ["-01-01T00", "-12-31T23"] };

export function wholeYear(value: unknown, frequency: unknown, key: string): any {
  const s = value === null || value === undefined || value === "" ? null : pyStr(value).trim();
  if (s && s.length === 4 && /^\d+$/.test(s) && typeof frequency === "string" && frequency in YEAR_BOUNDS) {
    return s + YEAR_BOUNDS[frequency][key === "start" ? 0 : 1];
  }
  return s === null ? null : value;
}

class Bad extends Error {}

/** [endpoint with the path filled in, query params] for one request. */
export function prepare(req: SpecRequest, ep: any, params0: Record<string, unknown>): [any, Record<string, unknown>] {
  const params: Record<string, any> = structuredClone(params0);
  const kind = req.endpoint || "data";
  const route = normRoute(params.route ?? "");
  delete params.route;
  const e = entry(route) || {};
  if (kind === "facet_values") {
    if (!("facet" in params)) throw new Bad("'facet'");
    const facet = params.facet;
    delete params.facet;
    return [{ ...ep, path: `/${route}/facet/${pyQuote(pyStr(facet))}/`, params: {} }, params];
  }
  if (["routes", "facets", "metadata"].includes(kind)) return [{ ...ep, path: route ? `/${route}/` : "/", params: {} }, params];
  const q: Record<string, unknown> = {};
  const data = params.data || e.data_default || ["value"];
  delete params.data;
  (typeof data === "string" ? [data] : data).forEach((d: unknown, i: number) => (q[`data[${i}]`] = d));
  const facets: Record<string, any> = { ...(params.facets || {}) };
  delete params.facets;
  const st = params.state;
  delete params.state;
  if (st !== undefined && st !== null) {
    if (!("state_facet" in e)) throw new Bad("'state_facet'");
    facets[e.state_facet] = (Array.isArray(st) ? st : [st]).map(usps);
  }
  const msn = params.msn;
  delete params.msn;
  if (msn !== undefined && msn !== null) {
    // the MSN facet is named per route: seriesId in SEDS, msn in total-energy (verified 2026-10)
    const name = ["seriesId", "msn"].find((f) => (e.facets || []).includes(f)) ?? "seriesId";
    facets[name] = (Array.isArray(msn) ? msn : [msn]).map((m: unknown) => pyStr(m).toUpperCase());
  }
  for (const [f, vals] of Object.entries(facets)) q[`facets[${f}][]`] = Array.isArray(vals) ? vals : [vals];
  let sort: any = params.sort || [{ column: "period", direction: "desc" }];
  delete params.sort;
  if (typeof sort === "string") {
    sort = sort.split(",").map((s: string) => ({ column: s.split(":")[0], direction: [...s.split(":"), "desc"][1] }));
  }
  sort.forEach((s: any, i: number) => {
    q[`sort[${i}][column]`] = s.column;
    q[`sort[${i}][direction]`] = s.direction ?? "desc";
  });
  if (e.frequency && !params.frequency) params.frequency = e.default_frequency || e.frequency[0];
  for (const key of ["start", "end"]) {
    params[key] = wholeYear(params[key], params.frequency, key);
    if (params[key] === null) delete params[key];
  }
  Object.assign(q, params);
  return [{ ...ep, path: `/${route}/data/`, params: {} }, q];
}

const badRequest = (r: SpecRequest, e: unknown): DataError =>
  new DataError(`request ${pyRepr(r.name)}: ${e instanceof Error ? e.message : String(e)}`, "bad_request");

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const client = gr.clientFor(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    let ep2: any, q: Record<string, unknown>;
    try {
      [ep2, q] = prepare(r, ep, params);
    } catch (e) {
      if (e instanceof Bad || e instanceof StateError) throw badRequest(r, e);
      throw e;
    }
    let [rows, meta] = await gr.fetchRequest(client, ep2, q, r.max_rows);
    rows = normalize(r, ep2, rows);
    if (meta.truncated) {
      notes.push(`${r.name}: stopped at ${fmt(rows.length)} rows (max_rows)` + (meta.total ? ` of ${fmt(meta.total)}` : "") +
        "; narrow the facets or dates");
    }
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${pyRepr(r.name)} returned no rows: check the facet values (facet_values ` +
        "endpoint), the frequency and the start/end format (YYYY, YYYY-MM, YYYY-MM-DD)", "bad_request");
    }
    if ((r.endpoint || "data") === "data") notes.push(`${r.name}: route ${ep2.path} frequency ${pyStr(q.frequency ?? "(default)")}`);
    tables[r.name] = rows;
  }
  return [tables, notes];
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  if ((req.endpoint || "data") !== "data" || !rows.length) return rows;
  const p: any = req.params || {};
  const data = p.data || ["value"];
  const cols: string[] = typeof data === "string" ? [data] : [...data];
  for (const r of rows) {
    for (const c of cols) {
      const v = r[c];
      if (typeof v === "string" && MARKERS.has(v.trim())) {
        r[`${c}_flag`] = v.trim();
        r[c] = "";
      }
    }
  }
  const flagged = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (k.endsWith("_flag")) flagged.add(k);
  for (const r of rows) for (const k of flagged) if (!(k in r)) r[k] = "";
  return rows;
}

async function ping(client: Client) {
  try {
    await client.get("/");
    return { auth_ok: true, kind: "", detail: "route list answered with the key" };
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    return { auth_ok: !["auth", "key_missing"].includes(e.kind), kind: e.kind, detail: e.message };
  }
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const base = String(pack.endpoints.base_url).replace(/\/+$/, "");
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    let ep2: any, q: Record<string, unknown>;
    try {
      [ep2, q] = prepare(r, ep, params);
    } catch (e) {
      if (e instanceof Bad || e instanceof StateError) continue;
      throw e;
    }
    const pg = ep2.paging || { type: "none" };
    const size = Number(pg.size || 5000);
    let pages = 1;
    if (pg.type === "offset") pages = Math.min(25, Math.max(1, Math.ceil(Number(r.max_rows || size) / size)));
    for (let i = 0; i < pages; i++) {
      const qq: Record<string, unknown> = { ...q };
      if (pg.type === "offset") [qq[pg.limit_param], qq[pg.offset_param]] = [size, i * size];
      qq.api_key = "DEMO_KEY";
      const url = `${base}${ep2.path}?` + pyUrlencode(qq);
      const kf = dnavFile(r, params);
      items.push({ name: `${r.name}#${i + 1}`, request: r.name, url,
        filename: pages === 1 ? `${r.name}.json` : `${r.name}_${i + 1}.json`, needs_key: false, method: "GET", body: null,
        alt_filenames: kf ? [kf.filename] : [],
        note: "DEMO_KEY allows only a few requests an hour: put your own key in its place if the link answers OVER_RATE_LIMIT" +
          (pages === 1 ? "" : `; page ${i + 1} of up to ${pages}, stop when data is empty`) +
          (kf ? `; without a key, EIA's file ${kf.url} (as downloaded) holds the same series` : "") });
    }
  }
  return items;
}

// ---------------------------------------------------------------------- dnav history files (the keyless route)
// EIA publishes every petroleum series of the dnav tables as a keyless Excel 97 workbook, one series per file:
// www.eia.gov/dnav/pet/hist_xls/<series><d|w|m|a>.xls. Sheet "Data 1": row 0 a title, row 1 "Sourcekey" and the
// series id, row 2 "Date" and the series description with its units in parentheses, then one row per period: an
// Excel date and the value; a period with no value is an empty cell.
const DNAV_URL = "https://www.eia.gov/dnav/pet/hist_xls/";
const DNAV_FREQ: Record<string, string> = { daily: "d", weekly: "w", monthly: "m", annual: "a" };

/** The keyless file that holds this request's rows, null when there is none: a data request of a petroleum route
 * for exactly one series, the value column and no other facet. */
export function dnavFile(req: SpecRequest, p: Record<string, any>): { request: string; url: string; filename: string; frequency: string } | null {
  if ((req.endpoint || "data") !== "data") return null;
  const route = normRoute(p.route);
  const facets = p.facets || {};
  let series = facets.series;
  series = Array.isArray(series) ? series : [series];
  const data = p.data || ["value"];
  const freq = p.frequency || (entry(route) || {}).default_frequency;
  const keys = Object.keys(facets);
  const cols = typeof data === "string" ? [data] : [...data];
  if (!route.startsWith("petroleum/") || keys.length !== 1 || keys[0] !== "series" || series.length !== 1 ||
    !/^[A-Za-z0-9_]+$/.test(pyStr(series[0] || "")) || typeof freq !== "string" || !(freq in DNAV_FREQ) ||
    cols.length !== 1 || cols[0] !== "value" || ["state", "msn"].some((k) => has(p, k))) return null;
  const fn = `${pyStr(series[0])}${DNAV_FREQ[freq]}.xls`;
  return { request: req.name, url: DNAV_URL + fn, filename: fn, frequency: freq };
}

/** The keyless files that hold every request of the spec; [] when one request has none. */
function keylessFiles(spec: Spec, pack: Pack): any[] {
  const files: any[] = [];
  for (const r of spec.requests || []) {
    const [, params, probs] = gr.resolve(pack, r);
    const f = probs.length ? null : dnavFile(r, params);
    if (!f) return [];
    files.push(f);
  }
  return files;
}

/** format(x, ".15g") */
function formatG15(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [m, es] = x.toExponential(14).split("e");
  const exp = Number(es);
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exp < -4 || exp >= 15) return `${strip(m)}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  return strip(x.toFixed(14 - exp));
}

type XCell = { kind: "empty" | "text" | "number" | "date" | "bool" | "error"; value: any };

function cellOf(sh: XLSX.WorkSheet, r: number, c: number): XCell {
  const cell: any = sh[XLSX.utils.encode_cell({ r, c })];
  if (!cell || cell.t === "z" || cell.v === undefined || cell.v === null) return { kind: "empty", value: "" };
  if (cell.t === "n") return { kind: cell.z && XLSX.SSF.is_date(cell.z) ? "date" : "number", value: cell.v };
  if (cell.t === "b") return { kind: "bool", value: cell.v ? 1 : 0 };
  if (cell.t === "e") return { kind: "error", value: cell.v };
  return { kind: "text", value: String(cell.v) };
}

/** str(cell.value) as xlrd gives it: numbers are floats ("1.0"), empty cells "". */
function cellStr(c: XCell): string {
  if (c.kind === "number" || c.kind === "date") return Number.isInteger(c.value) ? `${c.value}.0` : pyStr(c.value);
  return pyStr(c.value);
}

function dnavRows(file: string, req: SpecRequest, params: Record<string, any>): Row[] {
  const name = req.name, fn = path.basename(file);
  const want = dnavFile(req, params);
  if (!want) {
    throw new DataError(`request ${pyRepr(name)}: ${fn} is an EIA history file, which holds one petroleum series at one ` +
      'frequency: the request must give a petroleum route, facets {"series": [one id]} and no other facet', "bad_request");
  }
  if (!fn.toLowerCase().startsWith(want.filename.slice(0, -4).toLowerCase())) {
    throw new DataError(`request ${pyRepr(name)}: ${fn} is not ${want.filename} (the series and frequency letter ` +
      "d/w/m/a must match the request)", "bad_request");
  }
  let wb: XLSX.WorkBook, sh: XLSX.WorkSheet, keys: string[], ncols: number, nrows: number;
  try {
    const buf = fs.readFileSync(file);
    if (!buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
      throw new Error("Unsupported format, or corrupt file: Expected BOF record");
    }
    wb = XLSX.read(buf, { type: "buffer", cellDates: false, cellNF: true, cellHTML: false });
    sh = wb.Sheets["Data 1"];
    if (!sh) throw new Error("No sheet named <'Data 1'>");
    // xlrd's nrows/ncols: the extent of the cells that hold a value
    nrows = 0;
    ncols = 0;
    for (const a of Object.keys(sh)) {
      if (a[0] === "!" || cellOf(sh, XLSX.utils.decode_cell(a).r, XLSX.utils.decode_cell(a).c).kind === "empty") continue;
      const { r, c } = XLSX.utils.decode_cell(a);
      nrows = Math.max(nrows, r + 1);
      ncols = Math.max(ncols, c + 1);
    }
    if (nrows < 2) throw new Error("array index out of range");
    keys = Array.from({ length: ncols }, (_, c) => cellStr(cellOf(sh, 1, c)).trim());
  } catch (e: any) {
    if (e instanceof DataError) throw e;
    throw new DataError(`request ${pyRepr(name)}: cannot read ${fn} as an EIA history file (${e?.name || "Error"}: ` +
      `${e?.message || e})`, "bad_request");
  }
  let series = params.facets.series;
  series = pyStr(Array.isArray(series) ? series[0] : series);
  if (keys[0] !== "Sourcekey" || !keys.includes(series)) {
    throw new DataError(`request ${pyRepr(name)}: ${fn} has no Sourcekey ${series} in sheet Data 1`, "bad_request");
  }
  const col = keys.indexOf(series);
  const desc = cellStr(cellOf(sh, 2, col)).trim();
  const units = /\(([^()]*)\)\s*$/.exec(desc);
  const freq = want.frequency;
  const lo = wholeYear(params.start, freq, "start"), hi = wholeYear(params.end, freq, "end");
  const date1904 = !!(wb.Workbook as any)?.WBProps?.date1904;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const rows: Row[] = [];
  for (let i = 3; i < nrows; i++) {
    const d = cellOf(sh, i, 0), v = cellOf(sh, i, col);
    if (d.kind !== "date" || v.kind === "empty") continue;
    const t = XLSX.SSF.parse_date_code(d.value, { date1904 });
    const period = freq === "annual" ? pad(t.y, 4) : freq === "monthly" ? `${pad(t.y, 4)}-${pad(t.m)}` : `${pad(t.y, 4)}-${pad(t.m)}-${pad(t.d)}`;
    if ((lo && period < pyStr(lo).slice(0, period.length)) || (hi && period > pyStr(hi).slice(0, period.length))) continue;
    const value = v.kind === "number" || v.kind === "date" ? formatG15(v.value) : pyStr(v.value).trim();
    rows.push({ period, series, "series-description": desc, value, units: units ? units[1] : "" });
  }
  if (!rows.length && !req.allow_empty) {
    throw new DataError(`request ${pyRepr(name)}: ${fn} has no value between ${lo || "the start"} and ${hi || "the end"}`, "bad_request");
  }
  const sort = params.sort || "period:desc";
  const asc = pyStr(typeof sort === "string" ? sort : sort[0]?.direction ?? "desc").toLowerCase().includes("asc");
  // sorted(key=period, reverse=not asc): stable, so equal periods keep their order either way
  const dir = asc ? 1 : -1;
  return [...rows].sort((a, b) => (a.period === b.period ? 0 : (a.period as string) < (b.period as string) ? -dir : dir));
}

/** API pages saved as JSON (the manual route), or the series' dnav history file (.xls as downloaded). */
function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [ep, params] = gr.resolve(pack, req);
  let rows: any[] = [];
  for (const f of [...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (f.toLowerCase().endsWith(".xls")) {
      rows = rows.concat(dnavRows(f, req, params));
      continue;
    }
    const doc = parsePyJson(fs.readFileSync(f).toString("utf8").replace(/^\ufeff/, ""));
    rows = rows.concat(gr.dig(doc, ep.records ?? "response.data") || []);
  }
  return normalize(req, ep, gr.clean(rows, ep));
}

function search(query: string, pack: Pack): any[] {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1);
  const scored: [number, any][] = [];
  for (const h of gr.searchCatalog(pack, query, 500)) {
    const text = Object.values(h).map((v) => pyStr(v)).join(" ").toLowerCase();
    scored.push([words.filter((w) => text.includes(w)).length, h]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, h]) => h).slice(0, 20);
}

const adapter: Adapter = { checkError, checkSpec, fetch, normalize, ping, manualItems, keylessFiles, parseUpload, search,
  prepare, wholeYear, dnavFile, dnavRows };
export default adapter;
