/**
 * Signed, expiring capability tokens for links the server hands out (downloads, the upload page, the keys page).
 * token = base64url(JSON payload) "." base64url(HMAC-SHA256). The secret is DATA_ANALYST_SECRET (required when
 * accounts are on, so links and stored keys survive restarts), else a random per-process secret.
 *
 * Two keys are derived from the secret with HKDF-SHA256, one per use: "sign" for these tokens and "keys" for the
 * encryption of stored API keys (store.ts), so one never stands in for the other.
 */
import crypto from "node:crypto";

export const MIN_SECRET = 32;
let raw: Buffer | null = null;
const derived = new Map<string, Buffer>();

function secretBytes(): Buffer {
  if (!raw) {
    const s = process.env.DATA_ANALYST_SECRET;
    raw = s ? Buffer.from(s, "utf8") : crypto.randomBytes(32);
  }
  return raw;
}

/** Refuse a DATA_ANALYST_SECRET too short to resist guessing (a link's payload is readable, so it can be tried offline). */
export function checkSecret(): void {
  const s = process.env.DATA_ANALYST_SECRET || "";
  if (s.length < MIN_SECRET) {
    throw new Error(`DATA_ANALYST_SECRET must be at least ${MIN_SECRET} characters (it signs every link and encrypts ` +
      "stored keys); generate one with: openssl rand -base64 48");
  }
}

/** The key for one use ("sign", "keys"), derived from the secret. */
export function derivedKey(use: "sign" | "keys"): Buffer {
  let k = derived.get(use);
  if (!k) {
    k = Buffer.from(crypto.hkdfSync("sha256", secretBytes(), Buffer.alloc(0), `data-analyst/${use}`, 32));
    derived.set(use, k);
  }
  return k;
}

/** The key earlier versions used for both signing and encryption: kept only to read keys stored before. */
export function legacySecret(): Buffer {
  return crypto.createHash("sha256").update(secretBytes()).digest();
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function sign(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const mac = crypto.createHmac("sha256", derivedKey("sign")).update(body).digest();
  return `${body}.${b64(mac)}`;
}

/** The payload of a valid, unexpired token of the given kind; null otherwise. */
export function verify<T = Record<string, any>>(token: string, kind: string): T | null {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return null;
  const want = crypto.createHmac("sha256", derivedKey("sign")).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (p.k !== kind || typeof p.exp !== "number" || p.exp < Date.now() / 1000) return null;
    return p as T;
  } catch {
    return null;
  }
}
