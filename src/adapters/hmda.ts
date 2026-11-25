/**
 * HMDA Data Browser API (FFIEC, run by the CFPB): counts and dollar sums of the mortgage applications and loans
 * that lenders report under the Home Mortgage Disclosure Act, by year, geography and the filters asked.
 * GET /aggregations?years=Y&states=S&<filter>=a,b returns {"parameters", "aggregations": [{count, sum, <filter
 * values>}]}; /nationwide/aggregations takes no geography. Verified 2026-11-25:
 *   - a list of years or of geographies is summed into one figure with no year or place column, so the pack sends
 *     one call per year and per state, county or metro code and adds those columns itself;
 *   - the API breaks the figures out by every value of every filter (filters cross), and ignores a filter it cannot
 *     apply (ages), so every reply row is checked to carry each filter asked with one of the values asked;
 *   - "sum" is the total loan amount in dollars, published as a float ("2.3845265E10").
 */
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { pyStr } from "../core/py.js";

export const FIRST_YEAR = 2018;
const MAX_CALLS = 400;
const GEO: Record<string, { level: string; re: RegExp; hint: string }> = {
  states: { level: "state", re: /^[A-Z]{2}$/, hint: "two-letter postal codes such as CA" },
  counties: { level: "county", re: /^\d{5}$/, hint: "5-digit state+county FIPS codes such as 06037" },
  msamds: { level: "msamd", re: /^\d{5}$/, hint: "5-digit MSA or metropolitan division codes such as 35614" },
};
export const FILTERS = ["actions_taken", "loan_types", "loan_purposes", "lien_statuses", "construction_methods",
  "total_units", "dwelling_categories", "loan_products", "races", "ethnicities", "sexes"];
const LABELS: Record<string, Record<string, string>> = {
  actions_taken: { 1: "Loan originated", 2: "Application approved but not accepted", 3: "Application denied",
    4: "Application withdrawn by applicant", 5: "File closed for incompleteness", 6: "Purchased loan",
    7: "Preapproval request denied", 8: "Preapproval request approved but not accepted" },
  loan_types: { 1: "Conventional", 2: "FHA-insured", 3: "VA-guaranteed", 4: "USDA RHS or FSA-guaranteed" },
  loan_purposes: { 1: "Home purchase", 2: "Home improvement", 31: "Refinancing", 32: "Cash-out refinancing",
    4: "Other purpose", 5: "Not applicable" },
  lien_statuses: { 1: "First lien", 2: "Subordinate lien" },
  construction_methods: { 1: "Site-built", 2: "Manufactured home" },
};

/** One value, a list, a comma list or (for years) a range "a-b", as strings. */
export function expand(v: unknown, ranges = false): string[] {
  const items = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
  const out: string[] = [];
  for (const x of items) {
    const s = pyStr(x).trim();
    const m = ranges ? /^(\d{4})\s*-\s*(\d{4})$/.exec(s) : null;
    if (m && Number(m[2]) >= Number(m[1])) {
      for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(String(i));
    } else if (s) out.push(...s.split(",").map((t) => t.trim()).filter(Boolean));
  }
  return [...new Set(out)];
}

const geoKeys = (r: SpecRequest) => Object.keys(GEO).filter((k) => expand(r.params?.[k]).length);
const geoUnits = (r: SpecRequest, k: string) => expand(r.params?.[k]).map((v) => (k === "states" ? v.toUpperCase() : v));
const asked = (r: SpecRequest) => FILTERS.filter((f) => expand(r.params?.[f]).length);

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    if (r.endpoint !== "aggregations" && r.endpoint !== "nationwide") continue;
    const n = JSON.stringify(r.name);
    const p = r.params || {};
    const years = expand(p.years, true);
    if (!years.length) bad.push(`request ${n}: years is required (one year, a list, or a range such as "2018-2024")`);
    const yBad = years.filter((y) => !/^\d{4}$/.test(y) || Number(y) < FIRST_YEAR);
    if (yBad.length) bad.push(`request ${n}: years ${yBad.join(", ")}: the Data Browser has ${FIRST_YEAR} on`);
    if (!expand(p.actions_taken).length) {
      bad.push(`request ${n}: actions_taken is required: 1 for originated loans; without it every application, denial, ` +
        "withdrawal and purchased loan (6, often counted again from its originator) is added together");
    }
    if (asked(r).length > 2) {
      bad.push(`request ${n}: ${asked(r).join(", ")}: the API takes at most two filters (actions_taken and one more); ` +
        "make one request per extra breakdown");
    }
    if (expand(p.ages).length) bad.push(`request ${n}: ages is not applied by the API (it answers as if it were absent): leave it out`);
    const keys = geoKeys(r);
    if (r.endpoint === "nationwide" && keys.length) bad.push(`request ${n}: nationwide takes no ${keys.join(", ")}: use aggregations`);
    if (r.endpoint === "aggregations") {
      if (keys.length !== 1) bad.push(`request ${n}: aggregations needs exactly one of states, counties or msamds (nationwide for the U.S.)`);
      for (const k of keys) {
        const wrong = geoUnits(r, k).filter((v) => !GEO[k].re.test(v));
        if (wrong.length) bad.push(`request ${n}: ${k} ${wrong.join(", ")}: use ${GEO[k].hint}`);
      }
    }
    const calls = years.length * (keys.length === 1 ? geoUnits(r, keys[0]).length : 1);
    if (calls > MAX_CALLS) bad.push(`request ${n}: ${calls} year x place calls (max ${MAX_CALLS}): ask fewer years or places`);
  }
  return bad;
}

