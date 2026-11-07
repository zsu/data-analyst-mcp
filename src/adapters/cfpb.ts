/**
 * CFPB Consumer Complaint Database adapter (search API v1, keyless).
 *
 * Only two resources of the API answer (verified 2026-10-20): the search ("/") and one complaint ("/<id>"). The
 * /trends, /geo/states and /_suggest_company resources now return the web page (HTML), so this pack builds:
 *   complaints    search hits, paged with search_after (the "frm" offset is ignored by the API)
 *   aggregations  the search with size=0: counts by one field (the API returns every field's buckets)
 *   trends        one size=0 count query per year / quarter / month (both date bounds are inclusive)
 *   complaint     one complaint by id
 * A company filter that matches nothing is an error with a hint, never a silent switch to a fuzzy search. The API
 * ignores filters it does not know (HTTP 200, unfiltered totals), so checkSpec rejects every undeclared parameter,
 * and sub_product / sub_issue are sent the only way the API applies them: product='<product>(bullet)<sub_product>'
 * and issue='<issue>(bullet)<sub_issue>' (U+2022 bullet).
 */
import fs from "node:fs";
import path from "node:path";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { parsePyJson, pyStr, pyUrlencode } from "../core/py.js";
import { readCsv } from "../core/tabular.js";

const CONTROL = new Set(["agg", "sub", "interval", "by", "page_size", "size", "complaint_id"]);
const MAX_PERIODS = 120;
const BULLET = String.fromCharCode(0x2022);
const NESTED: [string, string][] = [["product", "sub_product"], ["issue", "sub_issue"]];
const RETIRED: Record<string, string> = {
  has_narrative: "CFPB stopped publishing complaint narratives on 2026-08-14 and the API ignores " +
    "has_narrative (see source.md for the narratives archive)",
  consumer_disputed: "consumer_disputed was retired in 2017 and the API ignores it as a filter",
};

/** Python repr() of a request name or parameter in a message. */
function repr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v !== "string") return pyStr(v);
  return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? [...v] : [v]);
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** sub_product / sub_issue folded into product / issue as 'parent<U+2022>child'; a list of children stays an OR. */
function fold(params: Record<string, unknown>): Record<string, unknown> {
  const p = { ...params };
  for (const [parent, child] of NESTED) {
    const subs = p[child];
    delete p[child];
    if (empty(subs)) continue;
    const top = asList(p[parent])[0];
    p[parent] = asList(subs).map((s) => `${pyStr(top ?? null) || "None"}${BULLET}${pyStr(s)}`);
  }
  return p;
}

/** Filter parameters for the query string (booleans as true/false, lists repeated). */
export function q(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fold(params))) {
    if (CONTROL.has(k) || empty(v)) continue;
    out[k] = typeof v === "boolean" ? (v ? "true" : "false") : v;
  }
  return out;
}

function total(data: any): number {
  const t = data?.hits?.total;
  return Math.trunc(Number(t && typeof t === "object" ? t.value ?? 0 : t || 0));
}

function hitRows(data: any): Row[] {
  return (data?.hits?.hits || []).map((h: any) => gr.flatten(h._source || {}));
}

function buckets(data: any, field: string, sub: boolean): Row[] {
  const a = data?.aggregations?.[field] || {};
  const inner = a[field] || {};
  const tot = total(data);
  const rows: Row[] = [];
  for (const b of inner.buckets || []) {
    if (!sub) {
      rows.push({ field, key: b.key ?? null, complaints: b.doc_count ?? null, total_matching: tot });
      continue;
    }
    const subs = Object.entries<any>(b).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v) && "buckets" in v);
    if (!subs.length) {
      rows.push({ field, key: b.key ?? null, complaints: b.doc_count ?? null, sub_field: "", sub_key: "", sub_complaints: "",
        total_matching: tot });
    }
    for (const [sk, sv] of subs) {
      for (const s of sv.buckets || []) {
        rows.push({ field, key: b.key ?? null, complaints: b.doc_count ?? null, sub_field: sk.replace(".raw", ""),
          sub_key: s.key ?? null, sub_complaints: s.doc_count ?? null, total_matching: tot });
      }
    }
  }
  if (inner.sum_other_doc_count) {
    rows.push({ field, key: "(other buckets not returned)", complaints: inner.sum_other_doc_count, total_matching: tot });
  }
  return rows;
}

// ---------------------------------------------------------------------- periods
type Ymd = [number, number, number];
class BadDate extends Error {}

