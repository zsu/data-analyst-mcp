/**
 * The method record (src/report/method_audit.ts) and the quick-answer gate (src/report/audit_answer.ts): a port of
 * tests/test_method_audit.py. The workspace is written directly (decisions.json, facts.json, exhibits/*.csv,
 * references/ snapshots as the cite tool saves them, data/bls/request.json); the bls pack's real policy is used with
 * synthetic numbers that stand for no real BLS series. The rerun gate's own replay (src/analysis/rerun.ts) is
 * replaced by a stub here, so these tests check how the audits report its results.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rerunStub = vi.hoisted(() => ({ impl: null as null | ((w: string) => any) }));
vi.mock("../src/analysis/rerun.js", async (orig) => {
  const real: any = await orig();
  return { ...real, rerunWorkspace: (w: string) => (rerunStub.impl ? rerunStub.impl(w) : real.rerunWorkspace(w)) };
});

import * as A from "../src/report/audit_answer.js";
import { findUrls, checkUrl } from "../src/report/audit_report.js";
import * as MA from "../src/report/method_audit.js";
import type { Result } from "../src/report/method_audit.js";
import { isolate } from "./helpers.js";

const DK = "Don't know — decide for me";
const GOOD: any = {
  questions: [
    { id: "dollar_basis", question: "Nominal or real dollars?", asked: true, options: ["Real, CPI-U (recommended)", "Nominal", DK],
      answer: "dont_know", how: "dont_know", resolution: "Real dollars, CPI-U", assumption: "deflator" },
    { id: "period", question: "Which years?", asked: true, options: ["Last 10 years (recommended)", "Since 2000", DK],
      answer: "Since 2000", assumption: "span" }],
  literature_search: [{ query: "CPI-U deflating wages methodology", date: "2026-10-20", tool: "WebSearch", found: ["cpi_hb"] },
    { query: "regional wage deflators", date: "2026-10-20", found: [], note: "nothing beyond the handbook" }],
  references: [{ id: "cpi_hb", citation: "Test Agency, *Handbook of Methods*", url: "https://example.org/hb", accessed: "2026-10-20",
    opened: true, used_for: "deflator", quote: "Wages are deflated with the CPI-U." }],
  assumptions: [
    { parameter: "deflator", value: "CPI-U", basis: "precedent", evidence: "The agency deflates wages with the CPI-U [@cpi_hb]." },
    { parameter: "span", value: "Since 2000", basis: "user", evidence: "The user chose it.", question: "period" },
    { parameter: "trend", value: "Linear", basis: "empirical", evidence: "Fitted in exhibits/trend.csv; slope {{slope}}." },
    { parameter: "top_code", value: "Exclude top-coded rows", basis: "judgment", evidence: "No source settles it.",
      why_not_empirical: "The extract has no uncapped values.", sensitivity: "top_code" }],
  data_needs: [{ id: "uncapped", data: "Uncapped earnings records", improves: ["top_code"], effect: "an empirical top-code adjustment",
    how_to_get: "your payroll file", from_user: true }],
};
const SENS = "parameter,base,alternative,headline_base,headline_alt,conclusion_changes\ntop_code,exclude,include,0.5,0.42,no\n";
const BENCH = "measure,period,computed,published,source\nslope,2024,0.5,0.5,Test Agency\n";
const FACTS: any = {
  slope: { value: 0.5, source: "exhibits/trend.csv", where: { year: "2024" }, column: "slope", pack: "bls", headline: true },
  slope_incl: { value: 0.42, derivation: "trend refit with top-coded rows included", pack: "bls" } };
const HANDBOOK = "<html><body><h1>Handbook</h1><p>Wages are deflated with the CPI-U.</p></body></html>";
const ANSWER = "The 2024 slope was 0.5 (BLS, retrieved 2026-10-20; subject to revision), the same as the published figure. " +
  "BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.\n";

const copy = <T>(x: T): T => structuredClone(x);
let out = "";
const P = (...p: string[]) => path.join(out, ...p);
function write(p: string, text: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof text === "string" ? text : JSON.stringify(text, null, 2));
}
/** What the cite tool saves: references/<id><ext> and its opened.json record. */
function snapshot(url: string, id: string, text: string, ext = ".html"): void {
  const rel = `references/${id}${ext}`;
  write(P(rel), text);
  const logp = P("references", "opened.json");
  const log = fs.existsSync(logp) ? JSON.parse(fs.readFileSync(logp, "utf8")) : {};
  log[id] = { url, file: rel, sha256: crypto.createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text),
    opened: "2026-10-20T12:00:00Z", via: "file", content_type: "" };
  write(logp, log);
}
const fails = (r: Result[], check?: string) => r.filter(([c, ok]) => !ok && (check === undefined || c === check));
const msgs = (r: Result[], check?: string) => fails(r, check).map(([, , m]) => m);
const check = (D: any, F = FACTS) => MA.checkMethod(D, out, F);
const toks = (s: string) => A.answerNumbers(s).map((n) => n.tok);
const disp = (f: any) => A.factDisplay(f)!;
const audit = (o: { rerun?: boolean } = {}) => A.audit(out, false, !!o.rerun);

beforeEach(() => {
  isolate();
  rerunStub.impl = null;
  out = fs.mkdtempSync(path.join(os.tmpdir(), "da-method-"));
  write(P("exhibits", "trend.csv"), "year,slope\n2024,0.5\n");
  write(P("exhibits", "sensitivity.csv"), SENS);
  write(P("exhibits", "benchmark.csv"), BENCH);
  snapshot("https://example.org/hb", "cpi_hb", HANDBOOK);
});
afterEach(() => fs.rmSync(out, { recursive: true, force: true }));

