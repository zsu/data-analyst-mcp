/** Manual-download bundles, ingest, the keyless/key-missing routes and the .xls reader. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../src/core/generic-rest.js";
import { load } from "../src/core/packs.js";
import { xlsSheets } from "../src/core/tabular.js";
import * as T from "../src/tools.js";
import { csv, failure, fixtures, isolate, newSession, prepare, TEST_DIR } from "./helpers.js";

const CDC = { description: "Leading causes of death, New York, 2017", requests: [{ name: "ny_causes_2017", endpoint: "query",
  params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'", $order: "deaths DESC" } }] };

beforeAll(() => isolate());

describe("manual bundle", () => {
  it("writes instructions, both scripts with the requests built in, and the spec", async () => {
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: "cdc", spec: CDC }], reason: "test" });
    expect(fs.existsSync(r.instructions)).toBe(true);
    const sh = fs.readFileSync(r.download_scripts.bash, "utf8");
    const ps = fs.readFileSync(r.download_scripts.powershell, "utf8");
    expect(sh).toContain("https://data.cdc.gov/resource/");
    expect(sh).not.toContain("\r\n");
    expect(ps).toContain("\r\n");
    expect(sh).not.toContain("@ITEMS@");
    expect(JSON.parse(fs.readFileSync(r.request_spec, "utf8"))).toEqual(CDC);
    expect(r.user_commands.bash).toBe("bash ~/Downloads/download_data.sh");
  });

  it("covers several sources in one bundle", async () => {
    const s = newSession();
    const fema = { requests: [{ name: "regions", endpoint: "query", params: { version: "v2", entity: "FemaRegions" } }] };
    const r: any = await T.manualBundle(s, { sources: [{ source: "cdc", spec: CDC }, { source: "fema", spec: fema }] });
    expect(new Set(r.items.map((i: any) => i.source))).toEqual(new Set(["cdc", "fema"]));
    expect(path.basename(r.request_spec)).toBe("plan.json");
  });
});

describe("ingest", () => {
  it("packages the downloaded file like a fetch, with the manual route", async () => {
    const s = newSession();
    fixtures("cdc");
    await prepare(s, "cdc", CDC);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    const idx = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "packs", "cdc", "fixtures", "index.json"), "utf8"));
    const file = Object.entries<any>(idx).find(([k]) => k.includes("bi63-dtpu") && k.includes("New+York"))![1];
    fs.copyFileSync(path.join(TEST_DIR, "packs", "cdc", "fixtures", typeof file === "string" ? file : file.file),
      path.join(up, "ny_causes_2017.json"));
    const r: any = await T.ingest(s, { source: "cdc", spec: CDC, files: [up] });
    expect(r.summary.route).toBe("manual_download");
    expect(csv(s, "cdc", "ny_causes_2017")[0].cause_name).toBe("All causes");
    expect(r.notes[0]).toContain("ingested");
  });

  it("names the files that are missing", async () => {
    const s = newSession();
    await prepare(s, "fema", { requests: [{ name: "a", endpoint: "query", params: { version: "v2", entity: "FemaRegions" } },
      { name: "b", endpoint: "query", params: { version: "v2", entity: "FemaRegions" } }] });
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
    fs.writeFileSync(path.join(up, "a.csv"), "region\n1\n");
    fs.writeFileSync(path.join(up, "other.txt"), "x");
    const f = await failure(T.ingest(s, { source: "fema", files: [up], spec: { requests: [
      { name: "a", endpoint: "query", params: { version: "v2", entity: "FemaRegions" } },
      { name: "b", endpoint: "query", params: { version: "v2", entity: "FemaRegions" } }] } }));
    expect(f.code).toBe("not_found");
    expect(f.missing).toEqual(["b.csv"]);
  });

  it("reads a dataset page's CSV export for a JSON request", async () => {
    const p = await load("medicaid");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "up-"));
    const f = path.join(dir, "enroll_latest.csv");
    fs.writeFileSync(f, '"State Abbreviation","Reporting Period","Total Medicaid and CHIP Enrollment"\n"VT","202607","144684"\n');
    const rows = gr.parseUpload(p, { name: "enroll_latest", endpoint: "query", params: { dataset: "enrollment" } }, [f]);
    expect(rows).toEqual([{ "State Abbreviation": "VT", "Reporting Period": "202607", "Total Medicaid and CHIP Enrollment": "144684" }]);
  });
});

describe("xls", () => {
  // the same cells as Python's xlrd (checked on the five recorded .xls workbooks)
  it("reads a legacy workbook, sized by the cells that hold values", () => {
    const sheets = xlsSheets(fs.readFileSync(path.join(TEST_DIR, "packs", "fsa", "fixtures", "PortfolioSummary.xls")));
    expect(Object.keys(sheets)).toEqual(["PortfolioSummary"]);
    expect(sheets.PortfolioSummary[0][0]).toBe("Federal Student Aid Portfolio Summary");
    expect(sheets.PortfolioSummary[0].length).toBe(10);
    expect(sheets.PortfolioSummary.length).toBe(72);
  });
});
