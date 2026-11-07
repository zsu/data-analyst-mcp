/**
 * philfed pack (Philadelphia Fed Real-Time Data Research Center workbooks), ported from tests/sources/philfed/test_philfed.py.
 * Fixtures recorded live from www.philadelphiafed.org (keyless) on 2026-10-30: three complete workbooks, the HTML
 * "Error - 404" page served with HTTP 200 for a missing file, and trimmed real copies of four larger workbooks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const SRC = "philfed";
const FX = path.join(TEST_DIR, "packs", SRC, "fixtures");
const SPEC = { description: "SPF real GDP outlook (2026:Q3 survey), CPI, dispersion, Anxious Index, Greenbook, Livingston, " +
  "real GDP vintages",
requests: [
  { name: "rgdp_level", endpoint: "spf", params: { file: "medianLevel", sheet: "RGDP" } },
  { name: "rgdp_growth", endpoint: "spf", params: { file: "medianGrowth", sheet: "RGDP" } },
  { name: "cpi", endpoint: "spf", params: { file: "medianLevel", sheet: "CPI" } },
  { name: "rgdp_disp", endpoint: "spf_dispersion", params: { measure: 2, sheet: "RGDP" } },
  { name: "recess", endpoint: "spf_prob", params: { sheet: "RECESS" } },
  { name: "gb_rgdp", endpoint: "greenbook", params: { sheet: "gRGDP" } },
  { name: "liv_cpi", endpoint: "livingston", params: { file: "medians", sheet: "CPI" } },
  { name: "rgdp_vintages", endpoint: "rtdsm", params: { file: "real_gdp" } }] };

beforeAll(() => isolate());

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  return failure(T.fetchData(s, { source: SRC, spec }));
}

describe("philfed", () => {
  it("the spec is valid (api route)", async () => {
    expect(gr.checkSpec(await load(SRC), SPEC)).toEqual([]);
  });

  it("fetches every workbook", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.summary.route).toBe("api");
    const lv = csv(s, SRC, "rgdp_level");
    const last = lv[lv.length - 1];
    expect([last.survey, last.RGDP1, last.RGDPA, last.RGDPB]).toEqual(["2026Q3", "24270.6000", "24359.0924", "24886.3000"]);
    expect(lv[0].survey).toBe("1968Q4");
    const g = csv(s, SRC, "rgdp_growth");
    expect(Object.keys(g[0]).slice(0, 4)).toEqual(["survey", "YEAR", "QUARTER", "drgdp2"]);
    expect([g[g.length - 1].survey, g[g.length - 1].drgdp2]).toEqual(["2026Q3", "2.4624"]); // release: 2.5 percent
    expect(g[1].drgdp6).toBe(""); // "#N/A" -> empty
    const cpi = csv(s, SRC, "cpi");
    expect(cpi[cpi.length - 1].CPIA).toBe("3.5610"); // Q4/Q4 2026: 3.6
    const d = csv(s, SRC, "rgdp_disp");
    expect([d[d.length - 1]["Survey_Date(T)"], d[d.length - 1]["RGDP_D2(T)"]]).toEqual(["2026Q3", "1.2909"]);
    const rc = csv(s, SRC, "recess").pop()!;
    expect([rc.survey, rc.RECESS2]).toEqual(["2026Q3", "19.9667"]);
    const gb = csv(s, SRC, "gb_rgdp").pop()!;
    expect([gb.greenbook_date, gb.DATE, gb.gRGDPF0]).toEqual(["2020-12-04", "2020.4", "5"]);
    const liv = csv(s, SRC, "liv_cpi").pop()!;
    expect([liv.survey_date, liv.Date, liv.CPI_10Y]).toEqual(["2026-06-01", "46174", "2.33"]);
    const q = Object.fromEntries(csv(s, SRC, "rgdp_vintages").map((x) => [x.DATE, x]));
    const base = [1, 2, 3, 4].map((i) => Number(q[`2025:Q${i}`].ROUTPUT26Q3));
    expect(q["2026:Q2"].ROUTPUT26Q3).toBe(last.RGDP1); // the SPF's information set
    const growth = (Number(last.RGDPA) / (base.reduce((a, b) => a + b, 0) / 4) - 1) * 100;
    expect(Math.round(growth * 10) / 10).toBe(2.1); // SPF release 2026:Q3: 2.1
  });

  it("the HTML 404 page is a clear error", async () => {
    const f = await fetchFail({ requests: [{ name: "bad", endpoint: "rtdsm", params: { file: "ROUTPUTQvQx" } }] });
    expect(f.message).toContain("Error - 404");
    expect(f.message).toContain("file name");
    const ad = (await load(SRC)).adapter!;
    expect(ad.checkError!(200, Buffer.from("PK\x03\x04 workbook bytes", "latin1"))).toBeNull();
  });

  it("a wrong sheet lists the sheets", async () => {
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "spf", params: { file: "medianGrowth", sheet: "rgdp" } }] });
    expect(f.message).toContain("RGDP");
  });

  it("a bad spec is invalid_request", async () => {
    for (const p of [{ file: "medianlevels", sheet: "RGDP" }, { file: "medianLevel" }]) {
      expect((await fetchFail({ requests: [{ name: "x", endpoint: "spf", params: p }] })).code).toBe("invalid_request");
    }
    expect((await fetchFail({ requests: [{ name: "x", endpoint: "spf_dispersion", params: { measure: 4, sheet: "RGDP" } }] })).code)
      .toBe("invalid_request");
  });

  it("catalog alias and manual links", async () => {
    const b: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec: SPEC }] });
    const urls = Object.fromEntries(b.items.map((i: any) => [i.filename.replace(/\.[^.]+$/, ""), i.url]));
    expect(urls.rgdp_vintages.endsWith("/real-time-data/data-files/xlsx/ROUTPUTQvQd.xlsx")).toBe(true);
    expect(urls.rgdp_disp.endsWith("/historical-data/Dispersion_2.xlsx")).toBe(true);
    const names = new Set(b.items.map((i: any) => i.filename));
    expect(names.has("rgdp_level.xlsx") && names.has("gb_rgdp.xlsx")).toBe(true);
    const hits = gr.searchCatalog(await load(SRC), "unemployment");
    expect(hits.map((h) => h.alias)).toContain("unemployment");
  });

  it("ingests an uploaded workbook", async () => {
    const spec = { requests: [{ name: "rgdp_growth", endpoint: "spf", params: { file: "medianGrowth", sheet: "RGDP" } }] };
    const s = newSession();
    delete process.env.DATA_ANALYST_FIXTURES;
    await prepare(s, SRC, spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "philfed-up-"));
    fs.copyFileSync(path.join(FX, "spf_medianGrowth.xlsx"), path.join(up, "rgdp_growth.xlsx"));
    await T.ingest(s, { source: SRC, spec, files: [up] });
    const rows = csv(s, SRC, "rgdp_growth");
    expect([rows[rows.length - 1].survey, rows[rows.length - 1].drgdp2]).toEqual(["2026Q3", "2.4624"]);
  });
});
