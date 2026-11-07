/**
 * The bls deep pack: BLS time series through the BLS Public Data API (port of sources/bls/fetch.py, bls_api.py and
 * lib/series_ids.py; the series-id data are in packs/bls/series_ids.json).
 *
 * spec: {"description": "Unemployment and job openings since 2015",
 *        "series": [{"id": "LNS14000000", "label": "Unemployment rate"}, "JTS000000000000000JOL"],
 *        "build": [{"kind": "laus", "state": "MD", "measure": "unemployment_rate"}],   optional: built IDs
 *        "start_year": 2015, "end_year": 2026,                                         end defaults to this year
 *        "annual_average": true, "catalog": true, "calculations": false}               v2 (key) only
 * Route: with a key, API v2; without one (or with a rejected key), keyless v1 when the request fits its limits (25
 * queries a day, 25 series and 10 years per query); otherwise the key is needed (or the manual bundle).
 *
 * Discovery (request_schema search): words search the topic catalog of common series; series IDs ("LNS14000000
 * CUUR0000SA0", or "describe ...") give each one's title, seasonal adjustment and dimensions from data.bls.gov;
 * "decode ID ..." reads the survey and S/U code offline; "build {json}" shows the IDs a build entry makes.
 */
import path from "node:path";
import { DataError } from "../core/http.js";
import { dataDir } from "../core/package.js";
import type { DeepContext, DeepPack, DeepResult, Pack } from "../core/packs.js";
import * as pol from "../core/policy.js";
import { fail } from "../envelope.js";
import { BlsClient, BlsError, describe, LIMITS, planQueries, REGISTER_URL } from "./_bls_api.js";
import { build, D, decode, searchCatalog, SpecError, topics } from "./_bls_ids.js";
import * as L from "./_bls_lib.js";

const one = (n: number, w: string, many: string) => `${n} ${n === 1 ? w : many}`;

function checkSpec(spec: any): string[] {
  try {
    L.normSpec(spec);
    return [];
  } catch (e) {
    if (e instanceof SpecError || e instanceof TypeError) return [`spec has a problem: ${e.message}`];
    throw e;
  }
}

function citation(pack: Pack, sp: L.NSpec, retrieved: string): string {
  const ids = sp.series.map((x) => x.id);
  return pol.citation(pack.policy, "", { retrieved, dataset: ids.slice(0, 8).join(", ") +
    (ids.length > 8 ? ` and ${ids.length - 8} more series` : "") });
}

function result(pack: Pack, out: string, pk: { req: any }, sp: L.NSpec, notes: string[]): DeepResult {
  const d = dataDir(out, L.SOURCE);
  const tables = (pk.req.tables as any[]).map((t) => ({ name: t.name, file: t.file, rows: t.rows,
    columns: L.readHeader(path.join(d, t.file)) }));
  return { data_dir: d, tables, notes: [`API ${pk.req.api_version}; latest period in the data: ${pk.req.latest_period}`, ...notes,
    ...(pk.req.messages as string[]).slice(0, 10).map((m) => `BLS: ${m}`)],
    problems: pk.req.problems, retrieved: pk.req.retrieved, citation: citation(pack, sp, pk.req.retrieved), route: pk.req.route,
    files: [] };
}

