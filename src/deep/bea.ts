/**
 * The bea deep pack: BEA's Data API (key) and its public bulk files (no key), packaged as one tidy CSV
 * (port of sources/bea/fetch.py and bea_api.py).
 *
 * spec: {"description": "...", "prefer": "auto" | "api" | "bulk" (optional, the Python --prefer),
 *        "requests": [{"id": "gdp_pct", "dataset": "NIPA", "table": "T10101", "line_code": 1, "frequency": "Q",
 *                      "years": "2019-2025"},
 *                     {"id": "st", "dataset": "Regional", "table": "SAGDP9", "line_code": 1, "geo_fips": "STATE", ...},
 *                     {"id": "ita", "dataset": "ITA", "params": {"Indicator": "BalGds", "AreaOrCountry": "China"}}]}
 * Route: a key -> the API (GDP-by-industry workbook tables always from the workbook); no key and every request in
 * the bulk files -> the bulk files; no key and a request that needs the API -> key_missing (manual_bundle offered).
 * A key BEA rejects or has locked out falls back to the bulk files when they hold every request.
 *
 * Discovery (request_schema search): words search NIPA table titles and the GDP-by-industry workbooks (no key);
 * "<Dataset> words" searches that dataset's tables (API datasets need a key); "lines T10106" lists a NIPA table's
 * lines (no key); "values Regional LineCode TableName=SAINC1" lists a parameter's values (key).
 */
import { DataError } from "../core/http.js";
import { dataDir } from "../core/package.js";
import type { DeepContext, DeepPack, DeepResult, Pack } from "../core/packs.js";
import { fail } from "../envelope.js";
import { BeaClient, BeaError, DATASETS, datasetName, findApiKey, valueKey } from "./_bea_api.js";
import * as F from "./_bea_fetch.js";

const PREFER = ["auto", "api", "bulk"];
const SEARCH_LIMIT = 20;

function preferOf(spec: any): string {
  return spec?.prefer === undefined || spec?.prefer === null ? "auto" : String(spec.prefer).toLowerCase();
}

function checkSpec(spec: any): string[] {
  let reqs: F.Req[];
  try {
    reqs = F.normalizeRequests(spec);
  } catch (e) {
    if (e instanceof DataError) return [e.message];
    throw e;
  }
  const probs = F.specProblems(reqs);
  const prefer = preferOf(spec);
  if (!PREFER.includes(prefer)) probs.push(`prefer must be one of ${PREFER.join(", ")} (got ${JSON.stringify(spec.prefer)})`);
  if (prefer === "bulk") {
    const need = reqs.filter((q) => !F.bulkCoverage(q)[0]).map((q) => q.id);
    if (need.length) probs.push(`prefer "bulk" was given, but these requests are not in the bulk files: ${need.join(", ")}`);
  }
  return probs;
}

function result(p: F.Packaged, notes: string[]): DeepResult {
  return { data_dir: p.data_dir, tables: p.tables, notes: [...notes, ...p.notes], problems: [], retrieved: p.retrieved,
    citation: p.citation, vintage: p.vintage.join("; "), route: p.route, files: p.files };
}

const KEY_TROUBLE = new Set(["auth", "rate_limit", "budget"]);

async function fetch(ctx: DeepContext): Promise<DeepResult> {
  const { spec, workspace: out, force } = ctx;
  const notes: string[] = [];
  const reqs = F.normalizeRequests(spec, notes);
  const probs = F.specProblems(reqs);
  if (probs.length) throw new BeaError("The request has problems: " + probs.join("; "), "api", { dataKind: "spec" });
  const ex = F.existingData(out, reqs);
  if (ex && ex.csv_exists && ex.spec_matches && !force) {
    const s = ex.saved;
    return { data_dir: dataDir(out, F.SOURCE), tables: s.tables, notes: [`The data for this request are already in ${ex.path} ` +
      `(${ex.rows} rows, ${ex.route}, ${ex.downloaded}). Fetch with force: true to download again (for example after a BEA release).`,
    ...(s.notes || [])], problems: [], retrieved: s.retrieved, citation: s.citation, vintage: (s.vintage || []).join("; "),
    route: "reuse_existing", files: [] };
  }
  const prefer = preferOf(spec);
  const [key] = findApiKey();
  const coverAll = reqs.every((q) => F.bulkCoverage(q)[0]);
  const bulk = async (extra: string[]) => {
    const [rows, nts, manifest] = await F.runBulk(reqs, F.cacheDir(out));
    return result(F.packageData(out, reqs, spec, rows, nts, "bulk", [], manifest, "BEA public bulk files", extra), notes);
  };
  if (prefer === "bulk" || (!key && coverAll && prefer !== "api")) {
    return bulk([key ? "Using BEA's public bulk files as requested (prefer: bulk)." :
      "Every request is in BEA's public bulk files, so no key was needed (the same, latest estimates as the API)."]);
  }
  const apiReqs = reqs.filter((q) => !q.bulk_only), fileReqs = reqs.filter((q) => q.bulk_only);
  let rows: F.Row[] = [], nts: F.Row[] = [], log: any[] = [];
  if (apiReqs.length) {
    try {
      const client = new BeaClient();
      const mprobs = await F.validateWithMetadata(client, apiReqs);
      if (mprobs.length) throw new BeaError("BEA's metadata does not have: " + mprobs.join("; "), "api");
      [rows, nts, log] = await F.runApi(client, apiReqs, out);
    } catch (e) {
      if (e instanceof BeaError && KEY_TROUBLE.has(e.bea) && key && coverAll && prefer !== "api") {
        return bulk([`The BEA key does not work right now (${e.message.split("\n")[0].slice(0, 300)}), but every request is in ` +
          "BEA's public bulk files, so they were used instead (no key needed; the same, latest estimates). Tell the user " +
          "about the key problem in one line."]);
      }
      throw e;
    }
  }
  let manifest: F.Manifest = {};
  if (fileReqs.length) {
    const [r2, n2, m2] = await F.runBulk(fileReqs, F.cacheDir(out));
    rows = rows.concat(r2);
    nts = nts.concat(n2);
    manifest = m2;
  }
  const route = apiReqs.length ? "api" : "bulk";
  const acquired = apiReqs.length ? "BEA Data API" + (fileReqs.length ? " and public bulk files" : "") : "BEA public bulk files";
  return result(F.packageData(out, reqs, spec, rows, nts, route, log, manifest, acquired), notes);
}

