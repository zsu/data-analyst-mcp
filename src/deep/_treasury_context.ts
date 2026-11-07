/**
 * Non-Treasury context series for the treasury pack (port of sources/treasury/context.py): CPI (to express dollars
 * in real terms) and GDP (amounts as a share of the economy). Use only when the user wants real dollars or "% of GDP".
 *
 * Sources, tried in order (the first that answers wins; the file records which one was used):
 *   cpi  1. FRED CPIAUCNS (fredgraph.csv, no key)  2. BLS CUUR0000SA0 (v1 without a key, v2 with BLS_API_KEY)
 *   gdp  1. FRED GDP (quarterly, billions, SAAR)    2. World Bank NY.GDP.MKTP.CN (annual CALENDAR years)
 * `start` is the first FISCAL year needed: data are kept from October 1 of the year before.
 * Output: <workspace>/data/treasury/context_<kind>.csv (date, value) and context_sources.json.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "../core/http.js";
import * as keys from "../core/keys.js";
import { dataDir } from "../core/package.js";
import { pyFloatRepr } from "../core/py.js";
import { readCsv, writeCsv } from "../core/tabular.js";

const UA = "Mozilla/5.0 (data-analyst treasury pack)";
export const SERIES: Record<string, { fred: string; bls?: string; worldbank?: string; units: string; frequency: string }> = {
  cpi: { fred: "CPIAUCNS", bls: "CUUR0000SA0",
    units: "Index 1982-84=100, not seasonally adjusted (CPI-U, U.S. city average, all items)", frequency: "monthly" },
  gdp: { fred: "GDP", worldbank: "NY.GDP.MKTP.CN",
    units: "Billions of dollars, seasonally adjusted annual rate (FRED/BEA); World Bank fallback is " +
      "annual calendar-year dollars, converted to billions", frequency: "quarterly" },
};
const BLS_AUTH: keys.Auth = { env: "BLS_API_KEY", home: "bls", placement: "body", param: "registrationkey" };
export const MANUAL: Record<string, string[]> = {
  cpi: ["https://fred.stlouisfed.org/series/CPIAUCNS (Download > CSV)",
    "https://data.bls.gov/timeseries/CUUR0000SA0 (More formatting options > Download)"],
  gdp: ["https://fred.stlouisfed.org/series/GDP (Download > CSV)",
    "https://apps.bea.gov/iTable/?reqid=19&step=2&isuri=1&categories=survey (NIPA Table 1.1.5)"],
};

type Obs = [string, number];

const client = (timeout: number, auth?: keys.Auth) => new Client("", { name: "treasury-context", auth, rps: 2, burst: 2,
  retries: 0, timeout, deadline: timeout * 2, userAgent: UA });

export const fyStart = (start: number) => `${start - 1}-10-01`;

/** Months absent between the first and last monthly date (October 2025 CPI was never collected). */
export function missingMonths(rows: Obs[]): string[] {
  const dates = rows.map((r) => r[0].slice(0, 7));
  if (dates.length < 2 || !rows.every((r) => ["", "01"].includes(r[0].slice(8, 10)))) return [];
  let y = Number(dates[0].slice(0, 4)), m = Number(dates[0].slice(5, 7));
  const have = new Set(dates), out: string[] = [];
  const key = () => `${y}-${String(m).padStart(2, "0")}`;
  while (key() <= dates[dates.length - 1]) {
    if (!have.has(key())) out.push(key());
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
  return out.length < dates.length ? out : [];
}

const cmp = (a: Obs, b: Obs) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);

