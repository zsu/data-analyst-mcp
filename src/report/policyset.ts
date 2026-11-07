/**
 * The source policies a report is bound by, and the package rules they imply (a port of report/policyset.py,
 * with the parts of core/policy.py the report layer uses: is_microdata, check_package, run_audit_hooks).
 * Shared by build_report and audit_report, so the builder and the release gate apply one rule set.
 *
 * Sources used = report.json "sources" (ids, or {"source": id} / {"id": id} objects), else every data/<id>/
 * folder of the workspace. Each one's policy is packs/<id>/policy.json.
 *
 * Package rule for a file (decide):
 *   data/<id>/...   allowed          -> in (temp files *.part / *.meta.json stay out)
 *                   aggregates_only  -> in unless it matches redistribution.microdata_globs (row-level data)
 *                   definition_only  -> only redistribution.package_include globs, never microdata
 *                   any file above MICRO_MAX bytes stays out with a note (fetch it again)
 *                   redistribution.withhold: rows of shared CSVs whose key is withheld are dropped, and raw
 *                   files named after a withheld key stay out
 *   data/<file>     (not in a source folder) follows the strictest rule of the sources used
 *   anything else   exhibits/, facts, decisions: in (exhibits are aggregates) unless an audit hook
 *                   forbid_in_package matches, or it is microdata of a definition_only source outside exhibits/
 */
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as pol from "../core/policy.js";
import type { Policy } from "../core/policy.js";
import { fnmatch } from "../core/tabular.js";
import { readDictFile, readText, csvGrid, writeDict, str } from "./py.js";

export const LIMITS = { MICRO_MAX: 50_000_000 };     // data files larger than this stay out of the ZIP
export const PROV_NAMES = ["request.json", "fetch_spec.json", "manifest.json", "extract_spec.json"];
const TEMP_SUFFIXES = [".part", ".meta.json", ".tmp"];
const ID = /^[a-z0-9][a-z0-9_-]*$/;

let SOURCES = PACKS_DIR;
/** The folder of source packs (tests point it at fake packs). */
export function sourcesDir(): string {
  return SOURCES;
}
export function setSourcesDir(d: string): void {
  SOURCES = d;
  POLICY_CACHE = null;
}

export class SourceError extends Error {}

const isPack = (d: string) => fs.existsSync(path.join(d, "policy.json"));

let POLICY_CACHE: Record<string, Policy> | null = null;
/** Every pack's policy (for the key scan). */
export function allPolicies(): Record<string, Policy> {
  if (POLICY_CACHE) return POLICY_CACHE;
  const out: Record<string, Policy> = {};
  const d = sourcesDir();
  for (const sid of fs.existsSync(d) ? fs.readdirSync(d).sort() : []) {
    if (!isPack(path.join(d, sid))) continue;
    try {
      out[sid] = pol.load(path.join(d, sid));
    } catch {
      // an unreadable policy is skipped
    }
  }
  return (POLICY_CACHE = out);
}

function ids(x: unknown): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(x) ? x : []) {
    const sid = typeof s === "string" ? s : s && typeof s === "object" ? (s.source || s.id) : null;
    if (sid) out.push(String(sid));
  }
  return [...new Set(out)];
}

export function dataFolders(base: string): string[] {
  const d = path.join(base, "data");
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((x) => fs.statSync(path.join(d, x)).isDirectory()).sort();
}

export function usedSources(base: string, R: any): string[] {
  const got = ids(R?.sources);
  return got.length ? got : dataFolders(base);
}

export function loadPolicies(list: string[]): Record<string, Policy> {
  const out: Record<string, Policy> = {}, bad: string[] = [];
  for (const sid of list) {
    const d = path.join(sourcesDir(), sid);
    if (!ID.test(sid) || !isPack(d)) {
      bad.push(sid);
      continue;
    }
    out[sid] = pol.load(d);
  }
  if (bad.length) {
    throw new SourceError(`not a source pack: ${str(bad)} (folders under data/ must be source ids; or list the sources ` +
      'in report.json "sources")');
  }
  return out;
}

