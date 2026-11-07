/** fhwa: fixture r001 (Highway Statistics 2023, VM-2 xlsx) was recorded from www.fhwa.dot.gov on 2026-11-07. */
import { beforeAll, describe, expect, it } from "vitest";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

describe("fhwa", () => {
  it("reads VM-2 past the hidden sheet, raw and with its stacked header", async () => {
    const s = newSession();
    const r = await fetchOk(s, "fhwa", { description: "VM-2 2023", requests: [
      { name: "vm2_2023_raw", endpoint: "table", params: { year: "2023", table: "vm2" } },
      { name: "vm2_2023", endpoint: "table", params: { year: "2023", table: "vm2", header_lines: "5-8" } }] });
    expect(r.status).toBe("ok");
    expect(csv(s, "fhwa", "vm2_2023_raw")[0].col1).toBe("FUNCTIONAL  SYSTEM  TRAVEL - 2023 (1)");
    const t = csv(s, "fhwa", "vm2_2023");
    const al = t.find((x) => x.STATE === "Alabama")!;
    expect(al["RURAL | INTERSTATE"]).toBe("6903.3341");
    expect(al["RURAL | MINOR | ARTERIAL"]).toBe("4655.6639999999998");
    expect(Object.keys(al)).toContain("URBAN | TOTAL_col18");
  });
});
