/**
 * Checks shared by audit_report (reports, papers) and audit_answer (quick answers): a port of
 * report/method_audit.py. <workspace>/decisions.json is the method record of every product (record_decisions
 * writes it): the critical questions and how each was answered, the literature searched, the references opened
 * and the assumptions with their basis. report.json may carry "references" and "assumptions" too; merged() joins
 * both (report.json wins on the same id or parameter).
 *
 * Rules (all FAIL-level):
 *   questions    an asked question offers exactly one "Don't know" option and no "Skip" option; a question not
 *                asked has reason_code no_user or settled_by_request (with "request", the user's quoted words); a
 *                skipped, unanswered or no_user question counts as "Don't know" and needs a resolution tied to an
 *                assumption that is not "user"; a blocking question decided without the user needs a rationale,
 *                and a skipped one needs one follow-up first
 *   literature   at least one search entry with its query, date and what it found, or unavailable with
 *                reason_code no_search_tool, network_blocked or tool_unavailable
 *   disclosures  no_user questions and unavailable searches need a line in "disclosures" the answer carries
 *   references   citation, URL or DOI, accessed date and opened: true, backed by a snapshot the cite tool saved
 *                (references/opened.json: same URL, file unchanged since); a "quote" must be in that snapshot
 *   assumptions  basis empirical > literature > precedent > user > judgment, each backed by its evidence
 *   sensitivity  each exhibits/sensitivity.csv row's headlines are registered facts; conclusion_changes agrees
 *   data_needs   every judgment assumption and every benchmark row "not checked" is named in a data_needs entry
 *   benchmark    exhibits/benchmark.csv compares the headline numbers with published figures
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rerunWorkspace } from "../analysis/rerun.js";
import { workspaceFile } from "../core/guard.js";
import { redact } from "../core/keys.js";
import { decodeText } from "../core/tabular.js";
import { pyFloatRepr } from "../core/py.js";
import { csvGrid, fmtG, match, readDictFile, repr, rx, str, strip, toFloat, unescapeHtml, type DictRow } from "./py.js";

export type Result = [string, boolean, string];

/** Notes the audits print (not checks): collected per audit call. */
export const NOTES: string[] = [];
export const note = (m: string) => void NOTES.push(m);

export const BASES = ["empirical", "literature", "precedent", "user", "judgment"];      // strongest first
export const NO_ANSWER = ["dont_know", "skipped", "not_asked"];
export const NOT_ASKED_CODES: Record<string, string> = {
  no_user: "nobody could answer (a headless or scheduled run)",
  settled_by_request: "the request already settles it" };
export const UNAVAILABLE_CODES: Record<string, string> = {
  no_search_tool: "no web search or fetch tool exists in this environment, not even one that could be loaded",
  network_blocked: "the environment's network blocks every search and fetch",
  tool_unavailable: "the search and fetch tools exist but failed for the whole run (a usage limit or an outage): say when they were tried" };
const DONT_KNOW_RE = /^\W*(?:i\s+)?don['’]?t\s+know/i;
const SKIP_RE = /^\W*skip\b/i;
const CITE_RE = /\[@[^\]]*\]/g;
const SENS_COLS = ["parameter", "base", "alternative", "headline_base", "headline_alt", "conclusion_changes"];
export const BENCH_COLS = ["measure", "period", "computed", "published", "source"];

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function load(base: string): any {
  const p = path.join(base, "decisions.json");
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/^﻿/, "");
  } catch {                                            // saved in a Windows code page: read it, and say so
    note("decisions.json is not UTF-8; read as cp1252. Save it as UTF-8.");
    text = decodeText(raw);
  }
  return JSON.parse(text);
}

/** R (report.json, or {}) with decisions.json's questions, literature, references and assumptions joined in. */
export function merged(base: string, R0?: any): any {
  const R: any = { ...(R0 || {}) };
  const D = load(base);
  const refs = new Map<any, any>();
  for (const r of D.references || []) refs.set(r?.id, r);
  for (const r of R.references || []) refs.set(r?.id, r);
  const asm = new Map<any, any>();
  for (const a of D.assumptions || []) asm.set(a?.parameter, a);
  for (const a of R.assumptions || []) asm.set(a?.parameter, a);
  if (refs.size) R.references = [...refs.values()];
  if (asm.size) R.assumptions = [...asm.values()];
  for (const k of ["questions", "literature_search", "data_needs"]) {
    const d = D[k] || [], r = R[k] || [];
    if (d.length || r.length) R[k] = [...d, ...r.filter((x: unknown) => !d.some((y: unknown) => same(x, y)))];
  }
  if ((D.disclosures && Object.keys(D.disclosures).length) || (R.disclosures && Object.keys(R.disclosures).length)) {
    R.disclosures = { ...(D.disclosures || {}), ...(R.disclosures || {}) };
  }
  if ("data_needs" in D || "data_needs" in R) if (!("data_needs" in R)) R.data_needs = D.data_needs ?? [];
  if (D.data_needs_note && !R.data_needs_note) R.data_needs_note = D.data_needs_note;
  for (const k of ["audit_allow", "rounding_ties_ok"]) {
    if (D[k] && D[k].length) {
      const have = [...(R[k] || [])];
      R[k] = [...have, ...D[k].filter((x: unknown) => !have.some((y) => same(x, y)))];
    }
  }
  return R;
}

