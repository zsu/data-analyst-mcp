/**
 * omb pack (OMB budget files on GovInfo), ported from tests/sources/omb/test_omb.py. Fixtures recorded live from
 * www.govinfo.gov on 2026-10-30 (whole real files and trimmed real copies; see the Python test's docstring).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import { xlsxSheets } from "../../src/core/tabular.js";
import { _test as omb } from "../../src/adapters/omb.js";
import { numClean } from "../../src/adapters/_omb_grid.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "omb", "fixtures");
const SPEC = { description: "Historical Tables 1.1, 3.1 and 7.1 (FY2027), receipts by account, direct loan subsidy rates",
  requests: [
    { name: "summary", endpoint: "historical_table", params: { fy: 2027, table: "1.1" } },
    { name: "functions", endpoint: "historical_table", params: { fy: 2027, table: "3.1" } },
    { name: "debt", endpoint: "historical_table", params: { fy: 2027, table: "table_7_1" } },
    { name: "receipts", endpoint: "budget_database", params: { fy: 2027, kind: "receipts" } },
    { name: "direct_loans", endpoint: "credit_supplement", params: { fy: 2027, table: 1 } }] };

beforeAll(() => isolate());

/** The CSV header as written (csv() rows are objects, which put year columns first). */
const header = (s: any, name: string) => fs.readFileSync(path.join(s.workspace, "data", "omb", `${name}.csv`), "utf8").split(/\r?\n/)[0].split(",");

const problems = async (spec: any) => gr.checkSpec(await load("omb"), spec);

