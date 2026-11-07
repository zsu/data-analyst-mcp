/**
 * FBI Crime Data Explorer adapter (port of the Python adapter.py).
 *
 * - beforeRequest: `from`/`to` given as a year become 01-YYYY / 12-YYYY (the API wants MM-YYYY, except the
 *   employee endpoints, which want YYYY); state codes are upper-cased.
 * - normalize: CDE answers with nested chart objects ({"offenses": {"rates": {"United States Offenses":
 *   {"01-2020": 29.06, ...}}}}). They become one long table: section, series, key, period, year, month,
 *   value, unit, plus data_through and last_refresh from cde_properties. Values are kept as published.
 *   Every row also carries span_from / span_to (YYYY-MM, the request's from/to): `type=totals` breakdowns
 *   have no period of their own and are summed over that span, so the span is the only record of what
 *   they cover (tables from one request per year then stack without losing the year).
 * - manualItems: links carry API_KEY=DEMO_KEY (api.data.gov's public demo key), because the API refuses a
 *   request without any key.
 */
import * as gr from "../core/generic-rest.js";
import type { Adapter, Pack, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyStr, pyUrlencode } from "../core/py.js";

const MMYYYY = /^(\d{2})-(\d{4})$/;
const YYYY = /^\d{4}$/;
const SKIP_TOP = ["cde_properties"];

const isDict = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const strip = (v: unknown) => pyStr(v ?? "").trim();
/** Python repr() of a str (the quote style Python picks). */
const repr = (s: string) => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);

function beforeRequest(_req: SpecRequest, ep: any, params: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = { ...params };
  const fmt = ep?.date_format ?? "mm-yyyy";
  for (const [k, month] of [["from", "01"], ["to", "12"]]) {
    const v = strip(p[k]);
    if (!v) continue;
    if (fmt === "mm-yyyy" && YYYY.test(v)) p[k] = `${month}-${v}`;
    else if (fmt === "yyyy" && MMYYYY.test(v)) p[k] = v.slice(-4);
  }
  if (p.state) p.state = pyStr(p.state).toUpperCase();
  if (p.ori) p.ori = pyStr(p.ori).toUpperCase();
  return p;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    for (const k of ["from", "to"]) {
      const v = strip(p[k]);
      if (v && !(MMYYYY.test(v) || YYYY.test(v))) {
        probs.push(`request ${repr(String(r.name))}: ${k}=${repr(v)} must be MM-YYYY (01-2019) or YYYY`);
      }
    }
    const st = p.state;
    if (st && !/^[A-Za-z]{2}$/.test(pyStr(st))) {
      probs.push(`request ${repr(String(r.name))}: state must be a two-letter code such as CA`);
    }
  }
  return probs;
}

type Units = { rates: string; actuals: string };
type Meta = { data_through: unknown; last_refresh: unknown };

function units(body: Record<string, any>): Units {
  const t = (body.tooltips || {}).leftYAxisHeaders || {};
  return { rates: t.yAxisHeaderRates ?? "", actuals: t.yAxisHeaderActual ?? "" };
}

function meta(body: Record<string, any>): Meta {
  const cp = body.cde_properties;
  if (!isDict(cp)) {
    const lr = body.last_refresh_date;
    return { data_through: "", last_refresh: isDict(lr) ? lr.UCR ?? "" : "" };
  }
  return { data_through: (cp.max_data_date || {}).UCR ?? "", last_refresh: (cp.last_refresh_date || {}).UCR ?? "" };
}

function unitFor(section: string, series: string, u: Units): string {
  const last = section ? section.split("/").pop()! : series;
  if (last === "rates" || series.endsWith("per 1,000 People")) {
    return last === "rates" && u.rates ? u.rates : series.includes("1,000") ? "per 1,000 people" : "";
  }
  if (last === "actuals") return u.actuals || "count";
  if (section.includes("Percent of Population Coverage")) return "percent of population";
  if (section.startsWith("populations")) return "persons";
  return "";
}

function leaves(obj: unknown, path: string[], out: [string[], unknown][]): void {
  if (isDict(obj)) {
    for (const [k, v] of Object.entries(obj)) leaves(v, [...path, String(k)], out);
  } else if (Array.isArray(obj)) {
    if (obj.length && obj.every((x) => isDict(x) && !Object.values(x).some((y) => y !== null && typeof y === "object"))) {
      for (const x of obj) out.push([path, x]);
    } else {
      obj.forEach((x, i) => leaves(x, !isDict(x) ? [...path, String(i)] : path, out));
    }
  } else out.push([path, obj]);
}

