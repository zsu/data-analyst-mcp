/** GSA CALC+: ported from tests/sources/gsa-calc/test_gsa_calc.py (same fixtures and values). */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/gsa-calc.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { TEST_DIR, csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

// Fixtures recorded live from api.gsa.gov (CALC+ ceiling rates v3, keyless) on 2026-10-20 (r006, r007 on 2026-10-22).
const SPEC = { description: "Data scientist ceiling rates, master's degree, small business",
  requests: [{ name: "ds_ma_small", endpoint: "rates",
    params: { keyword: "data scientist", education_level: "MA", business_size: "S" }, max_rows: 30 },
  { name: "ds_stats", endpoint: "rate_stats", params: { keyword: "data scientist" } },
  { name: "ds_facets", endpoint: "rate_facets", params: { keyword: "data scientist", worksite: "customer" } },
  { name: "ds_titles", endpoint: "suggest_labor_category", params: { prefix: "data sci" } },
  { name: "ds_phd_export", endpoint: "rates_export",
    params: { keyword: "data scientist", education_level: "PHD", price_range: "150,200" } }] };

const problems = async (spec: any) => gr.checkSpec(await load("gsa-calc"), spec);

describe("gsa-calc", () => {
  it("is valid and takes the api route", async () => {
    expect(await problems(SPEC)).toEqual([]);
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "gsa-calc", SPEC);
    expect(r.summary.route).toBe("api");
    const rates = csv(s, "gsa-calc", "ds_ma_small");
    expect(rates.length).toBe(30);
    expect(rates[0].labor_category).toBe("Data Scientist");
    expect(rates[0].current_price).toBe("90.0");
    expect(rates[0]).not.toHaveProperty("_index");
    expect(rates.every((x) => x.education_level === "Masters" && x.business_size === "S")).toBe(true);
    expect(r.notes.some((n: string) => n.includes("10,000"))).toBe(true);
    const st = csv(s, "gsa-calc", "ds_stats")[0];
    expect(st.count).toBe("1470");
    expect(st.mean.startsWith("175.20")).toBe(true);
    const facets = csv(s, "gsa-calc", "ds_facets");
    const ws = Object.fromEntries(facets.filter((x) => x.facet === "worksite").map((x) => [x.key, x.doc_count]));
    expect(ws).toEqual({ Customer_Facility: "708" }); // worksite filter took effect
    expect(csv(s, "gsa-calc", "ds_titles")[0].key).toBe("Data Scientist");
    const ex = csv(s, "gsa-calc", "ds_phd_export");
    expect(ex.length).toBe(3);
    expect(ex[0].idv_piid).toBe("47QRAA25D0009"); // export columns renamed
    expect(ex[0].business_size).toBe("S"); // "small business" recoded
    expect(ex[0].current_price).toBe("176.75");
  });

  it("a bad filter value is a spec problem", async () => {
    expect((await problems({ requests: [{ name: "x", endpoint: "rates", params: { keyword: "analyst", worksite: "Both" } }] })).length)
      .toBeGreaterThan(0);
  });

  it("an empty export is no rows", async () => {
    // r006 (recorded 2026-10-22): an export with no matches is only the SEARCH/FILTER VALUES preamble.
    const spec = { requests: [{ name: "none_export", endpoint: "rates_export",
      params: { keyword: "qzxv nonexistent title", worksite: "virtual" } }] };
    const s = newSession();
    fixtures("gsa-calc");
    await prepare(s, "gsa-calc", spec);
    const f = await failure(T.fetchData(s, { source: "gsa-calc", spec }));
    expect(f.message).toContain("returned no rows");
    const parse = adapter.parseExport as (t: string) => any[];
    expect(parse("SEARCH VALUES\r\nsearch\r\nvendor_name:NOBODY\r\n\r\n")).toEqual([]);
    expect(parse("")).toEqual([]);
  });

  it("an export shortfall is noted", async () => {
    // the export writes rates identical in every exported column once: one count request says by how many
    const pack = await load("gsa-calc");
    const asked: any[] = [];
    const client = { get: async (_p: string, query: any) => {
      asked.push(query);
      return { json: () => ({ aggregations: { wage_stats: { count: 52 } } }) };
    } };
    const short = adapter.exportShortfall as (c: any, p: any, params: any, n: number) => Promise<string | null>;
    const note = await short(client, pack, { export: "y", keyword: "analyst" }, 50);
    expect(note).toContain("the export has 50 rows but the search matches 52");
    expect(asked[0]).not.toHaveProperty("export");
    expect([asked[0].page_size, asked[0].keyword]).toEqual([0, "analyst"]);
    expect(await short(client, pack, { keyword: "analyst" }, 52)).toBeNull();
  });

  it("a 406 is explained", async () => {
    // r007 (recorded 2026-10-22): ordering by a field the API cannot sort on answers 406, empty body.
    const spec = { requests: [{ name: "bad_order", endpoint: "rates", max_rows: 5, params: { keyword: "economist", ordering: "sin" } }] };
    const s = newSession();
    fixtures("gsa-calc");
    await prepare(s, "gsa-calc", spec);
    const f = await failure(T.fetchData(s, { source: "gsa-calc", spec }));
    expect(f.code).toBe("agency_rejected"); // Python kind bad_request
    expect(f.message).toContain("page past row 10,000");
  });

  it("an ignored filter or search field is a spec problem", async () => {
    for (const params of [{ keyword: "analyst", filter: ["schedule:MAS"] }, { keyword: "analyst", filter: "vendor_name:ACME" },
      { keyword: "analyst", filter: ["sin:541611", "nonsense"] }, { search: "category:Professional Services" }]) {
      expect((await problems({ requests: [{ name: "x", endpoint: "rates", params }] })).length).toBeGreaterThan(0);
    }
    expect(await problems({ requests: [{ name: "x", endpoint: "rates",
      params: { search: "vendor_name:ACME", filter: ["subcategory:IT Services"] } }] })).toEqual([]);
  });

  it("manual export link and ingest", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "gsa-calc", spec: SPEC }] });
    const first = r.items[0];
    expect(first.filename).toBe("ds_ma_small.csv");
    expect(first.url).toContain("export=y");
    expect(first.url).toContain("filter=education_level%3AMA");
    // ingest the recorded export CSV as if the user had downloaded it
    const one = { requests: [SPEC.requests[4]] };
    const s = newSession();
    fixtures("gsa-calc");
    await prepare(s, "gsa-calc", one);
    const up = path.join(s.workspace, "up");
    fs.mkdirSync(up);
    fs.copyFileSync(path.join(TEST_DIR, "packs", "gsa-calc", "fixtures", "r005.csv"), path.join(up, "ds_phd_export.csv"));
    await T.ingest(s, { source: "gsa-calc", spec: one, files: [path.join(up, "ds_phd_export.csv")] });
    expect(csv(s, "gsa-calc", "ds_phd_export")[0].vendor_name).toBe("RANCHO BIOSCIENCES, LLC");
  });
});
