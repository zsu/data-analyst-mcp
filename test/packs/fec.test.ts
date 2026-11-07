/**
 * fec: ported from tests/sources/fec/test_fec.py. Fixtures were recorded live from
 * api.open.fec.gov (October 2026); the client drops api_key from recorded URLs. The Schedule A sample uses committee
 * (PAC) receipts only, so no individual contributor's details are stored in the repository.
 */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/fec.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SPEC = { description: "2024 Pennsylvania Senate race: candidates' money, small-donor share and outside spending for one " +
    "candidate, and a sample of committee (PAC) contributions",
  requests: [
    { name: "pa_senate_2024", endpoint: "elections", params: { office: "senate", state: "PA", cycle: 2024 } },
    { name: "casey_by_size", endpoint: "contributions_by_size", params: { candidate_id: "S6PA00217", cycle: 2024 } },
    { name: "casey_outside", endpoint: "independent_expenditures_by_candidate", params: { candidate_id: "S6PA00217", cycle: 2024 } },
    { name: "casey_pac_receipts_sample", endpoint: "schedule_a", params: { committee_id: "C00431056",
      two_year_transaction_period: 2024, is_individual: "false", per_page: 5 }, max_rows: 8 }] };

beforeAll(() => isolate());

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures("fec");
  await prepare(s, "fec", spec);
  return failure(T.fetchData(s, { source: "fec", spec }));
}

describe("fec", () => {
  it("a small spec runs keyless on the API", () => {
    expect(adapter.keyOnlyNeeds!({ requests: SPEC.requests.slice(0, 3) })).toEqual([]);
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "fec", SPEC);
    expect(r.summary.route).toBe("api");
    const race = csv(s, "fec", "pa_senate_2024");
    expect(race.length).toBe(11);
    expect(race[0].candidate_id).toBe("S6PA00217");
    expect(race[0].total_receipts).toBe("64886501.07");
    expect(Object.fromEntries(csv(s, "fec", "casey_by_size").map((x) => [x.size, x.total]))["200"]).toBe("4035976.17");
    expect(Object.fromEntries(csv(s, "fec", "casey_outside").map((x) => [x.support_oppose_indicator, x.total])).O).toBe("103689638.03");
    const rows = csv(s, "fec", "casey_pac_receipts_sample"); // two keyset pages of 5, cut at 8
    expect(rows.length).toBe(8);
    expect(rows.every((x) => x.committee_id === "C00431056")).toBe(true);
    expect(r.notes.some((n: string) => n.includes("stopped at 8 rows"))).toBe(true);
  });

  it("an unfiltered schedule is a spec problem", async () => {
    const f = await fetchFail({ requests: [{ name: "all", endpoint: "schedule_a", params: { two_year_transaction_period: 2024 } }] });
    expect(f.code).toBe("invalid_request");
  });

  it("a big itemized request needs a key", async () => {
    const big = { requests: [{ name: "pac", endpoint: "schedule_a", params: { committee_id: "C00431056" } }] };
    expect(adapter.keyOnlyNeeds!(big).length).toBeGreaterThan(0);
    expect((await fetchFail(big)).code).toBe("key_missing");
  });

  it("manual links carry DEMO_KEY", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "fec", spec: SPEC }] });
    expect(r.items.length).toBe(4);
    expect(r.items.every((i: any) => i.url.includes("api_key=DEMO_KEY"))).toBe(true);
  });
});
