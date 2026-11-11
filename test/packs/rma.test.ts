/**
 * rma: the reinsurance workbooks are recorded (2026-11-11). The Summary of Business zips (3 MB a year) are over
 * the fixture size limit, so coverage is tested on lines of sobcov_2024.txt (downloaded 2026-11-11), zipped and
 * read through ingest: the same reader as fetch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/rma.js";
import { tsvRecords } from "../../src/core/tabular.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const LINES = [
  "2024|19|IA|001|Adair                         |0041|Corn                          |05|ARP       |A    |RBUP|.9000|1|1|0|1|0|Acres                    |12|0|8084|684|301|0|0|0|0|.00",
  "2024|19|IA|001|Adair                         |0041|Corn                          |88|ECO-RP    |A    |RBUP|.9500|23|18|0|79|0|Acres                    |0|8644|636513|354983|156189|0|0|0|0|.00",
  "2024|19|IA|001|Adair                         |0081|Soybeans                      |05|ARP       |A    |RBUP|.9000|1|1|0|1|0|Acres                    |91|0|46364|3385|1489|0|0|0|0|.00",
  "2024|31|NE|001|Adams                         |0041|Corn                          |88|ECO-RP    |A    |RBUP|.9500|9|9|7|45|32|Acres                    |0|2734|269619|136573|60091|0|0|0|85031|.62",
  "2024|01|AL|083|Limestone                     |0081|Soybeans                      |02|RP        |A    |RBUP|.6000|2|1|1|1|1|Acres                    |237|0|101016|2616|1953|0|0|0|-6461|-2.47",
];

describe("rma", () => {
  it("reads the reinsurance results by fund, without the footnotes", async () => {
    const s = newSession();
    const r: any = await fetchOk(s, "rma", { description: "SRA 2024", requests: [
      { name: "sra", endpoint: "reinsurance", params: { year: "2024", level: "National" } },
      { name: "sra_st", endpoint: "reinsurance", params: { year: "2024", level: "State", state: ["ia", "NE"] } }] });
    expect(r.status).toBe("ok");
    const nat = csv(s, "rma", "sra");
    expect(nat.map((x) => x.Fund)).toEqual(["A", "C", "Total"]);
    expect(Object.keys(nat[0])[0]).toBe("Fund");
    expect(nat[2]["Gross Premium"]).toBe("15897885302");
    expect(nat[2]["Net Gain/(Loss) *"]).toBe("1809401390.555");
    const st = csv(s, "rma", "sra_st");
    expect(st.map((x) => `${x.State} ${x.Fund}`)).toEqual(["IA A", "IA C", "NE A", "NE C"]);
  });

  it("names the Summary of Business fields and filters by state, crop and plan", async () => {
    const spec = { description: "Iowa corn 2024", requests: [{ name: "ia_corn", endpoint: "coverage",
      params: { year: "2024", state: "19", commodity: "corn", plan: ["ARP", "88"] } }] };
    const s = newSession();
    fixtures("rma");
    await prepare(s, "rma", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "rma-up-"));
    fs.writeFileSync(path.join(up, "sobcov_2024.zip"), zipSync({ "sobcov_2024.txt": Buffer.from(LINES.join("\r\n") + "\r\n") }));
    const r: any = await T.ingest(s, { source: "rma", spec, files: [up] });
    expect(r.status).toBe("ok");
    const rows = csv(s, "rma", "ia_corn");
    expect(rows.map((x) => x["Insurance Plan Name Abbreviation"])).toEqual(["ARP", "ECO-RP"]);
    expect(rows[1]).toMatchObject({ "Location County Name": "Adair", "Commodity Code": "0041", "Coverage Level": ".9500",
      "Endorsed/Companion Acres": "8644", "Liability Amount": "636513", "Total Premium Amount": "354983",
      "Subsidy Amount": "156189", "Indemnity Amount": "0", "Loss Ratio": ".00" });
  });

  it("keeps negative indemnities and refuses a layout with more fields", () => {
    const rows = adapter.normalize!({ name: "x", endpoint: "coverage", params: { state: "AL" } }, {},
      [{ "Location State Abbreviation": "AL", "Indemnity Amount": "-6461" }, { "Location State Abbreviation": "IA" }]);
    expect(rows).toEqual([{ "Location State Abbreviation": "AL", "Indemnity Amount": "-6461" }]);
    expect(tsvRecords({ delimiter: "|", columns: ["a", "b"] }, "1|2\n\n3|4\n")).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
    expect(() => tsvRecords({ delimiter: "|", columns: ["a", "b"] }, "1|2|3\n")).toThrow(/3 fields, the layout names 2/);
  });

  it("checks the year and level", async () => {
    const s = newSession();
    const spec = { description: "bad", requests: [{ name: "x", endpoint: "reinsurance", params: { year: "24", level: "county" } }] };
    const f = await failure(fetchOk(s, "rma", spec));
    expect(f.message).toMatch(/4-digit year/);
    expect(f.message).toMatch(/National or State/);
  });
});