describe("method rules", () => {
  it("a good record passes", () => expect(fails(check(GOOD))).toEqual([]));

  it("offers one Don't know option and no Skip", () => {
    const D = copy(GOOD);
    D.questions[0].options = ["Real", "Nominal"];
    expect(fails(check(D), "questions").length).toBeGreaterThan(0);
    D.questions[0].options = ["Real", "Skip", DK];
    expect(msgs(check(D), "questions").some((m) => m.includes("Skip"))).toBe(true);
    D.questions[0].options = ["Real", DK, "I don't know"];
    expect(fails(check(D), "questions").length).toBeGreaterThan(0);
  });

  it("skip and not asked count as Don't know", () => {
    for (const how of ["dont_know", "skipped", "not_asked"]) {
      const D = copy(GOOD);
      const q = D.questions[0];
      Object.assign(q, { how, answer: how });
      if (how === "not_asked") {
        Object.assign(q, { asked: false, reason_code: "no_user" });
        D.disclosures = { dollar_basis: "Nobody could be asked about dollars; real CPI-U was used." };
      }
      expect(fails(check(D)), how).toEqual([]);
      delete q.resolution;
      expect(fails(check(D), "questions").length, how).toBeGreaterThan(0);
    }
  });

  it("not asked needs a reason code and a disclosure", () => {
    const D = copy(GOOD);
    const q = D.questions[0];
    Object.assign(q, { asked: false, how: "not_asked", answer: "not_asked", reason: "non-interactive run" });
    expect(fails(check(D), "questions").length).toBeGreaterThan(0);              // free text is not enough
    q.reason_code = "no_user";
    expect(msgs(check(D), "disclosures").some((m) => m.includes("dollar_basis"))).toBe(true);
    D.disclosures = { dollar_basis: "Not asked: no user could answer; real CPI-U dollars were used." };
    const r = check(D);
    expect(fails(r)).toEqual([]);
    expect(r.some(([c, ok, m]) => ok && c === "disclosures" && m.includes("disclose"))).toBe(true);
  });

  it("settled_by_request needs the quote and counts as answered", () => {
    const D = copy(GOOD);
    const q = D.questions[1];
    Object.assign(q, { asked: false, answer: null, reason_code: "settled_by_request" });
    expect(fails(check(D)).length).toBeGreaterThan(0);
    q.request = "since 2000";
    expect(fails(check(D))).toEqual([]);
  });

  it("a user basis can quote the request", () => {
    const D = copy(GOOD);
    D.questions = D.questions.slice(0, 1);
    delete D.assumptions[1].question;
    expect(fails(check(D), "assumptions").length).toBeGreaterThan(0);
    D.assumptions[1].request = "how have wages changed since 2000";
    expect(fails(check(D), "assumptions")).toEqual([]);
  });

  it("judgment needs no evidence field; precedent does", () => {
    const D = copy(GOOD);
    delete D.assumptions[3].evidence;
    expect(fails(check(D), "assumptions")).toEqual([]);
    delete D.assumptions[0].evidence;
    expect(msgs(check(D), "assumptions").some((m) => m.includes("evidence"))).toBe(true);
  });

  it("a Don't know cannot rest on a user basis", () => {
    const D = copy(GOOD);
    D.questions[0].assumption = "span";
    expect(fails(check(D), "questions").length).toBeGreaterThan(0);
  });

  it("blocking question", () => {
    const D = copy(GOOD);
    Object.assign(D.questions[0], { blocking: true, how: "skipped" });
    expect(fails(check(D), "questions").length).toBeGreaterThan(0);              // no rationale, no follow-up
    D.questions[0].rationale = "literal reading: all states";
    expect(fails(check(D), "questions").length).toBeGreaterThan(0);              // still no follow-up
    D.questions[0].followed_up = true;
    const r = check(D);
    expect(fails(r)).toEqual([]);
    expect(r.some(([, ok, m]) => ok && m.includes("opening paragraph of the answer"))).toBe(true);
  });

  it("literature is required", () => {
    const D = copy(GOOD);
    D.literature_search = [];
    expect(fails(check(D), "literature").length).toBeGreaterThan(0);
    D.literature_search = [{ unavailable: true }];
    expect(fails(check(D), "literature").length).toBeGreaterThan(0);
    D.literature_search = [{ unavailable: true, reason: "no search tool here" }];
    expect(fails(check(D), "literature").length).toBeGreaterThan(0);             // free text is not enough
    D.literature_search = [{ unavailable: true, reason_code: "no_search_tool" }];
    expect(fails(check(D), "literature")).toEqual([]);
    expect(fails(check(D), "disclosures").length).toBeGreaterThan(0);            // and the answer must say so
    D.disclosures = { literature: "No literature search was run: this environment has no search tool." };
    expect(fails(check(D))).toEqual([]);
    D.literature_search = [{ query: "x", date: "2026-10-20", found: ["nope"] }];
    expect(fails(check(D), "literature").length).toBeGreaterThan(0);
  });

  it("a reference must be opened", () => {
    let D = copy(GOOD);
    D.references[0].opened = false;
    const bad = fails(check(D));
    expect(bad.some(([c]) => c === "references")).toBe(true);
    expect(bad.some(([c, , m]) => c === "assumptions" && m.includes("deflator"))).toBe(true);
    D = copy(GOOD);
    D.assumptions[0].evidence = "See [@missing].";
    expect(msgs(check(D), "references").some((m) => m.includes("[@missing]"))).toBe(true);
  });

  it("empirical needs an existing CSV or fact", () => {
    const D = copy(GOOD);
    D.assumptions[2].evidence = "Fitted in exhibits/missing.csv.";
    expect(fails(check(D), "assumptions").length).toBeGreaterThan(0);
    D.assumptions[2].evidence = "Slope {{slope}}.";
    expect(fails(check(D), "assumptions")).toEqual([]);
  });

  it("a user basis needs a user answer", () => {
    const D = copy(GOOD);
    Object.assign(D.questions[1], { answer: "dont_know", resolution: "Since 2000" });
    expect(fails(check(D), "assumptions").length).toBeGreaterThan(0);
  });

  it("judgment needs why_not_empirical and a sensitivity row", () => {
    let D = copy(GOOD);
    delete D.assumptions[3].why_not_empirical;
    expect(fails(check(D), "assumptions").length).toBeGreaterThan(0);
    D = copy(GOOD);
    D.assumptions[3].sensitivity = "other";
    expect(fails(check(D), "assumptions").length).toBeGreaterThan(0);
    fs.rmSync(P("exhibits", "sensitivity.csv"));
    expect(fails(check(GOOD), "assumptions").length).toBeGreaterThan(0);
  });

  it("an unknown basis fails", () => {
    const D = copy(GOOD);
    D.assumptions[0].basis = "expert opinion";
    expect(fails(check(D), "assumptions").length).toBeGreaterThan(0);
  });

  it("data needs", () => {
    let D = copy(GOOD);
    D.data_needs = [];
    expect(msgs(check(D), "data_needs").some((m) => m.includes("top_code"))).toBe(true);
    delete D.data_needs;
    expect(fails(check(D), "data_needs").length).toBeGreaterThan(0);
    D = copy(GOOD);
    delete D.data_needs[0].how_to_get;
    expect(fails(check(D), "data_needs").length).toBeGreaterThan(0);
    D = copy(GOOD);                                   // an unchecked benchmark needs an entry too
    write(P("exhibits", "benchmark.csv"), BENCH + "wage,2024,30,not checked,Test Agency\n");
    expect(msgs(check(D), "data_needs").some((m) => m.includes("wage"))).toBe(true);
    D.data_needs[0].improves.push("wage");
    expect(fails(check(D), "data_needs")).toEqual([]);
  });

  it("no data needs with a note", () => {
    const D = copy(GOOD);
    D.assumptions = D.assumptions.slice(0, 3);
    D.data_needs = [];
    expect(fails(check(D), "data_needs").length).toBeGreaterThan(0);
    D.data_needs_note = "The agency publishes every value used.";
    expect(fails(check(D))).toEqual([]);
  });

  it("benchmark compares values", () => {
    const bench = P("exhibits", "benchmark.csv");
    const head = "measure,period,computed,published,source,url,accessed,match,note\n";
    const rows = (rs: string[][]) => head + rs.map(([m, p, c, pb, y, n]) => `${m},${p},${c},${pb},src,https://x.gov,2026-10-21,${y},${n}\n`).join("");
    write(bench, rows([["slope", "2024", "0.5", "0.5", "", ""], ["rate", "2026", "3.419", "3.4", "yes", ""],
      ["earnings", "2025", "72376", "72380", "yes", "Census rounds medians to $10"], ["level", "2025", "23943307", "23943305", "", ""],
      ["votes", "2022", "219 D / 24 R", "219 D / 24 R", "yes", ""], ["laws", "2024", "5", "not checked", "", ""]]));
    expect(fails(MA.checkBenchmark(out, FACTS))).toEqual([]);
    write(bench, rows([["slope", "2024", "0.5", "0.6", "yes", ""]]));            // says yes, differs
    expect(msgs(MA.checkBenchmark(out)).some((m) => m.includes("says it matches"))).toBe(true);
    write(bench, rows([["slope", "2024", "0.5", "0.6", "no", ""]]));             // differs, no cause given
    expect(msgs(MA.checkBenchmark(out)).some((m) => m.includes("differ by more than rounding"))).toBe(true);
    write(bench, rows([["slope", "2024", "0.5", "0.6", "no", "BLS excludes self-employed"]]));
    expect(fails(MA.checkBenchmark(out))).toEqual([]);
    expect(MA.benchNumber("$72,380")).toEqual([72380, 0.5]);                    // exact unless a note says rounded
    expect(MA.benchNumber("140,000")).toEqual([140000, 140]);                   // three zeros: rounding, capped
    write(bench, rows([["deficit", "2025", "-931964", "-931960", "yes", ""]]));  // an exact count, off by 4
    expect(fails(MA.checkBenchmark(out)).length).toBeGreaterThan(0);
    expect(MA.benchNumber("1992473.0")).toEqual([1992473, 0.5]);
    expect(MA.benchNumber("219 D / 24 R")).toBeNull();
    expect(MA.isFact(2209848, 0.5, [-2209848.0])).toBe(true);                  // a decline written without its sign
    write(bench, rows([["m2", "2026", "5.66", "5.65891", "yes", ""]]));         // computed shown rounded: agrees
    expect(fails(MA.checkBenchmark(out))).toEqual([]);
    write(bench, rows([["m2", "2026", "6", "5.65891", "yes", ""]]));            // but not to any coarse rounding
    expect(fails(MA.checkBenchmark(out)).length).toBeGreaterThan(0);
    write(bench, rows([["dsr", "2026", "11.111", "11.31", "yes", "within published rounding"]]));
    expect(fails(MA.checkBenchmark(out)).length).toBeGreaterThan(0);             // a "rounding" note cannot excuse 0.2
    write(bench, rows([["earnings", "2025", "72376", "72380", "yes", "Census rounds medians to $10"]]));
    expect(fails(MA.checkBenchmark(out))).toEqual([]);
    write(bench, rows([["debt", "2026", "32425013", "32525013", "yes", "rounded to $1 million"]]));
    expect(fails(MA.checkBenchmark(out)).length).toBeGreaterThan(0);             // a $100 billion gap is no rounding
    write(bench, rows([["income", "2025", "72376", "72400", "yes", "published rounded to $100"]]));
    expect(fails(MA.checkBenchmark(out))).toEqual([]);
    write(bench, rows([["pages", "2025", "16494", "16336", "yes", "computed is around the published value"]]));
    expect(fails(MA.checkBenchmark(out)).length).toBeGreaterThan(0);             // "around" is not "rounding"
    write(bench, head + "Median days, 119th Congress,2026,194,999,src,https://x.gov,2026-10-21,,x\n");
    expect(msgs(MA.checkBenchmark(out)).some((m) => m.includes("quote fields"))).toBe(true);   // shifted row
  });

  it("benchmark file", () => {
    expect(fails(MA.checkBenchmark(out))).toEqual([]);
    fs.rmSync(P("exhibits", "benchmark.csv"));
    expect(fails(MA.checkBenchmark(out)).length).toBeGreaterThan(0);
  });

  it("merged prefers report.json", () => {
    write(P("decisions.json"), GOOD);
    const R = MA.merged(out, { assumptions: [{ parameter: "deflator", value: "PCE" }] });
    expect(R.assumptions.find((a: any) => a.parameter === "deflator").value).toBe("PCE");
    expect(R.assumptions.length).toBe(4);
    expect(R.references[0].id).toBe("cpi_hb");
    expect(R.questions.length).toBe(2);
  });
});