export function match(globs: string[] | null | undefined, rel: string): boolean {
  const r = rel.replaceAll("\\", "/");
  return (globs || []).some((g) => fnmatch(r, g) || fnmatch(path.posix.basename(r), g));
}

/** core.policy.is_microdata */
export function isMicrodata(P: Policy, relpath: string): boolean {
  if (!["definition_only", "aggregates_only"].includes(P.redistribution.mode)) return false;
  return match(P.redistribution.microdata_globs, relpath);
}

/** core.policy.check_package: files that must not leave the workspace under this source's rules. */
export function checkPackage(P: Policy, members: string[]): string[] {
  const bad = members.filter((m) => isMicrodata(P, m));
  for (const h of P.audit_hooks || []) {
    if (h.kind === "forbid_in_package") {
      bad.push(...members.filter((m) => (h.globs || []).some((g: string) => fnmatch(m.replaceAll("\\", "/"), g))));
    }
  }
  return [...new Set(bad)].sort();
}

// ---------------------------------------------------------------------- provenance
function readJson(p: string): any {
  return JSON.parse(readText(p));
}

/** [path relative to base, content] of data/<id>/'s provenance file: report.json "provenance" (a path, or
 * {id: path}), else the first of request.json, fetch_spec.json, manifest.json, extract_spec.json. */
export function provenance(base: string, sid: string, R?: any): [string | null, any] {
  const want = R?.provenance;
  const cands: string[] = [];
  if (want && typeof want === "object" && !Array.isArray(want) && want[sid]) cands.push(want[sid]);
  else if (typeof want === "string" && want.replaceAll("\\", "/").startsWith(`data/${sid}/`)) cands.push(want);
  cands.push(...PROV_NAMES.map((n) => `data/${sid}/${n}`));
  for (const rel of cands) {
    const p = path.join(base, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      try {
        const v = readJson(p);
        return [rel.replaceAll("\\", "/"), v && typeof v === "object" ? v : {}];
      } catch {
        return [rel.replaceAll("\\", "/"), {}];
      }
    }
  }
  return [null, {}];
}

const VINTAGE_KEYS = ["vintage", "latest", "latest_period", "api_version", "as_of", "vintage_dates"];
const empty = (v: unknown) => v === null || v === undefined || v === "" ||
  (Array.isArray(v) && !v.length) || (typeof v === "object" && v !== null && !Array.isArray(v) && !Object.keys(v).length);

/** The vintage information a provenance file carries (BLS, FRED style), plus series-level vintages. */
export function vintageFields(P: any): Record<string, any> {
  let got: Record<string, any> = {};
  for (const k of VINTAGE_KEYS) if (!empty(P?.[k])) got[k] = P[k];
  if (got.vintage === "latest" && Object.keys(got).length === 1) got = {};
  const series = Array.isArray(P?.spec?.series) ? P.spec.series : [];
  const vint = [...new Set(series.filter((x: any) => x && typeof x === "object" && x.vintage)
    .map((x: any) => (x.vintage && typeof x.vintage === "object" ? x.vintage.kind || "" : str(x.vintage))))]
    .filter((x) => x !== "").sort() as string[];
  if (vint.length && !(vint.length === 1 && vint[0] === "latest")) got.series_vintages = vint;
  return got;
}

// ---------------------------------------------------------------------- withholding (FRED copyright)
/** {"<source or ''>\u0000<KEY>": entry} from report.json "clearance" ({source, key, basis, redistribute}) and the
 * FRED-style "copyright_clearance" ({series_id, basis, redistribute}). */
