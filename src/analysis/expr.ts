/**
 * The expression language of compute: a small parser and evaluator, with no eval, no Function and no property
 * access anywhere. An expression is parsed into a tree against a whitelist and evaluated by walking that tree.
 *
 *   literals      12, 0.5, 1e-3, "text" or 'text', true, false, null
 *   columns       a bare name (rate, total_deaths) or col("name with spaces")
 *   operators     + - * / % **   == != < <= > >=   && || !  (also and, or, not)   cond ? a : b
 *   functions     the names in FUNCTIONS, AGGREGATES and WINDOWS below; nothing else can be called
 *
 * Refused at parse time: property access (a.b), indexing (a[0]), template strings, assignment, braces, unknown
 * functions, calls of anything but a whitelisted name, and the names constructor, prototype and __proto__.
 * Values: numbers, text, booleans and null (a gap). Arithmetic on text is an error (convert with number()), and
 * a gap propagates (null + 1 is null); a division by zero is null.
 */
import { pyFloatRepr } from "../core/py.js";
import { pyRepr, pyRound } from "./pyfmt.js";
import type { Row, Value } from "./table.js";

export class ExprError extends Error {}

export type Node =
  | { t: "lit"; v: Value }
  | { t: "col"; name: string }
  | { t: "un"; op: "-" | "+" | "!"; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "cond"; c: Node; a: Node; b: Node }
  | { t: "call"; fn: string; args: Node[] };

const FORBIDDEN = new Set(["constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__", "this", "globalThis", "window", "global", "process", "require", "import",
  "eval", "Function", "new", "function", "return", "class", "async", "await", "yield", "delete", "typeof",
  "instanceof", "void", "with", "var", "let", "const"]);

/** Scalar functions: name -> [min args, max args]. */
export const FUNCTIONS: Record<string, [number, number]> = {
  number: [1, 1], text: [1, 1], string: [1, 1], round: [1, 2], abs: [1, 1], sqrt: [1, 1], log: [1, 1], ln: [1, 1],
  log10: [1, 1], exp: [1, 1], floor: [1, 1], ceil: [1, 1], pow: [2, 2], greatest: [1, 99], least: [1, 99],
  if: [3, 3], coalesce: [1, 99], isnull: [1, 1], notnull: [1, 1], isin: [2, 999], lower: [1, 1], upper: [1, 1],
  trim: [1, 1], substr: [2, 3], len: [1, 1], contains: [2, 2], startswith: [2, 2], endswith: [2, 2],
  replace: [3, 3], concat: [1, 99], zfill: [2, 2], year: [1, 1], month: [1, 1], day: [1, 1], quarter: [1, 1],
  fiscal_year: [1, 1], col: [1, 1],
};
/** Aggregates (over the group, or the whole table when there is no groupby). */
export const AGGREGATES: Record<string, [number, number]> = {
  sum: [1, 1], mean: [1, 1], median: [1, 1], min: [1, 1], max: [1, 1], count: [0, 1], first: [1, 1], last: [1, 1],
  stdev: [1, 1], weighted_mean: [2, 2], n_distinct: [1, 1],
};
/** Window functions (in row order within the group): derive and filter only. */
export const WINDOWS: Record<string, [number, number]> = { lag: [1, 2], lead: [1, 2], cumsum: [1, 1], row_number: [0, 0] };

export const ALLOWED = [...Object.keys(FUNCTIONS), ...Object.keys(AGGREGATES), ...Object.keys(WINDOWS)].sort();

