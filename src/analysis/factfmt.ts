/**
 * Formatting of registered facts for prose: a port of the Python skill's scripts/analysis/factfmt.py (shared by
 * facts, build_report and the audits). One version for every source pack: every format code the packs use.
 *
 * A format string is  [prefix:]... kind[:digits][:abs]    e.g. "pct:1", "signed:pct100:1", "pct:1:abs",
 * "from_millions:dollars_b:1". digits may be negative (round to tens, hundreds ...); default 0.
 *
 * Kinds (value as stored -> text):
 *   raw          value as given: integral numbers without decimals or grouping (2015.0 -> "2015"), other floats
 *                in their shortest form without binary noise (0.1 + 0.2 -> "0.3"), text unchanged
 *   pct:0        0.8734  -> "87 percent"            share stored as 0-1
 *   pct100:1     87.34   -> "87.3 percent"          already in percent (FRED and BLS rates: 4.2)
 *   pp:1         0.038   -> "3.8 percentage points" difference of two shares (0-1), absolute value
 *   pp100:1      3.8     -> "3.8 percentage points" already in points, absolute value
 *   bp:0         0.0025  -> "25 basis points"       difference of two rates stored as 0-1, absolute value
 *   bp100:0      0.25    -> "25 basis points"       difference of two rates already in percent, absolute value
 *   dollars:0    80612   -> "$80,612"; dollars:-2 -> "$80,600"; dollars:2 34.3 -> "$34.30"
 *   num:0        25812   -> "25,812"; in reports whole numbers 0-9 are spelled out ("seven"); mode "answer"
 *                (facts.json text) keeps digits, which the answer gate can check
 *   thousands:-3 254     -> "254,000"               value in thousands -> the full number
 *   millions:1   25.8e6  -> "25.8 million"          a count in units (no dollar sign)
 *   billions:1 / trillions:1, kmillions:1 (value in thousands -> "159.0 million")
 *   usd_m / usd_b / usd_t (aliases dollars_m/_b/_t): value in DOLLARS -> "$1,832.8 billion"
 *   usd_m_scaled / usd_b_scaled / usd_t_scaled: value ALREADY in millions / billions / trillions of dollars
 *   ratio:2      0.991   -> "0.99";   index:1  123.456 -> "123.5";   year 2015.0 -> "2015"
 * Prefixes: signed:, abs:, from_thousands: / from_millions: / from_billions:.  Suffix: :abs.
 *
 * Conventions: rounding is half away from zero on the shortest decimal form of the value (2.25 -> "2.3"); a
 * value that rounds to zero never prints a minus sign; "1 percentage point", "0.1 percentage point",
 * "1 basis point" are singular; percent is spelled out; raw never adds digit grouping.
 */
import { decRound, fixed, gfmt, pyFloat, pyRepr } from "./pyfmt.js";

export const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
export const FROM_SCALES: Record<string, number> = { from_thousands: 1e3, from_millions: 1e6, from_billions: 1e9 };
export const PREFIXES = ["signed", "abs", ...Object.keys(FROM_SCALES)];
const DOLLAR_SCALES: Record<string, [number, string]> = { m: [10 ** 6, "million"], b: [10 ** 9, "billion"], t: [10 ** 12, "trillion"] };
const ALIASES: Record<string, string> = { dollars_m: "usd_m", dollars_b: "usd_b", dollars_t: "usd_t" };
export const KINDS = ["raw", "pct", "pct100", "pp", "pp100", "bp", "bp100", "dollars", "num", "thousands", "millions",
  "billions", "trillions", "kmillions", "usd_m", "usd_b", "usd_t", "usd_m_scaled", "usd_b_scaled",
  "usd_t_scaled", "ratio", "index", "year", ...Object.keys(ALIASES)];
/** The placeholder grammar build_report and audit_report accept: {{name}} or {{name|fmt}}. */
export const FMT_PATTERN = String.raw`[a-z0-9_]+(?::[a-z0-9_]+)*(?::-?\d+)?(?::abs)?`;

export class FormatError extends Error {}

const round = (x: number, digits: number, mul = 1, div = 1) => decRound(Number(x), digits, mul, div, "half_up");
const num = (x: number, digits: number, mul = 1, div = 1) => fixed(round(x, digits, mul, div), Math.max(digits, 0));
const neg = (x: number, digits: number, mul = 1, div = 1) => (round(x, digits, mul, div) < 0 ? "-" : "");

function points(n: string): string {
  const v = Number(n.replace(/,/g, ""));
  return `${n} percentage point${v === 1 || v === 0.1 ? "" : "s"}`;
}

function raw(value: unknown): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value !== "number") return value === null || value === undefined ? "None" : String(value);
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
  if (Number.isInteger(value)) return BigInt(value).toString();
  return gfmt(value, 15);
}

/** float(value) as Python does: a number, or text that is a number; else a FormatError (Python's ValueError). */
function toFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value)) return Number(value);
  if (typeof value === "string" && /^\s*[+-]?(nan|inf|infinity)\s*$/i.test(value)) {
    const t = value.trim().toLowerCase();
    return t.includes("nan") ? NaN : t.startsWith("-") ? -Infinity : Infinity;
  }
  throw new FormatError(`could not convert string to float: ${pyRepr(value)}`);
}