async function fetch(ctx: DeepContext): Promise<DeepResult> {
  const { pack, workspace: out } = ctx;
  const sp = L.normSpec(ctx.spec);
  const ex = L.existingData(out, L.fingerprint(sp));
  if (ex && ex.csv_exists && ex.matches && !ex.problems.length && !ctx.force) {
    const stale = ex.age_days !== null && ex.age_days >= 7;
    const r = result(pack, out, { req: ex.saved }, sp, [`The data for this request are already in ${ex.path} (retrieved ` +
      `${pol.localDay(ex.retrieved)}, latest period ${ex.latest_period}).` + (stale ? " BLS has probably published newer " +
      "data or revisions since then: ask whether to refresh (force: true) if the latest month matters." : " force: true downloads again.")]);
    return { ...r, route: "reuse_existing" };
  }
  const ids = sp.series.map((x) => x.id);
  const plans = { v1: planQueries(ids, sp.start_year, sp.end_year, "v1"), v2: planQueries(ids, sp.start_year, sp.end_year, "v2") };
  const v1Fits = plans.v1.length <= LIMITS.v1.daily;
  const lost = (["annual_average", "calculations"] as const).filter((o) => sp[o]);
  const lostNote = lost.length ? `Without a key BLS does not return ${lost.join(", ")}; compute them from the monthly data and ` +
    "say so (not for medians or productivity: CPS median earnings, LE series, and PR annual values are not means of their " +
    "quarters; take BLS's annual table, or FRED's annual series '<id>A')." : "";
  const keyBenefit = `A free key (${REGISTER_URL}) raises the limits to 500 queries a day, 50 series and 20 years per ` +
    "query, and adds published annual averages and BLS's own net and percent changes.";
  let c = new BlsClient();
  const notes: string[] = [];
  if (!c.key && !v1Fits) {
    throw new DataError(`bls: this request needs ${one(plans.v1.length, "keyless query", "keyless queries")} (limit ` +
      `${LIMITS.v1.daily} a day) or ${plans.v2.length} with a key, and no BLS_API_KEY is set up. Narrow the request (fewer ` +
      "series or years) to fit the keyless limits, or set up a key.", "key_missing");
  }
  let got;
  try {
    got = await c.fetch(ids, sp.start_year, sp.end_year, { catalog: sp.catalog, annualaverage: sp.annual_average,
      calculations: sp.calculations, aspects: sp.aspects });
  } catch (e) {
    if (e instanceof BlsError && e.blsKind === "auth" && c.key && v1Fits) {
      notes.push(`BLS rejected the stored key (keys expire after a year: renew it at ${REGISTER_URL}); this request fits the ` +
        `keyless limits, so it was downloaded without the key (API v1).`);
      c = new BlsClient({ useKey: false });
      got = await c.fetch(ids, sp.start_year, sp.end_year, {}).catch(blocked);
    } else blocked(e);
  }
  const [by, messages, raw] = got!;
  if (c.version === "v1") {
    notes.push(`No working BLS key: keyless API v1 (${one(plans.v1.length, "query", "queries")} of the ${LIMITS.v1.daily} ` +
      `allowed per day). ${lostNote} ${keyBenefit}`.replace(/ {2,}/g, " ").trim());
  }
  const route = c.version === "v2" ? "api" : "api_keyless";
  const pk = await L.packageData(pack, by, messages, raw, sp, out, c.version, "BLS Public Data API download", route);
  if (pk.req.problems.length) notes.push("Some series returned no data: check the IDs (request_schema search with the IDs) and fix the spec.");
  return result(pack, out, pk, sp, notes);
}

function blocked(e: unknown): never {
  if (e instanceof BlsError && e.blsKind === "unavailable") {
    throw fail("agency_unavailable", e.message, "A temporary BLS outage, not a problem with the spec: fetch the same spec " +
      "once more in about 30 minutes (do not loop; failed attempts may count against the keyless quota). Meanwhile FRED " +
      "carries the headline BLS series (UNRATE, PAYEMS, CPIAUCSL): use it if the question allows, and say which source the " +
      "figures came from.");
  }
  if (e instanceof BlsError && e.blsKind === "quota") {
    throw fail("agency_unavailable", e.message, "The BLS daily query limit is used up. It resets the next day; manual_bundle " +
      "lets the user download from another computer meanwhile. Tell the user; do not retry today.", { manual_bundle:
      "manual_bundle writes a one-command download the user runs on their own computer; then ingest" });
  }
  throw e;
}

async function ingest(ctx: DeepContext & { files: string[] }): Promise<DeepResult> {
  const sp = L.normSpec(ctx.spec);
  const { pk, notes } = await L.ingest(ctx.pack, ctx.files, sp, ctx.workspace);
  return result(ctx.pack, ctx.workspace, pk, sp, notes);
}

