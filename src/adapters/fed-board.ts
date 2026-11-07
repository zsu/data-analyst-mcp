/**
 * Federal Reserve Board data: Data Download Program (DDP) packages, the Z.1 bulk CSV zip, SCF chart data and tables.
 *
 * DDP (www.federalreserve.gov/datadownload, verified 2026-10-30): Output.aspx?rel=<release>&series=<package id>
 * &lastobs=&from=MM/DD/YYYY&to=&filetype=csv&label=include&layout=seriescolumn&type=package returns a CSV whose first
 * rows are labels ("Series Description", "Unit:", "Multiplier:", "Currency:", "Unique Identifier:" - sometimes with a
 * trailing space - and "Time Period" with the series codes), then one row per date. A package id that is not one of
 * the release's packages answers HTTP 200 with an EMPTY body; an unknown release answers HTTP 400 with an HTML page.
 * The package ids are only listed on the release's Choose page (radio inputs, or <option>s for Z1's 435 packages),
 * so a package named by title is looked up there. ND in a cell = no data.
 *
 * Z.1 bulk zip: csv/<table with . as _>.csv (date, then one column per series) and data_dictionary/<same>.txt
 * (tab-separated: series, description, "Line N", table title, units). z1_table_mapping.csv maps the new table codes
 * (S1M.b) to the published names they replaced (B.101).
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { unzipSync } from "fflate";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { pyStr, sleep } from "../core/py.js";
import { readCsv, xlsxSheets } from "../core/tabular.js";
import { pyRepr } from "./_dol_states.js";

const BASE = "https://www.federalreserve.gov";
const CHOOSE = "/datadownload/Choose.aspx";
const OUTPUT = "/datadownload/Output.aspx";
const Z1_ZIP = "/releases/z1/current/z1_csv_files.zip";
const Z1_MAP = "/releases/z1/current/z1_table_mapping.csv";
const HASH = /^[0-9a-f]{32}$/;
const PKG = /<(?:option|input)\b[^>]*?\bvalue="(rel=[^"]*?series=([0-9a-f]{32})[^"]*)"[^>]*>(?:\s*<label[^>]*>)?([^<]+)</gi;
const FLAGS = new Set(["ND", "NC", "NA", "N/A"]);
const LABELS: Record<string, string> = { "series description": "description", "unit:": "unit", "multiplier:": "multiplier",
  "currency:": "currency", "unique identifier:": "unique_id" };

const fmt = (n: number) => n.toLocaleString("en-US");
const ws = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const decode = (b: Uint8Array) => new TextDecoder("utf-8").decode(b); // utf-8-sig, errors="replace"

/** csv.reader rows (any of CRLF, LF, CR ends a record; an empty line is an empty row). */
function csvRows(text: string): string[][] {
  if (!text) return [];
  const rows: string[][] = parse(text, { relax_column_count: true, relax_quotes: true, skip_empty_lines: false,
    record_delimiter: ["\r\n", "\n", "\r"] });
  return rows.map((r) => (r.length === 1 && r[0] === "" ? [] : r));
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", ndash: "\u2013",
  mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", hellip: "\u2026", eacute: "\u00e9",
  reg: "\u00ae", copy: "\u00a9", deg: "\u00b0", sect: "\u00a7", middot: "\u00b7" };
/** html.unescape (named entities: the common ones). */
function unescape(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z]+);?/g, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\ufffd";
    }
    return ENT[e] ?? all;
  });
}

function checkError(_status: number, body: Buffer): string | null {
  if (!body.toString("latin1").trim()) {
    return "the Board's server returned an empty file. For a Data Download Program package this means the " +
      "package id is not one of the release's packages: list them with the ddp_packages endpoint (or give " +
      "the package title) and check the release code.";
  }
  return null;
}

