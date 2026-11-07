/**
 * nces: fixtures r001 (Digest 2025 table 203.10, xlsx) and r002 (HD2023_Dict.zip) were recorded from nces.ed.gov on
 * 2026-11-07. IPEDS data zips (over 1 MB) are over the fixture size limit; their filter is tested on rows here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/nces.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

describe("nces", () => {
  it("reads a Digest table raw and with its stacked header, and an IPEDS dictionary", async () => {
    const s = newSession();
    const r = await fetchOk(s, "nces", { description: "Digest 2025 table 203.10 and the HD2023 dictionary", requests: [
      { name: "t203_10_raw", endpoint: "digest_table", params: { edition: "25", table: "203.10" } },
      { name: "t203_10", endpoint: "digest_table", params: { edition: "25", table: "203.10", header_lines: "3-4" } },
      { name: "hd2023_vars", endpoint: "ipeds_dictionary", params: { file: "HD2023" } },
      { name: "hd2023_codes", endpoint: "ipeds_dictionary", params: { file: "HD2023", sheet: "Frequencies" } }] });
    expect(r.status).toBe("ok");
    const raw = csv(s, "nces", "t203_10_raw");
    expect(raw[1].col1).toBe("[In thousands]");
    const t = csv(s, "nces", "t203_10");
    expect(Object.keys(t[0]).slice(0, 3)).toEqual(["row", "Year", "All grades"]);
    const y1980 = t.find((x) => x.Year === "1980")!;
    expect(y1980["All grades"]).toBe("40,877");
    expect(y1980["Prekindergarten through grade 8 | Total"]).toBe("27,647");
    expect(csv(s, "nces", "hd2023_vars")[0]).toMatchObject({ varName: "UNITID" });
    expect(csv(s, "nces", "hd2023_codes").find((x) => x.VarName === "STABBR" && x.CodeValue === "VT")!.ValueLabel).toBe("Vermont");
  });

  it("filters IPEDS rows by UNITID or state", () => {
    const rows = [{ UNITID: "100654", STABBR: "AL" }, { UNITID: "230959", STABBR: "VT" }, { UNITID: "231174", STABBR: "VT" }];
    const f = (params: any) => adapter.normalize!({ name: "x", endpoint: "ipeds", params }, {}, rows);
    expect(f({ state: "vt" }).map((r) => r.UNITID)).toEqual(["230959", "231174"]);
    expect(f({ unitid: [100654] }).length).toBe(1);
    expect(adapter.checkSpec!({ requests: [{ name: "x", endpoint: "digest_table", params: { edition: "2025", table: "203.10" } }] }, null as any)[0])
      .toContain("two digits");
  });
});
