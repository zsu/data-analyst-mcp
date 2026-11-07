/** NAEP: ported from tests/sources/naep/test_naep.py (same fixtures and values). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import ad from "../../src/adapters/naep.js";
import * as gr from "../../src/core/generic-rest.js";
import { load } from "../../src/core/packs.js";
import * as T from "../../src/tools.js";
import { csv, fetchOk, isolate, newSession } from "../helpers.js";

beforeAll(() => isolate());

// Fixtures recorded live from www.nationsreportcard.gov (NAEP Data Service 6.4) on 2026-10-20.
const SPEC = { description: "NAEP grade 4 reading: national 2024 vs 2019 with significance test; grade 4 reading by race in Wyoming 2024; math grade 8 states",
  requests: [{ name: "read4_np_2019_2024", endpoint: "scores", params: { subject: "reading", grade: 4, jurisdiction: "NP", Year: "2024,2019" } },
    { name: "read4_change", endpoint: "compare_years", params: { subject: "reading", grade: 4, Year: "2024,2019" } },
    { name: "read4_wy_race", endpoint: "scores", params: { subject: "reading", grade: 4, jurisdiction: "WY", variable: "SDRACE", Year: "2024" } },
    { name: "math8_states", endpoint: "compare_jurisdictions", params: { subject: "math", grade: 8, jurisdiction: "NP,MA,MS", Year: "2024" } },
    { name: "read4_levels", endpoint: "achievement_levels", params: { subject: "reading", grade: 4, Year: "2024" } }] };

const problems = async (spec: any) => gr.checkSpec(await load("naep"), spec);
const normalize = (rows: any[]) => ad.normalize!({} as any, {}, rows);
const withheldNote = ad.withheldNote as (req: any, rows: any[]) => string | null;
const loadsTolerant = ad.loadsTolerant as (raw: Buffer) => [any, boolean];

describe("naep", () => {
  it("is valid and takes the api route", async () => {
    expect(await problems(SPEC)).toEqual([]);
  });

  it("fetches", async () => {
    const s = newSession();
    const r = await fetchOk(s, "naep", SPEC);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api");
    const rows = Object.fromEntries(csv(s, "naep", "read4_np_2019_2024").map((x) => [x.year, x]));
    expect(rows["2024"].value).toBe("214.274883563924");
    expect(rows["2024"].stdError).toBe("0.364153420531045"); // QCData=true gives SEs
    const chg = csv(s, "naep", "read4_change");
    expect(new Set(chg.map((x) => x.sig))).toEqual(new Set(["HIGHER", "LOWER"]));
    const wy = Object.fromEntries(csv(s, "naep", "read4_wy_race").map((x) => [x.varValueLabel, x]));
    expect(wy.Black.value).toBe("999"); // published sentinel kept
    expect(wy.Black.value_flag).toBe("suppressed");
    expect(wy.Black.errorFlag_notes).toContain("Reporting standard not met");
    expect(wy.White.value_flag).toBe("");
    expect(csv(s, "naep", "math8_states")[0].subject).toBe("MAT"); // alias math -> mathematics
    expect(csv(s, "naep", "read4_levels").length).toBe(4);
    expect(r.notes.some((n: string) => n.includes("malformed"))).toBe(false); // valid bodies: no repair note
  });

  it("compare_years needs two years", async () => {
    expect((await problems({ requests: [{ name: "x", endpoint: "compare_years",
      params: { subject: "reading", grade: 4, Year: "2024" } }] })).length).toBeGreaterThan(0);
  });

  it("a grade the subject lacks is a spec problem", async () => {
    expect((await problems({ requests: [{ name: "x", endpoint: "scores", params: { subject: "tel", grade: 4 } }] })).length)
      .toBeGreaterThan(0);
  });

  it("repairs the variables list's malformed JSON", async () => {
    // type=independentvariables for 2024 sends unescaped quotes inside longLabel (fixture r006, raw body kept).
    const spec = { description: "Independent variables for grade 8 reading 2024",
      requests: [{ name: "read8_vars_2024", endpoint: "variables", params: { subject: "reading", cohort: 2, Year: "2024" } }] };
    const s = newSession();
    const r = await fetchOk(s, "naep", spec);
    expect(r.status).toBe("ok");
    const rows = csv(s, "naep", "read8_vars_2024");
    expect(rows.length).toBe(407);
    expect(rows.some((x) => x.varName === "SCHTYPE")).toBe(true);
    expect(rows.some((x) => x.longLabel.includes('"'))).toBe(true); // the quoted survey item is kept
    expect(r.notes.some((n: string) => n.includes("malformed JSON"))).toBe(true);
  });

  it("notes a year whose every estimate is withheld", () => {
    const row = (year: number, value: number, flag: number) => ({ year, value, errorFlag: flag });
    const rows = normalize([row(2022, 210.5, 0), row(2022, 230.1, 0), row(2024, 999, 288), row(2024, 999, 288)]);
    const note = withheldNote({ name: "g", params: { variable: "SLUNCH3" } }, rows)!;
    expect(note).toContain("every estimate for 2024 is withheld");
    expect(note).toContain("Non-qualified independent variable");
    expect(note).toContain("use ECONDIS");
    expect(withheldNote({ name: "g", params: {} }, rows.slice(0, 2))).toBeNull();
    const some = normalize([row(2024, 999, 1), row(2024, 215.0, 0)]); // one small cell: no note
    expect(withheldNote({ name: "g", params: {} }, some)).toBeNull();
  });

  it("repairs stray quotes (unit)", async () => {
    const bad = Buffer.from('{"result": [{"variables": [{"varName": "Q7", "shortLabel": "Agree: "Science is useful" (student)", ' +
      '"longLabel": "Rate: "very" or "not at all"."}, {"varName": "Q8", "shortLabel": "n", ' +
      '"longLabel": "Has a \\"proper\\" escape"}]}], "n": [1, -2]}');
    const [data, fixed] = loadsTolerant(bad);
    expect(fixed).toBe(true);
    const v = data.result[0].variables;
    expect(v[0].shortLabel).toBe('Agree: "Science is useful" (student)');
    expect(v[0].longLabel).toBe('Rate: "very" or "not at all".');
    expect(v[1].longLabel).toBe('Has a "proper" escape');
    expect(data.n).toEqual([1, -2]);
    expect(loadsTolerant(Buffer.from('{"a": "b \\"c\\""}'))).toEqual([{ a: 'b "c"' }, false]); // valid: untouched
    expect(() => loadsTolerant(Buffer.from('{"a": [1, 2}'))).toThrow(); // other faults still fail
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "naep-up-")); // manual route: same repair
    const p = path.join(d, "vars.json");
    fs.writeFileSync(p, bad);
    const req = { name: "vars", endpoint: "variables", params: { subject: "science", cohort: 1, Year: "2024" } };
    const rows = (await ad.parseUpload!(await load("naep"), req, [p])) as any[];
    expect(rows.map((x) => x.varName)).toEqual(["Q7", "Q8"]);
  });

  it("manual links carry the subscale", async () => {
    const r: any = await T.manualBundle(newSession(), { sources: [{ source: "naep", spec: SPEC }] });
    const urls: string[] = r.items.map((i: any) => i.url);
    expect(urls.every((u) => u.includes("subscale=") && u.includes("QCData=true"))).toBe(true);
    expect(urls.some((u) => u.includes("subject=mathematics") && u.includes("subscale=MRPCM"))).toBe(true);
  });
});
