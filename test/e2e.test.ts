/**
 * The whole answer workflow through the MCP protocol, with the real tools and no stubs (fixtures for the data):
 * find_sources -> source_brief -> record_decisions -> request_schema -> fetch -> compute -> facts -> write_table
 * -> record_decisions (method record) -> audit_answer with rerun, then a mistyped number fails the gate.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { fixtures, isolate, newSession } from "./helpers.js";

let client: Client;
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const r: any = await client.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
}

beforeAll(async () => {
  isolate();
  fixtures("cdc");
  const server = createServer(newSession());
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "e2e", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

describe("answer workflow, end to end", () => {
  it("gets from a question to an audited answer, and the gate catches a wrong number", async () => {
    expect((await call("find_sources", { question: "leading causes of death in New York" })).candidates[0].source).toBe("cdc");
    const brief = await call("source_brief", { source: "cdc" });
    const request = "How many people died in New York in 2017, and what share was heart disease? Final counts.";
    let r = await call("record_decisions", { questions: brief.questions_to_ask.map((q: any) => ({ id: q.id, question: q.question,
      how: "not_asked", reason_code: "settled_by_request", request })) });
    expect(r.status).toBe("ok");
    await call("request_schema", { source: "cdc", names: ["query"] });
    r = await call("fetch", { source: "cdc", spec: { description: "Leading causes of death, New York, 2017", requests: [{
      name: "ny_causes_2017", endpoint: "query", params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'",
        $order: "deaths DESC" } }] } });
    expect(r.status).toBe("ok");

    r = await call("compute", { inputs: { c: "data/cdc/ny_causes_2017.csv" }, save_as: "exhibits/ny_2017.csv", steps: [
      { derive: { total: 'sum(cause_name == "All causes" ? deaths : 0)' } },
      { filter: 'cause_name == "All causes" || cause_name == "Heart disease"' },
      { derive: { share: "deaths / total" } },
      { select: ["cause_name", "deaths", "share"] }] });
    expect(r.status).toBe("ok");
    r = await call("facts", { pack: "cdc", add: [
      { name: "deaths_ny_2017", table: "exhibits/ny_2017.csv", where: { cause_name: "All causes" }, column: "deaths",
        fmt: "num:0", label: "Deaths in New York, all causes, 2017", headline: true },
      { name: "heart_share_ny_2017", table: "exhibits/ny_2017.csv", where: { cause_name: "Heart disease" }, column: "share",
        fmt: "pct:1", label: "Heart disease share of deaths, New York, 2017" }] });
    expect(r.status, JSON.stringify(r)).toBe("ok");
    const deathsText = r.summary.added.deaths_ny_2017.text;
    const shareText = r.summary.added.heart_share_ny_2017.text;
    expect(shareText).toMatch(/%$|percent/);

    r = await call("write_table", { path: "exhibits/benchmark.csv",
      columns: ["measure", "period", "computed", "published", "source", "url", "accessed", "match", "note"],
      rows: [["Deaths in New York, all causes", "2017", 155358, "not checked", "CDC WONDER", "https://wonder.cdc.gov/", "2026-11-07",
        "not checked", "no published table for this exact cut was opened"]] });
    expect(r.status).toBe("ok");
    const quote = "Final mortality data are complete counts of all deaths occurring in the United States.";
    r = await call("cite", { url: "https://www.cdc.gov/nchs/nvss/deaths.htm", id: "nchs_deaths",
      text: `Mortality data. ${quote} Provisional counts are revised as records arrive.` });
    expect(r.status, JSON.stringify(r)).toBe("ok");
    r = await call("record_decisions", {
      disclosures: { literature: "No literature search could be run here." },
      method: {
      literature_search: [{ unavailable: true, reason_code: "no_search_tool", reason: "this test client has no search tool" }],
      references: [{ id: "nchs_deaths", citation: "NCHS, Mortality data (National Vital Statistics System)",
        url: "https://www.cdc.gov/nchs/nvss/deaths.htm", accessed: "2026-11-07", opened: true, used_for: "final counts", quote }],
      assumptions: [{ parameter: "counts_final", value: "final 2017 counts", basis: "precedent",
        evidence: "NCHS reports final counts as complete [@nchs_deaths]",
        why_not_empirical: "an official definition (NCHS final-count release), not a quantity the data can estimate" }],
      data_needs: [{ id: "published_total", data: "The NCHS published 2017 New York death total",
        improves: ["Deaths in New York, all causes"], effect: "a benchmark for the headline", how_to_get: "CDC WONDER",
        from_user: false }],
    } });
    expect(r.status).toBe("ok");

    const answer = `In 2017, ${deathsText} people died in New York (final counts), and heart disease caused ${shareText} of ` +
      "those deaths (CDC, NCHS leading causes of death). No literature search could be run here.\n";
    const audit = await call("audit_answer", { answer, rerun: true });
    const fails = (audit.checks || []).filter((c: any) => c.status === "FAIL");
    expect(fails, JSON.stringify(fails, null, 1)).toEqual([]);
    expect(JSON.stringify(audit)).toContain("AUDIT PASSED");

    const typo = await call("audit_answer", { answer: answer.replace(deathsText, "155,385") });
    expect(JSON.stringify(typo)).not.toContain("AUDIT PASSED");
  });
});
