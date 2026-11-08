/**
 * compute: declarative steps over full workspace tables, saved as an exhibit CSV with its lineage.
 *
 * The steps are data, never code: every expression goes through expr.ts (a whitelisted parser), and every verb
 * is a fixed function here. The same steps replay from the recorded inputs (rerun.ts), so every exhibit and
 * every number read from it is reproduced by the server, not typed.
 *
 * Inputs are workspace CSVs (data/<id>/, exhibits/, published/) or Parquet files under data/<id>/ (the opm pack writes
 * tables over 1M rows only as Parquet); an input may name the columns to read ({path, columns}), which for Parquet
 * is the only part decoded.
 *
 * exhibits/lineage.json: {"exhibits/<x>.csv": {"packs": [...], "tool": "compute", "from": alias,
 *   "inputs": {alias: {"path", "sha256", "columns"?}}, "steps": [...], "sha256": <the CSV's hash>}}. The older format is
 * {"exhibits/<x>.csv": [packs]}; lineagePacks() reads both.
 */
import fs from "node:fs";
import path from "node:path";
import { namesHint } from "../core/compact.js";
import { addStateCodes, alignCheck, CombineError, deflate, fiscalYear, toFiscal } from "./combine.js";
import { compare, compile, evaluate, ExprError, inspect, isTruthy, parse as parseExpr, type Ctx, type Node } from "./expr.js";
import { pyRepr } from "./pyfmt.js";
import { replicateColumns, replicateSe } from "./replicate.js";
import { cellText, csvGrid, headerOf, newRow, PARQUET_MAX_CELLS, parquetColumns, ParquetInputError, readParquetTable, sha256,
  tableCsv, tableFromGrid, type Row, type Table, type Value } from "./table.js";

export class ComputeError extends Error {}

export const LINEAGE = "exhibits/lineage.json";
export const PACK_ID = /^[a-z0-9][a-z0-9_-]*$/;
const INPUT_RE = /^((data\/[a-z0-9][a-z0-9_-]*\/[^/]+|exhibits\/[^/]+|published\/[^/]+)\.csv|data\/[a-z0-9][a-z0-9_-]*\/[^/]+\.parquet)$/;
const SAVE_RE = /^exhibits\/[A-Za-z0-9][A-Za-z0-9_.-]*\.csv$/;

export type Step = Record<string, any>;
export type Input = string | { path: string; columns?: string[] };
export type Pipeline = { inputs: Record<string, Input>; steps: Step[]; from?: string };
export type InputRecord = { path: string; sha256: string; columns?: string[] };
export type LineageEntry = { packs: string[]; tool: string; from?: string; inputs: Record<string, InputRecord>;
  steps: Step[]; sha256: string };

// ---------------------------------------------------------------------- paths and lineage
export function relPath(p: string): string {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

/** The absolute path of a workspace-relative CSV path, refusing anything outside data/, exhibits/ and published/. */
export function inputPath(workspace: string, rel: string): string {
  const r = relPath(rel);
  if (r.split("/").some((s) => s === ".." || s === "") || !INPUT_RE.test(r)) {
    throw new ComputeError(`input ${pyRepr(rel)}: a workspace path like data/<id>/<table>.csv, data/<id>/<table>.parquet, ` +
      "exhibits/<name>.csv or published/<name>.csv");
  }
  const abs = path.resolve(workspace, r);
  if (path.relative(workspace, abs).startsWith("..")) throw new ComputeError(`input ${pyRepr(rel)} is outside the workspace`);
  return abs;
}

/** An input as {path, columns?}: a path string, or an object naming the columns to read. */
export function normInput(alias: string, v: unknown): { path: string; columns?: string[] } {
  if (typeof v === "string") return { path: v };
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as any).path === "string") {
    const extra = Object.keys(v).filter((k) => k !== "path" && k !== "columns");
    if (extra.length) throw new ComputeError(`input ${alias}: unknown key(s) ${pyRepr(extra)}; an input is a path or {path, columns}`);
    const cols = (v as any).columns;
    if (cols === undefined || cols === null) return { path: (v as any).path };
    if (!Array.isArray(cols) || !cols.length || !cols.every((c) => typeof c === "string")) {
      throw new ComputeError(`input ${alias}: columns is a non-empty list of column names`);
    }
    return { path: (v as any).path, columns: [...new Set(cols as string[])] };
  }
  throw new ComputeError(`input ${alias}: a workspace path, or {path, columns: [names]}, not ${pyRepr(v)}`);
}

/** The Parquet copy fetch writes beside a large data/<id>/<table>.csv, when it is there and not older than the CSV. */
function parquetCopy(csvAbs: string): string | null {
  if (!/[\\/]data[\\/][^\\/]+[\\/][^\\/]+\.csv$/i.test(csvAbs)) return null;
  const pq = csvAbs.replace(/\.csv$/i, ".parquet");
  try {
    return fs.statSync(pq).mtimeMs >= fs.statSync(csvAbs).mtimeMs ? pq : null;
  } catch {
    return null;
  }
}

