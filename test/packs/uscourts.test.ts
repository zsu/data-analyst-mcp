/** uscourts: fixture r001 (bf_f2_0930.2026.xlsx, table F-2) was recorded from www.uscourts.gov on 2026-11-07. */
import { beforeAll, describe, expect, it } from "vitest";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

describe("uscourts", () => {
  it("reads table F-2 with its stacked header", async () => {
    const s = newSession();
    const r = await fetchOk(s, "uscourts", { description: "F-2, 12 months to 2026-09-30", requests: [
      { name: "f2", endpoint: "table", params: { file: "bf_f2_0930.2026", header_lines: "3-5", carry: "all" } }] });
    expect(r.status).toBe("ok");
    const t = csv(s, "uscourts", "f2");
    expect(t[0]["Circuit and District"]).toBe("Total");
    expect(t[0]["Total All Chapters"]).toBe("621111");
    const ma = t.find((x) => x["Circuit and District"] === "MA")!;
    expect(ma["Predominant Nature of Debt | Business | Chapter 7"]).toBe("259");
    expect(ma["Predominant Nature of Debt | Nonbusiness | Chapter 13"]).toBe("1672");
  });
});
