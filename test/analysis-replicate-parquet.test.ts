/**
 * compute on Parquet inputs (typed as the same CSV, column projection, the cell cap, lineage and rerun) and the
 * replicate_se step (both forms, every method, refusals), on tables written into a session workspace.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readLineage } from "../src/analysis/compute.js";
import { rerunWorkspace } from "../src/analysis/rerun.js";
import { PARQUET_MAX_CELLS } from "../src/analysis/table.js";
import { TOOLS } from "../src/analysis/tools.js";
import { writeParquet } from "../src/core/parquet.js";
import { readCsv } from "../src/core/tabular.js";
import type { Session } from "../src/session.js";
import { failure, isolate, newSession } from "./helpers.js";

beforeAll(() => isolate());

const compute = (s: Session, a: any) => TOOLS.find((t) => t.name === "compute")!.handler(s, a) as any;
const text = (s: Session, rel: string) => fs.readFileSync(path.join(s.workspace, rel), "utf8");
const read = (s: Session, rel: string) => readCsv(text(s, rel)) as Record<string, string>[];

function put(s: Session, rel: string, body: string): string {
  const p = path.join(s.workspace, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

const csv = (rows: (string | number)[][]) => rows.map((r) => r.join(",")).join("\r\n") + "\r\n";

// ---------------------------------------------------------------------- Parquet
function parquetWorkspace(): Session {
  const s = newSession();
  const file = path.join(s.workspace, "data/opm/t.parquet");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeParquet(file, [
    { name: "code", kind: "string", values: ["01", "02", null, "10"] },
    { name: "count", kind: "int64", values: [5, null, 7, 12] },
    { name: "pay", kind: "double", values: [1.5, 2.25, null, 100000] },
    { name: "flag", kind: "string", values: ["True", "False", "True", null] },
    { name: "agency", kind: "string", values: ["VA", "HS", "VA", "1,234"] },
  ], 4, "test");
  put(s, "data/opm/t.csv", csv([["code", "count", "pay", "flag", "agency"], ["01", 5, 1.5, "True", "VA"], ["02", "", 2.25, "False", "HS"],
    ["", 7, "", "True", "VA"], [10, 12, 100000, "", '"1,234"']]));
  return s;
}

describe("compute on Parquet", () => {
  it("types a Parquet input exactly as the same CSV", () => {
    const s = parquetWorkspace();
    const steps = [{ derive: { pay2: "pay * 2", n: "count + 1", lead0: "len(code)" } }, { orderby: ["-count"] }];
    const a = compute(s, { inputs: { t: "data/opm/t.parquet" }, save_as: "exhibits/pq.csv", steps });
    const b = compute(s, { inputs: { t: "data/opm/t.csv" }, save_as: "exhibits/cs.csv", steps });
    expect(a.status).toBe("ok");
    expect(text(s, "exhibits/pq.csv")).toBe(text(s, "exhibits/cs.csv"));
    expect(b.summary.columns).toEqual(["code", "count", "pay", "flag", "agency", "pay2", "n", "lead0"]);
    expect(read(s, "exhibits/pq.csv")[0]).toMatchObject({ code: "10", count: "12", pay2: "200000", n: "13", lead0: "2" });
    expect(read(s, "exhibits/pq.csv").map((r) => r.code)).toEqual(["10", "", "01", "02"]);
    expect(readLineage(s.workspace)["exhibits/pq.csv"]).toMatchObject({ packs: ["opm"], inputs: { t: { path: "data/opm/t.parquet" } } });
  });

  it("reads only the named columns, in that order, and the rerun gate replays them", async () => {
    const s = parquetWorkspace();
    const r = compute(s, { inputs: { t: { path: "data/opm/t.parquet", columns: ["agency", "count"] } }, save_as: "exhibits/by.csv",
      steps: [{ groupby: ["agency"], rollup: { n: "sum(count)" } }] });
    expect(r.summary.columns).toEqual(["agency", "n"]);
    expect(read(s, "exhibits/by.csv")).toEqual([{ agency: "1,234", n: "12" }, { agency: "HS", n: "" }, { agency: "VA", n: "12" }]);
    expect(readLineage(s.workspace)["exhibits/by.csv"].inputs.t).toMatchObject({ path: "data/opm/t.parquet",
      columns: ["agency", "count"] });
    compute(s, { inputs: { t: { path: "data/opm/t.csv", columns: ["count", "code"] } }, save_as: "exhibits/c.csv", steps: [] });
    expect(text(s, "exhibits/c.csv")).toBe("count,code\r\n5,01\r\n,02\r\n7,\r\n12,10\r\n");
    const rr = await rerunWorkspace(s.workspace);
    expect(rr.exhibits).toEqual({ "exhibits/by.csv": { same: true }, "exhibits/c.csv": { same: true } });
  });

  it("refuses unknown columns, Parquet outside data/, a file that is not Parquet and more cells than the cap", async () => {
    const s = parquetWorkspace();
    let f = await failure(() => compute(s, { inputs: { t: { path: "data/opm/t.parquet", columns: ["nope"] } }, save_as: "exhibits/x.csv", steps: [] }));
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("no column nope; the columns are code, count, pay, flag, agency");
    f = await failure(() => compute(s, { inputs: { t: { path: "data/opm/t.csv", columns: ["nope"] } }, save_as: "exhibits/x.csv", steps: [] }));
    expect(f.message).toContain("no column nope");
    f = await failure(() => compute(s, { inputs: { t: { path: "data/opm/t.parquet", extra: 1 } }, save_as: "exhibits/x.csv", steps: [] }));
    expect(f.message).toContain("unknown key(s) ['extra']");
    put(s, "exhibits/y.parquet", "x");
    f = await failure(() => compute(s, { inputs: { t: "exhibits/y.parquet" }, save_as: "exhibits/x.csv", steps: [] }));
    expect(f.message).toContain("a workspace path like");
    put(s, "data/opm/bad.parquet", "not parquet at all");
    f = await failure(() => compute(s, { inputs: { t: "data/opm/bad.parquet" }, save_as: "exhibits/x.csv", steps: [] }));
    expect(f.message).toContain("could not be read as Parquet");
    const cap = PARQUET_MAX_CELLS.value;
    PARQUET_MAX_CELLS.value = 10;
    try {
      f = await failure(() => compute(s, { inputs: { t: "data/opm/t.parquet" }, save_as: "exhibits/x.csv", steps: [] }));
      expect(f.message).toContain("4 rows x 5 columns is more than compute reads at once");
      expect(f.message).toContain("name the columns you need");
      expect(compute(s, { inputs: { t: { path: "data/opm/t.parquet", columns: ["code", "count"] } }, save_as: "exhibits/x.csv",
        steps: [] }).status).toBe("ok");
    } finally {
      PARQUET_MAX_CELLS.value = cap;
    }
  });
});

// ---------------------------------------------------------------------- replicate_se
const REPS = ["r1", "r2", "r3", "r4"];
const MICRO: (string | number)[][] = [
  ["g", "x", "w", ...REPS],
  ["b", 1, 5, 4, 6, 5, 5],
  ["a", 1, 10, 12, 8, 10, 11],
  ["b", 1, 5, 6, 4, 5, 5],
  ["a", 0, 20, 18, 22, 21, 19],
  ["b", 0, 10, 10, 10, 12, 8],
];

/** Independent reference: the estimate per group with weight column k. */
function byHand(k: number, g: string, f: (rows: { x: number; w: number }[]) => number): number {
  return f(MICRO.slice(1).filter((r) => r[0] === g).map((r) => ({ x: Number(r[1]), w: Number(r[2 + k]) })));
}
const total = (rs: { x: number; w: number }[]) => rs.reduce((s, r) => s + r.x * r.w, 0);
const rate = (rs: { x: number; w: number }[]) => total(rs) / rs.reduce((s, r) => s + r.w, 0);
function refSe(g: string, f: typeof total, c: number): number {
  const theta = byHand(0, g, f);
  return Math.sqrt(c * [1, 2, 3, 4].reduce((s, k) => s + (byHand(k, g, f) - theta) ** 2, 0));
}

