/** nih: ported from tests/sources/nih/test_nih.py (same fixtures, same values). */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import { readJson } from "../../src/core/policy.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const SRC = "nih";
const SPEC = { description: "NCI breast cancer projects at Vermont organizations, FY2024; opioid (RCDC) projects in Vermont, FY2024; publications of one project",
  requests: [
    { name: "vt_nci_breast_2024", endpoint: "projects",
      params: { fiscal_years: [2024], org_states: ["VT"], agencies: ["NCI"], text: "breast cancer" } },
    { name: "vt_opioids_2024", endpoint: "projects",
      params: { fiscal_years: [2024], org_states: ["VT"], spending_categories: ["Opioids"],
        include_fields: ["ApplId", "CoreProjectNum", "FiscalYear", "ProjectTitle", "AwardAmount", "AgencyIcAdmin"] } },
    { name: "pubs_r01ca282725", endpoint: "publications", params: { core_project_nums: ["R01CA282725"] } }] };

async function check(spec: any): Promise<any> {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  return failure(T.fetchData(s, { source: SRC, spec }));
}

/** A response object as fetchRequest reads it. */
function resp(d: unknown) {
  const body = Buffer.from(JSON.stringify(d));
  return { status: 200, body, text: () => body.toString("utf8"), json: () => JSON.parse(body.toString("utf8")) };
}

async function pack() {
  return load(SRC);
}

