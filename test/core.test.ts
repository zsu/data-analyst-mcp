import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PACKS_DIR } from "../src/core/env.js";
import { cleanUrl } from "../src/core/http.js";
import { redact, remember } from "../src/core/keys.js";
import { allPacks, packIds, route } from "../src/core/packs.js";
import * as pol from "../src/core/policy.js";
import { parsePyJson, parseQsl, pyFloatRepr, pyQuote, pyUrlencode } from "../src/core/py.js";
import { readCsv, writeCsv, xlsxSheets } from "../src/core/tabular.js";
import { isolate, TEST_DIR } from "./helpers.js";

beforeAll(() => isolate());

describe("redaction", () => {
  it("removes key-shaped query parameters, JSON fields and headers", () => {
    expect(redact("https://x.gov/a?api_key=abc123&q=1")).toBe("https://x.gov/a?api_key=[REDACTED]&q=1");
    expect(redact('{"registrationkey": "deadbeef99"}')).toBe('{"registrationkey": "[REDACTED]"}');
    expect(redact("Authorization: Bearer abcdef123456")).toBe("Authorization: Bearer [REDACTED]");
    expect(redact("use the 'Authorization: Bearer' header")).toBe("use the 'Authorization: Bearer' header");
  });
  it("removes every remembered secret wherever it appears", () => {
    remember("s3cr3t-value-42");
    expect(redact("error near s3cr3t-value-42 in path")).toBe("error near [REDACTED] in path");
  });
  it("drops secret params from recorded URLs", () => {
    expect(cleanUrl("https://api.x.gov/v1?b=2&api_key=zz&a=1", ["api_key"])).toBe("https://api.x.gov/v1?b=2&a=1");
  });
});

describe("python-compatible encoding", () => {
  it("urlencodes like urllib (quote_plus, doseq)", () => {
    expect(pyUrlencode({ $where: "state = 'New York'", n: 5, f: true })).toBe("%24where=state+%3D+%27New+York%27&n=5&f=True");
    expect(pyUrlencode({ a: ["x", "y z"] })).toBe("a=x&a=y+z");
    expect(pyUrlencode({ t: "a~b*c" })).toBe("t=a~b%2Ac");
    expect(pyQuote("a b/c", "")).toBe("a%20b%2Fc");
    expect(pyQuote("a b/c", "/")).toBe("a%20b/c");
  });
  it("writes numbers as Python does, so values stay as published", () => {
    expect([4, 4.5, 1e16, 1.5e-5, 0.0001, -0, 123456.789].map(pyFloatRepr))
      .toEqual(["4.0", "4.5", "1e+16", "1.5e-05", "0.0001", "-0.0", "123456.789"]);
    const v = parsePyJson('{"a": 4.0, "b": 3.94, "c": 12345678901234567890, "d": 7, "e": 1e-5, "f": [1.0, 2]}');
    expect(v).toEqual({ a: "4.0", b: 3.94, c: "12345678901234567890", d: 7, e: "1e-05", f: ["1.0", 2] });
  });
  it("parses queries like parse_qsl(keep_blank_values=True)", () => {
    expect(parseQsl("a=1&b=&flag&c=x+y%21")).toEqual([["a", "1"], ["b", ""], ["flag", ""], ["c", "x y!"]]);
  });
});

describe("csv", () => {
  it("round-trips quoting and short rows like Python's csv module", () => {
    const text = writeCsv([{ a: 'he said "hi"', b: "x,y" }, { a: "line\nbreak", b: true }], ["a", "b"]);
    expect(text).toBe('a,b\r\n"he said ""hi""","x,y"\r\n"line\nbreak",True\r\n');
    expect(readCsv("a,b,c\r\n1,2\r\n")).toEqual([{ a: "1", b: "2", c: null }]);
  });
});

describe("xlsx", () => {
  // the same cells as the Python reader (checked against it on five recorded workbooks)
  it("reads a recorded workbook as stored, line ends as XML reads them", () => {
    const sheets = xlsxSheets(fs.readFileSync(path.join(TEST_DIR, "packs", "acf", "fixtures", "fy2025-tanf-caseload.xlsx")));
    expect(Object.keys(sheets)).toEqual(["TFam", "TRec", "Mar25", "FYCY2025-Families"]);
    expect(sheets.TFam[3].slice(0, 3)).toEqual(["State", "45566", "45597"]);
    expect(sheets.TFam[3][16]).toBe("Average\nFY 2025");
  });
});

describe("policies", () => {
  it("every pack's policy is valid", async () => {
    const bad: Record<string, string[]> = {};
    for (const id of packIds()) {
      const probs = pol.validate(pol.load(path.join(PACKS_DIR, id)), path.join(PACKS_DIR, id));
      if (probs.length) bad[id] = probs;
    }
    expect(bad).toEqual({});
    expect(packIds().length).toBe(63);
  });
  it("citations fill the retrieval date", async () => {
    const [cdc] = (await allPacks()).filter((p) => p.id === "cdc");
    const c = pol.citation(cdc.policy, "api", { retrieved: "2026-11-07" });
    expect(c).toContain("November 7, 2026");
    expect(c).not.toMatch(/\{retrieved/);
  });
});

describe("routing", () => {
  it("ranks the producing agency first for common questions", async () => {
    expect((await route("unemployment rate by month"))[0].source).toBe("bls");
    expect((await route("leading causes of death by state"))[0].source).toBe("cdc");
    expect((await route("FEMA disaster declarations in Vermont")).map((r) => r.source)).toContain("fema");
  });
});
