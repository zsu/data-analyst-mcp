/** regulations: ported from tests/sources/regulations/test_regulations.py. Fixtures were recorded
 * live from api.regulations.gov (October 2026); the key is never part of a fixture. */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/regulations.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SPEC = { description: "Power-plant greenhouse gas rule docket: proposed rule documents and posted comment count",
  requests: [
    { name: "docket_rules", endpoint: "documents", params: { "filter[docketId]": "EPA-HQ-OAR-2023-0072", "filter[documentType]": "Proposed Rule" } },
    { name: "docket_comments", endpoint: "comment_count", params: { "filter[docketId]": "EPA-HQ-OAR-2023-0072" } }] };

beforeAll(() => isolate());

describe("regulations", () => {
  it("fetches keyless on the API", async () => {
    const s = newSession();
    const r = await fetchOk(s, "regulations", SPEC);
    expect(r.summary.route).toBe("api");
    const docs = csv(s, "regulations", "docket_rules");
    expect(docs.length).toBe(3);
    expect(docs[0]).toHaveProperty("documentType"); // "attributes." prefix dropped
    expect(new Set(docs.map((d) => d.documentType))).toEqual(new Set(["Proposed Rule"]));
    expect(docs[0].frDocNum).toBe("2023-25580");
    const cnt = csv(s, "regulations", "docket_comments");
    expect(cnt[0].totalElements).toBe("8202");
    expect(cnt[0]["filter[docketId]"]).toBe("EPA-HQ-OAR-2023-0072");
  });

  it("a big request needs a key", async () => {
    const big = { requests: [{ name: "all_epa", endpoint: "documents", params: { "filter[agencyId]": "EPA" }, max_rows: 10000 }] };
    expect(adapter.keyOnlyNeeds!(big).length).toBeGreaterThan(0);
    const s = newSession();
    fixtures("regulations");
    await prepare(s, "regulations", big);
    expect((await failure(T.fetchData(s, { source: "regulations", spec: big }))).code).toBe("key_missing");
  });

  it("manual links carry DEMO_KEY", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "regulations", spec: SPEC }] });
    expect(r.items.every((i: any) => i.url.includes("api_key=DEMO_KEY"))).toBe(true);
  });
});
