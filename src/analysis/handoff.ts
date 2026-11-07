/**
 * The data hand-off: what each source delivered, read back from its provenance files (a port of the Python
 * skill's scripts/core/handoff.py).
 *
 * For every <workspace>/data/<id>/ (request.json; Treasury's fetch_spec.json) and <workspace>/published/*.csv it
 * lists the files with row counts, the route and retrieval date, the fetch notes and problems, and a short
 * preview of each table, and writes the same as ready-to-send Markdown ("text"). Everything comes from the files
 * written at fetch time, so the hand-off cannot drift from what was downloaded.
 */
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import { localDay, readJson } from "../core/policy.js";
import { readCsv } from "../core/tabular.js";
import { fixed } from "./pyfmt.js";
import { readCsvGrid } from "./table.js";

export const PREVIEW_ROWS = 4;
export const PREVIEW_COLS = 8;
export const CELL = 40;
export const MAX_TABLES = 6;
export const PROVENANCE = ["request.json", "fetch_spec.json"];
export const MAX_NOTES = 6;
export const CAVEAT = new RegExp("missing|may be|upper bound|withheld|suppress|fewer|stopped at|partial|incomplete|not in|" +
  "no rows|twice|restored|skipped|without --check|not fetched|not reported|dropped|lag", "i");

const comma = (n: number) => fixed(n, 0);
const posix = (p: string) => p.split(path.sep).join("/");

function cell(v: unknown): string {
  const s = String(v ?? "").split(/\s+/).filter(Boolean).join(" ").replace(/\|/g, "/");
  return s.length <= CELL ? s : s.slice(0, CELL - 3) + "...";
}

export type Preview = { header: string[]; rows: string[][]; same: [string, string][]; hidden: number; total: number; columns: number };

/** The first n rows of a CSV, showing the columns that vary (a column with one value in the first `sample` rows is
 * listed once under "same", so values are not crowded out by labels). */
export function preview(file: string, n = PREVIEW_ROWS, sample = 200): Preview {
  const grid = readCsvGrid(fs.readFileSync(file, "utf8"));
  const head = grid[0] || [];
  const rows: string[][] = [];
  let total = 0;
  for (const row of grid.slice(1)) {
    total++;
    if (rows.length < sample) rows.push([...row, ...Array(Math.max(0, head.length - row.length)).fill("")]);
  }
  const vary = head.map((_, i) => i).filter((i) => new Set(rows.map((r) => r[i])).size > 1);
  const show = (vary.length ? vary : head.map((_, i) => i)).slice(0, PREVIEW_COLS);
  const same: [string, string][] = head.map((h, i) => [h, i] as const)
    .filter(([, i]) => !vary.includes(i) && rows.length && rows[0][i] !== "").map(([h, i]) => [h, rows[0][i]]);
  return { header: show.map((i) => head[i]), rows: rows.slice(0, n).map((r) => show.map((i) => r[i])), same: same.slice(0, 6),
    hidden: head.length - show.length - same.slice(0, 6).length, total, columns: head.length };
}

function tableMd(pv: Preview): string[] {
  if (!pv.header.length) return ["(empty file)"];
  const out = ["| " + pv.header.map(cell).join(" | ") + " |", "|" + "---|".repeat(pv.header.length)];
  out.push(...pv.rows.map((r) => "| " + r.map(cell).join(" | ") + " |"));
  if (pv.same.length) out.push(`Same in the first ${comma(Math.min(pv.total, 200))} rows: ` + pv.same.map(([k, v]) => `${k} = ${cell(v)}`).join("; "));
  if (pv.hidden > 0) out.push(`(${pv.hidden} more columns: see the data dictionary)`);
  return out;
}

function provenance(d: string): [any, string] {
  for (const name of PROVENANCE) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) {
      try {
        return [JSON.parse(fs.readFileSync(p, "utf8")) || {}, name];
      } catch {
        return [{}, name];
      }
    }
  }
  return [{}, ""];
}

function redistribution(source: string): string {
  try {
    return readJson(path.join(PACKS_DIR, source), "policy.json")?.redistribution?.mode || "allowed";
  } catch {
    return "allowed";                                  // a folder that is no pack: treat as shareable data
  }
}

export type FileSummary = { file: string; rows?: number | null; columns?: number; preview?: Preview | null; earlier?: string };
export type SourceSummary = { source: string; route: string; retrieved: string; files: FileSummary[]; notes: string[];
  problems: string[]; readme: string | null; microdata: boolean; provenance: boolean; provenance_file: string };

