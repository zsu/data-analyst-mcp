/**
 * Disk cache for raw downloads, used only when a pack's policy allows it.
 * - <cacheRoot>/<namespace>/<sha256(key)>.bin with a .meta.json sidecar {key, stored, ...meta}
 * - the key is a credential-free URL (plus a body hash for POST), so no secret is ever written
 * - atomic writes, 0600 files where the OS supports it; entries over MAX_ENTRY are not cached
 * - entries untouched for STALE_DAYS are dropped, then the least recently used beyond MAX_TOTAL
 * policy cache.mode: "none" and "run_only" refuse every get and put; "persistent" caches for ttl_hours.
 * Remote mode never caches across users' sessions unless DATA_ANALYST_CACHE is set by the operator.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cacheRoot, mode } from "./env.js";
import type { Policy } from "./policy.js";

const MAX_ENTRY = 512 * 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024 * 1024;
const STALE_DAYS = 30;

export class Cache {
  mode: string;
  ttl: number;
  on: boolean;
  dir: string;

  constructor(namespace: string, policy: Policy, enabled = true) {
    this.mode = policy.cache.mode;
    this.ttl = Number(policy.cache.ttl_hours || 24) * 3600;
    this.on = enabled && this.mode === "persistent" && (mode() === "local" || !!process.env.DATA_ANALYST_CACHE);
    this.dir = path.join(cacheRoot(), namespace);
    if (this.on) fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private paths(key: string): [string, string] {
    const h = createHash("sha256").update(key).digest("hex");
    return [path.join(this.dir, h + ".bin"), path.join(this.dir, h + ".meta.json")];
  }

  get(key: string, maxAgeHours?: number): [Buffer, any] | null {
    if (!this.on) return null;
    const [dataP, metaP] = this.paths(key);
    try {
      const meta = JSON.parse(fs.readFileSync(metaP, "utf8"));
      const ttl = maxAgeHours !== undefined ? maxAgeHours * 3600 : this.ttl;
      if (Date.now() / 1000 - meta.stored > ttl) return null;
      const data = fs.readFileSync(dataP);
      const now = new Date();
      fs.utimesSync(metaP, now, now);
      return [data, meta];
    } catch {
      return null;
    }
  }

  /** Path of a cached file (for large bulk files read in place). */
  path(key: string): string | null {
    return this.get(key) === null ? null : this.paths(key)[0];
  }

  put(key: string, data: Buffer, meta: Record<string, unknown> = {}): string | null {
    if (!this.on || data.length > MAX_ENTRY) return null;
    const [dataP, metaP] = this.paths(key);
    for (const [target, payload] of [[dataP, data], [metaP, Buffer.from(JSON.stringify({ key, stored: Date.now() / 1000, ...meta }))]] as const) {
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      fs.renameSync(tmp, target);
    }
    this.sweep();
    return dataP;
  }

  sweep(): void {
    try {
      const entries = fs.readdirSync(this.dir).filter((n) => n.endsWith(".meta.json")).map((n) => {
        const p = path.join(this.dir, n);
        const bin = p.replace(/\.meta\.json$/, ".bin");
        const st = fs.statSync(p);
        return { meta: p, bin, atime: st.mtimeMs, size: fs.existsSync(bin) ? fs.statSync(bin).size : 0 };
      }).sort((a, b) => b.atime - a.atime);
      let total = 0;
      for (const e of entries) {
        total += e.size;
        if (Date.now() - e.atime > STALE_DAYS * 86400000 || total > MAX_TOTAL) {
          fs.rmSync(e.meta, { force: true });
          fs.rmSync(e.bin, { force: true });
        }
      }
    } catch {
      /* a sweep never fails a fetch */
    }
  }
}
