/** USITC HTS: ported from tests/sources/usitc/test_usitc.py (same fixtures and values). Fixtures recorded live from
 * hts.usitc.gov/reststop (keyless) on 2026-11-04, HTS 2026 Revision 22. */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/usitc.js";

const rateType = adapter.rateType as (t: string) => string;
const dotted = adapter.dotted as (h: string) => string;
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

const SPEC = { description: "HTS revision, steel flat-rolled heading 7208, lithium-ion lines, dairy heading 0401",
  requests: [
    { name: "release", endpoint: "current_release", params: {} },
    { name: "steel", endpoint: "schedule", params: { from: "7208", to: "7208" } },
    { name: "li_ion", endpoint: "search", params: { keyword: "lithium-ion" } },
    { name: "dairy", endpoint: "schedule", params: { from: "0401", to: "0401" } }] };

describe("usitc", () => {
  it("takes the api route", async () => {
    expect((await fetchOk(newSession(), "usitc", SPEC)).summary.route).toBe("api");
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "usitc", SPEC);
    expect(r.status).toBe("ok");
    expect(csv(s, "usitc", "release")[0].name).toBe("2026HTSRev22");
    const steel = csv(s, "usitc", "steel");
    // to=7208 is the whole heading: the pack asks up to 7209 and drops the 7209 heading row
    expect(steel.length).toBe(54);
    expect(steel[0].htsno).toBe("7208");
    expect(steel.every((x) => !x.htsno.startsWith("7209"))).toBe(true);
    expect(steel[steel.length - 1].htsno).toBe("7208.90.00.00");
    const line = steel.find((x) => x.htsno === "7208.10.15.00")!;
    expect([line.general, line.general_rate_type, line.general_ad_valorem_pct]).toEqual(["Free", "free", "0.0"]);
    for (const col of ["special", "other", "rate_line", "general_effective", "chapter99_refs", "footnotes", "units"]) {
      expect(steel[0]).toHaveProperty(col);
    }
    const dairy = csv(s, "usitc", "dairy");
    const cream = dairy.find((x) => x.htsno === "0401.50.75.00")!;
    expect([cream.general, cream.general_rate_type, cream.general_ad_valorem_pct]).toEqual(["$1.646/kg", "specific", ""]);
    expect(cream.chapter99_refs).toBe("9904.04.09 9904.04.21");
    const li = csv(s, "usitc", "li_ion");
    expect(li.length).toBe(31);
    // a search hit whose rate line is not in the reply gets no rate from the previous (unrelated) hit
    const stat = li.find((x) => x.htsno === "2826.90.90.10")!;
    expect([stat.rate_line, stat.general_rate_type]).toEqual(["", "none"]);
  });

  it("carries rates down and types them", () => {
    const rows = [
      { htsno: "8703", indent: "0", general: "", footnotes: [], units: [] },
      { htsno: "8703.10.50", indent: "2", general: "2.5%", units: [],
        footnotes: [{ columns: ["other"], value: "See 9903.90.08. ", type: "endnote" }] },
      { htsno: "8703.10.50.30", indent: "3", general: "", footnotes: [], units: ["No."] },
      { htsno: "", indent: "1", general: "", footnotes: [], units: [] },
      { htsno: "8703.21.01.10", indent: "4", general: "", footnotes: [], units: ["No."] },
    ];
    const out = adapter.normalize!({} as any, { path: "/exportList" }, rows);
    // the CSV cell of Python's float 2.5
    expect([out[2].rate_line, out[2].general_effective, out[2].general_ad_valorem_pct]).toEqual(["8703.10.50", "2.5%", "2.5"]);
    expect(out[2].units).toBe("No.");
    expect(out[1].chapter99_refs).toBe("9903.90.08");
    expect(out[1].footnotes).toBe("[other] See 9903.90.08.");
    expect([out[3].rate_line, out[3].general_rate_type]).toEqual(["", "none"]);
    expect(out[4].rate_line).toBe(""); // 8703.21.01.10 does not extend 8703.10.50
    expect(rateType("Free (A,AU,BH)")).toBe("free");
    expect(rateType("1.7¢/kg on lead content")).toBe("specific");
    expect(rateType("0.9¢/kg + 2.2%")).toBe("compound");
    expect(rateType("The duty provided in the applicable subheading + 25%")).toBe("chapter99");
    expect(rateType("12%")).toBe("ad_valorem");
  });

  it("range bounds", async () => {
    expect(dotted("870380")).toBe("8703.80");
    expect(dotted("8703.80.00.20")).toBe("8703.80.00.20");
    expect(dotted("870")).toBe("");
    const ep = { path: "/exportList" };
    const sent = adapter.beforeRequest!({} as any, ep, { from: "870380", to: "8703.80" }) as any;
    expect([sent.from, sent.to]).toEqual(["8703.80", "8703.81"]);
    expect((adapter.beforeRequest!({} as any, ep, { from: "8703", to: "8799" }) as any).to).toBe("8800");
    expect((adapter.beforeRequest!({} as any, ep, { from: "9903", to: "9999" }) as any).to).toBe("9999.99.99.99");
    const p = await load("usitc");
    const bad = { requests: [{ name: "x", endpoint: "schedule", params: { from: "87a", to: "8703" } }] };
    expect(gr.checkSpec(p, bad).length).toBeGreaterThan(0);
    const rev = { requests: [{ name: "x", endpoint: "schedule", params: { from: "8704", to: "8703" } }] };
    expect(gr.checkSpec(p, rev).length).toBeGreaterThan(0);
  });

  it("a missing range is a spec problem", async () => {
    const bad = { requests: [{ name: "x", endpoint: "schedule", params: { from: "7208" } }] };
    expect(gr.checkSpec(await load("usitc"), bad).length).toBeGreaterThan(0);
  });
});
