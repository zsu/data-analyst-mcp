/**
 * HHS poverty guidelines from ASPE's Poverty Guidelines API: GET /api/<year>/<state>/<household_size> returns one
 * guideline ({"data": {"year", "state", "household_size", "income"}}). Verified 2026-11-25: years 1983 to the
 * current year, areas us/ak/hi. The API never refuses a bad value: an unknown year answers the latest year, an
 * unknown area answers us, a size that is not a number answers size 1, and size 0 answers the per-person amount.
 * So the spec is checked first and every reply is checked against what was asked. Sizes above 8 are extended by
 * the API with the published amount for each additional person.
 */
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const AREAS: Record<string, string> = { us: "48 contiguous states and DC", ak: "Alaska", hi: "Hawaii" };
export const FIRST_YEAR = 1983;
const MAX_SIZE = 20;
const MAX_CALLS = 600;

/** One value, a list or a range "a-b" as a list of strings (ranges only for integers). */
export function expand(v: unknown): string[] {
  const items = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
  const out: string[] = [];
  for (const x of items) {
    const s = pyStr(x).trim();
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(s);
    if (m && Number(m[2]) >= Number(m[1]) && Number(m[2]) - Number(m[1]) < 200) {
      for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(String(i));
    } else if (s) out.push(...s.split(",").map((t) => t.trim()).filter(Boolean));
  }
  return [...new Set(out)];
}

const years = (r: SpecRequest) => expand(r.params?.year);
const areas = (r: SpecRequest) => (expand(r.params?.state).length ? expand(r.params?.state) : ["us"]).map((s) => s.toLowerCase());
const sizes = (r: SpecRequest) => (expand(r.params?.household_size).length ? expand(r.params?.household_size) : expand("1-8"));

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    if (r.endpoint !== "guidelines") continue;
    const n = JSON.stringify(r.name);
    const y = years(r);
    if (!y.length) bad.push(`request ${n}: year is required (one year, a list, or a range such as "2015-2024")`);
    const yBad = y.filter((v) => !/^\d{4}$/.test(v) || Number(v) < FIRST_YEAR);
    if (yBad.length) bad.push(`request ${n}: year ${yBad.join(", ")}: the API has guidelines for ${FIRST_YEAR} to the current year`);
    const aBad = areas(r).filter((a) => !(a in AREAS));
    if (aBad.length) bad.push(`request ${n}: state ${aBad.join(", ")}: use us (48 contiguous states and DC), ak or hi`);
    const sBad = sizes(r).filter((s) => !/^\d+$/.test(s) || Number(s) < 1 || Number(s) > MAX_SIZE);
    if (sBad.length) bad.push(`request ${n}: household_size ${sBad.join(", ")}: use 1 to ${MAX_SIZE}`);
    const calls = y.length * areas(r).length * sizes(r).length;
    if (calls > MAX_CALLS) bad.push(`request ${n}: ${calls} year x area x size combinations (max ${MAX_CALLS}): ask fewer years or sizes`);
  }
  return bad;
}

/** One API reply as a row, after checking that it answers what was asked. */
export function guidelineRow(asked: { year: string; state: string; household_size: string }, rec: Row): Row {
  const got = { year: pyStr(rec.year ?? "").trim(), state: pyStr(rec.state ?? "").trim().toLowerCase(),
    household_size: pyStr(rec.household_size ?? "").trim() };
  const income = Number(pyStr(rec.income ?? "").trim());
  if (got.year !== asked.year) {
    throw new DataError(`no HHS poverty guidelines for ${asked.year}: the API answered ${got.year || "nothing"} instead (it ` +
      "answers the latest year for a year it does not have). Ask for years up to the latest published one.", "bad_request");
  }
  if (got.state !== asked.state || got.household_size !== asked.household_size || !Number.isFinite(income) || income <= 0) {
    throw new DataError(`the poverty guidelines API answered ${JSON.stringify(rec)} for ${asked.year}/${asked.state}/` +
      `${asked.household_size}: not the guideline asked for`, "api");
  }
  return { year: Number(asked.year), state: asked.state.toUpperCase(), area: AREAS[asked.state],
    household_size: Number(asked.household_size), poverty_guideline: income };
}

async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const subs: SpecRequest[] = [];
  const asked = new Map<string, { group: string; year: string; state: string; household_size: string }>();
  for (const r of spec.requests) {
    if (r.endpoint !== "guidelines") throw new DataError(`request ${JSON.stringify(r.name)}: unknown endpoint ${JSON.stringify(r.endpoint)} (known: guidelines)`, "bad_request");
    for (const year of years(r)) for (const state of areas(r)) for (const household_size of sizes(r)) {
      const name = `${r.name}__${subs.length + 1}`;
      subs.push({ name, endpoint: "guidelines", params: { year, state, household_size } });
      asked.set(name, { group: r.name, year, state, household_size });
    }
  }
  const [t, notes] = await gr.fetchSpec(pack, { ...spec, requests: subs });
  const tables: Tables = {};
  for (const r of spec.requests) tables[r.name] = [];
  for (const s of subs) {
    const a = asked.get(s.name)!;
    const rows = (t[s.name] || []) as Row[];
    if (rows.length !== 1) throw new DataError(`the poverty guidelines API gave ${rows.length} records for ${a.year}/${a.state}/${a.household_size}`, "api");
    (tables[a.group] as Row[]).push(guidelineRow(a, rows[0]));
  }
  return [tables, notes.map((n) => n.replace(/__\d+\b/g, ""))];
}

const adapter: Adapter = { fetch, checkSpec };
export default adapter;
