/**
 * usda-fna adapter: SNAP State Options Report (dashboard CSV exports and PDFs), SNAP State Activity Reports (PDF), and
 * FNA's Program Data tables (XLSX: SNAP, WIC, child nutrition; _usda-fna_book.ts).
 *
 * Neither report has an API (verified 2026-10-30). What this adapter reads:
 *   - The State Options Report dashboard is a Tableau view on publicdashboards.dl.usda.gov. Appending ".csv" to a
 *     view URL exports the view's first sheet, and URL parameters drive the export:
 *       StateAgencyComparison.csv?State 1 Param=<agency>&State 2 Param =<agency>&Edition=<label>
 *           every policy option of two agencies (column State names the agency; the second parameter's name ends in
 *           a space); waivers and demonstration projects are not in this view;
 *       OptionsProjectsWaivers.csv?Policy Option Param 1=<policy>&Option Selection Parameter 1=<selection>&Edition=<label>
 *           every agency that made that selection, waivers and projects included.
 *     An unknown parameter value is ignored silently (the view falls back to its default selection), so every
 *     exported row is checked against what was asked for.
 *   - The report PDFs (www.fna.usda.gov): see _usda-fna_pdf.ts (this server has no PDF text reader yet).
 *   - The Program Data workbooks are linked from three listing pages; their file names carry a release number that
 *     changes (snap-persons-10.xlsx), so each fetch reads the current name from the listing page (endpoints.json
 *     program_pages) and never builds it.
 * State agencies are the reports' 53 (50 states, DC, Guam, Virgin Islands) under the reports' own names.
 */
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import { clientFor, INCOMPLETE, resolve } from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Spec, SpecRequest, Tables } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyQuote } from "../core/py.js";
import { readCsv } from "../core/tabular.js";
import {
  Areas, comma, findSheet, LayoutError, norm, pad2, parseSnapYear, parseTable, parseWicSheet, pyRepr, pyStrip, readBook,
  snapZipMember, SpecError, wicSheetKey, zipMembers, zipXlsxYears, type Row,
} from "./_usda-fna_book.js";
import {
  activityPageRows, activityTableRows, AGENCIES, agenciesOf, agency, NAME, pagesOf, pdfPages, reportRows, reportYear,
} from "./_usda-fna_pdf.js";

const EPS: any = readJson(path.join(PACKS_DIR, "usda-fna"), "endpoints.json") || {};
const AREAS = new Areas(AGENCIES); // + AS, PR, MP: the Program Data tables have them

const blank = (v: unknown) => v === null || v === undefined || v === "";
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const lastPart = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");

// ---------------------------------------------------------------------- spec helpers
function ints(v: unknown, lo: number, hi: number, what: string): number[] {
  const vals = Array.isArray(v) ? v : [v];
  const out: number[] = [];
  for (const x of vals) {
    const s = pyStrip(x === null || x === undefined ? "None" : x === true ? "True" : x === false ? "False" : String(x));
    if (!/^[+-]?\d+(?:_\d+)*$/.test(s)) throw new SpecError(`${what} ${pyRepr(x)} is not a number`);
    const n = parseInt(s.replace(/_/g, ""), 10);
    if (!(lo <= n && n <= hi)) throw new SpecError(`${what} ${n} is outside ${lo}-${hi}`);
    out.push(n);
  }
  return out;
}

function edition(v: unknown, allowed: string[] = ["16", "17"]): string {
  const falsy = v === null || v === undefined || v === "" || v === 0 || v === false;
  const e = pyStrip(String(falsy ? "17" : v)).toLowerCase().replace(/th/g, "");
  if (!allowed.includes(e)) throw new SpecError(`edition ${pyRepr(v)}: this endpoint has editions ${allowed.join(", ")}`);
  return e;
}

const reportEditions = () => Object.keys(EPS.options_reports || {});

/** The catalog entry of the requested policy (alias, or its exact name). */
function policyOf(params: Record<string, any>): any {
  const p = pyStrip(String(params.policy || ""));
  for (const [alias, c] of Object.entries<any>(EPS.catalog || {})) {
    if (c.endpoint === "option_states" && (p === alias || p === c.id || p.toLowerCase() === c.id.toLowerCase())) return c;
  }
  throw new SpecError(`policy ${pyRepr(p)} is not in the catalog: use an alias or name from source_brief / a request_schema search ` +
    "(e.g. bbce, abawd_waiver, telephonic_signature_waiver)");
}

