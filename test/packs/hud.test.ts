/**
 * hud pack tests (offline), ported from tests/sources/hud/test_hud.py. The fixtures are HUD's documented example
 * responses (https://www.huduser.gov/portal/dataset/fmr-api.html, read 2026-10-20), not live recordings; a fake
 * token is set only so the client takes the keyed route (fixtures are matched by URL).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fakeKeys, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const SPEC = { description: "FMRs for Wallingford town VT (FY2017) and the Washington DC metro; Autauga County AL income limits; Massachusetts FMRs; Virginia counties",
  requests: [
    { name: "wallingford_2017", endpoint: "fmr", params: { entityid: "5002175925", year: 2017 } },
    { name: "dc_metro", endpoint: "fmr", params: { entityid: "METRO47900M47900" } },
    { name: "autauga_il", endpoint: "income_limits", params: { entityid: "0100199999" } },
    { name: "ma_fmr", endpoint: "fmr_state", params: { statecode: "ma" } },
    { name: "va_counties", endpoint: "list_counties", params: { statecode: "VA" } }] };

function workbook(cols: Record<string, string[]>): Uint8Array {
  const names = Object.keys(cols);
  const aoa = [names, ...cols[names[0]].map((_, i) => names.map((n) => cols[n][i]))];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

describe("hud", () => {
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k === "HUD_USER_TOKEN") delete process.env[k];
  });

  it("fetch without a token asks for setup", async () => {
    const s = newSession();
    fixtures("hud");
    await prepare(s, "hud", SPEC);
    const f = await failure(T.fetchData(s, { source: "hud", spec: SPEC }));
    expect(f.code).toBe("key_missing");
    expect(JSON.stringify(f)).toContain("HUD_USER_TOKEN");
  });

  it("check with a token: the spec is valid", async () => {
    await fakeKeys("hud");
    expect(gr.checkSpec(await load("hud"), SPEC)).toEqual([]);
  });

  it("fetches the documented examples", async () => {
    const [env] = await fakeKeys("hud", "placeholder-not-a-real-token");
    expect(env).toBe("HUD_USER_TOKEN");
    const s = newSession();
    const r = await fetchOk(s, "hud", SPEC);
    expect(r.status).toBe("ok");
    const w = csv(s, "hud", "wallingford_2017");
    expect(w.length).toBe(1);
    expect([w[0].town_name, w[0].year, w[0]["Two-Bedroom"]]).toEqual(["Wallingford town", "2017", "948.0"]);
    const dc = csv(s, "hud", "dc_metro");
    expect(dc.map((x) => x.zip_code)).toEqual(["MSA level", "20001", "20002", "20003"]);
    expect(dc[0]["Two-Bedroom"]).toBe("2045");
    const il = csv(s, "hud", "autauga_il");
    expect([il[0].median_income, il[0].il50_p4, il[0].il30_p1, il[0].il80_p8]).toEqual(["65900", "32950", "13850", "69600"]);
    const ma = csv(s, "hud", "ma_fmr");
    expect(ma.map((x) => x.area_type)).toEqual(["metro", "metro", "county", "county"]);
    expect(ma[2].fips_code).toBe("2502300170");
    expect(csv(s, "hud", "va_counties")[0].fips_code).toBe("5100199999");
    const raw = fs.readFileSync(path.join(s.workspace, "data", "hud", "README.md"), "utf8");
    expect(raw).not.toContain("placeholder-not-a-real-token");
  });

  it("a five-digit FIPS is refused", async () => {
    const bad = { requests: [{ name: "x", endpoint: "fmr", params: { entityid: "51001" } }] };
    expect(gr.checkSpec(await load("hud"), bad).length).toBeGreaterThan(0);
  });

  it("manual items need the token header", async () => {
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: "hud", spec: SPEC }] });
    expect(r.status).toBe("ok");
    const items = JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8")).items;
    expect(items.every((i: any) => i.needs_key && i.key_header === "Authorization" && i.key_prefix === "Bearer ")).toBe(true);
    expect(items.map((i: any) => i.url.split("public")[1])[3]).toContain("/fmr/statedata/MA");
  });

  it("ingests the published FMR workbooks (one with a malformed core.xml date)", async () => {
    const spec = { description: "One metro's FMRs from the published workbooks",
      requests: [{ name: "metro_fy2022", endpoint: "fmr", params: { entityid: "METRO19740M19740", year: 2022 } },
        { name: "metro_fy2027", endpoint: "fmr", params: { entityid: "METRO19740M19740", year: 2027 } }] };
    const metro = ["METRO19740M19740", "METRO19740M19740", "METRO33860M33860"];
    const fips = ["0800199999", "0800599999", "0100199999"];
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "hud-up-"));
    fs.writeFileSync(path.join(up, "metro_fy2022.xlsx"), workbook({ fips2010: fips, fmr_2: ["1530", "1530", "786"],
      metro_code: metro, areaname: ["Denver-Aurora-Lakewood, CO HUD Metro FMR Area", "Denver-Aurora-Lakewood, CO HUD Metro FMR Area",
        "Montgomery, AL MSA"] }));
    const z = unzipSync(workbook({ stusps: ["CO", "CO", "AL"], hud_area_code: metro, fips, fmr_2: ["1915", "1915", "1021"] }));
    // HUD's malformed date, as in FY26_FMRs_revised.xlsx
    const core = z["docProps/core.xml"] ? strFromU8(z["docProps/core.xml"]).split("<dcterms:created")[0]
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">';
    z["docProps/core.xml"] = strToU8(core + '<dcterms:modified xsi:type="dcterms:W3CDTF">2026- 2-19T18:17:31Z</dcterms:modified></cp:coreProperties>');
    fs.writeFileSync(path.join(up, "metro_fy2027.xlsx"), zipSync(z));

    const s = newSession();
    fixtures("hud");
    await prepare(s, "hud", spec);
    const r: any = await T.ingest(s, { source: "hud", spec, files: [up] });
    expect(r.status).toBe("ok");
    const a22 = csv(s, "hud", "metro_fy2022"), a27 = csv(s, "hud", "metro_fy2027");
    expect(a22.map((x) => [x.fips2010, x.fmr_2])).toEqual([["0800199999", "1530"], ["0800599999", "1530"]]);
    expect(new Set(a27.map((x) => x.fmr_2))).toEqual(new Set(["1915"]));
    // a workbook with no row for the requested entity is refused, not passed through
    const bad = { ...spec, requests: [{ ...spec.requests[0], params: { entityid: "METRO99999M99999", year: 2022 } }] };
    const s2 = newSession();
    await prepare(s2, "hud", bad);
    const f = await failure(T.ingest(s2, { source: "hud", spec: bad, files: [path.join(up, "metro_fy2022.xlsx")] }));
    expect(JSON.stringify(f)).toContain("no row for entity id METRO99999M99999");
  });
});
