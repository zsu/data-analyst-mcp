/** congress: ported from tests/sources/congress/test_congress.py (same fixtures, same values). */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { DataError } from "../../src/core/http.js";
import { load } from "../../src/core/packs.js";
import { readJson } from "../../src/core/policy.js";
import { pyUrlencode } from "../../src/core/py.js";
import * as T from "../../src/tools.js";
import * as C from "../../src/adapters/congress.js";
import { fromstring } from "../../src/adapters/_govinfo_xml.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare, TEST_DIR } from "../helpers.js";

beforeAll(() => isolate());

const SRC = "congress";
const FIX = path.join(TEST_DIR, "packs", SRC, "fixtures");
const B = { congress: 119, billType: "s", billNumber: 5 };
const SPEC = { description: "Laken Riley Act (119th S. 5): bill, cosponsors and every recorded vote; one House and one " +
  "Senate roll call; a 1989 Senate vote list; cost-estimate links for H.R. 5376 (117th); recent CRS reports; Maryland " +
  "members of the 118th Congress",
  requests: [
    { name: "s5_bill", endpoint: "bill", params: B },
    { name: "s5_cosponsors", endpoint: "bill_cosponsors", params: B },
    { name: "s5_votes", endpoint: "bill_votes", params: B },
    { name: "ira_senate_passage", endpoint: "roll_call", params: { chamber: "senate", congress: 117, session: 2, roll: 325 } },
    { name: "ira_house_passage", endpoint: "roll_call", params: { chamber: "house", year: 2022, roll: 420 } },
    { name: "senate_votes_1989", endpoint: "senate_votes", params: { congress: 101, session: 1 } },
    { name: "hr5376_cost_estimates", endpoint: "bill_cbo_estimates", params: { congress: 117, billType: "hr", billNumber: 5376 } },
    { name: "crs_recent", endpoint: "crs_reports", max_rows: 5 },
    { name: "md_members_118", endpoint: "members_state", params: { congress: 118, stateCode: "MD", currentMember: "false" } }] };

const saved = { ...C.internals };
afterEach(() => Object.assign(C.internals, saved));

async function ingest(spec: any, file: string) {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  const r: any = await T.ingest(s, { source: SRC, spec, files: [file] });
  return [s, r] as const;
}

