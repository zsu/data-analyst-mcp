/**
 * acf pack tests (offline), ported from tests/sources/acf/test_acf.py. Manual route only: acf.gov answers every
 * script with an AWS WAF JavaScript challenge (HTTP 202). The fixtures are archived copies of real ACF workbooks
 * (Internet Archive captures of the acf.gov file URLs, downloaded 2026-10-30), each standing in for the file a user
 * saves from the browser and uploads (see the Python test's docstring for the trimming).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cell, monthHeader, stateCode, tidy } from "../../src/adapters/_acf_tidy.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

beforeAll(() => isolate());

const FIX = path.join(TEST_DIR, "packs", "acf", "fixtures");
const FIN = { description: "FY 2024 TANF and MOE spending",
  requests: [{ name: "categories", endpoint: "tanf_financial", params: { fiscal_year: 2024 } }] };
const FIN_FILE = "fy-2024-tanf-moe-financial-data.xlsx";
const CASE_FILE = "fy2025-tanf-caseload.xlsx";
const CCDF_FILE = "ccdf-expenditures-for-fy-2022-all-appropriation-years.xlsx";

function upload(files: string[]): string {
  const up = fs.mkdtempSync(path.join(os.tmpdir(), "acf-up-"));
  for (const f of files) fs.copyFileSync(path.join(FIX, f), path.join(up, f));
  return up;
}

async function ingest(spec: any, files: string[]) {
  const s = newSession();
  delete process.env.DATA_ANALYST_FIXTURES;
  await prepare(s, "acf", spec);
  const up = upload(files);
  return { s, run: () => T.ingest(s, { source: "acf", spec, files: [up] }) };
}

async function ingestOk(spec: any, files: string[]) {
  const { s, run } = await ingest(spec, files);
  const r: any = await run();
  return { s, r };
}

async function checkProblems(spec: any): Promise<string> {
  const s = newSession();
  await prepare(s, "acf", spec);
  const f = await failure(T.fetchData(s, { source: "acf", spec }));
  expect(f.code).toBe("invalid_request");
  return f.message;
}

describe("acf", () => {
  it("fetch gives the manual download (nothing is sent to acf.gov)", async () => {
    const s = newSession();
    await prepare(s, "acf", FIN);
    const f = await failure(T.fetchData(s, { source: "acf", spec: FIN }));
    expect(f.code).toBe("agency_unavailable");
    expect(f.message).toContain("AWS WAF");
    expect(f.manual_bundle).toBeTruthy();
    const b: any = await T.manualBundle(s, { sources: [{ source: "acf", spec: FIN }] });
    const man = JSON.parse(fs.readFileSync(path.join(b.bundle, "manifest.json"), "utf8"));
    expect(man.items.map((i: any) => [i.url, i.filename])).toEqual([
      ["https://acf.gov/sites/default/files/documents/ofa/" + FIN_FILE, FIN_FILE]]);
    expect(man.items[0].note).toContain("web browser");
  });

  it("the adapter's fetch is blocked", async () => {
    const p = await load("acf");
    await expect(p.adapter!.fetch!(FIN, p, "api")).rejects.toMatchObject({ kind: "blocked" });
  });

  it("manual links", async () => {
    const p = await load("acf");
    const spec = { requests: [
      { name: "ssp", endpoint: "tanf_caseload", params: { fiscal_year: 2024, program: "ssp" } },
      { name: "both", endpoint: "tanf_caseload", params: { fiscal_year: 2023, program: "tanf_ssp" } },
      { name: "ccdf19", endpoint: "ccdf_expenditures", params: { fiscal_year: 2019 } },
      { name: "gy21", endpoint: "ccdf_expenditures", params: { fiscal_year: 2021, file: "grant_year" } },
      { name: "fin19", endpoint: "tanf_financial", params: { fiscal_year: 2019 } },
      { name: "ccdf16", endpoint: "ccdf_expenditures", params: { fiscal_year: 2016 } }] };
    const items = Object.fromEntries(p.adapter!.manualItems!(spec, p).map((i: any) => [i.request, i]));
    const b = "https://acf.gov/sites/default/files/documents/";
    expect(items.ssp.url).toBe(b + "ofa/fy2024-15months-ssp-caseload.xlsx");
    expect(items.both.url).toBe(b + "ofa/fy2023_tanssp_caseload.xlsx");
    expect([items.ccdf19.url, items.ccdf19.filename]).toEqual([b + "occ/ALL%20YEARS%20FY%202019%20Expenditures.xlsx",
      "ALL YEARS FY 2019 Expenditures.xlsx"]);
    expect(items.gy21.url).toBe(b + "occ/ccdf-expenditures-for-gy-2021-as-of-9-30-2022-tables-1b-12b.xlsx");
    // a year without a verified file name: the year's page, and a file name for the upload
    expect(items.fin19.url).toBe("https://acf.gov/ofa/data/tanf-financial-data-fy-2019");
    expect(items.fin19.filename).toBe("fin19_tanf_financial_2019.xlsx");
    expect(items.fin19.note).toContain("no verified file link");
    expect(items.ccdf16.url).toBe("https://acf.gov/occ/resource/fy-2016-ccdf-state-expenditure-data");
  });

  it("bad specs are refused", async () => {
    for (const [params, words] of [[{ fiscal_year: "last year" }, "four-digit year"], [{ fiscal_year: 1990 }, "1997 on"],
      [{}, "'fiscal_year' is required"], [{ fiscal_year: 2024, program: "snap" }, "program is a tanf_caseload parameter"],
      [{ fiscal_year: 2024, header_row: "two" }, "header_row"]] as [any, string][]) {
      const msg = await checkProblems({ requests: [{ name: "x", endpoint: "tanf_financial", params }] });
      expect(msg).toContain(words.replace("'fiscal_year'", '"fiscal_year"'));
    }
    const p = await load("acf");
    expect(gr.checkSpec(p, { requests: [{ name: "x", endpoint: "tanf_caseload", params: { fiscal_year: 2024, program: "medicaid" } }] })
      .length).toBeGreaterThan(0);
    expect((await checkProblems({ requests: [{ name: "x", endpoint: "ccdf_expenditures",
      params: { fiscal_year: 2016, file: "grant_year" } }] }))).toContain("GY 2018");
  });

  it("TANF financial upload", async () => {
    const spec = { description: "FY 2024 TANF financial data",
      requests: [{ name: "a1", endpoint: "tanf_financial", params: { fiscal_year: 2024 } },
        { name: "funds", endpoint: "tanf_financial", params: { fiscal_year: 2024, table: "A.5" } },
        { name: "b", endpoint: "tanf_financial", params: { fiscal_year: 2024, table: "B" } },
        { name: "dc", endpoint: "tanf_financial", params: { fiscal_year: 2024, table: "District of Columbia" } },
        { name: "f", endpoint: "tanf_financial", params: { fiscal_year: 2024, table: "F" } }] };
    const { s, r } = await ingestOk(spec, [FIN_FILE]);
    expect(r.summary.route).toBe("manual_download");
    const a1rows = csv(s, "acf", "a1");
    const a1 = Object.fromEntries(a1rows.map((x) => [x["Spending Category"], x]));
    expect(Object.keys(a1rows[0])).toEqual(["row", "Spending Category", "Federal Funds",
      "State MOE in TANF and Separate State Programs", "All Funds", "Percent of Total Funds Used", "sheet"]);
    const ba = a1["Basic Assistance"];
    expect([ba["Federal Funds"], ba["State MOE in TANF and Separate State Programs"], ba["All Funds"]])
      .toEqual(["3162142819.87", "5023870603.12", "8186013422.99"]);
    expect(ba["Percent of Total Funds Used"]).toBe("0.218202265449694"); // a fraction: 21.8%
    expect(a1["TOTAL FUNDS USED"]["All Funds"]).toBe("37515712342.03");
    expect(a1["Transferred to CCDF Discretionary"]["State MOE in TANF and Separate State Programs"]).toBe("");
    expect(ba.sheet).toBe("A.1 Fed & State by Category");
    const funds = csv(s, "acf", "funds");
    expect(funds.slice(-2).map((x) => [x.section, x.label, x.value])).toEqual([
      ["Carryover from Prior Years", "State Family Assistance Grant", "9783404395.36"],
      ["Carryover from Prior Years", "Total Funds Available", "26603502932.57"]]);
    const b = Object.fromEntries(csv(s, "acf", "b").map((x) => [x.state_code, x]));
    expect(Object.keys(b).length).toBe(52); // U.S. total, 50 states, DC
    expect([b.US.STATE, b.DC.STATE]).toEqual(["U.S. TOTAL", "DIST.OF COLUMBIA"]);
    expect(b.AL["6. Basic Assistance"]).toBe("32124953.24");
    expect(b.US["24. Total Expenditures"]).toBe("35000349713.11");
    expect(b.AL).toHaveProperty(["6.a. Basic Assistance - (excluding Relative Foster Care Maintenance Payments and Adoption and " +
      "Guardianship Subsidies)"]);
    const dc = Object.fromEntries(csv(s, "acf", "dc").map((x) => [x["Spending Category"], x]));
    expect(dc["Basic Assistance"]["All Funds"]).toBe("51920224.78");
    const f = csv(s, "acf", "f");
    expect(new Set(f.map((x) => x.block))).toEqual(new Set(["Transitional Services for Employed", "Job Access"]));
    const ja = f.filter((x) => x.block === "Job Access" && x.state_code === "US")[0];
    expect([ja.Total, ja.Federal, ja.State]).toEqual(["3345456.19", "2100000", "1245456.19"]);
  });

  it("TANF caseload upload", async () => {
    const spec = { description: "FY 2025 TANF caseload",
      requests: [{ name: "fam", endpoint: "tanf_caseload", params: { fiscal_year: 2025 } },
        { name: "rec", endpoint: "tanf_caseload", params: { fiscal_year: 2025, table: "recipients" } },
        { name: "avg", endpoint: "tanf_caseload", params: { fiscal_year: 2025, table: "avg_families" } },
        { name: "mar", endpoint: "tanf_caseload", params: { fiscal_year: 2025, table: "2025-03" } }] };
    const { s } = await ingestOk(spec, [CASE_FILE]);
    const fam = csv(s, "acf", "fam");
    expect(Object.keys(fam[0]).slice(0, 4)).toEqual(["row", "State", "state_code", "2024-10"]);
    expect(fam[0]).toHaveProperty("2025-12");
    expect(fam[0]).toHaveProperty(["Average CY 2025"]);
    const us = fam[0];
    expect([us.state_code, us["2024-10"], us["2025-09"]]).toEqual(["US", "873701", "832409"]);
    expect(us["Average FY 2025"]).toBe("849457.833333333");
    expect(fam.length).toBe(55); // U.S., 50 states, DC, Guam, Puerto Rico, Virgin Islands
    expect(new Set(fam.filter((x) => ["Guam", "Virgin Islands"].includes(x.State)).map((x) => x.state_code))).toEqual(new Set(["GU", "VI"]));
    const rec = Object.fromEntries(csv(s, "acf", "rec").map((x) => [x.state_code, x]));
    expect(rec.US["2024-10"]).toBe("2154454");
    const avg = csv(s, "acf", "avg");
    expect(new Set(avg.map((x) => x.block))).toEqual(new Set(["Fiscal Year 2025 (October - September)",
      "Calendar Year 2025 (January - December)"]));
    const cy = avg.filter((x) => x.block.startsWith("Calendar") && x.state_code === "US")[0];
    expect([cy["Total Families"], cy["No Parent Families"]]).toEqual(["836788.333333333", "326938.833333333"]);
    const mar = Object.fromEntries(csv(s, "acf", "mar").map((x) => [x.state_code, x]));
    expect([mar.US["Total Families"], mar.US.Adults, mar.US.Children]).toEqual(["848807", "577110", "1514959"]);
    expect(mar.US["Total Families"]).toBe(fam[0]["2025-03"]);
  });

  it("caseload, older layout (FY 2021: other sheet names, month headers as text, FY-only averages)", async () => {
    const spec = { requests: [{ name: "fam", endpoint: "tanf_caseload", params: { fiscal_year: 2021 } },
      { name: "avg", endpoint: "tanf_caseload", params: { fiscal_year: 2021, table: "avg_recipients" } }] };
    const { s } = await ingestOk(spec, ["fy2021_tanf_caseload.xlsx"]);
    const fam = csv(s, "acf", "fam");
    expect([fam[0]["2020-10"], fam[0].sheet]).toEqual(["865205", "Total Number of Families"]);
    expect(fam[0]).toHaveProperty(["Average FY 2021"]);
    const avg = csv(s, "acf", "avg");
    expect(avg[0]).not.toHaveProperty("block");
    expect([avg[0].state_code, avg[0]["Total Recipients"], avg[0].Adults]).toEqual(["US", "1847643.75", "422884.833333333"]);
  });

  it("CCDF upload", async () => {
    const spec = { requests: [{ name: "funds", endpoint: "ccdf_expenditures", params: { fiscal_year: 2022 } },
      { name: "cats", endpoint: "ccdf_expenditures", params: { fiscal_year: 2022, table: "3a" } },
      { name: "by_gy", endpoint: "ccdf_expenditures", params: { fiscal_year: 2022, table: "Table 1a" } }] };
    const { s } = await ingestOk(spec, [CCDF_FILE]);
    const funds = Object.fromEntries(csv(s, "acf", "funds").map((x) => [x.state_code, x]));
    expect(funds.AL.Mandatory).toBe("16441707");
    expect(funds.US.State).toBe("Total");
    expect(funds.US.Total).toBe("29097749868.57");
    expect(funds.AS.Total).toBe("-5965217.77"); // negative adjustments as published
    const cats = Object.fromEntries(csv(s, "acf", "cats").map((x) => [x.state_code, x]));
    expect(cats.AL["Direct Services"]).toBe("233813020.42");
    const gy = Object.fromEntries(csv(s, "acf", "by_gy").map((x) => [x.label, x]));
    expect([gy.Mandatory["GY 2022"], gy.Total["Total by Fund"]]).toEqual(["913695732", "29097749869"]);
  });

  it("a wrong table or file is refused", async () => {
    let f = await failure((await ingest({ requests: [{ name: "x", endpoint: "tanf_financial",
      params: { fiscal_year: 2024, table: "Z.9" } }] }, [FIN_FILE])).run());
    expect(f.message).toContain("no table 'Z.9'");
    expect(f.message).toContain("A.1 Fed & State by Category");
    f = await failure((await ingest({ requests: [{ name: "x", endpoint: "tanf_caseload",
      params: { fiscal_year: 2025, table: "2023-01" } }] }, [CASE_FILE])).run());
    expect(f.message).toContain("no sheet for 2023-01");
    // the empty WAF challenge page saved instead of the workbook
    const s = newSession();
    await prepare(s, "acf", FIN);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "acf-up2-"));
    fs.writeFileSync(path.join(up, FIN_FILE), "");
    f = await failure(T.ingest(s, { source: "acf", spec: FIN, files: [up] }));
    expect(f.message).toContain("not an Excel workbook");
  });

  it("tidy units", () => {
    expect(monthHeader("45566")).toBe("2024-10");
    expect(monthHeader("Oct-20")).toBe("2020-10");
    expect(monthHeader("Average FY 2025")).toBe("Average FY 2025");
    expect(cell("3162142819.8699999")).toBe("3162142819.87");
    expect(stateCode("DIST. OF COLUMBIA")).toBe("DC");
    expect(stateCode("U.S. Totals")).toBe("US");
    expect(stateCode("Spending Category")).toBe("");
    const rows = tidy([["Title"], ["State", "Total", "Adults"], ["Alabama", "5", "-"], ["Alaska", "3", "1"],
      ["Arizona", "2", "1"], ["Notes:"], ['"-" - data inapplicable']]);
    expect(Object.fromEntries(rows[0])).toEqual({ row: 3, State: "Alabama", state_code: "AL", Total: "5", Adults: "" });
    expect([...rows[0].keys()]).toEqual(["row", "State", "state_code", "Total", "Adults"]);
    expect(rows.length).toBe(3);
  });
});
