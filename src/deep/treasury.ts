/**
 * The treasury deep pack: U.S. Treasury Fiscal Data API datasets (port of sources/treasury/fetch.py and context.py).
 *
 * spec: {"description": "...", "as_of": "2025-09-30",           as_of adds <date_field> <= as_of to every dataset
 *        "datasets": [{"name": "mts9", "endpoint": "v1/accounting/mts/mts_table_9",
 *                      "filter": {"record_date": {"gte": "2015-10-01"}},   bare value = eq, list = in; a string is API syntax
 *                      "fields": null, "date_field": "record_date", "sort": "...", "allow_empty": false}],
 *        "context": [{"kind": "cpi", "start": 2016}]}            optional: CPI / GDP context series (fiscal-year start)
 * A "fields" subset that leaves out row-identity columns makes the API GROUP AND SUM rows; the download compares
 * the row count with and without "fields" and stops if they differ.
 *
 * Discovery (request_schema search): words search the live catalog (falls back to the bundled catalog.json); an
 * endpoint path ("v2/accounting/od/debt_to_penny") gives its fields, types, units, row count and first/last row;
 * an endpoint, a JSON filter and the word values ("v1/accounting/mts/mts_table_1 {"record_date": "2026-09-30"}
 * values") lists the values each code and description column holds.
 */
import fs from "node:fs";
import path from "node:path";
import { DataError } from "../core/http.js";
import { dataDir } from "../core/package.js";
import type { DeepContext, DeepPack, DeepResult, Pack } from "../core/packs.js";
import { fail } from "../envelope.js";
import { FiscalDataClient, filterString, MAX_PAGE, normalizeEndpoint } from "./_treasury_api.js";
import { fetchContext, MANUAL, SERIES } from "./_treasury_context.js";
import * as L from "./_treasury_lib.js";

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

type Ctx = { kind: string; start: number };

/** The spec's context requests: "cpi", {"kind": "gdp", "start": 2016}, or a list of them. */
function contextOf(spec: any): Ctx[] {
  const c = spec?.context;
  if (c === undefined || c === null) return [];
  return (Array.isArray(c) ? c : [c]).map((x: any) => (typeof x === "string" ? { kind: x, start: Number(spec.context_start ?? 1990) }
    : { kind: x?.kind, start: Number(x?.start ?? spec.context_start ?? 1990) }));
}

const hasDatasets = (spec: any) => Array.isArray(spec?.datasets) && spec.datasets.length > 0;

function checkSpec(spec: any): string[] {
  const probs: string[] = [];
  const ctx = contextOf(spec);
  if (hasDatasets(spec) || !ctx.length) {
    try {
      const sp = L.loadSpec(spec);
      for (const d of sp.datasets) {
        filterString(L.effectiveFilter(sp, d));
        if (d.fields !== undefined && d.fields !== null && !(Array.isArray(d.fields) && d.fields.every((f) => typeof f === "string"))) {
          probs.push(`${d.name}: "fields" must be a list of field names (or left out)`);
        }
      }
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      probs.push(e.message);
    }
  }
  for (const c of ctx) {
    if (!(c.kind in SERIES)) probs.push(`context kind ${JSON.stringify(c.kind)}: use "cpi" or "gdp"`);
    if (!Number.isInteger(c.start) || c.start < 1900) probs.push(`context start ${JSON.stringify(c.start)}: the first fiscal year needed, e.g. 2016`);
  }
  return probs;
}

const columnsOf = (p: string): string[] => {
  const head = fs.readFileSync(p, "utf8").replace(/^﻿/, "").split(/\r?\n/)[0];
  return head ? head.split(",").map((c) => c.replace(/^"|"$/g, "")) : [];
};

function datasetTables(prov: any): DeepResult["tables"] {
  return Object.entries<any>(prov.datasets).map(([name, d]) => ({ name, file: `${name}.csv`, rows: d.rows, columns: d.columns }));
}

const unitNotes = (prov: any) => Object.entries<any>(prov.datasets).map(([name, d]) =>
  `${name}.csv: ${d.rows.toLocaleString("en-US")} rows, ${d.date_field} ${d.first_date ?? "None"} to ${d.last_date ?? "None"}; ` +
  `units: ${d.units || "see the field types in README.md"}`);

function citationFor(prov: any): string {
  const names = [...new Set(Object.values<any>(prov.datasets).map((v) => v.endpoint as string))].sort().join(", ");
  return L.CITATION.replace("{datasets}", names).replace("{date}", String(prov.retrieved).slice(0, 10));
}