async function fromFred(series: string, start: number, timeout: number): Promise<[Obs[], string]> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}`;
  const text = (await client(timeout).get(url)).text();
  const rows: Obs[] = [];
  for (const line of text.split(/\r?\n/)) {
    const r = line.split(",");
    if (r.length < 2 || !/^\d{4}/.test(r[0])) continue;
    if (r[1] === "." || r[1] === "") continue;
    if (r[0].slice(0, 10) >= fyStart(start)) rows.push([r[0], Number(r[1])]);
  }
  return [rows, url];
}

async function fromBls(series: string, start: number, timeout: number): Promise<[Obs[], string]> {
  const [key] = keys.findKey("BLS_API_KEY", "bls");
  const [ver, span] = key ? ["v2", 20] : ["v1", 10];
  const url = `https://api.bls.gov/publicAPI/${ver}/timeseries/data/`;
  const end = new Date().getFullYear();
  const seen = new Map<string, Obs>();
  const c = client(timeout, key ? BLS_AUTH : undefined);
  for (let y0 = start - 1; y0 <= end; y0 += span) {
    const body = { seriesid: [series], startyear: String(y0), endyear: String(Math.min(y0 + span - 1, end)) };
    const j: any = (await c.request("POST", url, null, { jsonBody: body })).json();
    if (j.status !== "REQUEST_SUCCEEDED") throw new Error(keys.redact(`BLS: ${j.status} ${j.message}`));
    for (const d of j.Results.series[0].data) {
      if (String(d.period).startsWith("M") && d.period !== "M13" && !["-", ""].includes(d.value)) {
        const o: Obs = [`${d.year}-${String(d.period).slice(1)}-01`, Number(d.value)];
        seen.set(JSON.stringify(o), o);
      }
    }
  }
  return [[...seen.values()].sort(cmp).filter((r) => r[0] >= fyStart(start)), url + series];
}

async function fromWorldbank(indicator: string, start: number, timeout: number): Promise<[Obs[], string]> {
  const url = `https://api.worldbank.org/v2/country/USA/indicator/${indicator}?format=json&per_page=200` +
    `&date=${start - 1}:${new Date().getFullYear()}`;
  const j: any = JSON.parse((await client(timeout).get(url)).text());
  const rows: Obs[] = j[1].filter((d: any) => d.value !== null && d.value !== undefined).map((d: any) => [`${d.date}-01-01`, d.value / 1e9]);
  return [rows.sort(cmp), url];
}

export type ContextResult = { status: "ok"; kind: string; path: string; source: string; series_id: string; url: string;
  rows: number; failed_sources: string[]; missing_months: string[] } | { status: "blocked"; kind: string; errors: string[];
  manual_download: string[]; message: string };

/** Fetch one context series into data/treasury/ (or report that no source answered). */
export async function fetchContext(kind: string, out: string, start: number, timeout = 25): Promise<ContextResult> {
  const s = SERIES[kind];
  const attempts: [string, () => Promise<[Obs[], string]>, string, string][] = [["FRED", () => fromFred(s.fred, start, timeout), s.fred, s.frequency]];
  if (kind === "cpi") attempts.push(["BLS", () => fromBls(s.bls!, start, timeout), s.bls!, "monthly"]);
  else attempts.push(["World Bank", () => fromWorldbank(s.worldbank!, start, timeout), s.worldbank!, "annual (calendar year)"]);
  const errors: string[] = [];
  for (const [name, fn, sid, freq] of attempts) {
    let rows: Obs[], url: string;
    try {
      [rows, url] = await fn();
      if (!rows.length) throw new Error("no rows returned");
    } catch (e: any) {
      errors.push(keys.redact(`${name}: ${String(e?.message ?? e).slice(0, 160)}`));
      continue;
    }
    const d = dataDir(out, "treasury");
    fs.mkdirSync(d, { recursive: true });
    const p = path.join(d, `context_${kind}.csv`);
    fs.writeFileSync(p, writeCsv(rows.map(([date, value]) => ({ date, value: pyFloatRepr(value) })), ["date", "value"]));
    const metaPath = path.join(d, "context_sources.json");
    let meta: Record<string, any> = {};
    if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta[kind] = { source: name, series_id: sid, url, frequency: freq,
      units: name !== "World Bank" ? s.units : "Billions of current dollars, calendar year",
      first: rows[0][0], last: rows[rows.length - 1][0], rows: rows.length,
      retrieved: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      sha256: createHash("sha256").update(fs.readFileSync(p)).digest("hex"), failed_sources: errors,
      missing_months: missingMonths(rows) };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return { status: "ok", kind, path: p, ...meta[kind] };
  }
  return { status: "blocked", kind, errors, manual_download: MANUAL[kind],
    message: `No ${kind.toUpperCase()} source answered from here. Ask the user whether to continue in nominal ` +
      "dollars (and say so in the product) or to download the series by hand and upload it as " +
      `context_${kind}.csv with columns date,value.` };
}

/** Rows of a context file (for the table summary). */
export function contextRows(p: string): number {
  return readCsv(fs.readFileSync(p, "utf8")).length;
}
