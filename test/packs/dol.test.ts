/** dol: ported from tests/sources/dol/test_dol.py (same fixtures, specs and expected values). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, DataError, Response } from "../../src/core/http.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fakeKeys, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "dol", "fixtures");
const UTF = { description: "UI trust fund: Wyoming latest month, CA and TX in 2026, each state's latest month",
  requests: [
    { name: "wy", endpoint: "ui_trust_fund", params: { state: "WY", latest: true } },
    { name: "ca_tx", endpoint: "ui_trust_fund", params: { state: ["CA", "Texas"], start: "2026-01", end: "2026-09",
      fields: ["dep_ui_contributions_total", "c14", "dis_ui_benefits_total", "balance_close_utf"] } },
    { name: "latest", endpoint: "ui_trust_fund", params: { latest: true, fields: ["balance_close_utf"] } }] };
const UI = { description: "Weekly UI claims, national, first 10 weeks on file (documented preview)",
  requests: [{ name: "ui_national", endpoint: "query", params: { dataset: "eta_ui_national_weekly_claims", sort: "asc" }, max_rows: 10 }] };
const WHD = { description: "WHD enforcement cases in Texas, newest first",
  requests: [{ name: "whd_tx", endpoint: "query", params: { dataset: "whd_enforcement", state: "tx" } }] };

beforeAll(() => isolate());
afterEach(() => {
  delete process.env.DOL_API_KEY;
  vi.restoreAllMocks();
});

const pack = () => load("dol");
const adapter = async (): Promise<any> => (await pack()).adapter;

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures("dol");
  await prepare(s, "dol", spec);
  return failure(T.fetchData(s, { source: "dol", spec }));
}

describe("dol", () => {
  it("a data query needs a key; without one it is key_missing", async () => {
    const ad = await adapter();
    expect(ad.keyOnlyNeeds(WHD).length).toBe(1);
    const f = await fetchFail(WHD);
    expect(f.code).toBe("key_missing");
    expect(f.manual_bundle).toBeTruthy();
  });

  it("the catalog and field dictionary are keyless (api route)", async () => {
    const s = newSession();
    const r = await fetchOk(s, "dol", { requests: [{ name: "catalog", endpoint: "datasets", params: {} },
      { name: "ui_fields", endpoint: "dataset_info", params: { dataset_id: "eta_ui_national_weekly_claims" } }] });
    expect(r.summary.route).toBe("api");
    const cat = csv(s, "dol", "catalog");
    expect(cat.length).toBe(45);
    expect(cat.map((c) => c.api_url)).toContain("ui_state_weekly_claims");
    const fields = Object.fromEntries(csv(s, "dol", "ui_fields").map((f) => [f.column_name, f.column_desc]));
    expect(fields.c5).toContain("Seasonally adjusted count of total initial claims");
  });

  it("fetches the documented preview with a key", async () => {
    await fakeKeys("dol");
    const s = newSession();
    const r = await fetchOk(s, "dol", UI);
    const rows = csv(s, "dol", "ui_national");
    expect(rows.length).toBe(10);
    expect([rows[0].rptdate, rows[0].c4]).toEqual(["1967-01-07", "346000"]);
    expect(r.notes.some((n: string) => n.includes("c5 = Seasonally adjusted count of total initial claims"))).toBe(true);
  });

  it("keeps the API's order when sort_by is empty", async () => {
    await fakeKeys("dol");
    const s = newSession();
    await fetchOk(s, "dol", { requests: [{ name: "osha", endpoint: "query", params: { dataset: "OSHA/inspection", sort_by: "" }, max_rows: 10 }] });
    const rows = csv(s, "dol", "osha");
    expect(rows[0].estab_name).toBe("CHRISTMAS TREE SHOPS");
    expect(rows[0].site_state).toBe("NH");
  });

  it("builds filter_object and a case-tolerant search", async () => {
    const spec = { requests: [{ name: "amazon", endpoint: "query", params: { dataset: "osha_inspection", state: "ca",
      search: { estab_name: "Amazon" }, filters: { insp_type: ["A", "B"], open_date: { gt: "2024-01-01" } } }, max_rows: 2000 }] };
    const p = await pack();
    const items = p.adapter!.manualItems!(spec, p);
    expect(items.length).toBe(2); // two pages of 1,000
    const q = new URL(items[1].url.replace("{API_KEY}", "k")).searchParams;
    expect([q.get("limit"), q.get("offset"), q.get("sort_by"), q.get("sort")]).toEqual(["1000", "1000", "open_date", "desc"]);
    const conds = JSON.parse(q.get("filter_object")!).and;
    expect(conds).toContainEqual({ field: "insp_type", operator: "in", value: ["A", "B"] });
    expect(conds).toContainEqual({ field: "open_date", operator: "gt", value: "2024-01-01" });
    expect(conds).toContainEqual({ field: "site_state", operator: "eq", value: "CA" });
    const like = conds.find((c: any) => "or" in c).or;
    expect(like.map((c: any) => c.value)).toEqual(["%Amazon%", "%AMAZON%", "%amazon%"]);
    expect(items[0].url.startsWith("https://apiprod.dol.gov/v4/get/OSHA/inspection/json?")).toBe(true);
    expect(items[0].needs_key).toBe(true);
  });

  it("bad specs are invalid_request", async () => {
    expect((await fetchFail({ requests: [{ name: "x", endpoint: "query", params: { dataset: "nope" } }] })).code).toBe("invalid_request");
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "query", params: { dataset: "osha_violation", state: "TX" } }] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("state");
  });

  it("unknown field names are refused from the keyless field dictionary", async () => {
    // r007 (dataset 10334) is keyless: a filter, search or sort on a field the dataset lacks is refused before any data
    // request. checkSpec is synchronous here, so the dictionary is read by fetch (with a key); after that, the same
    // spec is refused without a key too.
    const bad: any = { requests: [{ name: "x", endpoint: "query", params: { dataset: "osha_inspection", state: "NH",
      filters: { site_district: "NORTH", insp_type: "B" }, search: { establishment: "acme" } } }] };
    await fakeKeys("dol");
    let f = await fetchFail(bad);
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("'site_district'");
    expect(f.message).toContain("'establishment'");
    expect(f.message.split("its fields")[0]).not.toContain("'insp_type'");
    expect(f.message).toContain("site_city"); // the real fields are listed
    delete process.env.DOL_API_KEY;
    f = await fetchFail(bad);
    expect(f.code).toBe("invalid_request");
    bad.requests[0].check_fields = false; // the escape when the dictionary is incomplete
    expect((await fetchFail(bad)).code).toBe("key_missing");
    const good = { requests: [{ name: "x", endpoint: "query", params: { dataset: "osha_inspection", state: "NH", filters: { site_city: "KEENE" } } }] };
    f = await fetchFail(good);
    expect(f.code).toBe("key_missing");
    expect(f.manual_bundle).toBeTruthy();
  });

  // ------------------------------------------------------------------ OUI unemployment insurance files (keyless)
  it("trust fund files need no key; a mixed spec needs it for the query only", async () => {
    const ad = await adapter();
    expect(ad.keyOnlyNeeds(UTF)).toEqual([]);
    const needs = ad.keyOnlyNeeds({ requests: [...UTF.requests, ...WHD.requests] });
    expect(needs[0]).toContain("whd_tx");
    expect(needs[0]).not.toContain("wy");
  });

  it("fetches the trust fund file", async () => {
    const s = newSession();
    const r = await fetchOk(s, "dol", UTF);
    expect(r.summary.route).toBe("api");
    const wy = csv(s, "dol", "wy");
    expect(wy.length).toBe(1);
    expect(Object.keys(wy[0]).length).toBe(136); // st, rptdate and the 134 coded columns, renamed
    expect([wy[0].st, wy[0].rptdate, wy[0].balance_close_utf, wy[0].balance_close_total, wy[0].dep_ui_contributions_total,
      wy[0].dis_ui_benefits_total]).toEqual(["WY", "2026-09-30", "586148120.75", "589297877.79", "871553.05", "3111454.15"]);
    expect(Object.keys(wy[0]).filter((c) => /^c\d+$/.test(c))).toEqual([]);
    const ca = csv(s, "dol", "ca_tx");
    expect(Object.keys(ca[0])).toEqual(["st", "rptdate", "dep_ui_contributions_total", "dep_treasury_interest_utf",
      "dis_ui_benefits_total", "balance_close_utf"]);
    expect(new Set(ca.map((x) => x.st))).toEqual(new Set(["CA", "TX"])); // "Texas" resolved to TX
    expect(ca.map((x) => x.rptdate).sort()[0]).toBe("2026-01-31");
    expect(ca.filter((x) => x.st === "CA" && x.rptdate === "2026-06-30").map((x) => x.balance_close_utf)).toEqual(["18308724.16"]);
    const latest = Object.fromEntries(csv(s, "dol", "latest").map((x) => [x.st, x.rptdate]));
    expect(latest).toEqual({ AK: "1979-03-31", CA: "2026-08-31", TX: "2026-08-31", WY: "2026-09-30", VT: "2026-06-30", PR: "2026-06-30" });
    expect(r.notes.some((n: string) => n.includes("have not reported it yet") && n.includes("VT 2026-06"))).toBe(true);
    expect(r.notes.some((n: string) => n.includes("balance_close_utf (c87)"))).toBe(true);
  });

  it("the identities hold on the renamed columns", async () => {
    const s = newSession();
    await fetchOk(s, "dol", { requests: [{ name: "tx", endpoint: "ui_trust_fund", params: { state: "TX" } }] });
    for (const x of csv(s, "dol", "tx")) {
      const f = (k: string) => Number(x[k] || 0);
      for (const a of ["total", "clearing", "utf", "bpa"]) {
        expect(f(`balance_close_${a}`)).toBeCloseTo(f(`balance_forward_${a}`) + f(`deposits_${a}`) - f(`disbursements_${a}`), 1);
      }
    }
  });

  it("reads the UI Data Summary workbook", async () => {
    const s = newSession();
    const r = await fetchOk(s, "dol", { requests: [{ name: "fin", endpoint: "ui_data_summary", params: {} },
      { name: "solv", endpoint: "ui_data_summary", params: { sheet: "Wage and Tax Rate" } }] });
    const fin = Object.fromEntries(csv(s, "dol", "fin").map((x) => [x.st, x]));
    expect(Object.keys(fin).length).toBe(54); // 53 jurisdictions and the United States
    const ca = fin.CA;
    expect([ca.cyq, ca.quarter_end, ca.tf_balance_thousands, ca.loan_balance_thousands, ca.net_trust_fund_balance_thousands])
      .toEqual(["2026.2", "2026-06-30", "18309", "18722060", "-18703751"]);
    expect([fin.AZ.state, fin.AZ.note]).toEqual(["Arizona", "Indicates states missing some monthly revenue reports."]);
    expect(fin.AZ.revenues_thousands).toBe("319139.6"); // stored 319139.59999999998
    expect(fin.US.state).toBe("United States");
    const solv = Object.fromEntries(csv(s, "dol", "solv").map((x) => [x.st, x]));
    expect(solv.WY.cyq).toBe("2025.4"); // this sheet lags two quarters
    expect([solv.WY.ahcm, solv.WY.hcm, solv.AL.tax_rate_total_wages]).toEqual(["2.43", "2.13", "0.07"]);
    expect(solv.CA.ahcm).toBe(""); // NA for a borrowing state
    expect(r.notes.some((n: string) => n.includes("non-Title XII"))).toBe(true);
  });

  it("trust fund: manual link without a key, and ingest", async () => {
    const p = await pack();
    const items = p.adapter!.manualItems!(UTF, p);
    expect(new Set(items.map((i: any) => i.url))).toEqual(new Set(["https://oui.doleta.gov/unemploy/csv/ar2112.csv"]));
    expect(items.some((i: any) => i.needs_key)).toBe(false);
    const spec = { requests: [{ name: "wy", endpoint: "ui_trust_fund", params: { state: "WY", latest: true } }] };
    const s = newSession();
    await prepare(s, "dol", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "dol-up-"));
    fs.copyFileSync(path.join(FX, "trimmed_ar2112.csv"), path.join(up, "ar2112.csv"));
    await T.ingest(s, { source: "dol", spec, files: [up] });
    expect(csv(s, "dol", "wy")[0].balance_close_utf).toBe("586148120.75");
  });

  it("trust fund bad specs are invalid_request", async () => {
    for (const [params, word] of [[{ state: "Atlantis" }, "unknown state"], [{ start: "June 2026" }, "YYYY-MM"],
      [{ fields: ["trust_fund_balance"] }, "balance_close_utf"]] as [any, string][]) {
      const f = await fetchFail({ requests: [{ name: "x", endpoint: "ui_trust_fund", params }] });
      expect(f.code).toBe("invalid_request");
      expect(f.message).toContain(word);
    }
    expect((await fetchFail({ requests: [{ name: "x", endpoint: "ui_data_summary", params: { sheet: "Loans" } }] })).code)
      .toBe("invalid_request");
  });

  it("the trust fund client sends no key and rejects an HTML page", async () => {
    const ad = await adapter();
    expect(() => ad.tidyOui({ name: "x", endpoint: "ui_trust_fund" }, { columns: {} }, {}, Buffer.from("<html>Error</html>"), "ar2112.csv"))
      .toThrow(/expected the ETA 2112 CSV/);
    try {
      ad.tidyOui({ name: "x", endpoint: "ui_trust_fund" }, { columns: {} }, {}, Buffer.from("<html>Error</html>"), "ar2112.csv");
    } catch (e) {
      expect(e).toBeInstanceOf(DataError);
    }
    const seen: any = {};
    vi.spyOn(Client.prototype, "request").mockImplementation(async function (this: Client, _m: string, p = "") {
      Object.assign(seen, { base: this.base, auth: this.auth, path: p });
      return new Response(200, {}, Buffer.from('"st","rptdate","c87"\n"WY","2026-09-30",5\n'), p);
    });
    const fake: any = { policy: { limits: { rps: 3, burst: 6 } } };
    const [rows] = await ad.fetchOui(fake, { name: "x", endpoint: "ui_trust_fund" },
      { path: "https://oui.doleta.gov/unemploy/csv/ar2112.csv", columns: { c87: "balance_close_utf" } }, {}, new Map());
    expect(seen.auth).toEqual({}); // no credentials on the oui.doleta.gov client
    expect(seen.base).toBe("https://oui.doleta.gov");
    expect(rows).toEqual([{ st: "WY", rptdate: "2026-09-30", balance_close_utf: "5" }]);
  });

  it("searches the catalog", async () => {
    const s = newSession();
    const r: any = await T.requestSchema(s, { source: "dol", search: "unemployment insurance weekly claims state" });
    expect(r.results[0].id).toBe("ETA/ui_state_weekly_claims");
  });
});
