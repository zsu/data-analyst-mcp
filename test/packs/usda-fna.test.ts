/**
 * usda-fna pack, ported from tests/sources/usda-fna/test_usda_fna.py, on the same fixtures.
 *
 * Fixtures r001-r005.csv were recorded live on 2026-10-30 (State Options dashboard CSV exports: Texas and California
 * policy options; BBCE and No BBCE, 17th edition; BBCE, 16th edition; the telephonic signature waiver). Two index
 * entries are not responses to their own URL, to test the gates: the TBA request replays the BBCE export (the
 * dashboard ignoring a parameter), and the ESAP request answers HTTP 404 (a republished dashboard). Program Data
 * (recorded live 2026-10-30/31): the three listing pages (pd_*.html) and the workbooks snap-persons-10,
 * 26wifypart-10, 27wilatest-10 (its "June 2025" column holds June 2026), 01slfypart-10, cncost-10 and 36slmonthly-10
 * (hidden columns 9-10 hold numbers); 27wilatest-9 (not in index.json) prints "Data as of September 11, 2025" over
 * June 2026 data; snap-zip-fy69tocurrent-10_FY25only.zip and wicagencies2025ytd_3sheets.xlsx are trimmed real files.
 *
 * The report PDFs: this server has no PDF text reader, so fetching or ingesting a PDF endpoint is not_supported
 * (as the Python pack without pypdf). The PDF table parsers are ported all the same; their tests run on the page
 * text pypdf gives for the fixture PDFs (when python with pypdf is on PATH; skipped otherwise).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { programRows, table } from "../../src/adapters/usda-fna.js";
import { activityTableRows, parseTablePage, reportRows, reportYear } from "../../src/adapters/_usda-fna_pdf.js";
import * as gr from "../../src/core/generic-rest.js";
import { DataError } from "../../src/core/http.js";
import { load } from "../../src/core/packs.js";
import { readJson } from "../../src/core/policy.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "usda-fna", "fixtures");
const SRC = "usda-fna";
let EPS: any;

const SPEC = { description: "SNAP State Options: Texas and California policy options; BBCE and telephonic signature waiver states",
  requests: [
    { name: "tx_ca", endpoint: "options_by_state", params: { state: ["TX", "CA"], edition: "17" } },
    { name: "bbce", endpoint: "option_states", params: { policy: "bbce" } },
    { name: "bbce16", endpoint: "option_states", params: { policy: "bbce", selection: "BBCE", edition: "16" } },
    { name: "tel", endpoint: "option_states", params: { policy: "telephonic_signature_waiver", selection: "Telephonic signature waiver" } }] };
const SAR = { description: "SNAP State Activity Report FY 2023: households by benefit type, admin costs, claim dollars",
  requests: [{ name: "sar", endpoint: "activity_tables",
    params: { fiscal_year: 2023, tables: ["households_by_benefit_type", "admin_costs", "claims_established_dollars"] } }] };
const PD = { description: "FNA Program Data: SNAP persons (latest months), WIC and school lunch participation by state, " +
  "school meal costs, NSLP national monthly",
requests: [
  { name: "snap", endpoint: "program_table", params: { table: "snap_persons_latest", state: ["TX", "CA"] } },
  { name: "wic", endpoint: "program_table", params: { table: "wic_participation_state", state: "AZ" } },
  { name: "nslp", endpoint: "program_table", params: { table: "nslp_participation_state", state: "TX", fiscal_year: [2024, 2025] } },
  { name: "costs", endpoint: "program_table", params: { table: "school_meals_costs", fiscal_year: 2025 } },
  { name: "nslp_monthly", endpoint: "program_table", params: { table: "nslp_monthly", fiscal_year: 2025 } }] };
const PD_COLS = ["table", "table_title", "data_as_of", "state", "state_abbr", "agency", "row_type", "period", "period_type",
  "fiscal_year", "measure", "unit", "value", "value_num", "value_flag", "status", "footnote"];

beforeAll(async () => {
  isolate();
  EPS = readJson((await load(SRC)).dir, "endpoints.json");
});

const header = (s: any, name: string) =>
  fs.readFileSync(path.join(s.workspace, "data", SRC, `${name}.csv`), "utf8").split(/\r?\n/)[0].split(",");

async function problems(spec: any): Promise<string> {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  const f = await failure(T.fetchData(s, { source: SRC, spec }));
  expect(f.code).toBe("invalid_request");
  return f.message;
}

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  return failure(T.fetchData(s, { source: SRC, spec }));
}

/** Ingest: the files copied (under new names) into an upload folder; returns [session, result]. */
async function ingest(spec: any, files: [string, string][]): Promise<[any, any]> {
  const s = newSession();
  delete process.env.DATA_ANALYST_FIXTURES;
  await prepare(s, SRC, spec);
  const up = fs.mkdtempSync(path.join(os.tmpdir(), "fna-up-"));
  for (const [src, dst] of files) fs.copyFileSync(path.join(FX, src), path.join(up, dst));
  return [s, () => T.ingest(s, { source: SRC, spec, files: [up] })];
}