async function ingest(ctx: DeepContext & { files: string[] }): Promise<DeepResult> {
  const notes: string[] = [];
  const reqs = F.normalizeRequests(ctx.spec, notes);
  const p = await F.ingestFiles(ctx.files, ctx.spec, reqs, ctx.workspace);
  return result(p, [...notes, "Files downloaded by the user and uploaded, then packaged: say where they came from in the " +
    "methods (BEA's API notice applies when the replies came from the API)."]);
}

function specKeys(name: string): Record<string, string> {
  const common = { id: "short name for the request (rows carry it in request_id)",
    params: "raw API parameters (BEA names); they override the friendly keys" };
  const years = '"2019-2025", a list of years, "ALL", or "LAST5" / "LAST10" (the last n years with data)';
  if (F.NIPA_LIKE.includes(name)) {
    return { table: name === "NIPA" ? "T10101 ... (search words to find titles)" : name === "FixedAssets" ? "FAAt101 ..." : "U20305 ...",
      ...(name === "FixedAssets" ? {} : { frequency: "A | Q | M (monthly only for tables whose title says so)" }), years,
      line_code: 'a number, a list, or "ALL": BEA returns the whole table and the rows are filtered', ...common };
  }
  if (name === "Regional") {
    return { table: "SAGDP9, SAINC1, CAINC1, SARPP, MARPP ... (an N suffix as in SAGDP9N also works)",
      line_code: 'a number, a list (one API call per line), or "ALL" (one GeoFips only)',
      geo_fips: '"STATE" | "COUNTY" | "MSA" | "PORT" | ... | a state postal code ("NY" = its counties) | FIPS codes ("06" = 06000). ' +
        "Every level comes back labeled in geo_level (COUNTY on the bulk route also holds state and U.S. rows): filter before summing.",
      years, ...common };
  }
  if (name === "GDPbyIndustry") {
    return { table: "workbook codes TVA101-TVA113, TGO101-TGO107, TII1xx (public workbooks, no key); API TableIDs (1, 5, 6, 25 ...) " +
      "go in params with Industry", frequency: "A | Q", years, ...common };
  }
  return { ...common, params: `the API parameters (required: ${DATASETS[name].required.join(", ") || "none, but see about"})` };
}

