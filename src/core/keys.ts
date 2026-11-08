/**
 * API key lookup and redaction for every source pack.
 *
 * A pack names its key variable in policy.json (auth.env, e.g. "FRED_API_KEY"). findKey() looks, in order:
 *   0. the per-request key provider (remote mode: the signed-in user's own keys), when one is set
 *   1. the <ENV> environment variable
 *   local mode only:
 *   2. the file named by the <ENV>_FILE environment variable
 *   3. "env": {"<ENV>": "..."} in ~/.config/data-analyst/keys.json ($DATA_ANALYST_CONFIG_DIR), written by
 *      `data-analyst-mcp setup`
 *   4. "env": {"<ENV>": "..."} in Claude Code's settings.json (~/.claude or $CLAUDE_CONFIG_DIR)
 *   5. ~/.<home>/api_key (a file holding only the key); <home> is auth.home in policy.json
 * Files are read on every lookup, so a key stored a moment ago works without a restart.
 * Returns [key, source label]. The label may be shown; the key never is. Every result and error that leaves the
 * server goes through redact(), which removes every key this process has seen plus key-shaped query parameters,
 * headers and JSON fields.
 *
 * DATA_ACCESS_FORCE=restricted hides every key and makes every request fail as a network error (sandbox replay).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mode } from "./env.js";
import { quotePlus } from "./py.js";

const KNOWN = new Set<string>();
export const KEY_FIELDS = ["api_key", "apikey", "api-key", "key", "registrationkey", "userid", "token", "access_token",
  "x-api-key", "authorization", "subscription-key", "user_token"];
/** Patterns a pack adds for keys its API echoes in odd shapes, by pack id ("" = every pack). */
const EXTRA_PATTERNS: { re: RegExp; pack: string }[] = [];
const packScope = new AsyncLocalStorage<string[]>();

/** Run fn as a call for one or more packs: those packs' own redaction patterns apply inside it. */
export function withPackScope<T>(pack: string | string[], fn: () => T): T {
  return packScope.run(Array.isArray(pack) ? pack : [pack], fn);
}

/** Secrets of this server itself (never a pack's key): the signing secret, the bearer token, contact strings. */
export const SERVER_SECRETS = ["DATA_ANALYST_SECRET", "DATA_ANALYST_AUTH_TOKEN", "NWS_USER_AGENT", "SEC_USER_AGENT"];

/** Add the server's own secrets from the environment to the redaction set (call once at startup). */
export function rememberServerSecrets(): void {
  for (const env of SERVER_SECRETS) remember((process.env[env] || "").trim());
}

export type Auth = {
  env?: string | null; alt_env?: string[]; required?: "required" | "optional" | "none";
  placement?: "query" | "header" | "body" | "none"; param?: string | null; prefix?: string; home?: string | null;
  extra?: Record<string, string>; demo_key?: string; signup_url?: string | null; key_only?: string[];
  [k: string]: unknown;
};

/** A per-request key source (remote mode: the signed-in user's keys). Returns undefined for "not stored". */
export type KeyProvider = (env: string) => string | undefined;
const provider = new AsyncLocalStorage<KeyProvider>();

export function withKeyProvider<T>(p: KeyProvider, fn: () => T): T {
  return provider.run(p, fn);
}

export function restricted(): boolean {
  return (process.env.DATA_ACCESS_FORCE || "").trim().toLowerCase() === "restricted";
}

export function configPath(): string {
  const cfg = process.env.DATA_ANALYST_CONFIG_DIR || path.join(os.homedir(), ".config", "data-analyst");
  return path.join(cfg, "keys.json");
}

export function settingsPath(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(cfg, "settings.json");
}

function readEnvJson(p: string, env: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
    const v = data && typeof data === "object" ? (data.env || {})[env] : undefined;
    return String(v ?? "").trim();
  } catch {
    return "";
  }
}

function readKeyFile(p: string): string {
  try {
    return fs.readFileSync(p, "utf8").replace(/^﻿/, "").split(/\r?\n/)[0].trim();
  } catch {
    return "";
  }
}

export function defaultHome(env: string): string {
  return env.toLowerCase().replace("_api_key", "").replaceAll("_", "-");
}

export function keyLocations(env: string, home?: string | null): string[] {
  if (mode() === "remote") return [`the ${env} secret on the server, or your own key on the server's settings page`];
  const h = home || defaultHome(env);
  return [`the ${env} environment variable`, `the file named by the ${env}_FILE environment variable`,
    `"env": {"${env}": "..."} in ${configPath()} (data-analyst-mcp setup writes it)`,
    `"env": {"${env}": "..."} in Claude Code's ${settingsPath()}`, `~/.${h}/api_key (a file holding only the key)`];
}

