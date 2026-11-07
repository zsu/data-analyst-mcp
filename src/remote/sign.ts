/**
 * Signed, expiring capability tokens for links the server hands out (downloads, the upload page, the keys page).
 * token = base64url(JSON payload) "." base64url(HMAC-SHA256). The secret is DATA_ANALYST_SECRET (required when
 * accounts are on, so links and stored keys survive restarts), else a random per-process secret.
 */
import crypto from "node:crypto";

let secret: Buffer | null = null;

export function serverSecret(): Buffer {
  if (!secret) {
    const s = process.env.DATA_ANALYST_SECRET;
    secret = s ? crypto.createHash("sha256").update(s).digest() : crypto.randomBytes(32);
  }
  return secret;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function sign(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const mac = crypto.createHmac("sha256", serverSecret()).update(body).digest();
  return `${body}.${b64(mac)}`;
}

/** The payload of a valid, unexpired token of the given kind; null otherwise. */
export function verify<T = Record<string, any>>(token: string, kind: string): T | null {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return null;
  const want = crypto.createHmac("sha256", serverSecret()).update(body).digest();
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
