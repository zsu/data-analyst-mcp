/**
 * Python semantics the report audits depend on (they are ports of regex-heavy Python scripts): Python-style
 * regular expressions (inline flags, named groups, re.match / fullmatch / sub / split), str.strip with
 * characters, splitlines, repr() of messages, "%g" and "%.Nf" formatting, round() half to even, float()
 * parsing, csv.DictReader rows (short rows get null, extra cells are kept), html.escape / unescape.
 */
import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { decodeText } from "../core/tabular.js";
import { pyFloatRepr } from "../core/py.js";

// ---------------------------------------------------------------------- regular expressions
const FLAG_MAP: Record<string, string> = { i: "i", m: "m", s: "s" };

/** A JS RegExp from Python regex source: a leading (?ims) becomes flags, (?P<n>...) a named group, \Z the end. */
export function rx(src: string, flags = ""): RegExp {
  let s = src;
  const lead = /^\(\?([aiLmsux]+)\)/.exec(s);
  if (lead) {
    for (const c of lead[1]) if (FLAG_MAP[c] && !flags.includes(FLAG_MAP[c])) flags += FLAG_MAP[c];
    s = s.slice(lead[0].length);
  }
  s = s.replace(/\(\?P</g, "(?<").replace(/\(\?P=(\w+)\)/g, "\\k<$1>").replace(/\\Z/g, "(?![\\s\\S])");
  return new RegExp(s, flags.replace(/g|y/g, ""));
}

const clones = new WeakMap<RegExp, Record<string, RegExp>>();
function clone(re: RegExp, kind: "g" | "y" | "full"): RegExp {
  let c = clones.get(re);
  if (!c) clones.set(re, (c = {}));
  if (!c[kind]) {
    const fl = re.flags.replace(/[gy]/g, "");
    c[kind] = kind === "full" ? new RegExp(`^(?:${re.source})$`, fl) : new RegExp(re.source, fl + kind);
  }
  return c[kind];
}

export type M = RegExpExecArray;

/** re.search */
export function search(re: RegExp, s: string): M | null {
  const g = clone(re, "g");
  g.lastIndex = 0;
  return g.exec(s);
}

/** re.match: anchored at pos. */
export function match(re: RegExp, s: string, pos = 0): M | null {
  const y = clone(re, "y");
  y.lastIndex = pos;
  return y.exec(s);
}

/** re.fullmatch */
export function fullmatch(re: RegExp, s: string): M | null {
  return clone(re, "full").exec(s);
}

export function finditer(re: RegExp, s: string): M[] {
  return [...s.matchAll(clone(re, "g"))] as M[];
}

/** re.findall: the matches, or group 1 when the pattern has groups (a tuple of groups when it has several). */
export function findall(re: RegExp, s: string): any[] {
  return finditer(re, s).map((m) => (m.length === 1 ? m[0] : m.length === 2 ? m[1] ?? "" : m.slice(1).map((x) => x ?? "")));
}

/** re.sub with a string (taken literally) or a function of the match. */
export function sub(re: RegExp, repl: string | ((m: M) => string), s: string, count = 0): string {
  let out = "", last = 0, n = 0;
  for (const m of finditer(re, s)) {
    if (count && n >= count) break;
    out += s.slice(last, m.index) + (typeof repl === "string" ? repl : repl(m));
    last = m.index + m[0].length;
    n++;
  }
  return out + s.slice(last);
}

/** re.split (capture groups are kept, as Python does); maxsplit > 0 stops after that many splits. */
export function split(re: RegExp, s: string, maxsplit = 0): string[] {
  const out: string[] = [];
  let last = 0, n = 0;
  for (const m of finditer(re, s)) {
    if (maxsplit && n >= maxsplit) break;
    out.push(s.slice(last, m.index), ...m.slice(1).map((x) => x as string));
    last = m.index + m[0].length;
    n++;
  }
  out.push(s.slice(last));
  return out;
}

export const end = (m: M) => m.index + m[0].length;

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------- strings
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_LEAD = new RegExp(`^[${WS}]+`), WS_TAIL = new RegExp(`[${WS}]+$`);

function charSet(chars: string): (c: string) => boolean {
  const set = new Set([...chars]);
  return (c) => set.has(c);
}

export function lstrip(s: string, chars?: string): string {
  if (chars === undefined) return s.replace(WS_LEAD, "");
  const has = charSet(chars);
  let i = 0;
  while (i < s.length && has(s[i])) i++;
  return s.slice(i);
}

export function rstrip(s: string, chars?: string): string {
  if (chars === undefined) return s.replace(WS_TAIL, "");
  const has = charSet(chars);
  let j = s.length;
  while (j > 0 && has(s[j - 1])) j--;
  return s.slice(0, j);
}

export function strip(s: string, chars?: string): string {
  return lstrip(rstrip(s, chars), chars);
}

/** str.splitlines() */
export function splitlines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** str(x) of a JSON value as Python prints it. */
export function str(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return repr(v);
}

/** repr() of a JSON value (strings with Python's quotes, lists and dicts as Python prints them). */
export function repr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let out = "";
    for (const c of v) {
      const code = c.codePointAt(0)!;
      if (c === "\\") out += "\\\\";
      else if (c === q) out += "\\" + q;
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (code < 32 || code === 127) out += "\\x" + code.toString(16).padStart(2, "0");
      else out += c;
    }
    return q + out + q;
  }
  if (Array.isArray(v)) return "[" + v.map(repr).join(", ") + "]";
  if (v instanceof Set) return v.size ? "{" + [...v].map(repr).join(", ") + "}" : "set()";
  if (typeof v === "object") return "{" + Object.entries(v as object).map(([k, x]) => `${repr(k)}: ${repr(x)}`).join(", ") + "}";
  return String(v);
}