/** [key, definition] of a Program Data table (catalog entries with endpoint program_table). */
function tableOf(params: Record<string, any>): [string, any] {
  const k = pyStrip(String(params.table || ""));
  const cat = EPS.catalog || {};
  const c = Object.prototype.hasOwnProperty.call(cat, k) ? cat[k] : null;
  if (!c || c.endpoint !== "program_table") {
    const keys = Object.entries<any>(cat).filter(([, d]) => d.endpoint === "program_table").map(([a]) => a);
    throw new SpecError(`table ${pyRepr(k)} is not a Program Data table; known: ${keys.join(", ")}`);
  }
  return [k, c];
}

function wicMeasures(v: unknown): string[] {
  const sheets = EPS.wic_agency_sheets;
  if (blank(v)) return ["participants_total"];
  if (v === "all" || (Array.isArray(v) && v.length === 1 && v[0] === "all")) return Object.keys(sheets);
  const vals: string[] = Array.isArray(v) ? v : String(v).split(",").map(pyStrip).filter(Boolean);
  const bad = vals.filter((x) => !Object.prototype.hasOwnProperty.call(sheets, x));
  if (bad.length) throw new SpecError(`unknown WIC measure(s) ${pyRepr(bad)}; known: ${Object.keys(sheets).join(", ")}`);
  return vals;
}

function endpointOf(req: SpecRequest): string {
  let e = req.endpoint;
  const cat = EPS.catalog || {};
  if (!e && req.dataset && Object.prototype.hasOwnProperty.call(cat, req.dataset)) e = cat[req.dataset].endpoint;
  return e || "";
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {}, e = endpointOf(r), n = r.name;
    try {
      if (e === "options_by_state") {
        agenciesOf(p.state);
        edition(p.edition);
      } else if (e === "option_states") {
        const c = policyOf({ policy: p.policy || r.dataset });
        edition(p.edition);
        if (!blank(p.selection) && !c.selections.includes(p.selection)) {
          probs.push(`request ${pyRepr(n)}: selection ${pyRepr(p.selection)} is not one of ${pyRepr(c.id)}'s: ` + c.selections.join("; "));
        }
      } else if (e === "options_report") {
        edition(p.edition, reportEditions());
        if (!blank(p.state)) agency(p.state);
        pagesOf(p.pages);
      } else if (e === "activity_tables") {
        const yrs: number[] = EPS.activity_parsed_years || [];
        ints(p.fiscal_year, Math.min(...yrs), Math.max(...yrs), "fiscal_year (parsed tables: FY 2019-2023; " +
          "other years: activity_report)");
        const t = p.tables;
        if (!blank(t) && t !== "all") {
          const bad = (Array.isArray(t) ? t : [t]).filter((x: any) => !Object.prototype.hasOwnProperty.call(EPS.activity_tables, x));
          if (bad.length) probs.push(`request ${pyRepr(n)}: unknown table(s) ${pyRepr(bad)}; known: ${Object.keys(EPS.activity_tables).join(", ")}`);
        }
        if (!blank(p.state)) agenciesOf(p.state);
      } else if (e === "program_table") {
        const [k, c] = tableOf({ table: p.table || r.dataset });
        if (!blank(p.state)) {
          if (c.layout === "annual" || c.layout === "monthly") {
            probs.push(`request ${pyRepr(n)}: ${k} is a national table; drop state (state tables: the ` +
              "catalog entries ending in _state or _latest)");
          }
          AREAS.codes(p.state);
        }
        if (!blank(p.fiscal_year)) ints(p.fiscal_year, 1969, 2100, "fiscal_year");
      } else if (e === "snap_state_monthly") {
        const lo = EPS.snap_zip.first_xlsx_year;
        ints(p.fiscal_year, lo, 2100, `fiscal_year (FY ${lo} onward; earlier years are .xls files ` +
          "this pack does not read: snap_annual has national totals)");
        if (!blank(p.state)) AREAS.codes(p.state);
      } else if (e === "wic_agency_monthly") {
        const yrs: number[] = EPS.wic_agency_files.years;
        const fys = ints(p.fiscal_year, Math.min(...yrs), 2100, `fiscal_year (FY ${Math.min(...yrs)} onward)`);
        if (fys.length > 1) probs.push(`request ${pyRepr(n)}: wic_agency_monthly takes one fiscal_year a request`);
        wicMeasures(p.measures);
        if (!blank(p.state)) AREAS.codes(p.state);
      } else if (e === "activity_report") {
        ints(p.fiscal_year, 2004, 2023, "fiscal_year");
        if ((Array.isArray(p.fiscal_year) ? p.fiscal_year : [1]).length > 1) {
          probs.push(`request ${pyRepr(n)}: activity_report takes one fiscal_year a request`);
        }
        pagesOf(p.pages);
      }
    } catch (ex) {
      if (!(ex instanceof SpecError)) throw ex;
      probs.push(`request ${pyRepr(n)}: ${ex.message}`);
    }
  }
  return probs;
}