export function clearances(R: any): Map<string, any> {
  const out = new Map<string, any>();
  for (const c of R?.clearance || []) out.set(`${String(c.source ?? "") || ""}\u0000${String(c.key ?? "").toUpperCase()}`, c);
  for (const c of R?.copyright_clearance || []) out.set(`\u0000${String(c.series_id ?? "").toUpperCase()}`, c);
  return out;
}

export function clearanceFor(clear: Map<string, any>, sid: string, k: string): any {
  return clear.get(`${sid}\u0000${k.toUpperCase()}`) || clear.get(`\u0000${k.toUpperCase()}`);
}

/** [the withhold rule, rows of its meta table whose column holds a withheld value]. */
export function withholdRows(base: string, sid: string, P: Policy): [any | null, Record<string, string | null>[]] {
  const w = P.redistribution?.withhold;
  if (!w) return [null, []];
  const meta = path.join(base, "data", sid, w.meta || "series.csv");
  if (!fs.existsSync(meta)) return [w, []];
  const rows = readDictFile(meta).rows;
  const col = w.column || "";
  const cell = (r: Record<string, string | null>) => (r[col] ?? "") === null ? "" : String(r[col] ?? "");
  if (w.shareable) {                               // whitelist: anything not listed is withheld (FRED)
    const ok = new Set((w.shareable as unknown[]).map(str));
    return [w, rows.filter((r) => !ok.has(cell(r)))];
  }
  const vals = new Set(((w.values || []) as unknown[]).map(str));
  return [w, rows.filter((r) => vals.has(cell(r)))];
}

/** Keys whose rows may not leave the workspace (a clearance with "redistribute": true lifts one). */
export function withheldKeys(base: string, sid: string, P: Policy, R: any): Set<string> {
  const [w, rows] = withholdRows(base, sid, P);
  if (!w) return new Set();
  const clear = clearances(R);
  const keys = new Set<string>();
  for (const r of rows) {
    const k = String(r[w.key || ""] ?? "");
    const c = clearanceFor(clear, sid, k);
    if (k && !(c && c.redistribute === true)) keys.add(k);
  }
  return keys;
}

/** [CSV text without the withheld rows, rows dropped]. */
export function filteredCsv(p: string, keycol: string, withheld: Set<string>): [string, number] {
  const { fields, rows } = readDictFile(p);
  const keep = rows.filter((r) => !withheld.has(String(r[keycol] ?? "")));
  return [writeDict(keep, fields, (v) => (v === null || v === undefined ? "" : String(v))), rows.length - keep.length];
}

