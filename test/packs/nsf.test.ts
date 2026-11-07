/** nsf: fixture r001 (keyword quantum, January 2026) was recorded from api.nsf.gov on 2026-11-07. */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/nsf.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

describe("nsf", () => {
  it("fetches awards without people's contact fields", async () => {
    const s = newSession();
    const r = await fetchOk(s, "nsf", { description: "NSF awards with quantum, January 2026", requests: [
      { name: "quantum_jan26", endpoint: "awards", params: { keyword: "quantum", dateStart: "01/01/2026", dateEnd: "01/31/2026" } }] });
    expect(r.status).toBe("ok");
    const rows = csv(s, "nsf", "quantum_jan26");
    expect(rows.length).toBe(11);
    expect(Object.keys(rows[0])).not.toContain("piEmail");
    expect(Object.keys(rows[0])).not.toContain("poPhone");
    expect(rows.every((x) => /^\d{7}$/.test(x.id))).toBe(true);
    expect(rows.every((x) => x.fundsObligatedAmt !== undefined)).toBe(true);
  });

  it("checks dates and asks for a filter", () => {
    const p = (params: any) => adapter.checkSpec!({ requests: [{ name: "a", endpoint: "awards", params }] }, null as any);
    expect(p({ dateStart: "2026-01-01" })[0]).toContain("MM/DD/YYYY");
    expect(p({})[0]).toContain("at least one filter");
    expect(p({ awardeeStateCode: "VT" })).toEqual([]);
  });
});