function microWorkspace(): Session {
  const s = newSession();
  put(s, "data/census/pums.csv", csv(MICRO));
  return s;
}

const step = (o: Record<string, unknown>, groupby: string[] | null = ["g"]) => ({ ...(groupby ? { groupby } : {}),
  replicate_se: { estimates: { total: "sum(w * x)", rate: "sum(w * x) / sum(w)" }, weight: "w", replicates: "r1:r4", ...o } });

describe("replicate_se from microdata", () => {
  it("gives SE and MOE per group, in rollup's order, for every method", async () => {
    const s = microWorkspace();
    const cases: [Record<string, unknown>, number][] = [[{ method: "sdr" }, 4 / 4], [{ method: "jk1" }, 3 / 4],
      [{ method: "brr" }, 1 / 4], [{ method: "fay", rho: 0.3 }, 1 / (4 * 0.7 ** 2)], [{ method: "custom", scale: 0.05 }, 0.05]];
    for (const [i, [o, c]] of cases.entries()) {
      const r = compute(s, { inputs: { p: "data/census/pums.csv" }, save_as: `exhibits/se${i}.csv`, steps: [step({ ...o, also: { n: "count()" } })] });
      expect(r.summary.columns).toEqual(["g", "total", "total_se", "total_moe", "rate", "rate_se", "rate_moe", "n"]);
      const rows = read(s, `exhibits/se${i}.csv`);
      expect(rows.map((x) => x.g)).toEqual(["a", "b"]);
      for (const row of rows) {
        expect(Number(row.total)).toBeCloseTo(byHand(0, row.g, total), 12);
        expect(Number(row.total_se)).toBeCloseTo(refSe(row.g, total, c), 12);
        expect(Number(row.total_moe)).toBeCloseTo(1.645 * refSe(row.g, total, c), 12);
        expect(Number(row.rate)).toBeCloseTo(byHand(0, row.g, rate), 12);
        expect(Number(row.rate_se)).toBeCloseTo(refSe(row.g, rate, c), 12);
      }
      expect(rows.map((x) => x.n)).toEqual(["2", "3"]);
      expect(r.notes[0]).toContain("over 4 replicates r1-r4");
    }
    expect(read(s, "exhibits/se0.csv")[0]).toMatchObject({ total: "10", total_se: "3" });
    expect(Number(read(s, "exhibits/se0.csv")[0].total_moe)).toBeCloseTo(4.935, 12);
    expect(read(s, "exhibits/se0.csv")[1]).toMatchObject({ total: "10", total_se: "0" });
    const r = compute(s, { inputs: { p: "data/census/pums.csv" }, save_as: "exhibits/all.csv", steps: [step({ method: "sdr", confidence: 95 }, null)] });
    expect(r.summary.columns[0]).toBe("total");
    expect(read(s, "exhibits/all.csv")).toHaveLength(1);
    expect(r.notes[0]).toBe("replicate_se: SE = sqrt(4/4 * sum over r of (estimate_r - estimate)^2) over 4 replicates r1-r4 " +
      "(sdr, successive difference replication); MOE = 1.96 * SE (95 percent); weight w");
    const rr = await rerunWorkspace(s.workspace);
    expect(Object.values(rr.exhibits).every((e) => e.same)).toBe(true);
  });

  it("gives the SE of a difference written as one estimate, and a gap where a replicate is missing", () => {
    const s = microWorkspace();
    compute(s, { inputs: { p: "data/census/pums.csv" }, save_as: "exhibits/d.csv", steps: [{ replicate_se: { method: "sdr",
      estimates: { diff: 'sum(w * x * (g == "a")) - sum(w * x * (g == "b"))' }, weight: "w", replicates: REPS } }] });
    const thetas = [0, 1, 2, 3, 4].map((k) => byHand(k, "a", total) - byHand(k, "b", total));
    const want = Math.sqrt([1, 2, 3, 4].reduce((acc, k) => acc + (thetas[k] - thetas[0]) ** 2, 0));
    expect(Number(read(s, "exhibits/d.csv")[0].diff_se)).toBeCloseTo(want, 12);
    put(s, "data/census/gap.csv", csv([["g", "x", "w", ...REPS], ["a", 1, 10, 12, 8, 10, 11], ["b", 1, 5, "", "", "", ""]]));
    const r = compute(s, { inputs: { p: "data/census/gap.csv" }, save_as: "exhibits/g.csv",
      steps: [{ groupby: ["g"], replicate_se: { method: "sdr", estimates: { t: "sum(w * x)" }, weight: "w", replicates: "r1:r4" } }] });
    // b has no replicate weights: its replicate estimates are gaps, so is its SE
    expect(read(s, "exhibits/g.csv").map((x) => [x.g, x.t, x.t_se, x.t_moe === "" ? "" : Number(x.t_moe).toFixed(3)]))
      .toEqual([["a", "10", "3", "4.935"], ["b", "5", "", ""]]);
    expect(r.notes[1]).toContain("1 estimate with a missing replicate estimate");
    // a replicate sum over no values is a gap: the SE is then a gap too
    put(s, "data/census/gap2.csv", csv([["g", "x", "w", ...REPS], ["a", 1, 10, 12, 8, 10, ""]]));
    const r2 = compute(s, { inputs: { p: "data/census/gap2.csv" }, save_as: "exhibits/g2.csv",
      steps: [{ replicate_se: { method: "sdr", estimates: { t: "sum(w * x)" }, weight: "w", replicates: "r1:r4" } }] });
    expect(read(s, "exhibits/g2.csv")).toEqual([{ t: "10", t_se: "", t_moe: "" }]);
    expect(r2.notes[1]).toContain("1 estimate with a missing replicate estimate");
  });

  it("refuses what would give a wrong or meaningless SE", async () => {
    const s = microWorkspace();
    const bad = async (o: Record<string, unknown>, groupby?: string[]) => (await failure(() => compute(s, {
      inputs: { p: "data/census/pums.csv" }, save_as: "exhibits/x.csv", steps: [{ ...(groupby ? { groupby } : {}), replicate_se: o }] }))).message;
    const base = { estimates: { t: "sum(w * x)" }, weight: "w", replicates: "r1:r4" };
    expect(await bad(base)).toContain("name the method (sdr, fay, jk1, brr, custom)");
    expect(await bad({ ...base, method: "bootstrap" })).toContain("method is one of sdr, fay, jk1, brr, custom");
    expect(await bad({ ...base, method: "fay" })).toContain("method fay needs rho");
    expect(await bad({ ...base, method: "sdr", rho: 0.5 })).toContain("rho goes with method fay only");
    expect(await bad({ ...base, method: "custom" })).toContain('method "custom" needs scale');
    expect(await bad({ ...base, method: "sdr", confidence: 80 })).toContain("confidence is 90");
    expect(await bad({ ...base, method: "sdr", estimates: { n: "count()" } })).toContain("does not use the weight w");
    expect(await bad({ ...base, method: "sdr", estimates: { t: "w * x" } })).toContain("is not an aggregate");
    expect(await bad({ ...base, method: "sdr", replicates: "r1:q4" })).toContain('a range is "PREFIX1:PREFIX80"');
    expect(await bad({ ...base, method: "sdr", replicates: "r1:r9" })).toContain("no columns r5, r6, r7, r8, r9");
    expect(await bad({ ...base, method: "sdr", replicates: ["r1"] })).toContain("at least two replicate columns");
    expect(await bad({ ...base, method: "sdr", replicates: ["w", "r1"] })).toContain("is also listed as a replicate");
    expect(await bad({ ...base, method: "sdr" }, ["w"])).toContain("a weight cannot be a groupby key");
    expect(await bad({ ...base, method: "sdr", estimate: "x" })).toContain("not both");
    expect(await bad({ ...base, method: "sdr", estimates: { g: "sum(w)" } }, ["g"])).toContain("would name two columns");
    expect(await bad({ ...base, method: "sdr", bogus: 1 })).toContain("unknown key(s) ['bogus']");
    const f = await failure(() => compute(s, { inputs: { p: "data/census/pums.csv" }, save_as: "exhibits/x.csv",
      steps: [{ replicate_se: { ...base, method: "sdr", estimates: { t: "sum(w * x)" } }, how: "x" }] }));
    expect(f.message).toContain("step 1 (replicate_se): unknown key(s) ['how']");
  });
});