export function csvHeader(p: string): string[] {
  try {
    return csvGrid(readText(p))[0] || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------- the package rule for one file
export type Decision = { ok: boolean; reason: string; filter: [string, Set<string>] | null; policy: boolean };

/** The package rule for a file (path relative to base). "policy" is true when the file stays out because of a
 * source's terms (not because of its size). */
export function decide(rel0: string, base: string, policies: Record<string, Policy>, R: any,
  withheld: Record<string, Set<string>> = {}): Decision {
  const rel = rel0.replaceAll("\\", "/");
  const full = path.join(base, rel);
  const repl = R?.replication || {};
  const res: Decision = { ok: true, reason: "", filter: null, policy: false };
  const no = (reason: string, policy = true): Decision => ({ ok: false, reason, filter: null, policy });
  const size = () => (fs.existsSync(full) && fs.statSync(full).isFile() ? fs.statSync(full).size : 0);

  for (const [sid, P] of Object.entries(policies)) {                  // audit hooks: forbid_in_package
    for (const h of P.audit_hooks || []) {
      if (h.kind === "forbid_in_package" && (h.globs || []).some((g: string) => fnmatch(rel, g))) {
        return no(`${sid} forbids it in a package (${h.id}: ${h.why || ""})`);
      }
    }
  }
  const m = /^data\/([^/]+)\/(.+)$/s.exec(rel);
  if (m && m[1] in policies) {
    const sid = m[1], subp = m[2];
    const P = policies[sid];
    const rd = P.redistribution;
    if (TEMP_SUFFIXES.some((s) => subp.endsWith(s))) return no("temporary download file", false);
    if (rd.mode === "definition_only") {
      if (isMicrodata(P, subp) || isMicrodata(P, rel)) {
        return no(`microdata of ${sid}: its terms forbid redistribution (definition_only)`);
      }
      if (!match(rd.package_include || [], subp)) {
        return no(`${sid} is definition_only: only its request definition leaves the analysis folder`);
      }
    } else if (rd.mode === "aggregates_only" && match(rd.microdata_globs || [], subp)) {
      return no(`row-level data of ${sid}: only tables of estimates may be shared (aggregates_only)`);
    }
    const isData = [".csv", ".csv.gz", ".parquet", ".dat", ".dat.gz", ".xlsx", ".zip"].some((e) => subp.toLowerCase().endsWith(e));
    if (repl.include_data === false && isData && path.posix.basename(subp) !== "data_dictionary.csv") {
      return no("left out by report.json replication.include_data = false", false);
    }
    const keys = withheld[sid] || new Set<string>();
    const w = rd.withhold || {};
    if (keys.size && subp.startsWith("raw/")) {
      const name = path.posix.basename(subp);
      if ([...keys].some((k) => name.startsWith(k + "_") || name.startsWith(k + "."))) {
        return no(`raw response of a withheld ${w.key || "key"} (${sid}: redistribution.withhold)`);
      }
    }
    if (size() > LIMITS.MICRO_MAX) {
      return no(`larger than ${Math.floor(LIMITS.MICRO_MAX / 1_000_000)} MB; fetch it again with the fetch tool`, false);
    }
    if (keys.size && subp.toLowerCase().endsWith(".csv") && subp !== w.meta && csvHeader(full).includes(w.key)) {
      res.filter = [w.key, keys];
    }
    return res;
  }
  if (m) return no(`data/${m[1]}/ is not a source of this report`, false);   // a data folder of a source not used
  if (rel.startsWith("data/")) {                                              // a loose file: strictest rule wins
    const strict = pol.strictest(Object.values(policies));
    if (strict !== "allowed") return no(`not in a source folder, so the strictest rule of the sources used (${strict}) applies`);
    if (size() > LIMITS.MICRO_MAX) return no(`larger than ${Math.floor(LIMITS.MICRO_MAX / 1_000_000)} MB`, false);
    return res;
  }
  if (!rel.startsWith("exhibits/") && !rel.startsWith("lib/")) {
    for (const [sid, P] of Object.entries(policies)) {
      if (P.redistribution.mode === "definition_only" && isMicrodata(P, rel)) {
        return no(`looks like microdata of ${sid} (its microdata_globs); its terms forbid redistribution`);
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------------- audit hooks (core.policy.run_audit_hooks)
/** glob.glob(os.path.join(base, pattern)) without recursion ("*" does not match a leading dot). */
export function glob(base: string, pattern: string): string[] {
  const segs = pattern.replaceAll("\\", "/").split("/").filter((x) => x && x !== ".");
  let cur = [base];
  for (const [i, seg] of segs.entries()) {
    const last = i === segs.length - 1, next: string[] = [];
    for (const d of cur) {
      if (!/[*?[]/.test(seg)) {
        const p = path.join(d, seg);
        if (fs.existsSync(p) && (last || fs.statSync(p).isDirectory())) next.push(p);
        continue;
      }
      if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
      for (const name of fs.readdirSync(d).sort()) {
        if (name.startsWith(".") && !seg.startsWith(".")) continue;
        if (!fnmatch(name, seg)) continue;
        const p = path.join(d, name);
        if (last || fs.statSync(p).isDirectory()) next.push(p);
      }
    }
    cur = next;
  }
  return segs.length ? cur : [];
}

function hasContent(p: string): boolean {
  try {
    const text = fs.readFileSync(p).subarray(0, 1 << 16).toString("utf8");
    const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim());
    return lines.length >= (p.toLowerCase().endsWith(".csv") ? 2 : 1);
  } catch {
    return false;
  }
}

function requestJson(out: string, pid: string): any {
  try {
    return readJson(path.join(out, "data", pid, "request.json"));
  } catch {
    return null;
  }
}

function dataFlagged(out: string, cond: any): boolean {
  const pat = cond.pattern ? new RegExp(cond.pattern, "i") : null;
  for (const p of glob(out, cond.glob || "")) {
    try {
      const rows = readDictFile(p).rows;
      if (rows.some((r) => {
        const v = String(r[cond.column || ""] ?? "");
        return pat ? pat.test(v) : ["1", "true", "yes", "y", "p"].includes(v.trim().toLowerCase());
      })) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function factsTouch(facts: any, source: string, pattern: string): boolean {
  if (!facts || !Object.keys(facts).length) return true;
  const rx = new RegExp(pattern, "i");
  for (const f of Object.values<any>(facts)) {
    if (!f || typeof f !== "object" || (f.pack && !String(f.pack).includes(source))) continue;
    if (rx.test(JSON.stringify({ where: f.where ?? null, label: f.label ?? null }))) return true;
  }
  return false;
}

/** [status PASS | FAIL, hook id, message] per hook. require_text searches the report.json text and, when given,
 * the built page (or the answer). */
export function runAuditHooks(P: Policy, out: string, report: any, facts: any, html?: string): [string, string, string][] {
  const res: [string, string, string][] = [];
  const text = (JSON.stringify(report || {}) + " " + (html || "")).toLowerCase();
  for (const h of P.audit_hooks || []) {
    const hid = h.id || "?", kind = h.kind;
    if (h.when_route) {
      const route = String(requestJson(out, P.id)?.route || "");
      if (!h.when_route.includes(route)) {
        res.push(["PASS", hid, `not needed: data came by route ${route || "unknown"} (${h.why})`]);
        continue;
      }
    }
    if (h.when_columns) {
      const rq = requestJson(out, P.id);
      const cols = rq === null ? null : rq?.spec?.columns;
      const used = !cols || !cols.length || cols.some((c: unknown) => h.when_columns.some((p: string) => String(c).toLowerCase().includes(p)));
      if (!used) {
        res.push(["PASS", hid, `not needed: no column matching ${str(h.when_columns)} was fetched (${h.why})`]);
        continue;
      }
    }
    if (h.when_data && !dataFlagged(out, h.when_data)) {
      res.push(["PASS", hid, `not needed: no row of ${h.when_data.glob} has ${h.when_data.column} set (${h.why})`]);
      continue;
    }
    if (h.when_facts && !factsTouch(facts, P.id, h.when_facts)) {
      res.push(["PASS", hid, `not needed: no ${P.id} fact is about ${h.when_facts} (${h.why})`]);
      continue;
    }
    if (kind === "require_file") {
      const hits = glob(out, h.glob).filter(hasContent);              // an empty file is not one
      res.push([hits.length ? "PASS" : "FAIL", hid, `${h.glob}: ${hits.length ? "found" : "missing"} (${h.why})`]);
    } else if (kind === "require_text") {
      const words = (h.any || []).map((w: string) => w.toLowerCase());
      const ok = words.some((w: string) => text.includes(w)) || (h.any_pattern || []).some((x: string) => new RegExp(x).test(text));
      res.push([ok ? "PASS" : "FAIL", hid, `report mentions one of ${str(words)}: ${ok ? "True" : "False"} (${h.why})`]);
    } else if (kind === "require_fact_prefix") {
      const ok = Object.keys(facts || {}).some((k) => k.startsWith(h.prefix));
      res.push([ok ? "PASS" : "FAIL", hid, `a fact named ${h.prefix}*: ${ok ? "True" : "False"} (${h.why})`]);
    }
  }
  return res;
}
