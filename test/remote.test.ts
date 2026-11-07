/**
 * Remote mode over real HTTP: sessions and workspaces, signed downloads, the upload page, a bearer token, and
 * the OAuth sign-in with per-user keys (dynamic registration, PKCE, consent, token, the keys page). Fixtures only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/remote/app.js";
import { fixtures, isolate } from "./helpers.js";

const CDC = { description: "NY 2017", requests: [{ name: "ny_causes_2017", endpoint: "query",
  params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'", $order: "deaths DESC" } }] };
const FAKE = "USERKEY-" + "q".repeat(32);

type Running = { url: string; close: () => void; sessions: Map<string, any> };
const running: Running[] = [];

async function start(opts: Record<string, unknown> = {}): Promise<Running> {
  const holder: any = {};
  const srv = await new Promise<any>((resolve) => {
    const tmp = createApp({ publicUrl: "http://127.0.0.1:1", ...opts });
    const s = tmp.app.listen(0, "127.0.0.1", () => resolve(s));
    holder.first = tmp;
  });
  const port = (srv.address() as AddressInfo).port;
  srv.close();
  holder.first.close();
  // the public URL must name the real port (OAuth metadata and links use it)
  const app = createApp({ publicUrl: `http://127.0.0.1:${port}`, ...opts });
  const server = await new Promise<any>((resolve) => {
    const s = app.app.listen(port, "127.0.0.1", () => resolve(s));
  });
  const r = { url: `http://127.0.0.1:${port}`, sessions: app.sessions, close: () => {
    app.close();
    server.close();
  } };
  running.push(r);
  return r;
}

async function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers } }));
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  return JSON.parse(r.content[0].text);
}

async function ready(c: Client, source: string): Promise<void> {
  const b = await call(c, "source_brief", { source });
  await call(c, "record_decisions", { questions: b.questions_to_ask.map((q: any) => ({ id: q.id, how: "not_asked",
    reason_code: "settled_by_request", request: "test" })) });
}

beforeAll(() => {
  isolate();
  process.env.DATA_ANALYST_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "state-"));
  process.env.DATA_ANALYST_SECRET = "test-secret-" + crypto.randomBytes(8).toString("hex");
  fixtures("cdc");
});
afterAll(() => running.forEach((r) => r.close()));

describe("remote, open", () => {
  it("serves tools per session, links files instead of paths, and drops the workspace at close", async () => {
    const r = await start();
    const c = await connect(r.url);
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("fetch");
    await ready(c, "cdc");
    await call(c, "request_schema", { source: "cdc", names: ["query"] });
    const out = await call(c, "fetch", { source: "cdc", spec: CDC });
    expect(out.status).toBe("ok");
    expect(out.files[0]).toBe("data/cdc/ny_causes_2017.csv");
    expect(JSON.stringify(out)).not.toContain(os.tmpdir().slice(0, 12));
    const link = out.links["data/cdc/ny_causes_2017.csv"];
    expect(link).toMatch(new RegExp(`^${r.url}/files/`));
    const csv = await (await fetch(link)).text();
    expect(csv).toContain("All causes");
    expect((await fetch(link.slice(0, -3) + "AAA")).status).toBe(404);
    const [entry] = [...r.sessions.values()];
    expect(fs.existsSync(entry.session.workspace)).toBe(true);
    await c.close();
  });

  it("refuses key files and reads only uploaded files on ingest", async () => {
    const r = await start();
    const c = await connect(r.url);
    await ready(c, "cdc");
    await call(c, "request_schema", { source: "cdc", names: ["query"] });
    const bad = await call(c, "ingest", { source: "cdc", spec: CDC, files: [os.homedir()] });
    expect(bad.code).toBe("invalid_request");
    const b = await call(c, "manual_bundle", { sources: [{ source: "cdc", spec: CDC }] });
    expect(b.upload_page).toMatch(/\/upload\//);
    expect(b.links["manual_download/INSTRUCTIONS.md"]).toMatch(/\/files\//);
    const idx = JSON.parse(fs.readFileSync(path.join(process.env.DATA_ANALYST_FIXTURES!, "index.json"), "utf8"));
    const f = Object.entries<any>(idx).find(([k]) => k.includes("bi63-dtpu") && k.includes("New+York"))![1];
    const body = fs.readFileSync(path.join(process.env.DATA_ANALYST_FIXTURES!, typeof f === "string" ? f : f.file));
    const up = await fetch(`${b.upload_page}?&name=ny_causes_2017.json`, { method: "PUT", body });
    expect(up.status).toBe(200);
    const ing = await call(c, "ingest", { source: "cdc", spec: CDC, files: ["uploads"] });
    expect(ing.status).toBe("ok");
    expect(ing.summary.route).toBe("manual_download");
    await c.close();
  });

  it("answers an unknown session with 404", async () => {
    const r = await start();
    const res = await fetch(`${r.url}/mcp`, { method: "POST", headers: { "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-session-id": "nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(404);
  });
});

describe("remote, bearer token", () => {
  it("refuses requests without the token", async () => {
    const r = await start({ authToken: "t0ken-" + "z".repeat(20) });
    await expect(connect(r.url)).rejects.toThrow();
    const c = await connect(r.url, { Authorization: "Bearer t0ken-" + "z".repeat(20) });
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("fetch");
    await c.close();
  });
});

describe("remote, OAuth accounts and per-user keys", () => {
  it("signs in, stores a key on the keys page, and uses it without ever showing it", async () => {
    const r = await start({ accounts: true });
    // the 401 points at the protected-resource metadata, which names this server as the authorization server
    const un = await fetch(`${r.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(un.status).toBe(401);
    expect(un.headers.get("www-authenticate")).toContain("resource_metadata");
    const meta = await (await fetch(`${r.url}/.well-known/oauth-authorization-server`)).json() as any;
    expect(meta.registration_endpoint).toBe(`${r.url}/register`);
    // dynamic client registration, as claude.ai does it
    const redirect = "http://127.0.0.1:9/callback";
    const client = await (await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test assistant", redirect_uris: [redirect], token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json() as any;
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const authz = new URL(meta.authorization_endpoint);
    Object.entries({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge,
      code_challenge_method: "S256", state: "st8" }).forEach(([k, v]) => authz.searchParams.set(k, v));
    const consent = await (await fetch(authz)).text();
    expect(consent).toContain("Test assistant");
    const pending = /name="pending" value="([^"]+)"/.exec(consent)![1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    const made = await (await fetch(`${r.url}/oauth/consent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ pending, account_code: "" }) })).text();
    const accountCode = /<code[^>]*>([^<]+)<\/code>/.exec(made)![1];
    const next = new URL(/href="([^"]+)"/.exec(made)![1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))));
    expect(next.searchParams.get("state")).toBe("st8");
    const tok = await (await fetch(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: next.searchParams.get("code")!, code_verifier: verifier,
        client_id: client.client_id, redirect_uri: redirect }) })).json() as any;
    expect(tok.access_token).toBeTruthy();
    // the code works once
    const again = await fetch(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: next.searchParams.get("code")!, code_verifier: verifier,
        client_id: client.client_id, redirect_uri: redirect }) });
    expect(again.status).toBe(400);

    const c = await connect(r.url, { Authorization: `Bearer ${tok.access_token}` });
    let k = await call(c, "check_key", { source: "fred" });
    expect(k.key.configured).toBe(false);
    // a key error gives the user their own keys page, never a request for the key in chat
    await ready(c, "usda-nass");
    await call(c, "request_schema", { source: "usda-nass", names: ["query"] });
    const nass = { requests: [{ name: "corn_va", endpoint: "query", params: { commodity_desc: "corn", year__GE: 2012, state_alpha: "va" } }] };
    const missing = await call(c, "fetch", { source: "usda-nass", spec: nass });
    expect(missing.code).toBe("key_missing");
    expect(missing.keys_url).toMatch(new RegExp(`^${r.url}/keys/`));
    expect(missing.fix).toContain(missing.keys_url);
    const [entry] = [...r.sessions.values()];
    const page = entry.session.keysUrl as string;
    expect(page).toMatch(/\/keys\//);
    const form = await (await fetch(page)).text();
    expect(form).toContain("FRED_API_KEY");
    expect(form).not.toContain(FAKE);
    const saved = await (await fetch(page, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ FRED_API_KEY: FAKE }) })).text();
    expect(saved).toContain("Stored now: FRED_API_KEY");
    expect(saved).not.toContain(FAKE);
    k = await call(c, "check_key", { source: "fred" });
    expect(k.key.configured).toBe(true);
    expect(k.key.where).toBe("your stored key");
    // stored encrypted: the value is not in the state files
    for (const f of fs.readdirSync(process.env.DATA_ANALYST_STATE_DIR!)) {
      expect(fs.readFileSync(path.join(process.env.DATA_ANALYST_STATE_DIR!, f), "utf8")).not.toContain(FAKE);
    }
    // another account does not see it; the account code reconnects to the same keys
    const { tokens: t2 } = await signIn(r.url, meta, "");
    const c2 = await connect(r.url, { Authorization: `Bearer ${t2.access_token}` });
    expect((await call(c2, "check_key", { source: "fred" })).key.configured).toBe(false);
    const { tokens: t3 } = await signIn(r.url, meta, accountCode);
    const c3 = await connect(r.url, { Authorization: `Bearer ${t3.access_token}` });
    expect((await call(c3, "check_key", { source: "fred" })).key.configured).toBe(true);
    // a session cannot be used with another account's token
    const sid = [...r.sessions.keys()][0];
    const cross = await fetch(`${r.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t2.access_token}`,
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    expect(cross.status).toBe(403);
    await Promise.all([c.close(), c2.close(), c3.close()]);
  });
});

async function signIn(url: string, meta: any, accountCode: string): Promise<{ tokens: any }> {
  const redirect = "http://127.0.0.1:9/cb";
  const client = await (await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Other", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) })).json() as any;
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authz = new URL(meta.authorization_endpoint);
  Object.entries({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", code_challenge: challenge,
    code_challenge_method: "S256" }).forEach(([k, v]) => authz.searchParams.set(k, v));
  const consent = await (await fetch(authz)).text();
  const pending = /name="pending" value="([^"]+)"/.exec(consent)![1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const res = await fetch(`${url}/oauth/consent`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ pending, account_code: accountCode }) });
  const loc = res.status === 302 ? res.headers.get("location")! :
    /href="([^"]+)"/.exec(await res.text())![1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const code = new URL(loc).searchParams.get("code")!;
  const tokens = await (await fetch(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id,
      redirect_uri: redirect }) })).json() as any;
  return { tokens };
}
