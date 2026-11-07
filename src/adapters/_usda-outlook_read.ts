/**
 * usda-outlook: reading the published files and pages (the Python adapter's helpers). Rows are Maps so that year
 * columns ("2019", "2026") keep the published order (a JS object moves integer-like keys to the front); asTable()
 * hands them to package.write with that order.
 */
import { DataError } from "../core/http.js";
import { withColumns } from "../core/package.js";
import { fnmatch, unzip, xlsxSheets } from "../core/tabular.js";

export type MRow = Map<string, unknown>;
export type Day = { y: number; m: number; d: number; iso: string };

export const ERS = "https://www.ers.usda.gov";
export const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december"];

/** Python repr() of a str (or str() of a number). */
export function repr(s: unknown): string {
  if (s === null || s === undefined) return "None";
  if (typeof s === "number") return String(s);
  if (typeof s === "boolean") return s ? "True" : "False";
  const t = String(s);
  const q = t.includes("'") && !t.includes('"') ? '"' : "'";
  return q + t.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n").replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t") + q;
}

/** Python str() of a value in an f-string (None as "None"). */
export const pstr = (v: unknown) => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v));
export const words = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
export const strip = (s: string) => s.replace(/^\s+|\s+$/g, "");
export const basename = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
export const blank = (v: unknown) => v === null || v === undefined || v === "";

export function day(y: number, m: number, d: number): Day {
  return { y, m, d, iso: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

/** Python int(x), or null when it raises. */
export function pyInt(v: unknown): number | null {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string" && /^\s*[-+]?\d+(_\d+)*\s*$/.test(v)) return parseInt(v.trim().replace(/_/g, ""), 10);
  return null;
}

// ---------------------------------------------------------------------- text and numbers
/** Decimal("%.15g" % float(s)).normalize() written with format "f". */
function sig15(x: number): string {
  if (x === 0) return "0";
  const [m, es] = Math.abs(x).toExponential(14).split("e");
  const digits = m.replace(".", "").replace(/0+$/, "") || "0";
  const e = Number(es);
  let s: string;
  if (e >= digits.length - 1) s = digits + "0".repeat(e - (digits.length - 1));
  else if (e >= 0) s = digits.slice(0, e + 1) + "." + digits.slice(e + 1);
  else s = "0." + "0".repeat(-e - 1) + digits;
  return (x < 0 ? "-" : "") + s;
}

/** Shortest exact text of an .xlsx float (Excel keeps 15 significant digits). */
export function num(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = strip(String(v));
  if (NUM.test(s) && (s.includes(".") || s.toLowerCase().includes("e"))) {
    const x = parseFloat(s);
    if (!Number.isFinite(x)) return s;
    const t = sig15(x);
    return t === "-0" || t === "" ? "0" : t;
  }
  return s;
}

/** Python bytes.decode("cp1252", errors="replace"): the five undefined bytes become U+FFFD. */
export function cp1252(data: Uint8Array): string {
  return new TextDecoder("windows-1252").decode(data).replace(/[\u0081\u008d\u008f\u0090\u009d]/g, "�");
}

export function utf8OrCp1252(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    return cp1252(data);
  }
}

// ---------------------------------------------------------------------- csv (Python's csv module)
/**
 * Python's csv.reader (excel dialect, not strict) over text read by lines: lines end at "\n" (io.StringIO), or at
 * "\r", "\n" or "\r\n" with universal = true (a text stream opened with newline="").
 */
export function* csvRows(text: string, universal = false): Generator<string[]> {
  let fields: string[] = [];
  let field = "";
  type S = "start_record" | "start_field" | "in_field" | "in_quoted" | "quote_in_quoted" | "eat_crnl";
  let st: S = "start_record";
  const save = () => {
    fields.push(field);
    field = "";
  };
  const lineEnd = universal ? /\r\n|\r|\n/g : /\n/g;
  let pos = 0;
  while (pos < text.length) {
    lineEnd.lastIndex = pos;
    const m = lineEnd.exec(text);
    const end = m ? m.index + m[0].length : text.length;
    for (let i = pos; i <= end; i++) {
      const eol = i === end;
      const ch = eol ? "" : text[i];
      switch (st) {
        case "start_record":
          if (eol) break;
          if (ch === "\n" || ch === "\r") {
            st = "eat_crnl";
            break;
          }
          st = "start_field";
        // falls through
        case "start_field":
          if (eol || ch === "\n" || ch === "\r") {
            save();
            st = eol ? "start_record" : "eat_crnl";
          } else if (ch === '"') st = "in_quoted";
          else if (ch === ",") save();
          else {
            field += ch;
            st = "in_field";
          }
          break;
        case "in_field":
          if (eol || ch === "\n" || ch === "\r") {
            save();
            st = eol ? "start_record" : "eat_crnl";
          } else if (ch === ",") {
            save();
            st = "start_field";
          } else field += ch;
          break;
        case "in_quoted":
          if (eol) break;
          if (ch === '"') st = "quote_in_quoted";
          else field += ch;
          break;
        case "quote_in_quoted":
          if (ch === '"') {
            field += ch;
            st = "in_quoted";
          } else if (ch === ",") {
            save();
            st = "start_field";
          } else if (eol || ch === "\n" || ch === "\r") {
            save();
            st = eol ? "start_record" : "eat_crnl";
          } else {
            field += ch;
            st = "in_field";
          }
          break;
        case "eat_crnl":
          if (ch === "\n" || ch === "\r") break;
          if (eol) st = "start_record";
          else throw new DataError("new-line character seen in unquoted field - do you need to open the file with newline=''?", "api");
          break;
      }
    }
    pos = end;
    if (st === "start_record") {
      yield fields;
      fields = [];
    }
  }
  if (field.length || (st as string) === "in_quoted") {
    save();
    yield fields;
  }
}

/** csv.DictReader: [fieldnames, rows]; blank lines are skipped, a short row's missing cells are null, extra cells dropped. */
export function dictReader(text: string, universal = false): [string[], Generator<MRow>] {
  const it = csvRows(text, universal);
  const first = it.next();
  const names = first.done ? [] : first.value;
  function* rows(): Generator<MRow> {
    for (const r of it) {
      if (!r.length) continue;
      const m: MRow = new Map();
      for (let i = 0; i < Math.min(names.length, r.length); i++) m.set(names[i], r[i]);
      for (let i = r.length; i < names.length; i++) m.set(names[i], null);
      yield m;
    }
  }
  return [names, rows()];
}

/** {k: "" if v is None else v} */
export const noNone = (r: MRow): MRow => new Map([...r].map(([k, v]) => [k, v === null || v === undefined ? "" : v]));

// ---------------------------------------------------------------------- pages (links scraped by their text)
const HTML_ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–",
  mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", copy: "©",
  reg: "®", trade: "™", middot: "·", bull: "•", eacute: "é", shy: "­", sect: "§" };