// ---------------------------------------------------------------------- DDP
export function parsePackages(text: string, rel: string): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PKG)) {
    const h = m[2];
    if (seen.has(h)) continue;
    seen.add(h);
    const label = ws(unescape(m[3]));
    const mm = /^(.*?)\s*\[([^\]]*)\]\s*$/s.exec(label);
    const [title, listed] = mm ? [mm[1], mm[2]] : [label, ""];
    out.push({ rel, package_title: title, package: h, listed });
  }
  return out;
}

class Cache {
  pkgs = new Map<string, Row[]>();
  blobs = new Map<string, any>();
}

async function packages(c: Client, rel0: string, cache: Cache): Promise<Row[]> {
  const rel = rel0.toUpperCase();
  if (!cache.pkgs.has(rel)) {
    let text: string;
    try {
      text = (await c.get(CHOOSE, { rel })).text();
    } catch (e) {
      if (e instanceof DataError && e.kind === "bad_request") {
        throw new DataError(`release ${pyRepr(rel)} is not a Data Download Program release (HTTP 400). Codes: G19, Z1, ` +
          "SLOOS, SCOOS, H8, H6, H15, H41, G17, G20, CHGDEL, DSR, FOR, CP, H10, H3, E2, PRATES", "bad_request");
      }
      throw e;
    }
    cache.pkgs.set(rel, parsePackages(text, rel));
    if (!cache.pkgs.get(rel)!.length) {
      throw new DataError(`no preformatted packages found on the ${rel} Choose page ` +
        `(${BASE}${CHOOSE}?rel=${rel}); the page layout may have changed`, "api");
    }
  }
  return cache.pkgs.get(rel)!;
}

