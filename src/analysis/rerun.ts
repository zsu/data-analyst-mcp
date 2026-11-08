/**
 * The --rerun gate: replay every exhibit's recorded lineage (exhibits/lineage.json) from its inputs and recompute
 * every table fact, so the numbers an answer cites are reproduced by code, not typed.
 * report/ audits import it. Nothing is written: the replays stay in memory.
 *
 *   exhibits  every exhibits/*.csv and every lineage entry: same = the replayed steps give the file byte for byte
 *             (an exhibit without compute steps cannot be replayed: same false, with why in detail)
 *   facts     every facts.json entry: a table fact is read again from the replayed exhibit (or the fetched
 *             data/ or published/ file); a derived fact written as an expression over fact names is recomputed
 *             from the rerun values; a prose derivation keeps its stored value (detail says so).
 *             same = the rerun value equals the stored one (within float noise, as method_audit's fact_diff).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LINEAGE, readLineage, relPath, runPipeline } from "./compute.js";
import { derivationExpr, evalDerivation, readCell, readFacts } from "./facts.js";
import { tableCsv, type Table } from "./table.js";

export type RerunResult = {
  exhibits: Record<string, { same: boolean; detail?: string }>;
  facts: Record<string, { stored: unknown; rerun: unknown; same: boolean; detail?: string }>;
};

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function rerunWorkspace(workspace: string): Promise<RerunResult> {
  const ws = path.resolve(workspace);
  const lin = readLineage(ws);
  const replayed = new Map<string, string>();         // exhibit -> the CSV text its steps give now
  const parsed = new Map<string, Table>();            // each input file read once for every recipe that uses it
  const exhibits: RerunResult["exhibits"] = {};
  const exDir = path.join(ws, "exhibits");
  const files = fs.existsSync(exDir)
    ? fs.readdirSync(exDir).filter((f) => f.toLowerCase().endsWith(".csv")).map((f) => `exhibits/${f}`) : [];
  for (const rel of [...new Set([...files, ...Object.keys(lin)])].sort()) {
    const entry = lin[rel];
    const abs = path.join(ws, rel);
    if (!fs.existsSync(abs)) {
      exhibits[rel] = { same: false, detail: `${rel} is in ${LINEAGE} but the file is missing` };
      continue;
    }
    if (entry && entry.tool === "write_table") {        // a method table: unchanged since write_table wrote it
      const sha = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
      exhibits[rel] = sha === entry.sha256 ? { same: true, detail: `${rel} is a method table (write_table), unchanged` }
        : { same: false, detail: `${rel} was edited after write_table wrote it: write it again with write_table` };
      continue;
    }
    if (!entry || Array.isArray(entry) || !Array.isArray(entry.steps) || !entry.inputs) {
      exhibits[rel] = { same: false, detail: `${rel} has no recorded compute steps, so it cannot be replayed: make it with compute` };
      continue;
    }
    const inputs = Object.fromEntries(Object.entries(entry.inputs as Record<string, { path: string; columns?: string[] }>)
      .map(([k, v]) => [k, Array.isArray(v.columns) ? { path: v.path, columns: v.columns } : v.path]));
    try {
      const r = runPipeline(ws, { inputs, steps: entry.steps, from: entry.from }, parsed);
      const text = tableCsv(r.table);
      replayed.set(rel, text);
      const changed = Object.entries(r.inputs).filter(([k, v]) => entry.inputs[k]?.sha256 && entry.inputs[k].sha256 !== v.sha256)
        .map(([, v]) => v.path);
      const same = text === fs.readFileSync(abs, "utf8");
      exhibits[rel] = same ? { same: true } : { same: false, detail: `replaying the steps of ${rel} gives a different CSV` +
        (changed.length ? ` (inputs changed since it was made: ${changed.join(", ")})` : " (the file was changed after compute saved it)") };
    } catch (e: any) {
      exhibits[rel] = { same: false, detail: `replaying ${rel} failed: ${e?.message || e}` };
    }
  }

  const stored = readFacts(ws);
  const facts: RerunResult["facts"] = {};
  const values: Record<string, unknown> = {};
  const pending: string[] = [];
  for (const [name, rec] of Object.entries(stored)) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.source && rec.where && rec.column) {
      const src = relPath(rec.source);
      let text: string | undefined;
      let detail: string | undefined;
      if (src.startsWith("exhibits/")) {
        text = replayed.get(src);
        if (text === undefined) detail = exhibits[src]?.detail || `${src} could not be replayed`;
      } else if (fs.existsSync(path.join(ws, src))) {
        text = fs.readFileSync(path.join(ws, src), "utf8");
      } else detail = `${src} is missing`;
      if (text === undefined) {
        facts[name] = { stored: rec.value, rerun: null, same: false, detail };
        continue;
      }
      try {
        const [v] = readCell(text, src, rec.where, rec.column, name);
        values[name] = v;
        facts[name] = { stored: rec.value, rerun: v, same: sameValue(rec.value, v) };
      } catch (e: any) {
        facts[name] = { stored: rec.value, rerun: null, same: false, detail: e?.message || String(e) };
      }
    } else pending.push(name);
  }
  // derived facts, in their stored order: an expression is recomputed from the rerun values
  for (const name of pending) {
    const rec = stored[name];
    const node = rec.derivation ? derivationExpr(String(rec.derivation), (n) => Object.hasOwn(stored, n) && n !== name) : null;
    if (!node) {
      values[name] = rec.value;
      facts[name] = { stored: rec.value, rerun: rec.value, same: true,
        detail: "a prose derivation: the stored value is kept (write the derivation as an expression over fact names to have it recomputed)" };
      continue;
    }
    try {
      const v = evalDerivation(node, (n) => (Object.hasOwn(values, n) ? values[n] : undefined), name);
      values[name] = v;
      facts[name] = { stored: rec.value, rerun: v, same: sameValue(rec.value, v) };
    } catch (e: any) {
      facts[name] = { stored: rec.value, rerun: null, same: false, detail: e?.message || String(e) };
    }
  }
  return { exhibits, facts };
}
