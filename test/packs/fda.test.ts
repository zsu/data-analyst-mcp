/** fda: ported from tests/sources/fda/test_fda.py (same fixtures, same values). */
import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const SRC = "fda";
const SPEC = { description: "Metformin adverse-event reports received in 2024: top reactions; Class I food recalls reported in January 2024",
  requests: [
    { name: "metformin_reactions_2024", endpoint: "count",
      params: { dataset: "drug_event",
        search: 'patient.drug.openfda.generic_name.exact:"METFORMIN HYDROCHLORIDE" AND receivedate:[20240101 TO 20241231]',
        count: "patient.reaction.reactionmeddrapt.exact", limit: 10 } },
    { name: "food_recalls_class1", endpoint: "search", max_rows: 5,
      params: { dataset: "food_enforcement", search: 'classification:"Class I" AND report_date:[20240101 TO 20240131]',
        sort: "report_date:asc" } }] };

const NONE = { description: "no match", requests: [{ name: "none", endpoint: "search", max_rows: 5,
  params: { dataset: "drug_enforcement", search: 'recalling_firm:"ZZQXNOFIRM"' } }] };

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  return failure(T.fetchData(s, { source: SRC, spec }));
}

async function instructions(spec: any): Promise<string> {
  const r: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec }] });
  return fs.readFileSync(r.instructions, "utf8");
}

describe("fda", () => {
  it("fetches by the api route without a key", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.summary.route).toBe("api");
    expect((await T.checkKey(s, { source: SRC })).key.required).toBe("optional");
    const rx = csv(s, SRC, "metformin_reactions_2024");
    expect(rx.length).toBe(10);
    expect(rx[0].term).toBe("DIARRHOEA");
    expect(rx[0].count).toBe("502");
    const fr = csv(s, SRC, "food_recalls_class1");
    expect(fr.length).toBe(5);
    expect(fr[0].classification).toBe("Class I");
    expect(fr[0].recall_number).toBe("F-0690-2024");
    expect(r.notes.some((n: string) => n.includes("66 in total"))).toBe(true);
  });

  it("no match is a clear error", async () => {
    const f = await fetchFail(NONE);
    expect(f.message).toContain("no records matching");
  });

  it("no match with allow_empty is an empty table", async () => {
    const spec = { ...NONE, requests: [{ ...NONE.requests[0], allow_empty: true }] };
    const r = await fetchOk(newSession(), SRC, spec);
    expect(["ok", "partial"]).toContain(r.status);
  });

  it("a keyless count asks for 999 terms and says when cut", async () => {
    const spec = { requests: [
      { name: "device_generic_jan2024", endpoint: "count",
        params: { dataset: "device_event", search: "date_received:[20240101 TO 20240131]", count: "device.generic_name.exact" } },
      { name: "shortage_categories", endpoint: "count", params: { dataset: "drug_shortages", count: "therapeutic_category" } }] };
    const s = newSession();
    const r = await fetchOk(s, SRC, spec);
    expect(r.status).toBe("partial");
    expect(r.notes.some((n: string) => n.includes("device_generic_jan2024: stopped at 999 terms"))).toBe(true);
    expect(csv(s, SRC, "device_generic_jan2024").length).toBe(999);
    const cats = csv(s, SRC, "shortage_categories");
    expect([cats[0].term, cats[0].count]).toEqual(["Anesthesia", "370"]);
    expect(r.notes.some((n: string) => n.includes("shortage_categories") && n.includes("stopped at"))).toBe(false);
    const text = await instructions(spec);
    expect(text).toContain("limit=999");
    expect(text).not.toContain("limit=1000");
  });

  it("a date count is not cut at 1000", async () => {
    const spec = { requests: [{ name: "daily", endpoint: "count", params: { dataset: "drug_event", count: "receivedate",
      search: 'receivedate:[20200101 TO 20251231] AND patient.drug.openfda.generic_name:"metformin hydrochloride"' } }] };
    const s = newSession();
    const r = await fetchOk(s, SRC, spec);
    expect(r.status).toBe("ok");
    expect(csv(s, SRC, "daily").length).toBe(2123);
  });

  it("a count 404 reports openFDA's message", async () => {
    const f = await fetchFail({ requests: [{ name: "shortage_categories_exact", endpoint: "count",
      params: { dataset: "drug_shortages", count: "therapeutic_category.exact" } }] });
    expect(f.message).toContain("Nothing to count");
    expect(f.message).not.toContain("no records matching");
  });

  it("an unknown dataset, a large skip and a large count limit are invalid_request", async () => {
    for (const bad of [
      { requests: [{ name: "x", endpoint: "search", params: { dataset: "drug/events" } }] },
      { requests: [{ name: "x", endpoint: "search", params: { dataset: "drug_event", skip: 30000 } }] },
      { requests: [{ name: "x", endpoint: "count", params: { dataset: "drug_event", count: "serious", limit: 5000 } }] }]) {
      expect((await fetchFail(bad)).code).toBe("invalid_request");
    }
  });

  it("manual links use plain paths", async () => {
    const text = await instructions(SPEC);
    expect(text).toContain("https://api.fda.gov/drug/event.json?");
    expect(text).not.toContain("%2F");
  });
});
