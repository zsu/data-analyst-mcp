/** fred (deep pack): ported from tests/sources/fred/test_fred.py (same fixtures and values). Fixtures recorded live
 * on 2026-10-20 (the FULL spec's API requests re-recorded on 2026-10-22): graph_* / alfred_* from the keyless route;
 * api_* / geofred_* / v2_* from the API with a real key (not in the recorded URLs or bodies). Keyed tests set
 * FRED_API_KEY to a made-up value: fixture URLs carry no key, so it never matters and is never sent anywhere. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { zipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as keys from "../../src/core/keys.js";
import { load } from "../../src/core/packs.js";
import * as pol from "../../src/core/policy.js";
import * as api from "../../src/deep/_fred_api.js";
import * as F from "../../src/deep/_fred_pack.js";
import fred from "../../src/deep/fred.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FAKE = "abcdefghijklmnopqrstuvwxyz012345"; // made up; fixtures answer without any key
const FIX = path.join(TEST_DIR, "packs", "fred", "fixtures");
const PIPE = { description: "Output gap since 2019",
  series: [{ id: "GDPC1", label: "Real GDP", source: "U.S. Bureau of Economic Analysis", copyright: "public_domain",
    copyright_basis: "series page tag Public Domain: Citation Requested, read 2026-10-20" },
  { id: "GDPPOT", label: "Real potential GDP (CBO)", source: "U.S. Congressional Budget Office", copyright: "public_domain",
    copyright_basis: "series page tag, read 2026-10-20" },
  { id: "USREC", label: "NBER recession indicator", source: "Federal Reserve Bank of St. Louis", copyright: "citation_required",
    copyright_basis: "series page tag Copyrighted: Citation Required, read 2026-10-20" }],
  start: "2007-01-01" };
const FULL = { description: "API coverage: latest, first release, as-of vintages, GeoFRED, release calendar and release " +
  "observations",
  series: [{ id: "GDPC1", label: "Real GDP", start: "2024-01-01", end: "2025-12-31" },
    { id: "GDPC1", label: "Real GDP, first release", start: "2020-04-01", end: "2020-04-01", vintage: "first_release" },
    { id: "GDPC1", label: "Real GDP, as of", start: "2020-04-01", end: "2020-07-01",
      vintage: { as_of: ["2020-08-27", "2021-07-29"] } }],
  regional: [{ series_id: "CAUR", region_type: "state", date: "2025-01-01", label: "State unemployment rates" }],
  release_dates: { release_id: 50, start: "2026-10-01", end: "2026-12-31", limit: 5 },
  release_observations: [{ release_id: 53, limit: 5, max_pages: 2 }] };
const ASOF = { description: "Keyless as-of vintages",
  series: [{ id: "GDPC1", start: "2020-04-01", end: "2020-07-01", vintage: { as_of: ["2020-08-27", "2021-07-29"] } }] };

const fixture = (name: string) => fs.readFileSync(path.join(FIX, name));
const dir = (s: { workspace: string }) => path.join(s.workspace, "data", "fred");
const read = (s: { workspace: string }, f: string) => fs.readFileSync(path.join(dir(s), f), "utf8");
const withKey = () => (process.env.FRED_API_KEY = FAKE);

beforeAll(() => isolate());
afterEach(() => {
  delete process.env.FRED_API_KEY;
  delete process.env.DATA_ACCESS_FORCE;
  fixtures("fred");
});

describe("fred routes and fetch", () => {
  it("keyless: the graph downloads, with titles from the XLSX (test_01, test_05)", async () => {
    const s = newSession();
    const r = await fetchOk(s, "fred", PIPE);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api_keyless");
    const rows = csv(s, "fred", "fred_observations");
    expect(Object.keys(rows[0])).toEqual(["series_id", "label", "variant", "vintage", "date", "value", "realtime_start",
      "realtime_end"]);
    expect(rows.find((x) => x.series_id === "GDPC1" && x.date === "2020-04-01")!.value).toBe("19077.992");
    const meta = Object.fromEntries(csv(s, "fred", "series").map((m) => [m.series_id, m]));
    expect(meta.USREC.copyright).toBe("citation_required");
    expect(meta.GDPC1.metadata_source).toBe("fredgraph.xlsx");
    expect(meta.GDPC1.title).toBe("Real Gross Domestic Product");
    expect(Number(meta.GDPPOT.n_future)).toBeGreaterThan(0); // CBO projections flagged
    expect(read(s, "README.md")).toContain("downloaded without the API");
    const req = JSON.parse(read(s, "request.json"));
    expect([req.source, req.route, req.keyless]).toEqual(["fred", "api_keyless", true]);
    expect(r.notes.join(" ")).toContain("keyless graph downloads");
  });

  it("with a key: the API route, and the key never shows (test_02)", async () => {
    withKey();
    const s = newSession();
    const r = await fetchOk(s, "fred", { description: "x", series: [{ id: "GDPC1", start: "2024-01-01", end: "2025-12-31" }] });
    expect(r.summary.route).toBe("api");
    expect(JSON.stringify(r)).not.toContain(FAKE);
  });

  /** A copy of the fixtures where FRED's series call for GDPC1 answers as given. */
  const brokenApi = (hit: any) => {
    const fx = fs.mkdtempSync(path.join(os.tmpdir(), "fred-fx-"));
    for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(fx, f));
    const idx = JSON.parse(fs.readFileSync(path.join(fx, "index.json"), "utf8"));
    idx["GET https://api.stlouisfed.org/fred/series?series_id=GDPC1&file_type=json"] = hit;
    fs.writeFileSync(path.join(fx, "index.json"), JSON.stringify(idx));
    return fx;
  };
  const REJECTED = { file: "api_key_rejected.json", status: 400 }; // FRED's documented answer to an unknown key
  const fetchWith = async (fx: string, spec: any) => {
    withKey();
    const s = newSession();
    await prepare(s, "fred", spec);
    process.env.DATA_ANALYST_FIXTURES = fx;
    return { s, r: T.fetchData(s, { source: "fred", spec }) };
  };

  it("a rejected key falls back to the keyless graph downloads when nothing key-only is asked", async () => {
    const { s, r: p } = await fetchWith(brokenApi(REJECTED), PIPE);
    const r: any = await p;
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api_keyless");
    const notes = r.notes.join(" ");
    expect(notes).toContain("FRED rejected the stored key");
    expect(notes).toContain("is not registered");
    expect(notes).toContain("downloaded without the key (keyless graph downloads)");
    expect(notes).toContain("No working FRED API key");
    expect(notes).not.toContain("A free key");
    const req = JSON.parse(read(s, "request.json"));
    expect([req.route, req.keyless]).toEqual(["api_keyless", true]);
    expect(csv(s, "fred", "fred_observations").find((x) => x.series_id === "GDPC1" && x.date === "2020-04-01")!.value)
      .toBe("19077.992");
    expect(JSON.stringify(r)).not.toContain(FAKE);
    // the keyless calls go only to FRED's graph hosts, never with the key
    expect(req.requests.every((u: string) => /^https:\/\/(fred|alfred)\.stlouisfed\.org\//.test(u) && !u.includes(FAKE)))
      .toBe(true);
  });

  it("an API outage (maintenance page) falls back to the keyless graph downloads", async () => {
    const page = { body: "<!DOCTYPE html><html><title>Site Maintenance</title></html>" };
    const r: any = await (await fetchWith(brokenApi(page), PIPE)).r;
    expect(r.summary.route).toBe("api_keyless");
    expect(r.notes.join(" ")).toContain("The FRED API did not answer");
  });

  it("a rejected key still fails when the spec needs a key-only feature", async () => {
    const spec = { description: "x", series: [{ id: "GDPC1", start: "2020-04-01", end: "2020-04-01", vintage: "first_release" }] };
    const f = await failure((await fetchWith(brokenApi(REJECTED), spec)).r);
    expect(f.code).toBe("key_rejected");
    expect(f.message).toContain("FRED rejected the API key");
  });

  it("a rejected key and keyless downloads that cannot connect: key_rejected naming both", async () => {
    const spy = vi.spyOn(api.Keyless.prototype, "metadata")
      .mockRejectedValue(new api.FredError("fredgraph.xlsx: network error: ECONNRESET", "network"));
    try {
      const f = await failure((await fetchWith(brokenApi(REJECTED), PIPE)).r);
      expect(f.code).toBe("key_rejected");
      expect(f.message).toContain("FRED rejected the API key");
      expect(f.message).toContain("the keyless graph downloads failed too: fredgraph.xlsx: network error");
      expect(JSON.stringify(f)).not.toContain(FAKE);
    } finally {
      spy.mockRestore();
    }
  });

  it("a key-only need without a key: key_missing with the manual route; the bundle lists every file (test_03)", async () => {
    const s = newSession();
    const f = await failure(fetchOk(s, "fred", FULL));
    expect(f.code).toBe("key_missing");
    expect(f.message).toContain("GDPC1: first release vintages");
    expect(f.manual_bundle).toBeTruthy();
    const b: any = await T.manualBundle(s, { sources: [{ source: "fred", spec: FULL }] });
    expect(b.bundle.replaceAll("\\", "/")).toMatch(/manual_download$/);
    const items = JSON.parse(fs.readFileSync(path.join(b.bundle, "manifest.json"), "utf8")).items;
    const v2 = items.find((i: any) => i.filename === "release_53.json");
    expect(v2.url).toMatch(/^https:\/\/api\.stlouisfed\.org\/fred\/v2\/release\/observations\?/);
    expect(v2.note).toContain("Authorization: Bearer");
    expect(items.some((i: any) => i.filename === "regional_01__group.json" && i.needs_key)).toBe(true);
    expect(items.every((i: any) => !i.needs_key || i.url.includes("api_key={API_KEY}"))).toBe(true);
    expect(items.filter((i: any) => i.needs_key).length).toBeGreaterThan(0);
    const sh = fs.readFileSync(b.download_scripts.bash, "latin1"), ps = fs.readFileSync(b.download_scripts.powershell, "latin1");
    expect(sh).not.toContain("\r"); // bash LF, PowerShell CRLF
    expect(ps.split("\n").length).toBe(ps.split("\r\n").length);
    for (const script of [sh, ps]) {
      expect(script).toContain("regional_01__group.json");
      expect(script).not.toContain(FAKE);
    }
  });

  it("a bad spec is a fix_spec failure (test_04)", async () => {
    const f = await failure(fetchOk(newSession(), "fred", { series: [{ id: "GDPC1", vintage: "yesterday" }] }));
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain('vintage must be "latest"');
  });

  it("the API route: first release, as-of vintages, source and copyright tag, GeoFRED (test_06)", async () => {
    withKey();
    const s = newSession();
    const r = await fetchOk(s, "fred", FULL);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api");
    const rows = csv(s, "fred", "fred_observations");
    const fr = rows.find((x) => x.variant === "GDPC1_first_release")!;
    expect([fr.value, fr.realtime_start]).toEqual(["17205.822", "2020-07-30"]);
    const asof = new Map(rows.filter((x) => x.variant === "GDPC1_asof").map((x) => [`${x.vintage} ${x.date}`, x.value]));
    expect(asof.get("2020-08-27 2020-04-01")).toBe("17282.188");
    expect(asof.has("2020-08-27 2020-07-01")).toBe(false); // not yet published then
    const meta = csv(s, "fred", "series");
    expect(meta[0].source).toBe("U.S. Bureau of Economic Analysis");
    expect(meta[0].copyright).toBe("public_domain"); // from the series/tags record
    expect(meta[0].copyright_basis).toContain("series tag");
    expect(csv(s, "fred", "regional").length).toBe(51);
    expect(read(s, "README.md")).toContain("This product uses the FRED");
    const text = read(s, "request.json");
    expect(text).not.toContain(FAKE);
    expect(text.replaceAll("api_key=[REDACTED]", "")).not.toContain("api_key=");
    expect(r.citation.text).toContain("U.S. Bureau of Economic Analysis, Real Gross Domestic Product [GDPC1], retrieved from FRED");
  });

  it("the release calendar and whole-release observations (test_07)", async () => {
    withKey();
    const s = newSession();
    const r = await fetchOk(s, "fred", FULL);
    expect(csv(s, "fred", "release_dates").map((d) => d.date)).toEqual(["2026-10-02", "2026-11-06", "2026-12-04"]);
    expect(csv(s, "fred", "release_dates")[0].release_name).toBe("Employment Situation");
    const rs = csv(s, "fred", "release_series");
    expect(rs.length).toBe(1); // pages merged by series
    expect([rs[0].series_id, rs[0].copyright, rs[0].n_obs]).toEqual(["A001RD3A086NBEA", "public_domain", "10"]);
    const ro = csv(s, "fred", "release_observations");
    expect(ro.length).toBe(10);
    expect([ro[0].date, ro[0].value]).toEqual(["1929-01-01", "8.757"]);
    expect(r.notes.some((n: string) => n.includes("max_pages"))).toBe(true);
  });

  it("release_dates lookup through request_schema search (test_08)", async () => {
    withKey();
    const s = newSession();
    let r: any = await T.requestSchema(s, { source: "fred", search: "release_dates 50 2026-10-01 2026-12-31 limit 5" });
    expect(r.results[0].count).toBe(3);
    expect(r.results[0].release_dates.length).toBe(3);
    delete process.env.FRED_API_KEY;
    r = await T.requestSchema(s, { source: "fred", search: "release_dates 50" });
    expect(r.results[0].status).toBe("needs_key");
  });

  it("keyless as-of vintages end where each vintage ended (test_09)", async () => {
    const s = newSession();
    await fetchOk(s, "fred", ASOF);
    expect(csv(s, "fred", "fred_observations").map((x) => [x.vintage, x.date])).toEqual(
      [["2020-08-27", "2020-04-01"], ["2021-07-29", "2020-04-01"], ["2021-07-29", "2020-07-01"]]);
  });

  it("an unknown ID is a problem, so the result is partial (test_10)", async () => {
    const r = await fetchOk(newSession(), "fred", { description: "Unknown ID", series: ["NOSUCHSERIESXYZ"], start: "2024-01-01" });
    expect(r.status).toBe("partial");
    expect(r.notes.some((p: string) => p.includes("no such series"))).toBe(true);
  });

  it("the same request is reused; a label change rebuilds from raw/ (test_11)", async () => {
    const s = newSession();
    await fetchOk(s, "fred", PIPE);
    let r = await fetchOk(s, "fred", PIPE);
    expect(r.summary.route).toBe("reuse_existing");
    expect(r.citation.text).toContain("[GDPC1]");
    const spec2 = JSON.parse(JSON.stringify(PIPE));
    spec2.series[0].label = "Real gross domestic product";
    r = await fetchOk(s, "fred", spec2);
    expect(r.summary.route).toBe("reuse_existing");
    expect(r.notes[0]).toContain("rebuilt from data/fred/raw/");
    expect(csv(s, "fred", "series")[0].label).toBe("Real gross domestic product");
    expect(JSON.parse(read(s, "request.json")).route).toBe("api_keyless"); // the original route is kept
    r = await fetchOk(s, "fred", { ...spec2, start: "2008-01-01" }); // the data changed: fetched again
    expect(r.summary.route).toBe("api_keyless");
  });

  it("the manual bundle lists the graph links; ingest of the downloads equals the fetch (test_12)", async () => {
    const s = newSession();
    await fetchOk(s, "fred", PIPE);
    const b: any = await T.manualBundle(s, { sources: [{ source: "fred", spec: PIPE }] });
    expect(fs.readFileSync(b.request_spec, "utf8")).toContain("GDPPOT");
    for (const f of [b.download_scripts.bash, b.download_scripts.powershell]) {
      const script = fs.readFileSync(f, "ascii");
      for (const sid of ["GDPC1", "GDPPOT", "USREC"]) {
        expect(script).toContain(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${sid}&`);
      }
    }
    expect(b.items.map((i: any) => i.filename)).toEqual(["GDPC1.csv", "GDPPOT.csv", "USREC.csv", "metadata_01.xlsx"]);
    expect(b.items.every((i: any) => !i.needs_key)).toBe(true);
    const s2 = newSession();
    await prepare(s2, "fred", PIPE);
    const r: any = await T.ingest(s2, { source: "fred", spec: PIPE, files: [path.join(dir(s), "raw")] });
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("manual_download");
    expect(csv(s2, "fred", "fred_observations")).toEqual(csv(s, "fred", "fred_observations"));
    expect(csv(s2, "fred", "series")[0].title).toBe("Real Gross Domestic Product");
  });

  it("ingest merges v2 release pages saved one file per page (test_12b)", async () => {
    const spec = { description: "Release 53 by hand", release_observations: [{ release_id: 53, limit: 5, max_pages: 2 }] };
    const s = newSession();
    await prepare(s, "fred", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "fred-up-"));
    const url = "https://api.stlouisfed.org/fred/v2/release/observations?release_id=53&format=json&limit=5";
    for (const [name, fx, u] of [["release_53.json", "v2_release_obs_53_p1.json", url],
      ["release_53__p02.json", "v2_release_obs_53_p2.json", url + "&next_cursor=A001RD3A086NBEA%2C1934-01-01"]]) {
      fs.writeFileSync(path.join(up, name), `{"request": "${u}", "response": ${fixture(fx).toString("utf8")}}`);
    }
    const r: any = await T.ingest(s, { source: "fred", spec, files: [up] });
    expect(r.status).toBe("ok");
    expect(csv(s, "fred", "release_series").map((x) => [x.series_id, x.n_obs])).toEqual([["A001RD3A086NBEA", "10"]]);
    expect(csv(s, "fred", "release_observations").map((x) => x.date.slice(0, 4))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(1929 + i)));
    expect((JSON.parse(read(s, "request.json")).notes || []).some((n: string) => n.includes("max_pages"))).toBe(true);
  });

  it("ingest also reads the API's own replies, as the generic download scripts save them", async () => {
    const spec = { description: "Release 53 by hand", release_observations: [{ release_id: 53, limit: 5, max_pages: 2 }] };
    const s = newSession();
    await prepare(s, "fred", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "fred-up-"));
    fs.copyFileSync(path.join(FIX, "v2_release_obs_53_p1.json"), path.join(up, "release_53.json"));
    fs.copyFileSync(path.join(FIX, "v2_release_obs_53_p2.json"), path.join(up, "release_53__p02.json"));
    await T.ingest(s, { source: "fred", spec, files: [up] });
    expect(csv(s, "fred", "release_observations").length).toBe(10);
  });

  it("ingest without files fails (test_13)", async () => {
    const s = newSession();
    await prepare(s, "fred", PIPE);
    const f = await failure(T.ingest(s, { source: "fred", spec: PIPE, files: [] }));
    expect(f.code).toBe("invalid_request");
  });

  it("restricted network: agency_unavailable with the manual route (test_14)", async () => {
    const s = newSession();
    await prepare(s, "fred", PIPE);
    delete process.env.DATA_ANALYST_FIXTURES;
    process.env.DATA_ACCESS_FORCE = "restricted";
    const f = await failure(T.fetchData(s, { source: "fred", spec: PIPE }));
    expect(f.code).toBe("agency_unavailable");
    expect(f.manual_bundle).toBeTruthy();
  });

  it("search without a key says what a key adds and where to search instead (test_15)", async () => {
    const r: any = await T.requestSchema(newSession(), { source: "fred", search: "potential gdp" });
    expect(r.results[0].status).toBe("needs_key");
    expect(r.results[0].message).toContain("https://fred.stlouisfed.org/searchresults/?st=potential+gdp");
  });

  it("describe: keyless titles; with a key source and release (test_16)", async () => {
    let r: any = await T.requestSchema(newSession(), { source: "fred", search: "describe GDPC1" });
    expect(r.results[0].title).toBe("Real Gross Domestic Product");
    expect(r.results[0].copyright).toBe("unknown");
    withKey();
    r = await T.requestSchema(newSession(), { source: "fred", search: "describe gdpc1" });
    expect(r.results[0].source).toBe("U.S. Bureau of Economic Analysis");
    expect(r.results[0].release).toBe("Gross Domestic Product");
    expect(r.results[0].copyright).toBe("public_domain");
  });

  it("the gate asks for the vintage schema when a spec uses vintages", async () => {
    expect(fred.uses(FULL)).toEqual(["series", "vintage", "regional", "release_dates", "release_observations"]);
    expect(fred.uses(PIPE)).toEqual(["series"]);
    expect(fred.uses({ series: ["GDPC1"], vintage: { as_of: ["2020-08-27"] } })).toEqual(["series", "vintage"]);
    const s = newSession();
    await T.sourceBrief(s, { source: "fred" });
    await T.requestSchema(s, { source: "fred", names: ["series"] });
    const f = await failure(T.fetchData(s, { source: "fred", spec: ASOF }));
    expect(f.code).toBe("gate_blocked");
    expect(f.message).toContain("vintage");
    const sc: any = await T.requestSchema(s, { source: "fred", names: ["vintage", "lookups"] });
    expect(sc.schemas[0].example.series.length).toBe(2);
    expect(sc.schemas[1].search_forms.describe).toContain("describe GDPC1");
  });

  it("withhold: a preapproval_required series is marked in series.csv and named in the README", async () => {
    withKey();
    const s = newSession();
    await fetchOk(s, "fred", { description: "x", series: [{ id: "GDPC1", start: "2024-01-01", end: "2025-12-31",
      copyright: "preapproval_required", copyright_basis: "series page tag, read 2026-11-07" }] });
    const p = (await load("fred")).policy;
    const w = p.redistribution.withhold;
    const meta = csv(s, "fred", w.meta.replace(/\.csv$/, ""));
    expect(meta[0][w.key]).toBe("GDPC1");
    expect(meta[0][w.column]).toBe("preapproval_required");
    expect(w.shareable).not.toContain(meta[0][w.column]);
    expect(meta[0].copyright_basis).toBe("series page tag, read 2026-11-07");
    expect(read(s, "README.md")).toContain("**Pre-approval required here:** `GDPC1`");
  });
});

describe("fred units", () => {
  it("citation uses the local day (test_citation_uses_local_day)", () => {
    const stamp = new Date(Date.UTC(2026, 9, 23, 0, 2));
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
      "November", "December"];
    const want = `${months[stamp.getMonth()]} ${stamp.getDate()}, ${stamp.getFullYear()}`;
    expect(api.citation("T5YIE", "5-Year Breakeven", "FRBSL", "2026-10-23T00:02:00+00:00")).toContain(want);
    expect(api.citation("T5YIE", "x", "", "2026-10-22")).toContain("October 22, 2026");
  });

  it("the README flags delayed series (test_readme_flags_delayed_series)", async () => {
    const ks = ["series_id", "label", "title", "units", "frequency", "fiscal_year", "seasonal_adjustment", "vintage", "first_date",
      "last_date", "n_obs", "n_missing", "n_future", "last_updated", "copyright", "citation"];
    const m: any = Object.fromEntries(ks.map((k) => [k, ""]));
    Object.assign(m, { series_id: "UMCSENT", notes: "At the request of the source, the data is delayed by 1 month. Copyright." });
    const req = { keyless: false, retrieved: "2026-10-22", acquired: "api", route: "api", regional_rows: 0 };
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "fred-readme-"));
    F.writeReadme(await load("fred"), d, { description: "x" }, [m, { ...m, series_id: "GDPC1", notes: "BEA" }], [], req);
    const text = fs.readFileSync(path.join(d, "README.md"), "utf8");
    expect(text).toContain("`UMCSENT` reaches FRED late");
    expect(text).toContain("delayed by 1 month");
    expect(text).not.toContain("`GDPC1` reaches FRED late");
  });

  it("a maintenance page is an outage (test_maintenance_page_is_an_outage)", async () => {
    const stub = { get: async (url: string) => ({ status: 200, headers: {}, url, cached: false,
      body: Buffer.from("<!DOCTYPE html><html><title>Site Maintenance</title></html>") }) as any };
    const c = new api.FredClient("0".repeat(32));
    const e: any = await c.json(stub, "https://api.stlouisfed.org/fred/series", {}, "series").catch((x) => x);
    expect(e).toBeInstanceOf(api.FredError);
    expect(e.fk).toBe("unavailable");
    expect((await c.ping()).auth_ok).toBe((await c.ping()).auth_ok); // ping never throws
  });

  it("norm_vintage (test_17)", () => {
    expect(F.normVintage(null).kind).toBe("latest");
    expect(F.normVintage("initial").kind).toBe("first_release");
    expect(F.normVintage({ as_of: ["2021-07-29", "2020-08-27"] }).dates).toEqual(["2020-08-27", "2021-07-29"]);
    expect(() => F.normVintage({ as_of: ["July 2020"] })).toThrow("vintage as_of needs YYYY-MM-DD dates, got ['July 2020']");
  });

  it("norm_spec (test_18)", () => {
    expect(F.normSpec({ series: ["gdpc1"], recessions: true }).series.map((x) => x.id)).toEqual(["GDPC1", "USREC"]);
    expect(() => F.normSpec({ series: ["GDPC1", "GDPC1"] })).toThrow("duplicate series in spec.json: ['GDPC1']");
    expect(() => F.normSpec({ series: [{ id: "GDPC1", frequency: "x" }] }))
      .toThrow("GDPC1: frequency must be one of ('d', 'w', 'bw', 'm', 'q', 'sa', 'a')");
    expect(() => F.normSpec({ release_observations: [{ release_id: "gdp" }] }))
      .toThrow("release_observations needs a numeric release_id, got 'gdp'");
    expect(fred.checkSpec!({ series: [{ id: "GDPC1", vintage: "yesterday" }] }, null as any)[0]).toContain("got 'yesterday'");
    expect(fred.checkSpec!({ description: "nothing" }, null as any)).toEqual(
      ["spec.json has no series, regional, release_dates or release_observations block"]);
  });

  it("fingerprints (test_19)", () => {
    const a = F.normSpec({ series: [{ id: "GDPC1", label: "a" }] });
    const b = F.normSpec({ series: [{ id: "GDPC1", label: "b" }] });
    expect(F.fingerprint(a)).toBe(F.fingerprint(b));
    expect(F.metaFingerprint(a)).not.toBe(F.metaFingerprint(b));
    const c = F.normSpec({ series: [{ id: "GDPC1" }], release_dates: { release_id: 50 } });
    expect(F.fingerprint(a)).not.toBe(F.fingerprint(c));
  });

  it("tags (test_20)", () => {
    const s = F.normSpec({ series: [{ id: "CPIAUCSL", units: "pc1" }, { id: "GDP", frequency: "a" },
      { id: "GDPC1", vintage: { as_of: "2020-08-27" } }] });
    expect(s.series.map(F.tag)).toEqual(["CPIAUCSL_pc1", "GDP_aavg", "GDPC1_asof"]);
  });

  it("key_only_needs (test_21)", () => {
    expect(F.keyOnlyNeeds(F.normSpec(FULL)).length).toBe(4);
    expect(F.keyOnlyNeeds(F.normSpec(ASOF))).toEqual([]);
  });

  it("graph_url (test_22)", () => {
    const u = api.graphUrl("GDPC1", { start: "2020-04-01", vintage_dates: ["2020-08-27", "2021-07-29"] });
    expect(u.startsWith("https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=GDPC1,GDPC1")).toBe(true);
    expect(u).toContain("cosd=2020-04-01,2020-04-01");
    expect(api.graphUrl("X", { frequency: "q", aggregation_method: "eop" })).toContain("fq=Quarterly&fam=eop");
  });

  it("parse_graph_csv and its zip (test_23)", () => {
    const cols = api.parseGraphCsv(fixture("graph_GDPC1_2007.csv"));
    expect(cols.get("GDPC1")![0].date).toBe("2007-01-01");
    const z = zipSync({ "quarterly.csv": fixture("graph_GDPC1_2007.csv"), "monthly.csv": fixture("graph_USREC_2007.csv") });
    expect([...api.parseGraphCsv(Buffer.from(z)).keys()].sort()).toEqual(["GDPC1", "USREC"]);
  });

  it("an HTML page in place of a graph CSV is not_found (test_24)", () => {
    let e: any;
    try {
      api.parseGraphCsv(fixture("graph_404_page.html"));
    } catch (x) {
      e = x;
    }
    expect(e.fk).toBe("not_found");
  });

  it("parse_graph_xlsx (test_25)", () => {
    const meta = api.parseGraphXlsx(fixture("graph_meta_GDPC1_GDPPOT_USREC.xlsx"));
    expect(meta.get("GDPC1")!.units).toBe("Billions of Chained 2017 Dollars");
    expect(meta.get("GDPC1")!.seasonal_adjustment).toBe("Seasonally Adjusted Annual Rate");
    expect(meta.get("USREC")!.frequency).toBe("Monthly");
    expect(meta.get("GDPPOT")!.last_updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("split_description and fiscal years (test_26)", () => {
    const d = api.splitDescription("Federal Outlays: Interest, Millions of Dollars, Annual, Not Seasonally Adjusted",
      "Data Updated: 2026-04-03");
    expect([d.title, d.units, d.frequency, d.last_updated]).toEqual(["Federal Outlays: Interest", "Millions of Dollars", "Annual",
      "2026-04-03"]);
    expect(F.isFiscal({ ...d, sheet: "Annual, Fiscal Year" }, "FYOINT")).toBe(true);
  });

  it("observation_rows (test_27)", () => {
    const rows = api.observationRows("GDPC1", [{ date: "2020-04-01", value: "." }, { date: "2020-04-01", GDPC1_20200827: "17282.188" }]);
    expect(rows[0].value).toBeNull();
    expect([rows[1].realtime_start, rows[1].value]).toEqual(["2020-08-27", 17282.188]);
  });

  it("regional_rows (test_28)", () => {
    const rows = api.regionalRows(JSON.parse(fixture("geofred_regional_1224_2025-01.json").toString("utf8")));
    expect(rows.length).toBe(51);
    expect(rows[0].date).toBe("2025-01-01");
  });

  it("copyright status, tags and v2 ids (test_29)", () => {
    expect(api.copyrightStatus("Copyright, 2016, Standard & Poor's", true)).toBe("copyrighted");
    expect(api.copyrightStatus("BEA Account Code", true)).toBe("no_copyright_notice");
    expect(api.copyrightStatus("", false)).toBe("unknown");
    expect(api.copyrightFromTag("copyrighted: pre-approval required")).toBe("preapproval_required");
    expect(api.copyrightFromTag("public domain: citation requested")).toBe("public_domain");
    const tags = { tags: [{ name: "nation", group_id: "geot" }, { name: "copyrighted: citation required", group_id: "cc" }] };
    expect(api.copyrightTagOf(tags)).toBe("copyrighted: citation required");
    expect(api.copyrightTagOf({ tags: [] })).toBe("");
  });

  it("keyless vintages come 12 to a download; GeoFRED frequencies (test_29b)", () => {
    const dates = [...Array.from({ length: 12 }, (_, i) => `2024-${String(i + 1).padStart(2, "0")}-15`), "2025-01-15", "2025-02-15"];
    const s = F.normSpec({ series: [{ id: "GDPC1", vintage: { as_of: dates } }] });
    expect(F.vintageChunks(s.series[0]).map((c) => c!.length)).toEqual([12, 2]);
    expect(F.pyManualItems(s).slice(0, 2).map((i) => i.file)).toEqual(["GDPC1_asof_p1.csv", "GDPC1_asof_p2.csv"]);
    expect(F.vintageChunks(F.normSpec({ series: ["GDPC1"] }).series[0])).toEqual([null]);
    expect(["a", "Annual", "sa", "Semiannual", "bw", "Biweekly", "q"].map(F.geoFreq)).toEqual(["a", "a", "sa", "sa", "bw", "bw", "q"]);
  });

  it("citation (test_30)", () => {
    const c = api.citation("GDPC1", "Real Gross Domestic Product", "U.S. Bureau of Economic Analysis", "2026-10-20T19:45:12+00:00");
    expect(c).toBe("U.S. Bureau of Economic Analysis, Real Gross Domestic Product [GDPC1], retrieved from FRED, Federal Reserve " +
      "Bank of St. Louis; https://fred.stlouisfed.org/series/GDPC1, October 20, 2026.");
  });

  it("period ends and fiscal years (test_31)", () => {
    expect(F.periodEndIso("2026-10-01", ["2026-07-01", "2026-10-01"])).toBe("2026-12-31");
    expect(F.periodEndIso("2025-09-30", ["2024-09-30", "2025-09-30"])).toBe("2025-09-30");
    // daily and weekly dates are the observation itself, not a month that has not ended
    expect(F.periodEndIso("2026-10-01", ["2026-09-30", "2026-10-01"])).toBe("2026-10-01");
    expect(F.periodEndIso("2026-10-01", ["2026-09-24", "2026-10-01"])).toBe("2026-10-01");
    expect(F.isFiscal({ frequency: "Annual, Fiscal Year" })).toBe(true);
    expect(F.isFiscal({ frequency: "Annual" }, "FYOIGDA188S")).toBe(true);
    expect(F.isFiscal({ frequency: "Annual" }, "GDPA")).toBe(false);
  });

  it("redaction (test_35)", () => {
    keys.remember(FAKE);
    const msg = keys.redact(`https://api.stlouisfed.org/fred/series?series_id=X&api_key=${FAKE}&file_type=json`);
    expect(msg).not.toContain(FAKE);
    expect(msg).toContain("api_key=[REDACTED]");
    const c = new api.FredClient(FAKE);
    expect(String(c)).toBe("FredClient(key=[REDACTED])");
    expect(JSON.stringify(c)).not.toContain(FAKE);
    expect(inspect(c)).not.toContain(FAKE);
  });

  it("policy: no cache, the withhold rule, the API notice (test_36)", async () => {
    const p = (await load("fred")).policy;
    expect(p.cache.mode).toBe("none");
    expect(p.redistribution.withhold.shareable).toEqual(["no_copyright_notice", "public_domain", "citation_required"]);
    expect(() => pol.checkCache(p, "run_only")).toThrow(pol.PolicyError);
    expect(p.notices[0]).toContain("FRED");
  });

  it("key check (test_37)", async () => {
    const reply = (status: number, body: string) => async () => ({ status, body: Buffer.from(body) });
    expect((await api.verify(FAKE, reply(400, '{"error_code":400,"error_message":"Bad Request.  The value for variable ' +
      'api_key is not registered."}')))[0]).toBe(false); // the documented rejection
    expect((await api.verify(FAKE, reply(200, '{"seriess": []}')))[0]).toBe(true);
    expect((await api.verify(FAKE, reply(429, "")))[0]).toBeNull();
    expect((await api.verify(FAKE))[0]).toBe(true); // the recorded GNPCA reply
  });
});
