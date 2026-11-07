/**
 * nws pack, ported from tests/sources/nws/test_nws.py. Fixtures recorded live from api.weather.gov on 2026-10-20
 * (forecast = point lookup + gridpoint forecast).
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SRC = "nws";
const SPEC = { description: "Washington, DC forecast; active alerts in New Mexico; observations at Reagan National",
  requests: [
    { name: "dc_forecast", endpoint: "forecast", params: { lat: 38.8894, lon: -77.0352 } },
    { name: "nm_alerts", endpoint: "alerts_active", params: { area: "NM" } },
    { name: "dca_obs", endpoint: "observations", params: { station: "KDCA", limit: 3 }, max_rows: 3 },
    { name: "dc_stations", endpoint: "stations_near", params: { lat: 38.8894, lon: -77.0352 }, max_rows: 3 }] };

beforeAll(() => isolate());

describe("nws", () => {
  it("the spec is valid (api route)", async () => {
    expect(gr.checkSpec(await load(SRC), SPEC)).toEqual([]);
  });

  it("fetches forecast, alerts, observations and stations", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.summary.route).toBe("api");
    const fc = csv(s, SRC, "dc_forecast");
    expect(fc.length).toBe(14);
    expect(fc[0].name).toBe("This Afternoon");
    expect(fc[0].temperature).toBe("71");
    expect(fc[0].office).toBe("LWX");
    expect(fc[0].grid_x).toBe("97");
    const al = csv(s, SRC, "nm_alerts");
    expect(al[0].id.startsWith("urn:oid:")).toBe(true);
    expect(al[0]).not.toHaveProperty("geometry.coordinates");
    const obs = csv(s, SRC, "dca_obs");
    expect(obs[0].stationId).toBe("KDCA");
    expect(obs[0]["temperature.unitCode"]).toBe("wmoUnit:degC");
    const st = csv(s, SRC, "dc_stations");
    expect(st[0].stationIdentifier).toBe("KDCA");
    expect(st[0].latitude).toBe("38.84833");
  });

  it("a missing lon is invalid_request", async () => {
    const spec = { requests: [{ name: "x", endpoint: "forecast", params: { lat: 38.9 } }] };
    const s = newSession();
    fixtures(SRC);
    await prepare(s, SRC, spec);
    expect((await failure(T.fetchData(s, { source: SRC, spec }))).code).toBe("invalid_request");
  });

  it("the manual bundle's forecast link says which page to save", async () => {
    const b: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec: SPEC }] });
    expect(b.items[0].url).toBe("https://api.weather.gov/points/38.8894,-77.0352");
    const items = gr.manualItems(await load(SRC), SPEC);
    expect((await load(SRC)).adapter!.manualItems!(SPEC, await load(SRC))[0].note).toContain("properties.forecast");
    expect(items.length).toBe(b.items.length);
  });
});
