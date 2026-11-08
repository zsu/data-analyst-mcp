/**
 * Secrets never reach the model and never stay in a file: every form a key is echoed in is redacted; no tool reads a
 * key file or a file holding a key; an echoed key is scrubbed from the workspace; a key goes only to its agency's site;
 * hosted keys stored by an earlier version still open. Offline: fixtures and a stubbed fetch.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as guard from "../src/core/guard.js";
import { Client, DataError } from "../src/core/http.js";
import * as keys from "../src/core/keys.js";
import * as packages from "../src/core/package.js";
import { quotePlus } from "../src/core/py.js";
import { toFailure, ToolError } from "../src/envelope.js";
import * as lib from "../src/index.js";
import { createServer } from "../src/server.js";
import { fixtures, isolate, newSession, TEST_DIR } from "./helpers.js";

// key characters that change when URL-encoded or JSON-escaped
const FAKES = {
  FRED_API_KEY: "FAKE+fred/0123456789=&abc",        // environment
  CENSUS_API_KEY: "FAKE-census-keysjson-0123456789", // keys.json
  EIA_API_KEY: "FAKE-eia-settings-0123456789",       // Claude Code's settings.json
  BLS_API_KEY: "FAKE-bls-envfile-0123456789",        // BLS_API_KEY_FILE
  DATA_GOV_API_KEY: "FAKE-datagov-home-0123456789",  // ~/.data-gov/api_key
};
const forms = (k: string) => [k, encodeURIComponent(k), quotePlus(k),
  encodeURIComponent(k).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), JSON.stringify(k).slice(1, -1)];
const ALL_FORMS = Object.values(FAKES).flatMap(forms);
const leaked = (text: string) => ALL_FORMS.filter((f) => text.includes(f));

const CDC = { description: "NY 2017", requests: [{ name: "ny_causes_2017", endpoint: "query",
  params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'", $order: "deaths DESC" } }] };

let home = "";
let client: McpClient;
let workspace = "";
const outputs: string[] = [];
const paths: Record<string, string> = {};

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const r: any = await client.callTool({ name, arguments: args });
  for (const c of r.content) outputs.push(String(c.text ?? ""));
  return JSON.parse(r.content[0].text);
}

function walk(d: string): string[] {
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
}

beforeAll(async () => {
  home = isolate();
  process.env.FRED_API_KEY = FAKES.FRED_API_KEY;
  const cfg = process.env.DATA_ANALYST_CONFIG_DIR!;
  fs.mkdirSync(cfg, { recursive: true });
  paths.keysJson = path.join(cfg, "keys.json");
  fs.writeFileSync(paths.keysJson, JSON.stringify({ env: { CENSUS_API_KEY: FAKES.CENSUS_API_KEY } }));
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  paths.settings = path.join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
  fs.writeFileSync(paths.settings, JSON.stringify({ env: { EIA_API_KEY: FAKES.EIA_API_KEY } }));
  fs.mkdirSync(path.join(home, "vault"), { recursive: true });
  paths.envFile = path.join(home, "vault", "bls.txt");
  fs.writeFileSync(paths.envFile, FAKES.BLS_API_KEY);
  process.env.BLS_API_KEY_FILE = paths.envFile;
  fs.mkdirSync(path.join(home, ".data-gov"), { recursive: true });
  paths.homeKey = path.join(home, ".data-gov", "api_key");
  fs.writeFileSync(paths.homeKey, FAKES.DATA_GOV_API_KEY);
  // a project folder with a .env, and a downloads folder with a real data file and a note holding a key
  fs.mkdirSync(path.join(home, "project"), { recursive: true });
  paths.dotenv = path.join(home, "project", ".env");
  fs.writeFileSync(paths.dotenv, `FRED_API_KEY=${FAKES.FRED_API_KEY}\n`);
  fs.writeFileSync(path.join(home, "project", "data.json"), "[]");
  fs.mkdirSync(path.join(home, "Downloads"), { recursive: true });
  paths.note = path.join(home, "Downloads", "notes.json");
  fs.writeFileSync(paths.note, JSON.stringify({ mine: FAKES.CENSUS_API_KEY }));
  const fx = path.join(TEST_DIR, "packs", "cdc", "fixtures");
  const idx = JSON.parse(fs.readFileSync(path.join(fx, "index.json"), "utf8"));
  const hit = Object.entries<any>(idx).find(([k]) => k.includes("bi63-dtpu") && k.includes("New+York"))![1];
  const file = typeof hit === "string" ? hit : hit.file;
  paths.download = path.join(home, "Downloads", "ny_causes_2017.json");
  fs.copyFileSync(path.join(fx, file), paths.download);
  // the same fixtures, with the response echoing a key (as some agencies echo the request back)
  paths.echoFixtures = path.join(home, "fixtures-echo");
  fs.cpSync(fx, paths.echoFixtures, { recursive: true });
  const body = fs.readFileSync(path.join(fx, file), "utf8");
  fs.writeFileSync(path.join(paths.echoFixtures, file), body.replace("All causes", `All causes ${FAKES.FRED_API_KEY}`));

  fixtures("cdc");
  const s = newSession();
  workspace = s.workspace;
  const server = createServer(s);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new McpClient({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const brief = await call("source_brief", { source: "cdc" });
  await call("record_decisions", { questions: brief.questions_to_ask.map((q: any) => ({ id: q.id, how: "not_asked",
    reason_code: "settled_by_request", request: "test" })) });
  await call("request_schema", { source: "cdc", names: ["query"] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("redaction", () => {
  it("knows every configured key from the start, in every form it can be echoed in", () => {
    for (const k of Object.values(FAKES)) {
      for (const f of forms(k)) expect(keys.redact(`before ${f} after`)).not.toContain(f);
    }
    expect(keys.redact("X-Api-Key: abc123def456ghi")).toBe("X-Api-Key: [REDACTED]");
    expect(keys.redact("x-api-key: the agency's header")).toBe("x-api-key: the agency's header");
  });

  it("never passes on the text a JSON parse failed on", () => {
    let err: unknown;
    try {
      JSON.parse("SECRETVALUE1234 is a key file");
    } catch (e) {
      err = e;
    }
    expect(toFailure(err).message).not.toContain("SECRETVAL");
  });
});

describe("paths a model names", () => {
  it("ingest refuses key files, .env files, folders holding them, and files holding a key", async () => {
    for (const p of [paths.keysJson, paths.settings, paths.envFile, paths.homeKey, paths.dotenv,
      path.join(home, "project"), paths.note, home]) {
      const r = await call("ingest", { source: "cdc", spec: CDC, files: [p] });
      expect(r.code, p).toBe("invalid_request");
    }
    // a plain data file outside the workspace still ingests (local mode)
    const ok = await call("ingest", { source: "cdc", spec: CDC, files: [paths.download] });
    expect(ok.status).toBe("ok");
  });

  it.skipIf(process.platform === "win32")("follows a symlink before deciding", async () => {
    const link = path.join(home, "Downloads", "innocent.json");
    fs.symlinkSync(paths.keysJson, link);
    const r = await call("ingest", { source: "cdc", spec: CDC, files: [link] });
    expect(r.code).toBe("invalid_request");
    fs.rmSync(link);
  });

  it("for_each reads only workspace tables; read_file only workspace files", async () => {
    for (const csv of [paths.keysJson, "../../x.csv"]) {
      const r = await call("fetch", { source: "cdc", spec: { requests: [{ name: "each", endpoint: "query",
        params: { dataset: "leading_death" }, for_each: { csv, column: "env" } }] } });
      expect(r.status).toBe("error");
      expect(r.message).toContain("outside the workspace");
    }
    for (const p of [paths.keysJson, paths.settings, "../../etc/passwd"]) {
      expect((await call("read_file", { path: p })).code).toBe("invalid_request");
    }
  });

  it("build_report and audit_report refuse report.json paths outside the workspace", async () => {
    const r = await call("build_report", { report: { title: "t", replication: { extra: [paths.keysJson] } } });
    expect(r.status).toBe("error");
    expect(r.message).toContain("outside the workspace");
    const f = await call("build_report", { report: { title: "t", facts: "../../.config/data-analyst/keys.json" } });
    expect(f.status).toBe("error");
    const a = await call("audit_report", {});
    expect(JSON.stringify(a)).toContain("outside the workspace");
  });

  it("the library refuses the same paths", async () => {
    await expect(lib.ingest("cdc", CDC, [paths.keysJson], { out: path.join(home, "lib-out") })).rejects.toBeInstanceOf(ToolError);
  });

  it("guard names the places keys are kept", () => {
    expect(guard.secretPlace(paths.keysJson)).not.toBe("");
    expect(guard.secretPlace(path.join(home, ".ssh", "id_ed25519"))).not.toBe("");
    expect(guard.secretPlace(path.join(home, "Downloads", "server.pem"))).not.toBe("");
    expect(guard.secretPlace(paths.download)).toBe("");
  });
});

describe("files written", () => {
  it("an echoed key is scrubbed from every workspace file, and the result says so", async () => {
    process.env.DATA_ANALYST_FIXTURES = paths.echoFixtures;
    try {
      const r = await call("fetch", { source: "cdc", spec: CDC, force: true });
      expect(r.status).toBe("ok");
      expect(r.notes.join(" ")).toContain("[REDACTED]");
      const csv = fs.readFileSync(path.join(workspace, "data", "cdc", "ny_causes_2017.csv"), "utf8");
      expect(csv).toContain("All causes [REDACTED]");
      // the checksum in request.json is of the file as written
      const req = JSON.parse(fs.readFileSync(path.join(workspace, "data", "cdc", "request.json"), "utf8"));
      const t = req.tables.find((x: any) => x.name === "ny_causes_2017");
      expect(t.sha256).toBe(crypto.createHash("sha256").update(fs.readFileSync(path.join(workspace, "data", "cdc", t.file))).digest("hex"));
    } finally {
      fixtures("cdc");
    }
    for (const f of walk(workspace)) expect(leaked(fs.readFileSync(f, "latin1")), f).toEqual([]);
  });

  it("scrubDir reports what it changed", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-"));
    fs.mkdirSync(path.join(d, "raw"));
    fs.writeFileSync(path.join(d, "raw", "a.json"), `{"echo": "${encodeURIComponent(FAKES.FRED_API_KEY)}"}`);
    fs.writeFileSync(path.join(d, "b.csv"), "x\n1\n");
    expect(packages.takeScrubbed(d)).toEqual(["raw/a.json"]);
    expect(fs.readFileSync(path.join(d, "raw", "a.json"), "utf8")).toBe('{"echo": "[REDACTED]"}');
  });
});

describe("where a key is sent", () => {
  const seen: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const stub = (answer: (url: string) => Response) => {
    seen.length = 0;
    vi.stubGlobal("fetch", async (url: any, init: any) => {
      seen.push({ url: String(url), headers: init?.headers || {}, body: init?.body ? String(init.body) : undefined });
      return answer(String(url));
    });
  };
  const offline = <T>(fn: () => Promise<T>) => async () => {
    const fx = process.env.DATA_ANALYST_FIXTURES;
    delete process.env.DATA_ANALYST_FIXTURES;
    try {
      await fn();
    } finally {
      process.env.DATA_ANALYST_FIXTURES = fx;
    }
  };

  it("only to the client's own site, never down to http", offline(async () => {
    stub(() => new Response("{}", { status: 200 }));
    const c = new Client("https://api.example.gov/v1", { name: "t", retries: 0,
      auth: { env: "FRED_API_KEY", placement: "query", param: "api_key" } });
    await c.get("/series");
    await c.get("https://data.example.gov/other");
    await c.get("https://elsewhere.example.com/next?page=2");   // a next-page link from a response
    await c.get("http://api.example.gov/v1/plain");
    const has = (u: string) => forms(FAKES.FRED_API_KEY).some((f) => u.includes(f));
    expect(seen.map((s) => has(s.url))).toEqual([true, true, false, false]);
  }));

  it("a header key is not sent along a link to another site", offline(async () => {
    stub(() => new Response("{}", { status: 200 }));
    const c = new Client("https://api.example.gov", { name: "t", retries: 0,
      auth: { env: "FRED_API_KEY", placement: "header", param: "X-Api-Key" } });
    await c.get("/a");
    await c.get("https://other.example.org/b");
    expect(seen[0].headers["X-Api-Key"]).toBe(FAKES.FRED_API_KEY);
    expect(seen[1].headers["X-Api-Key"]).toBeUndefined();
  }));

  it("a key in the body follows a 307/308 redirect wherever it points", offline(async () => {
    stub((u) => (u.includes("api.example.gov")
      ? new Response("", { status: 307, headers: { location: "https://mirror.example.net/x" } })
      : new Response("{}", { status: 200 })));
    const c = new Client("https://api.example.gov", { name: "t", retries: 0,
      auth: { env: "FRED_API_KEY", placement: "body", param: "registrationkey" } });
    await c.postJson("/data", { series: ["X"] });
    expect(seen.map((s) => s.url)).toEqual(["https://api.example.gov/data", "https://mirror.example.net/x"]);
    expect(JSON.parse(seen[1].body!).registrationkey).toBe(FAKES.FRED_API_KEY);
    stub((u) => (u.startsWith("https:")
      ? new Response("", { status: 308, headers: { location: "http://api.example.gov/data" } })
      : new Response("{}", { status: 200 })));
    await c.postJson("/data", { series: ["X"] });
    expect(seen.map((s) => s.url)).toEqual(["https://api.example.gov/data", "http://api.example.gov/data"]);
    expect(JSON.parse(seen[1].body!).registrationkey).toBe(FAKES.FRED_API_KEY);
  }));
});

describe("tool outputs", () => {
  it("no output of any call above holds a key in any form", () => {
    expect(outputs.length).toBeGreaterThan(10);
    for (const o of outputs) expect(leaked(o)).toEqual([]);
  });
});

describe("hosted key store", () => {
  it("opens keys stored with the earlier derivation and re-encrypts them on the next save", async () => {
    const secret = "s".repeat(16) + crypto.randomBytes(16).toString("hex");
    process.env.DATA_ANALYST_SECRET = secret;
    process.env.DATA_ANALYST_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "state-"));
    const sign = await import("../src/remote/sign.js");
    const store = await import("../src/remote/store.js");
    const { id } = store.createAccount();
    // the blob as an earlier version wrote it: one key, sha256(secret), for signing and encryption
    const legacy = crypto.createHmac("sha256", crypto.createHash("sha256").update(secret).digest()).update(`keys:${id}`).digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", legacy, iv);
    const enc = Buffer.concat([c.update(JSON.stringify({ FRED_API_KEY: "legacy-key-0123456789" }), "utf8"), c.final()]);
    const file = path.join(process.env.DATA_ANALYST_STATE_DIR, "accounts.json");
    const accts = JSON.parse(fs.readFileSync(file, "utf8"));
    accts[id].keys = [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
    fs.writeFileSync(file, JSON.stringify(accts));
    expect(store.keyNames(id)).toEqual(["FRED_API_KEY"]);
    expect(store.keyProvider(id)("FRED_API_KEY")).toBe("legacy-key-0123456789");
    expect(store.setKeys(id, { CENSUS_API_KEY: "census-key-0123456789" })).toEqual(["CENSUS_API_KEY", "FRED_API_KEY"]);
    // now under the new key only
    const blob = JSON.parse(fs.readFileSync(file, "utf8"))[id].keys as string;
    const [iv2, tag2, enc2] = blob.split(".").map((x) => Buffer.from(x, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", legacy, iv2);
    d.setAuthTag(tag2);
    expect(() => Buffer.concat([d.update(enc2), d.final()])).toThrow();
    // a short secret is refused
    process.env.DATA_ANALYST_SECRET = "short";
    expect(() => sign.checkSecret()).toThrow(/at least 32/);
    process.env.DATA_ANALYST_SECRET = secret;
  });
});
