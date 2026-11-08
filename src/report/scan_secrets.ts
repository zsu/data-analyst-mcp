/**
 * Check that no API key or credential appears in any output file (a port of report/scan_secrets.py). Never
 * reports a key: hits name the file and line only.
 *
 * Scans every file (large files in chunks, and every member of a .zip such as replication_package.zip,
 * decompressed) for:
 *   - the literal value of every key core/keys.ts can find for any source pack, in any letter case
 *   - key-shaped assignments and URL parameters: <PACK>_API_KEY=..., "api_key": "...", ?api_key=<16+>,
 *     registrationkey=<hex>, UserID=<GUID> (BEA), BEA's echoed "ParameterName": "USERID", Authorization: Bearer ...
 *     (the placeholders {API_KEY}, [REDACTED] and __NAME__ are fine)
 *   - for sources whose API echoes keys in error text (policy auth.echoes_key: BLS, BEA), any 32-hex token, except
 *     inside data/<id>/ of a source that does not echo keys (its own identifiers) and inside references/ (saved
 *     pages: cache hashes, script ids); a PDF's /ID document ids are not keys either.
 * A page the cite tool downloaded itself (no key sent, no credential in its URL, unchanged since: references/opened.json)
 * is what every visitor gets, so a site key in its own script is not a secret: only the key values are looked for there.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { findKey, secretValues } from "../core/keys.js";
import { CREDENTIAL_PATTERNS } from "../core/secret_patterns.js";
import type { Policy } from "../core/policy.js";
import { allPolicies } from "./policyset.js";

const CHUNK = 1 << 22;
// patterns run on latin1 text (one char per byte), as Python's bytes patterns do
const BASE_PATTERNS = CREDENTIAL_PATTERNS;
const HEX32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;

const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (x) => x.toLowerCase());
const latin1 = (s: string) => Buffer.from(s, "utf8").toString("latin1");

/** Every key the packs can find on this machine (looked up through core/keys.ts, never shown), as latin1 lower case. */
export function knownKeys(policies?: Record<string, Policy>): string[] {
  const P = policies ?? allPolicies();
  for (const p of Object.values(P)) {
    const a: any = p.auth || {};
    if (a.env) findKey(a.env, a.home);
    for (const v of Object.values(a.extra || {})) if (typeof v === "string" && v === v.toUpperCase() && /[A-Z]/.test(v)) findKey(v, a.home);
  }
  return secretValues().filter((s) => s).map((s) => asciiLower(latin1(s)));
}

export function echoSources(policies: Record<string, Policy>): string[] {
  return Object.entries(policies).filter(([, p]) => (p.auth as any)?.echoes_key).map(([sid]) => sid);
}

/** Is the hex at pos the value of a URL query parameter whose name is not a credential (series=, id=)? */
function urlId(buf: string, pos: number): boolean {
  const before = buf.slice(Math.max(0, pos - 200), pos);
  const m = /[?&]([A-Za-z_][\w.-]{0,30})=$/.exec(before);
  return !!m && before.includes("http") && !/key|token|auth|secret|pass|user|reg|sig/i.test(m[1]);
}

function lineCount(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) n++;
  return n;
}

/** Scan a stream of chunks (latin1 text). */
function scanChunks(chunks: Iterable<string>, name: string, keys: string[], hex32 = false, patterns = true): string[] {
  const hits: string[] = [];
  const overlap = Math.max(...keys.map((k) => k.length), 200);
  let prev = "", offsetLine = 1;
  const pats = !patterns ? [] : hex32 ? [...BASE_PATTERNS, HEX32] : BASE_PATTERNS;
  for (const chunk of chunks) {
    if (!chunk) break;
    const buf = prev + chunk;
    const low = keys.length ? asciiLower(buf) : "";
    const prevLines = lineCount(prev);
    const lineOf = (pos: number) => offsetLine + lineCount(buf.slice(0, pos)) - prevLines;
    for (const k of keys) {
      const i = low.indexOf(k);
      if (i >= 0) hits.push(`${name}: line ~${lineOf(i)}: contains an API key value`);
    }
    for (const p of pats) {
      p.lastIndex = 0;
      let m: RegExpExecArray | null, found: RegExpExecArray | null = null;
      while ((m = p.exec(buf))) {
        if (!(p === HEX32 && urlId(buf, m.index))) {
          found = m;
          break;
        }
        if (m[0].length === 0) p.lastIndex++;
      }
      p.lastIndex = 0;
      if (found) {
        const what = p === HEX32 ? "a 32-hex token (a key this source echoes)" : "a hard-coded credential";
        hits.push(`${name}: line ~${lineOf(found.index)}: looks like ${what}`);
      }
    }
    offsetLine += lineCount(chunk);
    prev = buf.slice(-overlap);
  }
  return hits;
}

function* bufferChunks(b: Uint8Array): Generator<string> {
  for (let i = 0; i < b.length; i += CHUNK) yield Buffer.from(b.buffer, b.byteOffset + i, Math.min(CHUNK, b.length - i)).toString("latin1");
}

function* fileChunks(p: string): Generator<string> {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (!n) break;
      yield buf.subarray(0, n).toString("latin1");
    }
  } finally {
    fs.closeSync(fd);
  }
}

const parts = (rel: string) => rel.split(/[\\/]/).filter((x) => x && x !== ".");

/** Is rel (a path or zip member name) inside data/<id>/ of a source in quiet? */
export function otherSourceData(rel: string, quiet: Set<string>): boolean {
  const p = parts(rel);
  return p.some((x, i) => i < p.length - 1 && x === "data" && i + 1 < p.length && quiet.has(p[i + 1]));
}

