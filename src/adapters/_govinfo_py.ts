/**
 * Python text forms the govinfo, congress, doj-news, open-payments, fda, nih, senate-lobbying and clinical-trials
 * adapters need and core does not have: repr() of a value (error messages), html.unescape, Python's whitespace
 * (str.split / strip / \s), int() of a spec value, and difflib.get_close_matches.
 */
import { pyFloatRepr } from "../core/py.js";
import { HTML5, INVALID_CHARREFS, INVALID_CODEPOINTS } from "./_govinfo_entities.js";

/** The characters Python's str.isspace() (and \s in a str pattern) accepts. */
export const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${PY_WS}]+`, "g");
const WS_EDGE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

/** str.split() with no arguments. */
export function pySplit(s: string): string[] {
  return s.split(WS_RUN).filter((x) => x !== "");
}

/** str.strip() with no arguments. */
export function pyStrip(s: string): string {
  return s.replace(WS_EDGE, "");
}

/** re.sub(r"\s+", rep, s) for a str pattern. */
export function pyWsSub(s: string, rep: string): string {
  return s.replace(WS_RUN, rep);
}

/** str.strip(chars). */
export function stripChars(s: string, chars: string): string {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

function reprStr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + q;
}

/** Python repr() of a JSON value. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return reprStr(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") {
    return "{" + Object.entries(v as Record<string, unknown>).map(([k, x]) => `${reprStr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  }
  return String(v);
}

/** repr() of a tuple of strings. */
export function pyTupleRepr(v: readonly unknown[]): string {
  return "(" + v.map(pyRepr).join(", ") + (v.length === 1 ? ",)" : ")");
}

/** Python int(x) for a spec value; throws (like TypeError / ValueError) when Python's would. */
export function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`cannot convert ${v} to int`);
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const t = pyStrip(v).replace(/_/g, "");
    if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
    throw new TypeError(`invalid literal for int() with base 10: ${reprStr(v)}`);
  }
  throw new TypeError("int() argument must be a string or a number");
}

/** Python truthiness of a JSON value. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

// ---------------------------------------------------------------------- html.unescape
const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

function replaceCharref(s: string): string {
  if (s[0] === "#") {
    const num = s[1] === "x" || s[1] === "X" ? parseInt(s.slice(2).replace(/;$/, ""), 16) : parseInt(s.slice(1).replace(/;$/, ""), 10);
    if (num in INVALID_CHARREFS) return INVALID_CHARREFS[num];
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
    if (INVALID_CODEPOINTS.has(num)) return "";
    return String.fromCodePoint(num);
  }
  if (s in HTML5) return HTML5[s];
  for (let x = s.length - 1; x > 1; x--) {
    if (s.slice(0, x) in HTML5) return HTML5[s.slice(0, x)] + s.slice(x);
  }
  return "&" + s;
}

/** html.unescape. */
export function htmlUnescape(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(CHARREF, (_m, g: string) => replaceCharref(g));
}

// ---------------------------------------------------------------------- difflib.get_close_matches
class SequenceMatcher {
  a = ""; b = ""; b2j = new Map<string, number[]>(); fullbcount: Map<string, number> | null = null;
  matchingBlocks: [number, number, number][] | null = null;
  setSeqs(a: string, b: string): void {
    this.a = a;
    this.setSeq2(b);
  }
  setSeq1(a: string): void {
    this.a = a;
    this.matchingBlocks = null;
  }
  setSeq2(b: string): void {
    this.b = b;
    this.matchingBlocks = null;
    this.fullbcount = null;
    const b2j = new Map<string, number[]>();
    [...b].forEach((ch, i) => {
      const l = b2j.get(ch);
      if (l) l.push(i);
      else b2j.set(ch, [i]);
    });
    const n = [...b].length;
    if (n >= 200) {                               // autojunk: popular elements
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(elt);
    }
    this.b2j = b2j;
  }
  private findLongestMatch(a: string[], b: string[], alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of this.b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
      }
      j2len = newj2len;
    }
    // no junk (isjunk=None): the match grows over equal neighbours, popular (autojunk) elements included
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }
  getMatchingBlocks(): [number, number, number][] {
    if (this.matchingBlocks) return this.matchingBlocks;
    const a = [...this.a], b = [...this.b];
    const la = a.length, lb = b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: [number, number, number][] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(a, b, alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    let [i1, j1, k1] = [0, 0, 0];
    const out: [number, number, number][] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) out.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    this.matchingBlocks = out;
    return out;
  }
  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((s, t) => s + t[2], 0);
    const len = [...this.a].length + [...this.b].length;
    return len ? (2 * matches) / len : 1;
  }
  quickRatio(): number {
    if (!this.fullbcount) {
      this.fullbcount = new Map();
      for (const ch of this.b) this.fullbcount.set(ch, (this.fullbcount.get(ch) || 0) + 1);
    }
    const avail = new Map<string, number>();
    let matches = 0;
    for (const ch of this.a) {
      const n = avail.has(ch) ? avail.get(ch)! : this.fullbcount.get(ch) || 0;
      avail.set(ch, n - 1);
      if (n > 0) matches++;
    }
    const len = [...this.a].length + [...this.b].length;
    return len ? (2 * matches) / len : 1;
  }
  realQuickRatio(): number {
    const la = [...this.a].length, lb = [...this.b].length;
    return la + lb ? (2 * Math.min(la, lb)) / (la + lb) : 1;
  }
}

/** difflib.get_close_matches(word, possibilities, n, cutoff). */
export function getCloseMatches(word: string, possibilities: string[], n = 3, cutoff = 0.6): string[] {
  const result: [number, string][] = [];
  const s = new SequenceMatcher();
  s.setSeq2(word);
  for (const x of possibilities) {
    s.setSeq1(x);
    if (s.realQuickRatio() >= cutoff && s.quickRatio() >= cutoff && s.ratio() >= cutoff) result.push([s.ratio(), x]);
  }
  result.sort((p, q) => (q[0] !== p[0] ? q[0] - p[0] : p[1] < q[1] ? 1 : p[1] > q[1] ? -1 : 0));
  return result.slice(0, n).map(([, x]) => x);
}
