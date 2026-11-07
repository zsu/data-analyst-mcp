/**
 * fdic: ported from the Python skill's tests/sources/fdic/test_fdic.py. Fixtures r001-r003 were recorded from
 * api.fdic.gov on 2026-10-20, r004-r005 on 2026-10-22.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SPEC = { description: "Bank failures in 2023; Wells Fargo Bank quarterly financials, 2024; Wyoming summary, 2025",
  requests: [
    { name: "failures_2023", endpoint: "failures", params: { filters: 'FAILYR:2023 AND RESTYPE:"FAILURE"',
      fields: "CERT,NAME,CITY,PSTALP,FAILDATE,QBFASSET,QBFDEP,COST,RESTYPE1", sort_order: "ASC" } },
    { name: "wells_2024", endpoint: "financials", params: { filters: "CERT:3511 AND REPDTE:[20240101 TO 20241231]",
      fields: "CERT,REPDTE,ASSET,DEP,NETINC,ROA", sort_order: "ASC" } },
    { name: "wy_summary_2025", endpoint: "summary", params: { filters: 'STNAME:"Wyoming" AND YEAR:2025',
      fields: "STNAME,YEAR,CB_SI,BANKS,ASSET,DEP,NETINC" } }] };

beforeAll(() => isolate());

describe("fdic", () => {
  it("fetch unwraps the records and adds ISO dates", async () => {
    const s = newSession();
    const r = await fetchOk(s, "fdic", SPEC);
    expect(r.summary.route).toBe("api");
    const fails = csv(s, "fdic", "failures_2023");
    expect(fails.length).toBe(5);
    const svb = fails[0];
    expect(svb.NAME).toBe("SILICON VALLEY BANK");
    expect(svb.FAILDATE).toBe("3/10/2023");
    expect(svb.FAILDATE_iso).toBe("2023-03-10");
    expect(svb).not.toHaveProperty("data.NAME");
    expect(svb).not.toHaveProperty("score");
    const q = csv(s, "fdic", "wells_2024");
    expect(q.map((x) => x.REPDTE_iso)).toEqual(["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31"]);
    expect(q[0].NETINC).toBe("5363000"); // thousands of dollars, year-to-date
    expect(csv(s, "fdic", "wy_summary_2025").map((x) => x.CB_SI).sort()).toEqual(["CB", "SI"]);
  });

  it("financials without fields is a spec problem", async () => {
    const s = newSession();
    fixtures("fdic");
    const spec = { requests: [{ name: "x", endpoint: "financials", params: { filters: "CERT:3511" } }] };
    await prepare(s, "fdic", spec);
    expect((await failure(T.fetchData(s, { source: "fdic", spec }))).code).toBe("invalid_request");
  });

  it("manual links are CSV", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "fdic", spec: SPEC }] });
    expect(r.items.every((i: any) => i.url.includes("format=csv") && i.filename.endsWith(".csv"))).toBe(true);
  });

  it("searches fields", async () => {
    const r: any = await T.requestSchema(newSession(), { source: "fdic", search: "charter class" });
    expect(r.results.map((h: any) => h.field)).toContain("BKCLASS");
  });

  it("aggregations on failures and history", async () => {
    const spec = { requests: [
      { name: "ga_failures_by_year", endpoint: "failures", params: { filters: "PSTALP:GA AND FAILYR:[2008 TO 2013]", agg_by: "FAILYR",
        agg_sum_fields: "QBFASSET,COST", agg_term_fields: "RESTYPE1", agg_limit: 20 } },
      { name: "vt_history_by_code", endpoint: "history", params: { filters: "PSTALP:VT", agg_by: "CHANGECODE", agg_term_fields: "CLASS",
        agg_limit: 10 } }] };
    const s = newSession();
    const r = await fetchOk(s, "fdic", spec);
    expect(r.summary.route).toBe("api");
    const fy = csv(s, "fdic", "ga_failures_by_year");
    expect(fy.map((x) => x.FAILYR).sort()).toEqual(["2008", "2009", "2010", "2011", "2012", "2013"]);
    for (const c of ["count", "sum_QBFASSET", "sum_COST", "count_RESTYPE1_PA"]) expect(fy[0]).toHaveProperty(c);
    expect(fy.reduce((n, x) => n + Number(x.count), 0)).toBe(87);
    const hist = csv(s, "fdic", "vt_history_by_code");
    expect(hist.length).toBe(10);
    expect(hist[0]).toHaveProperty("count_CLASS_N");
    const eps = (await load("fdic")).endpoints.endpoints;
    for (const name of ["failures", "history", "financials", "sod", "summary"]) {
      for (const p of ["agg_by", "agg_sum_fields", "agg_term_fields", "agg_limit"]) expect(eps[name].params, name).toHaveProperty(p);
    }
  });
});
