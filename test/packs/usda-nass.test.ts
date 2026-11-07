/**
 * usda-nass pack, ported from tests/sources/usda-nass/test_usda_nass.py. No USDA_NASS_API_KEY was available, so
 * the fixtures are the example outputs printed on the Quick Stats API page (read 2026-10-20), saved as doc_*.json;
 * they are not live recordings. A fake key is set only so the client takes the keyed route; URLs drop it.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fakeKeys, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SRC = "usda-nass";
const SPEC = { description: "Corn in Virginia since 2012 (the documented example), its row count, and the sector names",
  requests: [
    { name: "corn_va", endpoint: "query", params: { commodity_desc: "corn", year__GE: 2012, state_alpha: "va" } },
    { name: "corn_va_count", endpoint: "count", params: { commodity_desc: "CORN", year__GE: 2012, state_alpha: "VA" } },
    { name: "sectors", endpoint: "param_values", params: { param: "sector_desc" } }] };

beforeAll(() => isolate());
beforeEach(() => {
  delete process.env.USDA_NASS_API_KEY;
});

describe("usda-nass", () => {
  it("without a key the fetch asks for setup", async () => {
    const s = newSession();
    fixtures(SRC);
    await prepare(s, SRC, SPEC);
    const f = await failure(T.fetchData(s, { source: SRC, spec: SPEC }));
    expect(f.code).toBe("key_missing");
    expect(f.message).toContain("USDA_NASS_API_KEY");
  });

  it("with a key the spec is valid (api route)", async () => {
    await fakeKeys(SRC);
    expect(gr.checkSpec(await load(SRC), SPEC)).toEqual([]);
    expect((await fetchOk(newSession(), SRC, SPEC)).summary.route).toBe("api");
  });

  it("fetches the documented examples", async () => {
    const keys = await fakeKeys(SRC);
    const s = newSession();
    await fetchOk(s, SRC, SPEC);
    const rows = csv(s, SRC, "corn_va"); // lower-case filters were upper-cased
    expect(rows[0].short_desc).toBe("CORN - ACRES PLANTED");
    expect(rows[0].Value).toBe("510,000");
    expect(rows[0].value_num).toBe("510000");
    expect(rows[0].value_flag).toBe("");
    expect(csv(s, SRC, "corn_va_count")[0].count).toBe("27");
    const sec = csv(s, SRC, "sectors");
    expect(sec.map((x) => x.value).slice(0, 2)).toEqual(["ANIMALS & PRODUCTS", "CROPS"]);
    expect(sec[0].param).toBe("sector_desc");
    const readme = fs.readFileSync(path.join(s.workspace, "data", SRC, "README.md"), "utf8");
    expect(readme).not.toContain(process.env[keys[0]]!);
  });

  it("suppression codes and errors inside HTTP 200", async () => {
    const ad = (await load(SRC)).adapter!;
    const rows = ad.normalize!({ name: "x", endpoint: "query" }, {}, [{ Value: "(D)" }, { Value: "1,234.5" }, { Value: "(Z)", "CV (%)": "12.3" }]);
    expect(rows.map((r) => [r.value_num, r.value_flag])).toEqual([["", "D"], ["1234.5", ""], ["", "Z"]]);
    expect(rows[2].cv_num).toBe("12.3");
    expect(ad.checkError!(200, Buffer.from('{"error":["exceeds limit = 50000"]}'))).toContain("exceeds limit");
  });

  it("an unfiltered query is invalid_request", async () => {
    await fakeKeys(SRC);
    const bad = { requests: [{ name: "x", endpoint: "query", params: { state_alpha: "IA" } }] };
    const s = newSession();
    fixtures(SRC);
    await prepare(s, SRC, bad);
    const f = await failure(T.fetchData(s, { source: SRC, spec: bad }));
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("add at least a commodity_desc");
  });

  it("manual links are CSV with the key placeholder", async () => {
    const b: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec: SPEC }] });
    const q = b.items[0];
    expect(q.url).toContain("format=CSV");
    expect(q.url).toContain("key={API_KEY}");
    expect(q.url).toContain("commodity_desc=CORN");
    expect(q.filename.endsWith(".csv")).toBe(true);
  });
});
