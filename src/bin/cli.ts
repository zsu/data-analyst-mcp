#!/usr/bin/env node
/**
 * data-analyst-mcp
 *   (no arguments)        run the MCP server over stdio (what an assistant starts: npx -y data-analyst-mcp)
 *   setup <source>        store a source's API key in ~/.config/data-analyst/keys.json, typed with hidden input
 *   serve --http          the hosted mode over streamable HTTP (see src/remote/app.ts for its settings)
 *   --version | --help
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configPath } from "../core/keys.js";
import { load } from "../core/packs.js";
import { createServer, VERSION } from "../server.js";
import { Session } from "../session.js";

const HELP = `data-analyst-mcp ${VERSION}
  data-analyst-mcp                 run the MCP server over stdio
  data-analyst-mcp setup <source>  store an API key for a source (hidden input) in ${configPath()}
  data-analyst-mcp serve --http [--port 8080] [--host 127.0.0.1] [--public-url https://your.host]
                                   the hosted mode (streamable HTTP at /mcp); off loopback it needs
                                   DATA_ANALYST_ACCOUNTS=1, DATA_ANALYST_AUTH_TOKEN, or DATA_ANALYST_OPEN=1
Options (any mode): --sources fred,treasury  --domains economy,health  --hide-unconfigured
                    --workspace <folder> (stdio: one fixed analysis folder, reused across restarts)
Environment: DATA_ANALYST_OUT (workspace root), DATA_ANALYST_CONFIG_DIR (keys.json folder).`;

function askHidden(prompt: string): Promise<string> {
  let muted = false;
  const out = new Writable({ write(chunk, _enc, cb) {
    if (!muted) process.stdout.write(chunk);
    cb();
  } });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

async function setup(source?: string): Promise<number> {
  if (!source) {
    console.error("usage: data-analyst-mcp setup <source>");
    return 2;
  }
  const p = await load(source);
  const env = p.policy.auth.env;
  if (!env) {
    console.log(`${source} needs no API key.`);
    return 0;
  }
  if (!process.stdin.isTTY) {
    console.error("setup reads the key from your terminal with hidden input: run it in a terminal.");
    return 2;
  }
  if (p.policy.auth.signup_url) console.log(`Get a free ${env} at ${p.policy.auth.signup_url}`);
  const key = await askHidden(`Paste your ${env} (input hidden): `);
  if (!key) {
    console.error("No key entered; nothing stored.");
    return 2;
  }
  const file = configPath();
  let data: any = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch { /* new file */ }
  data.env = { ...(data.env || {}), [env]: key };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(`Stored ${env} in ${file}. Your assistant can fetch ${source} now.`);
  return 0;
}

/**
 * Options for every mode, as flags or environment variables (the flags set the variables):
 *   --sources fred,treasury     DATA_ANALYST_SOURCES          only these sources
 *   --domains economy,health    DATA_ANALYST_DOMAINS          only sources in these domains
 *   --hide-unconfigured         DATA_ANALYST_HIDE_UNCONFIGURED  leave out sources whose required key is not set up
 *   --workspace <folder>        DATA_ANALYST_WORKSPACE        (stdio) one fixed analysis folder, so fetches are
 *                                                               reused across restarts (within each source's terms)
 */
export function takeGlobalFlags(argv: string[]): string[] {
  const rest: string[] = [];
  const valued: Record<string, string> = { "--sources": "DATA_ANALYST_SOURCES", "--domains": "DATA_ANALYST_DOMAINS",
    "--workspace": "DATA_ANALYST_WORKSPACE" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued[a] && i + 1 < argv.length) process.env[valued[a]] = argv[++i];
    else if (a === "--hide-unconfigured") process.env.DATA_ANALYST_HIDE_UNCONFIGURED = "1";
    else rest.push(a);
  }
  return rest;
}

async function main(): Promise<number | undefined> {
  const [cmd, ...rest] = takeGlobalFlags(process.argv.slice(2));
  if (cmd === "--version" || cmd === "-v") return (console.log(VERSION), 0);
  if (cmd === "--help" || cmd === "-h") return (console.log(HELP), 0);
  if (cmd === "setup") return setup(rest[0]);
  if (cmd === "serve") return serve(rest);
  if (cmd) {
    console.error(`unknown command ${cmd}\n${HELP}`);
    return 2;
  }
  const fixed = process.env.DATA_ANALYST_WORKSPACE;
  const server = createServer(new Session(undefined, fixed ? path.resolve(fixed) : undefined));
  await server.connect(new StdioServerTransport());
  return undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** serve --http: the hosted (remote) mode. */
async function serve(args: string[]): Promise<number | undefined> {
  if (!args.includes("--http")) {
    console.error("usage: data-analyst-mcp serve --http [--port 8080] [--host 0.0.0.0] [--public-url https://...]");
    return 2;
  }
  const port = Number(flag(args, "--port") || process.env.PORT || 8080);
  const host = flag(args, "--host") || process.env.HOST || "127.0.0.1";
  const publicUrl = flag(args, "--public-url") || process.env.DATA_ANALYST_PUBLIC_URL || `http://localhost:${port}`;
  const accounts = process.env.DATA_ANALYST_ACCOUNTS === "1", token = process.env.DATA_ANALYST_AUTH_TOKEN;
  if (!LOOPBACK.has(host) && !accounts && !token && process.env.DATA_ANALYST_OPEN !== "1") {
    console.error(`refusing to serve on ${host} without authentication: anyone who can reach it could use the operator's ` +
      "keys and quotas. Choose one: DATA_ANALYST_ACCOUNTS=1 (OAuth sign-in, per-user keys; needs DATA_ANALYST_SECRET), " +
      "DATA_ANALYST_AUTH_TOKEN=<token> (one shared bearer token), or DATA_ANALYST_OPEN=1 (open on purpose).");
    return 2;
  }
  const { createApp } = await import("../remote/app.js");
  const { app } = createApp({ publicUrl, accounts: process.env.DATA_ANALYST_ACCOUNTS === "1",
    authToken: process.env.DATA_ANALYST_AUTH_TOKEN || undefined, trustProxy: process.env.DATA_ANALYST_TRUST_PROXY === "1",
    callsPerMinute: Number(process.env.DATA_ANALYST_CALLS_PER_MINUTE || 240),
    idleMinutes: Number(process.env.DATA_ANALYST_IDLE_MINUTES || 120) });
  app.listen(port, host, () => {
    console.error(`data-analyst-mcp ${VERSION}: MCP at ${new URL("/mcp", publicUrl)} (listening on ${host}:${port})` +
      (process.env.DATA_ANALYST_ACCOUNTS === "1" ? ", OAuth accounts on" : process.env.DATA_ANALYST_AUTH_TOKEN ? ", bearer token" : ", open"));
  });
  return undefined;
}

main().then((code) => {
  if (code !== undefined) process.exit(code);
}).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(3);
});
