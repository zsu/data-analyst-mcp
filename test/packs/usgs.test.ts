/** USGS: ported from tests/sources/usgs/test_usgs.py (same fixtures and values). */
import { beforeAll, describe, expect, it } from "vitest";
import ad from "../../src/adapters/usgs.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

// Fixtures recorded live from earthquake.usgs.gov and api.waterdata.usgs.gov (ogcapi/v1) on 2026-10-20.
const SPEC = { description: "M6+ earthquakes, January 2024; 2024 count; Potomac daily discharge; Vermont stream sites",
  requests: [
    { name: "m6_jan2024", endpoint: "earthquakes", params: { starttime: "2024-01-01", endtime: "2024-01-31", minmagnitude: 6 }, max_rows: 3 },
    { name: "m6_2024_count", endpoint: "earthquake_count", params: { starttime: "2024-01-01", endtime: "2024-12-31", minmagnitude: 6 } },
    { name: "potomac_daily", endpoint: "water", params: { collection: "streamflow_daily", monitoring_location_id: "01646500",
      parameter_code: "00060", statistic_id: "00003", time: "2024-01-01/2024-01-05" }, max_rows: 3 },
    { name: "vt_sites", endpoint: "water", params: { collection: "monitoring-locations", state_code: "Vermont", site_type_code: "ST",
      properties: "monitoring_location_number,monitoring_location_name,county_name,drainage_area" }, max_rows: 2 }] };

const problems = async (spec: any) => gr.checkSpec(await load("usgs"), spec);

describe("usgs", () => {
  it("is valid and takes the api route", async () => {
    expect(await problems(SPEC)).toEqual([]);
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "usgs", SPEC);
    expect(r.summary.route).toBe("api");
    const eq = csv(s, "usgs", "m6_jan2024");
    expect(eq[0].id).toBe("us7000lui3");
    expect(eq[0].mag).toBe("6.5");
    expect(eq[0].time_utc).toBe("2024-01-28T09:38:56.538Z");
    expect(eq[0].depth_km).toBe("621.081");
    expect(csv(s, "usgs", "m6_2024_count")[0].count).toBe("99");
    const q = Object.fromEntries(csv(s, "usgs", "potomac_daily").map((x) => [x.time, x.value]));
    expect(q["2024-01-03"]).toBe("6860");
    const sites = csv(s, "usgs", "vt_sites");
    expect(sites[0].monitoring_location_number).toBe("01129400");
    expect(sites[0].latitude).toBe("45.0039350382815");
  });

  it("manual bundle links each host", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "usgs", spec: SPEC }] });
    const urls: string[] = r.items.map((i: any) => i.url);
    expect(urls[0].startsWith("https://earthquake.usgs.gov/fdsnws/event/1/query?")).toBe(true);
    expect(urls[2]).toContain("monitoring_location_id=USGS-01646500");
    expect(urls[2]).toContain("/collections/daily/items?");
  });

  it("a site filter on the sites collection is id", () => {
    // monitoring-locations answers HTTP 400 to monitoring_location_id; its site key is `id` (live 2026-10).
    const ep = { path: "/collections/{collection}/items" };
    const sites: any = ad.beforeRequest!({} as any, ep, { collection: "monitoring-locations", monitoring_location_id: "04086600,usgs-05420500" });
    expect(sites.id).toBe("USGS-04086600,USGS-05420500");
    expect(sites).not.toHaveProperty("monitoring_location_id");
    const data: any = ad.beforeRequest!({} as any, ep, { collection: "peaks", monitoring_location_id: "04086600" });
    expect(data.monitoring_location_id).toBe("USGS-04086600"); // data collections keep it
  });

  it("an eventid's single Feature is one row", async () => {
    // With `eventid` the event service answers one GeoJSON Feature, not a FeatureCollection (live 2026-10).
    const ep = (await load("usgs")).endpoints.endpoints.earthquakes;
    const body = { type: "Feature", id: "zz00000001", // synthetic event
      properties: { mag: 4.2, place: "test place", time: 1700000000000, updated: 1700000100000,
        products: { origin: [{ id: "p1", contents: { a: { url: "x" } } }] } },
      geometry: { type: "Point", coordinates: [-120.5, 36.25, 8.1] } };
    const calls: any[] = [];
    const fake = { get: async (_p: string, query?: any) => {
      calls.push(query);
      return { json: () => body };
    } };
    const quake = ad.quake as (c: any, ep: any, params: any, max: any) => Promise<[any[], boolean]>;
    let [rows, more] = await quake(fake, ep, { ...ep.defaults, eventid: "zz00000001" }, null);
    expect(more).toBe(false);
    expect(calls[0].eventid).toBe("zz00000001");
    rows = ad.normalize!({} as any, ep, rows);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("zz00000001");
    expect(rows[0].depth_km).toBe("8.1");
    expect(rows[0].time_utc).toBe("2023-11-14T22:13:20.000Z");
    expect(Object.keys(rows[0]).filter((k) => k.startsWith("products"))).toEqual([]);
    expect((ad.features as (d: any) => any[])({ type: "FeatureCollection", features: [body, body] }).length).toBe(2);
  });

  it("antimeridian boxes", async () => {
    // one box crossing 180 has maxlongitude above 180 (accepted); min above max is refused, with the +360 form
    // only for an east-to-west pair and "swapped" otherwise; separate boxes on either side stay valid
    const base = { starttime: "2023-01-01", endtime: "2023-02-01", minmagnitude: 4 };
    const box = (name: string, lo: number, hi: number, la = [-30, -10]) => ({ name, endpoint: "earthquakes",
      params: { ...base, minlatitude: la[0], maxlatitude: la[1], minlongitude: lo, maxlongitude: hi } });
    expect(await problems({ requests: [box("arc", 170, 190)] })).toEqual([]);
    let p = (await problems({ requests: [box("arc", 170, -170)] })).join("; ");
    expect(p).toContain("maxlongitude 190");
    p = (await problems({ requests: [box("x", -100, -120)] })).join("; ");
    expect(p).toContain("swapped");
    expect(p).not.toContain("above 180");
    expect(await problems({ requests: [box("north", -180, 180, [0, 90]), box("south", -180, 180, [-90, 0]),
      box("w", 150, 180, [40, 60]), box("e", -180, -170, [-25, -15])] })).toEqual([]);
  });

  it("an unknown endpoint is a spec problem", async () => {
    expect((await problems({ requests: [{ name: "x", endpoint: "nwis_iv", params: {} }] })).length).toBeGreaterThan(0);
  });
});
