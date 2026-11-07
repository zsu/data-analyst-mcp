/**
 * ipums deep pack tests (offline), ported from tests/sources/ipums/test_ipums.py. Fixtures: real IPUMS API v2
 * metadata responses (October 2026), a real GET /extracts/11 response (account e-mail and number scrubbed), the real
 * DDI codebooks of a CPS and an NHIS extract (trimmed; documentation, not microdata), and SYNTHETIC rows in the IPUMS
 * CSV layout (the IPUMS terms forbid redistributing extracts; the CPS file's checksum differs from the one IPUMS
 * reported, so it also tests the checksum guard).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { approxRows, buildBody, IpumsClient, parseDdi, sampleLabel, specProblems, verify, webSection, writeManualBundle,
  writeReproduceBundle } from "../../src/deep/ipums.js";
import { csv, failure, fakeKeys, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

const SPEC = { collection: "cps",
  description: "Employment and wages of people ages 25-54 by sex and education, CPS ASEC 2023 (smoke test)",
  samples: ["cps2023_03s"], variables: ["AGE", "SEX", "EDUC", "EMPSTAT", "CLASSWLY", "INCWAGE", "WKSWORK1", "UHRSWORKLY"],
  case_selections: { AGE: { min: 25, max: 54 } } };
const SPEC_NHIS = { collection: "nhis", description: "Uninsured adults, NHIS 2024 (smoke test)", samples: ["ih2024"],
  variables: ["AGE", "EDUC", "EMPSTAT", "USBORN", "HINOTCOVE"] };
const FIX = path.join(TEST_DIR, "packs", "ipums", "fixtures");
const FAKE = "offline-test-key-not-real";

beforeAll(() => isolate());
beforeEach(() => {
  delete process.env.IPUMS_API_KEY;
  delete process.env.DATA_ACCESS_FORCE;
  fixtures("ipums");
});

function uploads(pairs = [["synthetic_cps_00011.csv.gz", "cps_00011.csv.gz"], ["ddi_cps_00011.xml", "cps_00011.xml"]]): string[] {
  const up = fs.mkdtempSync(path.join(os.tmpdir(), "ipums-up-"));
  for (const [src, dst] of pairs) fs.copyFileSync(path.join(FIX, src), path.join(up, dst));
  return pairs.map(([, dst]) => path.join(up, dst));
}

async function ingest(s: any, spec: any, files: string[]): Promise<any> {
  await prepare(s, "ipums", spec);
  return T.ingest(s, { source: "ipums", spec, files });
}

async function fetchFail(spec: any, s = newSession()) {
  await prepare(s, "ipums", spec);
  return failure(T.fetchData(s, { source: "ipums", spec }));
}

const ddir = (s: any) => path.join(s.workspace, "data", "ipums");

describe("ipums", () => {
  it("dry run: the API body", () => {
    const body = buildBody(SPEC);
    expect(body.samples).toEqual({ cps2023_03s: {} });
    expect(body.variables.AGE.caseSelections.general[0]).toBe("25");
    expect(body.variables.AGE.caseSelections.general.length).toBe(30);
    expect(body.dataStructure).toEqual({ rectangular: { on: "P" } });
  });

  it("check: a valid spec, and IPUMS accepts the key (ping)", async () => {
    const p = await load("ipums");
    expect(p.deep!.checkSpec!(SPEC, p)).toEqual([]);
    const r = await new IpumsClient(FAKE).ping("cps");
    expect(r.auth_ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("offline-test-key");
    expect(String(new IpumsClient(FAKE))).not.toContain("offline-test-key");
  });

  it("no key: the fetch is refused with the setup command and the website route", async () => {
    const f = await fetchFail(SPEC);
    expect(f.code).toBe("key_missing");
    expect(f.fix).toContain("setup ipums");
    expect(f.fix).toContain("website");
    expect(f.manual_bundle).toBeTruthy();
  });

  it("hand-download bundle: no key, the website comes first", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "ipums-b-"));
    const b = writeManualBundle("cps", buildBody(SPEC), out, "key_missing");
    expect(b.endsWith(path.join("manual_download", "ipums"))).toBe(true);
    for (const f of ["INSTRUCTIONS.md", "download_ipums.sh", "download_ipums.ps1", "extract_spec.json", "manifest.json"]) {
      expect(fs.existsSync(path.join(b, f)), f).toBe(true);
    }
    const sh = fs.readFileSync(path.join(b, "download_ipums.sh"), "utf8");
    expect(sh).toContain('"cps2023_03s"'); // the definition is built into the script
    expect(sh).not.toContain("@SPEC_JSON@");
    expect(sh).not.toContain("\r\n");
    const text = fs.readFileSync(path.join(b, "INSTRUCTIONS.md"), "utf8");
    expect(text).toContain("Option A: the IPUMS website");
    expect(text).toContain("codes 25 through 54");
    expect(text).toContain("bash ~/Downloads/download_ipums.sh");
    expect(text).toContain('-File "$HOME\\Downloads\\download_ipums.ps1"');
    expect(text.toLowerCase()).not.toContain("python");
    // a key exists (network blocked): the API steps come first
    const k = fs.readFileSync(path.join(writeManualBundle("cps", buildBody(SPEC), out, "network"), "INSTRUCTIONS.md"), "utf8");
    expect(k).toContain("Option A: the IPUMS API");
  });

  it("fix_spec", async () => {
    const f = await fetchFail({ collection: "cps", samples: [], variables: ["AGE"] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain('"samples" must be a non-empty list');
  });

  it("ingest supersedes an earlier codebook", async () => {
    const s = newSession();
    fs.mkdirSync(ddir(s), { recursive: true });
    fs.writeFileSync(path.join(ddir(s), "cps_00009.xml"), "<codeBook/>");
    const r = await ingest(s, SPEC, uploads());
    expect(r.status).toBe("ok");
    const xmls = fs.readdirSync(ddir(s)).filter((x) => x.endsWith(".xml"));
    expect(xmls).not.toContain("cps_00009.xml");
    expect(fs.existsSync(path.join(ddir(s), "cps_00009.xml.superseded"))).toBe(true);
  });

  it("ingest: package", async () => {
    const s = newSession();
    const r = await ingest(s, SPEC, uploads());
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("manual_download");
    expect(r.summary.tables[0].rows).toBe(3);
    const rows = csv(s, "ipums", "ipums_extract");
    expect(Object.keys(rows[0])).toEqual(["YEAR", "SERIAL", "ASECWT", "AGE", "SEX", "INCWAGE"]);
    expect(rows[0].INCWAGE).toBe("52000");
    const sex = Object.fromEntries(csv(s, "ipums", "codebook").filter((c) => c.variable === "SEX").map((c) => [c.value, c.value_label]));
    expect(sex["2"]).toBe("Female"); // from the real DDI
    const readme = fs.readFileSync(path.join(ddir(s), "README.md"), "utf8");
    expect(readme).toContain("DOI 10.18128/D030.V13.0");
    expect(readme).toContain("definition_only");
    expect(readme).toContain("`ASECWT`: ASEC person weight");
    const req = JSON.parse(fs.readFileSync(path.join(ddir(s), "request.json"), "utf8"));
    expect(req.route).toBe("manual_download");
    expect(req.tables[0].file).toBe("ipums_extract.csv");
    expect(JSON.parse(fs.readFileSync(path.join(ddir(s), "extract_spec.json"), "utf8")).extract_number).toBe(11);
    // the same request is now reused, not submitted again
    await fakeKeys("ipums", FAKE);
    const again: any = await T.fetchData(s, { source: "ipums", spec: SPEC });
    expect(again.summary.route).toBe("reuse_existing");
    expect(JSON.stringify(again)).not.toContain("offline-test-key");
  });

  it("ingest from a folder", async () => {
    const s = newSession();
    const r = await ingest(s, SPEC, [path.dirname(uploads()[0])]);
    expect(r.status).toBe("ok");
    expect(r.notes.join(" ")).toContain("Extract cps:11");
  });

  it("resume is automatic, and the checksum guard refuses a file IPUMS did not report", async () => {
    const s = newSession();
    fs.mkdirSync(ddir(s), { recursive: true });
    fs.writeFileSync(path.join(ddir(s), "extract_spec.json"), JSON.stringify({ collection: "cps", extract_number: 11, spec: SPEC,
      api_body: buildBody(SPEC), status: "submitted" }));
    await fakeKeys("ipums", FAKE);
    const f = await fetchFail(SPEC, s); // collects extract 11 (no new submission: the fixtures have no POST)
    expect(f.message).toContain("Checksum mismatch");
    expect(fs.existsSync(path.join(ddir(s), "ipums_extract.csv"))).toBe(false);
    expect(JSON.stringify(f)).not.toContain("offline-test-key");
  });

  it("list samples (search)", async () => {
    await fakeKeys("ipums", FAKE);
    const p = await load("ipums");
    const hits = await p.deep!.search!("cps ASEC 2023", p);
    expect(hits.map((h: any) => `${h.name}\t${h.description}`)).toContain("cps2023_03s\tIPUMS-CPS, ASEC 2023");
    for (const [c, line] of [["nhis", "ih2024\t2024 NHIS"], ["meps", "mp2022\t2022 MEPS"]]) {
      expect((await p.deep!.search!(c, p)).map((h: any) => `${h.name}\t${h.description}`)).toContain(line);
    }
    // request_schema lists the collection's samples
    const s = newSession();
    await T.sourceBrief(s, { source: "ipums" });
    const sc: any = await T.requestSchema(s, { source: "ipums", names: ["cps"] });
    expect(sc.schemas[0].samples.some((x: any) => x.name === "cps2023_03s")).toBe(true);
    expect(sc.schemas[0].weights.ASECWT).toContain("ASEC person weight");
  });

  it("reproduce bundle", () => {
    const rep = fs.mkdtempSync(path.join(os.tmpdir(), "ipums-rep-"));
    writeReproduceBundle("cps", buildBody(SPEC), rep);
    expect(fs.readdirSync(rep).sort()).toEqual(["DOWNLOAD.md", "download_ipums.ps1", "download_ipums.sh", "extract_spec.json"]);
    for (const name of ["download_ipums.sh", "download_ipums.ps1"]) { // each works alone: the definition is built in
      const text = fs.readFileSync(path.join(rep, name), "utf8");
      expect(text).toContain('"cps2023_03s"');
      expect(text).not.toContain("SPEC_FILE");
      expect(text).not.toContain("SpecFile");
      expect(text).toContain(name.endsWith(".sh") ? 'BAKED_NUMBER=""' : "$BakedNumber = ''");
    }
    const doc = fs.readFileSync(path.join(rep, "DOWNLOAD.md"), "utf8");
    expect(doc).toContain("bash download_ipums.sh");
    expect(doc).toContain("built in");
  });

  it("key check (setup)", async () => {
    const [ok, detail] = await verify(FAKE);
    expect(ok).toBe(true);
    expect(detail).not.toContain("offline-test-key");
  });

  it("health surveys: spec rules and ingest", async () => {
    const bad = { ...SPEC_NHIS, case_selections: { AGE: { min: 18, max: 64 } }, adjust_monetary_values: ["X"] };
    let probs = specProblems(bad);
    expect(probs.filter((x) => x.includes("available only for usa, cps, ipumsi")).length).toBe(2);
    expect(probs.join(" ")).toContain("case_selections");
    expect(probs.join(" ")).toContain("domain mask");
    expect(probs.join(" ")).toContain("CPI-U");
    // options the API refuses for one health survey but not the other
    for (const [spec, word] of [[{ ...SPEC_NHIS, data_quality_flags: true }, "data_quality_flags"],
      [{ ...SPEC_NHIS, collection: "meps", samples: ["mp2022"], attached_characteristics: { EDUC: ["spouse"] } }, "attached_characteristics"],
      [{ ...SPEC_NHIS, data_structure: { rectangular: { on: "R" } } }, "rectangular on 'R'"]] as const) {
      probs = specProblems(spec);
      expect(probs.join(" ")).toContain(word);
    }
    expect(specProblems({ ...SPEC_NHIS, data_structure: { rectangular: { on: "I" } } })).toEqual([]);
    const s = newSession();
    const r = await ingest(s, SPEC_NHIS, [path.dirname(uploads([["synthetic_nhis_00001.csv.gz", "nhis_00001.csv.gz"],
      ["ddi_nhis_00001.xml", "nhis_00001.xml"]])[0])]);
    expect(r.status).toBe("ok");
    expect(r.summary.tables[0].rows).toBe(4);
    expect(r.notes.join(" ")).toContain("Extract nhis:1");
    const cov = Object.fromEntries(csv(s, "ipums", "codebook").filter((c) => c.variable === "HINOTCOVE").map((c) => [c.value, c.value_label]));
    expect(cov["2"]).toBe("Yes, has no coverage"); // from the real DDI
    const readme = fs.readFileSync(path.join(ddir(s), "README.md"), "utf8");
    expect(readme).toContain("IPUMS NHIS");
    expect(readme).toContain("SAMPWEIGHT");
    expect(readme).toContain("0 = NIU"); // NHIS missing-code hint, not USA's
    expect([sampleLabel("ih2024"), sampleLabel("mp2022")]).toEqual(["2024 NHIS", "2022 MEPS"]);
    expect(approxRows(["ih2024", "mp2022"])).toBe(45_000 + 25_000);
    const rounds = buildBody({ ...SPEC_NHIS, collection: "meps", samples: ["mp2022"], data_structure: { rectangular: { on: "R" } } });
    expect(webSection("meps", rounds)).toContain("**Rectangular (round)**");
  });

  it("DDI: special codes of continuous variables", () => {
    // INCBUS has no category rows; its NIU code is only in the coding notes [ASEC 2026 DDI, 2026-10-21]
    const xml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ipums-x-")), "x.xml");
    fs.writeFileSync(xml, '<codeBook><dataDscr><var name="INCBUS"><labl>Non-farm business income</labl>' +
      "<txt>INCBUS indicates net business income.</txt>" +
      "<codInstr>Codes99999999 = N.I.U. (Not in Universe). 99999998 = Missing. (1962-1964 only)" +
      '</codInstr></var><var name="SEX"><labl>Sex</labl><catgry><catValu>1</catValu><labl>Male</labl>' +
      "</catgry></var></dataDscr></codeBook>");
    let codes = parseDdi(xml)[1];
    expect(new Set(codes.map((c) => `${c.variable}|${c.value}`))).toEqual(new Set(["INCBUS|99999999", "INCBUS|99999998", "SEX|1"]));
    fs.writeFileSync(xml, '<codeBook><dataDscr><var name="EARNWEEK2"><labl>Weekly earnings</labl>' + // a decimal code is one code
      "<codInstr>999999.99 = N.I.U. (Not in Universe).</codInstr></var></dataDscr></codeBook>");
    codes = parseDdi(xml)[1];
    expect(codes.map((c) => `${c.variable}|${c.value}`)).toEqual(["EARNWEEK2|999999.99"]);
  });
});
