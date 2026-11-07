/** senate-lobbying: ported from tests/sources/senate-lobbying/test_senate_lobbying.py (same fixtures, same values). */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import { readJson } from "../../src/core/policy.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const SRC = "senate-lobbying";
const BASE = { registrant_name: "Pfizer", client_name: "Pfizer", filing_year: 2024, filing_period: "first_quarter" };
const SPEC = { description: "Pfizer's own lobbying reports for Q1 2024 (original and amendment), by filing and by activity; " +
  "LD-203 contributions of one lobbyist",
  requests: [
    { name: "pfizer_q1_2024", endpoint: "filings", params: BASE },
    { name: "pfizer_q1_2024_tax", endpoint: "filing_activities", params: { ...BASE, issue_code: "TAX" } },
    { name: "pomper_2024", endpoint: "contributions", params: { lobbyist_name: "Pomper", filing_year: 2024 } }] };

describe("senate-lobbying", () => {
  it("fetches by the api route", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.summary.route).toBe("api");
    const f = Object.fromEntries(csv(s, SRC, "pfizer_q1_2024").map((x) => [x.filing_type, x]));
    expect(f.Q1.expenses).toBe("3550000.00");
    expect(f["1A"].expenses).toBe("3740000.00");
    expect(f["1A"].is_amendment).toBe("True");
    expect(f.Q1.is_amendment).toBe("False");
    const acts = csv(s, SRC, "pfizer_q1_2024_tax");
    expect(acts.length).toBeGreaterThan(0);
    expect(new Set(acts.map((a) => a.general_issue_code))).toEqual(new Set(["TAX"]));
    expect(acts[0]).toHaveProperty("lobbyists");
    const items = csv(s, SRC, "pomper_2024");
    expect(items.length).toBe(49);
    expect(items[0].payee_name).toBe("DEMOCRATIC SENATORIAL CAMPAIGN COMMITTEE");
  });

  it("entity filters the API ignores are renamed", async () => {
    const p = await load(SRC);
    const ad = p.adapter!;
    const eps = readJson(p.dir, "endpoints.json").endpoints;
    expect(ad.beforeRequest!({ name: "x" }, eps.clients, { state: "OR", client_id: "9876", client_name: "port" }))
      .toEqual({ client_state: "OR", id: "9876", client_name: "port" });
    expect(ad.beforeRequest!({ name: "x" }, eps.registrants, { registrant_id: "321", state: "OR" })).toEqual({ id: "321", state: "OR" });
    expect(ad.beforeRequest!({ name: "x" }, eps.filings, { registrant_id: "321", client_state: "OR" }))
      .toEqual({ registrant_id: "321", client_state: "OR" });
    const items = gr.manualItems(p, { requests: [{ name: "c", endpoint: "clients", params: { state: "OR" } }] });
    expect(items[0].url).toContain("client_state=OR");
    expect(items[0].url).not.toContain("&state=");
  });

  it("a filing repeated per matching activity is kept once", async () => {
    const p = await load(SRC);
    const ad = p.adapter!;
    const acts = [{ general_issue_code: "ENV", description: "sample issue text" },
      { general_issue_code: "TRA", description: "sample issue text, second activity" }];
    const one = { filing_uuid: "u-1", filing_type: "Q1", income: "20000.00", lobbying_activities: acts };
    const two = { filing_uuid: "u-2", filing_type: "Q1", income: "10000.00", lobbying_activities: acts.slice(0, 1) };
    const fake = (rows: unknown[]): any => ({
      async request() {
        const body = Buffer.from(JSON.stringify({ count: rows.length, next: null, results: rows }));
        return { status: 200, body, text: () => body.toString("utf8"), json: () => JSON.parse(body.toString("utf8")) };
      },
    });
    const params = { filing_year: 2025, filing_specific_lobbying_issues: "sample" };
    const spec = { requests: [{ name: "f", endpoint: "filings", params }, { name: "a", endpoint: "filing_activities", params }] };
    const fetch = ad.fetch as any;
    const [tables, notes] = await fetch(spec, p, "api", fake([one, two, one]));
    expect(tables.f.map((r: any) => r.filing_uuid)).toEqual(["u-1", "u-2"]);
    expect(tables.f.reduce((s: number, r: any) => s + Number(r.income), 0)).toBe(30000);
    expect(tables.a.map((r: any) => [r.filing_uuid, r.general_issue_code])).toEqual([["u-1", "ENV"], ["u-1", "TRA"], ["u-2", "ENV"]]);
    const rep = notes.filter((n: string) => n.includes("repeats were dropped"));
    expect(rep.length).toBe(2);
    expect(rep[0].startsWith("f: the LDA API sent 3 rows for 2 distinct filings")).toBe(true);
    expect(rep[0]).toContain("filing_specific_lobbying_issues");
    const [, notes2] = await fetch({ requests: spec.requests.slice(0, 1) }, p, "api", fake([one, two]));
    expect(notes2.some((n: string) => n.includes("repeats were dropped"))).toBe(false);
    expect(ad.normalize!({ name: "l" }, { path: "/lobbyists/" }, [{ id: 7 }, { id: 7 }, { id: 8 }])).toEqual([{ id: 7 }, { id: 8 }]);
  });

  it("an unfiltered filings request is invalid_request", async () => {
    const bad = { requests: [{ name: "all", endpoint: "filings", params: { ordering: "-dt_posted" } }] };
    const s = newSession();
    fixtures(SRC);
    await prepare(s, SRC, bad);
    expect((await failure(T.fetchData(s, { source: SRC, spec: bad }))).code).toBe("invalid_request");
  });

  it("writes a manual bundle", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec: SPEC }] });
    expect(fs.existsSync(r.instructions)).toBe(true);
  });
});