// ---------------------------------------------------------------------- tokens
type Tok = { k: "num" | "str" | "id" | "op" | "end"; v: string; at: number };
const OPS = ["===", "!==", "**", "==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "(", ")",
  ",", "?", ":"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const bad = (msg: string): never => {
    throw new ExprError(`${msg} (at character ${i + 1} of ${JSON.stringify(src)})`);
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(src.slice(i));
    if (num) {
      out.push({ k: "num", v: num[0], at: i });
      i += num[0].length;
      if (/^[A-Za-z_$]/.test(src.slice(i))) bad("a number cannot be followed by a name");
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") {
          const e = src[j + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", "'": "'", '"': '"' };
          if (!(e in map)) bad(`unknown escape \\${e ?? ""} in a string (only \\n \\t \\\\ \\' \\")`);
          s += map[e];
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) bad("unterminated string");
      out.push({ k: "str", v: s, at: i });
      i = j + 1;
      continue;
    }
    if (c === "`") bad("template strings (backticks) are not allowed: use \"text\" and concat()");
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0], at: i });
      i += id[0].length;
      continue;
    }
    if (c === ".") bad("property access (.) is not allowed: name a column, or use col(\"a.b\") for a column whose name has a dot");
    if (c === "[" || c === "]") bad("indexing ([ ]) is not allowed");
    if (c === "{" || c === "}") bad("braces are not allowed");
    if (c === "=" && src[i + 1] === ">") bad("functions (=>) are not allowed");
    if (c === "=" && src[i + 1] !== "=") bad("assignment (=) is not allowed: compare with ==");
    if (c === ";") bad("only one expression is allowed (no ;)");
    if (c === "$" || c === "#" || c === "@" || c === "\\") bad(`the character ${c} is not allowed`);
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) bad(`unexpected character ${JSON.stringify(c)}`);
    out.push({ k: "op", v: op === "===" ? "==" : op === "!==" ? "!=" : op!, at: i });
    i += op!.length;
  }
  out.push({ k: "end", v: "", at: src.length });
  return out;
}

