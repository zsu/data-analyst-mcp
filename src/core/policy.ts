/**
 * Load, check and enforce a source pack's policy.json. The schema is the Python skill's (docs: the field list
 * at the top of the Python core/policy.py); this project owns its copy of every policy.json.
 */
import fs from "node:fs";
import path from "node:path";
import type { Auth } from "./keys.js";

export type Policy = {
  id: string; title: string; agency: string; depth: "deep" | "standard"; domains: string[]; keywords: string[];
  questions: string[]; homepage: string; terms_url?: string; auth: Auth & { required: "required" | "optional" | "none";
    placement: "query" | "header" | "body" | "none" };
  limits: { rps: number; burst: number; max_rows?: number; errors_per_min?: number; bytes_per_min?: number;
    [k: string]: unknown };
  routes: Record<string, any>; cache: { mode: "none" | "run_only" | "persistent"; ttl_hours?: number; why?: string };
  redistribution: { mode: "allowed" | "aggregates_only" | "definition_only"; microdata_globs: string[];
    package_include: string[]; withhold: any; why?: string };
  notices: string[]; audit_hooks: any[]; clarify: string[]; formats: string[]; retention: any; citation: string;
  aliases?: string[]; use_instead?: { question: string; source: string; terms: string[]; why: string }[];
  [k: string]: any;
};

const REQUIRED = ["id", "title", "agency", "depth", "domains", "homepage", "auth", "limits", "routes", "cache",
  "redistribution", "citation"];
const CACHE_MODES = ["none", "run_only", "persistent"];
const REDIST_MODES = ["allowed", "aggregates_only", "definition_only"];
const AUTH_REQ = ["required", "optional", "none"];
const PLACEMENTS = ["query", "header", "body", "none"];
const ROUTE_NAMES = ["api", "api_keyless", "bulk", "manual"];
const HOOK_KINDS = ["require_file", "require_text", "require_fact_prefix", "forbid_in_package"];
export const REDIST_ORDER: Record<string, number> = { allowed: 0, aggregates_only: 1, definition_only: 2 };

export class PolicyError extends Error {}

