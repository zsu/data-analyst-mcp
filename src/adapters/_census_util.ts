/**
 * Helpers of the census adapter that reproduce Python behavior the Python adapter relied on: the state lookup of
 * scripts/analysis/combine.py, difflib.get_close_matches, repr() of values in messages, float() parsing and
 * csv.writer lines. Module-private to the census adapter.
 */
import { Client, DataError, Response } from "../core/http.js";
import { pyStr } from "../core/py.js";

/** A spec mistake (Python ValueError): becomes a spec problem or a bad_request DataError. */
export class ValueErr extends Error {}

// ---------------------------------------------------------------------- states (combine.STATES / combine.state)
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
for (const s of STATES) for (const k of [s[0].toLowerCase(), s[1], s[2].toLowerCase(), String(parseInt(s[1], 10))]) BY.set(k, s);

/** combine.state(x, as_) */
export function stateOf(x: unknown, as: "usps" | "fips" | "name" = "usps"): string {
  let key = pyStr(x).trim().toLowerCase();
  if (/^\d+$/.test(key)) key = key.length <= 2 ? key.padStart(2, "0") : key;
  const hit = BY.get(key) ?? BY.get(key.replace(/^0+/, ""));
  if (!hit) throw new ValueErr(`unknown state ${pyRepr(x)}: give a USPS code (MD), a FIPS code (24) or a name (Maryland)`);
  return { usps: hit[0], fips: hit[1], name: hit[2] }[as];
}

// ---------------------------------------------------------------------- Python text forms
/** repr() of a JSON-ish value as Python would print it in a message. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let s = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    if (q === "'") s = s.replace(/'/g, "\\'");
    return q + s + q;
  }
  if (Array.isArray(v)) return v.length === 1 && (v as any)._tuple ? `(${pyRepr(v[0])},)` : `[${v.map(pyRepr).join(", ")}]`;
  if (typeof v === "object") return "{" + Object.entries(v as object).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  return String(v);
}

/** repr() of a Python tuple of values. */
export function pyTuple(vals: unknown[]): string {
  return vals.length === 1 ? `(${pyRepr(vals[0])},)` : `(${vals.map(pyRepr).join(", ")})`;
}

/** Python float(str): the number, or null where float() raises ValueError. */
export function pyFloat(s: unknown): number | null {
  if (typeof s === "number") return s;
  const t = pyStr(s).trim();
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (!/^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/.test(t)) return null;
  return Number(t.replace(/_/g, ""));
}

/** Python int() of text (whitespace and a sign allowed); throws as int() raises ValueError. */
export function pyInt(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d(_?\d)*$/.test(t)) throw new Error(`invalid literal for int() with base 10: ${pyRepr(s)}`);
  return Number(t.replace(/_/g, ""));
}

/** Python truthiness of a JSON value. */
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}

/** Python `v not in (None, "")`. */
export function given(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/** str.title() */
export function title(s: string): string {
  let prevCased = false;
  let out = "";
  for (const ch of s) {
    const cased = ch.toLowerCase() !== ch.toUpperCase();
    out += cased ? (prevCased ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prevCased = cased;
  }
  return out;
}

/** str.splitlines() */
export function splitlines(s: string): string[] {
  const out = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** One line of Python's csv.writer (QUOTE_MINIMAL, CRLF). */
export function csvLine(vals: unknown[]): string {
  if (vals.length === 1 && pyStr(vals[0]) === "") return '""\r\n';
  return vals.map((v) => {
    const s = pyStr(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",") + "\r\n";
}

// ---------------------------------------------------------------------- difflib.get_close_matches
class SequenceMatcher {
  a: string[] = [];
  b: string[] = [];
  b2j = new Map<string, number[]>();
  fullbcount: Map<string, number> | null = null;

  setSeq2(b: string): void {
    this.b = Array.from(b);
    this.fullbcount = null;
    this.b2j = new Map();
    this.b.forEach((elt, i) => {
      const l = this.b2j.get(elt);
      if (l) l.push(i);
      else this.b2j.set(elt, [i]);
    });
    const n = this.b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of [...this.b2j]) if (idxs.length > ntest) this.b2j.delete(elt);
    }
  }

  setSeq1(a: string): void {
    this.a = Array.from(a);
  }

  private longest(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const { a, b, b2j } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  private matches(): number {
    const queue: [number, number, number, number][] = [[0, this.a.length, 0, this.b.length]];
    let total = 0;
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const [i, j, k] = this.longest(alo, ahi, blo, bhi);
      if (k) {
        total += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    return total;
  }

  private static calc(m: number, len: number): number {
    return len ? (2.0 * m) / len : 1.0;
  }

  ratio(): number {
    return SequenceMatcher.calc(this.matches(), this.a.length + this.b.length);
  }

  quickRatio(): number {
    if (!this.fullbcount) {
      this.fullbcount = new Map();
      for (const e of this.b) this.fullbcount.set(e, (this.fullbcount.get(e) || 0) + 1);
    }
    const avail = new Map<string, number>();
    let m = 0;
    for (const e of this.a) {
      const n = avail.has(e) ? avail.get(e)! : this.fullbcount.get(e) || 0;
      avail.set(e, n - 1);
      if (n > 0) m++;
    }
    return SequenceMatcher.calc(m, this.a.length + this.b.length);
  }

  realQuickRatio(): number {
    const la = this.a.length, lb = this.b.length;
    return SequenceMatcher.calc(Math.min(la, lb), la + lb);
  }
}

/** difflib.get_close_matches(word, possibilities, n, cutoff) */
export function getCloseMatches(word: string, possibilities: string[], n = 3, cutoff = 0.6): string[] {
  const res: [number, string][] = [];
  const s = new SequenceMatcher();
  s.setSeq2(word);
  for (const x of possibilities) {
    s.setSeq1(x);
    if (s.realQuickRatio() >= cutoff && s.quickRatio() >= cutoff && s.ratio() >= cutoff) res.push([s.ratio(), x]);
  }
  // heapq.nlargest(n, result): by score, then by the string, both descending
  res.sort((p, q) => (p[0] !== q[0] ? q[0] - p[0] : p[1] === q[1] ? 0 : p[1] < q[1] ? 1 : -1));
  return res.slice(0, n).map(([, x]) => x);
}

// ---------------------------------------------------------------------- requests
/** The Census client request: 200 and 204 accepted; the key goes to the Data API only, never to www2.census.gov
 * files (geography lists, replicate weights); a missing_key / invalid_key page becomes a key error. */
export async function censusGet(client: Client, p: string, params?: Record<string, unknown> | null,
  allow404 = false): Promise<Response> {
  const useKey = !/^https?:\/\//.test(p) || p.startsWith(client.base);
  try {
    return await client.request("GET", p, params, { okStatuses: [200, 204], allow404, useKey });
  } catch (e) {
    if (e instanceof DataError && e.kind === "api") {
      if (e.message.includes("missing_key")) throw new DataError(e.message, "key_missing", e.status);
      if (e.message.includes("invalid_key")) throw new DataError(e.message, "auth", e.status);
    }
    throw e;
  }
}

export function respJson(r: Response): any {
  if (r.status === 204 || !r.body.toString("latin1").trim()) return null;
  return r.json();
}

/** Python `body.lstrip()[:1] == b"{"` */
export function startsWithBrace(body: Buffer): boolean {
  return body.toString("latin1").trimStart().startsWith("{");
}

/** _ensure_list: a list or a comma-separated string as a list of non-empty names. */
export function ensureList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => pyStr(x).trim()).filter(Boolean);
  return pyStr(v || "").split(",").map((s) => s.trim()).filter(Boolean);
}
