/** EPA AQS: ported from tests/sources/epa-aqs/test_epa_aqs.py (same fixtures and values). */
import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/epa-aqs.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fakeKeys, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

beforeAll(() => isolate());

// No AQS key was available when this pack was built, so the fixtures are NOT live recordings: they are the
// example responses printed in the AQS API documentation (https://aqs.epa.gov/aqsweb/documents/data_api.html),
// saved as doc_*.json (a sample-data record, the "No data matched your selection" reply, the "Failed" reply).
// The documentation's examples call the row list "Body"; the live API calls it "Data" (the adapter reads both).
const SPEC = { description: "PM2.5 sample at site 01-073-0023 (Jefferson County, AL) on 2017-04-01 (documented example)",
  requests: [{ name: "al_pm25_sample", endpoint: "data", params: { service: "sampleData", geo: "bySite", param: "pm25",
    bdate: "20170401", edate: "20170401", state: "AL", county: "73", site: "23" } }] };

const TWO_YEARS = { description: "Vermont annual ozone 2022-2023 (split into two calls)",
  requests: [{ name: "vt_ozone", endpoint: "data", allow_empty: true, params: { service: "annualData", geo: "byState",
    param: "ozone", bdate: "20220101", edate: "20231231", state: "Vermont" } }] };

const A: any = adapter;
const KEY_VARS = ["AQS_API_KEY", "AQS_EMAIL"];
const noKeys = () => KEY_VARS.forEach((k) => delete process.env[k]);

