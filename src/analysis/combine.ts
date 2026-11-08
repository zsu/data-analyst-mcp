/**
 * Helpers for combining sources (a port of scripts/analysis/combine.py), on compute's tables.
 * Sources disagree on periods, geography codes, units and vintages; these make the conversions explicit and
 * refuse silent ones:
 *   fiscalYear(date)        federal fiscal year (October-September, named for the year it ends)
 *   toFiscal(t, ...)        calendar data to fiscal years, with a `complete` flag (12 distinct months or 4
 *                           quarters); incomplete years are kept but flagged, never presented as full years
 *   state(x, as)            one state in any form to another (raises with the accepted forms)
 *   addStateCodes(t, col)   adds state_usps, state_fips and state_name
 *   alignCheck(...)         before a join: keys present and unique, overlapping, units named
 *   deflate(...)            real dollars with a named index and base period
 * Python printed its reports; here they are returned as notes.
 */
import { namesHint } from "../core/compact.js";
import { dateParts } from "./expr.js";
import { pyRepr } from "./pyfmt.js";
import { cellText, newRow, type Row, type Table, type Value } from "./table.js";

export class CombineError extends Error {}

export const STATES: [string, string, string][] = [
  ["AL", "01", "Alabama"], ["AK", "02", "Alaska"], ["AZ", "04", "Arizona"], ["AR", "05", "Arkansas"],
  ["CA", "06", "California"], ["CO", "08", "Colorado"], ["CT", "09", "Connecticut"], ["DE", "10", "Delaware"],
  ["DC", "11", "District of Columbia"], ["FL", "12", "Florida"], ["GA", "13", "Georgia"], ["HI", "15", "Hawaii"],
  ["ID", "16", "Idaho"], ["IL", "17", "Illinois"], ["IN", "18", "Indiana"], ["IA", "19", "Iowa"],
  ["KS", "20", "Kansas"], ["KY", "21", "Kentucky"], ["LA", "22", "Louisiana"], ["ME", "23", "Maine"],
  ["MD", "24", "Maryland"], ["MA", "25", "Massachusetts"], ["MI", "26", "Michigan"], ["MN", "27", "Minnesota"],
  ["MS", "28", "Mississippi"], ["MO", "29", "Missouri"], ["MT", "30", "Montana"], ["NE", "31", "Nebraska"],
  ["NV", "32", "Nevada"], ["NH", "33", "New Hampshire"], ["NJ", "34", "New Jersey"], ["NM", "35", "New Mexico"],
  ["NY", "36", "New York"], ["NC", "37", "North Carolina"], ["ND", "38", "North Dakota"], ["OH", "39", "Ohio"],
  ["OK", "40", "Oklahoma"], ["OR", "41", "Oregon"], ["PA", "42", "Pennsylvania"], ["RI", "44", "Rhode Island"],
  ["SC", "45", "South Carolina"], ["SD", "46", "South Dakota"], ["TN", "47", "Tennessee"], ["TX", "48", "Texas"],
  ["UT", "49", "Utah"], ["VT", "50", "Vermont"], ["VA", "51", "Virginia"], ["WA", "53", "Washington"],
  ["WV", "54", "West Virginia"], ["WI", "55", "Wisconsin"], ["WY", "56", "Wyoming"], ["AS", "60", "American Samoa"],
  ["GU", "66", "Guam"], ["MP", "69", "Northern Mariana Islands"], ["PR", "72", "Puerto Rico"],
  ["VI", "78", "U.S. Virgin Islands"],
];
const BY = new Map<string, [string, string, string]>();
for (const s of STATES) for (const k of [s[0].toLowerCase(), s[1], s[2].toLowerCase(), String(Number(s[1]))]) BY.set(k, s);

