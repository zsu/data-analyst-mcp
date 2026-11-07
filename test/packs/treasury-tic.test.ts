/**
 * treasury-tic: fixtures r001 (slt_table5.txt) and r002 (mfhhis01.txt) were recorded from ticdata.treasury.gov on
 * 2026-11-07. slt_table1.txt (about 1 MB) is over the fixture size limit, so its reader is tested on an excerpt.
 */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/treasury-tic.js";
import { tsvRecords } from "../../src/core/tabular.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

describe("treasury-tic", () => {
  it("fetches the latest 13 months and the history", async () => {
    const s = newSession();
    const r = await fetchOk(s, "treasury-tic", { description: "Major foreign holders, latest and China 2005", requests: [
      { name: "mfh_latest", endpoint: "major_foreign_holders" },
      { name: "china_2005", endpoint: "major_foreign_holders_history",
        params: { country: "China, Mainland", from: "2005-01", to: "2005-12", include_comparison: true } }] });
    expect(r.status).toBe("ok");
    const latest = csv(s, "treasury-tic", "mfh_latest");
    expect(latest.length).toBe(25 * 13);
    expect(latest[0]).toEqual({ country: "Japan", kind: "country", period: "2026-08", holdings_billions: "1068.3" });
    expect(latest.find((x) => x.country === "Grand Total" && x.period === "2026-08")!.holdings_billions).toBe("9331.7");
    expect(latest.filter((x) => x.kind === "foreign_official").length).toBe(3 * 13);
    const china = csv(s, "treasury-tic", "china_2005");
    expect(china.length).toBe(13); // 12 months plus the comparison-only June
    expect(china.find((x) => x.period === "2005-01")!.holdings_billions).toBe("223.5"); // January, one line up
    const june = china.filter((x) => x.period === "2005-06");
    expect(june.map((x) => [x.holdings_billions, x.comparison_only])).toEqual([["298.0", "False"], ["243.3", "True"]]);
    expect(r.citation.text).toContain("Treasury International Capital");
  });

  it("reads SLT table 1 and filters by name, code and month", () => {
    const text = [
      "Table 1: U.S. Long-Term Securities Held by Foreign Residents", "All Countries", "note", "Millions of dollars",
      "Link: x", "", "\t\t\tTotal U.S. Securities", "Country\tCountry Code\tDate\tHoldings",
      "country\tcountry_code\tdate\tfor_lt_total_pos\tfor_lt_treas_pos",
      "Austria\t10189\t2026-08\t53564\t3881", "Japan\t42609\t2026-08\t3055500\t1036972",
      "Japan\t42609\t2025-12\t2900000\t1000000", "", "for_lt_corp_net: 19 + 23 - 18 - 22"].join("\n");
    const rows = tsvRecords({ header_row: 9 }, text);
    const norm = (params: any) => adapter.normalize!({ name: "t", endpoint: "holdings_by_country", params }, {}, rows);
    expect(norm({}).length).toBe(3);
    expect(norm({ country: "japan", from: "2026-01" }).map((r) => r.for_lt_treas_pos)).toEqual(["1036972"]);
    expect(norm({ country: ["10189"] }).map((r) => r.country)).toEqual(["Austria"]);
  });

  it("refuses a malformed month", () => {
    const probs = adapter.checkSpec!({ requests: [{ name: "x", endpoint: "holdings_by_country", params: { from: "2026" } }] },
      null as any);
    expect(probs[0]).toContain("YYYY-MM");
  });
});