/** An input's column names, read before the table (the header line of a CSV, the schema of a Parquet file). */
function inputHeader(alias: string, rel: string, abs: string, buf: Buffer, parquet: boolean): string[] {
  if (parquet) {
    try {
      return parquetColumns(buf, abs);
    } catch (e: any) {
      throw new ComputeError(`input ${alias}: ${relPath(rel)} could not be read as Parquet: ${e?.message || e}`);
    }
  }
  return headerOf(buf.subarray(0, Math.min(buf.length, 1 << 20)).toString("utf8").replace(/^\uFEFF/, ""));
}

/** The most cells of a CSV parsed at once (every column of every row, before any column is dropped). A 37 MB ACS PUMS
 * file of 62,777 rows x 175 columns (11M cells) took 1.5 s and about 360 MB to parse; 60M is about 2 GB. */
export const CSV_MAX_RAW_CELLS = { value: 60_000_000 };

/** Parsed CSV grids kept across calls, keyed by path and content hash: compute and the rerun read the same large
 * microdata file again and again. Only files of at least CACHE_MIN_BYTES; at most the budget in total (about ten
 * times the file size each), least recently used dropped first. */
const GRID_CACHE = new Map<string, { grid: string[][]; bytes: number }>();
const CACHE_MIN_BYTES = 5_000_000;
function cacheBudget(): number {
  const mb = Number(process.env.DATA_ANALYST_PARSE_CACHE_MB);
  return (Number.isFinite(mb) && mb >= 0 ? mb : 512) * 1024 * 1024;
}

function cachedGrid(abs: string, sha: string, buf: Buffer): string[][] {
  const key = `${abs}\u0000${sha}`;
  const hit = GRID_CACHE.get(key);
  if (hit) {
    GRID_CACHE.delete(key);                             // most recently used last
    GRID_CACHE.set(key, hit);
    return hit.grid;
  }
  const grid = csvGrid(buf.toString("utf8"));
  const bytes = buf.length * 10;
  const budget = cacheBudget();
  if (buf.length >= CACHE_MIN_BYTES && bytes <= budget) {
    let used = [...GRID_CACHE.values()].reduce((a, v) => a + v.bytes, 0);
    for (const [k, v] of GRID_CACHE) {
      if (used + bytes <= budget) break;
      GRID_CACHE.delete(k);
      used -= v.bytes;
    }
    GRID_CACHE.set(key, { grid, bytes });
  }
  return grid;
}

/** Drop every cached grid (tests). */
export function clearParseCache(): void {
  GRID_CACHE.clear();
}

/** How many parsed grids are cached (tests). */
export function parseCacheSize(): number {
  return GRID_CACHE.size;
}

/** Line ends in a buffer (an upper bound on a CSV's rows, for the cell caps). */
function lineEnds(buf: Buffer): number {
  let n = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
  return n;
}

/** Read one input as a typed table (only its named columns, when given). */
function readInput(alias: string, abs: string, inp: { path: string; columns?: string[] }, buf: Buffer, sha: string,
  header: string[]): Table {
  if (relPath(inp.path).endsWith(".parquet")) {
    try {
      return readParquetTable(buf, abs, inp.columns);
    } catch (e: any) {
      if (e instanceof ParquetInputError) throw new ComputeError(`input ${alias} (${relPath(inp.path)}): ${e.message}`);
      throw new ComputeError(`input ${alias}: ${relPath(inp.path)} could not be read as Parquet: ${e?.message || e}`);
    }
  }
  const want = inp.columns;
  if (!GRID_CACHE.has(`${abs}\u0000${sha}`)) {
    const rows = lineEnds(buf);
    const raw = rows * header.length, typed = rows * (want ? want.length : header.length);
    if (raw > CSV_MAX_RAW_CELLS.value || typed > PARQUET_MAX_CELLS.value) {
      const n = (x: number) => x.toLocaleString("en-US");
      throw new ComputeError(`input ${alias}: ${relPath(inp.path)} has about ${n(rows)} rows x ${n(header.length)} columns, ` +
        `more than compute reads at once (${n(CSV_MAX_RAW_CELLS.value)} cells parsed, ${n(PARQUET_MAX_CELLS.value)} kept). ` +
        (raw > CSV_MAX_RAW_CELLS.value
          ? "Read the .parquet file beside it when the fetch wrote one ({path, columns}), or fetch fewer rows or variables."
          : `Name only the columns the steps need: {"${alias}": {"path": "${relPath(inp.path)}", "columns": [...]}}.`));
    }
  }
  return tableFromGrid(header, cachedGrid(abs, sha, buf), want);
}

/** The input columns a single-input recipe reads, when its steps say so: every column the steps name up to the first
 * step that keeps only named columns (select, rollup, replicate_se with estimates, pivot_wider with id_cols). Null when
 * any step could read columns it does not name (dedupe: true, other tables, ...) or no step narrows the table, so
 * every column reaches the output: then the whole table is read. */
