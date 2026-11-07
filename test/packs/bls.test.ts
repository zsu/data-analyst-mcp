/** bls: ported from tests/sources/bls/test_bls.py (same fixtures and values).
 *
 * Fixtures (test/packs/bls/fixtures) were recorded from live, keyless BLS API v1 responses on 2026-10-20:
 * v1_cpi_2017_2026.json, v1_jobs_2017_2026.json, v1_build_md.json (LAUS state and county, state CES, OEWS national and
 * state, U-6 and LNS13023621), and the data.bls.gov series page describe_CUUR0000SA0.html. No BLS key was available,
 * so the keyed paths are tested by their pure parts (plans, manual items, redaction) instead of invented responses. */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as keys from "../../src/core/keys.js";
import { load } from "../../src/core/packs.js";
import { readCsv } from "../../src/core/tabular.js";
import pack from "../../src/deep/bls.js";
import { BlsClient, BlsError, describePage, planQueries } from "../../src/deep/_bls_api.js";
import * as ids from "../../src/deep/_bls_ids.js";
import * as L from "../../src/deep/_bls_lib.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const CPI = { description: "CPI-U all items, U.S. city average, 2017-2026",
  series: [{ id: "CUUR0000SA0", label: "CPI-U all items (NSA)" }], start_year: 2017, end_year: 2026 };
const JOBS = { description: "Unemployment rate and nonfarm payrolls, 2017-2026",
  series: [{ id: "LNS14000000", label: "Unemployment rate" }, { id: "CES0000000001", label: "Total nonfarm payrolls" }],
  start_year: 2017, end_year: 2026 };
const BUILD = { description: "Builder verification: LAUS state and county, CES state, OEWS national and state, " +
  "U-6 vs the job-losers level",
  series: ["LNS13327709", "LNS13023621"],
  build: [{ kind: "state", state: "MD" }, { kind: "laus", county: "24005" },
    { kind: "oews", occupation: "15-1252", measure: "annual_median_wage" },
    { kind: "oews", occupation: "15-1252", measure: "annual_median_wage", state: "MD" }],
  start_year: 2025, end_year: 2026 };

const pick = (rows: Record<string, string>[], sid: string, year: number, period: string) =>
  rows.find((r) => r.series_id === sid && r.year === String(year) && r.period === period)!;

beforeAll(() => isolate());

