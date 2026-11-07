/**
 * 0.3 features: selective loading, the request list on results, the persistent response cache (only where a
 * source's terms allow it), the off-loopback refusal, a fixed local workspace across restarts, and the library API.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Cache } from "../src/core/cache.js";
import { Client } from "../src/core/http.js";
import { packIds } from "../src/core/packs.js";
import * as T from "../src/tools.js";
import * as sdk from "../src/index.js";
import { failure, fixtures, isolate, newSession, TEST_DIR } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CDC = { description: "NY 2017", requests: [{ name: "ny_causes_2017", endpoint: "query",
  params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'", $order: "deaths DESC" } }] };

beforeAll(() => isolate());
afterEach(() => {
  for (const k of ["DATA_ANALYST_SOURCES", "DATA_ANALYST_DOMAINS", "DATA_ANALYST_HIDE_UNCONFIGURED"]) delete process.env[k];
});

describe("selective loading", () => {
  it("lists, briefs and fetches only the enabled sources", async () => {
    process.env.DATA_ANALYST_SOURCES = "cdc,fema";
    expect(packIds()).toEqual(["cdc", "fema"]);
    const f = await failure(T.sourceBrief(newSession(), { source: "bls" }));
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("not enabled on this server");
    expect((await T.findSources(newSession(), {}) as any).sources.map((x: any) => x.id)).toEqual(["cdc", "fema"]);
  });

  it("filters by domain", () => {
    process.env.DATA_ANALYST_DOMAINS = "weather";
    expect(packIds()).toContain("nws");
    expect(packIds()).not.toContain("cdc");
  });

  it("hides sources whose required key is not set up", async () => {
    process.env.DATA_ANALYST_HIDE_UNCONFIGURED = "1";
    const ids = (await T.findSources(newSession(), {}) as any).sources.map((x: any) => x.id);
    expect(ids).not.toContain("usda-nass");
    expect(ids).toContain("cdc");
    process.env.USDA_NASS_API_KEY = "x".repeat(40);
    const again = (await T.findSources(newSession(), {}) as any).sources.map((x: any) => x.id);
    expect(again).toContain("usda-nass");
    delete process.env.USDA_NASS_API_KEY;
  });
});

describe("results list their requests", () => {
  it("each upstream request with status, cached flag and time", async () => {
    fixtures("cdc");
    const r: any = await sdk.fetchSource("cdc", CDC, { out: fs.mkdtempSync(path.join(os.tmpdir(), "req-")) });
    expect(r.requests_total).toBe(1);
    expect(r.requests[0]).toMatchObject({ method: "GET", status: 200, cached: false });
    expect(r.requests[0].url).toMatch(/^https:\/\/data\.cdc\.gov\/resource\//);
  });
});

describe("response cache", () => {
  it("serves a repeated GET from disk, only for a persistent-cache policy", async () => {
    delete process.env.DATA_ANALYST_FIXTURES;
    process.env.DATA_ANALYST_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "cache-"));
    let hits = 0;
    const srv = http.createServer((_q, res) => {
      hits++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: hits }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const policy = (mode: string) => ({ id: "t", cache: { mode, ttl_hours: 1 } }) as any;
    try {
      const cached = () => new Client(base, { name: "t", cache: new Cache("t", policy("persistent")) });
      const first = await cached().getJson("/x", { a: 1 });
      const second = await cached().getJson("/x", { a: 1 });
      expect([first, second, hits]).toEqual([{ ok: 1 }, { ok: 1 }, 1]);
      const runOnly = () => new Client(base, { name: "t", cache: new Cache("t", policy("run_only")) });
      await runOnly().getJson("/y");
      await runOnly().getJson("/y");
      expect(hits).toBe(3);
    } finally {
      srv.close();
    }
  });
});

const tsxCli = (args: string[], env: Record<string, string | undefined> = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "src", "bin", "cli.ts"), ...args],
    { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", timeout: 60000 });

describe("off-loopback safety", () => {
  it("refuses to serve on 0.0.0.0 without authentication, unless asked to", () => {
    const r = tsxCli(["serve", "--http", "--host", "0.0.0.0", "--port", "0"],
      { DATA_ANALYST_ACCOUNTS: "", DATA_ANALYST_AUTH_TOKEN: "", DATA_ANALYST_OPEN: "" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refusing to serve on 0.0.0.0 without authentication");
    expect(r.stderr).toContain("DATA_ANALYST_OPEN=1");
  });
});

describe("fixed local workspace", () => {
  it("a second server run on the same workspace reuses the earlier fetch", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "fixed-ws-"));
    const run = async () => {
      const env = { ...process.env, DATA_ANALYST_FIXTURES: path.join(TEST_DIR, "packs", "cdc", "fixtures") } as Record<string, string>;
      const c = new McpClient({ name: "t", version: "0" });
      await c.connect(new StdioClientTransport({ command: process.execPath,
        args: ["--import", "tsx", path.join(ROOT, "src", "bin", "cli.ts"), "--workspace", ws], cwd: ROOT, env }));
      const call = async (name: string, args: any) => JSON.parse(((await c.callTool({ name, arguments: args })) as any).content[0].text);
      await call("source_brief", { source: "cdc" });
      await call("record_decisions", { questions: [{ id: "cdc:1", how: "dont_know", resolution: "final" },
        { id: "cdc:2", how: "answered", answer: "counts" }] });
      await call("request_schema", { source: "cdc", names: ["query"] });
      const r = await call("fetch", { source: "cdc", spec: CDC });
      await c.close();
      return r;
    };
    expect((await run()).summary.route).toBe("api");
    expect((await run()).summary.route).toBe("reuse_existing");
    expect(fs.existsSync(path.join(ws, "data", "cdc", "ny_causes_2017.csv"))).toBe(true);
  }, 60000);
});

describe("library API", () => {
  it("routes, briefs and fetches without the model-facing gate", async () => {
    fixtures("cdc");
    expect((await sdk.route("leading causes of death"))[0].source).toBe("cdc");
    expect(((await sdk.brief("cdc")) as any).questions_to_ask.length).toBe(2);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-"));
    const r: any = await sdk.fetchSource("cdc", CDC, { out });
    expect(r.status).toBe("ok");
    const c: any = sdk.compute(out, { inputs: { c: "data/cdc/ny_causes_2017.csv" }, save_as: "exhibits/all.csv",
      steps: [{ filter: 'cause_name == "All causes"' }, { select: ["cause_name", "deaths"] }] });
    expect(c.status).toBe("ok");
    const f = sdk.registerFacts(out, { pack: "cdc", add: [{ name: "deaths", table: "exhibits/all.csv",
      where: { cause_name: "All causes" }, column: "deaths", fmt: "num:0", label: "Deaths, NY 2017" }] } as any);
    expect(f.facts[0]).toMatchObject({ name: "deaths", text: "155,358" });
    let e: any;
    try {
      await sdk.fetchSource("no-such", CDC, { out });
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(sdk.ToolError);
    expect(e.failure.code).toBe("invalid_request");
  });
});
