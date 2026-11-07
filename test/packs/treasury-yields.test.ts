/** treasury-yields: ported from tests/sources/treasury-yields/test_treasury_yields.py (same fixtures and values).
 * Fixtures r001-r003.csv were recorded live on 2026-10-20 (par yield curve 2024 and 2025, long-term rates 2025),
 * full yearly files as served. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, fetchOk, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

beforeAll(() => isolate());

const FX = path.join(TEST_DIR, "packs", "treasury-yields", "fixtures");
const SPEC = { description: "Par yield curve and long-term rates, 2024-2025",
  requests: [{ name: "par", endpoint: "par_yield_curve", params: { start_year: 2024, end_year: 2025 } },
    { name: "lt", endpoint: "long_term_rates", params: { year: 2025 } }] };

describe("treasury-yields", () => {
  it("takes the api route", async () => {
    expect((await fetchOk(newSession(), "treasury-yields", SPEC)).summary.route).toBe("api");
  });

  it("stacks years oldest first", async () => {
    const s = newSession();
    const r = await fetchOk(s, "treasury-yields", SPEC);
    expect(r.status).toBe("ok");
    const par = csv(s, "treasury-yields", "par");
    expect(Object.keys(par[0]).slice(0, 3)).toEqual(["date", "1 Mo", "1.5 Month"]);
    expect(par[0].date).toBe("2024-01-02");
    expect(par[0]["10 Yr"]).toBe("3.95");
    expect(par[0]["1.5 Month"]).toBe(""); // not published before 2025-02-18: empty, not zero
    expect(par[par.length - 1].date).toBe("2025-12-31");
    expect(par[par.length - 1]["10 Yr"]).toBe("4.18");
    expect(par.length).toBe(499);
    const lt = csv(s, "treasury-yields", "lt");
    expect(Object.keys(lt[0])).toEqual(["date", "LT COMPOSITE (>10 Yrs)", "TREASURY 20-Yr CMT"]);
    expect([lt[0].date, lt[0]["LT COMPOSITE (>10 Yrs)"]]).toEqual(["2025-01-02", "4.85"]);
  });

  it("a year before the feed starts is a spec problem", async () => {
    const bad = { requests: [{ name: "r", endpoint: "real_yield_curve", params: { start_year: 1999, end_year: 2004 } }] };
    const probs = gr.checkSpec(await load("treasury-yields"), bad);
    expect(probs.length).toBeGreaterThan(0);
    expect(probs.join("; ")).toContain("2003");
  });

  it("finds the alias in the catalog", async () => {
    const r: any = await T.requestSchema(newSession(), { source: "treasury-yields", search: "breakeven" });
    expect(r.results[0].alias).toBe("real");
  });

  it("the manual bundle has one link per year", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "treasury-yields", spec: SPEC }] });
    expect(r.items.map((i: any) => i.filename)).toEqual(["par_2024.csv", "par_2025.csv", "lt_2025.csv"]);
    expect(r.items[0].url).toContain("daily-treasury-rates.csv/2024/all?type=daily_treasury_yield_curve");
  });

  it("ingests the downloaded files", async () => {
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "ty-up-"));
    for (const [src, dst] of [["r001.csv", "par_2024.csv"], ["r002.csv", "par_2025.csv"], ["r003.csv", "lt_2025.csv"]]) {
      fs.copyFileSync(path.join(FX, src), path.join(up, dst));
    }
    const s = newSession();
    delete process.env.DATA_ANALYST_FIXTURES;
    await prepare(s, "treasury-yields", SPEC);
    const r: any = await T.ingest(s, { source: "treasury-yields", spec: SPEC, files: [up] });
    expect(r.status).toBe("ok");
    expect(csv(s, "treasury-yields", "par").length).toBe(499);
  });
});
