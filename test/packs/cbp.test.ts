/**
 * cbp: fixture r001 (the Nationwide Encounters document page) was recorded from www.cbp.gov on 2026-11-07. The
 * CSVs (2-5 MB) are over the fixture size limit; their filters are tested on rows from the November 2026 file.
 */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/cbp.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

describe("cbp", () => {
  it("lists the current files newest first", async () => {
    const s = newSession();
    const r = await fetchOk(s, "cbp", { description: "CBP encounter files", requests: [{ name: "files", endpoint: "list_files" }] });
    expect(r.status).toBe("ok");
    const f = csv(s, "cbp", "files");
    expect(f[0].fiscal_years).toBe("FY2024-FY2027");
    expect(f.slice(0, 2).map((x) => x.file).sort()).toEqual(["2026-11/nationwide-encounters-fy24-fy27-oct-aor",
      "2026-11/nationwide-encounters-fy24-fy27-oct-state"]);
  });

  it("filters encounter rows", () => {
    const rows = [
      { "Fiscal Year": "2025", Component: "U.S. Border Patrol", "Land Border Region": "Southwest Land Border", Citizenship: "MEXICO", "Encounter Count": "5" },
      { "Fiscal Year": "2025", Component: "Office of Field Operations", "Land Border Region": "Northern Land Border", Citizenship: "CANADA", "Encounter Count": "2" }];
    const out = adapter.normalize!({ name: "e", endpoint: "encounters", params: { region: "southwest land border" } }, {}, rows);
    expect(out.map((r) => r.Citizenship)).toEqual(["MEXICO"]);
  });
});