function matchPackage(pkgs: Row[], want: string, rel: string): Row {
  const w = ws(String(want)).toLowerCase();
  const tests = [(t: string) => t === w, (t: string) => t.startsWith(w), (t: string) => t.includes(w)];
  for (const test of tests) {
    const hits = pkgs.filter((p) => test(String(p.package_title).toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const exact = hits.filter((p) => String(p.package_title).toLowerCase() === w);
      if (exact.length === 1) return exact[0];
      const names = hits.slice(0, 12).map((p) => p.package_title).join("; ");
      throw new DataError(`package ${pyRepr(want)} matches ${hits.length} packages of ${rel}: ${names}` +
        (hits.length > 12 ? " ..." : "") + ". Give the full title or the package id.", "bad_request");
    }
  }
  const names = pkgs.slice(0, 15).map((p) => p.package_title).join("; ");
  throw new DataError(`no ${rel} package titled ${pyRepr(want)}. Packages: ${names}` + (pkgs.length > 15 ? " ..." : "") +
    " (all of them: the ddp_packages endpoint)", "bad_request");
}

const p2 = (s: string) => String(Number(s)).padStart(2, "0");

/** A sortable YYYY-MM-DD for DDP and spec dates: 2026-08-14, 2026-08, 2026Q3, 2026:Q3, 2026 (end: the period's
 * last day, for an inclusive "to"). */
export function dateKey(v: unknown, end = false): string {
  const s = pyStr(v || "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${p2(m[2])}-${p2(m[3])}`;
  m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${p2(m[2])}-${end ? "31" : "01"}`;
  m = /^(\d{4}):?Q([1-4])$/i.exec(s);
  if (m) {
    const q = Number(m[2]);
    return `${m[1]}-${String(end ? 3 * q : 3 * q - 2).padStart(2, "0")}-${end ? "31" : "01"}`;
  }
  if (/^\d{4}$/.test(s)) return end ? `${s}-12-31` : `${s}-01-01`;
  return s;
}

const blank = (v: unknown) => v === null || v === undefined || v === "";

/** from / to / lastobs applied to the full package. */
export function filterRows(rows: Row[], start?: unknown, end?: unknown, lastobs?: unknown): Row[] {
  const lo = blank(start) ? "" : dateKey(start);
  const hi = blank(end) ? "" : dateKey(end, true);
  let out = rows.filter((r) => (!lo || dateKey(r.date) >= lo) && (!hi || dateKey(r.date) <= hi));
  if (!blank(lastobs)) {
    const n = pyInt(lastobs);
    const by = new Map<unknown, Row[]>();
    for (const r of out) {
      if (!by.has(r.series)) by.set(r.series, []);
      by.get(r.series)!.push(r);
    }
    const keep = new Set<Row>();
    for (const v of by.values()) {
      const sorted = [...v].sort((a, b) => cmp(dateKey(a.date), dateKey(b.date)));
      for (const x of n === 0 ? sorted : sorted.slice(-n)) keep.add(x);
    }
    out = out.filter((r) => keep.has(r));
  }
  return out;
}

function pyInt(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = pyStr(v).trim().replace(/_/g, "");
  if (!/^[-+]?\d+$/.test(s)) throw new DataError(`invalid literal for int() with base 10: ${pyRepr(v)}`, "bad_request");
  return Number(s);
}

function catalogRel(pack: Pack, pkg: string): string | null {
  for (const c of Object.values<any>(pack.endpoints?.catalog || {})) if (c.id === pkg) return c.rel ?? null;
  return null;
}

function ids(v: unknown): Set<string> {
  if (blank(v)) return new Set();
  const items = Array.isArray(v) ? v : pyStr(v).split(",");
  return new Set(items.filter((x) => pyStr(x).trim()).map((x) => pyStr(x).trim().toUpperCase()));
}

export function parseDdpCsv(text: string, keep?: Set<string> | null): Row[] {
  const rows = csvRows(text);
  const meta: Record<string, string[]> = {};
  let start: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length) continue;
    const lab = r[0].trim().toLowerCase();
    if (lab === "time period") {
      meta.series = r.slice(1);
      start = i + 1;
      break;
    }
    if (lab in LABELS) meta[LABELS[lab]] = r.slice(1);
  }
  if (start === null || !("series" in meta)) {
    const head = text.slice(0, 200).replaceAll("\n", " ");
    throw new DataError(`not a Data Download Program CSV (no 'Time Period' header row): ${pyRepr(head)}`, "api");
  }
  const codes = meta.series;
  const cols: [string, Record<string, string>, boolean][] = codes.map((code, j) => {
    const info: Record<string, string> = {};
    for (const k of ["description", "unit", "multiplier", "currency", "unique_id"]) {
      const m = meta[k] || [];
      info[k] = ws(j < m.length ? m[j] : "");
    }
    const ok = !keep || !keep.size || keep.has(code.trim().toUpperCase()) || keep.has(info.unique_id.toUpperCase());
    return [code.trim(), info, ok];
  });
  const out: Row[] = [];
  for (const r of rows.slice(start)) {
    if (!r.length || !r[0].trim()) continue;
    r.slice(1).forEach((v0, j) => {
      if (j >= cols.length || !cols[j][2]) return;
      const v = v0.trim();
      if (v === "") return;
      const flag = FLAGS.has(v.toUpperCase()) ? v : "";
      out.push({ date: r[0].trim(), series: cols[j][0], value: flag ? "" : v, value_flag: flag, ...cols[j][1] });
    });
  }
  return out;
}

/** The whole package, labels included, series in columns (the Choose page's own default form). */
function ddpQuery(rel: string, pkg: string): Record<string, string> {
  return { rel, series: pkg.toLowerCase(), lastobs: "", from: "", to: "", filetype: "csv", label: "include",
    layout: "seriescolumn", type: "package" };
}

async function fetchDdp(c: Client, pack: Pack, r: SpecRequest, params: Record<string, any>, cache: Cache, notes: string[]): Promise<Row[]> {
  let pkg = pyStr(params.package || "").trim();
  const rel = pyStr(params.rel || "").trim().toUpperCase() || (catalogRel(pack, pkg) || "");
  if (!rel) {
    throw new DataError(`request ${pyRepr(r.name)}: give "rel" (the release code, e.g. G19) with a package id or title`, "bad_request");
  }
  let title: string | null = null;
  if (!HASH.test(pkg.toLowerCase())) {
    const p = matchPackage(await packages(c, rel, cache), pkg, rel);
    [pkg, title] = [String(p.package), String(p.package_title)];
  }
  let resp: any = null;
  for (const wait of [5, 15, null]) { // an empty body was sometimes transient (it answered a moment later)
    try {
      resp = await c.get(OUTPUT, ddpQuery(rel, pkg));
      break;
    } catch (e) {
      if (wait === null || !(e instanceof DataError) || !e.message.includes("empty file") || process.env.DATA_ANALYST_FIXTURES) throw e;
      await sleep(wait * 1000);
    }
  }
  let rows = parseDdpCsv(resp.text(), ids(params.series_ids));
  rows = filterRows(rows, params.from, params.to, params.lastobs);
  notes.push(`${r.name}: DDP release ${rel}, package ` + (title ? `${pyRepr(title)} ` : "") + `(${pkg.toLowerCase()}); ` +
    "value x multiplier is in unit (Currency x 1000000 = millions of dollars).");
  return rows;
}

// ---------------------------------------------------------------------- Z.1
async function z1Mapping(c: Client, cache: Cache): Promise<Row[]> {
  if (!cache.blobs.has("map")) cache.blobs.set("map", readCsv((await c.get(Z1_MAP)).text()));
  return cache.blobs.get("map");
}

/** [new code, published name, title] for a new code (S1M.b) or a published name (B.101). */
async function z1Table(c: Client, want: unknown, cache: Cache): Promise<[string, string, string]> {
  const w = pyStr(want).trim();
  const rows = await z1Mapping(c, cache);
  for (const row of rows) {
    if ([String(row.new ?? "").toLowerCase(), String(row.old ?? "").toLowerCase()].includes(w.toLowerCase())) {
      return [String(row.new), String(row.old ?? ""), String(row.title ?? "")];
    }
  }
  const stem = w.split(".")[0].toLowerCase();
  const near = rows.filter((x) => (String(x.new) + String(x.old)).toLowerCase().includes(stem)).slice(0, 12)
    .map((x) => `${x.new} (${x.old})`);
  throw new DataError(`no Z.1 table ${pyRepr(want)} in z1_table_mapping.csv` + (near.length ? `; similar: ${near.join(", ")}` : "") +
    ". List them with the z1_tables endpoint.", "bad_request");
}

function openZip(bytes: Uint8Array, what: string): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch {
    throw new DataError(`expected the ${what}, got something else (an HTML page?)`, "api");
  }
}

const splitlines = (s: string) => s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);

export function z1Rows(zbytes: Uint8Array, nw: string, old: string, keep: Set<string>, start: string, end: string): Row[] {
  const z = openZip(zbytes, "Z.1 zip file");
  const stem = nw.replaceAll(".", "_");
  const names = new Map(Object.keys(z).map((n) => [n.toLowerCase(), n]));
  const member = names.get(`csv/${stem}.csv`.toLowerCase()) || names.get(`${stem}.csv`.toLowerCase());
  if (!member) throw new DataError(`table ${nw} (${stem}.csv) is not in the Z.1 zip`, "not_found");
  const info: Record<string, Record<string, string>> = {};
  const dd = names.get(`data_dictionary/${stem}.txt`.toLowerCase());
  if (dd) {
    for (const line of splitlines(decode(z[dd]))) {
      const f = line.split("\t").map((x) => x.trim());
      if (f.length >= 2 && f[0]) {
        info[f[0]] = { description: f[1], line: (f.length > 2 ? f[2] : "").replaceAll("Line", "").trim(), units: f.length > 4 ? f[4] : "" };
      }
    }
  }
  return z1FromCsv(decode(z[member]), info, nw, old, keep, start, end);
}

export function z1FromCsv(text: string, info: Record<string, Record<string, string>>, nw: string, old: string,
  keep0: Set<string>, start: string, end: string): Row[] {
  const rows = csvRows(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  const keep = new Set([...keep0].map((k) => (k.includes(".") ? k : k + ".Q")));
  for (const k of keep0) keep.add(k);
  const out: Row[] = [];
  for (const r of rows.slice(1)) {
    if (!r.length || !r[0].trim()) continue;
    const d = r[0].trim();
    if ((start && d < start) || (end && d.slice(0, end.length) > end)) continue;
    for (let j = 1; j < r.length; j++) {
      const s = j < head.length ? head[j] : `col${j}`;
      if (keep.size && !keep.has(s.toUpperCase())) continue;
      const v = r[j].trim();
      if (v === "") continue;
      const flag = FLAGS.has(v.toUpperCase()) ? v : "";
      const m = info[s] || {};
      out.push({ date: d, series: s, value: flag ? "" : v, value_flag: flag, description: m.description ?? "",
        line: m.line ?? "", units: m.units ?? "", table: nw, table_published: old });
    }
  }
  return out;
}

async function fetchZ1(c: Client, r: SpecRequest, params: Record<string, any>, cache: Cache, notes: string[]): Promise<Row[]> {
  const [nw, old, title] = await z1Table(c, params.table, cache);
  if (!cache.blobs.has("zip")) cache.blobs.set("zip", (await c.get(Z1_ZIP)).body);
  const keep = new Set([...ids(params.series_ids)].map((k) => k.toUpperCase()));
  const rows = z1Rows(cache.blobs.get("zip"), nw, old, keep, pyStr(params.start || ""), pyStr(params.end || ""));
  notes.push(`${r.name}: Z.1 table ${nw} (${old}, ${title}) from the current release's bulk CSV zip.`);
  return rows;
}

// ---------------------------------------------------------------------- SCF
const scfMember = (params: Record<string, any>) => `interactive_bulletin_charts_${params.group}_${params.stat}.csv`;

function scfChartRows(zbytes: Uint8Array, member: string): Row[] {
  const z = openZip(zbytes, "SCF chart-data zip");
  const names = new Map(Object.keys(z).map((n) => [path.posix.basename(n).toLowerCase(), n]));
  if (!names.has(member.toLowerCase())) {
    throw new DataError(`${member} is not in scf.zip (${[...names.keys()].sort(cmp).slice(0, 6).join(", ")} ...)`, "not_found");
  }
  return readCsv(decode(z[names.get(member.toLowerCase())!]));
}

function sheetNames(xbytes: Uint8Array): string[] {
  let z: Record<string, Uint8Array>;
  try {
    z = unzipSync(xbytes);
  } catch {
    z = {};
  }
  if (!z["xl/workbook.xml"]) throw new DataError("not an .xlsx workbook (an HTML page in its place?)", "api");
  return [...decode(z["xl/workbook.xml"]).matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
}

function scfTableRows(xbytes: Uint8Array, sheet0: string): Row[] {
  let sheet = sheet0;
  const names = sheetNames(xbytes).map(unescape);
  if (!names.includes(sheet)) {
    const low = new Map(names.map((n) => [n.toLowerCase(), n]));
    if (!low.has(sheet.toLowerCase())) {
      throw new DataError(`no sheet ${pyRepr(sheet)} in the SCF tables workbook (sheets: ${names.join(", ")})`, "bad_request");
    }
    sheet = low.get(sheet.toLowerCase())!;
  }
  const grid = xlsxSheets(xbytes, new Set([sheet]))[sheet] || [];
  const width = Math.max(0, ...grid.map((r) => r.length));
  const out: Row[] = [];
  grid.forEach((row, i) => {
    if (!row.some((v) => v !== null && v !== "")) return;
    const o: Row = { row: i + 1 };
    for (let j = 0; j < width; j++) o[`c${j + 1}`] = j < row.length && row[j] !== null ? row[j] : "";
    out.push(o);
  });
  return out;
}

// ---------------------------------------------------------------------- hooks
function checkSpec(spec: Spec, pack: Pack): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: any = r.params || {}, n = pyRepr(r.name ?? null), ep = r.endpoint;
    if (ep === "ddp") {
      const pkg = pyStr(p.package || "");
      const cat = pack.endpoints?.catalog || {};
      if (!p.rel && !(pkg in cat) && !catalogRel(pack, pkg)) {
        probs.push(`request ${n}: ddp needs "rel" (release code, e.g. G19) unless the package is a catalog alias`);
      }
      for (const k of ["from", "to"]) {
        if (p[k] && !/^(?:\d{4}(-\d{1,2}(-\d{1,2})?)?|\d{4}:?Q[1-4])$/i.test(pyStr(p[k]))) {
          probs.push(`request ${n}: ${k} must be YYYY, YYYY-MM, YYYY-MM-DD or YYYYQn`);
        }
      }
      if (!blank(p.lastobs) && !/^\d+$/.test(pyStr(p.lastobs))) probs.push(`request ${n}: lastobs must be a whole number`);
    }
    if (ep === "z1") {
      for (const k of ["start", "end"]) {
        if (p[k] && !/^\d{4}(:Q[1-4])?$/.test(pyStr(p[k]))) probs.push(`request ${n}: ${k} must be YYYY or YYYY:Qn (e.g. 2020:Q1)`);
      }
    }
  }
  return probs;
}

function cut(r: SpecRequest, rows: Row[], ep: any, notes: string[]): Row[] {
  const limit = Number(r.max_rows || ep.max_rows || 200000);
  if (rows.length > limit) {
    notes.push(`${r.name}: stopped at ${fmt(limit)} rows (max_rows); the source has ${fmt(rows.length)}. Narrow it with ` +
      "series_ids, dates or lastobs, or raise max_rows.");
    return rows.slice(0, limit);
  }
  return rows;
}

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const c = gr.clientFor(pack);
  const cache = new Cache();
  const tables: Tables = {};
  let notes: string[] = [];
  const miss = new gr.Misses();
  for (const r of spec.requests) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const P: Record<string, any> = params;
    const kind = r.endpoint || "";
    let rows: Row[];
    try {
      if (kind === "ddp") rows = await fetchDdp(c, pack, r, P, cache, notes);
      else if (kind === "ddp_packages") rows = await packages(c, pyStr(P.rel), cache);
      else if (kind === "z1") rows = await fetchZ1(c, r, P, cache, notes);
      else if (kind === "scf_chart") {
        if (!cache.blobs.has("scf")) cache.blobs.set("scf", (await c.get(ep.path)).body);
        rows = scfChartRows(cache.blobs.get("scf"), scfMember(P));
      } else if (kind === "scf_table") {
        const [p] = gr.split(ep, P);
        rows = scfTableRows((await c.get(p)).body, pyStr(P.sheet));
      } else {
        const [t, n] = await gr.fetchSpec(pack, { requests: [r] }, c);
        rows = (t[r.name] as Row[]) || [];
        notes = notes.concat(n);
      }
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      if (e.kind === "not_found") {
        miss.notFound(r, tables, notes);
        continue;
      }
      throw new DataError(`request ${pyRepr(r.name)} (${kind}): ${e.message}`, e.kind, e.status);
    }
    rows = cut(r, rows, ep, notes);
    miss.checkEmpty(r, rows);
    tables[r.name] = rows;
  }
  miss.raiseIfAny("check the table code or file", "check series_ids, dates and lastobs");
  return [tables, notes];
}

