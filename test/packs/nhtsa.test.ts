/** NHTSA: ported from tests/sources/nhtsa/test_nhtsa.py (same fixtures and values). */
import { beforeAll, describe, expect, it } from "vitest";
import ad from "../../src/adapters/nhtsa.js";
import * as gr from "../../src/core/generic-rest.js";
import { DataError } from "../../src/core/http.js";
import { load } from "../../src/core/packs.js";
import { parsePyJson } from "../../src/core/py.js";
import * as T from "../../src/tools.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

// Fixtures recorded live from api.nhtsa.gov and vpic.nhtsa.dot.gov on 2026-10-20.
const SPEC = { description: "2019 Honda Civic: recalls, NCAP rating, VIN decode",
  requests: [{ name: "civic_2019_recalls", endpoint: "recalls_by_vehicle", params: { make: "honda", model: "civic", modelYear: 2019 } },
    { name: "civic_2019_sedan_rating", endpoint: "ratings_detail", params: { vehicleId: 14009 } },
    { name: "vin", endpoint: "vin_decode", params: { vin: "1HGCM82633A123456" } },
    { name: "odi", endpoint: "complaint_odi", params: { odinumber: 11675912 } }] };

const problems = async (spec: any) => gr.checkSpec(await load("nhtsa"), spec);
const fetchWith = ad.fetchWith as (c: any, spec: any, pack: any) => Promise<[Record<string, any[]>, string[]]>;

/** A response the generic code can read (body, json, text). */
function resp(d: unknown) {
  const body = Buffer.from(JSON.stringify(d));
  return { status: 200, body, json: () => parsePyJson(body.toString("utf8")), text: () => body.toString("utf8") };
}

