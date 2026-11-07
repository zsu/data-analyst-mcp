/** doj-news: ported from tests/sources/doj-news/test_doj_news.py (same fixtures, same values). */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { iso, ts } from "../../src/adapters/doj-news.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const SRC = "doj-news";
const SPEC = { description: "DOJ press releases with fentanyl in the title on 2 June 2025; one release in full; blog entries since 2025",
  requests: [
    { name: "fentanyl_june_2025", endpoint: "press_releases", params: { "parameters[title]": '"fentanyl"', "parameters[date]": "2025-06-02" } },
    { name: "one_release", endpoint: "press_release",
      params: { uuid: "2715a413-eb10-4d71-b4fd-9fd3e3eb0c0a", fields: "uuid,title,date,component,topic,url,body" } },
    { name: "blog_since", endpoint: "blog_entries", params: { since: "2025-01-01" }, max_rows: 3 }] };

async function check(spec: any): Promise<any> {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  return failure(T.fetchData(s, { source: SRC, spec }));
}

describe("doj-news", () => {
  it("fetches by the api route", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.summary.route).toBe("api");
    const rel = csv(s, SRC, "fentanyl_june_2025");
    expect(rel.length).toBe(7);
    expect(rel.every((x) => x.date_iso === "2025-06-02")).toBe(true);
    expect(rel.every((x) => x.title.toLowerCase().includes("fentanyl"))).toBe(true);
    expect(rel[0].date).toBe("1748865600");                 // published Unix timestamp kept
    expect(rel.some((x) => x.component_names.includes("USAO - Florida, Middle"))).toBe(true);
    expect(rel[0]).not.toHaveProperty("created");            // added only to page by: not kept
    const one = csv(s, SRC, "one_release")[0];
    expect(one.title).toBe("Bluefield Woman Pleads Guilty to COVID-19 Relief Fraud Scheme");
    expect(one.body_text).not.toContain("<p>");
    expect(one.body_text).toContain("April Elick");
    const blog = csv(s, SRC, "blog_since");
    expect(blog.length).toBe(3);
    expect(blog.every((b) => b.date_iso >= "2025-01-01")).toBe(true);
    expect(r.notes.some((n: string) => n.includes("max_rows") && n.includes("posting time"))).toBe(true);
    expect(r.notes.some((n: string) => n.includes("2013-01-01"))).toBe(false);   // 2025 rows: no coverage note
  });

  it("pre-2013 rows get the coverage note", async () => {
    const old = { description: "Releases with 'sentenced' in the title on 26 November 2012",
      requests: [{ name: "sentenced_2012_11_26", endpoint: "press_releases",
        params: { "parameters[title]": "sentenced", "parameters[date]": "2012-11-26" } }] };
    const s = newSession();
    const r = await fetchOk(s, SRC, old);
    const rows = csv(s, SRC, "sentenced_2012_11_26");
    expect(rows.length && rows.every((x) => x.date_iso < "2013-01-01")).toBeTruthy();
    expect(rows.some((x) => x.component_names.includes("USAO"))).toBe(false);
    expect(r.notes.some((n: string) => n.includes("2013-01-01") && n.includes("not comparable"))).toBe(true);
  });

  it("created/changed time tags and entities", async () => {
    const spec = { description: "Releases with 'Office' in the title on 14 March 2024, with web-publishing times",
      requests: [{ name: "office_2024_03_14", endpoint: "press_releases", params: { "parameters[title]": "Office",
        "parameters[date]": "2024-03-14", fields: "uuid,title,date,created,changed,component,topic,url" } }] };
    const s = newSession();
    await fetchOk(s, SRC, spec);
    const rows = csv(s, SRC, "office_2024_03_14");
    expect(rows.length).toBe(8);
    expect(rows.every((x) => x.created.startsWith("<time"))).toBe(true);
    expect(rows.every((x) => x.created_iso && x.changed_iso)).toBe(true);
    expect(rows.every((x) => x.changed_iso >= x.created_iso && x.created_iso >= "2024-03-14")).toBe(true);
    expect(rows.some((x) => x.changed_iso > "2024-03-14")).toBe(true);
    expect(rows.some((x) => x.title.includes("&#"))).toBe(false);
    expect(rows.some((x) => x.title.includes("Attorney's Office"))).toBe(true);
  });

  it("normalize reads every time format", async () => {
    const ad = (await load(SRC)).adapter!;
    const rows = [{ title: "Smith &amp; Sons&#039; Owner Sentenced", date: "1504152000",
      created: '<time datetime="2017-08-31T22:15:00-04:00">1504232100</time>\n', changed: "1504232100",
      component: [{ name: "Office of Justice Programs &amp; Grants" }], topic: "" }];
    const out: any = ad.normalize!({ name: "x", params: {} }, {}, rows)[0];
    expect(out.title).toBe("Smith & Sons' Owner Sentenced");
    expect(out.date_iso).toBe("2017-08-31");
    expect(out.created_iso).toBe("2017-08-31");    // the attribute's (Eastern) day, not UTC 09-01
    expect(out.changed_iso).toBe("2017-09-01");    // bare digits: UTC day
    expect(out.component_names).toBe("Office of Justice Programs & Grants");
    expect(iso("<time>1504232100</time>")).toBe("2017-09-01");
    expect(iso('<time datetime="">n/a</time>')).toBe("");
  });

  it("date order pages by created and drops repeats", async () => {
    const p = await load(SRC);
    const day = 86400, base = 1700000000;
    const recs = Array.from({ length: 160 }, (_, i) => ({ uuid: `u${i}`, title: `t${i}`, date: String(base - Math.floor(i / 2) * day),
      created: `<time datetime="x">${base - Math.floor(i / 2) * day + 3600 * (1 + (i % 2))}</time>` }));
    recs.sort((a, b) => ts(b.created) - ts(a.created));
    const sent: any[] = [];
    const client: any = {
      async request(_m: string, _p: string, q: any) {
        sent.push({ ...q });
        const pg = q.page, n = q.pagesize;
        let page = recs.slice(pg * n, (pg + 1) * n);
        if (pg === 1) page = [recs[n - 1], ...page.slice(0, -1)];    // one release repeated at a page boundary
        const d = { results: page, metadata: { resultset: { count: recs.length } } };
        return { json: () => JSON.parse(JSON.stringify(d)) };
      },
    };
    const spec = { requests: [{ name: "r", endpoint: "press_releases", params: { since: "2023-10-05", fields: "uuid,title,date" } }] };
    const [tables, notes] = await (p.adapter!.fetch as any)(spec, p, "api", client);
    expect(sent.every((q) => q.sort === "created" && q.fields.includes("created"))).toBe(true);
    const rows = tables.r;
    expect(new Set(rows.map((x: any) => x.uuid)).size).toBe(rows.length);
    expect(rows.length && rows.every((x: any) => x.date_iso >= "2023-10-05")).toBeTruthy();
    const dates = rows.map((x: any) => x.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(rows[0]).not.toHaveProperty("created");
    expect(notes.some((n: string) => n.includes("came back twice"))).toBe(true);
    expect(sent.length).toBe(3);      // page 2 lies past `since`, within the margin: read for early postings
  });

  it("a bad since is invalid_request", async () => {
    expect((await check({ requests: [{ name: "x", endpoint: "press_releases", params: { since: "June 2025" } }] })).code)
      .toBe("invalid_request");
  });

  it("since needs newest first", async () => {
    expect((await check({ requests: [{ name: "x", endpoint: "press_releases", params: { since: "2025-01-01", direction: "ASC" } }] })).code)
      .toBe("invalid_request");
  });

  it("the manual bundle drops pack options", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: SRC, spec: SPEC }] });
    const items = JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8")).items;
    const blog = items.filter((i: any) => i.name.startsWith("blog_since"));
    expect(blog.length).toBeGreaterThan(0);
    expect(blog[0].url).not.toContain("since=");
    expect(blog[0].url).toContain("page=0");
    expect(blog[0].note).toContain("ingested");
  });
});
