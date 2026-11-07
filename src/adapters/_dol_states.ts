/**
 * One state in any form to another: the Python skill's scripts/analysis/combine.state, which the dol, eia and
 * irs-soi adapters import (core has no such helper). Kept beside the dol adapter; eia and irs-soi import it too.
 */
const STATES: [string, string, string][] = [
  ["AL", "01", "Alabama"], ["AK", "02", "Alaska"], ["AZ", "04", "Arizona"], ["AR", "05", "Arkansas"],
  ["CA", "06", "California"], ["CO", "08", "Colorado"], ["CT", "09", "Connecticut"], ["DE", "10", "Delaware"],
  ["DC", "11", "District of Columbia"], ["FL", "12", "Florida"], ["GA", "13", "Georgia"], ["HI", "15", "Hawaii"],
  ["ID", "16", "Idaho"], ["IL", "17", "Illinois"], ["IN", "18", "Indiana"], ["IA", "19", "Iowa"], ["KS", "20", "Kansas"],
  ["KY", "21", "Kentucky"], ["LA", "22", "Louisiana"], ["ME", "23", "Maine"], ["MD", "24", "Maryland"],
  ["MA", "25", "Massachusetts"], ["MI", "26", "Michigan"], ["MN", "27", "Minnesota"], ["MS", "28", "Mississippi"],
  ["MO", "29", "Missouri"], ["MT", "30", "Montana"], ["NE", "31", "Nebraska"], ["NV", "32", "Nevada"],
  ["NH", "33", "New Hampshire"], ["NJ", "34", "New Jersey"], ["NM", "35", "New Mexico"], ["NY", "36", "New York"],
  ["NC", "37", "North Carolina"], ["ND", "38", "North Dakota"], ["OH", "39", "Ohio"], ["OK", "40", "Oklahoma"],
  ["OR", "41", "Oregon"], ["PA", "42", "Pennsylvania"], ["RI", "44", "Rhode Island"], ["SC", "45", "South Carolina"],
  ["SD", "46", "South Dakota"], ["TN", "47", "Tennessee"], ["TX", "48", "Texas"], ["UT", "49", "Utah"],
  ["VT", "50", "Vermont"], ["VA", "51", "Virginia"], ["WA", "53", "Washington"], ["WV", "54", "West Virginia"],
  ["WI", "55", "Wisconsin"], ["WY", "56", "Wyoming"], ["AS", "60", "American Samoa"], ["GU", "66", "Guam"],
  ["MP", "69", "Northern Mariana Islands"], ["PR", "72", "Puerto Rico"], ["VI", "78", "U.S. Virgin Islands"],
];

const BY = new Map<string, [string, string, string]>();
for (const s of STATES) for (const k of [s[0].toLowerCase(), s[1], s[2].toLowerCase(), String(Number(s[1]))]) BY.set(k, s);

/** Python's repr() of a value as an f-string's !r shows it (strings quoted). */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let s = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    if (q === "'") s = s.replace(/'/g, "\\'");
    return q + s + q;
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.entries(v as object).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  return String(v);
}

/** Thrown for an unknown state (Python's ValueError). */
export class StateError extends Error {}

export function state(x: unknown, as: "usps" | "fips" | "name" = "usps"): string {
  let key = String(x ?? "None").trim().toLowerCase();
  if (/^\d+$/.test(key)) key = key.length <= 2 ? key.padStart(2, "0") : key;
  const hit = BY.get(key) ?? BY.get(key.replace(/^0+/, ""));
  if (!hit) throw new StateError(`unknown state ${pyRepr(x)}: give a USPS code (MD), a FIPS code (24) or a name (Maryland)`);
  return { usps: hit[0], fips: hit[1], name: hit[2] }[as];
}
