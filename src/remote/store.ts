/**
 * Server state for remote mode: OAuth clients, authorization codes, tokens, and each account's API keys.
 *
 * Keys are encrypted at rest with AES-256-GCM under a key derived from DATA_ANALYST_SECRET (per account, a fresh
 * IV per write). They are decrypted only in memory when a tool call needs one, and no tool, page or log ever
 * returns them: the keys page shows only which variables are set. Tokens are stored as SHA-256 hashes.
 * State lives in DATA_ANALYST_STATE_DIR (default <workspace root>/state), files 0600.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../core/env.js";
import { remember } from "../core/keys.js";
import { derivedKey, legacySecret } from "./sign.js";

export function stateDir(): string {
  const d = process.env.DATA_ANALYST_STATE_DIR || path.join(workspaceRoot(), "state");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function load<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), name), "utf8"));
  } catch {
    return fallback;
  }
}

function save(name: string, data: unknown): void {
  const p = path.join(stateDir(), name);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------- key encryption
function keyFor(account: string, legacy = false): Buffer {
  return crypto.createHmac("sha256", legacy ? legacySecret() : derivedKey("keys")).update(`keys:${account}`).digest();
}

function encrypt(account: string, data: Record<string, string>): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFor(account), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(data), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

function decryptWith(key: Buffer, blob: string): Record<string, string> {
  const [iv, tag, enc] = blob.split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString("utf8"));
}

/** Keys stored by an earlier version (one key for signing and encryption) still open; the next write re-encrypts them. */
function decrypt(account: string, blob: string): Record<string, string> {
  try {
    return decryptWith(keyFor(account), blob);
  } catch {
    return decryptWith(keyFor(account, true), blob);
  }
}

// ---------------------------------------------------------------------- accounts and their keys
type Accounts = Record<string, { created: number; code_hash: string; keys?: string }>;

export function createAccount(): { id: string; code: string } {
  const a = load<Accounts>("accounts.json", {});
  const id = crypto.randomBytes(9).toString("base64url");
  const code = crypto.randomBytes(12).toString("base64url");
  a[id] = { created: Date.now(), code_hash: hash(code) };
  save("accounts.json", a);
  return { id, code };
}

/** The account a code belongs to (the code is shown to the user once, to reconnect later with the same keys). */
export function accountByCode(code: string): string | null {
  const h = hash(code.trim());
  const a = load<Accounts>("accounts.json", {});
  return Object.entries(a).find(([, v]) => v.code_hash === h)?.[0] ?? null;
}

export function accountExists(id: string): boolean {
  return !!load<Accounts>("accounts.json", {})[id];
}

/** Merge keys into the account (an empty value removes that variable). */
export function setKeys(account: string, keys: Record<string, string>): string[] {
  const a = load<Accounts>("accounts.json", {});
  if (!a[account]) throw new Error("unknown account");
  const cur = a[account].keys ? decrypt(account, a[account].keys!) : {};
  for (const [k, v] of Object.entries(keys)) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(k)) continue;
    if (v.trim()) cur[k] = v.trim();
    else delete cur[k];
  }
  a[account].keys = encrypt(account, cur);
  save("accounts.json", a);
  return Object.keys(cur).sort();
}

/** The names of the variables the account has stored (never the values). */
export function keyNames(account: string): string[] {
  const a = load<Accounts>("accounts.json", {})[account];
  return a?.keys ? Object.keys(decrypt(account, a.keys)).sort() : [];
}

/** A key lookup for one account (keys.ts withKeyProvider); every value it returns joins the redaction set. */
export function keyProvider(account: string): (env: string) => string | undefined {
  // read on every lookup: a key the user stores mid-session works on the next call
  return (env) => {
    const a = load<Accounts>("accounts.json", {})[account];
    const v = a?.keys ? decrypt(account, a.keys)[env] : undefined;
    if (v) remember(v);
    return v;
  };
}

// ---------------------------------------------------------------------- OAuth clients, codes and tokens
export function getClient(id: string): any | undefined {
  return load<Record<string, any>>("clients.json", {})[id];
}

export function putClient(c: any): void {
  const all = load<Record<string, any>>("clients.json", {});
  all[c.client_id] = c;
  save("clients.json", all);
}

type Grant = { kind: "code" | "access" | "refresh"; client: string; account: string; exp: number; challenge?: string;
  redirect?: string; scopes?: string[]; resource?: string };

export function putGrant(token: string, g: Grant): void {
  const all = load<Record<string, Grant>>("grants.json", {});
  const now = Date.now() / 1000;
  for (const [k, v] of Object.entries(all)) if (v.exp < now) delete all[k];
  all[hash(token)] = g;
  save("grants.json", all);
}

export function getGrant(token: string, kind: Grant["kind"]): Grant | null {
  const g = load<Record<string, Grant>>("grants.json", {})[hash(token)];
  return g && g.kind === kind && g.exp > Date.now() / 1000 ? g : null;
}

export function dropGrant(token: string): void {
  const all = load<Record<string, Grant>>("grants.json", {});
  delete all[hash(token)];
  save("grants.json", all);
}
