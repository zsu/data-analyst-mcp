/**
 * census: ported from tests/sources/census/test_census.py, against the same fixtures (see that
 * file's docstring for what each fixture is) and the same expected values.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import adapter, { manualItemsAsync, normalize, parseUpload, withMoe } from "../../src/adapters/census.js";
import { asecJoin, asecRwIndex, asecRwValues, iterRows, mergeChunks, microMeta, renameHint } from "../../src/adapters/_census_micro.js";
import { censusGet } from "../../src/adapters/_census_util.js";
import { DataError } from "../../src/core/http.js";
import { load } from "../../src/core/packs.js";
import { readCsv } from "../../src/core/tabular.js";
import * as T from "../../src/tools.js";
import { csv, failure, fakeKeys, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FIX = path.join(TEST_DIR, "packs", "census", "fixtures");
const SPEC = { description: "Median household income, Maryland counties, latest ACS 5-year",
  requests: [{ name: "md_county_income", endpoint: "query",
    params: { dataset: "acs5", get: "NAME,B19013_001E", for: "county:*", state: "Maryland" } }] };
const DOC = { description: "Hmong population by state, ACS 1-year 2019 (documented example)",
  requests: [{ name: "hmong_2019", endpoint: "query", params: { dataset: "2019/acs/acs1", get: "NAME,B02015_009E", for: "state:*" } }] };
const GEO = { description: "names to codes",
  requests: [
    { name: "montgomery", endpoint: "query",
      params: { dataset: "acs5", get: ["NAME", "B25077_001E", "B25064_001E"], state: "MD", county: "Montgomery" } },
    { name: "baltimore_city", endpoint: "query", params: { dataset: "acs5", get: "NAME,B01003_001E", state: "24", place: "Baltimore" } }] };
const MICRO = { description: "fixtures: ACS PUMS Wyoming ages 90+, replicates; ASEC and CPS basic Wyoming ages 80-85",
  requests: [
    { name: "wy_pums", endpoint: "query",
      params: { dataset: "2024/acs/acs1/pums", get: "AGEP,HICOV,PINCP", state: "WY", AGEP: "90:99", replicates: true } },
    { name: "wy_asec", endpoint: "query", params: { dataset: "2026/cps/asec/mar", get: "A_AGE,NOW_COV", state: "WY", A_AGE: "80:85" } },
    { name: "wy_basic", endpoint: "query", params: { dataset: "2026/cps/basic/sep", get: "PRTAGE,PEMLR", state: "WY", PRTAGE: "80:85" } }] };

beforeAll(() => isolate());

const keyed = async () => {
  await fakeKeys("census");
};
const noKey = () => {
  delete process.env.CENSUS_API_KEY;
};

/** The fetch failure of a spec (gate satisfied first). */
async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures("census");
  await prepare(s, "census", spec);
  return failure(T.fetchData(s, { source: "census", spec }));
}

async function items(spec: any): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {};
  for (const i of adapter.manualItems!(spec, await load("census"))) (out[i.request] ??= []).push(i);
  return out;
}

