/** census-geocoder (new in this port; fixtures recorded live 2026-11-07). */
import { beforeAll, describe, expect, it } from "vitest";
import * as T from "../../src/tools.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

const SPEC = { description: "geocoder fixtures", requests: [
  { name: "white_house", endpoint: "address", params: { address: "1600 Pennsylvania Ave NW, Washington, DC 20500" } },
  { name: "no_match", endpoint: "address", params: { address: "1 Nowhere Lane, Nowhere, ZZ 00000" }, allow_empty: true },
  { name: "baltimore_point", endpoint: "coordinates", params: { x: -76.6122, y: 39.2904, vintage: "Census2020_Current" } },
  { name: "location_only", endpoint: "address_location", params: { address: "1600 Pennsylvania Ave NW, Washington, DC 20500" } },
  { name: "benchmarks", endpoint: "benchmarks", params: {} }] };

beforeAll(() => isolate());

describe("census-geocoder", () => {
  it("geocodes an address to its join keys and every layer", async () => {
    const s = newSession();
    const r = await fetchOk(s, "census-geocoder", SPEC);
    expect(r.status).toBe("ok");
    const [wh] = csv(s, "census-geocoder", "white_house");
    expect(wh.matched_address).toBe("1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500");
    expect([wh.state_fips, wh.state_usps, wh.county_fips]).toEqual(["11", "DC", "11001"]);
    expect(wh.tract_geoid).toMatch(/^11001\d{6}$/);
    expect(wh.block_geoid.startsWith(wh.tract_geoid)).toBe(true);
    expect(Object.keys(wh).slice(0, 9)).toEqual(["input", "matched_address", "lon", "lat", "tiger_line_id", "tiger_side",
      "state_fips", "state_usps", "county_fips"]);
    expect(Number(wh.lon)).toBeCloseTo(-77.035, 2);
  });

  it("an unmatched address is an empty table, a point gets its geographies, other endpoints pass through", async () => {
    const s = newSession();
    await fetchOk(s, "census-geocoder", SPEC);
    expect(csv(s, "census-geocoder", "no_match")).toEqual([]);
    const [pt] = csv(s, "census-geocoder", "baltimore_point");
    expect([pt.state_fips, pt.county_fips]).toEqual(["24", "24510"]);
    expect(pt.tract_geoid).toMatch(/^24510\d{6}$/);
    const [loc] = csv(s, "census-geocoder", "location_only");
    expect(loc.matched_address).toContain("1600 PENNSYLVANIA");
    expect(loc.state_fips).toBe("");
    expect(csv(s, "census-geocoder", "benchmarks").map((b) => b.benchmarkName)).toContain("Public_AR_Current");
  });

  it("briefs with its cross-checks and the Census notice", async () => {
    const b: any = await T.sourceBrief(newSession(), { source: "census-geocoder" });
    expect(b.rules.notices[0]).toContain("not endorsed or certified");
    expect(b.questions_to_ask.length).toBe(1);
    expect(b.paired_with.map((p: any) => p.primary[0])).toContain("census-geocoder");
  });
});
