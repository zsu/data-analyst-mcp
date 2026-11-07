/**
 * actuaries pack tests (offline), ported from tests/sources/actuaries/test_actuaries.py. Fixtures recorded or
 * downloaded from the live sites on 2026-10-30 (the CMS pages trimmed to <main>, trimmed real copies of the large
 * ZIPs, and the SSA single-year tables workbook from the Internet Archive; see the Python test's comments).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { pageLinks } from "../../src/adapters/_actuaries_read.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

beforeAll(() => isolate());

const FIX = path.join(TEST_DIR, "packs", "actuaries", "fixtures");
const SPEC = { description: "2026 Medicare Trustees Report HI trust fund operations",
  requests: [{ name: "hi_ops", endpoint: "medicare_tr_table", params: { table: "Operations of the Hospital Insurance (HI) Trust Fund" } }] };
const SSA = { description: "2026 OASDI Trustees Report: combined trust fund operations",
  requests: [{ name: "oasdi_ops", endpoint: "ssa_tr_table", params: { report_year: 2026, table: "VI.G2" } }] };

async function fetchFail(spec: any) {
  const s = newSession();
  fixtures("actuaries");
  await prepare(s, "actuaries", spec);
  return failure(T.fetchData(s, { source: "actuaries", spec }));
}

const by = (rows: Record<string, string>[], k: string) => Object.fromEntries(rows.map((x) => [x[k], x]));

describe("actuaries", () => {
  it("check: the sample spec is valid", async () => {
    expect(gr.checkSpec(await load("actuaries"), SPEC)).toEqual([]);
  });

  it("a Medicare table", async () => {
    const s = newSession();
    const r = await fetchOk(s, "actuaries", SPEC);
    expect(r.status).toBe("ok");
    const rows = csv(s, "actuaries", "hi_ops");
    expect(Object.keys(rows[0]).slice(0, 3)).toEqual(["row", "Calendar Year", "Payroll Taxes (Income)"]);
    expect(rows[0]).toHaveProperty(["Balance at end of year (see note 21) (Trust Fund)"]);
    const b = by(rows, "Calendar Year");
    expect([rows[0]["Calendar Year"], rows[rows.length - 1]["Calendar Year"], rows.length]).toEqual(["1966", "2035", 70]);
    expect(b["1966"]["Payroll Taxes (Income)"]).toBe("1858"); // published "$1,858" in the CSV twin
    expect(b["1966"]["Income from taxation of benefits (Income)"]).toBe(""); // published as a dash
    const bal = "Balance at end of year (see note 21) (Trust Fund)";
    expect([b["2032"][bal], b["2033"][bal]]).toEqual(["28111", "-56909"]); // HI reserves run out in 2033
    expect(r.notes.some((n: string) => n.includes("2026 Medicare Trustees Report") && n.includes("sheet HI"))).toBe(true);
  });

  it("the Medicare file list and other tables", async () => {
    const spec = { description: "Medicare TR tables",
      requests: [{ name: "files", endpoint: "medicare_tr_files", params: { report_year: 2026 } },
        { name: "rates", endpoint: "medicare_tr_table", params: { table: "HI Cost and Income Rates" } },
        { name: "tp_gdp", endpoint: "medicare_tr_table", params: { table: "Ratio of HI Taxable Payroll" } },
        { name: "partd", endpoint: "medicare_tr_table", params: { table: "Part D" } },
        { name: "notes", endpoint: "medicare_tr_table", params: { table: "HI Cost and Income Rates", sheet: "Notes" } }] };
    const s = newSession();
    const r = await fetchOk(s, "actuaries", spec);
    const files = csv(s, "actuaries", "files");
    expect(new Set(files.map((x) => x.table))).toEqual(new Set(["hi cost and income rates", "ratio of hi taxable payroll to gdp",
      "operations of the hospital insurance (hi) trust fund for calendar years",
      "operations of the part d account of the supplementary medical insurance (smi) trust fund for calendar years"]));
    expect(files.map((x) => `${x.table}|${x.sheet}|${x.format}`)).toContain("hi cost and income rates|HI Income & Cost Rates|xlsx");
    const rates = by(csv(s, "actuaries", "rates"), "Calendar Year");
    expect([rates["2026"]["Cost rates (%)"], rates["2026"]["Income rates (%)"]]).toEqual(["3.49", "3.49"]);
    // Excel percent-format cells are written as displayed: 0.371 shown as 37.1%
    expect(by(csv(s, "actuaries", "tp_gdp"), "CY")["1966"].Ratio).toBe("37.1");
    expect(r.notes.some((n: string) => n.includes("percent-format"))).toBe(true);
    // years whose values are all dashes (Part D before 2004) stay rows with empty values
    const pd = by(csv(s, "actuaries", "partd"), "Calendar year");
    expect(pd["1967"]["Government contributions (see note 2) (Income)"]).toBe("");
    expect(pd["2004"]["Government contributions (see note 2) (Income)"]).toBe("440");
    const notes = csv(s, "actuaries", "notes");
    expect(Object.keys(notes[0])).toEqual(["row", "text"]);
    expect(notes[notes.length - 1].text.startsWith("Note: Totals do not necessarily")).toBe(true);
  });

  it("a wrong sheet lists the sheets", async () => {
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "medicare_tr_table",
      params: { table: "HI Cost and Income Rates", sheet: "Table 9" } }] });
    expect(f.message).toContain("no sheet 'Table 9'");
    expect(f.message).toContain("HI Income & Cost Rates, Notes");
  });

  it("an ambiguous or unknown table", async () => {
    let f = await fetchFail({ requests: [{ name: "x", endpoint: "medicare_tr_table", params: { table: "Operations" } }] });
    expect(f.message).toContain("matches 2 files");
    f = await fetchFail({ requests: [{ name: "x", endpoint: "medicare_tr_table", params: { table: "Part E" } }] });
    expect(f.message).toContain("no table 'Part E'");
  });

  it("report_year checks", async () => {
    const p = await load("actuaries");
    const probs = gr.checkSpec(p, { requests: [{ name: "x", endpoint: "medicare_tr_table", params: { report_year: 2019, table: "HI Cost" } }] });
    expect(probs.join("; ")).toContain("2022 on");
    expect(gr.checkSpec(p, { requests: [{ name: "x", endpoint: "medicare_tr_table", params: {} }] }).length).toBeGreaterThan(0);
  });

  it("NHE historical", async () => {
    const spec = { description: "NHE 2024",
      requests: [{ name: "summary", endpoint: "nhe_table", params: { file: "summary" } },
        { name: "summary_long", endpoint: "nhe_table", params: { file: "summary", layout: "long" } },
        { name: "funds", endpoint: "nhe_table", params: { file: "service_funds" } },
        { name: "t3", endpoint: "nhe_table", params: { file: "tables", table: "Table 03" } }] };
    const s = newSession();
    await fetchOk(s, "actuaries", spec);
    const sm = csv(s, "actuaries", "summary");
    // the CSV header as written (a parsed row object would put the year keys first)
    const head = fs.readFileSync(path.join(s.workspace, "data", "actuaries", "summary.csv"), "utf8").split("\r\n")[0].split(",");
    expect(head.slice(0, 6)).toEqual(["row", "Expenditure Amount", "indent", "group", "parent", "1960"]);
    const nhe = sm[0];
    expect([nhe["Expenditure Amount"], nhe["1960"], nhe["2024"]]).toEqual(["National Health Expenditures (Amount in Billions)", "27.1", "5278.60"]);
    const gdp = sm.filter((x) => x["Expenditure Amount"].startsWith("National Health Expenditures as a Percent of Gross"));
    expect(gdp[0]["2024"]).toBe("18");
    const lng = csv(s, "actuaries", "summary_long");
    expect(Object.keys(lng[0]).slice(-2)).toEqual(["year", "value"]);
    expect(lng.filter((x) => x.row === gdp[0].row).map((x) => ({ year: x.year, value: x.value }))).toContainEqual({ year: "2024", value: "18" });
    const f = csv(s, "actuaries", "funds");
    const lab = "Expenditure Amount (Millions)";
    expect([f[0][lab], f[0]["2024"], f[0]["1960"]]).toEqual(["Total National Health Expenditures", "5278588", "27122"]);
    const fed = f.filter((x) => x.group === "Total National Health Expenditures" && x[lab] === "Federal");
    expect([fed[0].parent, fed[0]["2024"], fed[0]["1960"]]).toEqual(["Medicaid (Title XIX)", "596694", ""]);
    expect(f.length).toBe(539);
    const hosp = f.filter((x) => x.group === "Total Hospital Expenditures" && x[lab] === "Total Hospital Expenditures");
    expect(hosp[0]["2024"]).toBe("1634738");
    const t3 = csv(s, "actuaries", "t3");
    expect(t3[0].section).toBe("Amount in Billions");
    expect([t3[0].Item, t3[0]["2024"]]).toEqual(["National Health Expenditures", "5278.6"]);
  });

  it("NHE projections", async () => {
    const spec = { description: "NHE projections",
      requests: [{ name: "t1", endpoint: "nhe_table", params: { file: "projections_tables", table: "Table01" } },
        { name: "t2long", endpoint: "nhe_table", params: { file: "projections_tables", table: "Table02", layout: "long" } },
        { name: "data", endpoint: "nhe_table", params: { file: "projections_data" } }] };
    const s = newSession();
    await fetchOk(s, "actuaries", spec);
    const t1 = csv(s, "actuaries", "t1");
    expect(t1[0]).toHaveProperty(["Projected 2025"]); // the 'Projected' label covers 2025-2034
    expect(t1[0]).toHaveProperty(["Projected 2034"]);
    expect(t1[0]).toHaveProperty("2024");
    const t2 = csv(s, "actuaries", "t2long").filter((x) => x["Type of Expenditure (billions $)"] === "National Health Expenditures");
    const v = Object.fromEntries(t2.map((x) => [`${x.year}|${x.year_label}`, x.value]));
    expect([v["2024|"], v["2025|Projected"]]).toEqual(["5278.6", "5661.7"]);
    const d = csv(s, "actuaries", "data");
    expect(d[0]).toHaveProperty(["2024 Historical"]);
    expect(d[0]).toHaveProperty(["2034 Projected"]);
    // the units line above "Source of Funds" is part of its header
    expect([d[0]["Type of Service"], d[0]["Expenditure Amount (Millions) Source of Funds"], d[0]["2024 Historical"]])
      .toEqual(["National Health Expenditures", "Total Expenditures", "5278588"]);
  });

  it("SSA goes to the manual route", async () => {
    const f = await fetchFail(SSA);
    expect(f.code).toBe("agency_unavailable");
    expect(f.message).toContain("www.ssa.gov");
    const s = newSession();
    const b: any = await T.manualBundle(s, { sources: [{ source: "actuaries", spec: SSA }] });
    const man = JSON.parse(fs.readFileSync(path.join(b.bundle, "manifest.json"), "utf8"));
    expect(man.items.map((i: any) => i.url)).toEqual(["https://www.ssa.gov/oact/TR/2026/SingleYearTRTables_TR2026.xlsx"]);
    // the adapter's fetch never calls www.ssa.gov: it stops as blocked
    const p = await load("actuaries");
    await expect(p.adapter!.fetch!(SSA, p, "api")).rejects.toMatchObject({ kind: "blocked" });
    expect(gr.checkSpec(p, { requests: [{ name: "x", endpoint: "ssa_tr_table", params: { table: "Table 5" } }] }).length).toBeGreaterThan(0);
  });

  it("SSA upload", async () => {
    const spec = { description: "2026 OASDI Trustees Report tables",
      requests: [{ name: "oasdi_ops", endpoint: "ssa_tr_table", params: { report_year: 2026, table: "VI.G2" } },
        { name: "pop", endpoint: "ssa_tr_table", params: { report_year: 2026, table: "V.A3" } },
        { name: "rates", endpoint: "ssa_tr_table", params: { report_year: 2026, table: "IV.B1" } }] };
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "act-up-"));
    fs.copyFileSync(path.join(FIX, "SingleYearTRTables_TR2026.xlsx"), path.join(up, "SingleYearTRTables_TR2026.xlsx"));
    const s = newSession();
    delete process.env.DATA_ANALYST_FIXTURES;
    await prepare(s, "actuaries", spec);
    const r: any = await T.ingest(s, { source: "actuaries", spec, files: [up] });
    expect(r.summary.route).toBe("manual_download");
    const ops = csv(s, "actuaries", "oasdi_ops");
    expect(Object.keys(ops[0]).slice(0, 4)).toEqual(["row", "section", "Calendar year", "year"]);
    expect(new Set(ops.map((x) => x.section))).toEqual(new Set(["Historical data", "Intermediate", "Low-cost", "High-cost"]));
    const inter = ops.filter((x) => x.section === "Intermediate");
    const last = inter[inter.length - 1]; // the last year with reserves under the intermediate assumptions (footnote b)
    expect([last["Calendar year"], last.year, last["Reserves at end of yeara"]]).toEqual(["2033b", "2033", "182.9"]);
    const pop = csv(s, "actuaries", "pop");
    expect([pop[0]["Calendar year"], pop[0]["Population (in thousands) Under 20"]]).toEqual(["1941", "48419"]);
    expect(pop[0]["Dependency ratio Ageda"]).toBe("0.118");
    const rates = csv(s, "actuaries", "rates");
    expect(rates[0]).toHaveProperty(["OASDI Cost ratec"]);
    expect([rates[0]["Calendar year"], rates[0]["OASI Income rateb"]]).toEqual(["1970", "7.6"]);
  });

  it("reads the ZIP links from the CMS page", async () => {
    const eps = (await load("actuaries")).endpoints;
    const links = pageLinks(fs.readFileSync(path.join(FIX, "cms_trustees_page.html"), "utf8"));
    const pat = new RegExp(eps.medicare_link, "i");
    const years: Record<string, string> = {};
    for (const [h, t] of links) {
      const m = pat.exec(t);
      if (m) years[m[1]] = h;
    }
    expect(Object.keys(years).map(Number).sort()).toEqual([2022, 2023, 2024, 2025, 2026]);
    expect(years["2026"]).toBe("/files/zip/2026-expanded-supplementary-tables-figures.zip");
    expect(years).toEqual(eps.medicare_known);
  });
});