// ---------------------------------------------------------------------- parser
class Parser {
  i = 0;
  constructor(private toks: Tok[], private src: string) {}
  peek(): Tok {
    return this.toks[this.i];
  }
  next(): Tok {
    return this.toks[this.i++];
  }
  isOp(v: string): boolean {
    const t = this.peek();
    return t.k === "op" && t.v === v;
  }
  isWord(v: string): boolean {
    const t = this.peek();
    return t.k === "id" && t.v === v;
  }
  expect(v: string): void {
    if (!this.isOp(v)) this.fail(`expected ${v}`);
    this.i++;
  }
  fail(msg: string): never {
    const t = this.peek();
    throw new ExprError(`${msg} (at character ${t.at + 1} of ${JSON.stringify(this.src)})`);
  }
  parse(): Node {
    const n = this.cond();
    if (this.peek().k !== "end") this.fail(`unexpected ${JSON.stringify(this.peek().v)}`);
    return n;
  }
  depth = 0;
  cond(): Node {
    if (++this.depth > 64) this.fail("the expression nests too deeply (more than 64 levels)");
    try {
      return this.cond1();
    } finally {
      this.depth--;
    }
  }
  cond1(): Node {
    const c = this.or();
    if (this.isOp("?")) {
      this.i++;
      const a = this.cond();
      this.expect(":");
      const b = this.cond();
      return { t: "cond", c, a, b };
    }
    return c;
  }
  or(): Node {
    let a = this.and();
    while (this.isOp("||") || this.isWord("or")) {
      this.i++;
      a = { t: "bin", op: "||", a, b: this.and() };
    }
    return a;
  }
  and(): Node {
    let a = this.not();
    while (this.isOp("&&") || this.isWord("and")) {
      this.i++;
      a = { t: "bin", op: "&&", a, b: this.not() };
    }
    return a;
  }
  not(): Node {
    if (this.isOp("!") || this.isWord("not")) {
      this.i++;
      return { t: "un", op: "!", a: this.not() };
    }
    return this.cmp();
  }
  cmp(): Node {
    const a = this.add();
    const t = this.peek();
    if (t.k === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      this.i++;
      const b = this.add();
      const t2 = this.peek();
      if (t2.k === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t2.v)) this.fail("chained comparisons: combine with &&");
      return { t: "bin", op: t.v, a, b };
    }
    return a;
  }
  add(): Node {
    let a = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().v;
      a = { t: "bin", op, a, b: this.mul() };
    }
    return a;
  }
  mul(): Node {
    let a = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.next().v;
      a = { t: "bin", op, a, b: this.unary() };
    }
    return a;
  }
  unary(): Node {
    if (this.isOp("-") || this.isOp("+")) {
      const op = this.next().v as "-" | "+";
      return { t: "un", op, a: this.unary() };
    }
    return this.power();
  }
  power(): Node {
    const a = this.primary();
    if (this.isOp("**")) {
      this.i++;
      return { t: "bin", op: "**", a, b: this.unary() };
    }
    return a;
  }
  primary(): Node {
    const t = this.next();
    let n: Node;
    if (t.k === "num") n = { t: "lit", v: Number(t.v) };
    else if (t.k === "str") n = { t: "lit", v: t.v };
    else if (t.k === "op" && t.v === "(") {
      n = this.cond();
      this.expect(")");
    } else if (t.k === "id") {
      if (FORBIDDEN.has(t.v) || t.v.startsWith("__")) {
        this.i--;
        this.fail(`the name ${t.v} is not allowed`);
      }
      if (t.v === "true" || t.v === "True") n = { t: "lit", v: true };
      else if (t.v === "false" || t.v === "False") n = { t: "lit", v: false };
      else if (t.v === "null" || t.v === "None") n = { t: "lit", v: null };
      else if (this.isOp("(")) {
        const fn = t.v;
        const table = [FUNCTIONS, AGGREGATES, WINDOWS].find((x) => Object.hasOwn(x, fn));
        if (!table) {
          this.i--;
          this.fail(`unknown function ${fn}(); the functions are: ${ALLOWED.join(", ")}`);
        }
        const ar = table[fn];
        this.i++;
        const args: Node[] = [];
        if (!this.isOp(")")) {
          args.push(this.cond());
          while (this.isOp(",")) {
            this.i++;
            args.push(this.cond());
          }
        }
        this.expect(")");
        if (args.length < ar[0] || args.length > ar[1]) {
          throw new ExprError(`${fn}() takes ${ar[0] === ar[1] ? ar[0] : `${ar[0]} to ${ar[1]}`} argument(s), got ${args.length}`);
        }
        if (fn === "col") {
          const a = args[0];
          if (a.t !== "lit" || typeof a.v !== "string") throw new ExprError('col() takes a column name in quotes: col("my column")');
          if (FORBIDDEN.has(a.v) || a.v.startsWith("__")) throw new ExprError(`the name ${a.v} is not allowed`);
          n = { t: "col", name: a.v };
        } else n = { t: "call", fn, args };
      } else n = { t: "col", name: t.v };
    } else {
      this.i--;
      this.fail(t.k === "end" ? "the expression ends too early" : `unexpected ${JSON.stringify(t.v)}`);
    }
    if (this.isOp("(")) this.fail("only a function name can be called");
    return n;
  }
}

export function parse(src: unknown): Node {
  if (typeof src === "number" || typeof src === "boolean" || src === null) return { t: "lit", v: src as Value };
  if (typeof src !== "string") throw new ExprError(`an expression is text, not ${JSON.stringify(src)}`);
  if (src.length > 2000) throw new ExprError("expression longer than 2000 characters");
  return new Parser(tokenize(src), src).parse();
}

/** Column names an expression reads, and whether it uses aggregates or windows (outside aggregates). */
export function inspect(n: Node): { cols: string[]; agg: boolean; win: boolean } {
  const cols = new Set<string>();
  let agg = false, win = false;
  const walk = (x: Node, inAgg: boolean) => {
    switch (x.t) {
      case "col":
        cols.add(x.name);
        break;
      case "un":
        walk(x.a, inAgg);
        break;
      case "bin":
        walk(x.a, inAgg);
        walk(x.b, inAgg);
        break;
      case "cond":
        walk(x.c, inAgg);
        walk(x.a, inAgg);
        walk(x.b, inAgg);
        break;
      case "call":
        if (AGGREGATES[x.fn]) {
          if (inAgg) throw new ExprError(`an aggregate inside an aggregate (${x.fn}) is not allowed`);
          agg = true;
        }
        if (WINDOWS[x.fn]) {
          if (inAgg) throw new ExprError(`a window function inside an aggregate (${x.fn}) is not allowed`);
          win = true;
        }
        x.args.forEach((a) => walk(a, inAgg || !!AGGREGATES[x.fn]));
        break;
    }
  };
  walk(n, false);
  return { cols: [...cols], agg, win };
}

