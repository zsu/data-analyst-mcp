/** federal-register: ported from tests/sources/federal-register/test_federal_register.py.
 * Fixtures were recorded live from www.federalregister.gov (October 2026). */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { normalize } from "../../src/adapters/federal-register.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SPEC = { description: "Executive orders published in 2024 (Biden) and EPA final rules per year",
  requests: [
    { name: "eo_2024", endpoint: "executive_orders",
      params: { "conditions[president][]": "joe-biden", "conditions[publication_date][year]": "2024" } },
    { name: "epa_rules_by_year", endpoint: "document_counts",
      params: { facet: "yearly", "conditions[type][]": "RULE", "conditions[agencies][]": "environmental-protection-agency" } }] };

beforeAll(() => isolate());

describe("federal-register", () => {
  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "federal-register", SPEC);
    expect(r.summary.route).toBe("api");
    const eos = csv(s, "federal-register", "eo_2024");
    expect(eos.length).toBe(18);
    expect(eos[0].executive_order_number).toBe("14132");
    expect(eos[0]["president.identifier"]).toBe("joe-biden");
    const counts = csv(s, "federal-register", "epa_rules_by_year");
    expect(Object.keys(counts[0])).toEqual(["key", "name", "count"]);
    expect(Object.fromEntries(counts.map((c) => [c.name, c.count]))["1995"]).toBe("729");
  });

  it("documents repeated across pages are dropped; facets become rows", () => {
    const rows = [{ document_number: "2019-00011", type: "Notice" }, { document_number: "2019-00012", type: "Notice" },
      { document_number: "2019-00011", type: "Notice" }, { document_number: "", type: "Notice" }];
    expect(normalize({}, { path: "/documents.json" }, rows).map((r) => r.document_number)).toEqual(["2019-00011", "2019-00012", ""]);
    expect(normalize({}, { path: "/documents/facets/yearly" }, [{ "2019-01-01.count": 7, "2019-01-01.name": "2019" }]))
      .toEqual([{ key: "2019-01-01", name: "2019", count: 7 }]);
  });

  it("a bad facet is a spec problem", async () => {
    const s = newSession();
    fixtures("federal-register");
    const spec = { requests: [{ name: "x", endpoint: "document_counts", params: { facet: "decade" } }] };
    await prepare(s, "federal-register", spec);
    expect((await failure(T.fetchData(s, { source: "federal-register", spec }))).code).toBe("invalid_request");
  });

  it("manual bundle", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "federal-register", spec: SPEC }] });
    expect(fs.readFileSync(r.instructions, "utf8")).toContain("federalregister.gov/api/v1/documents.json");
  });
});