describe("congress", () => {
  it("fetches keyless by the api route", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.summary.route).toBe("api");
    expect(csv(s, SRC, "s5_bill")[0]["latestAction.text"]).toBe("Became Public Law No: 119-1.");
    const cos = csv(s, SRC, "s5_cosponsors");
    expect(cos.length).toBe(53);
    expect(cos[0]).toHaveProperty("party");
    const votes = Object.fromEntries(csv(s, SRC, "s5_votes").map((v) => [`${v.chamber}/${v.roll}`, v]));
    expect(Object.keys(votes).length).toBe(5);
    const house = votes["house/23"];
    expect([house.yea, house.nay, house.yea_D, house.yea_R]).toEqual(["263", "156", "46", "217"]);
    const passage = votes["senate/7"];
    expect([passage.yea, passage.nay, passage.yea_D, passage.nay_R]).toEqual(["64", "35", "12", "0"]);
    const sen = csv(s, SRC, "ira_senate_passage");
    expect(sen.length).toBe(100);
    expect(sen.filter((m) => m.position === "yea").length).toBe(50);
    expect(sen[0].date).toBe("2022-08-07");
    const hou = csv(s, SRC, "ira_house_passage");
    expect(hou.filter((m) => m.position === "yea" && m.party === "D").length).toBe(220);
    expect(hou[0].member_id).toBe("A000370");
    const menu = csv(s, SRC, "senate_votes_1989");
    expect(menu.length).toBe(312);
    expect(menu[0].date).toBe("1989-11-21");
    expect(csv(s, SRC, "hr5376_cost_estimates").every((c) => c.url.startsWith("https://www.cbo.gov/"))).toBe(true);
    expect(csv(s, SRC, "crs_recent").length).toBe(5);
    expect(new Set(csv(s, SRC, "md_members_118").map((m) => m.state))).toEqual(new Set(["Maryland"]));
  });

  it("current congress, ordinals and session years", () => {
    expect(C.currentCongress([2025, 1, 2])).toBe(118);
    expect(C.currentCongress([2025, 1, 3])).toBe(119);
    expect(C.currentCongress([2026, 12, 31])).toBe(119);
    expect(C.currentCongress([2027, 1, 3])).toBe(120);
    expect(C.currentCongress([1933, 3, 3])).toBe(72);
    expect(C.ordinal(121)).toBe("121st");
    expect(C.ordinal(112)).toBe("112th");
    expect(C.sessionYear(117, 2)).toBe(2022);
  });

  it("a + in sort is sent as a space", async () => {
    const p = await load(SRC);
    const a = p.adapter!;
    const eps = readJson(p.dir, "endpoints.json").endpoints;
    const prm = a.beforeRequest!({ name: "x" }, eps.bills_congress, { congress: 116, sort: "updateDate+asc" }) as any;
    const [pth, query] = gr.split(eps.bills_congress, prm);
    expect(pth).toBe("/bill/116");
    expect(pyUrlencode(query)).toContain("sort=updateDate+asc");
    expect(eps.bills.params.sort.enum).toContain("introducedDate+desc");
    const cb = eps.committee_bills_congress;
    const [pth2] = gr.split(cb, a.beforeRequest!({ name: "x" }, cb, { congress: 116, chamber: "senate", committeeCode: "ssfi00" }) as any);
    expect(pth2).toBe("/committee/116/senate/ssfi00/bills");
  });

  it("title_contains matches the phrase as given", async () => {
    const m = C.titleMatcher("water rights")!;
    expect(m("Tribal Water Rights Settlement Act")).toBe(true);
    expect(m("A bill on water-rights adjudication")).toBe(true);
    expect(m("Rights of Water Users Act")).toBe(false);
    expect(m("Freshwater Rights Act")).toBe(false);
    expect(m("Waters Rightsholders Act")).toBe(true);
    expect(C.titleMatcher("port")!("Rural Support Act")).toBe(false);
    expect(C.titleMatcher("veteran")!("Veterans Housing Act")).toBe(true);
    const many = C.titleMatcher(["levy", "levies"])!;
    expect(many("Special Levies Act") && many("Levy Relief Act")).toBe(true);
    expect(C.titleMatcher("  ")).toBeNull();
    const rows = [{ title: "Port Infrastructure Act" }, { title: "Passport Fee Act" }];
    const a = (await load(SRC)).adapter!;
    expect(a.normalize!({ name: "x", params: { title_contains: "port" } }, {}, rows)).toEqual(rows.slice(0, 1));
  });

  it("a multi-word title phrase that keeps nothing explains word order", async () => {
    expect(C.phraseOrderHint({ name: "x", params: { title_contains: "harbor" } })).toBeNull();
    const h = C.phraseOrderHint({ name: "x", params: { title_contains: ["harbor", "dredging permits"] } })!;
    expect(h).toContain("'dredging permits'");
    expect(h).toContain("in that order");
    expect(h).toContain("list each form");
    const p = await load(SRC);
    const r = { name: "b", endpoint: "bills", params: { title_contains: "dredging permits" } };
    C.internals.fetchSpec = async () => {
      throw new DataError("request(s) 'b' returned no rows: check the filter values", "bad_request");
    };
    let err: any = null;
    try {
      await p.adapter!.fetch!({ requests: [r] }, p, "api");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DataError);
    expect(err.message).toContain("in that order");
    C.internals.fetchSpec = async () => [{ b: [] }, []];
    const [, notes] = await p.adapter!.fetch!({ requests: [{ ...r, allow_empty: true }] }, p, "api");
    expect(notes.some((n) => n.includes("no titles matched") && n.includes("in that order"))).toBe(true);
  });

  it("title_contains says display titles only and gives the title search", async () => {
    const p = await load(SRC);
    const rows = [{ title: "Harbor Dredging Act", number: "12", type: "HR" }];
    const spec = { requests: [{ name: "b", endpoint: "bills_congress", params: { congress: 118, title_contains: "harbor dredging" } },
      { name: "plain", endpoint: "bills_congress", params: { congress: 118 } }] };
    C.internals.fetchSpec = async (_p, sp) => [{ [sp.requests[0].name]: rows }, []];
    const [, notes] = await p.adapter!.fetch!(spec, p, "api");
    expect(notes.length).toBe(1);
    const n = notes[0];
    expect(n.startsWith("b: title_contains matched the list's display title only")).toBe(true);
    expect(n).toContain('{"collection": "BILLS", "congress": 118, "title": "harbor dredging"}');
    expect(n).toContain("bill_titles");
    expect(n).toContain("missing");
    const law = C.displayTitleNote({ name: "l", endpoint: "laws", params: { congress: "current", title_contains: ["levy", "levies"] } })!;
    expect(law).toContain('"collection": "PLAW", "congress": <the Congress number>, "title": "levies"');
    expect(C.displayTitleNote({ name: "c", endpoint: "crs_reports", params: { title_contains: "harbor" } })).toBeNull();
  });

  it("a Senate roll_call needs a session", async () => {
    const bad = { requests: [{ name: "x", endpoint: "roll_call", params: { chamber: "senate", roll: 5 } }] };
    const s = newSession();
    fixtures(SRC);
    await prepare(s, SRC, bad);
    expect((await failure(T.fetchData(s, { source: SRC, spec: bad }))).code).toBe("invalid_request");
  });

  it("a refused Senate host is found by the probe", async () => {
    C.internals.client = (() => ({
      async get() {
        throw new DataError("senate-lis: HTTP 403 from www.senate.gov: the host refused", "blocked");
      },
    })) as any;
    const senate = { requests: [{ name: "v", endpoint: "bill_votes", params: { congress: 119, billType: "hr", billNumber: 1 } }] };
    const house = { requests: [{ name: "v", endpoint: "bill_votes", params: { congress: 119, billType: "hr", billNumber: 1, chamber: "house" } }] };
    expect(await C.refusedHostsProbe(senate)).toContain("chamber");
    expect(await C.refusedHostsProbe(house)).toBe("");
  });

  it("writes a manual bundle", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec: SPEC }] });
    const items = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8")).items
      .map((i: any) => [i.filename, i]));
    expect(items["ira_house_passage.xml"].url).toBe("https://clerk.house.gov/evs/2022/roll420.xml");
    expect(items["ira_house_passage.xml"].needs_key).toBe(false);
    expect(items["s5_bill.json"].url).toContain("api_key=DEMO_KEY");
    expect(Object.values<any>(items).every((i) => i.url.split("api_key=").length - 1 <= 1)).toBe(true);
  });

  it("ingests a roll-call XML", async () => {
    const [s] = await ingest({ requests: [SPEC.requests[3]] }, path.join(FIX, "r009.xml"));
    expect(csv(s, SRC, "ira_senate_passage").length).toBe(100);
  });

  it("a roll_call summary row", async () => {
    const req = { name: "h", endpoint: "roll_call", params: { chamber: "house", year: 2022, roll: 420, summary: "true" } };
    const [s] = await ingest({ requests: [req] }, path.join(FIX, "r008.xml"));
    const rows = csv(s, SRC, "h");
    expect(rows.length).toBe(1);
    expect([rows[0].question, rows[0].chamber]).toEqual(["On Passage", "house"]);
  });

  it("an en bloc Senate menu vote", () => {
    const xml = "<vote_summary><congress>119</congress><session>1</session><congress_year>2025</congress_year><votes>" +
      "<vote><vote_number>00655</vote_number><vote_date>18-Dec</vote_date><en_bloc>" +
      "<matter><issue>PN416-9</issue><question>On the Nomination</question><result>Confirmed</result></matter>" +
      "<matter><issue>PN141-12</issue><question>On the Nomination</question><result>Confirmed</result></matter>" +
      "</en_bloc><vote_tally><yeas>53</yeas><nays>43</nays></vote_tally><title>En bloc</title></vote>" +
      "<vote><vote_number>00656</vote_number><vote_date>18-Dec</vote_date><issue>PN499-11</issue>" +
      "<question>On the Cloture Motion\n </question><result>Agreed to</result>" +
      "<vote_tally><yeas>53</yeas><nays>43</nays></vote_tally><title>Cloture</title></vote></votes></vote_summary>";
    const rows = C.parseSenateMenu(fromstring(xml), "menu.xml");
    expect([rows[0].issue, rows[0].question, rows[0].result, rows[0].en_bloc]).toEqual(["PN416-9; PN141-12", "On the Nomination", "Confirmed", "2"]);
    expect([rows[1].question, rows[1].en_bloc]).toEqual(["On the Cloture Motion", ""]);
  });
});
