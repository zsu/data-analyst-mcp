/**
 * Python text forms the analysis layer needs: repr() of values in messages, format(x, ",.Nf") and "%.15g", and
 * decimal rounding on the shortest form of a float (Decimal(repr(x)).quantize, half up or half even).
 */
import { pyFloatRepr } from "../core/py.js";

/** Python repr() of a JSON-like value (strings in single quotes, None, True/False, lists, dicts). */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(v) : pyFloatRepr(v);
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

/** repr() of a value Python holds as a float (whole numbers as "4.0"). */
export function pyFloat(v: number): string {
  return pyFloatRepr(v);
}

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** format(x, ",.Nf") (grouping) or format(x, ".Nf"). */
export function fixed(x: number, digits: number, grouping = true): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  let s: string;
  if (Math.abs(x) >= 1e21) {
    s = BigInt(Math.round(x)).toString() + (digits > 0 ? "." + "0".repeat(digits) : "");
  } else s = x.toFixed(digits);
  if (!grouping) return s;
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [i, f] = body.split(".");
  return (neg ? "-" : "") + group(i) + (f !== undefined ? "." + f : "");
}

/** format(x, ".15g") (or another precision): Python's general format. */
export function gfmt(x: number, precision = 15): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const p = Math.max(precision, 1);
  const [m, es] = x.toExponential(p - 1).split("e");
  const e = Number(es);
  const strip = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (e < -4 || e >= p) {
    return `${strip(m)}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  return strip(x.toFixed(Math.max(p - 1 - e, 0)));
}

/** The decimal digits of a float's shortest form: value = m * 10^e. */
function decimalOf(x: number): { m: bigint; e: number } {
  const s = String(x);
  const r = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(s);
  if (!r) throw new Error(`not a finite number: ${s}`);
  const frac = r[3] || "";
  const m = BigInt((r[1] || "") + r[2] + frac);
  return { m, e: Number(r[4] || 0) - frac.length };
}

const pow10 = (n: number) => 10n ** BigInt(n);

/**
 * x * mul / div rounded to `digits` decimals (negative: tens, hundreds ...), in decimal on the shortest form of x
 * (so 0.145 * 100 is 14.5). mode "half_up" rounds ties away from zero (Decimal ROUND_HALF_UP); "half_even" is
 * Python's round(). div must be a power of ten. A zero result is never negative.
 */
export function decRound(x: number, digits: number, mul = 1, div = 1, mode: "half_up" | "half_even" = "half_up"): number {
  if (!Number.isFinite(x)) return x;
  let { m, e } = decimalOf(x);
  m *= BigInt(mul);
  const k = Math.round(Math.log10(div));
  if (10 ** k !== div) throw new Error(`decRound: div ${div} is not a power of ten`);
  e -= k;
  const T = -digits;
  let q: bigint;
  if (e >= T) {
    q = m * pow10(e - T);
  } else {
    const shift = T - e;
    const p = pow10(shift);
    q = m / p;
    const r = m % p;
    const ar = r < 0n ? -r : r;
    const half = 5n * pow10(shift - 1);
    const up = ar > half || (ar === half && (mode === "half_up" || q % 2n !== 0n));
    if (up) q += m < 0n ? -1n : 1n;
  }
  const out = Number(`${q}e${T}`);
  return out === 0 ? 0 : out;
}

/** The exact value of a double as num / 2^den2 (den2 >= 0) or num * 2^-den2 (den2 < 0). */
function exactBinary(x: number): { num: bigint; exp2: number } {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const bexp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp2: number;
  if (bexp === 0) exp2 = -1074;
  else {
    mant |= 1n << 52n;
    exp2 = bexp - 1075;
  }
  return { num: sign * mant, exp2 };
}

/** Python round(x, n): the exact binary value rounded half to even (round(2.675, 2) is 2.67, round(0.5) is 0). */
export function pyRound(x: number, n = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const { num, exp2 } = exactBinary(x);
  // x * 10^n = num * 2^exp2 * 10^n = A / B
  let A = num, B = 1n;
  if (exp2 >= 0) A <<= BigInt(exp2);
  else B <<= BigInt(-exp2);
  if (n >= 0) A *= pow10(n);
  else B *= pow10(-n);
  const neg = A < 0n;
  const a = neg ? -A : A;
  let q = a / B;
  const r2 = (a % B) * 2n;
  if (r2 > B || (r2 === B && q % 2n === 1n)) q += 1n;
  const signed = neg ? -q : q;
  const out = n >= 0 ? Number(`${signed}e-${n}`) : Number(`${signed}e${-n}`);
  return out === 0 ? (neg ? -0 : 0) : out;
}