export function neededColumns(p: Pipeline, header: string[]): string[] | null {
  try {
    const need = new Set<string>();
    const add = (c: unknown) => { if (typeof c === "string") need.add(c); };
    const ref = (src: unknown) => { for (const c of inspect(parseExpr(src)).cols) need.add(c); };
    const done = () => {
      const out = header.filter((c) => need.has(c));
      return out.length && out.length < header.length ? out : null;
    };
    for (const step of p.steps || []) {
      const verbs = Object.keys(step || {}).filter((k) => VERBS.includes(k));
      if (verbs.length !== 1) return null;
      const verb = verbs[0], arg = (step as any)[verb];
      if ((step as any).groupby !== undefined) strList((step as any).groupby, "groupby").forEach(add);
      switch (verb) {
        case "filter": ref(arg); break;
        case "derive": for (const [, e] of exprs(arg, "derive")) ref(e); break;
        case "rename": for (const [a] of exprs(arg, "rename")) add(a); break;
        case "orderby": strList(arg, "orderby").forEach((c) => add(c.replace(/^-/, ""))); break;
        case "slice": break;
        case "dedupe": if (arg === true) return null; strList(arg, "dedupe").forEach(add); break;
        case "fiscal_year": add(typeof arg === "string" ? arg : arg?.date); break;
        case "state_codes": add(typeof arg === "string" ? arg : arg?.col); break;
        case "select": strList(arg, "select").forEach(add); return done();
        case "rollup": for (const [, e] of exprs(arg, "rollup")) ref(e); return done();
        case "replicate_se": {
          if (!arg || typeof arg !== "object" || !arg.estimates || typeof arg.estimates !== "object") return null;
          add(arg.weight);
          replicateColumns(arg.replicates).forEach(add);
          for (const e of Object.values(arg.estimates)) ref(e);
          for (const e of Object.values(arg.also || {})) ref(e);
          return done();
        }
        case "pivot_wider":
          if (!arg?.id_cols) return null;
          strList(arg.id_cols, "id_cols").forEach(add);
          add(arg.names_from);
          add(arg.values_from);
          return done();
        default:
          return null;                                  // other tables, value-dependent columns
      }
    }
    return null;
  } catch {
    return null;                                        // a malformed step: the full read reports it
  }
}

export function readLineage(workspace: string): Record<string, any> {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(workspace, LINEAGE), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** The source packs of a lineage entry (the Python list form or compute's object form). */
export function lineagePacks(entry: unknown): string[] {
  if (Array.isArray(entry)) return entry.map(String);
  if (entry && typeof entry === "object" && Array.isArray((entry as any).packs)) return (entry as any).packs.map(String);
  return [];
}

export function writeLineage(workspace: string, lin: Record<string, unknown>): void {
  const sorted = Object.fromEntries(Object.keys(lin).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, lin[k]]));
  fs.mkdirSync(path.join(workspace, "exhibits"), { recursive: true });
  fs.writeFileSync(path.join(workspace, LINEAGE), JSON.stringify(sorted, null, 2) + "\n");
}

/** Validated pack ids, deduplicated in order (facts.py _packs). */
export function packList(x: unknown): string[] {
  if (x === null || x === undefined || x === "" || (Array.isArray(x) && !x.length)) return [];
  const vals = typeof x === "string" ? [x] : Array.isArray(x) ? x : [x];
  const bad = vals.filter((v) => !PACK_ID.test(String(v)));
  if (bad.length) throw new ComputeError(`source pack ids look like 'bls' or 'treasury_yields', not ${pyRepr(bad)}`);
  return [...new Set(vals.map(String))];
}

// ---------------------------------------------------------------------- verbs
const VERBS = ["filter", "derive", "select", "rename", "rollup", "join", "pivot_wider", "pivot_longer", "orderby", "slice",
  "dedupe", "concat", "fiscal_year", "to_fiscal", "state_codes", "deflate", "align_check", "replicate_se", "as", "from"];
const EXTRA: Record<string, string[]> = { filter: ["groupby"], derive: ["groupby"], rollup: ["groupby"], replicate_se: ["groupby"],
  join: ["on", "how", "suffix"] };

export function need(t: Table, cols: string[], what: string): void {
  const miss = cols.filter((c) => !t.cols.includes(c));
  if (miss.length) throw new ComputeError(`${what}: no column${miss.length > 1 ? "s" : ""} ${miss.join(", ")}; ${namesHint(miss, t.cols, "columns", pyRepr)}`);
}

export function strList(v: unknown, what: string): string[] {
  const xs = typeof v === "string" ? [v] : v;
  if (!Array.isArray(xs) || !xs.every((x) => typeof x === "string")) throw new ComputeError(`${what}: a column name or a list of names`);
  return xs as string[];
}

const keyOf = (r: Row, on: string[]) => on.map((k) => (r[k] === null ? "\u0001null" : cellText(r[k]))).join("\u0000");