describe("nih", () => {
  it("fetches by the api route", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api");
    const rows = csv(s, SRC, "vt_nci_breast_2024");
    expect(rows.length).toBe(7);
    const first = rows.filter((x) => x.appl_id === "10931667")[0];
    expect(first.award_amount).toBe("686647");
    expect(first["organization.org_state"]).toBe("VT");
    expect(first.subproject_id).toBe("");             // exclude_subprojects defaults to true
    const op = csv(s, SRC, "vt_opioids_2024");
    expect(op.length).toBe(3);
    expect(op.map((x) => x.core_project_num)).toContain("R01DA057308");
    expect(csv(s, SRC, "pubs_r01ca282725").map((p) => p.pmid)).toContain("39270543");
    expect(r.notes.some((x: string) => x.includes("every word anywhere"))).toBe(true);   // two-word text gets the note
  });

  it("project searches page in a stable order", async () => {
    const a = (await pack()).adapter!;
    const eps = readJson((await pack()).dir, "endpoints.json").endpoints;
    let body: any = a.beforeRequest!({ name: "x" }, eps.projects, { fiscal_years: [2023], agencies: ["NIA"] });
    expect([body.sort_field, body.sort_order]).toEqual(["appl_id", "asc"]);
    body = a.beforeRequest!({ name: "x" }, eps.projects, { fiscal_years: [2023], sort_field: "award_amount", sort_order: "desc" });
    expect([body.sort_field, body.sort_order]).toEqual(["award_amount", "desc"]);
    expect(a.beforeRequest!({ name: "x" }, eps.publications, { pmids: [1] })).not.toHaveProperty("sort_field");
    expect(eps.projects.unique_key).toBe("appl_id");
    expect(a.beforeRequest!({ name: "x", max_rows: 50 }, eps.projects, { text: "asthma" })).not.toHaveProperty("sort_field");
    expect(a.beforeRequest!({ name: "x", max_rows: 2000 }, eps.projects, { text: "asthma" })).toHaveProperty("sort_field");
  });

  it("the appl_id cut note only when the pack sorted", async () => {
    const p = await pack();
    const fake: any = {
      name: "nih",
      async request(_m: string, _p: string, _q: unknown, o: any) {
        const { offset: off, limit: lim } = o.jsonBody;
        const n = Math.max(0, Math.min(lim, 3000 - off));
        return resp({ meta: { total: 3000 }, results: Array.from({ length: n }, (_, i) => ({ appl_id: 100000 + off + i, fiscal_year: 2022 })) });
      },
    };
    const notesFor = async (maxRows: number, extra: Record<string, unknown> = {}) => {
      const req = { name: "p", endpoint: "projects", max_rows: maxRows, params: { fiscal_years: [2022], text: "sleep apnea", ...extra } };
      const [, notes] = await gr.fetchSpec(p, { requests: [req] }, fake);
      return notes.filter((n) => n.includes("stopped at"));
    };
    const small = await notesFor(40);
    expect(small.length && !small[0].includes("lowest appl_id")).toBeTruthy();
    const paged = await notesFor(1200);
    expect(paged.length && paged[0].includes("lowest appl_id")).toBeTruthy();
    const chosen = await notesFor(1200, { sort_field: "award_amount", sort_order: "desc" });
    expect(chosen.length && !chosen[0].includes("lowest appl_id")).toBeTruthy();
  });

  it("phrase vs every word", async () => {
    const p = await pack();
    const a = p.adapter!;
    const ep = p.endpoints.endpoints.projects;
    let crit: any = (a.beforeRequest!({ name: "x", max_rows: 10 }, ep, { phrase: "night shift work" }) as any).criteria;
    expect(crit.advanced_text_search.operator).toBe("advanced");
    expect(crit.advanced_text_search.search_text).toBe('"night shift work"');
    crit = (a.beforeRequest!({ name: "x", max_rows: 10 }, ep, { phrase: ["heat stroke", 'sun "stroke"'] }) as any).criteria;
    expect(crit.advanced_text_search.search_text).toBe('"heat stroke" OR "sun  stroke"');
    crit = (a.beforeRequest!({ name: "x", max_rows: 10 }, ep, { text: "night shift" }) as any).criteria;
    expect(crit.advanced_text_search.operator).toBe("and");
    expect(a.requestNote!({ name: "x", params: { text: "night shift" } }, ep, {})).toContain("every word anywhere");
    expect(a.requestNote!({ name: "x", params: { phrase: "night shift" } }, ep, {})).toContain("phrase");
    expect(a.requestNote!({ name: "x", params: { text: "insomnia" } }, ep, {})).toBeNull();
    const f = await check({ requests: [{ name: "x", endpoint: "projects", params: { fiscal_years: [2024], text: "a b", phrase: "a b" } }] });
    expect(f.code).toBe("invalid_request");
  });

  it("no criteria is invalid_request", async () => {
    expect((await check({ requests: [{ name: "all", endpoint: "projects", params: {} }] })).code).toBe("invalid_request");
  });

  it("an unknown RCDC category is invalid_request, with the close names", async () => {
    const f = await check({ requests: [{ name: "x", endpoint: "projects", params: { fiscal_years: [2024], spending_categories: ["Cancr"] } }] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("Cancer");
  });

  it("search finds RCDC categories", async () => {
    const r: any = await T.requestSchema(newSession(), { source: SRC, search: "alzheimer" });
    expect(r.results.some((h: any) => h.id === 40)).toBe(true);
  });

  it("publications paging never asks past offset 9999", async () => {
    const ep = readJson((await pack()).dir, "endpoints.json").endpoints.publications;
    const asked: [number, number][] = [];
    const fake: any = {
      async request(_m: string, _p: string, _q: unknown, o: any) {
        const { offset: off, limit: lim } = o.jsonBody;
        asked.push([off, lim]);
        if (off > 9999 || lim > 500) throw new Error(`asked offset=${off} limit=${lim}`);
        const n = Math.max(0, Math.min(lim, 25000 - off));
        return resp({ meta: { total: 25000 }, results: Array.from({ length: n }, (_, i) => ({ coreproject: "X", pmid: off + i, applid: 1 })) });
      },
    };
    const [rows, meta] = await gr.fetchRequest(fake, ep, { criteria: { core_project_nums: ["X"] } }, null);
    expect(rows.length).toBe(10000);
    expect(meta.truncated).toBe(true);
    expect(Math.max(...asked.map(([o]) => o))).toBe(9500);
    const f = await check({ requests: [{ name: "p", endpoint: "publications", max_rows: 12000, params: { pmids: [1] } }] });
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("10,000");
  });

  it("the manual bundle is POST", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec: SPEC }] });
    const items = JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8")).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i: any) => i.method === "POST" && "criteria" in i.body)).toBe(true);
  });
});
