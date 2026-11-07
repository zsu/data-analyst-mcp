/**
 * SEC EDGAR adapter (data.sec.gov XBRL and submissions APIs, efts.sec.gov full-text search). Keyless.
 *
 * User-Agent: SEC's fair-access policy asks every automated client to identify itself with a contact
 * email ("Sample Company Name AdminContact@<sample company domain>.com") and to stay under 10 requests a
 * second. The pack sends SEC_USER_AGENT (environment variable, or "env" in keys.json or Claude Code's settings.json)
 * when set, else a generic tool name. It never sends a User-Agent that contains a GitHub URL, because SEC's
 * firewall answers HTTP 403 to those (verified 2026-10-20).
 * data.sec.gov and efts.sec.gov accept the generic name; www.sec.gov (company_tickers.json, the
 * Archives) needs a contact email, so this pack resolves tickers with efts instead.
 *
 * Every response is reshaped here (columnar submissions arrays, nested XBRL units), so fetch() replaces
 * the generic fetch. Published values are never changed: rows keep val, unit, fy, fp, form, filed, frame.
 */
import fs from "node:fs";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import * as keys from "../core/keys.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { parsePyJson, pyStr, pyUrlencode } from "../core/py.js";

export const DEFAULT_UA = "data-analyst/1.0 (U.S. government open data analysis tool)";
const UA_ENV = "SEC_USER_AGENT";
const EFTS = "https://efts.sec.gov/LATEST/search-index";
const ARCHIVES = "https://www.sec.gov/Archives/edgar/data";
const CO_EPS = ["submissions", "company_concept", "company_facts", "insider_filings"];

const fmt = (n: number) => n.toLocaleString("en-US");
/** Python str() of a value, with None as "None" (as str(None) gives inside f-strings and sort keys). */
const pstr = (v: unknown) => (v === null || v === undefined ? "None" : pyStr(v));
/** dict.get(k, d): the default only when the key is absent (a JSON null stays null). */
const get = (o: any, k: string, d: any = null) => (o && typeof o === "object" && k in o ? o[k] : d);
const isDigits = (s: string) => /^\d+$/.test(s);

export function userAgent(): string {
  const [ua0] = keys.findKey(UA_ENV);
  const ua = (ua0 || "").trim();
  if (!ua || ua.toLowerCase().includes("github")) return DEFAULT_UA;
  return ua;
}

function client(pack: Pack): Client {
  return gr.clientFor(pack, undefined, { userAgent: userAgent() });
}

function checkError(_status: number, body: Buffer): string | null {
  const head = body.subarray(0, 300);
  const h = head.toString("latin1");
  if (h.slice(0, 1) === "{" && (h.includes('"errorType"') || h.includes('"errorMessage"'))) {
    return "EDGAR search is temporarily failing (" + head.toString("utf8").slice(0, 160) + "); try again in a minute";
  }
  if (h.trimStart().slice(0, 1) === "<" && body.subarray(0, 2000).toString("latin1").includes("Request Rate Threshold")) {
    return "SEC refused the request (rate threshold / undeclared automated tool). Set SEC_USER_AGENT to " +
      "'Your Name your.email@example.org' and keep under 10 requests a second";
  }
  return null;
}

function pad(cik: unknown): string {
  const s = pyStr(cik).replace(/\D/g, "");
  if (!s) throw new DataError(`not a CIK: ${pyRepr(cik)}`, "bad_request");
  return s.padStart(10, "0");
}

function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "string") return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return pyStr(v);
}

async function lookup(c: Client, text: string, limit = 10): Promise<Row[]> {
  const data = await c.getJson(EFTS, { keysTyped: text.trim() });
  const out: Row[] = [];
  for (const h of ((get(data, "hits") || {}).hits || []).slice(0, limit)) {
    const src = get(h, "_source") || {};
    const cik = pyStr(get(h, "_id") || "");
    if (!isDigits(cik)) continue;
    out.push({ cik: cik.padStart(10, "0"), name: pyStr(get(src, "entity") || "").replace(/\s*\([^)]*\)\s*$/, "").trim(),
      tickers: get(src, "tickers") || "", entity: get(src, "entity") || "" });
  }
  return out;
}