describe("census", () => {
  it("a keyless query is key_missing", async () => {
    noKey();
    const f = await fetchFail(SPEC);
    expect(f.code).toBe("key_missing");
    expect(f.message).toContain("CENSUS_API_KEY");
  });

  it("a keyless query that reaches the API is a key error (missing_key.html)", async () => {
    noKey();
    fixtures("census");
    const pack = await load("census");
    const c = (await import("../../src/core/generic-rest.js")).clientFor(pack);
    const e = await censusGet(c, "/2024/acs/acs5", { get: "NAME,B19013_001E,B19013_001M", for: "county:*", in: "state:24" })
      .catch((x) => x);
    expect(e).toBeInstanceOf(DataError);
    expect(e.kind).toBe("key_missing");
  });

  it("fetches the documented example with margins of error", async () => {
    await keyed();
    const s = newSession();
    const r = await fetchOk(s, "census", DOC);
    expect(r.status).toBe("ok");
    const rows = csv(s, "census", "hmong_2019");
    expect(Object.keys(rows[0])).toEqual(["NAME", "B02015_009E", "B02015_009E_flag", "B02015_009M", "B02015_009M_flag", "state"]);
    const ga = rows.find((x) => x.NAME === "Georgia")!;
    expect([ga.B02015_009E, ga.B02015_009M]).toEqual(["3162", "1336"]);
    const idaho = rows.find((x) => x.NAME === "Idaho")!;
    expect(idaho.B02015_009E).toBe("");
    expect(idaho.B02015_009E_flag).toContain("null");
    expect(r.notes.some((n: string) => n.includes("margins of error added"))).toBe(true);
    expect(fs.readFileSync(path.join(s.workspace, "data", "census", "README.md"), "utf8")).toContain(
      "not endorsed or certified by the Census Bureau");
  });

  it("SIPP adds keys and weight and needs no geography", async () => {
    await keyed();
    const s = newSession();
    const spec = { requests: [{ name: "sipp_dec", endpoint: "query", params: { dataset: "2024/sipp", get: "TAGE,RHLTHMTH", MONTHCODE: "12" } }] };
    const r = await fetchOk(s, "census", spec);
    const rows = csv(s, "census", "sipp_dec");
    expect(Object.keys(rows[0])).toEqual(["TAGE", "RHLTHMTH", "SSUID", "PNUM", "MONTHCODE", "WPFINWGT"]);
    expect(rows[0].SSUID).toBe("000114552134"); // leading zeros kept
    expect(rows[2].WPFINWGT).toBe("-9"); // no ACS sentinel handling, no _flag column
    expect(r.notes.some((n: string) => n.includes("WPFINWGT") && n.includes("keys and weight added"))).toBe(true);
  });

  it("SIPP state is the interview state and nothing below", async () => {
    const spec = { requests: [{ name: "md", endpoint: "query", params: { dataset: "2024/sipp", get: "TPTOTINC", state: "Maryland" } }] };
    const url = (await items(spec)).md[0].url;
    expect(url).toContain("/2024/sipp?get=TPTOTINC,SSUID,PNUM,MONTHCODE,WPFINWGT");
    expect(url).toContain("TST_INTV=24");
    expect(url).not.toContain("for=");
    const bad = { requests: [{ name: "x", endpoint: "query", params: { dataset: "2024/sipp", get: "TPTOTINC", state: "MD", county: "031" } }] };
    const f = await fetchFail(bad);
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("SIPP has no geography below the state");
  });

  it("time series links and checks", async () => {
    const spec = { requests: [
      { name: "duty", endpoint: "query", params: { dataset: "trade_imports_hs", get: "CTY_NAME,CAL_DUT_MO", CTY_CODE: "5700",
        COMM_LVL: "HS2", time: "2026-08" } },
      { name: "qtax", endpoint: "query", params: { dataset: "eits_qtax", get: "CELL_VALUE,CATEGORY_CODE", state: "MD", time: "2026-Q1" } }] };
    const it = await items(spec);
    expect(it.duty[0].url).toContain("/timeseries/intltrade/imports/hs?get=CTY_NAME,CAL_DUT_MO");
    expect(it.duty[0].url).not.toContain("for=");
    expect(it.qtax[0].url).toContain("for=state:24");
    const bad = { requests: [
      { name: "a", endpoint: "query", params: { dataset: "trade_exports_hs", get: "ALL_VAL_MO" } },
      { name: "b", endpoint: "query", params: { dataset: "eits_retail", get: "cell_value", for: "us:*" } }] };
    const f = await fetchFail(bad);
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("international trade needs a time");
    expect(f.message).toContain("a time series needs time");
  });

  it("Household Pulse and homeownership aliases", async () => {
    await keyed();
    const s = newSession();
    const spec = { requests: [
      { name: "pulse_expense_2024", endpoint: "query", params: { dataset: "pulse",
        get: "MEASURE_NAME,MEASURE_LABEL,RATE,RATE_MOE,TOTAL,UNIVERSE,CYCLE,PHASE,COL_START_DATE,COL_END_DATE",
        for: "us:*", time: "2024", MEASURE_NAME: "EXPENSE" } },
      { name: "pulse_covid_expense_2023", endpoint: "query", params: { dataset: "pulse_covid",
        get: "EXPENSE_RATE,EXPENSE_RT_MOE,EXPENSE_TOTAL,EXPENSE_UNIV,WEEK,COL_START_DATE,COL_END_DATE", for: "us:*", time: "2023" } },
      { name: "homeownership_2025", endpoint: "query", params: { dataset: "eits_homeownership",
        get: "cell_value,data_type_code,category_code,seasonally_adj,time_slot_id,geo_level_code,error_data",
        for: "us:*", time: "2025", category_code: "RATE" } }] };
    await fetchOk(s, "census", spec);
    const p = Object.fromEntries(csv(s, "census", "pulse_expense_2024").map((x) => [x.CYCLE, x]));
    expect(Object.keys(p).sort()).toEqual(Array.from({ length: 9 }, (_, i) => `0${i + 1}`));
    const c9 = p["09"];
    expect([c9.PHASE, c9.RATE, c9.RATE_MOE]).toEqual(["4.2", "37.1", "0.7"]);
    expect((100 * Number(c9.TOTAL)) / Number(c9.UNIVERSE)).toBeCloseTo(Number(c9.RATE), 1);
    const w = Object.fromEntries(csv(s, "census", "pulse_covid_expense_2023").map((x) => [x.WEEK, x]));
    expect([w["63"].EXPENSE_RATE, w["63"].EXPENSE_RT_MOE]).toEqual(["40.8", "0.6"]);
    const hv = csv(s, "census", "homeownership_2025");
    const hor = Object.fromEntries(hv.filter((x) => x.data_type_code === "HOR").map((x) => [x.time, x.cell_value]));
    expect(hor).toEqual({ "2025-Q1": "65.1", "2025-Q2": "65.0", "2025-Q3": "65.3", "2025-Q4": "65.7" });
    const e = hv.filter((x) => x.data_type_code === "E_HOR");
    expect(new Set(e.map((x) => x.cell_value))).toEqual(new Set(["0.5"]));
    expect(new Set(e.map((x) => x.error_data))).toEqual(new Set(["yes"]));
    expect(new Set(hv.filter((x) => x.data_type_code === "SAHOR").map((x) => x.seasonally_adj))).toEqual(new Set(["yes"]));
  });

  it("names resolve offline only to the release-calendar guess (synchronous manual items)", async () => {
    const spec = { requests: [{ name: "m", endpoint: "query",
      params: { dataset: "2023/acs/acs5", get: "NAME,B01003_001E", state: "MD", county: "Montgomery" } }] };
    const i = (await items(spec)).m[0];
    expect(i.note).toContain("geography names could not be resolved here");
    expect(i.url).not.toContain("county:");
  });

  it("latest and names resolve in links", async () => {
    noKey();
    fixtures("census");
    const pack = await load("census");
    const urls = Object.fromEntries((await manualItemsAsync(GEO, pack)).map((i) => [i.request, i.url]));
    expect(urls.montgomery).toContain("/2024/acs/acs5?"); // newest vintage, not hard-coded
    expect(urls.montgomery).toContain("for=county:031&in=state:24");
    expect(urls.montgomery).toContain("B25077_001E,B25077_001M,B25064_001E,B25064_001M");
    expect(urls.baltimore_city).toContain("for=place:04000&in=state:24"); // Baltimore city, not a CDP
    // what was looked up is reused by the synchronous manual items of manual_bundle
    const sync = Object.fromEntries(adapter.manualItems!(GEO, pack).map((i) => [i.request, i.url]));
    expect(sync).toEqual(urls);
  });

  it("did you mean", async () => {
    await keyed();
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "query",
      params: { dataset: "acs5", get: "NAME,B01003_001E", state: "Maryland", county: "Montgomry" } }] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("Did you mean: Montgomery County");
    const st = await fetchFail({ requests: [{ name: "x", endpoint: "query", params: { dataset: "acs5", get: "NAME", state: "Marylnd" } }] });
    expect(st.code).toBe("invalid_request");
    expect(st.message).toContain("Did you mean: Maryland");
    const amb = await fetchFail({ requests: [{ name: "x", endpoint: "query",
      params: { dataset: "acs5", get: "NAME", state: "MD", county: "Baltimore" } }] });
    expect(amb.code).toBe("invalid_request");
    expect(amb.message).toContain("ambiguous");
  });

  it("margins of error cannot be dropped, and ACS 1-year has no tracts", async () => {
    const f = await fetchFail({ requests: [{ name: "a", endpoint: "query",
      params: { dataset: "acs1", get: "NAME,B19013_001E", for: "tract:*", state: "MD", moe: false } }] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("never dropped");
    expect(f.message).toContain("ACS 1-year has no tracts");
  });

  it("searches variables", async () => {
    const s = newSession();
    fixtures("census");
    const r: any = await T.requestSchema(s, { source: "census", search: "2020/dec/pl: total population" });
    const ids = r.results.map((x: any) => x.variable ?? x.id);
    expect(ids).toContain("P1_001N");
    expect(r.results.some((x: any) => x.dataset === "2020/dec/pl")).toBe(true);
  });

  it("normalize: special values and top-codes", () => {
    const rows = [
      { NAME: "A", B25077_001E: "2000001", B25077_001M: "-555555555", B19013_001E: "-666666666", B19013_001M: "-222222222", state: "24" },
      { NAME: "B", B25077_001E: "350000", B25077_001M: "4100", B19013_001E: "90000", B19013_001M: "-999999999", state: "11" }];
    const out: any[] = normalize({}, {}, rows);
    expect(out[0].B25077_001E).toBe("2000001"); // top-code kept, flagged
    expect(out[0].B25077_001E_flag).toContain("$2,000,000 or more");
    expect(out[0].B25077_001M).toBe("");
    expect(out[0].B25077_001M_flag).toContain("treat the margin of error as zero");
    expect(out[0].B19013_001E).toBe("");
    expect(out[0].B19013_001E_flag).toContain("could not be computed");
    expect(out[1].B19013_001M).toBe("");
    expect(out[1].B19013_001M_flag).toContain("(N)");
    expect(out[1].B19013_001E_flag).toBe("");
    expect(Object.keys(out[0]).slice(0, 4)).toEqual(["NAME", "B25077_001E", "B25077_001E_flag", "B25077_001M"]);
  });

  it("reads uploads from data.census.gov", async () => {
    const pack = await load("census");
    const req = { name: "s1501", params: { get: ["NAME", "S1501_C02_015E"] } };
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "census-up-"));
    const j = path.join(t, "s1501.json"); // data.census.gov table JSON: every column of the table
    fs.writeFileSync(j, JSON.stringify({ response: { data: [["GEO_ID", "NAME", "S1501_C01_006E", "S1501_C02_015E", "S1501_C02_015M"],
      ["0400000US25", "Massachusetts", "1", "48.3", "0.4"]] } }));
    let rows: any[] = parseUpload(pack, req, [j]);
    expect({ geo_fips: rows[0].geo_fips, S1501_C02_015E: rows[0].S1501_C02_015E, S1501_C02_015M: rows[0].S1501_C02_015M })
      .toEqual({ geo_fips: "25", S1501_C02_015E: "48.3", S1501_C02_015M: "0.4" });
    expect(rows[0]).not.toHaveProperty("S1501_C01_006E");
    const c = path.join(t, "s1501.csv"); // its "Download Table" CSV, read long
    fs.writeFileSync(c, 'Label (Grouping),Alabama!!Estimate,Alabama!!Margin of Error\n"Bachelor\'s degree or higher","29.9%","±0.4"\n');
    rows = parseUpload(pack, req, [c]);
    expect(rows.map((r) => [r.geography, r.measure, r.value])).toEqual([["Alabama", "Estimate", 29.9], ["Alabama", "Margin of Error", 0.4]]);
    // the table JSON names its year and product: kept on each row, and a 5-year file is no 1-year request
    const v = path.join(t, "b19013.json");
    fs.writeFileSync(v, JSON.stringify({ response: { dataAPIURI: "https://api.census.gov/data/2024/acs/acs5?get=group(B19013)",
      objectId: "ACSDT5Y2024.B19013", data: [["GEO_ID", "NAME", "B19013_001E"], ["0400000US51", "Virginia", "1"]] } }));
    const r5 = { name: "inc", params: { dataset: "acs5", get: ["NAME", "B19013_001E"] } };
    expect((parseUpload(pack, r5, [v])[0] as any).vintage).toBe("2024");
    expect(() => parseUpload(pack, { ...r5, params: { ...r5.params, dataset: "acs1" } }, [v])).toThrow(DataError);
    const b = path.join(t, "bad.json");
    fs.writeFileSync(b, JSON.stringify({ x: 1 }));
    expect(() => parseUpload(pack, req, [b])).toThrow(DataError); // never an empty table that looks fine
  });

  // ------------------------------------------------------------------ ACS PUMS and CPS microdata
  it("PUMS replicates are split, joined, with a codebook", async () => {
    await keyed();
    const s = newSession();
    const r = await fetchOk(s, "census", MICRO);
    expect(r.status).toBe("ok");
    const rows = csv(s, "census", "wy_pums");
    expect(rows.length).toBe(53);
    const reps = Array.from({ length: 80 }, (_, i) => `PWGTP${i + 1}`);
    expect(Object.keys(rows[0])).toEqual(["AGEP", "HICOV", "PINCP", "SERIALNO", "SPORDER", "PWGTP", "WGTP", "ADJINC", ...reps, "state"]);
    expect(rows.every((x) => Number(x.AGEP) >= 90 && Number(x.AGEP) <= 99)).toBe(true);
    // the second call's replicates landed on the same persons: compare with the recorded call itself
    const [head, ...call2] = JSON.parse(fs.readFileSync(path.join(FIX, "wy_pums2024_call2.json"), "utf8"));
    const want = Object.fromEntries(call2.map((x: string[]) => [`${x[head.indexOf("SERIALNO")]}|${x[head.indexOf("SPORDER")]}`,
      x[head.indexOf("PWGTP80")]]));
    expect(Object.fromEntries(rows.map((x) => [`${x.SERIALNO}|${x.SPORDER}`, x.PWGTP80]))).toEqual(want);
    const notes = r.notes.join(" | ");
    expect(notes).toContain("added ADJINC"); // PINCP's label says to use ADJINC
    expect(notes).toContain("2 calls of at most 50 variables, joined on SERIALNO, SPORDER");
    const book = csv(s, "census", "wy_pums_codebook");
    const lab = Object.fromEntries(book.map((x) => [`${x.variable}|${x.value}`, x.value_label]));
    expect(lab["HICOV|2"]).toBe("No health insurance coverage");
    expect(lab["PINCP|-19999"]).toContain("N/A (less than 15");
    const dd = Object.fromEntries(readCsv(fs.readFileSync(path.join(s.workspace, "data", "census", "data_dictionary.csv"), "utf8"))
      .map((x: any) => [`${x.table}|${x.column}`, x]));
    expect(dd["wy_pums|PWGTP80"].non_missing).toBe("53");
    expect(dd["wy_pums|SERIALNO"].type).toBe("text");
    expect(rows.every((x) => x.SERIALNO.startsWith("2024"))).toBe(true); // keys stay text
  });

  it("CPS ASEC and basic: keys and weights", async () => {
    await keyed();
    const s = newSession();
    await fetchOk(s, "census", MICRO);
    const a = csv(s, "census", "wy_asec");
    expect(Object.keys(a[0])).toEqual(["A_AGE", "NOW_COV", "H_SEQ", "A_LINENO", "PERIDNUM", "MARSUPWT", "HSUP_WGT", "state"]);
    expect(new Set(a.map((x) => `${x.H_SEQ}|${x.A_LINENO}`)).size).toBe(a.length); // the person key is unique
    const b = csv(s, "census", "wy_basic");
    expect(Object.keys(b[0]).slice(0, 7)).toEqual(["PRTAGE", "PEMLR", "HRHHID", "HRHHID2", "PULINENO", "PWSSWGT", "PWCMPWGT"]);
    expect(b[0].HRHHID.startsWith("0") || b[0].HRHHID.length === 15).toBe(true); // text, zeros kept
  });

  it("microdata spec checks", async () => {
    const f = await fetchFail({ requests: [
      { name: "a", endpoint: "query", params: { dataset: "2004/cps/asec/mar", get: "PTOTVAL", replicates: true } },
      { name: "b", endpoint: "query", params: { dataset: "acs1_pums", get: "AGEP", state: "MD", county: "Montgomery" } },
      { name: "c", endpoint: "query", params: { dataset: "acs1_pums", get: "AGEP", agep: "25:54" } },
      { name: "d", endpoint: "query", params: { dataset: "2026/cps/basic/sep", get: "PEMLR", replicates: true } },
      { name: "e", endpoint: "query", params: { dataset: "1998/cps/asec/mar", get: "A_AGE", state: "MD" } }] });
    expect(f.code).toBe("invalid_request");
    const m = f.message;
    expect(m).toContain("ASEC replicate weight files start with 2005");
    expect(m).toContain("ipums");
    expect(m).toContain("smallest area is the PUMA");
    expect(m).toContain("filters are variable names in upper case");
    expect(m).toContain("basic monthly files have no replicate weights");
    expect(m).toContain("ASEC files before 2001 take no state geography");
  });

  it("microdata links: national by state, in chunks", async () => {
    const it = await items({ requests: [
      { name: "us", endpoint: "query", params: { dataset: "2024/acs/acs1/pums", get: "HICOV,AGEP", AGEP: "0:18", replicates: true } },
      { name: "cps_us", endpoint: "query", params: { dataset: "2026/cps/basic/sep", get: "PEMLR" } },
      { name: "puma", endpoint: "query", params: { dataset: "2024/acs/acs1/pums", get: "HICOV", state: "MD",
        for: "public use microdata area:*" } }] });
    expect(it.us.length).toBe(51 * 2); // 50 states and DC, two calls each
    expect(it.us[0].url).toContain("for=state:01");
    expect(it.us[1].url).toContain("AGEP=0:18"); // every call repeats the filter
    expect(it.us[1].url).toContain("SERIALNO,SPORDER"); // and carries the join keys
    expect(it.us[it.us.length - 1].url).toContain("for=state:56");
    expect(it.cps_us.length).toBe(1);
    expect(it.cps_us[0].url).not.toContain("for="); // the nation: no geography (old ASEC fails with one)
    expect(it.puma.length).toBe(1);
    expect(it.puma[0].url).toContain("for=public+use+microdata+area:*&in=state:24");
  });

  it("ASEC replicates are joined from Census's file", async () => {
    await keyed();
    const s = newSession();
    const spec = { requests: [{ name: "wy_asec_rw", endpoint: "query",
      params: { dataset: "2026/cps/asec/mar", get: "A_AGE,NOW_COV", state: "WY", A_AGE: "80:85", replicates: true } }] };
    const r = await fetchOk(s, "census", spec);
    const rows = csv(s, "census", "wy_asec_rw");
    expect(rows.length).toBe(78);
    const cols = Object.keys(rows[0]);
    expect(cols.slice(0, 9)).toEqual(["A_AGE", "NOW_COV", "H_SEQ", "A_LINENO", "PERIDNUM", "PH_SEQ", "PPPOS", "MARSUPWT", "HSUP_WGT"]);
    expect(cols.slice(-160)).toEqual(Array.from({ length: 160 }, (_, i) => `PWWGT${i + 1}`));
    expect(r.notes.some((n: string) => n.includes("sums match the totals") && n.includes("PWWGT0 equals MARSUPWT"))).toBe(true);
    // links for the manual route: the two Census files, no key
    const rw = (await items(spec)).wy_asec_rw.filter((i) => i.filename.startsWith("wy_asec_rw_repwgt"));
    expect(rw.map((i) => i.url.split("/").pop()).sort()).toEqual(["CPS_ASEC_ASCII_REPWGT_2026.DAT.GZ", "CPS_ASEC_ASCII_REPWGT_2026.SAS"]);
    expect(rw.some((i) => i.needs_key)).toBe(false);
  });

  it("ASEC replicate gates", () => {
    const blob = zlib.gunzipSync(fs.readFileSync(path.join(FIX, "trimmed_asec2026_repwgt.dat.gz")));
    const sas = fs.readFileSync(path.join(FIX, "trimmed_asec2026_repwgt.sas")).toString("latin1");
    const idx = asecRwIndex(blob, sas);
    expect(idx.records).toBe(78);
    const key = idx.offsets.keys().next().value!.split("|").map(Number) as [number, number];
    const [w0, reps] = asecRwValues(blob, idx, key)!;
    expect(reps.length).toBe(160);
    expect(reps[0]).toMatch(/^-?\d+\.\d{4}$/);
    const bad = sas.replace(/(PWWGT0\s*=\s*)([\d.]+)/, (_m, a, b) => a + String(Number(b) + 5));
    expect(() => asecRwIndex(blob, bad)).toThrow(DataError); // a file that does not add up to its stated totals
    expect(() => asecRwIndex(blob.subarray(0, Math.floor(blob.length / 2)), sas)).toThrow(DataError); // a cut download
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "census-rw-")); // a person whose PWWGT0 is not their MARSUPWT
    const src = path.join(t, "a.csv"), dst = path.join(t, "b.csv");
    fs.writeFileSync(src, `PH_SEQ,PPPOS,MARSUPWT\n${key[0]},${key[1]},${(w0 + 1).toFixed(4)}\n`);
    expect(() => asecJoin(src, dst, ["PH_SEQ", "PPPOS", "MARSUPWT"], blob, idx)).toThrow(DataError);
    fs.writeFileSync(src, `PH_SEQ,PPPOS,MARSUPWT\n${key[0]},${key[1]},${w0.toFixed(4)}\n`);
    const [cols, n] = asecJoin(src, dst, ["PH_SEQ", "PPPOS", "MARSUPWT"], blob, idx);
    expect([n, cols.length]).toEqual([1, 163]);
  });

  it("never sends the key to www2", async () => {
    const seen: [string, boolean | undefined][] = [];
    const fake: any = { base: "https://api.census.gov/data",
      request: async (_m: string, p: string, _q: unknown, o: any) => (seen.push([p, o.useKey]), null) };
    await censusGet(fake, "https://www2.census.gov/programs-surveys/cps/datasets/2026/march/");
    await censusGet(fake, "/2024/acs/acs1/pums", { get: "AGEP" });
    expect(seen.map(([, k]) => k)).toEqual([false, true]);
  });

  it("names the renamed PUMS state variable (ST to STATE from 2023)", async () => {
    expect(renameHint("2024/acs/acs1/pums", "ST")).toContain("ST is named STATE from the 2023 file on");
    expect(renameHint("2023/acs/acs5/pums", "ST")).toContain("STATE");
    expect(renameHint("2023/acs/acs1/pumspr", "ST")).toContain("STATE");
    expect(renameHint("2022/acs/acs5/pums", "STATE")).toContain("STATE is named ST before the 2023 file");
    expect(renameHint("2022/acs/acs1/pums", "ST")).toBeNull(); // still ST then
    expect(renameHint("2024/acs/acs1/pums", "AGEP")).toBeNull();
    expect(renameHint("2026/cps/asec/mar", "ST")).toBeNull();
    // microMeta's refusal carries the hint (a 404 on /variables/ST.json, as the live API answers)
    fixtures("census"); // no response cache
    const fake: any = { base: "https://api.census.gov/data",
      request: async (_m: string, p: string) => p.endsWith("/ST.json")
        ? { status: 404, body: Buffer.from("<html>not found</html>") }
        : { status: 200, body: Buffer.from('{"name": "PWGTP"}'), json: () => ({ name: "PWGTP" }) } };
    const e = await microMeta(fake, await load("census"), "2024/acs/acs1/pums", ["ST", "PWGTP"]).catch((x) => x);
    expect(e).toBeInstanceOf(DataError);
    expect(e.kind).toBe("bad_request");
    expect(e.message).toContain("not variables of 2024/acs/acs1/pums: ST (ST is named STATE from the 2023 file on");
    expect(e.message).toContain("state column");
  });

  it("merges chunks out of order, and refuses a missing person", () => {
    const p1: [string[], Iterable<any[]>] = [["X", "K", "state"], [["1", "a", "56"], ["2", "b", "56"], ["3", "c", "56"]]];
    const p2: [string[], Iterable<any[]>] = [["R1", "K"], [["r-a", "a"], ["r-c", "c"], ["r-b", "b"]]];
    let [cols, rows] = mergeChunks([p1, p2], ["K"]);
    expect(cols).toEqual(["X", "K", "state", "R1"]);
    expect([...rows]).toEqual([["1", "a", "56", "r-a"], ["2", "b", "56", "r-b"], ["3", "c", "56", "r-c"]]);
    [cols, rows] = mergeChunks([[["X", "K"], [["1", "a"], ["2", "b"]]], [["R1", "K"], [["r-b", "b"], ["r-z", "z"]]]], ["K"]);
    expect(() => [...rows]).toThrow(DataError); // never a blank replicate for a missing person
    const body = Buffer.from('[["A","B"],\n["1",null],\n["2","x"]]');
    expect([...iterRows(body)]).toEqual([["A", "B"], ["1", null], ["2", "x"]]);
  });

  it("a microdata upload joins the manual files", async () => {
    const pack = await load("census");
    const req = { name: "wy_pums", params: MICRO.requests[0].params };
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "census-mu-"));
    ["wy_pums2024_call1.json", "wy_pums2024_call2.json"].forEach((f, i) =>
      fs.copyFileSync(path.join(FIX, f), path.join(t, `wy_pums_${String(i + 1).padStart(3, "0")}.json`)));
    const rows: any[] = parseUpload(pack, req, fs.readdirSync(t).sort().map((f) => path.join(t, f)));
    expect(rows.length).toBe(53);
    expect(rows[0]).toHaveProperty("PWGTP80");
    expect(rows[0]).toHaveProperty("PWGTP1");
  });

  it("margin-of-error names", () => {
    expect(withMoe(["NAME", "B19013_001E", "S1701_C03_001E", "DP03_0062PE", "P1_001N"])).toEqual(
      ["NAME", "B19013_001E", "B19013_001M", "S1701_C03_001E", "S1701_C03_001M", "DP03_0062PE", "DP03_0062PM", "P1_001N"]);
  });
});