/** Groups of row indexes by key, in the order pandas groupby gives (sorted by the keys; gaps last). */
export function groupRows(t: Table, by: string[], sorted: boolean): Row[][] {
  if (!by.length) return [t.rows];
  const m = new Map<string, Row[]>();
  for (const r of t.rows) {
    const k = keyOf(r, by);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  const gs = [...m.values()];
  if (sorted) gs.sort((a, b) => {
    for (const k of by) {
      const c = compare(a[0][k], b[0][k]);
      if (c) return c;
    }
    return 0;
  });
  return gs;
}

function exprs(v: unknown, what: string): [string, unknown][] {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ComputeError(`${what}: an object {new_column: "expression"}`);
  const out = Object.entries(v as object);
  if (!out.length) throw new ComputeError(`${what}: give at least one {name: expression}`);
  return out;
}

/** Row lists this pipeline made itself and nothing else holds: derive may add columns to their rows in place instead
 * of copying every row (an input table, a parse-cache entry or an "as" table is never in it). */
const OWNED = new WeakSet<Row[]>();

function derive(t: Table, spec: unknown, by: string[]): Table {
  let cols = [...t.cols];
  const rows = OWNED.has(t.rows) ? t.rows : t.rows.map((r) => Object.assign(newRow(), r));
  OWNED.add(rows);
  for (const [name, src] of exprs(spec, "derive")) {
    const node = compile(src, cols, { what: "derive" });
    for (const g of groupRows({ cols, rows }, by, false)) {
      const ctx: Ctx = { i: 0, group: g, cache: new Map() }; // moved row by row: evaluate keeps no reference to it
      const vals = g.map((r, i) => ((ctx.row = r), (ctx.i = i), evaluate(node, ctx)));
      g.forEach((r, i) => (r[name] = vals[i]));
    }
    if (!cols.includes(name)) cols = [...cols, name];
  }
  return { cols, rows };
}

function filter(t: Table, src: unknown, by: string[]): Table {
  const node = compile(src, t.cols, { what: "filter" });
  const keep = new Set<Row>();
  for (const g of groupRows(t, by, false)) {
    const cache = new Map<Node, unknown>();
    g.forEach((r, i) => {
      if (isTruthy(evaluate(node, { row: r, i, group: g, cache }))) keep.add(r);
    });
  }
  return { cols: t.cols, rows: t.rows.filter((r) => keep.has(r)) };
}

function rollup(t: Table, spec: unknown, by: string[]): Table {
  const items = exprs(spec, "rollup").map(([name, src]) => [name, compile(src, t.cols, { what: "rollup", win: false })] as const);
  const keys = new Set(by);
  const rows: Row[] = [];
  for (const g of groupRows(t, by, true)) {
    if (!g.length && by.length) continue;
    const o = newRow();
    for (const k of by) o[k] = g[0][k];
    const cache = new Map<Node, unknown>();
    for (const [name, node] of items) o[name] = evaluate(node, { i: 0, group: g, keys, cache });
    rows.push(o);
  }
  const names = items.map(([n]) => n);
  return { cols: [...by, ...names.filter((n) => !by.includes(n))], rows };
}

function join(t: Table, right: Table, step: Step): { table: Table; notes: string[] } {
  const how = step.how ?? "inner";
  if (how !== "inner" && how !== "left") throw new ComputeError(`join: how is "inner" or "left", not ${pyRepr(how)}`);
  let lk: string[], rk: string[];
  if (step.on && typeof step.on === "object" && !Array.isArray(step.on)) {
    lk = Object.keys(step.on);
    rk = Object.values(step.on).map(String);
  } else {
    lk = rk = strList(step.on, "join on");
  }
  if (!lk.length) throw new ComputeError("join: on names the key columns");
  need(t, lk, "join (left table)");
  need(right, rk, "join (right table)");
  const [sx, sy] = Array.isArray(step.suffix) && step.suffix.length === 2 ? step.suffix.map(String) : ["_x", "_y"];
  const sameKeys = lk.every((k, i) => k === rk[i]);
  const rOther = right.cols.filter((c) => !(sameKeys && rk.includes(c)));
  const lName = new Map<string, string>(), rName = new Map<string, string>();
  for (const c of t.cols) lName.set(c, rOther.includes(c) && !(sameKeys && lk.includes(c)) ? c + sx : c);
  for (const c of rOther) rName.set(c, t.cols.includes(c) && !(sameKeys && lk.includes(c)) ? c + sy : c);
  const index = new Map<string, Row[]>();
  for (const r of right.rows) {
    if (rk.some((k) => r[k] === null)) continue;
    const k = keyOf(r, rk);
    if (!index.has(k)) index.set(k, []);
    index.get(k)!.push(r);
  }
  const notes: string[] = [];
  const repeated = [...index.values()].filter((g) => g.length > 1).length;
  if (repeated) notes.push(`join: ${repeated} key value(s) repeat in the right table, so their rows are multiplied (align_check refuses this)`);
  const rows: Row[] = [];
  let unmatched = 0;
  for (const l of t.rows) {
    const hits = lk.some((k) => l[k] === null) ? [] : index.get(keyOf(l, lk)) || [];
    if (!hits.length) {
      unmatched++;
      if (how === "left") {
        const o = newRow();
        for (const c of t.cols) o[lName.get(c)!] = l[c];
        for (const c of rOther) o[rName.get(c)!] = null;
        rows.push(o);
      }
      continue;
    }
    for (const r of hits) {
      const o = newRow();
      for (const c of t.cols) o[lName.get(c)!] = l[c];
      for (const c of rOther) o[rName.get(c)!] = r[c];
      rows.push(o);
    }
  }
  if (unmatched) notes.push(`join: ${unmatched} left row(s) found no match` + (how === "inner" ? " and were dropped" : " (their right columns are empty)"));
  return { table: { cols: [...t.cols.map((c) => lName.get(c)!), ...rOther.map((c) => rName.get(c)!)], rows }, notes };
}

function pivotWider(t: Table, spec: any): Table {
  if (!spec || typeof spec !== "object") throw new ComputeError("pivot_wider: {names_from, values_from, id_cols?, fill?}");
  const namesFrom = String(spec.names_from ?? "");
  const valuesFrom = strList(spec.values_from, "pivot_wider values_from");
  need(t, [namesFrom, ...valuesFrom], "pivot_wider");
  const ids = spec.id_cols ? strList(spec.id_cols, "pivot_wider id_cols") : t.cols.filter((c) => c !== namesFrom && !valuesFrom.includes(c));
  need(t, ids, "pivot_wider id_cols");
  const fill: Value = spec.fill ?? null;
  const names: string[] = [];
  const out = new Map<string, Row>();
  const seen = new Set<string>();
  for (const r of t.rows) {
    const nm = cellText(r[namesFrom]);
    if (!names.includes(nm)) names.push(nm);
    const k = keyOf(r, ids);
    if (seen.has(k + "\u0002" + nm)) {
      throw new ComputeError(`pivot_wider: several rows for ${pyRepr(Object.fromEntries(ids.map((c) => [c, cellText(r[c])])))} and ` +
        `${namesFrom} = ${pyRepr(nm)}: aggregate (rollup) or filter to one row each first`);
    }
    seen.add(k + "\u0002" + nm);
    if (!out.has(k)) {
      const o = newRow();
      for (const c of ids) o[c] = r[c];
      out.set(k, o);
    }
    for (const v of valuesFrom) out.get(k)![valuesFrom.length > 1 ? `${v}_${nm}` : nm] = r[v];
  }
  const newCols = valuesFrom.length > 1 ? valuesFrom.flatMap((v) => names.map((n) => `${v}_${n}`)) : names;
  const clash = newCols.filter((c) => ids.includes(c));
  if (clash.length) throw new ComputeError(`pivot_wider: new columns ${pyRepr(clash)} clash with id columns; rename first`);
  const rows = [...out.values()];
  for (const r of rows) for (const c of newCols) if (!Object.hasOwn(r, c)) r[c] = fill;
  return { cols: [...ids, ...newCols], rows };
}

function pivotLonger(t: Table, spec: any): Table {
  if (!spec || typeof spec !== "object") throw new ComputeError("pivot_longer: {cols, names_to?, values_to?}");
  const cols = strList(spec.cols, "pivot_longer cols");
  need(t, cols, "pivot_longer");
  const namesTo = String(spec.names_to ?? "name"), valuesTo = String(spec.values_to ?? "value");
  const keep = t.cols.filter((c) => !cols.includes(c));
  if (keep.includes(namesTo) || keep.includes(valuesTo)) throw new ComputeError(`pivot_longer: ${namesTo} or ${valuesTo} is already a column`);
  const rows: Row[] = [];
  for (const r of t.rows) {
    for (const c of cols) {
      const o = newRow();
      for (const k of keep) o[k] = r[k];
      o[namesTo] = c;
      o[valuesTo] = r[c];
      rows.push(o);
    }
  }
  return { cols: [...keep, namesTo, valuesTo], rows };
}

function orderby(t: Table, spec: unknown): Table {
  const items = strList(spec, "orderby").map((s) => (s.startsWith("-") ? { c: s.slice(1), d: -1 } : { c: s, d: 1 }));
  need(t, items.map((x) => x.c), "orderby");
  const rows = t.rows.map((r, i) => ({ r, i })).sort((a, b) => {
    for (const { c, d } of items) {
      const x = a.r[c], y = b.r[c];
      if (x === null || y === null) {
        if (x !== y) return x === null ? 1 : -1;                       // gaps last, either direction
        continue;
      }
      const k = compare(x, y) * d;
      if (k) return k;
    }
    return a.i - b.i;
  }).map((x) => x.r);
  return { cols: t.cols, rows };
}

function slice(t: Table, spec: any): Table {
  let start: number | undefined, end: number | undefined;
  if (typeof spec === "number") end = spec;
  else if (Array.isArray(spec)) [start, end] = spec;
  else if (spec && typeof spec === "object") ({ start, end } = spec);
  else throw new ComputeError("slice: a row count (the first n), [start, end] or {start, end} (0-based, end excluded, negatives count from the end)");
  for (const v of [start, end]) if (v !== undefined && v !== null && !Number.isInteger(v)) throw new ComputeError("slice: start and end are whole numbers");
  return { cols: t.cols, rows: t.rows.slice(start ?? 0, end ?? undefined) };
}

function dedupe(t: Table, spec: unknown): Table {
  const by = spec === true || (Array.isArray(spec) && !spec.length) ? t.cols : strList(spec, "dedupe");
  need(t, by, "dedupe");
  const seen = new Set<string>();
  return { cols: t.cols, rows: t.rows.filter((r) => {
    const k = keyOf(r, by);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }) };
}

function concat(tables: Table[]): Table {
  const cols: string[] = [];
  for (const t of tables) for (const c of t.cols) if (!cols.includes(c)) cols.push(c);
  const rows = tables.flatMap((t) => t.rows.map((r) => {
    const o = newRow();
    for (const c of cols) o[c] = Object.hasOwn(r, c) ? r[c] : null;
    return o;
  }));
  return { cols, rows };
}

// ---------------------------------------------------------------------- the pipeline
function wrap<T>(i: number, verb: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ExprError || e instanceof CombineError || e instanceof ComputeError) {
      throw new ComputeError(`step ${i + 1} (${verb}): ${e.message}`);
    }
    throw e;
  }
}

