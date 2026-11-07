/**
 * National Weather Service (api.weather.gov) adapter.
 *
 * - fetch: forecast endpoints first resolve the point (/points/lat,lon) to its forecast grid, then read
 *   the forecast URL that the point names; everything else runs through the generic fetcher.
 * - User-Agent: NWS asks every client for an identifying User-Agent. The shared one is sent; set
 *   NWS_USER_AGENT (e.g. "my-analysis (me@example.com)") to send your own.
 * - normalize: GeoJSON features lose their "properties." prefix; alert polygons are dropped (they are
 *   large; geometry.type stays); station points get longitude/latitude columns.
 */
import { clean, clientFor, fetchRequest, manualItems as grManualItems, resolve, split } from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const repr = (s: unknown) => (s === null || s === undefined ? "None" : `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);

function client(pack: Pack): Client {
  const ua = (process.env.NWS_USER_AGENT || "").trim();
  return clientFor(pack, undefined, ua ? { userAgent: ua } : {});
}

/** f"{x:.4f}" (exact binary value, ties to even, as Python formats). */
function fixed4(x: number): string {
  const s = x * 10000;
  if (Number.isFinite(s) && Number.isInteger(s * 2) && !Number.isInteger(s)) {
    const fl = Math.floor(s);
    return ((fl % 2 === 0 ? fl : fl + 1) / 10000).toFixed(4);
  }
  return x.toFixed(4);
}

/** /points accepts at most 4 decimal places; more gives a 301 redirect to the rounded point. */
function round(params: Record<string, unknown>): Record<string, unknown> {
  for (const k of ["lat", "lon"]) {
    const v = params[k];
    if (v !== null && v !== undefined && v !== "") params[k] = fixed4(Number(typeof v === "string" ? v.trim() : v)).replace(/0+$/, "").replace(/\.$/, "");
  }
  return params;
}

async function forecast(c: Client, ep: any, params: Record<string, unknown>, maxRows: unknown): Promise<Row[]> {
  const [p] = split(ep, params);
  const point = await c.getJson(p);
  const props = point?.properties || {};
  const url = props[ep.resolve];
  if (!url) {
    throw new DataError(`nws: the point ${pyStr(params.lat)},${pyStr(params.lon)} has no ${ep.resolve} ` +
      "(NWS forecasts cover the U.S. and its territories only)", "bad_request");
  }
  const fc = await c.getJson(url);
  const fp = fc?.properties || {};
  const extra = { office: props.gridId ?? "", grid_x: props.gridX ?? "", grid_y: props.gridY ?? "",
    generated_at: fp.generatedAt ?? "", update_time: fp.updateTime ?? "" };
  const rows = clean(fp.periods || [], ep).map((r) => ({ ...r, ...extra }));
  return maxRows ? rows.slice(0, Math.trunc(Number(maxRows))) : rows;
}

async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const c = client(pack);
  const tables: Tables = {}, notes: string[] = [];
  for (const r of spec.requests) {
    let [ep, params, probs] = resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    if ("lat" in params) params = round(params);
    let rows: Row[];
    if (ep.resolve) rows = await forecast(c, ep, params, r.max_rows);
    else {
      const [got, meta] = await fetchRequest(c, ep, params, r.max_rows);
      rows = got;
      if (meta.truncated) notes.push(`${r.name}: stopped at ${rows.length.toLocaleString("en-US")} rows (max_rows or page limit); the source has more.`);
    }
    rows = normalize(r, ep, rows);
    if (!rows.length && !r.allow_empty) {
      if (ep.path === "/alerts/active") notes.push(`${r.name}: no active alerts matched (a valid answer: nothing is in effect now).`);
      else throw new DataError(`request ${repr(r.name)} returned no rows: check the parameters (see source.md)`, "bad_request");
    }
    tables[r.name] = rows;
  }
  return [tables, notes];
}

function normalize(_req: SpecRequest, ep: any, rows: Row[]): Row[] {
  if (ep.records !== "features") return rows;
  return rows.map((r) => {
    const n: Row = {};
    for (let [k, v] of Object.entries(r)) {
      if (k.startsWith("properties.")) k = k.slice("properties.".length);
      if (k.startsWith("@")) continue;
      n[k] = v;
    }
    const coords = "geometry.coordinates" in n ? n["geometry.coordinates"] : "";
    delete n["geometry.coordinates"];
    if (n["geometry.type"] === "Point" && coords) {
      const parts = pyStr(coords).split(";").map((p) => p.trim());
      if (parts.length >= 2) [n.longitude, n.latitude] = [parts[0], parts[1]];
    }
    return n;
  });
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items = grManualItems(pack, spec);
  const eps = pack.endpoints?.endpoints || {};
  for (const it of items) {
    const req = (spec.requests || []).find((r) => r.name === it.request) || ({} as SpecRequest);
    const ep = eps[req.endpoint || ""] || {};
    if (ep.resolve) {
      it.note = `This link returns the point. Open the URL in its properties.${ep.resolve} field and save ` +
        `THAT page as ${it.filename}.`;
    }
  }
  return items;
}

const adapter: Adapter = { fetch: (spec, pack) => fetch(spec, pack), normalize, manualItems };
export default adapter;