/** The fixture workbook with edit(member name, bytes) applied to each member. */
function rezip(file: string, edit: (n: string, b: Buffer) => Buffer): Uint8Array {
  const z = unzipSync(fs.readFileSync(path.join(FX, file)));
  return zipSync(Object.fromEntries(Object.entries(z).map(([n, b]) => [n, new Uint8Array(edit(n, Buffer.from(b)))])));
}
const swap = (b: Buffer, a: string | RegExp, c: string) => Buffer.from(b.toString("latin1").replace(a, c), "latin1");

/** The pages of a fixture PDF as the Python pack reads them (pypdf, NFKC); null without python + pypdf. */
function pypdfPages(file: string): string[] | null {
  const code = "import io,json,sys,unicodedata\ntry:\n import pypdf\nexcept ImportError:\n print('null'); sys.exit()\n" +
    "r=pypdf.PdfReader(sys.argv[1])\nsys.stdout.reconfigure(encoding='utf-8')\n" +
    "print(json.dumps([unicodedata.normalize('NFKC', p.extract_text() or '') for p in r.pages]))";
  const p = spawnSync("python", ["-I", "-c", code, path.join(FX, file)], { encoding: "utf8" });
  if (p.status !== 0 || !p.stdout) return null;
  return JSON.parse(p.stdout);
}
const SAR_PAGES = pypdfPages("sar23_p9_p14_p30.pdf");
const SOR_PAGES = pypdfPages("sor17_p132_p134.pdf");