export type PipelineResult = { table: Table; notes: string[]; inputs: Record<string, InputRecord> };

/** Read the inputs and run the steps (no file is written). `parsed` keeps each input read once across calls (the
 * rerun replays many recipes over one large microdata file); it is keyed by path, content hash and columns, and is
 * safe to share because no step changes its input table in place (every verb builds new rows). */
export function runPipeline(workspace: string, p: Pipeline, parsed?: Map<string, Table>): PipelineResult {
  if (!p.inputs || typeof p.inputs !== "object" || !Object.keys(p.inputs).length) {
    throw new ComputeError('inputs: {alias: "data/<id>/<table>.csv" | "data/<id>/<table>.parquet" | "exhibits/<x>.csv" | ' +
      "{path, columns}}, at least one");
  }
  const inputs: PipelineResult["inputs"] = {};
  type Prepared = { alias: string; inp: { path: string; columns?: string[] }; abs: string; buf: Buffer; sha: string;
    header: string[]; parquet: boolean };
  const prepared: Prepared[] = [];
  for (const [alias, raw] of Object.entries(p.inputs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) || alias === "this" || alias.startsWith("__")) throw new ComputeError(`input alias ${pyRepr(alias)}: letters, digits and _ only`);
    const inp = normInput(alias, raw);
    const rel = inp.path;
    const abs = inputPath(workspace, rel);
    if (!fs.existsSync(abs)) throw new ComputeError(`input ${alias}: no file ${relPath(rel)} in the workspace (fetch it first, or check the path)`);
    const buf = fs.readFileSync(abs);
    const sha = sha256(buf);
    inputs[alias] = { path: relPath(rel), sha256: sha, ...(inp.columns ? { columns: inp.columns } : {}) };
    const parquet = relPath(rel).endsWith(".parquet");
    prepared.push({ alias, inp, abs, buf, sha, parquet, header: inputHeader(alias, rel, abs, buf, parquet) });
  }
  for (const x of prepared) {
    const miss = (x.inp.columns || []).filter((c) => !x.header.includes(c));
    if (!miss.length) continue;
    const what = `no column${miss.length > 1 ? "s" : ""} ${miss.join(", ")}`;
    throw new ComputeError(x.parquet   // the messages the readers give (the Parquet one names the file)
      ? `input ${x.alias} (${relPath(x.inp.path)}): ${what}; ${namesHint(miss, x.header, "columns", (v) => (v as string[]).join(", "))}`
      : `input ${x.alias}: ${what}; ${namesHint(miss, x.header, "columns", pyRepr)}`);
  }
  // a dry run of the steps on empty tables with the inputs' headers: a misspelt column fails here, before a large
  // file is parsed (only what the data cannot change is reported; data-dependent steps end the dry run)
  runSteps(p, new Map(prepared.map((x) => [x.alias, { cols: x.inp.columns ?? x.header, rows: [] }])), true);
  // one input and no columns named: read only the columns the steps use, when the steps say which those are
  const auto = prepared.length === 1 && !prepared[0].inp.columns ? neededColumns(p, prepared[0].header) : null;
  const env = new Map<string, Table>();
  for (const x of prepared) {
    const want = x.inp.columns ?? auto ?? undefined;
    const key = `${x.abs}\u0000${x.sha}\u0000${want ? JSON.stringify(want) : ""}`;
    let t = parsed?.get(key);
    if (!t) {
      // only some columns of a fetched CSV that has a Parquet copy: decode those columns from the copy (same table)
      const pq = want && !x.parquet ? parquetCopy(x.abs) : null;
      t = pq ? readInput(x.alias, pq, { path: relPath(x.inp.path).replace(/\.csv$/, ".parquet"), columns: want },
        fs.readFileSync(pq), x.sha, x.header)
        : readInput(x.alias, x.abs, { path: x.inp.path, columns: want }, x.buf, x.sha, x.header);
      parsed?.set(key, t);
    }
    env.set(x.alias, t);
  }
  const r = runSteps(p, env, false);
  return { table: r.table, notes: r.notes, inputs };
}

