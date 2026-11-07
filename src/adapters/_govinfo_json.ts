/**
 * Work-around for a core gap (used by several adapters): core's flatten() writes a list of objects as JSON text
 * with pyJsonDumps, but parsePyJson has already turned a whole-number float (447500.0) into the string
 * "447500.0", so the text says "447500.0" (quoted) where Python's json.dumps wrote 447500.0. This client wrapper
 * hands generic-rest records whose lists of objects are already Python's json.dumps text (from the exact number
 * tokens); flatten() keeps a string as it is, so the CSV cell is byte-identical to Python's.
 */
import type { Client, Response } from "../core/http.js";
import type { Pack } from "../core/packs.js";
import { dig } from "../core/generic-rest.js";
import { pyFloatRepr, urlsplit } from "../core/py.js";

class PyNum {
  constructor(public src: string) {}
}

function parseExact(text: string): unknown {
  return JSON.parse(text, function (_k: string, v: unknown, ctx?: { source?: string }) {
    return typeof v === "number" && ctx?.source ? new PyNum(ctx.source) : v;
  } as any);
}

const isInt = (src: string) => /^-?\d+$/.test(src);

function numText(n: PyNum): string {
  return isInt(n.src) ? BigInt(n.src).toString() : pyFloatRepr(Number(n.src));
}

/** json.dumps(v, ensure_ascii=False). */
function dumps(v: unknown): string {
  if (v instanceof PyNum) return numText(v);
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(dumps).join(", ") + "]";
  return "{" + Object.entries(v as object).map(([k, x]) => `${JSON.stringify(k)}: ${dumps(x)}`).join(", ") + "}";
}

/** The value parsePyJson would have given. */
function plain(v: unknown): unknown {
  if (v instanceof PyNum) {
    const n = Number(v.src);
    if (isInt(v.src)) return Number.isSafeInteger(n) ? n : v.src.replace(/^(-?)0+(?=\d)/, "$1");
    const repr = pyFloatRepr(n);
    return repr === String(n) ? n : repr;
  }
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = plain(x);
    return o;
  }
  return v;
}

const scalar = (x: unknown) => typeof x === "string" || typeof x === "boolean" || x instanceof PyNum;

/** In place, as flatten() walks a record: a non-empty list holding a non-scalar becomes its json.dumps text. */
function walk(rec: unknown): void {
  if (!rec || typeof rec !== "object" || Array.isArray(rec) || rec instanceof PyNum) return;
  const o = rec as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) {
      if (v.length && !v.every(scalar)) o[k] = dumps(v);
    } else if (v && typeof v === "object" && !(v instanceof PyNum)) walk(v);
  }
}

function recordsPath(pack: Pack, p: string): string | null {
  const bare = p.split("?")[0];
  for (const ep of Object.values<any>(pack.endpoints?.endpoints || {})) {
    if (!ep.path) continue;
    const rx = new RegExp("^/?" + String(ep.path).replace(/^\/+/, "").split(/\{[^}]+\}/)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/?]+") + "$");
    if (rx.test(bare)) return ep.records ?? "";
  }
  return null;
}

/** The client, with JSON records shaped so flatten() writes lists of objects as Python did. `records` is the
 * endpoint's records path when the caller knows it (endpoints that share a path may keep different records);
 * otherwise it is found from the request path. */
export function pyJsonClient(client: Client, pack: Pack, records?: string): Client {
  const w = Object.create(client) as Client;
  w.request = async (method, p = "", params, o = {}) => {
    const r = await client.request(method, p, params, o);
    let rel = p;
    if (/^https?:\/\//.test(p)) {                 // a next-page link: its path below the client's base
      const u = urlsplit(p), basePath = urlsplit(client.base).path.replace(/\/+$/, "");
      rel = u.path.startsWith(basePath) ? u.path.slice(basePath.length) : u.path;
    }
    const rp = records ?? recordsPath(pack, rel);
    if (rp === null || rp.startsWith("$")) return r;
    const out = Object.create(r) as Response;
    out.json = <T = any>(): T => {
      const data = parseExact(r.text());
      const recs = dig(data, rp);
      if (Array.isArray(recs)) recs.forEach(walk);
      else walk(recs);
      return plain(data) as T;
    };
    return out;
  };
  return w;
}