// ---------------------------------------------------------------------- network
/** One fetch's clients and listing pages (the Python module kept them for its one-shot process). */
class Net {
  tab: Client | null = null;
  listings = new Map<string, string>();
  constructor(public pack: Pack) {}

  tableau(): Client {
    this.tab ??= new Client(EPS.tableau.base_url, { name: "usda-fna (publicdashboards.dl.usda.gov)", rps: 1, burst: 2, timeout: 60 });
    return this.tab;
  }

  async getView(p: string): Promise<Buffer> {
    try {
      return (await this.tableau().get(p)).body;
    } catch (e) {
      if (e instanceof DataError && e.kind === "not_found") {
        throw new DataError(`usda-fna: the State Options dashboard view is gone (HTTP 404): FNA has republished the ` +
          `dashboard (${EPS.tableau.page}), so endpoints.json tableau needs the new view ` +
          "path. Until then use options_report (the PDF).", "not_found", 404);
      }
      throw e;
    }
  }

  async getPdf(p: string): Promise<Buffer> {
    const body = (await clientFor(this.pack).get(p)).body;
    if (!body.subarray(0, 4).equals(Buffer.from("%PDF"))) {
      throw new DataError(`usda-fna: ${p} did not return a PDF (the site may have moved the file; see the listing ` +
        "pages in source.md Access)", "api");
    }
    return body;
  }

  async listing(program: string): Promise<string> {
    if (!this.listings.has(program)) {
      this.listings.set(program, (await clientFor(this.pack).get(EPS.program_pages[program])).body.toString("utf8"));
    }
    return this.listings.get(program)!;
  }

  /** The resource-file paths on a listing page whose file name matches rx (whole name). */
  async listed(program: string, rx: string, what: string): Promise<string[]> {
    const html = await this.listing(program);
    const re = new RegExp(`^(?:${rx})$`, "i");
    const hits: string[] = [];
    for (const m of html.matchAll(/href="(\/sites\/default\/files\/resource-files\/([^"/]+))"/g)) {
      if (re.test(m[2]) && !hits.includes(m[1])) hits.push(m[1]);
    }
    if (!hits.length) {
      throw new DataError(`usda-fna: no ${what} link on ${EPS.base_url}${EPS.program_pages[program]} (FNA may have ` +
        "renamed or moved the file; endpoints.json program_pages / catalog stem need updating)", "api");
    }
    return hits;
  }

  async getFile(p: string, kind: string): Promise<Buffer> {
    const body = (await clientFor(this.pack).get(p)).body;
    if (body.subarray(0, 2).toString("latin1") !== "PK") {
      throw new DataError(`usda-fna: ${p} did not return an ${kind} file (the site may have moved it; see the listing ` +
        "pages in source.md Access)", "api");
    }
    return body;
  }
}

function one(hits: string[], what: string): string {
  if (hits.length > 1) {
    throw new DataError(`usda-fna: the listing page links several ${what} files (${hits.join(", ")}); not guessing ` +
      "which is current", "api");
  }
  return hits[0];
}

function view(v: string, query: Record<string, string>): string {
  return `${EPS.tableau.workbook}/${v}.csv?` + Object.entries(query).map(([k, x]) => `${pyQuote(k, "")}=${pyQuote(x, "")}`).join("&");
}

// ---------------------------------------------------------------------- State Options Report: dashboard CSVs
function csvRows(body: Buffer, need: string[], what: string): Record<string, string>[] {
  const text = body.toString("utf8").replace(/^\ufeff/, "");
  const rows = readCsv(text).map((r) => {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) o[pyStrip(k ?? "")] = pyStrip(v === null || v === undefined ? "" : String(v));
    return o;
  });
  const head = new Set(rows.length ? Object.keys(rows[0]) : (text.split(/\r\n|[\n\r]/)[0] ?? "").split(",").map(pyStrip));
  if (!pyStrip(text)) return [];
  const miss = need.filter((x) => !head.has(x)).sort(cmp);
  if (miss.length) {
    throw new DataError(`usda-fna: the dashboard's ${what} export no longer has the columns ${pyRepr(miss)} ` +
      `(it has ${pyRepr([...head].sort(cmp).slice(0, 8))}): the dashboard was changed; use options_report (the PDF)`, "api");
  }
  return rows;
}

