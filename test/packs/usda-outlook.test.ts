/**
 * usda-outlook pack tests (offline), ported from tests/sources/usda-outlook/test_usda_outlook.py. Fixtures are real
 * files fetched live (keyless) on 2026-10-30; several are trimmed real copies (see the Python test's docstring).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { baselineEditions, day, fiwReleases, pickEdition, pickRelease } from "../../src/adapters/_usda-outlook_read.js";
import { estimateType, flag } from "../../src/adapters/usda-outlook.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

beforeAll(() => isolate());

const FIX = path.join(TEST_DIR, "packs", "usda-outlook", "fixtures");
const SRC = "usda-outlook";
const CORN_US = "U.S. Feed Grain and Corn Supply and Use";
const SPEC = { description: "Latest WASDE U.S. corn, its 2026/27 ending stocks path, 2026 net farm income, baseline corn",
  requests: [
    { name: "corn_us", endpoint: "wasde", params: { report_title: CORN_US, commodity: "Corn" } },
    { name: "corn_path", endpoint: "wasde", params: { start_report: "2026-06", end_report: "2026-10", report_title: CORN_US,
      commodity: "Corn", attribute: "Ending Stocks", market_year: "2026/27" } },
    { name: "nfi", endpoint: "farm_income", params: { variable: ["net farm income", "Net cash income"], state: ["US", "ia"], start_year: 2020 } },
    { name: "summary", endpoint: "farm_income_summary", params: {} },
    { name: "vintages", endpoint: "farm_income_archive", params: { item: "nfi", year: 2025 } },
    { name: "base_corn", endpoint: "baseline", params: { commodity: "Corn", attribute: "Ending stocks" } },
    { name: "base_income", endpoint: "baseline", params: { member: "*Farm receipts*" } }] };

describe("usda-outlook", () => {
  it("check: the sample spec is valid", async () => {
    expect(gr.checkSpec(await load(SRC), SPEC)).toEqual([]);
  });

  it("fetch", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.status).toBe("ok");
    const notes = r.notes.join(" ");
    // WASDE latest = newest ESMIS release (2026-10-09) -> the 2026-10 CSV
    expect(notes).toContain("corn_us: report = 2026-10 (WASDE 676, released 2026-10-09)");
    const corn = csv(s, SRC, "corn_us");
    expect(new Set(Object.keys(corn[0]))).toEqual(new Set(["WasdeNumber", "ReportDate", "ReportTitle", "Attribute",
      "ReliabilityProjection", "Commodity", "Region", "MarketYear", "ProjEstFlag", "AnnualQuarterFlag", "Value", "Unit",
      "ReleaseDate", "ReleaseTime", "ForecastYear", "ForecastMonth"]));
    const es = Object.fromEntries(corn.filter((x) => x.Attribute === "Ending Stocks").map((x) => [x.MarketYear, [x.ProjEstFlag, x.Value, x.Unit]]));
    expect(es).toEqual({ "2024/25": ["", "1551.00", "Million Bushels"], "2025/26": ["Est.", "2095.00", "Million Bushels"],
      "2026/27": ["Proj.", "1849.00", "Million Bushels"] });
    expect(new Set(corn.map((x) => x.ReportTitle))).toEqual(new Set([CORN_US]));
    // month-to-month path; 2026-06 is a real 404 (reissued v2 report) and is skipped with its reason
    expect(csv(s, SRC, "corn_path").map((x) => [x.ReportDate, x.Value])).toEqual([["July 2026", "1790.00"],
      ["August 2026", "1653.00"], ["September 2026", "1567.00"], ["October 2026", "1849.00"]]);
    expect(notes).toContain("2026-06: the June 2026 report was reissued");
    // farm income: read from the release ZIP, filtered, unit padding stripped, estimate_type added
    const nfi = csv(s, SRC, "nfi");
    const us = Object.fromEntries(nfi.filter((x) => x.State === "US").map((x) => [`${x.Year}|${x.VariableDescriptionTotal}`, x]));
    const x = us["2026|Net farm income"];
    expect([x.Amount, x.unit_desc, x.ChainType_GDP_Deflator, x.release_date, x.estimate_type, x.artificialKey])
      .toEqual(["158353790", "$1,000", "100.000", "2026-09-03", "forecast", "FIAUSNTFI--P"]);
    expect([us["2025|Net farm income"].Amount, us["2025|Net farm income"].estimate_type]).toEqual(["162614960", "estimate"]);
    expect(us["2026|Net cash income"].Amount).toBe("176430198");
    const ia = nfi.filter((y) => y.State === "IA" && y.VariableDescriptionTotal === "Net farm income");
    expect(Math.max(...ia.map((y) => Number(y.Year)))).toBe(2025); // no state rows for a forecast year
    const allowed = new Set(Array.from({ length: 7 }, (_, i) => String(2020 + i)));
    expect(nfi.filter((y) => !allowed.has(y.Year))).toEqual([]);
    expect(notes).toContain("forecast year(s) 2026");
    // summary workbook: forecast column 2026F, billion dollars
    const sm = Object.fromEntries(csv(s, SRC, "summary").map((y) => [y.item, y]));
    const nf = sm["l. Net farm income (j-k)"];
    expect([nf.section, nf.unit, nf["2026F"], nf["2025"]]).toEqual(["Farm income statement", "Billion Dollars", "158.35379", "162.61496"]);
    expect(sm["Debt-to-equity"].unit).toBe("Percent");
    expect(notes).toContain("data as of 2026-09-03");
    const head = fs.readFileSync(path.join(s.workspace, "data", SRC, "summary.csv"), "utf8").split("\r\n")[0];
    expect(head.startsWith("section,item,unit,2019,")).toBe(true); // year columns in the published order
    // archive of past forecasts: 2025 net farm income, release by release
    expect(csv(s, SRC, "vintages").map((y) => [y.release_year, y.release_month, y.release_number, y.amount])).toEqual([
      ["2025", "feb", "1", "180114083"], ["2025", "sep", "2", "179846374"], ["2026", "feb", "4", "154537944"],
      ["2026", "sep", "5", "162614960"]]);
    // baseline: the full release (media 5014), projections CSV and Table 26 workbook
    const b = Object.fromEntries(csv(s, SRC, "base_corn").map((y) => [y.year, y.value]));
    expect([b["2025/26"], b["2026/27"], b["2035/36"]]).toEqual(["2154", "2019", "2259"]);
    expect(notes).toContain("Projections to 2035 (full release, last updated 2/13/2026)");
    const inc = Object.fromEntries(csv(s, SRC, "base_income").map((y) => [y.col1, y]));
    expect(inc["Cash receipts"]["2026"]).toBe("540.875330651853"); // .xlsx float in shortest form
  });

  it("warns about several report tables; reliability rows on request", async () => {
    const spec = { requests: [
      { name: "es", endpoint: "wasde", params: { report: "2026-10", commodity: "corn", region: "United States", attribute: "ending stocks" } },
      { name: "rel", endpoint: "wasde", params: { report: "2026-10", commodity: "Corn", attribute: "Ending Stocks", include_reliability: true,
        report_title: "Reliability of United States October Projections" } },
      { name: "proj", endpoint: "wasde", params: { report: "2026-10", commodity: "Corn", region: "United States", proj_est: "proj" } }] };
    const s = newSession();
    const r = await fetchOk(s, SRC, spec);
    const es = csv(s, SRC, "es");
    expect(new Set(es.map((x) => x.Unit))).toEqual(new Set(["Million Bushels", "Million Metric Tons"]));
    expect(es.some((x) => x.ReportTitle.startsWith("Reliability"))).toBe(false);
    expect(r.notes.join(" ")).toContain("the same item comes from 2 report tables");
    const rel = csv(s, SRC, "rel");
    expect(rel.length).toBe(7);
    expect(rel.map((x) => [x.ReliabilityProjection, x.Value, x.Unit])).toContainEqual(["root_mean_square_error", "26.80", "Percent"]);
    expect(new Set(csv(s, SRC, "proj").map((x) => x.MarketYear))).toEqual(new Set(["2026/27"]));
  });

  it("bad specs are refused", async () => {
    const p = await load(SRC);
    for (const [params, ep] of [[{ variable: [] }, "farm_income"], [{ variable: "Net farm income", state: "Iowa" }, "farm_income"],
      [{ report: "2019-05" }, "wasde"], [{ report: "Oct 2026" }, "wasde"], [{ report: "2026-10", start_report: "2026-01" }, "wasde"],
      [{ proj_est: "forecast" }, "wasde"], [{ edition: "newest" }, "baseline"]] as [any, string][]) {
      expect(gr.checkSpec(p, { requests: [{ name: "x", endpoint: ep, params }] }).length, JSON.stringify(params)).toBeGreaterThan(0);
    }
  });

  it("a missing month alone is an error", async () => {
    const spec = { requests: [{ name: "june", endpoint: "wasde", params: { report: "2026-06", commodity: "Corn" } }] };
    const s = newSession();
    fixtures(SRC);
    await prepare(s, SRC, spec);
    const f = await failure(T.fetchData(s, { source: SRC, spec }));
    expect(JSON.stringify(f)).toContain("reissued as a corrected v2 report");
  });

  it("manual bundle links (the pages are not read here: the fallback links)", async () => {
    const s = newSession();
    const spec = { ...SPEC, requests: [...SPEC.requests, { name: "oct", endpoint: "wasde", params: { report: "2026-10" } }] };
    const r: any = await T.manualBundle(s, { sources: [{ source: SRC, spec }] });
    const items = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8")).items
      .map((i: any) => [i.name, i]));
    expect(items["oct#2026-10"].url).toBe("https://www.usda.gov/sites/default/files/documents/oce-wasde-report-data-2026-10.csv");
    const t = new Date();
    const now = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
    expect(items[`corn_us#${now}`]).toBeTruthy(); // "latest": this month's CSV name
    expect(items["corn_path#2026-06"].url).toContain("2026-06.csv");
    expect(items["nfi#1"].url).toBe("https://www.ers.usda.gov/data-products/farm-income-and-wealth-statistics/" +
      "data-files-us-and-state-level-farm-income-and-wealth-statistics");
    expect(items["base_corn#1"].url).toBe("https://www.ers.usda.gov/data-products/agricultural-baseline-database");
    expect(Object.values(items).some((i: any) => i.needs_key)).toBe(false);
  });

  it("ingests the downloaded files, filtered like a fetch", async () => {
    const spec = { requests: [
      { name: "corn", endpoint: "wasde", params: { report: "2026-10", report_title: CORN_US, attribute: "Ending Stocks", commodity: "Corn" } },
      { name: "nfi", endpoint: "farm_income", params: { variable: "Net farm income", state: "US", year: 2026 } },
      { name: "base", endpoint: "baseline", params: { commodity: "Wheat", attribute: "Ending stocks", year: "2030/31" } }] };
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "uo-up-"));
    fs.copyFileSync(path.join(FIX, "wasde_2026-10_trimmed.csv"), path.join(up, "corn_2026-10.csv"));
    fs.copyFileSync(path.join(FIX, "september-3-2026-release_trimmed.zip"), path.join(up, "nfi.zip"));
    fs.copyFileSync(path.join(FIX, "baseline_2035_full_trimmed.zip"), path.join(up, "base.zip"));
    const s = newSession();
    delete process.env.DATA_ANALYST_FIXTURES;
    await prepare(s, SRC, spec);
    const r: any = await T.ingest(s, { source: SRC, spec, files: [up] });
    expect(r.status).toBe("ok");
    expect(csv(s, SRC, "corn").map((x) => x.Value)).toEqual(["1551.00", "2095.00", "1849.00"]);
    expect(csv(s, SRC, "nfi").map((x) => [x.Amount, x.estimate_type])).toEqual([["158353790", "forecast"]]);
    const base = csv(s, SRC, "base");
    expect(base.length).toBe(1);
    expect(base[0].commodity).toBe("Wheat");
    // a WASDE CSV under the agency's own name is the keyless file route
    const one = { requests: [spec.requests[0]] };
    const up2 = fs.mkdtempSync(path.join(os.tmpdir(), "uo-up2-"));
    fs.copyFileSync(path.join(FIX, "wasde_2026-10_trimmed.csv"), path.join(up2, "oce-wasde-report-data-2026-10.csv"));
    const s2 = newSession();
    await prepare(s2, SRC, one);
    const r2: any = await T.ingest(s2, { source: SRC, spec: one, files: [up2] });
    expect(r2.summary.route).toBe("keyless_file");
  });

  it("rules", () => {
    const sept26 = day(2026, 9, 3), feb26 = day(2026, 2, 5);
    expect([2026, 2025, 2024].map((y) => estimateType(y, sept26))).toEqual(["forecast", "estimate", "estimate"]);
    expect([2026, 2025, 2024].map((y) => estimateType(y, feb26))).toEqual(["forecast", "forecast", "estimate"]);
    expect(["Proj.", "(Proj.)", "Est.", "(Est.)", ""].map(flag)).toEqual(["proj", "proj", "est", "est", "none"]);
    const eds = baselineEditions(fs.readFileSync(path.join(FIX, "baseline.html"), "utf8"));
    expect(eds.slice(0, 3).map((e) => [e.to_year, e.kind])).toEqual([[2035, "early"], [2035, "full"], [2034, "full"]]);
    expect(pickEdition(eds, "latest").url.split("?")[0]).toBe(
      "https://www.ers.usda.gov/media/5014/usda-agricultural-baseline-projections-to-2035.zip");
    expect(pickEdition(eds, 2034).to_year).toBe(2034);
    const rels = fiwReleases(fs.readFileSync(path.join(FIX, "fiw.html"), "utf8"));
    expect([rels[0].date.iso, rels[1].date.iso]).toEqual([sept26.iso, feb26.iso]);
    expect(pickRelease(rels, "2024-12").url).toBe("https://www.ers.usda.gov/media/29593/december-3-2024-release.zip");
    expect(rels[rels.length - 1].url.endsWith("august-26-2014-release.csv")).toBe(true);
  });
});
