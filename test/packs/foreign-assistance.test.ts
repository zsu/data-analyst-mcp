/**
 * foreign-assistance: the published files (0.2 to 22 MB) are over the fixture size limit, so the filters are
 * tested on rows from us_foreign_aid_country.csv (downloaded 2026-11-07) through ingest.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as T from "../../src/tools.js";
import { csv, failure, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const EXCERPT = ['"Country Code","Country Name","Region ID","Region Name","Income Group Acronym","Income Group Name","Transaction Type ID","Transaction Type Name","Fiscal Year","current_amount","constant_amount"',
  "UKR,Ukraine,2,Europe and Eurasia,LMIC,Lower Middle Income Country,2,Obligations,2022,20581184045,22661159783",
  "UKR,Ukraine,2,Europe and Eurasia,LMIC,Lower Middle Income Country,2,Obligations,2023,48739359160,51292829203",
  "UKR,Ukraine,2,Europe and Eurasia,LMIC,Lower Middle Income Country,2,Obligations,2025,18006771647,18006771647",
  "ABW,Aruba,6,Western Hemisphere,HIC,High Income Country,2,Obligations,2005,29270,46301"].join("\r\n");

describe("foreign-assistance", () => {
  it("filters a by-country file by country, years and transaction type", async () => {
    const spec = { description: "Ukraine obligations 2022-2024", requests: [{ name: "ukraine", endpoint: "by_country",
      params: { country: "Ukraine", from: "2022", to: "2024", transaction_type: "2" } }] };
    const s = newSession();
    fixtures("foreign-assistance");
    await prepare(s, "foreign-assistance", spec);
    expect((await failure(T.fetchData(s, { source: "foreign-assistance", spec }))).code).toBe("agency_unavailable");
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "fa-up-"));
    fs.writeFileSync(path.join(up, "ukraine.csv"), EXCERPT);
    const r: any = await T.ingest(s, { source: "foreign-assistance", spec, files: [up] });
    expect(r.status).toBe("ok");
    const rows = csv(s, "foreign-assistance", "ukraine");
    expect(rows.map((x) => x["Fiscal Year"])).toEqual(["2022", "2023"]);
    expect(rows[1].current_amount).toBe("48739359160");
  });
});