async function resolveCik(c: Client, params: Record<string, any>): Promise<string> {
  if (params.cik) return pad(params.cik);
  const t = pyStr(params.ticker || "").trim();
  if (/^\d{1,10}$/.test(t)) return pad(t);
  const hits = await lookup(c, t);
  const want = t.toUpperCase();
  const exact = hits.filter((h) => pyStr(h.tickers).split(",").map((x) => x.trim().toUpperCase()).includes(want));
  if (exact.length) return exact[0].cik as string;
  const named = hits.filter((h) => String(h.name).toUpperCase() === want);
  if (named.length) return named[0].cik as string;
  throw new DataError(`no SEC registrant has the ticker or exact name ${pyRepr(t)}. Candidates: ` +
    hits.slice(0, 5).map((h) => `${h.entity} CIK ${h.cik}`).join("; ") + ". Put the right one in params.cik.", "bad_request");
}

function split(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  return (Array.isArray(v) ? v : pyStr(v).split(",")).filter((x) => pyStr(x).trim()).map((x) => pyStr(x).trim());
}

const truthy = (v: unknown) => ["true", "1", "yes"].includes(pstr(v).toLowerCase());

const DURATIONS: Record<string, [number, number]> = { annual: [350, 380], quarter: [80, 100] };

/** date.fromisoformat for YYYY-MM-DD (null when it is not one). */
function isoDay(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (y < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

/** Length of a duration fact in days (end - start + 1); "" for instant facts (no start). */
export function days(start: unknown, end: unknown): number | "" {
  const a = isoDay(start), b = isoDay(end);
  return a === null || b === null ? "" : b - a + 1;
}

/** A ratio unit is keyed 'USD/shares' in company_concept and company_facts but written 'USD-per-shares'
 * in the frames URL (SEC's API doc; verified 2026-10-22). Accept either spelling and send the one the endpoint uses. */
export function unitFor(endpoint: string, unit: unknown): any {
  if (!unit) return unit;
  const u = pyStr(unit);
  return endpoint === "frames" ? u.replaceAll("/", "-per-") : u.replaceAll("-per-", "/");
}

/** Two facts of about the same period (end dates and lengths within a week: 52/53-week years). */
function near(a: Row, b: Row): boolean {
  const ea = isoDay(a.end), eb = isoDay(b.end);
  if (ea === null || eb === null) return a.end === b.end;
  const da = a.period_days, db = b.period_days;
  return Math.abs(ea - eb) <= 7 && ((da === "" && db === "") || (da !== "" && db !== "" && Math.abs(Number(da) - Number(db)) <= 7));
}

/** A fact's period class: instant, annual or quarter (null: any other length, e.g. a 6- or 9-month YTD). */
function length(d: unknown): string | null {
  if (d === "") return "instant";
  const n = Number(d);
  return Object.entries(DURATIONS).find(([, [lo, hi]]) => lo <= n && n <= hi)?.[0] ?? null;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function cmpTuple(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = cmp(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
}

/** frames_only: one value per period, periods that do not overlap (see the Python adapter's notes): a period with no
 * framed fact keeps its latest-filed fact when its length is one the series has. Returns [rows, restored, skipped]. */
export function onePerPeriod(rows: Row[], duration?: string | null): [Row[], number, number] {
  const framed = rows.filter((r) => r.frame);
  const kinds = new Set<string | null>(framed.map((r) => length(r.period_days)));
  if (duration) kinds.add(duration);
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.frame) continue;
    const k = JSON.stringify([r.unit, r.start, r.end]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const maxFiled = (g: Row[]) => g.map((r) => pstr(r.filed)).reduce((m, x) => (x > m ? x : m));
  const ordered = [...groups.values()].sort((a, b) => cmp(maxFiled(b), maxFiled(a)));
  const extra: Row[] = [];
  let skipped = 0;
  for (const g of ordered) {
    let best = g[0];
    for (const r of g.slice(1)) if (cmpTuple([pstr(r.filed), pstr(r.accn)], [pstr(best.filed), pstr(best.accn)]) > 0) best = r;
    if ([...framed, ...extra].some((f) => f.unit === best.unit && near(f, best))) continue;
    const L = length(best.period_days);
    if (L === null || !kinds.has(L)) {
      skipped++;
      continue;
    }
    extra.push(best);
  }
  const out = [...framed, ...extra];
  out.sort((a, b) => cmpTuple([pstr(a.tag), pstr(a.unit), pstr(a.end), pstr(a.start)], [pstr(b.tag), pstr(b.unit), pstr(b.end), pstr(b.start)]));
  return [out, extra.length, skipped];
}

function factRows(cik: string, entity: any, taxonomy: any, tag: any, concept: any, params: Record<string, any>,
  notes: string[] | null = null, name = ""): Row[] {
  const forms = split(params.forms), unit = unitFor("company_concept", params.unit);
  let rows: Row[] = [];
  for (const [u, obs] of Object.entries<any>(get(concept, "units") || {})) {
    if (unit && u !== unit) continue;
    for (const o of obs) {
      if (forms.length && !forms.some((f) => pyStr(get(o, "form", "")).startsWith(f))) continue;
      const d = days(get(o, "start"), get(o, "end"));
      const want = params.duration;
      if (want && !(d !== "" && DURATIONS[want][0] <= d && d <= DURATIONS[want][1])) continue;
      rows.push({ cik, entity_name: entity, taxonomy, tag, label: get(concept, "label") || "", unit: u,
        start: get(o, "start", ""), end: get(o, "end", ""), period_days: d, val: get(o, "val"), fy: get(o, "fy", ""),
        fp: get(o, "fp", ""), form: get(o, "form", ""), filed: get(o, "filed", ""), accn: get(o, "accn", ""),
        frame: get(o, "frame", "") });
    }
  }
  if (truthy(params.frames_only)) {
    let restored: number, skipped: number;
    [rows, restored, skipped] = onePerPeriod(rows, params.duration);
    if ((restored || skipped) && notes !== null) {
      notes.push(`${name}: ${tag}: ${restored} period(s) with no SEC frame were restored from their latest-filed ` +
        `fact (empty frame column); ${skipped} unframed fact period(s) of another length (e.g. ` +
        "year-to-date) were skipped because they overlap the series. Label periods by end date.");
    }
  }
  return rows;
}

function filings(cik: string, cols: Record<string, any>, profile: Row): Row[] {
  const ks = Object.keys(cols);
  const n = Math.max(0, ...Object.values(cols).filter(Array.isArray).map((v: any[]) => v.length));
  const rows: Row[] = [];
  const num = String(parseInt(cik, 10));
  for (let i = 0; i < n; i++) {
    const r: Row = {};
    for (const k of ks) r[k] = Array.isArray(cols[k]) && i < cols[k].length ? cols[k][i] : "";
    const acc = pyStr(get(r, "accessionNumber", ""));
    const doc = r.primaryDocument || "";
    r.url = acc && doc ? `${ARCHIVES}/${num}/${acc.replaceAll("-", "")}/${pyStr(doc)}` : "";
    r.index_url = acc ? `${ARCHIVES}/${num}/${acc.replaceAll("-", "")}/${acc}-index.htm` : "";
    rows.push({ ...profile, ...r });
  }
  return rows;
}

function eftsRows(data: any): Row[] {
  const rows: Row[] = [];
  for (const h of (get(data, "hits") || {}).hits || []) {
    const s = get(h, "_source") || {};
    const id = pyStr(get(h, "_id", ""));
    const adsh = get(s, "adsh") || id.split(":")[0];
    const fname = id.includes(":") ? id.slice(id.indexOf(":") + 1) : "";
    const ciks: string[] = get(s, "ciks") || [];
    const first = ciks.length && isDigits(pyStr(ciks[0])) ? String(parseInt(pyStr(ciks[0]), 10)) : "";
    rows.push({ adsh, form: get(s, "form", ""), file_date: get(s, "file_date", ""), period_ending: get(s, "period_ending") || "",
      file_type: get(s, "file_type") || "", file_description: get(s, "file_description") || "",
      display_names: (get(s, "display_names") || []).join("; "), ciks: ciks.join("; "),
      sics: (get(s, "sics") || []).join("; "), biz_states: (get(s, "biz_states") || []).join("; "),
      items: (get(s, "items") || []).join("; "),
      url: first && fname ? `${ARCHIVES}/${first}/${pyStr(adsh).replaceAll("-", "")}/${fname}` : "" });
  }
  return rows;
}

async function eftsAll(c: Client, q: Record<string, unknown>, limit: number): Promise<[Row[], any]> {
  let rows: Row[] = [];
  let start = 0;
  let total: any = null;
  while (rows.length < limit && start < 10000) {
    const data = await c.getJson(EFTS, start ? { ...q, from: start } : q);
    const t = (get(data, "hits") || {}).total || {};
    total = t && typeof t === "object" && !Array.isArray(t) ? get(t, "value") : t;
    const got = eftsRows(data);
    rows = rows.concat(got);
    if (got.length < 100) break;
    start += got.length;
  }
  return [rows.slice(0, limit), total];
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: any = r.params || {}, n = pyRepr(r.name), ep = r.endpoint;
    if (ep && CO_EPS.includes(ep) && !(p.cik || p.ticker)) probs.push(`request ${n}: ${ep} needs params.cik or params.ticker`);
    if (ep === "frames" && p.period && !/^CY\d{4}(Q[1-4]I?)?$/.test(pyStr(p.period))) {
      probs.push(`request ${n}: period must look like CY2023, CY2023Q1 or CY2023Q4I`);
    }
    if (p.duration && !(p.duration in DURATIONS)) probs.push(`request ${n}: duration must be annual or quarter`);
  }
  return probs;
}

const noNone = (rows: Row[]) => rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null || v === undefined ? "" : v])));

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const c = client(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  const miss = new gr.Misses();
  for (const r of spec.requests) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const P: Record<string, any> = params;
    const kind = r.endpoint, name = r.name;
    const limit = Number(r.max_rows || ep.max_rows || 100000);
    let rows: Row[];
    try {
      if (kind === "company_search") rows = await lookup(c, pyStr(P.text), 20);
      else if (kind === "submissions") {
        const cik = await resolveCik(c, P);
        const d = await c.getJson(`/submissions/CIK${cik}.json`);
        const prof = { cik, entity_name: get(d, "name", ""), sic: get(d, "sic", ""), sic_description: get(d, "sicDescription", ""),
          tickers: (get(d, "tickers") || []).join("; ") };
        rows = filings(cik, (get(d, "filings") || {}).recent || {}, prof);
        const older: any[] = (get(d, "filings") || {}).files || [];
        if (truthy(P.all)) {
          for (const f of older) rows = rows.concat(filings(cik, await c.getJson(`/submissions/${f.name}`), prof));
        } else if (older.length) {
          notes.push(`${name}: older filings are in ${older.length} more file(s); set params.all=true to include them.`);
        }
        const forms = split(P.forms), since = P.since;
        if (forms.length) rows = rows.filter((x) => forms.includes(x.form as string));
        if (since) rows = rows.filter((x) => pyStr(get(x, "filingDate", "")) >= since);
      } else if (kind === "company_concept") {
        const cik = await resolveCik(c, P);
        const tax = P.taxonomy || "us-gaap";
        const d = await c.getJson(`/api/xbrl/companyconcept/CIK${cik}/${tax}/${P.tag}.json`);
        rows = factRows(cik, get(d, "entityName", ""), tax, get(d, "tag", P.tag), d, P, notes, name);
      } else if (kind === "company_facts") {
        const cik = await resolveCik(c, P);
        const d = await c.getJson(`/api/xbrl/companyfacts/CIK${cik}.json`);
        const tags = new Set(split(P.tags)), taxOnly = P.taxonomy;
        rows = [];
        for (const [tax, concepts] of Object.entries<any>(get(d, "facts") || {})) {
          if (taxOnly && tax !== taxOnly) continue;
          for (const [tag, concept] of Object.entries<any>(concepts)) {
            if (tags.size && !tags.has(tag)) continue;
            rows = rows.concat(factRows(cik, get(d, "entityName", ""), tax, tag, concept, P, notes, name));
          }
        }
        const got = new Set(rows.map((x) => x.tag));
        const missing = [...tags].filter((t) => !got.has(t)).sort(cmp);
        if (missing.length) notes.push(`${name}: not reported by this company (or filtered out): ${missing.join(", ")}`);
      } else if (kind === "frames") {
        const tax = P.taxonomy || "us-gaap", unit = unitFor("frames", P.unit || "USD");
        const d = await c.getJson(`/api/xbrl/frames/${tax}/${P.tag}/${unit}/${P.period}.json`);
        const base = { taxonomy: tax, tag: get(d, "tag", P.tag), unit: get(d, "uom", unit), period: get(d, "ccp", P.period) };
        rows = (get(d, "data") || []).map((x: any) => ({ ...base, ...x }));
      } else if (kind === "full_text_search") {
        const q = Object.fromEntries(["q", "forms", "startdt", "enddt", "ciks"].filter((k) => P[k]).map((k) => [k, P[k]]));
        let total: any;
        [rows, total] = await eftsAll(c, q, limit);
        if (total && total > rows.length) {
          notes.push(`${name}: ${fmt(rows.length)} of ${fmt(Number(total))}${total >= 10000 ? "+" : ""} matching documents; ` +
            "narrow the dates or forms (the index returns at most 10,000).");
        }
      } else if (kind === "insider_filings") {
        const cik = await resolveCik(c, P);
        const q: Record<string, unknown> = { forms: P.forms || "4", ciks: cik };
        for (const k of ["startdt", "enddt"]) if (P[k]) q[k] = P[k];
        const [docs] = await eftsAll(c, q, limit);
        rows = [];
        const num = String(parseInt(cik, 10));
        for (const x of docs) {
          const cks = String(x.ciks).split("; "), names = String(x.display_names).split("; ");
          const j = cks.findIndex((v) => v !== cik);
          const i = j < 0 ? null : j;
          rows.push({ issuer_cik: cik, form: x.form, file_date: x.file_date, period_ending: x.period_ending,
            insider: i !== null && i < names.length ? names[i].replace(/\s*\(CIK \d+\)\s*$/, "").trim() : "",
            insider_cik: i !== null ? cks[i] : "", adsh: x.adsh,
            index_url: `${ARCHIVES}/${num}/${pyStr(x.adsh).replaceAll("-", "")}/${x.adsh}-index.htm` });
        }
        rows.sort((a, b) => cmp(pyStr(b.file_date), pyStr(a.file_date)));
      } else throw new DataError(`unknown endpoint ${pyRepr(kind ?? null)}`, "bad_request");
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      if (e.kind !== "not_found") throw new DataError(`request ${pyRepr(name)} (${kind}): ${e.message}`, e.kind, e.status);
      miss.notFound(r, tables, notes); // one unknown tag or CIK must not stop the other requests
      continue;
    }
    if (rows.length > limit) {
      notes.push(`${name}: stopped at ${fmt(limit)} of ${fmt(rows.length)} rows (max_rows).`);
      rows = rows.slice(0, limit);
    }
    if (kind === "company_search" && !rows.length) { // no match is an answer, not a spec error: keep the others
      notes.push(`${name}: no SEC filer matched ${pyRepr(P.text)} (EDGAR company search); kept as an empty ` +
        "table. Try a shorter or former name or the ticker; a company that files nothing with the " +
        "SEC (private, or foreign without U.S. listings) has no record.");
    } else miss.checkEmpty(r, rows);
    tables[name] = noNone(rows);
  }
  miss.raiseIfAny("SEC has no such tag for that company or no such CIK (tags are case-sensitive). " +
    "To see which of several tags a company reports, ask company_facts with \"tags\": it notes the " +
    "unreported ones instead of failing",
  "check the tag (case-sensitive), unit, forms filter or period (see source.md)");
  return [tables, notes];
}

