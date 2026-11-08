/**
 * The MCP tools' logic, independent of the transport (server.ts registers them; tests call them directly).
 * Every function takes the session and its validated arguments and returns a JSON-able result; failures are
 * thrown as ToolError (envelope.ts) and turned into the error envelope by the caller.
 */
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { columnList, inLongRun, namesHint } from "./core/compact.js";
import { trail, withRun } from "./core/context.js";
import { outline, pick, splitSections } from "./core/sections.js";
import { AGGREGATES, FUNCTIONS, WINDOWS } from "./analysis/expr.js";
import { GUIDE_DIR, mode } from "./core/env.js";
import * as gr from "./core/generic-rest.js";
import * as guard from "./core/guard.js";
import { DataError, type ErrorKind } from "./core/http.js";
import { findAuthKey } from "./core/keys.js";
import * as manual from "./core/manual.js";
import { pairingsFor } from "./core/routing.js";
import * as packages from "./core/package.js";
import * as packs from "./core/packs.js";
import type { Pack, PingResult, Spec } from "./core/packs.js";
import * as pol from "./core/policy.js";
import { citation, fail, fromDataError, ToolError } from "./envelope.js";
import { Session, type Question } from "./session.js";

const PREVIEW_ROWS = 5;
const READ_MAX = 100_000;

async function pack(source: string): Promise<Pack> {
  try {
    return await packs.load(source);
  } catch (e) {
    if (e instanceof packs.UnknownSource) {
      throw fail("invalid_request", e.message, "Call find_sources to see the source ids.");
    }
    throw e;
  }
}

function questionsOf(p: Pack): { id: string; question: string }[] {
  return (p.policy.clarify || []).map((q, i) => ({ id: `${p.id}:${i + 1}`, question: q }));
}

function keyStatus(p: Pack) {
  const a = p.policy.auth;
  const [key, src] = findAuthKey(a);
  return { required: a.required, env: a.env ?? null, configured: !!key, where: key ? src : null,
    signup_url: a.signup_url ?? null, ...(a.key_only?.length ? { key_only: a.key_only } : {}) };
}

// ---------------------------------------------------------------------- guide
export const TOPICS: Record<string, string> = {
  workflow: "WORKFLOW.md", routing: "references/routing.md", report: "references/report_quick.md",
  compute: "references/compute.md", style: "references/style_guide.md",
  report_patterns: "references/report_patterns.md", report_schema: "references/report_schema.md",
};

/** compute's function lists, from the expression engine itself (so the guide never goes stale). */
function computeLists(): string {
  const names = (o: Record<string, unknown>) => Object.keys(o).filter((k) => k !== "col").join(", ");
  return `\n## Functions\nFunctions: ${names(FUNCTIONS)}.\nAggregates: ${names(AGGREGATES)}.\n` +
    `Windows (in row order, per group): ${names(WINDOWS)}.\n`;
}

/** A topic longer than this is served as an outline first, then by section. */
export const GUIDE_WHOLE_MAX = 12_000;

export function guide(_s: Session, a: { topic?: string; section?: string | string[] }) {
  const topic = a.topic || "workflow";
  const file = TOPICS[topic];
  if (!file) throw fail("invalid_request", `unknown topic ${JSON.stringify(topic)}`, `Use one of: ${Object.keys(TOPICS).join(", ")}.`);
  const text = fs.readFileSync(path.join(GUIDE_DIR, file), "utf8") + (topic === "compute" && a.section ? computeLists() : "");
  const secs = splitSections(text);
  const names = a.section === undefined ? [] : Array.isArray(a.section) ? a.section : [a.section];
  if (names.length) {
    const got = pick(secs, names);
    if (got.unknown.length) {
      throw fail("invalid_request", `no section ${got.unknown.map((n) => JSON.stringify(n)).join(", ")} in ${topic}`,
        `Use a title from this outline (or its number): ${outline(secs).map((o) => o.section).join("; ")}.`);
    }
    return { status: "ok", topic, section: names, text: got.text };
  }
  if (topic === "compute") return { status: "ok", topic, text: text + computeLists(), topics: Object.keys(TOPICS) };
  if (text.length <= GUIDE_WHOLE_MAX) return { status: "ok", topic, text, topics: Object.keys(TOPICS) };
  return { status: "ok", topic, text: secs[0].title ? "" : secs[0].text, outline: outline(secs), topics: Object.keys(TOPICS),
    next: `This topic is long: call guide again with topic "${topic}" and section (a title from outline or its number; ` +
      "a list for several), only for the parts the task needs." };
}