export function citedRefs(text: string): Set<string> {
  const out = new Set<string>();
  for (const g of text.match(CITE_RE) || []) for (const m of g.matchAll(/@([A-Za-z0-9_-]+)/g)) out.add(m[1]);
  return out;
}

/** Was the question put to the user? decisions.json's "asked" (default true); record_decisions writes how: "not_asked"
 * for a question it did not ask, which counts as asked: false. */
export function asked(q: any): boolean {
  return q.asked ?? q.how !== "not_asked";
}

function settled(q: any): boolean {
  return !asked(q) && q.reason_code === "settled_by_request" && !!strip(String(q.request ?? ""));
}

export function noAnswer(q: any): boolean {
  if (settled(q)) return false;
  return [null, undefined, "", ...NO_ANSWER].includes(q.answer) || (!asked(q) && !q.answer);
}

const qidOf = (q: any) => q.id || String(q.question ?? "?").slice(0, 40);

/** [disclosure key, what was claimed] for every claim no script can check. */
export function escapes(R: any): [string, string][] {
  const out: [string, string][] = [];
  for (const q of R.questions || []) {
    if (!asked(q) && q.reason_code === "no_user") out.push([qidOf(q), `question not asked: ${NOT_ASKED_CODES.no_user}`]);
  }
  const lit = R.literature_search || [];
  if (lit.some((s: any) => s.unavailable)) {
    const codes = [...new Set(lit.filter((s: any) => s.unavailable).map((s: any) => s.reason_code ?? ""))].sort() as string[];
    out.push(["literature", "literature search not run: " + codes.map((c) => UNAVAILABLE_CODES[c] ??
      (c ? `reason_code ${repr(c)} is not valid` : "no valid reason_code")).join("; ")]);
  }
  return out;
}

export function readCsv(p: string): [string[], DictRow[], (string[] | undefined)[]] {
  const d = readDictFile(p);
  return [d.fields, d.rows, d.extra];
}

// ---- references opened: the snapshot the cite tool saved
function openedLog(base: string): Record<string, any> {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(base, "references", "opened.json"), "utf8").replace(/^﻿/, ""));
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

const urlKey = (u: unknown) => String(u ?? "").trim().split("#")[0].replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();

/** Text reduced to lowercase words, so a quote from a page's Markdown rendering matches its HTML. */
export function words(s: string): string {
  return unescapeHtml(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w).join(" ");
}

export function sha256(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** The words of a saved page; null for a PDF (no PDF text reader here: the quote is then not checked). */
function snapshotText(p: string): string | null {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".pdf") return null;
  let text = fs.readFileSync(p).toString("utf8");
  if (ext === ".html" || ext === ".xml") {
    text = text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
    text = text.replace(/<[^>]+>/g, " ");
  }
  return text;
}

function checkOpened(rid: string, r: any, opened: Record<string, any>, base: string): [boolean, string, string | null] {
  const url = r.url || r.doi || "<url>";
  const e = opened[rid];
  if (!e) {
    return [false, `reference ${rid}: "opened": true, but references/opened.json has no snapshot of it: open it with the ` +
      `cite tool ({"url": "${url}", "id": "${rid}"}; pass "text" with what your own fetch tool returned when this ` +
      "server cannot reach the page); never cite what you have not opened", null];
  }
  if (r.url && urlKey(e.url) !== urlKey(r.url)) {
    return [false, `reference ${rid}: the snapshot is of ${str(e.url)}, not ${r.url}: cite the page you opened`, null];
  }
  const p = path.join(base, String(e.file ?? ""));
  if (!e.file || !fs.existsSync(p) || !fs.statSync(p).isFile() || sha256(p) !== e.sha256) {
    return [false, `reference ${rid}: ${str(e.file)} is missing or changed since it was opened: call cite again`, null];
  }
  const msg = `reference ${rid}: opened ${String(e.opened ?? "").slice(0, 10)} (${str(e.via)})`;
  const q = strip(String(r.quote ?? ""));
  if (!q) return [true, msg, null];
  if (words(q).length < 20) {
    return [false, `reference ${rid}: quote ${repr(q)} is too short to identify a passage: give a full sentence`, null];
  }
  const text = snapshotText(p);
  if (text === null) {
    note(`reference ${rid}: the quote was not checked (${e.file} is a PDF; this server reads no PDF text)`);
    return [true, msg + "; quote not checkable", "uncheckable"];
  }
  if (!words(text).includes(words(q))) {
    return [false, `reference ${rid}: the quote is not in ${e.file}: quote the page's own words (an exact sentence, not a ` +
      "paraphrase)", null];
  }
  return [true, msg + "; quote found", "found"];
}

