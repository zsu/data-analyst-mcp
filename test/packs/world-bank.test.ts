/** World Bank: ported from tests/sources/world-bank/test_world_bank.py (same fixtures and values). Fixtures were
 * recorded live from api.worldbank.org on 2026-10-20 (r001: G7 GDP per capita PPP 2020-2023; r002: the HTTP 200
 * error the API returns for the archived indicator EN.ATM.CO2E.PC). */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/world-bank.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const SPEC = { description: "GDP per capita, PPP, G7 countries, 2020-2023",
  requests: [{ name: "g7_gdp_pc_ppp", endpoint: "indicator",
    params: { indicator: "gdp_per_capita_ppp", country: "g7", date: "2020:2023" } }] };

describe("world-bank", () => {
  it("takes the api route", async () => {
    const r = await fetchOk(newSession(), "world-bank", SPEC);
    expect(r.summary.route).toBe("api");
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "world-bank", SPEC);
    expect(r.status).toBe("ok");
    const rows = csv(s, "world-bank", "g7_gdp_pc_ppp");
    expect(rows.length).toBe(28);
    const us = rows.filter((x) => x.countryiso3code === "USA" && x.date === "2023");
    expect(us.length).toBe(1);
    expect(us[0].value.startsWith("8")).toBe(true); // about 80,000 international $
    expect(us[0]["indicator.id"]).toBe("NY.GDP.PCAP.PP.CD");
    expect(us[0].is_aggregate).toBe("N");
  });

  it("an archived indicator is an error", async () => {
    const s = newSession();
    const spec = { requests: [{ name: "co2_old", endpoint: "indicator",
      params: { indicator: "EN.ATM.CO2E.PC", country: "US", date: "2019:2020" } }] };
    fixtures("world-bank");
    await prepare(s, "world-bank", spec);
    const f = await failure(T.fetchData(s, { source: "world-bank", spec }));
    expect(f.message).toContain("archived");
  });

  it("the manual bundle resolves groups", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "world-bank", spec: SPEC }] });
    const url = r.items[0].url;
    expect(url).toContain("CA%3BFR%3BDE");
    expect(url).toContain("NY.GDP.PCAP.PP.CD");
  });

  it("searches the catalog offline", async () => {
    fixtures("world-bank");
    const r: any = await T.requestSchema(newSession(), { source: "world-bank", search: "health expenditure per capita" });
    expect(r.results[0].id).toBe("SH.XPD.CHEX.PC.CD");
  });

  it("takes a list of indicators", async () => {
    const spec = { requests: [{ name: "macro", endpoint: "indicator",
      params: { indicator: ["gdp_growth", "FP.CPI.TOTL.ZG"], country: "brics", mrnev: 3 } }] };
    const p = await load("world-bank");
    expect(gr.checkSpec(p, spec)).toEqual([]);
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "world-bank", spec }] });
    const url = r.items[0].url;
    expect(url).toContain("NY.GDP.MKTP.KD.ZG%3BFP.CPI.TOTL.ZG");
    expect(url).toContain("source=2");
    const ep = { path: "/country/{country}/indicator/{indicator}" };
    const q = adapter.beforeRequest!({} as any, ep, { indicator: ["SE.TER.ENRR", "unemployment"], country: "MX", source: "11" }) as any;
    expect([q.indicator, q.source]).toEqual(["SE.TER.ENRR;SL.UEM.TOTL.ZS", "11"]);
    expect(adapter.beforeRequest!({} as any, ep, { indicator: "fertility", country: "MX" })).not.toHaveProperty("source");
    const bad = { requests: [{ name: "b", endpoint: "indicator", params: { indicator: [["x"]], country: "MX" } }] };
    expect(gr.checkSpec(p, bad).length).toBeGreaterThan(0);
    const none = { requests: [{ name: "n", endpoint: "indicator", params: { country: "MX" } }] };
    expect(gr.checkSpec(p, none).length).toBeGreaterThan(0);
  });

  it("an unknown endpoint is a spec problem", async () => {
    expect(gr.checkSpec(await load("world-bank"), { requests: [{ name: "x", endpoint: "nope", params: {} }] }).length)
      .toBeGreaterThan(0);
  });
});
