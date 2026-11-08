/**
 * Remote mode: the MCP server over streamable HTTP, for a hosted deployment (a claude.ai custom connector).
 *
 *   POST/GET/DELETE /mcp   MCP (one Session, with its own temporary workspace, per MCP session)
 *   GET  /files/:token     a signed download of a workspace file (fetched CSVs, manual bundles); 24 hours
 *   GET  /upload#<token>   the page where the user uploads files a manual bundle downloaded (24 hours); its script
 *                          calls GET|PUT /upload/api with the token as a bearer header
 *   GET  /keys#<token>     (accounts on) the user's write-only key page (1 hour); GET|POST /keys/api
 *   The tokens of these two pages are in the URL fragment, which browsers never send: no access log or Referer has
 *   them. Every response is no-store, no-referrer, never framed, and runs no script without its own CSP nonce.
 *   OAuth endpoints        (accounts on) /.well-known/*, /authorize, /token, /register, /revoke, /oauth/consent
 *   GET  /healthz
 *
 * Auth, by configuration:
 *   DATA_ANALYST_ACCOUNTS=1   OAuth sign-in (what claude.ai connectors support); each user's own keys
 *   DATA_ANALYST_AUTH_TOKEN   a single shared bearer token (private deployments, clients that send headers)
 *   neither                   open: keyless sources and the operator's keys (environment variables) only
 * Keys: the operator's come only from the environment; a user's come only from the encrypted store. Key files
 * on the host are never read (DATA_ANALYST_MODE=remote).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { setOwnHost } from "../analysis/cite.js";
import { holdsCredential, workspaceFile } from "../core/guard.js";
import { holdsSecret } from "../core/keys.js";
import { safeName } from "../core/manual.js";
import { allPacks } from "../core/packs.js";
import { createServer } from "../server.js";
import { Session } from "../session.js";
import { grantCode, provider, type PendingAuth } from "./oauth.js";
import { keysPage, newAccountPage, uploadPage } from "./pages.js";
import { checkSecret, sign, verify } from "./sign.js";
import * as store from "./store.js";

export type RemoteOptions = { publicUrl: string; accounts?: boolean; authToken?: string; idleMinutes?: number;
  callsPerMinute?: number; trustProxy?: boolean };

type Entry = { session: Session; transport: StreamableHTTPServerTransport };

const FILE_TTL = 24 * 3600;
const KEYS_TTL = 3600;
const MAX_UPLOAD = 200 * 1024 * 1024;
const SCAN_MAX = 64 * 1024 * 1024;

export function createApp(o: RemoteOptions): { app: express.Express; close: () => void; sessions: Map<string, Entry> } {
  process.env.DATA_ANALYST_MODE = "remote";
  const base = new URL(o.publicUrl);
  const mcpUrl = new URL("/mcp", base);
  const at = (p: string) => new URL(p, base).toString();
  const app = express();
  if (o.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  setOwnHost(o.publicUrl);
  const sessions = new Map<string, Entry>();

  // every response: never cached, never framed, never sniffed, never sent on as a Referer; no script unless a page
  // brings its own nonce (page())
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    next();
  });
  /** An HTML page whose inline script runs only with this response's nonce. */
  const page = (res: Response, html: (nonce: string) => string) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.type("html").send(html(nonce));
  };
  const bearer = (req: Request) => String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expired = (res: Response) => void res.status(403).json({ error: "this link expired: ask your assistant for a new one" });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, sessions: sessions.size });
  });

  // ------------------------------------------------------------------ authentication
  let auth: express.RequestHandler = (_req, _res, next) => next();
  if (o.accounts) {
    if (!process.env.DATA_ANALYST_SECRET) throw new Error("DATA_ANALYST_ACCOUNTS=1 needs DATA_ANALYST_SECRET (stored keys are encrypted with it)");
    checkSecret();
    app.use(mcpAuthRouter({ provider, issuerUrl: base, resourceServerUrl: mcpUrl, resourceName: "data-analyst" }));
    auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
    app.post("/oauth/consent", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) => {
      const p = verify<PendingAuth>(req.body?.pending, "consent");
      if (!p) return void res.status(400).type("text").send("This sign-in request expired: start again from your assistant.");
      const code = String(req.body?.account_code || "").trim();
      if (code) {
        const acct = store.accountByCode(code);
        if (!acct) return void res.status(400).type("text").send("Unknown account code. Go back and check it, or leave it empty for a new account.");
        return void res.redirect(302, grantCode(p, acct));
      }
      const a = store.createAccount();
      res.status(200).type("html").send(newAccountPage(a.code, grantCode(p, a.id)));
    });
    const keyVars = async () => {
      const m = new Map<string, { env: string; sources: string[]; signup?: string | null }>();
      for (const p of await allPacks()) {
        const a = p.policy.auth;
        for (const env of [a.env, ...Object.values(a.extra || {})].filter((x): x is string => !!x)) {
          const v = m.get(env) || { env, sources: [], signup: a.signup_url };
          v.sources.push(p.id);
          m.set(env, v);
        }
      }
      return [...m.values()].sort((x, y) => (x.env < y.env ? -1 : 1));
    };
    // the page itself carries no token; its script sends the one from the link's fragment (pages.ts)
    app.get("/keys", (_req, res) => page(res, keysPage));
    const keyAccount = (req: Request) => {
      const t = verify<{ a: string }>(bearer(req), "keys");
      return t && store.accountExists(t.a) ? t.a : null;
    };
    app.get("/keys/api", async (req, res) => {
      const a = keyAccount(req);
      if (!a) return expired(res);
      res.json({ vars: await keyVars(), set: store.keyNames(a) });
    });
    app.post("/keys/api", express.json({ limit: "64kb" }), async (req, res) => {
      const a = keyAccount(req);
      if (!a) return expired(res);
      const got = req.body?.keys;
      if (!got || typeof got !== "object" || Array.isArray(got) ||
        Object.values(got).some((v) => typeof v !== "string" || v.length > 4096)) {
        return void res.status(400).json({ error: "keys must be an object of variable names to text values" });
      }
      const vars = new Set((await keyVars()).map((v) => v.env));
      const upd = Object.fromEntries(Object.entries(got as Record<string, string>).filter(([k, v]) => vars.has(k) && v !== ""));
      res.json({ vars: await keyVars(), set: store.setKeys(a, upd) });
    });
    // links issued before the token moved into the fragment
    app.get("/keys/:t", (req, res) => void res.redirect(302, `/keys#${encodeURIComponent(req.params.t)}`));
  } else if (o.authToken) {
    const want = Buffer.from(o.authToken);
    auth = (req, res, next) => {
      const got = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return void res.status(401).json({ error: "unauthorized" });
      next();
    };
  }

  // ------------------------------------------------------------------ MCP
  const limiter = rateLimit({ windowMs: 60_000, limit: o.callsPerMinute ?? 240, standardHeaders: "draft-7", legacyHeaders: false,
    message: { jsonrpc: "2.0", error: { code: -32000, message: "rate_limited: too many requests; wait a minute" }, id: null } });

  const accountOf = (req: Request): string | null => ((req as any).auth?.extra?.account as string) ?? null;

  function attach(session: Session): void {
    session.linker = (abs) => {
      const rel = path.relative(session.workspace, abs).replaceAll("\\", "/");
      return at(`/files/${sign({ k: "file", s: session.id, p: rel }, FILE_TTL)}`);
    };
    // the token is in the fragment: a browser never sends it to a server, so it is in no access log or Referer
    session.uploadUrl = at(`/upload#${sign({ k: "upload", s: session.id }, FILE_TTL)}`);
    if (session.account) {
      const account = session.account;
      // a fresh one-hour link each time a result shows it
      Object.defineProperty(session, "keysUrl", { get: () => at(`/keys#${sign({ k: "keys", a: account }, KEYS_TTL)}`) });
      session.keyProvider = store.keyProvider(account);
    }
  }

  const rpcError = (res: Response, status: number, message: string) =>
    void res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

  app.post("/mcp", limiter, auth, express.json({ limit: "4mb" }), async (req, res) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let entry = sid ? sessions.get(sid) : undefined;
    if (sid && !entry) return rpcError(res, 404, "unknown or expired session: start a new one");
    if (entry && entry.session.account !== accountOf(req)) return rpcError(res, 403, "this session belongs to another account");
    if (!entry) {
      if (!isInitializeRequest(req.body)) return rpcError(res, 400, "no session: send initialize first");
      const id = crypto.randomUUID();
      const session = new Session(id);
      session.account = accountOf(req);
      attach(session);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id,
        onsessioninitialized: (sidNew) => void sessions.set(sidNew, entry!) });
      transport.onclose = () => drop(id);
      entry = { session, transport };
      await createServer(session).connect(transport);
    }
    entry.session.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res, req.body);
  });

  const existing = async (req: Request, res: Response) => {
    const entry = sessions.get(req.headers["mcp-session-id"] as string);
    if (!entry) return rpcError(res, 404, "unknown or expired session");
    if (entry.session.account !== accountOf(req)) return rpcError(res, 403, "this session belongs to another account");
    entry.session.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res);
  };
  app.get("/mcp", limiter, auth, existing);
  app.delete("/mcp", limiter, auth, existing);

  // ------------------------------------------------------------------ files in and out
  app.get("/files/:t", (req, res) => {
    const t = verify<{ s: string; p: string }>(req.params.t, "file");
    const entry = t && sessions.get(t.s);
    if (!t || !entry) return void res.status(404).type("text").send("This link expired or its session ended.");
    const abs = path.resolve(entry.session.workspace, t.p);
    if (!workspaceFile(t.p, entry.session.workspace) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return void res.status(404).end();
    }
    // a last check: a file with a key in it is never handed out (fetched data is scrubbed when it is written)
    const buf = fs.readFileSync(abs);
    if (holdsSecret(buf) || (buf.length <= SCAN_MAX && holdsCredential(buf))) {
      return void res.status(409).type("text").send("This file holds an API key or credential, so it is not served. " +
        "Ask your assistant to remove it from the file first.");
    }
    res.download(abs, path.basename(abs));
  });

  const uploadSession = (token: string) => {
    const t = verify<{ s: string }>(token, "upload");
    return (t && sessions.get(t.s)) || null;
  };
  const upload = (entry: Entry | null, req: Request, res: Response) => {
    if (!entry) return void res.status(404).json({ error: "this link expired or its session ended" });
    const dir = path.join(entry.session.workspace, "uploads");
    fs.mkdirSync(dir, { recursive: true });
    const name = safeName(path.basename(String(req.query.name || "upload.bin")));
    fs.writeFileSync(path.join(dir, name), req.body as Buffer);
    res.json({ ok: true, path: `uploads/${name}`, bytes: (req.body as Buffer).length });
  };
  const raw = express.raw({ type: () => true, limit: MAX_UPLOAD });

  app.get("/upload", (_req, res) => page(res, uploadPage));
  app.get("/upload/api", (req, res) => {
    const entry = uploadSession(bearer(req));
    if (!entry) return void res.status(404).json({ error: "this link expired or its session ended" });
    const dir = path.join(entry.session.workspace, "uploads");
    res.json({ files: fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [] });
  });
  app.put("/upload/api", raw, (req, res) => upload(uploadSession(bearer(req)), req, res));
  // links issued before the token moved into the fragment
  app.get("/upload/:t", (req, res) => void res.redirect(302, `/upload#${encodeURIComponent(req.params.t)}`));
  app.put("/upload/:t", raw, (req, res) => upload(uploadSession(req.params.t), req, res));

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err?.status || 500).json({ error: err?.status === 413 ? "too large" : "server error" });
  });

  // ------------------------------------------------------------------ idle sessions
  function drop(id: string): void {
    const e = sessions.get(id);
    if (!e) return;
    sessions.delete(id);
    fs.rmSync(e.session.workspace, { recursive: true, force: true });
  }
  const idle = (o.idleMinutes ?? 120) * 60_000;
  const timer = setInterval(() => {
    for (const [id, e] of sessions) if (Date.now() - e.session.lastSeen > idle) {
      void e.transport.close();
      drop(id);
    }
  }, 60_000);
  timer.unref();

  return { app, sessions, close: () => {
    clearInterval(timer);
    for (const [id, e] of sessions) {
      void e.transport.close();
      drop(id);
    }
  } };
}