/** Is rel inside references/ (pages the cite tool saved: cache hashes and script ids, never an API reply)? */
export function referencePage(rel: string): boolean {
  const p = parts(rel);
  return p.length > 0 && p[0] === "references";
}

const hexRule = (rel: string, quiet: Set<string>) => !otherSourceData(rel, quiet) && !referencePage(rel);

/** The files under references/ that the cite tool downloaded itself, from a URL with no credential in it, and that
 *  still have the hash it recorded (references/opened.json): public pages as served to anyone. */
export function publicSnapshots(root: string): Set<string> {
  const out = new Set<string>();
  let log: Record<string, any>;
  try {
    log = JSON.parse(fs.readFileSync(path.join(root, "references", "opened.json"), "utf8"));
  } catch {
    return out;
  }
  for (const r of Object.values(log || {})) {
    if (r?.via !== "download" || typeof r.file !== "string" || typeof r.url !== "string" || !referencePage(r.file)) continue;
    if (scanText(r.url).length) continue;
    const f = path.resolve(root, r.file);
    try {
      if (crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") === r.sha256) out.add(f);
    } catch {
      // gone or unreadable: scanned (or skipped) as any other file
    }
  }
  return out;
}

/** zipfile.is_zipfile: an end-of-central-directory record near the end. */
function isZip(p: string): boolean {
  try {
    const size = fs.statSync(p).size;
    if (size < 22) return false;
    const n = Math.min(size, 65557);
    const fd = fs.openSync(p, "r");
    const b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, size - n);
    fs.closeSync(fd);
    return b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
  } catch {
    return false;
  }
}

export function scanFile(p: string, keys: string[] | string = [], hex32 = false, quiet = new Set<string>(), rel = "",
  patterns = true): string[] {
  const ks = (typeof keys === "string" ? [keys] : keys).filter((k) => k).map(asciiLower);
  const head = Buffer.alloc(5);
  const fd = fs.openSync(p, "r");
  fs.readSync(fd, head, 0, 5, 0);
  fs.closeSync(fd);
  const pdf = head.toString("latin1") === "%PDF-";         // a PDF's trailer /ID holds two 32-hex document ids
  let hits = scanChunks(fileChunks(p), p, ks, hex32 && !pdf && hexRule(rel || p, quiet), patterns);
  if (isZip(p)) {                                          // members are compressed: scan them decompressed too
    try {
      const z = unzipSync(fs.readFileSync(p));
      for (const [name, data] of Object.entries(z)) {
        if (name.endsWith("/")) continue;
        hits = hits.concat(scanChunks(bufferChunks(data), `${p}!${name}`, ks, hex32 && hexRule(name, quiet)));
      }
    } catch {
      // a damaged archive: its raw bytes were scanned above
    }
  }
  return [...new Set(hits)].sort();
}

export function scanText(text: string, keys: string[] = [], hex32 = false, name = "text"): string[] {
  const ks = keys.filter((k) => k).map(asciiLower);
  return scanChunks(bufferChunks(Buffer.from(text, "utf8")), name, ks, hex32);
}

function walk(d: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else if (e.isFile()) out.push(f);
  }
  return out;
}

/** [hits, files scanned] for files and folders. */
export function scanTree(paths: string[], keys: string[], hex32 = false): [string[], number] {
  // data/<id>/ of sources that never echo keys skip the 32-hex rule (their ids look like keys)
  const quiet = hex32 ? new Set(Object.entries(allPolicies()).filter(([, p]) => !(p.auth as any)?.echoes_key).map(([s]) => s))
    : new Set<string>();
  let found: string[] = [], n = 0;
  for (const root of paths) {
    const isFile = fs.existsSync(root) && fs.statSync(root).isFile();
    const files = isFile ? [root] : fs.existsSync(root) ? walk(root) : [];
    const pub = isFile ? new Set<string>() : publicSnapshots(root);
    for (const p of files) {
      n++;
      try {
        const rel = isFile ? p : path.relative(root, p);
        found = found.concat(scanFile(p, keys, hex32, quiet, rel, !pub.has(path.resolve(p))));
      } catch {
        // unreadable: skipped (as the Python scan does, with a note on stderr)
      }
    }
  }
  return [found, n];
}

/** Hits with the folder's own path taken off (workspace-relative names in tool output). */
export function relHits(hits: string[], base: string): string[] {
  const pre = path.resolve(base) + path.sep;
  return hits.map((h) => (h.startsWith(pre) ? h.slice(pre.length).replaceAll("\\", "/") : h));
}

/** The scan_secrets.py command on a folder: sources from data/<id>/ unless given. */
export function scanWorkspace(dir: string, sources?: string[]): { ok: boolean; files: number; hits: string[]; message: string } {
  const policies = allPolicies();
  let ids = sources;
  if (ids === undefined) {
    const d = path.join(dir, "data");
    ids = fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
  }
  const used = Object.fromEntries(ids.filter((s) => s in policies).map((s) => [s, policies[s]]));
  const [raw, n] = scanTree([dir], knownKeys(policies), echoSources(used).length > 0);
  const hits = relHits(raw, dir);
  return hits.length
    ? { ok: false, files: n, hits, message: "SECRET FOUND - remove before sharing:\n" + hits.join("\n") }
    : { ok: true, files: n, hits, message: `OK: scanned ${n} files; no API key or credential found.` };
}