// ---------------------------------------------------------------------- find_sources
export async function findSources(_s: Session, a: { question?: string }) {
  if (a.question) {
    return { status: "ok", question: a.question, candidates: await packs.route(a.question, 8),
      next: "Split the question into measures and give each one a source (guide topic routing lists the usual " +
        "pairings); then call source_brief for each chosen source." };
  }
  const all = (await packs.allPacks()).filter((p) => !packs.hiddenForKeys(p));
  return {
    status: "ok", count: all.length,
    sources: all.map((p) => ({ id: p.id, title: p.policy.title, agency: p.policy.agency, depth: p.policy.depth,
      key: p.policy.auth.required, domains: p.policy.domains, examples: (p.policy.questions || []).slice(0, 2),
      ...(p.policy.use_instead?.length ? { use_instead: p.policy.use_instead.map((u) => ({ question: u.question, source: u.source })) } : {}),
      ready: !p.missing.length })),
    next: "Call find_sources with the question to rank them, or source_brief on the ones you need.",
  };
}

/// ---------------------------------------------------------------------- source_brief
function requestIndex(p: Pack): { name: string; summary: string }[] {
  if (p.deep) return p.deep.operations;
  return [...gr.endpointIndex(p), ...(p.adapter?.describe ? p.adapter.describe(p) : [])];
}

/** Playbook sections left out of a brief unless asked for: the key status, rules and failure fixes carry their
 * essentials; the rest (keyless and manual routes) matters only when a fetch cannot run. */
const BRIEF_ON_REQUEST = ["Access"];

/** The playbook a brief carries: every section but BRIEF_ON_REQUEST, or the sections asked for, or all of it. */
function playbookOf(p: Pack, a: { sections?: string[]; full?: boolean }) {
  const md = fs.readFileSync(p.sourceMd, "utf8");
  const secs = splitSections(md);
  if (a.full) return { playbook: md };
  if (a.sections?.length) {
    const got = pick(secs, a.sections);
    if (got.unknown.length) {
      throw fail("invalid_request", `no playbook section ${got.unknown.map((n) => JSON.stringify(n)).join(", ")} for ${p.id}`,
        `Sections: ${outline(secs).map((o) => o.section).join("; ")}.`);
    }
    return { playbook: got.text };
  }
  const held = secs.filter((x) => BRIEF_ON_REQUEST.some((t) => x.title.toLowerCase() === t.toLowerCase()));
  return {
    playbook: secs.filter((x) => !held.includes(x)).map((x) => x.text).join("").trimEnd() + "\n",
    ...(held.length ? { playbook_on_request: held.map((x) => ({ section: x.title, chars: x.text.length,
      for: "keyless and manual routes, rate limits: read it when a fetch fails or no key is set up" })) } : {}),
  };
}

export async function sourceBrief(s: Session, a: { source: string; doc?: string; sections?: string[]; full?: boolean }) {
  const p = await pack(a.source);
  const docsDir = path.join(p.dir, "docs");
  const docs = fs.existsSync(docsDir) ? fs.readdirSync(docsDir).filter((f) => f.endsWith(".md")).sort() : [];
  if (a.doc) {
    const name = path.basename(a.doc).replace(/\.md$/, "") + ".md";
    if (!docs.includes(name)) throw fail("invalid_request", `no doc ${JSON.stringify(a.doc)} for ${p.id}`, `Docs: ${docs.join(", ") || "none"}.`);
    return { status: "ok", source: p.id, doc: name, text: fs.readFileSync(path.join(docsDir, name), "utf8") };
  }
  const pb = playbookOf(p, a);
  // a later call for some sections returns just them (the rest of the brief was given already)
  if (a.sections?.length && !a.full && s.briefed.has(p.id)) return { status: "ok", source: p.id, ...pb };
  s.briefed.add(p.id);
  const P = p.policy;
  const qs = questionsOf(p);
  return {
    status: "ok", source: p.id, title: P.title, agency: P.agency, depth: P.depth,
    ready: !p.missing.length,
    ...(p.missing.length ? { not_ready: `This source's code (${p.missing.join(", ")}) is not ported to this server yet: ` +
      "fetch will refuse it. Use another source that has the measure." } : {}),
    ...pb,
    questions_to_ask: qs,
    key: keyStatus(p),
    rules: { notices: P.notices, redistribution: { mode: P.redistribution.mode, why: P.redistribution.why },
      cache: P.cache.mode, citation_template: P.citation, terms_url: P.terms_url ?? null,
      manual_route: P.routes?.manual?.how ?? null },
    spec_kind: p.deep ? "this source's own spec format (see the playbook and request_schema)" : "requests",
    requests: requestIndex(p),
    // cross-referencing: the questions this source usually answers with others (routing table), and where to go instead
    // the note on each pairing is in guide("routing")
    paired_with: pairingsFor(p.id).map((r) => ({ question: r.question, primary: r.primary, cross_check: r.cross_check })),
    ...(P.use_instead?.length ? { use_instead: P.use_instead.map((u) => ({ question: u.question, source: u.source, why: u.why })) } : {}),
    catalog_entries: Object.keys(p.endpoints?.catalog || {}).length,
    docs,
    next: (qs.length ? `Ask the user the questions in questions_to_ask that the request leaves open (one round, at most 4, ` +
      `each with one "Don't know — decide for me" option, recommended option first) and record each with ` +
      `record_decisions (id ${qs[0].id} etc.). ` : "") +
      "Then call request_schema for the requests you will use (or search the catalog), and fetch.",
  };
}

