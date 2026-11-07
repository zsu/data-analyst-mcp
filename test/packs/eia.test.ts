/** eia: ported from the Python skill's tests/sources/eia/test_eia.py (same fixtures, specs and expected values). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const SPEC = { description: "Residential electricity price, Maryland and U.S., annual 2020-2024",
  requests: [{ name: "md_res_price", endpoint: "data",
    params: { route: "retail_sales", state: ["MD", "US"], facets: { sectorid: ["RES"] }, frequency: "annual", start: "2020", end: "2024" } }] };
const MORE = { description: "SEDS per capita, WTI, gasoline, sectors",
  requests: [
    { name: "seds_per_capita", endpoint: "data", params: { route: "seds", msn: "TETPB", state: ["Maryland", "US"], start: "2020", end: "2023" } },
    { name: "wti_monthly", endpoint: "data",
      params: { route: "spot_prices", facets: { series: ["RWTC"] }, frequency: "monthly", start: "2025-01", end: "2025-06" } },
    { name: "gasoline_weekly", endpoint: "data",
      params: { route: "gasoline_diesel_retail", facets: { series: ["EMM_EPMR_PTE_NUS_DPG"] }, frequency: "weekly",
        start: "2026-09-01", end: "2026-10-19" } },
    { name: "sectors", endpoint: "facet_values", params: { route: "retail_sales", facet: "sectorid" } }] };
const GAS_MONTHLY = { description: "U.S. regular gasoline, monthly 2024",
  requests: [{ name: "gas_2024", endpoint: "data",
    params: { route: "gasoline_diesel_retail", facets: { series: ["EMM_EPMR_PTE_NUS_DPG"] }, frequency: "monthly", start: "2024", end: "2024" } }] };
const XLS = "EMM_EPMR_PTE_NUS_DPGm.xls";
const FX = path.join(TEST_DIR, "packs", "eia", "fixtures");

beforeAll(() => isolate());

const adapter = async (): Promise<any> => (await load("eia")).adapter;

async function fetchFail(spec: any, env: Record<string, string> = {}): Promise<any> {
  const s = newSession();
  fixtures("eia");
  await prepare(s, "eia", spec);
  Object.assign(process.env, env);
  try {
    return await failure(T.fetchData(s, { source: "eia", spec }));
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
}

describe("eia", () => {
  it("without a key fetches on the api route (DEMO_KEY), citing the API", async () => {
    const s = newSession();
    const r = await fetchOk(s, "eia", SPEC);
    expect(r.summary.route).toBe("api");
    const rows = csv(s, "eia", "md_res_price");
    expect(rows.length).toBe(10);
    expect([rows[0].period, rows[0].stateid, rows[0].price, rows[0]["price-units"]]).toEqual(["2024", "MD", "17.86", "cents per kilowatt-hour"]);
    expect(JSON.stringify(r.citation)).toContain("EIA Open Data API v2 (api.eia.gov)");
  });

  it("fetches SEDS, spot prices, gasoline and facet values", async () => {
    const s = newSession();
    await fetchOk(s, "eia", MORE);
    const seds = csv(s, "eia", "seds_per_capita");
    expect([seds[0].seriesId, seds[0].stateId, seds[0].value, seds[0].unit]).toEqual(["TETPB", "MD", "191.3", "Million Btu"]);
    const wti = csv(s, "eia", "wti_monthly");
    expect([wti[0].period, wti[0].value, wti[0].units]).toEqual(["2025-06", "68.17", "$/BBL"]);
    expect(csv(s, "eia", "gasoline_weekly").length).toBe(7);
    expect(csv(s, "eia", "sectors").map((x) => x.id)).toContain("RES");
  });

  it("an invalid facet is the API's error", async () => {
    const f = await fetchFail({ requests: [{ name: "bad", endpoint: "data",
      params: { route: "retail_sales", facets: { bogus: ["X"] }, frequency: "annual", start: "2024" } }] });
    expect(f.message).toContain("Invalid facet 'bogus'");
  });

  it("spec checks: state without a state facet, a frequency the route lacks", async () => {
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "data", params: { route: "spot_prices", state: "MD", frequency: "hourly" } }] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("state");
    expect(f.message).toContain("frequency 'hourly'");
  });

  it("manual links use DEMO_KEY and bracket parameters", async () => {
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: "eia", spec: SPEC }] });
    const url: string = JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8")).items[0].url;
    expect(url.startsWith("https://api.eia.gov/v2/electricity/retail-sales/data/?")).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.getAll("facets[stateid][]")).toEqual(["MD", "US"]);
    expect(q.getAll("data[0]")).toEqual(["price"]);
    expect(q.getAll("api_key")).toEqual(["DEMO_KEY"]);
  });

  it("searches the catalog", async () => {
    const s = newSession();
    const r: any = await T.requestSchema(s, { source: "eia", search: "electricity price state" });
    expect(r.results[0].id).toBe("electricity/retail-sales");
  });

  it("builds requests that follow the route", async () => {
    const ad = await adapter();
    let [, q] = ad.prepare({ endpoint: "data" }, { path: "/{route}/data/" },
      { route: "total-energy", msn: "nggcbus", start: "2019", end: "2020" });
    expect(q["facets[msn][]"]).toEqual(["NGGCBUS"]);
    expect(q).not.toHaveProperty("facets[seriesId][]");
    expect([q.start, q.end]).toEqual(["2019-01", "2020-12"]); // monthly is the route default
    [, q] = ad.prepare({ endpoint: "data" }, { path: "/{route}/data/" }, { route: "seds", msn: "PATCB", start: "2010", end: "2012" });
    expect(q["facets[seriesId][]"]).toEqual(["PATCB"]);
    expect([q.start, q.end]).toEqual(["2010", "2012"]); // annual: years stay years
    expect(ad.wholeYear("2021", "quarterly", "end")).toBe("2021-Q4");
    expect(ad.wholeYear("2021-06", "monthly", "start")).toBe("2021-06");
  });

  // ------------------------------------------------------------ keyless dnav history files
  it("lists the keyless file for a one-series petroleum request", async () => {
    const p = await load("eia");
    expect(p.adapter!.keylessFiles!(GAS_MONTHLY, p)).toEqual([{ request: "gas_2024", frequency: "monthly", filename: XLS,
      url: "https://www.eia.gov/dnav/pet/hist_xls/" + XLS }]);
    expect(p.policy.routes?.manual?.keyless_file).toContain("hist_xls");
    // a request no history file holds (SEDS, electricity) gets none
    expect(p.adapter!.keylessFiles!(SPEC, p)).toEqual([]);
  });

  it("a spent DEMO_KEY (HTTP 429) offers the keyless file", async () => {
    const f = await fetchFail(GAS_MONTHLY);
    expect(f.code).toBe("agency_unavailable");
    expect(f.keyless_files.map((x: any) => x.filename)).toEqual([XLS]);
    expect(f.keyless_file).toContain("hist_xls");
    // with a key of the user's, a 429 stays an error
    expect((await fetchFail(GAS_MONTHLY, { EIA_API_KEY: "x".repeat(40) })).status).toBe("error");
  });

  it("ingests the keyless file", async () => {
    const s = newSession();
    fixtures("eia");
    await prepare(s, "eia", GAS_MONTHLY);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "eia-up-"));
    fs.copyFileSync(path.join(FX, XLS), path.join(up, XLS));
    const r: any = await T.ingest(s, { source: "eia", spec: GAS_MONTHLY, files: [up] });
    expect(r.summary.route).toBe("keyless_file");
    const rows = csv(s, "eia", "gas_2024");
    expect(rows.length).toBe(12);
    expect(rows.slice(-3).map((x) => [x.period, x.value])).toEqual([["2024-03", "3.426"], ["2024-02", "3.212"], ["2024-01", "3.075"]]);
    expect([rows[0].series, rows[0].units]).toEqual(["EMM_EPMR_PTE_NUS_DPG", "Dollars per Gallon"]);
    const req = JSON.parse(fs.readFileSync(path.join(s.workspace, "data", "eia", "request.json"), "utf8"));
    expect([req.route, req.acquired]).toEqual(["keyless_file", "keyless_file"]);
    expect(req.notes[0]).toContain(XLS);
    // the weekly file is not the monthly request's
    const wk = path.join(up, XLS.replace("m.xls", "w.xls"));
    fs.renameSync(path.join(up, XLS), wk);
    const ad = await adapter();
    expect(() => ad.dnavRows(wk, GAS_MONTHLY.requests[0], { ...GAS_MONTHLY.requests[0].params, route: "petroleum/pri/gnd" }))
      .toThrow(XLS);
  });

  it("reads the history file as xlrd did", async () => {
    const ad = await adapter();
    const params = { route: "petroleum/pri/gnd", facets: { series: ["EMM_EPMR_PTE_NUS_DPG"] }, frequency: "monthly" };
    const all = ad.dnavRows(path.join(FX, XLS), { name: "x", endpoint: "data" }, params);
    expect(all.length).toBe(432);
    expect(all[0]).toEqual({ period: "2026-10", series: "EMM_EPMR_PTE_NUS_DPG",
      "series-description": "U.S. Regular All Formulations Retail Gasoline Prices (Dollars per Gallon)", value: "4.31",
      units: "Dollars per Gallon" });
    const asc = ad.dnavRows(path.join(FX, XLS), { name: "x", endpoint: "data" }, { ...params, sort: "period:asc", start: "2020-03" });
    expect([asc.length, asc[0].period, asc[0].value, asc[1].value]).toEqual([80, "2020-03", "2.234", "1.841"]);
  });

  it("covers only one-series petroleum requests", async () => {
    const ad = await adapter();
    const one = (p: any) => ad.dnavFile({ name: "x", endpoint: "data" }, p);
    expect(one({ route: "petroleum/cons/psup", facets: { series: ["MGFUPUS2"] }, frequency: "monthly" }).filename).toBe("MGFUPUS2m.xls");
    expect(one({ route: "petroleum/pri/spt", facets: { series: "RWTC" }, frequency: "daily" }).filename).toBe("RWTCd.xls");
    expect(one({ route: "petroleum/pri/gnd", facets: { series: ["EMM_EPMR_PTE_NUS_DPG"] } }).filename)
      .toBe(XLS.replace("m.xls", "w.xls")); // the route's default frequency
    expect(one({ route: "petroleum/pri/spt", facets: { series: ["RWTC", "RBRTE"] }, frequency: "daily" })).toBeNull();
    expect(one({ route: "petroleum/pri/gnd", facets: { series: ["EMM_EPMR_PTE_NUS_DPG"], duoarea: ["NUS"] }, frequency: "weekly" })).toBeNull();
    expect(one({ route: "seds", msn: "TETPB" })).toBeNull();
    expect(one({ route: "natural-gas/pri/sum", facets: { series: ["N3010US3"] }, frequency: "monthly" })).toBeNull();
  });
});