export function key(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}

/** The CSV's file name, a column or a cell names the parameter (an empirical estimate's own table). */
function csvNames(p: string, param: string, maxRows = 5000): boolean {
  const k = key(param);
  if (!k) return false;
  if (key(path.basename(p, path.extname(p))).includes(k)) return true;
  const grid = csvGrid(decodeText(fs.readFileSync(p)));
  for (let n = 0; n < grid.length; n++) {
    if (n > maxRows) break;
    if (grid[n].some((c) => key(c) === k || (n === 0 && key(c).includes(k)))) return true;
  }
  return false;
}

export const NUM = rx(String.raw`(?i)^[^\d\-+.]*([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(%|percent|pct)?[^\d]*$`);
export const SAYS = ["match", "matches", "matched"];       // a benchmark.csv column that states the verdict
const BOUND = rx(String.raw`(?i)^\s*(>=|<=|>|<|≥|≤|over|more than|above|at least|under|below|less than|at most)\s*(.+)$`);

/** A sensitivity cell as [value, half a unit of its last digit as written]: "1.10" -> [1.1, 0.005]. */
function sensNumber(s: unknown): [number, number] | null {
  const m = match(NUM, strip(String(s ?? "")));
  if (!m) return null;
  const txt = m[1].replace(/,/g, "");
  return [Number(txt), txt.includes(".") ? 0.5 * 10 ** -txt.split(".")[1].length : 0.5];
}

function checkSensitivity(i: number, row: DictRow, facts: any): [boolean, string] {
  const label = `sensitivity.csv line ${i} (${row.parameter ?? ""})`;
  const values = factValues(facts), nums: Record<string, number> = {};
  for (const side of ["base", "alt"]) {
    const name = strip(String(row[`fact_${side}`] ?? "")), cell = row[`headline_${side}`];
    const x = sensNumber(cell);
    if (name) {
      const v = toFloat((facts?.[name] || {}).value);
      if (v === null) {
        return [false, `${label}: fact_${side} ${repr(name)} is not a numeric fact in facts.json`];
      }
      if (x && !isFact(x[0], x[1] + Math.abs(x[0]) * 1e-9, [v])) return [false, `${label}: headline_${side} ${str(cell)} is not fact ${name} (${fmtG(v)})`];
      nums[side] = x ? x[0] : v;
      continue;
    }
    if (x === null) {
      return [false, `${label}: headline_${side} ${repr(cell)} is not one number: register the headline under each ` +
        `alternative as a fact (the facts tool) and write it here (or name it in fact_${side})`];
    }
    if (!isFact(x[0], x[1] + Math.abs(x[0]) * 1e-9, values)) {
      return [false, `${label}: headline_${side} ${str(cell)} is not a registered fact: run the ` +
        `${side === "alt" ? "alternative" : "base case"} with compute and register its headline (fact_${side} names ` +
        "it), so the rerun reproduces it"];
    }
    nums[side] = x[0];
  }
  const cc = strip(String(row.conclusion_changes ?? "")).toLowerCase();
  const says = /^(yes|true)\b/.test(cc) ? "yes" : /^(no|false)\b/.test(cc) ? "no" : null;
  if (says === null) return [false, `${label}: conclusion_changes ${repr(cc)}: start it with yes or no`];
  const b = nums.base, a = nums.alt;
  const thr = sensNumber(row.threshold);
  if (thr) {
    // a sign flip is a change too (a fall that becomes a rise), whichever side of the threshold both are on
    const crosses = (b - thr[0]) * (a - thr[0]) < 0, flips = b * a < 0;
    if ((says === "yes") !== (crosses || flips)) {
      const why = crosses ? `are on opposite sides of the threshold ${fmtG(thr[0])}` : flips ? "differ in sign"
        : `are on the same side of the threshold ${fmtG(thr[0])} and of zero`;
      return [false, `${label}: base ${fmtG(b)} and alternative ${fmtG(a)} ${why}, so conclusion_changes must be ` +
        `${crosses || flips ? "yes" : "no"}`];
    }
  } else if (says === "no" && b * a < 0) {
    return [false, `${label}: the headline changes sign (${fmtG(b)} to ${fmtG(a)}), so the conclusion changes: write yes, ` +
      "or give the threshold the conclusion turns on in a threshold column"];
  }
  return [true, `${label}: ${fmtG(b)} vs ${fmtG(a)}, conclusion changes: ${says}`];
}

