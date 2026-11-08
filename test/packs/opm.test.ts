/**
 * opm deep pack tests (offline), ported from tests/sources/opm/test_opm.py. Fixtures recorded from data.opm.gov in
 * October 2026 (public data, no key): the ping and full separations listings, the first six rows (all 69 columns)
 * of the real separations_202608_1 Parquet file, and the same rows as CSV (the website TXT/CSV route).
 * Every test points OPM_CACHE_DIR at a temp folder so the user's raw-file cache is never touched.
 */
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { buildPlan, listSummary, OpmClient, scriptRules, writeDownloadScripts } from "../../src/deep/opm.js";
import { ParquetFile } from "../../src/core/parquet.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const SPEC = { description: "Separations by category, August 2026 file",
  datasets: { separations: { periods: ["2026-08"] } },
  columns: ["department_code", "department", "agency_code", "agency", "separation_category_code",
    "separation_category", "annualized_adjusted_basic_pay"] };
const FIX = path.join(TEST_DIR, "packs", "opm", "fixtures");
let cache = "";

beforeAll(() => isolate());
beforeEach(() => {
  cache = fs.mkdtempSync(path.join(os.tmpdir(), "opm-cache-"));
  process.env.OPM_CACHE_DIR = cache;
  delete process.env.DATA_ACCESS_FORCE;
  fixtures("opm");
});

const opmCsv = (s: any, name = "opm_separations") => csv(s, "opm", name);
const dir = (s: any) => path.join(s.workspace, "data", "opm");

async function fetchFail(spec: any) {
  const s = newSession();
  fixtures("opm");
  await prepare(s, "opm", spec);
  return failure(T.fetchData(s, { source: "opm", spec }));
}

async function ingestIn(s: any, spec: any, files: string[]) {
  await prepare(s, "opm", spec);
  return T.ingest(s, { source: "opm", spec, files }) as Promise<any>;
}

