/**
 * irs-soi exempt organizations: the Exempt Organizations Business Master File extract (EO BMF, every organization
 * recognized as tax-exempt, one CSV per state, updated monthly) and the SOI annual extracts of Form 990, 990-EZ and
 * 990-PF financial data (one zip per form and filing year, 10-57 MB holding a CSV of up to 250 MB).
 *
 * Checked 2026-11-08:
 *   EO BMF   https://www.irs.gov/pub/irs-soi/eo_{st}.csv (50 states, DC, pr, xx = international), 28 columns;
 *            listed on /charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf
 *   extracts listed on /statistics/soi-tax-stats-annual-extract-of-tax-exempt-organization-financial-data:
 *            {yy}eoextract990.zip, {yy}eoextractez.zip (24eoextract990EZ.zip), {yy}eoextract990pf.zip (2018-2024);
 *            {yy}eofinextract990.zip ... (2012-2017; some years hold a fixed-width .dat file, not read here)
 * EINs are text with leading zeros (the 990-PF CSV drops them: they are restored to 9 digits). The extract CSV is
 * read as a stream from the zip, so only the asked rows are kept.
 */
import { Unzip, UnzipInflate } from "fflate";
import { DataError } from "../core/http.js";
import type { Row, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";
import { decodeText, readCsv } from "../core/tabular.js";
import { pageLinks } from "./_irs-soi_tables.js";
import { state, StateError } from "./_dol_states.js";

const BASE = "https://www.irs.gov/pub/irs-soi";
export const BMF_PAGE = "https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf";
export const EXTRACT_PAGE = "https://www.irs.gov/statistics/soi-tax-stats-annual-extract-of-tax-exempt-organization-financial-data";
const FORMS: Record<string, RegExp> = {
  "990": /^(\d\d)eo(fin)?extract990\.zip$/i, "990ez": /^(\d\d)eo(fin)?extract(990)?ez\.zip$/i, "990pf": /^(\d\d)eo(fin)?extract990pf\.zip$/i };

const blank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
const list = (v: unknown): string[] => (blank(v) ? [] : (Array.isArray(v) ? v : [v]).map((x) => pyStr(x).trim()).filter(Boolean));
const ein9 = (s: string) => s.replace(/\D/g, "").padStart(9, "0");

/** A GET of a URL (live: the pack client; manual route: the uploaded file of the same name). */
export type Get = (url: string) => Promise<Buffer>;

/** The Form 990 extract file names (an uploaded zip's name tells its form and year). */
export const EXTRACT_FILES = FORMS;

/** USPS codes of the `state` parameter (also PR and XX = international). */
function bmfStates(p: any): string[] {
  return list(p.state).map((s) => {
    const k = s.toUpperCase();
    return k === "PR" || k === "XX" ? k : state(s, "usps");
  });
}

export function checkEo(r: SpecRequest): string[] {
  const p: any = r.params || {};
  const name = JSON.stringify(r.name ?? null);
  const probs: string[] = [];
  let sts: string[] = [];
  try {
    sts = bmfStates(p);
  } catch (e) {
    if (!(e instanceof StateError)) throw e;
    probs.push(`request ${name}: ${e.message}`);
  }
  if (r.endpoint === "eo_bmf") {
    if (!sts.length) probs.push(`request ${name}: eo_bmf needs state (USPS code or name, PR, or XX for international): one file per state`);
    if (sts.length > 10) probs.push(`request ${name}: ${sts.length} states is one file each; ask for 10 or fewer per request`);
  } else {
    const form = pyStr(p.form ?? "990").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!(form in FORMS)) probs.push(`request ${name}: form is 990, 990ez or 990pf`);
    if (blank(p.year) && blank(p.filing_year)) probs.push(`request ${name}: eo_extract needs year (the filing year of the extract, 2012-2024)`);
    if (!list(p.ein).length && !sts.length) {
      probs.push(`request ${name}: eo_extract needs ein (one or more EINs) or state (organizations of that state, from the EO BMF): ` +
        "the national file has about 300,000 rows of up to 246 columns");
    }
  }
  return probs;
}