/** One state in any form (USPS code, FIPS code, name) as usps, fips or name. */
export function state(x: Value, as: "usps" | "fips" | "name" = "usps"): string {
  let key = cellText(x).trim().toLowerCase();
  if (/^\d+$/.test(key)) key = key.length <= 2 ? key.padStart(2, "0") : key;
  const hit = BY.get(key) || BY.get(key.replace(/^0+/, ""));
  if (!hit) throw new CombineError(`unknown state ${pyRepr(typeof x === "number" ? x : cellText(x))}: give a USPS code (MD), a FIPS code (24) or a name (Maryland)`);
  return { usps: hit[0], fips: hit[1], name: hit[2] }[as];
}

export function addStateCodes(t: Table, col: string): Table {
  if (!t.cols.includes(col)) throw new CombineError(`state_codes: no column ${col}; ${namesHint([col], t.cols, "columns", pyRepr)}`);
  const names = ["state_usps", "state_fips", "state_name"];
  const rows = t.rows.map((r) => {
    const o: Row = Object.assign(newRow(), r);
    o.state_usps = state(r[col], "usps");
    o.state_fips = state(r[col], "fips");
    o.state_name = state(r[col], "name");
    return o;
  });
  return { cols: [...t.cols.filter((c) => !names.includes(c)), ...names], rows };
}

function parseDate(v: Value, col: string): [number, number, number] {
  const d = v === null ? null : dateParts(v);
  if (!d || d[1] < 1 || d[1] > 12) {
    throw new CombineError(`${col} = ${pyRepr(cellText(v))} is not a date (use 2023-10-01, 2023-10, 10/01/2023, 2023M10 or 2023Q4)`);
  }
  return d;
}

export function fiscalYear(v: Value, col = "date"): number {
  const [y, m] = parseDate(v, col);
  return y + (m >= 10 ? 1 : 0);
}

/** Calendar-period data to fiscal years. Flows: how "sum"; rates and indexes: "mean"; stocks: "last". */
export function toFiscal(t: Table, date: string, value: string, how: "sum" | "mean" | "last" = "sum",
  freq: "M" | "Q" = "M"): { table: Table; notes: string[] } {
  for (const c of [date, value]) if (!t.cols.includes(c)) throw new CombineError(`to_fiscal: no column ${c}; ${namesHint([c], t.cols, "columns", pyRepr)}`);
  if (!["sum", "mean", "last"].includes(how)) throw new CombineError(`to_fiscal: how is "sum", "mean" or "last", not ${pyRepr(how)}`);
  if (!["M", "Q"].includes(freq)) throw new CombineError(`to_fiscal: freq is "M" or "Q", not ${pyRepr(freq)}`);
  const notes: string[] = [];
  const need = freq === "M" ? 12 : 4;
  type R = { d: [number, number, number]; v: number; fy: number; period: string; key: number };
  const rs: R[] = [];
  for (const r of t.rows) {
    if (r[date] === null || r[value] === null) continue;            // dropna on [date, value]
    const v = r[value];
    if (typeof v !== "number") throw new CombineError(`to_fiscal: ${value} = ${pyRepr(v)} is not a number: convert it with number() first`);
    const d = parseDate(r[date], date);
    const period = freq === "M" ? `${d[0]}-${String(d[1]).padStart(2, "0")}` : `${d[0]}Q${Math.floor((d[1] - 1) / 3) + 1}`;
    rs.push({ d, v, fy: d[0] + (d[1] >= 10 ? 1 : 0), period, key: d[0] * 10000 + d[1] * 100 + d[2] });
  }
  const perCount = new Map<string, number>();
  rs.forEach((r) => perCount.set(r.period, (perCount.get(r.period) || 0) + 1));
  const dupPeriods = [...perCount].filter(([, n]) => n > 1).map(([p]) => p);
  if (dupPeriods.length) {
    notes.push(`to_fiscal: ${dupPeriods.length} period(s) have more than one row; keep one row per period (or aggregate first) ` +
      "before converting");
  }
  const sorted = rs.map((r, i) => ({ r, i })).sort((a, b) => a.r.key - b.r.key || a.i - b.i).map((x) => x.r);
  const groups = new Map<number, R[]>();
  for (const r of sorted) {
    if (!groups.has(r.fy)) groups.set(r.fy, []);
    groups.get(r.fy)!.push(r);
  }
  const rows: Row[] = [];
  const incomplete: number[] = [];
  for (const fy of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(fy)!;
    const vals = g.map((r) => r.v);
    const v = how === "sum" ? vals.reduce((a, b) => a + b, 0) : how === "mean" ? vals.reduce((a, b) => a + b, 0) / vals.length
      : vals[vals.length - 1];
    const periods = new Set(g.map((r) => r.period)).size;
    const complete = periods >= need && !g.some((r) => (perCount.get(r.period) || 0) > 1);
    if (!complete) incomplete.push(fy);
    const o = newRow();
    o.fiscal_year = fy;
    o[value] = v;
    o.periods = periods;
    o.complete = complete;
    rows.push(o);
  }
  if (incomplete.length) notes.push(`to_fiscal: incomplete fiscal years kept but flagged: ${incomplete.map((y) => `FY${y}`).join(", ")}`);
  return { table: { cols: ["fiscal_year", value, "periods", "complete"], rows }, notes };
}