describe("opm", () => {
  it("check: the plan picks the current August 2026 file (no key needed)", async () => {
    const p = await load("opm");
    expect(p.deep!.checkSpec!(SPEC, p)).toEqual([]);
    expect(p.policy.auth.required).toBe("none");
    const plan = await buildPlan(SPEC, new OpmClient());
    expect(plan.files[0].filename).toBe("separations_202608_1");
  });

  it("dry run: the download URL and current flag", async () => {
    const plan = await buildPlan(SPEC, new OpmClient());
    expect(plan.files[0].url).toBe("https://data.opm.gov/api/v1/files/separations/2026/08/1/download");
    expect(plan.files[0].current).toBe(true);
  });

  it("fetch", async () => {
    const s = newSession();
    const r = await fetchOk(s, "opm", SPEC);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api");
    const rows = opmCsv(s);
    expect(rows.length).toBe(6);
    expect(Object.keys(rows[0]).slice(0, 3)).toEqual(["count", "personnel_action_effective_date_yyyymm", "department_code"]);
    expect(rows[0].department_code).toBe("SZ");
    expect(rows[0].separation_category).toBe("QUIT");
    expect(rows[2].annualized_adjusted_basic_pay).toBe("REDACTED");
    expect(rows[0].source_file).toBe("separations_202608_1");
    for (const f of ["manifest.json", "request.json", "README.md", "data_dictionary.csv", "spec_used.json", "opm_separations.parquet"]) {
      expect(fs.existsSync(path.join(dir(s), f)), f).toBe(true);
    }
    const M = JSON.parse(fs.readFileSync(path.join(dir(s), "manifest.json"), "utf8"));
    expect(M.files[0].version).toBe(1);
    expect(M.route).toBe("api");
    expect(fs.existsSync(path.join(cache, "separations_202608_1.parquet"))).toBe(true);
    // the written Parquet holds the same table
    const pq = new ParquetFile(path.join(dir(s), "opm_separations.parquet"));
    const g = [...pq.rowGroups()][0];
    expect(pq.columns()).toEqual(Object.keys(rows[0]));
    expect(g.data.annualized_adjusted_basic_pay).toEqual(["72738", "63034", "REDACTED", "50764", "REDACTED", null]);
    expect(r.citation.text).toContain("separations files");
    // the same request is reused
    const again: any = await T.fetchData(s, { source: "opm", spec: SPEC });
    expect(again.summary.route).toBe("reuse_existing");
  });

  it("filters and aggregate", async () => {
    const spec = { ...SPEC, filters: { department_code: ["SZ", "TR"] }, columns: ["department_code", "separation_category"],
      aggregate: { by: ["department_code", "separation_category"] } };
    const s = newSession();
    const r = await fetchOk(s, "opm", spec);
    expect(r.status).toBe("ok");
    const rows = opmCsv(s);
    expect(new Set(rows.map((x) => x.department_code))).toEqual(new Set(["SZ", "TR"]));
    const sz = rows.find((x) => x.department_code === "SZ")!;
    expect(Number(sz.headcount)).toBe(2);
    expect(Number(sz.pay_sum)).toBe(72738 + 63034);
  });

  it("ingest: the website CSV form needs no Parquet file", async () => {
    const s = newSession();
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "opm-up-"));
    fs.copyFileSync(path.join(FIX, "separations_202608_1_head.csv"), path.join(up, "separations_202608_1.csv"));
    const r = await ingestIn(s, SPEC, [up]);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("manual_download");
    const rows = opmCsv(s);
    expect(rows.length).toBe(6);
    expect(rows[3].separation_category).toBe("RETIREMENT - VOLUNTARY");
    expect(rows[5].annualized_adjusted_basic_pay).toBe(""); // null in the Parquet original
  });

  it("ingest: a data/ folder built elsewhere", async () => {
    const s1 = newSession();
    expect((await fetchOk(s1, "opm", SPEC)).status).toBe("ok");
    const s2 = newSession();
    const r = await ingestIn(s2, SPEC, [path.join(s1.workspace, "data")]);
    expect(r.status).toBe("ok");
    const req = JSON.parse(fs.readFileSync(path.join(dir(s2), "request.json"), "utf8"));
    expect(req.acquired).toBe("manual_prebuilt");
    expect(r.notes).toEqual([]);
    expect(opmCsv(s2).length).toBe(6);
  });

  it("fix_spec", async () => {
    let f = await fetchFail({ datasets: { payroll: { periods: ["2026-08"] } } });
    expect(f.code).toBe("invalid_request");
    // a column no requested dataset has would come back all null: refused, with the near names
    f = await fetchFail({ ...SPEC, columns: ["agency_code", "effective_month"] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("effective_month");
    expect(f.message).toContain("personnel_action_effective_date_yyyymm");
    f = await fetchFail({ ...SPEC, filters: { grade: [8] } });
    expect(f.code).toBe("invalid_request");
    f = await fetchFail({ datasets: { separations: { from: "2031-01", to: "2031-03" } } });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("nothing available from 2031-01 to 2031-03");
  });

  it("aggregate refuses columns it would drop", async () => {
    const f = await fetchFail({ ...SPEC, aggregate: { by: ["department_code"] } });
    expect(f.message).toContain("would be dropped");
  });

  it("restricted sandbox: the fetch fails with the manual route", async () => {
    delete process.env.DATA_ANALYST_FIXTURES;
    process.env.DATA_ACCESS_FORCE = "restricted";
    const s = newSession();
    await prepare(s, "opm", SPEC);
    const f = await failure(T.fetchData(s, { source: "opm", spec: SPEC }));
    expect(f.code).toBe("agency_unavailable");
    expect(f.message).toContain("cannot reach data.opm.gov");
    expect(f.manual_bundle).toBeTruthy();
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "opm-b-"));
    const paths = writeDownloadScripts(d, SPEC, await load("opm"));
    for (const k of ["bash", "powershell"] as const) {
      expect(fs.readFileSync(paths[k]!, "ascii")).toContain("separations\tperiods\t202608"); // the request is built in
    }
  });

  const RANGE_SPEC = { datasets: { separations: { from: "2025-06", to: "latest", months: [8] },
    accessions: { periods: ["latest"] } }, pin: { separations_202508: 3 } };

  it("script rules", () => {
    expect(scriptRules(RANGE_SPEC)).toEqual(["separations\trange\t202506\tlatest\t8", "accessions\tperiods\tlatest",
      "separations\tpin\t202508\t3"]);
  });

  it("manual items: pinned versions only (other months need OPM's listing)", async () => {
    const p = await load("opm");
    expect(p.deep!.manualItems!(RANGE_SPEC, p).map((i: any) => i.url))
      .toEqual(["https://data.opm.gov/api/v1/files/separations/2025/08/3/download"]);
  });

  /** List and download against a local stand-in for data.opm.gov; check which files were picked. */
  async function runDownloadScript(cmd: (p: { bash?: string; powershell?: string }) => string[]) {
    const listing: Record<string, string[]> = { separations: ["separations_202508_4", "separations_202509_4", "separations_202608_1"],
      accessions: ["accessions_202607_2", "accessions_202608_1"] };
    const srv = http.createServer((req, res) => {
      const parts = (req.url || "").split("?")[0].replace(/^\/+|\/+$/g, "").split("/");
      let body: string | null = null;
      if (parts.length === 4 && (req.url || "").includes("current=true")) {
        body = JSON.stringify(listing[parts[3]].map((n) => ({ filename: n, version: Number(n.split("_").pop()), current: true })));
      } else if (parts.length === 8 && parts[7] === "download") body = parts.slice(3, 7).join("/");
      res.writeHead(body === null ? 404 : 200);
      res.end(body ?? "");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    try {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "opm-script-"));
      const paths = writeDownloadScripts(d, RANGE_SPEC, await load("opm"));
      const port = (srv.address() as any).port;
      const [exe, ...args] = cmd(paths);
      const code = await new Promise<number>((resolve) => {
        const p = spawn(exe, args, { env: { ...process.env, OPM_API_BASE: `http://127.0.0.1:${port}/api/v1/files`,
          NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
        p.on("close", (c) => resolve(c ?? 1));
      });
      expect(code).toBe(0);
      const got = fs.readdirSync(d).filter((f) => f.endsWith(".parquet")).sort();
      expect(got).toEqual(["accessions_202608_1.parquet", "separations_202508_3.parquet", "separations_202608_1.parquet"]);
      expect(fs.readFileSync(path.join(d, "separations_202508_3.parquet"), "ascii")).toBe("separations/2025/08/3"); // the pinned version
    } finally {
      srv.close();
    }
  }

  const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
  const hasBash = spawnSync(bash, ["-c", "command -v curl"]).status === 0;
  it.skipIf(!hasBash)("download script: bash", async () => {
    await runDownloadScript((p) => [bash, p.bash!.replaceAll("\\", "/")]);
  }, 120000);

  const ps = process.platform === "win32" ? "powershell" : "pwsh";
  const hasPs = spawnSync(ps, ["-NoProfile", "-Command", "exit 0"]).status === 0;
  it.skipIf(!hasPs)("download script: PowerShell", async () => {
    await runDownloadScript((p) => [ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", p.powershell!, "-NoPause"]);
  }, 120000);

  it("list: periods available (request_schema)", async () => {
    const r = await listSummary("separations");
    expect(r.first).toBe("2005-01");
    expect(r.latest_files).toBeTruthy();
    const s = newSession();
    await T.sourceBrief(s, { source: "opm" });
    const sc: any = await T.requestSchema(s, { source: "opm", names: ["separations"] });
    expect(sc.schemas[0].available.first).toBe("2005-01");
    expect(sc.schemas[0].columns.some((c: any) => c.name === "separation_category")).toBe(true);
  });
});