export function readJson<T = any>(dir: string, name: string): T | null {
  const p = path.join(dir, name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")) : null;
}

export function load(packDir: string): Policy {
  const p = readJson<any>(packDir, "policy.json");
  if (!p) throw new Error(`missing ${path.join(packDir, "policy.json")}`);
  for (const k of ["keywords", "questions", "notices", "audit_hooks", "clarify", "formats"]) p[k] ??= [];
  p.retention ??= null;
  p.auth = { env: null, alt_env: [], required: "none", placement: "none", param: null, prefix: "", home: null,
    echoes_key: false, key_only: [], signup_url: null, ...(p.auth || {}) };
  p.limits = { rps: 5, burst: 10, ...(p.limits || {}) };
  p.redistribution = { microdata_globs: [], package_include: ["request.json", "README.md"], withhold: null,
    ...(p.redistribution || {}) };
  return p as Policy;
}

const NOT_HERE = /^- Not here\b[\s\S]*?(?=^- |^#|^\s*$|(?![\s\S]))/gm;

/** What a pack says it covers, lower case: policy fields plus source.md and docs/*.md without "Not here" bullets. */
export function coverageText(packDir: string): string | null {
  const tp = readJson<any>(packDir, "policy.json");
  if (!tp) return null;
  const parts = [String(tp.title ?? "")];
  for (const k of ["domains", "keywords", "questions"]) for (const x of tp[k] || []) parts.push(String(x));
  const docs = path.join(packDir, "docs");
  const mds = [path.join(packDir, "source.md"),
    ...(fs.existsSync(docs) ? fs.readdirSync(docs).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(docs, f)) : [])];
  for (const md of mds) if (fs.existsSync(md)) parts.push(fs.readFileSync(md, "utf8").replace(NOT_HERE, ""));
  return parts.join("\n").toLowerCase();
}

function useInsteadProblems(p: any, packDir?: string): string[] {
  const ui = p.use_instead;
  if (ui === undefined || ui === null) return [];
  if (!Array.isArray(ui)) return ["use_instead must be a list of {question, source, terms, why}"];
  const bad: string[] = [];
  ui.forEach((u: any, i: number) => {
    const tag = `use_instead[${i}]`;
    if (!u || typeof u !== "object" || !["question", "source", "terms", "why"].every((k) => u[k])) {
      bad.push(`${tag}: question, source, terms (a list of words) and why are all required`);
      return;
    }
    if (!Array.isArray(u.terms) || !u.terms.every((t: unknown) => typeof t === "string" && t.trim())) {
      bad.push(`${tag}: terms must be a list of non-empty words the target pack must cover`);
      return;
    }
    if (u.source === p.id) {
      bad.push(`${tag}: source is this pack itself; name the pack that answers ${JSON.stringify(u.question)}`);
      return;
    }
    if (!packDir) return;
    const text = coverageText(path.join(path.dirname(path.resolve(packDir)), u.source));
    if (text === null) {
      bad.push(`${tag}: source ${JSON.stringify(u.source)} is not a pack`);
      return;
    }
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const missing = u.terms.filter((t: string) => !new RegExp(`(?<![a-z0-9])${esc(t.toLowerCase().trim())}(?![a-z0-9])`).test(text));
    if (missing.length) bad.push(`${tag}: pack ${JSON.stringify(u.source)} does not cover ${JSON.stringify(missing)}`);
  });
  return bad;
}

/** Problems with a policy (empty = valid). */
export function validate(p: any, packDir?: string): string[] {
  const bad = REQUIRED.filter((k) => !(k in p) || p[k] === null || p[k] === "" || (Array.isArray(p[k]) && !p[k].length))
    .map((k) => `missing field: ${k}`);
  if (packDir && p.id && path.basename(path.resolve(packDir)) !== p.id) bad.push(`id ${p.id} does not match its folder`);
  if (!["deep", "standard"].includes(p.depth)) bad.push("depth must be deep or standard");
  const a = p.auth || {};
  if (!AUTH_REQ.includes(a.required)) bad.push(`auth.required must be one of ${AUTH_REQ}`);
  if (!PLACEMENTS.includes(a.placement)) bad.push(`auth.placement must be one of ${PLACEMENTS}`);
  if (["required", "optional"].includes(a.required) && !a.env) bad.push("auth.env is required when a key is used");
  if (["required", "optional"].includes(a.required) && !a.signup_url) bad.push("auth.signup_url is required when a key is used");
  const r = p.routes || {};
  if (!r.manual?.how) bad.push("routes.manual.how is required: every source needs a manual-download route");
  for (const name of Object.keys(r)) if (!ROUTE_NAMES.includes(name)) bad.push(`unknown route ${name}`);
  for (const name of ["api", "api_keyless", "bulk"]) if (name in r && !r[name]?.probe) bad.push(`routes.${name}.probe is required`);
  if (!CACHE_MODES.includes(p.cache?.mode)) bad.push(`cache.mode must be one of ${CACHE_MODES}`);
  const rd = p.redistribution || {};
  if (!REDIST_MODES.includes(rd.mode)) bad.push(`redistribution.mode must be one of ${REDIST_MODES}`);
  if (["definition_only", "aggregates_only"].includes(rd.mode) && !rd.microdata_globs?.length) {
    bad.push(`redistribution.microdata_globs is required for ${rd.mode}`);
  }
  if ("aliases" in p && !Array.isArray(p.aliases)) bad.push("aliases must be a list");
  if (!rd.why) bad.push("redistribution.why is required (the terms that set the rule)");
  for (const h of p.audit_hooks || []) {
    if (!HOOK_KINDS.includes(h.kind)) bad.push(`audit hook ${h.id}: kind must be one of ${HOOK_KINDS}`);
    if (!h.why) bad.push(`audit hook ${h.id}: why is required`);
  }
  if (!String(p.citation || "").includes("{retrieved")) bad.push("citation must contain {retrieved} or {retrieved_long}");
  const kc = r.manual?.keyless_citation;
  if (kc !== undefined && kc !== null && !String(kc).includes("{retrieved")) {
    bad.push("routes.manual.keyless_citation must contain {retrieved} or {retrieved_long}");
  }
  return [...bad, ...useInsteadProblems(p, packDir)];
}

export function checkCache(p: Policy, want: "none" | "run_only" | "persistent"): void {
  const order = { none: 0, run_only: 1, persistent: 2 };
  if (order[want] > order[p.cache.mode]) {
    throw new PolicyError(`${p.id}: cache mode ${want} is not allowed (${p.cache.mode}): ${p.cache.why || ""}`);
  }
}

export function strictest(policies: Policy[]): string {
  return policies.map((p) => p.redistribution.mode).sort((a, b) => REDIST_ORDER[b] - REDIST_ORDER[a])[0] || "allowed";
}

export function notices(policies: Policy[]): string[] {
  return [...new Set(policies.flatMap((p) => p.notices || []))];
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The user's calendar date of a retrieval time; a plain date is kept. */
export function localDay(stamp: unknown): string {
  const s = String(stamp ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isFinite(t) && /[T ]\d/.test(s) ? localDate(new Date(t)) : s.slice(0, 10);
}

/** "2026-10-27 23:10 local time (2026-10-28 03:10 UTC)"; a plain date is kept. */
export function localStamp(stamp: unknown): string {
  const s = String(stamp ?? "");
  if (!/[T ]\d.*(Z|[+-]\d\d:?\d\d)$/.test(s)) return s;
  const d = new Date(Date.parse(s));
  const loc = `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const utc = d.toISOString().slice(0, 16).replace("T", " ");
  return `${loc} local time (${utc} UTC)`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];

/** The source's citation text; data that came by the keyless_file route cite that file when the pack says how. */
export function citation(p: Policy, route = "", vals: Record<string, string> = {}): string {
  const v: Record<string, string> = { ...vals };
  if (v.retrieved) v.retrieved = localDay(v.retrieved);
  const r = v.retrieved || "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r);
  v.retrieved_long ??= m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : r;
  v.title ??= p.title;
  v.dataset ??= "";
  v.vintage ??= "";
  v.url ??= p.homepage || "";
  const tmpl = route === "keyless_file" ? p.routes?.manual?.keyless_citation : null;
  return String(tmpl || p.citation).replace(/\{(\w+)\}/g, (all, k) => (k in v ? v[k] : all));
}