/** Verbs whose result depends on the data's values (new columns from values, lookups, checks): a dry run stops there. */
const DRY_STOP = new Set(["pivot_wider", "pivot_longer", "to_fiscal", "deflate", "replicate_se", "align_check"]);
/** Errors a dry run reports: a column or table that does not exist. */
const STRUCTURAL = /unknown column|no column|is not a table here|is not an input alias/;

/** Run the steps over the tables in env (`dry`: on empty tables, as a check before the inputs are read). */
function runSteps(p: Pipeline, env: Map<string, Table>, dry: boolean): { table: Table; notes: string[] } {
  const start = p.from ?? Object.keys(p.inputs)[0];
  if (!env.has(start)) throw new ComputeError(`from: ${pyRepr(start)} is not an input alias (${Object.keys(p.inputs).join(", ")})`);
  let cur = env.get(start)!;
  const notes: string[] = [];
  const table = (name: unknown, what: string): Table => {
    if (name === "this") return cur;
    if (typeof name !== "string" || !env.has(name)) {
      throw new ComputeError(`${what}: ${pyRepr(name)} is not a table here (inputs and "as" names: ${[...env.keys()].join(", ")})`);
    }
    return env.get(name)!;
  };
  if (!Array.isArray(p.steps)) throw new ComputeError("steps: a list of steps");
  for (let i = 0; i < p.steps.length; i++) {
    const step = p.steps[i];
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new ComputeError(`step ${i + 1}: an object such as {"filter": "year >= 2020"}`);
    const verbs = Object.keys(step).filter((k) => VERBS.includes(k));
    if (verbs.length !== 1) {
      throw new ComputeError(`step ${i + 1}: name exactly one verb (${VERBS.join(", ")}); got ${pyRepr(Object.keys(step))}` +
        (Object.keys(step).includes("groupby") ? ' (groupby goes with rollup, derive, filter or replicate_se in the same step: {"groupby": [...], "rollup": {...}})' : ""));
    }
    const verb = verbs[0];
    const extra = Object.keys(step).filter((k) => k !== verb && !(EXTRA[verb] || []).includes(k));
    if (extra.length) throw new ComputeError(`step ${i + 1} (${verb}): unknown key(s) ${pyRepr(extra)}; allowed with ${verb}: ${pyRepr(EXTRA[verb] || [])}`);
    const arg = step[verb];
    if (dry && DRY_STOP.has(verb)) break;
    const before = cur.rows;
    try {
    wrap(i, verb, () => {
      const by = step.groupby === undefined ? [] : strList(step.groupby, "groupby");
      if (by.length) need(cur, by, "groupby");
      switch (verb) {
        case "filter":
          cur = filter(cur, arg, by);
          break;
        case "derive":
          cur = derive(cur, arg, by);
          break;
        case "rollup":
          cur = rollup(cur, arg, by);
          break;
        case "select": {
          const cols = strList(arg, "select");
          need(cur, cols, "select");
          cur = { cols: [...new Set(cols)], rows: cur.rows };
          break;
        }
        case "rename": {
          const pairs = exprs(arg, "rename").map(([a, b]) => [a, String(b)] as const);
          need(cur, pairs.map(([a]) => a), "rename");
          const map = new Map(pairs);
          const cols = cur.cols.map((c) => map.get(c) ?? c);
          const dup = cols.filter((c, j) => cols.indexOf(c) !== j);
          if (dup.length) throw new ComputeError(`rename: ${pyRepr([...new Set(dup)])} would name two columns`);
          cur = { cols, rows: cur.rows.map((r) => {
            const o = newRow();
            cur.cols.forEach((c, j) => (o[cols[j]] = r[c]));
            return o;
          }) };
          break;
        }
        case "join": {
          const r = join(cur, table(arg, "join"), step);
          cur = r.table;
          notes.push(...r.notes);
          break;
        }
        case "pivot_wider":
          cur = pivotWider(cur, arg);
          break;
        case "pivot_longer":
          cur = pivotLonger(cur, arg);
          break;
        case "orderby":
          cur = orderby(cur, arg);
          break;
        case "slice":
          cur = slice(cur, arg);
          break;
        case "dedupe":
          cur = dedupe(cur, arg);
          break;
        case "concat":
          cur = concat([cur, ...(Array.isArray(arg) ? arg : [arg]).map((a) => table(a, "concat"))]);
          break;
        case "fiscal_year": {
          const o = typeof arg === "string" ? { date: arg } : arg || {};
          const as = String(o.as ?? "fiscal_year");
          need(cur, [String(o.date)], "fiscal_year");
          cur = { cols: cur.cols.includes(as) ? cur.cols : [...cur.cols, as], rows: cur.rows.map((r) => {
            const x = Object.assign(newRow(), r);
            x[as] = r[o.date] === null ? null : fiscalYear(r[o.date], o.date);
            return x;
          }) };
          break;
        }
        case "to_fiscal": {
          const o = arg || {};
          const r = toFiscal(cur, String(o.date), String(o.value), o.how ?? "sum", o.freq ?? "M");
          cur = r.table;
          notes.push(...r.notes);
          break;
        }
        case "state_codes":
          cur = addStateCodes(cur, typeof arg === "string" ? arg : String(arg?.col));
          break;
        case "deflate": {
          const o = arg || {};
          if (!o.name || typeof o.name !== "string") {
            throw new ComputeError('deflate: name the price index and its source in "name" (e.g. "CPI-U, BLS CUUR0000SA0"), so the ' +
              "answer can say which dollars these are");
          }
          const value = String(o.value), period = String(o.period);
          need(cur, [value, period], "deflate");
          const idx = table(o.index, "deflate index");
          const ip = String(o.index_period ?? period), iv = String(o.index_value ?? "");
          need(idx, [ip, iv], "deflate index");
          const m = new Map<string, number>();
          for (const r of idx.rows) {
            const k = cellText(r[ip]);
            if (m.has(k)) throw new ComputeError(`deflate: the index repeats period ${pyRepr(k)}: one row per period`);
            const v = r[iv];
            if (typeof v !== "number") throw new ComputeError(`deflate: index ${iv} = ${pyRepr(v)} at ${pyRepr(k)} is not a number`);
            m.set(k, v);
          }
          const base = o.base === undefined ? null : o.base;
          const out = deflate(cur.rows.map((r) => ({ period: r[period], value: r[value] })), m, base);
          const as = String(o.as ?? `${value}_real`);
          cur = { cols: cur.cols.includes(as) ? cur.cols : [...cur.cols, as], rows: cur.rows.map((r, j) => {
            const x = Object.assign(newRow(), r);
            x[as] = out[j];
            return x;
          }) };
          notes.push(`deflate: ${as} = ${value} in ${base === null ? "the index's own base (used as given)" : `${cellText(base)} dollars`}, ` +
            `deflated by ${o.name}`);
          break;
        }
        case "replicate_se": {
          const r = replicateSe(cur, arg, by);
          cur = r.table;
          notes.push(...r.notes);
          break;
        }
        case "align_check": {
          const o = arg || {};
          const names = strList(o.tables, "align_check tables");
          const frames = Object.fromEntries(names.map((n) => [n, table(n, "align_check")]));
          notes.push(...alignCheck(frames, strList(o.on, "align_check on"), o.units && typeof o.units === "object" ? o.units : {}));
          break;
        }
        case "as":
          if (typeof arg !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg) || arg === "this") throw new ComputeError("as: a table name (letters, digits, _)");
          env.set(arg, cur);
          break;
        case "from":
          cur = table(arg, "from");
          break;
      }
    });
    // these keep a subset of the same rows: a list derive owned stays owned (the old list is no longer used)
    if (OWNED.has(before) && ["filter", "select", "orderby", "slice", "dedupe"].includes(verb)) OWNED.add(cur.rows);
    // a table kept under a name may be read again: its rows are shared from now on
    if (verb === "as") OWNED.delete(cur.rows);
    } catch (e) {
      // the dry run reports only what the data cannot change: a column or table that does not exist
      if (!dry || (e instanceof ComputeError && STRUCTURAL.test(e.message))) throw e;
      break;
    }
  }
  return { table: cur, notes };
}