function schema(names: string[]): any[] {
  return names.map((n) => {
    if (n === "build") {
      return { name: "build", summary: "build series IDs from a state, county, occupation or industry",
        spec: { build: [{ kind: "laus | oews | state | ces_state | jolts", "...": "the kind's parameters" }] },
        kinds: {
          laus: { params: { state: "USPS code, FIPS or name (comma-separated or a list)", county: "5-digit FIPS (state + county), " +
            "published not seasonally adjusted only", measure: D().laus_measures.map(([k]) => k), seasonal: "S (default) or U" },
            pattern: "LAS/LAU + ST + FIPS + 11 zeros + measure; county LAUCN + FIPS5 + 8 zeros + measure" },
          oews: { params: { occupation: "SOC code(s) such as 15-1252", measure: D().oews_measures.map(([k]) => k),
            state: "optional: state (else national)" }, note: "annual; the API returns only the latest survey year (May reference period)" },
          state: { params: { state: "one state" }, makes: "LAUS unemployment rate, employment, labor force + CES total nonfarm payrolls" },
          ces_state: { params: { state: "state(s)", industry: "8-digit CES industry (00000000 = total nonfarm)",
            datatype: "2 digits (01 = employment)", seasonal: "S or U" } },
          jolts: { params: { industry: "code(s) or name(s), or all", measure: D().jolts_elements.map(([k]) => k),
            rate: "true (rate, default) or false (level, thousands)", seasonal: "S or U" },
            industries: Object.fromEntries(D().jolts_industries) },
        },
        preview: "request_schema search \"build {\\\"kind\\\": \\\"laus\\\", \\\"state\\\": \\\"MD\\\"}\" shows the IDs and labels" };
    }
    return { name: "series", summary: "BLS time series by series ID",
      spec: { description: "what this fetch is for",
        series: "[{\"id\": \"LNS14000000\", \"label\": \"Unemployment rate\"}] or plain IDs (capital letters and digits, 5-40)",
        build: "optional: built IDs (see the build schema)", start_year: "default end_year - 9", end_year: "default this year",
        annual_average: "v2 (key) only: BLS-published annual averages (M13 / Q05 / S03)",
        catalog: "v2 only, default true: series titles (without a key, titles come from data.bls.gov)",
        calculations: "v2 only: BLS's own 1-, 3-, 6- and 12-month net and percent changes" },
      limits: { v2_with_key: LIMITS.v2, v1_keyless: LIMITS.v1, note: "the fetch splits the request into queries that fit; " +
        "without a key a request needing more than 25 queries needs a key (or the manual bundle)" },
      series_id_rules: { third_letter: "S = seasonally adjusted, U = not (for most surveys)",
        prefixes: Object.fromEntries(D().surveys.map(([k, v]) => [k, v])),
        watch: ["U-6 is LNS13327709 (LNS13023621 is a level of job losers, not U-6)", "the ECI prefix is CI (EI is import/export prices)",
          "WPUFD4 is PPI final demand, not finished goods", "LNS14000036 is the 20-24 rate; 16-24 is LNS14024887",
          "FRED keeps pre-2018 metro area codes in many CPI IDs (FRED CUURA101SA0 = BLS CUURS12ASA0)"],
        verify: "request_schema search with the IDs: each one's title from data.bls.gov (read SA/NSA and units back against the concept)",
        verified_on: D().verified },
      output: "data/bls/bls_series.csv (series_id, label, year, period, period_name, freq, date, value, value_raw, preliminary, " +
        "footnote_codes, footnotes, latest; bls_net_*m / bls_pct_*m with calculations), series.csv (title, seasonal, " +
        "frequency, first/last period, n_obs, n_missing, absent_periods, n_preliminary), raw/, request.json, README.md",
      topics: topics() };
  });
}

async function search(query: string): Promise<any[]> {
  const q = query.trim();
  let m = /^build\s+([\s\S]+)$/i.exec(q);
  if (m) {
    let b: any;
    try {
      b = JSON.parse(m[1]);
    } catch {
      throw fail("invalid_request", "build needs a JSON object, e.g. build {\"kind\": \"laus\", \"state\": \"MD\"}", "Give the build entry as JSON.");
    }
    try {
      const { kind = "", ...kw } = b || {};
      return build(String(kind), kw).map((x) => ({ ...x, ...decode(x.id) }));
    } catch (e) {
      if (e instanceof SpecError) throw fail("invalid_request", e.message, "Fix the build entry (request_schema names [\"build\"]).");
      throw e;
    }
  }
  m = /^decode\s+([\s\S]+)$/i.exec(q);
  if (m) return m[1].split(/[\s,]+/).filter(Boolean).map(decode);
  m = /^describe\s+([\s\S]+)$/i.exec(q);
  const toks = (m ? m[1] : q).split(/[\s,]+/).filter(Boolean);
  if (m || (toks.length && toks.every((t) => /^[A-Z0-9]{5,40}$/.test(t) && /\d/.test(t) && /[A-Z]/.test(t)))) {
    const out: any[] = [];
    // the page's empty fields (no SA cell for PR series) never hide what the ID itself says
    for (const t of toks) out.push({ ...decode(t), ...Object.fromEntries(Object.entries(await describe(t)).filter(([, v]) => v !== "" && v !== null && v !== undefined)) });
    return out;
  }
  return [...searchCatalog(q), { topics: topics(), note: "A curated list of common series, not a BLS search. Build area " +
    "and occupation IDs with build entries; confirm any ID by searching for it (its data.bls.gov title). More: docs/series_ids.md." }];
}

const pack: DeepPack = {
  operations: [
    { name: "series", summary: "BLS time series by series ID (CPS, CES, CPI, PPI, JOLTS, ECI, productivity, LAUS, OEWS, QCEW ...): " +
      "spec series[] with start_year/end_year" },
    { name: "build", summary: "Series IDs built from a state, county, occupation or industry (laus, oews, state, ces_state, " +
      "jolts): spec build[]" },
  ],
  schema: (names) => schema(names),
  uses: (spec) => [...((spec?.series || []).length || !(spec?.build || []).length ? ["series"] : []),
    ...((spec?.build || []).length ? ["build"] : [])],
  specExample: { description: "Unemployment rate and nonfarm payrolls, 2017-2026",
    series: [{ id: "LNS14000000", label: "Unemployment rate" }, { id: "CES0000000001", label: "Total nonfarm payrolls" }],
    start_year: 2017, end_year: 2026 },
  search: (q) => search(q),
  checkSpec: (spec) => checkSpec(spec),
  fetch,
  ingest,
  manualItems: (spec) => L.manualItems(spec),
};

export default pack;
