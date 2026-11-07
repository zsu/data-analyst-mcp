/**
 * fsa pack (Federal Student Aid Data Center library workbooks), ported from tests/sources/fsa/test_fsa.py.
 * Fixtures recorded live from studentaid.gov on 2026-10-30: the real portfolio .xls files, trimmed .xlsx copies of
 * the two volume-by-school workbooks (served for the .xls URL), and the 404 of an unpublished award year.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { DataError } from "../../src/core/http.js";
import { load } from "../../src/core/packs.js";
import { label, measure, normalize } from "../../src/adapters/fsa.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "fsa", "fixtures");
const SUMMARY = { description: "Total federal student loan portfolio by program, every quarter",
  requests: [{ name: "portfolio", endpoint: "portfolio_summary", params: {} }] };
const VOLUME = { description: "Direct Loans and Pell Grants at Wyoming schools", requests: [
  { name: "dl_wy", endpoint: "dl_volume_by_school", params: { award_year: "2025-26", quarter: 4, state: "wy" } },
  { name: "pell_q4", endpoint: "grant_volume_by_school",
    params: { award_year: "2024-2025", quarter: "Q4", sheet: "Quarterly Activity", school: "casper" } }] };

beforeAll(() => isolate());

const header = (s: any, name: string) =>
  fs.readFileSync(path.join(s.workspace, "data", "fsa", `${name}.csv`), "utf8").split(/\r?\n/)[0].split(",");

describe("fsa", () => {
  it("the spec is valid (api route)", async () => {
    expect(gr.checkSpec(await load("fsa"), SUMMARY)).toEqual([]);
  });

  it("portfolio summary", async () => {
    const s = newSession();
    const r = await fetchOk(s, "fsa", SUMMARY);
    const rows = csv(s, "fsa", "portfolio");
    expect(header(s, "portfolio")).toEqual(["report", "fiscal_year", "quarter", "period_end", "category",
      "dollars_outstanding_billions", "recipients_millions", "unduplicated_recipients_millions"]);
    // FY2007 is an annual row; Total has unduplicated recipients only (footnote mark "Total1" dropped)
    expect([rows[0].fiscal_year, rows[0].quarter, rows[0].period_end, rows[0].category, rows[0].dollars_outstanding_billions])
      .toEqual(["2007", "", "2007-09-30", "Direct Loans", "106.8"]);
    const maxEnd = rows.map((y) => y.period_end).sort().pop();
    const last = rows.filter((x) => x.period_end === maxEnd);
    const total = last.find((x) => x.category === "Total")!;
    // the latest quarter in the 2026-10 file: FY2026 Q3 (ends 2026-06-30), $1,724.5 billion, 42.3 million people
    expect([total.fiscal_year, total.quarter, total.period_end]).toEqual(["2026", "Q3", "2026-06-30"]);
    expect([total.dollars_outstanding_billions, total.unduplicated_recipients_millions, total.recipients_millions])
      .toEqual(["1724.5", "42.3", ""]);
    expect(new Set(last.map((x) => x.category))).toEqual(new Set(["Direct Loans", "Federal Family Education Loans (FFEL)",
      "Perkins Loans", "Total"]));
    // FY2025 Q1 is published with full precision: kept as published
    const q1 = rows.find((x) => x.period_end === "2024-12-31" && x.category === "Direct Loans")!;
    expect(q1.dollars_outstanding_billions).toBe("1472.58466176543");
    expect(r.notes.some((n: string) => n.includes("fiscal-year quarters"))).toBe(true);
  });

  it("status sheets, location and repayment plans", async () => {
    const s = newSession();
    await fetchOk(s, "fsa", { requests: [
      { name: "status", endpoint: "portfolio_by_loan_status", params: { sheet: "Federally Managed" } },
      { name: "dl", endpoint: "portfolio_by_loan_status", params: {} },
      { name: "loc", endpoint: "portfolio_by_location", params: {} },
      { name: "plans", endpoint: "portfolio_by_repayment_plan", params: {} }] });
    const st = csv(s, "fsa", "status");
    expect(st[0].report).toBe("Federally Managed Portfolio by Loan Status");
    const dflt = st.find((x) => x.period_end === "2026-06-30" && x.category === "Cumulative in Default")!;
    expect([dflt.dollars_outstanding_billions, dflt.recipients_millions]).toEqual(["234.1", "9.3"]);
    // the year cell is blank under the first quarter of each year: filled down
    expect(st.find((x) => x.period_end === "2017-03-31")!.fiscal_year).toBe("2017");
    const dl = csv(s, "fsa", "dl");
    expect(dl[0].report).toBe("Direct Loan Portfolio by Loan Status");
    expect(new Set(dl.map((x) => x.category)).size).toBe(7);
    const loc = csv(s, "fsa", "loc");
    expect(header(s, "loc")).toEqual(["report", "as_of", "location", "balance_billions", "borrowers_thousands"]);
    const wy = loc.find((x) => x.location === "Wyoming")!;
    expect([wy.as_of, wy.balance_billions, wy.borrowers_thousands]).toEqual(["2026-03-31", "1.8", "54.8"]);
    expect(loc.map((x) => x.location)).toContain("Not Reported");
    expect(loc.filter((x) => x.location.startsWith("*"))).toEqual([]); // footnote row dropped
    const plans = csv(s, "fsa", "plans");
    const save = plans.filter((x) => x.category === "SAVE");
    // "-" before REPAYE (which SAVE replaced) began: those quarters have no SAVE row
    expect([save[0].period_end, save[0].dollars_outstanding_billions]).toEqual(["2015-12-31", "0.1"]);
    const other = plans.find((x) => x.category === "Other" && x.period_end === "2026-06-30")!;
    expect([other.dollars_outstanding_billions, other.recipients_millions]).toEqual(["9", ""]); // NA***
    expect(plans.map((x) => x.category)).toContain("Pay As You Earn"); // "Pay As You Earn*" mark dropped
  });

  it("volume by school", async () => {
    const s = newSession();
    const r = await fetchOk(s, "fsa", VOLUME);
    const dl = csv(s, "fsa", "dl_wy");
    const h = header(s, "dl_wy");
    expect(h.slice(0, 11)).toEqual(["award_year", "activity", "period_start", "period_end", "as_of", "ope_id", "school", "state",
      "zip_code", "school_type", "program"]);
    expect(new Set(h.slice(11))).toEqual(new Set(["recipients", "loans_originated_count", "loans_originated_dollars",
      "disbursements_count", "disbursements_dollars"]));
    expect(new Set(dl.map((x) => x.state))).toEqual(new Set(["WY"]));
    const wyo = dl.find((x) => x.school === "WYOTECH" && x.program === "DL PARENT PLUS")!;
    expect([wyo.award_year, wyo.activity, wyo.period_start, wyo.period_end, wyo.ope_id])
      .toEqual(["2025-26", "award year to date", "2025-07-01", "2026-06-30", "00915700"]);
    expect([wyo.recipients, wyo.loans_originated_dollars]).toEqual(["644", "15454940"]);
    // programs a school had no activity in ("-") are left out
    expect(dl.filter((x) => x.school === "WYOTECH").map((x) => x.program)).not.toContain("DL GRAD PLUS");
    const pell = csv(s, "fsa", "pell_q4");
    expect(new Set(pell.map((x) => x.school))).toEqual(new Set(["CASPER COLLEGE"]));
    expect([pell[0].activity, pell[0].period_start, pell[0].period_end, pell[0].program, pell[0].recipients,
      pell[0].disbursements_dollars]).toEqual(["quarter", "2025-04-01", "2025-06-30", "FEDERAL PELL GRANT PROGRAM", "218", "317984.05"]);
    expect(r.notes.some((n: string) => n.includes("award-year quarter 4"))).toBe(true);
  });

  it("manual links build the file names", async () => {
    const b: any = await T.manualBundle(newSession(), { sources: [{ source: "fsa", spec: VOLUME }] });
    const base = "https://studentaid.gov/sites/default/files/fsawg/datacenter/library/";
    expect(b.items.map((i: any) => i.url)).toEqual([base + "dl-dashboard-ay2025-2026-q4.xls", base + "grants-ay24-25-q4.xls"]);
    expect(b.items.some((i: any) => i.needs_key)).toBe(false);
  });

  it("an unpublished year is not found", async () => {
    const f = await failure(fetchOk(newSession(), "fsa", { requests: [{ name: "next", endpoint: "dl_volume_by_school",
      params: { award_year: "2026-27", quarter: 1 } }] }));
    expect(f.message).toContain("not found");
  });

  it("bad specs are refused before any request", async () => {
    const p = await load("fsa");
    for (const [params, word] of [[{ award_year: "2025", quarter: 4 }, "ambiguous"], [{ award_year: "2016-17", quarter: 4 }, "2018-19"],
      [{ award_year: "2025-27", quarter: 4 }, "2025-26"], [{ award_year: "2025-26", quarter: 5 }, "1-4"], [{ quarter: 4 }, "award_year"]] as const) {
      const probs = gr.checkSpec(p, { requests: [{ name: "x", endpoint: "dl_volume_by_school", params }] });
      expect(probs.join("; "), JSON.stringify(params)).toContain(word);
    }
    expect(gr.checkSpec(p, { requests: [{ name: "x", endpoint: "portfolio_by_loan_status", params: { sheet: "Perkins" } }] }).length)
      .toBeGreaterThan(0);
  });

  it("ingests the downloaded workbook", async () => {
    const s = newSession();
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "up-"));
    fs.copyFileSync(path.join(FX, "PortfolioSummary.xls"), path.join(up, "portfolio.xls"));
    await prepare(s, "fsa", SUMMARY);
    const r: any = await T.ingest(s, { source: "fsa", spec: SUMMARY, files: [up] });
    expect(r.status).toBe("ok");
    const totals = csv(s, "fsa", "portfolio").filter((x) => x.category === "Total");
    expect(totals[totals.length - 1].dollars_outstanding_billions).toBe("1724.5");
  });

  it("a layout change fails loudly", () => {
    const rows = [{ "Some Title": "Federal Fiscal Year", col2: "", col3: "Dollars" }, { "Some Title": "2026", col2: "Q1", col3: "1" }];
    expect(() => normalize({ name: "x" }, { layout: "portfolio", path: "/x.xls" }, rows)).toThrow(DataError);
    expect(() => normalize({ name: "x" }, { layout: "portfolio", path: "/x.xls" }, rows)).toThrow(/layout changed/);
    expect(measure("Dollars Outstanding           (in billions)")).toBe("dollars_outstanding_billions");
    expect(measure("Recipients3     (in millions)")).toBe("recipients_millions");
    expect(measure("$ of Loans Originated")).toBe("loans_originated_dollars");
    expect(measure("YTD Disbursements")).toBe("disbursements_dollars");
    expect(label("Total1")).toBe("Total");
  });
});
