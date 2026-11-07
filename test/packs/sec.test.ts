/** sec: ported from tests/sources/sec/test_sec.py (same fixtures, specs and expected values). */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

const SPEC = { description: "Apple annual net income; Q4 2023 goodwill impairments; a small company's facts and filings; " +
  "8-K documents mentioning goodwill impairment; Apple Form 4s",
requests: [
  { name: "aapl_net_income", endpoint: "company_concept",
    params: { ticker: "AAPL", tag: "NetIncomeLoss", forms: "10-K", frames_only: true, duration: "annual" } },
  { name: "goodwill_impairment_2023q4", endpoint: "frames", params: { tag: "GoodwillImpairmentLoss", period: "CY2023Q4" } },
  { name: "margaree_facts", endpoint: "company_facts", params: { cik: "2129664", tags: "Assets,NetIncomeLoss,StockholdersEquity" } },
  { name: "margaree_filings", endpoint: "submissions", params: { cik: "2129664" } },
  { name: "goodwill_8k", endpoint: "full_text_search",
    params: { q: "\"goodwill impairment\"", forms: "8-K", startdt: "2024-01-01", enddt: "2024-01-05" } },
  { name: "aapl_form4", endpoint: "insider_filings", params: { cik: "320193", startdt: "2025-01-01", enddt: "2025-03-31" } }] };

beforeAll(() => isolate());

async function adapter(): Promise<any> {
  return (await load("sec")).adapter;
}

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures("sec");
  await prepare(s, "sec", spec);
  return failure(T.fetchData(s, { source: "sec", spec }));
}

