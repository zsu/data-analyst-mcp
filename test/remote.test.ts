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
  process.env.DATA_ANALYST_SECRET = "test-secret-" + crypto.randomBytes(16).toString("hex");
  fixtures("cdc");
});
afterAll(() => running.forEach((r) => r.close()));

describe("remote, open", () => {
  it("serves tools per session, links files instead of paths, and drops the workspace at close", async () => {
    const r = await start();
    const c = await connect(r.url);
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("open_workspace"); // local only
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
    // the token is in the fragment (never sent to a server, so never in an access log); the page carries none
    expect(b.upload_page).toMatch(new RegExp(`^${r.url}/upload#`));
    const token = b.upload_page.split("#")[1];
    const shell = await fetch(b.upload_page);
    expect(await shell.text()).not.toContain(token);
    expect(shell.headers.get("content-security-policy")).toMatch(/script-src 'nonce-/);
    expect(b.links["manual_download/INSTRUCTIONS.md"]).toMatch(/\/files\//);
    const idx = JSON.parse(fs.readFileSync(path.join(process.env.DATA_ANALYST_FIXTURES!, "index.json"), "utf8"));
    const f = Object.entries<any>(idx).find(([k]) => k.includes("bi63-dtpu") && k.includes("New+York"))![1];
    const body = fs.readFileSync(path.join(process.env.DATA_ANALYST_FIXTURES!, typeof f === "string" ? f : f.file));
    expect((await fetch(`${r.url}/upload/api?name=x.json`, { method: "PUT", body })).status).toBe(404);
    const up = await fetch(`${r.url}/upload/api?name=ny_causes_2017.json`, { method: "PUT", body,
      headers: { Authorization: `Bearer ${token}` } });
    expect(up.status).toBe(200);
    const listed = await (await fetch(`${r.url}/upload/api`, { headers: { Authorization: `Bearer ${token}` } })).json() as any;
    expect(listed.files).toEqual(["ny_causes_2017.json"]);
    // a link issued before the token moved into the fragment still opens the page
    const old = await fetch(`${r.url}/upload/${token}`, { redirect: "manual" });
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe(`/upload#${token}`);
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
    const consentRes = await fetch(authz);
    for (const [h, v] of [["cache-control", "no-store"], ["referrer-policy", "no-referrer"], ["x-frame-options", "DENY"],
      ["x-content-type-options", "nosniff"]]) expect(consentRes.headers.get(h)).toBe(v);
    expect(consentRes.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const consent = await consentRes.text();
    expect(consent).toContain("Test assistant");
    // the page names where the sign-in goes back to, not only the client's self-chosen name
    expect(consent).toContain("<code>127.0.0.1:9</code>");
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
    expect(missing.keys_url).toMatch(new RegExp(`^${r.url}/keys#`));
    expect(missing.fix).toContain(missing.keys_url);
    const [entry] = [...r.sessions.values()];
    const page = entry.session.keysUrl as string;
    expect(page).toMatch(/\/keys#/);
    const token = page.split("#")[1];
    // the page is a shell: no token, no key names until its script asks with the token
    const shell = await fetch(page);
    const html = await shell.text();
    expect(html).toContain("Your API keys");
    expect(html).not.toContain(token);
    const csp = shell.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(shell.headers.get("cache-control")).toBe("no-store");
    const auth = { Authorization: `Bearer ${token}` };
    expect((await fetch(`${r.url}/keys/api`)).status).toBe(403);
    expect((await fetch(`${r.url}/keys/api`, { headers: { Authorization: `Bearer ${token.slice(0, -2)}AA` } })).status).toBe(403);
    const form = await (await fetch(`${r.url}/keys/api`, { headers: auth })).json() as any;
    expect(form.vars.map((v: any) => v.env)).toContain("FRED_API_KEY");
    expect(form.set).toEqual([]);
    const post = (body: unknown) => fetch(`${r.url}/keys/api`, { method: "POST", body: JSON.stringify(body),
      headers: { ...auth, "content-type": "application/json" } });
    expect((await post({ keys: { FRED_API_KEY: [FAKE, FAKE] } })).status).toBe(400);
    const savedRes = await post({ keys: { FRED_API_KEY: FAKE, NOT_A_PACK_KEY: "x".repeat(20) } });
    const saved = await savedRes.text();
    expect(JSON.parse(saved).set).toEqual(["FRED_API_KEY"]);
    expect(saved).not.toContain(FAKE);
    // a link issued before the token moved into the fragment still opens the page
    const old = await fetch(`${r.url}/keys/${token}`, { redirect: "manual" });
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe(`/keys#${token}`);
    k = await call(c, "check_key", { source: "fred" });
    expect(k.key.configured).toBe(true);
    expect(k.key.where).toBe("your stored key");
    // stored encrypted: the value is not in the state files
    for (const f of fs.readdirSync(process.env.DATA_ANALYST_STATE_DIR!)) {
      expect(fs.readFileSync(path.join(process.env.DATA_ANALYST_STATE_DIR!, f), "utf8")).not.toContain(FAKE);
    }
    // a workspace file that holds the key is never handed out, and the model cannot read the state folder
    const planted = path.join(entry.session.workspace, "planted.txt");
    fs.writeFileSync(planted, `echoed: ${FAKE}`);
    expect((await fetch(entry.session.linker(planted))).status).toBe(409);
    const st = await call(c, "read_file", { path: path.join(process.env.DATA_ANALYST_STATE_DIR!, "accounts.json") });
    expect(st.code).toBe("invalid_request");
    const rf = await c.callTool({ name: "read_file", arguments: { path: "planted.txt" } }) as any;
    expect(rf.content[0].text).not.toContain(FAKE);
    // the model cannot make the server open its own pages (the keys page)
    const own = await call(c, "cite", { url: page.replace("#", "/"), id: "own" });
    expect(own.status).toBe("error");
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
