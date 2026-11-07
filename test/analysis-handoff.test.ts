/**
 * The data hand-off: a port of tests/test_handoff.py (TestHandoff). TestCheckRecords is not
 * ported: it tests fetch.py's --check records, which this server replaces with the fetch gate (test/gate.test.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as handoff from "../src/analysis/handoff.js";
import { TOOLS } from "../src/analysis/tools.js";
import { write } from "../src/core/package.js";
import { load } from "../src/core/packs.js";
import { isolate, newSession } from "./helpers.js";

beforeAll(() => isolate());

function writeCsv(p: string, rows: Record<string, unknown>[]): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(p, [cols.join(","), ...rows.map((r) => cols.map((c) => String(r[c])).join(","))].join("\r\n") + "\r\n");
}

function writeJson(p: string, v: unknown): void {
  fs.writeFileSync(p, JSON.stringify(v));
}

describe("handoff", () => {
  it("summary reads the provenance", async () => {
    const s = newSession();
    const out = s.workspace;
    const rows = Array.from({ length: 10 }, (_, i) => 2001 + i).map((y) => ({ region: "North", year: y, units: "tons", amount: 10 + (y % 7) }));
    writeCsv(path.join(out, "data", "noaa", "storms.csv"), rows);
    writeJson(path.join(out, "data", "noaa", "request.json"), { route: "api", retrieved: "2026-03-04T15:00:00+00:00",
      tables: [{ name: "storms", file: "storms.csv", rows: 10 }], notes: ["storms: stopped at 10 rows"], problems: [] });
    writeCsv(path.join(out, "data", "loose", "x.csv"), [{ a: "1" }]);             // copied in by hand
    writeCsv(path.join(out, "published", "table.csv"),
      [{ measure: "m", value: "3", source_url: "https://agency.example/t", accessed: "2026-03-01" }]);
    const res: any = TOOLS.find((t) => t.name === "handoff")!.handler(s, {});
    expect(res.status).toBe("ok");
    const r = { ...res.summary, text: res.text };
    const noaa = r.sources.find((x: any) => x.source === "noaa");
    expect([noaa.route, noaa.retrieved]).toEqual(["api", "2026-03-04"]);
    expect(noaa.files[0].rows).toBe(10);
    const pv = noaa.files[0].preview;
    expect(pv.header).toEqual(["year", "amount"]);                                // the columns that vary come first
    expect(pv.rows.length).toBe(handoff.PREVIEW_ROWS);
    expect(pv.same).toContainEqual(["region", "North"]);
    expect(r.text).toContain("### noaa");
    expect(r.text).toContain("Route: api; retrieved 2026-03-04");
    expect(r.text).toContain("stopped at 10 rows");
    expect(r.unpackaged).toEqual(["loose"]);                                      // no request.json: said, not hidden
    expect(r.text).toContain("https://agency.example/t");
  });

  it("notes are never dropped silently", () => {
    const out = newSession().workspace;
    writeCsv(path.join(out, "data", "cdc", "t.csv"), [{ a: "1" }]);
    const notes = [...Array.from({ length: 10 }, (_, i) => `t: plain note ${i}`), "t: 12 rows may be missing across pages"];
    writeJson(path.join(out, "data", "cdc", "request.json"), { route: "api", retrieved: "2026-01-02", tables: [{ file: "t.csv" }], notes });
    const r = handoff.summarize(out);
    expect(r.text).toContain("rows may be missing");                             // a caveat is always shown
    expect(r.text).toContain("plain note 5");
    expect(r.text).not.toContain("plain note 6");
    expect(r.text).toContain("(+4 more notes in data/cdc/request.json)");
  });

  it("the more-notes pointer names the file read", () => {
    const out = newSession().workspace;
    writeCsv(path.join(out, "data", "usps", "t.csv"), [{ a: "1" }]);
    writeJson(path.join(out, "data", "usps", "fetch_spec.json"), { route: "api", retrieved: "2026-01-02", tables: [{ file: "t.csv" }],
      notes: Array.from({ length: 9 }, (_, i) => `t: plain note ${i}`) });
    expect(handoff.summarize(out).text).toContain("(+3 more notes in data/usps/fetch_spec.json)");
  });

  it("microdata gets no preview", () => {
    const out = newSession().workspace;
    writeCsv(path.join(out, "data", "ipums", "extract.csv"), [{ SERIAL: "1", AGE: "40" }]);
    writeJson(path.join(out, "data", "ipums", "request.json"), { route: "api", retrieved: "2026-01-02", tables: [{ file: "extract.csv" }] });
    const r = handoff.summarize(out);
    expect((r.sources[0] as any).files[0].preview).toBeNull();
    expect(r.text).toContain("Microdata: no preview");
  });

  it("tables of an earlier fetch are listed", async () => {
    // a second spec fetched into the same folder must not hide the first spec's tables from the hand-off
    const pack = await load("congress");
    const out = newSession().workspace;
    write(out, pack, { acts: [{ number: "1" }, { number: "2" }], votes: [{ n: "1" }] },
      { requests: [{ name: "acts", endpoint: "laws" }, { name: "votes", endpoint: "laws" }] }, { route: "api", notes: ["acts: an earlier note"] });
    write(out, pack, { bill_1: [{ sponsor: "A" }] }, { requests: [{ name: "bill_1", endpoint: "bill" }] },
      { route: "api", notes: ["bill_1: a new note"] });
    const r = handoff.summarize(out);
    const s: any = r.sources.find((x) => x.source === "congress");
    expect(s.files.map((f: any) => f.file)).toEqual(["data/congress/bill_1.csv", "data/congress/acts.csv", "data/congress/votes.csv"]);
    expect(s.files[1].rows).toBe(2);
    expect(s.files[1].earlier).toBeTruthy();
    expect(r.text).toContain("`data/congress/acts.csv`: 2 rows (earlier fetch: route api");
    expect(r.text).toContain("(earlier fetch, table still in the folder) acts: an earlier note");
    expect(r.text).toContain("bill_1: a new note");
  });
});