function pairs(abbrs: string[]): [string, string][] {
  const names = abbrs.map((a) => NAME.get(a)!);
  const out: [string, string][] = [];
  for (let i = 0; i < names.length; i += 2) out.push([names[i], i + 1 < names.length ? names[i + 1] : names[i]]);
  return out;
}

const byStateQuery = (pr: [string, string], label: string) => ({ "State 1 Param": pr[0], "State 2 Param ": pr[1], Edition: label });

function byStateRows(bodies: Buffer[], abbrs: string[], label: string): [Row[], string[]] {
  const want = new Set(abbrs.map((a) => NAME.get(a)!));
  const out: Row[] = [], seen = new Set<string>();
  for (const b of bodies) {
    for (const r of csvRows(b, ["State", "Option Selection", "Policy Option Field", "Counting Option Selection"], "StateAgencyComparison")) {
      const st = r.State;
      if (!want.has(st)) continue;
      const row = { edition: label, state: st, state_abbr: agency(st), policy_option: r["Policy Option Field"],
        option_selection: r["Option Selection"], agencies_with_selection: r["Counting Option Selection"],
        share_of_agencies: r["% Counting Option Selection"] ?? "" };
      const key = JSON.stringify(Object.values(row));
      if (!seen.has(key)) {
        seen.add(key);
        out.push(row);
      }
    }
  }
  const got = new Set(out.map((r) => r.state));
  const notes: string[] = [];
  const lack = [...want].filter((x) => !got.has(x)).sort(cmp);
  if (lack.length) notes.push(`${INCOMPLETE} no rows for ${lack.join(", ")} (${label})`);
  return [out, notes];
}

function selections(params: Record<string, any>): [any, string[]] {
  const c = policyOf(params);
  const sel = params.selection;
  return [c, !blank(sel) ? [sel] : [...c.selections]];
}

const optionQuery = (policy: string, sel: string, label: string) =>
  ({ "Policy Option Param 1": policy, "Option Selection Parameter 1": sel, Edition: label });

