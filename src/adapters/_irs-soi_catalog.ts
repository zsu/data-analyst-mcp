/**
 * irs-soi `table` and `table_list`: the catalog (packs/irs-soi/tables.json), the index pages that link each table's
 * files, and the request -> rows step. The workbook reading is in _irs-soi_tables.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import { Client, DataError } from "../core/http.js";
import type { Row, SpecRequest } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyStr } from "../core/py.js";
import { withColumns } from "../core/tabular.js";
import { longRows, markerNotes, pageLinks, readSoiGrid, readWorkbook, wideRows, type Link, type TableFilter } from "./_irs-soi_tables.js";

export type TableEntry = {
  id: string; product: string; number: string; title: string; index: string | string[]; file: string;
  year_type: string; first_year: number | null; last_year_verified: number | null; whole_series?: boolean; series?: string;
  overrides?: Record<string, string>; override_why?: string; sheet?: string | number; header_lines?: number[];
};

const BASE = "https://www.irs.gov/pub/irs-soi";
let CAT: { checked: string; tables: TableEntry[] } | null = null;

export function catalog(): TableEntry[] {
  if (!CAT) CAT = readJson(path.join(PACKS_DIR, "irs-soi"), "tables.json") as any;
  return CAT!.tables;
}

const blank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
const list = (v: unknown): string[] => (blank(v) ? [] : (Array.isArray(v) ? v : [v]).map((x) => pyStr(x).trim()).filter(Boolean));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.-]+/g, " ").replace(/(^|\s)-+|-+(\s|$)/g, " ").trim();

/** Words a loose table name may use for a product: "pub 16 2.1", "corporation 2.1", "data book 1-6". */
const PRODUCT_WORDS: [RegExp, string][] = [
  [/\b(pub(lication)? ?1304|individual|1040)\b/, "in_"], [/\b(percentile|shares?)\b/, "shares_"],
  [/\b(pub(lication)? ?16|corp(oration)?s?|1120)\b/, "corp_"], [/\b(partnerships?|1065)\b/, "partnership_"],
  [/\b(sole ?prop(rietorship)?s?|schedule c)\b/, "soleprop_"], [/\b(integrated|all business(es)?)\b/, "business_"],
  [/\b(data ?book|55 ?b)\b/, "databook_"], [/\bhistoric(al)?\b/, "historical_"], [/\bestate\b/, "estate_"],
  [/\bgift\b/, "gift_"], [/\bwealth\b/, "wealth_"], [/\b(exempt|990|charit(y|ies)|eo)\b/, "eo_"],
  [/\b(private foundations?|pf)\b/, "pf_"], [/\b(cfc|controlled foreign)\b/, "cfc_"], [/\bforeign tax credit\b/, "ftc_"],
  [/\b(country.by.country|cbc|8975)\b/, "cbc_"]];

/** The catalog entry a `table` value names: an id ("in_1.1"), or a product word and number ("corporation 2.1"). */
export function findTable(v: unknown): [TableEntry | null, TableEntry[]] {
  const s = pyStr(v ?? "").trim();
  const cat = catalog();
  const exact = cat.find((t) => t.id.toLowerCase() === s.toLowerCase());
  if (exact) return [exact, []];
  const n = norm(s);
  const num = /(\d+[a-z]?(?:[.-]\d+[a-z]?)?)\s*$/i.exec(n)?.[1]?.toUpperCase();
  const prefixes = PRODUCT_WORDS.filter(([re]) => re.test(n)).map(([, p]) => p);
  if (num) {
    const hits = cat.filter((t) => t.number.toUpperCase() === num && (!prefixes.length || prefixes.some((p) => t.id.startsWith(p))));
    if (hits.length === 1) return [hits[0], []];
    if (hits.length > 1) return [null, hits];
  }
  return [null, searchTables(s).slice(0, 8)];
}