describe("hard evidence", () => {
  const sens = (rows: string[], cols = "parameter,base,alternative,headline_base,headline_alt,conclusion_changes") => {
    write(P("exhibits", "sensitivity.csv"), cols + "\n" + rows.map((r) => r + "\n").join(""));
    return check(GOOD).filter(([c, ok]) => c === "sensitivity" && !ok).map(([, , m]) => m);
  };

  it("sensitivity headlines must be registered facts", () => {
    expect(sens(["top_code,exclude,include,0.5,0.42,no"])).toEqual([]);
    expect(sens(["top_code,exclude,include,0.5,0.9,no"]).some((m) => m.includes("not a registered fact"))).toBe(true);
    expect(sens(["top_code,exclude,include,0.5,higher,no"]).some((m) => m.includes("not one number"))).toBe(true);
    const cols = "parameter,base,alternative,headline_base,headline_alt,conclusion_changes,fact_base,fact_alt";
    expect(sens(["top_code,exclude,include,,,no,slope,slope_incl"], cols)).toEqual([]);
    expect(sens(["top_code,exclude,include,,,no,slope,nope"], cols).some((m) => m.includes("fact_alt"))).toBe(true);
    expect(sens(["top_code,exclude,include,0.5,0.6,no,slope,slope_incl"], cols).some((m) => m.includes("is not fact"))).toBe(true);
  });

  it("conclusion_changes must agree with the numbers", () => {
    const F = { ...FACTS, neg: { value: -0.1, derivation: "x", pack: "bls" } };
    write(P("exhibits", "sensitivity.csv"), "parameter,base,alternative,headline_base,headline_alt,conclusion_changes\n" +
      "top_code,exclude,include,0.5,-0.1,no\n");
    expect(check(GOOD, F).some(([c, ok, m]) => c === "sensitivity" && !ok && m.includes("changes sign"))).toBe(true);
    const cols = "parameter,base,alternative,headline_base,headline_alt,conclusion_changes,threshold\n";
    for (const [row, bad] of [["0.5,0.42,no,0.45", true], ["0.5,0.42,yes,0.45", false], ["0.5,0.42,no,0.4", false],
      ["0.5,0.42,maybe,", true]] as [string, boolean][]) {
      write(P("exhibits", "sensitivity.csv"), cols + "top_code,exclude,include," + row + "\n");
      expect(check(GOOD).some(([c, ok]) => c === "sensitivity" && !ok), row).toBe(bad);
    }
    // a sign flip is a change even when both headlines are on one side of the threshold
    for (const [row, bad] of [["0.5,-0.1,no,1.0", true], ["0.5,-0.1,yes,1.0", false]] as [string, boolean][]) {
      write(P("exhibits", "sensitivity.csv"), cols + "top_code,exclude,include," + row + "\n");
      const got = check(GOOD, F).filter(([c, ok]) => c === "sensitivity" && !ok).map(([, , m]) => m);
      expect(got.length > 0, row).toBe(bad);
      if (bad) expect(got[0]).toContain("differ in sign");
    }
  });

  it("a reference needs a saved snapshot", () => {
    fs.rmSync(P("references", "opened.json"));
    const bad = fails(check(GOOD));
    expect(bad.some(([c, , m]) => c === "references" && m.includes("cite tool"))).toBe(true);
    expect(bad.some(([c, , m]) => c === "assumptions" && m.includes("deflator"))).toBe(true);
  });

  it("the snapshot must be unchanged and of the cited URL", () => {
    fs.appendFileSync(P("references", "cpi_hb.html"), "<p>edited</p>");
    expect(msgs(check(GOOD), "references").some((m) => m.includes("changed"))).toBe(true);
    snapshot("https://example.org/other", "cpi_hb", HANDBOOK);
    expect(msgs(check(GOOD), "references").some((m) => m.includes("not https://example.org/hb"))).toBe(true);
  });

  it("the quote must be on the page", () => {
    const D = copy(GOOD);
    D.references[0].quote = "Wages are deflated with the PCE price index.";
    expect(msgs(check(D), "references").some((m) => m.includes("not in references/cpi_hb.html"))).toBe(true);
    D.references[0].quote = "CPI-U";
    expect(msgs(check(D), "references").some((m) => m.includes("too short"))).toBe(true);
    D.references[0].quote = "wages are DEFLATED with the cpi u";               // case and punctuation do not matter
    expect(fails(check(D))).toEqual([]);
    delete D.references[0].quote;                                               // opened, but supports nothing
    expect(fails(check(D), "references")).toEqual([]);
    expect(msgs(check(D), "assumptions").some((m) => m.includes("quote"))).toBe(true);
  });

  it("a numeric parameter from the literature needs why_not_empirical", () => {
    const D = copy(GOOD);
    D.assumptions[0].value = "0.35";
    expect(msgs(check(D), "assumptions").some((m) => m.includes("estimate"))).toBe(true);
    D.assumptions[0].why_not_empirical = "The extract has one year: no variation identifies it.";
    expect(fails(check(D), "assumptions")).toEqual([]);
  });

  it("an empirical CSV must name the parameter", () => {
    const D = copy(GOOD);
    write(P("exhibits", "exhibit_1.csv"), "year,value\n2024,1\n");
    D.assumptions[2].evidence = "Fitted in exhibits/exhibit_1.csv.";
    expect(fails(check(D), "assumptions").length).toBeGreaterThan(0);
    write(P("exhibits", "exhibit_1.csv"), "year,trend_slope\n2024,1\n");
    expect(fails(check(D), "assumptions")).toEqual([]);
  });

  it("every headline has a benchmark row", () => {
    expect(fails(MA.checkBenchmark(out, FACTS))).toEqual([]);
    let F = copy(FACTS);
    F.slope_incl.headline = true;
    expect(msgs(MA.checkBenchmark(out, F)).some((m) => m.includes("headline slope_incl"))).toBe(true);
    write(P("exhibits", "benchmark.csv"), BENCH + "Refit slope,2024,0.42,not checked,Test Agency\n");   // matched by value
    expect(fails(MA.checkBenchmark(out, F))).toEqual([]);
    F = copy(FACTS);
    delete F.slope.headline;
    expect(msgs(MA.checkBenchmark(out, F)).some((m) => m.includes("no headline facts"))).toBe(true);
  });
});

