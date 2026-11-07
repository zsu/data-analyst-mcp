/**
 * cms: ported from tests/sources/cms/test_cms.py. Fixtures r001-r003 were recorded live on
 * 2026-10-20 (provider-data datastore query; data-api Geographic Variation); r004-r005 on 2026-10-22 (monthly
 * enrollment and Part D prescribers, suppressed "*" cells); r006-r008 on 2026-10-28.
 */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/cms.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SPEC = { description: "Vermont hospitals: overall star rating; Medicare FFS standardized spending per capita by state, 2024",
  requests: [
    { name: "vt_hospitals", endpoint: "provider", params: { dataset: "hospital_info", where: { state: "VT" },
      columns: ["facility_id", "facility_name", "citytown", "hospital_type", "hospital_overall_rating"], sort: "facility_id" } },
    { name: "ffs_spending_2024", endpoint: "medicare", params: { dataset: "geo_variation",
      where: { YEAR: "2024", BENE_GEO_LVL: "State", BENE_AGE_LVL: "All" },
      columns: ["YEAR", "BENE_GEO_LVL", "BENE_GEO_DESC", "BENES_OM_CNT", "TOT_MDCR_STDZD_PYMT_PC", "TOT_MDCR_PYMT_PC"] } }] };
const BAD = { description: "unknown filter column", requests: [
  { name: "bad_filter", endpoint: "medicare", max_rows: 3,
    params: { dataset: "geo_variation", where: { STATE: "VT" }, columns: ["YEAR", "BENE_GEO_DESC"] } }] };

beforeAll(() => isolate());

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures("cms");
  await prepare(s, "cms", spec);
  return failure(T.fetchData(s, { source: "cms", spec }));
}

describe("cms", () => {
  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "cms", SPEC);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api");
    const rows = csv(s, "cms", "vt_hospitals");
    expect(rows.length).toBe(17);
    expect(rows[0].facility_id).toBe("470001");
    expect(rows[0].hospital_overall_rating).toBe("3");
    const geo = Object.fromEntries(csv(s, "cms", "ffs_spending_2024").map((g) => [g.BENE_GEO_DESC, g]));
    expect(geo.AK.TOT_MDCR_STDZD_PYMT_PC).toBe("9209.46");
    expect(geo.AK.BENE_AGE_LVL).toBe("All"); // filter columns are always returned
  });

  it("an unknown filter column fails", async () => {
    const f = await fetchFail(BAD);
    expect(f.code).toBe("agency_rejected");
    expect(f.message).toContain("STATE");
  });

  it("suppressed * cells are flagged", async () => {
    const s = newSession();
    const spec = { requests: [
      { name: "wy_county_enroll_2022", endpoint: "medicare", params: { dataset: "monthly_enrollment",
        where: { BENE_GEO_LVL: "County", BENE_STATE_ABRVTN: "WY", YEAR: "2022", MONTH: "Year" },
        columns: ["BENE_COUNTY_DESC", "TOT_BENES", "NATIND_TOT_BENES", "AGE_LT_25_BENES"] } },
      { name: "partd_flagged", endpoint: "medicare", max_rows: 2, params: { dataset: "partd_prescribers_geo_2024",
        where: { Prscrbr_Geo_Lvl: "State", GE65_Sprsn_Flag: "*" }, columns: ["Prscrbr_Geo_Desc", "Brnd_Name", "Tot_Clms", "GE65_Tot_Clms"] } }] };
    const r = await fetchOk(s, "cms", spec);
    expect(["ok", "partial"]).toContain(r.status);
    const rows = csv(s, "cms", "wy_county_enroll_2022");
    expect(rows.some((x) => Object.values(x).some((v) => v === "*"))).toBe(false);
    const unknown = rows.find((x) => x.BENE_COUNTY_DESC === "Unknown")!;
    expect(unknown.TOT_BENES).toBe("");
    expect(unknown.TOT_BENES_flag).toBe("suppressed (*)");
    const albany = rows.find((x) => x.BENE_COUNTY_DESC === "Albany County")!;
    expect([albany.TOT_BENES, albany.TOT_BENES_flag]).toEqual(["5784", ""]);
    const flagged = csv(s, "cms", "partd_flagged");
    expect(new Set(flagged.map((x) => x.GE65_Sprsn_Flag))).toEqual(new Set(["*"]));
    expect(flagged[0]).not.toHaveProperty("GE65_Sprsn_Flag_flag");
  });

  it("an unknown sort column is named", async () => {
    const f = await fetchFail({ requests: [{ name: "vt_hosp_badsort", endpoint: "provider",
      params: { dataset: "hospital_info", where: { state: "VT" }, sort: "ccn", columns: ["facility_id", "facility_name"] } }] });
    expect(f.code).toBe("agency_rejected");
    expect(f.message).toContain("['ccn']");
    expect(f.message).toContain("facility_id");
  });

  it("a bad operator is a spec problem", async () => {
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "provider",
      params: { dataset: "hospital_info", conditions: [{ property: "state", value: "VT", operator: "~" }] } }] });
    expect(f.code).toBe("invalid_request");
  });

  it("a numeric text comparison is a spec problem", async () => {
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "provider",
      params: { dataset: "hospital_info", conditions: [{ property: "mort_group_measure_count", value: "5", operator: ">" }] } }] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("TEXT");
  });

  it("a medicare list filter is one IN group", async () => {
    const s = newSession();
    const spec = { requests: [{ name: "three_states", endpoint: "medicare", params: { dataset: "geo_variation",
      where: { YEAR: "2022", BENE_GEO_LVL: "State", BENE_AGE_LVL: "All", BENE_GEO_DESC: ["VT", "NH", "ME"] },
      columns: ["YEAR", "BENE_GEO_DESC", "BENES_TOTAL_CNT"] } }] };
    await fetchOk(s, "cms", spec);
    expect(csv(s, "cms", "three_states").map((x) => x.BENE_GEO_DESC).sort()).toEqual(["ME", "NH", "VT"]);
    const url = adapter.manualItems!(spec, await load("cms"))[0].url;
    expect(url).toContain("filter%5Bin3%5D%5Bcondition%5D%5Boperator%5D=IN");
    expect(url).not.toContain("filter%5BBENE_GEO_DESC%5D");
  });

  it("medicare rows outside the filter fail", async () => {
    const ep = { path: "/data-api/v1/dataset/{dataset}/data" };
    const req = { name: "x", params: { where: { STATE: ["AK", "HI"] } } };
    expect(adapter.normalize!(req, ep, [{ STATE: "ak" }, { STATE: "HI" }]).length).toBe(2); // the API matches any case
    expect(() => adapter.normalize!(req, ep, [{ STATE: "AK" }, { STATE: "WA" }])).toThrow(/did not apply the filter/);
    expect(adapter.checkSpec!({ requests: [{ name: "e", params: { where: { STATE: [] } } }] }, await load("cms")).length).toBeGreaterThan(0);
  });

  it("manual links carry the filters", async () => {
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: "cms", spec: SPEC }] });
    const urls: string[] = r.items.map((i: any) => i.url);
    expect(urls.some((u) => u.includes("conditions%5B0%5D%5Bproperty%5D=state"))).toBe(true);
    expect(urls.some((u) => u.includes("filter%5BYEAR%5D=2024"))).toBe(true);
  });
});