// ---------------------------------------------------------------------- evaluation
export type Ctx = {
  /** The current row (absent in a rollup, where only aggregates and group keys may be read). */
  row?: Row;
  /** The row's index in `group`. */
  i: number;
  /** The rows of the current group (the whole table without groupby), in order. */
  group: Row[];
  /** Columns readable outside an aggregate in a rollup (the group keys). */
  keys?: Set<string>;
  cache: Map<Node, unknown>;
};

const show = (v: Value) => (typeof v === "number" ? pyFloatRepr(v).replace(/\.0$/, "") : pyRepr(v));

function numArg(fn: string, v: Value): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new ExprError(`${fn}: ${show(v)} is text, not a number: convert it with number() first`);
}

function finite(x: number): number | null {
  return Number.isFinite(x) ? (x === 0 ? 0 : x) : null;
}

function truthy(v: Value): boolean {
  return v !== null && v !== false && v !== 0 && v !== "";
}

/** number(x): text such as "1,234", "$1,234.50" or " 12 " as a number; null when it is no number (a flag). */
export function toNumber(v: Value): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = v.trim().replace(/^\$/, "").replace(/^(-?)\$/, "$1").replace(/,/g, "").replace(/\s+/g, "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  return Number(s);
}

/** A date cell as [year, month, day]: 2023-10-01, 2023-10, 2023-10-01T.., 10/01/2023, 2023M10, 2023Q4 (first month). */
export function dateParts(v: Value): [number, number, number] | null {
  if (v === null) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[T ].*)?$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3] || 1)];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return [Number(m[3]), Number(m[1]), Number(m[2])];
  m = /^(\d{4})M(\d{1,2})$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), 1];
  m = /^(\d{4})-?Q([1-4])$/.exec(s);
  if (m) return [Number(m[1]), (Number(m[2]) - 1) * 3 + 1, 1];
  return null;
}

function dateOf(fn: string, v: Value): [number, number, number] | null {
  if (v === null) return null;
  const d = dateParts(v);
  if (!d || d[1] < 1 || d[1] > 12 || d[2] < 1 || d[2] > 31) {
    throw new ExprError(`${fn}: ${show(v)} is not a date (use 2023-10-01, 2023-10, 10/01/2023, 2023M10 or 2023Q4)`);
  }
  return d;
}

/** Equality as a reader of the CSV sees it: 2020 equals "2020"; text compares exactly. */
export function looseEq(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === typeof b) return a === b;
  if (typeof a === "number" && typeof b === "string") return toNumber(b) === a && /^[+-]?[\d.eE+-]+$/.test(b.trim());
  if (typeof b === "number" && typeof a === "string") return looseEq(b, a);
  if (typeof a === "boolean" || typeof b === "boolean") return text(a) === text(b);
  return false;
}

