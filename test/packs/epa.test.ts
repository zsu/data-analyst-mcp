/** EPA (Envirofacts and ECHO): ported from tests/sources/epa/test_epa.py (same fixtures and values). */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/epa.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

// Fixtures recorded live from data.epa.gov/dmapservice and echodata.epa.gov on 2026-10-20
// (ECHO: get_facilities / get_case_info, then get_qid with the QueryID they returned).
const SPEC = { description: "Vermont: GHGRP emitters 2022, NPL Superfund sites, major air facilities, CAA cases",
  requests: [
    { name: "vt_ghg_2022", endpoint: "envirofacts",
      params: { table: "ghg_emitters", filters: [["state", "equals", "VT"], ["year", "equals", 2022]] }, max_rows: 3 },
    { name: "vt_npl", endpoint: "envirofacts",
      params: { table: "superfund_sites", filters: { fk_ref_state_code: "VT", npl_status_code: "F" } }, max_rows: 3 },
    { name: "vt_major_air", endpoint: "echo_facilities", params: { program: "air", p_st: "VT", p_maj: "Y" } },
    { name: "vt_caa_cases", endpoint: "echo_cases", params: { p_state: "VT", p_law: "CAA" }, max_rows: 3 }] };

const problems = async (spec: any) => gr.checkSpec(await load("epa"), spec);

describe("epa", () => {
  it("takes the api route", async () => {
    expect((await problems(SPEC))).toEqual([]);
    expect((await fetchOk(newSession(), "epa", SPEC)).summary.route).toBe("api");
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "epa", SPEC);
    expect(["ok", "partial"]).toContain(r.status);
    const ghg = csv(s, "epa", "vt_ghg_2022");
    expect(ghg[0].facility_name).toBe("Omya Inc. (Verpol)");
    expect(ghg[0].co2e_emission).toBe("16.688");
    const npl = csv(s, "epa", "vt_npl");
    expect(npl[0].name).toBe("PINE STREET CANAL");
    expect(npl[0].npl_status_code).toBe("F");
    const air = csv(s, "epa", "vt_major_air");
    expect(air.length).toBe(17);
    expect(air.every((row) => row.AIRState === "VT")).toBe(true);
    const cases = csv(s, "epa", "vt_caa_cases");
    expect(cases[0].CaseNumber).toBe("01-1991-0008");
    expect(cases[0].FedPenalty).toBe("$40,000.00"); // published text kept
    expect(cases[0].FedPenalty_usd).toBe("40000.00"); // added column
    expect(cases[0].DateFiled_iso).toBe("1991-05-01");
    expect(r.notes.some((n: string) => n.includes("ECHO matched 99 rows"))).toBe(true);
  });

  it("ECHO qcolumns reach the row pages", async () => {
    // r007-r008 recorded live on 2026-10-28: get_qid returns its ~60 default columns unless it is given
    // qcolumns too, so the column selection must be sent with every page, not only with the search
    const spec = { requests: [{ name: "vt_air_cols", endpoint: "echo_facilities",
      params: { program: "air", p_st: "VT", p_maj: "Y", qcolumns: "1,2,4,5" } }] };
    const s = newSession();
    await fetchOk(s, "epa", spec);
    const rows = csv(s, "epa", "vt_air_cols");
    expect(rows.length).toBe(17);
    expect(rows[0]).toHaveProperty("RegistryID");
    expect(rows[0]).not.toHaveProperty("AIRStreet"); // id 3 was not asked for
    expect(Object.keys(rows[0]).length).toBeLessThan(20);
  });

  it("case searches reject p_st", async () => {
    const probs = await problems({ requests: [{ name: "x", endpoint: "echo_cases", params: { p_st: "VT" } }] });
    expect(probs.length).toBeGreaterThan(0);
    expect(probs.join("; ")).toContain("p_state");
  });

  it("params ECHO ignores are refused", async () => {
    // ECHO accepts these without filtering (live 2026-10): each would return unfiltered rows.
    const cases: [string, Record<string, string>, string][] = [
      ["echo_cases", { p_state: "KS", p_fy: "2019" }, "p_milestone_fy"],
      ["echo_cases", { p_state: "KS", p_crim: "Y" }, "p_civil_criminal_indicator"],
      ["echo_cases", { p_state: "KS", p_name: "ACME" }, "CaseName"],
      ["echo_facilities", { program: "rcra", p_st: "KS", p_naics: "3251" }, "p_ncs"],
      ["echo_facilities", { program: "air", p_st: "KS", p_co: "Sedgwick" }, "p_fips"]];
    for (const [ep, params, hint] of cases) {
      const probs = await problems({ requests: [{ name: "x", endpoint: ep, params }] });
      expect(probs.length, `${ep} ${JSON.stringify(params)}`).toBeGreaterThan(0);
      expect(probs.join("; ")).toContain(hint);
    }
    expect(await problems({ requests: [{ name: "x", endpoint: "echo_facilities",
      params: { program: "cwa", p_st: "KS", p_co: "Sedgwick", p_ncs: "3251" } }] })).toEqual([]);
    expect((await problems({ requests: [{ name: "x", endpoint: "echo_cases",
      params: { p_state: "KS", p_fed_penalty: "100000" } }] })).length).toBeGreaterThan(0);
  });

  it("a bad operator is a spec problem", async () => {
    const probs = await problems({ requests: [{ name: "x", endpoint: "envirofacts",
      params: { table: "ghg_emitters", filters: [["state", "eq", "VT"]] } }] });
    expect(probs.length).toBeGreaterThan(0);
  });

  it("manual bundle", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "epa", spec: SPEC }] });
    const items = r.items;
    expect(items[0].url).toBe("https://data.epa.gov/dmapservice/ghg.ghg_emitter_sector/state/equals/VT/year/equals/2022/1:5000/CSV");
    expect(items[2].url.startsWith("https://echodata.epa.gov/echo/air_rest_services.get_facilities?")).toBe(true);
    const raw = adapter.manualItems!(SPEC, await load("epa"));
    expect(raw[2].note).toContain("get_qid");
  });

  it("an ECHO error in a 200 answer", () => {
    const body = Buffer.from('{"Results":{"Error":{"ErrorMessage":"Queryset Limit would be exceeded"}}}');
    expect(adapter.checkError!(200, body)).toContain("Queryset Limit");
  });
});
