/**
 * aspe: fixtures recorded from aspe.hhs.gov (Poverty Guidelines API) on 2026-11-25: 2024-2026 for 1-8 persons
 * (us), 2015 and 2025 for 4 and 10 persons in us/ak/hi, and 2099 (a year the API does not have; it answers 2026).
 */
import { beforeAll, describe, expect, it } from "vitest";
import adapter, { expand, guidelineRow } from "../../src/adapters/aspe.js";
import { load } from "../../src/core/packs.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";
import * as T from "../../src/tools.js";

beforeAll(() => isolate());

const spec = (params: Record<string, unknown>) => ({ description: "poverty guidelines",
  requests: [{ name: "fpl", endpoint: "guidelines", params }] });

describe("aspe", () => {
  it("fetches one row per year and household size", async () => {
    const s = newSession();
    const r = await fetchOk(s, "aspe", spec({ year: "2024-2026", state: "us", household_size: "1-8" }));
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r.citation)).toMatch(/Assistant Secretary for Planning and Evaluation/);
    const rows = csv(s, "aspe", "fpl");
    expect(rows.length).toBe(24);
    expect(Object.keys(rows[0])).toEqual(["year", "state", "area", "household_size", "poverty_guideline"]);
    const four = rows.filter((x) => x.household_size === "4").map((x) => [x.year, x.poverty_guideline]);
    expect(four).toEqual([["2024", "31200"], ["2025", "32150"], ["2026", "33000"]]);
  });

  it("covers Alaska and Hawaii and sizes above 8", async () => {
    const s = newSession();
    await fetchOk(s, "aspe", { description: "x", requests: [{ name: "fpl4", endpoint: "guidelines",
      params: { year: [2015, 2025], state: ["us", "ak", "hi"], household_size: [4, 10] } }] });
    const rows = csv(s, "aspe", "fpl4");
    expect(rows.length).toBe(12);
    const at = (y: string, st: string, n: string) => rows.find((x) => x.year === y && x.state === st && x.household_size === n)!;
    expect(at("2015", "US", "4").poverty_guideline).toBe("24250");
    expect(at("2015", "AK", "4").area).toBe("Alaska");
    expect(Number(at("2015", "AK", "4").poverty_guideline)).toBeGreaterThan(Number(at("2015", "US", "4").poverty_guideline));
  });

  it("fails on a year the API does not have instead of taking the latest year", async () => {
    const s = newSession();
    fixtures("aspe");
    const sp = spec({ year: 2099, household_size: 2 });
    await prepare(s, "aspe", sp);
    const f = await failure(T.fetchData(s, { source: "aspe", spec: sp }));
    expect(f.code).toBeTruthy();
    expect(f.fix).toBeTruthy();
    expect(JSON.stringify(f)).toMatch(/no HHS poverty guidelines for 2099/);
  });

  it("refuses values the API would silently replace", async () => {
    const p = await load("aspe");
    const bad = adapter.checkSpec!(spec({ year: [1970, "20x5"], state: "pr", household_size: [0, 3] }) as any, p);
    expect(bad.join(" ")).toMatch(/year 1970, 20x5/);
    expect(bad.join(" ")).toMatch(/state pr/);
    expect(bad.join(" ")).toMatch(/household_size 0/);
    expect(adapter.checkSpec!(spec({}) as any, p).join(" ")).toMatch(/year is required/);
    expect(adapter.checkSpec!(spec({ year: "2015-2025", state: ["US", "hi"] }) as any, p)).toEqual([]);
  });

  it("expands lists and ranges, and checks each reply", () => {
    expect(expand("2015-2017")).toEqual(["2015", "2016", "2017"]);
    expect(expand([4, "4", 9])).toEqual(["4", "9"]);
    expect(() => guidelineRow({ year: "2024", state: "ak", household_size: "2" },
      { year: "2024", state: "us", household_size: "2", income: "20440" })).toThrow(/not the guideline asked for/);
    expect(guidelineRow({ year: "2024", state: "us", household_size: "9" },
      { year: "2024", state: "us", household_size: "9", income: 58100 })).toMatchObject({ state: "US", poverty_guideline: 58100 });
  });
});