/** Order of two values (numbers before text; null last). */
export function compare(a: Value, b: Value): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function aggregate(fn: string, vals: Value[], weights?: Value[]): Value {
  const nums = (): number[] => {
    const out: number[] = [];
    for (const v of vals) {
      const x = numArg(fn, v);
      if (x !== null && !Number.isNaN(x)) out.push(x);
    }
    return out;
  };
  switch (fn) {
    case "count":
      return vals.filter((v) => v !== null).length;
    case "n_distinct":
      return new Set(vals.filter((v) => v !== null).map((v) => `${typeof v}:${v}`)).size;
    case "first":
      return vals.length ? vals[0] : null;
    case "last":
      return vals.length ? vals[vals.length - 1] : null;
    case "min":
    case "max": {
      const xs = vals.filter((v) => v !== null);
      if (!xs.length) return null;
      const kinds = new Set(xs.map((v) => (typeof v === "string" ? "text" : "num")));
      if (kinds.size > 1) throw new ExprError(`${fn}: the values mix numbers and text: convert with number() first`);
      return xs.reduce((a, b) => (compare(a, b) * (fn === "min" ? 1 : -1) <= 0 ? a : b));
    }
    case "sum": {
      const xs = nums();
      return xs.length ? finite(xs.reduce((a, b) => a + b, 0)) : null;
    }
    case "mean": {
      const xs = nums();
      return xs.length ? finite(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    }
    case "median": {
      const xs = nums().sort((a, b) => a - b);
      if (!xs.length) return null;
      const h = xs.length >> 1;
      return xs.length % 2 ? xs[h] : (xs[h - 1] + xs[h]) / 2;
    }
    case "stdev": {
      const xs = nums();
      if (xs.length < 2) return null;
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return finite(Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)));
    }
    case "weighted_mean": {
      let sw = 0, swx = 0;
      vals.forEach((v, i) => {
        const x = numArg(fn, v), w = numArg(fn, weights![i]);
        if (x === null || w === null || Number.isNaN(x) || Number.isNaN(w)) return;
        sw += w;
        swx += w * x;
      });
      return sw === 0 ? null : finite(swx / sw);
    }
  }
  throw new ExprError(`unknown aggregate ${fn}`);
}

function arith(op: string, a: Value, b: Value): Value {
  if (op === "+" && typeof a === "string" && typeof b === "string") return a + b;
  if (a === null || b === null) return null;
  const x = numArg(op, a)!, y = numArg(op, b)!;
  switch (op) {
    case "+":
      return finite(x + y);
    case "-":
      return finite(x - y);
    case "*":
      return finite(x * y);
    case "/":
      return y === 0 ? null : finite(x / y);
    case "%":
      return y === 0 ? null : finite(x - y * Math.floor(x / y));
    case "**":
      return finite(x ** y);
  }
  throw new ExprError(`unknown operator ${op}`);
}

