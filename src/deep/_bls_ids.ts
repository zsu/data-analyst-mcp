/**
 * BLS series IDs: survey prefixes, a topic catalog of common series, and ID builders (port of
 * sources/bls/lib/series_ids.py; the data are in packs/bls/series_ids.json).
 *
 *   build("laus", { state: "MD", measure: "unemployment_rate" })   // [{id: "LASST240000000000003", label: ...}]
 *   build("laus", { county: "24005" })                             // county LAUS (published unadjusted only)
 *   build("oews", { occupation: "15-1252", measure: "annual_median_wage", state: "MD" })
 *   build("state", { state: "MD" })                                // LAUS rate, employment, labor force + CES payrolls
 *
 * Watch these IDs: U-6 is LNS13327709 (LNS13023621 is a level of job losers, not U-6); the ECI prefix is CI (EI is
 * import/export prices); WPUFD4 is PPI final demand, not finished goods.
 */
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import { pyStr } from "../core/py.js";

type Data = { verified: string; surveys: [string, string, boolean][]; catalog: [string, string, string][];
  laus_measures: [string, string][]; oews_measures: [string, string][]; jolts_industries: [string, string][];
  jolts_elements: [string, string][]; builders: string[]; states: [string, string, string][] };

let data: Data | null = null;
export function D(): Data {
  if (!data) data = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, "bls", "series_ids.json"), "utf8")) as Data;
  return data;
}

/** A ValueError of the Python builders (a spec problem). */
export class SpecError extends Error {}

/** Python repr() of a str or a list of str. */
export function pyRepr(s: unknown): string {
  if (s === null || s === undefined) return "None";
  if (Array.isArray(s)) return "[" + s.map(pyRepr).join(", ") + "]";
  if (typeof s !== "string") return pyStr(s);
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n") + q;
}

const sortedKeys = (pairs: [string, string][]) => pairs.map(([k]) => k).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const lookup = (pairs: [string, string][], k: string) => pairs.find(([x]) => x === k)?.[1];

/** (usps, fips, name) from any form (USPS code, FIPS code, name). */
export function state(x: unknown): [string, string, string] {
  let key = pyStr(x).trim().toLowerCase();
  if (/^\d+$/.test(key) && key.length <= 2) key = key.padStart(2, "0");
  const by = new Map<string, [string, string, string]>();
  for (const s of D().states) for (const k of [s[0].toLowerCase(), s[1], s[2].toLowerCase(), String(Number(s[1]))]) by.set(k, s);
  const hit = by.get(key) ?? by.get(key.replace(/^0+/, ""));
  if (!hit) throw new SpecError(`unknown state ${pyRepr(x)}: give a USPS code (MD), a FIPS code (24) or a name (Maryland)`);
  return hit;
}

export function decode(sid0: string): { series_id: string; prefix: string; survey: string; seasonal: string } {
  const sid = sid0.trim().toUpperCase();
  const pre = sid.slice(0, 2);
  const s = D().surveys.find(([p]) => p === pre);
  const [name, hasSa] = s ? [s[1], s[2]] : ["unknown survey prefix: check https://www.bls.gov/help/hlpforma.htm", false];
  let seasonal = "";
  if (hasSa && sid.length > 2 && "SU".includes(sid[2])) seasonal = sid[2] === "S" ? "seasonally adjusted" : "not seasonally adjusted";
  return { series_id: sid, prefix: pre, survey: name, seasonal };
}

/** _list(): a comma-separated string or a list, as stripped non-empty strings. */
function list(x: unknown): string[] {
  if (x === null || x === undefined || x === "") return [];
  if (Array.isArray(x)) return x.map((v) => pyStr(v).trim()).filter(Boolean);
  return pyStr(x).split(",").map((v) => v.trim()).filter(Boolean);
}

export type Built = { id: string; label: string };

export function laus(st: unknown, county: unknown, measure = "unemployment_rate", seasonal = "S"): Built[] {
  const code = lookup(D().laus_measures, measure);
  if (!code) throw new SpecError(`LAUS measure must be one of ${pyRepr(sortedKeys(D().laus_measures))}`);
  const words = measure.replaceAll("_", " ");
  const out: Built[] = [];
  for (const c of list(county)) {
    if (!/^\d{5}$/.test(c)) throw new SpecError(`county must be a 5-digit FIPS code (state + county, e.g. 24005), got ${pyRepr(c)}`);
    out.push({ id: `LAUCN${c}00000000${code}`, label: `County ${c} ${words} (not seasonally adjusted)` });
  }
  for (const s of list(st)) {
    const [, fips, name] = state(s);
    const sa = (seasonal || "S").toUpperCase().slice(0, 1);
    if (!"SU".includes(sa)) throw new SpecError("seasonal must be S (adjusted) or U (not adjusted)");
    out.push({ id: `LA${sa}ST${fips}00000000000${code}`,
      label: `${name} ${words} (${sa === "S" ? "seasonally adjusted" : "not seasonally adjusted"})` });
  }
  if (!out.length) throw new SpecError("laus needs state (name, USPS or FIPS) or county (5-digit FIPS)");
  return out;
}

