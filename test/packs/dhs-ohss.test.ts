/**
 * dhs-ohss pack, ported from tests/sources/dhs-ohss/test_dhs_ohss.py. Fixtures are real ohss.dhs.gov responses
 * read on 2026-10-30, trimmed (the <main> element of the pages; the LPR workbook keeps the cells of sheets TOC,
 * Table 6 and Table 7, every other sheet an empty grid); the FY2025 quarterly report workbook is unchanged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import { forgetPages } from "../../src/adapters/dhs-ohss.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "dhs-ohss", "fixtures");
const LPR_URL = "https://ohss.dhs.gov/system/files/2026-06/2026_0604_ohss_yearbook_lawful_permanent_residents_fy2024.xlsx";
const SPEC = { description: "Persons obtaining LPR status by type and class of admission, FY2024 yearbook",
  requests: [{ name: "lpr_class", endpoint: "yearbook_table", params: { topic: "lpr", fiscal_year: 2024, table: "Table 6" } }] };

beforeAll(() => isolate());

const header = (s: any, name: string) =>
  fs.readFileSync(path.join(s.workspace, "data", "dhs-ohss", `${name}.csv`), "utf8").split(/\r?\n/)[0].split(",");

describe("dhs-ohss", () => {
  it("the spec is valid (api route)", async () => {
    expect(gr.checkSpec(await load("dhs-ohss"), SPEC)).toEqual([]);
  });

  it("fetches LPR Table 6", async () => {
    const s = newSession();
    const r = await fetchOk(s, "dhs-ohss", SPEC);
    const rows = csv(s, "dhs-ohss", "lpr_class");
    const h = header(s, "lpr_class");
    expect(h.slice(0, 3)).toEqual(["section", "Type and class of admission", "2015"]);
    expect(h[h.length - 1]).toBe("2024");
    expect(rows.length).toBe(78); // 3 sections x 26 rows; footnotes and notes cut
    const by = new Map(rows.map((x) => [`${x.section}|${x["Type and class of admission"]}`, x]));
    expect(by.get("TOTAL|Total")!["2024"]).toBe("1364090");
    expect(by.get("ADJUSTMENTS OF STATUS|Total")!["2024"]).toBe("782800");
    expect(by.get("NEW ARRIVALS|Total")!["2024"]).toBe("581290");
    expect(by.get("TOTAL|Children1")!["2015"]).toBe("66740"); // footnote marker kept in the label
    const notes = r.notes.join(" ");
    expect(notes).toContain("1 Includes orphans.");
    expect(notes).toContain("round table cells to the nearest 10");
    expect(notes).toContain(LPR_URL);
  });

  it("no fiscal_year: the newest year page with the topic; Table 7 by a bare number", async () => {
    const s = newSession();
    const r = await fetchOk(s, "dhs-ohss", { requests: [{ name: "t7", endpoint: "yearbook_table", params: { topic: "lpr", table: "7" } }] });
    const rows = csv(s, "dhs-ohss", "t7");
    expect(header(s, "t7")).toEqual(["Type and class of admission", "Total", "Adjustments of status", "New arrivals"]);
    expect(rows[0]).toEqual({ "Type and class of admission": "Total, all immigrants", Total: "1364090",
      "Adjustments of status": "782800", "New arrivals": "581290" });
    expect(r.notes.join(" ")).toContain("FY2024 yearbook");
  });

  it("a wrong sheet lists the sheets", async () => {
    const spec: any = { requests: [{ name: "x", endpoint: "yearbook_table", params: { topic: "lpr", fiscal_year: 2024, table: "Table 99" } }] };
    let f = await failure(fetchOk(newSession(), "dhs-ohss", spec));
    expect(f.code).toBe("agency_rejected"); // kind bad_request (exit 2 in Python)
    expect(f.message).toContain("no sheet 'Table 99'");
    expect(f.message).toContain("'LPRSuppTable 4'");
    expect(f.message).toContain("Type and Major Class of Admission");
    delete spec.requests[0].params.table;
    f = await failure(fetchOk(newSession(), "dhs-ohss", spec));
    expect(f.code).toBe("agency_rejected"); // kind bad_request (exit 2 in Python)
    expect(f.message).toContain("no table given");
  });

  it("a topic not posted yet is a clear not-found, not another year", async () => {
    const f = await failure(fetchOk(newSession(), "dhs-ohss", { requests: [{ name: "enf", endpoint: "yearbook_table",
      params: { topic: "enforcement", fiscal_year: 2024, table: "Table 39" } }] }));
    expect(f.message).toContain("posts no enforcement file");
  });

  it("lists a year's files", async () => {
    const s = newSession();
    await fetchOk(s, "dhs-ohss", { requests: [{ name: "files", endpoint: "yearbook_files", params: { fiscal_year: 2024 } }] });
    const rows = csv(s, "dhs-ohss", "files");
    expect(rows.length).toBe(6); // each file once, though the page links most twice
    const by = Object.fromEntries(rows.map((x) => [x.topic, x]));
    expect(by.lpr.url).toBe(LPR_URL);
    expect(by).toHaveProperty("lpr_expanded");
    expect(by["refugees, refugees_asylees"].fiscal_year).toBe("2024");
  });

  it("the quarterly report: two header rows joined", async () => {
    const s = newSession();
    const r = await fetchOk(s, "dhs-ohss", { requests: [{ name: "lir_class", endpoint: "lir_table", params: { table: "Table 1B" } },
      { name: "lir_files", endpoint: "lir_files", params: {} }] });
    const rows = csv(s, "dhs-ohss", "lir_class");
    // "Total | ... | Adjustments of status | ..." over "Total | Quarter 1 | ..."
    expect(header(s, "lir_class").slice(0, 3)).toEqual(["Type and class of admission", "Total", "Total Quarter 1"]);
    expect(rows[0].Total).toBe("1320080");
    expect(rows[0]["Adjustments of status Total"]).toBe("746830");
    expect(r.notes.join(" ")).toContain("preliminary");
    const files = csv(s, "dhs-ohss", "lir_files");
    expect([files[0].fiscal_year, files[0].through_quarter]).toEqual(["2025", "4"]);
    expect(files.length).toBe(10);
  });

  it("checks the spec", async () => {
    const p = await load("dhs-ohss");
    expect(gr.checkSpec(p, { requests: [{ name: "x", endpoint: "yearbook_table",
      params: { topic: "green cards", fiscal_year: 2024, table: "Table 6" } }] }).length).toBeGreaterThan(0);
    const old = gr.checkSpec(p, { requests: [{ name: "x", endpoint: "yearbook_table", params: { topic: "lpr", fiscal_year: 2010, table: "Table 6" } }] });
    expect(old.join(" ")).toContain("PDF only");
  });

  it("manual items: the page with what to download, or the workbook a fetch found", async () => {
    forgetPages();
    const p = await load("dhs-ohss");
    // no page read in this process (manualItems cannot read it): the item is the year page
    let it: any = p.adapter!.manualItems!(SPEC, p)[0];
    expect(it.url).toBe("https://ohss.dhs.gov/topics/immigration/yearbook/2024");
    expect(it.note).toContain("lpr data tables workbook");
    expect(it.filename).toBe("lpr_class.xlsx");
    await fetchOk(newSession(), "dhs-ohss", SPEC);
    it = p.adapter!.manualItems!(SPEC, p)[0];
    expect(it.url).toBe(LPR_URL);
    expect(it.filename).toBe("lpr_class.xlsx");
  });

  it("ingests an uploaded workbook; a saved web page is refused", async () => {
    const s = newSession();
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "up-"));
    fs.copyFileSync(path.join(FX, "lpr_fy2024_trimmed.xlsx"), path.join(up, "lpr_class.xlsx"));
    await prepare(s, "dhs-ohss", SPEC);
    const r: any = await T.ingest(s, { source: "dhs-ohss", spec: SPEC, files: [up] });
    expect(r.status).toBe("ok");
    const rows = csv(s, "dhs-ohss", "lpr_class");
    expect(rows.length).toBe(78);
    expect(rows[0]["2024"]).toBe("1364090");
    // the year page saved under the workbook's name (what a script gets for the page link) is refused clearly
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), "bad-"));
    fs.copyFileSync(path.join(FX, "yearbook_2024.html"), path.join(bad, "lpr_class.xlsx"));
    const s2 = newSession();
    await prepare(s2, "dhs-ohss", SPEC);
    const f = await failure(T.ingest(s2, { source: "dhs-ohss", spec: SPEC, files: [bad] }));
    expect(f.code).toBe("agency_rejected"); // kind bad_request (exit 2 in Python)
    expect(f.message).toContain("is a web page, not the workbook");
  });
});
