/**
 * usda-fooddata pack, ported from tests/sources/usda-fooddata/test_usda_fooddata.py. Fixtures were recorded live
 * from api.nal.usda.gov on 2026-10-20 (the key was dropped from the recorded URLs; responses hold no key).
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SRC = "usda-fooddata";
const SPEC = { description: "Cheddar cheese (Foundation) nutrients; energy, protein and fat of two cheeses",
  requests: [
    { name: "cheddar_foundation", endpoint: "search", params: { query: "cheddar", dataType: ["Foundation"] } },
    { name: "two_cheeses", endpoint: "foods", params: { fdcIds: [328637, 169901], nutrients: "203,204,208" } }] };

beforeAll(() => isolate());

async function problems(spec: any): Promise<string> {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  const f = await failure(T.fetchData(s, { source: SRC, spec }));
  expect(f.code).toBe("invalid_request");
  return f.message;
}

describe("usda-fooddata", () => {
  it("keyless (DEMO_KEY) is the api route", async () => {
    const p = await load(SRC);
    expect(gr.checkSpec(p, SPEC)).toEqual([]);
    expect(p.policy.auth.required).toBe("optional");
    expect((await fetchOk(newSession(), SRC, SPEC)).summary.route).toBe("api");
  });

  it("long layout", async () => {
    const s = newSession();
    await fetchOk(s, SRC, SPEC);
    const rows = csv(s, SRC, "cheddar_foundation");
    expect(rows.length).toBe(105);
    const energy = rows.filter((x) => x.nutrient_number === "208");
    expect(energy[0].value).toBe("408");
    expect(energy[0].unit).toBe("KCAL");
    expect(rows.filter((x) => x.nutrient_number === "268")[0].unit).toBe("kJ"); // Energy appears twice, in two units
    const two = csv(s, SRC, "two_cheeses");
    const prot = Object.fromEntries(two.filter((x) => x.nutrient_number === "203").map((x) => [x.fdcId, x.value]));
    expect(prot["328637"]).toBe("23.3");
    expect(prot["169901"]).toBe("16.7");
  });

  it("foods layout", async () => {
    const s = newSession();
    await fetchOk(s, SRC, { ...SPEC, requests: [{ ...SPEC.requests[1], layout: "foods" }] });
    const rows = csv(s, SRC, "two_cheeses");
    expect(rows.length).toBe(2);
    expect(rows[0]).toHaveProperty("foodNutrients");
  });

  it("too many ids is invalid_request", async () => {
    await problems({ requests: [{ name: "x", endpoint: "foods", params: { fdcIds: Array.from({ length: 21 }, (_, i) => i) } }] });
    // the API silently drops ids past 50 (live 2026-10-22), so a long comma-separated list must fail too
    const m = await problems({ requests: [{ name: "y", endpoint: "foods",
      params: { fdcIds: Array.from({ length: 55 }, (_, i) => String(1000 + i)).join(",") } }] });
    expect(m).toContain("split");
  });

  it("manual links carry DEMO_KEY once", async () => {
    const b: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec: SPEC }] });
    const urls = b.items.map((i: any) => i.url);
    expect(urls.every((u: string) => u.split("api_key=DEMO_KEY").length === 2)).toBe(true);
  });

  it("a field query is sent as written, and documented", async () => {
    // FDC search takes Lucene-style field queries (live 2026-10-28): the pack must not alter them
    const q = '+foodCategory:"Cheese" +ingredients:"annatto"';
    const p = await load(SRC);
    const items = gr.manualItems(p, { requests: [{ name: "cat", endpoint: "search", params: { query: q, dataType: ["Branded"] } }] });
    expect(items[0].url).toContain("query=%2BfoodCategory%3A%22Cheese%22+%2Bingredients%3A%22annatto%22");
    const doc = fs.readFileSync(path.join(p.dir, "source.md"), "utf8");
    expect(doc).toContain('foodCategory:"Cheese"');
    expect(doc).toContain("branded_food_category"); // where the category names are listed
  });
});
