/**
 * The registry of every number cited in an answer or report: a port of scripts/analysis/facts.py.
 * Written to <workspace>/facts.json (same schema); the report builder fills {{name}} / {{name|fmt}} placeholders
 * from it and the audit traces each value to its cell.
 *
 * A table fact is read from the saved CSV (`table`: exhibits/<x>.csv, data/<id>/<t>.csv or published/<x>.csv): the
 * registered value is the cell a reader finds there. A derived fact has a derivation; written as an expression
 * over fact names ("a / b - 1"), it is computed here (and a given value must agree), so a rerun recomputes it;
 * a prose derivation needs the value. NaN values and empty cells (gaps in the data) are refused.
 *
 * Each record holds label, fmt, value, source (the CSV path), where, column, derivation, se, the flags
 * preliminary / vintage / projection (the audit requires the prose to state them) and headline (needs a
 * benchmark.csv row), plus pack (the source pack(s): the pack argument; else the call's default; else the folder
 * when the CSV lies under data/<id>/; else the exhibit's lineage; else the only data/<id>/ folder) and text (the
 * value as the prose prints it, mode "answer").
 */
import fs from "node:fs";
import path from "node:path";
import { pyStr } from "../core/py.js";
import { readCsv } from "../core/tabular.js";
import { inspect, parse, evaluate, ExprError, type Node } from "./expr.js";
import { lineagePacks, packList, PACK_ID, readLineage, relPath, ComputeError } from "./compute.js";
import { formatValue } from "./factfmt.js";
import { fixed, pyFloat, pyRepr } from "./pyfmt.js";
import { headerOf, newRow } from "./table.js";

export class FactError extends Error {}

export const FACTS_FILE = "facts.json";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type TableFact = { name: string; table: string; where: Record<string, unknown>; column: string; fmt?: string;
  label?: string; pack?: string | string[] | null; headline?: boolean; preliminary?: boolean; vintage?: string | null;
  projection?: boolean; se?: number | null };
export type DerivedFact = { name: string; value?: number | string | null; derivation: string; fmt?: string; label?: string;
  pack?: string | string[] | null; headline?: boolean; preliminary?: boolean; vintage?: string | null; projection?: boolean;
  se?: number | null };

