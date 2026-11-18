/**
 * U.S. Small Business Administration loan data on data.sba.gov. Verified 2026-11-07:
 * - the CKAN API answers 404, but /data.json (the open-data catalog) lists every file;
 * - the 7(a) and 504 FOIA CSVs are under /sites/default/files/uploaded_resources/, named with their as-of date
 *   (FOIA_504_FY2010_Present_asof_260930.csv) and 60 to 255 MB each.
 * list_files reads the catalog. foia streams the CSV through the parser and keeps only the rows that pass the
 * filters, so a 255 MB file never becomes a full table in memory; a filter is required. cohorts sums the same
 * rows per ApprovalFY (and group_by columns) while reading, so a whole file can be totalled.
 */
import fs from "node:fs";
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { pyStr } from "../core/py.js";
import { columnsOf, withColumns } from "../core/tabular.js";

const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v])
  .map((x) => pyStr(x).trim().toUpperCase()).filter(Boolean);

/** The row filter of a foia request. */
export function keeper(p: Record<string, unknown>): (r: Row) => boolean {
  const states = list(p.state), years = list(p.fiscal_year), naics = list(p.naics);
  const from = p.from ? Number(p.from) : null, to = p.to ? Number(p.to) : null;
  return (r) => {
    if (states.length && !states.includes(pyStr(r.ProjectState ?? "").trim().toUpperCase())) return false;
    const fy = pyStr(r.ApprovalFY ?? "").trim();
    if (years.length && !years.includes(fy)) return false;
    if (from !== null && !(Number(fy) >= from)) return false;
    if (to !== null && !(Number(fy) <= to)) return false;
    if (naics.length && !naics.some((n) => pyStr(r.NaicsCode ?? "").trim().startsWith(n))) return false;
    return true;
  };
}

/** The published LoanStatus without spaces ("P I F" is PIF), with both undisbursed codes (7(a) COMMIT, 504 NOT
 * FUNDED) as UNDISBURSED. */
const STATUS: Record<string, string> = { COMMIT: "UNDISBURSED", NOTFUNDED: "UNDISBURSED" };
export const STATUS_CODES = ["CANCLD", "CHGOFF", "CLOSED", "EXEMPT", "PIF", "UNDISBURSED"];
export const statusCode = (v: unknown) => {
  const k = pyStr(v ?? "").replace(/\s+/g, "").toUpperCase();
  return STATUS[k] ?? k;
};
export const GROUPS = ["BorrState", "ProjectState", "ProcessingMethod", "naics2", "NaicsCode", "BusinessType", "BusinessAge",
  "FixedorVariableInterestInd", "TermInMonths", "RevolverStatus", "SoldSecMrktInd", "loan_status_code"];
const NOT_DISBURSED = ["CANCLD", "UNDISBURSED"];

const num = (v: unknown) => {
  const x = Number(pyStr(v ?? "").trim());
  return pyStr(v ?? "").trim() === "" || !Number.isFinite(x) ? 0 : x;
};
const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));

/** Totals per approval fiscal year (cohort) and group: loan counts by status, approved and guaranteed dollars for
 * all and for disbursed loans, and the gross charge-off amount. */
export class Cohorts {
  cells = new Map<string, { key: string[]; c: Record<string, number | string> }>();
  guaranty = false;
  constructor(public groups: string[]) {}

  add(r: Row): void {
    const g = this.groups.map((k) => (k === "naics2" ? pyStr(r.NaicsCode ?? "").trim().slice(0, 2)
      : k === "loan_status_code" ? statusCode(r.LoanStatus) : pyStr(r[k] ?? "").trim()));
    const key = [pyStr(r.ApprovalFY ?? "").trim(), ...g];
    const id = JSON.stringify(key);
    if ("SBAGuaranteedApproval" in r) this.guaranty = true;
    let cell = this.cells.get(id);
    if (!cell) {
      cell = { key, c: { as_of: pyStr(r.AsOfDate ?? "").trim(), loans: 0, gross_approval: 0, sba_guaranteed: 0, loans_disbursed: 0,
        disbursed_gross_approval: 0, disbursed_sba_guaranteed: 0, ...Object.fromEntries(STATUS_CODES.map((s) => [`loans_${s.toLowerCase()}`, 0])),
        gross_chargeoff_amount: 0, loans_other_status: 0 } };
      this.cells.set(id, cell);
    }
    const c = cell.c as Record<string, number>;
    const st = statusCode(r.LoanStatus), ga = num(r.GrossApproval), gu = num(r.SBAGuaranteedApproval);
    c.loans += 1;
    c.gross_approval += ga;
    c.sba_guaranteed += gu;
    if (STATUS_CODES.includes(st)) c[`loans_${st.toLowerCase()}`] += 1;
    else c.loans_other_status += 1;
    if (!NOT_DISBURSED.includes(st)) {
      c.loans_disbursed += 1;
      c.disbursed_gross_approval += ga;
      c.disbursed_sba_guaranteed += gu;
    }
    c.gross_chargeoff_amount += num(r.GrossChargeOffAmount);
  }

  /** One row per cohort and group, sorted; the 504 files have no guaranty column, so neither does their table. */
  table(): Row[] {
    const out: Row[] = [];
    const cells = [...this.cells.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, x]) => x);
    for (const { key, c } of cells) {
      const row: Row = { ApprovalFY: key[0] };
      this.groups.forEach((g, i) => (row[g] = key[i + 1]));
      for (const [k, v] of Object.entries(c)) {
        if (!this.guaranty && (k === "sba_guaranteed" || k === "disbursed_sba_guaranteed")) continue;
        row[k] = typeof v === "number" ? fmt(v) : v;
      }
      out.push(row);
    }
    return out;
  }
}

