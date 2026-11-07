/**
 * NREL / NLR developer API adapter: errors inside HTTP 200, and monthly outputs reshaped into rows.
 *
 * solar_resource returns one object per measure with monthly values (avg_dni.monthly.jan ...); pvwatts returns
 * 12-value lists (ac_monthly ...). Both are reshaped to one row per month (plus an "annual" row for
 * solar_resource). pvwatts with timeframe=hourly also returns one value per hour of a typical year (ac, dc, poa
 * ...; 8,760 values): it is reshaped to one row per hour instead. The published values are kept exactly, only
 * their arrangement changes.
 */
import { fetchSpec, Misses } from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const repr = (s: unknown) => (s === null || s === undefined ? "None" : `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);

/** str() of a JSON value as Python prints it (a dict or list in repr form). */
function pyText(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (Array.isArray(v)) return "[" + v.map((x) => (typeof x === "string" ? repr(x) : pyText(x))).join(", ") + "]";
  if (typeof v === "object") {
    return "{" + Object.entries(v as object).map(([k, x]) => `${repr(k)}: ${typeof x === "string" ? repr(x) : pyText(x)}`).join(", ") + "}";
  }
  return pyStr(v);
}

function checkError(_status: number, body: Buffer): string | null {
  if (body.toString("latin1").replace(/^[ \t\n\r\v\f]+/, "").slice(0, 1) !== "{") return null;
  let d: any;
  try {
    d = JSON.parse(body.toString("utf8").replace(/^\ufeff/, ""));
  } catch {
    return null;
  }
  const isDict = d && typeof d === "object" && !Array.isArray(d);
  const errs = isDict ? d.errors : null;
  const truthy = Array.isArray(errs) ? errs.length > 0 : !!errs && !(typeof errs === "object" && !Object.keys(errs).length);
  if (truthy) return "API error: " + (Array.isArray(errs) ? errs.map(pyText) : typeof errs === "string" ? [...errs] : typeof errs === "object" ? Object.keys(errs) : [pyText(errs)]).join("; ").slice(0, 400);
  const err = isDict ? d.error : null;
  if (err && typeof err === "object" && !Array.isArray(err) && err.message) return `${"code" in err ? pyText(err.code) : "error"}: ${pyText(err.message)}`;
  return null;
}

function solar(rows: Row[]): Row[] {
  if (!rows.length) return rows;
  const r = rows[0];
  const measures = [...new Set(Object.keys(r).filter((k) => k.includes(".")).map((k) => k.split(".")[0]))]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...MONTHS, "annual"].map((m, i) => {
    const row: Row = { period: m, month: m !== "annual" ? i + 1 : "" };
    for (const ms of measures) {
      const k = m === "annual" ? `${ms}.annual` : `${ms}.monthly.${m}`;
      row[`${ms}_kwh_m2_day`] = k in r ? r[k] : "";
    }
    return row;
  });
}

function splitList(v: unknown): unknown[] {
  if (v === null || v === undefined || v === "") return [];
  if (Array.isArray(v)) return v;
  return pyStr(v).split(";").map((x) => x.trim());
}

// timeframe=hourly arrays (PVWatts v8 docs): name -> column with its unit
const HOURLY: Record<string, string> = { ac: "ac_w", dc: "dc_w", poa: "poa_w_m2", dn: "dn_w_m2", df: "df_w_m2", tamb: "tamb_c",
  tcell: "tcell_c", wspd: "wspd_m_s", alb: "alb" };
const HOURS_PER_YEAR = 8760; // typical meteorological year: 365 days, no Feb 29
const ANNUAL = ["ac_annual", "solrad_annual", "capacity_factor"];

function annualOf(r: Row): Row {
  return Object.fromEntries(ANNUAL.filter((k) => k in r).map((k) => [k, r[k]]));
}

function pvwattsHourly(r: Row, cols: Record<string, unknown[]>): Row[] {
  const lens = Object.values(cols).map((v) => v.length);
  const n = Math.max(...lens);
  if (n % HOURS_PER_YEAR || lens.some((x) => x !== n)) {
    throw new DataError(`pvwatts timeframe=hourly returned arrays of [${[...new Set(lens)].sort((a, b) => a - b).join(", ")}] ` +
      `values, not a multiple of ${HOURS_PER_YEAR} hours; the pack cannot place them in time. ` +
      "Use timeframe=monthly or check the request.", "bad_request");
  }
  const perHour = n / HOURS_PER_YEAR;
  const stepMin = 60 % perHour === 0 ? 60 / perHour : null;
  const t0 = Date.UTC(2001, 0, 1); // any non-leap year; only month/day/hour are written
  const annual = annualOf(r);
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(stepMin ? t0 + i * stepMin * 60000 : t0 + Math.floor(i / perHour) * 3600000);
    const row: Row = { step: i, month: t.getUTCMonth() + 1, day: t.getUTCDate(), hour: t.getUTCHours() };
    if (perHour > 1) row.minute = stepMin ? t.getUTCMinutes() : "";
    for (const [c, v] of Object.entries(cols)) row[c] = v[i];
    Object.assign(row, annual);
    out.push(row);
  }
  return out;
}

function pvwatts(rows: Row[]): Row[] {
  if (!rows.length) return rows;
  const r = rows[0];
  const set = (v: unknown) => v !== null && v !== undefined && v !== "";
  const hourly: Record<string, unknown[]> = {};
  for (const [old, nw] of Object.entries(HOURLY)) if (set(r[old])) hourly[nw] = splitList(r[old]);
  if (Object.keys(hourly).length && Math.max(...Object.values(hourly).map((v) => v.length)) > 12) return pvwattsHourly(r, hourly);
  const monthly: Record<string, string> = { ac_monthly: "ac_kwh", dc_monthly: "dc_kwh", poa_monthly: "poa_kwh_m2",
    solrad_monthly: "solrad_kwh_m2_day" };
  const cols: Record<string, unknown[]> = {};
  for (const [old, nw] of Object.entries(monthly)) if (set(r[old])) cols[nw] = splitList(r[old]);
  if (!Object.keys(cols).length || !Object.values(cols).some((v) => v.length === 12)) return rows; // an unexpected shape: keep as is
  const annual = annualOf(r);
  return Array.from({ length: 12 }, (_, i) => ({ month: i + 1,
    ...Object.fromEntries(Object.entries(cols).map(([c, v]) => [c, i < v.length ? v[i] : ""])), ...annual }));
}

function cities(v: unknown): Set<string> {
  const vals = Array.isArray(v) ? v : [v];
  return new Set(vals.filter((x) => pyStr(x).trim()).map((x) => pyStr(x).split(/\s+/).filter(Boolean).join(" ").toLowerCase()));
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    if (p.city !== null && p.city !== undefined && p.city !== "" && !(p.state || p.zip)) {
      probs.push(`request ${repr(r.name)}: city is matched by the pack on the rows the API returns (the API ` +
        "has no city filter), so give state (or zip) too, or it pages through the whole country");
    }
  }
  return probs;
}

function normalize(req: SpecRequest, ep: any, rows: Row[]): Row[] {
  const p: string = ep.path || "";
  if (p.startsWith("/solar/solar_resource")) return solar(rows);
  if (p.startsWith("/pvwatts/")) return pvwatts(rows);
  const want = cities((req.params || {}).city || []);
  if (want.size && p.startsWith("/alt-fuel-stations")) {
    // the station API has no city parameter: sent, it answers 0 rows (verified 2026-10-28), so the pack
    // fetches the state or ZIP and keeps the rows whose city matches (JSON "city", CSV export "City")
    rows = rows.filter((r) => want.has(pyStr("city" in r ? r.city : "City" in r ? r.City : "").split(/\s+/).filter(Boolean)
      .join(" ").toLowerCase()));
  }
  return rows;
}

/** The core fetch, with the city match judged after paging: a state or ZIP fetch cut at max_rows leaves the
 * city's rows incomplete (said in a "stopped at" note, so the result is partial, never silently short), and an
 * empty city is an error only when every station was read. */
async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const city = new Set(spec.requests.filter((r) => cities((r.params || {}).city || []).size).map((r) => r.name));
  const run = { ...spec, requests: spec.requests.map((r) => (city.has(r.name) ? { ...r, allow_empty: true } : r)) };
  const [tables, notes] = await fetchSpec(pack, run);
  const head = (n: string) => (n.includes(":") ? n.slice(0, n.indexOf(":")) : n);
  const cut = new Set(notes.filter((n) => n.includes("stopped at")).map(head));
  const out = notes.map((n) => {
    const name = head(n);
    if (city.has(name) && cut.has(name) && n.includes("stopped at")) {
      const t = tables[name];
      return `${name}: stopped at max_rows before every station of the state or ZIP was read, so the ` +
        `${Array.isArray(t) ? t.length : 0} rows kept for the city may be incomplete (the city is matched after ` +
        "paging): raise max_rows or leave it unset.";
    }
    return n;
  });
  const miss = new Misses();
  for (const r of spec.requests) {
    if (city.has(r.name) && !cut.has(r.name)) {
      const t = tables[r.name];
      miss.checkEmpty(r, Array.isArray(t) ? t : []);
    }
  }
  miss.raiseIfAny("", "no station of that state or ZIP lists this city: check the spelling against the " +
    "city column of a state fetch");
  return [tables, out];
}

const adapter: Adapter = { checkError, checkSpec: (spec) => checkSpec(spec), normalize, fetch: (spec, pack) => fetch(spec, pack) };
export default adapter;
