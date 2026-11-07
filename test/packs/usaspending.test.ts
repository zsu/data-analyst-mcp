/** USAspending: ported from tests/sources/usaspending/test_usaspending.py (same fixtures and values). Fixtures were
 * recorded live from api.usaspending.gov on 2026-10-20: r001 Maryland obligations by awarding agency FY2024 (POST,
 * body paging), r002 NASA monthly obligations FY2024, r003 HHS budgetary resources, r004 broadband grants (5 fields),
 * r005 the HTTP 404 for a toptier code that does not exist. */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/usaspending.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const SPEC = { description: "Federal obligations in Maryland by awarding agency, FY2024",
  requests: [{ name: "md_by_agency_fy2024", endpoint: "by_category",
    params: { category: "awarding_agency", fiscal_year: 2024, state: "Maryland" }, max_rows: 10 },
  { name: "nasa_monthly_fy2024", endpoint: "over_time", params: { group: "month", fiscal_year: 2024, agency: "nasa" } },
  { name: "hhs_budget", endpoint: "agency_budgetary_resources", params: { toptier_code: "hhs" } },
  { name: "broadband_grants", endpoint: "awards",
    params: { award_type: "grants", fiscal_year: 2024, keyword: "broadband" }, max_rows: 5 }] };
const AWARDS = { description: "Broadband grants active in FY2024, largest first",
  requests: [{ name: "broadband_grants", endpoint: "awards",
    params: { award_type: "grants", fiscal_year: 2024, keyword: "broadband",
      fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date", "generated_internal_id"] },
    max_rows: 5 }] };

describe("usaspending", () => {
  it("the spec is valid and takes the api route", async () => {
    expect(gr.checkSpec(await load("usaspending"), SPEC)).toEqual([]);
    const spec = { description: SPEC.description, requests: SPEC.requests.slice(0, 3) };
    expect((await fetchOk(newSession(), "usaspending", spec)).summary.route).toBe("api");
  });

  it("fetches by category, over time and the budget", async () => {
    const s = newSession();
    const spec = { description: SPEC.description, requests: SPEC.requests.slice(0, 3) };
    const r = await fetchOk(s, "usaspending", spec);
    expect(["ok", "partial"]).toContain(r.status);
    const rows = csv(s, "usaspending", "md_by_agency_fy2024");
    expect(rows.length).toBe(10);
    expect(rows[0].code).toBe("SSA");
    expect(rows[0].amount).toBe("26899943426.5");
    const months = csv(s, "usaspending", "nasa_monthly_fy2024");
    expect(months.length).toBe(12);
    expect([months[0].fiscal_period, months[0].period_start]).toEqual(["FY2024 M01", "2023-10"]);
    const budget = Object.fromEntries(csv(s, "usaspending", "hhs_budget").map((b) => [b.fiscal_year, b]));
    expect(budget["2026"].agency_budgetary_resources).toBe("3709407922072.44");
  });

  it("fetches awards", async () => {
    const s = newSession();
    await fetchOk(s, "usaspending", AWARDS);
    const rows = csv(s, "usaspending", "broadband_grants");
    expect(rows.length).toBe(5);
    expect(rows[0].generated_internal_id).toBe("ASST_NON_4820B328_013");
    expect(rows[0].award_url.endsWith("ASST_NON_4820B328_013")).toBe(true);
  });

  it("errors are not swallowed", async () => {
    const s = newSession();
    const bad = { requests: [{ name: "bad", endpoint: "agency_budgetary_resources", params: { toptier_code: "999" } }] };
    fixtures("usaspending");
    await prepare(s, "usaspending", bad);
    const f = await failure(T.fetchData(s, { source: "usaspending", spec: bad }));
    expect(f.code).toBe("not_found");
  });

  it("refuses years before FY2008 and mixed award types", async () => {
    const p = await load("usaspending");
    const old = { requests: [{ name: "old", endpoint: "by_category", params: { category: "recipient", fiscal_year: 2007 } }] };
    expect(gr.checkSpec(p, old).join("; ")).toContain("FY2008");
    const mixed = { requests: [{ name: "mixed", endpoint: "awards", params: { award_type: ["A", "02"], fiscal_year: 2024 } }] };
    expect(gr.checkSpec(p, mixed).join("; ")).toContain("one group");
  });

  it("an unknown agency gets a did-you-mean", async () => {
    const bad = { requests: [{ name: "x", endpoint: "by_category",
      params: { category: "recipient", fiscal_year: 2024, agency: "Department" } }] };
    expect(gr.checkSpec(await load("usaspending"), bad).join("; ")).toContain("Did you mean");
  });

  it("the manual bundle posts with body paging", async () => {
    const items = adapter.manualItems!(SPEC, await load("usaspending"));
    const first = items[0];
    expect(first.method).toBe("POST");
    expect([first.body.page, first.body.limit]).toEqual([1, 100]);
    expect(first.body.filters.time_period).toEqual([{ start_date: "2023-10-01", end_date: "2024-09-30" }]);
    expect(first.body.filters.place_of_performance_locations).toEqual([{ country: "USA", state: "MD" }]);
    const budget = items.filter((i: any) => i.name.startsWith("hhs_budget#"))[0];
    expect(budget.url.endsWith("/agency/075/budgetary_resources/")).toBe(true);
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "usaspending", spec: SPEC }] });
    expect(r.items.length).toBe(items.length);
  });
});