/** Catalog entries ranked by the words of a query found in their id, product, number and title. */
export function searchTables(q: string): TableEntry[] {
  const words = norm(q).split(" ").filter((w) => w.length > 1 && !["the", "of", "and", "by", "table", "irs", "soi"].includes(w));
  if (!words.length) return catalog();
  const score = (t: TableEntry) => {
    const hay = norm(`${t.id} ${t.product} table ${t.number} ${t.title}`);
    return words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
  };
  return catalog().map((t) => [t, score(t)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

// ---------------------------------------------------------------------- index pages, once per run
export class Pages {
  private html = new Map<string, string>();
  constructor(public client: Client) {}
  async links(t: TableEntry): Promise<Map<number | null, Link>> {
    const re = new RegExp(t.file, "i");
    const out = new Map<number | null, Link>();
    for (const page of Array.isArray(t.index) ? t.index : [t.index]) {
      if (!this.html.has(page)) this.html.set(page, (await this.client.get(page)).text());
      for (const l of pageLinks(this.html.get(page)!, page)) {
        if (!re.test(l.file)) continue;
        if (!out.has(l.year)) out.set(l.year, l); // the first link of a year on the page
      }
    }
    for (const [y, f] of Object.entries(t.overrides || {})) {
      out.set(Number(y), { file: f, url: `${BASE}/${f}`, text: `${y} (override: ${t.override_why || "the page link is wrong"})`, year: Number(y) });
    }
    return out;
  }
}

// ---------------------------------------------------------------------- years
const YEAR_KEYS = ["year", "tax_year", "fiscal_year", "filing_year"];

/** Asked years ([] = the latest posted). Throws a bad_request on a malformed year. */
export function askedYears(p: Record<string, any>): number[] {
  const int = (k: string) => {
    const s = pyStr(p[k]).trim();
    if (!/^\d{4}$/.test(s)) throw new DataError(`${k} must be a four-digit year (got ${JSON.stringify(p[k])})`, "bad_request");
    return Number(s);
  };
  const one = YEAR_KEYS.find((k) => !blank(p[k]));
  if (one) return [int(one)];
  if (!blank(p.start_year) || !blank(p.end_year)) {
    const a = int(blank(p.start_year) ? "end_year" : "start_year"), b = blank(p.end_year) ? null : int("end_year");
    const out: number[] = [];
    for (let y = a; y <= (b ?? a); y++) out.push(y);
    if (b === null) out.push(Infinity); // open range: to the latest posted
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------- checks (no network)
export function checkTable(r: SpecRequest): string[] {
  const p: any = r.params || {};
  const name = JSON.stringify(r.name ?? null);
  const probs: string[] = [];
  if (r.endpoint === "table_list") return probs;
  const [t, near] = findTable(p.table);
  if (!t) {
    probs.push(`request ${name}: table ${JSON.stringify(p.table ?? null)} is not in the catalog` +
      (near.length ? `; did you mean ${near.map((x) => `${x.id} (${x.title.slice(0, 60)})`).join("; ")}?` : "") +
      " (table_list lists every table)");
    return probs;
  }
  let ys: number[];
  try {
    ys = askedYears(p);
  } catch (e) {
    return [`request ${name}: ${(e as Error).message}`];
  }
  const fin = ys.filter(Number.isFinite);
  if (fin.length > 1 && fin[fin.length - 1] < fin[0]) probs.push(`request ${name}: end_year is before start_year`);
  if (fin.length > 15 && !t.whole_series) probs.push(`request ${name}: ${fin.length} years is one workbook each; narrow the range`);
  if (t.first_year && fin.length && fin[0] < t.first_year && !t.whole_series) {
    probs.push(`request ${name}: ${t.id} is listed from ${t.first_year} (asked ${fin[0]}); older years use other table numbers ` +
      `on ${[t.index].flat()[0]}`);
  }
  if (!blank(p.layout) && !["long", "wide"].includes(pyStr(p.layout))) probs.push(`request ${name}: layout is long or wide`);
  return probs;
}

// ---------------------------------------------------------------------- fetch
function filterOf(p: any): TableFilter {
  return { rows: list(p.rows), columns: list(p.columns), section: list(p.section) };
}

/** Rows of one `table` request, read from the downloaded workbooks; notes describe each file. */
export async function fetchTable(r: SpecRequest, pages: Pages, limit: number, notes: string[],
  read?: (link: Link) => Promise<Uint8Array>): Promise<Row[]> {
  const p: any = r.params || {};
  const [t] = findTable(p.table);
  if (!t) throw new DataError(checkTable(r).join("; "), "bad_request");
  const links = await pages.links(t);
  const posted = [...links.keys()].filter((y): y is number => y !== null).sort((a, b) => a - b);
  const asked = askedYears(p);
  let pick: Link[];
  if (t.whole_series) {
    // one file holds every year: the latest edition (or the asked edition, when it is posted)
    const ed = asked.filter(Number.isFinite).length === 1 && links.has(asked[0]) ? links.get(asked[0])! : links.get(posted[posted.length - 1] ?? null) ?? links.get(null);
    if (!ed) throw new DataError(`${t.id}: no file found on ${[t.index].flat().join(", ")} (the page changed?)`, "not_found");
    pick = [ed];
    if (asked.length) notes.push(`${r.name}: ${t.id} holds ${t.series || "every year"} in one file; read ${ed.file}` +
      " (filter the years with rows or section)");
  } else {
    let ys = asked.length ? asked : posted.slice(-1);
    if (ys.includes(Infinity)) ys = [...ys.filter(Number.isFinite), ...posted.filter((y) => y > Math.max(...ys.filter(Number.isFinite)))];
    const missing = ys.filter((y) => !links.has(y));
    if (!posted.length) throw new DataError(`${t.id}: no file found on ${[t.index].flat().join(", ")} (the page changed?)`, "not_found");
    if (missing.length) {
      throw new DataError(`request ${JSON.stringify(r.name)}: ${t.id} is not posted for ${missing.join(", ")} (posted: ` +
        `${posted[0]}-${posted[posted.length - 1]}${posted.length < posted[posted.length - 1] - posted[0] + 1 ? ", with gaps: " + posted.join(", ") : ""}); ` +
        `see ${[t.index].flat()[0]}`, "not_found");
    }
    pick = ys.map((y) => links.get(y)!);
  }
  const layout = pyStr(p.layout ?? "long");
  const f = filterOf(p);
  const headerLines = Array.isArray(p.header_lines) ? p.header_lines.map(Number) : t.header_lines;
  const out: Row[] = [];
  let head: string[] | null = null;
  for (const link of pick) {
    const body = read ? await read(link) : new Uint8Array((await pages.client.get(link.url)).body);
    const wb = readWorkbook(body, link.file);
    const want = p.sheet ?? t.sheet;
    let names = wb.order.filter((n) => wb.sheets[n].filter((row) => row.some((v) => v !== null && String(v).trim())).length >= 3);
    if (!blank(want)) {
      const w = pyStr(want);
      const hit = wb.order.find((n) => n.trim().toLowerCase() === w.trim().toLowerCase()) ?? (/^\d+$/.test(w) ? names[Number(w) - 1] : undefined);
      if (!hit) throw new DataError(`${link.file}: no sheet ${JSON.stringify(want)} (sheets: ${wb.order.join(", ")})`, "bad_request");
      names = [hit];
    }
    const year = link.year ?? "";
    for (const sheet of names) {
      let tab;
      try {
        tab = readSoiGrid(wb.sheets[sheet], wb.marks[sheet], headerLines);
      } catch (e) {
        if (names.length > 1 && e instanceof DataError) {
          notes.push(`${r.name}: ${link.file} sheet ${JSON.stringify(sheet)} skipped: ${e.message}`);
          continue;
        }
        throw e;
      }
      const id = { TABLE: t.id, YEAR: year, YEAR_TYPE: t.whole_series ? "edition" : t.year_type, SHEET: sheet.trim() };
      if (layout === "wide") {
        const [rows, h] = wideRows(tab, id, f);
        if (head && h.join("|") !== head.join("|")) {
          notes.push(`${r.name}: the columns differ between files or sheets; wide rows keep every column (blank where absent)`);
          head = [...head, ...h.filter((x) => !head!.includes(x))];
        } else head = h;
        out.push(...rows);
      } else out.push(...longRows(tab, id, f));
      notes.push(`${r.name}: ${link.file} (${link.url})${names.length > 1 ? ` sheet ${JSON.stringify(sheet.trim())}` : ""}: ` +
        `"${tab.title.slice(0, 160)}"; ${tab.rows.length} lines x ${tab.columns.length} columns` +
        (tab.units ? `; money amounts in ${tab.units} (percent, average and count columns as their header says)` : "; units: see the column headers") +
        (tab.notes.length ? `; ${tab.notes.join("; ")}` : ""));
      const marks = markerNotes(tab);
      if (marks.length) notes.push(`${r.name}: markers (FLAG): ${marks.join(" | ").slice(0, 600)}`);
      if (out.length > limit) {
        notes.push(`${r.name}: stopped at ${limit} rows (max_rows); filter with rows, columns or section, or raise max_rows`);
        out.length = limit;
        return head ? withColumns(out, head) : out;
      }
    }
  }
  if (!out.length && (f.rows?.length || f.columns?.length || f.section?.length)) {
    notes.push(`${r.name}: the filters (rows, columns, section) matched nothing; run without them to see the labels`);
  }
  return head ? withColumns(out, head) : out;
}

/** table_list: the catalog, optionally with the years posted now (live: true reads each index page). */
export async function tableList(r: SpecRequest, pages: Pages | null): Promise<Row[]> {
  const p: any = r.params || {};
  let tabs = catalog();
  if (!blank(p.product)) tabs = tabs.filter((t) => list(p.product).some((w) => `${t.product} ${t.id}`.toLowerCase().includes(w.toLowerCase())));
  if (!blank(p.query)) {
    const hits = new Set(searchTables(pyStr(p.query)));
    tabs = tabs.filter((t) => hits.has(t));
  }
  const live = pages && ["true", "1", "yes"].includes(pyStr(p.live ?? "").toLowerCase());
  const out: Row[] = [];
  for (const t of tabs) {
    const row: Row = { TABLE: t.id, PRODUCT: t.product, NUMBER: t.number, TITLE: t.title, YEAR_TYPE: t.whole_series ? "edition" : t.year_type,
      FIRST_YEAR: t.first_year ?? "", LAST_YEAR_VERIFIED: t.last_year_verified ?? "", WHOLE_SERIES: t.whole_series ? "True" : "False",
      SERIES: t.series || "", INDEX: [t.index].flat().join(" ") };
    if (live) {
      const ys = [...(await pages!.links(t)).keys()].filter((y): y is number => y !== null).sort((a, b) => a - b);
      row.YEARS_POSTED = ys.join(" ");
    }
    out.push(row);
  }
  return out;
}

/** Manual route: the index page of each asked table (the file name changes by year, so the page is the link). */
export function manualTableItems(r: SpecRequest): any[] {
  const p: any = r.params || {};
  if (r.endpoint === "table_list") return [];
  const [t] = findTable(p.table);
  if (!t) return [];
  let ys: number[] = [];
  try {
    ys = askedYears(p).filter(Number.isFinite);
  } catch {
    /* checkSpec names it */
  }
  const what = t.whole_series ? "the newest file" : ys.length ? `the ${ys.join(", ")} file(s)` : "the newest year's file";
  return [{ name: `${r.name}#1`, request: r.name, url: [t.index].flat()[0], filename: `${r.name}.xls`, also_ext: [".xlsx", ".zip"],
    needs_key: false, method: "GET", body: null,
    note: `open the page, find ${t.product} table ${t.number} ("${t.title.slice(0, 80)}") and download ${what} ` +
      `(file names match /${t.file}/); upload it unchanged (keep the published file name, e.g. 23in11si.xls, so the year is known)` }];
}

/** Rows of uploaded workbooks for a `table` request (the year from the file name). */
export async function uploadedTable(r: SpecRequest, files: string[], limit: number, notes: string[]): Promise<Row[]> {
  const p: any = r.params || {};
  const [t] = findTable(p.table);
  if (!t) throw new DataError(checkTable(r).join("; "), "bad_request");
  const fake = new Pages(null as unknown as Client);
  const links = new Map<number | null, Link>();
  for (const f of files) {
    const file = path.basename(f);
    const y = /^(\d\d)/.test(file) ? (Number(file.slice(0, 2)) >= 80 ? 1900 : 2000) + Number(file.slice(0, 2)) : null;
    links.set(y, { file, url: f, text: file, year: y });
  }
  fake.links = async () => links;
  const asked = askedYears(p).filter(Number.isFinite);
  const req = { ...r, params: { ...p, ...(asked.length ? {} : { year: undefined }) } };
  if (!asked.length && !t.whole_series) {
    // every uploaded file
    const out: Row[] = [];
    for (const [y] of links) {
      out.push(...await fetchTable({ ...req, params: { ...req.params, year: y ?? undefined } }, fake, limit - out.length, notes,
        async (l) => new Uint8Array(fs.readFileSync(l.url))));
    }
    return out;
  }
  return fetchTable(req, fake, limit, notes, async (l) => new Uint8Array(fs.readFileSync(l.url)));
}
