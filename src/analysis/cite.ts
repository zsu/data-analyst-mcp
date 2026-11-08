/**
 * Snapshots of the pages a method record cites, so "opened": true is a fact a tool wrote, not a claim (a port of
 * scripts/core/cite.py).
 *
 * Each call saves <workspace>/references/<id>.<ext> and records it in references/opened.json:
 * {"<id>": {"url", "file", "sha256", "bytes", "opened" (UTC time), "via": "download" | "file", "content_type"}}.
 * The method audit accepts "opened": true on a reference only with such a record whose file still has that hash,
 * and looks for the reference's "quote" in it. `text` is what the model's own fetch tool returned (via "file", as
 * Python's --from-file); without it the page is downloaded through core/http.ts.
 *
 * Remote mode: a download never reaches a private or loopback address. The host is resolved first and every
 * address checked (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8, 100.64/10, ::1, ::, fc00::/7, fe80::/10,
 * and IPv4-mapped forms), and the connection itself uses a lookup that refuses them again (no DNS rebinding),
 * on every redirect.
 */
import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { mode } from "../core/env.js";
import { Client, DataError, UA } from "../core/http.js";
import { restricted } from "../core/keys.js";

export const ID_RE = /^[A-Za-z0-9_-]+$/;
export const MAX_BYTES = 30 * 1024 * 1024;
const EXT: [string, string][] = [["html", ".html"], ["pdf", ".pdf"], ["json", ".json"], ["xml", ".xml"], ["text/plain", ".txt"],
  ["markdown", ".md"]];

export class CiteError extends Error {
  constructor(message: string, public url?: string) {
    super(message);
  }
}

function ext(contentType: string, body: Buffer): string {
  const ct = (contentType || "").toLowerCase();
  for (const [k, e] of EXT) if (ct.includes(k)) return e;
  if (body.subarray(0, 5).toString("latin1") === "%PDF-") return ".pdf";
  const head = body.subarray(0, 300).toString("latin1").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") ? ".html" : ".txt";
}

export type OpenedRecord = { url: string; file: string; sha256: string; bytes: number; opened: string; via: string;
  content_type: string };

function record(ws: string, refId: string, url: string, data: Buffer, e: string, via: string, contentType: string): OpenedRecord {
  const d = path.join(ws, "references");
  fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(d)) {                  // one snapshot per reference: drop an earlier one in another format
    if (path.parse(f).name === refId && f !== refId + e && f !== "opened.json") fs.rmSync(path.join(d, f));
  }
  const rel = `references/${refId}${e}`;
  fs.writeFileSync(path.join(ws, rel), data);
  const logPath = path.join(d, "opened.json");
  let log: Record<string, OpenedRecord> = {};
  if (fs.existsSync(logPath)) {
    try {
      log = JSON.parse(fs.readFileSync(logPath, "utf8"));
    } catch {
      log = {};
    }
  }
  const rec: OpenedRecord = { url, file: rel, sha256: crypto.createHash("sha256").update(data).digest("hex"), bytes: data.length,
    opened: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), via, content_type: contentType };
  log[refId] = rec;
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  return rec;
}

// ---------------------------------------------------------------------- private addresses
function v4(a: string): number[] | null {
  const p = a.split(".").map(Number);
  return p.length === 4 && p.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? p : null;
}

/** Is an address private, loopback, link-local or otherwise not a public host? */
export function privateAddress(addr: string): boolean {
  let a = addr.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  const p = v4(a);
  if (p) {
    const [x, y] = p;
    return x === 10 || x === 127 || x === 0 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) ||
      (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127) || x >= 224;
  }
  if (net.isIPv6(a)) {
    if (a === "::1" || a === "::") return true;
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);        // ::ffff:7f00:1
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return privateAddress([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
    }
    const first = parseInt(a.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;                                             // not an address at all: refuse
}

const OWN_HOSTS = new Set<string>();
/** Hosted mode: this server's own public host, whose pages (the keys page, signed links) are never opened. */
export function setOwnHost(publicUrl: string): void {
  OWN_HOSTS.add(new URL(publicUrl).hostname.toLowerCase());
}

/** Refuse a URL whose host is or resolves to a private address, or is this server itself. */
export async function checkPublicHost(url: string): Promise<void> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw new CiteError(`not a valid URL: ${url}`);
  }
  if (OWN_HOSTS.has(host.toLowerCase())) throw new CiteError("refused: this server's own pages are never opened", url);
  if (net.isIP(host)) {
    if (privateAddress(host)) throw new CiteError(`refused: ${host} is a private or loopback address; this server opens public pages only`, url);
    return;
  }
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (e: any) {
    throw new CiteError(`could not resolve ${host} (${e?.code || e?.message || e})`, url);
  }
  const bad = addrs.filter((a) => privateAddress(a.address));
  if (!addrs.length || bad.length) {
    throw new CiteError(`refused: ${host} resolves to a private or loopback address (${bad.map((a) => a.address).join(", ") || "none"}); ` +
      "this server opens public pages only", url);
  }
}

const guardedLookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
    if (err) return (cb as any)(err);
    const list = addrs as unknown as dns.LookupAddress[];
    const bad = list.find((a) => privateAddress(a.address));
    if (bad || !list.length) return (cb as any)(new Error(`refused private address ${bad?.address ?? "(none)"} for ${hostname}`));
    if ((options as any).all) return (cb as any)(null, list);
    (cb as any)(null, list[0].address, list[0].family);
  });
};

/** GET with redirects followed by hand, every connection through the guarded lookup (remote mode). */
export async function guardedGet(url: string, timeout: number): Promise<{ status: number; body: Buffer; contentType: string }> {
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    await checkPublicHost(cur);
    const u = new URL(cur);
    const lib = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!lib) throw new CiteError(`refused: ${u.protocol} is not http(s)`, url);
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = lib.request(u, { method: "GET", headers: { "User-Agent": UA, Accept: "*/*" }, lookup: guardedLookup, timeout: timeout * 1000 },
        (r) => {
          const chunks: Buffer[] = [];
          let n = 0;
          r.on("data", (c: Buffer) => {
            n += c.length;
            if (n <= MAX_BYTES + 1) chunks.push(c);
            if (n > MAX_BYTES + 1) r.destroy();
          });
          r.on("end", () => resolve({ status: r.statusCode || 0, headers: r.headers, body: Buffer.concat(chunks) }));
          r.on("close", () => resolve({ status: r.statusCode || 0, headers: r.headers, body: Buffer.concat(chunks) }));
          r.on("error", reject);
        });
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      cur = new URL(String(res.headers.location), cur).toString();
      continue;
    }
    return { status: res.status, body: res.body, contentType: String(res.headers["content-type"] || "") };
  }
  throw new CiteError(`too many redirects opening ${url}`, url);
}

export type CiteResult = { status: "ok"; id: string; next: string } & OpenedRecord;

/** Save the page and record it. Throws CiteError with cite.py's messages. */
export async function cite(workspace: string, a: { url: string; id: string; text?: string; timeout?: number }): Promise<CiteResult> {
  const { url, id } = a;
  if (!ID_RE.test(id || "")) throw new CiteError(`id ${JSON.stringify(id)}: letters, digits, _ and - only (the [@id] you cite)`);
  if (!/^https?:\/\//i.test(url || "")) throw new CiteError("cite needs the page's http(s) URL (the url in references)");
  let rec: OpenedRecord;
  if (a.text !== undefined && a.text !== null) {
    const data = Buffer.from(a.text, "utf8").subarray(0, MAX_BYTES);
    if (!a.text.trim()) throw new CiteError("text is empty: pass the text your fetch tool returned for the page");
    rec = record(workspace, id, url, data, ext("", data), "file", "");
  } else {
    let body: Buffer, ctype: string;
    try {
      if (mode() === "remote" && !process.env.DATA_ANALYST_FIXTURES) {
        if (restricted()) throw new CiteError("network access is switched off (DATA_ACCESS_FORCE=restricted)", url);
        const r = await guardedGet(url, a.timeout ?? 30);
        if (r.status !== 200) {
          throw new CiteError(`HTTP ${r.status} opening ${url}: check the URL; never cite a page you could not open`, url);
        }
        [body, ctype] = [r.body, r.contentType];
      } else {
        if (mode() === "remote") await checkPublicHost(url);
        const c = new Client("", { name: "cite", retries: 1, timeout: a.timeout ?? 30 });
        const r = await c.get(url);
        [body, ctype] = [r.body, r.headers["content-type"] || ""];
      }
    } catch (e: any) {
      if (e instanceof CiteError && (e.message.startsWith("refused") || e.message.startsWith("HTTP"))) throw e;
      if (e instanceof DataError && e.status && e.status >= 400) {
        throw new CiteError(`HTTP ${e.status} opening ${url}: check the URL; never cite a page you could not open`, url);
      }
      throw new CiteError(`could not open ${url} from here (${e?.message || e}). If your own fetch tool can read the page, call ` +
        "cite again with text: the text it returned; otherwise do not mark the reference opened", url);
    }
    if (body.length > MAX_BYTES) body = body.subarray(0, MAX_BYTES);
    rec = record(workspace, id, url, body, ext(ctype, body), "download", ctype);
  }
  return { status: "ok", id, ...rec,
    next: `in decisions.json references: {"id": "${id}", "citation": ..., "url": "${url}", "accessed": "${rec.opened.slice(0, 10)}", ` +
      '"opened": true, "used_for": ..., "quote": "<a sentence from the page that supports the use>"}' };
}
