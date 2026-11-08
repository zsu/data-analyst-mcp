/**
 * facts (facts.py + factfmt.py) and cite (core/cite.py). The facts cases follow
 * tests/test_report_chain.py TestFacts, with the tables saved as CSVs in a session workspace; the format cases pin
 * factfmt's conventions.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { privateAddress } from "../src/analysis/cite.js";
import { formatValue } from "../src/analysis/factfmt.js";
import { pyRound } from "../src/analysis/pyfmt.js";
import { TOOLS } from "../src/analysis/tools.js";
import type { Session } from "../src/session.js";
import { failure, isolate, newSession } from "./helpers.js";

beforeAll(() => isolate());

const tool = (name: string) => TOOLS.find((t) => t.name === name)!.handler;
const facts = (s: Session, a: any) => tool("facts")(s, a) as any;
const factsJson = (s: Session) => JSON.parse(fs.readFileSync(path.join(s.workspace, "facts.json"), "utf8"));

function put(s: Session, rel: string, text: string): void {
  const p = path.join(s.workspace, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function ws(): Session {
  const s = newSession();
  fs.mkdirSync(path.join(s.workspace, "data", "bls"), { recursive: true });
  return s;
}

const derived = (name: string, value: unknown, fmt?: string, extra: Record<string, unknown> = {}) =>
  ({ derived: [{ name, value, derivation: "x", ...(fmt ? { fmt } : {}), ...extra }] });

describe("facts", () => {
  it("reads the cell back, with the only data/<id>/ folder as its pack", () => {
    const s = ws();
    put(s, "exhibits/e.csv", "year,v\r\n2024,1992.47\r\n");
    const r = facts(s, { add: [{ name: "ok", table: "exhibits/e.csv", where: { year: 2024 }, column: "v" }] });
    expect(r.summary.added.ok.value).toBe(1992.47);
    expect(r.summary.added.ok.pack).toBe("bls");
    expect(r.summary.added.ok).toEqual({ value: 1992.47, text: r.summary.added.ok.text, pack: "bls" }); // no input echo
    expect(JSON.parse(fs.readFileSync(path.join(s.workspace, "facts.json"), "utf8")).ok.where).toEqual({ year: "2024" });
  });

  it("refuses empty cells, missing rows and columns, and text", async () => {
    const s = ws();
    put(s, "exhibits/e.csv", "year,v,t\r\n2024,,a\r\n2025,3,b\r\n2025,4,c\r\n");
    const one = (where: any, column: string) => failure(() => facts(s, { add: [{ name: "f", table: "exhibits/e.csv", where, column }] }));
    expect((await one({ year: 2024 }, "v")).message).toBe("fact f: the cell is empty (a gap or a flagged value); do not cite it");
    expect((await one({ year: 2025 }, "v")).message).toContain("fact f: where={'year': 2025} matches 2 rows of e.csv (need exactly 1");
    expect((await one({ year: 2024 }, "w")).message).toBe("fact f: ['w'] not in the table; its columns are ['year', 'v', 't']");
    expect((await one({ year: 2024 }, "t")).message).toBe("fact f: t = 'a' in e.csv is not a number");
    expect((await failure(() => facts(s, { add: [{ name: "f", table: "exhibits/none.csv", where: {}, column: "v" }] }))).message)
      .toBe("fact f: save exhibits/none.csv before registering facts from it");
    expect(fs.existsSync(path.join(s.workspace, "facts.json"))).toBe(false);
  });

  it("refuses NaN and units slips, accepts the right scales", async () => {
    const s = ws();
    const bad = async (a: any, msg: string) => expect((await failure(() => facts(s, a))).message).toContain(msg);
    await bad(derived("n", Number.NaN), "value is NaN");
    await bad(derived("s", 1832.8, "usd_b:1"), "looks already scaled");
    facts(s, derived("s2", 1832.8, "usd_b_scaled:1"));
    await bad(derived("m", 5403326.76, "usd_b:1"), "prints as '$0.0 billion'");
    await bad(derived("d", 5403326758960.8, "usd_b_scaled:1"), "a value already in dollars given to a *_scaled");
    facts(s, derived("z", -0.027, "pct100:1"));                  // a rate may round to 0.0 percent
    await bad(derived("g", -2.6, "pp:1:abs"), "use pp100");
    facts(s, derived("g2", -0.026, "pp:1:abs"));
    await bad(derived("p", 27.4, "pct:1"), "a value already in percent takes pct100");
    await bad(derived("f", 1, "nope:1"), "unknown fact format 'nope:1'");
    await bad({ derived: [{ name: "w", value: 1, derivation: "" }] }, "give table/where/column, or value with derivation");
    await bad({ derived: [{ name: "bad name", value: 1, derivation: "x" }] }, "letters, digits and _ only");
    expect(Object.keys(factsJson(s))).toEqual(["s2", "z", "g2"]);
    expect(factsJson(s).z.text).toBe("0.0 percent");
  });

  it("infers the pack, or refuses when two sources leave it open", async () => {
    const s = ws();
    fs.mkdirSync(path.join(s.workspace, "data", "bea"), { recursive: true });
    expect((await failure(() => facts(s, derived("x", 1)))).message).toContain("say which source pack the number comes from");
    expect(facts(s, derived("e", 1, undefined, { pack: "bea" })).summary.added.e.pack).toBe("bea");
    expect(facts(s, derived("l", 1, undefined, { pack: ["bls", "bea"] })).summary.added.l.pack).toEqual(["bls", "bea"]);
    put(s, "data/bea/t.csv", "k,v\r\na,2.0\r\n");
    expect(facts(s, { add: [{ name: "d", table: "data/bea/t.csv", where: { k: "a" }, column: "v" }] }).summary.added.d.pack).toBe("bea");
    // an exhibit made by compute carries its packs
    TOOLS.find((t) => t.name === "compute")!.handler(s, { inputs: { t: "data/bea/t.csv" }, save_as: "exhibits/x.csv", steps: [],
      packs: ["bls"] });
    expect(facts(s, { add: [{ name: "x2", table: "exhibits/x.csv", where: { k: "a" }, column: "v" }] }).summary.added.x2.pack).toBe("bls");
    // so does a lineage entry in the Python list form
    put(s, "exhibits/y.csv", "k,v\r\na,3.0\r\n");
    const lin = JSON.parse(fs.readFileSync(path.join(s.workspace, "exhibits/lineage.json"), "utf8"));
    fs.writeFileSync(path.join(s.workspace, "exhibits/lineage.json"), JSON.stringify({ ...lin, "exhibits/y.csv": ["bea", "bls"] }));
    expect(facts(s, { add: [{ name: "y", table: "exhibits/y.csv", where: { k: "a" }, column: "v" }] }).summary.added.y.pack).toEqual(["bea", "bls"]);
    expect(facts(s, { ...derived("z", 1), pack: "bls" }).summary.added.z.pack).toBe("bls");
    // an agency page's figure has no pack, even with a default
    put(s, "published/umich.csv", "k,v\r\na,46.3\r\n");
    const pub = { add: [{ name: "p", table: "published/umich.csv", where: { k: "a" }, column: "v" }] };
    expect(facts(s, pub).summary.added.p).not.toHaveProperty("pack");
    expect(facts(s, { ...pub, pack: "bls" }).summary.added.p).not.toHaveProperty("pack");
    expect(facts(s, derived("d2", 1, undefined, { pack: [] })).summary.added.d2).not.toHaveProperty("pack");
    // a CSV value on a rounding tie for its format ("21.55" printed as "21.6") gets a note
    put(s, "exhibits/tie.csv", "k,v\r\na,21.55\r\n");
    const r = facts(s, { add: [{ name: "t", table: "exhibits/tie.csv", where: { k: "a" }, column: "v", fmt: "num:1", pack: "bls" }] });
    expect(r.notes.join("\n")).toContain("rounding tie");
  });

  it("writes text and the flags", () => {
    const s = ws();
    facts(s, derived("p", 0.25, "pct:0", { preliminary: true, vintage: "2020-07-30", projection: true }));
    const rec = factsJson(s).p;
    expect(rec.text).toBe("25 percent");
    expect(rec.preliminary && rec.projection).toBe(true);
    expect(rec.vintage).toBe("2020-07-30");
    expect(Object.keys(rec)).toEqual(["label", "fmt", "value", "derivation", "preliminary", "vintage", "projection", "pack", "text"]);
  });

  it("computes a derivation over fact names, and refuses a value that disagrees", async () => {
    const s = ws();
    put(s, "exhibits/e.csv", "year,v\r\n2020,200\r\n2024,250\r\n");
    facts(s, { add: [{ name: "a", table: "exhibits/e.csv", where: { year: 2020 }, column: "v" },
      { name: "b", table: "exhibits/e.csv", where: { year: 2024 }, column: "v" }],
    derived: [{ name: "growth", derivation: "b / a - 1", fmt: "pct:1" }, { name: "twice", derivation: "growth * 2", value: 0.5 }] });
    const F = factsJson(s);
    expect(F.growth).toMatchObject({ value: 0.25, text: "25.0 percent" });
    expect(F.twice.value).toBe(0.5);
    const f = await failure(() => facts(s, { derived: [{ name: "bad", derivation: "b - a", value: 49 }] }));
    expect(f.message).toContain("differs from its derivation b - a = 50");
    const z = await failure(() => facts(s, { derived: [{ name: "z", derivation: "a / (b - b)" }] }));
    expect(z.message).toContain("gives no value");
  });
});

describe("factfmt", () => {
  it("follows the conventions", () => {
    expect(formatValue(6, "signed:num:0")).toBe("+6");
    expect(formatValue(6, "num:0")).toBe("six");
    expect(formatValue(6, "num:0", "answer")).toBe("6");
    expect(formatValue(2.25, "ratio:1")).toBe("2.3");                   // half away from zero on the shortest form
    expect(formatValue(0.145, "pct:0")).toBe("15 percent");
    expect(formatValue(-0.0001, "dollars:0")).toBe("$0");               // no minus sign on zero
    expect(formatValue(-0.04, "signed:pct100:1")).toBe("0.0 percent");
    expect(formatValue(0.4, "signed:pct100:1")).toBe("+0.4 percent");
    expect(formatValue(0.01, "pp:0")).toBe("1 percentage point");
    expect(formatValue(0.1, "pp100:1")).toBe("0.1 percentage point");
    expect(formatValue(1.5, "pp100:1")).toBe("1.5 percentage points");
    expect(formatValue(0.0001, "bp:0")).toBe("1 basis point");
    expect(formatValue(80612, "dollars:-2")).toBe("$80,600");
    expect(formatValue(34.3, "dollars:2")).toBe("$34.30");
    expect(formatValue(254, "thousands:-3")).toBe("254,000");
    expect(formatValue(159044, "kmillions:1")).toBe("159.0 million");
    expect(formatValue(1.8328e12, "usd_b:1")).toBe("$1,832.8 billion");
    expect(formatValue(970065, "from_millions:dollars_b:1")).toBe("$970.1 billion");
    expect(formatValue(31422.5, "from_billions:dollars_t:1")).toBe("$31.4 trillion");
    expect(formatValue(-12.34, "pct100:1:abs")).toBe("12.3 percent");
    expect(formatValue(2015.0, "year")).toBe("2015");
    expect(formatValue(0.1 + 0.2)).toBe("0.3");
    expect(formatValue(2015.0)).toBe("2015");
    expect(formatValue("text")).toBe("text");
    expect(() => formatValue(1, "pct:1:x")).toThrow("only ':digits' and ':abs'");
  });

  it("round() is Python's: half to even on the binary value", () => {
    expect([pyRound(0.5), pyRound(1.5), pyRound(2.5), pyRound(2.675, 2), pyRound(-0.5), pyRound(1234.5, -1)])
      .toEqual([0, 2, 2, 2.67, -0, 1230]);
  });
});

describe("cite", () => {
  afterEach(() => {
    delete process.env.DATA_ANALYST_MODE;
  });

  it("saves the text the model's fetch tool returned and records it", async () => {
    const s = newSession();
    const r: any = await tool("cite")(s, { url: "https://www.bls.gov/cpi/", id: "bls-cpi", text: "<html><body>The CPI measures...</body></html>" });
    expect(r.status).toBe("ok");
    expect(r.summary.file).toBe("references/bls-cpi.html");
    const log = JSON.parse(fs.readFileSync(path.join(s.workspace, "references/opened.json"), "utf8"));
    expect(log["bls-cpi"]).toMatchObject({ url: "https://www.bls.gov/cpi/", file: "references/bls-cpi.html", via: "file", bytes: 45 });
    expect(log["bls-cpi"].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(log["bls-cpi"].opened).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    // one snapshot per reference: a later one in another format replaces it
    await tool("cite")(s, { url: "https://www.bls.gov/cpi/", id: "bls-cpi", text: "plain text now" });
    expect(fs.readdirSync(path.join(s.workspace, "references")).sort()).toEqual(["bls-cpi.txt", "opened.json"]);
  });

  it("refuses bad ids, non-http URLs and empty text", async () => {
    const s = newSession();
    expect((await failure(tool("cite")(s, { url: "https://x.gov", id: "a b", text: "x" }) as Promise<unknown>)).message).toContain("letters, digits");
    expect((await failure(tool("cite")(s, { url: "file:///etc/passwd", id: "a", text: "x" }) as Promise<unknown>)).message).toContain("http(s) URL");
    expect((await failure(tool("cite")(s, { url: "https://x.gov", id: "a", text: "  " }) as Promise<unknown>)).message).toContain("empty");
  });

  it("in remote mode, refuses private and loopback addresses before any request", async () => {
    process.env.DATA_ANALYST_MODE = "remote";
    const s = newSession();
    for (const url of ["http://127.0.0.1/", "http://10.1.2.3/x", "http://172.16.0.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "http://localhost:8080/", "http://0.0.0.0/"]) {
      const f = await failure(tool("cite")(s, { url, id: "x" }) as Promise<unknown>);
      expect(f.code, url).toBe("invalid_request");
      expect(f.message, url).toMatch(/^refused/);
    }
    expect(fs.existsSync(path.join(s.workspace, "references"))).toBe(false);
  });

  it("classifies addresses", () => {
    for (const a of ["10.0.0.1", "172.31.255.255", "192.168.0.1", "127.0.0.1", "169.254.1.1", "::1", "fc00::1", "fdff::1", "fe80::1",
      "::ffff:10.0.0.1", "::ffff:7f00:1"]) expect(privateAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "172.32.0.1", "192.169.0.1", "2607:f8b0:4004::200e", "23.1.1.1"]) expect(privateAddress(a), a).toBe(false);
  });
});