describe("bls", () => {
  it("checks specs and names the operations", async () => {
    const p = await load("bls");
    expect(pack.checkSpec!(CPI, p)).toEqual([]);
    expect(T.usedRequests(p, CPI)).toEqual(["series"]);
    expect(T.usedRequests(p, BUILD)).toEqual(["series", "build"]);
    expect(pack.checkSpec!({ series: ["not-an-id"], start_year: 2020, end_year: 2021 }, p)[0]).toContain("not BLS series IDs");
    expect(pack.checkSpec!({ series: ["LNS14000000"], start_year: 2022, end_year: 2021 }, p)[0]).toContain("after end_year");
    expect(pack.checkSpec!({ series: [] }, p)[0]).toContain("has no series");
    expect(pack.checkSpec!({ series: ["LNS14000000", "lns14000000"] }, p)[0]).toContain("duplicate series");
  });

  it("plans one query either way for the CPI spec, and needs a key for a large request", async () => {
    const sp = L.normSpec(CPI);
    expect(planQueries(sp.series.map((x) => x.id), 2017, 2026, "v1").length).toBe(1);
    expect(planQueries(sp.series.map((x) => x.id), 2017, 2026, "v2").length).toBe(1);
    const big = { series: Array.from({ length: 200 }, (_, i) => `CES${String(i).padStart(10, "0")}`), start_year: 1990, end_year: 2026 };
    const s = newSession();
    fixtures("bls");
    await prepare(s, "bls", big);
    const f = await failure(T.fetchData(s, { source: "bls", spec: big }));
    expect(f.code).toBe("key_missing");
    expect(f.manual_bundle).toBeTruthy();
    const items = pack.manualItems!(big, null as any);
    expect(items[0].needs_key).toBe(true);                         // more than 25 keyless queries: v2
    expect(items[0].url).toBe("https://api.bls.gov/publicAPI/v2/timeseries/data/");
    expect(items[0].body.registrationkey).toBeUndefined();         // the script adds the key on the user's computer
    const b: any = await T.manualBundle(s, { sources: [{ source: "bls", spec: big }] });
    const sh = fs.readFileSync(b.download_scripts.bash, "ascii");
    expect(sh).toContain("api.bls.gov");
    expect(sh).not.toMatch(/x{40}/);
  });

  it("fetches the CPI", async () => {
    const s = newSession();
    const r = await fetchOk(s, "bls", CPI);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api_keyless");
    const rows = csv(s, "bls", "bls_series");
    expect(Object.keys(rows[0]).slice(0, 8)).toEqual(["series_id", "label", "year", "period", "period_name", "freq", "date", "value"]);
    expect(pick(rows, "CUUR0000SA0", 2026, "M09").value).toBe("336.94");
    const gap = pick(rows, "CUUR0000SA0", 2025, "M10");
    expect(gap.value).toBe("");
    expect(gap.value_raw).toBe("-");
    expect(gap.footnotes).toContain("lapse in appropriations");
    const meta = csv(s, "bls", "series")[0];
    expect(meta.title.startsWith("All items in U.S. city average")).toBe(true);
    expect(meta.title_source).toBe("data.bls.gov");
    expect(meta.n_missing).toBe("1");
    const d = path.join(s.workspace, "data", "bls");
    expect(fs.readFileSync(path.join(d, "README.md"), "utf8")).toContain("cannot vouch for the data");
    const req = JSON.parse(fs.readFileSync(path.join(d, "request.json"), "utf8"));
    expect([req.route, req.api_version, req.source]).toEqual(["api_keyless", "v1", "bls"]);
    expect(req.requests.some((q: any) => q.url.startsWith("https://api.bls.gov/publicAPI/v1/"))).toBe(true);
    expect(fs.existsSync(path.join(d, "raw", "response_01.json"))).toBe(true);
    expect(fs.existsSync(path.join(s.workspace, "data", "bls_series.csv"))).toBe(false);
    expect(r.citation.text).toContain("CUUR0000SA0");
    expect(r.notes.some((n: string) => n.includes("free key"))).toBe(true);
  });

  it("flags preliminary values", async () => {
    const s = newSession();
    await fetchOk(s, "bls", JOBS);
    const rows = csv(s, "bls", "bls_series");
    expect(pick(rows, "CES0000000001", 2026, "M09").value).toBe("159044.0");
    expect(pick(rows, "CES0000000001", 2026, "M09").preliminary).toBe("1");
    expect(pick(rows, "CES0000000001", 2026, "M08").preliminary).toBe("1");
    expect(pick(rows, "CES0000000001", 2026, "M07").preliminary).toBe("0");
    expect(pick(rows, "LNS14000000", 2026, "M09").value).toBe("4.2");
    expect(pick(rows, "LNS14000000", 2025, "M10").value).toBe("");
  });

  it("fetches built IDs", async () => {
    const s = newSession();
    const r = await fetchOk(s, "bls", BUILD);
    expect(r.status).toBe("ok");
    const rows = csv(s, "bls", "bls_series");
    expect(pick(rows, "LASST240000000000003", 2026, "M09").value).toBe("3.9");
    expect(pick(rows, "LNS13327709", 2026, "M09").value).toBe("7.6");      // U-6
    expect(pick(rows, "LNS13023621", 2026, "M09").value).toBe("3200.0");   // job losers, thousands
    expect(pick(rows, "OEUN000000000000015125213", 2025, "A01").value).toBe("135980.0");
    expect(pick(rows, "OEUS240000000000015125213", 2025, "A01").freq).toBe("A");
    expect(rows.some((x) => x.series_id === "SMS24000000000000001")).toBe(true);
    expect(rows.some((x) => x.series_id === "LAUCN240050000000003")).toBe(true);
    const labels = Object.fromEntries(csv(s, "bls", "series").map((m) => [m.series_id, m.label]));
    expect(labels.LASST240000000000003).toBe("Maryland unemployment rate (seasonally adjusted)");
  });

  it("reuses existing data", async () => {
    const s = newSession();
    await fetchOk(s, "bls", CPI);
    const r: any = await T.fetchData(s, { source: "bls", spec: CPI });
    expect(r.summary.route).toBe("reuse_existing");
    expect((await T.fetchData(s, { source: "bls", spec: CPI, force: true }) as any).summary.route).toBe("api_keyless");
  });

  it("manual bundle and ingest", async () => {
    const s = newSession();
    await fetchOk(s, "bls", CPI);
    const items = pack.manualItems!(CPI, null as any);
    expect(items.map((i: any) => i.filename)).toEqual(["response_01.json"]);
    expect([items[0].method, items[0].needs_key]).toEqual(["POST", false]);
    expect(items[0].body).toEqual({ seriesid: ["CUUR0000SA0"], startyear: "2017", endyear: "2026" });
    const b: any = await T.manualBundle(s, { sources: [{ source: "bls", spec: CPI }] });
    for (const f of ["INSTRUCTIONS.md", "spec.json", "download_data.sh", "download_data.ps1"]) {
      expect(fs.existsSync(path.join(b.bundle, f)), f).toBe(true);
    }
    const text = fs.readFileSync(b.instructions, "utf8");
    expect(text).toContain("bash ~/Downloads/download_data.sh");
    expect(text.toLowerCase()).not.toContain("python");
    expect(fs.readFileSync(b.download_scripts.bash, "ascii")).toContain("CUUR0000SA0");
    // ingest our own raw/ responses into a second session: the same rows
    const raw = path.join(s.workspace, "data", "bls", "raw");
    const s2 = newSession();
    fixtures("bls");
    await prepare(s2, "bls", CPI);
    const r: any = await T.ingest(s2, { source: "bls", spec: CPI, files: [raw] });
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("manual_download");
    expect(csv(s2, "bls", "bls_series")).toEqual(csv(s, "bls", "bls_series"));
  });

  it("ingest maps a bare response_NN.json to its request (the download script's file)", async () => {
    const s = newSession();
    await fetchOk(s, "bls", CPI);
    const wrapped = JSON.parse(fs.readFileSync(path.join(s.workspace, "data", "bls", "raw", "response_01.json"), "utf8"));
    const up = path.join(s.workspace, "up");
    fs.mkdirSync(up);
    fs.writeFileSync(path.join(up, "response_01.json"), JSON.stringify(wrapped.response));
    const s2 = newSession();
    fixtures("bls");
    await prepare(s2, "bls", CPI);
    const r: any = await T.ingest(s2, { source: "bls", spec: CPI, files: [up] });
    expect(r.status).toBe("ok");                 // covered years known from the plan: no problems
    // a spec for more years than the upload covers is partial
    const more = { ...CPI, start_year: 2005 };
    await prepare(s2, "bls", more);
    expect((await T.ingest(s2, { source: "bls", spec: more, files: [up] }) as any).status).toBe("partial");
    // a reply under another name cannot say which request it answers (as Python's curl fallback): a note, no problem
    fs.renameSync(path.join(up, "response_01.json"), path.join(up, "reply.json"));
    const q: any = await T.ingest(s2, { source: "bls", spec: more, files: [up] });
    expect(q.status).toBe("ok");
    expect(q.notes.some((n: string) => n.includes("do not say which request"))).toBe(true);
  });

  it("restricted network: agency_unavailable with the manual bundle", async () => {
    const s = newSession();
    fixtures("bls");
    await prepare(s, "bls", CPI);
    delete process.env.DATA_ANALYST_FIXTURES;
    process.env.DATA_ACCESS_FORCE = "restricted";
    try {
      const f = await failure(T.fetchData(s, { source: "bls", spec: CPI }));
      expect(f.code).toBe("agency_unavailable");
      expect(f.manual_bundle).toBeTruthy();
    } finally {
      delete process.env.DATA_ACCESS_FORCE;
    }
  });

  it("builds, searches and decodes", async () => {
    expect(ids.build("laus", { county: "24005", measure: "labor_force" })[0].id).toBe("LAUCN240050000000006");
    expect(ids.build("oews", { occupation: "29-1141", measure: "hourly_mean_wage" })[0].id).toBe("OEUN000000000000029114103");
    expect(ids.build("ces_state", { state: "California", seasonal: "U" })[0].id).toBe("SMU06000000000000001");
    const all = ids.build("jolts", { industry: "all", measure: "quits" }).map((x) => x.id);
    expect([all.length, all[2], all[all.length - 1]]).toEqual([28, "JTS110099000000000QUR", "JTS929000000000000QUR"]);
    expect(ids.build("jolts", { industry: "Retail trade", measure: "hires", seasonal: "U" })[0].id).toBe("JTU440000000000000HIR");
    expect(() => ids.build("jolts", { industry: "999999" })).toThrow(ids.SpecError);
    expect(() => ids.build("laus", { state: "Atlantis" })).toThrow(/unknown state 'Atlantis'/);
    const r: any = await T.requestSchema(newSession(), { source: "bls", search: "u-6" });
    expect(r.results[0].id).toBe("LNS13327709");
    for (const [q, sid] of [["import prices", "EIUIR"], ["education unemployment", "LNS14027659"], ["union membership", "LUU0204899600"]]) {
      const x: any = await T.requestSchema(newSession(), { source: "bls", search: q });
      expect(x.results.map((h: any) => h.id), q).toContain(sid);
    }
    const dec: any = await T.requestSchema(newSession(), { source: "bls", search: "decode CUUR0000SA0" });
    expect(dec.results[0].seasonal).toBe("not seasonally adjusted");
    const built: any = await T.requestSchema(newSession(), { source: "bls", search: 'build {"kind": "laus", "state": "MD"}' });
    expect(built.results[0].id).toBe("LASST240000000000003");
  });

  it("describes a series from data.bls.gov", async () => {
    fixtures("bls");
    const r: any = await T.requestSchema(newSession(), { source: "bls", search: "CUUR0000SA0" });
    expect(r.results[0].title).toContain("All items in U.S. city average");
    expect(r.results[0].survey).toContain("CPI-U");
  });

  it("decodes OEWS IDs without a catalog page", () => {
    // data.bls.gov pages for OEWS IDs carry no catalog table [live 2026-10-21]
    const page = "<html><body><h1>Databases, Tables &amp; Calculators</h1></body></html>";
    const oe = describePage("OEUS060000000000029114113", "u", page);
    const other = describePage("LNS14000000", "u", page);
    expect(oe.error).toBeUndefined();
    expect([oe.fields["Occupation code (SOC)"], oe.fields["Data type"]]).toEqual(["29-1141", "annual median wage"]);
    expect(oe.note).toContain("not verified");
    expect(other.error).toBeTruthy();       // any other survey without a catalog is still "not found"
  });

  it("points FRED metro CPI IDs to BLS codes", () => {
    const page = "<html><body>ERROR: Invalid Series ID: CUURA210SA0</body></html>"; // [live 2026-10-22]
    const fred = describePage("CUURA210SA0", "u", page);
    const other = describePage("CUUR0000SEHA", "u", page);
    expect(fred.error).toContain("cu.area");
    expect(fred.error).toContain("A210");
    expect(other.error).not.toContain("cu.area");
  });

  it("a busy site is an outage", async () => {
    // BLS answers 503 "The BLS website is busy" (an HTML page) [live 2026-10-22]: an outage, not a spec error
    const c = new BlsClient({ useKey: false });
    const { DataError } = await import("../../src/core/http.js");
    (c.http as any).request = async () => {
      throw new DataError("bls: HTTP 503: <html>The BLS website is busy</html>", "http", 503);
    };
    const e = await c.post({ seriesid: ["LNS14000000"] }).catch((x) => x);
    expect(e).toBeInstanceOf(BlsError);
    expect(e.blsKind).toBe("unavailable");
    expect(e.message).not.toContain("<html>");
  });

  it("redacts an echoed 32-hex key", () => {
    const other = "fedcba9876543210fedcba9876543210"; // not a known key: caught by the pattern
    const msg = keys.withPackScope("bls", () => keys.redact(`The key: ${other} provided by the User is invalid. sha ${"ab".repeat(32)}`));
    // outside bls calls the pattern does not apply: another pack's 32-hex series hash stays as published
    expect(keys.redact(`series=${other}`)).toBe(`series=${other}`);
    expect(msg).not.toContain(other);
    expect(msg).toContain("ab".repeat(32)); // a 64-hex digest is left alone
  });

  it("catalog youth IDs", () => {
    // LNS14000036 is the 20-24 rate (data.bls.gov title, checked 2026-10-21); 16-24 is LNS14024887
    const cat = Object.fromEntries(ids.D().catalog.map(([sid, label]) => [sid, label]));
    expect(cat.LNS14024887).toContain("16 to 24");
    expect(cat.LNS14000036).toContain("20 to 24");
  });

  it("absent periods and period dates", () => {
    expect(L.periodInfo(2026, "M13")).toEqual(["A", "2026-07-01"]);
    expect(L.periodInfo(2026, "Q03")).toEqual(["Q", "2026-07-01"]);
    expect(L.periodInfo(2026, "S02")).toEqual(["S", "2026-07-01"]);
    const sub: any[] = [{ year: 2025, period: "M10", freq: "M" }, { year: 2026, period: "M01", freq: "M" }];
    expect(L.absentPeriods(sub)).toEqual(["2025 M11", "2025 M12"]);
    expect(readCsv("a,b\r\n1,2\r\n")[0]).toEqual({ a: "1", b: "2" });
  });
});