// ---------------------------------------------------------------------- request_schema
export async function requestSchema(s: Session, a: { source: string; names?: string[]; search?: string; detail?: boolean }) {
  const p = await pack(a.source);
  if (!a.names?.length && !a.search) {
    throw fail("invalid_request", "give names (request names from source_brief) or search", "Call again with names or search.");
  }
  const out: Record<string, unknown> = { status: "ok", source: p.id };
  if (a.search) {
    out.results = await (p.deep?.search ? p.deep.search(a.search, p) : p.adapter?.search ? p.adapter.search(a.search, p)
      : gr.searchCatalog(p, a.search));
  }
  if (a.names?.length) {
    const known = requestIndex(p).map((r) => r.name);
    const bad = a.names.filter((n) => !known.includes(n));
    if (bad.length) throw fail("invalid_request", `unknown request(s) ${bad.join(", ")} for ${p.id}`, `Use a known request name: ${namesHint(bad, known, "requests", (v) => (v as string[]).join(", "))}.`);
    if (p.deep) {
      try {
        out.schemas = await p.deep.schema(a.names, p, { detail: !!a.detail });
      } catch (e) {
        if (e instanceof DataError) throw new ToolError(fromDataError(e, p.policy));
        throw e;
      }
      out.spec_format = { example: p.deep.specExample ?? null, notes: ["the spec format is this source's own: see the playbook"] };
    } else {
      out.schemas = a.names.map((n) => gr.endpointSchema(p, n) ?? p.adapter?.describe?.(p).find((d) => d.name === n) ?? null);
      out.spec_format = {
        example: { description: "what this fetch is for", requests: [{ name: "short_name", endpoint: a.names[0],
          params: { "...": "..." }, max_rows: 5000 }] },
        notes: ["name: letters, digits, _ or - (names the CSV file)", "endpoint: one of the schemas above",
          "dataset: a catalog alias, for endpoints whose params mark one as catalog",
          'for_each: {"csv": "data/<id>/<table>.csv", "column": "...", "param": "..."} makes one request per row value',
          "allow_empty: true when no rows is a correct answer"],
      };
    }
    // the spec format is the same on every call: sent once per pack per session
    if (s.specFormatSent.has(p.id)) out.spec_format = "as in this session's first request_schema call for this source";
    s.specFormatSent.add(p.id);
    s.sawSchema(p.id, a.names);
  }
  return out;
}

// ---------------------------------------------------------------------- record_decisions
export function recordDecisions(s: Session, a: { questions?: Question[]; disclosures?: Record<string, string>;
  [k: string]: unknown }) {
  const questions = a.questions || [];
  const problems = questions.flatMap((q) => Session.questionProblems(q));
  // the audit fields come in `method` (the tool's schema) or at the top level (the library, older callers)
  const method = a.method && typeof a.method === "object" && !Array.isArray(a.method) ? a.method as Record<string, unknown> : {};
  const rest = Object.fromEntries([...Object.entries(method), ...Object.entries(a)]
    .filter(([k, v]) => k !== "questions" && k !== "method" && v !== undefined));
  const d = s.recordDecisions({ questions, ...rest });
  return { status: problems.length ? "partial" : "ok", recorded: questions.map((q) => q.id),
    fields: Object.keys(rest), problems, decisions_file: s.decisionsPath, questions_total: d.questions.length,
    next: problems.length ? "Fix each problem and record those questions again." : "Continue (fetch, or the audit)." };
}

// ---------------------------------------------------------------------- check_key
/** A ping kind (core, or a deep pack's own) as the core kind fromDataError maps to a code and fix. */
const PING_KINDS: Record<string, ErrorKind> = { budget: "rate_limit", unavailable: "http", request: "bad_request",
  other: "http" };
const CORE_KINDS = new Set<string>(["key_missing", "auth", "network", "not_found", "rate", "rate_limit", "bad_request",
  "api", "http", "fixture_missing", "blocked"]);

/**
 * Test the key live with the pack's ping (one small call, uncached, inside its own request trail). The client is the
 * pack's own, so the key goes only to its site (Client.keyAllowed). Outcomes: accepted, rejected (code key_rejected),
 * unreachable (the host did not answer: the key was not tested) or unclear (an answer that says neither).
 */