/** The packs an exhibit's inputs come from: data/<id>/ is <id>; an exhibit carries its lineage; published/ none. */
export function inferPacks(workspace: string, inputs: Record<string, { path: string }>): string[] {
  const lin = readLineage(workspace);
  const out: string[] = [];
  for (const { path: rel } of Object.values(inputs)) {
    const m = /^data\/([^/]+)\//.exec(rel);
    const got = m ? [m[1]] : rel.startsWith("exhibits/") ? lineagePacks(lin[rel]) : [];
    for (const p of got) if (!out.includes(p)) out.push(p);
  }
  return out;
}

export type ComputeArgs = Pipeline & { save_as: string; packs?: string[]; preview?: number };

/** Run the steps, save the exhibit and record its lineage. */
export function compute(workspace: string, a: ComputeArgs) {
  const save = relPath(a.save_as);
  if (!SAVE_RE.test(save) || save === LINEAGE) throw new ComputeError(`save_as ${pyRepr(a.save_as)}: exhibits/<name>.csv (letters, digits, _ . -)`);
  if (Object.entries(a.inputs || {}).some(([k, r]) => relPath(normInput(k, r).path) === save)) {
    throw new ComputeError(`save_as ${save} is also an input: save to a new name, so the exhibit can be replayed from its inputs`);
  }
  const r = runPipeline(workspace, a);
  const text = tableCsv(r.table);
  const abs = path.join(workspace, save);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  const packs = a.packs !== undefined && a.packs !== null ? packList(a.packs) : inferPacks(workspace, r.inputs);
  const entry: LineageEntry = { packs, tool: "compute", ...(a.from ? { from: a.from } : {}), inputs: r.inputs, steps: a.steps,
    sha256: sha256(text) };
  const lin = readLineage(workspace);
  lin[save] = entry;
  writeLineage(workspace, lin);
  const n = Math.max(0, Math.min(Number(a.preview ?? 20), 50));
  const pv = previewRows(r.table, n);
  return {
    file: abs, rel: save, rows: r.table.rows.length, columns: r.table.cols,
    preview: pv.rows, ...(pv.note ? { preview_note: pv.note } : {}),
    notes: r.notes, packs,
  };
}

