/**
 * DOJ News adapter (justice.gov API v1).
 *
 * - since/until (pack options, never sent): the API filters only by one day, so a date range pages through the
 *   list newest posted first and stops CREATED_MARGIN_DAYS of postings past `since` (at most MAX_PAGES pages).
 * - Paging order: `date` is a day stamp shared by about 100 releases a day, and the API does not keep ties in a
 *   stable order, so sort=date (the default) pages by `created` (posting time to the second) and the rows are
 *   then put in date order. A max_rows cut keeps the newest posted rows, and its note says so. Repeated uuids
 *   are dropped with a note.
 * - normalize: the published values stay; date_iso / created_iso / changed_iso are added (created/changed arrive
 *   as <time datetime="...">unix</time> HTML: their day is the datetime attribute's date, else the UTC day of
 *   the digits). Titles, component and topic names are HTML-unescaped; component_names / topic_names and
 *   teaser_text / body_text (HTML tags removed) are added. since/until are applied here too.
 */
import * as gr from "../core/generic-rest.js";
import { type Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, Tables } from "../core/packs.js";
import { parsePyJson, pyStr } from "../core/py.js";
import { pyJsonClient } from "./_govinfo_json.js";
import { htmlUnescape, PY_WS, pyInt, pyRepr, pyStrip, truthy } from "./_govinfo_py.js";