describe("nhtsa", () => {
  it("is valid and takes the api route", async () => {
    expect(await problems(SPEC)).toEqual([]);
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "nhtsa", SPEC);
    expect(r.summary.route).toBe("api");
    const rec = csv(s, "nhtsa", "civic_2019_recalls");
    expect(rec.length).toBe(4);
    expect(rec[0].NHTSACampaignNumber).toBe("20V314000");
    expect(rec[0].ReportReceivedDate).toBe("28/05/2020"); // published DD/MM/YYYY kept
    expect(rec[0].ReportReceivedDate_iso).toBe("2020-05-28"); // added column
    const rating = csv(s, "nhtsa", "civic_2019_sedan_rating")[0];
    expect(rating.OverallRating).toBe("5");
    expect(rating.RolloverPossibility).toBe("0.095");
    const vin = csv(s, "nhtsa", "vin")[0];
    expect(vin.Make).toBe("HONDA");
    expect(vin.ModelYear).toBe("2003");
    expect(csv(s, "nhtsa", "odi")[0].dateComplaintFiled_iso).toBe("2025-07-24"); // complaints are MM/DD/YYYY
  });

  it("a missing param is a spec problem", async () => {
    expect((await problems({ requests: [{ name: "x", endpoint: "recalls_by_vehicle", params: { make: "honda", model: "civic" } }] })).length)
      .toBeGreaterThan(0);
  });

  it("a year range is a spec problem", async () => {
    expect((await problems({ requests: [{ name: "x", endpoint: "recalls_by_vehicle",
      params: { make: "honda", model: "civic", modelYear: "2018-2020" } }] })).length).toBeGreaterThan(0);
  });

  it("fetches variants on request; an unmatched name is a note", async () => {
    // Fixtures r005-r013 recorded live 2026-10-28 (r005/r009: the full model lists, max=10000).
    const base = { make: "honda", model: "accord", modelYear: 2023 };
    const spec: any = { description: "Recalls for a 2023 sedan; a misspelled model",
      requests: [{ name: "sedan_2023", endpoint: "recalls_by_vehicle", params: base },
        { name: "typo", endpoint: "recalls_by_vehicle", params: { make: "honda", model: "zzqx", modelYear: 2023 } },
        { name: "odi", endpoint: "complaint_odi", params: { odinumber: 11675912 } }] };
    let s = newSession();
    let r = await fetchOk(s, "nhtsa", spec);
    expect(new Set(csv(s, "nhtsa", "sedan_2023").map((x) => x.model_requested))).toEqual(new Set(["accord"]));
    expect(r.notes.some((n: string) => n.startsWith("sedan_2023: NHTSA also lists ACCORD HYBRID, ACCORD SEDAN"))).toBe(true);
    expect(csv(s, "nhtsa", "typo")).toEqual([]);
    expect(r.notes.some((n: string) => n.startsWith("typo: no vehicle matched"))).toBe(true);
    expect(csv(s, "nhtsa", "odi").length).toBeGreaterThan(0);
    spec.requests[0].params = { ...base, variants: true };
    s = newSession();
    r = await fetchOk(s, "nhtsa", spec);
    const rows = csv(s, "nhtsa", "sedan_2023");
    const camp = rows.map((x) => x.NHTSACampaignNumber);
    expect(camp.length).toBe(new Set(camp).size); // a shared campaign is kept once
    expect(rows.map((x) => x.model_requested)).toContain("ACCORD HYBRID");
    expect(r.notes.some((n: string) => n.includes("ACCORD HYBRID (4)") && n.includes("no record under: ACCORD SEDAN"))).toBe(true);
  });

  it("asks for the model list in full", async () => {
    const pack = await load("nhtsa");
    const sent: any[] = [];
    const client = { request: async (_m: string, p: string, q: any) => {
      if (p.includes("products")) {
        sent.push({ ...q });
        const names = [...Array.from({ length: 19 }, (_, i) => `OTHER ${i}`), "WREN", ...(q.max ? ["SPARROW", "WREN HYBRID"] : [])];
        return resp({ results: names.map((n) => ({ model: n })) });
      }
      return resp({ Count: 1, results: [{ NHTSACampaignNumber: `99V00${q.model.length}000` }] });
    } };
    const spec = { requests: [{ name: "w", endpoint: "recalls_by_vehicle", params: { make: "x", model: "wren", modelYear: 2023, variants: true } }] };
    const [tables] = await fetchWith(client, spec, pack);
    expect(sent[0].max).toBe(10000);
    expect(new Set(tables.w.map((r) => r.model_requested))).toEqual(new Set(["wren", "WREN HYBRID"]));
    for (const name of ["products_models", "products_model_years"]) {
      const [, params] = gr.resolve(pack, { name: "m", endpoint: name, params: { modelYear: 2023, make: "x", issueType: "c" } });
      expect(params.max).toBe(10000);
    }
  });

  it("a variant's 5xx marks the table incomplete", async () => {
    const pack = await load("nhtsa");
    const client = (up: boolean) => ({ request: async (_m: string, p: string, q: any) => {
      if (p.includes("products")) return resp({ results: [{ model: "WREN" }, { model: "WREN HYBRID" }, { model: "WREN SPORT" }] });
      if (q.model === "wren" && up) return resp({ Count: 1, results: [{ NHTSACampaignNumber: "99V001000" }] });
      throw new DataError("nhtsa: HTTP 503", "http", 503);
    } });
    const spec = { requests: [{ name: "w", endpoint: "recalls_by_vehicle", params: { make: "x", model: "wren", modelYear: 2023, variants: true } }] };
    const [tables, notes] = await fetchWith(client(true), spec, pack);
    expect(tables.w.length).toBe(1);
    expect(notes.some((n) => n.startsWith("w" + gr.INCOMPLETE) && n.includes("WREN HYBRID (HTTP 503)"))).toBe(true);
    expect(notes.some((n) => n.includes("no vehicle matched"))).toBe(false);
    expect(notes.some((n) => n.includes("NHTSA also lists WREN SPORT"))).toBe(true); // a distinct model: not merged
    await expect(fetchWith(client(false), spec, pack)).rejects.toBeInstanceOf(DataError);
  });

  it("prefixed names (unit)", () => {
    const prefixed = ad.prefixed as (b: string, l: string[]) => [string[], string[]];
    const forms = ad.forms as (n: string, r: boolean) => string[];
    const listed = ["SPARROW", "SPARROW HYBRID", "SPARROWHAWK", "SPARROW (CREW CAB) EV", "sparrow hybrid", "SPARROW SPORT",
      "SPARROW 4DR AWD", "WREN"];
    expect(prefixed("sparrow", listed)).toEqual([["SPARROW HYBRID", "SPARROW (CREW CAB) EV", "SPARROW 4DR AWD"], ["SPARROW SPORT"]]);
    expect(forms("SPARROW (CREW CAB) EV", true)).toEqual(["SPARROW (CREW CAB) EV", "SPARROW EV"]);
    expect(forms("SPARROW (CREW CAB) EV", false)).toEqual(["SPARROW (CREW CAB) EV"]);
  });

  it("car seat stations follow offset paging", async () => {
    const ep = (await load("nhtsa")).endpoints.endpoints.car_seat_stations_state;
    const sent: any[] = [];
    const client: any = { request: async (_m: string, _p: string, q: any) => {
      sent.push(q.offset);
      const off = Number(q.offset || 0);
      const n = Math.max(0, Math.min(100, 230 - off));
      return resp({ Count: n, Results: Array.from({ length: n }, (_, i) => ({ Organization: `o${off + i}` })) });
    } };
    const [rows, meta] = await gr.fetchRequest(client, ep, { state: "ZZ" });
    expect(rows.length).toBe(230);
    expect(sent).toEqual([0, 100, 200]);
    expect(meta.truncated).toBe(false);
  });

  it("paging stops when a page repeats", async () => {
    const ep = (await load("nhtsa")).endpoints.endpoints.car_seat_stations_zip;
    const sent: any[] = [];
    const client: any = { request: async (_m: string, _p: string, q: any) => {
      sent.push(q.offset);
      return resp({ Count: 100, Results: Array.from({ length: 100 }, (_, i) => ({ Organization: `o${i}` })) });
    } };
    const [rows, meta] = await gr.fetchRequest(client, ep, { zip: "00000" });
    expect([rows.length, sent]).toEqual([100, [0, 100]]);
    expect(meta.truncated && meta.repeated_page).toBe(true);
  });

  it("manual bundle links the vPIC host", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "nhtsa", spec: SPEC }] });
    const urls: string[] = r.items.map((i: any) => i.url);
    expect(urls).toContain("https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1HGCM82633A123456?format=json");
    expect(urls.some((u) => u.startsWith("https://api.nhtsa.gov/recalls/recallsByVehicle?"))).toBe(true);
  });
});