async function liveKeyTest(p: Pack): Promise<Record<string, unknown>> {
  const ping = p.deep?.ping ? () => p.deep!.ping!(p)
    : p.adapter?.ping ? () => p.adapter!.ping!(gr.clientFor(p, undefined, { cache: null, retries: 1, timeout: 20 }))
    : null;
  if (!ping) {
    return { tested: false, reason: "this source has no live key check: the key is set up but was not tested; the " +
      "first fetch tests it" };
  }
  let r: PingResult;
  try {
    r = await withRun(ping);
  } catch (e) {
    if (!(e instanceof DataError)) throw e;
    r = { kind: e.kind, detail: e.message };
  }
  const kind = r.kind || "ok";
  const detail = r.detail || "";
  if (kind === "ok" && r.auth_ok !== false && r.reachable !== false) {
    return { tested: true, outcome: "accepted", detail: detail || "the agency answered a request made with the key" };
  }
  if (kind === "auth" || kind === "key_missing") {
    const f = fromDataError(new DataError(detail || `${p.id}: the key was rejected`, "auth"), p.policy);
    return { tested: true, outcome: "rejected", detail: f.message, code: f.code, fix: f.fix };
  }
  if (kind === "network") {
    return { tested: true, outcome: "unreachable", detail, code: "agency_unavailable",
      fix: "The agency's host did not answer, so the key was not tested (it may be fine). Tell the user the check " +
        "could not reach the agency; check the network connection, proxy or firewall, then call check_key again." };
  }
  const f = fromDataError(new DataError(detail || `${p.id}: ${kind}`, CORE_KINDS.has(kind) ? kind as ErrorKind :
    PING_KINDS[kind] ?? "http"), p.policy);
  return { tested: true, outcome: "unclear", detail: f.message, code: f.code,
    fix: "The agency answered, but not in a way that says whether the key is good (" + kind + "). A fetch may still " +
      "work; if it fails, follow its fix. " + f.fix };
}

export async function checkKey(_s: Session, a: { source: string; live?: boolean }) {
  const p = await pack(a.source);
  const k = keyStatus(p);
  const ready = k.required !== "required" || k.configured;
  const live = !k.configured ? { tested: false, reason: "no key is set up" }
    : a.live === false ? { tested: false, reason: "not asked (live: false)" }
    : await liveKeyTest(p);
  const rejected = live.outcome === "rejected";
  return { status: "ok", source: p.id, key: { ...k, live }, can_fetch: ready && !rejected && !p.missing.length,
    ...(rejected ? { fix: live.fix }
      : ready ? {} : { fix: fromDataError(new DataError(`${p.id}: ${p.policy.auth.env} is not set up`, "key_missing"), p.policy).fix }) };
}

// ---------------------------------------------------------------------- the gate
function endpointOf(p: Pack, r: Spec["requests"][number]): string | undefined {
  return r.endpoint || (r.dataset ? p.endpoints?.catalog?.[r.dataset]?.endpoint : undefined);
}

/** The request names a spec uses (what request_schema must have returned). */
export function usedRequests(p: Pack, spec: any): string[] {
  if (p.deep) return [...new Set(p.deep.uses(spec))];
  return [...new Set((spec.requests || []).map((r: any) => endpointOf(p, r)).filter((x: unknown): x is string => !!x))] as string[];
}

function checkShape(p: Pack, spec: any): void {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw fail("invalid_request", "spec must be a JSON object", "See request_schema spec_format and the playbook.");
  }
  if (!p.deep && !Array.isArray(spec.requests)) {
    throw fail("invalid_request", 'spec must be {"description": "...", "requests": [...]}', "See request_schema spec_format.");
  }
}

function gate(s: Session, p: Pack, spec: any): void {
  if (p.missing.length) {
    throw fail("not_supported", `${p.id}: this source's code (${p.missing.join(", ")}) is not ported to this server yet`,
      "Use another source that has the measure (find_sources), or tell the user this source is not available here yet.");
  }
  if (!s.briefed.has(p.id)) {
    throw fail("gate_blocked", `fetch ${p.id}: source_brief(${p.id}) has not been read in this session`,
      `Call source_brief with source "${p.id}", ask the user its questions_to_ask, record them with record_decisions, then fetch.`);
  }
  const seen = s.schemas.get(p.id) || new Set<string>();
  const unseen = usedRequests(p, spec).filter((n) => !seen.has(n));
  if (unseen.length) {
    throw fail("gate_blocked", `fetch ${p.id}: the schema of ${unseen.join(", ")} has not been read`,
      `Call request_schema with source "${p.id}" and names ${JSON.stringify(unseen)}, check the params, then fetch.`);
  }
  const open = s.unsettled(p.id, p.policy.clarify || []);
  if (open.length) {
    throw fail("gate_blocked", `fetch ${p.id}: critical questions not settled: ${open.join("; ")}`,
      "Ask the user these in one round (at most 4 questions, each with exactly one \"Don't know — decide for me\" " +
      "option, your recommended option first), or record why not (reason_code settled_by_request with the user's " +
      "words, or no_user only when nobody can answer). Record each with record_decisions, id or covers = the " +
      "question id, then fetch.", { unsettled: open });
  }
}

// ---------------------------------------------------------------------- choosing the route
const BUNDLE_HINT = "manual_bundle writes a one-command download the user runs on their own computer; then ingest";