export function sourceSummary(out: string, d: string): SourceSummary {
  const sid = path.basename(d);
  const [rec, recFile] = provenance(d);
  const tables: any[] = (Array.isArray(rec.tables) ? rec.tables : []).filter((t: any) => t && typeof t === "object" && t.file);
  // an earlier fetch into the same folder whose tables are still there: they are part of what was delivered
  const earlier: any[] = (Array.isArray(rec.earlier_fetches) ? rec.earlier_fetches : []).filter((e: any) => e && typeof e === "object");
  const listed = new Set(tables.map((t) => t.file));
  for (const e of earlier) {
    for (const t of e.tables || []) {
      if (t && typeof t === "object" && t.file && !listed.has(t.file) && fs.existsSync(path.join(d, t.file))) {
        tables.push({ ...t, earlier: `route ${e.route || e.acquired || "unknown"}, retrieved ` + (e.retrieved ? localDay(e.retrieved) : "unknown") });
        listed.add(t.file);
      }
    }
  }
  if (!tables.length) {                                  // no list in the record: every CSV in the folder
    for (const f of fs.readdirSync(d).filter((x) => x.toLowerCase().endsWith(".csv") && x !== "data_dictionary.csv").sort()) {
      tables.push({ file: f });
    }
  }
  const mode = redistribution(sid);
  const micro = mode === "definition_only" || mode === "aggregates_only";
  const files: FileSummary[] = [];
  for (const t of tables) {
    const p = path.join(d, t.file);
    const tag = t.earlier ? { earlier: t.earlier as string } : {};
    const rel = posix(path.relative(out, p));
    if (!fs.existsSync(p) || !p.toLowerCase().endsWith(".csv")) {
      files.push({ file: rel, rows: t.rows ?? null, ...tag });
      continue;
    }
    const pv = preview(p);
    files.push({ file: rel, rows: pv.total, columns: pv.columns, preview: micro ? null : pv, ...tag });
  }
  const retrieved = rec.retrieved || rec.downloaded || "";
  const notes = (rec.notes || []).filter(Boolean).map(String);
  const problems = (rec.problems || []).filter(Boolean).map(String);
  for (const e of earlier) for (const n of e.notes || []) if (n) notes.push(`(earlier fetch, table still in the folder) ${n}`);
  for (const e of earlier) for (const p of e.problems || []) if (p) problems.push(`(earlier fetch, table still in the folder) ${p}`);
  return { source: sid, route: rec.route || rec.acquired || "unknown", retrieved: retrieved ? localDay(retrieved) : "unknown",
    files, notes, problems, readme: fs.existsSync(path.join(d, "README.md")) ? posix(path.relative(out, path.join(d, "README.md"))) : null,
    microdata: micro, provenance: Object.keys(rec).length > 0, provenance_file: recFile };
}

export type PublishedSummary = { source: "published"; route: string; files: { file: string; rows: number; source_url: string[];
  accessed: string[]; preview: Preview }[] };

export function publishedSummary(out: string): PublishedSummary | null {
  const dir = path.join(out, "published");
  if (!fs.existsSync(dir)) return null;
  const paths = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv")).sort().map((f) => path.join(dir, f));
  if (!paths.length) return null;
  const files = paths.map((p) => {
    const pv = preview(p);
    const urls = new Set<string>(), dates = new Set<string>();
    for (const r of readCsv(fs.readFileSync(p, "utf8"))) {
      urls.add(String(r.source_url ?? ""));
      dates.add(String(r.accessed ?? ""));
    }
    const sorted = (s: Set<string>) => [...s].filter(Boolean).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { file: posix(path.relative(out, p)), rows: pv.total, source_url: sorted(urls), accessed: sorted(dates), preview: pv };
  });
  return { source: "published", route: "read from the agency's page", files };
}

/** Every caveat note and the first MAX_NOTES others; the rest are counted with where to read them. */
function notesMd(s: SourceSummary): string[] {
  const shown: string[] = [], rest: string[] = [];
  let others = 0;
  for (const n of s.notes) {
    const caveat = CAVEAT.test(n);
    (caveat || others < MAX_NOTES ? shown : rest).push(n);
    if (!caveat) others++;
  }
  const md = shown.map((n) => `- Note: ${n}`);
  if (rest.length) md.push(`- (+${rest.length} more notes in data/${s.source}/${s.provenance_file || "request.json"})`);
  return md;
}

export function summarize(workspace: string) {
  const out = path.resolve(workspace);
  const dataDir = path.join(out, "data");
  const dirs = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter((x) => fs.statSync(path.join(dataDir, x)).isDirectory()).sort().map((x) => path.join(dataDir, x)) : [];
  const sources = dirs.map((d) => sourceSummary(out, d));
  const pub = publishedSummary(out);
  const md: string[] = [];
  for (const s of sources) {
    md.push(`### ${s.source}`, `- Route: ${s.route}; retrieved ${s.retrieved}` +
      (s.provenance ? "" : " (no request.json: not packaged by fetch; fetch it again or ingest it)"));
    for (const f of s.files) {
      md.push((typeof f.rows === "number" ? `- \`${f.file}\`: ${comma(f.rows)} rows` : `- \`${f.file}\``) +
        (f.earlier ? ` (earlier fetch: ${f.earlier})` : ""));
    }
    md.push(...notesMd(s), ...s.problems.map((p) => `- **Problem**: ${p}`));
    const pv = s.files.filter((f) => f.preview);
    for (const f of pv.slice(0, MAX_TABLES)) {
      md.push("", `\`${f.file}\` (first ${f.preview!.rows.length} rows):`, "", ...tableMd(f.preview!));
    }
    if (s.microdata) md.push("- Microdata: no preview (the terms keep it in the analysis folder); see the data dictionary");
    if (pv.length > MAX_TABLES) md.push(`- (${pv.length - MAX_TABLES} more tables: listed above, no preview here)`);
    md.push("");
  }
  if (pub) {
    md.push("### Figures read from agency pages (`published/`)");
    for (const f of pub.files) {
      md.push(`- \`${f.file}\`: ${comma(f.rows)} rows; source ${f.source_url.join(", ") || "MISSING source_url"}; ` +
        `accessed ${f.accessed.join(", ") || "MISSING accessed"}`);
    }
    md.push("");
  }
  const missing = sources.filter((s) => !s.provenance).map((s) => s.source);
  return {
    status: "ok" as const, out, sources: [...sources, ...(pub ? [pub] : [])], unpackaged: missing, text: md.join("\n").trim(),
    action: "Send `text` as the per-source part of the hand-off (it is read from the files fetched), then add each source's " +
      "caveats from its README and any data that could not be fetched, with the route to get it." +
      (missing.length ? ` Folders without provenance: ${missing.join(", ")}.` : ""),
  };
}
