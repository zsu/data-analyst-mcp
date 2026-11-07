/** clinical-trials: ported from tests/sources/clinical-trials/test_clinical_trials.py (same fixtures, same values). */
import { beforeAll, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const SPEC = { description: "Recruiting phase 3 sickle cell trials; registry-wide studies by phase",
  requests: [
    { name: "scd_phase3_recruiting", endpoint: "studies",
      params: { "query.cond": "sickle cell", "filter.overallStatus": ["RECRUITING"], phase: "PHASE3" } },
    { name: "phase_counts", endpoint: "field_values", params: { fields: "Phase" } }] };

async function check(spec: any): Promise<any> {
  const s = newSession();
  fixtures("clinical-trials");
  await prepare(s, "clinical-trials", spec);
  return failure(T.fetchData(s, { source: "clinical-trials", spec }));
}

describe("clinical-trials", () => {
  it("fetches by the api route", async () => {
    const s = newSession();
    const r = await fetchOk(s, "clinical-trials", SPEC);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api");
    const rows = csv(s, "clinical-trials", "scd_phase3_recruiting");
    expect(rows.length).toBe(13);
    const first = rows[0];
    expect(first.nctId).toBe("NCT06609226");
    expect(first["leadSponsor.name"]).toBe("Novo Nordisk A/S");
    expect(first["enrollmentInfo.count"]).toBe("480");
    expect(rows.every((x) => x.phases.startsWith("PHASE3") || x.phases.includes("PHASE3"))).toBe(true);
    const ph = Object.fromEntries(csv(s, "clinical-trials", "phase_counts").map((x) => [x.value, x.studiesCount]));
    expect(ph.EARLY_PHASE1).toBe("6510");
  });

  it("a bad phase or status is invalid_request", async () => {
    for (const prm of [{ "query.cond": "asthma", phase: "PHASE5" }, { "query.cond": "asthma", "filter.overallStatus": "recruiting" }]) {
      const f = await check({ requests: [{ name: "x", endpoint: "studies", params: prm }] });
      expect(f.code).toBe("invalid_request");
    }
  });

  it("an unfiltered search is invalid_request", async () => {
    const f = await check({ requests: [{ name: "x", endpoint: "studies", params: {} }] });
    expect(f.code).toBe("invalid_request");
  });

  it("manual links carry aggFilters", async () => {
    const p = await load("clinical-trials");
    const urls = p.adapter!.manualItems!(SPEC, p).map((i: any) => i.url);
    expect(urls.some((u: string) => u.includes("aggFilters=phase%3A3"))).toBe(true);
  });
});
