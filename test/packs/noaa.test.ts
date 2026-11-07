/**
 * noaa pack, ported from tests/sources/noaa/test_noaa.py. Fixtures recorded live from the keyless NCEI Access Data
 * Service on 2026-10-20.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { DataError } from "../../src/core/http.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SRC = "noaa";
const SPEC = { description: "Central Park, NYC: daily and monthly weather, monthly normals; stations near Manhattan",
  requests: [
    { name: "cp_daily", endpoint: "data", params: { dataset: "daily", stations: "GHCND:USW00094728", startDate: "2024-01-01",
      endDate: "2024-01-03", dataTypes: "TMAX,TMIN,PRCP,SNOW" } },
    { name: "cp_monthly", endpoint: "data", params: { dataset: "monthly", stations: "USW00094728", startDate: "2024-01-01",
      endDate: "2024-12-31", dataTypes: "TAVG,PRCP" } },
    { name: "cp_normals", endpoint: "data", params: { dataset: "normals_monthly", stations: "USW00094728", startDate: "0001-01-01",
      endDate: "9996-12-31", dataTypes: "MLY-TAVG-NORMAL,MLY-PRCP-NORMAL" } },
    { name: "near_manhattan", endpoint: "station_search", params: { dataset: "daily", bbox: "40.9,-74.1,40.6,-73.8",
      startDate: "2024-01-01T00:00:00", endDate: "2024-01-31T23:59:59" }, max_rows: 2 }] };
const ADS = { path: "/access/services/data/v1" };

beforeAll(() => isolate());
beforeEach(() => {
  delete process.env.NOAA_API_KEY;
});

const adapter = async () => (await load(SRC)).adapter!;

describe("noaa", () => {
  it("keyless is the api route", async () => {
    expect(gr.checkSpec(await load(SRC), SPEC)).toEqual([]);
    expect((await fetchOk(newSession(), SRC, SPEC)).summary.route).toBe("api");
  });

  it("fetches daily, monthly, normals and stations", async () => {
    const s = newSession();
    await fetchOk(s, SRC, SPEC);
    const d = csv(s, SRC, "cp_daily");
    expect(d[0].DATE).toBe("2024-01-01");
    expect(d[0].TMAX).toBe("47"); // degrees F (units=standard)
    expect(d[0].PRCP).toBe("0.03");
    const m = csv(s, SRC, "cp_monthly");
    expect(m.length).toBe(12);
    expect(m[0].TAVG).toBe("37.0");
    expect(csv(s, SRC, "cp_normals")[0]["MLY-TAVG-NORMAL"]).toBe("33.7"); // padding trimmed
    const st = csv(s, SRC, "near_manhattan");
    expect(st[0].station_id).toBe("USW00094728");
    expect(st[0].latitude).toBe("40.77898");
    expect(st[0].data_types.split(" ")).toContain("TMAX");
  });

  it("CDO needs the key (key_only_needs)", async () => {
    const cdo = { requests: [{ name: "ny_stations", endpoint: "cdo_stations", params: { datasetid: "GSOM", locationid: "FIPS:36" } }] };
    expect((await adapter()).keyOnlyNeeds!(cdo).length).toBeGreaterThan(0);
    const s = newSession();
    fixtures(SRC);
    await prepare(s, SRC, cdo);
    expect((await failure(T.fetchData(s, { source: SRC, spec: cdo }))).code).toBe("key_missing");
  });

  it("a CDO fetch without a key is key_missing before any request", async () => {
    const spec = { requests: [{ name: "tx_types", endpoint: "cdo_datatypes", params: { locationid: "FIPS:48" } }] };
    const s = newSession();
    fixtures(SRC);
    await prepare(s, SRC, spec);
    const f = await failure(T.fetchData(s, { source: SRC, spec }));
    expect(f.code).toBe("key_missing");
    expect(f.message).toContain("NOAA_API_KEY");
  });

  it("ping without a key reports the key's absence (CDO is not called)", async () => {
    const noKey: any = { key: null, get: () => { throw new Error("CDO must not be called without a token"); } };
    const p = await (await adapter()).ping!(noKey);
    expect(p.kind).toBe("key_missing");
    expect(p.auth_ok).toBe(false);
  });

  it("partial dates are padded for ADS", async () => {
    // ADS refuses YYYY-MM even for monthly datasets ("Invalid ISO Date Time", live 2026-10)
    const br = (await adapter()).beforeRequest!;
    let p: any = br({ name: "x" }, ADS, { startDate: "2019-02", endDate: "2020-02", stations: "GHCND:USC00041614" });
    expect([p.startDate, p.endDate]).toEqual(["2019-02-01", "2020-02-29"]);
    expect(p.stations).toBe("USC00041614");
    p = br({ name: "x" }, ADS, { startDate: "1998", endDate: "2001" });
    expect([p.startDate, p.endDate]).toEqual(["1998-01-01", "2001-12-31"]);
    p = br({ name: "x" }, ADS, { startDate: "0001-01-01", endDate: "2003-06-30T23:59:59" });
    expect([p.startDate, p.endDate]).toEqual(["0001-01-01", "2003-06-30T23:59:59"]);
    p = br({ name: "x" }, { path: "/access/services/search/v1/data" }, { stations: "GHCND:USW00023174" });
    expect(p.stations).toBe("USW00023174");
  });

  it("a request none of whose data types came back fails", async () => {
    // a misspelled or lower-case data type gives HTTP 200 rows with only DATE and STATION (live 2026-10)
    const norm = (await adapter()).normalize!;
    const bare = [{ DATE: "2015-07-01", STATION: "USW00023174" }];
    expect(() => norm({ name: "x", params: { dataTypes: "snwd,AWNDX" } }, ADS, bare)).toThrow(DataError);
    expect(() => norm({ name: "x", params: { dataTypes: "snwd,AWNDX" } }, ADS, bare)).toThrow(/case-sensitive/);
    const ok = norm({ name: "x", params: { dataTypes: "SNWD,AWNDX" } }, ADS, [{ DATE: "2015-07-01", STATION: "USW00023174", SNWD: " 0" }]);
    expect(ok[0].SNWD).toBe("0");
  });

  it("a CDO range that is too long is invalid_request", async () => {
    const bad = { requests: [{ name: "x", endpoint: "cdo_data", params: { datasetid: "GHCND", stationid: "GHCND:USW00094728",
      startdate: "2020-01-01", enddate: "2024-12-31" } }] };
    expect(gr.checkSpec(await load(SRC), bad).join(" ")).toContain("CDO limits a request to 1 year (GHCND)");
  });
});
