/**
 * Python text forms the fred pack depends on (beyond src/core/py.ts): repr() and str() of spec values in error
 * messages and CSV cells, float() and int() of spec and API text, round() half to even, json.dumps(indent=n), and
 * urlencode(..., safe=","). Module-private helpers of the fred deep pack.
 */
import { pyFloatRepr, quotePlus } from "../core/py.js";

/** Python truthiness of a JSON value. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** A JSON number as Python's str() writes it (ints as digits, floats by repr). */
function num(v: number): string {
  return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(v) : pyFloatRepr(v);
}

function strRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const c of s) {
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

/** Python repr() of a JSON value. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return num(v);
  if (typeof v === "string") return strRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  return "{" + Object.entries(v as object).map(([k, x]) => `${strRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
}

/** Python repr() of a tuple of strings. */
export function tupleRepr(xs: readonly string[]): string {
  return "(" + xs.map(strRepr).join(", ") + (xs.length === 1 ? ",)" : ")");
}

/** Python str() of a JSON value (None, True, False as Python writes them). */
export function pstr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return num(v);
  return pyRepr(v);
}

/** A CSV cell as csv.DictWriter writes it: None is empty, anything else str(). */
export function cell(v: unknown): string {
  return v === null || v === undefined ? "" : pstr(v);
}

/** Python float(text); null where Python raises ValueError. */
export function pyFloat(text: string): number | null {
  const s = text.trim();
  if (/^[+-]?(?:inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  const dig = "\\d(?:_?\\d)*";
  const re = new RegExp(`^[+-]?(?:${dig}(?:\\.(?:${dig})?)?|\\.${dig})(?:[eE][+-]?${dig})?$`);
  if (!re.test(s)) return null;
  return Number(s.replaceAll("_", ""));
}

export class PyValueError extends Error {}

/** Python int(x) of a JSON value (raises PyValueError where Python raises ValueError or TypeError). */
export function pyInt(v: unknown): number {
  if (v === true) return 1;
  if (v === false) return 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new PyValueError(`cannot convert float ${pyFloatRepr(v)} to integer`);
    return Math.trunc(v);
  }
  if (typeof v === "string" && /^\s*[+-]?\d(?:_?\d)*\s*$/.test(v)) return parseInt(v.trim().replaceAll("_", ""), 10);
  if (typeof v === "string") throw new PyValueError(`invalid literal for int() with base 10: ${pyRepr(v)}`);
  throw new PyValueError(`int() argument must be a string, a bytes-like object or a real number, not '${
    v === null || v === undefined ? "NoneType" : Array.isArray(v) ? "list" : "dict"}'`);
}

/** str.isdigit() for ASCII text. */
export function isDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

/** Python round(x) (half to even). */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's str.isspace() characters, for re.sub(r"\s+", ...) on text. */
export const PY_SPACE = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

/** Python str.strip() (Unicode whitespace). */
export function pyStrip(s: string): string {
  return s.replace(/^[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/, "")
    .replace(/[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/, "");
}

/** Code-point order of strings (Python's sort), as a comparator. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tuples of strings in Python's order. */
export function cmpTuple(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = cmp(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

function jsonStr(s: string): string {
  return JSON.stringify(s).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** json.dumps(obj, indent=n) (ensure_ascii, Python's separators). */
export function dumpsIndent(obj: unknown, indent: number, level = 0): string {
  const pad = (n: number) => "\n" + " ".repeat(indent * n);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") return Number.isFinite(obj) ? num(obj) : obj > 0 ? "Infinity" : obj < 0 ? "-Infinity" : "NaN";
  if (typeof obj === "string") return jsonStr(obj);
  if (Array.isArray(obj)) {
    if (!obj.length) return "[]";
    return "[" + obj.map((x) => pad(level + 1) + dumpsIndent(x, indent, level + 1)).join(",") + pad(level) + "]";
  }
  const ents = Object.entries(obj as object).filter(([, v]) => v !== undefined);
  if (!ents.length) return "{}";
  return "{" + ents.map(([k, v]) => pad(level + 1) + jsonStr(k) + ": " + dumpsIndent(v, indent, level + 1)).join(",") +
    pad(level) + "}";
}

/** urllib.parse.urlencode(params, safe=","), in insertion order (values by str()). */
export function urlencodeSafe(params: Record<string, unknown>): string {
  return Object.entries(params).map(([k, v]) => `${quotePlus(k).replaceAll("%2C", ",")}=${quotePlus(pstr(v)).replaceAll("%2C", ",")}`)
    .join("&");
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** date.today().isoformat(): the local calendar day. */
export function localToday(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** datetime.now(timezone.utc).replace(microsecond=0).isoformat(). */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** Days between two YYYY-MM-DD dates (b - a); NaN when either is not a date. */
export function daysBetween(a: string, b: string): number {
  const p = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return NaN;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(t);
    return d.getUTCDate() === Number(m[3]) && d.getUTCMonth() === Number(m[2]) - 1 ? t : NaN;
  };
  return Math.round((p(b) - p(a)) / 86400000);
}

/** The day before the first of a month, as YYYY-MM-DD. */
export function dayBeforeFirst(y: number, month: number): string {
  const d = new Date(Date.UTC(y, month - 1, 1) - 86400000);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