const keyOf = (r: Row, on: string[]) => on.map((k) => cellText(r[k])).join("\u0000");

/**
 * frames: {source: table}; units: {source: "billions of dollars, nominal, fiscal years"}. Raises when a frame lacks
 * a join key, a unit description is missing, a frame repeats a key, or the keys do not overlap. Keys missing from
 * some frames are reported, not refused. Units are listed side by side, not compared.
 */
export function alignCheck(frames: Record<string, Table>, on: string[], units: Record<string, string>): string[] {
  const names = Object.keys(frames);
  const missingUnits = names.filter((s) => !units[s]);
  if (missingUnits.length) throw new CombineError(`name the units and period basis of ${pyRepr(missingUnits)} before joining`);
  const keysets: Set<string>[] = [];
  for (const s of names) {
    const f = frames[s];
    const lack = on.filter((k) => !f.cols.includes(k));
    if (lack.length) throw new CombineError(`${s} lacks join columns ${pyRepr(lack)}`);
    const seen = new Set<string>();
    let rep = 0;
    for (const r of f.rows) {
      const k = keyOf(r, on);
      if (seen.has(k)) rep++;
      else seen.add(k);
    }
    if (rep) throw new CombineError(`${s} has ${rep} repeated ${pyRepr(on)} key(s): aggregate or filter to one row per key first`);
    keysets.push(seen);
  }
  const notes = names.map((s) => `align_check: ${s}: ${units[s]}`);
  const common = keysets.length ? [...keysets[0]].filter((k) => keysets.every((ks) => ks.has(k))) : [];
  if (!common.length) throw new CombineError(`no overlapping ${pyRepr(on)} values across ${pyRepr(names)}: check codes and period labels`);
  const cs = new Set(common);
  names.forEach((s, i) => {
    const dropped = [...keysets[i]].filter((k) => !cs.has(k)).length;
    if (dropped) notes.push(`align_check: ${s} has ${dropped} key value(s) not in every source (they drop out of an inner join)`);
  });
  return notes;
}

/**
 * values / index, aligned on period labels. base = a period label (the index rebased to 1 there) or null (the
 * index used as given, e.g. already 2017=100 -> divide by 100 first).
 */
export function deflate(values: { period: Value; value: Value }[], index: Map<string, number>, base: Value | null): (number | null)[] {
  let idx = index;
  if (base !== null && base !== undefined) {
    const b = cellText(base);
    if (!idx.has(b)) throw new CombineError(`base period ${pyRepr(typeof base === "number" ? base : b)} is not in the index`);
    const bv = idx.get(b)!;
    idx = new Map([...idx].map(([k, v]) => [k, v / bv]));
  }
  if (values.some((v) => !idx.has(cellText(v.period)))) throw new CombineError("the price index does not cover every period of the values");
  return values.map((v) => {
    if (v.value === null) return null;
    if (typeof v.value !== "number") throw new CombineError(`deflate: ${pyRepr(v.value)} is not a number: convert it with number() first`);
    const d = idx.get(cellText(v.period))!;
    return d === 0 ? null : v.value / d;
  });
}
