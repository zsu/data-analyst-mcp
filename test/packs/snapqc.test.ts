/**
 * snapqc pack (SNAP Quality Control public-use files), ported from tests/sources/snapqc/test_snapqc.py. Fixtures
 * downloaded from snapqcdata.net on 2026-10-31: the /datafiles listing pages 0-2, qcfy2024_csv.zip with only the
 * Guam and Virgin Islands rows (475 of 44,891; header and values unchanged), and the reweighted FY 2018 file with
 * only the Guam rows.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import { readCsv } from "../../src/core/tabular.js";
import { csvCandidates, Database, ids, listingFiles, pickCsv, resolveVars, summaryRows } from "../../src/adapters/snapqc.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "snapqc", "fixtures");
const SPEC = { description: "SNAP QC FY 2024: weighted totals; Virgin Islands units and participants", requests: [
  { name: "totals", endpoint: "summary", params: { fiscal_year: 2024 } },
  { name: "vi_units", endpoint: "units", params: { fiscal_year: 2024, state: "VI", variables: ["FSUSIZE", "FSBEN", "AGE*"] } },
  { name: "vi_people", endpoint: "persons", params: { fiscal_year: 2024, state: "Virgin Islands", person_variables: ["AGE", "SEX"],
    participants_only: true } }] };

function fixtureRows(name: string): Record<string, string>[] {
  const z = unzipSync(fs.readFileSync(path.join(FX, name)));
  return readCsv(Buffer.from(Object.values(z)[0]).toString("latin1")) as Record<string, string>[];
}

/** The fixture zip with edit(csv text) -> csv text applied to its CSV. */
function rezip(name: string, edit: (t: string) => string): Uint8Array {
  const z = unzipSync(fs.readFileSync(path.join(FX, name)));
  const out: Record<string, Uint8Array> = {};
  for (const [n, d] of Object.entries(z)) out[n] = Buffer.from(edit(Buffer.from(d).toString("latin1")), "latin1");
  return zipSync(out);
}

function scaleFirstFywgt(text: string): string {
  const lines = text.split("\n");
  const head = lines[0].split(",");
  const j = head.indexOf("FYWGT");
  const cells = lines[1].split(",");
  cells[j] = String(Number(cells[j]) * 1.01);
  lines[1] = cells.join(",");
  return lines.join("\n");
}

const near = (a: number, b: number, places: number) => expect(Math.abs(Math.round((a - b) * 10 ** places))).toBe(0);
const header = (s: any, name: string) =>
  fs.readFileSync(path.join(s.workspace, "data", "snapqc", `${name}.csv`), "utf8").split(/\r?\n/)[0].split(",");

beforeAll(() => isolate());

