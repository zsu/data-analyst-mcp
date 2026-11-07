/**
 * onrr: the published files (0.5 to 42 MB) are over the fixture size limit, so the filters are tested on rows
 * from fiscal_year_revenue.csv and monthly_revenue.csv (downloaded 2026-11-07) through ingest and normalize.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/onrr.js";
import * as T from "../../src/tools.js";
import { csv, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

describe("onrr", () => {
  it("filters revenue by state, year and type", async () => {
    const spec = { description: "Louisiana royalties FY2004", requests: [{ name: "la", endpoint: "fiscal_year_revenue",
      params: { state: "louisiana", from: "2004", to: "2004", revenue_type: "Royalties" } }] };
    const s = newSession();
    fixtures("onrr");
    await prepare(s, "onrr", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "onrr-up-"));
    fs.writeFileSync(path.join(up, "la.csv"), ["Fiscal Year,Land Class,Land Category,State,County,FIPS Code,Offshore Region,Revenue Type,Mineral Lease Type,Commodity,Product,Revenue",
      '2004,Federal,Onshore,Louisiana,Rapides,"22079","",Royalties,Oil & Gas,Gas,Unprocessed (Wet) Gas,81801.64',
      '2004,Native American,Onshore,"","","","",Royalties,Sand & Gravel,Sand & gravel,Sand/Gravel-Cubic Yards,417488.19',
      '2005,Federal,Onshore,Louisiana,Rapides,"22079","",Royalties,Oil & Gas,Gas,Unprocessed (Wet) Gas,9.00'].join("\r\n"));
    const r: any = await T.ingest(s, { source: "onrr", spec, files: [up] });
    expect(r.status).toBe("ok");
    const rows = csv(s, "onrr", "la");
    expect(rows.length).toBe(1);
    expect(rows[0]["FIPS Code"]).toBe("22079");
  });

  it("reads the year of a monthly Date", () => {
    const rows = [{ Date: "01/01/2003", State: "California" }, { Date: "01/01/2024", State: "California" }];
    expect(adapter.normalize!({ name: "m", endpoint: "monthly_revenue", params: { from: "2020" } }, {}, rows).length).toBe(1);
  });
});