function keylessOffer(p: Pack, spec: any): Record<string, unknown> {
  const how = p.policy.routes?.manual?.keyless_file;
  if (!how) return {};
  const files = p.deep?.keylessFiles ? p.deep.keylessFiles(spec, p) : p.adapter?.keylessFiles ? p.adapter.keylessFiles(spec, p) : null;
  if (files && !files.length) return {};
  return { keyless_file: how, ...(files ? { keyless_files: files } : {}),
    keyless_action: "Download each keyless file (url, under its filename) and call ingest with them." };
}

/**
 * The route a fetch takes, from the key situation (the Python route check without probes: a failure of the
 * chosen route comes back as an error with its fix). A missing required key falls back to the pack's keyless or
 * bulk route when it has one and the spec needs no key-only feature.
 */
function chooseRoute(p: Pack, spec: any): string {
  const a = p.policy.auth;
  const [key] = findAuthKey(a);
  const needs = p.adapter?.keyOnlyNeeds ? p.adapter.keyOnlyNeeds(spec) : [];
  if (key || (a.required !== "required" && !needs.length)) return "api";
  const R = p.policy.routes || {};
  if (!needs.length && R.api_keyless) return "api_keyless";
  if (!needs.length && R.bulk) return "bulk";
  const f = fromDataError(new DataError(`${p.id}: this request needs a ${a.env} key` +
    (needs.length ? ` (for: ${needs.join("; ")})` : "") + ", and none is set up", "key_missing"), p.policy);
  throw new ToolError({ ...f, ...keylessOffer(p, spec), manual_bundle: BUNDLE_HINT });
}

/** Columns a fetch preview shows at most: the file has them all, the preview is for a first look. */
const PREVIEW_COLS = 12;
const PREVIEW_HEAD_BYTES = 256 * 1024;

/** The CSV's header and first n rows, read from the head of the file only, narrowed to PREVIEW_COLS columns
 * (numbered runs such as replicate weights left out first). */
export function preview(file: string, n = PREVIEW_ROWS): string[] {
  if (!fs.existsSync(file) || !file.toLowerCase().endsWith(".csv")) return [];
  const fd = fs.openSync(file, "r");
  let head: string;
  let whole: boolean;
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(PREVIEW_HEAD_BYTES, size));
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, got).toString("utf8");
    whole = got >= size;
  } finally {
    fs.closeSync(fd);
  }
  let grid: string[][];
  try {
    const cut = whole ? head : head.slice(0, head.lastIndexOf("\n") + 1);
    grid = parse(cut, { relax_column_count: true, relax_quotes: true, bom: true, to_line: n + 1 }) as string[][];
  } catch {
    return head.split(/\r?\n/).slice(0, n + 1).filter(Boolean);
  }
  if (!grid.length) return [];
  const cols = grid[0];
  if (cols.length <= PREVIEW_COLS) return grid.map(csvLine);
  const runs = inLongRun(cols);
  const keep = [...cols.keys()].filter((i) => !runs.has(cols[i])).slice(0, PREVIEW_COLS);
  const lines = grid.map((r) => csvLine(keep.map((i) => r[i] ?? "")));
  lines.push(`(${keep.length} of ${cols.length} columns shown; the file has them all)`);
  return lines;
}

function csvLine(cells: string[]): string {
  return cells.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");
}

function failWith(e: unknown, p: Pack, spec: any): never {
  if (e instanceof ToolError) throw e;
  if (e instanceof DataError) {
    const f = fromDataError(e, p.policy);
    // the keyless detour is for a missing or rejected key, or an agency that cannot be reached; a rate limit on
    // the user's own key is waited out, not routed around (as the Python route check did)
    const ownKeyLimited = e.kind === "rate" && !!findAuthKey(p.policy.auth)[0];
    const more = ["key_missing", "key_rejected", "agency_unavailable"].includes(f.code) && !ownKeyLimited
      ? { ...keylessOffer(p, spec), manual_bundle: BUNDLE_HINT } : {};
    throw new ToolError({ ...f, ...more });
  }
  throw e;
}

// ---------------------------------------------------------------------- fetch
export async function fetchData(s: Session, a: { source: string; spec: any; force?: boolean }) {
  const p = await pack(a.source);
  checkShape(p, a.spec);
  gate(s, p, a.spec);
  return runFetch(p, a.spec, s.workspace, !!a.force);
}

/**
 * The fetch itself, after the gate: the code path both the fetch tool and the library's fetchSource use. Writes
 * <workspace>/data/<id>/ and returns the result envelope; a failure throws ToolError with its code and fix.
 */