describe("snapqc", () => {
  it("the spec is valid (api route)", async () => {
    expect(gr.checkSpec(await load("snapqc"), SPEC)).toEqual([]);
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "snapqc", SPEC);
    expect(r.status).toBe("ok");
    const raw = fixtureRows("qcfy2024_csv_GU_VI.zip");
    const tot = new Map(csv(s, "snapqc", "totals").map((x) => [`${x.state_abbr}|${x.measure}`, x]));
    // weighted from the file itself: units = sum FYWGT, persons = sum FYWGT x FSUSIZE, benefits = sum FYWGT x FSBEN
    for (const [abbr, fips, n] of [["GU", "66", 197], ["VI", "78", 278]] as const) {
      const rs = raw.filter((x) => x.STATE === fips);
      expect(Number(tot.get(`${abbr}|units`)!.sample_units)).toBe(n);
      near(Number(tot.get(`${abbr}|units`)!.value), rs.reduce((a, x) => a + Number(x.FYWGT), 0), 2);
      near(Number(tot.get(`${abbr}|persons`)!.value), rs.reduce((a, x) => a + Number(x.FYWGT) * Number(x.FSUSIZE), 0), 2);
      near(Number(tot.get(`${abbr}|benefits`)!.value), rs.reduce((a, x) => a + Number(x.FYWGT) * Number(x.FSBEN), 0), 1);
    }
    expect(Number(tot.get("US|units")!.sample_units)).toBe(475);
    const notes = r.notes.join(" ");
    // a trimmed file cannot match the tech doc's national totals: the note says so instead of passing silently
    expect(notes).toContain("U.S. totals differ from FY 2024 Technical Documentation");
    const units = csv(s, "snapqc", "vi_units");
    expect(units.length).toBe(278);
    expect(header(s, "vi_units").slice(0, 9)).toEqual(["fiscal_year", "database", "HHLDNO", "STATE", "STATENAME", "YRMONTH",
      "HWGT", "FYWGT", "state_abbr"]);
    expect(units[0]).toHaveProperty("AGE18"); // FY 2024 has 18 person slots
    expect(new Set(units.map((x) => x.state_abbr))).toEqual(new Set(["VI"]));
    const people = csv(s, "snapqc", "vi_people");
    expect(people.length).toBe(units.reduce((a, x) => a + Number(x.FSUSIZE), 0)); // FSAFIL = 1 rows = FSUSIZE
    expect(header(s, "vi_people").slice(-5)).toEqual(["FSBEN", "person", "FSAFIL", "AGE", "SEX"]);
  });

  it("a reissued year takes the latest upload", async () => {
    const s = newSession();
    const r = await fetchOk(s, "snapqc", { requests: [{ name: "s18", endpoint: "summary", params: { fiscal_year: 2018, state: "GU" } }] });
    const notes = r.notes.join(" ");
    expect(notes).toContain("2020-07/qcfy2018_csv.zip");
    expect(notes).toContain("used the latest upload, /sites/default/files/2020-08/qcfy2018_csv_0.zip");
    const gu = Object.fromEntries(csv(s, "snapqc", "s18").map((x) => [x.measure, x]));
    near(Number(gu.units.value), fixtureRows("qcfy2018_csv_0_GU.zip").reduce((a, x) => a + Number(x.FYWGT), 0), 2);
  });

  it("reads the listing", () => {
    const rows = [0, 1, 2].flatMap((i) => listingFiles(fs.readFileSync(path.join(FX, `datafiles_p${i}.html`), "utf8")));
    expect([...new Set(rows.map((r) => r.year))].sort((a, b) => b - a).slice(0, 11)).toEqual(Array.from({ length: 11 }, (_, i) => 2024 - i));
    for (const [db, p] of [["qcfy2020", "/2022-12/qcfy2020_csv.zip"], ["qcfy2020_per1", "/2022-12/qcfy2020_per1_csv.zip"],
      ["qcfy2020_per2", "/2022-12/qcfy2020_per2_csv.zip"]]) {
      const [hit, notes] = pickCsv(csvCandidates(rows, 2020, db), db);
      expect(hit.path.endsWith(p)).toBe(true);
      expect(notes).toEqual([]);
    }
    expect(csvCandidates(rows, 2013, "qcfy2013")).toEqual([]); // no CSV before FY 2014
    const two = csvCandidates(rows, 2018, "qcfy2018").map((r) => ({ ...r, path: r.path.replace("2020-07", "2020-08") }));
    expect(() => pickCsv(two, "qcfy2018")).toThrow(/not guessing/);
  });

  it("gates every read", () => {
    const keep = (h: string[]) => [...ids(h), "FSUSIZE", "FSBEN"];
    const ok = rezip("qcfy2024_csv_GU_VI.zip", (t) => t);
    expect(new Database(ok, 2024, "qcfy2024", keep).rows.length).toBe(475);
    // Python's t.replace("\n", "\n1,", 2).replace("\n1,", "\n", 1): the second data row gets one field too many
    const longRow = (t: string) => {
      const a = t.indexOf("\n"), b = t.indexOf("\n", a + 1);
      return t.slice(0, b + 1) + "1," + t.slice(b + 1);
    };
    const cases: [(t: string) => string, RegExp][] = [
      [longRow, /fields, the header/],
      [(t) => t.replace(",202401,", ",202501,"), /outside FY 2024/],
      [(t) => t.replaceAll(",FYWGT,", ",FYWGTX,"), /lacks/],
    ];
    for (const [edit, words] of cases) {
      expect(() => new Database(rezip("qcfy2024_csv_GU_VI.zip", edit), 2024, "qcfy2024", keep)).toThrow(words);
    }
    expect(() => new Database(ok, 2023, "qcfy2023", keep)).toThrow(/should hold one qc_pub_fy2023.csv/); // the wrong year's zip
    expect(() => resolveVars(["FSBEN", "NOPE"], ["FSBEN"], [], 2024)).toThrow(/not in the FY 2024 file: NOPE/);
    // summary: HWGT / the state's sample months must be FYWGT in a full-year file
    const bad = rezip("qcfy2024_csv_GU_VI.zip", scaleFirstFywgt);
    expect(() => summaryRows(new Database(bad, 2024, "qcfy2024", keep), null, null)).toThrow(/differs from FYWGT on 1 rows/);
  });

  it("checks the spec", async () => {
    const p = await load("snapqc");
    for (const [params, words] of [[{ fiscal_year: 2012 }, "CSV files exist from FY 2014"], [{ fiscal_year: 2024, period: "per1" }, "FY 2020 only"],
      [{ fiscal_year: 2024, state: "PR" }, "not one of the 53"], [{ fiscal_year: 2024, month: 202312 + 100 }, "inside FY 2024"],
      [{ fiscal_year: 2024, variables: ["FS-BEN"] }, "not a variable name"]] as const) {
      expect(gr.checkSpec(p, { requests: [{ name: "x", endpoint: "units", params }] }).join(" ")).toContain(words);
    }
    const f = await failure(fetchOk(newSession(), "snapqc", { requests: [{ name: "x", endpoint: "units",
      params: { fiscal_year: 2024, variables: ["FSBEN", "EITC*"] } }] }));
    expect(f.message).toContain("not in the FY 2024 file: EITC*"); // EITCi was dropped in FY 2024
  });

  it("manual bundle and ingest", async () => {
    const spec = { requests: SPEC.requests.slice(1, 2) };
    const s = newSession();
    const b: any = await T.manualBundle(s, { sources: [{ source: "snapqc", spec }] });
    expect(b.items.map((i: any) => i.filename)).toEqual(["vi_units_qcfy2024_csv.zip"]);
    expect(b.items[0].url).toBe("https://snapqcdata.net/sites/default/files/2026-08/qcfy2024_csv.zip");
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "up-"));
    fs.copyFileSync(path.join(FX, "qcfy2024_csv_GU_VI.zip"), path.join(up, "vi_units_qcfy2024_csv.zip"));
    delete process.env.DATA_ANALYST_FIXTURES; // the ingest reads no network
    await prepare(s, "snapqc", spec);
    const r: any = await T.ingest(s, { source: "snapqc", spec, files: [up] });
    expect(r.status).toBe("ok");
    expect(csv(s, "snapqc", "vi_units").length).toBe(278);
  });
});
