/**
 * Write a source's data package: <out>/data/<source>/.
 *
 *   <name>.csv          one file per request, values exactly as published (missing values left empty)
 *   data_dictionary.csv table, column, inferred type, non-missing count, example
 *   raw/                responses as received (credential-free), when an adapter passes them
 *   request.json        spec, fingerprint, route, retrieval time, every request made (the call's trail);
 *                       "earlier_fetches" keeps the record of an earlier spec whose tables are still there
 *   README.md           what is here, the citation, notices, terms, redistribution and retention rules
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SourceRecord } from "./context.js";
import * as keys from "./keys.js";
import type { Pack, Row, Spec } from "./packs.js";
import * as pol from "./policy.js";
import { pyStr, stableJson } from "./py.js";
import { parse as parseCsv } from "csv-parse/sync";
import { writeParquet } from "./parquet.js";
import { columnsOf, readCsv, writeCsv } from "./tabular.js";

const LABEL_ONLY = new Set(["description", "label", "labels", "notes", "source_note"]);

export function dataDir(out: string, source: string): string {
  return path.join(path.resolve(out), "data", source);
}

export function fingerprint(spec: unknown): string {
  const strip = (x: any): any => {
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.keys(x).sort().filter((k) => !LABEL_ONLY.has(k) && !k.startsWith("_")).map((k) => [k, strip(x[k])]));
    }
    return x;
  };
  return createHash("sha256").update(stableJson(strip(spec))).digest("hex").slice(0, 16);
}

export type Existing = { path: string; matches: boolean; complete: boolean; retrieved: string; age_days: number | null;
  route: string; problems: string[] };

export function existing(out: string, source: string, spec: Spec): Existing | null {
  const rq = path.join(dataDir(out, source), "request.json");
  if (!fs.existsSync(rq)) return null;
  let saved: any;
  try {
    saved = JSON.parse(fs.readFileSync(rq, "utf8"));
  } catch {
    return null;
  }
  const files = (saved.tables || []).map((t: any) => path.join(dataDir(out, source), t.file));
  const t = Date.parse(saved.retrieved || "");
  return { path: dataDir(out, source), matches: saved.fingerprint === fingerprint(spec),
    complete: files.length > 0 && files.every((f: string) => fs.existsSync(f)), retrieved: saved.retrieved || "",
    age_days: Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null, route: saved.route,
    problems: saved.problems || [] };
}

function infer(vals: unknown[]): string {
  const v = vals.filter((x) => x !== "" && x !== null && x !== undefined).map(pyStr);
  if (!v.length) return "empty";
  if (v.every((x) => x.trim() !== "" && Number.isFinite(Number(x.replaceAll(",", ""))))) return "number";
  if (v.every((x) => /^(?:1[6-9]|20|21)\d\d-(?:0[1-9]|1[0-2])(?:-\d\d)?(?:[T ]|$)/.test(x))) return "date";
  return "text";
}

/**
 * A table already written to a CSV file (header row first), for microdata too large to hold as rows: an adapter
 * streams the rows to `path` (a temporary file outside the package) and returns this in place of a list of rows;
 * write() moves the file into data/<source>/ and builds the dictionary from `sample` and `nonMissing`.
 */
export class FileTable {
  constructor(public path: string, public columns: string[], public rows: number, public sample: Row[] = [],
    public nonMissing: Record<string, number> = {}) {}
  get length(): number {
    return this.rows;
  }
  discard(): void {
    fs.rmSync(this.path, { force: true });
  }
}

export type Table = Row[] | FileTable;

function rowsAndCols(table: Table): [Row[], string[]] {
  if (table instanceof FileTable) return [table.sample, table.columns];
  // a JS object lists integer-like keys ("1940", "2024") first, where Python keeps insertion order: a table can
  // carry its column order as `columns` (withColumns); any key it does not name follows, in first-seen order
  const cols: string[] = [...(columnsOf(table) || [])];
  const seen = new Set<string>(cols);
  for (const r of table) for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), cols.push(k));
  return [table, cols];
}

// the column-order mark lives in tabular.ts, so file readers can set it too
export { columnsOf, withColumns } from "./tabular.js";

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
const pad = (n: number) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const SCRUB_MAX = 1 << 30;

/**
 * Every file under dir with a known key (in any form) rewritten with [REDACTED] in its place: an agency that echoes
 * the key in a response must not leave it in the workspace (the model reads it, the user downloads it). Returns the
 * changed files, relative to dir. Files over 1 GB are left as they are.
 */
export function scrubDir(dir: string): string[] {
  const changed: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && scrubFile(f)) changed.push(path.relative(dir, f).replaceAll("\\", "/"));
    }
  };
  walk(dir);
  return changed.sort();
}

const SCRUBBED = new Set<string>();

/** One file scrubbed in place; true when it held a key (remembered for takeScrubbed). */
export function scrubFile(f: string): boolean {
  if (!fs.existsSync(f) || fs.statSync(f).size > SCRUB_MAX) return false;
  const [buf, hit] = keys.scrubBytes(fs.readFileSync(f));
  if (hit) {
    fs.writeFileSync(f, buf);
    SCRUBBED.add(path.resolve(f));
  }
  return hit;
}

