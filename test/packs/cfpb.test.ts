/**
 * cfpb: ported from the Python skill's tests/sources/cfpb/test_cfpb.py. Fixtures r001-r007 were recorded from the
 * CFPB search API on 2026-10-20, r008 on 2026-10-22.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import adapter, { periods, q } from "../../src/adapters/cfpb.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const WY = { state: "WY", date_received_min: "2025-01-01", date_received_max: "2025-12-31" };
const SPEC = { description: "Wyoming student loan complaints, 2025: latest complaints, counts by product, quarterly trend",
  requests: [
    { name: "wy_student_latest", endpoint: "complaints", params: { product: "Student loan", ...WY, page_size: 2 }, max_rows: 4 },
    { name: "wy_by_product", endpoint: "aggregations", params: { agg: "product", ...WY } },
    { name: "wy_student_quarterly", endpoint: "trends", params: { interval: "quarter", product: "Student loan", ...WY } }] };

beforeAll(() => isolate());

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures("cfpb");
  await prepare(s, "cfpb", spec);
  return failure(T.fetchData(s, { source: "cfpb", spec }));
}

describe("cfpb", () => {
  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "cfpb", SPEC);
    expect(r.summary.route).toBe("api");
    const rows = csv(s, "cfpb", "wy_student_latest"); // two pages of two, joined by search_after
    expect(rows.map((x) => x.complaint_id)).toEqual(["17993241", "17892924", "16527282", "16469628"]);
    expect(rows[0].company).toBe("MOHELA");
    const agg = csv(s, "cfpb", "wy_by_product");
    expect(agg[0].key).toBe("Credit reporting or other personal consumer reports");
    expect(agg[0].complaints).toBe("769");
    expect(agg[0].total_matching).toBe("1201");
    const qq = csv(s, "cfpb", "wy_student_quarterly");
    expect(qq.map((x) => x.period)).toEqual(["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4"]);
    expect(qq.reduce((n, x) => n + Number(x.complaints), 0)).toBe(19);
    expect(r.notes.some((n: string) => n.includes("of 19 matching"))).toBe(true);
  });

  it("periods", () => {
    expect(periods("2024-11-15", "2025-02-10", "month")[0]).toEqual(["2024-11", "2024-11-15", "2024-11-30"]);
    expect(periods("2024-11-15", "2025-02-10", "month").at(-1)).toEqual(["2025-02", "2025-02-01", "2025-02-10"]);
    expect(periods("2020-01-01", "2025-12-31", "year").length).toBe(6);
    expect(periods("2025-05-01", "2025-12-31", "quarter")[0]).toEqual(["2025-Q2", "2025-05-01", "2025-06-30"]);
  });

  it("ingests an aggregation upload", async () => {
    const spec = { requests: [SPEC.requests[1]] };
    const s = newSession();
    fixtures("cfpb");
    await prepare(s, "cfpb", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "cfpb-up-"));
    fs.copyFileSync(path.join(TEST_DIR, "packs", "cfpb", "fixtures", "r003.json"), path.join(up, "wy_by_product.json"));
    const r: any = await T.ingest(s, { source: "cfpb", spec, files: [up] });
    expect(r.status).toBe("ok");
    const rows = csv(s, "cfpb", "wy_by_product");
    expect(rows[1].key).toBe("Debt collection");
    expect(rows[1].complaints).toBe("152");
  });

  it("trends need dates", async () => {
    expect((await fetchFail({ requests: [{ name: "t", endpoint: "trends", params: { interval: "month" } }] })).code).toBe("invalid_request");
  });

  it("a bad agg is a spec problem", async () => {
    expect((await fetchFail({ requests: [{ name: "a", endpoint: "aggregations", params: { agg: "sub_product" } }] })).code)
      .toBe("invalid_request");
  });

  it("sub-filters are sent as bullet values", async () => {
    const s = newSession();
    const spec = { requests: [{ name: "wy_medical_not_mine", endpoint: "complaints", max_rows: 3,
      params: { product: "Debt collection", sub_product: "Medical debt", issue: "Attempts to collect debt not owed",
        sub_issue: ["Debt is not yours", "Debt was paid"], ...WY } }] };
    const r = await fetchOk(s, "cfpb", spec);
    const rows = csv(s, "cfpb", "wy_medical_not_mine");
    expect(rows.length).toBe(3);
    expect(new Set(rows.map((x) => x.sub_product))).toEqual(new Set(["Medical debt"]));
    expect(rows.every((x) => ["Debt is not yours", "Debt was paid"].includes(x.sub_issue))).toBe(true);
    expect(r.notes.some((n: string) => n.includes("of 14 matching"))).toBe(true);
    const qq = q(spec.requests[0].params);
    expect(qq.product).toEqual([`Debt collection${String.fromCharCode(0x2022)}Medical debt`]);
    expect(qq).not.toHaveProperty("sub_issue");
  });

  it("ignored or invalid parameters are spec problems", async () => {
    const base = { agg: "issue", ...WY };
    for (const extra of [{ has_narrative: true }, { consumer_disputed: "No" }, { zipcode: "82001" },
      { sub_issue: "Debt was paid" }, // no issue
      { product: ["Mortgage", "Credit card"], sub_product: "Store credit card" },
      { search_term: "fee", field: "complaint_what_happened" }]) {
      const f = await fetchFail({ requests: [{ name: "a", endpoint: "aggregations", params: { ...base, ...extra } }] });
      expect(f.code, JSON.stringify(extra)).toBe("invalid_request");
    }
  });

  it("manual bundle", async () => {
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: "cfpb", spec: SPEC }] });
    expect(r.items[0].url).toContain("format=csv");
    expect(adapter.manualItems!(SPEC, await load("cfpb")).length).toBe(6);
    expect(r.items.filter((i: any) => i.filename.startsWith("wy_student_quarterly_")).length).toBe(4);
  });
});