/** Python html.unescape for numeric references and the common named ones. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (all, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
    }
    return HTML_ENT[e] ?? all;
  });
}

export const textOf = (s: string) => words(unescapeHtml(s.replace(/<[^>]+>/g, " ")));

export type Link = { url: string; text: string; pos: number };

export function pageLinks(body: string, base = ERS): Link[] {
  const out: Link[] = [];
  for (const m of body.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>(.*?)<\/a>/gis)) {
    const href = unescapeHtml(m[1]);
    const url = href.startsWith("http") ? href : base + (href.startsWith("/") ? "" : "/") + href;
    out.push({ url, text: textOf(m[2]), pos: m.index! });
  }
  return out;
}

export function dateOf(text: string): Day | null {
  const m = /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
  return m ? day(parseInt(m[3], 10), MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1, parseInt(m[2], 10)) : null;
}

export type Release = { url: string; label: string; date: Day };

/** Release files on the farm income data-files page, newest first. */
export function fiwReleases(body: string): Release[] {
  const out: Release[] = [];
  for (const a of pageLinks(body)) {
    const m = /^(\w+ \d{1,2}, \d{4}) release(.*)$/i.exec(a.text);
    if (m && /\.(zip|csv)(\?|$)/i.test(a.url)) {
      const d = dateOf(m[1]);
      if (d) out.push({ url: a.url, label: a.text, date: d });
    }
  }
  return out.sort((a, b) => (a.date.iso < b.date.iso ? 1 : a.date.iso > b.date.iso ? -1 : 0));
}

export function fiwLink(body: string, starts: string): Link | null {
  for (const a of pageLinks(body)) if (a.text.toLowerCase().startsWith(starts.toLowerCase()) && a.url.includes("/media/")) return a;
  return null;
}

export type Edition = { url: string; to_year: number; kind: string; updated: string };

