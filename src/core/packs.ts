/**
 * Find and load source packs (packs/<id>/: policy.json, source.md, endpoints.json, docs/, assets/).
 *
 * A standard pack is run by core (generic-rest + package) from its endpoints.json, plus an optional adapter
 * (src/adapters/<id>.ts) for what endpoints.json cannot express. A deep pack (src/deep/<id>.ts) has its own
 * operations. packs/port.json lists the packs whose Python version had code beyond endpoints.json; such a pack
 * is "not ported" until its TypeScript code is registered, and the server says so instead of guessing.
 */
import fs from "node:fs";
import path from "node:path";
import { findAdapter, findDeep } from "../adapters/index.js";
import type { Client } from "./http.js";
import { PACKS_DIR } from "./env.js";
import { findAuthKey } from "./keys.js";
import * as pol from "./policy.js";
import type { Policy } from "./policy.js";

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[] | import("./package.js").FileTable>;
export type SpecRequest = { name: string; endpoint?: string; dataset?: string; params?: Record<string, unknown>;
  max_rows?: number; allow_empty?: boolean; for_each?: any; [k: string]: any };
export type Spec = { description?: string; requests: SpecRequest[]; [k: string]: any };

/**
 * What a key check (an adapter's or deep pack's ping) found. kind "" or "ok": the key was accepted; "auth" or
 * "key_missing": rejected; "network": the host did not answer; any other kind: the answer said neither.
 */
export type PingResult = { auth_ok?: boolean | null; reachable?: boolean; kind: string; detail: string };

/** Hooks a standard pack's adapter may define (the Python adapter.py hook names, in camelCase). */
export type Adapter = {
  fetch?: (spec: Spec, pack: Pack, route: string) => Promise<[Tables, string[]]>;
  checkSpec?: (spec: Spec, pack: Pack) => string[];
  beforeRequest?: (req: SpecRequest, ep: any, params: Record<string, unknown>) => Record<string, unknown> | void;
  normalize?: (req: SpecRequest, ep: any, rows: Row[]) => Row[];
  requestNote?: (req: SpecRequest, ep: any, params: Record<string, unknown>) => string | null | undefined;
  checkError?: (status: number, body: Buffer) => string | null | undefined;
  manualItems?: (spec: Spec, pack: Pack) => any[];
  /** The full manual items when they need lookups (names, "latest"); the tools prefer it over manualItems. */
  manualItemsAsync?: (spec: Spec, pack: Pack) => Promise<any[]>;
  parseUpload?: (pack: Pack, req: SpecRequest, files: string[]) => Row[] | Promise<Row[]>;
  search?: (query: string, pack: Pack) => any[] | Promise<any[]>;
  /** A live key check (check_key): one small call with the key. */
  ping?: (client: Client) => Promise<PingResult>;
  /** Extra one-line request summaries for source_brief (beside endpoints.json's). */
  describe?: (pack: Pack) => { name: string; summary: string }[];
  keyOnlyNeeds?: (spec: Spec) => string[];
  refusedHosts?: (spec: Spec) => string | null | undefined;
  keylessFiles?: (spec: Spec, pack: Pack) => any[];
  [k: string]: unknown;
};

/** What a deep pack's fetch or ingest returns (it writes <workspace>/data/<id>/ itself, usually with package.write). */
export type DeepResult = {
  data_dir: string; tables: { name: string; file: string; rows: number; columns: string[] }[]; notes: string[];
  problems?: string[]; retrieved: string; citation: string; vintage?: string; route: string; files?: string[];
};
export type DeepContext = { pack: Pack; spec: any; workspace: string; force: boolean };

/**
 * A deep pack (its own spec format and operations; the Python version had its own fetch.py).
 *   operations  the request index source_brief shows: names and one-line summaries
 *   schema      full schemas of named operations (request_schema)
 *   uses        which operations a spec uses (the gate checks that their schemas were read)
 *   checkSpec   problems with a spec ([] = valid), before any request
 */