const MAX_PAGES = 600;            // 30,000 records scanned per request at most
const CREATED_MARGIN_DAYS = 14;   // posting time seen up to 11 days before the release date
// The archive holds U.S. Attorney's Office releases only from January 2013.
const USAO_FROM = "2013-01-01";
const PACK_OPTS = ["since", "until"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DT_ATTR = /datetime\s*=\s*["']?(\d{4}-\d{2}-\d{2})/;

function utcDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (Number.isNaN(d.getTime()) || y < 1 || y > 9999) return "";
  return `${String(y).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function validDay(s: string): boolean {
  const [y, m, d] = s.split("-").map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(2000, m - 1, d));
  dt.setUTCFullYear(y);
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** YYYY-MM-DD from a bare Unix timestamp, or from <time datetime="...">digits</time>. */
export function iso(ts: unknown): string {
  let s = pyStrip(pyStr(truthy(ts) ? ts : ""));
  if (s.includes("<")) {
    const m = DT_ATTR.exec(s);
    if (m && validDay(m[1])) return m[1];
    s = pyStrip(s.replace(/<[^>]*>/g, " "));
  }
  if (!/^\d+$/.test(s.replace(/^-+/, "")) || !/^-?\d+$/.test(s)) return "";
  return utcDay(Number(s) * 1000);
}

const WS_LINES = new RegExp(`\\n[${PY_WS}]*\\n+`, "g");

function text(h: unknown): string {
  let s = pyStr(truthy(h) ? h : "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, "\n");
  s = htmlUnescape(s.replace(/<[^>]+>/g, " ")).split(" ").join(" ");
  return pyStrip(s.replace(WS_LINES, "\n").replace(/[ \t\r\f\v]+/g, " "));
}

function names(v: unknown): string {
  if (!truthy(v)) return "";
  let items: unknown;
  try {
    items = typeof v === "string" ? parsePyJson(v) : v;
  } catch {
    return pyStr(v);
  }
  if (Array.isArray(items)) {
    return items.map((i) => htmlUnescape(i && typeof i === "object" && !Array.isArray(i) ? pyStr((i as any).name ?? "") : pyStr(i)))
      .join("; ");
  }
  return htmlUnescape(pyStr(items));
}

function normalize(req: any, _ep: any, rows: Row[]): Row[] {
  const p = req.params || {};
  const since = pyStr(p.since || ""), until = pyStr(p.until || "");
  const out: Row[] = [];
  for (const r of rows) {
    if (typeof r.title === "string") r.title = htmlUnescape(r.title);     // the API sends entities (&#039;) in titles
    for (const col of ["date", "created", "changed"]) if (col in r) r[col + "_iso"] = iso(r[col]);
    for (const col of ["component", "topic"]) if (col in r) r[col + "_names"] = names(r[col]);
    for (const col of ["teaser", "body"]) if (col in r) r[col + "_text"] = text(r[col]);
    const d = pyStr(r.date_iso ?? "");
    if ((since || until) && d && ((since && d < since) || (until && d > until))) continue;
    out.push(r);
  }
  return out;
}

const strip = (params: Record<string, unknown>) => Object.fromEntries(Object.entries(params).filter(([k]) => !PACK_OPTS.includes(k)));

/** sort=date is sent as sort=created, with `created` added to fields when missing: [date order wanted, created added]. */
function pageByCreated(query: Record<string, unknown>): [boolean, boolean] {
  if (pyStr(query.sort ?? "date") !== "date") return [false, false];
  query.sort = "created";
  const fields = pyStr(query.fields || "").split(",").map((f) => pyStrip(f)).filter(Boolean);
  if (fields.length && !fields.includes("created")) {
    query.fields = [...fields, "created"].join(",");
    return [true, true];
  }
  return [true, false];
}

/** Unix seconds from a bare timestamp or from <time ...>digits</time>; 0 when absent. */
export function ts(v: unknown): number {
  const m = /(-?\d{6,})\s*(?:<\/time>|$)/.exec(pyStrip(pyStr(truthy(v) ? v : "")));
  return m ? parseInt(m[1], 10) : 0;
}

function minusDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return utcDay(Date.UTC(y, m - 1, d) - n * 86400000);
}

function toInt(v: unknown): number | null {
  if (!truthy(v)) return 0;
  if (typeof v === "string" && /^\s*-?\d+\.\d*\s*$/.test(v)) return Math.trunc(Number(v));
  try {
    return pyInt(v);
  } catch {
    return null;
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** A note when rows predate USAO_FROM: counts across that date compare different sets of offices. */
function coverageNote(name: string, rows: Row[]): string {
  const early = rows.map((x) => pyStr(x.date_iso || "")).filter((d) => d && d < USAO_FROM).length;
  if (!early) return "";
  return `${name}: ${fmt(early)} row(s) are dated before ${USAO_FROM}, when the justice.gov archive held no U.S. ` +
    "Attorney's Office releases (Main Justice components only). Counts before and after that date are " +
    "not comparable (and from 2013 one announcement is often posted by both): start a trend in 2013, " +
    "or count releases listing a Main Justice component (component_names not starting 'USAO').";
}

const adapter: Adapter = {
  normalize,

  checkSpec(spec) {
    const probs: string[] = [];
    for (const r of spec.requests || []) {
      const p = r.params || {};
      const name = pyRepr(r.name ?? null);
      for (const k of PACK_OPTS) if (truthy(p[k]) && !DAY.test(pyStr(p[k]))) probs.push(`request ${name}: ${k} must be YYYY-MM-DD`);
      if ((truthy(p.since) || truthy(p.until)) && (("sort" in p ? p.sort : "date") !== "date" || ("direction" in p ? p.direction : "DESC") !== "DESC")) {
        probs.push(`request ${name}: since/until need sort=date and direction=DESC (the defaults)`);
      }
      if (truthy(p.since) && truthy(p.until) && pyStr(p.since) > pyStr(p.until)) probs.push(`request ${name}: since is after until`);
      for (const k of ["page", "pagesize"]) {
        if (k in p) probs.push(`request ${name}: do not set ${k}; paging is automatic (use max_rows)`);
      }
    }
    return probs;
  },

  /** `client` replaces the pack's client (tests). */
  async fetch(spec: Spec, pack: Pack, _route: string, client?: Client): Promise<[Tables, string[]]> {
    const c = client ?? pyJsonClient(gr.clientFor(pack), pack);
    const tables: Tables = {};
    const notes: string[] = [];
    for (const r of spec.requests) {
      const [ep, params, probs] = gr.resolve(pack, r);
      if (probs.length) throw new DataError(probs.join("; "), "bad_request");
      const since = pyStr(params.since || "");
      const limit = pyInt(r.max_rows || ep.max_rows || 20000);
      const pg = ep.paging || { type: "none" };
      let rows: Row[];
      if (pg.type !== "page") {
        [rows] = await gr.fetchRequest(c, ep, strip(params), limit);
        rows = normalize(r, ep, rows);
      } else {
        const [p, query] = gr.split(ep, strip(params));
        const [byDate, added] = pageByCreated(query);
        const cutoff = since && byDate ? minusDays(since, CREATED_MARGIN_DAYS) : since;
        const size = pyInt(pg.size), start = pyInt(pg.start ?? 0);
        let page = start, total: number | null = null, stopped: string | null = null, repeats = 0;
        rows = [];
        const seen = new Set<unknown>();
        for (;;) {
          const resp = await c.request("GET", p, { ...query, [pg.page_param]: page, [pg.size_param]: size });
          const data = resp.json();
          const got: any[] = gr.dig(data, ep.records ?? "results") || [];
          total = toInt(gr.dig(data, ep.total ?? ""));
          for (const x of normalize(r, ep, gr.clean(got, ep))) {
            const u = x.uuid;
            if (truthy(u) && seen.has(u)) {
              repeats++;
              continue;
            }
            seen.add(u);
            rows.push(x);
          }
          const orderCol = byDate ? "created" : "date";
          const days = got.map((g) => iso(g?.[orderCol])).filter(Boolean);
          const oldest = days.length ? days.reduce((a, b) => (b < a ? b : a)) : "";
          if (rows.length >= limit) {
            stopped = "max_rows";
            rows = rows.slice(0, limit);
            break;
          }
          if (got.length < size || (cutoff && oldest && oldest < cutoff)) break;
          page++;
          if (page - start >= MAX_PAGES) {
            stopped = "pages";
            break;
          }
        }
        if (byDate) {
          const desc = pyStr(query.direction ?? "DESC").toUpperCase() !== "ASC";
          const key = (x: Row): [number, number] => [ts(x.date), ts(x.created)];
          rows.sort((a, b) => {
            const [ka, kb] = [key(a), key(b)];
            const c0 = ka[0] - kb[0] || ka[1] - kb[1];
            return desc ? -c0 : c0;
          });
          if (added) for (const x of rows) {
            delete x.created;
            delete x.created_iso;
          }
        }
        if (repeats) {
          notes.push(`${r.name}: ${fmt(repeats)} release(s) came back twice while paging (a release posted ` +
            "or removed during the fetch shifts the pages); the repeats were dropped, and about as " +
            "many may be missing. Fetch again (--force) if the count matters.");
        }
        if (stopped === "max_rows") {
          notes.push(`${r.name}: stopped at ${fmt(rows.length)} rows (max_rows); the source has more` +
            (total ? ` (the API reports ${fmt(total)} records for the title/day filter)` : "") +
            (byDate ? ". The cut follows posting time (the newest posted rows, then put in date order), " +
              "so releases near the cut can differ from a cut by date" : "") +
            ". Narrow the filter or raise max_rows.");
        } else if (stopped === "pages") {
          notes.push(`${r.name}: stopped after scanning ${fmt(MAX_PAGES * size)} records newest first` +
            (byDate && since ? ` (by posting time, reading ${CREATED_MARGIN_DAYS} days of postings past \`since\`)` : "") +
            "; older matches were not reached. Narrow the title filter or the date range.");
        }
      }
      if (!rows.length && !r.allow_empty) {
        throw new DataError(`request ${pyRepr(r.name)} returned no rows: check the title words and dates (see source.md)`, "bad_request");
      }
      tables[r.name] = rows;
      const note = coverageNote(r.name, rows);
      if (note) notes.push(note);
    }
    return [tables, notes];
  },

  manualItems(spec, pack) {
    const s: Spec = structuredClone(spec);
    const ranged = new Set<string>();
    for (const r of s.requests || []) {
      const p = r.params || {};
      if (PACK_OPTS.some((k) => k in p)) ranged.add(r.name);
      r.params = strip(p);
      if (pyStr(p.sort ?? "date") === "date") r.params.sort = "created";   // date ties shift between pages
    }
    const items = gr.manualItems(pack, s);
    for (const it of items) {
      if (ranged.has(it.request)) {
        it.note = (it.note ? it.note + "; " : "") + "newest first; the date range (since/until) is applied when the files are ingested";
      }
    }
    return items;
  },
};

export default adapter;