async function contextPart(ctxs: Ctx[], out: string, alone: boolean, r: DeepResult): Promise<void> {
  for (const c of ctxs) {
    const res = await fetchContext(c.kind, out, c.start);
    if (res.status === "blocked") {
      if (alone) {
        throw fail("agency_unavailable", res.message + ` Errors: ${res.errors.join("; ")}`,
          `Tell the user; the series can be downloaded by hand: ${res.manual_download.join("; ")}. Never type CPI or GDP values from memory.`,
          { manual_download: res.manual_download });
      }
      r.problems!.push(`context ${c.kind}: ${res.message} (${res.errors.join("; ")}); by hand: ${MANUAL[c.kind].join("; ")}`);
      continue;
    }
    r.tables.push({ name: `context_${c.kind}`, file: `context_${c.kind}.csv`, rows: res.rows, columns: ["date", "value"] });
    r.notes.push(`context_${c.kind}.csv: ${c.kind.toUpperCase()} from ${res.source} (${res.series_id}), ${SERIES[c.kind].units}` +
      (res.source === "World Bank" ? "; calendar years only: it cannot give fiscal-year GDP" : "") +
      (res.missing_months.length ? `; months not published: ${res.missing_months.join(", ")}` : "") +
      (res.failed_sources.length ? `; sources that failed first: ${res.failed_sources.join("; ")}` : ""));
    const f = path.join(dataDir(out, L.SOURCE), "context_sources.json");
    if (!r.files!.includes(f)) r.files!.push(f);
  }
}

async function fetch(ctx: DeepContext): Promise<DeepResult> {
  const out = ctx.workspace;
  const d = dataDir(out, L.SOURCE);
  const ctxs = contextOf(ctx.spec);
  const r: DeepResult = { data_dir: d, tables: [], notes: [], problems: [], retrieved: new Date().toISOString(),
    citation: "", route: "api", files: [] };
  if (hasDatasets(ctx.spec) || !ctxs.length) {
    const spec = L.loadSpec(ctx.spec);
    const ex = L.existingData(out, spec);
    let prov: any, citation: string;
    if (ex && ex.files_ok && ex.spec_matches && !ctx.force) {
      prov = ex.prov;
      citation = citationFor(prov);
      r.route = "reuse_existing";
      r.notes.push(`The data for this spec are already in ${d} (retrieved ${ex.retrieved}).` +
        (spec.as_of ? "" : " No as_of cut-off is set, so newer records may exist; fetch with force: true if the user wants the latest data."));
    } else {
      const dl = await L.download(spec, out, new FiscalDataClient());
      ({ prov, citation } = dl);
      r.notes.push(...dl.notes, ...dl.warnings);
    }
    r.tables.push(...datasetTables(prov));
    r.notes.push(...unitNotes(prov));
    r.retrieved = prov.retrieved;
    r.citation = citation;
    r.files!.push(path.join(d, "fetch_spec.json"));
  }
  await contextPart(ctxs, out, !hasDatasets(ctx.spec), r);
  if (!r.citation) {
    r.citation = "Context series: " + r.tables.map((t) => t.file).join(", ") + ` (sources in context_sources.json), retrieved ${r.retrieved.slice(0, 10)}.`;
  }
  return r;
}

async function ingest(ctx: DeepContext & { files: string[] }): Promise<DeepResult> {
  const spec = L.loadSpec(ctx.spec);
  const res = L.ingest(ctx.files, spec, ctx.workspace);
  const d = dataDir(ctx.workspace, L.SOURCE);
  return { data_dir: d, tables: datasetTables(res.prov), notes: [...res.warnings, ...unitNotes(res.prov)], problems: [],
    retrieved: res.prov.retrieved, citation: res.citation, route: "manual_download", files: [path.join(d, "fetch_spec.json")] };
}

const FORMAT = {
  description: "what this fetch is for",
  as_of: "YYYY-MM-DD data cut-off: adds <date_field> <= as_of to every dataset (leave it out only for latest lookups)",
  datasets: [{ name: "file name: lowercase letters, digits, _ (data/treasury/<name>.csv)",
    endpoint: "an endpoint path with its fixed version, e.g. v1/accounting/mts/mts_table_9 (v1 or v2: the other returns 404)",
    filter: "optional: {field: value} (eq), {field: [a, b]} (in), {field: {gte|gt|lte|lt|eq|in: value}}; a string is raw API syntax " +
      "(record_date:gte:2020-01-01,security_desc:in:(A,B))",
    fields: "optional list; leave it out unless it includes every row-identity column (a subset makes the API group and sum rows)",
    date_field: "optional; default record_date (some endpoints use effective_date, earning_period_start ...)",
    sort: "optional; default date_field (+ src_line_nbr when the endpoint has it)",
    allow_empty: "optional; a filter that matches no rows is an error unless true" }],
};