/** Python string comparison (code points), for sort(). */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sorted<T extends string>(xs: Iterable<T>): T[] {
  return [...xs].sort(cmp);
}

export function unique<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------- numbers
const FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*)?\.?\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|\d(?:_?\d)*\.(?:[eE][+-]?\d+)?|inf|infinity|nan)$/i;

/** float(x): null where Python raises (ValueError, TypeError). */
export function toFloat(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string") return null;
  const s = strip(v);
  if (!FLOAT_RE.test(s)) return null;
  const t = s.replace(/_/g, "").toLowerCase();
  if (/inf/.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/nan/.test(t)) return NaN;
  return Number(t);
}

/** "%.<d>f" as Python formats it (exact binary value, ties to even). */
export function fixed(x: number, d: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const digits = Math.max(0, d);
  const exact = Math.abs(x).toFixed(Math.min(100, digits + 30));
  const [ip, fp = ""] = exact.split(".");
  const keep = fp.slice(0, digits), rest = fp.slice(digits);
  let n = BigInt(ip + keep);
  const tail = /[1-9]/.test(rest.slice(1));
  if (rest[0] > "5" || (rest[0] === "5" && (tail || n % 2n === 1n))) n += 1n;
  let s = n.toString().padStart(digits + 1, "0");
  if (digits) s = s.slice(0, s.length - digits) + "." + s.slice(s.length - digits);
  const neg = x < 0 || Object.is(x, -0);
  return (neg ? "-" : "") + s;
}

/** round(x, nd): half to even on the exact value, as Python does. */
export function pyRound(x: number, nd = 0): number {
  return Number(fixed(x, nd));
}

/** "%g" / "%.<p>g" */
export function fmtG(x: number, p = 6): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const prec = p || 1;
  const [mant, es] = x.toExponential(prec - 1).split("e");
  const e = Number(es);
  const trim = (t: string) => (t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t);
  if (e < -4 || e >= prec) return `${trim(mant)}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  return trim(fixed(x, prec - 1 - e));
}

/** f"{n:,}" of an integer. */
export function commas(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : String(n);
}

// ---------------------------------------------------------------------- CSV (csv.DictReader / csv.reader)
export type DictRow = Record<string, string | null>;
export type DictCsv = { fields: string[]; rows: DictRow[]; extra: (string[] | undefined)[] };

export function readText(p: string): string {
  return decodeText(fs.readFileSync(p));
}

/** csv.reader rows (blank lines skipped). */
export function csvGrid(text: string): string[][] {
  try {
    return parse(text.replace(/^﻿/, ""), { relax_column_count: true, relax_quotes: true, skip_empty_lines: true });
  } catch {
    return text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l).map((l) => l.split(","));
  }
}

/** csv.DictReader: a short row's missing cells are null; cells past the header are kept in extra[i]. */
export function readDict(text: string): DictCsv {
  const grid = csvGrid(text);
  if (!grid.length) return { fields: [], rows: [], extra: [] };
  const [fields, ...body] = grid;
  const rows: DictRow[] = [], extra: (string[] | undefined)[] = [];
  for (const r of body) {
    const o: DictRow = {};
    fields.forEach((f, i) => (o[f] = i < r.length ? r[i] : null));
    rows.push(o);
    extra.push(r.length > fields.length ? r.slice(fields.length) : undefined);
  }
  return { fields, rows, extra };
}

export function readDictFile(p: string): DictCsv {
  return readDict(readText(p));
}

/** csv.DictWriter text (minimal quoting) with lineterminator "\n". */
export function writeDict(rows: Record<string, unknown>[], fields: string[], pyStr: (v: unknown) => string): string {
  return stringify([fields, ...rows.map((r) => fields.map((c) => pyStr(r[c])))], { record_delimiter: "\n",
    quoted_match: /[\r\n]/ });
}

// ---------------------------------------------------------------------- HTML
export function escapeHtml(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", mdash: "—", ndash: "–",
  hellip: "…", copy: "©", reg: "®", trade: "™", middot: "·", sect: "§",
  laquo: "«", raquo: "»", deg: "°", times: "×", minus: "−", larr: "←",
  rarr: "→", bull: "•", eacute: "é", ntilde: "ñ", shy: "­", thinsp: " ",
  ensp: " ", emsp: " ", cent: "¢", pound: "£", euro: "€", frac12: "½" };

/** html.unescape (numeric references and the common named entities). */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
      } catch {
        return all;
      }
    }
    return ENTITIES[e] ?? all;
  });
}
