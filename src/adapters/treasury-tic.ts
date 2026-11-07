/**
 * Treasury International Capital (TIC): published tab-delimited text tables, read by the generic $tsv reader and
 * made long here (one row per country and month), values as published.
 *
 *   major_foreign_holders           slt_table5.txt: "Country" then one column per month (2026-08 ...), billions
 *   major_foreign_holders_history   mfhhis01.txt: one block per year, a month-name line ("Dec Nov ...") above a
 *                                   "Country 2025 2025 ..." line, rows to "Grand Total", then "Of which:" rows
 *   holdings_by_country             slt_table1.txt: machine column names on line 9, then rows; a definitions
 *                                   footer ("for_lt_corp_net: 19 + 23 ...") follows the data
 * The spec-only params country, from and to filter the rows (the files are small, so the whole file is read).
 */
import type { Adapter, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07",
  aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const PERIOD = /^\d{4}-\d{2}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

/** A published row label without footnote marks ("Grand Total 1/" -> "Grand Total"). */
export function label(s: unknown): string {
  return pyStr(s ?? "").replace(/\s+\d+\/\s*$/g, "").replace(/\s+/g, " ").trim();
}

/** What a row is: a country, the All Other remainder, the Grand Total or a foreign-official line. */
export function kind(name: string): string {
  const n = name.toLowerCase();
  if (n === "grand total") return "grand_total";
  if (n === "all other") return "all_other";
  if (n.startsWith("of which") || /^(for\. official|treasury bills|t-bonds & notes)$/.test(n)) return "foreign_official";
  return "country";
}

/** "Of which" lines named as table 5 names them, so both files give the same labels. */
const OFFICIAL: Record<string, string> = { "for. official": "Of Which: Foreign Official",
  "treasury bills": "Of Which: Foreign Official Treasury Bills",
  "t-bonds & notes": "Of Which: Foreign Official T-Bonds & Notes" };

function list(v: unknown): string[] {
  const xs = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v];
  return xs.map((x) => pyStr(x).trim().toLowerCase()).filter(Boolean);
}

function keep(req: SpecRequest, country: string, code: string, period: string): boolean {
  const p = req.params || {};
  const want = list(p.country);
  if (want.length && !want.includes(country.toLowerCase()) && !(code && want.includes(code.toLowerCase()))) return false;
  if (p.from && period < pyStr(p.from)) return false;
  if (p.to && period > pyStr(p.to)) return false;
  return true;
}

function table5(req: SpecRequest, rows: Row[]): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    const name = label(r.Country);
    if (!name) continue;
    const periods = Object.keys(r).filter((k) => PERIOD.test(k));
    if (!periods.some((k) => NUMBER.test(pyStr(r[k] ?? "")))) continue; // notes and blank lines
    for (const period of periods) {
      if (!keep(req, name, "", period)) continue;
      out.push({ country: name, kind: kind(name), period, holdings_billions: pyStr(r[period] ?? "") });
    }
  }
  return out;
}

/**
 * The stacked yearly blocks of mfhhis01.txt (rows col1..colN from $tsv with header_row 0).
 *
 * Two quirks of the published file (verified 2026-11-07):
 * - A series-break year shows one month twice (June 2002-2011, March 2000): the first column is the new
 *   series, the second the previous series "shown for comparison only" (the file's footnotes). The second
 *   is kept only with include_comparison, marked comparison_only.
 * - In those years January is a 14th column one line up: its header "Jan" sits above the month line, the
 *   month line holds the year there, and each row's January value is on the line above the row. It is read
 *   from the line above.
 */
export function history(req: SpecRequest, rows: Row[]): Row[] {
  const out: Row[] = [];
  const withComparison = ["true", "1", "yes"].includes(pyStr(req.params?.include_comparison ?? "").toLowerCase());
  let months: { m: string; shifted: boolean; year?: string }[] = [];
  let cols: { period: string; shifted: boolean; comparison: boolean }[] = [];
  let inBlock = false;
  let prev: string[] = [];
  const cells = (r: Row) => Object.keys(r).filter((k) => /^col\d+$/.test(k)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))).map((k) => pyStr(r[k] ?? "").trim());
  for (const r of rows) {
    const c = cells(r);
    const first = label(c[0]);
    const low = first.toLowerCase();
    const before = prev;
    prev = c;
    if (!first && c.slice(1).filter((x) => MONTHS[x.slice(0, 3).toLowerCase()]).length >= 2) {
      months = c.slice(1).map((x) => (MONTHS[x.slice(0, 3).toLowerCase()] ? { m: MONTHS[x.slice(0, 3).toLowerCase()], shifted: false }
        : /^\d{4}$/.test(x) && before.at(c.indexOf(x))?.toLowerCase() === "jan" ? { m: "01", shifted: true, year: x }
          : { m: "", shifted: false }));
      inBlock = false;
      continue;
    }
    if (low === "country") {
      const seen = new Set<string>();
      cols = c.slice(1).map((y, i) => {
        const mo = months[i];
        const year = mo?.shifted ? mo.year! : y;
        const period = mo?.m && /^\d{4}$/.test(year) ? `${year}-${mo.m}` : "";
        const comparison = !!period && seen.has(period);
        if (period) seen.add(period);
        return { period, shifted: !!mo?.shifted, comparison };
      });
      inBlock = true;
      continue;
    }
    if (!inBlock || !first || low === "of which:") continue;
    if (/^\d+\/$/.test(first) || first.length > 60) {
      inBlock = false; // the footnotes after the last block
      continue;
    }
    const name = OFFICIAL[low] ?? first;
    cols.forEach((col, i) => {
      const v = (col.shifted ? before[i + 1] : c[i + 1]) ?? "";
      if (!col.period || v === "" || /^-+$/.test(v) || (col.comparison && !withComparison) || !keep(req, name, "", col.period)) return;
      out.push({ country: name, kind: kind(name), period: col.period, holdings_billions: v, comparison_only: col.comparison });
    });
    if (low === "t-bonds & notes") inBlock = false;
  }
  const per = (r: Row) => String(r.period);
  return out.sort((a, b) => (per(a) === per(b) ? 0 : per(a) < per(b) ? 1 : -1));
}

function table1(req: SpecRequest, rows: Row[]): Row[] {
  return rows.filter((r) => PERIOD.test(pyStr(r.date ?? "")) &&
    keep(req, label(r.country), pyStr(r.country_code ?? ""), pyStr(r.date)));
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  if (req.endpoint === "major_foreign_holders") return table5(req, rows);
  if (req.endpoint === "major_foreign_holders_history") return history(req, rows);
  if (req.endpoint === "holdings_by_country") return table1(req, rows);
  return rows;
}

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    for (const k of ["from", "to"]) {
      const v = r.params?.[k];
      if (v !== undefined && v !== null && v !== "" && !PERIOD.test(pyStr(v))) {
        bad.push(`request ${JSON.stringify(r.name)}: ${k} must be a month as YYYY-MM (got ${JSON.stringify(v)})`);
      }
    }
  }
  return bad;
}

const adapter: Adapter = { normalize, checkSpec };
export default adapter;