/** Baseline ZIPs on the database page. */
export function baselineEditions(body: string): Edition[] {
  const heads = [...body.matchAll(/(Most Recent Early-Release|Most Recent Full-Release|Historic Full-Release)/g)]
    .map((m) => [m.index!, m[0].toLowerCase().includes("early") ? "early" : "full"] as [number, string]);
  const out: Edition[] = [];
  for (const a of pageLinks(body)) {
    const m = /projections-to-(\d{4})\.zip/i.exec(a.url);
    if (!m) continue;
    let kind = "full";
    for (const [pos, k] of heads) if (pos < a.pos) kind = k;
    const upd = /Last Updated\s*(\d{1,2}\/\d{1,2}\/\d{4})/.exec(textOf(body.slice(a.pos, a.pos + 1500)));
    out.push({ url: a.url, to_year: parseInt(m[1], 10), kind, updated: upd ? upd[1] : "" });
  }
  return out;
}

const byYearDesc = (a: Edition, b: Edition) => b.to_year - a.to_year;

export function pickEdition(eds: Edition[], edition: unknown): Edition {
  const e = strip(pstr(edition || "latest")).toLowerCase();
  const full = eds.filter((x) => x.kind === "full").sort(byYearDesc);
  if (e === "latest") {
    if (!full.length) throw new DataError("no full-release baseline ZIP found on the Agricultural Baseline Database page", "api");
    return full[0];
  }
  if (e === "early") {
    const early = eds.filter((x) => x.kind === "early").sort(byYearDesc);
    if (!early.length) {
      throw new DataError("no early-release baseline ZIP is posted now (the early release comes in December and " +
        'is replaced by the full release in February): use edition "latest"', "not_found");
    }
    return early[0];
  }
  const hit = full.filter((x) => String(x.to_year) === e);
  if (!hit.length) {
    throw new DataError(`no baseline edition with projections to ${pstr(edition)} (posted: ` +
      `${full.map((x) => String(x.to_year)).join(", ")})`, "not_found");
  }
  return hit[0];
}

export function pickRelease(rels: Release[], release: unknown): Release {
  const r = strip(pstr(release || "latest"));
  if (!rels.length) throw new DataError("no release files found on the ERS farm income data-files page", "api");
  if (r.toLowerCase() === "latest") return rels[0];
  const hit = rels.filter((x) => x.date.iso === r || x.date.iso.slice(0, 7) === r);
  if (!hit.length) {
    throw new DataError(`no farm income release on ${r} (releases: ` +
      `${rels.slice(0, 12).map((x) => x.date.iso).join(", ")} ...)`, "not_found");
  }
  return hit[0];
}

// ---------------------------------------------------------------------- workbooks
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? all);

/** The sheets of an .xlsx in workbook order (a Record would put integer-like sheet names first). */
export function orderedSheets(data: Uint8Array): [string, (string | null)[][]][] {
  const sheets = xlsxSheets(data);
  const wb = new TextDecoder().decode(unzip(data)["xl/workbook.xml"] || new Uint8Array());
  const names = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => /\bname\s*=\s*"([^"]*)"/.exec(m[0])).filter(Boolean)
    .map((m) => unxml(m![1]));
  return names.filter((n) => n in sheets).map((n) => [n, sheets[n]]);
}

/** gr.grid_records({"sheet": 1, "header_row": hr}, ...) of one grid, as Maps. */
export function gridRecords(grid: (string | null)[][], headerRow: number): MRow[] {
  const hr = headerRow - 1;
  if (grid.length <= hr) return [];
  const head: string[] = [];
  const seen = new Set<string>();
  (grid.at(hr) || []).forEach((h, i) => {
    let name = h !== null && h !== "" ? words(String(h)) : `col${i + 1}`;
    if (seen.has(name)) name = `${name}_col${i + 1}`;
    seen.add(name);
    head.push(name);
  });
  const out: MRow[] = [];
  for (const r of grid.slice(hr + 1)) {
    if (!r.some((v) => v !== null && v !== "")) continue;
    const m: MRow = new Map();
    r.forEach((v, i) => m.set(i < head.length ? head[i] : `col${i + 1}`, v));
    out.push(m);
  }
  return out;
}

export { fnmatch };

/** Rows as package.write takes them: objects, with the columns in the rows' own key order (withColumns). */
export function asTable(rows: MRow[]): Record<string, unknown>[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of r.keys()) if (!seen.has(k)) (seen.add(k), cols.push(k));
  return withColumns(rows.map((r) => Object.fromEntries(r)), cols);
}
