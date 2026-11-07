/** FBI Crime Data Explorer: ported from tests/sources/fbi/test_fbi.py (same fixtures and values). */
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

// Fixtures recorded live from api.usa.gov/crime/fbi/cde on 2026-10-20 (key dropped from the URLs).
const SPEC = { description: "Violent crime, United States, 2020-2022; Delaware agencies; hate crimes; police employees",
  requests: [{ name: "violent_us", endpoint: "summarized_national", params: { offense: "V", from: "2020", to: "2022" } },
    { name: "de_agencies", endpoint: "agencies_by_state", params: { state: "de" } },
    { name: "hate_us", endpoint: "hate_crime_national", params: { from: "01-2022", to: "12-2023" } },
    { name: "employees_us", endpoint: "pe_national", params: { from: 2021, to: 2023 } }] };

const set = (xs: string[]) => new Set(xs);

describe("fbi", () => {
  it("takes the api route without a key (DEMO_KEY is used)", async () => {
    const r = await fetchOk(newSession(), "fbi", SPEC);
    expect(r.summary.route).toBe("api");
  });

  it("fetches one long table", async () => {
    const s = newSession();
    const r = await fetchOk(s, "fbi", SPEC);
    expect(r.status).toBe("ok");
    const rows = csv(s, "fbi", "violent_us");
    expect(Object.keys(rows[0]).slice(0, 7)).toEqual(["section", "series", "key", "period", "year", "month", "value"]);
    const jan = rows.filter((x) => x.section === "offenses/actuals" && x.series === "United States Offenses" && x.period === "2020-01");
    expect(jan[0].value).toBe("93464");
    const cov = Object.fromEntries(rows.filter((x) => x.section === "tooltips/Percent of Population Coverage").map((x) => [x.period, x.value]));
    expect(cov["2021-06"]).toBe("77.06"); // NIBRS transition: coverage dip
    const rate = rows.filter((x) => x.section === "offenses/rates" && x.period === "2020-01" && x.series === "United States Offenses")[0];
    expect(rate.unit).toBe("Offenses per 100,000 people");
    const ag = csv(s, "fbi", "de_agencies");
    expect(ag.map((a) => a.ori)).toContain("DE0010100");
    const hate = csv(s, "fbi", "hate_us");
    expect(hate.some((h) => h.series === "bias_category" && h.key === "Religion")).toBe(true);
    // totals have no period of their own: each row names the span it was summed over
    expect(set(hate.map((h) => [h.period, h.span_from, h.span_to].join("|")))).toEqual(set(["|2022-01|2023-12"]));
    expect(set(rows.map((x) => [x.span_from, x.span_to].join("|")))).toEqual(set(["2020-01|2022-12"]));
    const pe = csv(s, "fbi", "employees_us");
    expect(pe.filter((p) => p.series === "Male Officers").map((p) => p.value)).toContain("651534");
    expect(set(pe.map((p) => [p.span_from, p.span_to].join("|")))).toEqual(set(["2021|2023"]));
  });

  it("hate crime counts carry coverage", async () => {
    // source.md: type=totals has no participation figure; type=counts returns monthly coverage.
    // Fixture r005 recorded live (keyless, DEMO_KEY dropped from the URL) on 2026-10-22.
    const spec = { description: "Anti-Asian hate crime incidents, monthly with coverage, 2022",
      requests: [{ name: "anti_asian_2022", endpoint: "hate_crime_bias_national",
        params: { bias: "14", from: "01-2022", to: "12-2022", type: "counts" } }] };
    const s = newSession();
    expect((await fetchOk(s, "fbi", spec)).status).toBe("ok");
    const rows = csv(s, "fbi", "anti_asian_2022");
    const cov = rows.filter((x) => x.section === "tooltips/Percent of Population Coverage");
    expect(cov.map((x) => x.period).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `2022-${String(i + 1).padStart(2, "0")}`));
    expect(cov.every((x) => Number(x.value) > 0 && Number(x.value) <= 100)).toBe(true);
    expect(rows.some((x) => x.section === "populations/participated_population")).toBe(true);
    const s2 = newSession();
    await fetchOk(s2, "fbi", SPEC);
    expect(csv(s2, "fbi", "hate_us").some((h) => h.section.includes("Coverage"))).toBe(false); // totals: no coverage section
  });

  it("a bad date is a spec problem", async () => {
    const bad = { requests: [{ name: "x", endpoint: "summarized_national", params: { offense: "V", from: "2020-01", to: "2022" } }] };
    expect(gr.checkSpec(await load("fbi"), bad).length).toBeGreaterThan(0);
  });

  it("a bad offense is a spec problem", async () => {
    const bad = { requests: [{ name: "x", endpoint: "summarized_national", params: { offense: "MURDER", from: "2020", to: "2022" } }] };
    expect(gr.checkSpec(await load("fbi"), bad).length).toBeGreaterThan(0);
  });

  it("manual links use DEMO_KEY and converted dates", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "fbi", spec: SPEC }] });
    const urls = r.items.map((i: any) => i.url);
    expect(urls).toContain("https://api.usa.gov/crime/fbi/cde/summarized/national/V?from=01-2020&to=12-2022&API_KEY=DEMO_KEY");
    expect(urls.some((u: string) => u.includes("/agency/byStateAbbr/DE?"))).toBe(true);
  });
});