const blank = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? "" : v]));

function reshape(body: unknown, ep: any): Row[] {
  if (ep?.shape === "agencies" && isDict(body)) {
    const rows: Row[] = [];
    for (const [county, agencies] of Object.entries(body)) {
      for (const a of (agencies || []) as Record<string, any>[]) rows.push({ county_group: county, ...blank(a) });
    }
    return rows;
  }
  const u: Units = isDict(body) ? units(body) : { rates: "", actuals: "" };
  const m: Meta = isDict(body) ? meta(body) : { data_through: "", last_refresh: "" };
  const found: [string[], unknown][] = [];
  if (isDict(body)) {
    for (let [k, v] of Object.entries(body)) {
      if (SKIP_TOP.includes(k) || k === "last_refresh_date") continue;
      if (k === "tooltips" && isDict(v)) v = Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== "leftYAxisHeaders"));
      leaves(v, [k], found);
    }
  } else leaves(body, [], found);
  const rows: Row[] = [];
  for (const [path, val] of found) {
    if (isDict(val)) { // a record (e.g. LESDC counts)
      rows.push({ section: path.join("/"), ...blank(val), ...m });
      continue;
    }
    const key = path.length ? path[path.length - 1] : "";
    let series = path.length >= 2 ? path[path.length - 2] : "";
    let section = path.slice(0, -2).join("/");
    if (!section) [section, series] = [series, ""]; // two-level breakdowns: {"Arrestee Sex": {"Male": n}}
    const row: Row = { section, series, key, period: "", year: "", month: "" };
    const mm = MMYYYY.exec(key);
    if (mm) Object.assign(row, { period: `${mm[2]}-${mm[1]}`, year: mm[2], month: String(Number(mm[1])) });
    else if (YYYY.test(key)) Object.assign(row, { period: key, year: key });
    Object.assign(row, { value: val === null || val === undefined ? "" : val, unit: unitFor(section, series, u), ...m });
    rows.push(row);
  }
  const sortKey = (r: Row) => [pyStr(r.section ?? ""), pyStr(r.series ?? ""), pyStr(r.period ?? "") || pyStr(r.key ?? "")];
  const keyed = rows.map((r) => [sortKey(r), r] as [string[], Row]);
  keyed.sort(([a], [b]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  });
  return keyed.map(([, r]) => r);
}

/** The request's from/to as YYYY-MM (YYYY for the yearly employee endpoints); {} when it has none. */
function span(req: SpecRequest, ep: any): Record<string, string> {
  const p = beforeRequest(req, ep, req?.params || {});
  const out: Record<string, string> = {};
  for (const k of ["from", "to"]) {
    const v = strip(p[k]);
    const m = MMYYYY.exec(v);
    out[`span_${k}`] = m ? `${m[2]}-${m[1]}` : v;
  }
  return Object.values(out).some(Boolean) ? out : {};
}

function normalize(req: SpecRequest, ep: any, rows: Row[]): Row[] {
  const out: Row[] = [];
  for (const r of rows) out.push(...reshape(r, ep));
  const s = span(req, ep);
  return Object.keys(s).length ? out.map((r) => ({ ...r, ...s })) : out;
}

/** One link per request, with the converted dates and api.data.gov's public DEMO_KEY. */
function manualItems(spec: Spec, pack: Pack): any[] {
  const base = String(pack.endpoints?.base_url || "").replace(/\/+$/, "");
  const byName = new Map((spec.requests || []).map((r) => [r.name, r]));
  const items = gr.manualItems(pack, spec);
  for (const it of items) {
    const r = byName.get(it.request);
    if (!r) continue;
    const [ep, params] = gr.resolve(pack, r);
    const [p, query] = gr.split(ep, beforeRequest(r, ep, params));
    it.url = `${base}/${p.replace(/^\/+/, "")}?` + pyUrlencode({ ...query, API_KEY: "DEMO_KEY" });
    it.note = "API_KEY=DEMO_KEY is api.data.gov's public demo key (a few requests an hour); replace it with " +
      "your own free key from https://api.data.gov/signup/ if the link answers OVER_RATE_LIMIT.";
  }
  return items;
}

const adapter: Adapter = { beforeRequest, checkSpec, normalize, manualItems };
export default adapter;