export function readFacts(workspace: string): Record<string, any> {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(workspace, FACTS_FILE), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** The one cell of `column` in the row matching `where`, as [number, text]; refuses with facts.py's messages. */
export function readCell(csvText: string, source: string, where: Record<string, unknown>, column: string, name: string): [number, string] {
  const cols = headerOf(csvText);
  const base = path.basename(source);
  const missing = [column, ...Object.keys(where)].filter((c) => !cols.includes(c));
  if (missing.length) throw new FactError(`fact ${name}: ${pyRepr(missing)} not in the table; its columns are ${pyRepr(cols)}`);
  const rows = readCsv(csvText).filter((r) => Object.entries(where).every(([k, v]) => pyStr(r[k]) === pyStr(v)));
  if (rows.length !== 1) {
    throw new FactError(`fact ${name}: where=${pyRepr(where)} matches ${rows.length} rows of ${base} (need exactly 1; the CSV's ` +
      "own text must equal each value, e.g. 2026 vs 2026.0)");
  }
  const text = String(rows[0][column] ?? "").trim();
  if (!text || /^[+-]?nan$/i.test(text)) throw new FactError(`fact ${name}: the cell is empty (a gap or a flagged value); do not cite it`);
  if (!FLOAT.test(text)) throw new FactError(`fact ${name}: ${column} = ${pyRepr(text)} in ${base} is not a number`);
  return [Number(text), text];
}

/** Is a value stored exactly one digit past what its format prints, ending in 5 ("21.55" printed as "21.6")? */
export function roundingTie(cell: number, text: string, fmt: string): boolean {
  try {
    const shown = /-?\d[\d,]*(?:\.(\d+))?/.exec(formatValue(cell, fmt));
    if (!shown || !cell || !text.includes(".")) return false;
    const disp = Number(shown[0].replace(/,/g, ""));
    const k = disp ? Math.round(Math.log10(Math.abs(disp / cell))) : 0;
    return text.split(".")[1].trimEnd().length - k === (shown[1] || "").length + 1 && text.trimEnd().endsWith("5");
  } catch {
    return false;
  }
}

function tieNote(name: string, cell: number, text: string, fmt: string): string | null {
  if (!roundingTie(cell, text, fmt)) return null;
  return `note: fact ${name}: ${text} in the CSV sits on a rounding tie for its format: store full precision (no round() ` +
    'before saving), or, when the value is exact at that precision (published so), list it in decisions.json "rounding_ties_ok" ' +
    "with why; the answer audit fails otherwise";
}

export function dataPacks(workspace: string): string[] {
  const d = path.join(workspace, "data");
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((x) => fs.statSync(path.join(d, x)).isDirectory() && PACK_ID.test(x)).sort();
}

function packsOf(x: unknown): string[] {
  try {
    return packList(x);
  } catch (e) {
    if (e instanceof ComputeError) throw new FactError(e.message);
    throw e;
  }
}

function inferPack(workspace: string, name: string, explicit: unknown, dflt: string[], source?: string): string[] {
  const given = explicit !== undefined && explicit !== null;
  if (given && explicit !== "" && !packsOf(explicit).length) return [];          // pack: []: no pack, not the default
  const rel = relPath(source || "");
  if (!(given && packsOf(explicit).length) && rel.startsWith("published/")) return [];
  const got = given ? packsOf(explicit) : [];
  if (got.length) return got;
  if (dflt.length) return dflt;
  if (source) {
    const m = /^data\/([^/]+)\//.exec(rel);
    if (m) return [m[1]];
    const lin = lineagePacks(readLineage(workspace)[rel]);
    if (lin.length) return packsOf(lin);
  }
  const present = dataPacks(workspace);
  if (present.length === 1) return present;
  if (!present.length) return [];
  throw new FactError(`fact ${name}: the workspace holds data from ${pyRepr(present)}; say which source pack the number comes ` +
    "from: pack: '<id>' (or a list), the call's pack default, or save the exhibit with compute's packs");
}

/** Units slips facts.py refuses (a value already scaled, a share given to pct, points given to pp ...). */
function unitChecks(name: string, v: unknown, fmt: string): void {
  const parts = (fmt || "").split(":");
  const kind = parts.find((k) => ["usd_m", "usd_b", "usd_t", "dollars_m", "dollars_b", "dollars_t"].includes(k)) || "";
  const scaled = ["from_thousands", "from_millions", "from_billions"].some((p) => (fmt || "").includes(p));
  if (typeof v !== "number") return;
  if (kind && !scaled && v !== 0 && Math.abs(v) < 1e6) {
    const word = { m: "million", b: "billion", t: "trillion" }[kind.slice(-1) as "m" | "b" | "t"];
    throw new FactError(`fact ${name}: ${fmt} expects a value in dollars, but ${pyFloat(v)} looks already scaled (it would ` +
      `print as $0.0 ${word}). Use usd_${kind.slice(-1)}_scaled for a value already in ${word}s of dollars, or a from_millions: / ` +
      "from_billions: prefix.");
  }
  if (parts.includes("pct") && Math.abs(v) > 5) {
    throw new FactError(`fact ${name}: fmt pct takes a share (0.274 = 27.4 percent); ${pyFloat(v)} would print as ` +
      `${fixed(v * 100, 0)} percent: a value already in percent takes pct100`);
  }
  if (parts[0] === "pp" && Math.abs(v) > 1) {
    throw new FactError(`fact ${name}: fmt pp takes a difference of shares (0.026 = 2.6 points); ${pyFloat(v)} is already ` +
      "in points: use pp100");
  }
  if (fmt && v !== 0) {
    let shown = "";
    try {
      shown = formatValue(v, fmt);
    } catch {
      shown = "";
    }
    const digits = shown.split(" ")[0].replace(/[^\d]/g, "");
    if ((shown.startsWith("$") || shown.startsWith("-$")) && digits && /^0+$/.test(digits) && !parts[parts.length - 1].includes("-")) {
      throw new FactError(`fact ${name}: ${pyFloat(v)} prints as ${pyRepr(shown)} with fmt ${pyRepr(fmt)}: the value or the format ` +
        "is in the wrong units (millions given to usd_b?); a real amount that small needs more digits (usd_b:2) or a smaller scale (usd_m)");
    }
    if (/[\d,]{8,}(\.\d+)? (?:million|billion|trillion)/.test(shown)) {
      throw new FactError(`fact ${name}: ${pyFloat(v)} prints as ${pyRepr(shown)} with fmt ${pyRepr(fmt)}: a value already in dollars ` +
        "given to a *_scaled or from_* format? Check the units.");
    }
  }
}

/** A derivation written as an expression over fact names, parsed; null when it is prose. */
export function derivationExpr(derivation: string, known: (n: string) => boolean): Node | null {
  let n: Node;
  try {
    n = parse(derivation);
  } catch {
    return null;
  }
  let info;
  try {
    info = inspect(n);
  } catch {
    return null;
  }
  if (info.agg || info.win || !info.cols.length || !info.cols.every(known)) return null;
  return n;
}

/** The value of a derivation expression from fact values (numbers only). */
export function evalDerivation(n: Node, values: (name: string) => unknown, name: string): number | string | boolean | null {
  const row = newRow();
  for (const c of inspect(n).cols) {
    const v = values(c);
    if (typeof v !== "number") throw new FactError(`fact ${name}: its derivation uses ${c}, whose value ${pyRepr(v)} is not a number`);
    row[c] = v;
  }
  try {
    return evaluate(n, { row, i: 0, group: [row], cache: new Map() });
  } catch (e) {
    if (e instanceof ExprError) throw new FactError(`fact ${name}: derivation: ${e.message}`);
    throw e;
  }
}

function common(rec: Record<string, any>, f: { se?: number | null; preliminary?: boolean; vintage?: string | null;
  projection?: boolean; headline?: boolean }, derivation?: string): void {
  if (f.se !== undefined && f.se !== null) rec.se = Number(f.se);
  if (derivation) rec.derivation = derivation;
  if (f.preliminary) rec.preliminary = true;
  if (f.vintage && f.vintage !== "latest") rec.vintage = String(f.vintage);
  if (f.projection) rec.projection = true;
  if (f.headline) rec.headline = true;
}

function checkName(name: string, fmt: string): void {
  if (!NAME_RE.test(String(name))) throw new FactError(`fact name ${pyRepr(name)}: letters, digits and _ only`);
  try {
    formatValue(1.0, fmt);                       // an unknown format fails here, not in the report build
  } catch (e: any) {
    throw new FactError(e.message);
  }
}

/** Register a table fact: the value is the CSV cell. Returns the record and any note. */
export function tableFact(workspace: string, f: TableFact, dflt: string[] = []): { rec: Record<string, any>; note: string | null } {
  const fmt = f.fmt ?? "raw";
  checkName(f.name, fmt);
  if (!f.table || !f.where || typeof f.where !== "object" || !f.column) {
    throw new FactError(`fact ${f.name}: table facts need table (the CSV path), where and column`);
  }
  const source = relPath(f.table);
  if (!/^(data\/[^/]+\/|exhibits\/|published\/)[^/]+\.csv$/.test(source) || source.split("/").includes("..")) {
    throw new FactError(`fact ${f.name}: table ${pyRepr(f.table)}: a workspace CSV (exhibits/<x>.csv, data/<id>/<t>.csv or published/<x>.csv)`);
  }
  const abs = path.join(workspace, source);
  if (!fs.existsSync(abs)) throw new FactError(`fact ${f.name}: save ${source} before registering facts from it`);
  const [cell, text] = readCell(fs.readFileSync(abs, "utf8"), source, f.where, f.column, f.name);
  const rec: Record<string, any> = { label: f.label ?? "", fmt, value: cell, source,
    where: Object.fromEntries(Object.entries(f.where).map(([k, v]) => [k, pyStr(v)])), column: f.column };
  unitChecks(f.name, cell, fmt);
  common(rec, f);
  const packs = inferPack(workspace, f.name, f.pack, dflt, source);
  if (packs.length) rec.pack = packs.length === 1 ? packs[0] : packs;
  return { rec, note: tieNote(f.name, cell, text, fmt) };
}

/** Register a derived fact; `known` gives the values of facts registered so far. */
export function derivedFact(workspace: string, f: DerivedFact, known: Record<string, any>, dflt: string[] = []): Record<string, any> {
  const fmt = f.fmt ?? "raw";
  checkName(f.name, fmt);
  const derivation = String(f.derivation ?? "");
  const node = derivation ? derivationExpr(derivation, (n) => Object.hasOwn(known, n) && n !== f.name) : null;
  let value: unknown = f.value;
  if (node) {
    const got = evalDerivation(node, (n) => known[n]?.value, f.name);
    if (got === null) throw new FactError(`fact ${f.name}: its derivation ${derivation} gives no value (a gap or a division by zero); do not cite it`);
    if (value !== undefined && value !== null) {
      const a = Number(value), b = Number(got);
      if (typeof got !== "number" || !(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)))) {
        throw new FactError(`fact ${f.name}: value ${pyRepr(value)} differs from its derivation ${derivation} = ${pyRepr(got)}; ` +
          "leave value out and the derivation is computed");
      }
    }
    value = got;
  }
  if (value === undefined || value === null || !derivation) {
    throw new FactError(`fact ${f.name}: give table/where/column, or value with derivation (a derivation written as an ` +
      'expression over fact names, e.g. "a / b - 1", is computed for you)');
  }
  if (typeof value === "number" && Number.isNaN(value)) throw new FactError(`fact ${f.name}: value is NaN (a gap in the data); do not cite it`);
  const rec: Record<string, any> = { label: f.label ?? "", fmt, value, derivation };
  unitChecks(f.name, value, fmt);
  common(rec, f, derivation);
  const packs = inferPack(workspace, f.name, f.pack, dflt);
  if (packs.length) rec.pack = packs.length === 1 ? packs[0] : packs;
  return rec;
}

