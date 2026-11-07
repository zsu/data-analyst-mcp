/** fed-board: ported from the Python skill's tests/sources/fed-board/test_fed_board.py (same fixtures, specs and values). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const FX = path.join(TEST_DIR, "packs", "fed-board", "fixtures");
const SPEC = { description: "G.19 consumer credit (SA), SLOOS, G.19 packages, B.101 from the Z.1 zip, SCF chart data and Table 4",
  requests: [
    { name: "g19_sa", endpoint: "ddp", params: { rel: "G19", package: "Consumer Credit Outstanding (S.A.)", from: "2025-01" } },
    { name: "sloos", endpoint: "ddp", params: { package: "sloos", lastobs: 4 } },
    { name: "g19_pkgs", endpoint: "ddp_packages", params: { rel: "G19" } },
    { name: "b101", endpoint: "z1", params: { table: "B.101", start: "2025", series_ids: ["FL152090005", "FL152000005.Q"] } },
    { name: "z1_tables", endpoint: "z1_tables", params: {} },
    { name: "race_median", endpoint: "scf_chart", params: { group: "racecl4", stat: "median" } },
    { name: "table4", endpoint: "scf_table", params: { file: "scf2025_tables_public_real_historical", sheet: "Table 4" } }] };

beforeAll(() => isolate());

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures("fed-board");
  await prepare(s, "fed-board", spec);
  return failure(T.fetchData(s, { source: "fed-board", spec }));
}

describe("fed-board", () => {
  it("fetches DDP packages, Z.1, SCF chart data and tables on the api route", async () => {
    const s = newSession();
    const r = await fetchOk(s, "fed-board", SPEC);
    expect(r.summary.route).toBe("api");
    const g = csv(s, "fed-board", "g19_sa");
    expect(Object.keys(g[0])).toEqual(["date", "series", "value", "value_flag", "description", "unit", "multiplier", "currency", "unique_id"]);
    expect(g.map((x) => x.date).sort()[0]).toBe("2025-01");
    const tot = g.filter((x) => x.series === "DTCTL.M");
    const last = tot[tot.length - 1];
    expect([last.date, last.value, last.unit, last.multiplier]).toEqual(["2026-08", "5196778.44", "Currency", "1000000"]);
    expect(last.unique_id).toBe("G19/CCOUT/DTCTL.M");
    expect(last.description).toContain("seasonally adjusted level");
    const sl = csv(s, "fed-board", "sloos");
    const dates = [...new Set(sl.map((x) => x.date))].sort();
    expect(dates.slice(-4)).toEqual(["2025Q4", "2026Q1", "2026Q2", "2026Q3"]);
    expect(dates.length).toBe(4); // lastobs applied per series
    const pk = csv(s, "fed-board", "g19_pkgs");
    expect(pk.length).toBe(7);
    expect([pk[0].package_title, pk[0].package]).toEqual(["Consumer Credit Outstanding - All", "56a37b655eef16e2ede83467282a6e95"]);
    const b = csv(s, "fed-board", "b101");
    const nw = b.filter((x) => x.series === "FL152090005.Q");
    const n = nw[nw.length - 1];
    expect([n.date, n.value, n.line, n.table, n.table_published]).toEqual(["2026:Q2", "195870496", "42", "S1M.b", "B.101"]);
    expect(new Set(b.map((x) => x.series))).toEqual(new Set(["FL152090005.Q", "FL152000005.Q"]));
    expect(b.map((x) => x.date).sort()[0]).toBe("2025:Q1");
    expect(nw[0].units).toContain("Millions of dollars");
    expect(csv(s, "fed-board", "z1_tables")).toContainEqual({ new: "S1M.b", old: "B.101", title: "Households and nonprofit organizations" });
    const rm = csv(s, "fed-board", "race_median");
    expect(rm.filter((x) => x.year === "2025").map((x) => x.Category)).toEqual(["White, non-Hispanic", "Black, non-Hispanic", "Hispanic", "Other"]);
    const allf = csv(s, "fed-board", "table4").find((x) => x.c1 === "All families")!;
    expect([allf.row, allf.c26, allf.c27]).toEqual(["6", "216.1", "1232"]); // 2025 median, mean
  });

  it("a catalog alias carries its release; manual links; catalog search", async () => {
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: "fed-board", spec: SPEC }] });
    const items = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8")).items
      .map((i: any) => [i.name.split("#")[0], i]));
    expect(items.sloos.url).toBe("https://www.federalreserve.gov/datadownload/Output.aspx?rel=SLOOS&series=" +
      "e64f07187815f0e7ed89237d8cb91eeb&filetype=csv&label=include&layout=seriescolumn&type=package");
    expect(items.g19_sa.url).toContain("Choose.aspx?rel=G19");
    expect(items.g19_sa.note).toContain("Consumer Credit Outstanding (S.A.)");
    expect(items.b101.url.endsWith("/releases/z1/current/z1_csv_files.zip")).toBe(true);
    const found: any = await T.requestSchema(s, { source: "fed-board", search: "consumer credit" });
    expect(found.results.map((h: any) => h.alias)).toContain("g19_sa");
  });

  it("an ambiguous title, an unknown package id and an unknown release fail with the reason", async () => {
    expect((await fetchFail({ requests: [{ name: "x", endpoint: "ddp", params: { rel: "G19", package: "Credit" } }] })).message)
      .toContain("matches");
    expect((await fetchFail({ requests: [{ name: "x", endpoint: "ddp",
      params: { rel: "G19", package: "00000000000000000000000000000000" } }] })).message).toContain("empty file");
    expect((await fetchFail({ requests: [{ name: "x", endpoint: "ddp_packages", params: { rel: "NOPE" } }] })).message)
      .toContain("not a Data Download Program release");
  });

  it("a bad spec is invalid_request", async () => {
    for (const req of [{ endpoint: "ddp", params: { package: "Consumer Credit Outstanding (S.A.)" } }, // no rel
      { endpoint: "ddp", params: { package: "g19_sa", from: "Jan 2025" } },
      { endpoint: "z1", params: { table: "B.101", start: "2025Q1" } },
      { endpoint: "scf_chart", params: { group: "race", stat: "median" } }]) {
      expect((await fetchFail({ requests: [{ name: "x", ...req }] })).code).toBe("invalid_request");
    }
  });

  it("filters dates", async () => {
    const ad: any = (await load("fed-board")).adapter;
    const rows = ["2024Q4", "2025Q1", "2025Q4", "2026Q1"].map((date) => ({ date, series: "S" }));
    expect(ad.filterRows(rows, "2025", "2025").map((x: any) => x.date)).toEqual(["2025Q1", "2025Q4"]);
    expect(ad.filterRows(rows, undefined, undefined, 2).map((x: any) => x.date)).toEqual(["2025Q4", "2026Q1"]);
    expect(ad.dateKey("2026-08")).toBe("2026-08-01");
    expect(ad.dateKey("2026:Q3", true)).toBe("2026-09-31");
  });

  it("ingests uploaded files", async () => {
    const spec = { requests: [
      { name: "g19_sa", endpoint: "ddp", params: { package: "g19_sa", series_ids: "DTCTL.M" } },
      { name: "b101", endpoint: "z1", params: { table: "S1M.b", series_ids: ["FL152090005"] } },
      { name: "race_median", endpoint: "scf_chart", params: { group: "racecl4", stat: "median" } }] };
    const s = newSession();
    await prepare(s, "fed-board", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "fed-up-"));
    for (const [src, dst] of [["ddp_G19_sa.csv", "g19_sa.csv"], ["z1_csv_files_trim.zip", "b101.zip"], ["scf_chart_trim.zip", "race_median.zip"]]) {
      fs.copyFileSync(path.join(FX, src), path.join(up, dst));
    }
    delete process.env.DATA_ANALYST_FIXTURES;
    await T.ingest(s, { source: "fed-board", spec, files: [up] });
    const g = csv(s, "fed-board", "g19_sa");
    expect(new Set(g.map((x) => x.series))).toEqual(new Set(["DTCTL.M"]));
    expect(g[g.length - 1].value).toBe("5196778.44");
    const b = csv(s, "fed-board", "b101");
    expect(b[b.length - 1].value).toBe("195870496");
    expect(csv(s, "fed-board", "race_median").length).toBe(52);
  });
});