describe("omb", () => {
  it("the spec is valid (api route)", async () => {
    expect(await problems(SPEC)).toEqual([]);
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "omb", SPEC);
    expect(r.status).toBe("ok");
    const sm = csv(s, "omb", "summary");
    expect(header(s, "summary").slice(0, 4)).toEqual(["Year", "Total Receipts", "Total Outlays", "Total Surplus or Deficit (-)"]);
    expect(sm[0]).toHaveProperty("Off-Budget Outlays");
    const y24 = sm.find((x) => x.Year === "2024")!;
    expect([y24["Total Outlays"], y24["Total Receipts"], y24.sheet_row]).toEqual(["6735261", "4919884", "131"]);
    expect(sm[sm.length - 1].Year).toBe("2025"); // the footnotes are not rows
    expect(sm[0]["Off-Budget Outlays"]).toBe(".........."); // published marker kept
    const notes = r.notes.join(" ");
    expect(notes).toContain("(in millions of dollars)");
    expect(notes).toContain("$500 thousand or less");
    expect(notes).toContain("no estimate years");
    // Table 3.1: three unit blocks; the total appears once per block, told apart by units_block
    const f = csv(s, "omb", "functions");
    const tot = f.filter((x) => x["Superfunction and Function"] === "Total, Federal outlays");
    expect(tot.map((x) => x.units_block)).toEqual(["In millions of dollars", "As percentages of outlays", "As percentages of GDP"]);
    expect(tot.map((x) => x["1940"])).toEqual(["9468", "100", "9.6"]);
    expect(f[0]).toHaveProperty("2031 estimate");
    expect(notes).toContain("6 columns marked estimate");
    // Table 7.1: a three-row header joined top-down
    const d = csv(s, "omb", "debt");
    const col = "In Millions of Dollars Equals: Held by the Public Total";
    expect(d.find((x) => x["End of Fiscal Year"] === "2024")![col]).toBe("28193866");
    expect(d.find((x) => x["End of Fiscal Year"] === "2019")!["As Percentages of GDP Equals: Held by the Public Total"]).toBe("78.9");
    // Public Budget Database receipts: thousands of dollars; FY2024 adds up to Table 1.1's total receipts
    const rc = csv(s, "omb", "receipts");
    expect(rc.length).toBe(259);
    expect(header(s, "receipts").slice(0, 3)).toEqual(["Source Category Code", "Source Category Name", "Source Subcategory"]);
    expect(rc[0]["Agency Code"]).toBe("009"); // codes keep their leading zeros
    expect(rc.reduce((a, x) => a + parseInt(x["2024"], 10), 0)).toBe(4919884 * 1000);
    expect(notes).toContain("thousands of dollars");
    // Federal Credit Supplement Table 1: leader dots removed, label rows kept
    const dl = csv(s, "omb", "direct_loans");
    expect(dl[0]["Agency, Bureau, Program and Risk Category"]).toBe("Department of Agriculture");
    expect(dl[0]["2027 Subsidy rate (percent)"]).toBe("");
    const fo = dl.find((x) => x["Agency, Bureau, Program and Risk Category"] === "Farm Ownership")!;
    expect([fo["BEA Category"], fo["2026 Subsidy rate (percent)"], fo["2027 Subsidy rate (percent)"], fo["2027 Obligations"]])
      .toEqual(["Discretionary", "1.27", "2.47", "1241992"]);
  });

  it("an edition without granules is read from the package zip", async () => {
    const s = newSession();
    const r = await fetchOk(s, "omb", { description: "Table 1.1, FY2026 edition",
      requests: [{ name: "t11", endpoint: "historical_table", params: { fy: 2026, table: "1.1" } }] });
    const rows = csv(s, "omb", "t11");
    expect(rows.find((x) => x.Year === "2024")!["Total Outlays"]).toBe("6750856"); // FY2026 edition
    expect(rows[rows.length - 1].Year).toBe("2024");
    const notes = r.notes.join(" ");
    expect(notes).toContain("BUDGET-2026-TAB.zip");
    expect(notes).toContain("hist01z1");
  });

  it("a missing table is a clear error, not an empty table", async () => {
    const s = newSession();
    const f = await failure(fetchOk(s, "omb", { description: "a table the edition does not have",
      requests: [{ name: "t19", endpoint: "historical_table", params: { fy: 2027, table: "1.9" } }] }));
    expect(f.code).toBe("not_found");
    expect(f.message).toContain("Table 1.9 is not in the FY2027 Historical Tables");
    expect(f.message).toContain("1.1, 7.1"); // what the package holds
    expect(fs.existsSync(path.join(s.workspace, "data", "omb", "t19.csv"))).toBe(false);
  });

  it("a missing edition names the URLs", async () => {
    const s = newSession();
    const f = await failure(fetchOk(s, "omb", { description: "FY2026 has no Public Budget Database on GovInfo",
      requests: [{ name: "db", endpoint: "budget_database", params: { fy: 2026, kind: "outlays" } }] }));
    expect(f.message).toContain("no Public Budget Database outlays file for the FY2026 budget");
    expect(f.message).toContain("BUDGET-2026-DB/csv/BUDGET-2026-DB-2.csv");
  });

  it("bad specs are refused before any request", async () => {
    for (const [params, ep] of [[{ fy: 2027, table: "debt" }, "historical_table"], [{ fy: 1900, table: "1.1" }, "historical_table"],
      [{ fy: 2027 }, "historical_table"], [{ fy: 2027, kind: "spending" }, "budget_database"],
      [{ fy: 2027, table: "1.1" }, "credit_supplement"]] as const) {
      expect((await problems({ requests: [{ name: "x", endpoint: ep, params }] })).length, JSON.stringify(params)).toBeGreaterThan(0);
    }
  });

  it("searches the catalog", async () => {
    const s = newSession();
    let r: any = await T.requestSchema(s, { source: "omb", search: "federal debt end of year" });
    expect(r.results[0].alias).toBe("table_7_1");
    r = await T.requestSchema(s, { source: "omb", search: "credit subsidy rate direct loan" });
    expect(r.results.map((x: any) => x.alias)).toContain("fcs_table1");
  });

  it("manual bundle and ingest", async () => {
    const spec = { description: "Table 1.1 FY2027 and FY2026 by hand", requests: [
      { name: "t11", endpoint: "historical_table", params: { fy: 2027, table: "1.1" } },
      { name: "t11_26", endpoint: "historical_table", params: { fy: 2026, table: "1.1" } },
      { name: "rc", endpoint: "budget_database", params: { fy: 2027, kind: "receipts" } }] };
    const s = newSession();
    const b: any = await T.manualBundle(s, { sources: [{ source: "omb", spec }] });
    expect(b.items[0].url).toBe("https://www.govinfo.gov/content/pkg/BUDGET-2027-TAB/xls/BUDGET-2027-TAB-2-1.xlsx");
    const p = await load("omb");
    expect(p.adapter!.manualItems!(spec, p)[1].note).toContain("BUDGET-2026-TAB.zip");
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    fs.copyFileSync(path.join(FX, "tab2027_2_1.xlsx"), path.join(up, "t11.xlsx"));
    fs.copyFileSync(path.join(FX, "tab2026_package_trimmed.zip"), path.join(up, "t11_26.zip"));
    fs.copyFileSync(path.join(FX, "db2027_3_receipts.xlsx"), path.join(up, "rc.xlsx"));
    await prepare(s, "omb", spec);
    const r: any = await T.ingest(s, { source: "omb", spec, files: [up] });
    expect(r.status).toBe("ok");
    expect(csv(s, "omb", "t11").find((x) => x.Year === "2024")!["Total Outlays"]).toBe("6735261");
    expect(csv(s, "omb", "t11_26").find((x) => x.Year === "2024")!["Total Outlays"]).toBe("6750856");
    expect(csv(s, "omb", "rc").length).toBe(259);
  });

  it("an upload of the wrong table is refused", async () => {
    const spec = { description: "Table 3.2 asked, Table 1.1 uploaded",
      requests: [{ name: "t32", endpoint: "historical_table", params: { fy: 2027, table: "3.2" } }] };
    const s = newSession();
    fixtures("omb");
    await prepare(s, "omb", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    fs.copyFileSync(path.join(FX, "tab2027_2_1.xlsx"), path.join(up, "t32.xlsx"));
    const f = await failure(T.ingest(s, { source: "omb", spec, files: [up] }));
    expect(f.message).toContain("Table 3.2");
  });

  it("parse_grid rules: header joining, footer cut and number cleanup on the real Table 1.1 grid", () => {
    const grid = Object.values(xlsxSheets(fs.readFileSync(path.join(FX, "tab2027_2_1.xlsx"))))[0];
    const [rows, meta] = omb.parseGrid(grid, undefined, undefined, { tocCells: true });
    expect(meta.header).toEqual([3, 4]);
    expect(meta.top[1]).toBe("(in millions of dollars)");
    expect(meta.footer.length).toBe(2);
    expect(rows[0].get("sheet_row")).toBe(5);
    expect(numClean("78.900000000000006")).toBe("78.9");
    expect(numClean("6.3600000000000004E-2")).toBe("0.0636");
    expect(numClean("1160.0")).toBe("1160.0");
    expect(omb.normTable("Table 8.5")).toBe("8.5");
  });
});
