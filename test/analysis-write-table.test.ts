/** write_table (the method tables the audits require) and how rerun treats them; record_decisions' asked flag. */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { rerunWorkspace } from "../src/analysis/rerun.js";
import { writeTable } from "../src/analysis/write_table.js";
import { isolate, newSession } from "./helpers.js";

beforeAll(() => isolate());

describe("write_table", () => {
  it("writes a benchmark table that rerun accepts until it is edited", async () => {
    const s = newSession();
    writeTable(s.workspace, { path: "exhibits/benchmark.csv",
      columns: ["measure", "period", "computed", "published", "source", "url", "accessed", "match", "note"],
      rows: [["deaths", "2017", 155358, 155358, "CDC", "https://www.cdc.gov/x", "2026-11-07", "yes", ""]] });
    let r = await rerunWorkspace(s.workspace);
    expect(r.exhibits["exhibits/benchmark.csv"].same).toBe(true);
    fs.appendFileSync(path.join(s.workspace, "exhibits", "benchmark.csv"), "x,y,1,2,s,u,2026-01-01,no,\r\n");
    r = await rerunWorkspace(s.workspace);
    expect(r.exhibits["exhibits/benchmark.csv"].same).toBe(false);
  });

  it("refuses data exhibits, missing columns and published rows without their source", () => {
    const s = newSession();
    expect(() => writeTable(s.workspace, { path: "exhibits/exhibit_1.csv", columns: ["a"], rows: [] })).toThrow(/compute/);
    expect(() => writeTable(s.workspace, { path: "exhibits/sensitivity.csv", columns: ["parameter"], rows: [] })).toThrow(/needs the columns/);
    expect(() => writeTable(s.workspace, { path: "published/page.csv", columns: ["v", "source_url", "accessed"],
      rows: [["1", "not a url", "2026-11-07"]] })).toThrow(/source_url/);
    const ok = writeTable(s.workspace, { path: "published/page.csv", columns: ["v", "source_url", "accessed"],
      rows: [["1", "https://agency.gov/t", "2026-11-07"]] });
    expect(ok.rows).toBe(1);
  });
});

describe("record_decisions", () => {
  it("records a question not asked with asked: false, others with asked: true", () => {
    const s = newSession();
    s.recordDecisions({ questions: [{ id: "a", how: "not_asked", reason_code: "settled_by_request", request: "x" },
      { id: "b", how: "answered", answer: "y" }] });
    const q = Object.fromEntries(s.decisions().questions.map((x: any) => [x.id, x.asked]));
    expect(q).toEqual({ a: false, b: true });
  });
});
