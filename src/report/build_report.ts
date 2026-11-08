/**
 * Build a single self-contained HTML report or paper, and replication_package.zip, from report.json (a port of
 * report/build_report.py). The HTML has no external dependencies; charts are drawn by an inline script; the
 * AI-assistance disclaimer (guide/assets/disclaimer.txt) is always printed at the top of the page.
 *
 * What differs by source comes from each used source's policy.json (report.json "sources", else the data/<id>/
 * folders): notices (Data and Methods and the page footer), redistribution (policyset.ts decides what enters the
 * ZIP; definition_only sources get reproduce/<id>/ with download scripts, the request and REPRODUCE.md), withhold
 * (rows of withheld keys are dropped from shared CSVs unless a "clearance" lifts them), vintage (the Data Vintage
 * block from data/<id>/request.json), size (data files over 50 MB stay out with a note).
 *
 * The replication package carries the exhibit recipes (exhibits/lineage.json, written by compute) instead of an
 * analysis script: its REPLICATION.md says how to replay them with this server's tools (rerun, build_report,
 * audit_report). Nothing is ever written inside the server's package folder.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { GUIDE_DIR, ROOT } from "../core/env.js";
import { reportPathProblems } from "../core/guard.js";
import { holdsSecret } from "../core/keys.js";
import * as manual from "../core/manual.js";
import { pyJsonDumps } from "../core/py.js";
import * as pol from "../core/policy.js";
import type { Policy } from "../core/policy.js";
import { FMT_PATTERN, formatValue } from "../analysis/factfmt.js";
import * as MA from "./method_audit.js";
import * as PS from "./policyset.js";
import { knownKeys, scanText } from "./scan_secrets.js";
import { commas, escapeHtml, fmtG, readDict, readText, split, splitlines, str, strip, toFloat, writeDict } from "./py.js";

const TEMPLATE = path.join(GUIDE_DIR, "assets", "report_template.html");
const DISCLAIMER = path.join(GUIDE_DIR, "assets", "disclaimer.txt");
const EMBED_MAX = 400_000;
const SCRIPT_KINDS: Record<string, string> = { bash: ".sh", powershell: ".ps1" };

export class BuildError extends Error {}
function fail(msg: string): never {
  throw new BuildError(msg);
}

/** JSON.parse with a message that names the file, never quotes its text. */
function parseJson(text: string, name: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${name} is not valid JSON`);
  }
}

// ----------------------------------------------------------------------------- text helpers
const fnId = (n: unknown, scope?: string | null) => (scope ? `${scope}-${n}` : String(n));
const CITE_SRC = String.raw`\[@[A-Za-z0-9_-]+(?:\s*[;,]\s*@[A-Za-z0-9_-]+)*\]`;
const CITE_RE = new RegExp(CITE_SRC, "g");
let REF_LABELS = new Map<string, string>();

export function citedIds(text: string): Set<string> {
  const out = new Set<string>();
  for (const g of text.match(CITE_RE) || []) for (const m of g.matchAll(/@([A-Za-z0-9_-]+)/g)) out.add(m[1]);
  return out;
}

export const esc = (s: unknown) => escapeHtml(s === null || s === undefined ? "" : str(s));

export function inlineMd(s0: unknown, scope?: string | null): string {
  let s = escapeHtml(str(s0 ?? ""));
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/`(.+?)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\[\^(\d+)\]/g, (_m, n) => `<sup class="fn"><a href="#fn-${fnId(n, scope)}" id="fnref-${fnId(n, scope)}">${n}</a></sup>`);
  return s.replace(CITE_RE, (m) => "(" + [...m.matchAll(/@([A-Za-z0-9_-]+)/g)].map((x) =>
    `<a class="cite" href="#ref-${x[1]}">${escapeHtml(REF_LABELS.get(x[1]) ?? x[1])}</a>`).join("; ") + ")");
}

/** Paragraphs separated by blank lines; lines starting with '- ' become a list. */
export function blocksMd(text: unknown, scope?: string | null): string {
  if (Array.isArray(text)) return text.map((t) => blocksMd(t, scope)).join("");
  const out: string[] = [];
  for (const block of split(/\n\s*\n/, strip(text ? str(text) : ""))) {
    const lines = splitlines(block).filter((l) => strip(l));
    if (lines.length && lines.every((l) => /^\s*(?:- |\* )/.test(l))) {
      out.push("<ul>" + lines.map((l) => `<li>${inlineMd(l.trimStart().slice(2), scope)}</li>`).join("") + "</ul>");
    } else if (lines.length) out.push(`<p>${inlineMd(lines.join(" "), scope)}</p>`);
  }
  return out.join("");
}

function footnotesHtml(notes: unknown[], scope?: string | null, heading: string | null = "Notes"): string {
  if (!notes || !notes.length) return "";
  const items = notes.map((t, i) => `<li id='fn-${fnId(i + 1, scope)}'>${inlineMd(t, scope)} ` +
    `<a href='#fnref-${fnId(i + 1, scope)}' aria-label='Back to text'>↩</a></li>`).join("");
  const h = heading ? `<h2>${esc(heading)}</h2>` : "";
  return `<section class='prose ${heading ? "footnotes" : "footnotes part-notes"}'>${h}<ol>${items}</ol></section>`;
}

// ----------------------------------------------------------------------------- data helpers
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = strip(String(v)).replace(/,/g, "");
  if (s === "" || ["nan", "na", "none", "null"].includes(s.toLowerCase())) return null;
  return toFloat(s);
}

function key(v: unknown): string {
  const n = num(v);
  return n !== null && Number.isFinite(n) ? String(n) : str(v);
}

type Rows = Record<string, any>[];
function loadRows(ex: any, base: string): [Rows, string[], string] {
  if ("rows" in ex) {
    const rows: Rows = ex.rows || [];
    const cols = rows.length ? Object.keys(rows[0]) : [];
    return [rows, cols, writeDict(rows, cols, (v) => (v === null || v === undefined ? "" : str(v)))];
  }
  const text = readText(path.join(base, ex.data));
  const d = readDict(text);
  return [d.rows, d.fields, text.replace(/^﻿/, "")];
}

const REC_NOTE = "Shaded areas indicate recessions as dated by the National Bureau of Economic Research.";

function loadRecessions(base: string, rel: string): string[][] {
  const p = path.join(base, rel);
  if (!fs.existsSync(p)) {
    fail(`a chart asks for recession shading but ${rel} does not exist: save it with compute (columns start, end)`);
  }
  return readDict(readText(p)).rows.map((r) => [r.start ?? "", r.end ?? ""]);
}

function chartSpec(ex: any, rows0: Rows): any | null {
  const c = { ...(ex.chart || {}) };
  if (!Object.keys(c).length || c.type === "table") return null;
  let rows = rows0;
  for (const [k, v] of Object.entries(c.filter || {})) {
    const vals = new Set((Array.isArray(v) ? v : [v]).map(key));
    rows = rows.filter((r) => vals.has(key(r[k])));
  }
  const x = c.x;
  let cats: string[] = [];
  for (const r of rows) if (!cats.includes(key(r[x]))) cats.push(key(r[x]));
  if (c.x_order && c.x_order.length) {
    const order = c.x_order.map(key);
    cats = [...order.filter((v: string) => cats.includes(v)), ...cats.filter((v) => !order.includes(v))];
  }
  const scol = Array.isArray(c.y) ? null : c.series;
  const seen = new Map<string, number>();
  for (const r of rows) {                         // one value per (series, x), or the chart shows the last row
    const k = JSON.stringify([scol ? key(r[scol]) : "", key(r[x])]);
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  if (dup.length) {
    fail(`exhibit '${ex.title ?? ""}': ${dup.length} (series, ${x}) pairs have several rows, e.g. ${dup[0]}; add a chart ` +
      "'filter' (or 'series') so each point is one row");
  }
  const series = new Map<string, Map<string, number | null>>();
  if (Array.isArray(c.y)) for (const col of c.y) series.set(col, new Map(rows.map((r) => [key(r[x]), num(r[col])])));
  else {
    for (const r of rows) {
      const name = scol ? key(r[scol]) : c.series_name || ex.subtitle || c.y;
      if (!series.has(name)) series.set(name, new Map());
      series.get(name)!.set(key(r[x]), num(r[c.y]));
    }
  }
  let names = [...series.keys()];
  if (c.series_order && c.series_order.length) {
    const order = c.series_order.map(key);
    names = [...order.filter((n: string) => series.has(n)), ...names.filter((n) => !order.includes(n))];
  }
  if (names.length > 8) MA.note(`exhibit '${ex.title}' has ${names.length} series; more than 8 is unreadable. Fold into 'Other' or split.`);
  let dates: string[] | null = null;
  const dcol = c.date || "date";
  if ((c.type || "line") === "line" && rows.length && dcol in rows[0]) {
    const first = new Map<string, string>();
    for (const r of rows) if (!first.has(key(r[x]))) first.set(key(r[x]), String(r[dcol] ?? ""));
    dates = cats.map((k) => first.get(k) || "");
    if (!dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) dates = null;
  }
  return { type: c.type || "line", categories: cats, dates, recessions: c._recessions ?? null,
    series: names.map((n) => ({ name: n, values: cats.map((k) => series.get(n)!.get(k) ?? null) })),
    format: c.format || "number", decimals: c.decimals ?? null, y_min: c.y_min ?? null, y_max: c.y_max ?? null, x_label: c.x_label || "" };
}

// ----------------------------------------------------------------------------- render helpers
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];
function isoParts(s: unknown): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").slice(0, 10));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? [y, mo, d] : null;
}
export function longDate(s: unknown): string {
  if (!s) return "";
  const p = isoParts(s);
  return p ? `${MONTH_NAMES[p[1] - 1]} ${p[0]}` : str(s);
}
export function dayDate(s: unknown): string {
  const p = isoParts(s);
  return p ? `${MONTH_NAMES[p[1] - 1]} ${p[2]}, ${p[0]}` : str(s);
}

