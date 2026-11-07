/** treasury: ported from tests/sources/treasury/test_treasury.py (same fixtures and values).
 *
 * Fixtures (test/packs/treasury/fixtures): recorded live on 2026-10-20 (the ping and row count, the download, and the
 * fields lookup for Debt to the Penny, September 2026); upload_debt.csv is the same query's CSV link (format=csv) as
 * a user would download it from the manual bundle. */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import pack from "../../src/deep/treasury.js";
import * as L from "../../src/deep/_treasury_lib.js";
import { filterString } from "../../src/deep/_treasury_api.js";
import { missingMonths } from "../../src/deep/_treasury_context.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "treasury", "fixtures");
const SPEC = { description: "Debt to the penny, September 2026", as_of: "2026-09-30",
  datasets: [{ name: "debt", endpoint: "v2/accounting/od/debt_to_penny", filter: { record_date: { gte: "2026-09-01" } } }] };

beforeAll(() => isolate());

describe("treasury", () => {
  it("checks the spec and names its operation", async () => {
    expect(pack.checkSpec!(SPEC, await load("treasury"))).toEqual([]);
    expect(T.usedRequests(await load("treasury"), SPEC)).toEqual(["dataset"]);
    expect(pack.checkSpec!({ datasets: [] }, await load("treasury"))[0]).toContain("non-empty \"datasets\"");
    expect(pack.checkSpec!({ datasets: [{ name: "Bad", endpoint: "v1/x" }] }, await load("treasury"))[0]).toContain("lowercase");
    expect(pack.checkSpec!({ datasets: [{ name: "x", endpoint: "accounting/x" }] }, await load("treasury"))[0]).toContain("should look like");
    expect(pack.checkSpec!({ datasets: [{ name: "x", endpoint: "v1/x", filter: { a: { like: "b" } } }] }, await load("treasury"))[0])
      .toContain("filter operator 'like'");
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "treasury", SPEC);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api");
    const rows = csv(s, "treasury", "debt");
    expect(rows.length).toBe(21);
    expect(rows[0].record_date).toBe("2026-09-01");
    expect(rows[0].tot_pub_debt_out_amt).toBe("40112464593206.30");
    const d = path.join(s.workspace, "data", "treasury");
    const prov = JSON.parse(fs.readFileSync(path.join(d, "fetch_spec.json"), "utf8"));
    expect(prov.source).toBe("treasury");
    expect(prov.datasets.debt.rows).toBe(21);
    expect(prov.tables[0].file).toBe("debt.csv");
    expect(fs.readFileSync(path.join(d, "README.md"), "utf8")).toContain("Debt to the penny");
    expect(r.citation.text).toContain("v2/accounting/od/debt_to_penny");
    expect(r.files.some((f: string) => f.endsWith("fetch_spec.json"))).toBe(true);
  });

  it("reuses existing data, and force fetches again", async () => {
    const s = newSession();
    await fetchOk(s, "treasury", SPEC);
    let r: any = await T.fetchData(s, { source: "treasury", spec: SPEC });
    expect(r.summary.route).toBe("reuse_existing");
    r = await T.fetchData(s, { source: "treasury", spec: SPEC, force: true });
    expect(r.summary.route).toBe("api");
  });

  it("an unknown endpoint is not_found", async () => {
    const s = newSession();
    const bad = { datasets: [{ name: "x", endpoint: "v1/accounting/od/no_such_table" }] };
    const f = await failure(fetchOk(s, "treasury", bad));
    expect(f.code).toBe("not_found");
    expect(f.message).toContain("one fixed version");
  });

  it("unreachable: agency_unavailable with the manual bundle", async () => {
    const s = newSession();
    fixtures("treasury");
    await prepare(s, "treasury", SPEC);
    delete process.env.DATA_ANALYST_FIXTURES;
    process.env.DATA_ACCESS_FORCE = "restricted";
    try {
      const f = await failure(T.fetchData(s, { source: "treasury", spec: SPEC }));
      expect(f.code).toBe("agency_unavailable");
      expect(f.manual_bundle).toBeTruthy();
      const b: any = await T.manualBundle(s, { sources: [{ source: "treasury", spec: SPEC }] });
      for (const f of ["INSTRUCTIONS.md", "download_data.sh", "download_data.ps1", "spec.json"]) {
        expect(fs.existsSync(path.join(b.bundle, f)), f).toBe(true);
      }
      expect(fs.readFileSync(b.download_scripts.bash, "ascii")).toContain("api.fiscaldata.treasury.gov");
      const text = fs.readFileSync(b.instructions, "utf8");
      expect(text).toContain("bash ~/Downloads/download_data.sh");
      expect(text.toLowerCase()).not.toContain("python");
      expect(b.items[0].filename).toBe("debt.csv");
      expect(b.items[0].url).toContain("format=csv");
    } finally {
      delete process.env.DATA_ACCESS_FORCE;
    }
  });

  it("search falls back to the bundled catalog", async () => {
    fixtures("treasury");
    const r: any = await T.requestSchema(newSession(), { source: "treasury", search: "interest expense" });
    const eps = r.results.map((h: any) => h.endpoint);
    expect(r.results[r.results.length - 1].searched).toContain("bundled catalog.json");
    expect(eps).toContain("v2/accounting/od/interest_expense");
    const hit = r.results.find((h: any) => h.endpoint === "v2/accounting/od/interest_expense");
    expect(hit.guidance).toBeTruthy(); // curated datasets.md row merged in
  });

  it("the dataset schema lists the curated endpoints", async () => {
    const r: any = await T.requestSchema(newSession(), { source: "treasury", names: ["dataset"] });
    expect(r.schemas[0].all_endpoints).toBeGreaterThan(180);
    expect(r.schemas[0].curated.some((e: any) => e.endpoint === "v1/accounting/mts/mts_table_9")).toBe(true);
  });

  it("fields", async () => {
    fixtures("treasury");
    const r: any = await T.requestSchema(newSession(), { source: "treasury", search: "v2/accounting/od/debt_to_penny" });
    const info = r.results[0];
    expect(info.fields.map((f: any) => f.field)).toContain("record_date");
    expect(info.last_row.record_date >= "2026-10-01").toBe(true);
  });

  it("ingests an uploaded CSV", async () => {
    const s = newSession();
    fixtures("treasury");
    await prepare(s, "treasury", SPEC);
    const up = path.join(s.workspace, "up");
    fs.mkdirSync(up);
    fs.copyFileSync(path.join(FX, "upload_debt.csv"), path.join(up, "debt.csv"));
    delete process.env.DATA_ANALYST_FIXTURES;
    const r: any = await T.ingest(s, { source: "treasury", spec: SPEC, files: [up] });
    expect(r.summary.route).toBe("manual_download");
    expect(csv(s, "treasury", "debt")[0].tot_pub_debt_out_amt).toBe("40112464593206.30");
  });

  it("the catalog marks stale entries", async () => {
    const cat = L.loadCatalog((await load("treasury")).dir);
    const stale = cat.filter((e) => e.status).map((e) => e.endpoint);
    expect(stale).toContain("v2/debt/tror/delinquent_debt");
    expect(cat.filter((e) => e.status).every((e) => !e.in_live_catalog)).toBe(true);
  });
});