export async function runFetch(p: Pack, spec0: any, workspace: string, force = false) {
  checkShape(p, spec0);
  if (p.missing.length) {
    throw fail("not_supported", `${p.id}: this source's code (${p.missing.join(", ")}) is not ported yet`, "Use another source.");
  }
  const s = { workspace };
  const a = { force };
  return withRun(async () => {
    if (p.deep) {
      const probs = p.deep.checkSpec ? p.deep.checkSpec(spec0, p) : [];
      if (probs.length) {
        throw fail("invalid_request", `${p.id}: the request has problems: ${probs.join("; ")}`,
          "Fix the spec from the playbook and request_schema, then call fetch again.", { problems: probs });
      }
      chooseRoute(p, spec0);
      let r: packs.DeepResult;
      try {
        r = await p.deep.fetch({ pack: p, spec: spec0, workspace: s.workspace, force: !!a.force });
      } catch (e) {
        failWith(e, p, spec0);
      }
      return deepResult(p, r, spec0);
    }
    let spec: Spec;
    try {
      spec = spec0.requests.some((r: any) => r.for_each) ? gr.expandForEach(spec0, s.workspace) : spec0;
    } catch (e) {
      if (e instanceof DataError) throw fail("invalid_request", e.message, "Fix the for_each entry (the CSV path is relative to the workspace).");
      throw e;
    }
    const probs = gr.checkSpec(p, spec);
    if (probs.length) {
      throw fail("invalid_request", `${p.id}: the request has problems: ${probs.join("; ")}`,
        "Fix the spec from request_schema (params, enums, required fields) and call fetch again.", { problems: probs });
    }
    const refused = p.adapter?.refusedHosts ? p.adapter.refusedHosts(spec) : null;
    if (refused) {
      throw new ToolError({ status: "error", code: "agency_unavailable", message: refused,
        fix: "This host refuses automated requests: call manual_bundle and give the user its links to save from a browser, then ingest.",
        manual_bundle: BUNDLE_HINT });
    }
    const collapsed = gr.collapseForEach(spec);
    const ex = packages.existing(s.workspace, p.id, collapsed);
    if (ex && ex.matches && ex.complete && !ex.problems.length && !a.force) {
      const req = JSON.parse(fs.readFileSync(path.join(ex.path, "request.json"), "utf8"));
      return result(p, ex.path, req.tables, req.notes || [], { route: "reuse_existing", citeRoute: req.route,
        retrieved: req.retrieved, requests: req.requests, partial: false, dataset: spec0.description,
        extraNote: `Already fetched ${pol.localDay(ex.retrieved)}` +
          ((ex.age_days ?? 0) >= 7 ? "; newer data may exist (force: true refetches)." : ".") });
    }
    const route = chooseRoute(p, spec);
    let tables: packs.Tables = {}, notes: string[] = [];
    try {
      [tables, notes] = p.adapter?.fetch ? await p.adapter.fetch(spec, p, route) : await gr.fetchSpec(p, spec);
    } catch (e) {
      failWith(e, p, spec);
    }
    const truncated = notes.filter((n) => n.includes("stopped at") || n.includes(gr.INCOMPLETE));
    const merged = gr.mergeForEach(spec, tables);
    const requests = trail().slice();
    const res = packages.write(s.workspace, p, merged, collapsed, { route, acquired: route, requests,
      notes: notes.filter((n) => !truncated.includes(n)), problems: truncated });
    return result(p, res.data_dir, res.tables, notes, { route, retrieved: res.retrieved, requests,
      partial: truncated.length > 0, dataset: spec0.description, citation: res.citation });
  });
}

function deepResult(p: Pack, r: packs.DeepResult, spec: any) {
  return result(p, r.data_dir, r.tables as packages.TableMeta[], [...r.notes, ...(r.problems || [])], {
    route: r.route, retrieved: r.retrieved, requests: trail().slice(), partial: !!r.problems?.length,
    dataset: spec.description, citation: r.citation, vintage: r.vintage, extraFiles: r.files });
}

function result(p: Pack, dir: string, tables: packages.TableMeta[], notes: string[], o: { route: string;
  citeRoute?: string; retrieved: string; requests: any[]; partial: boolean; dataset?: string; citation?: string;
  extraNote?: string; vintage?: string; extraFiles?: string[] }) {
  const { route, retrieved, requests, partial, extraNote } = o;
  // deep packs write their own files: every file of the folder is scrubbed here, and the user is told
  const scrubbed = packages.takeScrubbed(dir);
  if (scrubbed.length) notes = [...notes, packages.scrubNote(scrubbed)];
  return {
    status: partial ? "partial" : "ok",
    summary: {
      source: p.id, route, retrieved,
      tables: tables.map((t) => ({ table: `${p.id}/${t.name}`, rows: t.rows, columns: columnList(t.columns || []),
        preview_csv: preview(path.join(dir, t.file)) })),
    },
    files: [...tables.flatMap((t) => [path.join(dir, t.file), ...(t.parquet ? [path.join(dir, t.parquet)] : [])]),
      path.join(dir, "data_dictionary.csv"), path.join(dir, "README.md"),
      path.join(dir, "request.json"), ...(o.extraFiles || [])].filter((f, i, all) => fs.existsSync(f) && all.indexOf(f) === i),
    // the request URLs are in requests below (and request.json): not repeated in the citation here
    citation: { ...citation(p.policy, { route: o.citeRoute ?? route, requests, retrieved, dataset: o.dataset, text: o.citation,
      vintage: o.vintage }), request_urls: undefined },
    // the upstream requests behind this result (credential-free URLs; every one is in request.json)
    requests: (requests || []).slice(0, 10).map((r: any) => ({ method: r.method, url: r.url, status: r.status,
      cached: !!r.cached, fetched_at: r.fetched_at })),
    requests_total: (requests || []).length,
    notes: [...(extraNote ? [extraNote] : []), ...notes],
    ...(partial ? { action: "These tables are incomplete (see notes). Narrow the filter or raise max_rows and fetch " +
      "again with force: true; if the cap is the API's own limit, tell the user the result is partial. Never present " +
      "a truncated table as complete." } : {}),
    next: "Read the playbook's traps before interpreting. Cite page_url and copy each notice word for word. The full " +
      "tables are in files (read_file shows small text files)." + (mode() === "remote" ? "" : " Analyze them with your own code tool."),
  };
}