/** Scrub every file under dir, then the files under it scrubbed since the last call (relative to dir), cleared. */
export function takeScrubbed(dir: string): string[] {
  scrubDir(dir);
  const pre = path.resolve(dir) + path.sep;
  const got = [...SCRUBBED].filter((f) => f.startsWith(pre));
  for (const f of got) SCRUBBED.delete(f);
  return got.map((f) => f.slice(pre.length).replaceAll("\\", "/")).sort();
}

export const scrubNote = (files: string[]) => `A key the agency echoed in its response was replaced with [REDACTED] in ` +
  `${files.join(", ")}: those files differ from the published bytes there.`;

export type TableMeta = { name: string; file: string; rows: number; columns: string[]; sha256: string; parquet?: string };

/** A microdata CSV at least this large also gets a Parquet copy beside it, so compute can decode only the columns a
 * recipe needs (the CSV stays the file of record: its checksum is in request.json). */
export const PARQUET_BESIDE_MIN_BYTES = { value: 5_000_000 };

/** The same table as `<name>.parquet`: every column as text, an empty cell as a gap (compute types it as the CSV). */
export function parquetBeside(csvPath: string): string | null {
  const grid = parseCsv(fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, ""),
    { relax_column_count: true, relax_quotes: true, skip_empty_lines: true }) as string[][];
  const head = grid[0] || [];
  if (!head.length || new Set(head).size !== head.length) return null;     // a repeated name has no Parquet form
  const n = grid.length - 1;
  const cols = head.map((name, j) => {
    const values: (string | null)[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = grid[i + 1];
      values[i] = j < r.length && r[j] !== "" ? r[j] : null;
    }
    return { name, kind: "string" as const, values };
  });
  const out = csvPath.replace(/\.csv$/i, ".parquet");
  writeParquet(out, cols, n, "data-analyst-mcp");
  return out;
}
export type WriteResult = { data_dir: string; tables: TableMeta[]; retrieved: string; citation: string };

export function write(out: string, pack: Pack, tables: Record<string, Table>, spec: Spec, o: {
  route: string; acquired?: string; requests?: SourceRecord[]; raw?: Record<string, Buffer>; notes?: string[];
  problems?: string[]; vintage?: string; extraReadme?: string;
}): WriteResult {
  const P = pack.policy;
  const d = dataDir(out, pack.id);
  fs.mkdirSync(d, { recursive: true });
  const retrieved = nowIso();
  const metaTables: TableMeta[] = [];
  let dictionary: Row[] = [];
  const endpoint = Object.fromEntries((spec?.requests || []).map((r) => [r.name, r.endpoint]));
  const shape: Record<string, string[]> = {};
  for (const [name, t] of Object.entries(tables)) {
    const [, cols] = rowsAndCols(t);
    if (cols.length) shape[String(endpoint[name])] ??= cols;
  }
  for (const [name, t] of Object.entries(tables)) {
    let [rows, cols] = rowsAndCols(t);
    if (!cols.length) cols = shape[String(endpoint[name])] || ["no_rows"];
    const file = `${name}.csv`;
    if (t instanceof FileTable) {
      fs.copyFileSync(t.path, path.join(d, file));
      t.discard();
    } else fs.writeFileSync(path.join(d, file), writeCsv(rows, cols));
    scrubFile(path.join(d, file));                 // before the checksum: request.json then matches the file
    // a large microdata table also as Parquet (from the scrubbed CSV); a stale copy from an earlier fetch goes
    const pq = path.join(d, `${name}.parquet`);
    fs.rmSync(pq, { force: true });
    const parquet = t instanceof FileTable && fs.statSync(path.join(d, file)).size >= PARQUET_BESIDE_MIN_BYTES.value
      ? parquetBeside(path.join(d, file)) : null;
    for (const c of cols) {
      const nonmiss = rows.map((r) => r[c]).filter((v) => v !== "" && v !== null && v !== undefined);
      dictionary.push({ table: name, column: c, type: infer(nonmiss.slice(0, 500)),
        non_missing: t instanceof FileTable ? t.nonMissing[c] ?? nonmiss.length : nonmiss.length,
        example: nonmiss.length ? pyStr(nonmiss[0]).slice(0, 80) : "" });
    }
    metaTables.push({ name, file, rows: t instanceof FileTable ? t.rows : rows.length, columns: cols,
      sha256: sha256(path.join(d, file)), ...(parquet ? { parquet: path.basename(parquet) } : {}) });
  }
  const earlier = earlierFetches(d, new Set(metaTables.map((t) => t.file)));
  const kept = new Set(earlier.flatMap((e) => e.tables.map((t: any) => t.name)));
  const dictPath = path.join(d, "data_dictionary.csv");
  if (kept.size && fs.existsSync(dictPath)) {
    dictionary = dictionary.concat(readCsv(fs.readFileSync(dictPath, "utf8")).filter((r) => kept.has(String(r.table))));
  }
  if (dictionary.length) fs.writeFileSync(dictPath, writeCsv(dictionary, ["table", "column", "type", "non_missing", "example"]));
  if (o.raw) {
    fs.mkdirSync(path.join(d, "raw"), { recursive: true });
    for (const [rel, data] of Object.entries(o.raw)) {
      const f = path.join(d, "raw", path.basename(rel));
      fs.writeFileSync(f, data);
      scrubFile(f);
    }
  }
  const req = { source: pack.id, spec, fingerprint: fingerprint(spec), route: o.route, acquired: o.acquired ?? "api",
    retrieved, vintage: o.vintage ?? "", requests: o.requests || [], tables: metaTables, problems: o.problems || [],
    notes: o.notes || [], earlier_fetches: earlier,
    policy: { redistribution: P.redistribution.mode, cache: P.cache.mode } };
  fs.writeFileSync(path.join(d, "request.json"), JSON.stringify(req, (k, v) => (k.startsWith("_") ? undefined : v), 2));
  scrubFile(path.join(d, "request.json"));
  const cite = pol.citation(P, o.route, { retrieved: today(), vintage: o.vintage ?? "", dataset: spec?.description ?? "" });
  let extra = o.extraReadme ?? "";
  if (earlier.length) {
    const listed = earlier.map((e) => `- ${pol.localStamp(e.retrieved)} (${e.route}): ` + e.tables.map((t: any) => `\`${t.file}\``).join(", ") +
      "; spec and requests in request.json `earlier_fetches`" + (e.problems || []).map((p: string) => `\n  - **Problem**: ${p}`).join(""));
    extra = [extra, "## Earlier fetches into this folder\n\n" + listed.join("\n")].filter(Boolean).join("\n\n");
  }
  writeReadme(d, pack, metaTables, cite, retrieved, o.acquired ?? "api", o.notes || [], o.problems || [], extra);
  return { data_dir: d, tables: metaTables, retrieved, citation: cite };
}