/** Locate the key named env. Returns [key, source]; [null, null] when absent or restricted. */
export function findKey(env?: string | null, home?: string | null): [string | null, string | null] {
  if (!env || restricted()) return [null, null];
  let found: [string | null, string | null] = [null, null];
  const p = provider.getStore();
  const own = p ? (p(env) || "").trim() : "";
  if (own) found = [own, "your stored key"];
  const ev = (process.env[env] || "").trim();
  if (!found[0] && ev) found = [ev, `${env} environment variable`];
  if (!found[0] && mode() === "local") {
    const kf = process.env[`${env}_FILE`];
    if (kf) {
      const k = readKeyFile(kf);
      if (k) found = [k, `file named by ${env}_FILE`];
    }
    for (const [label, file] of [["keys.json", configPath()], ["settings.json", settingsPath()]] as const) {
      if (found[0]) break;
      const k = readEnvJson(file, env);
      if (k) found = [k, `${label} (${file})`];
    }
    if (!found[0]) {
      const file = path.join(os.homedir(), `.${home || defaultHome(env)}`, "api_key");
      const k = readKeyFile(file);
      if (k) found = [k, file];
    }
  }
  if (found[0]) remember(found[0]);
  return found;
}

/** The key for a pack's auth block: auth.env first, then each auth.alt_env. */
export function findAuthKey(auth: Auth): [string | null, string | null] {
  let [key, src] = findKey(auth.env, auth.home);
  for (const alt of key ? [] : auth.alt_env || []) {
    [key, src] = findKey(alt);
    if (key) break;
  }
  return [key, src];
}

/** The forms a secret takes in text: as is, URL-encoded (upper and lower hex, %20 and +), JSON-escaped. */
function forms(secret: string): string[] {
  const out = new Set([secret]);
  try {
    out.add(encodeURIComponent(secret));
  } catch {
    // a lone surrogate: it has no URL form
  }
  out.add(quotePlus(secret));
  for (const v of [...out]) out.add(v.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  out.add(JSON.stringify(secret).slice(1, -1));
  return [...out].filter((v) => v.length >= 6);
}

/** Add a secret to the redaction set (keys passed in, tokens returned by an API), in every form it can be echoed in. */
export function remember(secret: string | null | undefined): void {
  if (secret && secret.length >= 6) for (const f of forms(secret)) KNOWN.add(f);
}

const known = () => [...KNOWN].sort((a, b) => b.length - a.length);

/** A file's text with every known secret (in every form) replaced: [text, changed]. Data patterns are left alone. */
export function scrubText(text: string): [string, boolean] {
  let out = text;
  for (const k of known()) if (out.includes(k)) out = out.split(k).join("[REDACTED]");
  return [out, out !== text];
}

/** scrubText for bytes (a raw response): unchanged bytes when no secret is in them. */
export function scrubBytes(buf: Buffer): [Buffer, boolean] {
  let out = buf;
  let changed = false;
  const mark = Buffer.from("[REDACTED]");
  for (const k of known()) {
    const kb = Buffer.from(k, "utf8");
    if (out.indexOf(kb) < 0) continue;
    const parts: Buffer[] = [];
    let at = 0;
    for (let i = out.indexOf(kb); i >= 0; i = out.indexOf(kb, at)) {
      parts.push(out.subarray(at, i), mark);
      at = i + kb.length;
    }
    parts.push(out.subarray(at));
    out = Buffer.concat(parts);
    changed = true;
  }
  return [out, changed];
}

/** Does the text hold a known secret, in any form? */
export function holdsSecret(text: string | Buffer): boolean {
  return [...KNOWN].some((k) => text.includes(k));
}

/** A pack whose API echoes keys in odd shapes adds a pattern (BLS: 32-hex tokens in error text). */
/**
 * A pack whose API echoes keys in odd shapes adds a pattern (BLS: 32-hex tokens in error text). It applies only
 * inside that pack's calls (withPackScope): in one server process every pack is loaded, and a pattern from one
 * pack must not redact another pack's data (a 32-hex series hash). pack "" applies everywhere.
 */
export function addPattern(regex: string | RegExp, pack: string): void {
  EXTRA_PATTERNS.push({ re: new RegExp(regex, "g"), pack });
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

export function redact(value: unknown): string {
  let text = typeof value === "string" ? value : String(value);
  for (const k of known()) text = text.split(k).join("[REDACTED]");
  const names = KEY_FIELDS.map(esc).join("|");
  text = text.replace(new RegExp(`([?&](?:${names})=)[^&\\s'"#]+`, "gi"), "$1[REDACTED]");
  text = text.replace(new RegExp(`(["'](?:${names})["']\\s*:\\s*["'])[^"']+`, "gi"), "$1[REDACTED]");
  // a credential is a run of token characters; prose such as "Bearer <token>" is left alone
  text = text.replace(/(authorization:\s*(?:(?:bearer|basic|token)\s+)?)(?!(?:bearer|basic|token)\b)[A-Za-z0-9._~+/=-]{6,}/gi,
    "$1[REDACTED]");
  // key headers written as lines (X-Api-Key: <value>); a value holds a digit, so prose after the colon is left alone
  text = text.replace(/((?:x-api-key|api-key|x-api-token|(?:ocp-apim-)?subscription-key):\s*)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/gi,
    "$1[REDACTED]");
  const scope = packScope.getStore() || [];
  for (const p of EXTRA_PATTERNS) if (!p.pack || scope.includes(p.pack)) text = text.replace(p.re, "[REDACTED]");
  return text;
}

/** Redact every string inside a JSON-like value (tool results). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

/** Every secret this process knows, for scanning outputs (never printed). */
export function secretValues(): string[] {
  return [...KNOWN].sort();
}