/** Preview limits: the file has every value exactly; the preview is for reading, so it is narrow and short. */
export const PREVIEW_MAX_COLS = 20;
export const PREVIEW_MAX_CHARS = 4000;

/** A number as the preview shows it: 6 significant digits for a fraction (integers and text as written). */
function previewCell(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v)) return String(Number(v.toPrecision(6)));
  return cellText(v as Value);
}

/** The first n rows, at most PREVIEW_MAX_COLS columns and about PREVIEW_MAX_CHARS characters, with a note on any cut. */
export function previewRows(t: Table, n: number): { rows: Record<string, string>[]; note?: string } {
  const cols = t.cols.slice(0, PREVIEW_MAX_COLS);
  const rows: Record<string, string>[] = [];
  let size = 0;
  for (const row of t.rows.slice(0, n)) {
    const o = Object.fromEntries(cols.map((c) => [c, previewCell(row[c])]));
    size += JSON.stringify(o).length;
    if (rows.length && size > PREVIEW_MAX_CHARS) break;
    rows.push(o);
  }
  const cut: string[] = [];
  if (cols.length < t.cols.length) cut.push(`the first ${cols.length} of ${t.cols.length} columns`);
  if (rows.length < Math.min(n, t.rows.length)) cut.push(`${rows.length} rows (size limit)`);
  return { rows, ...(cut.length ? { note: `preview shows ${cut.join(" and ")}; fractions rounded to 6 digits; the file has every value exactly` } : {}) };
}