/** One reply row as an output row, after checking it carries every filter asked with a value asked. */
export function aggregationRow(ctx: { year: string; level: string; code: string; filters: Record<string, string[]> },
  rec: Row): Row {
  const row: Row = { year: Number(ctx.year), geography: ctx.level, geography_code: ctx.code };
  for (const [f, vals] of Object.entries(ctx.filters)) {
    const got = pyStr(rec[f] ?? "").trim();
    if (!got || !vals.includes(got)) {
      throw new DataError(`the HMDA Data Browser answered ${JSON.stringify(rec)} for ${ctx.year} ${ctx.level} ${ctx.code}: ` +
        `filter ${f}=${vals.join(",")} was not applied`, "api");
    }
    row[f] = got;
    if (LABELS[f]) row[`${f}_label`] = LABELS[f][got] ?? "";
  }
  const count = Number(pyStr(rec.count ?? "").trim());
  const sum = Number(pyStr(rec.sum ?? "").trim());
  if (!Number.isFinite(count) || !Number.isFinite(sum)) throw new DataError(`the HMDA Data Browser answered ${JSON.stringify(rec)}: no count or sum`, "api");
  row.count = count;
  row.loan_amount = Math.round(sum);
  return row;
}

async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const subs: SpecRequest[] = [];
  const ctx = new Map<string, { group: string; year: string; level: string; code: string; filters: Record<string, string[]> }>();
  for (const r of spec.requests) {
    if (r.endpoint !== "aggregations" && r.endpoint !== "nationwide") {
      throw new DataError(`request ${JSON.stringify(r.name)}: unknown endpoint ${JSON.stringify(r.endpoint)} (known: aggregations, nationwide)`, "bad_request");
    }
    const filters: Record<string, string[]> = {};
    for (const f of asked(r)) filters[f] = expand(r.params?.[f]);
    const key = geoKeys(r)[0];
    const units = key ? geoUnits(r, key) : ["US"];
    for (const year of expand(r.params?.years, true)) for (const code of units) {
      const name = `${r.name}__${subs.length + 1}`;
      const params: Record<string, unknown> = { years: year };
      if (key) params[key] = code;
      for (const [f, vals] of Object.entries(filters)) params[f] = vals.join(",");
      subs.push({ name, endpoint: r.endpoint, params, max_rows: r.max_rows });
      ctx.set(name, { group: r.name, year, level: key ? GEO[key].level : "nation", code, filters });
    }
  }
  const [t, notes] = await gr.fetchSpec(pack, { ...spec, requests: subs });
  const tables: Tables = {};
  for (const r of spec.requests) tables[r.name] = [];
  const zero = new Map<string, Set<string>>();
  for (const s of subs) {
    const c = ctx.get(s.name)!;
    const rows = ((t[s.name] || []) as Row[]).map((rec) => aggregationRow(c, rec));
    if (rows.length && rows.every((x) => x.count === 0)) {
      if (!zero.has(c.group)) zero.set(c.group, new Set());
      zero.get(c.group)!.add(`${c.level} ${c.code} (${c.year})`);
    }
    (tables[c.group] as Row[]).push(...rows);
  }
  for (const [g, places] of zero) {
    notes.push(`${g}: count 0 for ${[...places].slice(0, 10).join(", ")}: the API answers 0, not an error, for a code it does ` +
      "not have. For the largest metro areas HMDA uses metropolitan division codes, not the MSA code; check the code.");
  }
  return [tables, notes.map((x) => x.replace(/__\d+\b/g, ""))];
}

const adapter: Adapter = { fetch, checkSpec };
export default adapter;
