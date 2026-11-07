/**
 * The combine helpers as compute verbs: a port of the Python skill's tests/test_combine.py (TestToFiscal,
 * TestAlignCheck). The tables are CSVs written into a session workspace, as pandas would save them.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { TOOLS } from "../src/analysis/tools.js";
import { readCsv } from "../src/core/tabular.js";
import type { Session } from "../src/session.js";
import { failure, isolate, newSession } from "./helpers.js";

beforeAll(() => isolate());

const compute = (s: Session, a: any) => TOOLS.find((t) => t.name === "compute")!.handler(s, a) as any;

function put(s: Session, rel: string, rows: Record<string, unknown>[]): string {
  const cols = Object.keys(rows[0]);
  const p = path.join(s.workspace, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [cols.join(","), ...rows.map((r) => cols.map((c) => String(r[c])).join(","))].join("\r\n") + "\r\n");
  return rel;
}

function toFiscal(s: Session, rel: string, o: Record<string, unknown> = {}) {
  const r = compute(s, { inputs: { d: rel }, save_as: "exhibits/fy.csv", steps: [{ to_fiscal: { date: "date", value: "v", ...o } }] });
  return { rows: readCsv(fs.readFileSync(path.join(s.workspace, "exhibits/fy.csv"), "utf8")) as Record<string, string>[], notes: r.notes as string[] };
}

const monthStarts = (y: number, m: number, n: number) => Array.from({ length: n }, (_, i) => {
  const k = m - 1 + i;
  return `${y + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}-01`;
});

describe("to_fiscal", () => {
  it("twelve rows of one month is not a full year", () => {
    const s = newSession();
    const rel = put(s, "data/t/m.csv", Array.from({ length: 12 }, (_, i) => ({ date: "2023-10-01", v: i })));
    const { rows, notes } = toFiscal(s, rel);
    expect(rows[0].periods).toBe("1");
    expect(rows[0].complete).toBe("False");
    expect(notes.join("\n")).toContain("to_fiscal: 1 period(s) have more than one row");
    expect(notes.join("\n")).toContain("to_fiscal: incomplete fiscal years kept but flagged: FY2024");
  });

  it("a full year, and the same year with a duplicated month", () => {
    const s = newSession();
    const months = monthStarts(2022, 10, 12).map((date) => ({ date, v: "1.0" }));
    let rel = put(s, "data/t/full.csv", months);
    const { rows } = toFiscal(s, rel);
    expect(rows).toEqual([{ fiscal_year: "2023", v: "12", periods: "12", complete: "True" }]);
    rel = put(s, "data/t/dup.csv", [...months, months[0]]);              // a second vintage of October
    expect(toFiscal(s, rel).rows[0].complete).toBe("False");
  });

  it("quarterly", () => {
    const s = newSession();
    const rel = put(s, "data/t/q.csv", ["2022-10-01", "2023-01-01", "2023-04-01", "2023-07-01"].map((date) => ({ date, v: 1.0 })));
    expect(toFiscal(s, rel, { freq: "Q" }).rows[0].complete).toBe("True");
  });

  it("means and last values, years in order", () => {
    const s = newSession();
    const rel = put(s, "data/t/r.csv", [...monthStarts(2023, 10, 12).map((date, i) => ({ date, v: i })),
      ...monthStarts(2022, 10, 12).map((date) => ({ date, v: 2 }))]);
    expect(toFiscal(s, rel, { how: "mean" }).rows.map((r) => [r.fiscal_year, r.v])).toEqual([["2023", "2"], ["2024", "5.5"]]);
    expect(toFiscal(s, rel, { how: "last" }).rows.map((r) => r.v)).toEqual(["2", "11"]);
  });
});

describe("align_check", () => {
  it("refuses repeated keys", async () => {
    const s = newSession();
    put(s, "data/a/a.csv", [{ year: 2020, x: 1 }, { year: 2020, x: 2 }]);
    put(s, "data/b/b.csv", [{ year: 2020, y: 3 }]);
    const f = await failure(() => compute(s, { inputs: { a: "data/a/a.csv", b: "data/b/b.csv" }, save_as: "exhibits/j.csv",
      steps: [{ align_check: { tables: ["a", "b"], on: ["year"], units: { a: "dollars", b: "dollars" } } }] }));
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("a has 1 repeated ['year'] key(s): aggregate or filter to one row per key first");
  });

  it("reports partial overlap and requires units", async () => {
    const s = newSession();
    put(s, "data/a/a.csv", [{ year: 2020, x: 1 }, { year: 2021, x: 2 }]);
    put(s, "data/b/b.csv", [{ year: 2021, y: 3 }, { year: 2022, y: 4 }]);
    const inputs = { a: "data/a/a.csv", b: "data/b/b.csv" };
    const r = compute(s, { inputs, save_as: "exhibits/j.csv", steps: [
      { align_check: { tables: ["a", "b"], on: ["year"], units: { a: "billions", b: "thousands of persons" } } },
      { join: "b", on: ["year"] }] });
    expect(r.notes.join("\n")).toContain("drop out");
    expect(r.notes).toContain("align_check: a: billions");
    expect(r.summary.rows).toBe(1);
    const f = await failure(() => compute(s, { inputs, save_as: "exhibits/j.csv",
      steps: [{ align_check: { tables: ["a", "b"], on: ["year"], units: { a: "billions" } } }] }));
    expect(f.message).toContain("name the units and period basis of ['b'] before joining");
  });

  it("refuses missing join columns and keys that never overlap", async () => {
    const s = newSession();
    put(s, "data/a/a.csv", [{ year: 2020, x: 1 }]);
    put(s, "data/b/b.csv", [{ yr: 2021, y: 3 }]);
    put(s, "data/b/c.csv", [{ year: 2021, y: 3 }]);
    let f = await failure(() => compute(s, { inputs: { a: "data/a/a.csv", b: "data/b/b.csv" }, save_as: "exhibits/j.csv",
      steps: [{ align_check: { tables: ["this", "b"], on: ["year"], units: { this: "x", b: "y" } } }] }));
    expect(f.message).toContain("b lacks join columns ['year']");
    f = await failure(() => compute(s, { inputs: { a: "data/a/a.csv", c: "data/b/c.csv" }, save_as: "exhibits/j.csv",
      steps: [{ align_check: { tables: ["a", "c"], on: ["year"], units: { a: "x", c: "y" } } }] }));
    expect(f.message).toContain("no overlapping ['year'] values across ['a', 'c']: check codes and period labels");
  });
});