async function schema(names: string[], _pack: Pack): Promise<any[]> {
  const [key] = findApiKey();
  let client: BeaClient | null = null;
  let stop = "";
  const out: any[] = [];
  for (const name of names) {
    const d = DATASETS[name];
    const one: any = { name, about: d.about, api_required_parameters: d.required, spec_keys: specKeys(name),
      bulk_route: name === "NIPA" ? `${F.NIPA_TXT}NipaData{A,Q,M}.txt + SeriesRegister.txt + TablesRegister.txt (no key)`
        : name === "Regional" ? `${F.REGIONAL_ZIP}<SAGDP|SQGDP|SAINC|SQINC|SAPCE|SARPP|SAOR|CAINC1|...>.zip (no key): STATE, ` +
          "COUNTY, a postal code (its counties, CA* tables), FIPS lists, MA* tables"
          : name === "GDPbyIndustry" ? `${F.INDUSTRY_XLS}{ValueAdded,GrossOutput,IntermediateInputs}.xlsx (workbook codes only, no key)`
            : "none: the API (key) is needed" };
    if (d.freq_only) one.frequency_only = d.freq_only;
    if (d.one_of_many) one.rule = `several ${d.one_of_many[0]} values need exactly one specific ${d.one_of_many[1]} (and vice versa)`;
    if (!key) one.live_parameters = "with a BEA key, this lists BEA's current parameters (none is set up)";
    else if (stop) one.live_parameters = `not read: ${stop}`;
    else {
      try {
        client ??= new BeaClient();
        one.live_parameters = await client.parameters(name);
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        one.live_parameters = `unavailable: ${e.message.split("\n")[0].slice(0, 300)}`;
        if (e instanceof BeaError && KEY_TROUBLE.has(e.bea)) stop = one.live_parameters;
      }
    }
    out.push(one);
  }
  out.push({ discovery: {
    tables: 'request_schema search "real gross domestic product" (NIPA titles and GDP-by-industry workbook tables; no key)',
    dataset_tables: 'request_schema search "Regional income" or "ITA balance": the first word names the dataset (API datasets need a key)',
    lines: 'request_schema search "lines T10106" (a NIPA table\'s lines and series codes; no key)',
    values: 'request_schema search "values Regional LineCode TableName=SAINC1" (a parameter\'s values, with filters; key, cached a day)' },
  prefer: 'optional top-level "prefer": "bulk" uses the public bulk files even with a key; "api" never falls back to them' });
  return out;
}

async function search(query: string, _pack: Pack): Promise<any[]> {
  const q = query.trim();
  const lines = /^lines?\s*[: ]\s*(\S+)$/i.exec(q);
  if (lines) {
    const found = await F.listLines(lines[1]);
    return found.length ? found : [{ note: `${lines[1]}: not in SeriesRegister.txt (NIPA tables only)` }];
  }
  const values = /^values\s+(\S+)\s+(\S+)((?:\s+\S+=\S+)*)\s*$/i.exec(q);
  if (values) {
    const ds = datasetName(values[1]) ?? values[1];
    const filters: Record<string, string> = {};
    for (const kv of values[3].trim().split(/\s+/).filter(Boolean)) {
      const i = kv.indexOf("=");
      filters[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const c = new BeaClient();
    const vals = Object.keys(filters).length ? await c.parameterValuesFiltered(ds, values[2], filters) : await c.parameterValues(ds, values[2]);
    const rows = vals.map((v) => ({ key: valueKey(v), ...v }));
    return rows.length > 500 ? [...rows.slice(0, 500), { note: `${rows.length} values; showing 500: add a filter` }] : rows;
  }
  const words = q.split(/\s+/).filter(Boolean);
  const ds = words.length ? datasetName(words[0]) : null;
  const [hits, problems] = await F.findTables(ds ? words.slice(1).join(" ") : q, ds);
  const tail: Record<string, unknown> = {};
  if (hits.length > SEARCH_LIMIT) tail.note = `${hits.length} matches; showing ${SEARCH_LIMIT}: narrow the words or name the dataset first`;
  if (problems.length) tail.problems = problems;
  if (!hits.length) tail.next = 'No match: try fewer words, "lines <NIPA table>", or name the dataset first ("Regional income").';
  return [...hits.slice(0, SEARCH_LIMIT), ...(Object.keys(tail).length ? [tail] : [])];
}

function uses(spec: any): string[] {
  const reqs: any[] = Array.isArray(spec?.requests) && spec.requests.length ? spec.requests : spec?.dataset ? [spec] : [];
  return [...new Set(reqs.map((r) => datasetName(r?.dataset || "NIPA")).filter((x): x is string => !!x))];
}

function manualItems(spec: any): any[] {
  try {
    return F.manualItems(F.normalizeRequests(spec));
  } catch (e) {
    if (e instanceof DataError) throw fail("invalid_request", e.message, "Fix the spec from request_schema, then ask again.");
    throw e;
  }
}

const pack: DeepPack = {
  operations: Object.entries(DATASETS).map(([name, d]) => ({ name, summary: d.about + (d.bulk ? " (bulk files: no key)" :
    name === "GDPbyIndustry" ? " (workbook tables: no key)" : " (API: key)") })),
  schema,
  uses,
  specExample: { description: "Real GDP growth, national and by state, 2019 to 2025", requests: [
    { id: "gdp_pct", dataset: "NIPA", table: "T10101", line_code: 1, frequency: "Q", years: "2019-2025" },
    { id: "gdp_real", dataset: "NIPA", table: "T10106", line_code: 1, frequency: "Q", years: "2019-2025" },
    { id: "state_real", dataset: "Regional", table: "SAGDP9", line_code: 1, geo_fips: "STATE", years: "2019-2025" },
    { id: "va_ind", dataset: "GDPbyIndustry", table: "TVA105", frequency: "A", years: "2024-2025" }] },
  search,
  checkSpec: (spec) => checkSpec(spec),
  fetch,
  ingest,
  manualItems: (spec) => manualItems(spec),
  ping: () => new BeaClient({ timeout: 30, useCache: false }).ping(),
};

export default pack;