function text(v: Value): string | null {
  if (v === null) return null;
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(v) : pyFloatRepr(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  return v;
}

function strArg(fn: string, v: Value): string | null {
  return v === null ? null : text(v);
}

export function evaluate(n: Node, ctx: Ctx): Value {
  switch (n.t) {
    case "lit":
      return n.v;
    case "col": {
      if (!ctx.row) {
        if (ctx.keys?.has(n.name)) return ctx.group.length ? ctx.group[0][n.name] ?? null : null;
        throw new ExprError(`in a rollup, ${n.name} must be inside an aggregate (sum, mean, first ...) or be a groupby key`);
      }
      return Object.hasOwn(ctx.row, n.name) ? ctx.row[n.name] : null;
    }
    case "un": {
      const a = evaluate(n.a, ctx);
      if (n.op === "!") return !truthy(a);
      if (a === null) return null;
      const x = numArg(n.op, a)!;
      return n.op === "-" ? (x === 0 ? 0 : -x) : x;
    }
    case "cond":
      return truthy(evaluate(n.c, ctx)) ? evaluate(n.a, ctx) : evaluate(n.b, ctx);
    case "bin": {
      if (n.op === "&&") return truthy(evaluate(n.a, ctx)) && truthy(evaluate(n.b, ctx));
      if (n.op === "||") return truthy(evaluate(n.a, ctx)) || truthy(evaluate(n.b, ctx));
      const a = evaluate(n.a, ctx), b = evaluate(n.b, ctx);
      switch (n.op) {
        case "==":
          return looseEq(a, b);
        case "!=":
          return !looseEq(a, b);
        case "<":
        case "<=":
        case ">":
        case ">=": {
          if (a === null || b === null) return false;
          const na = typeof a === "string" && typeof b === "number" ? null : a;
          const nb = typeof b === "string" && typeof a === "number" ? null : b;
          if (na === null || nb === null) {
            throw new ExprError(`${n.op}: comparing a number with text ${show(typeof a === "string" ? a : b)}: convert with number() first`);
          }
          const c = compare(a, b);
          return n.op === "<" ? c < 0 : n.op === "<=" ? c <= 0 : n.op === ">" ? c > 0 : c >= 0;
        }
        default:
          return arith(n.op, a, b);
      }
    }
    case "call":
      return call(n, ctx);
  }
}

function call(n: Extract<Node, { t: "call" }>, ctx: Ctx): Value {
  const fn = n.fn;
  if (AGGREGATES[fn]) {
    if (ctx.cache.has(n)) return ctx.cache.get(n) as Value;
    const sub = (i: number): Ctx => ({ row: ctx.group[i], i, group: ctx.group, cache: new Map() });
    const vals = fn === "count" && !n.args.length ? ctx.group.map(() => 1 as Value)
      : ctx.group.map((_, i) => evaluate(n.args[0], sub(i)));
    const w = fn === "weighted_mean" ? ctx.group.map((_, i) => evaluate(n.args[1], sub(i))) : undefined;
    const v = aggregate(fn, vals, w);
    ctx.cache.set(n, v);
    return v;
  }
  if (WINDOWS[fn]) {
    if (!ctx.row) throw new ExprError(`${fn}() works in derive and filter, not in a rollup`);
    if (fn === "row_number") return ctx.i + 1;
    if (fn === "lag" || fn === "lead") {
      const k = n.args[1] ? numArg(fn, evaluate(n.args[1], ctx)) : 1;
      if (k === null || !Number.isInteger(k) || k < 0) throw new ExprError(`${fn}: the offset is a whole number >= 0`);
      const j = fn === "lag" ? ctx.i - k : ctx.i + k;
      if (j < 0 || j >= ctx.group.length) return null;
      return evaluate(n.args[0], { row: ctx.group[j], i: j, group: ctx.group, cache: new Map() });
    }
    // cumsum: running sum of the group up to this row (gaps count as 0 once a value was seen)
    let arr = ctx.cache.get(n) as (number | null)[] | undefined;
    if (!arr) {
      arr = [];
      let s: number | null = null;
      ctx.group.forEach((r, i) => {
        const x = numArg(fn, evaluate(n.args[0], { row: r, i, group: ctx.group, cache: new Map() }));
        if (x !== null) s = (s ?? 0) + x;
        arr!.push(s);
      });
      ctx.cache.set(n, arr);
    }
    return arr[ctx.i];
  }
  const args = n.args.map((a) => (fn === "if" || fn === "coalesce" ? null : evaluate(a, ctx)));
  const x = args[0];
  const num1 = () => numArg(fn, x);
  switch (fn) {
    case "if":
      return truthy(evaluate(n.args[0], ctx)) ? evaluate(n.args[1], ctx) : evaluate(n.args[2], ctx);
    case "coalesce":
      for (const a of n.args) {
        const v = evaluate(a, ctx);
        if (v !== null) return v;
      }
      return null;
    case "number":
      return toNumber(x);
    case "text":
    case "string":
      return text(x);
    case "round": {
      const v = num1();
      const d = args[1] === undefined ? 0 : numArg(fn, args[1]);
      if (d === null || !Number.isInteger(d)) throw new ExprError("round: digits is a whole number");
      return v === null ? null : pyRound(v, d);
    }
    case "abs": {
      const v = num1();
      return v === null ? null : Math.abs(v);
    }
    case "sqrt":
    case "log":
    case "ln":
    case "log10":
    case "exp":
    case "floor":
    case "ceil": {
      const v = num1();
      if (v === null) return null;
      const f = { sqrt: Math.sqrt, log: Math.log, ln: Math.log, log10: Math.log10, exp: Math.exp, floor: Math.floor,
        ceil: Math.ceil }[fn]!;
      return finite(f(v));
    }
    case "pow": {
      const a = num1(), b = numArg(fn, args[1]);
      return a === null || b === null ? null : finite(a ** b);
    }
    case "greatest":
    case "least": {
      const xs = args.filter((v) => v !== null);
      if (!xs.length) return null;
      xs.forEach((v) => numArg(fn, v));
      return xs.reduce((a, b) => (compare(a, b) * (fn === "least" ? 1 : -1) <= 0 ? a : b));
    }
    case "isnull":
      return x === null;
    case "notnull":
      return x !== null;
    case "isin":
      return args.slice(1).some((v) => looseEq(x, v));
    case "lower":
    case "upper":
    case "trim": {
      const s = strArg(fn, x);
      if (s === null) return null;
      return fn === "lower" ? s.toLowerCase() : fn === "upper" ? s.toUpperCase() : s.trim();
    }
    case "len": {
      const s = strArg(fn, x);
      return s === null ? null : [...s].length;
    }
    case "substr": {
      const s = strArg(fn, x);
      const st = numArg(fn, args[1]), ln = args[2] === undefined ? undefined : numArg(fn, args[2]);
      if (s === null || st === null) return null;
      return [...s].slice(st, ln === undefined || ln === null ? undefined : st + ln).join("");
    }
    case "contains":
    case "startswith":
    case "endswith": {
      const s = strArg(fn, x), t = strArg(fn, args[1]);
      if (s === null || t === null) return null;
      return fn === "contains" ? s.includes(t) : fn === "startswith" ? s.startsWith(t) : s.endsWith(t);
    }
    case "replace": {
      const s = strArg(fn, x), a = strArg(fn, args[1]), b = strArg(fn, args[2]);
      if (s === null || a === null || b === null) return null;
      return a === "" ? s : s.split(a).join(b);
    }
    case "concat":
      return args.map((v) => text(v) ?? "").join("");
    case "zfill": {
      const s = strArg(fn, x), w = numArg(fn, args[1]);
      if (s === null || w === null) return null;
      const neg = /^[+-]/.test(s) ? s[0] : "";
      return neg + s.slice(neg.length).padStart(w - neg.length, "0");
    }
    case "year":
    case "month":
    case "day":
    case "quarter":
    case "fiscal_year": {
      const d = dateOf(fn, x);
      if (!d) return null;
      if (fn === "year") return d[0];
      if (fn === "month") return d[1];
      if (fn === "day") return d[2];
      if (fn === "quarter") return Math.floor((d[1] - 1) / 3) + 1;
      return d[0] + (d[1] >= 10 ? 1 : 0);
    }
  }
  throw new ExprError(`unknown function ${fn}`);
}

/** Parse and check an expression against a table's columns. */
export function compile(src: unknown, cols: string[], o: { agg?: boolean; win?: boolean; what?: string } = {}): Node {
  const n = parse(src);
  const info = inspect(n);
  const missing = info.cols.filter((c) => !cols.includes(c));
  if (missing.length) {
    throw new ExprError(`unknown column${missing.length > 1 ? "s" : ""} ${missing.join(", ")}; the columns are ${pyRepr(cols)}` +
      " (quote text values: \"New York\"; a name with spaces or dots: col(\"a b\"))");
  }
  if (info.agg && o.agg === false) throw new ExprError(`aggregates are not allowed in ${o.what || "this step"}`);
  if (info.win && o.win === false) throw new ExprError(`window functions are not allowed in ${o.what || "this step"}`);
  return n;
}

/** A copy of a compiled expression with every read of column `from` reading column `to` instead (replicate weights). */
export function substituteColumn(n: Node, from: string, to: string): Node {
  switch (n.t) {
    case "lit":
      return n;
    case "col":
      return n.name === from ? { t: "col", name: to } : n;
    case "un":
      return { t: "un", op: n.op, a: substituteColumn(n.a, from, to) };
    case "bin":
      return { t: "bin", op: n.op, a: substituteColumn(n.a, from, to), b: substituteColumn(n.b, from, to) };
    case "cond":
      return { t: "cond", c: substituteColumn(n.c, from, to), a: substituteColumn(n.a, from, to), b: substituteColumn(n.b, from, to) };
    case "call":
      return { t: "call", fn: n.fn, args: n.args.map((x) => substituteColumn(x, from, to)) };
  }
}

export function isTruthy(v: Value): boolean {
  return truthy(v);
}