function manualItems(spec: Spec, pack: Pack): any[] {
  let items: any[] = [];
  for (const r of spec.requests || []) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const P: Record<string, any> = params;
    const kind = r.endpoint, n = r.name;
    const it: any = { name: `${n}#1`, request: n, method: "GET", body: null, needs_key: false, optional: false, also_ext: [], note: "" };
    if (kind === "ddp") {
      const pkg = pyStr(P.package || "");
      const rel = pyStr(P.rel || catalogRel(pack, pkg) || "").toUpperCase();
      if (HASH.test(pkg.toLowerCase())) {
        const q = Object.entries(ddpQuery(rel, pkg)).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("&");
        Object.assign(it, { url: `${BASE}${OUTPUT}?${q}`, filename: `${n}.csv`,
          note: "the whole package; the pack applies series_ids, from, to and lastobs when it reads it" });
      } else {
        Object.assign(it, { url: `${BASE}${CHOOSE}?rel=${rel}`, filename: `${n}.csv`,
          note: `choose the preformatted package titled ${pyRepr(pkg)}, click Format package, keep CSV ` +
            "(labels included, series in columns), then Download file" });
      }
    } else if (kind === "ddp_packages") {
      Object.assign(it, { url: `${BASE}${CHOOSE}?rel=${pyStr(P.rel ?? "").toUpperCase()}`, filename: `${n}.html`,
        note: "save the page as HTML (File > Save as)" });
    } else if (kind === "z1") {
      Object.assign(it, { url: BASE + Z1_ZIP, filename: `${n}.zip`, also_ext: [".csv"],
        note: `the whole Z.1 zip (8 MB); or upload only csv/<table>.csv for table ${P.table === undefined || P.table === null ? "None" : pyStr(P.table)}` });
    } else if (kind === "scf_chart") {
      Object.assign(it, { url: BASE + ep.path, filename: `${n}.zip`, also_ext: [".csv"], note: `or upload only ${scfMember(P)} from the zip` });
    } else if (kind === "scf_table") {
      const [p] = gr.split(ep, P);
      Object.assign(it, { url: BASE + p, filename: `${n}.xlsx` });
    } else {
      items = items.concat(gr.manualItems(pack, { requests: [r] }));
      continue;
    }
    items.push(it);
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [, params] = gr.resolve(pack, req);
  const P: Record<string, any> = params;
  const kind = req.endpoint;
  let rows: Row[] = [];
  for (const f of [...files].sort(cmp)) {
    const data = fs.readFileSync(f);
    const low = f.toLowerCase();
    if (kind === "ddp") {
      rows = rows.concat(filterRows(parseDdpCsv(decode(data), ids(P.series_ids)), P.from, P.to, P.lastobs));
    } else if (kind === "ddp_packages") {
      rows = rows.concat(parsePackages(decode(data), pyStr(P.rel ?? "").toUpperCase()));
    } else if (kind === "z1") {
      const keep = new Set([...ids(P.series_ids)].map((k) => k.toUpperCase()));
      const nw = pyStr(P.table || "");
      if (/^[A-Z]\.\d/.test(nw)) { // the mapping file is not in the zip
        throw new DataError(`request ${pyRepr(req.name)}: for an uploaded Z.1 file give the new table code, not the ` +
          `published name ${pyRepr(nw)} (z1_tables maps them: B.101 = S1M.b, L.101 = S1M.s)`, "bad_request");
      }
      const start = pyStr(P.start || ""), end = pyStr(P.end || "");
      rows = rows.concat(low.endsWith(".zip") ? z1Rows(data, nw, "", keep, start, end) : z1FromCsv(decode(data), {}, nw, "", keep, start, end));
    } else if (kind === "scf_chart") {
      rows = rows.concat(low.endsWith(".zip") ? scfChartRows(data, scfMember(P)) : readCsv(decode(data)));
    } else if (kind === "scf_table") {
      rows = rows.concat(scfTableRows(data, pyStr(P.sheet)));
    } else rows = rows.concat(gr.parseUpload(pack, req, [f]));
  }
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null || v === undefined ? "" : v])));
}

const adapter: Adapter = { checkError, checkSpec, fetch, manualItems, parseUpload, filterRows, dateKey };
export default adapter;
