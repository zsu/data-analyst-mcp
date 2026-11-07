/**
 * USGS adapter (port of the Python adapter.py): earthquakes (FDSN event service, keyless) and the Water Data OGC
 * API (optional key).
 *
 * - fetch: earthquake requests use a keyless client (the api.data.gov key is never sent to earthquake.usgs.gov);
 *   water requests follow the OGC "next" links (cursor paging) that the generic fetcher cannot read.
 * - beforeRequest: site numbers get the "USGS-" agency prefix; state names or USPS codes become FIPS;
 *   skipGeometry defaults to true except for monitoring-locations, where a site id goes in `id`.
 * - earthquakes with `eventid`: the service answers a single Feature, which becomes one row.
 * - checkSpec: an earthquake box crossing the 180th meridian is one box with maxlongitude above 180. A box with
 *   minlongitude at or above maxlongitude is refused: when min is east (> 0) and max west (< 0) the message gives
 *   the +360 form, otherwise it says the bounds look swapped.
 * - normalize: GeoJSON "properties." prefixes go; earthquake times (epoch milliseconds) get ISO UTC columns and
 *   the coordinates become longitude, latitude, depth_km; points get longitude, latitude.
 */
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { pyStr, pyUrlencode } from "../core/py.js";

const WATER_BASE = "https://api.waterdata.usgs.gov/ogcapi/v1";
const QUAKE_EPS = ["earthquakes", "earthquake_count"];

// USPS code, FIPS, name (the Python analysis.combine STATES table).
const STATES = ("AL 01 Alabama|AK 02 Alaska|AZ 04 Arizona|AR 05 Arkansas|CA 06 California|CO 08 Colorado|" +
  "CT 09 Connecticut|DE 10 Delaware|DC 11 District of Columbia|FL 12 Florida|GA 13 Georgia|HI 15 Hawaii|ID 16 Idaho|" +
  "IL 17 Illinois|IN 18 Indiana|IA 19 Iowa|KS 20 Kansas|KY 21 Kentucky|LA 22 Louisiana|ME 23 Maine|MD 24 Maryland|" +
  "MA 25 Massachusetts|MI 26 Michigan|MN 27 Minnesota|MS 28 Mississippi|MO 29 Missouri|MT 30 Montana|NE 31 Nebraska|" +
  "NV 32 Nevada|NH 33 New Hampshire|NJ 34 New Jersey|NM 35 New Mexico|NY 36 New York|NC 37 North Carolina|" +
  "ND 38 North Dakota|OH 39 Ohio|OK 40 Oklahoma|OR 41 Oregon|PA 42 Pennsylvania|RI 44 Rhode Island|" +
  "SC 45 South Carolina|SD 46 South Dakota|TN 47 Tennessee|TX 48 Texas|UT 49 Utah|VT 50 Vermont|VA 51 Virginia|" +
  "WA 53 Washington|WV 54 West Virginia|WI 55 Wisconsin|WY 56 Wyoming|AS 60 American Samoa|GU 66 Guam|" +
  "MP 69 Northern Mariana Islands|PR 72 Puerto Rico|VI 78 U.S. Virgin Islands").split("|").map((s) => {
  const [u, f, ...n] = s.split(" ");
  return [u, f, n.join(" ")];
});
const BY = new Map<string, string>(); // lower-case USPS code or name -> FIPS
for (const [u, f, n] of STATES) for (const k of [u.toLowerCase(), n.toLowerCase()]) BY.set(k, f);

/** Python repr() of a str. */
function repr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n").replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t") + q;
}

