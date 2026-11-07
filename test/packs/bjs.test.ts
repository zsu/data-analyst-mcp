/**
 * bjs: fixtures r001 (NCVS Select personal victimization, 2024 violent records) and r002 (the Criminal
 * Victimization, 2024 table package cv24.zip) were recorded from api.ojp.gov and bjs.ojp.gov on 2026-11-07.
 */
import { beforeAll, describe, expect, it } from "vitest";
import adapter from "../../src/adapters/bjs.js";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const SPEC = { description: "Violent victimizations 2024: NCVS Select records and BJS's published Table 1", requests: [
  { name: "violent_2024", endpoint: "query", params: { dataset: "personal_victimization",
    $select: "year, newcrime, newoff, seriousviolent, notify, newwgt", $where: "year = '2024' AND newcrime = '1'" } },
  { name: "cv24_t01_raw", endpoint: "statistical_table", params: { report: "criminal_victimization_2024", member: "cv24t01.csv" } },
  { name: "cv24_t01", endpoint: "statistical_table", params: { report: "cv24", member: "cv24t01.csv", header_lines: "11-12" } }] };

describe("bjs", () => {
  it("reproduces BJS's published 2024 violent victimizations from the records", async () => {
    const s = newSession();
    const r = await fetchOk(s, "bjs", SPEC);
    expect(r.status).toBe("ok");
    const recs = csv(s, "bjs", "violent_2024");
    expect(recs.length).toBe(1049);
    const sum = (rows: any[]) => rows.reduce((n, x) => n + Number(x.newwgt), 0);
    expect(Math.round(sum(recs))).toBe(6671636);
    expect(Math.round(sum(recs.filter((x) => x.newoff === "2")) / 10) * 10).toBe(642150);
    const t = csv(s, "bjs", "cv24_t01");
    const total = t.find((x) => x["Type of violent crime"] === "Total violent crime/b")!;
    expect(total["2024* | Number"]).toBe("6,671,640");
    expect(total["2024* | Rate per 1,000/a"]).toBe("23.3");
    expect(total["2020_col5"]).toBe("†");
    expect(t[0].row).toBe("13");
    const raw = csv(s, "bjs", "cv24_t01_raw");
    expect(raw[1]).toMatchObject({ row: "2", col1: "Filename: cv24t01.csv" });
  });

  it("refuses aggregate SoQL before any request", async () => {
    const s = newSession();
    fixtures("bjs");
    const spec = { requests: [{ name: "agg", endpoint: "query", params: { dataset: "personal_victimization",
      $select: "year, sum(newwgt)", $group: "year" } }] };
    await prepare(s, "bjs", spec);
    const f = await failure(T.fetchData(s, { source: "bjs", spec }));
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("bot");
  });

  it("names a missing table and lists the package's files", async () => {
    const s = newSession();
    fixtures("bjs");
    const spec = { requests: [{ name: "t99", endpoint: "statistical_table", params: { report: "cv24", member: "cv24t99.csv" } }] };
    await prepare(s, "bjs", spec);
    const f = await failure(T.fetchData(s, { source: "bjs", spec }));
    expect(f.message).toContain("cv24t01.csv");
  });

  it("names a bot-check page", () => {
    const page = Buffer.from("<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>");
    expect(adapter.checkError!(200, page)).toContain("bot-check");
    expect(adapter.checkError!(200, Buffer.from("[]"))).toBeNull();
  });
});