function disclaimerHtml(): string {
  const paras = split(/\n\s*\n/, fs.readFileSync(DISCLAIMER, "utf8")).map((p) => strip(p)).filter((p) => p);
  return '<aside class="disclaimer" role="note" aria-label="AI-generated content disclaimer">' +
    paras.map((p) => `<p>${esc(p)}</p>`).join("") + "</aside>";
}

function exhibitHtml(i: number, ex: any, spec: any, fname: string, mode = "report", scope?: string | null): string {
  const source = ex.source ? `<p class="source"><span>Data source:</span> ${inlineMd(ex.source, scope)}</p>` : "";
  const notes = ex.notes ? `<p class="notes"><span>Notes:</span> ${inlineMd(ex.notes, scope)}</p>` : "";
  const inner = `
  <p class="ex-num">Exhibit ${i}.</p>
  <h3>${esc(ex.title)}</h3>
  ${ex.subtitle ? `<p class="ex-sub">${esc(ex.subtitle)}</p>` : ""}
  <div class="legend" data-legend="${i}"></div>
  <div class="chart" data-chart="${i}" role="img" aria-label="${esc(ex.title)}"></div>
  <details class="table-view"${spec === null ? " open" : ""}>
    <summary>Data table</summary>
    <div class="table-wrap" data-table="${i}"></div>
    <button type="button" class="dl" data-download="${i}">Download ${esc(fname)}</button>
  </details>
  ${source}${notes}`;
  if (mode === "paper") return `\n<section class="exhibit" id="exhibit-${i}">${inner}\n</section>`;
  const text = ex.text ? `<div class="ex-text prose">${blocksMd(ex.text, scope)}</div>` : "";
  return `\n<section class="exhibit-page${text ? "" : " no-text"}" id="exhibit-${i}">${text}<div class="exhibit">${inner}\n</div></section>`;
}

// ----------------------------------------------------------------------------- facts
export const FACT_RE = new RegExp(String.raw`\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\s*(` + FMT_PATTERN + String.raw`))?\s*\}\}`, "g");
const ANY_PLACEHOLDER = /\{\{[^{}]*\}\}/g;
const SENTENCE_START = /(?:^|[.!?][*)"”’]*\s+|\n\s*(?:[-*]\s+)?|\*\*\s*)$/;

function fillFacts(R: any, facts: Record<string, any>, mode: string): [any, [string, string][]] {
  const used: [string, string][] = [], missing: string[] = [], bad: string[] = [];
  const rep = (s: string) => s.replace(FACT_RE, (all, name: string, fmt0: string | undefined, offset: number) => {
    if (!(name in facts)) {
      missing.push(name);
      return all;
    }
    const f = facts[name];
    const fmt = fmt0 || f.fmt || "raw";
    let out: string;
    try {
      out = formatValue(f.value, fmt, mode);
    } catch (e) {
      bad.push(`${name}|${fmt}: ${(e as Error).message}`);
      return all;
    }
    used.push([name, fmt]);                           // the format as cited, which may override the default
    if (out[0] && out[0] !== out[0].toUpperCase() && SENTENCE_START.test(s.slice(0, offset))) out = out[0].toUpperCase() + out.slice(1);
    return out;
  });
  const walk = (x: any): any => {
    if (typeof x === "string") return rep(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, ["data", "chart", "path"].includes(k) ? v : walk(v)]));
    return x;
  };
  const keepKeys = ["data_files", "facts", "provenance", "request", "sources", "replication"];
  const out: any = {};
  for (const [k, v] of Object.entries(R)) out[k] = keepKeys.includes(k) ? v : walk(v);
  if (missing.length) fail("report.json cites facts that are not in facts.json: " + [...new Set(missing)].sort().join(", "));
  if (bad.length) fail("fact formats that cannot be applied: " + bad.join("; "));
  return [out, used];
}

const fileSha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// ----------------------------------------------------------------------------- sources and package
class Ctx {
  ids: string[];
  policies: Record<string, Policy> = {};
  prov: Record<string, [string | null, any]> = {};
  withheld: Record<string, Set<string>> = {};
  notices: string[];
  constructor(public R: any, public base: string) {
    this.ids = PS.usedSources(base, R);
    try {
      this.policies = PS.loadPolicies(this.ids);
    } catch (e) {
      fail((e as Error).message);
    }
    for (const sid of this.ids) this.prov[sid] = PS.provenance(base, sid, R);
    for (const [sid, P] of Object.entries(this.policies)) this.withheld[sid] = PS.withheldKeys(base, sid, P, R);
    this.notices = pol.notices(Object.values(this.policies));
  }
  title(sid: string): string {
    return this.policies[sid].title;
  }
}

const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();

/** Top-level files of the package: the request, facts, decisions, report and every exhibit CSV and recipe. */
function replicationFiles(R: any, base: string): string[] {
  const repl = R.replication || {};
  const want: string[] = [...(repl.files || ["spec.json", "plan.json", "analysis.py", "facts.json", "decisions.json", "report.json"])];
  want.push(...(R.exhibits || []).filter((e: any) => e.data).map((e: any) => e.data));
  const exdir = path.join(base, "exhibits");
  if (fs.existsSync(exdir)) want.push(...fs.readdirSync(exdir).filter((f) => f.endsWith(".csv") || f.endsWith(".json")).sort().map((f) => `exhibits/${f}`));
  want.push(...(repl.extra || []));
  return [...new Set(want)].filter((w) => isFile(path.join(base, w))).map((w) => w.replaceAll("\\", "/"));
}

function tree(base: string, top: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(base, p).replaceAll("\\", "/"));
    }
  };
  walk(path.join(base, top));
  return out.sort();
}

export type Member = { name: string; path: string; filter: [string, Set<string>] | null };
export type Excluded = { name: string; reason: string; policy: boolean };

function planPackage(ctx: Ctx): [Member[], Excluded[]] {
  const names = [...replicationFiles(ctx.R, ctx.base), ...tree(ctx.base, "data"), ...tree(ctx.base, "reproduce")];
  const members: Member[] = [], excluded: Excluded[] = [];
  for (const n of [...new Set(names)]) {
    if (n.endsWith(".pyc") || n.includes("/__pycache__/")) continue;
    const d = PS.decide(n, ctx.base, ctx.policies, ctx.R, ctx.withheld);
    if (d.ok) members.push({ name: n, path: path.join(ctx.base, n), filter: d.filter });
    else excluded.push({ name: n, reason: d.reason, policy: d.policy });
  }
  return sizeRule(members, excluded);
}

/** A data CSV larger than this stays out of the package when its table can be had otherwise (the terms allow it in:
 * this is about size only). A 37 MB microdata CSV made a 10 MB ZIP that took 3.4 s to write on every build. */
export const PACKAGE_CSV_MAX = { value: 10_000_000 };

/** One copy of each data table: a large CSV gives way to its Parquet copy, or to a re-fetch from its request; a small
 * CSV keeps its place and its Parquet copy stays out. */
export function sizeRule(members: Member[], excluded: Excluded[]): [Member[], Excluded[]] {
  const byName = new Map(members.map((m) => [m.name, m]));
  const drop = new Map<string, string>();
  for (const m of members) {
    const k = /^(data\/[^/]+\/.+)\.csv$/i.exec(m.name);
    if (!k) continue;
    const pq = byName.get(`${k[1]}.parquet`);
    const large = (x: Member) => !x.filter && fs.statSync(x.path).size > PACKAGE_CSV_MAX.value;
    const mb = Math.floor(PACKAGE_CSV_MAX.value / 1_000_000);
    const refetch = `fetch it again with the spec in ${m.name.split("/").slice(0, 2).join("/")}/request.json`;
    if (!large(m)) {
      if (pq) drop.set(pq.name, `the same table as ${m.name}, which is in the package`);
    } else if (pq && !large(pq)) {
      drop.set(m.name, `larger than ${mb} MB: the same table is in ${pq.name}`);
    } else {
      drop.set(m.name, `larger than ${mb} MB: ${refetch}`);
      if (pq) drop.set(pq.name, `the same table as ${m.name}, also larger than ${mb} MB: ${refetch}`);
    }
  }
  if (!drop.size) return [members, excluded];
  return [members.filter((m) => !drop.has(m.name)),
    [...excluded, ...[...drop].map(([name, reason]) => ({ name, reason, policy: false }))]];
}

/** The request to rebuild one source's data: its provenance "spec", report.json sources[].spec, or spec.json. */
function sourceSpec(ctx: Ctx, sid: string): any | null {
  const P = ctx.prov[sid][1];
  if (P?.spec && typeof P.spec === "object" && !Array.isArray(P.spec) && Object.keys(P.spec).length) return P.spec;
  for (const s of ctx.R.sources || []) {
    if (s && typeof s === "object" && (s.source || s.id) === sid && s.spec && typeof s.spec === "object") return s.spec;
  }
  const sp = path.join(ctx.base, "spec.json");
  if (ctx.ids.length === 1 && fs.existsSync(sp)) return JSON.parse(readText(sp));
  return null;
}

