/**
 * Through the MCP protocol: a fixed hint is sent once per session, facts returns the facts of the call (and lists
 * them all on request, writing nothing), and a client that asks for progress gets it (with no key in it).
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer, PROGRESS_BEAT_MS } from "../src/server.js";
import type { Session } from "../src/session.js";
import { fixtures, isolate, newSession } from "./helpers.js";

const FAKE = "FAKEKEY-progress-0123456789abcdef";
let client: Client;
let session: Session;

async function call(name: string, args: Record<string, unknown>, onprogress?: (p: any) => void): Promise<any> {
  const r: any = await client.callTool({ name, arguments: args }, undefined, onprogress ? { onprogress } : undefined);
  return JSON.parse(r.content[0].text);
}

const SPEC = { description: "Leading causes of death, New York, 2017", requests: [{ name: "ny_causes_2017", endpoint: "query",
  params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'", $order: "deaths DESC" } }] };
const pick = (name: string, cause: string) => ({ inputs: { c: "data/cdc/ny_causes_2017.csv" }, save_as: `exhibits/${name}.csv`,
  steps: [{ filter: `cause_name == "${cause}"` }, { select: ["cause_name", "deaths"] }] });

beforeAll(async () => {
  isolate();
  process.env.DATA_GOV_API_KEY = FAKE;
  fixtures("cdc");
  session = newSession();
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "progress-hints", version: "0" });
  await Promise.all([createServer(session).connect(a), client.connect(b)]);
  const brief = await call("source_brief", { source: "cdc" });
  await call("record_decisions", { questions: brief.questions_to_ask.map((q: any) => ({ id: q.id, question: q.question,
    how: "not_asked", reason_code: "settled_by_request", request: "New York, 2017, final counts" })) });
  await call("request_schema", { source: "cdc", names: ["query"] });
});

describe("progress", () => {
  it("reports each request of a fetch to a client that asks, with rising numbers and no key", async () => {
    const got: any[] = [];
    const r = await call("fetch", { source: "cdc", spec: SPEC }, (p) => got.push(p));
    expect(r.status).toBe("ok");
    expect(got.length).toBeGreaterThan(0);
    expect(got.some((p) => /GET https:\/\/\S+ -> 200/.test(p.message))).toBe(true);
    expect(got.map((p) => p.progress)).toEqual(got.map((_, i) => i + 1));
    for (const p of got) {
      expect(p.message).not.toContain(FAKE);
      expect(p.message).not.toContain("?");                  // the query stays out of the line
    }
    expect(JSON.stringify(r)).not.toContain("still working");  // progress never enters the result
  });

  it("says a call is still running while it waits (the rerun's worker)", async () => {
    const before = PROGRESS_BEAT_MS.value;
    const inline = process.env.DATA_ANALYST_RERUN_INLINE;
    delete process.env.DATA_ANALYST_RERUN_INLINE;
    PROGRESS_BEAT_MS.value = 5;
    try {
      const got: any[] = [];
      await client.callTool({ name: "rerun", arguments: {} }, undefined, { onprogress: (p) => got.push(p), timeout: 120_000 });
      expect(got.some((p) => /^replaying the exhibit recipes/.test(p.message))).toBe(true);
      expect(got.some((p) => /^still working \(\d+ s\)$/.test(p.message))).toBe(true);
    } finally {
      PROGRESS_BEAT_MS.value = before;
      if (inline !== undefined) process.env.DATA_ANALYST_RERUN_INLINE = inline;
    }
  }, 120_000);
});

describe("a fixed hint is sent once per session", () => {
  it("compute: the first result has next, a later one does not; a failure keeps its fix", async () => {
    const a = await call("compute", pick("all", "All causes"));
    const b = await call("compute", pick("heart", "Heart disease"));
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect([a, b].filter((r) => typeof r.next === "string")).toHaveLength(1);
    expect(a.next ?? b.next).toContain("facts");
    expect(b.summary.rows).toBe(1);                          // only the hint is gone
    const bad = await call("compute", { ...pick("bad", "x"), steps: [{ filter: "no_such_column == 1" }] });
    expect(bad.status).toBe("error");
    expect(bad.fix).toBeTruthy();
    const again = await call("compute", { ...pick("bad", "x"), steps: [{ filter: "no_such_column == 1" }] });
    expect(again.fix).toBe(bad.fix);
  });

  it("the gate's own hints are never left out (source_brief)", async () => {
    const a = await call("source_brief", { source: "cdc" });
    const b = await call("source_brief", { source: "cdc" });
    expect(a.next).toBeTruthy();
    expect(b.next).toBe(a.next);
  });

  it("a new session gets the hint again", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const other = new Client({ name: "second", version: "0" });
    const s2 = newSession();
    fs.cpSync(path.join(session.workspace, "data"), path.join(s2.workspace, "data"), { recursive: true });
    await Promise.all([createServer(s2).connect(a), other.connect(b)]);
    const r: any = await other.callTool({ name: "compute", arguments: pick("all", "All causes") });
    expect(JSON.parse(r.content[0].text).next).toContain("facts");
  });
});

describe("facts returns the facts of the call", () => {
  const fact = (name: string, table: string, cause: string) => ({ name, table: `exhibits/${table}.csv`,
    where: { cause_name: cause }, column: "deaths", fmt: "num:0", label: `${cause}, New York, 2017` });

  it("an add lists what it added; a call with no arguments lists every fact and writes nothing", async () => {
    const one = await call("facts", { pack: "cdc", add: [fact("deaths_all", "all", "All causes")] });
    expect(one.status).toBe("ok");
    expect(one.summary.added.deaths_all).toMatchObject({ value: 155358, text: "155,358", pack: "cdc" });
    expect(one.facts).toBeUndefined();
    expect(one.facts_total).toBe(1);

    const two = await call("facts", { pack: "cdc", add: [fact("deaths_heart", "heart", "Heart disease")] });
    expect(Object.keys(two.summary.added)).toEqual(["deaths_heart"]);   // not the earlier fact again
    expect(two.facts).toBeUndefined();
    expect(two.facts_total).toBe(2);

    const file = path.join(session.workspace, "facts.json");
    const before = fs.readFileSync(file);
    const stamp = fs.statSync(file).mtimeMs;
    const all = await call("facts", {});
    expect(all.facts.map((f: any) => f.name)).toEqual(["deaths_all", "deaths_heart"]);
    expect(all.facts[0]).toEqual({ name: "deaths_all", value: 155358, text: "155,358" });
    expect(all.facts[1].text).toBe(two.summary.added.deaths_heart.text);
    expect(all.facts_total).toBe(2);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(stamp);
  });

  it("a remove lists what is left", async () => {
    const r = await call("facts", { remove: ["deaths_heart"] });
    expect(r.facts.map((f: any) => f.name)).toEqual(["deaths_all"]);
    expect(r.facts_total).toBe(1);
  });
});
