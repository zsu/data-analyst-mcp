/**
 * Python text forms the spreadsheet packs (omb, pbgc, dhs-ohss, snapqc) depend on, and tables whose column order
 * must survive integer-like column names ("1940", "2024"): a JS object puts those keys first, so such a table is
 * written to a CSV here, in the Python column order, and handed to package.write as a FileTable.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileTable } from "../core/package.js";
import type { Row } from "../core/packs.js";
import { writeCsv } from "../core/tabular.js";

/** Python's str.isspace() characters. */
const WS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${WS}]+`, "g");
const WS_EDGE = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");

/** Python str.split() with no argument. */
export function pySplit(s: string): string[] {
  return s.split(WS_RUN).filter(Boolean);
}

/** " ".join(s.split()). */
export function squash(s: string): string {
  return pySplit(s).join(" ");
}

/** Python str.strip() with no argument. */
export function pyStrip(s: string): string {
  return s.replace(WS_EDGE, "");
}

/** Python repr() of a str. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  const s = String(v);
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || (c >= 0x7f && c < 0xa0)) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return q + out + q;
}

/** Python int() of a value (raises like Python on text that is not a whole number). */
export function pyInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`cannot convert ${v} to integer`);
    return Math.trunc(v);
  }
  if (typeof v === "string" && /^[-+]?\d+(_\d+)*$/.test(pyStrip(v))) return parseInt(pyStrip(v).replace(/_/g, ""), 10);
  throw new TypeError(`invalid literal for int(): ${pyRepr(v)}`);
}

/** Python float() of a string. */
export function pyFloat(v: unknown): number {
  if (typeof v === "number") return v;
  const s = pyStrip(String(v ?? "")).replace(/_/g, "");
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^[-+]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[-+]?nan$/i.test(s)) return NaN;
  throw new TypeError(`could not convert string to float: ${pyRepr(v)}`);
}

/** Python str.isdigit() on str(v) (ASCII digits). */
export function isDigits(v: unknown): boolean {
  return /^\d+$/.test(String(v));
}

/** Python format(x, ".15g"). */
export function g15(x: number): string {
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const e = Number(x.toExponential(14).split("e")[1]);
  if (e < -4 || e >= 15) {
    const [m, es] = x.toExponential(14).split("e");
    const mm = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    const n = Number(es);
    return `${mm}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  const f = x.toFixed(Math.max(0, 14 - e));
  return f.includes(".") ? f.replace(/0+$/, "").replace(/\.$/, "") : f;
}

/** Python round(x, n) on a float (half to even on the exact binary value). */
export function pyRound(x: number, n: number): number {
  if (!Number.isFinite(x)) return x;
  const s = x.toFixed(n);
  const exact = Math.abs(x).toFixed(Math.min(100, n + 30));
  const tail = exact.slice(exact.indexOf(".") + 1 + n);
  if (/^50*$/.test(tail)) {
    // an exact tie: toFixed rounded away from zero; Python keeps the even digit
    const digits = s.replace(/[-.]/g, "");
    if (Number(digits[digits.length - 1]) % 2 === 1) {
      const step = 10 ** -n;
      return Number((x > 0 ? Number(s) - step : Number(s) + step).toFixed(n));
    }
  }
  return Number(s);
}

/** f"{x:,.Nf}" (comma groups, N decimals, Python's rounding). */
export function commaFixed(x: number, n = 0): string {
  const r = pyRound(x, n);
  const [i, f] = Math.abs(r).toFixed(n).split(".");
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (r < 0 || Object.is(r, -0) ? "-" : "") + grouped + (f ? "." + f : "");
}

/** f"{n:,}" of an integer. */
export function comma(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 20 });
}

/** Python's sort key [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", s)], as a comparator. */
export function naturalCompare(a: string, b: string): number {
  const ka = a.split(/(\d+)/), kb = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    if (ka[i] === kb[i]) continue;
    if (i % 2 === 1) {
      const d = Number(ka[i]) - Number(kb[i]);
      if (d) return d < 0 ? -1 : 1;
      continue;
    }
    return ka[i] < kb[i] ? -1 : 1;
  }
  return ka.length - kb.length;
}

/** Code-point string order (Python sorted()). */
export const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A row whose key order is the column order (a Map keeps integer-like keys in place). */
export type ORow = Map<string, unknown>;

const INDEX_KEY = /^(0|[1-9]\d{0,9})$/;

/**
 * Rows as package.write takes them, columns in first-seen order across the rows (as the Python packager writes
 * them). With an integer-like column name, a plain object would reorder the columns, so the rows are written to a
 * CSV in a temporary folder (outside the package) and returned as a FileTable.
 */
export function toTable(rows: ORow[], id: string): Row[] | FileTable {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of r.keys()) if (!seen.has(k)) (seen.add(k), cols.push(k));
  const objs = rows.map((r) => Object.fromEntries(r) as Row);
  if (!rows.length || !cols.some((c) => INDEX_KEY.test(c) && Number(c) < 2 ** 32 - 1)) return objs;
  const file = path.join(os.tmpdir(), `da-${id}-${process.pid}-${randomUUID()}.csv`);
  fs.writeFileSync(file, writeCsv(objs, cols));
  return new FileTable(file, cols, rows.length, objs);
}

/** urllib.parse.urljoin(base, href) for the links pages carry (absolute, //host, /path, relative), unnormalized. */
export function urljoin(base: string, href: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return href;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/[^/?#]*)?([^?#]*)/.exec(base);
  if (!m) return href;
  if (href.startsWith("//")) return m[1] + href;
  if (href.startsWith("/")) return m[1] + (m[2] || "") + href;
  if (href.startsWith("?") || href.startsWith("#") || /(^|\/)\.\.?(\/|$)/.test(href)) return new URL(href, base).toString();
  return m[1] + (m[2] || "") + m[3].replace(/[^/]*$/, "") + href;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\xa0", ndash: "–",
  mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", copy: "\xa9" };

/** html.unescape for the entities these pages use (numeric, and the common named ones). */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (all, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENT[e] ?? all);
}