describe("treasury units", () => {
  it("split_filter moves unsafe values local", () => {
    const [api, local] = L.splitFilter({ record_date: { gte: "2020-01-01" },
      security_desc: ["Foreign Series Notes & Bonds", "Treasury Bills"] });
    expect("record_date" in (api as any)).toBe(true);
    expect("security_desc" in local).toBe(true);
    expect(filterString({ a: "x", b: ["1", "2"], c: { lte: "3" } })).toBe("a:eq:x,b:in:(1,2),c:lte:3");
  });

  it("unit_hint reads data formats", () => {
    const t = { issued_amt: "CURRENCY0", outstanding_amt: "CURRENCY0", yield_pct: "PERCENTAGE" };
    const mil = { issued_amt: "$1,000,000", outstanding_amt: "$1,000,000" }; // MSPD table 3 [live 2026-10-21]
    expect(L.unitHint("v1/debt/mspd/mspd_table_3_market", t, t, mil)).toContain("issued_amt, outstanding_amt are in MILLIONS");
    expect(L.unitHint("v1/debt/mspd/mspd_table_3_market", t, t, {})).toContain("not confirmed"); // an upload
    const d = { tot_pub_debt_out_amt: "CURRENCY" };
    expect(L.unitHint("v2/accounting/od/debt_to_penny", d, d, { tot_pub_debt_out_amt: "$10.20" })).toBe("Amounts are in dollars and cents.");
    const r = { avg_interest_rate_amt: "PERCENTAGE" }; // an _amt field that is a rate, not money
    expect(L.unitHint("v2/accounting/od/avg_interest_rates", r, r, { avg_interest_rate_amt: "10.2%" })).not.toContain("dollars");
    const m = { mil_amt: "CURRENCY" }; // millions by name though its format says $10.20
    expect(L.unitHint("v1/accounting/mts/x", m, m, { mil_amt: "$10.20" })).toContain("mil_amt are in MILLIONS");
  });

  it("values lists every value", () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ transaction_catg: `Line ${String(i).padStart(3, "0")}`, record_date: "2026-01-02" }));
    const cols = ["transaction_catg", "record_date"];
    const short: any = L.valueSummary(rows, cols).columns.get("transaction_catg");
    expect(short.distinct).toBe(120);
    expect(short.all_values).toContain("values");
    const full: any = L.valueSummary(rows, cols, null, L.MAX_VALUES_CLI).columns.get("transaction_catg");
    expect(full.size).toBe(120);
    expect(full.has("Line 119")).toBe(true);
    const many = Array.from({ length: 250 }, (_, i) => ({ transaction_catg: `Line ${String(i).padStart(3, "0")}` }));
    const top: any = L.valueSummary(many, ["transaction_catg"], null, L.MAX_VALUES_CLI).columns.get("transaction_catg");
    expect([top.distinct, top.values.size]).toEqual([250, 200]);
    expect(top.more).toContain("+50 more");
  });

  it("a string filter is applied on ingest", () => {
    expect(L.parseFilterString("record_date:gte:2020-01-01,type:in:(Bills,Notes),record_date:lte:2025-09-30"))
      .toEqual({ record_date: { gte: "2020-01-01", lte: "2025-09-30" }, type: { in: ["Bills", "Notes"] } });
    const rows = [{ record_date: "2019-12-31", type: "Bills" }, { record_date: "2021-01-31", type: "Notes" },
      { record_date: "2021-01-31", type: "Bonds" }, { record_date: "2026-01-31", type: "Bills" }];
    const kept = L.applyFilter(rows, "record_date:gte:2020-01-01,type:in:(Bills,Notes),record_date:lte:2025-09-30");
    expect(kept).toEqual([rows[1]]);
  });

  it("manual items carry one CSV link per dataset", () => {
    const items = pack.manualItems!(SPEC, null as any);
    expect(items.length).toBe(1);
    expect(items[0].url).toContain("filter=record_date:gte:2026-09-01,record_date:lte:2026-09-30");
    expect(items[0].url).toContain("page%5Bsize%5D=10000");
  });

  it("context specs: checked, and missing months listed", async () => {
    const p = await load("treasury");
    expect(pack.checkSpec!({ context: [{ kind: "cpi", start: 2016 }] }, p)).toEqual([]);
    expect(T.usedRequests(p, { context: "gdp" })).toEqual(["context"]);
    expect(T.usedRequests(p, { ...SPEC, context: "gdp" })).toEqual(["dataset", "context"]);
    expect(pack.checkSpec!({ context: "ppi" }, p)[0]).toContain("use \"cpi\" or \"gdp\"");
    expect(missingMonths([["2025-09-01", 1], ["2025-11-01", 2], ["2025-12-01", 3]])).toEqual(["2025-10"]);
  });
});