/** Python float(v), or null where it raises. */
function num(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/_/g, "");
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Python format(x, "g"). */
function pyG(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const [m, es] = x.toExponential(5).split("e");
  const e = Number(es);
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (e < -4 || e >= 6) return `${strip(m)}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  return strip(x.toFixed(Math.max(0, 5 - e)));
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    if (!QUAKE_EPS.includes(r.endpoint || "")) continue;
    const p: Record<string, any> = r.params || {};
    const lo = num(p.minlongitude), hi = num(p.maxlongitude);
    if (lo === null || hi === null || lo < hi) continue;
    const fix = lo > 0 && 0 > hi // east of 180 written as negative: a box across the 180th meridian
      ? `a box crossing the 180th meridian is one box with maxlongitude above 180 (minlongitude ${pyG(lo)}, ` +
        `maxlongitude ${pyG(hi + 360)})`
      : "the two values look swapped";
    probs.push(`request ${repr(String(r.name))}: minlongitude must be below maxlongitude; ${fix}`);
  }
  return probs;
}

function stateFips(v: unknown): string {
  const s = pyStr(v).trim();
  if (/^\d+$/.test(s)) return s.padStart(2, "0");
  return BY.get(s.toLowerCase()) ?? s;
}

function beforeRequest(_req: SpecRequest, ep: any, params: Record<string, unknown>): Record<string, unknown> {
  if (String(ep?.path ?? "").startsWith("/collections/")) {
    const ids = params.monitoring_location_id;
    if (ids !== null && ids !== undefined && ids !== "") {
      const parts = pyStr(ids).split(",").map((p) => p.trim()).filter(Boolean);
      params.monitoring_location_id = parts.map((p) => (p.includes("-") ? p.toUpperCase() : `USGS-${p}`)).join(",");
      if (params.collection === "monitoring-locations") {
        // the sites themselves: the site is the feature id, and this collection answers 400 to
        // monitoring_location_id (its queryables have `id`)
        const v = params.monitoring_location_id;
        delete params.monitoring_location_id;
        params.id = v;
      }
    }
    if (params.state_code !== null && params.state_code !== undefined && params.state_code !== "") {
      params.state_code = stateFips(params.state_code);
    }
    const cc = params.county_code;
    if (cc !== null && cc !== undefined && cc !== "" && /^\d+$/.test(pyStr(cc))) params.county_code = pyStr(cc).padStart(3, "0");
    if (!("skipGeometry" in params)) params.skipGeometry = params.collection === "monitoring-locations" ? "false" : "true";
  }
  return params;
}

async function water(c: Client, ep: any, params: Record<string, unknown>, maxRows?: number | null): Promise<[Row[], boolean]> {
  const limit = Math.trunc(Number(maxRows || ep.max_rows || 200000));
  const size = Math.trunc(Number(ep.paging?.size || 10000));
  const [p, query] = gr.split(ep, params);
  query.limit = Math.min(size, limit);
  let rows: any[] = [];
  let url: string | null = null, pages = 0, more = false;
  for (;;) {
    const resp: { json(): any } = url ? await c.get(url) : await c.get(p, query);
    pages++;
    const data: any = resp.json();
    const got: any[] = data?.features || [];
    rows = rows.concat(got);
    const link: any = (data?.links || []).find((l: any) => l?.rel === "next");
    url = link ? link.href ?? null : null;
    if (rows.length >= limit) {
      more = !!url;
      rows = rows.slice(0, limit);
      break;
    }
    if (!url || !got.length || pages >= 500) {
      more = !!(url && got.length);
      break;
    }
  }
  return [gr.clean(rows, ep), more];
}

/** GeoJSON features of an earthquake response. A query with `eventid` answers one Feature, not a
 * FeatureCollection: it becomes one row. Its `products` catalog is left out so the row has the same columns as a
 * search row; the event `url` links to it. */
export function features(data: any): any[] {
  if (data && typeof data === "object" && !Array.isArray(data) && data.type === "Feature") {
    const props = Object.fromEntries(Object.entries(data.properties || {}).filter(([k]) => k !== "products"));
    return [{ ...data, properties: props }];
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data.features || [] : [];
}

export async function quake(c: Client | any, ep: any, params: Record<string, unknown>, maxRows?: number | null): Promise<[Row[], boolean]> {
  const ev = params.eventid;
  if (ev === null || ev === undefined || ev === "" || ep.records !== "features") {
    const [rows, meta] = await gr.fetchRequest(c, ep, params, maxRows);
    return [rows, meta.truncated];
  }
  const [p, query] = gr.split(ep, params);
  return [gr.clean(features((await c.get(p, query)).json()), ep), false];
}

function isoMs(v: unknown): string {
  const f = num(v);
  if (f === null || !Number.isFinite(f)) return "";
  const ms = Math.trunc(f);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  if (y < 1 || y > 9999) return "";
  return d.toISOString();
}

function normalize(_req: SpecRequest, ep: any, rows: Row[]): Row[] {
  if (ep?.records !== "features") return rows;
  const isQuake = String(ep.path ?? "").includes("earthquake.usgs.gov");
  return rows.map((r) => {
    const n: Row = {};
    for (const [k, v] of Object.entries(r)) n[k.startsWith("properties.") ? k.slice("properties.".length) : k] = v;
    const raw = "geometry.coordinates" in n ? n["geometry.coordinates"] : "";
    delete n["geometry.coordinates"];
    const coords = (raw === null || raw === undefined || raw === "" || raw === 0 || raw === false ? "" : pyStr(raw))
      .split(";").map((p) => p.trim()).filter(Boolean);
    delete n.type;
    if (isQuake) {
      n.time_utc = isoMs(n.time ?? null);
      n.updated_utc = isoMs(n.updated ?? null);
      if (coords.length === 3) [n.longitude, n.latitude, n.depth_km] = coords;
    } else if (coords.length >= 2) [n.longitude, n.latitude] = [coords[0], coords[1]];
    return n;
  });
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const waterClient = gr.clientFor(pack);
  const quakeClient = new Client("", { name: "usgs-earthquake", auth: { placement: "none" } as any, rps: 5, burst: 10,
    headers: pack.endpoints?.headers ?? null });
  const tables: Tables = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [ep, params0, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const params = beforeRequest(r, ep, params0);
    let [rows, more] = String(ep.path).startsWith("http") ? await quake(quakeClient, ep, params, r.max_rows)
      : await water(waterClient, ep, params, r.max_rows);
    if (more) {
      notes.push(`${r.name}: stopped at ${rows.length.toLocaleString("en-US")} rows (max_rows); the source has more. Narrow the ` +
        "filter (time, sites, parameter) or raise max_rows.");
    }
    rows = normalize(r, ep, rows);
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${repr(r.name)} returned no rows: check site ids, parameter code, statistic ` +
        "and time window (see source.md)", "bad_request");
    }
    tables[r.name] = rows;
  }
  return [tables, notes];
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items = gr.manualItems(pack, spec);
  const base = String(pack.endpoints?.base_url || "").replace(/\/+$/, "");
  for (const it of items) {
    for (const scheme of ["https://", "http://"]) {
      if (it.url.startsWith(`${base}/${scheme}`)) it.url = scheme + it.url.slice(base.length + 1 + scheme.length);
    }
    if (it.url.startsWith(WATER_BASE)) {
      const req: any = (spec.requests || []).find((r) => r.name === it.request) || {};
      const [ep, params] = gr.resolve(pack, req);
      const [p, query] = gr.split(ep, beforeRequest(req, ep, params));
      query.limit = 10000;
      it.url = `${WATER_BASE}${p}?` + pyUrlencode(query);
      it.note = 'up to 10,000 rows; if the JSON has a links entry with rel "next", open that URL too and ' +
        "save it as the next numbered file";
    }
  }
  return items;
}

/** Check the key against the water API only (the earthquake host never receives it). */
async function ping(client: Client): Promise<{ auth_ok: boolean; kind: string; detail: string }> {
  try {
    await client.get(`${WATER_BASE}/collections/parameter-codes/items`, { f: "json", limit: 1 });
    return { auth_ok: true, kind: "", detail: "water data API answered with the key" };
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    return { auth_ok: !["auth", "key_missing"].includes(e.kind), kind: e.kind, detail: e.message };
  }
}

const adapter: Adapter = { checkSpec, beforeRequest, normalize, fetch, manualItems, ping, quake, features };
export default adapter;
