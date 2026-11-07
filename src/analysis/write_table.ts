/**
 * write_table: the method tables the audits require, which are not computed from fetched data:
 *   exhibits/benchmark.csv    each headline compared with the agency's published figure
 *   exhibits/sensitivity.csv  each judgment call's alternative, with both headlines (registered facts)
 *   published/<name>.csv      a figure only an agency page publishes, as the page shows it (source_url, accessed)
 * Every other exhibit comes from compute (its steps are replayed by rerun). A table written here is recorded in
 * exhibits/lineage.json with its hash (tool "write_table"), so rerun can tell it was not edited afterwards.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeCsv } from "../core/tabular.js";
import { readLineage, writeLineage } from "./compute.js";

export class WriteTableError extends Error {}

const REQUIRED: Record<string, string[]> = {
  "exhibits/benchmark.csv": ["measure", "period", "computed", "published", "source", "url", "accessed", "match"],
  "exhibits/sensitivity.csv": ["parameter", "base", "alternative", "headline_base", "headline_alt", "conclusion_changes"],
};

export function writeTable(workspace: string, a: { path: string; columns: string[]; rows: (string | number | null)[][] }) {
  const rel = a.path.replaceAll("\\", "/").replace(/^\.\//, "");
  const published = /^published\/[A-Za-z0-9_-]+\.csv$/.test(rel);
  if (!REQUIRED[rel] && !published) {
    throw new WriteTableError(`write_table writes only exhibits/benchmark.csv, exhibits/sensitivity.csv or published/<name>.csv ` +
      `(not ${rel}); data exhibits come from compute, so rerun can replay them`);
  }
  const cols = a.columns.map(String);
  if (new Set(cols).size !== cols.length) throw new WriteTableError("column names must be unique");
  const need = published ? ["source_url", "accessed"] : REQUIRED[rel];
  const missing = need.filter((c) => !cols.includes(c));
  if (missing.length) throw new WriteTableError(`${rel} needs the columns ${need.join(", ")} (missing: ${missing.join(", ")})`);
  const bad = a.rows.findIndex((r) => r.length !== cols.length);
  if (bad >= 0) throw new WriteTableError(`row ${bad + 1} has ${a.rows[bad].length} cells, not ${cols.length}`);
  const rows = a.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""])));
  if (published) {
    rows.forEach((r, i) => {
      if (!/^https?:\/\//.test(String(r.source_url))) throw new WriteTableError(`row ${i + 1}: source_url must be the page's URL`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.accessed))) throw new WriteTableError(`row ${i + 1}: accessed must be YYYY-MM-DD`);
    });
  }
  const text = writeCsv(rows, cols);
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  if (!published) {
    const lin = readLineage(workspace);
    lin[rel] = { packs: [], tool: "write_table", sha256: createHash("sha256").update(text).digest("hex") };
    writeLineage(workspace, lin);
  }
  return { status: "ok", path: abs, rows: rows.length, columns: cols,
    next: published ? "Register facts from it like any CSV, and say in the answer that the figure was read from that page."
      : "audit_answer / audit_report check this table against the registered facts." };
}
