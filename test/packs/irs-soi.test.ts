/** irs-soi: ported from the Python skill's tests/sources/irs-soi/test_irs_soi.py (same fixtures, specs and values). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "irs-soi", "fixtures");
const SPEC = { description: "Maryland income tax statistics, tax year 2022, and migration into Maryland 2022-2023",
  requests: [
    { name: "md_county", endpoint: "county_agi", params: { tax_year: 2022, state: "MD" } },
    { name: "md_in", endpoint: "migration", params: { level: "state", direction: "inflow", y1: 2022, state: "Maryland" } }] };

beforeAll(() => isolate());

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures("irs-soi");
  await prepare(s, "irs-soi", spec);
  return failure(T.fetchData(s, { source: "irs-soi", spec }));
}

describe("irs-soi", () => {
  it("fetches county data and state migration on the api route", async () => {
    const s = newSession();
    const r = await fetchOk(s, "irs-soi", SPEC);
    expect(r.summary.route).toBe("api");
    const md = csv(s, "irs-soi", "md_county");
    expect(md.length).toBe(24); // 3 places x 8 AGI classes, Alabama dropped
    expect(Object.keys(md[0]).slice(0, 7)).toEqual(["TAX_YEAR", "STATEFIPS", "STATE", "COUNTYFIPS", "COUNTYNAME", "AGI_STUB", "N1"]);
    expect(md[0]).toHaveProperty("MARS1"); // published as mars1: upper-cased
    expect(new Set(md.map((x) => x.STATE))).toEqual(new Set(["MD"]));
    const tot = md.filter((x) => x.COUNTYFIPS === "000");
    expect([tot[0].COUNTYNAME, tot[0].AGI_STUB, tot[0].N1, tot[0].A00100]).toEqual(["Maryland", "1", "40530", "-2088844"]);
    const mont = Object.fromEntries(md.filter((x) => x.COUNTYFIPS === "031").map((x) => [x.AGI_STUB, x]));
    expect([mont["8"].N1, mont["8"].A00100]).toEqual(["89920", "44953260"]);
    expect(mont["8"].TAX_YEAR).toBe("2022");
    const mig = csv(s, "irs-soi", "md_in");
    expect(mig.length).toBe(56);
    expect(Object.keys(mig[0]).slice(0, 3)).toEqual(["Y1_YEAR", "Y2_YEAR", "Y2_STATEFIPS"]);
    expect(mig.slice(0, 5).map((x) => x.ROW_TYPE)).toEqual(["total_us_and_foreign", "total_us", "total_foreign", "total_same_state",
      "non_migrants"]); // both 97 rows told apart by name
    const va = mig.find((x) => x.Y1_STATE === "VA")!;
    expect([va.N1, va.N2, va.AGI, va.ROW_TYPE]).toEqual(["13353", "21646", "1173876", "flow"]);
  });

  it("ZIP code and state tables", async () => {
    const s = newSession();
    const spec = { requests: [
      { name: "zips", endpoint: "zip_agi", params: { tax_year: 2022, state: "24", zipcode: ["20601", "99999"], columns: ["N1", "A00100"] } },
      { name: "states", endpoint: "state_agi", params: { tax_year: 2022, state: ["MD", "US"], agi_stub: [0, 10] } }] };
    const r = await fetchOk(s, "irs-soi", spec);
    expect(r.summary.route).toBe("api");
    const z = csv(s, "irs-soi", "zips");
    expect(Object.keys(z[0])).toEqual(["TAX_YEAR", "STATEFIPS", "STATE", "ZIPCODE", "AGI_STUB", "N1", "A00100"]);
    expect(z.length).toBe(12);
    const top = z.find((x) => x.ZIPCODE === "20601" && x.AGI_STUB === "6")!;
    expect([top.N1, top.A00100]).toEqual(["780", "217760"]);
    const st = Object.fromEntries(csv(s, "irs-soi", "states").map((x) => [`${x.STATE}/${x.AGI_STUB}`, x]));
    expect(Object.keys(st).length).toBe(4);
    expect([st["MD/0"].N1, st["MD/0"].A00100]).toEqual(["3095140", "295351996"]); // "3,095,140"
    expect(st["US/10"].A00100).toBe("2716781710");
  });

  it("county migration: suppressed cells and other flows", async () => {
    const s = newSession();
    await fetchOk(s, "irs-soi", { requests: [{ name: "out", endpoint: "migration",
      params: { level: "county", direction: "outflow", y1: 2022, county: ["01005", "24031"] } }] });
    const rows = csv(s, "irs-soi", "out");
    expect(new Set(rows.map((x) => `${x.Y1_STATEFIPS}/${x.Y1_COUNTYFIPS}`))).toEqual(new Set(["01/005", "24/031"]));
    const ne = rows.find((x) => x.Y1_COUNTYFIPS === "005" && x.Y2_STATEFIPS === "59" && x.Y2_COUNTYFIPS === "001")!;
    expect([ne.N1, ne.AGI, ne.SUPPRESSED, ne.ROW_TYPE]).toEqual(["", "", "N1;N2;AGI", "other_flows"]);
    const m = Object.fromEntries(rows.filter((x) => x.Y1_COUNTYFIPS === "031" && x.ROW_TYPE !== "flow").map((x) => [x.ROW_TYPE, x]));
    expect(m.total_different_state.N1).toBe("20473");
    expect(m.non_migrants.N1).toBe("429090");
  });

  it("bad specs are invalid_request", async () => {
    const cases: [any, string][] = [
      [{ name: "z", endpoint: "zip_agi", params: { tax_year: 2022 } }, "needs state"],
      [{ name: "c", endpoint: "county_agi", params: { tax_year: 2008, state: "MD" } }, "2011"],
      [{ name: "s", endpoint: "state_agi", params: { tax_year: 2013 } }, "xlsx"],
      [{ name: "m", endpoint: "migration", params: { level: "state", direction: "inflow", tax_year: 2022 } }, "y1"],
      [{ name: "m2", endpoint: "migration", params: { level: "metro", direction: "inflow" } }, "level"],
      [{ name: "k", endpoint: "county_agi", params: { tax_year: 2022, county: "031" } }, "needs state"],
      [{ name: "x", endpoint: "county_agi", params: { tax_year: 2022, state: "Marylnd" } }, "unknown state"]];
    for (const [bad, word] of cases) {
      const f = await fetchFail({ requests: [bad] });
      expect(f.code, JSON.stringify(bad)).toBe("invalid_request");
      expect(f.message).toContain(word);
    }
  });

  it("a year not posted names the file", async () => {
    const f = await fetchFail({ requests: [{ name: "next", endpoint: "migration", params: { level: "state", direction: "inflow", y1: 2023 } }] });
    expect(f.code).toBe("not_found");
    expect(f.message).toContain("stateinflow2324.csv");
  });

  it("the manual bundle links the published files", async () => {
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: "irs-soi", spec: { requests: [
      { name: "zips", endpoint: "zip_agi", params: { start_year: 2021, end_year: 2022, state: "MD" } },
      { name: "cty", endpoint: "county_agi", params: { tax_year: 2022, agi_classes: false } },
      { name: "st", endpoint: "state_agi", params: { tax_year: 2018 } },
      { name: "mig", endpoint: "migration", params: { level: "county", direction: "outflow", y1: 2021 } }] } }] });
    expect(r.items.map((i: any) => i.filename)).toEqual(["21zpallagi.csv", "22zpallagi.csv", "22incyallnoagi.csv", "18in55cmagi.csv",
      "countyoutflow2122.csv"]);
    expect(r.items[0].url).toBe("https://www.irs.gov/pub/irs-soi/21zpallagi.csv");
  });

  it("ingest filters the uploaded files", async () => {
    const s = newSession();
    await prepare(s, "irs-soi", SPEC);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "irs-up-"));
    fs.copyFileSync(path.join(FX, "22incyallagi_subset.csv"), path.join(up, "22incyallagi.csv"));
    fs.copyFileSync(path.join(FX, "r001.csv"), path.join(up, "stateinflow2223.csv"));
    delete process.env.DATA_ANALYST_FIXTURES;
    await T.ingest(s, { source: "irs-soi", spec: SPEC, files: [up] });
    const md = csv(s, "irs-soi", "md_county");
    expect(md.length).toBe(24);
    expect(new Set(md.map((x) => x.STATE))).toEqual(new Set(["MD"]));
    expect(csv(s, "irs-soi", "md_in").length).toBe(56);
  });

  it("parses an upload directly", async () => {
    const ad: any = (await load("irs-soi")).adapter;
    let rows = await ad.parseUpload(null, { name: "z", endpoint: "zip_agi", params: { tax_year: 2022, zipcode: "20601", agi_stub: 6 } },
      [path.join(FX, "22zpallagi_subset.csv")]);
    expect(rows.length).toBe(1);
    expect([rows[0].ZIPCODE, rows[0].N1, rows[0].TAX_YEAR]).toEqual(["20601", "780", 2022]);
    rows = await ad.parseUpload(null, { name: "c", endpoint: "county_agi", params: { tax_year: 2022, state: "MD", county: "Montgomery" } },
      [path.join(FX, "22incyallagi_subset.csv")]);
    expect(new Set(rows.map((x: any) => `${x.COUNTYNAME}/${x.COUNTYFIPS}`))).toEqual(new Set(["Montgomery County/031"]));
    expect(rows.length).toBe(8);
    // TY2022 publishes "Prince George's Coun" (cut to 20 characters): the full name still matches
    expect(ad.nameHit("Prince George's Coun", new Set(["prince george's county"]))).toBe(true);
    expect(ad.nameHit("Allegany County", new Set(["montgomery county"]))).toBe(false);
  });
});