// ---------------------------------------------------------------------- manual route
/** data.sec.gov and efts JSON links; a browser sends its own User-Agent, which SEC accepts. */
function manualItems(spec: Spec, _pack: Pack): any[] {
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const p: any = r.params || {}, kind = r.endpoint, name = r.name;
    let cik: string | null = null;
    if (p.cik || /^\d{1,10}$/.test(pyStr(p.ticker || ""))) cik = pad(p.cik || p.ticker);
    let url: string | null = null, note = "";
    const tax = p.taxonomy || "us-gaap";
    if (kind === "submissions" && cik) url = `https://data.sec.gov/submissions/CIK${cik}.json`;
    else if (kind === "company_concept" && cik && p.tag) url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${tax}/${p.tag}.json`;
    else if (kind === "company_facts" && cik) url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    else if (kind === "frames" && p.tag && p.period) {
      url = `https://data.sec.gov/api/xbrl/frames/${tax}/${p.tag}/${unitFor("frames", p.unit || "USD")}/${p.period}.json`;
    } else if (kind === "full_text_search" || kind === "company_search" || kind === "insider_filings") {
      const q: Record<string, unknown> = kind === "company_search" ? { keysTyped: get(p, "text", "") }
        : Object.fromEntries(["q", "forms", "startdt", "enddt", "ciks"].filter((k) => p[k]).map((k) => [k, p[k]]));
      if (kind === "insider_filings" && cik) Object.assign(q, { forms: p.forms || "4", ciks: cik });
      url = EFTS + "?" + pyUrlencode(q);
      note = "first 100 hits; add &from=100, &from=200 ... for more";
    }
    if (kind && CO_EPS.includes(kind) && !cik) {
      note = "look up the CIK first (https://www.sec.gov/edgar/searchedgar/companysearch) and put it in params.cik";
    }
    if (url) items.push({ name: `${name}#1`, request: name, url, filename: `${name}.json`, needs_key: false, note });
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [, params] = gr.resolve(pack, req);
  const P: Record<string, any> = params;
  const kind = req.endpoint;
  let rows: Row[] = [];
  for (const f of [...files].sort(cmp)) {
    const d = parsePyJson(fs.readFileSync(f, "utf8").replace(/^\ufeff/, ""));
    if (kind === "submissions") {
      const cik = pad(get(d, "cik") || P.cik);
      const prof = { cik, entity_name: get(d, "name", ""), sic: get(d, "sic", ""), sic_description: get(d, "sicDescription", ""),
        tickers: (get(d, "tickers") || []).join("; ") };
      const recent = "filings" in d ? (get(d, "filings") || {}).recent : d;
      rows = rows.concat(filings(cik, recent || {}, prof));
    } else if (kind === "company_concept") {
      rows = rows.concat(factRows(pad(get(d, "cik")), get(d, "entityName", ""), get(d, "taxonomy", ""), get(d, "tag", ""), d, P));
    } else if (kind === "company_facts") {
      const tags = new Set(split(P.tags));
      for (const [tax, concepts] of Object.entries<any>(get(d, "facts") || {})) {
        for (const [tag, concept] of Object.entries<any>(concepts)) {
          if (!tags.size || tags.has(tag)) rows = rows.concat(factRows(pad(get(d, "cik")), get(d, "entityName", ""), tax, tag, concept, P));
        }
      }
    } else if (kind === "frames") {
      const base = { taxonomy: get(d, "taxonomy", ""), tag: get(d, "tag", ""), unit: get(d, "uom", ""), period: get(d, "ccp", "") };
      rows = rows.concat((get(d, "data") || []).map((x: any) => ({ ...base, ...x })));
    } else if (kind === "company_search") {
      rows = rows.concat(((get(d, "hits") || {}).hits || []).map((h: any) => ({ cik: pyStr(get(h, "_id", "")).padStart(10, "0"),
        entity: get(get(h, "_source") || {}, "entity", ""), tickers: get(get(h, "_source") || {}, "tickers", "") })));
    } else rows = rows.concat(eftsRows(d));
  }
  return noNone(rows);
}

/** Common XBRL concepts (endpoints.json "concepts") plus the endpoint descriptions. */
function search(query: string, pack: Pack, limit = 20): any[] {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1);
  const hits: [number, any][] = [];
  for (const [tag, desc] of Object.entries<any>(pack.endpoints?.concepts || {})) {
    const text = `${tag} ${desc}`.toLowerCase();
    const s = words.reduce((n, w) => n + text.split(w).length - 1, 0);
    if (s) hits.push([s, { tag, description: desc }]);
  }
  const out = [...hits].sort((a, b) => b[0] - a[0]).map(([, h]) => h).concat(gr.searchCatalog(pack, query, limit));
  return out.slice(0, limit);
}

const adapter: Adapter = { checkError, checkSpec, fetch, manualItems, parseUpload, search, userAgent, unitFor, onePerPeriod, days,
  DEFAULT_UA };
export default adapter;