describe("replicate_se from published replicate estimates", () => {
  it("adds an SE and MOE to each row; refuses groupby, text and clashes", async () => {
    const s = newSession();
    put(s, "published/vr.csv", csv([["NAME", "ESTIMATE", "Var_Rep1", "Var_Rep2", "Var_Rep3", "Var_Rep4"], ["A", 100, 102, 98, 101, 99],
      ["B", 50, 50, 50, "", 50], ["C", 7, 7, 7, 7, 9]]));
    const r = compute(s, { inputs: { v: "published/vr.csv" }, save_as: "exhibits/vr.csv",
      steps: [{ replicate_se: { estimate: "ESTIMATE", replicates: "Var_Rep1:Var_Rep4", method: "sdr" } }, { select: ["NAME", "ESTIMATE", "ESTIMATE_se", "ESTIMATE_moe"] }] });
    expect(read(s, "exhibits/vr.csv")).toEqual([
      { NAME: "A", ESTIMATE: "100", ESTIMATE_se: String(Math.sqrt(10)), ESTIMATE_moe: String(1.645 * Math.sqrt(10)) },
      { NAME: "B", ESTIMATE: "50", ESTIMATE_se: "", ESTIMATE_moe: "" },
      { NAME: "C", ESTIMATE: "7", ESTIMATE_se: "2", ESTIMATE_moe: "3.29" }]);
    expect(r.notes).toEqual(["replicate_se: SE = sqrt(4/4 * sum over r of (estimate_r - estimate)^2) over 4 replicates " +
      "Var_Rep1-Var_Rep4 (sdr, successive difference replication); MOE = 1.645 * SE (90 percent); estimates in ESTIMATE",
    "replicate_se: 1 row with a missing estimate or replicate (a gap): no SE given"]);
    compute(s, { inputs: { v: "published/vr.csv" }, save_as: "exhibits/vr2.csv",
      steps: [{ replicate_se: { estimate: "ESTIMATE", replicates: "Var_Rep1:Var_Rep4", method: "jk1", as: "est" } }] });
    expect(Number(read(s, "exhibits/vr2.csv")[0].est_se)).toBeCloseTo(Math.sqrt(0.75 * 10), 12);
    const bad = async (o: Record<string, unknown>, groupby?: string[]) => (await failure(() => compute(s, {
      inputs: { v: "published/vr.csv" }, save_as: "exhibits/x.csv", steps: [{ ...(groupby ? { groupby } : {}), replicate_se: o }] }))).message;
    const base = { estimate: "ESTIMATE", replicates: "Var_Rep1:Var_Rep4", method: "sdr" };
    expect(await bad(base, ["NAME"])).toContain("groupby goes with the microdata form");
    expect(await bad({ ...base, estimate: "NAME" })).toContain("row 1: NAME is 'A', not a number");
    const f = await failure(() => compute(s, { inputs: { v: "published/vr.csv" }, save_as: "exhibits/x.csv",
      steps: [{ replicate_se: base }, { replicate_se: base }] }));
    expect(f.message).toContain("step 2 (replicate_se): ['ESTIMATE_se', 'ESTIMATE_moe'] are already columns: give as a new name");
    expect(await bad({ ...base, also: { n: "count()" } })).toContain("unknown key(s) ['also']");
  });
});

describe("over MCP", () => {
  it("the compute schema takes {path, columns} inputs and the replicate_se step", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createServer } = await import("../src/server.js");
    const s = parquetWorkspace();
    put(s, "data/census/pums.csv", csv(MICRO));
    const server = createServer(s);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name: "compute", arguments: args });
      return { data: JSON.parse(r.content[0].text), isError: !!r.isError };
    };
    let r = await call({ inputs: { t: { path: "data/opm/t.parquet", columns: ["code"] } }, save_as: "exhibits/a.csv", steps: [] });
    expect(r.isError).toBe(false);
    expect(r.data.summary.columns).toEqual(["code"]);
    r = await call({ inputs: { p: "data/census/pums.csv" }, save_as: "exhibits/b.csv", steps: [step({ method: "sdr" })] });
    expect(r.isError).toBe(false);
    expect(r.data.summary.preview[0]).toMatchObject({ g: "a", total: "10", total_se: "3" });
    expect(r.data.notes[0]).toContain("replicate_se: SE = sqrt(4/4");
  });
});