describe("answer gate", () => {
  beforeEach(() => {
    write(P("decisions.json"), GOOD);
    write(P("facts.json"), FACTS);
    write(P("data", "bls", "request.json"), { source: "bls", route: "api_keyless", retrieved: "2026-10-20T00:00:00+00:00" });
    write(P("answer.md"), ANSWER);
  });
  const answer = (t: string) => write(P("answer.md"), t);
  const sameAll = () => {
    rerunStub.impl = () => ({ exhibits: { "exhibits/trend.csv": { same: true } },
      facts: Object.fromEntries(Object.entries(FACTS).map(([k, f]: [string, any]) => [k, { stored: f.value, rerun: f.value, same: true }])) });
  };

  it("passes with rerun", async () => {
    sameAll();
    const r = await audit({ rerun: true });
    expect(fails(r)).toEqual([]);
    expect(r.some(([c, , m]) => c === "replication" && m.includes("reproduces"))).toBe(true);
    const p = A.printed(await audit(), A.CHECKS, ANSWER);
    expect(p.passed).toBe(true);
    expect(p.lines.join("\n")).toContain("AUDIT PASSED");
  });

  it("prints every failing check", async () => {
    write(P("exhibits", "sensitivity.csv"), "parameter,base,alternative,headline_base,headline_alt,conclusion_changes\n" +
      "top_code,exclude,include,0.5,0.9,no\n");
    const p = A.printed(await audit(), A.CHECKS);
    expect(p.passed).toBe(false);
    expect(p.lines.join("\n")).toContain("[FAIL] sensitivity");
    expect(p.lines.join("\n")).toContain("not a registered fact");
  });

  it("fails without decisions", async () => {
    fs.rmSync(P("decisions.json"));
    const p = A.printed(await audit(), A.CHECKS);
    expect(p.passed).toBe(false);
    expect(p.lines.join("\n")).toContain("decisions.json missing");
  });

  it("fails on a mismatched fact", async () => {
    const F = copy(FACTS);
    F.slope.value = 0.6;
    write(P("facts.json"), F);
    expect(fails(await audit(), "facts").length).toBeGreaterThan(0);
  });

  it("rerun reports a changed exhibit and leaves it as it was", async () => {
    const trend = P("exhibits", "trend.csv");
    write(trend, "year,slope\n2024,0.5\n# hand edit\n");
    rerunStub.impl = () => ({ exhibits: { "exhibits/trend.csv": { same: false, detail: "replaying the steps gives a different CSV" } },
      facts: { slope: { stored: 0.5, rerun: 0.5, same: true }, slope_incl: { stored: 0.42, rerun: 0.42, same: true } } });
    const r = await audit({ rerun: true });
    expect(msgs(r, "replication").some((m) => m.includes("changed exhibits/trend.csv"))).toBe(true);
    expect(fs.readFileSync(trend, "utf8")).toContain("# hand edit");
    rerunStub.impl = () => ({ exhibits: {}, facts: { slope: { stored: 0.5, rerun: 0.6, same: false }, slope_incl: { stored: 0.42, rerun: 0.42, same: true } } });
    expect(msgs(await audit({ rerun: true }), "replication").some((m) => m.includes("rerun changed facts: ['slope']"))).toBe(true);
    rerunStub.impl = () => {
      throw new Error("boom");
    };
    expect(msgs(await audit({ rerun: true }), "replication").some((m) => m.includes("the rerun failed: boom"))).toBe(true);
  });

  it("answer numbers must be facts", async () => {
    answer("The 2024 slope was 0.6.\n");                           // a typo
    expect(msgs(await audit(), "answer").some((m) => m.includes("0.6"))).toBe(true);
    answer("The slope was 50 percent in 2024 (0.50), as published.\n");   // share as percent
    expect(fails(await audit(), "answer")).toEqual([]);
    fs.rmSync(P("answer.md"));
    expect(msgs(await audit(), "answer").some((m) => m.includes("answer.md missing"))).toBe(true);
  });

  it("answer numbers skip ids, years and allowed values", async () => {
    expect(toks("H.R. 1-10,564 and H.R. 4346 passed 243-187 (roll 404) in the 117th Congress on 2022-07-28 and on " +
      "October 21, 2026; P.L. 118-31; Tables 1.1.1, 1.1.2 and 2.6; line 32 of chapter 5, session 2; HTTP 403; " +
      "LNS14024887 in 2026 Q3: 9.9% (90 percent margin of error) and $1.99 trillion, 3 of 12 states\n" +
      "| 2 (tie) | House Natural Resources | 162 |")).toEqual(["9.9%", "$1.99 trillion", "3", "12", "162", "243", "187"]);
    expect(toks("Volumes 18 and 37 (parts 72–78, titles 28–41) were missing; vol. 17 has 382 pages.\n" +
      "| Notes | 37.3% |\n| **Total** | 100.0% |\n\nAll 100 percent of 9 lines.")).toEqual(["382", "37.3%", "100 percent", "9"]);
    expect(toks("EO 14296 and Executive Orders 14134 to 14371, E.O. 13810 and Proclamation 10886 were 238 orders.")).toEqual(["238"]);
    expect(toks("the per-1,000 ratio is 19.4")).toEqual(["19.4"]);
    expect(toks("IPUMS CPS extract 30: workers 16 and over, ages 25 to 64, children under 15 who live alone, " +
      "aged 65 were 9.7 percent; under 15 percent; under 50 bills")).toEqual(["9.7 percent", "15 percent", "50"]);
    expect(toks("Adults 25+; NIPA Handbook ch. 13 and sec. 4.2; beyond 1.645 standard errors; 48.3 percent")).toEqual(["48.3 percent"]);
    expect(toks("The budget had 2017 pages; in 2026 refunds rose; their 2022 peaks; September 2025 is shown.\n\n" +
      "| Volume | FY2017 pages | Year |\n|---|---|---|\n| Total | 2018 | 2019 |\n")).toEqual(["2017", "2018"]);
    expect(toks("RELATE 1, OWNERSHP in (1, 2), GQ = 2, REPWT1-80, FY2024-25; US 5 states\n| 35 to 44 | 61.1 |\n| 70.4 |")).toEqual(["5", "61.1", "70.4"]);
    const f224 = disp({ value: 22.4, fmt: "pct100:1" });
    expect(A.matches(A.answerNumbers("22 percent")[0], ...f224)).toBe(false);
    expect(A.matches(A.answerNumbers("about 22 percent")[0], ...f224)).toBe(true);
    expect(toks("above the 15 to 20 percent range; about 45 to 48 percent; rose from 3 to 5 percent")).toEqual(["3", "5 percent"]);
    expect(A.at("against 30.6 percent and 0.6 percent", "0.6 percent")).toBe(25);
    const m13 = disp({ value: -13.0, fmt: "pct100:0" });
    expect(A.matches(A.answerNumbers("13 of the 15 departments")[0], ...m13)).toBe(false);
    expect(A.matches(A.answerNumbers("fell from 11.7 to 6.5 hires")[0], ...disp({ value: 11.7, fmt: "pct100:1" }))).toBe(true);
    const f019 = disp({ value: 0.19, fmt: "num:2" });
    expect(A.matches(A.answerNumbers("a margin of 0.2")[0], ...f019)).toBe(false);
    expect(A.matches(A.answerNumbers("about 0.2")[0], ...f019)).toBe(true);
    expect(toks("version 1 for August; RPP (U.S. = 100); months in sample 4 and 8; rose 4.5 percent")).toEqual(["4.5 percent"]);
    expect(toks("(collection BILLS, congress 118); Table 2.1, footnote 5; 274 laws")).toEqual(["274"]);
    const f24 = { value: 6.3, fmt: "pct100:1", where: { year: "2024" } };
    expect(A.wrongYear(" percent in 2019, ...", [f24])).toBe(true);
    expect(A.wrongYear(" percent in 2024", [f24])).toBe(false);
    expect(A.wrongYear(" percent in 2019", [{ value: 6.3, where: { group: "all" } }])).toBe(false);
    expect(toks("GAO-26-900644, p. 9 and pp. 12-14, page 31 of USDL-26-0229: 671 products; BLS table 37b; " +
      "ages 55-59, 60-64 and 65 or more; 65 or more workers")).toEqual(["671", "65"]);
    expect(findUrls("see https://x.gov/RA%20(GW).aspx) and (https://y.gov/a).")).toEqual(["https://x.gov/RA%20(GW).aspx", "https://y.gov/a"]);
    expect(A.matches(A.answerNumbers("3.0 percentage points")[0], 3.0, "pubpct", 1)).toBe(false);
    expect(A.matches(A.answerNumbers("3.0 percent")[0], 3.0, "pubpct", 1)).toBe(true);
    // a table read by hand from an agency page names its page and date on every row
    write(P("published", "dash.csv"), "state,employees,source_url,accessed\nMD,121612,https://data.opm.gov/x,2026-10-21\nDC,114531,,2026-10-21\n");
    let r = A.checkPublished(out);
    expect(r[0][1]).toBe(false);
    expect(r[0][2]).toContain("1 row(s)");
    write(P("published", "dash.csv"), "state,employees,source_url,accessed\nMD,121612,https://data.opm.gov/x,2026-10-21\n");
    expect(A.checkPublished(out).map((x) => [x[1], x[3]])).toEqual([[true, ["https://data.opm.gov/x"]]]);
    fs.rmSync(P("published"), { recursive: true });
    // a published benchmark figure is quoted at its published precision, never a coarser rounding
    expect(A.matches(A.answerNumbers("2.35 points")[0], 2.35, "pub", 2)).toBe(true);
    expect(A.matches(A.answerNumbers("2.4 percent")[0], 2.35, "pub", 2)).toBe(false);
    expect(A.matches(A.answerNumbers("in 1 year")[0], 1.149, "pubpct", 3)).toBe(false);
    const n = A.answerNumbers("$1.99 trillion")[0];
    expect([n.num * n.scale, n.tol * n.scale]).toEqual([1.99e12, 0.005e12]);
    const f = { value: 0.3, fmt: "pct100:1" };
    expect(A.matches(A.answerNumbers("0.3 percent")[0], ...disp(f))).toBe(true);
    expect(A.matches(A.answerNumbers("30 states")[0], ...disp(f))).toBe(false);
    expect(A.matches(A.answerNumbers("| 1,992.5 |")[0], ...disp({ value: 1992473224352.42, fmt: "usd_b:1" }))).toBe(true);
    expect(A.matches(A.answerNumbers("fell 2.2 percent")[0], ...disp({ value: -2.2, fmt: "pct100:1" }))).toBe(true);
    expect(A.matches(A.answerNumbers("-2.2 percent")[0], ...disp({ value: 2.2, fmt: "pct100:1" }))).toBe(false);
    expect(A.matches(A.answerNumbers("$110")[0], ...disp({ value: 110.4, fmt: "index:1" }))).toBe(false);
    expect(toks("267,442 for FY2024 and 146,482 for FY2025; 4.1 in FY2024 and 77 in FY2025; FY2024-25; Note 12; " +
      "the 10 Yr rate; CPI-W (1982-84=100) and 1982–84")).toEqual(["267,442", "146,482", "4.1", "77"]);
    expect(A.matches(A.answerNumbers("3.6 percentage points")[0], ...disp({ value: 3.6, fmt: "pct100:1" }))).toBe(false);
    expect(A.matches(A.answerNumbers("3.4 percentage points")[0], ...disp({ value: 3.4, fmt: "pp100:1" }))).toBe(true);
    const cell = { ...A.answerNumbers("| Retail | 0.12 |")[0], table: true };
    expect(A.matches(cell, ...disp({ value: -0.12, fmt: "pp100:2" }))).toBe(false);
    const c = { value: 52123, fmt: "num:0" };
    expect(A.matches(A.answerNumbers("52 offices")[0], ...disp(c))).toBe(false);
    expect(A.matches(A.answerNumbers("52.1 thousand")[0], ...disp(c))).toBe(true);
    answer("The 2024 slope was 0.5, as published; the survey has 60,000 households.\n");
    expect(fails(await audit(), "answer").length).toBeGreaterThan(0);
    const D = copy(GOOD);
    D.audit_allow = [{ value: "60,000", reason: "sample size from the survey documentation" }];
    write(P("decisions.json"), D);
    expect(fails(await audit(), "answer")).toEqual([]);
  });

  it("carries disclosures and flags", async () => {
    const D = copy(GOOD);
    D.disclosures = { q1: "Not asked (no user): the measure is the official rate." };
    write(P("decisions.json"), D);
    expect(msgs(await audit(), "disclosures").some((m) => m.includes("word for word"))).toBe(true);
    answer("The 2024 slope was 0.5.\n\n**Not asked (no user):** the measure is the official rate\n");   // markdown, no period
    expect(fails(await audit(), "disclosures")).toEqual([]);
    const F = copy(FACTS);
    F.slope.preliminary = true;
    write(P("facts.json"), F);
    expect(msgs(await audit(), "answer").some((m) => m.includes("preliminary"))).toBe(true);
  });

  it("labels near numbers and table words", async () => {
    expect(toks("A 9.9-point drop, 3 of 4 quarters, (2) the 10-yr rate and the 50-states list")).toEqual(["9.9"]);
    expect(A.tableWords("| Senate | four |\n| House | 162 |").map((n) => n.num)).toEqual([4]);
    const F = copy(FACTS);
    F.slope.preliminary = true;
    write(P("facts.json"), F);
    answer("**Slope**\n\nThe 2024 slope was 0.5, as published.\n\nOther notes.\n\nThe data are subject to revision.\n");
    expect(msgs(await audit(), "answer").some((m) => m.includes("preliminary"))).toBe(true);
    answer("**Slope (preliminary)**\n\nThe 2024 slope was 0.5, as published.\n\nOther notes.\n");
    expect(msgs(await audit(), "answer").some((m) => m.includes("preliminary"))).toBe(false);
    answer("The 2024 slope was 0.5.\n");                          // no benchmark reported
    expect(msgs(await audit(), "answer").some((m) => m.includes("benchmark check"))).toBe(true);
  });

  it("round 6 rules", async () => {
    expect(toks("`31.7 percent` and the `65 or more` band")).toEqual(["31.7 percent"]);
    const f = { value: 70.36, fmt: "pct100:1" };
    expect(A.matches(A.answerNumbers("70 quorum calls")[0], ...disp(f))).toBe(false);
    expect(A.matches(A.answerNumbers("| 70.4 |")[0], ...disp(f))).toBe(true);
    expect(A.matches(A.answerNumbers("$4.7 trillion")[0], 4.7, "pubpct")).toBe(false);
    expect(A.matches(A.answerNumbers("0.01")[0], 7.4, "pub")).toBe(false);
    expect(A.matches(A.answerNumbers("4.7 percent")[0], 4.7, "pubpct")).toBe(true);
    const F = copy(FACTS);
    F.drop = { value: -4.2, fmt: "pct100:1", derivation: "x" };
    write(P("facts.json"), F);
    const dir = async () => msgs(await audit(), "answer").some((m) => m.includes("direction words disagree"));
    answer("The 2024 slope was 0.5, as published. Income rose 4.2 percent.\n");
    expect(await dir()).toBe(true);
    answer("The 2024 slope was 0.5, as published. Income fell 4.2 percent.\n");
    expect(await dir()).toBe(false);
    for (const [txt, flagged] of [["The 2010-2019 average real rate was 4.2 percent; it has since turned lower.", true],
      ["Pages came to 4.2 percent fewer than in 2017.", false],
      ["The yield was below the rate in FY2020 (by 3.1 percent) and in FY2021 (by 4.2 percent), then above it.", false]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, as published. " + txt + "\n");
      expect(await dir(), txt).toBe(flagged);
    }
  });

  it("rows and opening", () => {
    const facts = { ag: { value: 93119, fmt: "dollars:0", where: { department: "Agriculture" } },
      tr: { value: 87250, fmt: "dollars:0", where: { department: "Treasury" } },
      y26: { value: 22.4, fmt: "pct100:1", where: { year: "2026" } }, y23: { value: 20.4, fmt: "pct100:1", where: { year: "2023" } } };
    const D = { questions: [{ id: "scope", blocking: true, asked: false }],
      disclosures: { scope: "No one was available to ask, so the scope is the literal reading." } };
    const otherRows = (F: any) => A.checkAnswer(out, F, D)[0].some(([, ok, m]) => !ok && m.includes("match facts of other rows"));
    const table = (a: string, t: string) => `| Department | Average |\n|---|---|\n| Agriculture | ${a} |\n| Treasury | ${t} |\n`;
    for (const [a, t, ok] of [["$93,119", "$87,250", true], ["$87,250", "$93,119", false]] as [string, string, boolean][]) {
      answer(D.disclosures.scope + "\n\n" + table(a, t));
      expect(!otherRows(facts), a).toBe(ok);
    }
    const ranked = (a: string, t: string) => `| Rank | Department | Average |\n|---|---|---|\n| 1 | Agriculture | ${a} |\n| 2 | Treasury | ${t} |\n`;
    for (const [a, t, ok] of [["$93,119", "$87,250", true], ["$87,250", "$93,119", false]] as [string, string, boolean][]) {
      answer(D.disclosures.scope + "\n\n" + ranked(a, t));
      expect(!otherRows(facts), a).toBe(ok);
    }
    expect(toks("status code 2 (supervisor), 4 (CSRA supervisor) or 5 (manager); codes 6 and 7; the 15 departments")).toEqual(["15"]);
    const per: any = {};
    for (const [y, v] of [[2021, 6.1], [2022, 1.9], [2023, 2.4], [2024, 2.0]]) per[`g${y}`] = { value: v, fmt: "pct100:1", where: { year: String(y) } };
    for (const [y, v] of [[2020, 291.901], [2021, 301.236], [2022, 308.729], [2023, 317.265]]) per[`q${y}`] = { value: v, fmt: "num:3", where: { year: String(y) } };
    const tbl = (a: string) => "| Year | Growth | Prior-year average |\n|---|---|---|\n" + [[2021, a, "291.901"], [2022, "1.9", "301.236"],
      [2023, "2.4", "308.729"], [2024, "2.0", "317.265"]].map(([y, g, q]) => `| ${y} | ${g} percent | ${q} |\n`).join("");
    for (const [a, ok] of [["6.1", true], ["1.9", false]] as [string, boolean][]) {
      answer(D.disclosures.scope + "\n\n" + tbl(a));
      expect(!otherRows(per), a).toBe(ok);
    }
    answer(D.disclosures.scope + "\n\n| Year | Share |\n|---|---|\n| 2026 | 20.4 percent |\n");
    expect(otherRows(facts)).toBe(false);
    answer("The average was $93,119.\n\nMore text.\n\nAnother part.\n\n" + D.disclosures.scope + "\n");
    expect(A.checkAnswer(out, facts, D)[0].some(([c, ok, m]) => c === "disclosures" && !ok && m.includes("opening"))).toBe(true);
  });

  it("dollars of different years need their basis", () => {
    const flagged = (txt: string, D: any = {}) => {
      answer(txt);
      return A.checkAnswer(out, {}, D)[0].some(([c, ok, m]) => c === "answer" && !ok && m.includes("never says their basis"));
    };
    const cmp = "Average spending per visitor was $1,840 in 2025, up from $1,320 in 2019.";
    expect(flagged(cmp)).toBe(true);
    expect(flagged("Grants rose to $4.1 million in 2024 from 2018.")).toBe(true);
    expect(flagged("The median fee was $1,250 in 2019. By 2024 it reached $1,610, an increase.")).toBe(true);
    expect(flagged("| Item | 2019 | 2024 |\n|---|---|---|\n| Fees | $5.0 | $6.1 |\n")).toBe(true);
    for (const basis of ["(nominal dollars)", "Amounts are not adjusted for inflation.", "in current dollars", "(in 2025 dollars)",
      "Both are in constant 2025 dollars.", "adjusted for inflation with the CPI-U", "In real terms the rise is smaller."]) {
      expect(flagged(cmp + " " + basis), basis).toBe(false);
    }
    expect(flagged(cmp, { dollar_basis_ok: { reason: "both are statutory caps, set in dollars" } })).toBe(false);
    expect(flagged(cmp, { dollar_basis_ok: { reason: " " } })).toBe(true);
    expect(flagged("Real estate loans were $3.2 billion in 2024, up from $2.9 billion in 2019.")).toBe(true);
    for (const prose of ["The program, created in 1998, spent $4.2 billion in 2024.",
      "In 2024 the office awarded $4.2 million to 31 grantees. The 2019 report counted 25 grantees.",
      "Enrollment grew from 1.2 million in 2019 to 1.5 million in 2024.",
      "In fiscal 2024 (October 2023 to September 2024) outlays were $6.75 trillion.",
      "Of the 2,019 claims filed in 2024, 1,512 were paid, totaling $3.1 million.",
      "The fee is $25; it was set in 2015.", "| State | 2024 |\n|---|---|\n| A | $5.0 |\n| B | $6.1 |\n"]) {
      expect(flagged(prose), prose).toBe(false);
    }
  });

  it("a subset count in words is a fact", () => {
    const facts: any = {};
    [["Agriculture", 93119], ["Treasury", 87250], ["Labor", 81002], ["Energy", 79540]].forEach(([d, v], i) => {
      facts[`d${i}`] = { value: v, fmt: "dollars:0", where: { department: d } };
    });
    const table = "| Department | Average |\n|---|---|\n| Agriculture | $93,119 |\n| Treasury | $87,250 |\n| Labor | $81,002 |\n| Energy | $79,540 |\n";
    const flagged = (txt: string, F: any) => {
      answer(txt + "\n\n" + table);
      return A.checkAnswer(out, F, {})[0].some(([c, ok, m]) => c === "answer" && !ok && m.includes("not found among the facts"));
    };
    const claim = "Three of the four departments pay more than the median.";
    expect(flagged(claim, facts)).toBe(true);
    expect(flagged(claim, { ...facts, n_above: { value: 3, fmt: "num:0", label: "Departments above the median" } })).toBe(false);
    for (const prose of ["Spending was set by one of the two parties in Congress.",
      "Two of the three branches agreed; one of the twelve regional banks objected.", "All four departments are listed."]) {
      expect(flagged(prose, facts), prose).toBe(false);
    }
    expect(A.subsetWords("| two of the three |\n", new Set([3]))).toEqual([]);
    expect([...A.tableSizes(table)]).toEqual([4]);
  });

  it("round 7 and 8 rules", async () => {
    expect(toks("Statements of January 17 and 21, 2025; 2 U.S.C. 653; 40 CFR 60.5; Montgomery (24031); usa:20; SuDoc " +
      "Y 4.J 89/2:; budget function 900; Somerset's 10.7 percent; U.S. 4.1 percent; S. 5 passed; " +
      "standard error 9.9 percentage points; HTTP 403; On March 3, 12 states")).toEqual(["10.7 percent", "4.1 percent", "9.9 percentage points", "12"]);
    expect(toks("| 0301 | Misc | 24,530 |\n\nSeries 0343 and code 1802; `2210` but `22.3%`")).toEqual(["24,530", "22.3%"]);
    expect(A.allowKey("90 percent")).toBe(A.allowKey("90-percent"));
    expect(A.allowKey("90")).not.toBe(A.allowKey("90 percent"));
    const F = copy(FACTS);
    F.va = { value: -25600, fmt: "num:0", derivation: "x" };
    write(P("facts.json"), F);
    const dir = async () => msgs(await audit(), "answer").some((m) => m.includes("direction words disagree"));
    answer("The 2024 slope was 0.5, as published. Virginia rose 25,600 jobs, while the declines elsewhere were small.\n");
    expect(await dir()).toBe(true);
    F.va = { value: 0.8, fmt: "pp100:1", derivation: "x", label: "HHS change, pp" };
    F.drop_size = { value: 130326, fmt: "num:0", derivation: "x", label: "Decline in accessions" };
    write(P("facts.json"), F);
    for (const [txt, flagged] of [["The share is down 0.8 percentage points.", true], ["The share rose 0.8 percentage points.", false],
      ["Accessions fell 130,326.", false]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, as published. " + txt + "\n");
      expect(await dir(), txt).toBe(flagged);
    }
    write(P("exhibits", "benchmark.csv"), "measure,period,computed,published,source,url,accessed,match,note\n" +
      "slope,2024,0.5,0.5,BLS,https://x.gov,2026-10-21,yes,\nmedian,2025,769,770,BLS,https://x.gov,2026-10-21,no,rounded public file\n");
    for (const [txt, ok] of [["The median was $770.", false], ["BLS publishes $770.", true], ["IPUMS gives $770.", false]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, as published. " + txt + "\n");
      expect(msgs(await audit(), "answer").some((m) => m.includes("match only a published figure")), txt).toBe(!ok);
    }
    // decisions.json in a Windows code page is read (with a note), not a crash
    fs.writeFileSync(P("decisions.json"), Buffer.from(JSON.stringify(GOOD).replace("}", ', "note_x": "café"}').replace(/—/g, "\x97"), "latin1"));
    expect(typeof MA.load(out)).toBe("object");
  });

  it("round 20 rules", async () => {
    const F = copy(FACTS);
    F.chg = { value: -0.011, fmt: "signed:pp:1", derivation: "x", label: "change, less than HS" };
    write(P("facts.json"), F);
    const bad = async () => msgs(await audit(), "answer");
    for (const [txt, ok] of [["The rate is lower than in 2019 (+1.1 percentage points).", false],
      ["The rate is lower than in 2019 (-1.1 percentage points).", true]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, as published. " + txt + "\n");
      expect((await bad()).some((m) => m.includes("1.1")), txt).toBe(!ok);
    }
    const D = copy(GOOD);
    D.audit_allow = [{ value: "60 days", reason: "the window, a choice" }];
    write(P("decisions.json"), D);
    answer("The 2024 slope was 0.5, as published. Laws signed 60 days before; S.Res. 377, 412 and 532 passed.\n");
    expect(await bad()).toEqual([]);
    const f25 = { value: 53.6, where: { snapshot: "September 2025" } };
    expect(A.wrongYear(" percent in September 2024 ", [f25])).toBe(true);
    expect(A.wrongYear(" percent in Sept. 2025", [f25])).toBe(false);
    expect(A.wrongYear(" percent in 2026", [{ where: { period: 202508 } }])).toBe(true);
    expect(A.wrongYear(" percent in 2025", [{ where: { period: "202508" } }])).toBe(false);
    expect(toks("Employees under 30 dropped; workers younger than 30 fell 19.5 percent; under 30 percent")).toEqual(["19.5 percent", "30 percent"]);
    write(P("exhibits", "benchmark.csv"), "measure,period,computed,published,source,url,accessed,match,note\n" +
      "slope,2024,0.5,0.5,BLS,https://x.gov,2026-10-21,yes,\n" +
      "households,2025,137056,137100,Census,https://x.gov,2026-10-21,yes,Census rounds to 4 significant digits\n");
    F.hh = { value: 137056, fmt: "num:0", derivation: "x" };
    write(P("facts.json"), F);
    answer("The 2024 slope was 0.5, matching the published figure.\n");
    expect((await bad()).some((m) => m.includes("households"))).toBe(false);
  });

  it("round 28 rules", async () => {
    const facts: any = {};
    for (const [k, v] of [["Northside", 41], ["Southside", 57]] as [string, number][]) {
      facts[`n_${k}`] = { value: v, fmt: "num:0", where: { district: k }, label: `Permits issued, ${k}` };
    }
    facts.n_all = { value: 98, fmt: "num:0", label: "Permits issued, all districts" };
    for (const [txt, who] of [["Southside (2023-2024) issued 41 permits", "southside"], ["Southside issued 57 permits", null],
      ["Southside issued 57 permits, more than the 41 elsewhere", null], ["Northside and Southside issued 41 and 57", null],
      ["In southside terms, permits reached 41", null]] as [string, string | null][]) {
      const n = A.answerNumbers(txt).filter((m) => m.tok === "41" || m.tok === "57")[0];
      const fh = Object.values(facts).filter((f) => A.matches(n, ...disp(f)));
      expect(A.clauseOwner([txt], n, fh, facts), txt).toBe(who);
    }
    let pf: any = {};
    for (const [c, y, v] of [["a", 2012, 512], ["a", 2022, 640], ["r", 2012, 601], ["r", 2022, 640]] as [string, number, number][]) {
      pf[`${c}${y}`] = { value: v, fmt: "dollars:0", where: { year: String(y) } };
    }
    let shown: any = Object.entries(pf).map(([k, f]) => [k, disp(f), f]);
    const t2 = (a: string, b: string) => `| Year | Pay | Pay, 2022 dollars |\n|---|---|---|\n| 2012 | ${a} | $601 |\n| 2022 | ${b} | $640 |\n`;
    expect(A.periodMisfits(t2("$640", "$512"), shown, pf)).toEqual(["$640", "$512"]);
    expect(A.periodMisfits(t2("$512", "$640"), shown, pf)).toEqual([]);
    for (const [txt, want] of [["It amends 42 U.S.C. 1395, 1396 and 1397.", []], ["FLSA section 13(a)(1) applies.", []],
      ["Votes on March 4, 6, 11 and 12, 2024.", []], ["On March 3, 12 states", ["12"]],
      ["42 U.S.C. 1395, 42 U.S.C. 1396 and 138 Stat. 3234", []], ["42 U.S.C. 1395 and 12 percent", ["12 percent"]],
      ["These are votes 1 to 659 of the session; 351 were on nominations.", ["351"]],
      ["The gap is significant at 90 percent (90 percent margins of error); 90 percent of", ["90 percent"]]] as [string, string[]][]) {
      expect(toks(txt), txt).toEqual(want);
    }
    const mf = { pce: { value: 2.8, fmt: "pct100:1", label: "PCE price index, change 2019-2025" },
      eci: { value: 3.4, fmt: "pct100:1", label: "ECI wages, change 2019-2025" }, x: { value: 1.0, fmt: "num:0", label: "other" } };
    for (const [txt, bad] of [["prices (PCE, up 3.4 percent)", "PCE"], ["prices (PCE, up 2.8 percent)", null],
      ["PCE-based estimates instead of ECI, 3.4 percent", null]] as [string, string | null][]) {
      const n = A.answerNumbers(txt).filter((m) => m.tok.includes("percent"))[0];
      const fh = Object.values(mf).filter((f) => A.matches(n, ...disp(f)));
      expect(A.measureNamed([txt], n, fh, mf), txt).toBe(bad);
    }
    const y = (v: number, yr: string) => ({ value: v, fmt: "pct100:2", where: { year: yr } });
    expect(A.wrongYear(A.yearBefore("The rate topped in 2011 at ", ", eased to 1.9 percent in 2014."), [y(4.17, "2012")])).toBe(true);
    expect(A.wrongYear(A.yearBefore("last seen in 1987 (", " percent)"), [y(4.2, "2026")])).toBe(true);
    expect(A.wrongYear(" in 2024", [{ value: 1, where: { alt: "x" }, label: "Share, FY2026, alternative" }])).toBe(true);
    expect(A.wrongYear(" in 1944", [{ value: 1, where: { m: "peak" }, label: "Peak share since 1939" }])).toBe(false);
    const cf: any = {};
    for (const [row, a, b] of [["North", -15.1, -23.4], ["South", -9.0, -12.2], ["East", -6.1, -8.8], ["West", -4.4, -7.7]] as [string, number, number][]) {
      cf[`a_${row}`] = { value: a, fmt: "num:1", where: { region: row }, label: `${row}: change to 2025` };
      cf[`b_${row}`] = { value: b, fmt: "num:1", where: { region: row }, label: `${row}: change to 2026` };
    }
    const t = (a: string, b: string) => `| Region | To 2025 | To 2026 |\n|---|---|---|\n| North | ${a} | ${b} |\n| South | -9.0 | -12.2 |\n` +
      "| East | -6.1 | -8.8 |\n| West | -4.4 | -7.7 |\n";
    expect(A.columnMisfits(t("-15.1", "-23.4"), cf)).toEqual([]);
    expect(A.columnMisfits(t("-23.4", "-15.1"), cf)).toEqual(["-23.4", "-15.1"]);
    expect(toks("file versions 4, 4 and 3; 12 percent")).toEqual(["12 percent"]);
    expect(toks("Rates followed 6 months later, over the past 12 months")).toEqual(["6"]);
    let F = copy(FACTS);
    F.rate = { value: 6.02, fmt: "pct100:2", derivation: "x", label: "rate" };
    write(P("facts.json"), F);
    answer("The 2024 slope was 0.5, as published. Prices followed 6 months later.\n");
    expect(msgs(await audit(), "answer").some((m) => m.includes("6 not found"))).toBe(true);
    // a cited figure stored on a rounding tie needs full precision or a stated reason
    F = copy(FACTS);
    F.tie = { value: 744.25, fmt: "num:1", source: "exhibits/trend.csv", label: "Outlays, $B" };
    write(P("facts.json"), F);
    answer("The 2024 slope was 0.5, as published. Outlays were 744.3.\n");
    expect(msgs(await audit(), "answer").some((m) => m.includes("rounding tie"))).toBe(true);
    const D = copy(GOOD);
    D.rounding_ties_ok = [{ fact: "tie", reason: "published to the cent" }];
    write(P("decisions.json"), D);
    expect(msgs(await audit(), "answer").some((m) => m.includes("rounding tie"))).toBe(false);
    write(P("decisions.json"), GOOD);
    // a credited published "about 1 percent" is not our preliminary 1.31 read coarsely
    F = copy(FACTS);
    F.sh = { value: 1.31, fmt: "pct100:2", derivation: "x", preliminary: true };
    write(P("facts.json"), F);
    write(P("exhibits", "benchmark.csv"), "measure,period,computed,published,source,url,accessed,match,note\n" +
      "slope,2024,0.5,0.5,BLS,https://x.gov,2026-10-21,yes,\n" +
      "DHS change (percent),2026,-0.8,1,GAO,https://x.gov,2026-10-21,no,GAO rounds to whole percents\n");
    answer("The 2024 slope was 0.5, as published.\n\nGAO reports that DHS fell about 1 percent.\n");
    expect(msgs(await audit(), "answer").some((m) => m.includes("preliminary"))).toBe(false);
    write(P("facts.json"), FACTS);
    for (const [pub, ok] of [["over -45", true], ["over -50", false], ["at most 2", true]] as [string, boolean][]) {
      write(P("exhibits", "benchmark.csv"), "measure,period,computed,published,source,url,accessed,match,note\n" +
        `slope,2024,0.5,0.5,BLS,https://x.gov,2026-10-21,yes,\nfall,2025,${pub.includes("45") || pub.includes("50") ? "-46" : "1.7"},` +
        `${pub},GAO,https://x.gov,2026-10-21,yes,\n`);
      expect(!MA.checkBenchmark(out, FACTS).some(([, okk]) => !okk), pub).toBe(ok);
    }
    F = copy(FACTS);
    F.fte = { value: -8.3, fmt: "signed:pct100:1", derivation: "x", label: "FTE change" };
    write(P("facts.json"), F);
    write(P("exhibits", "benchmark.csv"), BENCH);
    for (const [txt, flagged] of [["FTEs fell -8.3 percent.", true], ["FTEs changed by -8.3 percent.", false]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, as published. " + txt + "\n");
      expect(msgs(await audit(), "answer").some((m) => m.includes("direction words disagree")), txt).toBe(flagged);
    }
    write(P("facts.json"), FACTS);
    expect(A.forms("Democratic").has("democrats")).toBe(true);
    expect(toks("Coded as RACE 651 or 652; CLASSWKR 21, 25 and 27.")).toEqual([]);
    expect(toks("RACE 651 or 9 percent")).toEqual(["9 percent"]);
    const G = { g20: { value: -2.47, fmt: "pct100:1", where: { year: "2020" } }, q23: { value: 2.52, fmt: "pct100:1", where: { year: "2023" } } };
    const n = A.answerNumbers("Output rose 2.5 percent in 2020.")[0];
    const fh = Object.values(G).filter((f) => A.matches(n, ...disp(f)));
    expect(A.dated(["Output rose 2.5 percent in 2020."], n, fh)).toEqual([G.g20]);
    write(P("exhibits", "benchmark.csv"), "measure,period,computed,published,source,url,accessed,match,note\n" +
      "slope,2024,0.5,0.5,BLS,https://x.gov,2026-10-21,yes,\n" +
      "Jobs added (thousands),2025,251.2,254,BLS,https://x.gov,2026-10-21,no,first print; revised since\n");
    for (const [txt, ok] of [["BLS first reported 254,000 jobs.", true], ["BLS first reported 254 thousand jobs.", true],
      ["BLS first reported 245,000 jobs.", false]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, as published. " + txt + "\n");
      expect(!msgs(await audit(), "answer").some((m) => m.includes("not found among the facts")), txt).toBe(ok);
    }
  });

  it("round 21 rules", async () => {
    const facts: any = {};
    for (const [y, v] of [[2014, 1.62], [2015, 1.71], [2016, 1.66], [2017, 1.69]]) facts[`s${y}`] = { value: v, fmt: "num:2", where: { year: String(y) } };
    facts.ratio = { value: 1.17, fmt: "num:2", derivation: "x" };
    const shown: any = Object.entries(facts).map(([k, f]) => [k, disp(f), f]);
    const table = (x: string) => `| Year | Spread |\n|---|---|\n| 2014 | 1.62 |\n| 2015 | ${x} |\n| 2016 | 1.66 |\n| 2017 | 1.69 |\n`;
    expect(A.periodMisfits(table("1.17"), shown, facts)).toEqual(["1.17"]);
    expect(A.periodMisfits(table("1.71"), shown, facts)).toEqual([]);
    const F = copy(FACTS);
    Object.assign(F, { re: { value: 0.54, fmt: "num:2", where: { industry: "Real estate" } },
      rt: { value: -0.12, fmt: "num:2", where: { industry: "Retail trade" } }, fed: { value: -0.11, fmt: "num:2", where: { industry: "Federal" } } });
    write(P("facts.json"), F);
    write(P("exhibits", "benchmark.csv"), "measure,period,computed,published,source,url,accessed,match,note\n" +
      "slope,2024,0.5,0.5,BLS,https://x.gov,2026-10-21,yes,\n" +
      "Federal contribution,2025,-0.11,-0.11,BEA Real GDP by Industry,https://x.gov/?id=1,2026-10-22,yes,\n");
    for (const [c, ok] of [["-0.12", true], ["-0.11", false]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, matching BEA's published figure.\n\n| Industry | Contribution to real GDP growth (BEA) |\n" +
        `|---|---|\n| Real estate | 0.54 |\n| Retail trade | ${c} |\n| Federal | -0.11 |\n`);
      expect(msgs(await audit(), "answer").some((m) => m.includes("other rows only")), c).toBe(!ok);
    }
    write(P("exhibits", "benchmark.csv"), "measure,period,computed,published,source,url,accessed,match,note\n" +
      "slope,2024,0.5,0.5,BLS,https://x.gov,2026-10-21,yes,\nspread (bp),2010-2019,169,170,MBA,https://x.gov,2026-10-22,no,MBA averages 1990-2021\n");
    F.sp = { value: 0.0169, fmt: "bp100:0", derivation: "x" };
    write(P("facts.json"), F);
    answer("The 2024 slope was 0.5, as published. The spread averaged 169 basis points; MBA reports roughly 170 basis points " +
      "for 1990-2021, a longer period.\n");
    expect(msgs(await audit(), "answer").some((m) => m.includes("must give the published figure"))).toBe(false);
    const F2 = copy(FACTS);
    F2.gap = { value: -0.034, fmt: "pp:1", derivation: "x" };
    write(P("facts.json"), F2);
    for (const [txt, ok] of [["Federal pay grew 3.4 percentage points less than private wages.", true],
      ["Federal pay grew 3.4 percentage points faster.", false]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, as published. " + txt + "\n");
      expect(msgs(await audit(), "answer").some((m) => m.includes("direction words disagree")), txt).toBe(!ok);
    }
    write(P("facts.json"), F);
    expect(toks("a 43-day shutdown; the 10-year note, a 4-week bill and the 30-day average")).toEqual(["43"]);
    expect(toks("On February 12 to 13, 2024, issues 204 to 206 and issue 45 of volume 171; 219 issues")).toEqual(["219"]);
    Object.assign(F, { co: { value: 19.8, fmt: "num:1", where: { state: "Colorado" } }, or_: { value: 16.9, fmt: "num:1", where: { state: "Oregon" } },
      tot: { value: 18.1, fmt: "num:1", derivation: "x" } });
    write(P("facts.json"), F);
    for (const [txt, ok] of [["Colorado (19.8) and Oregon (16.9) lead.", true], ["Colorado (16.9) and Oregon (19.8) lead.", false],
      ["Colorado and Oregon together reach 18.1.", true], ["Colorado and Oregon: 19.8 and 16.9.", true],
      ["Spending was 16.9 on Oregon and 19.8 on Colorado.", true], ["Colorado (16.9), Oregon (19.8).", false]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, as published. " + txt + "\n");
      expect(msgs(await audit(), "answer").some((m) => m.includes("other entries of the same kind")), txt).toBe(!ok);
    }
  });

  it("round 22 rules", async () => {
    expect(A.periodKey("2025 Q1")).not.toBe(A.periodKey("2025 Q3"));
    expect(A.periodKey("Q3 2025")).toBe(A.periodKey("2025-07"));
    expect(A.periodKey("Dec 2025")).not.toBe(A.periodKey("2026"));
    expect(A.wrongYear(" percent in 2026", [{ where: { month: "Dec 2025" } }])).toBe(true);
    expect(A.factPeriods({ where: { fiscal_year: "2026", month: "12" } })).toEqual([A.periodKey("2025-12")]);
    expect(A.factPeriods({ where: { fiscal_year: "2026", month: "2026-02" } })).toEqual([A.periodKey("2026-02")]);
    const facts: any = {};
    for (const [i, v] of [[1, -1.8], [2, 4.2], [3, 5.2], [4, 1.6]]) facts[`q${i}`] = { value: v, fmt: "num:1", where: { quarter: `2025 Q${i}` } };
    const shown: any = Object.entries(facts).map(([k, f]) => [k, disp(f), f]);
    const table = (x: string) => `| Quarter | Growth |\n|---|---|\n| 2025 Q1 | -1.8 |\n| 2025 Q2 | 4.2 |\n| 2025 Q3 | ${x} |\n| 2025 Q4 | 1.6 |\n`;
    expect(A.periodMisfits(table("4.2"), shown, facts)).toEqual(["4.2"]);
    expect(A.periodMisfits(table("5.2"), shown, facts)).toEqual([]);
    expect(A.fromToMisreads("The balance fell from $890.8 billion to $984.0 billion.").length).toBeGreaterThan(0);
    expect(A.fromToMisreads("The balance rose from $890.8 billion to $984.0 billion.")).toEqual([]);
    expect(A.fromToMisreads("Spending rose from 2019 to 2024 by 3 percent.")).toEqual([]);
    expect(A.fromToMisreads("The rate fell from 5.4 percent in 2019 to 4.3 percent.")).toEqual([]);
    const f26 = [{ where: { year: "2026" } }];
    expect(A.wrongYear(A.yearBefore("for 2025 (men "), f26)).toBe(true);
    expect(A.wrongYear(A.yearBefore("rose from 13.1 percent in 2019 to "), f26)).toBe(false);
    expect(A.wrongYear(A.yearBefore("146 issues in 2025 (", " in 2024) had both"), f26)).toBe(false);
    expect(A.wrongYear(A.yearBefore("$1,177.1 billion for 2025, $"), f26)).toBe(false);
    expect(A.wrongYear(A.yearBefore("from $885.5 billion in 2024: a goods deficit of $"), f26)).toBe(false);
    const F = copy(FACTS);
    Object.assign(F, { nr: { value: 66, fmt: "num:0", where: { committee: "Natural Resources Committee" } },
      ec: { value: 63, fmt: "num:0", where: { committee: "Energy and Commerce Committee" } } });
    write(P("facts.json"), F);
    for (const [txt, ok] of [["Natural Resources (66) and Energy and Commerce (63) came next.", true],
      ["Natural Resources (63) and Energy and Commerce (63) came next.", false]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, as published. " + txt + "\n");
      expect(msgs(await audit(), "answer").some((m) => m.includes("other entries of the same kind")), txt).toBe(!ok);
    }
    // a dropped connection is throttling, not a dead link; an HTTP error still fails
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET", message: "read ECONNRESET" } });
      }) as any;
      expect((await checkUrl("https://fred.stlouisfed.org/series/X"))[0]).toBe(true);
      globalThis.fetch = (async () => new Response("no", { status: 404 })) as any;
      expect((await checkUrl("https://x.gov/a"))[0]).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("round 23 rules", async () => {
    const f = [{ where: { snapshot: "September 2024" } }];
    expect(A.wrongYear(" percent in October 2024", f)).toBe(true);
    expect(A.wrongYear(" percent in September 2024", f)).toBe(false);
    expect(A.wrongYear(" percent of GDP in 2019", [{ where: { year: "2025" } }])).toBe(true);
    expect(A.factPeriods({ where: { component: "Defense" }, column: "share_2019" })).toEqual([201900]);
    expect(A.rowLabel({ ...A.answerNumbers("| 117th | 362 |")[0], line: "| 117th | 362 |" })).toBe("117th");
    expect(toks("IT management (series 2210) and series 2210 grew 12 percent")).toEqual(["12 percent"]);
    const ents = new Map([["house", [new Set(["chamber"]), "house"]], ["senate", [new Set(["chamber"]), "senate"]]]) as any;
    const s = "616 Senate, 254 House, 85.3 percent of all roll calls";
    expect(A.misnamed([s], A.answerNumbers(s)[2], [{ where: { chamber: "Both" } }], ents)).toBeNull();
    expect(A.sentences("The U.S. city average (3.7 percent) rose. Houston fell.").length).toBe(2);
    write(P("exhibits", "benchmark.csv"), "measure,period,computed,published,source,url,accessed,match,note\n" +
      "slope,2024,0.5,,BLS,https://x.gov,2026-10-21,not checked,\n");
    expect(msgs(MA.checkBenchmark(out)).some((m) => m.includes("published column is empty"))).toBe(true);
    const F = copy(FACTS);
    Object.assign(F, { la: { value: 8.0, fmt: "num:1", where: { metro: "Los Angeles-Long Beach-Anaheim" } },
      mia: { value: 7.9, fmt: "num:1", where: { metro: "Miami-Fort Lauderdale-West Palm Beach" } } });
    write(P("facts.json"), F);
    write(P("exhibits", "benchmark.csv"), "measure,period,computed,published,source,url,accessed,match,note\n" +
      "slope,2024,0.5,0.5,BLS,https://x.gov,2026-10-21,yes,\nNo-vehicle share Miami,2024,7.9,8.0,Census DP04,https://x.gov,2026-10-22,no,sampling error\n");
    answer("The 2024 slope was 0.5, as published.\n\n| Metro | Computed | Census DP04 published |\n|---|---|---|\n" +
      "| Los Angeles-Long Beach-Anaheim | 8.0 | 8.0 |\n| Miami-Fort Lauderdale-West Palm Beach | 7.9 | 8.0 |\n");
    expect(msgs(await audit(), "answer").some((m) => m.includes("other rows only"))).toBe(false);
  });

  it("round 24 rules", async () => {
    const F = copy(FACTS);
    F.cit = { value: -70.675, fmt: "usd_b_scaled:1:abs", derivation: "x", label: "corporate change" };
    write(P("facts.json"), F);
    for (const [txt, ok] of [["Corporate receipts fell $70.7 billion.", true], ["Corporate receipts were down $70.7 billion.", true],
      ["Corporate receipts were up $70.7 billion.", false]] as [string, boolean][]) {
      answer("The 2024 slope was 0.5, as published. " + txt + "\n");
      expect(msgs(await audit(), "answer").some((m) => m.includes("direction words disagree")), txt).toBe(!ok);
    }
    const f20 = [{ where: { year: "2020" } }];
    expect(A.wrongYear(" percent in the March 2019 ASEC", f20)).toBe(true);
    expect(A.wrongYear(" in October 2023–August 2024", [{ where: { year: "2024" } }])).toBe(false);
    expect(A.factPeriods({ where: { type: "Retirement" }, column: "FY2024_oct_aug" })).toEqual([]);
    const facts = { ret: { value: 76830, fmt: "num:0", where: { type: "Retirement" } }, quit: { value: 73491, fmt: "num:0", where: { type: "Quit" } } };
    expect(A.rowOk(A.answerNumbers("| Retirement (voluntary, early out) | 73,491 |")[0], [facts.quit], facts)).toBe(false);
    expect(toks("Mothers whose youngest child is 6 to 17; a child under 18 BLS reports; all 79 succeeded; all 50 states")).toEqual(["79"]);
  });

  it("round 25 rules", async () => {
    let facts: any = { a: { value: 2.51, fmt: "num:2", where: { fiscal_year: "FY2026" } }, b: { value: 2.56, fmt: "num:2", where: { fiscal_year: "FY2025" } } };
    const shown: any = Object.entries(facts).map(([k, f]) => [k, disp(f), f]);
    const t = (x: string) => `| Year | Bid-to-cover |\n|---|---|\n| FY2025 | 2.56 |\n| FY2026 (preliminary) | ${x} |\n`;
    expect(A.periodMisfits(t("2.56"), shown, facts)).toEqual(["2.56"]);
    expect(A.periodMisfits(t("2.51"), shown, facts)).toEqual([]);
    facts = { sa: { value: 55.8, fmt: "num:1", where: { series: "Nominal (SA)" } }, nsa: { value: 59.0, fmt: "num:1", where: { series: "Nominal (NSA)" } } };
    expect(A.rowOk(A.answerNumbers("| Nominal (NSA) | 55.8 |")[0], [facts.sa], facts)).toBe(false);
    expect(A.rowLabel(A.answerNumbers("| Appendix | n/a | 1,340 |")[0])).toBe("appendix");
    expect(A.rowLabel(A.answerNumbers("| H.R. 131 | 248 | 177 |")[0])).toBe("h.r. 131");
    const ents = new Map([["labor", [new Set(["department"]), "labor"]], ["energy", [new Set(["department"]), "energy"]]]) as any;
    const s = "Labor is first at 16.3 years on average, with Energy (16.3) next.";
    const n = A.answerNumbers(s).filter((x) => x.tok === "16.3")[0];
    expect(A.misnamed([s], n, [{ where: { department: "Labor" } }], ents)).toBe("energy");
    expect(A.UP_WORDS.test("the position improved")).toBe(true);
    expect(toks("BUDGET-2026-PER returns 404; it returned 503 rows")).toEqual(["503"]);
    expect(toks("2025 equals the session's votes 1-659 in all")).toEqual([]);
    expect(A.factPeriods({ where: { year: "2026 (to Oct 15)" } })).toEqual([202600]);
    const F = copy(FACTS);
    F.btc = { value: -0.01, fmt: "num:2", derivation: "x" };
    write(P("facts.json"), F);
    answer("The 2024 slope was 0.5, as published. Bid-to-cover is flat (within 0.01).\n");
    expect(msgs(await audit(), "answer").some((m) => m.includes("direction words disagree"))).toBe(false);
  });

  it("round 26 rules", () => {
    expect(A.fromToMisreads("The share was 18.3 percent in 2025, down from 16.8 percent in 2019.").length).toBeGreaterThan(0);
    expect(A.fromToMisreads("Unemployment was 4.2 percent, down from 4.3 percent.")).toEqual([]);
    expect(A.wrongYear(" percent of U.S. personal income in 2024", [{ where: { year: "2025" } }])).toBe(true);
    const ents = new Map([["native americans", [new Set(["area"]), "native americans"]], ["energy", [new Set(["area"]), "energy"]]]) as any;
    const s = "Then Native Americans with 9, Energy with 9.";
    expect(A.misnamed([s], A.answerNumbers(s)[0], [{ where: { area: "Energy" } }], ents)).toBe("native americans");
    const facts: any = {};
    for (const [y, rows] of [[2019, [["65+", 22.6], ["25-64", 9.8], ["16+", 10.2]]], [2026, [["65+", 21.5], ["25-64", 10.0], ["16+", 10.6]]]] as [number, [string, number][]][]) {
      for (const [g, v] of rows) facts[`${g}_${y}`] = { value: v, fmt: "num:1", where: { group: g }, column: `share_${y}` };
    }
    const shown: any = Object.entries(facts).map(([k, f]) => [k, disp(f), f]);
    const t = (x: string) => "| Group | Self-employed, 2019 (%) | Self-employed, 2026 (%) |\n|---|---|---|\n" +
      `| 65 and over | 22.6 | ${x} |\n| 25 to 64 | 9.8 | 10.0 |\n| 16 and over | 10.2 | 10.6 |\n`;
    expect(A.periodMisfits(t("22.6"), shown, facts)).toEqual(["22.6"]);
    expect(A.periodMisfits(t("21.5"), shown, facts)).toEqual([]);
    expect(toks("5.7 percent at 25 to 64; the 25-to-64 share")).toEqual(["5.7 percent"]);
  });

  it("round 27 rules", async () => {
    const ents = new Map([["louisiana", [new Set(["state"]), "louisiana"]], ["south carolina", [new Set(["state"]), "south carolina"]],
      ["montana", [new Set(["state"]), "montana"]], ["virginia", [new Set(["state"]), "virginia"]],
      ["bills", [new Set(["security"]), "bills"]], ["bonds", [new Set(["security"]), "bonds"]]]) as any;
    let s = "South Carolina (+2.3 percent) and Louisiana (+2.3 percent) led.";
    expect(A.misnamed([s], A.answerNumbers(s)[0], [{ where: { state: "South Carolina" } }], ents)).toBe("louisiana");
    s = "The mix: bills 17.4 percent, bonds 22.4 percent.";
    expect(A.misnamed([s], A.answerNumbers(s)[0], [{ where: { security: "Bonds" } }], ents)).toBe("bills");
    expect(A.matches(A.answerNumbers("BEA publishes +1.1 percentage points")[0], -1.1, "pubpp", 1)).toBe(false);
    const ents2 = new Map([["united states", [new Set(["geo"]), "united states"]], ["u.s.", [new Set(["geo"]), "united states"]],
      ["florida", [new Set(["geo"]), "florida"]], ["food inspection", [new Set(["series"]), "food inspection"]],
      ["compliance inspection", [new Set(["series"]), "compliance inspection"]]]) as any;
    expect(A.forms("United States").has("u.s.")).toBe(true);
    s = "Food Inspection (1863, down 47.5 percent) led.";
    expect(A.misnamed([s], A.answerNumbers(s)[0], [{ where: { series: "Compliance Inspection" } }], ents2)).toBe("food inspection");
    expect(toks("Senate roll call votes 225 and 600; it passed 51-47")).toEqual(["51", "47"]);
    expect(toks("The 33,999-page figure")).toEqual(["33,999"]);
    const F = copy(FACTS);
    Object.assign(F, { n: { value: -0.086, fmt: "pp:1", derivation: "x" }, t: { value: -0.021, fmt: "pp:1", derivation: "x" },
      f: { value: -0.004, fmt: "pp:1", derivation: "x" } });
    write(P("facts.json"), F);
    answer("The 2024 slope was 0.5, as published. Notes fell 8.6 percentage points, TIPS 2.1 percentage points and FRNs 0.4 percentage points.\n");
    expect(fails(await audit(), "answer")).toEqual([]);
    F.m = { value: -0.002, fmt: "pp:1", derivation: "x" };
    write(P("facts.json"), F);
    answer("**Men are slightly below.** The 2024 slope was 0.5, as published, and men were 0.2 percentage points above their 2019 average.\n");
    expect(msgs(await audit(), "answer").some((m) => m.includes("direction words disagree"))).toBe(true);
  });

  it("fails without provenance", async () => {
    fs.rmSync(P("data", "bls", "request.json"));
    expect(fails(await audit(), "vintage").length).toBeGreaterThan(0);
  });
});
