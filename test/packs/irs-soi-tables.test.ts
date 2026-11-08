/**
 * irs-soi published tables (table, table_list) and exempt organizations (eo_bmf, eo_extract), on recorded files:
 * the index pages cut to their file links, the published workbooks unchanged, the Wyoming EO BMF file and the 2024
 * Form 990-PF extract cut to a few organizations (all fetched 2026-11-08).
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findTable } from "../../src/adapters/_irs-soi_catalog.js";
import { headerNames, pageLinks, parseCell } from "../../src/adapters/_irs-soi_tables.js";
import { TOOLS } from "../../src/analysis/tools.js";
import { formatMark, readCsv } from "../../src/core/tabular.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

beforeAll(() => isolate());

const one = (rows: Record<string, string>[], f: (r: Record<string, string>) => boolean) => {
  const hit = rows.filter(f);
  expect(hit).toHaveLength(1);
  return hit[0];
};

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures("irs-soi");
  await prepare(s, "irs-soi", spec);
  return failure(T.fetchData(s, { source: "irs-soi", spec }));
}

describe("irs-soi table reader units", () => {
  it("reads the marker a number format prints, not fill characters", () => {
    expect(formatMark('"* "#,##0', "5636723")).toBe("*");
    expect(formatMark('"** "#,##0;"** "\\-#,##0', "-3")).toBe("**");
    expect(formatMark("_(* #,##0_);_(* \\(#,##0\\);_(* \"-\"??_);_(@_)", "12")).toBe("");
    expect(formatMark("#,##0", "12")).toBe("");
    expect(formatMark("General", "12")).toBe("");
  });

  it("splits a cell into its value and markers", () => {
    expect(parseCell("1,335")).toEqual({ value: "1335", flag: "" });
    expect(parseCell("* 1,335")).toEqual({ value: "1335", flag: "*" });
    expect(parseCell("[2]")).toEqual({ value: "", flag: "[2]" });
    expect(parseCell("d")).toEqual({ value: "", flag: "d" });
    expect(parseCell("38.00 [24]")).toEqual({ value: "38.00", flag: "[24]" });
    expect(parseCell("5636723", "*")).toEqual({ value: "5636723", flag: "*" });
    expect(parseCell("78.900000000000006")).toEqual({ value: "78.9", flag: "" });
    expect(parseCell("  ")).toBeNull();
  });

  it("names columns from stacked header lines; a span stops where the group above changes", () => {
    const g = [
      ["Item", "Gross estate", null, "Deductions", null, null, "Net estate tax", null],
      [null, null, null, "Charitable deduction", null, "Other", null, null],
      [null, "Number", "Amount", "Number", "Amount", "Amount", "Number", "Amount"],
    ];
    expect(headerNames(g, [1, 2, 3], 8, [0])).toEqual(["", "Gross estate | Number", "Gross estate | Amount",
      "Deductions | Charitable deduction | Number", "Deductions | Charitable deduction | Amount", "Deductions | Other | Amount",
      "Net estate tax | Number", "Net estate tax | Amount"]);
  });

  it("finds the file links of an index page, repairing a link written without its path", () => {
    const html = '<a href="/pub/irs-soi/23in11si.xls">2023 XLS</a> <a href="https://www.irs.gov11in02tr.xls">2011</a>' +
      ' <a href="/statistics/other">x</a> <a href="https://www.irs.gov/pub/irs-soi/histab20.xlsx">Table 20</a>';
    const links = pageLinks(html, "https://www.irs.gov/statistics/x");
    expect(links.map((l) => [l.file, l.url, l.year])).toEqual([
      ["23in11si.xls", "https://www.irs.gov/pub/irs-soi/23in11si.xls", 2023],
      ["11in02tr.xls", "https://www.irs.gov/pub/irs-soi/11in02tr.xls", 2011],
      ["histab20.xlsx", "https://www.irs.gov/pub/irs-soi/histab20.xlsx", null]]);
  });

  it("resolves a table by id or by a product word and number", () => {
    expect(findTable("in_1.1")[0]?.id).toBe("in_1.1");
    expect(findTable("data book 1-6")[0]?.id).toBe("databook_1-6");
    expect(findTable("Publication 16 Table 2.1")[0]?.id).toBe("corp_2.1");
    expect(findTable("partnership 1")[0]?.id).toBe("partnership_1");
    const [none, near] = findTable("tax shares by percentile");
    expect(none).toBeNull();
    expect(near.map((t) => t.id)).toContain("shares_4.1");
  });
});

describe("irs-soi table", () => {
  it("reads Publication 1304 Table 1.1 long, with sections, column numbers, units and markers", async () => {
    const s = newSession();
    const r = await fetchOk(s, "irs-soi", { description: "Individual returns by size of AGI, 2023", requests: [
      { name: "t11", endpoint: "table", params: { table: "in_1.1", tax_year: 2023 } }] });
    expect(r.summary.route).toBe("api");
    const rows = csv(s, "irs-soi", "t11");
    expect(Object.keys(rows[0])).toEqual(["TABLE", "YEAR", "YEAR_TYPE", "SHEET", "SECTION", "LINE", "LEVEL", "PARENT", "ROW_LABEL",
      "COL", "COLUMN", "VALUE", "FLAG", "UNITS"]);
    const all = rows.filter((x) => x.ROW_LABEL === "All returns" && x.SECTION === "Size of adjusted gross income");
    expect(all.find((x) => x.COL === "1")!.VALUE).toBe("160602107");
    const agi = all.find((x) => x.COL === "3")!;
    expect([agi.COLUMN, agi.VALUE, agi.UNITS, agi.YEAR, agi.YEAR_TYPE]).toEqual([
      "All returns | Adjusted gross income less deficit | Amount", "15286017359", "thousands of dollars", "2023", "tax year"]);
    expect(new Set(rows.map((x) => x.SECTION))).toEqual(new Set(["Size of adjusted gross income",
      "Accumulated from smallest size of adjusted gross income", "Accumulated from largest size of adjusted gross income"]));
    // "[2]" = less than 0.05 percent: no value, the marker kept
    const tiny = rows.find((x) => x.ROW_LABEL === "No adjusted gross income" && x.COL === "7")!;
    expect([tiny.VALUE, tiny.FLAG]).toEqual(["", "[2]"]);
    expect(r.notes.join("\n")).toMatch(/\[2\] Less than 0\.05 percent/);
  });

  it("filters a range of years by section and column", async () => {
    const s = newSession();
    await fetchOk(s, "irs-soi", { description: "Returns 2022-2023", requests: [{ name: "n", endpoint: "table",
      params: { table: "in_1.1", start_year: 2022, end_year: 2023, section: "Size of adjusted gross income", rows: ["All returns"], columns: [1] } }] });
    expect(csv(s, "irs-soi", "n").map((x) => [x.YEAR, x.VALUE])).toEqual([["2022", "161336659"], ["2023", "160602107"]]);
  });

  it("reads Table 3.5 wide, with the flag columns the markers need", async () => {
    const s = newSession();
    await fetchOk(s, "irs-soi", { description: "Tax generated at the 37 percent rate, 2023", requests: [{ name: "t35",
      endpoint: "table", params: { table: "in_3.5", year: 2023, layout: "wide", columns: ["37 percent"] } }] });
    const rows = csv(s, "irs-soi", "t35");
    const tot = one(rows, (x) => x.ROW_LABEL === "Total");
    expect(tot["(42) Tax generated at specified rate | 37 percent | Income taxed at rate"]).toBe("1159707580");
    expect(tot["(43) Tax generated at specified rate | 37 percent | Tax generated at rate"]).toBe("429091805");
    const low = one(rows, (x) => x.ROW_LABEL === "Under $2,000");
    expect(low["(41) Tax generated at specified rate | 37 percent | Number of returns FLAG"]).toBe("*");
  });

  it("reads a 1998 table printed as pages and panels (columns 1-60)", async () => {
    const s = newSession();
    await fetchOk(s, "irs-soi", { description: "1998 returns", requests: [{ name: "t98", endpoint: "table",
      params: { table: "in_1.1", year: 1998 } }] });
    const rows = csv(s, "irs-soi", "t98");
    expect(Math.max(...rows.map((x) => Number(x.COL)))).toBe(60);
    const acc = one(rows, (x) => x.COL === "21" && x.ROW_LABEL === "All returns");
    expect([acc.SECTION, acc.VALUE]).toEqual(["Accumulated from Smallest Size of Adjusted Gross Income", "124770662"]);
  });

  it("reads whole-series tables: tax shares by percentile and Data Book collections", async () => {
    const s = newSession();
    const r = await fetchOk(s, "irs-soi", { description: "Average tax rate of the top 1 percent and collections, latest", requests: [
      { name: "shares", endpoint: "table", params: { table: "shares_4.1", section: "Average tax rate", rows: ["2023"], columns: ["Top 1 percent"] } },
      { name: "coll", endpoint: "table", params: { table: "data book 1-6", rows: ["2025"], columns: [1] } }] });
    const sh = one(csv(s, "irs-soi", "shares"), () => true);
    expect([sh.YEAR_TYPE, sh.ROW_LABEL, sh.COLUMN, sh.VALUE]).toEqual(["edition", "2023",
      "Descending cumulative percentiles | Top 1 percent", "26.2682"]);
    const c = one(csv(s, "irs-soi", "coll"), () => true);
    expect([c.TABLE, c.YEAR, c.YEAR_TYPE, c.VALUE]).toEqual(["databook_1-6", "2025", "fiscal year", "5313762307"]);
    expect(r.notes.join("\n")).toContain("25db-1-06-co.xlsx");
  });

  it("reads Publication 16: row levels from the style indent, * from the number format, and a header without column numbers", async () => {
    const s = newSession();
    const r = await fetchOk(s, "irs-soi", { description: "Corporations", requests: [
      { name: "c1", endpoint: "table", params: { table: "corp_1", year: 2023, columns: [1, 9] } },
      { name: "c21", endpoint: "table", params: { table: "corp_2.1", year: 2014, rows: ["Total income tax after credits"], columns: ["Total"] } }] });
    const c1 = csv(s, "irs-soi", "c1");
    const ag = one(c1, (x) => x.ROW_LABEL === "Agricultural production" && x.COL === "1");
    expect([ag.LEVEL, ag.PARENT, ag.VALUE]).toEqual(["1", "Agriculture, forestry, fishing and hunting", "102164"]);
    const brew = one(c1, (x) => x.ROW_LABEL === "Breweries" && x.COL === "9");
    expect([brew.COLUMN, brew.VALUE, brew.FLAG]).toEqual(["Income subject to tax", "5636723", "*"]);
    const t = one(csv(s, "irs-soi", "c21"), (x) => x.COLUMN === "Total");
    expect([t.COL, t.VALUE]).toEqual(["", "336078471"]);
    expect(r.notes.join("\n")).toMatch(/no column-number row/);
  });

  it("reads estate, gift, exempt-organization and historical tables", async () => {
    const s = newSession();
    await fetchOk(s, "irs-soi", { description: "Transfer taxes, nonprofits, corporate rates", requests: [
      { name: "est", endpoint: "table", params: { table: "estate_1", rows: ["All returns"], columns: [90] } },
      { name: "gift", endpoint: "table", params: { table: "gift_1", year: 2021, columns: [1, 2] } },
      { name: "eo", endpoint: "table", params: { table: "eo_1", rows: ["Pledges and grants receivable"], columns: [2] } },
      { name: "rates", endpoint: "table", params: { table: "historical_24", section: "1909" } }] });
    const est = one(csv(s, "irs-soi", "est"), () => true);
    expect([est.YEAR, est.YEAR_TYPE, est.COLUMN, est.VALUE]).toEqual(["2024", "filing year", "Net estate tax | Amount", "23313220"]);
    const g = csv(s, "irs-soi", "gift");
    expect(one(g, (x) => x.LINE === "6" && x.COL === "2").VALUE).toBe("182580094632");
    expect(g[0].UNITS).toBe("dollars"); // gift amounts are whole dollars
    const eo = one(csv(s, "irs-soi", "eo"), () => true);
    expect([eo.VALUE, eo.FLAG]).toEqual(["12497", "*"]);
    expect(csv(s, "irs-soi", "rates").map((x) => [x.SECTION, x.ROW_LABEL, x.VALUE])).toEqual([
      ["1909-1913 (February 28)", "First $5,000", "0"], ["1909-1913 (February 28)", "Over $5,000", "1"]]);
  });

  it("refuses an unknown table with suggestions, and a year not posted with the years that are", async () => {
    let f = await fetchFail({ requests: [{ name: "x", endpoint: "table", params: { table: "tax shares by percentile" } }] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("shares_4.1");
    f = await fetchFail({ requests: [{ name: "x", endpoint: "table", params: { table: "in_1.1", year: 2024 } }] });
    expect(f.message).toMatch(/not posted for 2024 \(posted: 1996-2023/);
  });

  it("lists the catalog, and the years posted when live", async () => {
    const s = newSession();
    await fetchOk(s, "irs-soi", { description: "SOI tables", requests: [
      { name: "all", endpoint: "table_list" },
      { name: "ind", endpoint: "table_list", params: { product: "individual", query: "size of AGI earned income", live: true } }] });
    const all = csv(s, "irs-soi", "all");
    expect(all.length).toBe(125);
    const ind = csv(s, "irs-soi", "ind");
    const eitc = one(ind, (x) => x.TABLE === "in_2.5");
    expect(eitc.YEARS_POSTED.split(" ").slice(-2)).toEqual(["2022", "2023"]);
  });

  it("feeds compute: a static estimate of one more point on the 37 percent rate", async () => {
    const s = newSession();
    await fetchOk(s, "irs-soi", { description: "Income taxed at 37 percent, 2023", requests: [{ name: "t35", endpoint: "table",
      params: { table: "in_3.5", year: 2023, rows: ["Total"], columns: [42] } }] });
    const compute = TOOLS.find((t) => t.name === "compute")!.handler as any;
    const res = compute(s, { inputs: { t: "data/irs-soi/t35.csv" }, save_as: "exhibits/top_rate.csv", steps: [
      { derive: { change_thousand_dollars: "VALUE * 0.01" } }, { select: ["YEAR", "COLUMN", "VALUE", "change_thousand_dollars"] }] });
    expect(res.status).toBe("ok");
    const out = readCsv(fs.readFileSync(path.join(s.workspace, "exhibits/top_rate.csv"), "utf8")) as Record<string, string>[];
    expect(Number(out[0].change_thousand_dollars)).toBeCloseTo(11597075.8, 1);
  });
});

describe("irs-soi exempt organizations", () => {
  it("filters the EO BMF and keeps EINs as text", async () => {
    const s = newSession();
    await fetchOk(s, "irs-soi", { description: "Wyoming health nonprofits", requests: [{ name: "wy", endpoint: "eo_bmf",
      params: { state: "Wyoming", ntee: "E", columns: ["NTEE_CD", "REVENUE_AMT"] } }] });
    const rows = csv(s, "irs-soi", "wy");
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0])).toEqual(["EIN", "NAME", "STATE", "REVENUE_AMT", "NTEE_CD"]);
    expect(rows.every((x) => x.NTEE_CD.startsWith("E") && /^\d{9}$/.test(x.EIN))).toBe(true);
  });

  it("reads the Form 990-PF extract from its zip, by state, restoring 9-digit EINs", async () => {
    const s = newSession();
    const r = await fetchOk(s, "irs-soi", { description: "Wyoming private foundations, 2024 extract", requests: [{ name: "pf",
      endpoint: "eo_extract", allow_empty: true, params: { year: 2024, form: "990pf", state: "WY" } }] });
    const rows = csv(s, "irs-soi", "pf");
    const bmf = fs.readFileSync(path.join(TEST_DIR, "packs", "irs-soi", "fixtures", "eo_wy_subset.csv"), "utf8");
    for (const x of rows) {
      expect(x.EIN ?? x.ein).toMatch(/^\d{9}$/);
      expect(bmf).toContain(x.EIN ?? x.ein);
    }
    expect(r.notes.join("\n")).toMatch(/24eoextract990pf\.zip .*24eoextract990pf\.csv: 12 returns/);
  });

  it("asks for a filter before reading a national extract", async () => {
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "eo_extract", params: { year: 2024 } }] });
    expect(f.message).toMatch(/needs ein .* or state/);
  });
});