// ---------------------------------------------------------------------- EO BMF
async function bmf(get: Get, st: string): Promise<Row[]> {
  const body = await get(`${BASE}/eo_${st.toLowerCase()}.csv`);
  const text = decodeText(new Uint8Array(body));
  if (/^\s*</.test(text)) throw new DataError(`eo_${st.toLowerCase()}.csv: got an HTML page instead of the CSV`, "api");
  return readCsv(text);
}

export async function fetchBmf(r: SpecRequest, get: Get, limit: number, notes: string[]): Promise<Row[]> {
  const p: any = r.params || {};
  const eins = new Set(list(p.ein).map(ein9));
  const ntee = list(p.ntee).map((s) => s.toUpperCase());
  const sub = new Set(list(p.subsection).map((s) => s.padStart(2, "0")));
  const nameq = list(p.name).map((s) => s.toLowerCase());
  const cols = list(p.columns).map((s) => s.toUpperCase());
  const out: Row[] = [];
  for (const st of bmfStates(p)) {
    const rows = await bmf(get, st);
    if (rows.length && !("EIN" in rows[0])) throw new DataError(`eo_${st.toLowerCase()}.csv has no EIN column: the layout changed`, "api");
    let kept = 0;
    for (const row of rows) {
      if (eins.size && !eins.has(ein9(String(row.EIN)))) continue;
      if (ntee.length && !ntee.some((n) => String(row.NTEE_CD || "").toUpperCase().startsWith(n))) continue;
      if (sub.size && !sub.has(String(row.SUBSECTION || "").padStart(2, "0"))) continue;
      if (nameq.length && !nameq.some((n) => `${row.NAME} ${row.SORT_NAME}`.toLowerCase().includes(n))) continue;
      if (out.length >= limit) {
        notes.push(`${r.name}: stopped at ${limit} rows (max_rows); filter with ntee, subsection, ein or name`);
        return out;
      }
      out.push(cols.length ? Object.fromEntries(Object.entries(row).filter(([k]) => k === "EIN" || k === "NAME" || k === "STATE" || cols.includes(k))) : row);
      kept++;
    }
    notes.push(`${r.name}: eo_${st.toLowerCase()}.csv (${BASE}/eo_${st.toLowerCase()}.csv): ${rows.length} organizations, ${kept} kept`);
  }
  notes.push(`${r.name}: EO BMF codes (SUBSECTION, FOUNDATION, ASSET_CD, INCOME_CD, NTEE_CD ...) are explained in ` +
    "https://www.irs.gov/pub/foia/ig/tege/eo-info.pdf; ASSET_AMT, INCOME_AMT, REVENUE_AMT are " +
    "whole dollars from the latest return on file (TAX_PERIOD), not one common year");
  return out;
}

// ---------------------------------------------------------------------- Form 990 extracts
/** CSV records from text chunks (quoted fields, any line end): a small streaming reader. */
class CsvStream {
  private field = "";
  private rec: string[] = [];
  private quoted = false;
  private afterQuote = false;
  constructor(private onRecord: (r: string[]) => void) {}
  push(s: string): void {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (this.quoted) {
        if (ch === '"') {
          if (s[i + 1] === '"') (this.field += '"', i++);
          else (this.quoted = false, this.afterQuote = true);
        } else this.field += ch;
        continue;
      }
      if (ch === '"' && !this.field) this.quoted = true;
      else if (ch === ",") (this.rec.push(this.field), this.field = "", this.afterQuote = false);
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        this.end();
      } else this.field += ch;
    }
  }
  end(): void {
    if (this.rec.length || this.field) {
      this.rec.push(this.field);
      this.onRecord(this.rec);
    }
    this.rec = [];
    this.field = "";
    this.afterQuote = false;
  }
}

