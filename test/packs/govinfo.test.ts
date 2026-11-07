/** govinfo: ported from tests/sources/govinfo/test_govinfo.py (same fixtures, same values). */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import * as G from "../../src/adapters/govinfo.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

beforeAll(() => isolate());

const SRC = "govinfo";
const SPEC = { description: "Stablecoin bills in the 118th Congress, recent budget office publications, and the text of one law",
  requests: [
    { name: "stablecoin_bills", endpoint: "search", params: { collection: "BILLS", congress: 118, phrase: "payment stablecoin", sort: "newest" } },
    { name: "cbo_recent", endpoint: "search",
      params: { collection: "GOVPUB", publisher: "Congressional Budget Office", date_from: "2026-06-01", sort: "newest" } },
    { name: "law_text", endpoint: "text", params: { packageId: "PLAW-118publ201" } }] };
const SECTIONS_SPEC = { description: "Sections of two 2024 laws and the U.S. Code sections the first amends",
  requests: [
    { name: "performance_act", endpoint: "sections", params: { packageId: "PLAW-118publ190" } },
    { name: "clinic_naming", endpoint: "sections", params: { packageId: "PLAW-118publ200", max_chars: 200 } }] };

const saved = { ...G.internals };
afterEach(() => Object.assign(G.internals, saved));

async function checkSpec(spec: any): Promise<string[]> {
  const p = await load(SRC);
  return p.adapter!.checkSpec!(spec, p);
}

async function fetchFail(spec: any): Promise<any> {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  return failure(T.fetchData(s, { source: SRC, spec }));
}

