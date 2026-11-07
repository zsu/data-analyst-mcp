/**
 * NOAA NCEI adapter: keyless Access Data Service first, CDO v2 (token) only where it is needed.
 *
 * - beforeRequest: ADS station ids without the CDO "GHCND:" prefix; YYYY / YYYY-MM dates padded to full dates
 *   (ADS refuses them, even for monthly data).
 * - fetch: the generic fetch, except that cdo_* requests without NOAA_API_KEY stop as key_missing (CDO
 *   answers a bare HTTP 400 "Token parameter is required").
 * - normalize: ADS values are padded text ("   83"); they are trimmed (the digits are unchanged). The
 *   station search returns nested documents; they become one row per station. A data request none of
 *   whose data types came back fails instead of returning only DATE and STATION.
 * - keyOnlyNeeds: the cdo_* endpoints need NOAA_API_KEY (sent as the "token" header).
 */
import { clientFor, fetchSpec } from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { parsePyJson, pyStr } from "../core/py.js";

const ADS_DATA = "/access/services/data/";
const ADS_SEARCH = "/access/services/search/";
const repr = (s: unknown) => (s === null || s === undefined ? "None" : `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const pyTrim = (s: string) => s.replace(/^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g, "");

/** YYYY or YYYY-MM -> YYYY-MM-DD (first day for a start, last day for an end); anything else unchanged. */
function fullDate(v: unknown, end: boolean): unknown {
  const s = pyStr(v).trim();
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(s);
  if (!m) return v;
  const y = parseInt(m[1], 10);
  if (m[2] === undefined) return end ? `${pad(y, 4)}-12-31` : `${pad(y, 4)}-01-01`;
  const mo = parseInt(m[2], 10);
  if (!(1 <= mo && mo <= 12)) return v;
  // calendar.monthrange (proleptic Gregorian, year 0001 included)
  const d = new Date(0);
  d.setUTCFullYear(y, mo, 0);
  return end ? `${pad(y, 4)}-${pad(mo)}-${pad(d.getUTCDate())}` : `${pad(y, 4)}-${pad(mo)}-01`;
}

function beforeRequest(_req: SpecRequest, ep: any, params: Record<string, unknown>): Record<string, unknown> {
  const p: string = ep.path || "";
  if ((p.startsWith(ADS_DATA) || p.startsWith(ADS_SEARCH)) && params.stations) {
    const ids = pyStr(params.stations).split(",").map((s) => s.trim()).filter(Boolean);
    params.stations = ids.map((s) => (s.includes(":") ? s.slice(s.indexOf(":") + 1) : s)).join(",");
  }
  if (p.startsWith(ADS_DATA)) {
    for (const [k, end] of [["startDate", false], ["endDate", true]] as const) {
      const v = params[k];
      if (v !== null && v !== undefined && v !== "") params[k] = fullDate(v, end);
    }
  }
  return params;
}

/** The generic fetch, after one check: cdo_* requests without NOAA_API_KEY stop as key_missing. */
async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const c = clientFor(pack);
  const cdo = (spec.requests || []).filter((r) => pyStr(r.endpoint ?? "").startsWith("cdo_")).map((r) => r.name);
  if (cdo.length && !c.key) {
    throw new DataError(`request(s) ${cdo.map(repr).join(", ")}: the Climate Data Online v2 endpoints (cdo_*) need a ` +
      "free NOAA token: set NOAA_API_KEY (https://www.ncei.noaa.gov/cdo-web/token), or use the " +
      "keyless data / station_search endpoints", "key_missing");
  }
  return fetchSpec(pack, spec, c);
}

function loads(v: unknown): any[] {
  try {
    return parsePyJson(v === null || v === undefined || v === "" ? "[]" : pyStr(v));
  } catch {
    return [];
  }
}

function stationRows(rows: Row[]): Row[] {
  return rows.map((r) => {
    const st = loads(r.stations);
    const dts = loads(r.dataTypes);
    const coords = pyStr(r["location.coordinates"] || "").split(";");
    const s0 = st && st.length ? st[0] : {};
    const ids = (Array.isArray(dts) ? dts : []).filter((d) => d && typeof d === "object" && !Array.isArray(d))
      .map((d) => pyStr(d.id ?? "")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { station_id: s0.id ?? "", name: s0.name ?? "",
      longitude: coords.length === 2 ? coords[0].trim() : "", latitude: coords.length === 2 ? coords[1].trim() : "",
      start_date: r.startDate ?? "", end_date: r.endDate ?? "", data_types: ids.join(" "),
      data_types_count: r.dataTypesCount ?? "", file_path: r.filePath ?? "" };
  });
}

function normalize(req: SpecRequest, ep: any, rows: Row[]): Row[] {
  const p: string = ep.path || "";
  if (p.startsWith(ADS_SEARCH)) return stationRows(rows);
  if (p.startsWith(ADS_DATA)) {
    rows = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? pyTrim(v) : v])));
    const asked = pyStr((req.params || {}).dataTypes || "").split(",").map((t) => t.trim()).filter(Boolean);
    const cols = new Set(rows.flatMap((r) => Object.keys(r).map((k) => k.toUpperCase())));
    if (rows.length && asked.length && !asked.some((t) => cols.has(t.toUpperCase()))) {
      throw new DataError(`request ${repr(req.name)}: none of the data types ${asked.join(", ")} came back (ADS ` +
        "returns only DATE and STATION for a misspelled or wrongly cased type, or one the station " +
        "did not record in that period). Check the ids (case-sensitive: TMAX, PRCP ...; normals " +
        "MLY-TAVG-NORMAL ...) and the station's data_types with station_search.", "bad_request");
    }
    return rows;
  }
  return rows;
}

function keyOnlyNeeds(spec: Spec): string[] {
  const needs = [...new Set((spec.requests || []).map((r) => r.endpoint).filter((e) => pyStr(e ?? "").startsWith("cdo_")))]
    .sort() as string[];
  return needs.map((n) => `${n} (Climate Data Online v2 needs a free NOAA token)`);
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    if (r.endpoint === "cdo_data" && p.startdate && p.enddate) {
      const a = pyStr(p.enddate).slice(0, 4).trim(), b = pyStr(p.startdate).slice(0, 4).trim();
      if (!/^[+-]?\d+$/.test(a) || !/^[+-]?\d+$/.test(b)) continue;
      const span = parseInt(a, 10) - parseInt(b, 10);
      const ds = pyStr(p.datasetid ?? "").toUpperCase();
      if (span > (ds === "GSOM" || ds === "GSOY" ? 10 : 1)) {
        probs.push(`request ${repr(r.name)}: CDO limits a request to 1 year (${ds || "daily"}) or 10 years ` +
          "(GSOM/GSOY); split it, or use the keyless data endpoint with stations");
      }
    }
  }
  return probs;
}

/** Check the CDO token (the keyless ADS endpoints never need it). Without a token, say so: CDO would
 * answer HTTP 400, which reads as a rejected key. */
async function ping(client: Client): Promise<{ auth_ok: boolean; kind: string; detail: string }> {
  if (!client.key) {
    return { auth_ok: false, kind: "key_missing", detail: "no NOAA_API_KEY found: the keyless data and station_search " +
      "endpoints work; only the cdo_* endpoints need the token" };
  }
  try {
    await client.get("/cdo-web/api/v2/datasets", { limit: 1 });
    return { auth_ok: true, kind: "", detail: "CDO v2 accepted the token" };
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    const kind = e.kind === "bad_request" ? "auth" : e.kind; // CDO answers 400 for a missing or bad token
    return { auth_ok: kind !== "auth" && kind !== "key_missing", kind, detail: e.message };
  }
}

const adapter: Adapter = { beforeRequest, fetch: (spec, pack) => fetch(spec, pack), normalize, keyOnlyNeeds,
  checkSpec: (spec) => checkSpec(spec), ping };
export default adapter;