function parseDate(s: unknown): Ymd {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(pyStr(s));
  if (!m) throw new BadDate(`Invalid isoformat string: ${repr(s)}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) throw new BadDate("day is out of range for month");
  return [y, mo, d];
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const iso = ([y, m, d]: Ymd) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const le = (a: Ymd, b: Ymd) => iso(a) <= iso(b);

/** [label, first day, last day] for every period touching [start, end], clipped to the range. */
export function periods(start: string, end: string, interval: string): [string, string, string][] {
  const s = parseDate(start), e = parseDate(end);
  const steps: Record<string, number> = { year: 12, quarter: 3, month: 1 };
  if (!(interval in steps)) throw new BadDate(`KeyError: ${repr(interval)}`);
  const step = steps[interval];
  const out: [string, string, string][] = [];
  let [y, m] = s;
  if (interval === "year") m = 1;
  else if (interval === "quarter") m = Math.floor((m - 1) / 3) * 3 + 1;
  while (le([y, m, 1], e)) {
    let m2 = m + step - 1, y2 = y;
    while (m2 > 12) [m2, y2] = [m2 - 12, y2 + 1];
    const first: Ymd = [y, m, 1], last: Ymd = [y2, m2, daysIn(y2, m2)];
    const label = interval === "year" ? String(y) : interval === "quarter" ? `${y}-Q${Math.floor((m - 1) / 3) + 1}`
      : `${y}-${String(m).padStart(2, "0")}`;
    out.push([label, iso(le(s, first) ? first : s), iso(le(last, e) ? last : e)]);
    m += step;
    while (m > 12) [m, y] = [m - 12, y + 1];
  }
  return out;
}

// ---------------------------------------------------------------------- spec checks
/** Undeclared parameters (the API would ignore them silently) and sub-filters without one parent. */
function paramProblems(pack: Pack, r: SpecRequest): string[] {
  const eps = pack.endpoints?.endpoints || {};
  const ep = eps[r.endpoint || ""];
  const p: Record<string, unknown> = r.params || {};
  const n = repr(r.name ?? null);
  const probs: string[] = [];
  if (ep === undefined) return probs; // the generic check reports the unknown endpoint
  const known = new Set([...Object.keys(ep.params || {}), ...CONTROL, ...Object.keys(ep.defaults || {})]);
  for (const k of Object.keys(p)) {
    if (k in RETIRED) probs.push(`request ${n}: ${RETIRED[k]}; remove it`);
    else if (!known.has(k)) {
      probs.push(`request ${n}: unknown parameter ${repr(k)} (the API ignores unknown filters and would return ` +
        `unfiltered counts); known: ${Object.keys(ep.params || {}).sort(cmp).join(", ")}`);
    }
  }
  for (const [parent, child] of NESTED) {
    if (empty(p[child])) continue;
    const tops = asList(p[parent]).filter((x) => x !== undefined && x !== null && x !== "");
    if (tops.length !== 1 || tops.some((x) => pyStr(x).includes(BULLET))) {
      probs.push(`request ${n}: ${child} needs exactly one ${parent} (the API filters a ${child} only as ` +
        `${parent}='<${parent}>' + U+2022 bullet + '<${child}>'); for several ${parent} values use separate ` +
        "requests or write the bullet form in the list yourself");
    }
  }
  return probs;
}

function checkSpec(spec: Spec, pack: Pack): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    const n = repr(r.name ?? null);
    probs.push(...paramProblems(pack, r));
    if (r.endpoint === "trends") {
      const [a, b] = [p.date_received_min, p.date_received_max];
      if (!(a && b)) {
        probs.push(`request ${n}: trends needs date_received_min and date_received_max (YYYY-MM-DD)`);
        continue;
      }
      let k: number;
      try {
        k = periods(a, b, p.interval || "month").length;
      } catch (e) {
        if (!(e instanceof BadDate)) throw e;
        probs.push(`request ${n}: dates must be YYYY-MM-DD and interval year, quarter or month`);
        continue;
      }
      if (k > MAX_PERIODS) probs.push(`request ${n}: ${k} periods; at most ${MAX_PERIODS} (use a longer interval)`);
    }
    if (r.endpoint === "complaints" && Math.trunc(Number(p.page_size || 1000)) > 10000) {
      probs.push(`request ${n}: page_size is at most 10000`);
    }
  }
  return probs;
}

// ---------------------------------------------------------------------- fetch
async function complaints(c: Client, params: Record<string, unknown>, maxRows: unknown): Promise<[Row[], number | null]> {
  const limit = Math.trunc(Number(maxRows || 10000));
  const size = Math.min(Math.trunc(Number(params.page_size || 1000)), 10000);
  const query = q(params);
  let rows: Row[] = [];
  let after: string | null = null, tot: number | null = null;
  while (rows.length < limit) {
    const page: Record<string, unknown> = { ...query, size: Math.min(size, limit - rows.length), no_aggs: "true" };
    if (after) page.search_after = after;
    const data = await c.getJson("/", page);
    tot = total(data);
    const hits: any[] = data?.hits?.hits || [];
    rows = rows.concat(hitRows(data));
    if (hits.length < (page.size as number)) break;
    const last: any[] = hits[hits.length - 1].sort || [];
    if (last.length < 2) break;
    after = `${pyStr(last[0])}_${pyStr(last[1])}`;
  }
  return [rows.slice(0, limit), tot];
}

const today = () => {
  const d = new Date();
  return iso([d.getFullYear(), d.getMonth() + 1, d.getDate()]);
};
const blanks = (rows: Row[]) => rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? ""])));

async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const c = gr.clientFor(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [, params, probs0] = gr.resolve(pack, r);
    const probs = [...probs0, ...paramProblems(pack, r)];
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const kind = r.endpoint, name = r.name;
    let rows: Row[];
    if (kind === "complaints") {
      let tot: number | null;
      [rows, tot] = await complaints(c, params, r.max_rows);
      if (tot && tot > rows.length) {
        notes.push(`${name}: ${rows.length.toLocaleString("en-US")} of ${tot.toLocaleString("en-US")} matching complaints ` +
          "(max_rows); use aggregations or trends for counts, or narrow the filters.");
      }
    } else if (kind === "aggregations") {
      const data = await c.getJson("/", { ...q(params), size: 0 });
      rows = buckets(data, pyStr(params.agg), pyStr(params.sub ?? null).toLowerCase() === "true");
    } else if (kind === "trends") {
      rows = [];
      const by = params.by as string | undefined;
      for (const [label, a, b] of periods(params.date_received_min as string, params.date_received_max as string, params.interval as string)) {
        const query: Record<string, unknown> = { ...q(params), date_received_min: a, date_received_max: b, size: 0 };
        if (!by) query.no_aggs = "true";
        const data = await c.getJson("/", query);
        if (by) {
          for (const x of buckets(data, by, false)) {
            rows.push({ period: label, period_start: a, period_end: b, [by]: x.key, complaints: x.complaints,
              period_total: x.total_matching });
          }
        } else rows.push({ period: label, period_start: a, period_end: b, complaints: total(data) });
      }
      if (rows.length && pyStr(rows[rows.length - 1].period_end) >= today()) {
        notes.push(`${name}: the last period is incomplete (it runs to today or later).`);
      }
    } else if (kind === "complaint") rows = hitRows(await c.getJson(`/${pyStr(params.complaint_id)}`));
    else throw new DataError(`unknown endpoint ${repr(kind ?? null)}`, "bad_request");
    if (!rows.length && !r.allow_empty) {
      const hint = params.company ? " The company filter needs CFPB's exact name (e.g. 'WELLS FARGO & COMPANY'): run an " +
        "aggregations request with agg=company and search_term=<name> to find it." : "";
      throw new DataError(`request ${repr(name)} returned no complaints: check the filter values (exact, case-sensitive ` +
        `names; see source.md).${hint}`, "bad_request");
    }
    tables[name] = blanks(rows);
  }
  return [tables, notes];
}

// ---------------------------------------------------------------------- manual route
function url(pack: Pack, p: string, query: Record<string, unknown>): string {
  return `${String(pack.endpoints.base_url).replace(/\/+$/, "")}${p}?` + pyUrlencode(query);
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [, params, probs] = gr.resolve(pack, r);
    if (probs.length) continue;
    const kind = r.endpoint, name = r.name;
    if (kind === "complaints") {
      const query = { ...q(params), size: Math.min(Math.trunc(Number(r.max_rows || 10000)), 10000), format: "csv", no_aggs: "true" };
      items.push({ name: `${name}#1`, request: name, url: url(pack, "/", query), filename: `${name}.csv`, needs_key: false,
        note: "up to 10,000 complaints; the database web page (consumerfinance.gov/data-research/consumer-complaints/search/) exports more" });
    } else if (kind === "aggregations") {
      items.push({ name: `${name}#1`, request: name, url: url(pack, "/", { ...q(params), size: 0 }), filename: `${name}.json`,
        needs_key: false, note: "" });
    } else if (kind === "trends") {
      periods(params.date_received_min as string, params.date_received_max as string, params.interval as string).forEach(([label, a, b], i) => {
        const query = { ...q(params), date_received_min: a, date_received_max: b, size: 0 };
        items.push({ name: `${name}#${i + 1}`, request: name, url: url(pack, "/", query), filename: `${name}_${label}.json`,
          needs_key: false, note: `period ${label}` });
      });
    } else if (kind === "complaint") {
      items.push({ name: `${name}#1`, request: name, url: url(pack, `/${pyStr(params.complaint_id ?? null)}`, {}).replace(/\?+$/, ""),
        filename: `${name}.json`, needs_key: false, note: "" });
    }
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [, params] = gr.resolve(pack, req);
  const kind = req.endpoint;
  let rows: Row[] = [];
  for (const p of [...files].sort(cmp)) {
    const raw = new TextDecoder("utf-8").decode(fs.readFileSync(p)).replace(/^\uFEFF/, "");
    if (p.toLowerCase().endsWith(".csv")) {
      rows = rows.concat(readCsv(raw));
      continue;
    }
    const data = parsePyJson(raw);
    if (kind === "aggregations") rows = rows.concat(buckets(data, pyStr(params.agg), pyStr(params.sub ?? null).toLowerCase() === "true"));
    else if (kind === "trends") {
      const stem = path.basename(p, path.extname(p));
      rows.push({ period: stem.split("_").pop(), complaints: total(data) });
    } else rows = rows.concat(hitRows(data));
  }
  return blanks(rows);
}

const adapter: Adapter = { fetch, checkSpec, manualItems, parseUpload, periods, q };
export default adapter;