// ---------------------------------------------------------------------- manual download and ingest
async function itemsFor(p: Pack, spec: any): Promise<any[]> {
  if (p.deep) return p.deep.manualItems ? p.deep.manualItems(spec, p) : [];
  if (p.adapter?.manualItemsAsync) return p.adapter.manualItemsAsync(spec, p);
  if (p.adapter?.manualItems) return p.adapter.manualItems(spec, p);
  return p.endpoints ? gr.manualItems(p, spec) : [];
}

export async function manualBundle(s: Session, a: { sources: { source: string; spec: any }[]; reason?: string }) {
  const groups: [Pack, any[]][] = [];
  const specs: Record<string, any> = {};
  const none: string[] = [];
  for (const x of a.sources) {
    const p = await pack(x.source);
    checkShape(p, x.spec);
    if (p.missing.length) throw fail("not_supported", `${p.id}: not ported to this server yet`, "Use another source.");
    const items = await itemsFor(p, x.spec);
    if (!items.length) none.push(`${p.id}: ${p.policy.routes?.manual?.how || "no manual route"}`);
    else {
      groups.push([p, items]);
      specs[p.id] = x.spec;
    }
  }
  if (!groups.length) throw fail("not_supported", "none of these sources has download links for this spec", none.join(" | "));
  const b = manual.writeBundle(s.workspace, groups, a.reason || "requested", specs);
  return { status: "ok", bundle: b.dir, instructions: b.instructions, download_scripts: b.scripts, request_spec: b.spec,
    user_commands: b.commands, items: b.items.map((i) => ({ source: i.source, filename: i.filename, url: i.url,
      needs_key: i.needs_key, optional: i.optional })), ...(none.length ? { not_covered: none } : {}),
    next: "Send INSTRUCTIONS.md and both download scripts to the user with your file-sending tool when you have one (or " +
      "give their paths), and the one command for their system (user_commands). The script asks for any key with hidden " +
      "input on their computer; never ask for a key in chat. When they have the files, call ingest with them." };
}

export async function ingest(s: Session, a: { source: string; spec: any; files: string[] }) {
  const p = await pack(a.source);
  checkShape(p, a.spec);
  gate(s, p, a.spec);
  return runIngest(p, a.spec, a.files, s.workspace);
}

