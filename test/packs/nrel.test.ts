/**
 * nrel pack, ported from tests/sources/nrel/test_nrel.py. Fixtures recorded live from developer.nlr.gov on
 * 2026-10-20 with a key (URLs are recorded without it); r005 (a ZIP read in full) on 2026-10-28.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { DataError } from "../../src/core/http.js";
import { load } from "../../src/core/packs.js";
import { pyFloatRepr } from "../../src/core/py.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SRC = "nrel";
const SPEC = { description: "Vermont DC fast EV stations; Montpelier VT rates, solar resource and a 4 kW PV system",
  requests: [
    { name: "vt_dcfast", endpoint: "alt_fuel_stations", params: { state: "VT", fuel_type: "ELEC", ev_charging_level: "dc_fast" }, max_rows: 3 },
    { name: "montpelier_rates", endpoint: "utility_rates", params: { lat: 44.26, lon: -72.58 } },
    { name: "montpelier_solar", endpoint: "solar_resource", params: { lat: 44.26, lon: -72.58 } },
    { name: "montpelier_pv", endpoint: "pvwatts", params: { lat: 44.26, lon: -72.58, system_capacity: 4, module_type: 0,
      losses: 14, array_type: 1, tilt: 30, azimuth: 180 } }] };
const PV = { path: "/pvwatts/v8.json" };

beforeAll(() => isolate());

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  return failure(T.fetchData(s, { source: SRC, spec }));
}

describe("nrel", () => {
  it("keyless (DEMO_KEY) is the api route", async () => {
    expect(gr.checkSpec(await load(SRC), SPEC)).toEqual([]);
  });

  it("fetches stations, rates, solar resource and PVWatts", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.summary.route).toBe("api");
    const st = csv(s, SRC, "vt_dcfast");
    expect(st[1].station_name).toBe("Brattleboro, VT - Tesla Supercharger");
    expect(st[1].ev_dc_fast_num).toBe("16");
    expect(r.notes.some((n: string) => n.includes("113 in total"))).toBe(true);
    expect(csv(s, SRC, "montpelier_rates")[0].residential).toBe("0.1688");
    const solar = csv(s, SRC, "montpelier_solar");
    expect(solar.length).toBe(13);
    expect(solar[0].avg_ghi_kwh_m2_day).toBe("1.67");
    expect(solar[12].period).toBe("annual");
    const pv = csv(s, SRC, "montpelier_pv");
    expect(pv.length).toBe(12);
    expect(pv[0].ac_kwh).toBe("319.5231449149002");
  });

  it("pvwatts needs its inputs", async () => {
    expect((await fetchFail({ requests: [{ name: "pv", endpoint: "pvwatts", params: { lat: 40, lon: -105 } }] })).code)
      .toBe("invalid_request");
  });

  it("errors inside HTTP 200", async () => {
    const ad = (await load(SRC)).adapter!;
    expect(ad.checkError!(200, Buffer.from('{"errors": ["lat must be a number"]}'))).toContain("lat");
    expect(ad.checkError!(200, Buffer.from('{"errors": [], "outputs": {}}'))).toBeNull();
  });

  it("pvwatts timeframe=hourly gives one row per hour", async () => {
    // a row shaped like flatten output; the numbers are arbitrary, not source data
    const norm = (await load(SRC)).adapter!.normalize!;
    const n = 8760;
    const row: any = { ac_monthly: Array.from({ length: 12 }, (_, m) => pyFloatRepr(m + 1)).join("; "),
      dc_monthly: Array(12).fill("1.5").join("; "),
      ac: Array.from({ length: n }, (_, i) => pyFloatRepr((i % 24) * 7.5)).join("; "),
      tamb: Array.from({ length: n }, (_, i) => pyFloatRepr(-3.0 + (i % 50))).join("; "),
      ac_annual: 1234.5, capacity_factor: 11.1 };
    const out = norm({ name: "pv" }, PV, [row]);
    expect(out.length).toBe(n);
    expect([out[0].month, out[0].day, out[0].hour]).toEqual([1, 1, 0]);
    expect([out[25].month, out[25].day, out[25].hour]).toEqual([1, 2, 1]);
    expect([out[n - 1].month, out[n - 1].day, out[n - 1].hour]).toEqual([12, 31, 23]);
    expect(out[25].ac_w).toBe("7.5");
    expect(out[49].tamb_c).toBe("46.0");
    expect(out[0].capacity_factor).toBe(11.1);
    expect(out[0]).not.toHaveProperty("ac_kwh");
    const bad = { ...row, ac: Array(100).fill("1").join("; "), tamb: Array(100).fill("1").join("; ") };
    expect(() => norm({ name: "pv" }, PV, [bad])).toThrow(DataError);
    const { ac: _a, tamb: _t, ...monthlyRow } = row;
    expect(norm({ name: "pv" }, PV, [monthlyRow]).map((m) => m.month)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("the nearest endpoint needs coordinates", async () => {
    // the API removed 'location' (HTTP 422)
    expect((await fetchFail({ requests: [{ name: "near", endpoint: "alt_fuel_nearest", params: { fuel_type: "E85", radius: 10 } }] })).code)
      .toBe("invalid_request");
  });

  it("city is matched on the rows, not sent", async () => {
    // sent, the city parameter answers 0 rows (live 2026-10-28): the pack fetches the ZIP and keeps that city's rows
    const req = { name: "dcfast_town", endpoint: "alt_fuel_stations",
      params: { zip: "05301", fuel_type: "ELEC", ev_charging_level: "dc_fast", city: "  brattleboro" } };
    let s = newSession();
    let r = await fetchOk(s, SRC, { requests: [req] });
    expect(r.status).toBe("ok");
    expect(csv(s, SRC, "dcfast_town").map((x) => x.city)).toEqual(Array(4).fill("Brattleboro"));
    const f = await fetchFail({ requests: [{ ...req, params: { ...req.params, city: "Nowhere" } }] }); // every station read, none matched
    expect(f.message).toContain("returned no rows");
    // a state fetch cut at max_rows (r001: 3 of 113) leaves the city's rows incomplete: partial, and said so
    s = newSession();
    r = await fetchOk(s, SRC, { requests: [{ name: "dcfast_town", endpoint: "alt_fuel_stations", max_rows: 3,
      params: { state: "VT", fuel_type: "ELEC", ev_charging_level: "dc_fast", city: "Nowhere" } }] });
    expect(r.status).toBe("partial");
    expect(r.notes.some((n: string) => n.includes("may be incomplete"))).toBe(true);
    // city alone would page through the country
    expect((await fetchFail({ requests: [{ name: "c", endpoint: "alt_fuel_stations", params: { city: "Barre" } }] })).code)
      .toBe("invalid_request");
  });
});