/** [check, ok, message] for the method record in R (already merged with decisions.json). */
export function checkMethod(R: any, base: string, facts: any): Result[] {
  const out: Result[] = [];
  const res = (check: string, ok: unknown, msg: string) => void out.push([check, !!ok, msg]);
  const refs = new Map<any, any>((R.references || []).map((r: any) => [r?.id, r]));
  const asm = new Map<any, any>((R.assumptions || []).map((a: any) => [a?.parameter, a]));
  const questions: any[] = R.questions || [];

  // ---- questions
  for (const q of questions) {
    const qid = qidOf(q);
    if (asked(q)) {
      const opts = (q.options || []).map((o: unknown) => str(o));
      const dk = opts.filter((o: string) => DONT_KNOW_RE.test(o)), skip = opts.filter((o: string) => SKIP_RE.test(o));
      const good = dk.length === 1 && !skip.length;
      res("questions", good, good ? `question ${qid}: options ok` : `question ${qid}: offer exactly one "Don't know — decide ` +
        `for me" option and no "Skip" (found ${dk.length} Don't know, ${skip.length} Skip)`);
    } else {
      const code = q.reason_code;
      if (!(code in NOT_ASKED_CODES)) {
        res("questions", false, `question ${qid}: not asked; set "reason_code": "no_user" only when nobody can answer (a ` +
          'headless or scheduled run; with a question tool, ask), or "settled_by_request" with "request": the user\'s own words');
        continue;
      }
      if (code === "settled_by_request") {
        res("questions", settled(q), settled(q) ? `question ${qid}: settled by the request (${repr(q.request)})`
          : `question ${qid}: settled_by_request needs "request": the user's own words`);
        continue;
      }
    }
    if (!noAnswer(q)) continue;
    const how = q.how || q.answer || "not_asked";
    const a = asm.get(q.assumption);
    const ok = !!q.resolution && a !== undefined && String(a?.basis || "").toLowerCase() !== "user";
    res("questions", ok, ok ? `question ${qid}: ${how}, decided as ${repr(q.resolution)} (${str(a.basis)})`
      : `question ${qid}: ${how} counts as "Don't know"; record the "resolution" and the "assumption" (a parameter in ` +
        "the assumptions, basis other than user) that decides it");
    if (q.blocking) {
      const ok2 = !!q.rationale && (how !== "skipped" || !asked(q) || !!q.followed_up);
      res("questions", ok2, ok2 ? `question ${qid}: blocking, decided without the user by ${repr(q.rationale)}; state it in ` +
        "the opening paragraph of the answer, its disclosures line word for word"
        : `question ${qid}: blocking (what the user means): ask one follow-up after a skip ("followed_up": true), then ` +
          'record the literal reading as "rationale"');
    }
  }

  // ---- literature search
  const lit: any[] = R.literature_search || [];
  if (!lit.length) {
    res("literature", false, "no literature_search: search the agency methodology and research behind the definitions " +
      "and parameters, and record each query, date and what it found");
  }
  lit.forEach((s, j) => {
    const i = j + 1;
    if (s.unavailable) {
      const ok = s.reason_code in UNAVAILABLE_CODES;
      res("literature", ok, ok ? `search ${i}: unavailable (${s.reason_code})` : `search ${i}: unavailable needs ` +
        '"reason_code": "no_search_tool" (no search or fetch tool, not even a deferred one that could be loaded), ' +
        '"network_blocked" or "tool_unavailable" (the tools failed for the whole run); otherwise run the search');
      return;
    }
    const ok = !!s.query && !!s.date && ("found" in s || !!s.note);
    res("literature", ok, ok ? `search ${i}: ${repr(s.query)}` : `search ${i}: needs query, date and found (ids of the ` +
      "references opened, or [] with a note)");
    for (const rid of s.found || []) if (!refs.has(rid)) res("literature", false, `search ${i}: found ${repr(rid)}, which is not in references`);
  });

  // ---- disclosures: what the gate cannot check, the reader must be told
  const disc = R.disclosures || {};
  for (const [k, what] of escapes(R)) {
    const text = strip(String(disc[k] ?? ""));
    res("disclosures", !!text, text ? `${k}: disclose in the answer: ${text}` : `${k}: ${what}. No script can check that ` +
      `claim: add "disclosures": {"${k}": "<one line>"} to decisions.json (record_decisions) and carry that line in the ` +
      "answer or report");
  }

  // ---- references
  const opened = openedLog(base), verified = new Map<string, string | null>();
  for (const [rid, r] of refs) {
    const miss = ([["citation", r.citation], ["url or doi", r.url || r.doi], ["accessed", r.accessed],
      ["opened: true", r.opened === true]] as [string, unknown][]).filter(([, v]) => !v).map(([k]) => k);
    if (miss.length) {
      res("references", false, `reference ${str(rid)}: needs ${miss.join(", ")} (never cite what you have not opened)`);
      continue;
    }
    const [ok, msg, quote] = checkOpened(String(rid), r, opened, base);
    res("references", ok, msg);
    if (ok) verified.set(String(rid), quote);
  }
  for (const rid of [...citedRefs(JSON.stringify(R))].filter((x) => !refs.has(x)).sort()) {
    res("references", false, `[@${rid}] is cited but not in references`);
  }
  if (!refs.size) {
    res("references", false, "no references: cite the publications and research that the definitions, parameters and " +
      "methods rely on");
  }

  // ---- assumptions
  const sensPath = path.join(base, "exhibits", "sensitivity.csv");
  let sensRows: Map<any, DictRow> | null = null;
  let sensList: DictRow[] = [];
  if (fs.existsSync(sensPath)) {
    const [cols, rows] = readCsv(sensPath);
    sensList = rows;
    const miss = SENS_COLS.filter((c) => !cols.includes(c));
    res("assumptions", !miss.length, !miss.length ? "exhibits/sensitivity.csv: columns ok"
      : `exhibits/sensitivity.csv lacks columns ${repr(miss)}`);
    sensRows = new Map(rows.map((r) => [r.parameter, r]));
  }
  const bases: Record<string, number> = {};
  for (const [p, a] of asm) {
    const b = String(a?.basis || "").toLowerCase();
    bases[b] = (bases[b] || 0) + 1;
    const ev = String(a?.evidence ?? "");
    if (!BASES.includes(b)) {
      res("assumptions", false, `assumption ${repr(p)}: basis ${repr(b || "missing")} is not one of ${BASES.join(" > ")}`);
      continue;
    }
    if (["empirical", "literature", "precedent"].includes(b) && !strip(ev)) {
      res("assumptions", false, `assumption ${repr(p)} (${b}): needs "evidence"`);
      continue;
    }
    let ok: boolean, why: string;
    if (b === "empirical") {
      const paths = (ev.match(/(?:exhibits|data|published)\/[\w./-]+\.csv/g) || []).filter((x) => fs.existsSync(path.join(base, x)));
      const fs_ = [...ev.matchAll(/\{\{\s*([A-Za-z_]\w*)/g)].map((m) => m[1]).filter((x) => facts && x in facts);
      ok = fs_.length > 0 || paths.some((x) => csvNames(path.join(base, x), String(p)));
      why = "name the {{fact}} that holds the estimate, or a data, exhibit or published CSV whose file name, a column or " +
        `a row names the parameter ${repr(p)}: an estimate the evidence cannot point to was not made`;
    } else if (b === "literature" || b === "precedent") {
      const idsCited = citedRefs(ev);
      ok = [...idsCited].some((i) => verified.has(i) && ["found", "uncheckable"].includes(verified.get(i) as string));
      why = 'cite the opened reference it comes from as [@id], with a "quote" in that reference: the sentence of the page ' +
        "that supports it (the audit finds it in the saved snapshot)";
      if (ok && match(NUM, strip(String(a?.value ?? ""))) && !strip(String(a?.why_not_empirical ?? ""))) {
        ok = false;
        why = "a number taken from the literature or an agency is a parameter the data may be able to estimate: fit the " +
          "model the literature uses with compute (basis empirical, the published value as a sensitivity row), or state " +
          "why_not_empirical (the data cannot identify it, or it is an official definition such as a threshold)";
      }
    } else if (b === "user") {
      const q = questions.find((x) => x.assumption === p || (x.id !== undefined && x.id === a?.question));
      const quoted = !!strip(String(a?.request ?? ""));
      ok = quoted || (q !== undefined && !noAnswer(q));
      why = 'point to the question the user answered ("question": id), or quote the user\'s own words ("request") when ' +
        "the request settles it";
    } else {
      const key = a?.sensitivity || p;
      const row = (sensRows || new Map()).get(key);
      ok = !!strip(String(a?.why_not_empirical ?? "")) && row !== undefined && !!strip(String(row?.conclusion_changes ?? ""));
      why = "judgment is the last resort: estimate it from the data or adopt a published estimate; otherwise state " +
        "why_not_empirical and add its row to exhibits/sensitivity.csv (" + SENS_COLS.join(", ") + ")";
      // "sensitivity" is the parameter of that row, not a description: say so when it names no row.
      if (row === undefined && a?.sensitivity && sensRows?.size) {
        why += `; "sensitivity" ${repr(key)} names no row: it is the row's parameter (${repr([...sensRows.keys()])}), ` +
          "or leave it out when the row's parameter is the assumption's own";
      }
    }
    res("assumptions", ok, ok ? `assumption ${repr(p)}: ${b} ok` : `assumption ${repr(p)} (${b}): ${why}`);
  }
  sensList.forEach((row, j) => res("sensitivity", ...checkSensitivity(j + 2, row, facts)));
  if (!asm.size) res("assumptions", false, "no assumptions: list each key definition and parameter with its basis and evidence");

  // ---- data that would improve the estimates
  const gaps: string[] = [...asm.entries()].filter(([, a]) => String(a?.basis || "").toLowerCase() === "judgment").map(([p]) => str(p));
  const bench = path.join(base, "exhibits", "benchmark.csv");
  if (fs.existsSync(bench)) {
    for (const r of readCsv(bench)[1]) {
      if (String(r.published ?? "").toLowerCase().includes("not checked") && r.measure) gaps.push(r.measure);
    }
  }
  const needs = R.data_needs;
  const covered = new Set<string>();
  const norm = (x: unknown) => str(x).replace(/\s+/g, " ").trim().toLowerCase();
  (needs || []).forEach((d: any, j: number) => {
    const miss = ["data", "improves", "effect", "how_to_get"].filter((k) => !d?.[k] || (Array.isArray(d[k]) && !d[k].length));
    const id = d?.id ?? j + 1;
    res("data_needs", !miss.length, !miss.length ? `data need ${str(id)}: ok` : `data need ${str(id)}: needs ${miss.join(", ")}`);
    const imp = d?.improves || [];
    for (const x of typeof imp === "string" ? [imp] : imp) covered.add(norm(x));
  });
  for (const g of [...new Set(gaps)]) {
    const ok = covered.has(norm(g));
    res("data_needs", ok, ok ? `${g}: data that would improve it are listed` : `${g} rests on judgment or an unchecked ` +
      `benchmark: add a data_needs entry whose "improves" names it (the assumption's parameter or the benchmark.csv ` +
      `measure, "${g}"), with the data, its effect, how to get it and from_user`);
  }
  if (needs === undefined || needs === null) {
    res("data_needs", false, "no data_needs: list the data that would make the estimates more accurate, or [] with a " +
      "data_needs_note saying why none would");
  } else if (!needs.length && !R.data_needs_note) {
    res("data_needs", false, "data_needs is empty: add a data_needs_note saying why no data would help");
  }

  const n = Object.values(bases).reduce((x, y) => x + y, 0);
  if (n) {
    note("assumption bases: " + BASES.filter((k) => k in bases).map((k) => `${k} ${bases[k]}`).join(", ") +
      ` (judgment ${Math.round((100 * (bases.judgment || 0)) / n)}%)`);
  }
  return out;
}

/** A benchmark cell as [value, rounding tolerance]: "$72,380" -> [72380, 0.5], "0.3" -> [0.3, 0.05]. null when the
 * cell is not one number ("219 D / 24 R", "not checked"). Zero decimals are dropped ("8.0" reads as 8). */
export function benchNumber(s: unknown): [number, number] | null {
  const m = match(NUM, strip(String(s ?? "")));
  if (!m) return null;
  let txt = m[1].replace(/,/g, "");
  if (txt.includes(".") && /^0*$/.test(txt.split(".")[1])) txt = txt.replace(/0+$/, "").replace(/\.$/, "");
  let tol: number;
  if (txt.includes(".")) tol = 0.5 * 10 ** -txt.split(".")[1].length;
  else {
    const digits = txt.replace(/^[+-]+/, "");
    const zeros = digits.replace(/^0+|0+$/g, "") ? digits.length - digits.replace(/0+$/, "").length : 0;
    // one or two trailing zeros are usually exact (570 laws, 931,960 million); three or more (140,000) read as
    // rounding, at most 0.1 percent
    tol = zeros < 3 ? 0.5 : Math.max(0.5, Math.min(0.5 * 10 ** zeros, Math.abs(Number(txt)) * 0.001));
  }
  return [Number(txt), tol];
}

export function factValues(facts: any): number[] {
  const out: number[] = [];
  for (const f of Object.values<any>(facts || {})) {
    const v = toFloat((f || {}).value);
    if (v !== null) out.push(v);
  }
  return out;
}

/** x (as written in benchmark.csv, maybe rounded and in percent or another scale) equals a registered fact. */
export function isFact(x: number, tol: number, values: number[]): boolean {
  for (const v of values) {
    for (const k of [1, 100, 0.01, 1e3, 1e-3, 1e6, 1e-6, 1e9, 1e-9, 1e12, 1e-12]) {
      if (Math.abs(Math.abs(v) * k - Math.abs(x)) <= tol * 1.0001 + 1e-12) return true;   // a fall may lose its sign
    }
  }
  return false;
}

/** Computed and published agree within the published rounding, or the computed value's own (5.66 vs 5.65891). */
export function benchAgree(c: [number, number], pb: [number, number]): boolean {
  return Math.abs(c[0] - pb[0]) <= Math.max(pb[1] * 1.0001, Math.abs(pb[0]) * 1e-6, Math.min(c[1] * 1.0001, Math.abs(pb[0]) * 0.005)) + 1e-12;
}

/** A note says the publisher rounds, and the gap is one its figure can show. */
export function roundingGap(c: [number, number], pb: [number, number], pub: unknown, noteText: unknown): boolean {
  const ps = String(pub ?? "");
  const digits = ps.split(".")[0].replace(/\D/g, "");
  const zeros = digits.replace(/^0+|0+$/g, "") && !ps.includes(".") ? digits.length - digits.replace(/0+$/, "").length : 0;
  return /\bround/i.test(String(noteText ?? "")) && Math.abs(c[0] - pb[0]) <= Math.max(10 * pb[1], zeros ? 0.5 * 10 ** zeros : 0);
}

function checkHeadlines(facts: any, rows: DictRow[]): Result[] {
  if (!facts || !Object.keys(facts).length) return [];
  const heads = Object.entries<any>(facts).filter(([, f]) => (f || {}).headline);
  if (!heads.length) {
    return [["benchmark", false, "no headline facts: register the numbers the answer leads with using the facts tool " +
      "(headline: true); each needs a benchmark.csv row"]];
  }
  const out: Result[] = [];
  for (const [n, f] of heads) {
    const keys = new Set([key(n), key(f.label)].filter((k) => k));
    const fv = toFloat(f.value);
    const v = fv === null ? [] : [fv];
    let hit = false;
    for (const r of rows) {
      const c = benchNumber(r.computed);
      if (keys.has(key(r.measure)) || (c && v.length && isFact(c[0], Math.max(c[1], Math.abs(c[0]) * 1e-9), v))) {
        hit = true;
        break;
      }
    }
    out.push(["benchmark", hit, hit ? `headline ${n}: benchmarked` : `headline ${n}: no benchmark.csv row: compare it with ` +
      `the agency's published figure (measure = ${n} or its label, computed = its value), or add a row with published ` +
      '"not checked" and a data_needs entry for it']);
  }
  return out;
}

/** benchmark.csv exists with rows; each numeric computed/published pair agrees within the published figure's
 * rounding unless a note explains the difference; a row never says it matches when it does not. */
export function checkBenchmark(base: string, facts?: any): Result[] {
  const p = path.join(base, "exhibits", "benchmark.csv");
  if (!fs.existsSync(p)) {
    return [["benchmark", false, "exhibits/benchmark.csv missing: compare each headline number with the agency's published " +
      "figure (" + BENCH_COLS.join(", ") + ', url, accessed); "not checked" when none exists']];
  }
  const [cols, rows, extra] = readCsv(p);
  const miss = BENCH_COLS.filter((c) => !cols.includes(c));
  if (miss.length || !rows.length) {
    return [["benchmark", false, `exhibits/benchmark.csv: ${miss.length ? "lacks columns " + repr(miss) : "no rows"}`]];
  }
  const out: Result[] = [], values = factValues(facts);
  let unchecked = 0, compared = 0, uncited = 0;
  rows.forEach((r, j) => {
    const i = j + 2;
    const label = `benchmark.csv line ${i} (${r.measure ?? ""}, ${r.period ?? ""})`;
    if (extra[j] || Object.values(r).includes(null)) {          // an unquoted comma shifts every column after it
      out.push(["benchmark", false, `${label}: ${extra[j] ? cols.length + extra[j]!.length : "fewer"} fields against the ` +
        `header's ${cols.length}: quote fields that contain commas (write the file with compute or a CSV writer)`]);
      return;
    }
    const pub = String(r.published ?? "");
    if (pub.toLowerCase().includes("not checked")) {
      unchecked++;
      return;
    }
    if (!strip(pub)) {
      out.push(["benchmark", false, `${label}: the published column is empty: give the published figure, or write "not ` +
        'checked" in it (and say why in the note)']);
      return;
    }
    const bound = match(BOUND, pub);                // "over 45", ">= 45", "at most 2": a published bound, not a figure
    if (bound && benchNumber(r.computed) && benchNumber(bound[2])) {
      let c0 = benchNumber(r.computed)![0], b0 = benchNumber(bound[2])![0];
      if (c0 < 0 && b0 < 0) [c0, b0] = [-c0, -b0];      // a fall "over 45 percent" written -45: compare sizes
      const up = [">", ">=", "≥", "over", "more than", "above", "at least"].includes(bound[1].toLowerCase());
      if (up ? c0 >= b0 : c0 <= b0) compared++;
      else out.push(["benchmark", false, `${label}: computed ${str(r.computed)} is outside the published bound ${pub}: find ` +
        "the cause or explain it in the note"]);
      return;
    }
    const c = benchNumber(r.computed), pb = benchNumber(pub);
    const noteText = strip(String(r.note || r.notes || ""));
    const sk = SAYS.find((k) => k in r && r[k]);
    const says = sk ? strip(String(r[sk])).toLowerCase() : "";
    if (c && values.length && !isFact(c[0], Math.max(c[1], Math.abs(c[0]) * 0.005), values)) uncited++;
    if (c === null || pb === null) {
      const flat = (x: unknown) => String(x ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      if (flat(r.computed) !== flat(pub) && !noteText && !says) {
        out.push(["benchmark", false, `${label}: computed and published are not single numbers and differ; add a match ` +
          "column (yes/no) and a note saying how they compare"]);
      }
      return;
    }
    compared++;
    const agree = benchAgree(c, pb);
    const rounding = roundingGap(c, pb, pub, noteText);
    if (!agree && says.startsWith("yes") && !rounding) {        // only a gap the size of a rounding is a match
      out.push(["benchmark", false, `${label}: says it matches, but computed ${str(r.computed)} differs from published ` +
        `${pub} by more than the published rounding (±${fmtG(pb[1])}); when the publisher rounds (to 4 significant ` +
        'digits, to $10), say so in the note; when the gap is sampling error, write match "within MOE" (not yes) and ' +
        "say so in the note; in the note"]);
    } else if (!agree && !noteText) {
      out.push(["benchmark", false, `${label}: computed ${str(r.computed)} vs published ${pub} differ by more than rounding ` +
        `(±${fmtG(pb[1])}); find the cause and fix it, or add a note column explaining the difference (definition, ` +
        "vintage, universe) and say so in the answer"]);
    }
  });
  out.push(...checkHeadlines(facts, rows));
  if (uncited && !out.some(([, ok]) => !ok)) {
    note(`benchmark.csv has ${uncited} computed value(s) not in facts.json: fine for cross-checks; the headline numbers the ` +
      "answer cites should be registered facts");
  }
  if (!out.some(([, ok]) => !ok)) {
    out.push(["benchmark", true, `${rows.length} benchmark rows: ${compared} compared within rounding or explained, ` +
      `${unchecked} not checked` + (uncited ? `, ${uncited} computed values not in facts.json (cross-checks)` : "")]);
  }
  return out;
}

/** A fact read from a CSV cell must match that cell; one without a source needs a derivation. */
export function checkFact(name: string, f: any, base: string): [boolean, string] {
  if (f.source) {
    const sp = path.join(base, f.source);
    if (!workspaceFile(f.source, base)) return [false, `${name}: source ${f.source} is outside the workspace`];
    if (!fs.existsSync(sp)) return [false, `${name}: source ${f.source} does not exist`];
    const where = isObj(f.where) ? f.where : {};
    const rows = readCsv(sp)[1].filter((r) => Object.entries(where).every(([k, v]) => str(r[k]) === str(v)));
    if (rows.length !== 1) return [false, `${name}: ${rows.length} rows in ${f.source} match ${str(f.where ?? null)}`];
    const raw = f.column !== undefined && f.column in rows[0] ? rows[0][f.column] : undefined;
    const cell = raw === undefined ? null : toFloat(raw);
    if (cell === null) return [false, `${name}: column ${str(f.column ?? null)} missing or not numeric`];
    const v = toFloat(f.value);
    const ok = v !== null && Math.abs(cell - v) <= 1e-9 * Math.max(1.0, Math.abs(cell));
    return [ok, ok ? `${name}: matches ${f.source}` : `${name}: facts.json ${str(f.value)} vs CSV ${pyFloatRepr(cell)}`];
  }
  if (!f.derivation) return [false, `${name}: no source cell and no derivation`];
  return [true, `${name}: derived (${String(f.derivation).slice(0, 60)})`];
}

/** --rerun: replay every exhibit's lineage and recompute every table fact (rerunWorkspace); facts.json and the
 * tracked exhibit CSVs must come out the same. Nothing in the workspace is changed. */
export async function rerun(base: string, fpath: string, tracked: string[]): Promise<Result[]> {
  if (!fs.existsSync(fpath)) return [["replication", false, "--rerun needs facts.json; register the facts first (the facts tool)"]];
  let r;
  try {
    r = await rerunWorkspace(base);
  } catch (e) {
    return [["replication", false, "the rerun failed: " + redact(e instanceof Error ? e.message : String(e)).slice(-400)]];
  }
  const out: Result[] = [];
  const orig = JSON.parse(fs.readFileSync(fpath, "utf8"));
  const diff = Object.entries(r.facts || {}).filter(([, v]) => !v.same).map(([k]) => k).sort();
  const detail = (k: string) => (r.facts[k] as { detail?: string }).detail;
  const tag = (k: string) => k + (!(k in orig) ? " (new: facts.json predates the recipe)" : detail(k) ? ` (${detail(k)})` : "");
  out.push(["replication", !diff.length, !diff.length ? "rerun reproduces every fact exactly"
    : `rerun changed facts: ${repr(diff.slice(0, 8).map(tag))}`]);
  const rel = (p: string) => (path.isAbsolute(p) ? path.relative(base, p) : p).replaceAll("\\", "/");
  const ex = new Map(Object.entries(r.exhibits || {}).map(([k, v]) => [rel(k), v]));
  for (const t of [...new Set(tracked)]) {
    const k = rel(t);
    const e = ex.get(k);
    if (!fs.existsSync(path.join(base, k))) {
      if (e) out.push(["replication", false, `rerun removed ${k}`]);
      continue;
    }
    const why = e?.detail || "the saved file differs from what its recipe (exhibits/lineage.json) computes now";
    if (e && !e.same) out.push(["replication", false, `rerun changed ${k}: ${why} (the file was left as it was)`]);
  }
  return out;
}

