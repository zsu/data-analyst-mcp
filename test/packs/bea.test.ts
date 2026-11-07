/** BEA: ported from tests/sources/bea/test_bea.py (same fixtures and values).
 *
 * Fixtures: bulk_*.txt and bulk_SAGDP.zip are BEA's real bulk files (2026-10-19/20) trimmed to a few series, areas
 * and years; doc_*.json are BEA's documented API examples (user guide, April 2026), with the guide's example UserID,
 * which BEA echoes in Request. Not live responses.
 * Not ported: the stats.py checks (s12, s12b, s13, s14: lib/ is not ported yet) and the shared report-tool checks
 * (s15-s17, s19 and the scan_secrets half of s18: scripts/report is not ported yet).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as A from "../../src/deep/_bea_api.js";
import * as F from "../../src/deep/_bea_fetch.js";
import * as T from "../../src/tools.js";
import { csv, failure, fakeKeys, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "bea", "fixtures");
const DOC_KEY = "11111111-2222-3333-4444-555555555555"; // the user guide's example key, not a real one
const FILES: Record<string, string> = {
  "SeriesRegister.txt": path.join(FX, "bulk_SeriesRegister.txt"), "NipaDataA.txt": path.join(FX, "bulk_NipaDataA.txt"),
  "NipaDataQ.txt": path.join(FX, "bulk_NipaDataQ.txt"), "TablesRegister.txt": path.join(FX, "bulk_TablesRegister.txt"),
  "SAGDP.zip": path.join(FX, "bulk_SAGDP.zip") };
const SPEC = { description: "Real GDP, percent change and state real GDP", requests: [
  { id: "pct", dataset: "NIPA", table: "T10101", line_code: 1, frequency: "Q", years: "2025-2026" },
  { id: "st", dataset: "Regional", table: "SAGDP9", line_code: 1, geo_fips: ["06000", "48000"], years: "2024-2025" }] };
const API_SPEC = { description: "PCE by type of product (documented example)",
  requests: [{ id: "pce", dataset: "NIPA", table: "T20305", frequency: "Q", years: "2015" }] };
const ITA_SPEC = { description: "trade", requests: [{ id: "ita", dataset: "ITA", params: { Indicator: "BalGds", AreaOrCountry: "China" } }] };

const nipaReq = (table: string, years: string, freq = "A") => ({ id: "t", dataset: "NIPA", table, frequency: freq, years,
  line_codes: [] as string[], geo: null });
const regionalReq = (geo: unknown, years = "2024") =>
  F.normalizeRequests({ requests: [{ id: "s", dataset: "Regional", table: "SAGDP9", line_code: 1, geo_fips: geo, years }] })[0];

function clearKeys(): void {
  for (const k of Object.keys(process.env)) if (k.endsWith("_API_KEY")) delete process.env[k];
}

function filesHolding(dir: string, text: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (fs.readFileSync(p, "latin1").includes(text)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

beforeAll(() => isolate());

describe("bea route and fetch (TestBeaCli)", () => {
  it("takes the bulk route without a key", async () => {
    clearKeys();
    const r = await fetchOk(newSession(), "bea", SPEC);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("bulk");
    expect(r.summary.source).toBe("bea");
  });

  it("fetches from the bulk files", async () => {
    clearKeys();
    const s = newSession();
    const r = await fetchOk(s, "bea", SPEC);
    expect(r.summary.route).toBe("bulk");
    const rows = csv(s, "bea", "bea_data");
    expect(Object.keys(rows[0]).slice(0, 4)).toEqual(["request_id", "dataset", "table", "line"]);
    const q = new Map(rows.map((x) => [`${x.request_id}|${x.time_period}`, x]));
    expect(q.get("pct|2025Q1")!.series_code).toBe("A191RL");
    expect(q.get("pct|2025Q1")!.value).toBe("0.1");
    const st = new Map(rows.filter((x) => x.request_id === "st").map((x) => [`${x.geo_fips}|${x.time_period}`, x]));
    expect(st.get("06000|2024")!.value).toBe("3312182.2");
    expect(st.get("06000|2024")!.unit).toBe("Millions of chained 2017 dollars");
    expect(st.get("06000|2024")!.unit_mult).toBe("6");
    const d = path.join(s.workspace, "data", "bea");
    for (const f of ["README.md", "notes.csv", "request.json"]) expect(fs.existsSync(path.join(d, f)), f).toBe(true);
    const req = JSON.parse(fs.readFileSync(path.join(d, "request.json"), "utf8"));
    expect(req.route).toBe("bulk");
    expect(req.source).toBe("bea");
    expect(r.citation.text).toContain("downloaded from BEA's public bulk files");
  });

  it("reuses existing data", async () => {
    clearKeys();
    const s = newSession();
    await fetchOk(s, "bea", SPEC);
    const r = await T.fetchData(s, { source: "bea", spec: SPEC });
    expect((r as any).summary.route).toBe("reuse_existing");
    const again = await T.fetchData(s, { source: "bea", spec: SPEC, force: true });
    expect((again as any).summary.route).toBe("bulk");
  });

  it("an API-only request without a key is key_missing with the setup command", async () => {
    clearKeys();
    const s = newSession();
    fixtures("bea");
    await prepare(s, "bea", ITA_SPEC);
    const f = await failure(T.fetchData(s, { source: "bea", spec: ITA_SPEC }));
    expect(f.code).toBe("key_missing");
    expect(f.fix).toContain("setup bea");
    expect(f.manual_bundle).toBeTruthy();
  });

  it("writes a manual bundle for an API-only request", async () => {
    clearKeys();
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: "bea", spec: ITA_SPEC }], reason: "key_missing" });
    for (const f of ["download_data.sh", "download_data.ps1", "INSTRUCTIONS.md", "spec.json"]) {
      expect(fs.existsSync(path.join(r.bundle, f)), f).toBe(true);
    }
    const text = fs.readFileSync(path.join(r.bundle, "INSTRUCTIONS.md"), "utf8");
    expect(text).toContain("bash ~/Downloads/download_data.sh");
    expect(text).toContain(String.raw`-File "$HOME\Downloads\download_data.ps1"`);
    expect(text.toLowerCase()).not.toContain("python");
    expect(r.user_commands.bash).toBe("bash ~/Downloads/download_data.sh");
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ source: "bea", filename: "ita.json", needs_key: true });
    expect(r.items[0].url).toBe("https://apps.bea.gov/api/data?UserID={API_KEY}&method=GetData&DataSetName=ITA&Indicator=BalGds&" +
      "AreaOrCountry=China&ResultFormat=JSON");
    // the bulk-covered requests get the public files, no key
    const b: any = await T.manualBundle(newSession(), { sources: [{ source: "bea", spec: SPEC }] });
    expect(b.items.map((i: any) => i.filename)).toEqual(["NipaDataQ.txt", "SeriesRegister.txt", "TablesRegister.txt", "SAGDP.zip"]);
    expect(b.items.every((i: any) => !i.needs_key)).toBe(true);
  });

  it("takes the API route with the documented example", async () => {
    clearKeys();
    await fakeKeys("bea", DOC_KEY);
    try {
      const s = newSession();
      const r = await fetchOk(s, "bea", API_SPEC);
      expect(r.status).toBe("ok");
      expect(r.summary.route).toBe("api");
      const rows = csv(s, "bea", "bea_data");
      expect(rows[0].series_code).toBe("DPCERC");
      expect(rows[0].value).toBe("12119763.0"); // "12,119,763" with the commas removed
      expect(rows[0].unit_mult).toBe("6");
      const d = path.join(s.workspace, "data", "bea");
      expect(filesHolding(d, DOC_KEY)).toEqual([]);
      expect(JSON.stringify(r)).not.toContain(DOC_KEY);
      expect(fs.readFileSync(path.join(d, "README.md"), "utf8")).toContain("not endorsed or certified");
      expect(fs.existsSync(path.join(d, "raw", "pce.json"))).toBe(true);
    } finally {
      clearKeys();
    }
  });

  it("falls back to the bulk files when BEA rejects the key and every request is in them", async () => {
    clearKeys();
    // a copy of the fixtures where the first metadata call answers with BEA's "invalid UserID" error
    const fx = fs.mkdtempSync(path.join(os.tmpdir(), "bea-fx-"));
    for (const f of fs.readdirSync(FX)) fs.copyFileSync(path.join(FX, f), path.join(fx, f));
    const idx = JSON.parse(fs.readFileSync(path.join(fx, "index.json"), "utf8"));
    idx["GET https://apps.bea.gov/api/data?method=GetParameterValues&ResultFormat=JSON&DataSetName=NIPA&ParameterName=TableName"] =
      { body: JSON.stringify({ BEAAPI: { Results: { Error: { APIErrorCode: "3", APIErrorDescription: "Invalid API UserId" } } } }) };
    fs.writeFileSync(path.join(fx, "index.json"), JSON.stringify(idx));
    await fakeKeys("bea", DOC_KEY);
    try {
      const s = newSession();
      await prepare(s, "bea", SPEC);
      process.env.DATA_ANALYST_FIXTURES = fx;
      const r: any = await T.fetchData(s, { source: "bea", spec: SPEC });
      expect(r.summary.route).toBe("bulk");
      expect(r.notes.join(" ")).toContain("does not work right now");
      expect(csv(s, "bea", "bea_data").length).toBe(10);
      // prefer "api" never falls back
      const f = await failure(T.fetchData(s, { source: "bea", spec: { ...SPEC, prefer: "api" }, force: true }));
      expect(f.code).toBe("key_rejected");
    } finally {
      clearKeys();
      fixtures("bea");
    }
  });

  it("notes spec keys a dataset does not use", async () => {
    clearKeys();
    const spec = { description: "x", requests: [{ ...SPEC.requests[0], geo_fips: "STATE", colour: "red" }] };
    const r: any = await fetchOk(newSession(), "bea", spec);
    expect(r.notes.some((n: string) => n.includes("request pct: colour, geo_fips not used for NIPA"))).toBe(true);
  });

  it("dataset rules are refused before any request (fix_spec)", async () => {
    clearKeys();
    const bad = { requests: [{ id: "x", dataset: "IntlServTrade", params: { TypeOfService: "Telecom,Travel", AreaOrCountry: "All" } }] };
    const s = newSession();
    fixtures("bea");
    await prepare(s, "bea", bad);
    let f = await failure(T.fetchData(s, { source: "bea", spec: bad }));
    expect(f.code).toBe("invalid_request");
    const mne = { requests: [{ id: "m", dataset: "MNE", params: { Year: "2023" } }] };
    await prepare(s, "bea", mne);
    f = await failure(T.fetchData(s, { source: "bea", spec: mne }));
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("DirectionOfInvestment");
  });

  it("lists datasets and their rules offline (--endpoints, --dataset-info)", async () => {
    clearKeys();
    const s = newSession();
    const brief: any = await T.sourceBrief(s, { source: "bea" });
    expect(brief.requests.map((r: any) => r.name)).toContain("ITA");
    const r: any = await T.requestSchema(s, { source: "bea", names: ["MNE"] });
    expect(r.schemas[0].name).toBe("MNE");
    expect(r.schemas[0].api_required_parameters).toEqual(["DirectionOfInvestment", "Classification", "Year"]);
  });

  it("ingests uploaded bulk files", async () => {
    clearKeys();
    const s = newSession();
    fixtures("bea");
    await prepare(s, "bea", SPEC);
    const up = path.join(s.workspace, "uploads");
    fs.mkdirSync(up);
    for (const [name, src] of Object.entries(FILES)) fs.copyFileSync(src, path.join(up, name));
    delete process.env.DATA_ANALYST_FIXTURES;
    try {
      const r: any = await T.ingest(s, { source: "bea", spec: SPEC, files: ["uploads"] });
      expect(r.status).toBe("ok");
      expect(r.summary.route).toBe("manual_download");
      const rows = csv(s, "bea", "bea_data");
      expect(rows.find((x) => x.request_id === "st" && x.geo_fips === "48000" && x.time_period === "2024")).toBeTruthy();
    } finally {
      fixtures("bea");
    }
  });

  it("ingests an uploaded API reply and removes the echoed key", async () => {
    clearKeys();
    const s = newSession();
    fixtures("bea");
    await prepare(s, "bea", API_SPEC);
    const up = path.join(s.workspace, "uploads");
    fs.mkdirSync(up);
    fs.copyFileSync(path.join(FX, "doc_nipa_getdata.json"), path.join(up, "pce.json"));
    const r: any = await T.ingest(s, { source: "bea", spec: API_SPEC, files: ["uploads"] });
    expect(r.summary.route).toBe("manual_download");
    expect(csv(s, "bea", "bea_data")[0].value).toBe("12119763.0");
    expect(r.notes.join(" ")).toContain("still held the user's key");
    expect(filesHolding(path.join(s.workspace, "data", "bea"), DOC_KEY)).toEqual([]);
    await prepare(s, "bea", ITA_SPEC);
    const missing = await failure(T.ingest(s, { source: "bea", spec: ITA_SPEC, files: ["uploads"] }));
    expect(missing.code).toBe("not_found");
    expect(missing.message).toContain("Expected ita.json");
  });

  it("searches NIPA titles and lists a table's lines without a key", async () => {
    clearKeys();
    fixtures("bea");
    const s = newSession();
    const r: any = await T.requestSchema(s, { source: "bea", search: "real gross domestic product" });
    expect(r.results.filter((h: any) => h.dataset === "NIPA").map((h: any) => h.table)).toEqual(["T10101", "T10106"]);
    const lines: any = await T.requestSchema(s, { source: "bea", search: "lines T10106" });
    expect(lines.results[0]).toMatchObject({ line: 1, series_code: "A191RX" });
  });
});

describe("bea client and parser units (TestBeaUnits)", () => {
  it("special values go to flag", () => {
    const q = { id: "r", dataset: "Regional", table: "CAINC5N", frequency: "", geo: "COUNTY" };
    const rows = F.tidyApiRows(q, { LineCode: "10" }, [
      { Code: "CAINC5N-10", GeoFips: "01001", GeoName: "Autauga, AL", TimePeriod: "2024", DataValue: "(D)",
        CL_UNIT: "Thousands of dollars", UNIT_MULT: "3" },
      { Code: "CAINC5N-10", GeoFips: "01003", GeoName: "Baldwin, AL *", TimePeriod: "2024", DataValue: "(NA)" },
      { Code: "CAINC5N-10", GeoFips: "01005", GeoName: "Barbour, AL", TimePeriod: "2024", DataValue: "(NM)" },
      { Code: "CAINC5N-10", GeoFips: "01007", GeoName: "Bibb, AL", TimePeriod: "2024", DataValue: "1,337" }]);
    expect(rows.map((r) => [r.value, r.flag])).toEqual([["", "(D)"], ["", "(NA)"], ["", "(NM)"], ["1337.0", ""]]);
    expect(rows[1].geo_name).toBe("Baldwin, AL");
  });

  it("error shapes and auth codes", () => {
    const e = A.firstError({ BEAAPI: { Results: [{ Error: { APIErrorCode: "40", APIErrorDescription: "x",
      ErrorDetail: [{ Description: "bad" }] } }] } });
    expect(A.errorDetail(e!)).toBe("x (bad)");
    expect(A.isAuthError("4", "This UserId is not active.")).toBe(true);
    expect(A.isAuthError("40", "missing parameters")).toBe(false);
  });

  it("dataset problems", () => {
    expect(A.datasetProblems("ITA", { Indicator: "BalGds", AreaOrCountry: "China" })).toEqual([]);
    expect(A.datasetProblems("ITA", { Indicator: "BalGds,BalServ", AreaOrCountry: "All" }).length).toBeGreaterThan(0);
    expect(A.datasetProblems("UnderlyingGDPbyIndustry", { TableID: "210", Frequency: "Q", Year: "2024", Industry: "ALL" }).length)
      .toBeGreaterThan(0);
    expect(A.datasetProblems("Nope", {}).length).toBeGreaterThan(0);
  });

  it("the byte budget waits", async () => {
    await fakeKeys("bea", DOC_KEY);
    try {
      const c = new A.BeaClient({ useCache: false });
      const now = performance.now() / 1000;
      c.bytes = [[now - 59.6, 60_000_000], [now - 1, 30_000_000]];
      const slept: number[] = [];
      c.sleeper = async (ms) => {
        slept.push(ms / 1000);
        c.bytes.shift();
      };
      await c.waitForBytes();
      expect(slept.length).toBeGreaterThan(0);
      expect(slept[0]).toBeLessThan(2);
    } finally {
      clearKeys();
    }
  });

  it("verifies a key with one GetDataSetList call", async () => {
    fixtures("bea");
    const [ok, detail] = await A.verify(DOC_KEY);
    expect(ok, detail).toBe(true);
    expect(detail).not.toContain(DOC_KEY);
  });

  it("the bulk cache follows DATA_ANALYST_CACHE", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bea-cache-"));
    process.env.DATA_ANALYST_CACHE = d;
    try {
      expect(path.normalize(F.cacheDir())).toBe(path.join(d, "bea", "bulk"));
    } finally {
      delete process.env.DATA_ANALYST_CACHE;
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("bea regressions (TestRegressions)", () => {
  it("s00 names requested years that are missing", () => {
    const reqs = [{ id: "inc", years: "2016,2017,2018" }, { id: "all", years: "X" }, { id: "gone", years: "2016" }];
    const rows = [{ request_id: "inc", year: 2016 }, { request_id: "inc", year: 2017 }, { request_id: "all", year: 2010 }];
    expect(F.missingYears(reqs, rows)).toEqual({ inc: [2018] });
  });

  it("s01 the NIPA bulk route keeps every line", async () => {
    const [rows] = await F.nipaFromFlat(nipaReq("T10205", "2023"), FX, {}, FILES);
    const lines = new Set(rows.map((r) => parseInt(r.line, 10)));
    const max = Math.max(...lines);
    expect(lines.has(3) && lines.has(6)).toBe(true);
    expect([...lines].sort((a, b) => a - b)).toEqual(Array.from({ length: max }, (_, i) => i + 1));
  });

  it("s02 the NIPA bulk route raises on empty", async () => {
    await expect(F.nipaFromFlat(nipaReq("T10101", "1900,1901"), FX, {}, FILES)).rejects.toBeInstanceOf(A.BeaError);
  });

  it("s02b the NIPA bulk route refuses monthly for a table not published monthly", async () => {
    await expect(F.nipaFromFlat(nipaReq("T10106", "2024", "M"), FX, {}, FILES)).rejects.toThrow(/not monthly/);
    expect(F.MONTHLY_TITLE.test("Table 2.6. Personal Income and Its Disposition, Monthly")).toBe(true);
    expect(F.MONTHLY_TITLE.test("Table 2.8.11. ... Percent Change from Month One Year Ago")).toBe(true);
    expect(F.MONTHLY_TITLE.test("Table 2.3.11. ... Percent Change from Quarter One Year Ago")).toBe(false);
  });

  it("s03 NIPA line_code filters", () => {
    const q = F.normalizeRequests({ requests: [{ id: "g", dataset: "NIPA", table: "T10106", line_code: 1, frequency: "A",
      years: "2024-2025" }] })[0];
    expect(q.line_codes).toEqual(["1"]);
    const rows = [1, 2].flatMap((ln) => [2024, 2025].map((y) => ({ request_id: "g", line: String(ln), year: y })));
    expect(new Set(F.finalizeRows([q], rows).map((r) => r.line))).toEqual(new Set(["1"]));
    q.line_codes = ["999"];
    expect(() => F.finalizeRows([q], rows)).toThrow(A.BeaError);
  });

  it("s04 the fingerprint is unchanged without line filters (and matches Python's)", () => {
    const reqs = F.normalizeRequests({ requests: [{ id: "a", dataset: "NIPA", table: "T10101", frequency: "Q", years: "2024" }] });
    expect(F.fingerprint(reqs)).toBe("ba233440e1769dcc");
    const two = F.normalizeRequests({ requests: [
      { id: "g", dataset: "NIPA", table: "T10106", line_code: 1, frequency: "A", years: "2024-2025" },
      { id: "s", dataset: "Regional", table: "SAGDP9", line_code: [1, 2], geo_fips: ["6", "6037"], years: "LAST5" }] });
    expect(F.fingerprint(two)).toBe("4fc90ac27f94fb4b");
    expect(two[1].calls).toEqual([{ TableName: "SAGDP9", GeoFips: "06000,06037", Year: "LAST5", LineCode: "1" },
      { TableName: "SAGDP9", GeoFips: "06000,06037", Year: "LAST5", LineCode: "2" }]);
  });

  it("s05 LASTn is not sent to NIPA", () => {
    const q = F.normalizeRequests({ requests: [{ id: "n", dataset: "NIPA", table: "T10101", years: "LAST2" }] })[0];
    expect(q.calls[0].Year).toBe("X");
    expect(q.years).toBe("LAST2");
    const rows = [2022, 2023, 2024].map((y) => ({ request_id: "n", line: "1", year: y }));
    expect(new Set(F.finalizeRows([q], rows).map((r) => r.year))).toEqual(new Set([2023, 2024]));
  });

  it("s06 two-digit state FIPS are padded", async () => {
    const q = regionalReq(["06", "48000"]);
    expect(q.geo).toBe("06000,48000");
    expect(q.calls[0].GeoFips).toBe("06000,48000");
    const [rows] = await F.regionalFromZip(q, FX, {}, FILES);
    expect(new Set(rows.map((r) => r.geo_fips))).toEqual(new Set(["06000", "48000"]));
  });

  it("s07 the bulk route refuses geographies it cannot select", async () => {
    expect(F.bulkCoverage(regionalReq("TERR"))[0]).toBe(false);
    expect(F.bulkCoverage(regionalReq("NY"))[0]).toBe(false); // postal code = counties: not in SA tables
    expect(F.bulkGeoOk("NY", "CAINC1")).toBe(true);
    await expect(F.regionalFromZip(regionalReq("TERR"), FX, {}, FILES)).rejects.toBeInstanceOf(A.BeaError);
  });

  it("s08 Regional notes carry the footnotes", async () => {
    const [, notes] = await F.regionalFromZip(regionalReq("STATE"), FX, {}, FILES);
    const refs = new Set(notes.map((n) => n.note_ref));
    for (const r of ["1", "(D)", "(NA)"]) expect(refs.has(r), r).toBe(true);
    expect(notes.some((n) => n.note_text.includes("included footnote file"))).toBe(false);
    expect(notes.some((n) => n.note_text.includes("chained 2017 dollars"))).toBe(true);
  });

  it("s09 GDPbyIndustry API periods", () => {
    const rows = F.tidyApiRows({ id: "g", dataset: "GDPbyIndustry", table: "1", frequency: "", geo: null }, {},
      [{ Year: "2024", Quarter: "2024", DataValue: "1" }, { Year: "2024", Quarter: "II", DataValue: "2" }]);
    expect(rows.map((r) => [r.time_period, r.year, r.frequency])).toEqual([["2024", 2024, "A"], ["2024Q2", 2024, "Q"]]);
  });

  it("s10 geo_level classifies codes", () => {
    expect(F.geoLevel("06037", "06037,06059")).toBe("county");
    expect(F.geoLevel("06000", "06000,48000")).toBe("state");
    expect(F.geoLevel("31080", "MSA")).toBe("msa");
  });

  it("s11 workbook unit text", () => {
    expect(F.workbookUnit("[Millions of dollars] Seasonally adjusted at annual rates"))
      .toBe("Millions of dollars; seasonally adjusted at annual rates");
    expect(F.workbookUnit("[2017=100]")).toBe("2017=100");
  });

  it("s12d industry section units and plain NIPA units", () => {
    expect(F.sectionUnit("Percent and percentage points", "Percent change")).toBe("Percent");
    expect(F.sectionUnit("Percent and percentage points", "Percentage points")).toBe("Percentage points");
    expect(F.sectionUnit("Millions of dollars", "Addenda")).toBe("Millions of dollars");
    expect(F.plainUnit("Level", "Quantity Contributions", "0"))
      .toBe("percentage points (contribution to the percent change; quarterly at an annual rate)");
    expect(F.plainUnit("Level", "Ratio", "0")).toContain("dollars per person");
    expect(F.plainUnit("Level", "Chained Dollars", "6"))
      .toBe("millions of chained dollars (reference year in the table title); quarterly and monthly values at annual rates");
    expect(F.plainUnit("Level change", "Current Dollars", "9"))
      .toBe("change in billions of current dollars; quarterly and monthly values at annual rates");
  });

  it("s12c GUID redaction spares paths", () => {
    const p = String.raw`C:\tmp\f2b4c907-70d5-4426-8f30-5c3698def66e\scratchpad\bea_data.csv`;
    expect(A.redact(p)).toBe(p);
    expect(A.redact("/tmp/f2b4c907-70d5-4426-8f30-5c3698def66e/x")).toBe("/tmp/f2b4c907-70d5-4426-8f30-5c3698def66e/x");
    expect(A.redact("my key 12345678-ABCD-1234-ABCD-1234567890AB")).not.toContain("12345678-ABCD");
  });

  it("s18 key redaction (the pack never lets one out)", () => {
    const key = "1A2B3C4D-1A2B-1A2B-1A2B-1A2B3C4D5E6F";
    for (const s of [`{"env": {"BEA_API_KEY": "${key}"}}`, `{"ParameterName": "USERID", "ParameterValue": "${key}"}`,
      `https://apps.bea.gov/api/data?UserID=${key}&method=GetData`]) {
      expect(A.redact(s), s).not.toContain(key);
    }
    const scrubbed = A.scrubResponse({ BEAAPI: { Request: { RequestParam: [{ ParameterName: "USERID", ParameterValue: "not-a-guid-key" }] } } });
    expect(scrubbed.BEAAPI.Request.RequestParam[0].ParameterValue).toBe("[REDACTED]");
  });

  it("builds the API URLs of the download bundle as Python does", () => {
    expect(F.apiUrl("ITA", { Indicator: "BalGds", AreaOrCountry: "China", Year: "2023,2024", X: "a/b c" }, "{API_KEY}"))
      .toBe("https://apps.bea.gov/api/data?UserID={API_KEY}&method=GetData&DataSetName=ITA&Indicator=BalGds&AreaOrCountry=China" +
        "&Year=2023,2024&X=a%2Fb%20c&ResultFormat=JSON");
  });
});