/** facts.json with "text" (the value as the prose prints it) on every numeric fact. */
export function saveFacts(workspace: string, items: Record<string, any>): string {
  for (const rec of Object.values(items)) {
    if (typeof rec?.value === "number") {
      try {
        rec.text = formatValue(rec.value, rec.fmt ?? "raw", "answer");
      } catch {
        /* an unformattable value keeps no text */
      }
    }
  }
  const p = path.join(workspace, FACTS_FILE);
  fs.writeFileSync(p, JSON.stringify(items, null, 2));
  return p;
}

export type FactsArgs = { add?: TableFact[]; derived?: DerivedFact[]; remove?: string[]; pack?: string | string[] };

/** Add (or replace) facts and save facts.json. Nothing is written when any fact is refused. */
export function registerFacts(workspace: string, a: FactsArgs): { file: string; added: Record<string, any>; notes: string[];
  names: string[] } {
  const items = readFacts(workspace);
  for (const n of a.remove || []) delete items[n];
  const dflt = packsOf(a.pack);
  const added: Record<string, any> = {};
  const notes: string[] = [];
  const errors: string[] = [];
  for (const f of a.add || []) {
    try {
      const { rec, note } = tableFact(workspace, f, dflt);
      items[f.name] = added[f.name] = rec;
      if (note) notes.push(note);
    } catch (e) {
      if (e instanceof FactError) errors.push(e.message);
      else throw e;
    }
  }
  for (const f of a.derived || []) {
    try {
      const rec = derivedFact(workspace, f, items, dflt);
      items[f.name] = added[f.name] = rec;
    } catch (e) {
      if (e instanceof FactError) errors.push(e.message);
      else throw e;
    }
  }
  if (errors.length) {
    const err = new FactError(errors[0]);
    (err as any).problems = errors;
    throw err;
  }
  for (const rec of Object.values(added)) {
    if (typeof rec.value !== "number") continue;
    try {
      formatValue(rec.value, rec.fmt, "answer", (m) => notes.push(`fact ${Object.keys(added).find((k) => added[k] === rec)}: ${m}`));
    } catch {
      /* checked when registered */
    }
  }
  const file = saveFacts(workspace, items);
  for (const k of Object.keys(added)) added[k] = items[k];
  return { file, added, notes, names: Object.keys(items) };
}