describe("govinfo", () => {
  it("fetches keyless by the api route", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.summary.route).toBe("api");
    const bills = csv(s, SRC, "stablecoin_bills");
    expect(bills.length).toBe(9);
    expect(r.notes.some((n: string) => n.includes("quoted search returned"))).toBe(false);   // all-words count 10: no note
    expect(bills[0].packageId).toBe("BILLS-118hr10561ih");
    expect(bills.every((b) => b.collectionCode === "BILLS")).toBe(true);
    expect(csv(s, SRC, "cbo_recent")[0].governmentAuthor).toBe("Congressional Budget Office");
    const text = csv(s, SRC, "law_text")[0];
    expect(text.date_issued).toBe("2024-12-23");
    expect(text.text).toContain("Public Law 118-201");
    expect(text.text).not.toContain("<pre>");
    expect(text.text_status).toBe("full");
    expect(text.pdf_url).toBe("https://www.govinfo.gov/content/pkg/PLAW-118publ201/pdf/PLAW-118publ201.pdf");
    expect(r.notes.some((n: string) => n.includes("no usable text"))).toBe(false);
  });

  it("builds and escapes the query", async () => {
    expect(G.buildQuery({ collection: "BILLS", congress: 118, text: 'tax:credit (child) "AND" \\ OR' }))
      .toBe("collection:BILLS AND congress:118 AND (tax credit child)");
    expect(G.buildQuery({ collection: ["PLAW", "STATUTE"], phrase: 'say "hi"', date_from: "2024-01-01" }))
      .toBe('(collection:PLAW OR collection:STATUTE) AND publishdate:range(2024-01-01,) AND ("say hi")');
    expect(G.buildQuery({ all_words: 'say "hi"' })).toBe("(say hi)");
    expect(G.buildQuery({ collection: "BILLS", congress: 118, title: 'harbor: "dredging"' }))
      .toBe('collection:BILLS AND congress:118 AND title:"harbor dredging"');
    expect(G.buildQuery({ title: "harbor" })).toBe("title:harbor");
    expect(await checkSpec({ requests: [{ name: "t", endpoint: "search", params: { title: "harbor" } }] })).toEqual([]);
    expect(G.billPackageId({ congress: 117, billtype: "HR", number: 5376 })).toBe("BILLS-117hr5376enr");
  });

  it("word forms and one-word phrases", async () => {
    expect(G.buildQuery({ collection: "CRPT", phrase: " levy " })).toBe("collection:CRPT AND (levy)");
    expect(G.buildQuery({ collection: "CRPT", any: ["levy", "levies", "flat tax:rate"] }))
      .toBe('collection:CRPT AND (levy OR levies OR "flat tax rate")');
    expect(G.buildQuery({ any: "levy; levies" })).toBe("(levy OR levies)");
    expect(await checkSpec({ requests: [{ name: "s", endpoint: "search", params: { collection: "CRPT", any: ["levy", "levies"] } }] })).toEqual([]);
    expect((await checkSpec({ requests: [{ name: "s", endpoint: "search", params: { any: ["::"] } }] })).length).toBeGreaterThan(0);
  });

  it("a quoted phrase far below the all-words count is noted", async () => {
    const p = await load(SRC);
    const sent: any[] = [];
    const client = (n: number): any => ({
      async request(_m: string, _p: string, _q: unknown, o: any) {
        sent.push(o.jsonBody);
        return { json: () => ({ count: n }) };
      },
    });
    const req = { name: "s", endpoint: "search", params: { collection: "BILLS", phrase: "flat tax" } };
    G.internals.client = () => client(140);
    const note = (await G.phraseCountNote(p, req, 40))!;
    expect(note).toContain("quoted search returned 40 documents, under half of the 140");
    expect(note).toContain("may be missing documents");
    expect(note).toContain("all_words");
    expect([sent[0].query, sent[0].pageSize]).toEqual(["collection:BILLS AND (flat tax)", 1]);
    G.internals.client = () => client(70);
    expect(await G.phraseCountNote(p, req, 40)).toBeNull();
    G.internals.client = () => client(14);
    expect(await G.phraseCountNote(p, req, 4)).toBeNull();
    expect(await G.phraseCountNote(p, { ...req, params: { phrase: "levy" } }, 3)).toBeNull();
  });

  it("dateIssued in query is invalid_request", async () => {
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "search",
      params: { collection: "CRPT", query: "levy AND dateIssued:range(2023-01-01,2023-12-31)" } }] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("date_from");
  });

  it("an unknown collection is invalid_request", async () => {
    const f = await fetchFail({ requests: [{ name: "x", endpoint: "search", params: { collection: "NOPE", text: "tax" } }] });
    expect(f.code).toBe("invalid_request");
  });

  it("a wildcard search is refused", async () => {
    const p = await checkSpec({ requests: [{ name: "s", endpoint: "search", params: { query: "title:tariff*", collection: "BILLS" } }] });
    expect(p.some((x) => x.includes("wildcard"))).toBe(true);
    expect(await checkSpec({ requests: [{ name: "s", endpoint: "search", params: { query: "title:tariff OR title:tariffs", collection: "BILLS" } }] }))
      .toEqual([]);
  });

  it("dates outside a closed collection", async () => {
    const p = await checkSpec({ requests: [{ name: "g", endpoint: "published", params: {
      collection: "GAOREPORTS", start_date: "2025-01-01", end_date: "2025-12-31" } }] });
    expect(p.some((x) => x.includes("covers 1989-2008"))).toBe(true);
    expect(await checkSpec({ requests: [{ name: "g", endpoint: "published", params: {
      collection: "GAOREPORTS", start_date: "2005-01-01", end_date: "2005-12-31" } }] })).toEqual([]);
    expect(await checkSpec({ requests: [{ name: "g", endpoint: "published", params: {
      collection: "GAOREPORTS", start_date: "1990-01-01", end_date: "1992-12-31" } }] })).toEqual([]);
  });

  it("writes a manual bundle", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec: SPEC }] });
    const items = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8")).items
      .map((i: any) => [i.filename, i]));
    expect(items["law_text.htm"].url).toBe("https://www.govinfo.gov/content/pkg/PLAW-118publ201/html/PLAW-118publ201.htm");
    expect(items["stablecoin_bills.json"].body.query).toContain("collection:BILLS");
  });

  it("sections", async () => {
    const s = newSession();
    await fetchOk(s, SRC, SECTIONS_SPEC);
    const secs = csv(s, SRC, "performance_act");
    expect(secs.length).toBe(8);
    expect(secs[0].identifier).toBe("/us/pl/118/190/s1");
    expect(secs[0].usc_classified).toBe("31 U.S.C. 1101");
    expect(secs[3].usc_amended).toBe("31 U.S.C. 1120(a)(2)");
    expect(secs[2].usc_amended).toBe("31 U.S.C. 1122");
    expect(secs.every((x, i) => x.num === String(i + 1))).toBe(true);
    expect(secs[1].text).toContain("REPORTING. (a)");
    const clinic = csv(s, SRC, "clinic_naming");
    expect(clinic.length).toBe(1);
    expect([clinic[0].usc_amended, clinic[0].usc_cited]).toEqual(["", ""]);
    expect(clinic[0].text.length).toBe(200);
  });

  it("an unmarked amending action counts as amended", () => {
    const xml = '<lawDoc xmlns="http://schemas.gpo.gov/xml/uslm"><main><section identifier="/us/pl/119/1/s3">' +
      '<num value="3">SEC. 3.</num><subsection><chapeau>Section 236 of the Act (<ref href="/us/usc/t8/s1226">' +
      "8 U.S.C. 1226</ref>), as amended by this Act, is further amended</chapeau></subsection>" +
      '<subsection><chapeau>See also <ref href="/us/usc/t8/s1101">8 U.S.C. 1101</ref>.</chapeau></subsection>' +
      "</section></main></lawDoc>";
    const row = G.uslmSections("PLAW-119publ1", xml)[0];
    expect([row.usc_amended, row.usc_cited]).toEqual(["8 U.S.C. 1226", "8 U.S.C. 1101"]);
    expect(G.htmlToText("<pre>(Vote No.\x00 7)</pre>")).toBe("(Vote No. 7)");
    expect(G.calls({ requests: [{ name: "x", endpoint: "text", params: { packageId: "C", granuleId: "G" } }] })).toBe(2);
  });

  it("a PDF-only placeholder is flagged", async () => {
    const cover = "[House Hearing]\n\nA SAMPLE HEARING TITLE\n\nHEARING BEFORE THE COMMITTEE\n\n";
    const stub = cover + "[TEXT NOT AVAILABLE REFER TO PDF]";
    const body = "Witness testimony on the sample topic. ".repeat(2000);
    expect(G.textStatus(stub, 120)).toBe("pdf_only");
    expect(G.textStatus(stub, "")).toBe("pdf_only");
    expect(G.textStatus(body + "[TEXT NOT AVAILABLE REFER TO PDF]" + body, 40)).toBe("partial_pdf");
    expect(G.textStatus(cover, 200)).toBe("near_empty");
    expect(G.textStatus(cover, 1)).toBe("full");
    expect(G.textStatus(body + "[GRAPHIC NOT AVAILABLE IN TIFF FORMAT]", 30)).toBe("full");
    const rows: Record<string, string> = { "HX-1": stub, "HX-2": body, "HX-3": cover };
    G.internals.fetchText = async (_p, req) => [G.textRow(String(req.params!.packageId), { pages: 150 }, rows[String(req.params!.packageId)], "link", null)];
    const spec = { requests: Object.keys(rows).map((pid, i) => ({ name: `hearing_text#${i}`, endpoint: "text", _group: "hearing_text",
      params: { packageId: pid } })) };
    const p = await load(SRC);
    const [tables, notes] = await p.adapter!.fetch!(spec, p, "api");
    expect(Object.values<any>(tables).map((t) => t[0].text_status)).toEqual(["pdf_only", "full", "near_empty"]);
    const bad = notes.filter((n) => n.includes("no usable text"));
    expect(bad.length).toBe(1);
    expect(bad[0].startsWith("hearing_text: incomplete: 2 of 3 rows")).toBe(true);
    expect(bad[0]).toContain("HX-1, HX-3");
    expect(bad[0]).toContain("pdf_url");
    expect((tables["hearing_text#0"] as any)[0].pdf_url).toBe("https://www.govinfo.gov/content/pkg/HX-1/pdf/HX-1.pdf");
  });

  it("sections without USLM", async () => {
    const p = await checkSpec({ requests: [{ name: "b", endpoint: "sections", params: { packageId: "BILLS-118hr4763eh" } }] });
    expect(p.some((x) => x.includes("use endpoint text"))).toBe(true);
    const f = await fetchFail({ requests: [{ name: "old_law", endpoint: "sections", params: { packageId: "PLAW-112publ1" } }] });
    expect(f.message).toContain("113th Congress");
  });

  it("sections from an upload", async () => {
    const p = await load(SRC);
    const req = { name: "u", endpoint: "sections", params: { packageId: "PLAW-118publ200" } };
    const rows = await p.adapter!.parseUpload!(p, req, [path.join(TEST_DIR, "packs", SRC, "fixtures", "r008.xml")]);
    expect(rows[0].identifier).toBe("/us/pl/118/200/s1");
    expect(G.uscCite("/us/usc/t16/s666c–1/p")).toBe("16 U.S.C. 666c–1(p)");
    expect(G.uscCite("/us/usc/t31/ch11")).toBe("31 U.S.C. ch. 11");
  });

  it("the published end date is inclusive", async () => {
    const a = (await load(SRC)).adapter!;
    const p: any = a.beforeRequest!({ name: "x" }, { path: "/published/{start_date}/{end_date}" },
      { start_date: "2025-01-01", end_date: "2025-12-31", collection: "FR" });
    expect(p.end_date).toBe("2026-01-01");
    expect(a.beforeRequest!({ name: "x" }, { path: "/packages/{packageId}/summary" }, { x: 1 })).toEqual({ x: 1 });
  });
});