export function oews(occupation: unknown, measure = "annual_median_wage", st?: unknown): Built[] {
  const code = lookup(D().oews_measures, measure);
  if (!code) throw new SpecError(`OEWS measure must be one of ${pyRepr(sortedKeys(D().oews_measures))}`);
  const out: Built[] = [];
  for (const occ of list(occupation)) {
    const soc = occ.replaceAll("-", "");
    if (!/^\d{6}$/.test(soc)) throw new SpecError(`SOC occupation code must look like "15-1252", got ${pyRepr(occ)}`);
    let area: string, where: string;
    if (st) {
      const [, fips, name] = state(st);
      [area, where] = [`S${fips}00000`, name];
    } else [area, where] = ["N0000000", "United States"];
    out.push({ id: `OEU${area}000000${soc}${code}`,
      label: `SOC ${soc.slice(0, 2)}-${soc.slice(2)} ${measure.replaceAll("_", " ")}, ${where} (OEWS, annual)` });
  }
  if (!out.length) throw new SpecError("oews needs occupation (SOC code, e.g. 15-1252)");
  return out;
}

export function cesState(st: unknown, industry = "00000000", datatype = "01", seasonal = "S"): Built[] {
  if (!/^\d{8}$/.test(industry) || !/^\d{2}$/.test(datatype)) {
    throw new SpecError("industry is 8 digits (00000000 = total nonfarm), datatype 2 digits (01 = employment)");
  }
  return list(st).map((s) => {
    const [, fips, name] = state(s);
    const sa = (seasonal || "S").toUpperCase().slice(0, 1);
    const what = industry === "00000000" && datatype === "01" ? "total nonfarm employment (thousands)"
      : `industry ${industry}, data type ${datatype}`;
    return { id: `SM${sa}${fips}00000${industry}${datatype}`, label: `${name} ${what} (${sa === "S" ? "SA" : "NSA"})` };
  });
}

export function jolts(industry: unknown = "000000", measure = "quits", rate = true, seasonal = "S"): Built[] {
  const el = lookup(D().jolts_elements, measure);
  if (!el) throw new SpecError(`JOLTS measure must be one of ${pyRepr(sortedKeys(D().jolts_elements))}`);
  const sa = (seasonal || "S").toUpperCase().slice(0, 1);
  if (!"SU".includes(sa)) throw new SpecError("seasonal must be S (adjusted) or U (not adjusted)");
  const inds = D().jolts_industries;
  const names = new Map(inds.map(([k, v]) => [v.toLowerCase(), k]));
  const l = list(industry);
  const want = pyStr(industry).toLowerCase() === "all" ? inds.map(([k]) => k) : l.length ? l : ["000000"];
  return want.map((i) => {
    const code = i === "00000000" ? "000000" : names.get(i.toLowerCase()) ?? i;
    const title = lookup(inds, code);
    if (!title) throw new SpecError(`unknown JOLTS industry ${pyRepr(i)}; use a code or name from: ` + inds.map(([k, v]) => `${k} ${v}`).join("; "));
    const m = measure.replaceAll("_", " ");
    return { id: `JT${sa}${code}000000000${el}${rate ? "R" : "L"}`,
      label: `${m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()} ${rate ? "rate" : "level (thousands)"}, ${title} (${sa === "S" ? "SA" : "NSA"})` };
  });
}

/** The state employment set: LAUS unemployment rate, employment, labor force and CES payrolls. */
export function stateSet(st: unknown): Built[] {
  const out: Built[] = [];
  for (const m of ["unemployment_rate", "employment", "labor_force"]) out.push(...laus(st, null, m));
  return [...out, ...cesState(st)];
}

export function build(kind: string, kw0: Record<string, unknown>): Built[] {
  const kw = Object.fromEntries(Object.entries(kw0).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  const str = (k: string, d: string) => (k in kw ? pyStr(kw[k]) : d);
  if (kind === "laus") return laus(kw.state, kw.county, str("measure", "unemployment_rate"), str("seasonal", "S"));
  if (kind === "oews") return oews(kw.occupation, str("measure", "annual_median_wage"), kw.state);
  if (kind === "state") return stateSet(kw.state);
  if (kind === "ces_state") return cesState(kw.state, str("industry", "00000000"), str("datatype", "01"), str("seasonal", "S"));
  if (kind === "jolts") {
    return jolts(kw.industry ?? "000000", str("measure", "quits"),
      !["false", "0", "level", "no"].includes(pyStr(kw.rate ?? true).toLowerCase()), str("seasonal", "S"));
  }
  throw new SpecError(`unknown builder ${pyRepr(kind)}; use one of (${D().builders.map(pyRepr).join(", ")})`);
}

export function searchCatalog(words: string, limit = 20): { id: string; name: string; topic: string }[] {
  const toks: string[] = words.toLowerCase().match(/[a-z0-9-]+/g) || [];
  const hits: [number, { id: string; name: string; topic: string }][] = [];
  for (const [sid, name, topic] of D().catalog) {
    const text = `${sid} ${name} ${topic}`.toLowerCase();
    const score = toks.filter((t) => text.includes(t)).length + (toks.includes(topic) ? 2 : 0);
    if (score) hits.push([-score, { id: sid, name, topic }]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits.slice(0, limit).map((h) => h[1]);
}

export function topics(): string[] {
  return [...new Set(D().catalog.map(([, , t]) => t))].sort();
}