function schema(names: string[], pack: Pack): any[] {
  return names.map((n) => {
    if (n === "context") {
      return { name: "context", summary: "CPI-U (FRED CPIAUCNS, else BLS CUUR0000SA0) or GDP (FRED GDP, else World Bank, calendar years only) " +
        "for real dollars or % of GDP; only when the user wants them",
        spec: { context: [{ kind: "cpi | gdp", start: "the first FISCAL year needed (data from October 1 of the year before)" }],
          note: "context may stand alone or sit beside datasets; output data/treasury/context_<kind>.csv (date, value) and context_sources.json" },
        units: Object.fromEntries(Object.entries(SERIES).map(([k, v]) => [k, v.units])) };
    }
    const cat = L.loadCatalog(pack.dir);
    return { name: "dataset", summary: "one table per dataset from any Fiscal Data endpoint", spec: FORMAT,
      page_limit: `${MAX_PAGE.toLocaleString("en-US")} rows per API page: the fetch reads every page and checks the count against total-count`,
      local_filters: "values with &, commas or parentheses are filtered locally after the download (the API mishandles them)",
      discovery: { search: "request_schema search with words searches the live catalog (falls back to the bundled catalog.json)",
        fields: "request_schema search \"<endpoint>\" gives fields, labels, types, units, row count, first and last row",
        values: "request_schema search \"<endpoint> <filter JSON> values\" lists every code and description column's values under the filter (at most 20,000 rows)" },
      curated: cat.filter((e) => e.guidance).map((e) => Object.fromEntries(["endpoint", "table", "frequency", "earliest_date", "guidance"]
        .filter((k) => k in e).map((k) => [k, e[k]]))),
      all_endpoints: cat.length,
      output: "data/treasury/<name>.csv (API field names, values as published, \"null\" -> empty), fetch_spec.json (query URLs, " +
        "row counts, first/last date, labels, types, unit hints, SHA-256, route), README.md (data dictionary, values of every code column)" };
  });
}

async function search(query: string, pack: Pack): Promise<any[]> {
  const q = query.trim();
  const m = /^(\S*v[12]\/\S+)(?:\s+([\s\S]*))?$/.exec(q);
  if (m) {
    let rest = (m[2] || "").trim();
    const values = /(^|\s)values$/i.test(rest);
    if (values) rest = rest.replace(/(^|\s)values$/i, "").trim();
    let filter: any;
    if (rest) {
      try {
        filter = JSON.parse(rest);
      } catch {
        filter = rest;                      // API filter syntax
      }
    }
    try {
      normalizeEndpoint(m[1]);
    } catch (e: any) {
      throw fail("invalid_request", e.message, "Give an endpoint path such as v2/accounting/od/debt_to_penny.");
    }
    return [values ? await L.valuesInfo(m[1], filter) : await L.fieldsInfo(m[1], filter)];
  }
  const [hits, where] = await L.searchCatalog(pack.dir, q);
  return [...hits.slice(0, L.SEARCH_LIMIT), { searched: where,
    ...(hits.length > L.SEARCH_LIMIT ? { note: `${hits.length} matches; showing ${L.SEARCH_LIMIT}: add words to narrow` } : {}),
    next: "request_schema search \"<endpoint>\" for its fields; add a filter and the word values for the code columns' values" }];
}

const pack: DeepPack = {
  operations: [
    { name: "dataset", summary: "One table from any Fiscal Data endpoint (debt to the penny, MTS receipts/outlays/deficit, DTS " +
      "cash, interest expense, average rates, debt limit, auctions, exchange rates ...): spec datasets[] with endpoint and filter" },
    { name: "context", summary: "CPI-U or GDP context series for real dollars or % of GDP (FRED, else BLS or World Bank): spec context[]" },
  ],
  schema,
  uses: (spec) => [...(hasDatasets(spec) || !contextOf(spec).length ? ["dataset"] : []), ...(contextOf(spec).length ? ["context"] : [])],
  specExample: { description: "Debt to the penny, fiscal year ends 2015-2025", as_of: "2025-09-30",
    datasets: [{ name: "debt", endpoint: "v2/accounting/od/debt_to_penny", filter: { record_date: { gte: "2014-09-01" } } }] },
  search,
  checkSpec: (spec) => checkSpec(spec),
  fetch,
  ingest,
  manualItems: (spec) => (hasDatasets(spec) ? L.manualItems(spec) : []),
};

export default pack;