function optionRows(bodies: Buffer[], c: any, sels: string[], label: string): Row[] {
  const out: Row[] = [];
  for (const b of bodies) {
    for (const r of csvRows(b, ["Edition", "Option Selection", "Policy Option", "State Agency"], "OptionsProjectsWaivers")) {
      if (r["Policy Option"] !== c.id || !sels.includes(r["Option Selection"]) || r.Edition !== label) {
        // the view ignored a parameter (an unknown value falls back to the default selection)
        throw new DataError(`usda-fna: asked for ${pyRepr(c.id)} / ${pyRepr(sels)} (${label}) but the dashboard returned ` +
          `${pyRepr(r["Policy Option"])} / ${pyRepr(r["Option Selection"])} (${r.Edition}): the policy or ` +
          "selection name no longer matches the dashboard; check it in the dashboard and endpoints.json catalog", "api");
      }
      out.push({ edition: label, policy_option: r["Policy Option"], option_selection: r["Option Selection"],
        state: r["State Agency"], state_abbr: agency(r["State Agency"]) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------- Program Data tables (XLSX)
function keepRows(rows: Row[], p: Record<string, any>): Row[] {
  if (!blank(p.state)) {
    const codes = new Set(AREAS.codes(p.state));
    rows = rows.filter((x) => codes.has(x.state_abbr));
  }
  if (!blank(p.fiscal_year)) {
    const fys = new Set(ints(p.fiscal_year, 1969, 2100, "fiscal_year"));
    rows = rows.filter((x) => fys.has(x.fiscal_year));
  }
  return rows;
}

function layout<T>(f: () => T): T {
  try {
    return f();
  } catch (ex) {
    if (!(ex instanceof LayoutError)) throw ex;
    throw new DataError(`usda-fna: the workbook does not have the expected layout (${ex.message}); its rows were not read. ` +
      "FNA changed the table: check it and update endpoints.json (catalog columns / title)", "api");
  }
}

/** Rows and notes of Program Data table k from its workbook (exported for the tests, as Python's program_rows). */
export function programRows(k: string, c: any, body: Uint8Array, p: Record<string, any>): [Row[], string[]] {
  const [rows, notes] = layout(() => parseTable(k, c, body, AREAS));
  return [keepRows(rows, p), notes];
}

export const table = (k: string) => tableOf({ table: k });

function snapZipYears(body: Uint8Array, fys: number[], what: string): Map<number, Uint8Array> {
  let names: string[];
  try {
    names = zipMembers(body);
  } catch {
    throw new DataError(`usda-fna: ${what} is not a zip file`, "api");
  }
  const out = new Map<number, Uint8Array | null>(fys.map((fy) => [fy, snapZipMember(body, names, fy)]));
  const missing = [...out].filter(([, b]) => b === null).map(([fy]) => fy);
  if (missing.length) {
    const have = zipXlsxYears(names).filter((y) => y >= EPS.snap_zip.first_xlsx_year);
    throw new DataError(`usda-fna: the SNAP data zip has no FY${pad2(missing[0] % 100)}.xlsx (its .xlsx years: ` +
      `${pyRepr(have)})`, "bad_request");
  }
  return out as Map<number, Uint8Array>;
}

function snapMonthlyRows(bodies: Map<number, Uint8Array>, p: Record<string, any>): [Row[], string[]] {
  let rows: Row[] = [];
  const notes: string[] = [];
  for (const fy of [...bodies.keys()].sort((a, b) => a - b)) {
    const [rs, ns] = layout(() => parseSnapYear(bodies.get(fy)!, fy, AREAS));
    rows = rows.concat(rs);
    notes.push(...ns);
  }
  return [keepRows(rows, { state: p.state }), notes];
}

function wicAgencyRows(body: Uint8Array, fy: number, p: Record<string, any>): [Row[], string[]] {
  const want = wicMeasures(p.measures);
  const book = layout(() => readBook(body));
  let rows: Row[] = [];
  const notes: string[] = [], seen = new Set<string>();
  for (const [name, rs, hidden] of book) {
    const k = wicSheetKey(name, EPS.wic_agency_sheets);
    if (k === null || !want.includes(k)) continue;
    let r2: Row[], n2: string[];
    try {
      [r2, n2] = parseWicSheet(k, EPS.wic_agency_sheets[k], rs, hidden, fy, AREAS);
    } catch (ex) {
      if (!(ex instanceof LayoutError)) throw ex;
      notes.push(`${INCOMPLETE} sheet ${pyRepr(name)} dropped: ${ex.message}`);
      continue;
    }
    seen.add(k);
    rows = rows.concat(r2);
    notes.push(...n2);
  }
  for (const k of want) {
    if (!seen.has(k) && !notes.some((n) => n.includes(k))) notes.push(`${INCOMPLETE} no sheet for ${k} in the FY ${fy} WIC agency workbook`);
  }
  return [keepRows(rows, { state: p.state }), notes];
}

/** Request-named notes: an incomplete one keeps the INCOMPLETE marker right after the name; the rest are checks. */
function named(name: string, notes: string[]): string[] {
  return notes.map((n) => (n.includes(INCOMPLETE) ? `${name}${n.slice(n.indexOf(INCOMPLETE))}` : `${name}: check: ${n}`));
}

// ---------------------------------------------------------------------- the fetch
async function fetchOne(net: Net, r: SpecRequest, params: Record<string, any>): Promise<[Row[], string[]]> {
  const e = endpointOf(r), p = params;
  if (e === "options_by_state") {
    const ed = edition(p.edition);
    const label = EPS.tableau.editions[ed], abbrs = agenciesOf(p.state);
    const bodies: Buffer[] = [];
    for (const pr of pairs(abbrs)) bodies.push(await net.getView(view("StateAgencyComparison", byStateQuery(pr, label))));
    const [rows, notes] = byStateRows(bodies, abbrs, label);
    return [rows, [...notes.map((n) => (n.startsWith(INCOMPLETE) ? `${r.name}${n}` : n)),
      `${r.name}: ${comma(rows.length)} rows for ${new Set(rows.map((x) => x.state)).size} agencies (${label}); policy options ` +
      "only (waivers and demonstration projects: option_states or options_report)"]];
  }
  if (e === "option_states") {
    const ed = edition(p.edition);
    const label = EPS.tableau.editions[ed];
    const [c, sels] = selections({ ...p, policy: p.policy || r.dataset });
    const bodies: Buffer[] = [];
    for (const s of sels) bodies.push(await net.getView(view("OptionsProjectsWaivers", optionQuery(c.id, s, label))));
    const rows = optionRows(bodies, c, sels, label);
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${pyRepr(r.name)}: no agency has ${pyRepr(c.id)} = ${pyRepr(sels)} in the ${label}: the option may ` +
        "not be in that edition (the catalog description says which)", "bad_request");
    }
    const n = new Set(rows.map((x) => x.state)).size;
    return [rows, [`${r.name}: ${c.id} (${label}): ${rows.length} rows, ${n} of 53 agencies` +
      (p.selection ? "" : "; an agency missing here has no published selection")]];
  }
  if (e === "options_report") {
    const ed = edition(p.edition, reportEditions());
    const rows = reportRows(pdfPages(await net.getPdf(EPS.options_reports[ed].url)), ed, p, EPS);
    return [rows, [`${r.name}: ${EPS.options_reports[ed].label}, ${rows.length} page(s) of text`]];
  }
  if (e === "activity_report") {
    const fy = ints(p.fiscal_year, 2004, 2023, "fiscal_year")[0];
    const rows = activityPageRows(pdfPages(await net.getPdf(EPS.activity_reports[String(fy)])), fy, p);
    return [rows, [`${r.name}: SNAP State Activity Report FY ${fy}, ${rows.length} page(s) of text`]];
  }
  if (e === "program_table") {
    const [k, c] = tableOf({ table: p.table || r.dataset });
    const fp = one(await net.listed(c.program, reEscape(c.stem) + "-\\d+\\.xlsx", `${k} (${c.stem}-NN.xlsx)`), k);
    const [rows, notes] = programRows(k, c, await net.getFile(fp, "XLSX"), p);
    const asof = rows.length ? rows[0].data_as_of : "";
    return [rows, [...named(r.name, notes), `${r.name}: ${k} from ${lastPart(fp)} (data as of ` +
      `${asof || "not stated"}): ${comma(rows.length)} values`]];
  }
  if (e === "snap_state_monthly") {
    const z = EPS.snap_zip;
    const fp = one(await net.listed("snap", reEscape(z.stem) + "-\\d+\\.zip", "SNAP data zip"), "SNAP data zip");
    const fys = ints(p.fiscal_year, z.first_xlsx_year, 2100, "fiscal_year");
    const [rows, notes] = snapMonthlyRows(snapZipYears(await net.getFile(fp, "zip"), fys, fp), p);
    return [rows, [...named(r.name, notes), `${r.name}: SNAP by state and month, FY ` +
      `${fys.join(", ")}, from ${lastPart(fp)}: ${comma(rows.length)} values`]];
  }
  if (e === "wic_agency_monthly") {
    const fy = ints(p.fiscal_year, 2022, 2100, "fiscal_year")[0];
    const hits = await net.listed("wic", "wicagencies\\d{4}ytd\\.xlsx", "WIC agency monthly");
    const mine = hits.filter((h) => h.toLowerCase().endsWith(`wicagencies${fy}ytd.xlsx`));
    if (!mine.length) {
      const have = hits.map((h) => parseInt(/(\d{4})ytd/.exec(h)![1], 10)).sort((a, b) => a - b);
      throw new DataError(`request ${pyRepr(r.name)}: the WIC page lists agency files for FY ${pyRepr(have)}, not FY ${fy}`, "bad_request");
    }
    const [rows, notes] = wicAgencyRows(await net.getFile(mine[0], "XLSX"), fy, p);
    return [rows, [...named(r.name, notes), `${r.name}: WIC by agency and month, FY ${fy}, from ` +
      `${lastPart(mine[0])}: ${comma(rows.length)} values`]];
  }
  if (e === "activity_tables") {
    let rows: Row[] = [];
    const notes: string[] = [];
    for (const fy of ints(p.fiscal_year, 2019, 2023, "fiscal_year")) {
      const [rs, ns] = activityTableRows(pdfPages(await net.getPdf(EPS.activity_reports[String(fy)])), fy, p, EPS);
      rows = rows.concat(rs);
      notes.push(...ns);
    }
    const tabs = new Set(rows.map((x) => x.table));
    return [rows, [...notes.map((n) => (!n.includes(INCOMPLETE) ? `${r.name}: ${n}` : `${r.name}${n.slice(n.indexOf(INCOMPLETE))}`)),
      `${r.name}: ${comma(rows.length)} values from ${tabs.size} table(s)`]];
  }
  throw new DataError(`request ${pyRepr(r.name)}: unknown endpoint ${pyRepr(e)}`, "bad_request");
}

async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const tables: Tables = {}, notes: string[] = [];
  const net = new Net(pack);
  for (const r of spec.requests) {
    const [, params, probs] = resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const [rows, ns] = await fetchOne(net, r, params);
    tables[r.name] = rows;
    notes.push(...ns);
  }
  return [tables, notes];
}

// ---------------------------------------------------------------------- manual route
function manualItems(spec: Spec, pack: Pack): any[] {
  const fna = String(EPS.base_url).replace(/\/+$/, "");
  const tab = String(EPS.tableau.base_url).replace(/\/+$/, "");
  const items: any[] = [];
  for (const r of spec.requests || []) {
    const [, p, probs] = resolve(pack, r);
    if (probs.length || checkSpec({ requests: [r] }).length) continue;
    const e = endpointOf(r), name = r.name;
    const base = { request: name, needs_key: false, method: "GET", body: null };
    if (e === "options_by_state") {
      const label = EPS.tableau.editions[edition(p.edition)];
      pairs(agenciesOf(p.state)).forEach((pr, i) => {
        items.push({ ...base, name: `${name}#${i + 1}`, url: tab + view("StateAgencyComparison", byStateQuery(pr, label)),
          filename: `${name}_${pad2(i + 1)}.csv`, note: `${pr[0]} and ${pr[1]} (${label})` });
      });
    } else if (e === "option_states") {
      const label = EPS.tableau.editions[edition(p.edition)];
      const [c, sels] = selections({ ...p, policy: p.policy || r.dataset });
      sels.forEach((s, i) => {
        items.push({ ...base, name: `${name}#${i + 1}`, url: tab + view("OptionsProjectsWaivers", optionQuery(c.id, s, label)),
          filename: `${name}_${pad2(i + 1)}.csv`, note: `${c.id}: ${s} (${label})` });
      });
    } else if (e === "program_table") {
      const [k, c] = tableOf({ table: p.table || r.dataset });
      const page = fna + EPS.program_pages[c.program];
      items.push({ ...base, name: `${name}#1`, url: `${fna}/sites/default/files/resource-files/${c.stem}-${EPS.program_release}.xlsx`,
        filename: `${name}_${c.stem}.xlsx`, note: `${k}: ${c.description} (Excel). If the link is gone, the release number changed: ` +
          `open ${page} and download the Excel file of this table` });
    } else if (e === "snap_state_monthly") {
      items.push({ ...base, name: `${name}#1`, url: fna + EPS.snap_zip.file, filename: `${name}_${EPS.snap_zip.stem}.zip`,
        note: "SNAP data zip (persons, households, benefits by state and month, FY 1969 on). If " +
          `the link is gone, open ${fna}${EPS.program_pages.snap} and download the 'FY 69 through FY ..' zip` });
    } else if (e === "wic_agency_monthly") {
      const fy = ints(p.fiscal_year, 2022, 2100, "fiscal_year")[0];
      items.push({ ...base, name: `${name}#1`, url: fna + String(EPS.wic_agency_files.file).replaceAll("{fy}", String(fy)),
        filename: `${name}_wicagencies${fy}ytd.xlsx`, note: `WIC monthly data by state agency, FY ${fy} (Excel), from ` +
          `${fna}${EPS.program_pages.wic}` });
    } else if (e === "options_report" || e === "activity_report" || e === "activity_tables") {
      let files: [string, string][];
      if (e === "options_report") {
        const ed = edition(p.edition, reportEditions());
        files = [[EPS.options_reports[ed].url, EPS.options_reports[ed].label]];
      } else {
        files = ints(p.fiscal_year, 2004, 2023, "fiscal_year").map((fy) => [EPS.activity_reports[String(fy)], `SNAP State Activity Report FY ${fy}`]);
      }
      files.forEach(([fp, label], i) => {
        let leaf = lastPart(fp);
        try {
          leaf = decodeURIComponent(leaf);
        } catch {
          /* keep it encoded */
        }
        items.push({ ...base, name: `${name}#${i + 1}`, url: fna + fp, filename: `${name}_${leaf.replace(/ /g, "_")}`,
          note: `${label} (PDF)` });
      });
    }
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [, p, probs] = resolve(pack, req);
  if (probs.length) throw new DataError(probs.join("; "), "bad_request");
  const e = endpointOf(req);
  const read = (f: string) => fs.readFileSync(f);
  const paths = [...files].sort(cmp);
  const isPk = (b: Buffer) => b.subarray(0, 2).toString("latin1") === "PK";
  if (e === "program_table") {
    const [k, c] = tableOf({ table: p.table || req.dataset });
    for (const x of paths) {
      const body = read(x);
      if (isPk(body)) {
        try {
          if (findSheet(readBook(body), c)) return programRows(k, c, body, p)[0];
        } catch (ex) {
          if (ex instanceof LayoutError) continue;
          throw ex;
        }
      }
    }
    throw new DataError(`request ${pyRepr(req.name)} needs the Excel file of ${k} (${c.stem}-NN.xlsx); none of the ` +
      "uploaded files is that table (checked by its title row)", "bad_request");
  }
  if (e === "snap_state_monthly") {
    const fys = ints(p.fiscal_year, EPS.snap_zip.first_xlsx_year, 2100, "fiscal_year");
    const bodies = new Map<number, Uint8Array>();
    for (const x of paths) {
      const body = read(x);
      if (!isPk(body)) continue;
      let names: string[];
      try {
        names = zipMembers(body);
      } catch {
        throw new DataError(`usda-fna: ${path.basename(x)} is not a zip file`, "api");
      }
      if (names.includes("xl/workbook.xml")) { // one FYyy.xlsx uploaded on its own
        const top = readBook(body)[0][1].slice(0, 3).flatMap((r) => r.filter((v) => v).map(norm)).join(" ");
        const fy = fys.find((y) => top.includes(`Fiscal Year ${y}`));
        if (fy) bodies.set(fy, body);
        continue;
      }
      for (const fy of fys) {
        const b = snapZipMember(body, names, fy);
        if (b !== null) bodies.set(fy, b);
      }
    }
    const got = [...bodies.keys()].sort((a, b) => a - b), need = [...fys].sort((a, b) => a - b);
    if (got.join(",") !== need.join(",")) {
      throw new DataError(`request ${pyRepr(req.name)} needs the SNAP data zip (or its FYyy.xlsx files) for FY ${pyRepr(fys)}; ` +
        `the upload has ${got.length ? pyRepr(got) : "none of them"}`, "bad_request");
    }
    return snapMonthlyRows(bodies, p)[0];
  }
  if (e === "wic_agency_monthly") {
    const fy = ints(p.fiscal_year, 2022, 2100, "fiscal_year")[0];
    for (const x of paths) {
      const body = read(x);
      if (!isPk(body)) continue;
      let book;
      try {
        book = readBook(body);
      } catch (ex) {
        if (ex instanceof LayoutError) continue;
        throw ex;
      }
      const rx = new RegExp(`FISCAL YEAR ${fy}\\b`, "i");
      if (book.some(([n, rs]) => rx.test(rs.slice(0, 4).flatMap((r) => r.filter((v) => v).map(norm)).join(" ")) &&
        wicSheetKey(n, EPS.wic_agency_sheets))) return wicAgencyRows(body, fy, p)[0];
    }
    throw new DataError(`request ${pyRepr(req.name)} needs wicagencies${fy}ytd.xlsx; no uploaded file is the FY ${fy} WIC ` +
      "agency workbook", "bad_request");
  }
  if (e === "options_by_state") {
    const abbrs = agenciesOf(p.state);
    const [rows, notes] = byStateRows(paths.map(read), abbrs, EPS.tableau.editions[edition(p.edition)]);
    if (notes.length) {
      throw new DataError(`the uploaded files hold ${pyStrip(notes[0].split(INCOMPLETE).pop()!)}: upload every ` +
        "StateAgencyComparison file listed in INSTRUCTIONS.md", "bad_request");
    }
    return rows;
  }
  if (e === "option_states") {
    const [c, sels] = selections({ ...p, policy: p.policy || req.dataset });
    return optionRows(paths.map(read), c, sels, EPS.tableau.editions[edition(p.edition)]);
  }
  const pdfs = paths.filter((x) => read(x).subarray(0, 4).toString("latin1") === "%PDF");
  if (!pdfs.length) throw new DataError(`request ${pyRepr(req.name)} needs the report PDF; the upload has none`, "bad_request");
  if (e === "options_report") return reportRows(pdfPages(read(pdfs[0])), edition(p.edition, reportEditions()), p, EPS);
  const years = ints(p.fiscal_year, 2004, 2023, "fiscal_year");
  const byYear = new Map<number, string[]>();
  for (const x of pdfs) { // the agency's file names do not sort by year: read each PDF
    const pages = pdfPages(read(x));
    const fy = reportYear(pages);
    if (fy !== null && years.includes(fy)) byYear.set(fy, pages);
  }
  const got = [...byYear.keys()].sort((a, b) => a - b), need = [...years].sort((a, b) => a - b);
  if (got.join(",") !== need.join(",")) {
    throw new DataError(`request ${pyRepr(req.name)} needs the State Activity Report PDF for FY ${pyRepr(years)}; the upload has ` +
      `${got.length ? pyRepr(got) : "none of them"} (the year is read from each PDF's cover or table titles)`, "bad_request");
  }
  let rows: Row[] = [];
  for (const fy of years) {
    rows = rows.concat(e === "activity_report" ? activityPageRows(byYear.get(fy)!, fy, p) : activityTableRows(byYear.get(fy)!, fy, p, EPS)[0]);
  }
  return rows;
}

const adapter: Adapter = {
  checkSpec: (spec) => checkSpec(spec),
  fetch: (spec, pack) => fetch(spec, pack),
  manualItems,
  parseUpload,
};
export default adapter;