describe("sec", () => {
  it("fetches on the api route", async () => {
    const s = newSession();
    const r = await fetchOk(s, "sec", SPEC);
    expect(r.summary.route).toBe("api");
    const ni = csv(s, "sec", "aapl_net_income");
    expect(ni[0].cik).toBe("0000320193"); // ticker resolved through efts
    const last = ni[ni.length - 1];
    expect([last.end, last.val, last.frame, last.period_days]).toEqual(["2025-09-27", "112010000000", "CY2025", "364"]);
    expect(ni.every((x) => Number(x.period_days) >= 350 && Number(x.period_days) <= 380)).toBe(true);
    expect(new Set(ni.map((x) => x.end)).size).toBe(ni.length); // one value per period
    // SEC framed no fact for fiscal 2010 or 2012: frames_only keeps their latest-filed facts, with a note
    const fy10 = ni.filter((x) => x.end === "2010-09-25");
    expect([fy10[0].val, fy10[0].frame]).toEqual(["14013000000", ""]);
    expect(ni.length).toBe(19);
    expect(r.notes.some((n: string) => n.includes("aapl_net_income") && n.includes("2 period(s) with no SEC frame were restored"))).toBe(true);
    const fr = csv(s, "sec", "goodwill_impairment_2023q4");
    expect(fr.length).toBe(125);
    expect(fr[0].entityName).toBe("CONSTELLATION BRANDS, INC.");
    const facts = csv(s, "sec", "margaree_facts");
    expect(new Set(facts.map((x) => x.tag))).toEqual(new Set(["Assets", "NetIncomeLoss", "StockholdersEquity"]));
    expect(facts.filter((x) => x.tag === "Assets").map((x) => x.val)).toContain("3293");
    const fl = csv(s, "sec", "margaree_filings");
    expect(fl[0].form).toBe("10-Q");
    expect(fl[0].url.startsWith("https://www.sec.gov/Archives/edgar/data/2129664/")).toBe(true);
    const docs = csv(s, "sec", "goodwill_8k");
    expect(docs.length).toBe(11);
    expect(docs[0].adsh).toBe("0001437749-24-000383");
    const f4 = csv(s, "sec", "aapl_form4");
    expect(f4[0].insider).toBe("WAGNER SUSAN");
    expect(f4.every((x) => x.form === "4")).toBe(true);
  });

  it("never sends a User-Agent with a GitHub URL", async () => {
    const ad = await adapter();
    const old = process.env.SEC_USER_AGENT;
    try {
      process.env.SEC_USER_AGENT = "tool (+https://github.com/x/y)";
      expect(ad.userAgent()).toBe(ad.DEFAULT_UA);
      process.env.SEC_USER_AGENT = "Jane Analyst jane.analyst@example.org";
      expect(ad.userAgent()).toBe("Jane Analyst jane.analyst@example.org");
    } finally {
      if (old === undefined) delete process.env.SEC_USER_AGENT;
      else process.env.SEC_USER_AGENT = old;
    }
    expect(ad.DEFAULT_UA.toLowerCase()).not.toContain("github");
  });

  it("bad specs are invalid_request", async () => {
    for (const bad of [{ requests: [{ name: "a", endpoint: "company_concept", params: { tag: "Assets" } }] },
      { requests: [{ name: "b", endpoint: "frames", params: { tag: "Assets", period: "2023" } }] }]) {
      expect((await fetchFail(bad)).code).toBe("invalid_request");
    }
  });

  it("an unknown tag names the request and spares the rest", async () => {
    const known = { name: "known", endpoint: "company_concept",
      params: { cik: "320193", tag: "NetIncomeLoss", forms: "10-K", duration: "annual" } };
    const unknown = { name: "unknown_tag", endpoint: "company_concept", params: { cik: "320193", tag: "RevenueFromLemonadeStands" } };
    const f = await fetchFail({ requests: [unknown, known] });
    expect(f.code).toBe("not_found");
    expect(f.message).toContain("'unknown_tag'");
    expect(f.message).toContain("company_facts");
    const s = newSession();
    const r = await fetchOk(s, "sec", { requests: [{ ...unknown, allow_empty: true }, known] });
    expect(csv(s, "sec", "known").length).toBeGreaterThan(0);
    expect(r.notes.some((n: string) => n.includes("unknown_tag") && n.includes("404"))).toBe(true);
  });

  it("a company search without a match is an empty table", async () => {
    const s = newSession();
    const r = await fetchOk(s, "sec", { requests: [
      { name: "nomatch", endpoint: "company_search", params: { text: "Qzxvy Kwrrt Holdings" } },
      { name: "found", endpoint: "company_search", params: { text: "AAPL" } }] });
    expect(csv(s, "sec", "nomatch")).toEqual([]);
    expect(csv(s, "sec", "found").length).toBeGreaterThan(0);
    expect(r.notes.some((n: string) => n.startsWith("nomatch: no SEC filer matched"))).toBe(true);
  });

  it("spells ratio units per endpoint", async () => {
    const s = newSession();
    await fetchOk(s, "sec", { requests: [
      { name: "msft_dividends_ps", endpoint: "company_concept",
        params: { cik: "789019", tag: "CommonStockDividendsPerShareDeclared", unit: "USD-per-shares", forms: "10-K",
          frames_only: true, duration: "annual" } },
      { name: "proforma_eps_2022", endpoint: "frames",
        params: { tag: "BusinessAcquisitionProFormaEarningsPerShareBasic", unit: "USD/shares", period: "CY2022" } }] });
    const dv = csv(s, "sec", "msft_dividends_ps");
    expect(dv.length).toBe(19); // 16 framed years and 3 that SEC left without a frame
    expect([dv[0].end, dv[0].val, dv[0].unit]).toEqual(["2008-06-30", "0.44", "USD/shares"]);
    const fr = csv(s, "sec", "proforma_eps_2022");
    expect(fr.length).toBe(111);
    expect(new Set(fr.map((x) => x.unit))).toEqual(new Set(["USD/shares"]));
    const ad = await adapter();
    expect(ad.unitFor("frames", "shares/USD")).toBe("shares-per-USD");
    expect(ad.unitFor("company_facts", "USD-per-shares")).toBe("USD/shares");
    expect(ad.unitFor("company_concept", "USD")).toBe("USD");
  });

  it("keeps one value per period", async () => {
    const ad = await adapter();
    const fact = (start: string, end: string, val: number, filed: string, frame = "") =>
      ({ tag: "T", unit: "USD", start, end, val, filed, accn: filed, frame, period_days: ad.days(start, end) });
    const rows = [fact("2019-01-01", "2019-12-31", 1, "2020-02-01", "CY2019"),
      fact("2019-01-01", "2019-12-31", 1, "2021-02-01"), // repeated in a later filing
      fact("2020-01-01", "2020-12-31", 2, "2021-02-01"), // no framed fact for 2020
      fact("2020-01-01", "2020-12-31", 3, "2022-02-01"), // restated later: the latest wins
      fact("2021-01-03", "2022-01-01", 4, "2022-02-01"),
      fact("2021-01-01", "2021-12-31", 4, "2023-02-01", "CY2021"), // 52/53-week twin of a framed year
      fact("2022-01-01", "2022-06-30", 5, "2022-08-01"), // 6-month YTD: overlaps, skipped
      fact("2022-04-01", "2022-06-30", 6, "2022-08-01")]; // a quarter: no framed quarter here
    let [out, restored, skipped] = ad.onePerPeriod(rows);
    expect(out.map((x: any) => [x.end, x.val])).toEqual([["2019-12-31", 1], ["2020-12-31", 3], ["2021-12-31", 4]]);
    expect([restored, skipped]).toEqual([1, 2]);
    [out, restored] = ad.onePerPeriod(rows, "quarter"); // a quarterly series takes the quarter
    expect(out.map((x: any) => [x.end, x.val])).toContainEqual(["2022-06-30", 6]);
  });

  it("writes a manual bundle of JSON links", async () => {
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: "sec", spec: SPEC }] });
    const items = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8")).items
      .map((i: any) => [i.name, i]));
    expect(items["margaree_facts#1"].url).toBe("https://data.sec.gov/api/xbrl/companyfacts/CIK0002129664.json");
    expect(items["goodwill_8k#1"].url).toContain("efts.sec.gov");
  });
});
