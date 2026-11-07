/**
 * uspto: ported from the Python skill's tests/sources/uspto/test_uspto.py. doc_applications_search.json is the JSON
 * response sample USPTO publishes for the Patent File Wrapper search endpoint (no key was available), mapped to the
 * query that would return it; live_probe_401.json is a real keyless probe response recorded on 2026-10-20.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as T from "../../src/tools.js";
import { csv, failure, fakeKeys, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SPEC = { description: "Application 18045436 (documented example)",
  requests: [{ name: "app_18045436", endpoint: "applications_search", params: { q: "applicationNumberText:18045436" } }] };

beforeAll(() => isolate());

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures("uspto");
  await prepare(s, "uspto", spec);
  return failure(T.fetchData(s, { source: "uspto", spec }));
}

describe("uspto", () => {
  it("without a key the fetch says to set up USPTO_API_KEY", async () => {
    delete process.env.USPTO_API_KEY;
    const f = await fetchFail(SPEC);
    expect(f.code).toBe("key_missing");
    expect(f.message).toContain("USPTO_API_KEY");
  });

  it("fetches the documented example", async () => {
    await fakeKeys("uspto");
    const s = newSession();
    await fetchOk(s, "uspto", SPEC);
    const rows = csv(s, "uspto", "app_18045436");
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.applicationNumberText).toBe("18045436");
    expect(row["applicationMetaData.patentNumber"]).toBe("12000000");
    expect(row["applicationMetaData.grantDate"]).toBe("2024-06-04");
    expect(row["applicationMetaData.applicationStatusDescriptionText"]).toBe("Patented Case");
    expect(row["applicationMetaData.cpcClassificationBag"]).toContain("C12Q1/6869");
  });

  it("an application number with slashes is a spec problem", async () => {
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "application", params: { applicationNumberText: "14/412,875" } }] });
    expect(f.code).toBe("invalid_request");
  });

  it("the manual bundle sends the key in a header", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "uspto", spec: SPEC }] });
    const manifest = JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8"));
    const it0 = manifest.items[0];
    expect(it0.key_header).toBe("X-API-KEY");
    expect(it0.key_env).toBe("USPTO_API_KEY");
    expect(it0.url).not.toContain("{API_KEY}");
    expect(it0.note).toContain("X-API-KEY header");
  });
});
