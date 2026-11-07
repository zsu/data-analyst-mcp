/**
 * Small helpers that reproduce Python's text forms where the packs depend on them: URL encoding (the recorded
 * fixtures and request URLs were made by Python's urllib), str() of JSON values in CSV cells, and json.dumps
 * for request-body fingerprints. Keeping these identical keeps every fixture valid and outputs comparable.
 */

/** Python str() of a JSON value: True/False, None as "", numbers as JS writes them. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(v) : String(v);
  return typeof v === "object" ? pyJsonDumps(v) : String(v);
}

const hex = (c: string) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");

/** urllib.parse.quote(s, safe): unreserved letters, digits and _.-~ stay; so do the characters in safe. */
export function pyQuote(s: string, safe = "/"): string {
  let out = encodeURIComponent(s).replace(/[!'()*]/g, hex);
  for (const ch of safe) {
    const enc = encodeURIComponent(ch).replace(/[!'()*]/g, hex);
    if (enc !== ch) out = out.split(enc).join(ch);
  }
  return out;
}

/** urllib.parse.quote_plus: like quote with safe="", and a space as "+". */
export function quotePlus(s: string): string {
  return pyQuote(s, " ").replace(/ /g, "+");
}

/** urllib.parse.urlencode(params, doseq=True), in insertion order. */
export function pyUrlencode(params: Record<string, unknown> | [string, unknown][]): string {
  const pairs = Array.isArray(params) ? params : Object.entries(params);
  const out: string[] = [];
  for (const [k, v] of pairs) {
    if (Array.isArray(v)) for (const x of v) out.push(`${quotePlus(k)}=${quotePlus(pyStr(x))}`);
    else out.push(`${quotePlus(k)}=${quotePlus(pyStr(v))}`);
  }
  return out.join("&");
}

function unquotePlus(s: string): string {
  const t = s.replace(/\+/g, " ");
  try {
    return decodeURIComponent(t);
  } catch {
    return t.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

/** urllib.parse.parse_qsl(query, keep_blank_values=True). */
export function parseQsl(query: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of query.split(/[&]/)) {
    if (!part) continue;
    const i = part.indexOf("=");
    const [k, v] = i < 0 ? [part, ""] : [part.slice(0, i), part.slice(i + 1)];
    out.push([unquotePlus(k), unquotePlus(v)]);
  }
  return out;
}

export type Split = { scheme: string; netloc: string; path: string; query: string; fragment: string };

/** urllib.parse.urlsplit. */
export function urlsplit(url: string): Split {
  const m = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(url) || [];
  return { scheme: m[1] || "", netloc: m[2] || "", path: m[3] || "", query: m[4] || "", fragment: m[5] || "" };
}

export function urlunsplit(s: Split): string {
  let u = s.scheme ? `${s.scheme}:` : "";
  if (s.netloc || s.scheme) u += `//${s.netloc}`;
  u += s.path;
  if (s.query) u += `?${s.query}`;
  if (s.fragment) u += `#${s.fragment}`;
  return u;
}

/** json.dumps(obj, sort_keys=sortKeys, ensure_ascii=ensureAscii) with Python's separators. */
export function pyJsonDumps(obj: unknown, sortKeys = false, ensureAscii = true): string {
  const enc = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : v > 0 ? "Infinity" : v < 0 ? "-Infinity" : "NaN";
    if (typeof v === "string") return !ensureAscii ? JSON.stringify(v) : JSON.stringify(v).replace(/[\u0080-￿]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    const nums = NUMBER_TEXT.get(v as object);
    const member = (key: string, x: unknown) => (nums?.get(key) === x ? (x as string) : enc(x));
    if (Array.isArray(v)) return "[" + v.map((x, i) => member(String(i), x)).join(", ") + "]";
    const keys = Object.keys(v as object);
    if (sortKeys) keys.sort();
    return "{" + keys.map((k) => `${enc(k)}: ${member(k, (v as Record<string, unknown>)[k])}`).join(", ") + "}";
  };
  return enc(obj);
}

/** A stable JSON text (sorted keys) for fingerprints. */
export function stableJson(obj: unknown): string {
  return pyJsonDumps(obj, true);
}

/** repr() of a Python float: shortest round-trip digits, ".0" on whole numbers, exponent below 1e-4 or from 1e16. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [m, es] = Math.abs(x).toExponential().split("e");
  const e = Number(es);
  const digits = m.replace(".", "");
  const sign = x < 0 ? "-" : "";
  if (e < -4 || e >= 16) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${mant}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  if (e < 0) return `${sign}0.${"0".repeat(-e - 1)}${digits}`;
  const int = digits.slice(0, e + 1).padEnd(e + 1, "0");
  const frac = digits.slice(e + 1);
  return `${sign}${int}.${frac || "0"}`;
}

/**
 * JSON.parse that keeps what Python's json module would show: a float written as a whole number ("4.0") or
 * with an exponent Python writes differently comes back as Python's text of it ("4.0", "1e-05"), and an integer
 * too large for a double comes back as its exact digits. Every other number stays a number. So values written
 * to CSV are exactly as published (and as the Python skill wrote them). Use Number() before arithmetic on a
 * value that may be such a string.
 */
export function parsePyJson<T = any>(text: string): T {
  return JSON.parse(text, function (this: unknown, k: string, v: unknown, ctx?: { source?: string }) {
    if (typeof v !== "number" || !ctx?.source) return v;
    const src = ctx.source;
    let out: number | string;
    if (/^-?\d+$/.test(src)) out = Number.isSafeInteger(v) ? v : src.replace(/^(-?)0+(?=\d)/, "$1");
    else {
      const repr = pyFloatRepr(v);
      out = repr === String(v) ? v : repr;
    }
    // a number that became text is still a number when written back as JSON (a list of objects in a CSV cell)
    if (typeof out === "string" && this && typeof this === "object") {
      let m = NUMBER_TEXT.get(this as object);
      if (!m) NUMBER_TEXT.set(this as object, (m = new Map()));
      m.set(k, out);
    }
    return out;
  } as any);
}

/**
 * For each object or array parsePyJson made: the members that were numbers in the JSON but are held as text
 * ("4.0", big integers). pyJsonDumps writes those back as numbers, as Python's json.dumps did; a real string
 * "4.0" stays quoted.
 */
const NUMBER_TEXT = new WeakMap<object, Map<string, string>>();

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