export type DeepPack = {
  operations: { name: string; summary: string }[];
  schema: (names: string[], pack: Pack) => any[] | Promise<any[]>;
  uses: (spec: any) => string[];
  specExample?: any;
  search?: (query: string, pack: Pack) => any[] | Promise<any[]>;
  checkSpec?: (spec: any, pack: Pack) => string[];
  fetch: (ctx: DeepContext) => Promise<DeepResult>;
  ingest?: (ctx: DeepContext & { files: string[] }) => Promise<DeepResult>;
  manualItems?: (spec: any, pack: Pack) => any[];
  keylessFiles?: (spec: any, pack: Pack) => any[];
  /** A live key check (check_key), run only when a key is set up. */
  ping?: (pack: Pack) => Promise<PingResult>;
};

export type Pack = {
  id: string; dir: string; policy: Policy; endpoints: any | null; adapter: Adapter | null; deep: DeepPack | null;
  /** Python code this pack needs that is not ported yet ([] = ready). */
  missing: string[];
  sourceMd: string;
  has: (hook: keyof Adapter) => boolean;
};

let portList: Record<string, { python: string[] }> | null = null;
function port(): Record<string, { python: string[] }> {
  if (!portList) {
    const p = path.join(PACKS_DIR, "port.json");
    portList = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  }
  return portList!;
}

export function isPack(dir: string): boolean {
  return fs.existsSync(path.join(dir, "policy.json"));
}

/** Every pack folder, enabled or not. */
export function allPackIds(): string[] {
  if (!fs.existsSync(PACKS_DIR)) return [];
  return fs.readdirSync(PACKS_DIR).filter((d) => isPack(path.join(PACKS_DIR, d))).sort();
}

const listSetting = (name: string) =>
  (process.env[name] || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

/**
 * Selective loading: the operator can enable only some sources (DATA_ANALYST_SOURCES=fred,treasury, the CLI's
 * --sources) or domains (DATA_ANALYST_DOMAINS=economy,health, --domains). A source outside them is not listed,
 * briefed or fetched.
 */
export function packEnabled(id: string): boolean {
  const only = listSetting("DATA_ANALYST_SOURCES");
  if (only.length && !only.includes(id)) return false;
  const domains = listSetting("DATA_ANALYST_DOMAINS");
  if (domains.length) {
    const p = pol.readJson<any>(path.join(PACKS_DIR, id), "policy.json");
    if (!(p?.domains || []).some((d: string) => domains.includes(String(d).toLowerCase()))) return false;
  }
  return true;
}

/** The enabled packs (see packEnabled). */
export function packIds(): string[] {
  return allPackIds().filter(packEnabled);
}

/**
 * DATA_ANALYST_HIDE_UNCONFIGURED=1 (--hide-unconfigured): leave out of listings a source that requires a key
 * none is set up for, here and now (inside a signed-in user's call their own keys count).
 */
export function hiddenForKeys(p: Pack): boolean {
  return /^(1|true|yes)$/i.test(process.env.DATA_ANALYST_HIDE_UNCONFIGURED || "") &&
    p.policy.auth.required === "required" && !findAuthKey(p.policy.auth)[0];
}

export class UnknownSource extends Error {}

const cache = new Map<string, Pack>();

export async function load(pid: string): Promise<Pack> {
  if (cache.has(pid) && packEnabled(pid)) return cache.get(pid)!;
  const dir = path.join(PACKS_DIR, pid);
  if (!/^[a-z0-9-]+$/.test(pid) || !isPack(dir)) {
    throw new UnknownSource(`unknown source ${JSON.stringify(pid)}. Known sources: ${packIds().join(", ")}`);
  }
  if (!packEnabled(pid)) {
    throw new UnknownSource(`source ${JSON.stringify(pid)} is not enabled on this server (enabled: ${packIds().join(", ")})`);
  }
  const policy = pol.load(dir);
  const endpoints = pol.readJson(dir, "endpoints.json");
  const la = findAdapter(pid), ld = findDeep(pid);
  const adapter = la ? await la() : null;
  const deep = ld ? await ld() : null;
  const need = port()[pid]?.python || [];
  const missing = need.filter((f) => (f === "adapter.py" ? !adapter : f === "fetch.py" ? !deep : false));
  const pack: Pack = {
    id: pid, dir, policy, endpoints, adapter, deep, missing, sourceMd: path.join(dir, "source.md"),
    has: (hook) => !!adapter && typeof adapter[hook] === "function",
  };
  cache.set(pid, pack);
  return pack;
}

export async function allPacks(): Promise<Pack[]> {
  return Promise.all(packIds().map(load));
}

// ---------------------------------------------------------------------- routing a question to packs
const STOP = new Set(("a an the of in on for to and or by with from what how much many is are was were did does do " +
  "since between over last year years data show chart compare trend latest per has have had than more after only " +
  "those each who which this that its their it be been").split(" "));
const SAME: Record<string, string> = { weekly: "week", monthly: "month", hourly: "hour", yearly: "annual",
  annually: "annual", quarterly: "quarter", earn: "earning", earned: "earning", paid: "pay", salarie: "salary",
  employed: "employment" };
const FIELDS: [string, number][] = [["keywords", 3], ["questions", 2], ["domains", 2], ["title", 2], ["agency", 1]];

/** Lower-case words without stop words and a plural s; hyphenated or dotted terms also stay whole. */
export function tokens(s: string): string[] {
  const out: string[] = [];
  for (const term of s.toLowerCase().match(/[a-z0-9]+(?:[-.][a-z0-9]+)*/g) || []) {
    const parts = term.match(/[a-z0-9]+/g) || [];
    for (let w of [...(parts.length > 1 ? [term] : []), ...parts]) {
      if (STOP.has(w) || w.length < 2) continue;
      if (w.length > 3 && w.endsWith("s") && /^[a-z]+$/.test(w)) w = w.slice(0, -1);
      out.push(SAME[w] ?? w);
    }
  }
  return out;
}

type Vocab = Record<string, [string, Set<string>][]>;
function vocab(P: any): Vocab {
  const out: Vocab = {};
  for (const [f] of FIELDS) {
    const vals = P[f] || [];
    out[f] = (typeof vals === "string" ? [vals] : vals).map((v: string) => [v, new Set(tokens(v))]);
  }
  return out;
}

const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));

