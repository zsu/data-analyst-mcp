/**
 * The analysis tools: compute (verbs, the expression whitelist, lineage), facts and the rerun gate, on a workspace
 * fetched from the cdc fixtures and on CSVs written into a session workspace.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { inspect, parse } from "../src/analysis/expr.js";
import { readLineage } from "../src/analysis/compute.js";
import { rerunWorkspace } from "../src/analysis/rerun.js";
import { TOOLS } from "../src/analysis/tools.js";
import { readCsv } from "../src/core/tabular.js";
import type { Session } from "../src/session.js";
import { failure, fetchOk, isolate, newSession } from "./helpers.js";

beforeAll(() => isolate());

const tool = (name: string) => TOOLS.find((t) => t.name === name)!.handler;
const compute = (s: Session, a: any) => tool("compute")(s, a) as any;
const facts = (s: Session, a: any) => tool("facts")(s, a) as any;
const read = (s: Session, rel: string) => readCsv(fs.readFileSync(path.join(s.workspace, rel), "utf8")) as Record<string, string>[];

function put(s: Session, rel: string, text: string): void {
  const p = path.join(s.workspace, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

const CDC = { description: "Leading causes of death, New York, 2017", requests: [{ name: "ny_causes_2017", endpoint: "query",
  params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'", $order: "deaths DESC" } }] };
const CAUSES = "data/cdc/ny_causes_2017.csv";
const TOP10 = 44092 + 34956 + 7687 + 7258 + 6264 + 4517 + 4176 + 3521 + 2296 + 1696;

async function cdcWorkspace(): Promise<Session> {
  const s = newSession();
  await fetchOk(s, "cdc", CDC);
  return s;
}

describe("compute on fetched data", () => {
  it("filters, derives shares, orders and records the lineage", async () => {
    const s = await cdcWorkspace();
    const r = compute(s, { inputs: { c: CAUSES }, save_as: "exhibits/causes.csv", steps: [
      { filter: 'cause_name != "All causes"' },
      { derive: { share: "deaths / sum(deaths)", rank: "row_number()" } },
      { orderby: ["-deaths"] },
      { select: ["cause_name", "deaths", "share", "rank"] },
    ] });
    expect(r.status).toBe("ok");
    expect(r.summary.rows).toBe(10);
    expect(r.summary.columns).toEqual(["cause_name", "deaths", "share", "rank"]);
    expect(r.summary.packs).toEqual(["cdc"]);
    const rows = read(s, "exhibits/causes.csv");
    expect(rows[0]).toEqual({ cause_name: "Heart disease", deaths: "44092", share: String(44092 / TOP10), rank: "1" });
    expect(fs.readFileSync(path.join(s.workspace, "exhibits/causes.csv"), "utf8")).toContain("\r\n");
    const lin = readLineage(s.workspace)["exhibits/causes.csv"];
    expect(lin.packs).toEqual(["cdc"]);
    expect(lin.inputs.c.path).toBe(CAUSES);
    expect(lin.inputs.c.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lin.steps).toHaveLength(4);
  });

  it("groups and rolls up; an exhibit built on an exhibit inherits its packs", async () => {
    const s = await cdcWorkspace();
    compute(s, { inputs: { c: CAUSES }, save_as: "exhibits/causes.csv", steps: [{ filter: 'cause_name != "All causes"' }] });
    const r = compute(s, { inputs: { e: "exhibits/causes.csv" }, save_as: "exhibits/total.csv", steps: [
      { groupby: ["state", "year"], rollup: { total: "sum(deaths)", n: "count()", top: "max(deaths)", avg_rate: "mean(aadr)",
        share_top: "max(deaths) / sum(deaths)" } },
    ] });
    expect(r.summary.packs).toEqual(["cdc"]);
    expect(read(s, "exhibits/total.csv")).toEqual([{ state: "New York", year: "2017", total: String(TOP10), n: "10",
      top: "44092", avg_rate: String((171.2 + 141.2 + 35.5 + 28.9 + 24.6 + 17.7 + 16.8 + 13.2 + 9.1 + 8.1) / 10),
      share_top: String(44092 / TOP10) }]);
  });

  it("refuses unknown columns, paths outside the workspace and a save over an input", async () => {
    const s = await cdcWorkspace();
    let f = await failure(() => compute(s, { inputs: { c: CAUSES }, save_as: "exhibits/x.csv", steps: [{ filter: "nope > 1" }] }));
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("step 1 (filter): unknown column nope");
    f = await failure(() => compute(s, { inputs: { c: "../secret.csv" }, save_as: "exhibits/x.csv", steps: [] }));
    expect(f.message).toContain("a workspace CSV path");
    f = await failure(() => compute(s, { inputs: { c: CAUSES }, save_as: "data/cdc/x.csv", steps: [] }));
    expect(f.message).toContain("exhibits/<name>.csv");
    compute(s, { inputs: { c: CAUSES }, save_as: "exhibits/a.csv", steps: [] });
    f = await failure(() => compute(s, { inputs: { c: "exhibits/a.csv" }, save_as: "exhibits/a.csv", steps: [] }));
    expect(f.message).toContain("is also an input");
    f = await failure(() => compute(s, { inputs: { c: CAUSES }, save_as: "exhibits/x.csv", steps: [{ groupby: ["state"] }] }));
    expect(f.message).toContain("groupby goes with rollup");
  });
});

describe("the expression whitelist", () => {
  const BAD: [string, string][] = [
    ["deaths.constructor", "property access"],
    ["constructor", "not allowed"],
    ["__proto__", "not allowed"],
    ["prototype", "not allowed"],
    ["col(\"__proto__\")", "not allowed"],
    ["col(\"constructor\")", "not allowed"],
    ["deaths['x']", "indexing"],
    ["`${deaths}`", "template strings"],
    ["eval(\"1\")", "not allowed"],
    ["Function(\"return 1\")", "not allowed"],
    ["process", "not allowed"],
    ["require(\"fs\")", "not allowed"],
    ["globalThis", "not allowed"],
    ["toString(deaths)", "unknown function toString()"],
    ["hasOwnProperty(deaths)", "unknown function hasOwnProperty()"],
    ["valueOf()", "unknown function valueOf()"],
    ["fetch(\"http://x\")", "unknown function fetch()"],
    ["deaths.toString()", "property access"],
    ["(deaths)(1)", "only a function name can be called"],
    ["abs(deaths)(1)", "only a function name can be called"],
    ["x = 1", "assignment"],
    ["1; 2", "only one expression"],
    ["{}", "braces"],
    ["() => 1", "functions (=>) are not allowed"],
    ["new Date()", "not allowed"],
    ["deaths\\u0041", "not allowed"],
    ["$where", "not allowed"],
    ["sum(sum(deaths))", "aggregate inside an aggregate"],
    ["(".repeat(100) + "1" + ")".repeat(100), "nests too deeply"],
  ];

  it("parse refuses everything outside the grammar", () => {
    for (const [src, msg] of BAD) expect(() => inspect(parse(src)), src).toThrow(msg);
  });

  it("compute refuses them as invalid_request", async () => {
    const s = newSession();
    put(s, "data/x/t.csv", "deaths,name\r\n1,a\r\n");
    for (const [src, msg] of BAD) {
      const f = await failure(() => compute(s, { inputs: { t: "data/x/t.csv" }, save_as: "exhibits/x.csv", steps: [{ derive: { y: src } }] }));
      expect(f.code, src).toBe("invalid_request");
      expect(f.message, src).toContain(msg);
    }
    expect(fs.existsSync(path.join(s.workspace, "exhibits/x.csv"))).toBe(false);
  });

  it("allows what it lists", () => {
    for (const src of ["a + b * 2 ** 3 - -c", "a >= 1 && !(b == \"x\") || not c", "if(a > 1, \"hi\", 'lo')", "x ? 1 : 2",
      "round(number(\"1,234.5\") / 3, 2)", "lag(a) / a - 1", "isin(state, \"NY\", \"VT\")", "col(\"a b\") + 1", "1.5e-3"]) {
      expect(() => parse(src), src).not.toThrow();
    }
  });
});

describe("compute verbs", () => {
  function ws(): Session {
    const s = newSession();
    put(s, "data/a/t.csv", "year,state,v,label\r\n2020,MD,1,\"1,234\"\r\n2021,MD,3,\"2,000\"\r\n2020,VA,5,x\r\n2021,VA,,y\r\n");
    put(s, "data/b/u.csv", "year,w\r\n2020,10\r\n2021,20\r\n2022,30\r\n");
    return s;
  }
  const run = (s: Session, steps: any[], inputs: any = { t: "data/a/t.csv", u: "data/b/u.csv" }) => {
    compute(s, { inputs, steps, save_as: "exhibits/out.csv" });
    return read(s, "exhibits/out.csv");
  };

  it("keeps \"1,234\" as text until number(), and refuses arithmetic on text", async () => {
    const s = ws();
    expect(run(s, [{ derive: { n: "number(label) + 1" } }, { select: ["n"] }]).map((r) => r.n)).toEqual(["1235", "2001", "", ""]);
    const f = await failure(() => compute(s, { inputs: { t: "data/a/t.csv" }, save_as: "exhibits/x.csv", steps: [{ derive: { n: "label + 1" } }] }));
    expect(f.message).toContain("convert it with number() first");
  });

  it("propagates gaps, never divides by zero, and keeps leading zeros", () => {
    const s = newSession();
    put(s, "data/a/z.csv", "fips,a,b\r\n01,1,0\r\n24,,2\r\n");
    expect(run(s, [{ derive: { q: "a / b", g: "a + 1", t: "fips + \"x\"" } }], { z: "data/a/z.csv" }))
      .toEqual([{ fips: "01", a: "1", b: "0", q: "", g: "2", t: "01x" }, { fips: "24", a: "", b: "2", q: "", g: "", t: "24x" }]);
  });

  it("joins (inner and left), with pandas suffixes and a note on unmatched rows", () => {
    const s = ws();
    let rows = run(s, [{ join: "u", on: ["year"] }, { select: ["year", "state", "w"] }]);
    expect(rows.map((r) => [r.year, r.state, r.w])).toEqual([["2020", "MD", "10"], ["2021", "MD", "20"], ["2020", "VA", "10"], ["2021", "VA", "20"]]);
    put(s, "data/b/v.csv", "yr,v\r\n2020,100\r\n");
    compute(s, { inputs: { t: "data/a/t.csv", v: "data/b/v.csv" }, save_as: "exhibits/out.csv",
      steps: [{ join: "v", on: { year: "yr" }, how: "left" }] });
    rows = read(s, "exhibits/out.csv");
    expect(Object.keys(rows[0])).toEqual(["year", "state", "v_x", "label", "yr", "v_y"]);
    expect(rows.map((r) => r.v_y)).toEqual(["100", "", "100", ""]);
  });

  it("pivots wider and longer, dedupes, slices, renames, concatenates", async () => {
    const s = ws();
    const wide = run(s, [{ pivot_wider: { names_from: "state", values_from: "v", id_cols: ["year"] } }]);
    expect(wide).toEqual([{ year: "2020", MD: "1", VA: "5" }, { year: "2021", MD: "3", VA: "" }]);
    compute(s, { inputs: { w: "exhibits/out.csv" }, save_as: "exhibits/long.csv",
      steps: [{ pivot_longer: { cols: ["MD", "VA"], names_to: "state", values_to: "v" } }] });
    expect(read(s, "exhibits/long.csv").map((r) => `${r.year}${r.state}${r.v}`)).toEqual(["2020MD1", "2020VA5", "2021MD3", "2021VA"]);
    expect(run(s, [{ dedupe: ["state"] }, { rename: { v: "value" } }, { select: ["state", "value"] }]))
      .toEqual([{ state: "MD", value: "1" }, { state: "VA", value: "5" }]);
    expect(run(s, [{ orderby: ["-v"] }, { slice: 2 }, { select: ["v"] }]).map((r) => r.v)).toEqual(["5", "3"]);
    expect(run(s, [{ select: ["year"] }, { as: "a" }, { from: "u" }, { concat: ["a"] }]).length).toBe(7);
    const f = await failure(() => compute(s, { inputs: { t: "data/a/t.csv" }, save_as: "exhibits/x.csv",
      steps: [{ pivot_wider: { names_from: "state", values_from: "v", id_cols: [] } }] }));
    expect(f.message).toContain("several rows");
  });

  it("windows per group: lag, cumsum", () => {
    const s = ws();
    const rows = run(s, [{ orderby: ["state", "year"] }, { groupby: ["state"], derive: { prev: "lag(v)", run: "cumsum(v)", share: "v / sum(v)" } }]);
    expect(rows.map((r) => [r.state, r.prev, r.run, r.share])).toEqual([["MD", "", "1", "0.25"], ["MD", "1", "4", "0.75"],
      ["VA", "", "5", "1"], ["VA", "5", "5", ""]]);
  });

  it("adds state codes, fiscal years and real dollars with a named index", async () => {
    const s = ws();
    expect(run(s, [{ state_codes: "state" }, { select: ["state_usps", "state_fips", "state_name"] }, { dedupe: true }]))
      .toEqual([{ state_usps: "MD", state_fips: "24", state_name: "Maryland" }, { state_usps: "VA", state_fips: "51", state_name: "Virginia" }]);
    put(s, "data/a/bad.csv", "st\r\nZZ\r\n");
    let f = await failure(() => compute(s, { inputs: { b: "data/a/bad.csv" }, save_as: "exhibits/x.csv", steps: [{ state_codes: "st" }] }));
    expect(f.message).toContain("unknown state 'ZZ': give a USPS code (MD), a FIPS code (24) or a name (Maryland)");
    put(s, "data/a/d.csv", "date\r\n2023-09-30\r\n2023-10-01\r\n");
    expect(run(s, [{ fiscal_year: { date: "date" } }], { d: "data/a/d.csv" }).map((r) => r.fiscal_year)).toEqual(["2023", "2024"]);
    put(s, "data/c/cpi.csv", "year,cpi\r\n2020,250\r\n2021,275\r\n");
    const real = run(s, [{ filter: "state == \"MD\"" }, { deflate: { value: "v", period: "year", index: "cpi", index_value: "cpi",
      name: "CPI-U", base: "2021" } }], { t: "data/a/t.csv", cpi: "data/c/cpi.csv" });
    expect(real.map((r) => Number(r.v_real))).toEqual([1 / (250 / 275), 3]);
    f = await failure(() => compute(s, { inputs: { t: "data/a/t.csv", cpi: "data/c/cpi.csv" }, save_as: "exhibits/x.csv",
      steps: [{ deflate: { value: "v", period: "year", index: "cpi", index_value: "cpi", name: "CPI-U", base: "2019" } }] }));
    expect(f.message).toContain("base period '2019' is not in the index");
    f = await failure(() => compute(s, { inputs: { t: "data/a/t.csv", u: "data/b/u.csv" }, save_as: "exhibits/x.csv",
      steps: [{ deflate: { value: "v", period: "year", index: "u", index_value: "w" } }] }));
    expect(f.message).toContain("name the price index");
  });
});

describe("over MCP", () => {
  it("the tools are listed and their schemas take the documented arguments", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createServer } = await import("../src/server.js");
    const s = newSession();
    put(s, "data/a/t.csv", "year,v\r\n2020,1\r\n2021,3\r\n");
    const server = createServer(s);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["compute", "facts", "rerun", "cite", "handoff"]) expect(names).toContain(t);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { data: JSON.parse(r.content[0].text), isError: !!r.isError };
    };
    let r = await call("compute", { inputs: { t: "data/a/t.csv" }, save_as: "exhibits/g.csv",
      steps: [{ orderby: ["year"] }, { derive: { growth: "v / lag(v) - 1" } }] });
    expect(r.isError).toBe(false);
    expect(r.data.summary.preview).toEqual([{ year: "2020", v: "1", growth: "" }, { year: "2021", v: "3", growth: "2" }]);
    r = await call("facts", { add: [{ name: "g", table: "exhibits/g.csv", where: { year: 2021 }, column: "growth", fmt: "pct:0" }] });
    expect(r.data.summary.added.g).toMatchObject({ value: 2, text: "200 percent", pack: "a" });
    r = await call("rerun", {});
    expect(r.data.summary.reproduced).toBe(true);
    r = await call("handoff", {});
    expect(r.data.text).toContain("### a");
    r = await call("compute", { inputs: { t: "data/a/t.csv" }, save_as: "exhibits/x.csv", steps: [{ derive: { y: "v.constructor" } }] });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("invalid_request");
  });
});

describe("facts and the rerun gate", () => {
  it("registers table and derived facts, with text, and reproduces them", async () => {
    const s = await cdcWorkspace();
    compute(s, { inputs: { c: CAUSES }, save_as: "exhibits/causes.csv", steps: [{ filter: 'cause_name != "All causes"' },
      { derive: { share: "deaths / sum(deaths)" } }] });
    const r = facts(s, {
      add: [{ name: "heart", table: "exhibits/causes.csv", where: { cause_name: "Heart disease" }, column: "deaths", fmt: "num:0",
        label: "Heart disease deaths, New York, 2017", headline: true },
      { name: "all", table: CAUSES, where: { cause_name: "All causes" }, column: "deaths", fmt: "num:0" },
      { name: "heart_share", table: "exhibits/causes.csv", where: { cause_name: "Heart disease" }, column: "share", fmt: "pct:1" }],
      derived: [{ name: "heart_of_all", derivation: "heart / all", fmt: "pct:1" }],
    });
    expect(r.status).toBe("ok");
    const F = JSON.parse(fs.readFileSync(path.join(s.workspace, "facts.json"), "utf8"));
    expect(F.heart).toEqual({ label: "Heart disease deaths, New York, 2017", fmt: "num:0", value: 44092, source: "exhibits/causes.csv",
      where: { cause_name: "Heart disease" }, column: "deaths", headline: true, pack: "cdc", text: "44,092" });
    expect(F.all.pack).toBe("cdc");
    expect(F.heart_share.text).toBe("37.9 percent");
    expect(F.heart_of_all).toMatchObject({ value: 44092 / 155358, derivation: "heart / all", text: "28.4 percent", pack: "cdc" });

    let rr = await rerunWorkspace(s.workspace);
    expect(rr.exhibits).toEqual({ "exhibits/causes.csv": { same: true } });
    expect(Object.values(rr.facts).every((f) => f.same)).toBe(true);
    expect(rr.facts.heart_of_all.rerun).toBe(44092 / 155358);

    // a hand edit of the exhibit is caught, and so is every fact read from it
    const ex = path.join(s.workspace, "exhibits/causes.csv");
    const orig = fs.readFileSync(ex, "utf8");
    fs.writeFileSync(ex, orig.replace("44092", "44000"));
    rr = await rerunWorkspace(s.workspace);
    expect(rr.exhibits["exhibits/causes.csv"].same).toBe(false);
    expect(rr.exhibits["exhibits/causes.csv"].detail).toContain("changed after compute saved it");
    expect(rr.facts.heart.same).toBe(true);                    // read from the replay, which is still 44092
    fs.writeFileSync(ex, orig);
    // changed inputs are named, and the facts read from them move
    const data = path.join(s.workspace, CAUSES);
    fs.writeFileSync(data, fs.readFileSync(data, "utf8").replace("44092", "44000"));
    rr = await rerunWorkspace(s.workspace);
    expect(rr.exhibits["exhibits/causes.csv"].detail).toContain(`inputs changed since it was made: ${CAUSES}`);
    expect(rr.facts.heart).toMatchObject({ stored: 44092, rerun: 44000, same: false });
    expect(rr.facts.heart_of_all.same).toBe(false);
    // the rerun writes nothing
    expect(fs.readFileSync(ex, "utf8")).toBe(orig);
  });

  it("flags an exhibit that compute did not make", async () => {
    const s = newSession();
    put(s, "exhibits/hand.csv", "a\r\n1\r\n");
    const rr = await rerunWorkspace(s.workspace);
    expect(rr.exhibits["exhibits/hand.csv"]).toMatchObject({ same: false });
    expect(rr.exhibits["exhibits/hand.csv"].detail).toContain("no recorded compute steps");
  });

  it("the rerun tool says what was not reproduced", async () => {
    const s = newSession();
    put(s, "exhibits/hand.csv", "a\r\n1\r\n");
    const r: any = await tool("rerun")(s, {});
    expect(r.summary.reproduced).toBe(false);
    expect(r.summary.not_reproduced).toEqual(["exhibits/hand.csv"]);
  });
});
