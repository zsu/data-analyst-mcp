/**
 * The packs that need only endpoints.json (no adapter): cdc, fema, medicaid, nyfed, va. Ported from
 * tests/sources/<id>/test_<id>.py, against the same fixtures and the same expected values.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

describe("cdc", () => {
  const SPEC = { description: "Leading causes of death, New York, 2017", requests: [{ name: "ny_causes_2017", endpoint: "query",
    params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'", $order: "deaths DESC" } }] };

  it("fetches and packages", async () => {
    const s = newSession();
    const r = await fetchOk(s, "cdc", SPEC);
    expect(r.status).toBe("ok");
    const rows = csv(s, "cdc", "ny_causes_2017");
    expect(rows[0].cause_name).toBe("All causes");
    expect(rows[0].deaths).toBe("155358");
    expect(fs.existsSync(path.join(s.workspace, "data", "cdc", "README.md"))).toBe(true);
    expect(r.citation.publisher).toContain("Centers for Disease Control");
    expect(r.requests[0].url).toMatch(/^https:\/\/data\.cdc\.gov\/resource\//);
    expect(r.summary.tables[0].preview_csv[0]).toContain("cause_name");
  });

  it("places_city is the current PLACES file (long format)", async () => {
    const s = newSession();
    const spec = { requests: [{ name: "places_place_obesity", endpoint: "query", params: { dataset: "places_city",
      $where: "stateabbr = 'VT' AND locationname = 'Burlington' AND measureid = 'OBESITY'" } }] };
    await fetchOk(s, "cdc", spec);
    const rows = csv(s, "cdc", "places_place_obesity");
    expect(rows[0]).toHaveProperty("measureid");
    expect(rows[0]).toHaveProperty("data_value");
    expect(rows[0]).not.toHaveProperty("obesity_crudeprev");
    expect(new Set(rows.map((x) => x.data_value_type))).toEqual(new Set(["Crude prevalence", "Age-adjusted prevalence"]));
  });

  it("weekly deaths: a backticked reserved word filters one granularity", async () => {
    const s = newSession();
    const spec = { requests: [{ name: "vt_deaths_by_year", endpoint: "query", params: { dataset: "weekly_deaths",
      $select: "`group`, year, state, total_deaths", $where: "`group` = 'By Year' AND state = 'Vermont'", $order: "year" } }] };
    await fetchOk(s, "cdc", spec);
    const rows = csv(s, "cdc", "vt_deaths_by_year");
    expect(new Set(rows.map((x) => x.group))).toEqual(new Set(["By Year"]));
    expect([rows[0].year, rows[0].total_deaths]).toEqual(["2020", "5983"]);
  });

  it("reuses an identical fetch", async () => {
    const s = newSession();
    await fetchOk(s, "cdc", SPEC);
    const r: any = await T.fetchData(s, { source: "cdc", spec: SPEC });
    expect(r.summary.route).toBe("reuse_existing");
  });

  it("an unknown endpoint is invalid_request", async () => {
    const s = newSession();
    fixtures("cdc");
    await T.sourceBrief(s, { source: "cdc" });
    const f = await failure(T.requestSchema(s, { source: "cdc", names: ["nope"] }));
    expect(f.code).toBe("invalid_request");
  });

  it("manual items carry every page link", async () => {
    const p = await load("cdc");
    const items = gr.manualItems(p, SPEC);
    expect(items[0].url).toMatch(/^https:\/\/data\.cdc\.gov\/resource\/.+\.json\?/);
  });
});

describe("fema", () => {
  const SPEC = { description: "Vermont FY2023 major disaster declarations; Vermont NFIP claims from the July 2023 flood",
    requests: [
      { name: "vt_dr_fy2023", endpoint: "disaster_declarations",
        params: { $filter: "state eq 'VT' and fyDeclared eq 2023 and declarationType eq 'DR'", $orderby: "id" }, max_rows: 3 },
      { name: "vt_claims_2023", endpoint: "nfip_claims", params: { $filter: "state eq 'VT' and yearOfLoss eq 2023",
        $select: "id,dateOfLoss,yearOfLoss,floodEvent,state,countyCode,ratedFloodZone,netBuildingPaymentAmount,netContentsPaymentAmount" },
        max_rows: 3 },
      { name: "regions_csv", endpoint: "query", params: { version: "v2", entity: "FemaRegions", $select: "region,name,city,state" }, max_rows: 3 }] };

  it("fetches and packages", async () => {
    const s = newSession();
    const r = await fetchOk(s, "fema", SPEC);
    expect(["ok", "partial"]).toContain(r.status);
    const dr = csv(s, "fema", "vt_dr_fy2023");
    expect(dr.length).toBe(3);
    expect([dr[0].femaDeclarationString, dr[0].designatedArea]).toEqual(["DR-4720-VT", "Addison (County)"]);
    const claims = csv(s, "fema", "vt_claims_2023");
    expect([claims[1].floodEvent, claims[1].netBuildingPaymentAmount]).toEqual(["Vermont/New York Flooding", "95493.9"]);
    expect(csv(s, "fema", "regions_csv")[0].city).toBe("Boston");
    expect(fs.readFileSync(path.join(s.workspace, "data", "fema", "README.md"), "utf8")).toContain("not endorsed by FEMA");
  });

  it("query needs its entity", async () => {
    const s = newSession();
    fixtures("fema");
    const spec = { requests: [{ name: "x", endpoint: "query", params: { version: "v2" } }] };
    await prepare(s, "fema", spec);
    expect((await failure(T.fetchData(s, { source: "fema", spec }))).code).toBe("invalid_request");
  });

  it("manual links page with $top", async () => {
    const items = gr.manualItems(await load("fema"), SPEC);
    expect(items[0].url.startsWith("https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?")).toBe(true);
    expect(items[0].url).toContain("%24top=10000");
  });
});

describe("medicaid", () => {
  const ENROLL_COLS = ["state_abbreviation", "reporting_period", "preliminary_or_updated", "final_report",
    "total_medicaid_and_chip_enrollment", "total_medicaid_enrollment", "total_chip_enrollment",
    "total_medicaid_and_chip_enrollment__footnotes"];
  const SPEC = { description: "Medicaid and CHIP enrollment July 2026, VT/NH 2026, Trulicity national Q4 2025, VT expansion spending",
    requests: [
      { name: "enroll_latest", endpoint: "query", params: { dataset: "enrollment", "conditions[0][property]": "reporting_period",
        "conditions[0][value]": "202607", ...Object.fromEntries(ENROLL_COLS.map((c, i) => [`properties[${i}]`, c])) } },
      { name: "vt_nh_2026", endpoint: "query", params: { dataset: "enrollment", "conditions[0][property]": "state_abbreviation",
        "conditions[0][operator]": "in", "conditions[0][value][0]": "VT", "conditions[0][value][1]": "NH",
        "conditions[1][property]": "reporting_period", "conditions[1][operator]": ">=", "conditions[1][value]": "202601",
        "conditions[2][property]": "preliminary_or_updated", "conditions[2][value]": "U",
        "sorts[0][property]": "reporting_period", "sorts[0][order]": "desc",
        "properties[0]": "state_abbreviation", "properties[1]": "reporting_period",
        "properties[2]": "preliminary_or_updated", "properties[3]": "total_medicaid_and_chip_enrollment" } },
      { name: "trulicity", endpoint: "query", params: { dataset: "sdud_2025", "conditions[0][property]": "state",
        "conditions[0][value]": "XX", "conditions[1][property]": "product_name", "conditions[1][operator]": "like",
        "conditions[1][value]": "TRULICITY%", "conditions[2][property]": "quarter", "conditions[2][value]": "4" } },
      { name: "vt_expansion", endpoint: "query", params: { dataset: "cms64_new_adult", "conditions[0][property]": "state",
        "conditions[0][value]": "Vermont" } },
      { name: "info", endpoint: "dataset_info", params: { dataset: "enrollment" } }] };

  it("fetches and packages", async () => {
    const s = newSession();
    const r = await fetchOk(s, "medicaid", SPEC);
    expect(r.status).toBe("ok");
    expect(r.notes).toEqual([]);
    const en = csv(s, "medicaid", "enroll_latest");
    expect(Object.keys(en[0])).toEqual(ENROLL_COLS);
    expect(en.length).toBe(51);
    expect(new Set(en.map((x) => x.preliminary_or_updated))).toEqual(new Set(["P"]));
    const sum = (k: string) => en.reduce((t, x) => t + Number(x[k]), 0);
    expect(sum("total_medicaid_and_chip_enrollment")).toBe(72946510);
    expect(sum("total_medicaid_enrollment")).toBe(65742057);
    expect(sum("total_chip_enrollment")).toBe(7204453);
    const vt = csv(s, "medicaid", "vt_nh_2026");
    expect(vt.length).toBe(12);
    expect([vt[1].state_abbreviation, vt[1].reporting_period, vt[1].total_medicaid_and_chip_enrollment]).toEqual(["VT", "202606", "146227"]);
    const tr = csv(s, "medicaid", "trulicity");
    expect(new Set(tr.map((x) => x.state))).toEqual(new Set(["XX"]));
    expect(tr[0].product_name).toBe("TRULICITY ");
    expect([tr[0].utilization_type, tr[0].number_of_prescriptions]).toEqual(["FFSU", "47"]);
    const ex = csv(s, "medicaid", "vt_expansion");
    expect([ex[0].total_computable_all_medical_assistance_expenditures, ex[0].quarter_end_date]).toEqual(["374,032,607", "2014-03-31"]);
    expect(csv(s, "medicaid", "info")[0].identifier).toBe("6165f45b-ca93-5bb5-9d06-db29c692a360");
  });

  it("lists the catalog", async () => {
    const s = newSession();
    const spec = { requests: [{ name: "cat", endpoint: "datasets", params: {} }] };
    await fetchOk(s, "medicaid", spec);
    const rows = csv(s, "medicaid", "cat");
    expect(rows.map((x) => x.title)).toContain("State Drug Utilization Data 2026");
    expect(rows[0]).toHaveProperty("modified");
  });

  it("resolves catalog aliases and bracketed params", async () => {
    const p = await load("medicaid");
    const [ep, params, probs] = gr.resolve(p, SPEC.requests[2] as any);
    expect(probs).toEqual([]);
    expect(params.dataset).toBe("158a1baa-5506-400a-8ec3-97756f0b0536");
    const [pth, query] = gr.split(ep, params);
    expect(pth).toBe("/api/1/datastore/query/158a1baa-5506-400a-8ec3-97756f0b0536/0");
    expect(query["conditions[1][operator]"]).toBe("like");
  });

  it("searches the catalog", async () => {
    const r: any = await T.requestSchema(newSession(), { source: "medicaid", search: "drug utilization 2025" });
    expect(JSON.stringify(r.results)).toContain("sdud_2025");
  });

  it("reports the agency's own error", async () => {
    const s = newSession();
    const bad = { requests: [{ name: "bad", endpoint: "query", params: { dataset: "enrollment",
      "conditions[0][property]": "no_such_column", "conditions[0][value]": "x" } }] };
    fixtures("medicaid");
    await prepare(s, "medicaid", bad);
    const f = await failure(T.fetchData(s, { source: "medicaid", spec: bad }));
    expect(["agency_rejected", "server_error"]).toContain(f.code);
  });

  it("refuses a spec without its dataset", async () => {
    const s = newSession();
    const bad = { requests: [{ name: "x", endpoint: "query", params: { "sorts[0][order]": "down" } }] };
    fixtures("medicaid");
    await prepare(s, "medicaid", bad);
    const f = await failure(T.fetchData(s, { source: "medicaid", spec: bad }));
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("dataset");
  });
});

describe("nyfed", () => {
  const SPEC = { description: "SOFR and EFFR in October 2026, Fed Treasury holdings and purchases", requests: [
    { name: "sofr", endpoint: "rates", params: { family: "secured", ratetype: "sofr", startDate: "2026-10-01", endDate: "2026-10-29" } },
    { name: "effr", endpoint: "rates", params: { family: "unsecured", ratetype: "effr", startDate: "2026-10-01", endDate: "2026-10-29" } },
    { name: "wam", endpoint: "soma_tsy_wam", params: { holdingtype: "all", date: "2026-10-28" } },
    { name: "dates", endpoint: "soma_asofdates", params: {} },
    { name: "ops", endpoint: "tsy_operations", params: { operation: "purchases", include: "summary", startDate: "2026-10-01", endDate: "2026-10-29" } },
    { name: "pd", endpoint: "pd_series", params: { timeseries: "PDPOSGST-TOT" } },
    { name: "hold", endpoint: "soma_tsy_holdings", params: { date: "2026-10-28" } }] };

  it("fetches and packages", async () => {
    const s = newSession();
    expect((await fetchOk(s, "nyfed", SPEC)).status).toBe("ok");
    const sofr = csv(s, "nyfed", "sofr");
    expect(sofr.length).toBe(20);
    expect([sofr[0].effectiveDate, sofr[0].type, sofr[0].percentRate]).toEqual(["2026-10-29", "SOFR", "3.94"]);
    const effr = csv(s, "nyfed", "effr");
    expect(effr[0].type).toBe("EFFR");
    expect([effr[0].targetRateFrom, effr[0].targetRateTo]).toEqual(["3.75", "4.0"]); // as published, not "4"
    expect(csv(s, "nyfed", "wam")[0].wam).toBe("8.13");
    const dates = csv(s, "nyfed", "dates");
    expect([dates.length, dates[0].value]).toEqual([1217, "2026-10-28"]);
    const ops = csv(s, "nyfed", "ops");
    expect([ops.length, ops[0].totalParAmtAccepted]).toEqual([5, "1827000000"]);
    const pd = csv(s, "nyfed", "pd");
    expect([pd[0].asofdate, pd[0].value]).toEqual(["2013-04-03", "108014"]);
    const hold = csv(s, "nyfed", "hold");
    expect(hold.length).toBe(433);
    expect([...new Set(hold.map((x) => x.securityType))].filter((t) => !["Bills", "NotesBonds", "TIPS", "FRNs"].includes(t))).toEqual([]);
  });

  it("refuses a bad rate family and a missing date", async () => {
    const p = await load("nyfed");
    expect(gr.checkSpec(p, { requests: [{ name: "x", endpoint: "rates", params: { family: "nope", ratetype: "sofr" } }] }).length).toBeGreaterThan(0);
    expect(gr.checkSpec(p, { requests: [{ name: "x", endpoint: "soma_tsy_holdings", params: {} }] }).length).toBeGreaterThan(0);
  });
});

describe("va", () => {
  const SPEC = { description: "Texas veterans by sex, VetPop2023, FY2023-FY2026", requests: [{ name: "tx_all_veterans", endpoint: "query",
    params: { dataset: "vetpop_state_pos", $where: "state = 'Texas' AND pos = '(a) All Veterans (b+c)' AND date <= '2026-09-30'", $order: "date, sex" } }] };
  const STATE_TOTALS = { description: "Veterans by state, VetPop2023 projection for 2025-09-30", requests: [{ name: "veterans_by_state_2025",
    endpoint: "query", params: { dataset: "vetpop_state", $select: "state, sum(veterans) AS veterans", $where: "date = '2025-09-30'",
      $group: "state", $order: "state" } }] };
  const BENEFITS = { description: "Pension recipients FY2025 and compensation recipients FY2025 in Vermont", requests: [
    { name: "pension_fy2025", endpoint: "query", params: { dataset: "pension_recipients_state_fy2025", $order: "state" } },
    { name: "vt_comp_counties", endpoint: "query", params: { dataset: "comp_recipients_county_fy2025", $where: "state = 'Vermont'", $order: "fips_code" } }] };
  const GDX = { description: "VA expenditures by state, GDX FY2025", requests: [
    { name: "gdx_direct_fy25", endpoint: "gdx_state_direct", params: { fy: "25" } }, { name: "gdx_cd_fy25", endpoint: "gdx_cd_direct" }] };

  it("fetches state by period of service", async () => {
    const s = newSession();
    expect((await fetchOk(s, "va", SPEC)).status).toBe("ok");
    const rows = csv(s, "va", "tx_all_veterans");
    expect(Object.keys(rows[0])).toEqual(["date", "sex", "state", "pos", "veterans"]);
    expect(rows.length).toBe(8);
    expect(new Set(rows.map((x) => x.sex))).toEqual(new Set(["Female", "Male"]));
    expect(rows.filter((x) => x.date.startsWith("2025-09-30") && x.sex === "Male")[0].veterans).toBe("1308094");
  });

  it("SoQL group by state", async () => {
    const s = newSession();
    await fetchOk(s, "va", STATE_TOTALS);
    const rows = csv(s, "va", "veterans_by_state_2025");
    expect(rows.length).toBe(53);
    const by = Object.fromEntries(rows.map((x) => [x.state, x.veterans]));
    expect(by.Texas).toBe("1518969");
    expect(by).toHaveProperty("Island Areas & Foreign");
  });

  it("keeps suppressed cells blank", async () => {
    const s = newSession();
    await fetchOk(s, "va", BENEFITS);
    const pen = Object.fromEntries(csv(s, "va", "pension_fy2025").map((x) => [x.state, x]));
    expect(pen.Alabama.total_pension_recipients).toBe("3229");
    expect(pen.Alaska.male).toBe("");
    expect(pen).toHaveProperty("Other Foreign Countries");
    const vt = csv(s, "va", "vt_comp_counties");
    expect([vt[0].fips_code, vt[0].total_disability_compensation]).toEqual(["50001", "423"]);
  });

  it("GDX workbook requests are valid and link the agency file", async () => {
    const p = await load("va");
    expect(gr.checkSpec(p, GDX)).toEqual([]);
    const items = gr.manualItems(p, GDX);
    expect(JSON.stringify(items)).toContain("https://www.va.gov/vetdata/docs/GDX/GDX_FY25.xlsx");
  });

  it("searches the catalog", async () => {
    const r: any = await T.requestSchema(newSession(), { source: "va", search: "pension recipients" });
    expect(JSON.stringify(r.results)).toContain("pension_recipients_state_fy2025");
  });
});
