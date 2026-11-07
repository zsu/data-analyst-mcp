/** bts: ported from the Python skill's tests/sources/bts/test_bts.py. Fixtures r001/r002 were recorded from
 * data.bts.gov on 2026-10-20. */
import { beforeAll, describe, expect, it } from "vitest";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SPEC = { description: "TSI freight, gasoline price and airline passengers, first half of 2024; Texas truck crossings, January 2025",
  requests: [
    { name: "tsi_2024h1", endpoint: "query", params: { dataset: "monthly_stats",
      $select: "date, transportation_services_index_freight, highway_fuel_prices_regular, " +
        "u_s_airline_traffic_total_non_seasonally_adjusted",
      $where: "date >= '2024-01-01' AND date <= '2024-06-01'", $order: "date" } },
    { name: "tx_trucks_2025_01", endpoint: "query", params: { dataset: "border_crossings", $select: "port_name, sum(value) AS trucks",
      $where: "state = 'Texas' AND measure = 'Trucks' AND date = '2025-01-01T00:00:00'", $group: "port_name", $order: "trucks DESC" } }] };

beforeAll(() => isolate());

describe("bts", () => {
  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "bts", SPEC);
    expect(r.summary.route).toBe("api");
    const rows = csv(s, "bts", "tsi_2024h1");
    expect(rows.length).toBe(6);
    expect(rows[0].date).toBe("2024-01-01T00:00:00.000");
    expect(rows[0].highway_fuel_prices_regular).toBe("3.075");
    const ports = csv(s, "bts", "tx_trucks_2025_01");
    expect(ports[0].port_name).toBe("Laredo");
    expect(ports[0].trucks).toBe("239825");
  });

  it("search finds columns", async () => {
    const r: any = await T.requestSchema(newSession(), { source: "bts", search: "transit ridership bus" });
    expect(r.results.map((h: any) => h.column)).toContain("system_use_transit_ridership_1");
  });

  it("an unknown endpoint is a spec problem", async () => {
    const s = newSession();
    fixtures("bts");
    const spec = { requests: [{ name: "x", endpoint: "nope", params: {} }] };
    await T.sourceBrief(s, { source: "bts" });
    await prepare(s, "bts", { requests: [] });
    s.sawSchema("bts", ["nope"]);
    expect((await failure(T.fetchData(s, { source: "bts", spec }))).code).toBe("invalid_request");
  });

  it("manual bundle links", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "bts", spec: SPEC }] });
    expect(r.items[0].url.startsWith("https://data.bts.gov/resource/crem-w557.json?")).toBe(true);
  });
});
