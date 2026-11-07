/** College Scorecard: ported from tests/sources/college-scorecard/test_college_scorecard.py (same fixtures and values). */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/college-scorecard.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

// Fixtures recorded live from api.data.gov/ed/collegescorecard/v1 on 2026-10-20 (key dropped from the URLs).
const SPEC = { description: "Delaware and Maryland public bachelor's colleges by 10-year earnings; MIT selected measures",
  requests: [{ name: "de_md_public", endpoint: "schools", params: { state: "DE,MD", ownership: 1, predominant_degree: 3,
    sort: "latest.earnings.10_yrs_after_entry.median:desc" } },
  { name: "mit", endpoint: "schools",
    params: { id: 166683, fields: ["name", "admission_rate", "net_price", "earnings_10yr", "completion_rate"] } }] };

describe("college-scorecard", () => {
  it("takes the api route without a key", async () => {
    const s = newSession();
    const r = await fetchOk(s, "college-scorecard", SPEC);
    expect(r.summary.route).toBe("api");
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "college-scorecard", SPEC);
    expect(r.status).toBe("ok");
    const rows = csv(s, "college-scorecard", "de_md_public");
    expect(rows.length).toBe(16);
    const ud = rows.filter((x) => x.id === "130943")[0];
    expect(ud["school.name"]).toBe("University of Delaware");
    expect(ud["latest.earnings.10_yrs_after_entry.median"]).toBe("83800");
    expect(ud["school.ownership_label"]).toBe("Public");
    expect(rows[rows.length - 1]["latest.earnings.10_yrs_after_entry.median"]).toBe(""); // nulls sort last
    const mit = csv(s, "college-scorecard", "mit")[0];
    expect(mit["latest.admissions.admission_rate.overall"]).toBe("0.0455"); // alias resolved
  });

  it("seven-year earnings alias and nonzero selectivity", async () => {
    const spec = { description: "Two Big Ten universities: 6-, 7- and 10-year earnings; schools admitting under 8% excluding zeros",
      requests: [{ name: "earn_678", endpoint: "schools",
        params: { id: "170976,145637", fields: ["name", "earnings_6yr", "earnings_7yr", "earnings_10yr"] } },
      { name: "selective_nonzero", endpoint: "schools",
        params: { "latest.admissions.admission_rate.overall__range": "0.001..0.08", fields: ["name", "admission_rate"],
          sort: "latest.admissions.admission_rate.overall:asc" }, max_rows: 100 }] };
    const s = newSession();
    const r = await fetchOk(s, "college-scorecard", spec);
    expect(r.status).toBe("ok");
    const earn = csv(s, "college-scorecard", "earn_678");
    expect(earn.length).toBe(2);
    expect(earn.every((x) => /^\d+$/.test(x["latest.earnings.7_yrs_after_entry.median"]))).toBe(true);
    const sel = csv(s, "college-scorecard", "selective_nonzero").map((x) => Number(x["latest.admissions.admission_rate.overall"]));
    expect(sel.length > 0 && sel.every((v) => v > 0 && v <= 0.08)).toBe(true);
    expect(sel).toEqual([...sel].sort((a, b) => a - b));
  });

  it("sort takes the short names", () => {
    const p = adapter.beforeRequest!({} as any, {}, { sort: "name:asc,latest.student.size:desc" }) as any;
    expect(p.sort).toBe("school.name:asc,latest.student.size:desc");
    expect((adapter.beforeRequest!({} as any, {}, { sort: "state" }) as any).sort).toBe("school.state");
  });

  it("paging params are a spec problem", async () => {
    const bad = { requests: [{ name: "x", endpoint: "schools", params: { state: "DE", per_page: 500 } }] };
    expect(gr.checkSpec(await load("college-scorecard"), bad).length).toBeGreaterThan(0);
  });

  it("manual links use the demo key", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "college-scorecard", spec: SPEC }] });
    const items = r.items;
    expect(items.every((i: any) => i.url.includes("api_key=DEMO_KEY") && i.url.includes("fields=id%2C"))).toBe(true);
    expect(items.some((i: any) => i.url.includes("page=0&per_page=100"))).toBe(true);
  });
});
