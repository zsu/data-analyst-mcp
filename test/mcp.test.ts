/** The server through the MCP protocol (in-memory transport), and the key-leak invariant on every tool output. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { DataError } from "../src/core/http.js";
import { createServer, INSTRUCTIONS } from "../src/server.js";
import { toFailure } from "../src/envelope.js";
import { fixtures, isolate, newSession } from "./helpers.js";

const FAKE = "FAKEKEY-0123456789abcdef";
let client: Client;
const outputs: string[] = [];

async function call(name: string, args: Record<string, unknown>): Promise<{ data: any; isError: boolean }> {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content[0].text as string;
  for (const c of r.content) outputs.push(String(c.text ?? ""));
  return { data: JSON.parse(text), isError: !!r.isError };
}

beforeAll(async () => {
  isolate();
  process.env.FRED_API_KEY = FAKE;
  process.env.DATA_GOV_API_KEY = FAKE + "-dg";
  fixtures("cdc");
  const server = createServer(newSession());
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

describe("mcp server", () => {
  it("sends the instructions and lists the tools, prompt and resources", async () => {
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const t of ["check_key", "fetch", "find_sources", "guide", "ingest", "manual_bundle", "read_file", "record_decisions", "request_schema", "source_brief"]) expect(tools).toContain(t);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["analyze"]);
    const p = await client.getPrompt({ name: "analyze", arguments: { question: "How many veterans live in Texas?" } });
    expect((p.messages[0].content as any).text).toContain("Ask in **one** round");
    const res = await client.listResources();
    expect(res.resources.map((r) => r.uri)).toContain("source://cdc");
    const doc = await client.readResource({ uri: "source://cdc" });
    expect((doc.contents[0] as any).text.length).toBeGreaterThan(500);
  });

  it("walks the whole path: find, brief, decide, schema, fetch, read", async () => {
    const found = await call("find_sources", { question: "leading causes of death in New York" });
    expect(found.data.candidates[0].source).toBe("cdc");
    let r = await call("fetch", { source: "cdc", spec: { requests: [{ name: "x", endpoint: "query", params: { dataset: "leading_death" } }] } });
    expect(r.isError).toBe(true);
    expect(r.data.code).toBe("gate_blocked");
    const brief = await call("source_brief", { source: "cdc" });
    expect(brief.data.questions_to_ask.length).toBe(2);
    await call("record_decisions", { questions: [{ id: "cdc:1", how: "dont_know", resolution: "final counts" },
      { id: "cdc:2", how: "answered", answer: "counts" }] });
    await call("request_schema", { source: "cdc", names: ["query"] });
    r = await call("fetch", { source: "cdc", spec: { description: "NY 2017", requests: [{ name: "ny_causes_2017", endpoint: "query",
      params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'", $order: "deaths DESC" } }] } });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe("ok");
    expect(r.data.citation.text).toContain("NY 2017");
    expect(r.data.citation.text).toMatch(/retrieved \w+ \d+, \d{4}/);
    const f = await call("read_file", { path: "data/cdc/ny_causes_2017.csv" });
    expect(f.data.text).toContain("All causes");
    const out = await call("read_file", { path: "../../etc/passwd" });
    expect(out.data.code).toBe("invalid_request");
  });

  it("errors carry a code and a fix", async () => {
    const r = await call("source_brief", { source: "no-such-source" });
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ status: "error", code: "invalid_request" });
    expect(r.data.fix).toContain("find_sources");
  });

  it("never shows a key: key status, briefs, errors", async () => {
    const k = await call("check_key", { source: "fred" });
    expect(k.data.key.configured).toBe(true);
    await call("source_brief", { source: "fred" });
    await call("source_brief", { source: "eia" });
    await call("find_sources", {});
    const f = toFailure(new DataError(`GET https://api.x.gov/v1?series=1&api_key=${FAKE}: HTTP 500 ${FAKE}`, "http"));
    outputs.push(JSON.stringify(f));
    for (const o of outputs) {
      expect(o).not.toContain(FAKE);
    }
  });
});