/** Parse a CSV stream, keeping the rows that pass `keep` (the header names the columns), or summing them into
 * `agg`. [rows, cut at max] */
export async function streamRows(src: Readable, keep: (r: Row) => boolean, max: number, agg?: Cohorts): Promise<[Row[], boolean]> {
  const out: Row[] = [];
  let cols: string[] = [];
  let cut = false;
  const parser = src.pipe(parse({ bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: true }));
  for await (const rec of parser as AsyncIterable<string[]>) {
    if (!cols.length) {
      cols = rec;
      continue;
    }
    const r: Row = {};
    cols.forEach((c, i) => (r[c] = i < rec.length ? rec[i] : ""));
    if (!keep(r)) continue;
    if (agg) {
      agg.add(r);
      continue;
    }
    if (out.length >= max) {
      cut = true;
      break;
    }
    out.push(r);
  }
  return [withColumns(out, cols), cut];
}

const groupsOf = (p: Record<string, unknown>) =>
  (Array.isArray(p.group_by) ? p.group_by : p.group_by === undefined || p.group_by === "" ? [] : [p.group_by]).map((x) => pyStr(x));

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    if (r.endpoint === "cohorts") {
      const badg = groupsOf(p).filter((x) => !GROUPS.includes(x));
      if (badg.length) bad.push(`request ${JSON.stringify(r.name)}: group_by ${JSON.stringify(badg)} not one of ${GROUPS.join(", ")}`);
    } else if (r.endpoint !== "foia") continue;
    if (r.endpoint === "foia" && !["state", "fiscal_year", "from", "naics"].some((k) => p[k] !== undefined && p[k] !== "")) {
      bad.push(`request ${JSON.stringify(r.name)}: give state, fiscal_year, from or naics (the files hold hundreds of thousands of loans), or use cohorts for totals`);
    }
    if (p.file !== undefined && (!/^[\w./-]+$/.test(pyStr(p.file)) || pyStr(p.file).includes(".."))) {
      bad.push(`request ${JSON.stringify(r.name)}: file is a path from list_files`);
    }
  }
  return bad;
}

/** One row per file in data.sba.gov's catalog (data.json); `file` is set for CSVs (the foia request's path). */
export function catalogRows(cat: any, search: string): Row[] {
  const out: Row[] = [];
  const want = search.trim().toLowerCase();
  for (const d of cat?.dataset || []) {
    for (const x of d.distribution || []) {
      const url = pyStr(x.downloadURL || x.accessURL || "");
      const m = /^https:\/\/data\.sba\.gov\/sites\/default\/files\/(.+?)(\.csv)?$/i.exec(url);
      const row = { dataset: pyStr(d.title ?? ""), title: pyStr(x.title ?? ""), format: pyStr(x.format || x.mediaType || ""),
        file: m && m[2] ? m[1] : "", url, modified: pyStr(d.modified ?? "").slice(0, 10) };
      if (want && !`${row.dataset} ${row.title}`.toLowerCase().includes(want)) continue;
      out.push(row);
    }
  }
  return out;
}

async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const c = gr.clientFor(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    if (r.endpoint === "list_files") {
      const resp = await c.request("GET", pack.endpoints.catalog_path, null);
      tables[r.name] = catalogRows(resp.json(), pyStr(params.search ?? ""));
      continue;
    }
    const [p] = gr.split(ep, params);
    const resp = await c.request("GET", p, null);
    const max = Number(r.max_rows || ep.max_rows || 1000000);
    const agg = r.endpoint === "cohorts" ? new Cohorts(groupsOf(params)) : undefined;
    let [rows, cut] = await streamRows(Readable.from([resp.body]), keeper(params), max, agg);
    if (agg) {
      rows = agg.table();
      const asOf = rows.length ? pyStr(rows[0].as_of) : "";
      notes.push(`${r.name}: ${rows.length.toLocaleString("en-US")} cohort rows; LoanStatus and charge-offs as of ${asOf || "the file's AsOfDate"}, so recent cohorts have had less time to default; dollars nominal`);
    }
    if (cut) notes.push(`${r.name}: stopped at ${rows.length.toLocaleString("en-US")} rows (max_rows); the source has more. Narrow the filter or raise max_rows.`);
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request '${r.name}' returned no rows: check the filters (ProjectState is two letters, ApprovalFY a year)`, "bad_request");
    }
    tables[r.name] = rows;
  }
  return [tables, notes];
}

async function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Promise<Row[]> {
  if (req.endpoint !== "foia" && req.endpoint !== "cohorts") return gr.parseUpload(pack, req, files);
  const [, params] = gr.resolve(pack, req);
  if (req.endpoint === "cohorts") {
    const agg = new Cohorts(groupsOf(params));
    for (const f of [...files].sort()) await streamRows(fs.createReadStream(f), keeper(params), 1000000, agg);
    return agg.table();
  }
  const rows: Row[] = [];
  let cols: string[] = [];
  for (const f of [...files].sort()) {
    const [got] = await streamRows(fs.createReadStream(f), keeper(params), 1000000);
    if (!cols.length) cols = columnsOf(got) || [];
    rows.push(...got);
  }
  return withColumns(rows, cols);
}

const adapter: Adapter = { fetch, checkSpec, parseUpload };
export default adapter;
