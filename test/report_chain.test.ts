/**
 * The report chain (build_report, audit_report, policyset, style_check): a port of tests/test_report_chain.py.
 *
 * The report tests build a small two-source report in a temporary workspace. The two sources are FAKE packs
 * ("alpha", allowed with a FRED-style withhold rule, and "beta", definition_only like IPUMS) whose policies are
 * written into a temporary packs folder (policyset's sources folder is pointed there). Their data are synthetic
 * numbers written by the test; they stand for no real source and no real response. The Python test ran an
 * analysis.py; here the exhibits, facts.json and exhibits/lineage.json are written directly as compute and facts
 * write them. The last block runs the tools on a workspace fetched from the cdc fixtures.
 * (factfmt's own cases are ported with the analysis tests, which own src/analysis/factfmt.ts.)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const rerunStub = vi.hoisted(() => ({ impl: null as null | ((w: string) => any) }));
process.env.DATA_ANALYST_RERUN_INLINE = "1"; // the stub lives in this thread: no worker, nothing kept
vi.mock("../src/analysis/rerun.js", async (orig) => {
  const real: any = await orig();
  return { ...real, rerunWorkspace: (w: string) => (rerunStub.impl ? rerunStub.impl(w) : real.rerunWorkspace(w)) };
});

import * as pol from "../src/core/policy.js";
import * as AR from "../src/report/audit_report.js";
import { build, BuildError, esc, FACT_RE } from "../src/report/build_report.js";
import type { Result } from "../src/report/method_audit.js";
import * as PS from "../src/report/policyset.js";
import { styleIssues } from "../src/report/style_check.js";
import { TOOLS } from "../src/report/tools.js";
import { Session } from "../src/session.js";
import { fetchOk, isolate } from "./helpers.js";

const ALPHA_NOTICE = "This product uses the Alpha Test API but is not endorsed or certified by the Alpha Test Agency.";
const BETA_NOTICE = "Beta Test Survey data are used under terms that forbid redistributing the extract.";

const POLICIES: Record<string, any> = {
  alpha: {
    id: "alpha", title: "Alpha Test Statistics", agency: "Alpha Test Agency", depth: "standard", domains: ["test"],
    homepage: "https://example.org/alpha",
    auth: { env: "ALPHA_TEST_API_KEY", required: "optional", placement: "query", param: "api_key",
      signup_url: "https://example.org/alpha/key", echoes_key: false },
    limits: { rps: 1 },
    routes: { api: { base: "https://example.org/alpha/api", probe: "https://example.org/alpha/api", hosts: ["example.org"] },
      manual: { how: "Download the CSV from the test page and upload it." } },
    cache: { mode: "run_only", why: "test" },
    redistribution: { mode: "allowed", why: "Synthetic test source (public domain).",
      withhold: { meta: "series.csv", key: "series_id", column: "copyright", values: ["copyrighted"] } },
    notices: [ALPHA_NOTICE],
    citation: "Alpha Test Agency, {dataset}, retrieved {retrieved_long}.",
  },
  beta: {
    id: "beta", title: "Beta Test Survey", agency: "Beta Test Center", depth: "deep", domains: ["test"], homepage: "https://example.org/beta",
    auth: { env: "BETA_TEST_API_KEY", required: "required", placement: "header", param: "Authorization",
      signup_url: "https://example.org/beta/key", echoes_key: true },
    limits: { rps: 1 },
    routes: { api: { base: "https://example.org/beta/api", probe: "https://example.org/beta/api", hosts: ["example.org"] },
      manual: { how: "Build the same extract on the test website and download the CSV." } },
    cache: { mode: "run_only", why: "test" },
    redistribution: { mode: "definition_only", why: "Synthetic stand-in for terms that forbid sharing extracts.",
      microdata_globs: ["*_extract.csv", "*.dat"], package_include: ["request.json", "README.md", "codebook.csv"] },
    notices: [BETA_NOTICE],
    audit_hooks: [{ id: "beta_codebook", kind: "require_file", glob: "data/beta/codebook.csv", why: "the codebook documents the extract" }],
    citation: "Beta Test Center, {dataset}, retrieved {retrieved_long}.",
  },
};

const REPORT: any = {
  mode: "report",
  title: "Alpha Rates and Beta Employment, 2022 to 2024",
  subtitle: "A synthetic two-source report used to test the report chain",
  date: "2026-10-20",
  sources: ["alpha", "beta"],
  request: "Build a test report from two fake sources.",
  at_a_glance: {
    text: "This test report examines a synthetic alpha rate from 2022 to 2024 and synthetic employment by group.",
    findings: [
      { lead: "Alpha Rates.", text: "The alpha rate reached {{alpha_last}} in 2024, a preliminary value." },
      { lead: "Change Over Time.", text: "The rate rose by {{alpha_change}} from 2022 to 2024." },
      { lead: "Beta Employment.", text: "The employment rate was {{beta_rate_x}} in group X and {{beta_rate_y}} in group Y." }] },
  notes_page: ["Unless otherwise indicated, all years are calendar years.",
    "Numbers in the text and exhibits may not add up to totals because of rounding.",
    "The data are the vintage retrieved in October 2026; both test sources revise their data."],
  introduction: { text: "The alpha rate was {{alpha_first}} in 2022 and {{alpha_last}} in 2024, a preliminary value that the agency revises.",
    subsections: [{ heading: "How Did the Alpha Rate Change?", body: "The rate rose by {{alpha_change}} over the period." },
      { heading: "What Data Were Used?", body: "The report uses two synthetic sources built for this test." }] },
  sections: [
    { heading: "Alpha Rates", body: "The alpha rate rose from {{alpha_first}} in 2022 to {{alpha_last}} in 2024, a preliminary value (see Exhibit 1).", exhibits: [1] },
    { heading: "Beta Employment", body: "Employment differed by group (see Exhibit 2).", exhibits: [2] }],
  exhibits: [
    { title: "Alpha Rate, 2022 to 2024", subtitle: "Percent",
      text: "The alpha rate climbed in each year. The latest value, {{alpha_last}}, is preliminary.",
      data: "exhibits/exhibit_1.csv", chart: { type: "line", x: "year", y: "value", format: "pct100", decimals: 1 },
      notes: "The latest value is preliminary.", source: "Analyst calculations using data from the Alpha Test Agency." },
    { title: "Employment Rate by Group, 2024", subtitle: "Percent",
      text: "Group X had a higher employment rate ({{beta_rate_x}}) than group Y ({{beta_rate_y}}).",
      data: "exhibits/exhibit_2.csv", chart: { type: "column", x: "group", y: "rate", format: "pct", decimals: 0 },
      notes: "Rates are unweighted shares of the synthetic extract.", source: "Analyst calculations using data from the Beta Test Center." }],
  methods: ["The alpha series is the vintage retrieved from the test API; the agency revises it [@alpha_doc].",
    "The beta extract stays in the analysis folder; only its definition is shared."],
  assumptions: [{ parameter: "Year basis", value: "Calendar years", basis: "precedent",
    evidence: "The test documentation reports calendar years [@alpha_doc]." }],
  references: [{ id: "alpha_doc", label: "Alpha 2026", citation: "Alpha Test Agency, *Test Documentation* (2026)",
    url: "https://example.org/alpha/doc", accessed: "2026-10-20", opened: true, quote: "The alpha rate is reported for calendar years." }],
  about: "This document was prepared to test the report chain of data-analyst-mcp.",
  data_files: [{ label: "Alpha observations (CSV)", path: "data/alpha/obs.csv" }, { label: "Beta codebook (CSV)", path: "data/beta/codebook.csv" }],
  clearance: [{ source: "alpha", key: "C9", basis: "synthetic test series, not cleared", redistribute: false }],
};

const DECISIONS = {
  questions: [{ id: "year_basis", question: "Calendar or fiscal years?",
    options: ["Calendar years (recommended)", "Fiscal years", "Don't know — decide for me"],
    asked: true, answer: "dont_know", how: "skipped", resolution: "Calendar years", assumption: "Year basis" }],
  literature_search: [{ query: "alpha rate methodology", date: "2026-10-20", tool: "WebSearch", found: ["alpha_doc"] }],
  data_needs: [{ id: "alpha_pub", data: "The agency's published alpha table", improves: ["Alpha rate"],
    effect: "a benchmark for the headline rate", how_to_get: "the Alpha Test Agency release page", from_user: false }],
};
const BENCHMARK = "measure,period,computed,published,source,url,accessed\nAlpha rate,2024,5.25,not checked,Alpha Test Agency,,\n";

// what compute and facts write for the Python test's analysis.py
const EXHIBIT_1 = "year,date,value\r\n2022,2022-01-01,4.0\r\n2023,2023-01-01,4.5\r\n2024,2024-01-01,5.25\r\n";
const EXHIBIT_2 = "group,rate\r\nX,0.75\r\nY,0.5\r\n";
const FACTS = {
  alpha_first: { value: 4.0, source: "exhibits/exhibit_1.csv", where: { year: "2022" }, column: "value", fmt: "pct100:1",
    label: "Alpha rate, 2022", pack: "alpha", text: "4.0 percent" },
  alpha_last: { value: 5.25, source: "exhibits/exhibit_1.csv", where: { year: "2024" }, column: "value", fmt: "pct100:1",
    label: "Alpha rate, 2024", pack: "alpha", preliminary: true, headline: true, text: "5.3 percent" },
  alpha_change: { value: 1.25, derivation: "alpha_last - alpha_first", fmt: "pp100:1", label: "Change in the alpha rate",
    pack: "alpha", text: "1.3 percentage points" },
  beta_rate_x: { value: 0.75, source: "exhibits/exhibit_2.csv", where: { group: "X" }, column: "rate", fmt: "pct:0",
    label: "Employment rate, group X", pack: "beta", text: "75 percent" },
  beta_rate_y: { value: 0.5, source: "exhibits/exhibit_2.csv", where: { group: "Y" }, column: "rate", fmt: "pct:0",
    label: "Employment rate, group Y", pack: "beta", text: "50 percent" },
};

function write(p: string, text: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof text === "string" || Buffer.isBuffer(text) ? text : JSON.stringify(text, null, 2));
}
const sha = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");

function snapshot(out: string, url: string, id: string, text: string, ext = ".md"): void {
  const rel = `references/${id}${ext}`;
  write(path.join(out, rel), text);
  const logp = path.join(out, "references", "opened.json");
  const log = fs.existsSync(logp) ? JSON.parse(fs.readFileSync(logp, "utf8")) : {};
  log[id] = { url, file: rel, sha256: sha(text), bytes: Buffer.byteLength(text), opened: "2026-10-20T12:00:00Z", via: "file", content_type: "" };
  write(logp, log);
}

function makeSources(d: string): void {
  for (const [sid, P] of Object.entries(POLICIES)) write(path.join(d, sid, "policy.json"), P);
}

function makeOut(out: string): void {
  const j = (...p: string[]) => path.join(out, ...p);
  write(j("data", "alpha", "obs.csv"), "series_id,date,value\nA1,2022-01-01,4.0\nA1,2023-01-01,4.5\nA1,2024-01-01,5.25\nC9,2024-01-01,99\n");
  write(j("data", "alpha", "series.csv"), "series_id,title,units,frequency,copyright,citation\n" +
    'A1,Alpha rate,Percent,Annual,public_domain,"Alpha Test Agency, Alpha rate [A1]."\n' +
    'C9,Copyrighted index,Index,Annual,copyrighted,"Owner, Copyrighted index [C9]."\n');
  write(j("data", "alpha", "raw", "A1_resp.json"), { note: "synthetic" });
  write(j("data", "alpha", "raw", "C9_resp.json"), { note: "synthetic" });
  write(j("data", "alpha", "README.md"), "# Alpha Test Statistics: downloaded data (synthetic)\n");
  write(j("data", "alpha", "request.json"), { source: "alpha", spec: { description: "alpha test", requests: [{ name: "obs", endpoint: "obs" }] },
    route: "api", acquired: "api", retrieved: "2026-10-01T12:00:00+00:00", vintage: "latest", latest_period: "2024 M01",
    requests: [{ url: "https://example.org/alpha/api/obs" }], tables: [{ name: "obs", file: "obs.csv", rows: 4, columns: ["series_id", "date", "value"] }] });
  write(j("data", "beta", "person_extract.csv"), "id,group,employed\n1,X,1\n2,X,1\n3,X,0\n4,X,1\n5,Y,1\n6,Y,0\n7,Y,0\n8,Y,1\n");
  write(j("data", "beta", "codebook.csv"), "variable,label\ngroup,Synthetic group\nemployed,Employed\n");
  write(j("data", "beta", "README.md"), "# Beta Test Survey extract (synthetic)\n");
  write(j("data", "beta", "request.json"), { source: "beta", spec: { description: "beta extract", samples: ["s1"], variables: ["group"] },
    route: "manual_download", retrieved: "2026-10-02T00:00:00+00:00" });
  write(j("manual_download", "beta", "INSTRUCTIONS.md"), "# How to download the beta extract\n");
  // the manual bundle's manifest: the reproduce scripts are built from its items (the request built in)
  write(j("manual_download", "manifest.json"), { items: [{ source: "beta", name: "extract", filename: "beta_extract.csv", method: "GET",
    url: "https://example.org/beta/api/extract?samples=s1&variables=group", needs_key: true, key_env: "BETA_TEST_API_KEY",
    signup_url: "https://example.org/beta/key", key_header: "Authorization", key_prefix: "", note: "", optional: false }] });
  write(j("exhibits", "exhibit_1.csv"), EXHIBIT_1);
  write(j("exhibits", "exhibit_2.csv"), EXHIBIT_2);
  write(j("exhibits", "lineage.json"), {
    "exhibits/exhibit_1.csv": { packs: ["alpha"], tool: "compute", inputs: { obs: { path: "data/alpha/obs.csv", sha256: sha(fs.readFileSync(j("data", "alpha", "obs.csv"))) } },
      steps: [{ filter: "series_id == 'A1'" }], sha256: sha(EXHIBIT_1) },
    "exhibits/exhibit_2.csv": { packs: ["beta"], tool: "compute", inputs: { m: { path: "data/beta/person_extract.csv", sha256: "x" } },
      steps: [{ groupby: ["group"] }], sha256: sha(EXHIBIT_2) } });
  write(j("facts.json"), FACTS);
  write(j("report.json"), REPORT);
  write(j("decisions.json"), DECISIONS);
  write(j("exhibits", "benchmark.csv"), BENCHMARK);
  snapshot(out, "https://example.org/alpha/doc", "alpha_doc", "# Test Documentation\n\nThe alpha rate is reported for calendar years.\n");
}

const fails = (r: Result[]) => r.filter(([, ok]) => !ok);
const sameAll = () => {
  rerunStub.impl = () => ({ exhibits: { "exhibits/exhibit_1.csv": { same: true }, "exhibits/exhibit_2.csv": { same: true } },
    facts: Object.fromEntries(Object.entries(FACTS).map(([k, f]) => [k, { stored: f.value, rerun: f.value, same: true }])) });
};

let tmp = "", src = "", out = "", page = "", names = new Set<string>(), zip: Record<string, Uint8Array> = {}, res: any;
const zipText = (n: string) => Buffer.from(zip[n]).toString("utf8");
const copyOut = (name: string) => {
  const dst = path.join(tmp, name);
  fs.cpSync(out, dst, { recursive: true, preserveTimestamps: true });
  return dst;
};
const auditOf = (o: string, rerun = false) => AR.audit(path.join(o, "report.json"), undefined, false, rerun);

beforeAll(() => {
  isolate();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "da-report-"));
  src = path.join(tmp, "sources");
  makeSources(src);
  PS.setSourcesDir(src);
  out = path.join(tmp, "out");
  makeOut(out);
  res = build(path.join(out, "report.json"));
  zip = unzipSync(fs.readFileSync(path.join(out, "replication_package.zip")));
  names = new Set(Object.keys(zip));
  page = fs.readFileSync(path.join(out, "report.html"), "utf8");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("build", () => {
  it("the fake policies are valid", () => {
    for (const sid of Object.keys(POLICIES)) expect(pol.validate(pol.load(path.join(src, sid)), path.join(src, sid))).toEqual([]);
  });

  it("builds the html", () => {
    expect(res.sources).toEqual(["alpha", "beta"]);
    expect(res.external_refs).toBe(0);
    expect(page).toContain('class="disclaimer"');
    expect(page).toContain("Data Vintage");
    expect(page).toContain("5.3 percent");                     // alpha_last 5.25 as pct100:1 (half up)
    expect(page).toContain("1.3 percentage points");           // alpha_change 1.25 as pp100:1
    const visible = page.replace(/<blockquote>[\s\S]*?<\/blockquote>|<pre\b[\s\S]*?<\/pre>|<script\b[\s\S]*?<\/script>/g, "");
    expect(visible).not.toContain("{{");
  });

  it("carries every notice", () => {
    const text = page.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect(text).toContain(ALPHA_NOTICE);
    expect(text).toContain(BETA_NOTICE);
    expect(page).toContain("Required Notices");
  });

  it("renders the method record", () => {
    for (const h of ["Questions and Decisions", "Literature Searched", "Data That Would Improve These Estimates",
      "Skipped (treated as Don", "Appendix A lists the data", "the Alpha Test Agency release page"]) expect(page).toContain(h);
    expect(names.has("decisions.json")).toBe(true);
  });

  it("puts only allowed files in the ZIP", () => {
    for (const want of ["REPLICATION.md", "facts.json", "report.json", "exhibits/exhibit_1.csv", "exhibits/exhibit_2.csv",
      "exhibits/lineage.json", "data/alpha/obs.csv", "data/alpha/series.csv", "data/alpha/request.json", "data/alpha/raw/A1_resp.json",
      "data/beta/request.json", "data/beta/README.md", "data/beta/codebook.csv"]) expect(names, want).toContain(want);
    expect(names).not.toContain("data/alpha/raw/C9_resp.json");               // withheld key: raw file left out
    const obs = zipText("data/alpha/obs.csv");
    expect(obs).toContain("A1,2024-01-01,5.25");
    expect(obs).not.toContain("C9");                                         // withheld rows dropped
    expect(fs.readFileSync(path.join(out, "data", "alpha", "obs.csv"), "utf8")).toContain("C9");   // local file intact
    expect(names).not.toContain("manual_download/beta/INSTRUCTIONS.md");
    expect([...names].some((n) => n.startsWith("lib/"))).toBe(false);        // recipes, not Python helpers
  });

  it("refuses definition_only microdata and writes the reproduce bundle", () => {
    expect(names).not.toContain("data/beta/person_extract.csv");
    for (const f of ["REPRODUCE.md", "spec.json", "download_beta.sh", "download_beta.ps1"]) expect(names).toContain(`reproduce/beta/${f}`);
    expect(names).not.toContain("reproduce/beta/manual/INSTRUCTIONS.md");    // the scripts replace the bundle
    expect(zipText("reproduce/beta/download_beta.sh")).toContain("samples=s1");   // request built in
    const txt = zipText("reproduce/beta/REPRODUCE.md");
    expect(txt).toContain("bash reproduce/beta/download_beta.sh");
    expect(txt).toContain(String.raw`-File ".\reproduce\beta\download_beta.ps1"`);
    expect(txt.indexOf("bash reproduce/beta/download_beta.sh")).toBeLessThan(txt.indexOf("ingest"));   // script first
    expect(txt).toContain('ingest {"source": "beta", "spec": <the content of reproduce/beta/spec.json>, "files": ["reproduce/beta"]}');
    expect(zipText("REPLICATION.md")).toContain("bash reproduce/beta/download_beta.sh");
    for (const f of ["REPRODUCE.md", "download_beta.sh", "download_beta.ps1", "spec.json"]) expect(page).toContain(`Download ${f}</button>`);
    expect(page.indexOf("Download download_beta.sh")).toBeLessThan(page.indexOf("Download spec.json"));
    expect(page).toContain("<code>reproduce/beta/download_beta.sh</code> (macOS, Linux)");
    expect(JSON.parse(zipText("reproduce/beta/spec.json")).samples).toEqual(["s1"]);
    expect(zipText("REPLICATION.md")).toContain("data/beta/person_extract.csv");   // listed as left out
    expect(page).not.toContain("href='../data/beta/person_extract.csv'");
    expect(page).toContain("local only, not distributed");
  });

  it("refuses microdata even when listed", async () => {
    const o = copyOut("extra_listed");
    const R = JSON.parse(fs.readFileSync(path.join(o, "report.json"), "utf8"));
    R.replication = { extra: ["data/beta/person_extract.csv"], include_microdata: true };
    R.data_files.push({ label: "Extract", path: "data/beta/person_extract.csv" });
    write(path.join(o, "report.json"), R);
    build(path.join(o, "report.json"));
    expect(Object.keys(unzipSync(fs.readFileSync(path.join(o, "replication_package.zip"))))).not.toContain("data/beta/person_extract.csv");
    expect(fs.readFileSync(path.join(o, "report.html"), "utf8")).not.toContain("person_extract.csv'>Extract");
    const r = await auditOf(o);
    expect(fails(r).some(([c, , m]) => c === "links" && m.includes("person_extract")), JSON.stringify(fails(r))).toBe(true);
  });

  it("refuses to build inside the server's package folder", async () => {
    const { ROOT } = await import("../src/core/env.js");
    expect(() => build(path.join(ROOT, "report.json"))).toThrow(BuildError);
  });

  it("checks the placeholder grammar", () => {
    const full = (s: string) => new RegExp(`^(?:${FACT_RE.source})$`).test(s);
    expect(full("{{x|signed:from_millions:dollars_b:1}}")).toBe(true);
    expect(full("{{x|pct:1:abs}}")).toBe(true);
    expect(full("{{ x }}")).toBe(true);
  });
});

describe("audit", () => {
  it("passes the good report, rerun included", async () => {
    sameAll();
    const r = await auditOf(out, true);
    expect(fails(r)).toEqual([]);
    expect(r.some(([c, , m]) => c === "policy" && m.includes("beta hook beta_codebook"))).toBe(true);
    expect(r.some(([c, , m]) => c === "replication" && m.includes("rerun reproduces"))).toBe(true);
    rerunStub.impl = null;
  });

  it("the audit_report tool says AUDIT PASSED", async () => {
    const tool = TOOLS.find((t) => t.name === "audit_report")!;
    const r: any = await tool.handler(new Session(undefined, out), {});
    expect(r.summary).toBe("AUDIT PASSED");
    expect(r.checks.every((c: any) => c.status === "PASS")).toBe(true);
  });

  it("fails on forced microdata", async () => {
    const o = copyOut("forced");
    const zp = path.join(o, "replication_package.zip");
    const z = unzipSync(fs.readFileSync(zp));
    z["data/beta/person_extract.csv"] = fs.readFileSync(path.join(o, "data", "beta", "person_extract.csv"));
    fs.writeFileSync(zp, zipSync(z));
    expect(fails(await auditOf(o)).some(([c, , m]) => c === "replication" && m.includes("person_extract"))).toBe(true);
  });

  it("fails on a missing notice", async () => {
    const o = copyOut("no_notice");
    const p = path.join(o, "report.html");
    const stat = fs.statSync(p);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").split(esc(BETA_NOTICE)).join("").split(BETA_NOTICE).join(""));
    fs.utimesSync(p, stat.atime, new Date(stat.mtimeMs + 1000));
    expect(fails(await auditOf(o)).some(([c, , m]) => c === "policy" && m.includes("notice missing"))).toBe(true);
  });

  it("fails on a missing hook file", async () => {
    const o = copyOut("no_codebook");
    fs.rmSync(path.join(o, "data", "beta", "codebook.csv"));
    expect(fails(await auditOf(o)).some(([c, , m]) => c === "policy" && m.includes("beta_codebook"))).toBe(true);
  });

  it("fails without a clearance", async () => {
    const o = copyOut("no_clearance");
    const R = JSON.parse(fs.readFileSync(path.join(o, "report.json"), "utf8"));
    delete R.clearance;
    write(path.join(o, "report.json"), R);
    build(path.join(o, "report.json"));
    expect(fails(await auditOf(o)).some(([c, , m]) => c === "policy" && m.includes("alpha C9"))).toBe(true);
  });

  it("fails without download scripts", async () => {
    const o = copyOut("no_scripts");
    const zp = path.join(o, "replication_package.zip");
    const z = unzipSync(fs.readFileSync(zp));
    for (const n of Object.keys(z)) if (n.endsWith(".sh") || n.endsWith(".ps1")) delete z[n];
    fs.writeFileSync(zp, zipSync(z));
    expect(fails(await auditOf(o)).some(([c, , m]) => c === "replication" && m.includes("download_*.sh"))).toBe(true);
  });

  it("fails on withheld rows", async () => {
    const o = copyOut("withheld_rows");
    const zp = path.join(o, "replication_package.zip");
    const z = unzipSync(fs.readFileSync(zp));
    z["data/alpha/extra.csv"] = Buffer.from("series_id,value\nC9,1\n");
    fs.writeFileSync(zp, zipSync(z));
    expect(fails(await auditOf(o)).some(([c, , m]) => c === "replication" && m.includes("withheld"))).toBe(true);
  });

  it("finds hand-typed numbers", () => {
    expect(AR.hardNumbers("In 2024, Exhibits 2, 3, and 4 show U-6 and 2026Q2.", new Set())).toEqual([]);
    expect(AR.hardNumbers("The rate was 4.2 percent on March 31, 2026.", new Set())).toEqual(["4.2"]);
    expect(AR.hardNumbers("It cost $2,000 in fiscal year 2025.", new Set())).toEqual(["$2,000"]);
  });
});

describe("policy set", () => {
  const P = (redistribution: any, audit_hooks: any[] = []) => ({ id: "g", redistribution: { microdata_globs: [], package_include: [],
    withhold: null, ...redistribution }, audit_hooks }) as any;
  it("aggregates_only", () => {
    const p = P({ mode: "aggregates_only", microdata_globs: ["records_*.csv"] });
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "da-ps-"));
    expect(PS.decide("data/g/records_2024.csv", t, { g: p }, {}).ok).toBe(false);
    expect(PS.decide("data/g/table1.csv", t, { g: p }, {}).ok).toBe(true);
    expect(PS.decide("data/loose.csv", t, { g: p }, {}).ok).toBe(false);            // strictest rule
    expect(PS.decide("exhibits/records_x.csv", t, { g: p }, {}).ok).toBe(true);
    fs.rmSync(t, { recursive: true, force: true });
  });
  it("size limit", () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), "da-ps-"));
    write(path.join(t, "data", "g", "big.csv"), "x\n1\n");
    const old = PS.LIMITS.MICRO_MAX;
    PS.LIMITS.MICRO_MAX = 2;
    let d;
    try {
      d = PS.decide("data/g/big.csv", t, { g: P({ mode: "allowed" }) }, {});
    } finally {
      PS.LIMITS.MICRO_MAX = old;
    }
    expect(d.ok).toBe(false);
    expect(d.policy).toBe(false);
    expect(d.reason).toContain("MB");
    fs.rmSync(t, { recursive: true, force: true });
  });
  it("forbid hook", () => {
    const p = P({ mode: "allowed" }, [{ id: "h", kind: "forbid_in_package", globs: ["exhibits/private_*"], why: "t" }]);
    expect(PS.decide("exhibits/private_a.csv", ".", { g: p }, {}).ok).toBe(false);
  });
});

describe("style", () => {
  it("rules", () => {
    expect(styleIssues("We find that the rate rose.").length).toBeGreaterThan(0);
    expect(styleIssues("Title I funds rose in October 1 and under 5 U.S.C. 5332.")).toEqual([]);
    expect(styleIssues("The rate rose 5%.").some((m) => m.includes("percent"))).toBe(true);
  });
  it("the style_check tool scores report.json", async () => {
    const tool = TOOLS.find((t) => t.name === "style_check")!;
    const r: any = await tool.handler(new Session(undefined, out), {});
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.summary).toMatch(/^Style guide: \d+\/\d+ sentences compliant/);
  });
});

describe("tools on a fetched workspace (cdc fixtures)", () => {
  const SPEC = { description: "Leading causes of death, New York, 2017", requests: [{ name: "ny_causes_2017",
    endpoint: "query", params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'", $order: "deaths DESC" } }] };

  it("audit_answer passes a cited answer and fails a typo; scan_secrets is clean", async () => {
    PS.setSourcesDir((await import("../src/core/env.js")).PACKS_DIR);
    try {
      const s = new Session(undefined, fs.mkdtempSync(path.join(os.tmpdir(), "da-ws-")));
      await fetchOk(s, "cdc", SPEC);
      const ws = s.workspace;
      const rows = fs.readFileSync(path.join(ws, "data", "cdc", "ny_causes_2017.csv"), "utf8");
      const head = rows.split(/\r?\n/)[0].split(",");
      expect(head).toContain("deaths");
      const all = fs.readFileSync(path.join(ws, "data", "cdc", "ny_causes_2017.csv"), "utf8").split(/\r?\n/).filter((l) => l);
      const cells = all[1].split(",");
      const row = Object.fromEntries(head.map((h, i) => [h, cells[i]]));
      const deaths = Number(row.deaths);
      write(path.join(ws, "facts.json"), { deaths: { value: deaths, source: "data/cdc/ny_causes_2017.csv",
        where: { cause_name: row.cause_name, year: row.year, state: row.state }, column: "deaths", fmt: "num:0",
        label: `Deaths, ${row.cause_name}, New York, 2017`, pack: "cdc", headline: true, text: deaths.toLocaleString("en-US") } });
      write(path.join(ws, "exhibits", "benchmark.csv"), `measure,period,computed,published,source\ndeaths,2017,${deaths},not checked,CDC\n`);
      const D: any = JSON.parse(fs.readFileSync(path.join(ws, "decisions.json"), "utf8"));
      Object.assign(D, { literature_search: [{ unavailable: true, reason_code: "no_search_tool" }],
        disclosures: { literature: "No literature search was run: this test has no search tool." },
        references: [{ id: "cdc_lcod", citation: "CDC, Leading causes of death", url: "https://data.cdc.gov/x", accessed: "2026-10-20", opened: true }],
        assumptions: [{ parameter: "measure", value: "deaths", basis: "user", request: "leading causes of death in New York" }],
        data_needs: [{ id: "pub", data: "CDC's published count", improves: ["deaths"], effect: "a benchmark", how_to_get: "WONDER" }] });
      write(path.join(ws, "decisions.json"), D);
      snapshot(ws, "https://data.cdc.gov/x", "cdc_lcod", "Leading causes of death.");
      const tool = TOOLS.find((t) => t.name === "audit_answer")!;
      const good = `In New York in 2017, ${row.cause_name} caused ${deaths.toLocaleString("en-US")} deaths. ` +
        "No literature search was run: this test has no search tool.";
      let r: any = await tool.handler(s, { answer: good });
      expect(r.checks.filter((c: any) => c.status === "FAIL")).toEqual([]);
      expect(r.summary).toBe("AUDIT PASSED");
      expect(fs.readFileSync(path.join(ws, "answer.md"), "utf8")).toContain(good);
      r = await tool.handler(s, { answer: good.replace(deaths.toLocaleString("en-US"), (deaths + 7).toLocaleString("en-US")) });
      expect(r.passed).toBe(false);
      expect(r.checks.some((c: any) => c.status === "FAIL" && c.message.includes("not found among the facts"))).toBe(true);
      const scan: any = await TOOLS.find((t) => t.name === "scan_secrets")!.handler(s, {});
      expect(scan.passed).toBe(true);
      expect(scan.summary).toMatch(/^OK: scanned \d+ files/);
      // a stored key that reaches a workspace file fails both the scan and the audit, by file name only
      const key = "kq" + "7".repeat(38);
      process.env.CDC_TEST_KEY_NOT_A_PACK = key;
      const { findKey } = await import("../src/core/keys.js");
      findKey("CDC_TEST_KEY_NOT_A_PACK");
      write(path.join(ws, "notes.txt"), `debug ${key}
`);
      const bad: any = await TOOLS.find((t) => t.name === "scan_secrets")!.handler(s, {});
      expect(bad.passed).toBe(false);
      expect(bad.hits).toEqual(["notes.txt: line ~1: contains an API key value"]);
      r = await tool.handler(s, { answer: good });
      const sec = r.checks.find((c: any) => c.check === "secrets");
      expect(sec.status).toBe("FAIL");
      expect(JSON.stringify(r)).not.toContain(key);
    } finally {
      PS.setSourcesDir(src);
    }
  });
});