/** Ingest after the gate (the tool and the library's ingest share it). */
export async function runIngest(p: Pack, spec: any, given: string[], workspace: string) {
  checkShape(p, spec);
  const s = { workspace };
  const a = { spec, files: given };
  const remote = mode() === "remote";
  if (remote && !a.files.every((f) => guard.workspaceFile(f, s.workspace))) {
    throw fail("invalid_request", "on this hosted server, ingest reads only files uploaded to this session",
      "Give the user the upload page (from manual_bundle), then call ingest with files: [\"uploads\"].");
  }
  // a path the model names: never a key file or a file with a key in it (a source that echoes keys excepted: below)
  for (const f of a.files) guard.checkReadable(f, { workspace: s.workspace, what: "ingest" });
  const files = a.files.map((f) => path.resolve(s.workspace, f));
  const absent = files.filter((f) => !fs.existsSync(f));
  if (absent.length) throw fail("not_found", `not found: ${absent.join(", ")}`, "Give the paths of the downloaded files or their folder.");
  const candidates = guard.checkFiles(a.files, { workspace: s.workspace, what: "ingest", contents: false });
  // a source whose own responses echo the user's key (BEA, BLS): its files hold it by nature, and are redacted on output
  const scan = (fs_: string[]) => {
    if ((p.policy.auth as any)?.echoes_key !== true) guard.checkContents(fs_, "ingest");
  };
  if (p.deep) scan(candidates);
  return withRun(async () => {
    if (p.deep) {
      if (!p.deep.ingest) throw fail("not_supported", `${p.id} has no ingest`, p.policy.routes?.manual?.how || "See the playbook.");
      let r: packs.DeepResult;
      try {
        r = await p.deep.ingest({ pack: p, spec: a.spec, workspace: s.workspace, force: true, files });
      } catch (e) {
        failWith(e, p, a.spec);
      }
      return deepResult(p, r, a.spec);
    }
    const items = await itemsFor(p, a.spec);
    if (!items.length) throw fail("not_supported", `${p.id} has no manual items for this spec`, "See the playbook's access section.");
    const [found, missing] = manual.matchUploads(files, items);
    if (missing.length) {
      throw fail("not_found", `some expected files were not found: ${missing.join(", ")}`,
        "Ask the user for these files, then call ingest again.", { missing });
    }
    const alt = new Set(items.flatMap((it) => (it.alt_filenames || []).map((x: string) => x.toLowerCase())));
    const vals = Object.values(found);
    scan(vals);
    const route = vals.length && vals.every((f) => alt.has(path.basename(f).toLowerCase())) ? "keyless_file" : "manual_download";
    const local = manual.copyIn(found, path.join(packages.dataDir(s.workspace, p.id), "raw"));
    let spec: Spec = a.spec;
    const tables: packs.Tables = {};
    try {
      spec = a.spec.requests.some((r: any) => r.for_each) ? gr.expandForEach(a.spec, s.workspace) : a.spec;
      for (const r of spec.requests) {
        const mine = Object.entries(local).filter(([n]) => n.split("#")[0] === r.name).map(([, f]) => f);
        tables[r.name] = p.adapter?.parseUpload ? await p.adapter.parseUpload(p, r, mine) : gr.parseUpload(p, r, mine);
      }
    } catch (e) {
      failWith(e, p, a.spec);
    }
    const merged = gr.mergeForEach(spec, tables);
    const names = [...new Set(vals.map((f) => path.basename(f)))].sort();
    const note = route === "keyless_file"
      ? `The agency's keyless files (${names.join(", ")}) were downloaded and ingested, not the API: say so in the methods; an API-only notice does not apply.`
      : "Files downloaded outside the API route (by the user, or saved from the agency's own site) and ingested: say where they " +
        "came from in the methods; an API-only notice applies only if they came from the API.";
    const res = packages.write(s.workspace, p, merged, gr.collapseForEach(spec), { route, acquired: route, notes: [note] });
    return result(p, res.data_dir, res.tables, [note], { route, retrieved: res.retrieved, requests: [], partial: false,
      dataset: a.spec.description, citation: res.citation });
  });
}

// ---------------------------------------------------------------------- read_file
/** read_file's default size: enough for a README or request.json; a codebook is read with match. */
const READ_DEFAULT = 20_000;
/** Lines a match returns at most. */
const MATCH_MAX_LINES = 200;

export function readFile(s: Session, a: { path: string; max_bytes?: number; match?: string }) {
  const abs = path.resolve(s.workspace, a.path);
  const rel = path.relative(s.workspace, abs);
  if (!guard.workspaceFile(a.path, s.workspace)) {
    throw fail("invalid_request", "read_file reads only inside this session's workspace (and never a key file)",
      "Use a path from a fetch result's files (relative to the workspace).");
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw fail("not_found", `no file ${rel}`, "Use a path from a fetch result's files (relative to the workspace).");
  }
  const max = Math.min(a.max_bytes || READ_DEFAULT, READ_MAX);
  const buf = fs.readFileSync(abs);
  if (a.match) {
    let re: RegExp;
    try {
      re = new RegExp(a.match, "i");
    } catch (e) {
      throw fail("invalid_request", `match is not a valid regular expression: ${(e as Error).message}`,
        "Give a plain word or a simple pattern such as \"COW|ESR\".");
    }
    // the header (first line) and the lines that match, each with its line number
    const lines = buf.toString("utf8").split(/\r?\n/);
    const hits: string[] = [];
    let n = 0;
    for (let i = 1; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      n++;
      if (hits.length < MATCH_MAX_LINES) hits.push(`${i + 1}: ${lines[i]}`);
    }
    let text = [`1: ${lines[0]}`, ...hits].join("\n");
    const cut = text.length > max;
    if (cut) text = text.slice(0, max);
    const [safe, masked] = guard.maskCredentials(text);
    return { status: n > hits.length || cut ? "partial" : "ok", path: rel, bytes: buf.length, matched_lines: n, text: safe,
      ...(n > hits.length || cut || masked ? { note: [n > hits.length ? `first ${hits.length} of ${n} matching lines` : "",
        cut ? `first ${max} characters` : "", masked ? "credential-shaped text was replaced with [REDACTED]" : ""]
        .filter(Boolean).join("; ") } : {}) };
  }
  // an upload may hold a key the server never saw (a response the agency echoed it in): credential-shaped text goes too
  const [text, masked] = guard.maskCredentials(buf.subarray(0, max).toString("utf8"));
  return { status: buf.length > max ? "partial" : "ok", path: rel, bytes: buf.length, text,
    ...(buf.length > max || masked ? { note: [buf.length > max ? `first ${max} of ${buf.length} bytes` : "",
      masked ? "credential-shaped text was replaced with [REDACTED]" : ""].filter(Boolean).join("; "),
      ...(buf.length > max ? { more: "max_bytes reads more (up to 100000); match returns only the lines you need" } : {}) } : {}) };
}