/** The provenance of earlier fetches whose tables are still in the folder and not replaced now. */
export function earlierFetches(d: string, newFiles: Set<string>): any[] {
  let old: any;
  try {
    old = JSON.parse(fs.readFileSync(path.join(d, "request.json"), "utf8"));
  } catch {
    return [];
  }
  const out: any[] = [];
  let files = new Set(newFiles);
  for (const e of [...(old.earlier_fetches || []), old]) {
    const keep = (e.tables || []).filter((t: any) => !files.has(t.file) && fs.existsSync(path.join(d, t.file || "")));
    if (!keep.length) continue;
    const mine = keep.filter((t: any) => t.name).map((t: any) => `${t.name}:`);
    const pick = (k: string) => (e[k] || []).map(String).filter((n: string) => mine.some((m: string) => n.startsWith(m)));
    out.push({ spec: e.spec, fingerprint: e.fingerprint, route: e.route, acquired: e.acquired, retrieved: e.retrieved,
      vintage: e.vintage, requests: e.requests, tables: keep, problems: pick("problems"), notes: pick("notes") });
    files = new Set([...files, ...keep.map((t: any) => t.file)]);
  }
  return out;
}

function writeReadme(d: string, pack: Pack, tables: TableMeta[], cite: string, retrieved: string, acquired: string,
  notes: string[], problems: string[], extra: string): void {
  const P = pack.policy;
  const rd = P.redistribution;
  const lines = [`# ${P.title}: downloaded data`, "",
    `Retrieved ${pol.localStamp(retrieved)} by the \`${acquired}\` route. Values are exactly as published; missing values are ` +
    "empty cells. Column types and examples are in `data_dictionary.csv`; every request is in `request.json` (URLs without keys).",
    "", "## Files", "",
    ...tables.map((t) => `- \`${t.file}\`: ${t.rows.toLocaleString("en-US")} rows; columns ${t.columns.slice(0, 12).join(", ")}` +
      (t.columns.length > 12 ? " …" : "")),
    "", "## Citation", "", cite, ""];
  if (P.notices?.length) lines.push("## Required notices", "", ...P.notices.map((n) => `- ${n}`), "");
  lines.push("## Use and redistribution", "", `Rule: **${rd.mode}**. ${rd.why || ""}`);
  if (rd.mode === "definition_only") {
    lines.push("", "These files must not be shared, attached to a report or put in a replication package. Share the request " +
      "definition and the reproduce scripts instead; anyone rerunning the work downloads the data under their own account.");
  }
  if (P.retention) lines.push("", `Retention: ${P.retention.note || ""}`);
  if (P.terms_url) lines.push("", `Terms: ${P.terms_url}`);
  if (notes.length) lines.push("", "## Notes", "", ...notes.map((n) => `- ${n}`));
  if (problems.length) lines.push("", "## Problems", "", ...problems.map((p) => `- ${p}`));
  if (extra) lines.push("", extra);
  fs.writeFileSync(path.join(d, "README.md"), lines.join("\n") + "\n");
}
