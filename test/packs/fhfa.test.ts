/**
 * fhfa pack tests (offline), ported from tests/sources/fhfa/test_fhfa.py. Fixtures from www.fhfa.gov, 2026-10-30
 * (trimmed real copies of the large files; see the Python test's docstring).
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

beforeAll(() => isolate());

const SPEC = { description: "FHFA HPI (U.S. purchase-only monthly, Vermont), annual state HPI, 2026 loan limits, FHLBank PUDB",
  requests: [
    { name: "us_po_monthly", endpoint: "hpi_master",
      params: { hpi_type: "traditional", hpi_flavor: "purchase-only", frequency: "monthly", place_id: "USA" } },
    { name: "vt_po_quarterly", endpoint: "hpi_master",
      params: { hpi_flavor: "purchase-only", level: "State", place_id: "VT", min_year: 2024 } },
    { name: "vt_at", endpoint: "hpi_state", params: { state: "vt", min_year: 2025 } },
    { name: "annual_state", endpoint: "hpi_annual", params: { geography: "state", where: { Abbreviation: "VT" }, min_year: 2020 } },
    { name: "limits_2026", endpoint: "loan_limits", params: { year: 2026, state: ["CA", "HI"] } },
    { name: "pudb_vt", endpoint: "fhlb_pudb", params: { year: "2025", where: { FIPSStateNumericCode: "50" } } }] };

async function fetchFail(spec: any) {
  const s = newSession();
  fixtures("fhfa");
  await prepare(s, "fhfa", spec);
  return failure(T.fetchData(s, { source: "fhfa", spec }));
}

describe("fhfa", () => {
  it("check: the sample spec is valid", async () => {
    expect(gr.checkSpec(await load("fhfa"), SPEC)).toEqual([]);
  });

  it("fetch", async () => {
    const s = newSession();
    const r = await fetchOk(s, "fhfa", SPEC);
    expect(r.status).toBe("ok");
    const us = csv(s, "fhfa", "us_po_monthly");
    expect(Object.keys(us[0]).slice(0, 10)).toEqual(["hpi_type", "hpi_flavor", "frequency", "level", "place_name", "place_id",
      "yr", "period", "index_nsa", "index_sa"]);
    expect(us.length).toBe(428); // 1991-01 .. 2026-08
    expect(new Set(us.map((x) => x.place_id))).toEqual(new Set(["USA"]));
    const last = us[us.length - 1];
    expect([last.yr, last.period, last.index_sa, last.index_nsa]).toEqual(["2026", "8", "444.61", "450.45"]);
    const aug25 = us.find((x) => x.yr === "2025" && x.period === "8")!;
    expect(Math.round((Number(last.index_sa) / Number(aug25.index_sa) * 100 - 100) * 10) / 10).toBe(2.4);
    const vt = csv(s, "fhfa", "vt_po_quarterly");
    expect(new Set(vt.map((x) => `${x.place_id}|${x.hpi_flavor}|${x.level}`))).toEqual(new Set(["VT|purchase-only|State"]));
    expect(Math.min(...vt.map((x) => Number(x.yr)))).toBe(2024);
    const at = csv(s, "fhfa", "vt_at"); // headerless file: the pack names the columns
    expect(Object.keys(at[0])).toEqual(["state", "yr", "qtr", "index_nsa"]);
    expect([at[at.length - 1].yr, at[at.length - 1].qtr, at[at.length - 1].index_nsa]).toEqual(["2026", "2", "902.53"]);
    expect(at.length).toBe(6);
    const an = csv(s, "fhfa", "annual_state");
    expect(Object.keys(an[0])).toEqual(["State", "Abbreviation", "FIPS", "Year", "Annual Change (%)", "HPI",
      "HPI with 1990 base", "HPI with 2000 base"]);
    const al = an[an.length - 1];
    expect([al.Year, al.HPI, al["Annual Change (%)"]]).toEqual(["2025", "1036.55", "3.61"]);
    const lim = csv(s, "fhfa", "limits_2026");
    expect(Object.keys(lim[0])).toEqual(["fips_state_code", "fips_county_code", "county_name", "state", "cbsa_number",
      "one_unit_limit", "two_unit_limit", "three_unit_limit", "four_unit_limit"]);
    expect(new Set(lim.map((x) => x.state))).toEqual(new Set(["CA", "HI"]));
    const alpine = lim.find((x) => x.county_name === "ALPINE COUNTY")!;
    expect([alpine.fips_state_code, alpine.fips_county_code, alpine.one_unit_limit]).toEqual(["06", "003", "832750"]);
    expect(Math.max(...lim.filter((x) => x.state === "CA").map((x) => Number(x.one_unit_limit)))).toBe(1249125); // ceiling
    expect(Math.max(...lim.map((x) => Number(x.one_unit_limit)))).toBe(1299500); // Maui, HI
    expect(r.notes.some((n: string) => n.includes("snake_case"))).toBe(true);
    const pudb = csv(s, "fhfa", "pudb_vt");
    expect(pudb.length > 0 && new Set(pudb.map((x) => x.FIPSStateNumericCode)).size === 1 && pudb[0].FIPSStateNumericCode === "50").toBe(true);
    expect(pudb[0].Bank).toBe("Boston");
  });

  it("loan limit layouts match", async () => {
    const spec = { requests: [{ name: "y2025", endpoint: "loan_limits", params: { year: 2025, state: "AL" } },
      { name: "y2026", endpoint: "loan_limits", params: { year: 2026, state: "AL" } }] };
    const s = newSession();
    await fetchOk(s, "fhfa", spec);
    const a = csv(s, "fhfa", "y2025"), b = csv(s, "fhfa", "y2026");
    expect(Object.keys(a[0])).toEqual(Object.keys(b[0]));
    expect([a[0].fips_state_code, a[0].fips_county_code, a[0].one_unit_limit]).toEqual(["01", "001", "806500"]);
    expect(b[0].one_unit_limit).toBe("832750");
  });

  it("max_rows applies after the filter", async () => {
    const spec = { requests: [{ name: "us", endpoint: "hpi_master", max_rows: 12,
      params: { hpi_flavor: "purchase-only", frequency: "monthly", place_id: "USA" } }] };
    const s = newSession();
    const r = await fetchOk(s, "fhfa", spec);
    expect(r.status).toBe("partial");
    expect(csv(s, "fhfa", "us").length).toBe(12);
    expect(r.notes.some((n: string) => n.includes("stopped at 12 rows") && n.includes("428 rows matched"))).toBe(true);
  });

  it("an unpublished year is not found", async () => {
    const f = await fetchFail({ requests: [{ name: "y2027", endpoint: "loan_limits", params: { year: 2027 } }] });
    expect(f.status).toBe("error");
    expect(f.message).toContain("not found");
  });

  it("an unknown filter column and an empty filter fail", async () => {
    let f = await fetchFail({ requests: [{ name: "x", endpoint: "hpi_state", params: { where: { "State Name": "Vermont" } } }] });
    expect(f.status).toBe("error");
    expect(f.message).toContain("not in this file");
    f = await fetchFail({ requests: [{ name: "x", endpoint: "hpi_state", params: { state: "Vermont" } }] });
    expect(f.status).toBe("error");
    expect(f.message).toContain("returned no rows");
  });

  it("a bad spec is refused", async () => {
    const p = await load("fhfa");
    for (const bad of [
      { requests: [{ name: "x", endpoint: "hpi_master", params: { hpi_flavor: "sales-only" } }] },
      { requests: [{ name: "x", endpoint: "hpi_annual", params: { geography: "zip5" } }] },
      { requests: [{ name: "x", endpoint: "loan_limits", params: { year: 2023 } }] },
      { requests: [{ name: "x", endpoint: "loan_limits", params: { year: 2026, min_year: 2020 } }] },
      { requests: [{ name: "x", endpoint: "hpi_state", params: { where: ["VT"] } }] }]) {
      expect(gr.checkSpec(p, bad as any).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it("manual bundle and upload", async () => {
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: "fhfa", spec: SPEC }] });
    expect(r.status).toBe("ok");
    const text = fs.readFileSync(r.instructions, "utf8");
    expect(text).toContain("https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv");
    expect(text).toContain("https://www.fhfa.gov/document/d/cll/fullcountyloanlimitlist2026_hera-based_final_flat.csv");
    // an uploaded copy of the headerless state file is named and filtered like a fetch
    const p = await load("fhfa");
    const rows = await p.adapter!.parseUpload!(p, SPEC.requests[2], [path.join(TEST_DIR, "packs", "fhfa", "fixtures", "r001.csv")]);
    expect(rows[0]).toEqual({ state: "VT", yr: "2025", qtr: "1", index_nsa: "852.68" });
  });

  it("an HTML page is refused", async () => {
    const ad = (await load("fhfa")).adapter!;
    expect(ad.checkError!(200, Buffer.from("<!DOCTYPE html><html><body>Page not found</body></html>"))).toBeTruthy();
    expect(ad.checkError!(200, Buffer.from("hpi_type,hpi_flavor\n"))).toBeNull();
  });
});