describe("usda-fna: State Options and State Activity Reports", () => {
  it("the spec is valid (api route)", async () => {
    expect(gr.checkSpec(await load(SRC), SPEC)).toEqual([]);
    const r = await fetchOk(newSession(), SRC, SPEC);
    expect(r.summary.route).toBe("api");
  });

  it("dashboard exports", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.status).toBe("ok");
    const txCa = csv(s, SRC, "tx_ca");
    expect(header(s, "tx_ca")).toEqual(["edition", "state", "state_abbr", "policy_option", "option_selection",
      "agencies_with_selection", "share_of_agencies"]);
    expect(txCa.length).toBe(30);
    const tx = Object.fromEntries(txCa.filter((x) => x.state_abbr === "TX").map((x) => [x.policy_option, x]));
    expect(tx["Broad-Based Categorical Eligibility (BBCE)"].option_selection).toBe("BBCE");
    expect(tx["Broad-Based Categorical Eligibility (BBCE)"].agencies_with_selection).toBe("44");
    expect(tx["Certification Period Lengths Months"].option_selection).toBe("4,6,12");
    const bbce = csv(s, SRC, "bbce");
    expect(bbce.length).toBe(53); // every agency once: 44 BBCE + 9 No BBCE
    expect(bbce.filter((x) => x.option_selection === "BBCE").length).toBe(44);
    expect(new Set(csv(s, SRC, "bbce16").map((x) => x.edition))).toEqual(new Set(["16th Edition (FY 2024)"]));
    expect(csv(s, SRC, "tel").length).toBe(12);
    expect(r.notes).toContain("tx_ca: 30 rows for 2 agencies (17th Edition (FY 2025)); policy options only (waivers and " +
      "demonstration projects: option_states or options_report)");
    expect(r.notes).toContain("bbce: Broad-Based Categorical Eligibility (BBCE) (17th Edition (FY 2025)): 53 rows, 53 of 53 " +
      "agencies; an agency missing here has no published selection");
  });

  it("an ignored parameter is an error (never the dashboard's default rows)", async () => {
    const f = await fetchFail({ requests: [{ name: "tba", endpoint: "option_states", params: { policy: "tba", selection: "TBA" } }] });
    expect(f.message).toContain("no longer matches the dashboard");
    expect(f.message).toContain("'Transitional Benefits Alternative' / ['TBA']");
  });

  it("a missing view names the PDF fallback", async () => {
    const f = await fetchFail({ requests: [{ name: "esap", endpoint: "option_states", params: { policy: "esap", selection: "ESAP" } }] });
    expect(f.code).toBe("not_found");
    expect(f.message).toContain("republished");
    expect(f.message).toContain("options_report");
  });

  it("a bad selection is invalid_request", async () => {
    const m = await problems({ requests: [{ name: "x", endpoint: "option_states", params: { policy: "bbce", selection: "Maybe" } }] });
    expect(m).toContain("No BBCE");
    expect(m).toContain("request 'x': selection 'Maybe' is not one of 'Broad-Based Categorical Eligibility (BBCE)''s: BBCE; No BBCE");
  });

  it("an unparsed year is invalid_request", async () => {
    const m = await problems({ requests: [{ name: "x", endpoint: "activity_tables", params: { fiscal_year: 2015 } }] });
    expect(m).toContain("activity_report");
    expect(m).toContain("fiscal_year (parsed tables: FY 2019-2023; other years: activity_report) 2015 is outside 2019-2023");
  });

  it("PDF endpoints are not supported here (no PDF text reader)", async () => {
    const f = await fetchFail(SAR);
    expect(f.code).toBe("not_supported");
    expect(f.message).toContain("PDF text reader");
    const g = await fetchFail({ requests: [{ name: "tx", endpoint: "options_report", params: { edition: 17, state: "TX" } }] });
    expect(g.code).toBe("not_supported");
  });

  it.skipIf(!SAR_PAGES)("activity tables (parsed from pypdf's page text)", () => {
    const [rows, notes] = activityTableRows(SAR_PAGES!, 2023, SAR.requests[0].params, EPS);
    expect(notes.filter((n) => n.includes(gr.INCOMPLETE))).toEqual([]);
    expect(Object.keys(rows[0])).toEqual(["report_fy", "table", "table_number", "table_title", "page", "state",
      "state_abbr", "row_type", "measure", "data_fy", "value", "value_num", "value_flag"]);
    const val = new Map(rows.map((x: any) => [`${x.table}|${x.state_abbr}|${x.measure}`, x]));
    const al: any = val.get("households_by_benefit_type|AL|households_ebt"); // printed column by column
    expect([al.value, al.value_num, al.data_fy]).toEqual(["391,662", "391662", 2023]);
    const cash: any = val.get("households_by_benefit_type|AL|households_cash");
    expect([cash.value_num, cash.value_flag]).toEqual(["", "N/A"]); // a code, never a zero
    expect((val.get("claims_established_dollars|AL|fraud_claim_dollars_established") as any).value_num).toBe("318378"); // row by row
    const dc: any = val.get("claims_established_dollars|DC|total_claim_dollars_established");
    expect([dc.value_num, dc.value_flag]).toEqual(["", "--"]);
    const states = new Set(rows.filter((x: any) => x.row_type === "state").map((x: any) => x.state_abbr));
    for (const a of ["GU", "VI", "DC"]) expect(states.has(a)).toBe(true);
    expect(states.size).toBe(53);
    const us: any = rows.find((x: any) => x.row_type === "us_total" && x.measure === "households_ebt");
    expect(us.value_num).toBe("22267689");
    expect(new Set(rows.filter((x: any) => x.table === "admin_costs").map((x: any) => x.measure)))
      .toEqual(new Set(["state_share_admin_costs", "federal_share_admin_costs", "arpa_funding", "total_admin_costs"]));
  });

  it.skipIf(!SAR_PAGES)("a misaligned table is dropped, never shifted onto the wrong agencies", () => {
    const page = SAR_PAGES![0];
    let [key, rows, prob] = parseTablePage(page, 9, 2023, EPS);
    expect([key, rows.length > 0, prob]).toEqual(["households_by_benefit_type", true, null]);
    const lines = page.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
    const i = lines.findIndex((ln) => ln.trim() === "391,662");
    [key, rows, prob] = parseTablePage([...lines.slice(0, i), ...lines.slice(i + 1)].join("\n"), 9, 2023, EPS);
    expect([key, rows]).toEqual(["households_by_benefit_type", []]);
    expect(prob).toContain("values for 53 agencies");
  });

  it.skipIf(!SOR_PAGES)("options report: a state's profile pages", () => {
    const rows: any[] = reportRows(SOR_PAGES!, "17", { edition: 17, state: "TX" }, EPS);
    expect(rows.map((x) => x.page)).toEqual([1, 2]); // pages of the trimmed fixture
    expect(new Set(rows.map((x) => x.state))).toEqual(new Set(["Texas"]));
    expect(rows[0].text).toContain("\nBBCE BBCE");
    expect(rows[1].text).toContain("Pre-Release Applications from Institutions Waiver");
  });

  it.skipIf(!SAR_PAGES)("the report year is read from the PDF's content", () => {
    expect(reportYear(SAR_PAGES!)).toBe(2023);
  });

  it("manual bundle", async () => {
    const spec = { requests: [...SPEC.requests.slice(0, 2), ...SAR.requests] };
    const b: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec }] });
    expect(b.items.map((i: any) => i.filename)).toEqual(["tx_ca_01.csv", "bbce_01.csv", "bbce_02.csv", "sar_snap-sar-fy23.pdf"]);
    expect(b.items[0].url).toContain("StateAgencyComparison.csv?State%201%20Param=Texas&State%202%20Param%20=California");
    expect(b.items[3].url.startsWith("https://www.fna.usda.gov/sites/default/files/")).toBe(true);
  });

  it("ingest (dashboard files)", async () => {
    const spec = { requests: SPEC.requests.slice(0, 2) };
    const [s, run] = await ingest(spec, [["r001.csv", "tx_ca_01.csv"], ["r002.csv", "bbce_01.csv"], ["r003.csv", "bbce_02.csv"]]);
    const r: any = await run();
    expect(r.summary.route).toBe("manual_download");
    expect(csv(s, SRC, "tx_ca").length).toBe(30);
    expect(csv(s, SRC, "bbce").length).toBe(53);
  });

  it("ingest of a report PDF is not supported here", async () => {
    const req = { name: "sar", endpoint: "activity_tables", params: { fiscal_year: 2023, tables: "all" } };
    const [, run] = await ingest({ requests: [req] }, [["sar23_p9_p14_p30.pdf", "sar_FY19-state-activity-report.pdf"]]);
    expect((await failure(run())).code).toBe("not_supported");
  });

  it("a blocked network hands off to the manual route", async () => {
    process.env.DATA_ACCESS_FORCE = "restricted";
    try {
      const s = newSession();
      delete process.env.DATA_ANALYST_FIXTURES;
      await prepare(s, SRC, SPEC);
      const f = await failure(T.fetchData(s, { source: SRC, spec: SPEC }));
      expect(f.code).toBe("agency_unavailable");
      expect(f.manual_bundle).toBeTruthy();
    } finally {
      delete process.env.DATA_ACCESS_FORCE;
    }
  });
});