export type RouteHit = { source: string; title: string; score: number; depth: string; auth: string; matched: string[];
  ready: boolean };

/** Rank packs for a question by weighted keyword overlap (a hint, not a decision). */
export async function route(question: string, limit = 6): Promise<RouteHit[]> {
  const q = new Set(tokens(question));
  const packs = (await allPacks()).filter((p) => !hiddenForKeys(p));
  const V = new Map(packs.map((p) => [p.id, vocab(p.policy)]));
  const df = new Map<string, number>();
  for (const v of V.values()) {
    const seen = new Set<string>();
    for (const entries of Object.values(v)) for (const [, toks] of entries) toks.forEach((t) => seen.add(t));
    seen.forEach((w) => df.set(w, (df.get(w) || 0) + 1));
  }
  const idf = new Map([...df].map(([w, n]) => [w, Math.log((packs.length + 1) / (n + 0.5))]));
  const ranked: RouteHit[] = [];
  for (const p of packs) {
    const v = V.get(p.id)!;
    let score = 0;
    const why: string[] = [];
    for (const [field, w] of FIELDS) {
      const all = new Set(v[field].flatMap(([, t]) => [...t]));
      const hit = [...q].filter((t) => all.has(t));
      if (!hit.length) continue;
      const whole = new Set(v[field].filter(([, t]) => t.size === 1 || subset(t, q)).flatMap(([, t]) => [...t]));
      score += w * hit.reduce((s, t) => s + (idf.get(t) || 0) * (whole.has(t) ? 1 : /^\d+$/.test(t) ? 0 : 0.5), 0);
      for (const [text, toks] of v[field]) {
        if (toks.size > 1 && subset(toks, q)) {
          score += (w * [...toks].reduce((s, t) => s + (idf.get(t) || 0), 0)) / 2;
          why.unshift(`${field}: ${text}`);
        } else {
          const some = [...toks].filter((t) => q.has(t) && !/^\d+$/.test(t));
          if (some.length) {
            why.push(toks.size === 1 ? `${field}: ${text}` :
              `${field}: ${[...toks].filter((t) => q.has(t)).sort().join(" ")} (one word of ${JSON.stringify(text)})`);
          }
        }
      }
    }
    if (q.has(p.id) || question.toLowerCase().includes(p.id.replaceAll("-", " "))) score += 5;
    if (score) {
      ranked.push({ source: p.id, title: p.policy.title, score: Math.round(score * 10) / 10, depth: p.policy.depth,
        auth: p.policy.auth.required, matched: why.slice(0, 4), ready: !p.missing.length });
    }
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}
