/**
 * pbgc pack (PBGC Pension Insurance Data Tables), ported from tests/sources/pbgc/test_pbgc.py. index_page.html was
 * recorded live on 2026-10-30; the workbooks are trimmed real copies (see the Python test's docstring), so a table
 * missing from the 2024 copy is "listed but not in this workbook", as S-22 really is in the 2024 1st installment.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import { normTable } from "../../src/adapters/pbgc.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "pbgc", "fixtures");
const SPEC = { description: "PBGC net position of both programs, premium rates, multiemployer assistance, 2024 edition",
  requests: [
    { name: "se", endpoint: "data_table", params: { year: 2024, table: "S-1" } },
    { name: "me", endpoint: "data_table", params: { year: 2024, table: "m1" } },
    { name: "rates", endpoint: "data_table", params: { year: 2024, table: "s_29" } },
    { name: "assist", endpoint: "data_table", params: { year: 2024, table: "M-3" } },
    { name: "participants", endpoint: "data_table", params: { year: 2024, table: "M-4" } }] };

beforeAll(() => isolate());

const header = (s: any, name: string) =>
  fs.readFileSync(path.join(s.workspace, "data", "pbgc", `${name}.csv`), "utf8").split(/\r?\n/)[0].split(",");

describe("pbgc", () => {
  it("the spec is valid (api route)", async () => {
    expect(gr.checkSpec(await load("pbgc"), SPEC)).toEqual([]);
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "pbgc", SPEC);
    expect(r.status).toBe("ok");
    const se = csv(s, "pbgc", "se");
    expect(header(s, "se")).toEqual(["Fiscal Year", "Assets ($ millions)", "Liabilities ($ millions)", "Net Position ($ millions)", "sheet_row"]);
    const y25 = se.find((x) => x["Fiscal Year"] === "2025")!;
    // PBGC FY2025 Annual Report: single-employer assets $152.3 billion, liabilities $90.0 billion, net $62.2 billion
    expect([y25["Assets ($ millions)"], y25["Liabilities ($ millions)"], y25["Net Position ($ millions)"]]).toEqual(["152262", "90049", "62213"]);
    expect(se[1]["Liabilities ($ millions)"]).toBe("2480.3"); // 2480.3000000000002 as stored
    const me = csv(s, "pbgc", "me");
    expect(me.find((x) => x["Fiscal Year"] === "2025")!["Net Positions ($ millions)"]).toBe("2648");
    const rates = csv(s, "pbgc", "rates");
    expect(rates.find((x) => x["Plan Year(s) Beginning"] === "2026")!["Flat-Rate Premium Rate per Participant"]).toBe("111");
    const a = csv(s, "pbgc", "assist");
    expect(a[0]).toHaveProperty("Special Financial Assistance (SFA) Total Amount of SFA ($ millions)");
    expect(a[a.length - 1]["Fiscal Year"]).toBe("Total 10");
    const p = csv(s, "pbgc", "participants");
    expect(p.find((x) => x.Year === "2025")!["Total Insured Participants"]).toBe("11112");
    const notes = r.notes.join(" ");
    expect(notes).toContain("Table S-1: Net Financial Position (1980-2025), single-employer program");
    expect(notes).toContain("2024 Pension Insurance Data Tables (1st Installment)");
    expect(notes).toContain("Source: PBGC Annual Reports");
    expect(notes).toContain("Plan Size (in thousands)"); // M-4's units row
  });

  it("editions and listing", async () => {
    const s = newSession();
    await fetchOk(s, "pbgc", { description: "editions, the 2024 listing, an older edition's table", requests: [
      { name: "eds", endpoint: "editions", params: {} },
      { name: "tabs", endpoint: "table_list", params: { year: 2024 } },
      { name: "s1_2018", endpoint: "data_table", params: { year: 2018, table: "S-1" } },
      { name: "tabs18", endpoint: "table_list", params: { year: 2018 } }] });
    const eds = csv(s, "pbgc", "eds");
    expect(eds.map((e) => e.year).slice(0, 3)).toEqual(["2024", "2023", "2022"]);
    expect(eds[0].url).toBe("https://www.pbgc.gov/sites/default/files/documents/2024-pension-data-tables.xlsx");
    expect(eds.find((e) => e.year === "2018")!.url).toBe("https://www.pbgc.gov/sites/default/files/2018_pension_data_tables.xlsx");
    expect(eds.find((e) => e.year === "2011")!.format).toBe("xls");
    const tabs = Object.fromEntries(csv(s, "pbgc", "tabs").map((t) => [t.table, t]));
    expect(Object.keys(tabs).length).toBe(70);
    expect([tabs["S-22"].in_workbook, tabs["S-1"].in_workbook]).toEqual(["no", "yes"]);
    expect(tabs["M-20"].program).toBe("multiemployer");
    // numbering changes between editions: premium rate history is S-39 in 2018, S-29 in 2024
    expect(tabs["S-29"].title).toContain("Premium Rates");
    const t18 = Object.fromEntries(csv(s, "pbgc", "tabs18").map((t) => [t.table, t]));
    expect(t18["S-39"].title).toContain("Premium Rates");
    const s18 = csv(s, "pbgc", "s1_2018");
    expect(s18.find((x) => x["Fiscal Year"] === "2019")!["Net Position (in millions)"]).toBe("8656");
  });

  it("a table not in the installment is a clear error", async () => {
    const f = await failure(fetchOk(newSession(), "pbgc", { description: "S-22 is listed but not in the 2024 1st installment",
      requests: [{ name: "s22", endpoint: "data_table", params: { year: 2024, table: "S-22" } }] }));
    expect(f.code).toBe("not_found");
    expect(f.message).toContain("is listed");
    expect(f.message).toContain("previous year's edition");
    const s = newSession();
    await fetchOk(s, "pbgc", { description: "S-22 from the 2023 edition",
      requests: [{ name: "s22", endpoint: "data_table", params: { year: 2023, table: "S-22" } }] });
    const row = csv(s, "pbgc", "s22").find((x) => x["Plan Year"] === "1980")!;
    expect([row["Active Participants"], row["Separated Vested Participants"]]).toEqual(["0.7762", "0.0636"]);
  });

  it("an unknown edition is not found", async () => {
    const f = await failure(fetchOk(newSession(), "pbgc", { description: "2025 is not posted",
      requests: [{ name: "x", endpoint: "data_table", params: { year: 2025, table: "S-1" } }] }));
    expect(f.message).toContain("no 2025 edition");
  });

  it("bad specs are refused before any request", async () => {
    const p = await load("pbgc");
    for (const params of [{ year: 2024, table: "Table 9" }, { year: "latest", table: "S-1" }, { year: 2024 }]) {
      expect(gr.checkSpec(p, { requests: [{ name: "x", endpoint: "data_table", params }] }).length, JSON.stringify(params)).toBeGreaterThan(0);
    }
  });

  it("searches the catalog", async () => {
    const r: any = await T.requestSchema(newSession(), { source: "pbgc", search: "premium rates" });
    expect(r.results.map((x: any) => x.alias).slice(0, 3)).toContain("s_29");
  });

  it("manual bundle and ingest", async () => {
    const s = newSession();
    const b: any = await T.manualBundle(s, { sources: [{ source: "pbgc", spec: SPEC }] });
    expect(b.items[0].url).toBe("https://www.pbgc.gov/about/reports/pension-insurance-data");
    const p = await load("pbgc");
    expect(p.adapter!.manualItems!(SPEC, p)[0].note).toContain("2024");
    const one = { description: "S-1 from an uploaded workbook",
      requests: [{ name: "se", endpoint: "data_table", params: { year: 2024, table: "S-1" } }] };
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    fs.copyFileSync(path.join(FX, "pbgc2024_trimmed.xlsx"), path.join(up, "se.xlsx"));
    await prepare(s, "pbgc", one);
    const r: any = await T.ingest(s, { source: "pbgc", spec: one, files: [up] });
    expect(r.status).toBe("ok");
    expect(csv(s, "pbgc", "se").find((x) => x["Fiscal Year"] === "2025")!["Net Position ($ millions)"]).toBe("62213");
  });

  it("normalizes table names", () => {
    expect(["s1", "S-1", "s_1", "Table S-1", "m 20", "GLANCE"].map(normTable)).toEqual(["S-1", "S-1", "S-1", "S-1", "M-20", "GLANCE"]);
  });
});