describe("epa-aqs", () => {
  it("without a key, fetch asks for one and offers the keyless file", async () => {
    noKeys();
    const s = newSession();
    fixtures("epa-aqs");
    await prepare(s, "epa-aqs", SPEC);
    const f = await failure(T.fetchData(s, { source: "epa-aqs", spec: SPEC }));
    expect(f.code).toBe("key_missing");
    expect(f.message).toContain("AQS_API_KEY");
    const f2 = await failure(T.fetchData(s, { source: "epa-aqs", spec: TWO_YEARS }));
    expect(f2.keyless_file).toContain("annual_conc_by_monitor_<year>.zip");
  });

  it("fetches the documented example; email and key never recorded", async () => {
    await fakeKeys("epa-aqs");
    try {
      const s = newSession();
      const r = await fetchOk(s, "epa-aqs", SPEC);
      expect(r.status).toBe("ok");
      const rows = csv(s, "epa-aqs", "al_pm25_sample");
      expect(rows[0].sample_measurement).toBe("6.2");
      expect(rows[0].county_name).toBe("Jefferson");
      expect(rows[0].unit_of_measure).toBe("Micrograms/cubic meter (LC)");
      const text = fs.readFileSync(path.join(s.workspace, "data", "epa-aqs", "request.json"), "utf8");
      expect(text).not.toContain("test@example.com");
      expect(text).not.toContain("x".repeat(40));
    } finally {
      noKeys();
    }
  });

  it("splits a multi-year range", async () => {
    await fakeKeys("epa-aqs");
    try {
      const r = await fetchOk(newSession(), "epa-aqs", TWO_YEARS);
      expect(r.notes.some((n: string) => n.includes("2 calls, one per year"))).toBe(true);
    } finally {
      noKeys();
    }
  });

  it("bad dates and geography are spec problems", async () => {
    const bad = { requests: [{ name: "x", endpoint: "data", params: { service: "dailyData", geo: "byCounty", param: "88101",
      bdate: "2024-06-01", edate: "20240630", state: "06" } }] };
    const probs = gr.checkSpec(await load("epa-aqs"), bad).join("; ");
    expect(probs).toContain("YYYYMMDD");
    expect(probs).toContain("county");
  });

  it("a Failed header is an error", () => {
    const body = fs.readFileSync(path.join(TEST_DIR, "packs", "epa-aqs", "fixtures", "doc_failed.json"));
    expect(adapter.checkError!(200, body)).toContain("value is missing");
  });

  it("year windows", () => {
    expect(A.yearWindows({ service: "dailyData", bdate: "20220615", edate: "20240110" }))
      .toEqual([["20220615", "20221231"], ["20230101", "20231231"], ["20240101", "20240110"]]);
  });

  it("an AirData zip is ingested and filtered", async () => {
    // The keyless route: EPA's AirData yearly file goes through ingest as downloaded. The file covers every
    // monitor; ingest keeps the request's rows and uses the API's column names. (Rows made up for the test,
    // in the layout of daily_<code>_<year>.csv, checked 2026-10-28.)
    noKeys();
    const head = "State Code,County Code,Site Num,Parameter Code,POC,Latitude,Longitude,Datum,Parameter Name," +
      "Sample Duration,Pollutant Standard,Date Local,Units of Measure,Event Type,Observation Count," +
      "Observation Percent,Arithmetic Mean,1st Max Value,1st Max Hour,AQI,Method Code,Method Name," +
      "Local Site Name,Address,State Name,County Name,City Name,CBSA Name,Date of Last Change";
    const line = (st: string, co: string, day: string, mean: string) =>
      `${st},${co},0007,42602,1,40.1,-80.2,WGS84,Nitrogen dioxide (NO2),1 HOUR,NO2 1-hour 2010,` +
      `2021-${day},Parts per billion,None,24,100.0,${mean},20.0,7,18,099,Method,Site,Addr,Somestate,` +
      'Somecounty,Town,"Town, ST",2022-05-01';
    const rows = [line("42", "003", "03-01", "9.5"), line("42", "003", "03-02", "11.25"),
      line("42", "005", "03-01", "4.0"), line("39", "003", "03-01", "7.0"), line("42", "003", "04-01", "8.0")];
    const spec = { requests: [{ name: "no2_march", endpoint: "data", params: { service: "dailyData", geo: "byCounty",
      param: "no2", bdate: "20210301", edate: "20210331", state: "PA", county: "3" } }] };
    const s = newSession();
    fixtures("epa-aqs");
    await prepare(s, "epa-aqs", spec);
    const up = path.join(s.workspace, "up");
    fs.mkdirSync(up);
    const zip = path.join(up, "daily_42602_2021.zip");
    fs.writeFileSync(zip, zipSync({ "daily_42602_2021.csv": strToU8([head, ...rows].join("\n") + "\n") }));
    const r: any = await T.ingest(s, { source: "epa-aqs", spec, files: [zip] });
    const got = csv(s, "epa-aqs", "no2_march");
    expect(got.map((x) => [x.county_code, x.date_local, x.arithmetic_mean]))
      .toEqual([["003", "2021-03-01", "9.5"], ["003", "2021-03-02", "11.25"]]);
    expect(got[0]).toHaveProperty("site_number");
    expect(got[0].first_max_value).toBe("20.0");
    // the AirData file is the pack's keyless_file: recorded and cited as such, not as the API
    expect(r.summary.route).toBe("keyless_file");
    const readme = fs.readFileSync(path.join(s.workspace, "data", "epa-aqs", "README.md"), "utf8");
    expect(readme).toContain("aqs.epa.gov/aqsweb/airdata");
    expect(readme).not.toContain("aqs.epa.gov/data/api");
    // an annual file for a daily request is refused, naming the file wanted
    fs.writeFileSync(zip, zipSync({ "x.csv": strToU8("State Code,Year,Metric Used\n42,2021,m\n") }));
    const f = await failure(T.ingest(s, { source: "epa-aqs", spec, files: [zip] }));
    expect(f.message).toContain("not an AirData dailyData file");
  });

  it("names the AirData files", () => {
    expect(A.airdataNames({ service: "dailyData", param: "88101" }, "2023")).toEqual(["daily_88101_2023.zip", "daily_88101_2023.csv"]);
    expect(A.airdataNames({ service: "dailyData", param: "88101,44201" }, "2023")).toEqual([]);
    expect(A.airdataNames({ service: "monitors", param: "88101" }, "2023")).toEqual([]);
  });

  it("manual bundle placeholders", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "epa-aqs", spec: SPEC }] });
    const it0 = r.items[0];
    expect(it0.url).toContain("state=01&county=073&site=0023");
    expect(it0.url.endsWith("&email={AQS_EMAIL}&key={API_KEY}")).toBe(true);
    expect(it0.needs_key).toBe(true);
  });
});
