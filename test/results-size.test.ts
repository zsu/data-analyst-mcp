/**
 * Result size and compute speed: compact lists and errors, sectioned guides and briefs, narrow previews, the report
 * sent once, failures-only audits, read_file match, the compute dry run, column projection, parse cache and cell caps,
 * copy-free derive, the Parquet copy of a large microdata CSV, and the replication package's size rule.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearParseCache, CSV_MAX_RAW_CELLS, neededColumns, parseCacheSize, runPipeline } from "../src/analysis/compute.js";
import { TOOLS as ANALYSIS } from "../src/analysis/tools.js";
import { PARQUET_MAX_CELLS, tableCsv } from "../src/analysis/table.js";
import { collapseRuns, columnList, namesHint } from "../src/core/compact.js";
import { parquetBeside } from "../src/core/package.js";
import { findSection, splitSections } from "../src/core/sections.js";
import { PACKAGE_CSV_MAX, sizeRule } from "../src/report/build_report.js";
import { setPath, TOOLS as REPORT } from "../src/report/tools.js";
import * as T from "../src/tools.js";
import type { Session } from "../src/session.js";
import { failure, isolate, newSession } from "./helpers.js";

beforeAll(() => isolate());
beforeEach(() => clearParseCache());

const tool = (name: string) => [...ANALYSIS, ...REPORT].find((t) => t.name === name)!.handler;
const compute = (s: Session, a: any) => tool("compute")(s, a) as any;

function put(s: Session, rel: string, text: string): string {
  const p = path.join(s.workspace, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

/** A wide table: id, grp, x, then w0 and replicate weights w1..w80 (like ACS PUMS). */
function wide(rows: number): string {
  const cols = ["id", "grp", "x", "w0", ...Array.from({ length: 80 }, (_, i) => `w${i + 1}`)];
  const lines = [cols.join(",")];
  for (let i = 0; i < rows; i++) {
    lines.push([i, i % 3 === 0 ? "a" : "b", (i % 7) + 0.5, 10 + (i % 5), ...Array.from({ length: 80 }, (_, r) => 10 + ((i + r) % 4))].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

describe("compact lists and messages", () => {
  it("collapses numbered runs and caps long lists only", () => {
    expect(collapseRuns(["a", "W1", "W2", "W3", "b", "y2019", "y2020"])).toEqual(["a", "W1-3", "b", "y2019", "y2020"]);
    expect(columnList(["a", "b"])).toEqual(["a", "b"]);                       // short lists stay as they are
    const many = ["SERIALNO", "PWGTP", ...Array.from({ length: 80 }, (_, i) => `PWGTP${i + 1}`)];
    expect(columnList(many)).toEqual(["SERIALNO", "PWGTP", "PWGTP1-80"]);
  });

  it("names the nearest columns instead of all of them", () => {
    const cols = Array.from({ length: 100 }, (_, i) => `c${i}`).concat(["HINCP", "ADJINC"]);
    const h = namesHint(["HINCPP"], cols);
    expect(h).toContain("HINCP");
    expect(h).toContain("102 columns in all");
    expect(h.length).toBeLessThan(300);
    expect(namesHint(["z"], ["a", "b"])).toBe('the columns are ["a","b"]');
  });
});

describe("guide and source_brief by section", () => {
  it("splits on ## headings and finds a section by title or number", () => {
    const secs = splitSections("# T\nlead\n## 1. One thing\nx\n## Two\ny\n```\n## not a heading\n```\n");
    expect(secs.map((s) => s.title)).toEqual(["", "1. One thing", "Two"]);
    expect(findSection(secs, "1")?.title).toBe("1. One thing");
    expect(findSection(secs, "one thing")?.title).toBe("1. One thing");
    expect(secs[2].text).toContain("## not a heading");
  });

  it("serves a long topic as an outline, then by section; compute lists its functions", () => {
    const s = newSession();
    const g: any = T.guide(s, { topic: "style" });
    expect(g.outline.length).toBeGreaterThan(3);
    expect(JSON.stringify(g).length).toBeLessThan(4000);
    const sec: any = T.guide(s, { topic: "style", section: "2" });
    expect(sec.text).toMatch(/^## 2\. Numbers/);
    expect(() => T.guide(s, { topic: "style", section: "nope" })).toThrow();
    expect((T.guide(s, { topic: "compute" }) as any).text).toMatch(/Aggregates: .*sum/);
    expect((T.guide(s, { topic: "report" }) as any).text).toContain("patch");
  });

  it("leaves Access out of the brief unless asked, and the pairing notes out always", async () => {
    const s = newSession();
    const b: any = await T.sourceBrief(s, { source: "census" });
    expect(b.playbook).not.toContain("## Access");
    expect(b.playbook_on_request[0].section).toBe("Access");
    expect(b.paired_with.every((r: any) => !("note" in r))).toBe(true);
    expect(b.docs).toEqual(expect.arrayContaining(["microdata.md", "timeseries.md"]));
    const a: any = await T.sourceBrief(s, { source: "census", sections: ["Access"] });
    expect(a.playbook).toMatch(/^## Access/);
    expect(a.questions_to_ask).toBeUndefined();                              // only the section, the brief was given
    const full: any = await T.sourceBrief(newSession(), { source: "census", full: true });
    expect(full.playbook).toContain("## Access");
    const doc: any = await T.sourceBrief(s, { source: "census", doc: "microdata" });
    expect(doc.text).toContain("STATE");                                     // the ST/STATE rename moved here
  });
});

describe("fetch preview and read_file", () => {
  it("previews a wide CSV from its head, without replicate weights", () => {
    const s = newSession();
    const p = put(s, "data/census/t.csv", wide(50));
    const pv = T.preview(p);
    expect(pv[0]).toBe("id,grp,x");                                          // w0..w80 is one numbered run
    expect(pv.length).toBe(1 + 5 + 1);                                         // header, 5 rows, the note
    expect(pv.at(-1)).toContain("3 of 84 columns shown");
  });

  it("returns only the header and matching lines with match", () => {
    const s = newSession();
    put(s, "data/census/codebook.csv", "variable,label\r\nCOW,Class of worker\r\nESR,Employment status\r\nAGEP,Age\r\n");
    const r: any = T.readFile(s, { path: "data/census/codebook.csv", match: "^(COW|AGEP)," });
    expect(r.text).toBe("1: variable,label\n2: COW,Class of worker\n4: AGEP,Age");
    expect(r.matched_lines).toBe(2);
  });
});

describe("report sent once, audits list failures", () => {
  it("sets dotted paths, makes lists for numbers and removes with null", () => {
    const R: any = { sections: [{ body: "a" }] };
    setPath(R, "sections.0.body", "b");
    setPath(R, "exhibits.0.title", "T");
    setPath(R, "sections.0.footnotes", null);
    expect(R).toEqual({ sections: [{ body: "b" }], exhibits: [{ title: "T" }] });
    expect(() => setPath(R, "__proto__.x", 1)).toThrow();
  });

  it("build_report without a report rebuilds report.json and patches it", async () => {
    const s = newSession();
    const f = await failure(() => tool("build_report")(s, {}));
    expect(f.code).toBe("not_found");                                         // nothing to rebuild yet
  });
});

describe("compute: dry run, projection, cache, caps, copy-free derive", () => {
  it("reports a misspelt column before reading the table", async () => {
    const s = newSession();
    put(s, "data/census/t.csv", wide(200));
    const old = CSV_MAX_RAW_CELLS.value;
    CSV_MAX_RAW_CELLS.value = 10;                                             // any read would be refused
    try {
      const f = await failure(() => compute(s, { inputs: { t: "data/census/t.csv" }, save_as: "exhibits/o.csv",
        steps: [{ derive: { y: "xx + 1" } }] }));
      expect(f.message).toContain("step 1 (derive): unknown column xx");
      expect(f.message).toContain("nearest");
      const g = await failure(() => compute(s, { inputs: { t: "data/census/t.csv" }, save_as: "exhibits/o.csv",
        steps: [{ derive: { y: "x + 1" } }] }));
      expect(g.message).toContain("more than compute reads at once");     // a correct recipe reaches the cap
    } finally {
      CSV_MAX_RAW_CELLS.value = old;
    }
  });

  it("reads only the columns a narrowing recipe uses, with the same result", () => {
    const s = newSession();
    put(s, "data/census/t.csv", wide(300));
    const header = ["id", "grp", "x", "w0", ...Array.from({ length: 80 }, (_, i) => `w${i + 1}`)];
    const steps = [{ derive: { y: "x * 2" } }, { groupby: ["grp"], replicate_se: { estimates: { m: "sum(w0 * y) / sum(w0)" },
      weight: "w0", replicates: "w1:w80", method: "sdr" } }];
    expect(neededColumns({ inputs: {}, steps } as any, header)?.length).toBe(84 - 1);   // id is not used
    expect(neededColumns({ inputs: {}, steps: [{ filter: "x > 1" }] } as any, header)).toBeNull(); // every column out
    const a = runPipeline(s.workspace, { inputs: { t: "data/census/t.csv" }, steps } as any);
    const b = runPipeline(s.workspace, { inputs: { t: "data/census/t.csv" }, steps: [{ as: "keep" }, ...steps] } as any);
    expect(tableCsv(a.table)).toBe(tableCsv(b.table));                       // "as" turns projection off
  });

  it("keeps a large parse for the next call, and never changes a cached input", () => {
    const s = newSession();
    put(s, "data/census/big.csv", wide(25_000));                              // over 5 MB
    const parsed = new Map();
    const one = runPipeline(s.workspace, { inputs: { t: "data/census/big.csv" }, steps: [{ derive: { y: "x + 1" } }, { select: ["id", "y"] }] } as any, parsed);
    expect(parseCacheSize()).toBe(1);
    const two = runPipeline(s.workspace, { inputs: { t: "data/census/big.csv" }, steps: [{ select: ["id", "x"] }] } as any, parsed);
    expect(one.table.cols).toEqual(["id", "y"]);
    expect(two.table.rows[0]).not.toHaveProperty("y");                       // derive did not write into the input
    for (const t of parsed.values()) expect((t as any).rows[0]).not.toHaveProperty("y");
  });

  it("decodes only the needed columns from the Parquet copy, with the same result", () => {
    const s = newSession();
    const p = put(s, "data/census/t.csv", wide(500));
    const steps = [{ groupby: ["grp"], rollup: { n: "count()", sx: "sum(x * w0)" } }];
    const before = tableCsv(runPipeline(s.workspace, { inputs: { t: "data/census/t.csv" }, steps } as any).table);
    expect(parquetBeside(p)).toMatch(/t\.parquet$/);
    const after = tableCsv(runPipeline(s.workspace, { inputs: { t: "data/census/t.csv" }, steps } as any).table);
    expect(after).toBe(before);
    const old = PARQUET_MAX_CELLS.value;
    PARQUET_MAX_CELLS.value = 500 * 3 + 10;                                   // grp, x, w0: under the cap from Parquet
    try {
      expect(tableCsv(runPipeline(s.workspace, { inputs: { t: "data/census/t.csv" }, steps } as any).table)).toBe(before);
    } finally {
      PARQUET_MAX_CELLS.value = old;
    }
  });
});

describe("replication package size rule", () => {
  it("keeps one copy of each table and leaves large ones to a re-fetch", () => {
    const s = newSession();
    const m = (name: string, bytes: number) => ({ name, path: put(s, name, "x".repeat(bytes)), filter: null });
    const old = PACKAGE_CSV_MAX.value;
    PACKAGE_CSV_MAX.value = 100;
    try {
      const [kept, out] = sizeRule([m("data/a/small.csv", 10), m("data/a/small.parquet", 10), m("data/a/big.csv", 500),
        m("data/a/big.parquet", 50), m("data/b/huge.csv", 500), m("data/b/huge.parquet", 500), m("exhibits/e.csv", 500)], []);
      expect(kept.map((k) => k.name).sort()).toEqual(["data/a/big.parquet", "data/a/small.csv", "exhibits/e.csv"]);
      expect(out.find((e) => e.name === "data/b/huge.csv")!.reason).toContain("data/b/request.json");
      expect(out.every((e) => !e.policy)).toBe(true);
    } finally {
      PACKAGE_CSV_MAX.value = old;
    }
  });
});