/** [prefixes, kind, digits, abs] of a format string; throws FormatError for anything unknown. */
export function parseFmt(fmt: string): [string[], string, number, boolean] {
  const parts = String(fmt).split(":");
  const pre: string[] = [];
  while (parts.length && PREFIXES.includes(parts[0])) pre.push(parts.shift()!);
  if (!parts.length) throw new FormatError(`fact format ${pyRepr(fmt)} has no kind`);
  const kind = parts.shift()!;
  if (!KINDS.includes(kind)) {
    throw new FormatError(`unknown fact format ${pyRepr(fmt)}: kind ${pyRepr(kind)} is not one of ${KINDS.join(", ")} (a whole ` +
      "number: num:0; a rate already in percent: pct100:1; a share 0-1: pct:1)");
  }
  let digits = 0, absolute = false;
  if (parts.length && /^-?\d+$/.test(parts[0])) digits = parseInt(parts.shift()!, 10);
  if (parts.length && parts[0] === "abs") {
    absolute = true;
    parts.shift();
  }
  if (parts.length) {
    throw new FormatError(`unknown fact format modifier ${pyRepr(parts.join(":"))} in ${pyRepr(fmt)} (only ':digits' and ':abs')`);
  }
  return [pre, ALIASES[kind] ?? kind, digits, absolute];
}

export type FormatMode = "report" | "answer" | "paper";

/**
 * The text of a fact value in a format. mode "answer" prints 0-9 as digits; any other mode spells them out.
 * `warn` receives the warnings Python printed to stderr (a pp value above 1).
 */
export function formatValue(value: unknown, fmt: string | null | undefined = "raw", mode: FormatMode | string = "report",
  warn: (msg: string) => void = () => {}): string {
  if (fmt === null || fmt === undefined || fmt === "" || fmt === "raw") return raw(value);
  const [pre, kind, digits, absolute] = parseFmt(fmt);
  if (pre.length) {
    const head = pre[0];
    const rest = fmt.split(":").slice(1).join(":");
    const v = toFloat(value);
    if (head === "signed") {
      let body = formatValue(Math.abs(v), rest, mode, warn);
      if (WORDS.includes(body) ? body === "zero" : !/[1-9]/.test(body)) return body;
      if (WORDS.includes(body)) body = String(WORDS.indexOf(body));
      return (v > 0 ? "+" : v < 0 ? "-" : "") + body;
    }
    if (head === "abs") return formatValue(Math.abs(v), rest, mode, warn);
    return formatValue(v * FROM_SCALES[head], rest, mode, warn);
  }
  if (kind === "raw") return raw(absolute ? Math.abs(toFloat(value)) : value);
  let v = toFloat(value);
  if (absolute) v = Math.abs(v);
  switch (kind) {
    case "pct":
      return `${num(v, digits, 100)} percent`;
    case "pct100":
      return `${num(v, digits)} percent`;
    case "pp":
      if (Math.abs(v) > 1) {
        warn(`WARNING: pp format got ${pyFloat(v)}, which would print as ${num(Math.abs(v), digits, 100)} percentage ` +
          "points; pp expects a difference of two shares (0-1). If the value is already in points, use pp100.");
      }
      return points(num(Math.abs(v), digits, 100));
    case "pp100":
      return points(num(Math.abs(v), digits));
    case "bp":
    case "bp100": {
      const n = num(Math.abs(v), digits, kind === "bp" ? 10000 : 100);
      return `${n} basis point${n === "1" ? "" : "s"}`;
    }
    case "dollars":
      return `${neg(v, digits)}$${num(Math.abs(v), digits)}`;
    case "num": {
      const r = round(v, digits);
      if (mode !== "answer" && digits <= 0 && Number.isInteger(r) && r >= 0 && r <= 9) return WORDS[r];
      return num(v, digits);
    }
    case "thousands":
      return `${neg(v, digits, 1000)}${num(Math.abs(v), digits, 1000)}`;
    case "millions":
      return `${num(v, digits, 1, 10 ** 6)} million`;
    case "billions":
      return `${num(v, digits, 1, 10 ** 9)} billion`;
    case "trillions":
      return `${num(v, digits, 1, 10 ** 12)} trillion`;
    case "kmillions":
      return `${num(v, digits, 1, 1000)} million`;
    case "usd_m":
    case "usd_b":
    case "usd_t": {
      const [scale, word] = DOLLAR_SCALES[kind.slice(-1)];
      return `${neg(v, digits, 1, scale)}$${num(Math.abs(v), digits, 1, scale)} ${word}`;
    }
    case "usd_m_scaled":
    case "usd_b_scaled":
    case "usd_t_scaled": {
      const word = DOLLAR_SCALES[kind[4]][1];
      return `${neg(v, digits)}$${num(Math.abs(v), digits)} ${word}`;
    }
    case "ratio":
    case "index":
      return num(v, digits);
    case "year":
      return String(round(v, 0));
  }
  throw new FormatError(`unknown fact format ${pyRepr(fmt)}`);
}