describe("usda-fna: Program Data", () => {
  it("the spec is valid (api route)", async () => {
    expect(gr.checkSpec(await load(SRC), PD)).toEqual([]);
  });

  it("program tables", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, PD);
    expect(r.status).toBe("ok");
    const snap = csv(s, SRC, "snap");
    expect(header(s, "snap")).toEqual(PD_COLS);
    const v = Object.fromEntries(snap.map((x) => [`${x.state_abbr}|${x.period}`, x]));
    expect(snap.length).toBe(6); // 2 states x 3 months
    expect([v["CA|2025-07"].value_num, v["CA|2025-07"].data_as_of]).toEqual(["5449432", "2026-10-09"]);
    expect(v["CA|2026-06"].status).toBe("preliminary");
    expect(v["TX|2026-07"].status).toBe("initial");
    const wic = Object.fromEntries(csv(s, SRC, "wic").map((x) => [`${x.agency}|${x.period}`, x]));
    expect(wic["|FY 2025"].value_num).toBe("157532.9167"); // the state total, ITOs included
    expect(wic["|FY 2025"].row_type).toBe("state");
    expect(wic["Navajo Nation|FY 2025"].row_type).toBe("sub_agency");
    expect(new Set(csv(s, SRC, "nslp").map((x) => x.fiscal_year))).toEqual(new Set(["2024", "2025"]));
    const costs = Object.fromEntries(csv(s, SRC, "costs").map((x) => [x.measure, x]));
    expect(costs.cash_nslp.value_num).toBe("17236.12265209");
    expect(costs.cash_nslp.unit).toBe("millions of dollars");
    expect([costs.commodities_bonus.value_num, costs.commodities_bonus.value_flag]).toEqual(["", "blank"]);
    const mon = csv(s, SRC, "nslp_monthly");
    expect(new Set(mon.map((x) => x.measure))).toEqual(new Set(["participation", "lunches_served", "share_free",
      "share_reduced_price", "snacks_served", "cash_payments", "commodity_costs"])); // hidden columns 9-10 skipped
    expect(mon.filter((x) => x.period_type === "month").length).toBe(12 * 7);
    const oct = mon.find((x) => x.period === "2024-10" && x.measure === "share_free")!;
    expect(oct.unit).toBe("fraction of lunches (0-1)");
    expect(r.notes).toContain("snap: snap_persons_latest from snap-persons-10.xlsx (data as of 2026-10-09): 6 values");
  });

  it("a mislabeled month column is dropped, never relabeled", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, { requests: [{ name: "wl", endpoint: "program_table",
      params: { table: "wic_participation_latest", state: "AL" } }] });
    expect(r.status).toBe("partial");
    const cut = r.notes.filter((n: string) => n.includes(gr.INCOMPLETE));
    expect(cut.join(" ")).toContain("June 2025");
    expect(cut[0].startsWith("wl: incomplete: column 'June 2025")).toBe(true);
    expect(csv(s, SRC, "wl").map((x) => x.period).sort()).toEqual(["2025-07", "2026-07"]);
    expect(r.notes.filter((n: string) => n.includes("Data as of"))).toEqual([]); // -10: October 9, 2026
  });

  it("a 'Data as of' before the latest data is noted, kept as printed, never fixed", () => {
    const [k, c] = table("wic_participation_latest");
    const [rows, notes] = programRows(k, c, fs.readFileSync(path.join(FX, "27wilatest-9.xlsx")), {});
    expect(new Set(rows.map((x) => x.data_as_of))).toEqual(new Set(["2025-09-11"]));
    const hit = notes.filter((n) => n.includes("Data as of"));
    expect(hit.length).toBe(1);
    expect(hit[0]).toContain("2025-09-11, before its own latest data (2026-06)");
    // the same date a year later (as FNA meant it) passes
    const fixed = rezip("27wilatest-9.xlsx", (_n, b) => swap(b, /September 11, 2025/g, "September 11, 2026"));
    expect(programRows(k, c, fixed, {})[1].filter((n) => n.includes("Data as of"))).toEqual([]);
  });

  it("layout gates", () => {
    let [k, c] = table("nslp_participation_state");
    const good = fs.readFileSync(path.join(FX, "01slfypart-10.xlsx"));
    expect(programRows(k, c, good, {})[0].length).toBe(305);
    const bad = rezip("01slfypart-10.xlsx", (n, b) => (n === "xl/sharedStrings.xml" ? swap(b, /FY 2023/g, "FY 2033") : b));
    expect(() => programRows(k, c, bad, {})).toThrow(/expected layout/);
    expect(() => programRows(k, c, bad, {})).toThrow(DataError);
    // the hidden columns of 36slmonthly made visible: values under no label fail the table
    [k, c] = table("nslp_monthly");
    const shown = rezip("36slmonthly-10.xlsx", (n, b) => (n.startsWith("xl/worksheets/") ? swap(b, / hidden="1"/g, "") : b));
    expect(() => programRows(k, c, shown, {})).toThrow(/unlabeled column/);
    // a workbook that is another table is refused by its title
    const [k2, c2] = table("wic_participation_state");
    expect(() => programRows(k2, c2, good, {})).toThrow(DataError);
  });

  it("SNAP by state and month (the data zip)", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, { requests: [{ name: "sm", endpoint: "snap_state_monthly", params: { fiscal_year: 2025 } }] });
    expect(r.status).toBe("ok");
    expect(r.notes.filter((n: string) => n.includes("check:"))).toEqual([]); // states = regions = U.S.
    const rows = csv(s, SRC, "sm");
    const tx = Object.fromEntries(rows.filter((x) => x.state_abbr === "TX").map((x) => [`${x.period}|${x.measure}`, x]));
    expect(tx["FY 2025|persons"].value_num).toBe("3472443.0833");
    expect(tx["2025-07|benefits"].value_num).toBe("625221101");
    expect(Object.keys(tx).filter((k) => k.endsWith("|persons")).length).toBe(13); // 12 months + the FY
    expect(new Set(rows.map((x) => x.row_type))).toEqual(new Set(["state", "region", "national"]));
    const m = await problems({ requests: [{ name: "x", endpoint: "snap_state_monthly", params: { fiscal_year: 2019 } }] });
    expect(m).toContain(".xls");
  });

  it("WIC by agency and month", async () => {
    let s = newSession();
    let r = await fetchOk(s, SRC, { requests: [{ name: "wa", endpoint: "wic_agency_monthly",
      params: { fiscal_year: 2025, state: "AZ", measures: ["participants_total", "nsa_costs"] } }] });
    expect(r.status).toBe("ok");
    const rows = csv(s, SRC, "wa");
    const tot = Object.fromEntries(rows.filter((x) => x.measure === "participants_total" && x.period === "FY 2025")
      .map((x) => [`${x.agency}|${x.row_type}`, x]));
    expect(Math.round(Number(tot["|state_agency"].value_num))).toBe(146899); // the state agency only
    expect("Navajo Nation|tribal_org" in tot).toBe(true);
    expect(new Set(rows.filter((x) => x.measure === "nsa_costs").map((x) => x.period_type))).toEqual(new Set(["fiscal_year"]));
    // a sheet missing from the workbook makes the table incomplete
    s = newSession();
    r = await fetchOk(s, SRC, { requests: [{ name: "wf", endpoint: "wic_agency_monthly",
      params: { fiscal_year: 2025, measures: ["food_costs"] } }] });
    expect(r.status).toBe("partial");
    expect(r.notes.filter((n: string) => n.includes(gr.INCOMPLETE)).join(" ")).toContain("food_costs");
  });

  it("program spec checks", async () => {
    for (const [params, words] of [[{ table: "nslp_annual", state: "TX" }, "national table"],
      [{ table: "no_such_table" }, "not a Program Data table"]] as const) {
      expect(await problems({ requests: [{ name: "x", endpoint: "program_table", params }] })).toContain(words);
    }
    // a table key is not a State Options policy
    expect(await problems({ requests: [{ name: "x", endpoint: "option_states", params: { policy: "nslp_annual" } }] }))
      .toContain("is not in the catalog");
  });

  it("manual bundle and ingest", async () => {
    const spec = { requests: [...PD.requests.slice(0, 2),
      { name: "sm", endpoint: "snap_state_monthly", params: { fiscal_year: 2025, state: "TX" } },
      { name: "wa", endpoint: "wic_agency_monthly", params: { fiscal_year: 2025, state: "AZ" } }] };
    const b: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec }] });
    const names = b.items.map((i: any) => i.filename);
    expect(names).toEqual(["snap_snap-persons.xlsx", "wic_26wifypart.xlsx", "sm_snap-zip-fy69tocurrent.zip",
      "wa_wicagencies2025ytd.xlsx"]);
    expect(b.items[0].url.endsWith("/resource-files/snap-persons-10.xlsx")).toBe(true);
    // saved under the bundle's names; parseUpload still checks each file's content (title, fiscal year)
    const srcs = ["snap-persons-10.xlsx", "26wifypart-10.xlsx", "snap-zip-fy69tocurrent-10_FY25only.zip", "wicagencies2025ytd_3sheets.xlsx"];
    const [s, run] = await ingest(spec, srcs.map((x, i) => [x, names[i]] as [string, string]));
    await run();
    expect(csv(s, SRC, "snap").length).toBe(6);
    expect(csv(s, SRC, "wic").length).toBe(20);
    expect(new Set(csv(s, SRC, "sm").map((x) => x.state_abbr))).toEqual(new Set(["TX"]));
    expect(new Set(csv(s, SRC, "wa").map((x) => x.agency)).has("Navajo Nation")).toBe(true);
  });
});
