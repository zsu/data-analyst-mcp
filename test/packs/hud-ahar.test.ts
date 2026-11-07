/**
 * hud-ahar: manual only (huduser.gov refuses scripts), so there are no recorded fixtures. The upload reader is
 * tested on a small workbook written here as .xlsb (the PIT files' format), with a sheet per year.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import * as T from "../../src/tools.js";
import { csv, failure, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

function workbook(dir: string, name: string): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["State", "Number of CoCs", "Overall Homeless, 2025",
    "Sheltered Total Homeless, 2025", "Unsheltered Homeless, 2025"], ["AK", 2, 2700, 2000, 700], ["AL", 8, 3800, 2300, 1500]]), "2025");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["State", "Number of CoCs", "Overall Homeless, 2024"], ["AK", 2, 2600]]), "2024");
  const f = path.join(dir, name);
  fs.writeFileSync(f, XLSX.write(wb, { bookType: "xlsb", type: "buffer" }));
  return f;
}

describe("hud-ahar", () => {
  it("refuses fetch, gives the browser links, and reads the uploaded year's sheet", async () => {
    const spec = { description: "PIT counts by state, 2025", requests: [{ name: "pit_2025", endpoint: "pit_by_state", params: { year: "2025" } }] };
    const s = newSession();
    fixtures("hud-ahar");
    await prepare(s, "hud-ahar", spec);
    const f = await failure(T.fetchData(s, { source: "hud-ahar", spec }));
    expect(f.code).toBe("agency_unavailable");
    const b: any = await T.manualBundle(s, { sources: [{ source: "hud-ahar", spec }] });
    expect(JSON.stringify(b)).toContain("2007-2025-PIT-Counts-by-State.xlsb");
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "ahar-up-"));
    workbook(up, "2007-2025-PIT-Counts-by-State.xlsb");
    const r: any = await T.ingest(s, { source: "hud-ahar", spec, files: [up] });
    expect(r.status).toBe("ok");
    const rows = csv(s, "hud-ahar", "pit_2025");
    expect(rows.map((x) => x.State)).toEqual(["AK", "AL"]);
    expect(rows[1]["Unsheltered Homeless, 2025"]).toBe("1500");
    expect(Object.keys(rows[0])[0]).toBe("State");
  });

  it("names the sheets when the year is not one", async () => {
    const spec = { requests: [{ name: "pit_1999", endpoint: "pit_by_state", params: { year: "1999" } }] };
    const s = newSession();
    fixtures("hud-ahar");
    await prepare(s, "hud-ahar", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "ahar-up-"));
    workbook(up, "2007-2025-PIT-Counts-by-State.xlsb");
    const f = await failure(T.ingest(s, { source: "hud-ahar", spec, files: [up] }));
    expect(f.message).toContain("sheets: 2025, 2024");
  });
});