export async function fetchExtract(r: SpecRequest, get: Get, limit: number, notes: string[]): Promise<Row[]> {
  const p: any = r.params || {};
  const form = pyStr(p.form ?? "990").toLowerCase().replace(/[^a-z0-9]/g, "");
  const year = Number(pyStr(p.year ?? p.filing_year));
  const links = pageLinks((await get(EXTRACT_PAGE)).toString("utf8"), EXTRACT_PAGE).filter((l) => FORMS[form].test(l.file));
  const link = links.find((l) => l.year === year);
  if (!link) {
    throw new DataError(`request ${JSON.stringify(r.name)}: no Form ${form} extract for ${year} on ${EXTRACT_PAGE} (posted: ` +
      `${[...new Set(links.map((l) => l.year))].sort().join(", ")})`, "not_found");
  }
  // the EINs to keep: asked, or every organization of the asked states (EO BMF)
  const eins = new Set(list(p.ein).map(ein9));
  for (const st of bmfStates(p)) for (const row of await bmf(get, st)) eins.add(ein9(String(row.EIN)));
  if (bmfStates(p).length) notes.push(`${r.name}: state filter = the EINs in the current EO BMF of ${bmfStates(p).join(", ")} (` +
    "organizations that moved or lost exemption since filing are missed)");
  const cols = list(p.columns).map((c) => c.toLowerCase());
  const zip = await get(link.url);
  const out: Row[] = [];
  let head: string[] | null = null, einAt = -1, keep: number[] = [], seen = 0, member = "", truncated = false;
  const csv = new CsvStream((rec) => {
    if (!head) {
      head = rec.map((h) => h.trim());
      einAt = head.findIndex((h) => h.toLowerCase() === "ein");
      if (einAt < 0) throw new DataError(`${link.file}: no EIN column (columns: ${head.slice(0, 8).join(", ")})`, "api");
      keep = head.map((h, i) => [h, i] as [string, number]).filter(([h, i]) => !cols.length || i === einAt || cols.includes(h.toLowerCase())).map(([, i]) => i);
      const missing = cols.filter((c) => !head!.some((h) => h.toLowerCase() === c));
      if (missing.length) notes.push(`${r.name}: ${link.file} has no column ${missing.join(", ")} (see ${year % 100}eofinextractdoc.xlsx)`);
      return;
    }
    seen++;
    if (truncated || !eins.has(ein9(rec[einAt] || ""))) return;
    if (out.length >= limit) {
      truncated = true;
      return;
    }
    const o: Row = {};
    for (const i of keep) o[head[i]] = i === einAt ? ein9(rec[i] || "") : (rec[i] ?? "").trim();
    out.push(o);
  });
  const dec = new TextDecoder("windows-1252");
  const uz = new Unzip();
  uz.register(UnzipInflate);
  let failed: Error | null = null;
  uz.onfile = (f) => {
    if (member || !/\.(csv|txt)$/i.test(f.name)) {
      if (!member && /\.dat$/i.test(f.name)) failed = new DataError(`${link.file} holds a fixed-width file (${f.name}), not a CSV; ` +
        "this filing year is not read here (use 2018 or later, or the manual route with the year's layout file)", "bad_request");
      return;
    }
    member = f.name;
    f.ondata = (err, chunk, final) => {
      if (err || failed) {
        failed ??= err;
        return;
      }
      try {
        csv.push(dec.decode(chunk, { stream: !final }));
        if (final) csv.end();
      } catch (e) {
        failed = e as Error;
      }
    };
    f.start();
  };
  uz.push(new Uint8Array(zip), true);
  if (failed) throw failed;
  if (!member) throw new DataError(`${link.file}: no CSV member in the zip`, "api");
  notes.push(`${r.name}: ${link.file} (${link.url}), ${member}: ${seen} returns, ${out.length} kept; amounts in whole dollars; ` +
    `field definitions in ${BASE}/${String(year % 100).padStart(2, "0")}eofinextractdoc.xlsx; the extract year is the year the ` +
    "returns were filed/processed (tax periods vary: see the tax period column)");
  if (truncated) notes.push(`${r.name}: stopped at ${limit} rows (max_rows)`);
  return out;
}
