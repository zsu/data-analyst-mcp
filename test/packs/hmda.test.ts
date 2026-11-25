/**
 * hmda: fixtures recorded from ffiec.cfpb.gov (HMDA Data Browser API) on 2026-11-25: FHA, VA and USDA originations
 * nationwide 2022-2024; FHA originations and denials in TX and OH, 2023; FHA originations in an MSA code (35620,
 * which answers 0) and a division code (35614), 2023.
 */
import { beforeAll, describe, expect, it } from "vitest";
import adapter, { aggregationRow, expand } from "../../src/adapters/hmda.js";
import { load } from "../../src/core/packs.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

const req = (endpoint: string, params: Record<string, unknown>, name = "h") =>
  ({ description: "HMDA", requests: [{ name, endpoint, params }] });

describe("hmda", () => {
  it("makes one call per year and adds the year the API leaves out", async () => {
    const s = newSession();
    const r = await fetchOk(s, "hmda", req("nationwide", { years: "2022-2024", actions_taken: 1, loan_types: [2, 3, 4] }, "govt"));
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r.citation)).toMatch(/Federal Financial Institutions Examination Council/);
    const rows = csv(s, "hmda", "govt");
    expect(rows.length).toBe(9);
    expect(Object.keys(rows[0])).toEqual(["year", "geography", "geography_code", "actions_taken", "actions_taken_label",
      "loan_types", "loan_types_label", "count", "loan_amount"]);
    const fha23 = rows.find((x) => x.year === "2023" && x.loan_types === "2")!;
    expect([fha23.geography, fha23.loan_types_label, fha23.count, fha23.loan_amount])
      .toEqual(["nation", "FHA-insured", "754785", "221850785000"]);
    expect(new Set(rows.map((x) => x.year))).toEqual(new Set(["2022", "2023", "2024"]));
  });

  it("makes one call per state and keeps each filter value apart", async () => {
    const s = newSession();
    await fetchOk(s, "hmda", req("aggregations", { years: 2023, states: ["tx", "OH"], actions_taken: [1, 3], loan_types: 2 }, "st"));
    const rows = csv(s, "hmda", "st");
    expect(rows.length).toBe(4);
    expect(new Set(rows.map((x) => `${x.geography_code}/${x.actions_taken}`))).toEqual(new Set(["TX/1", "TX/3", "OH/1", "OH/3"]));
    expect(rows.every((x) => x.geography === "state" && x.loan_types === "2")).toBe(true);
  });

  it("notes a metro code that answers 0", async () => {
    const s = newSession();
    const r = await fetchOk(s, "hmda", req("aggregations", { years: 2023, msamds: ["35620", "35614"], actions_taken: 1, loan_types: 2 }, "m"));
    const rows = csv(s, "hmda", "m");
    expect(rows.find((x) => x.geography_code === "35620")!.count).toBe("0");
    expect(Number(rows.find((x) => x.geography_code === "35614")!.count)).toBeGreaterThan(0);
    expect(JSON.stringify(r.notes)).toMatch(/count 0 for msamd 35620 \(2023\).*metropolitan division/);
  });

  it("refuses specs the API would sum, ignore or refuse", async () => {
    const p = await load("hmda");
    const bad = (params: Record<string, unknown>, ep = "aggregations") => adapter.checkSpec!(req(ep, params) as any, p).join(" ");
    expect(bad({ states: "CA", loan_types: 2 })).toMatch(/years is required/);
    expect(bad({ years: 2017, states: "CA", actions_taken: 1 })).toMatch(/years 2017/);
    expect(bad({ years: 2023, states: "CA" })).toMatch(/actions_taken is required/);
    expect(bad({ years: 2023, actions_taken: 1 })).toMatch(/exactly one of states, counties or msamds/);
    expect(bad({ years: 2023, states: "CA", counties: "06037", actions_taken: 1 })).toMatch(/exactly one/);
    expect(bad({ years: 2023, counties: "6037", actions_taken: 1 })).toMatch(/counties 6037/);
    expect(bad({ years: 2023, states: "CA", actions_taken: 1, loan_types: 2, loan_purposes: 1 })).toMatch(/at most two filters/);
    expect(bad({ years: 2023, states: "CA", actions_taken: 1, ages: "25-34" })).toMatch(/ages is not applied/);
    expect(bad({ years: 2023, states: "CA", actions_taken: 1 }, "nationwide")).toMatch(/nationwide takes no states/);
    expect(bad({ years: "2018-2024", states: ["CA", "TX"], actions_taken: 1, loan_types: [1, 2] })).toBe("");
  });

  it("checks each reply row against the filters asked", () => {
    expect(expand("2018-2020", true)).toEqual(["2018", "2019", "2020"]);
    expect(expand("1,2")).toEqual(["1", "2"]);
    const ctx = { year: "2023", level: "state", code: "CA", filters: { actions_taken: ["1"], sexes: ["Joint"] } };
    expect(() => aggregationRow(ctx, { count: 5, sum: "1.0E6", actions_taken: "1" })).toThrow(/sexes=Joint was not applied/);
    expect(aggregationRow(ctx, { count: 5, sum: "2.3845265E10", actions_taken: "1", sexes: "Joint" }))
      .toMatchObject({ year: 2023, actions_taken_label: "Loan originated", sexes: "Joint", count: 5, loan_amount: 23845265000 });
  });
});