/** {bash, powershell} rel paths of the download scripts in reproduce/<id>/ (empty when not both). */
function reproduceScripts(base: string, sid: string): Record<string, string> {
  const d = path.join(base, "reproduce", sid);
  const out: Record<string, string> = {};
  for (const [kind, ext] of Object.entries(SCRIPT_KINDS)) {
    const hits = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(ext)).sort() : [];
    if (hits.length) out[kind] = `reproduce/${sid}/${hits[0]}`;
  }
  return Object.keys(out).length === Object.keys(SCRIPT_KINDS).length ? out : {};
}

function manualItemsFor(ctx: Ctx, sid: string): any[] {
  try {
    const m = JSON.parse(readText(path.join(ctx.base, "manual_download", "manifest.json")));
    return (m.items || []).filter((it: any) => it.source === sid);
  } catch {
    return [];
  }
}

/** reproduce/<id>/ for a definition_only source: download scripts with the request built in, spec.json and
 * REPRODUCE.md. No data files. */
function writeReproduce(ctx: Ctx, sid: string): void {
  const P = ctx.policies[sid];
  const d = path.join(ctx.base, "reproduce", sid);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  const spec = sourceSpec(ctx, sid);
  if (spec !== null) fs.writeFileSync(path.join(d, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
  const rel = `reproduce/${sid}`;
  const items = manualItemsFor(ctx, sid);
  if (items.length) manual.writeScripts(d, items, `download_${sid}`);
  const copied: string[] = [];
  if (!Object.keys(reproduceScripts(ctx.base, sid)).length) {   // no scripts: the analysis's own bundle, as is
    const mdir = path.join(ctx.base, "manual_download", sid);
    for (const f of tree(ctx.base, `manual_download/${sid}`)) {
      const src = path.join(ctx.base, f), relF = path.relative(mdir, src).replaceAll("\\", "/");
      if (PS.isMicrodata(P, relF) || fs.statSync(src).size > PS.LIMITS.MICRO_MAX || path.basename(f).startsWith("extract_number_")) continue;
      fs.mkdirSync(path.dirname(path.join(d, "manual", relF)), { recursive: true });
      fs.copyFileSync(src, path.join(d, "manual", relF));
      copied.push(relF);
    }
  }
  const scripts = reproduceScripts(ctx.base, sid);
  const inc = tree(ctx.base, `data/${sid}`).filter((f) => PS.decide(f, ctx.base, ctx.policies, ctx.R, ctx.withheld).ok);
  const specArg = spec !== null ? `${rel}/spec.json` : `<spec.json for ${sid}>`;
  const a: any = P.auth || {};
  const keys: [string, string][] = ["required", "optional"].includes(a.required) && a.env && a.signup_url ? [[a.env, a.signup_url]] : [];
  const lines = [`# Reproduce the ${P.title} data`, "",
    `The terms of this source do not allow its data files to be shared (${P.redistribution.why || ""}). This folder holds ` +
    "what is needed to download the same data under your own account; the analysis then runs unchanged.", ""];
  if (Object.keys(scripts).length) {
    const stem = path.posix.basename(scripts.bash).replace(/\.[^.]*$/, "");
    const scriptDir = path.posix.dirname(scripts.bash);
    lines.push("## Download: one command", "", ...manual.runSection(stem, keys, scriptDir, "spec.json"));
    lines.push("## Then: package the files and rerun the analysis", "",
      "With the data-analyst-mcp server, in a session whose workspace holds this package (on a remote server, upload the " +
      "downloaded files on its upload page first):", "", "```",
      `ingest {"source": "${sid}", "spec": <the content of ${specArg}>, "files": ["${scriptDir}"]}`,
      "rerun {}", "```", "");
  } else {
    lines.push("## With the data-analyst-mcp server", "", "```",
      `fetch {"source": "${sid}", "spec": <the content of ${specArg}>}`, "rerun {}", "```", "",
      "fetch says which route works for you (a key, a keyless route, or a manual-download bundle) and downloads the data " +
      `into \`data/${sid}/\`. If you download the files by hand, package them with ` +
      `\`ingest {"source": "${sid}", "spec": <the content of ${specArg}>, "files": [<the files>]}\`.`, "");
  }
  lines.push("## By hand", "", P.routes?.manual?.how || "", "");
  if (copied.length) lines.push("The manual-download bundle of the original analysis is in `manual/`.", "");
  if (inc.length) lines.push("## The original request", "", "Shared in the package (no data):", "", ...inc.map((f) => `- \`${f}\``), "");
  if (keys.length && !Object.keys(scripts).length) lines.push(`A free key (${keys[0][0]}) is available at ${keys[0][1]}.`, "");
  fs.writeFileSync(path.join(d, "REPRODUCE.md"), lines.join("\n"));
}

const REPRODUCE_ORDER = ["REPRODUCE.md", ".sh", ".ps1", "spec.json", ".json", ".md"];

function reproduceShown(base: string, sid: string): string[] {
  const rank = (f: string) => {
    const i = REPRODUCE_ORDER.findIndex((k) => f.endsWith(k));
    return i < 0 ? REPRODUCE_ORDER.length : i;
  };
  return tree(base, `reproduce/${sid}`).filter((f) => !f.endsWith(".txt")).sort((a, b) => {
    const [x, y] = [path.posix.basename(a), path.posix.basename(b)];
    return rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0);
  });
}

function replicationReadme(ctx: Ctx, excluded: Excluded[]): string {
  const R = ctx.R;
  const lines = [`# Replication materials: ${R.title ?? ""}`, "",
    "This package holds what is needed to reproduce every number, exhibit and chart in the report, within the terms of " +
    "each data source.", "",
    "1. Use the data-analyst-mcp server (an MCP server for U.S. government data) in a session whose workspace holds this " +
    "package's files.",
    "2. Get the data (by source, below).",
    "3. Recompute: `exhibits/lineage.json` holds the recipe of every exhibit (its inputs with their SHA-256 checksums and " +
    "the `compute` steps). The server's `rerun` tool replays every recipe and recomputes every fact in `facts.json` from " +
    "its exhibit cell.",
    "4. Compare the recomputed values with `facts.json`. They must be identical when the data are the ones used (see the " +
    "retrieval dates below).",
    "5. Rebuild and audit the report: `build_report` with `report.json`, then `audit_report` with `rerun: true`.", "",
    "## Data by source", ""];
  for (const sid of ctx.ids) {
    const P = ctx.policies[sid];
    const mode = P.redistribution.mode;
    const [provRel, prov] = ctx.prov[sid];
    const when = prov.retrieved || prov.downloaded || "";
    let head = `- **${P.title}** (\`data/${sid}/\`)` + (when ? `, retrieved ${dayDate(when)}` : "") + ": ";
    if (mode === "allowed") head += "the data are included as retrieved (the vintage used).";
    else if (mode === "aggregates_only") head += "tables of estimates are included; row-level files stay with the analyst.";
    else {
      head += "no data files are included; the terms forbid sharing them. ";
      const sc = reproduceScripts(ctx.base, sid);
      if (Object.keys(sc).length) {
        const c = manual.runLines(path.posix.basename(sc.bash).replace(/\.[^.]*$/, ""), path.posix.dirname(sc.bash));
        head += `Download the same data under your own account with one command: \`${c.bash}\` (macOS, Linux) or ` +
          `\`${c.powershell}\` (Windows); the request is built into the scripts. Then follow \`reproduce/${sid}/REPRODUCE.md\`.`;
      } else head += `Download the same data under your own account with \`reproduce/${sid}/REPRODUCE.md\`.`;
    }
    lines.push(head + ` Rule: ${mode}. ${P.redistribution.why || ""}`);
    if (ctx.withheld[sid]?.size) {
      const w = P.redistribution.withhold;
      lines.push(`  - Rows of ${[...ctx.withheld[sid]].sort().join(", ")} (${w.key}) are left out of the shared files: their ` +
        "terms do not allow redistribution. Download them again with your own access.");
    }
    if (mode !== "definition_only") {
      lines.push(`  - Current data: call \`fetch\` with source \`${sid}\`, the spec in ` + (provRel ? `\`${provRel}\`` : "spec.json") +
        " and `force: true`. Sources revise published data, so new numbers can differ from the report.");
    }
  }
  const out = excluded.filter((e) => !e.name.startsWith("lib/") && !e.name.startsWith("reproduce/"));
  if (out.length) {
    lines.push("", "## Not included", "", ...out.slice(0, 60).map((e) => `- \`${e.name}\`: ${e.reason}`));
    if (out.length > 60) lines.push(`- and ${out.length - 60} more files`);
  }
  lines.push("", "## Contents", "",
    "- `spec.json` / `plan.json`: the data request; `exhibits/lineage.json`: the recipe of every exhibit; `facts.json`: " +
    "every number in the text, with its source cell or derivation; `decisions.json`: the method record.",
    "- `data/<id>/`: each source's files as its terms allow, with `request.json` (exact requests without keys, retrieval " +
    "time) and `README.md` (citation, terms).",
    "- `exhibits/`: the data for each exhibit; `reproduce/`: download instructions for sources whose data may not be shared.", "");
  const cites: string[] = R.citation ? [str(R.citation)] : [];
  if (!cites.length) {
    for (const s of ctx.ids) {
      const P = ctx.prov[s][1];
      const v = P.vintage;
      cites.push(pol.citation(ctx.policies[s], str(P.route || ""), { retrieved: String(P.retrieved || P.downloaded || "").slice(0, 10),
        dataset: str(P.spec?.description || ctx.title(s)), vintage: v === null || v === undefined || v === "latest" ? "" : str(v) }));
    }
  }
  if (cites.length) lines.push("## Data citations", "", ...cites, "");
  if (ctx.notices.length) lines.push("## Notices", "", ...ctx.notices.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

function makePackage(ctx: Ctx): [string, Member[], Excluded[]] {
  const [members, excluded] = planPackage(ctx);
  const zp = path.join(ctx.base, "replication_package.zip");
  const files: Record<string, [Uint8Array, { level: 6 }]> = {};
  files["REPLICATION.md"] = [Buffer.from(replicationReadme(ctx, excluded), "utf8"), { level: 6 }];
  knownKeys();
  const leaked: string[] = [];
  const digest = crypto.createHash("sha256");
  for (const name of Object.keys(files)) digest.update(`${name}\u0000`).update(files[name][0]);
  for (const m of members) {
    const data = m.filter ? Buffer.from(PS.filteredCsv(m.path, m.filter[0], m.filter[1])[0], "utf8") : fs.readFileSync(m.path);
    if (holdsSecret(data)) leaked.push(m.name);
    files[m.name] = [data, { level: 6 }];
    digest.update(`${m.name}\u0000`).update(data);
  }
  // checked before anything is written: a package with a key in it is never made, not even in part
  if (leaked.length) {
    fs.rmSync(zp, { force: true });
    fail(`an API key is in ${str(leaked.slice(0, 5))}; no replication package was written (remove it and build again)`);
  }
  // the same members with the same bytes as the ZIP already there: it is not written again (zipping is the slow part)
  const sum = digest.digest("hex");
  const mf = path.join(ctx.base, ".replication_package.sha256");
  const same = fs.existsSync(zp) && fs.existsSync(mf) && fs.readFileSync(mf, "utf8").trim() === `${sum} ${fileSha(zp)}`;
  if (!same) {
    try {
      fs.writeFileSync(zp + ".part", zipSync(files));
      fs.renameSync(zp + ".part", zp);
    } finally {
      fs.rmSync(zp + ".part", { force: true });
    }
    fs.writeFileSync(mf, `${sum} ${fileSha(zp)}\n`);
  }
  // a last guard: the policy check of core on everything that went in
  const names = members.map((m) => m.name);
  const bad = new Set<string>();
  for (const [sid, P] of Object.entries(ctx.policies)) {
    const scope = names.filter((n) => n.startsWith(`data/${sid}/`) || !["data/", "exhibits/", "lib/"].some((x) => n.startsWith(x)));
    for (const b of PS.checkPackage(P, scope)) bad.add(b);
  }
  if (bad.size) {
    fs.rmSync(zp, { force: true });
    fail(`the package would hold files the source terms forbid: ${str([...bad].sort().slice(0, 5))}`);
  }
  return ["replication_package.zip", members, excluded];
}

// ----------------------------------------------------------------------------- data and methods: vintage, notices
const SERIES_COLS = ["series_id", "title", "units", "frequency", "seasonal_adjustment", "first_date", "last_date", "vintage",
  "last_updated", "n_future", "n_missing", "converted_to", "transformation", "copyright"];
const SKIP_SCAN = ["series.csv", "data_dictionary.csv", "codebook.csv", "variables.csv", "notes.csv"];

function periodText(lp: unknown): string {
  const m = /^(\d{4}) ?([MQS])(\d\d)$/.exec(str(lp));
  if (!m) return str(lp);
  const [y, k, n] = [m[1], m[2], Number(m[3])];
  if (k === "M" && n >= 1 && n <= 12) return `${MONTH_NAMES[n - 1]} ${y}`;
  if (k === "Q" && n >= 1 && n <= 4) return `the ${["first", "second", "third", "fourth"][n - 1]} quarter of ${y}`;
  if (k === "S" && (n === 1 || n === 2)) return `the ${n === 1 ? "first" : "second"} half of ${y}`;
  return str(lp);
}

function vintText(v0: unknown): string {
  const v = str(v0);
  const named: Record<string, string> = { latest: "latest available", first_release: "first release", all: "full revision history" };
  if (v in named) return named[v];
  if (v.includes(":") || /^\d{4}-\d\d-\d\d/.test(v)) {
    const tail = v.includes(":") ? v.split(":").slice(1).join(":") : v;
    return "as published on " + tail.split(",").map(dayDate).join(", ");
  }
  return v;
}

function flagsAndGaps(base: string, sid: string, P: any): [string[], string[]] {
  const used = new Set<string>(P.used_series || []);
  const prelim = new Set<string>(), gaps = new Set<string>();
  for (const rel of tree(base, `data/${sid}`)) {
    const full = path.join(base, rel);
    if (!rel.endsWith(".csv") || SKIP_SCAN.includes(path.posix.basename(rel)) || rel.includes("/raw/")) continue;
    if (fs.statSync(full).size > PS.LIMITS.MICRO_MAX) continue;
    const cols = PS.csvHeader(full);
    if (!cols.includes("preliminary") && !(cols.includes("value") && cols.includes("series_id"))) continue;
    for (const r of readDict(readText(full)).rows) {
      const sidv = r.series_id ?? "";
      if (used.size && sidv && !used.has(sidv)) continue;
      const per = r.period_name ? `${r.period_name} ${r.year}` : r.date || r.period || r.time_period || "";
      if (["1", "true", "yes", "p"].includes(strip(String(r.preliminary ?? "")).toLowerCase())) prelim.add(strip(`${sidv} ${per}`));
      if (cols.includes("value") && cols.includes("series_id") && strip(String(r.value ?? "")) === "") gaps.add(per);
    }
  }
  return [[...prelim].sort(), [...gaps].sort()];
}

function vintageHtml(ctx: Ctx): string {
  const parts: string[] = [], tables: string[] = [];
  for (const sid of ctx.ids) {
    const [provRel, P] = ctx.prov[sid];
    const T = ctx.title(sid);
    if (!provRel) {
      parts.push(`<p class='vintage'>${esc(T)}: no provenance file was found in <code>data/${esc(sid)}/</code>, so the retrieval date is not recorded.</p>`);
      continue;
    }
    const when = P.retrieved || P.downloaded || "";
    const route = P.route || "", acq = P.acquired || "";
    let txt = `${T}: retrieved on ${when ? dayDate(when) : "an unrecorded date"}`;
    if (route || acq) txt += " by the " + [...new Set([str(route), str(acq)])].filter((x) => x).join(" / ") + " route";
    if (P.api_version) txt += ` (${str(P.api_version)})`;
    const vf = PS.vintageFields(P);
    const v = vf.vintage;
    if (v && v !== "latest") txt += "; vintage " + (Array.isArray(v) ? v.slice(0, 4).map(str).join("; ") : vintText(v));
    if (vf.series_vintages) txt += "; series vintages " + vf.series_vintages.map(str).join(", ");
    const lp = P.latest_period || P.latest;
    if (lp && typeof lp === "object" && !Array.isArray(lp)) txt += "; latest observation " + Object.entries(lp).map(([k, x]) => `${k} ${str(x)}`).join("; ");
    else if (lp) txt += `; the latest period in the data is ${periodText(lp)}`;
    if (P.spec?.as_of) txt += `; data cut-off ${str(P.spec.as_of)}`;
    parts.push(`<p class='vintage'>${esc(txt)}.</p>`);
    const [prelim, gaps] = flagsAndGaps(ctx.base, sid, P);
    if (prelim.length) parts.push("<p class='vintage'>Values marked preliminary at retrieval: " + esc(prelim.slice(0, 12).join("; ")) + (prelim.length > 12 ? "; and others" : "") + ".</p>");
    if (gaps.length) {
      parts.push("<p class='vintage'>Periods with no published value in the series used: " + esc(gaps.slice(0, 12).join(", ")) +
        (gaps.length > 12 ? " and others" : "") + ". These gaps were left empty, not interpolated.</p>");
    }
    const dropped = P.options_dropped || P.v2_options_dropped;
    if (dropped && dropped.length) parts.push("<p class='vintage'>Requested but unavailable on the route used: " + esc(dropped.map(str).join(", ")) + ".</p>");
    for (const pr of (P.problems || []).slice(0, 5)) parts.push(`<p class='vintage'>${esc(T)}: ${esc(pr)}</p>`);
    const sp = path.join(ctx.base, "data", sid, "series.csv");
    if (fs.existsSync(sp)) {
      const meta = readDict(readText(sp)).rows;
      const cols = SERIES_COLS.filter((c) => meta.length && c in meta[0]);
      if (meta.length && cols.includes("series_id")) {
        const head = cols.map((c) => `<th>${esc(c.replaceAll("_", " ").replace(/^./, (x) => x.toUpperCase()))}</th>`).join("");
        const body = meta.map((m) => "<tr>" + cols.map((c) => `<td>${esc(c === "vintage" && m[c] ? vintText(m[c]) : m[c] ?? "")}</td>`).join("") + "</tr>").join("");
        tables.push(`<div class='table-wrap'><table class='audit'><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      }
      const cites = meta.filter((m) => m.citation).map((m) => m.citation);
      if (cites.length) tables.push("<h3>Series Citations</h3><ul class='files'>" + cites.map((c) => `<li>${esc(c)}</li>`).join("") + "</ul>");
    }
  }
  if (!parts.length) return "";
  parts.push("<p class='vintage'>Sources revise their published data (benchmark and seasonal revisions, later releases of " +
    "preliminary values), so a later retrieval can differ from the data used here.</p>");
  return "<h3>Data Vintage</h3>" + parts.join("") + tables.join("");
}

const noticesHtml = (ctx: Ctx) => (ctx.notices.length ? "<h3>Required Notices</h3><ul class='notices'>" +
  ctx.notices.map((n) => `<li>${esc(n)}</li>`).join("") + "</ul>" : "");

function footerHtml(ctx: Ctx): string {
  const srcs = ctx.ids.map((s) => ctx.title(s)).join("; ");
  return (srcs ? `<p>Data: ${esc(srcs)}. Sources revise published data; later retrievals can differ.</p>` : "") +
    ctx.notices.map((n) => `<p>${esc(n)}</p>`).join("");
}

// ----------------------------------------------------------------------------- appendix blocks
function referencesHtml(R: any): string {
  const refs = R.references || [];
  if (!refs.length) return "";
  const items = refs.map((r: any) => {
    const url = r.url ? ` <a href='${esc(r.url)}'>${esc(r.url)}</a>` : "";
    const acc = r.accessed ? ` (accessed ${esc(r.accessed)})` : "";
    const use = r.used_for ? `<br><span class='muted'>Used for: ${esc(r.used_for)}</span>` : "";
    return `<li id='ref-${esc(r.id)}'>${inlineMd(r.citation ?? "")}.${url}${acc}${use}</li>`;
  });
  return `<section class='prose references' id='references'><h2>References</h2><ol>${items.join("")}</ol></section>`;
}

function assumptionsHtml(R: any): string {
  const rows = R.assumptions || [];
  if (!rows.length) return "";
  const judged = rows.some((a: any) => String(a.basis || "").toLowerCase() === "judgment");
  const why = (a: any) => String(a.basis || "").toLowerCase() !== "judgment" ? "" :
    `<td>${inlineMd(a.why_not_empirical ?? "")} Sensitivity: <code>exhibits/sensitivity.csv</code>, ${esc(a.sensitivity || a.parameter || "")}.</td>`;
  const trs = rows.map((a: any) => `<tr><td>${inlineMd(a.parameter ?? "")}</td><td>${inlineMd(a.value ?? "")}</td>` +
    `<td>${esc(a.basis ?? "")}</td><td>${inlineMd(a.evidence ?? "")}</td>${judged ? why(a) || "<td></td>" : ""}</tr>`).join("");
  return "<h3>Key Assumptions and Parameters</h3><div class='table-wrap'><table class='audit'>" +
    `<thead><tr><th>Parameter</th><th>Value</th><th>Basis</th><th>Evidence</th>${judged ? "<th>Why Not Empirical</th>" : ""}</tr></thead>` +
    `<tbody>${trs}</tbody></table></div>`;
}

function decisionsHtml(R: any): string {
  const out: string[] = [];
  const qs = R.questions || [];
  if (qs.length) {
    const how: Record<string, string> = { dont_know: "Don't know", skipped: "Skipped (treated as Don't know)", not_asked: "Not asked" };
    const trs = qs.map((q: any) => {
      const no = [null, undefined, "", ...MA.NO_ANSWER].includes(q.answer);
      let ans = no ? how[q.how || q.answer || "not_asked"] ?? "Don't know" : str(q.answer);
      if (!MA.asked(q) && q.reason_code === "settled_by_request" && q.request) ans = `Settled by the request: “${q.request}”`;
      else if (!MA.asked(q) && (q.reason_code || q.reason)) ans += ` (${MA.NOT_ASKED_CODES[q.reason_code] ?? (q.reason || q.reason_code)})`;
      let dec = q.resolution || (no ? "" : "As answered");
      if (q.blocking && q.rationale) dec += `; ${q.rationale}`;
      return `<tr><td>${inlineMd(q.question ?? q.id ?? "")}</td><td>${inlineMd(ans)}</td><td>${inlineMd(dec)}</td></tr>`;
    });
    out.push("<h3>Questions and Decisions</h3><div class='table-wrap'><table class='audit'><thead><tr><th>Question</th>" +
      `<th>Answer</th><th>How It Was Decided</th></tr></thead><tbody>${trs.join("")}</tbody></table></div>`);
  }
  const lit = R.literature_search || [];
  if (lit.length) {
    const items = lit.map((s: any) => {
      if (s.unavailable) {
        const why = MA.UNAVAILABLE_CODES[s.reason_code] ?? (s.reason_code || "");
        return `<li>Literature search was not available: ${inlineMd(why + (s.reason ? ` (${s.reason})` : ""))}</li>`;
      }
      const found = (s.found || []).map((i: string) => `[@${i}]`).join(", ") || "nothing relevant";
      return `<li>&ldquo;${esc(s.query ?? "")}&rdquo; (${esc(s.date ?? "")}${s.tool ? `, ${esc(s.tool)}` : ""}): ${inlineMd(found)}.` +
        `${s.note ? ` ${inlineMd(s.note)}` : ""}</li>`;
    });
    out.push(`<h3>Literature Searched</h3><ul>${items.join("")}</ul>`);
  }
  const disc = MA.escapes(R).map(([k]) => (R.disclosures || {})[k]).filter((t) => t);
  if (disc.length) out.push("<h3>Not Verified by the Audit</h3><ul>" + disc.map((t) => `<li>${inlineMd(t)}</li>`).join("") + "</ul>");
  return out.join("");
}

function dataNeedsHtml(R: any): string {
  const needs = [...(R.data_needs || [])].sort((a: any, b: any) => Number(!a.from_user) - Number(!b.from_user));
  if (!needs.length) {
    return R.data_needs_note ? `<h3 id='data-needs'>Data That Would Improve These Estimates</h3><p>${inlineMd(R.data_needs_note)}</p>` : "";
  }
  const trs = needs.map((d: any) => `<tr><td>${inlineMd(d.data ?? "")}</td><td>${inlineMd(d.effect ?? "")}</td>` +
    `<td>${inlineMd(d.how_to_get ?? "")}${d.from_user ? " (from you)" : ""}</td></tr>`).join("");
  return "<h3 id='data-needs'>Data That Would Improve These Estimates</h3><div class='table-wrap'><table class='audit'>" +
    `<thead><tr><th>Data</th><th>What It Would Improve</th><th>How to Get It</th></tr></thead><tbody>${trs}</tbody></table></div>`;
}

function replicationHtml(ctx: Ctx, outDir: string, pkg: string | null, members: Member[], excluded: Excluded[], mode: string): [string, any[]] {
  const base = ctx.base;
  const rel = (p: string) => path.relative(outDir, path.join(base, p)).replaceAll("\\", "/");
  const shown = replicationFiles(ctx.R, base);
  for (const sid of ctx.ids) shown.push(...[ctx.prov[sid][0], `data/${sid}/README.md`].filter((x): x is string => !!x));
  const defonly = ctx.ids.filter((sid) => ctx.policies[sid].redistribution.mode === "definition_only");
  for (const sid of defonly) shown.push(...reproduceShown(base, sid));
  const inPkg = new Map(members.map((m) => [m.name, m]));
  const embeds: any[] = [], blocks: string[] = [];
  [...new Set(shown.filter((x) => !x.startsWith("exhibits/")))].forEach((f, k) => {
    const fp = path.join(base, f);
    const m = inPkg.get(f);
    if (!m || !isFile(fp)) return;
    if (m.filter) {
      blocks.push(`<li><code>${esc(f)}</code> (in the package, without the rows of ${esc([...m.filter[1]].sort().join(", "))}: not cleared for redistribution)</li>`);
      return;
    }
    if (fs.statSync(fp).size > EMBED_MAX) {
      blocks.push(`<li><a href='${esc(rel(f))}'>${esc(f)}</a> (large file; it is in the package)</li>`);
      return;
    }
    const text = fs.readFileSync(fp).toString("utf8");
    const name = path.posix.basename(f);
    embeds.push({ id: `att-${k}`, name, text });
    blocks.push(`<li><details><summary><code>${esc(f)}</code></summary><button type='button' class='dl' data-attach='att-${k}'>` +
      `Download ${esc(name)}</button><pre class='code'>${esc(text)}</pre></details></li>`);
  });
  const held = excluded.filter((e) => e.policy && !e.name.startsWith("lib/") && !e.name.startsWith("reproduce/"));
  const heldHtml = held.length ? "<p>Not in the package because of the source terms: " + held.slice(0, 8).map((e) =>
    `<code>${esc(e.name)}</code> (${esc(e.reason)})`).join("; ") + (held.length > 8 ? `; and ${held.length - 8} more` : "") + ".</p>" : "";
  const pkgHtml = pkg ? `<p><a class='pkg' href='${esc(rel(pkg))}'>Download the replication package (ZIP)</a>: the data each ` +
    "source's terms allow to share, download instructions for the rest, the exhibit data and their recipes, the facts file, " +
    "and step-by-step instructions (REPLICATION.md).</p>" : "";
  const title = mode === "paper" ? "Appendix: Replication Materials" : "Replication Materials";
  const get = defonly.map((sid) => {
    const sc = reproduceScripts(base, sid);
    return Object.keys(sc).length ? `${esc(ctx.title(sid))}: run <code>${esc(sc.bash)}</code> (macOS, Linux) or ` +
      `<code>${esc(sc.powershell)}</code> (Windows), attached below. One command downloads the data under your own account ` +
      `(the request is built in; the script asks for your key with hidden input). Then follow <code>reproduce/${esc(sid)}/REPRODUCE.md</code>.`
      : `${esc(ctx.title(sid))}: follow <code>reproduce/${esc(sid)}/REPRODUCE.md</code>.`;
  });
  const getHtml = get.length ? "<ul>" + get.map((g) => `<li>${g}</li>`).join("") + "</ul>" : "";
  const steps = "<ol><li>Get the data: use the included files in <code>data/</code> where the terms allow" +
    (get.length ? ", and for sources whose terms forbid sharing:" + getHtml : ".") +
    "</li><li>Replay the recipes in <code>exhibits/lineage.json</code> with the data-analyst-mcp server's <code>rerun</code> " +
    "tool. It recomputes the exhibit data and <code>facts.json</code>.</li><li>Compare the recomputed facts with the values in " +
    "the audit trail.</li></ol>";
  return [`<section class='prose replication' id='replication'><h2>${title}</h2>${pkgHtml}${heldHtml}${steps}` +
    `<ul class='files code-list'>${blocks.join("")}</ul></section>`, embeds];
}

const PROV_ROWS: [string, string][] = [["retrieved", "Retrieved"], ["downloaded", "Downloaded"], ["route", "Route"],
  ["acquired", "How acquired"], ["api_version", "API version"], ["api_base", "API"], ["collection", "Collection"],
  ["extract_number", "Extract number"], ["latest_period", "Latest period"], ["n_requests", "Requests"], ["n_queries", "Queries"],
  ["rows", "Rows"], ["fingerprint", "Request fingerprint"], ["csv_sha256", "Data checksum (SHA-256)"]];

function provenanceHtml(ctx: Ctx): string {
  const parts: string[] = [];
  for (const sid of ctx.ids) {
    const [provRel, P] = ctx.prov[sid];
    const p = ctx.policies[sid];
    const rows: [string, string][] = [["Source", `${p.title} (${p.agency})`], ["Redistribution rule", p.redistribution.mode]];
    for (const [k, label] of PROV_ROWS) {
      const v = P[k];
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) continue;
      rows.push([label, typeof v === "number" && Number.isInteger(v) ? commas(v) : typeof v === "object" ? pyJsonDumps(v, false, true) : str(v)]);
    }
    if (Array.isArray(P.requests) && !("n_requests" in P)) rows.push(["Requests", String(P.requests.length)]);
    if (P.spec?.as_of) rows.push(["Data cut-off (as_of)", str(P.spec.as_of)]);
    rows.push(["Provenance file", provRel || "none found"]);
    let tbl = "<div class='table-wrap'><table class='audit'><tbody>" + rows.map(([k, v]) => `<tr><th scope='row'>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("") + "</tbody></table></div>";
    let trs = "";
    if (Array.isArray(P.tables)) {
      trs = P.tables.map((t: any) => `<tr><td><code>${esc(t.file ?? "")}</code></td><td>${commas(Number(t.rows ?? 0))}</td>` +
        `<td><code>${esc(String(t.sha256 ?? "").slice(0, 16))}</code></td></tr>`).join("");
    } else if (P.datasets && typeof P.datasets === "object") {
      trs = Object.entries<any>(P.datasets).map(([n, d]) => `<tr><td><code>${esc(n)}.csv</code> (${esc(d.endpoint ?? "")})</td>` +
        `<td>${commas(Number(d.rows ?? 0))}</td><td>${esc(d.first_date || "")} to ${esc(d.last_date || "")}</td></tr>`).join("");
    } else if (Array.isArray(P.files)) {
      trs = P.files.slice(0, 40).map((f: any) => `<tr><td><code>${esc(f.dataset ?? "")} ${esc(f.year ?? "")}-${esc(f.month ?? "")}</code>` +
        `</td><td>v${esc(f.version ?? "")}</td><td><code>${esc(String(f.sha256 ?? "").slice(0, 16))}</code></td></tr>`).join("");
    }
    if (trs) tbl += `<div class='table-wrap'><table class='audit'><tbody>${trs}</tbody></table></div>`;
    const ctxp = path.join(ctx.base, "data", sid, "context_sources.json");
    if (fs.existsSync(ctxp)) {
      const C = JSON.parse(readText(ctxp));
      tbl += "<div class='table-wrap'><table class='audit'><thead><tr><th>Context series</th><th>Source</th><th>Units</th>" +
        "<th>Range</th><th>Retrieved</th></tr></thead><tbody>" + Object.entries<any>(C).map(([k, v]) =>
        `<tr><td>${esc(k)} (<code>${esc(v.series_id ?? "")}</code>)</td><td>${esc(v.source ?? "")}</td><td>${esc(v.units ?? "")}</td>` +
        `<td>${esc(v.first ?? "")} to ${esc(v.last ?? "")}</td><td>${esc(v.retrieved ?? "")}</td></tr>`).join("") + "</tbody></table></div>";
    }
    parts.push(`<h4>${esc(p.title)}</h4>${tbl}`);
  }
  if (!parts.length) return "";
  return "<h3>Data provenance</h3>" + parts.join("") + "<p class='audit-note'>The exact requests (without keys) are in each " +
    "source's provenance file; the server's <code>fetch</code> tool downloads the data again.</p>";
}

function auditHtml(ctx: Ctx, outDir: string, facts: Record<string, any>, used: [string, string][], mode: string): string {
  const R = ctx.R, base = ctx.base;
  const rel = (p: string) => path.relative(outDir, path.join(base, p)).replaceAll("\\", "/");
  const parts = [provenanceHtml(ctx)];
  const files = [...(R.data_files || [])];
  for (const extra of ["analysis.py", "facts.json", "report.json", "spec.json", "plan.json", "exhibits/lineage.json"]) {
    if (fs.existsSync(path.join(base, extra)) && !files.some((d: any) => d.path === extra)) files.push({ label: extra, path: extra });
  }
  const trs = files.map((d: any) => {
    const fp = path.join(base, d.path);
    return `<tr><td><a href='${esc(rel(d.path))}'>${esc(d.path)}</a></td><td>${commas(fs.statSync(fp).size)}</td><td><code>${fileSha(fp)}</code></td></tr>`;
  });
  for (const [sid, P] of Object.entries(ctx.policies)) {          // definition_only data: checksum only, never linked
    if (P.redistribution.mode !== "definition_only") continue;
    for (const f of tree(base, `data/${sid}`)) {
      const fp = path.join(base, f);
      if (PS.isMicrodata(P, f.slice(`data/${sid}/`.length)) && fs.statSync(fp).size <= 4 * PS.LIMITS.MICRO_MAX) {
        trs.push(`<tr><td><code>${esc(f)}</code> (local only, not distributed)</td><td>${commas(fs.statSync(fp).size)}</td><td><code>${fileSha(fp)}</code></td></tr>`);
      }
    }
  }
  if (trs.length) {
    parts.push("<h3>Files and checksums (SHA-256)</h3><div class='table-wrap'><table class='audit'><thead><tr><th>File</th>" +
      "<th>Bytes</th><th>SHA-256</th></tr></thead><tbody>" + trs.join("") + "</tbody></table></div>");
  }
  if (used.length) {
    const anySe = used.some(([n]) => typeof facts[n].se === "number");
    const seen = new Set<string>();
    const rows: string[] = [];
    for (const [name, citedFmt] of used) {
      const k = `${name}\u0000${citedFmt}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const f = facts[name];
      const pk = f.pack;
      const pkTxt = pk ? (Array.isArray(pk) ? pk.join(", ") : str(pk)) : "";
      const src = f.source ? `<a href='${esc(rel(f.source))}'>${esc(f.source)}</a><br><span class='muted'>row: ` +
        `${esc(Object.entries(f.where || {}).map(([a, b]) => `${a} = ${str(b)}`).join(", "))}; column: ${esc(f.column)}</span>`
        : `<span class='muted'>derived: ${esc(f.derivation ?? "")}</span>`;
      const se = typeof f.se === "number" ? fmtG(f.se, 6) : "";
      rows.push(`<tr><td>${esc(f.label || name)}<br><code>${esc(name)}</code></td><td>${esc(formatValue(f.value, citedFmt, mode))}</td>` +
        `<td><code>${esc(f.value)}</code></td>${anySe ? `<td>${esc(se)}</td>` : ""}<td>${src}</td><td>${esc(pkTxt)}</td></tr>`);
    }
    parts.push("<h3>Numbers cited in the text</h3><div class='table-wrap'><table class='audit'><thead><tr><th>Fact</th>" +
      `<th>As cited</th><th>Unrounded</th>${anySe ? "<th>Standard error</th>" : ""}<th>Source cell</th><th>Source pack</th></tr></thead><tbody>` +
      rows.join("") + "</tbody></table></div>");
  }
  // balanced parentheses stay in a URL ("...RA%20(GW).aspx"), as in audit_report.findUrls
  const urls = [...new Set((JSON.stringify(R).match(/https?:\/\/(?:[^\s"'<>()[\]\\]|\([^\s"'<>()]*\))+/g) || []).map((u) => u.replace(/[.,;:]+$/, "")))].sort();
  if (urls.length) parts.push("<h3>External references</h3><ul class='files'>" + urls.map((u) => `<li><a href='${esc(u)}'>${esc(u)}</a></li>`).join("") + "</ul>");
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  parts.push(`<p class='audit-note'>Generated ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:` +
    `${pad(now.getMinutes())} from <code>report.json</code>. The data for every exhibit are embedded in this file and are also saved ` +
    "in the CSV files linked above.</p>");
  return `<section class='prose audit-trail' id='audit'><h2>${mode === "paper" ? "Appendix: Audit Trail" : "Audit Trail"}</h2>` +
    `<details><summary>Data provenance, file checksums, and the source of every number</summary>${parts.join("")}</details></section>`;
}

const findingHtml = (s: any) => (s && typeof s === "object" && !Array.isArray(s)
  ? (s.lead ? `<strong>${inlineMd(s.lead)}</strong> ` : "") + inlineMd(s.text ?? "") : inlineMd(s));

function tilesHtml(R: any): string {
  const hl = R.highlights || [];
  return hl.length ? "<div class='tiles'>" + hl.map((h: any) => `<div class='tile'><p class='t-label'>${esc(h.label)}</p>` +
    `<p class='t-value'>${esc(h.value)}</p>${h.note ? `<p class='t-note'>${esc(h.note)}</p>` : ""}</div>`).join("") + "</div>" : "";
}

const exRange = (nums: number[]) => (!nums.length ? "" : nums.length === 1 ? `Exhibit ${nums[0]}` : `Exhibits ${nums[0]}–${nums[nums.length - 1]}`);

function validateReport(R: any): void {
  const n = (R.exhibits || []).length;
  const errs: string[] = [];
  const placed = (R.sections || []).flatMap((s: any) => (s.exhibits || []).map(Number));
  if (JSON.stringify(placed) !== JSON.stringify(Array.from({ length: n }, (_, i) => i + 1))) {
    errs.push(`the sections must show every exhibit exactly once, in order 1..${n} (exhibits are numbered in reading order); got ${str(placed)}`);
  }
  (R.sections || []).forEach((s: any, k: number) => {
    if (!strip(String(s.body ?? ""))) errs.push(`section ${k + 1} ('${s.heading ?? "None"}') has no body: it opens with a summary of its findings`);
  });
  const cov = (R.cover || {}).exhibit;
  if (cov && !(Number(cov) >= 1 && Number(cov) <= n)) errs.push(`cover.exhibit ${cov} is not an exhibit number`);
  if (errs.length) fail("report structure:\n  - " + errs.join("\n  - "));
}

type Parts = { meta: string; badge: string; methods: string; refs: string; repl: string; audit: string };

function paperBody(R: any, exBlocks: Map<number, string>, p: Parts): string {
  const summary = (R.summary || []).map((s: any) => `<p>${findingHtml(s)}</p>`).join("");
  const placed = new Set<number>(), secHtml: string[] = [], toc: string[] = [];
  (R.sections || []).forEach((s: any, j: number) => {
    const k = j + 1;
    const nums = (s.exhibits || []).map(Number).filter((n: number) => exBlocks.has(n) && !placed.has(n));
    nums.forEach((n: number) => placed.add(n));
    toc.push(`<li><a href='#section-${k}'>${esc(s.heading)}</a></li>`);
    secHtml.push(`<section class='prose' id='section-${k}'><h2>${esc(s.heading)}</h2>${blocksMd(s.body ?? "")}${nums.map((n: number) => exBlocks.get(n)).join("")}</section>`);
  });
  const rest = [...exBlocks.keys()].filter((n) => !placed.has(n));
  const restHtml = rest.length ? `<section class='exhibits'>${secHtml.length ? "<h2>Exhibits</h2>" : ""}${rest.map((n) => exBlocks.get(n)).join("")}</section>` : "";
  const tocItems = [...toc, "<li><a href='#methods'>Appendix: Data and Methods</a></li>",
    "<li><a href='#replication'>Appendix: Replication Materials</a></li>", "<li><a href='#audit'>Appendix: Audit Trail</a></li>"];
  const nav = toc.length ? `<nav class='toc'><h2>Contents</h2><ol>${tocItems.join("")}</ol></nav>` : "";
  const about = R.about ? `<section class='prose about' id='about'><h2>About This Document</h2>${blocksMd(R.about)}</section>` : "";
  return `
${disclaimerHtml()}
<header class="masthead">
  <p class="kicker">${p.meta}${p.badge}</p>
  <h1>${esc(R.title)}</h1>
  ${R.subtitle ? `<p class="dek">${inlineMd(R.subtitle)}</p>` : ""}
</header>
<section class="summary">
  <h2>Summary</h2>
  ${tilesHtml(R)}
  ${summary}
</section>
${nav}
${secHtml.join("")}
${restHtml}
${p.methods}
${p.refs}
${p.repl}
${p.audit}
${footnotesHtml(R.footnotes || [])}
${about}
`;
}

function reportBody(R: any, exBlocks: Map<number, string>, p: Parts): string {
  const sections = R.sections || [], exhibits = R.exhibits || [];
  const secNums: number[][] = sections.map((s: any) => (s.exhibits || []).map(Number));
  const cov = R.cover || {};
  let hero = "";
  if (cov.exhibit) {
    const ex = exhibits[Number(cov.exhibit) - 1];
    const t = cov.title || ex.title;
    const subt = ex.subtitle ? `<p class='ex-sub'>${esc(ex.subtitle)}</p>` : "";
    hero = `<figure class='cover-chart'><p class='cover-chart-title'>${esc(t)}</p>${subt}<div class='legend' data-legend='cover'></div>` +
      `<div class='chart' data-chart='cover' role='img' aria-label='${esc(t)}'></div></figure>`;
  }
  const dek = R.subtitle ? `<p class="dek">${inlineMd(R.subtitle)}</p>` : "";
  const cover = `<header class="masthead cover" id="cover"><p class="kicker">${p.meta}${p.badge}</p><h1>${esc(R.title)}</h1>${dek}${hero}</header>`;
  const g = R.at_a_glance || {};
  const findings = (g.findings && g.findings.length ? g.findings : R.summary) || [];
  const glance = `<section class='glance' id='at-a-glance'><h2>At a Glance</h2>${blocksMd(g.text ?? "")}` +
    (findings.length ? "<ul class='glance-findings'>" + findings.map((s: any) => `<li>${findingHtml(s)}</li>`).join("") + "</ul>" : "") +
    `${tilesHtml(R)}</section>`;
  const intro = R.introduction || {};
  const introTitle = intro.title || "Introduction";
  const subs = intro.subsections || [];
  const items: string[] = [];
  if (Object.keys(intro).length) {
    const subList = subs.length ? "<ul>" + subs.map((x: any, j: number) => `<li><a href='#intro-${j + 1}'>${esc(x.heading)}</a></li>`).join("") + "</ul>" : "";
    items.push(`<li><a href='#introduction'>${esc(introTitle)}</a>${subList}</li>`);
  }
  sections.forEach((s: any, j: number) => {
    const nums = secNums[j];
    items.push(`<li><a href='#section-${j + 1}'>${esc(s.heading)}</a>${nums.length ? `<span class='ex-range'>${exRange(nums)}</span>` : ""}</li>`);
  });
  if (R.footnotes && R.footnotes.length) items.push("<li><a href='#footnotes'>Notes</a></li>");
  items.push("<li><a href='#methods'>Appendix A: Data and Methods</a></li>");
  const appx = R.appendixes || [];
  const letters = appx.map((_: any, j: number) => String.fromCharCode(66 + j));
  appx.forEach((a: any, j: number) => items.push(`<li><a href='#appendix-${letters[j]}'>Appendix ${letters[j]}: ${esc(a.title)}</a></li>`));
  if (p.refs) items.push("<li><a href='#references'>References</a></li>");
  items.push("<li><a href='#about'>About This Document</a></li>");
  items.push("<li class='supp'>Supplementary materials: <a href='#replication'>Replication Materials</a> · <a href='#audit'>Audit Trail</a></li>");
  const contents = `<nav class='contents toc' id='contents'><h2>Contents</h2><ol class='contents-list'>${items.join("")}</ol></nav>`;
  const groups = sections.map((s: any, j: number) => secNums[j].length ? `<h3>${esc(s.heading)}</h3><ol class='ex-list'>` +
    secNums[j].map((n) => `<li><a href='#exhibit-${n}'><span class='ex-n'>${n}.</span> ${esc(exhibits[n - 1]?.title)}</a></li>`).join("") + "</ol>" : "").join("");
  const exList = groups ? `<nav class='exhibit-list' id='list-of-exhibits'><h2>List of Exhibits</h2>${groups}</nav>` : "";
  let notes = R.notes_page;
  if (notes && notes.length && R.data_needs && R.data_needs.length) {
    notes = [...(typeof notes === "string" ? [notes] : notes), "Appendix A lists the data that would make these estimates more accurate."];
  }
  const notesHtml = notes && notes.length ? `<section class='prose notes-page' id='notes'><h2>Notes About This Report</h2>${blocksMd(notes)}</section>` : "";
  let introHtml = "";
  if (Object.keys(intro).length) {
    const sc = intro.footnotes && intro.footnotes.length ? "intro" : null;
    const subHtml = subs.map((x: any, j: number) => `<h3 id='intro-${j + 1}'>${esc(x.heading)}</h3>${blocksMd(x.body ?? "", sc)}`).join("");
    introHtml = `<section class='prose intro' id='introduction'><h2>${esc(introTitle)}</h2>${blocksMd(intro.text ?? "", sc)}${subHtml}` +
      `${footnotesHtml(intro.footnotes || [], sc, null)}</section>`;
  }
  const secHtml = sections.map((s: any, j: number) => {
    const sc = s.footnotes && s.footnotes.length ? `s${j + 1}` : null;
    return `<section class='chapter' id='section-${j + 1}'><div class='section-opener prose'><h2>${esc(s.heading)}</h2>` +
      `${blocksMd(s.body ?? "", sc)}</div>${secNums[j].map((n) => exBlocks.get(n)).join("")}${footnotesHtml(s.footnotes || [], sc, null)}</section>`;
  });
  const globalFn = footnotesHtml(R.footnotes || []).replace("<section class='prose footnotes'>", "<section class='prose footnotes' id='footnotes'>");
  const extra = appx.map((a: any, j: number) => `<section class='prose appendix' id='appendix-${letters[j]}'><h2>Appendix ${letters[j]}: ` +
    `${esc(a.title)}</h2>${blocksMd(a.body ?? "")}</section>`).join("");
  const about = `<section class='prose about' id='about'><h2>About This Document</h2>${blocksMd(R.about ?? "")}</section>`;
  const supp = `<div class='supplementary'><p class='supp-label'>Supplementary materials (not part of the publication)</p>${p.repl}${p.audit}</div>`;
  return [disclaimerHtml(), cover, glance, contents, exList, notesHtml, introHtml, ...secHtml, globalFn, p.methods, extra, p.refs, about, supp].join("\n");
}

// ----------------------------------------------------------------------------- build
function inside(p: string, folder: string): boolean {
  const rel = path.relative(path.resolve(folder), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export type BuildResult = { report: string; mode: string; sources: string[]; exhibits: number; facts_cited: number; bytes: number;
  external_refs: number; package: { file: string; members: number; left_out: string[] }; notices: number; notes: string[] };

export function build(reportPath: string, outPath?: string): BuildResult {
  const base = path.dirname(path.resolve(reportPath));
  if (inside(base, ROOT)) fail(`${base} is inside the server's package folder; build reports in the session workspace`);
  MA.NOTES.length = 0;
  let R = MA.merged(base, parseJson(readText(reportPath), "report.json"));
  const outside = reportPathProblems(base, R);
  if (outside.length) fail(`report.json names files outside the workspace or where keys are kept: ${str(outside)} ` +
    "(every path is relative to the report's folder)");
  const mode = R.mode || "report";
  if (mode !== "report" && mode !== "paper") fail(`mode must be 'report' or 'paper', not '${mode}'`);
  outPath = outPath || path.join(base, "report.html");
  const outDir = path.dirname(path.resolve(outPath));
  const ctx = new Ctx(R, base);
  REF_LABELS = new Map((R.references || []).filter((r: any) => r.id).map((r: any) => [r.id, r.label || r.id]));
  const unknown = [...citedIds(JSON.stringify(R))].filter((i) => !REF_LABELS.has(i));
  if (unknown.length) fail(`[@citations] without a matching entry in references: ${str(unknown.sort())}`);
  const factsPath = path.join(base, R.facts || "facts.json");
  const facts = fs.existsSync(factsPath) ? parseJson(readText(factsPath), R.facts || "facts.json") : {};
  let used: [string, string][];
  [R, used] = fillFacts(R, facts, mode);
  ctx.R = R;
  const left = JSON.stringify(Object.fromEntries(Object.entries(R).filter(([k]) => k !== "request"))).match(ANY_PLACEHOLDER) || [];
  if (left.length) fail(`unresolved or malformed fact placeholders (use {{name}} or {{name|fmt}}): ${str(left)}`);
  if (!R.date) {
    R.date = new Date().toISOString().slice(0, 10);
    MA.note(`report.json has no "date"; using today (${R.date})`);
  }
  const bad = [...(R.data_files || []).map((d: any) => d.path).filter((p: string) => !fs.existsSync(path.join(base, p))),
    ...(R.exhibits || []).filter((e: any) => e.data && !fs.existsSync(path.join(base, e.data))).map((e: any) => e.data)];
  if (bad.length) fail(`linked files do not exist (every link must resolve): ${str(bad)}`);
  // files the source terms keep local are never linked from the page (it travels with the package)
  const keepLocal = (R.data_files || []).map((d: any) => d.path).filter((p: string) => {
    const d = PS.decide(p, base, ctx.policies, R, ctx.withheld);
    return !d.ok && d.policy;
  });
  if (keepLocal.length) {
    MA.note(`not linked: ${str(keepLocal)} (the source terms keep these files local)`);
    R.data_files = R.data_files.filter((d: any) => !keepLocal.includes(d.path));
  }
  if ((R.replication || {}).include_microdata) {
    MA.note("replication.include_microdata is ignored: microdata of a definition_only source never goes into a package");
  }
  const sections = R.sections || [];
  const exScope = new Map<number, string | null>();
  if (mode === "report") {
    validateReport(R);
    sections.forEach((s: any, j: number) => {
      for (const n of s.exhibits || []) exScope.set(Number(n), s.footnotes && s.footnotes.length ? `s${j + 1}` : null);
    });
  }
  const coverEx = mode === "report" ? Number((R.cover || {}).exhibit || 0) : 0;
  const payload: any[] = [], exBlocks = new Map<number, string>();
  (R.exhibits || []).forEach((ex: any, j: number) => {
    const i = j + 1;
    const ch = ex.chart || {};
    const rec = ch.recessions;
    if (rec) {
      ch._recessions = loadRecessions(base, typeof rec === "string" ? rec : "exhibits/recessions.csv");
      const n = ch.recession_note || REC_NOTE;
      if (!String(ex.notes ?? "").includes(n)) ex.notes = (String(ex.notes ?? "").trimEnd() + " " + n).trim();
    }
    let [rows, cols, csvText] = loadRows(ex, base);
    const show: string[] | undefined = ch.columns;      // display/download only these columns (table exhibits)
    if (show && show.length) {
      const miss = show.filter((c) => !cols.includes(c));
      if (miss.length) fail(`exhibit ${i}: chart.columns ${str(miss)} are not in ${ex.data}`);
      csvText = writeDict(rows, show, (v) => (v === null || v === undefined ? "" : str(v)));
      rows = rows.map((r) => Object.fromEntries(show.map((k) => [k, r[k]])));
      cols = [...show];
    }
    const spec = chartSpec(ex, rows);
    const fname = path.posix.basename(String(ex.data ?? `exhibit_${i}.csv`).replaceAll("\\", "/"));
    const fmt = ch.format || "number";
    payload.push({ id: i, chart: spec, csv: csvText, csv_name: fname, columns: cols, format: fmt });
    if (i === coverEx && spec) payload.push({ id: "cover", chart: spec, csv: "", csv_name: "", columns: [], format: fmt });
    exBlocks.set(i, exhibitHtml(i, ex, spec, fname, mode, exScope.get(i)));
  });
  const files = (R.data_files || []).map((d: any) => {
    const rel = path.relative(outDir, path.join(base, d.path)).replaceAll("\\", "/");
    return `<li><a href='${esc(rel)}'>${esc(d.label || d.path)}</a> <code>${esc(d.path)}</code></li>`;
  });
  const filesHtml = files.length ? `<h3>Data Underlying the Exhibits</h3><ul class='files'>${files.join("")}</ul>` : "";
  const requestHtml = R.request ? `<h3>Request</h3><blockquote>${inlineMd(R.request)}</blockquote>` : "";
  const citeHtml = R.citation ? `<h3>Data Citation</h3><p class='cite'>${inlineMd(R.citation)}</p>` : "";
  const methodsTitle = mode === "report" ? "Appendix A: Data and Methods" : "Appendix: Data and Methods";
  const methodsHtml = `<section class='prose methods appendix' id='methods'><h2>${methodsTitle}</h2>${requestHtml}` +
    `${blocksMd(R.methods ?? "")}${vintageHtml(ctx)}${decisionsHtml(R)}${assumptionsHtml(R)}${dataNeedsHtml(R)}${filesHtml}` +
    `${citeHtml}${noticesHtml(ctx)}</section>`;

  for (const [sid, P] of Object.entries(ctx.policies)) {
    if (P.redistribution.mode === "definition_only") writeReproduce(ctx, sid);
    else fs.rmSync(path.join(base, "reproduce", sid), { recursive: true, force: true });
  }
  const [pkg, members, excluded] = makePackage(ctx);
  R.data_files = R.data_files || [];
  if (!R.data_files.some((d: any) => d.path === pkg)) R.data_files.push({ label: "Replication package (ZIP)", path: pkg });
  const [replHtml, attachments] = replicationHtml(ctx, outDir, pkg, members, excluded, mode);
  const audit = auditHtml(ctx, outDir, facts, used, mode);
  const meta = [R.organization, longDate(R.date)].filter((x) => x).map(esc).join(" · ");
  const badge = R.status ? ` <span class="badge">${esc(R.status)}</span>` : "";
  const parts: Parts = { meta, badge, methods: methodsHtml, refs: referencesHtml(R), repl: replHtml, audit };
  const body = mode === "report" ? reportBody(R, exBlocks, parts) : paperBody(R, exBlocks, parts);
  const tpl = fs.readFileSync(TEMPLATE, "utf8");
  const dataJson = JSON.stringify(payload).replaceAll("</", "<\\/");
  const attachJson = JSON.stringify(attachments).replaceAll("</", "<\\/");
  const page = tpl.split("__TITLE__").join(esc(R.title ?? "Report")).split("__MODE__").join(mode)
    .split("<!--__BODY__-->").join(body).split("<!--__FOOTER__-->").join(footerHtml(ctx))
    .split("/*__DATA__*/null").join(dataJson).split("/*__ATTACH__*/null").join(attachJson);
  const leaks = scanText(page, knownKeys(), false, "report.html");
  if (leaks.length) {
    fs.rmSync(outPath, { force: true });
    fs.rmSync(path.join(base, pkg), { force: true });
    fail("an API key or credential appeared in the report content; nothing was written (" + leaks.slice(0, 3).join("; ") + ")");
  }
  fs.writeFileSync(outPath, page, "utf8");
  const ext = page.match(/(?:\bsrc\s*=\s*["']|<link[^>]+href\s*=\s*["']|@import\s+|url\(\s*["']?)(?:https?:)?\/\//gi) || [];
  return { report: path.resolve(outPath), mode, sources: ctx.ids, exhibits: exBlocks.size, facts_cited: new Set(used.map(([n]) => n)).size,
    bytes: Buffer.byteLength(page), external_refs: ext.length,
    package: { file: path.join(base, pkg), members: members.length + 1,
      left_out: excluded.filter((e) => !e.name.startsWith("lib/") && !e.name.startsWith("reproduce/")).map((e) => `${e.name}: ${e.reason}`).slice(0, 20) },
    notices: ctx.notices.length, notes: [...MA.NOTES] };
}

