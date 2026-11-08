/**
 * The MCP server: instructions, tools, the `analyze` prompt and the source/guide resources.
 * Transport-free: bin/cli.ts connects it over stdio; http.ts (remote mode) over streamable HTTP.
 */
import fs from "node:fs";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GUIDE_DIR, PACKS_DIR } from "./core/env.js";
import { redact, redactDeep, rememberServerSecrets, withKeyProvider, withPackScope } from "./core/keys.js";
import { knownKeys } from "./report/scan_secrets.js";
import { packIds } from "./core/packs.js";
import { toFailure } from "./envelope.js";
import { Session } from "./session.js";
import * as T from "./tools.js";
import { TOOLS as ANALYSIS_TOOLS } from "./analysis/tools.js";
import { TOOLS as REPORT_TOOLS } from "./report/tools.js";

export const VERSION = "0.3.1";

export const INSTRUCTIONS = `Live U.S. government data, fetched from the agency at call time; every result is cited.
Never answer a U.S. government data question from memory, and never estimate, simulate or "illustrate" a number:
if no source can answer, say so.

Workflow: find_sources(question) -> source_brief(id) -> ask the user -> record_decisions -> request_schema(id,
names) -> fetch(id, spec) -> compute -> facts -> audit_answer (send only after AUDIT PASSED). guide() has the
full method (framing, literature, accuracy checklist, combining sources, the answer, reports). When a question
spans agencies, source_brief's paired_with names the usual cross-checks: fetch both and compare.

Ask before you fetch. source_brief returns questions_to_ask: the choices that change a headline number. Ask
the ones the request leaves open in ONE round (at most 4 questions, each with exactly one "Don't know — decide
for me" option, your recommended option first), with your question tool when you have one. A blocking question
(what the user means: which program, place, population) that is skipped is asked once more. Record every
question with record_decisions; fetch refuses until they are settled (gate_blocked says what is missing).

Errors carry a code and a fix: follow the fix, never repeat a call unchanged, never present a failure as data.
Keys are never asked for in chat: key_missing gives the user a command or page to store a key themselves.

Citations: cite page_url and the citation text with its retrieval date; copy every notice word for word.
Read the playbook's traps before interpreting a number; surface revisions, preliminary values, sampling error
and definition changes unprompted.`;

type Handler<A> = (s: Session, a: A) => unknown;

/**
 * Remote mode: workspace paths become relative paths, with a signed download URL each in `links`; a key error
 * carries the user's keys page; a manual bundle carries the upload page.
 */
function remoteView(s: Session, out: any): any {
  if (!s.linker || !out || typeof out !== "object") return out;
  const links: Record<string, string> = {};
  const ws = s.workspace;
  const walk = (v: any): any => {
    if (typeof v === "string" && v.startsWith(ws)) {
      const rel = path.relative(ws, v).replaceAll("\\", "/");
      if (fs.existsSync(v) && fs.statSync(v).isFile()) links[rel] = s.linker!(v);
      return rel;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const view = walk(out);
  if (Object.keys(links).length) {
    view.links = links;
    view.links_note = "Give the user these links to download the files (each works for 24 hours, while this session lasts).";
  }
  if (view.status === "error" && (view.code === "key_missing" || view.code === "key_rejected")) {
    view.keys_url = s.keysUrl;
    view.fix = s.keysUrl
      ? `Give the user this link to store their own key (it opens a page on this server; never ask for the key in chat): ${s.keysUrl} . Then call the tool again.`
      : "This server keeps only its operator's keys and has none for this source. Use a keyless source, or manual_bundle " +
        "(the user downloads with their own key on their computer, then uploads).";
  }
  if (view.bundle && s.uploadUrl) {
    view.upload_page = s.uploadUrl;
    view.next = "Give the user the links to INSTRUCTIONS.md and the download script for their system, and the upload page. " +
      "When they say the files are uploaded, call ingest with files: [\"uploads\"].";
  }
  return view;
}

/** A result as the text the client gets: every string redacted, then the JSON text once more. */
function render(s: Session, out: unknown): string {
  return redact(JSON.stringify(redactDeep(remoteView(s, out)), null, 1));
}

const LAST_RESORT = JSON.stringify({ status: "error", code: "unexpected", message: "internal error (details withheld)",
  fix: "Call the tool again; if it fails the same way, report it." }, null, 1);

/** The packs a call is about: its source, its sources[].source, or the data/<id>/ folder of a path it reads. */
export function callPacks(a: any): string[] {
  const ids = new Set<string>();
  if (typeof a?.source === "string") ids.add(a.source);
  for (const x of Array.isArray(a?.sources) ? a.sources : []) if (typeof x?.source === "string") ids.add(x.source);
  for (const p of [a?.path, ...(Array.isArray(a?.files) ? a.files : [])]) {
    const m = typeof p === "string" ? /(?:^|[\\/])data[\\/]([a-z0-9-]+)[\\/]/i.exec(p) : null;
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

function wrap<A>(s: Session, fn: Handler<A>) {
  return async (a: A) => {
    const call = async () => {
      let text: string;
      let isError = false;
      try {
        const out = s.keyProvider ? await withKeyProvider(s.keyProvider, () => fn(s, a)) : await fn(s, a);
        text = render(s, out);
      } catch (e) {
        isError = true;
        try {
          text = render(s, toFailure(e));
        } catch {
          text = LAST_RESORT;
        }
      }
      // redacted inside the pack scope too, so that pack's own patterns apply to its result text
      return { content: [{ type: "text" as const, text }], isError };
    };
    // a pack's own redaction patterns (keys its API echoes) apply only inside calls for that pack
    const packs = callPacks(a);
    const r = packs.length ? await withPackScope(packs, call) : await call();
    s.lastSeen = Date.now();
    return r;
  };
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const NET = { readOnlyHint: true, openWorldHint: true } as const;

const questionSchema = z.object({
  id: z.string().describe('The question id from source_brief (e.g. "cdc:1"), or your own id for a general question'),
  question: z.string().optional(),
  covers: z.array(z.string()).optional().describe("Other question ids this one settles"),
  blocking: z.boolean().optional().describe("What the user means (program, place, population): no default exists"),
  asked: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  answer: z.string().optional().describe('The user\'s answer, or "dont_know"'),
  how: z.enum(["answered", "dont_know", "skipped", "not_asked"]).optional(),
  reason_code: z.enum(["no_user", "settled_by_request"]).optional(),
  request: z.string().optional().describe("settled_by_request: the user's own words that settle it"),
  resolution: z.string().optional().describe("What you chose, for a Don't know, a skip or no_user"),
  assumption: z.string().optional(),
  rationale: z.string().optional(),
  followed_up: z.boolean().optional(),
});

const specSchema = z.record(z.string(), z.any()).describe(
  'Most sources: {"description": "...", "requests": [{"name", "endpoint", "params", "max_rows"}]}. Deep sources ' +
  "(bea, bls, fred, ipums, opm, treasury) have their own format: see source_brief and request_schema.");

export function createServer(session = new Session()): McpServer {
  const server = new McpServer({ name: "data-analyst", version: VERSION }, { instructions: INSTRUCTIONS });
  const s = session;
  // every key this machine has, and the server's own secrets, are redacted from the first call on
  rememberServerSecrets();
  knownKeys();

  server.registerTool("guide", {
    title: "Method guide",
    description: "The analyst's method: framing the question, asking only critical questions, choosing sources, " +
      "the accuracy checklist and combining sources. Call once at the start of a data question. Topics: workflow " +
      "(default), routing (which sources answer which questions, usual pairings), style, report_patterns.",
    inputSchema: { topic: z.enum(["workflow", "routing", "style", "report_patterns"]).optional() },
    annotations: READ,
  }, wrap(s, T.guide));

  server.registerTool("find_sources", {
    title: "Find sources",
    description: "With a question: the source packs ranked for it (a hint: split the question into measures and " +
      "give each its source). Without one: every source with its agency, key need and example questions.",
    inputSchema: { question: z.string().optional() },
    annotations: READ,
  }, wrap(s, T.findSources));

  server.registerTool("source_brief", {
    title: "Source brief",
    description: "One source's playbook (coverage, units, traps, citation), its questions_to_ask (the critical " +
      "choices: ask the user those the request leaves open, then record_decisions), its key status, rules and " +
      "request index. Required before fetch. With doc: one of its long reference docs instead.",
    inputSchema: { source: z.string().describe("A source id from find_sources"), doc: z.string().optional() },
    annotations: READ,
  }, wrap(s, T.sourceBrief));

  server.registerTool("request_schema", {
    title: "Request schema",
    description: "Full parameters of named requests (from source_brief's requests), and the spec format; or search " +
      "the source's catalog of datasets and series. fetch requires the schema of every request it uses.",
    inputSchema: { source: z.string(), names: z.array(z.string()).optional(), search: z.string().optional() },
    annotations: READ,
  }, wrap(s, T.requestSchema));

  server.registerTool("record_decisions", {
    title: "Record decisions",
    description: "Record the method record in decisions.json (merged with what is there): how each critical question " +
      "was settled (the user's answer, a Don't know with the resolution you chose, a skip, or why it was not asked; " +
      "fetch checks the source's questions), and, for the audits, the literature searched, the references opened (cite " +
      "first), the assumptions with their basis, the data that would improve the answer, and numbers allowed in the " +
      "answer that are not statistics. Lists replace the earlier list of the same name.",
    inputSchema: {
      questions: z.array(questionSchema).optional(),
      disclosures: z.record(z.string(), z.string()).optional()
        .describe("One line per question decided without the user (or 'literature'), which the answer carries word for word"),
      literature_search: z.array(z.record(z.string(), z.any())).optional()
        .describe('[{query, date, tool, found: [ref ids], note}] or [{unavailable: true, reason_code: "no_search_tool" | "network_blocked", reason}]'),
      references: z.array(z.record(z.string(), z.any())).optional()
        .describe("[{id, citation, url, accessed, opened: true, used_for, quote}] (opened only after cite saved the page)"),
      assumptions: z.array(z.record(z.string(), z.any())).optional()
        .describe("[{parameter, value, basis: empirical|literature|precedent|user|judgment, evidence, why_not_empirical, sensitivity}] " +
          "(sensitivity: the parameter of its exhibits/sensitivity.csv row, only when that differs from the assumption's parameter)"),
      data_needs: z.array(z.record(z.string(), z.any())).optional()
        .describe("[{id, data, improves: [...], effect, how_to_get, from_user}]"),
      data_needs_note: z.string().optional().describe("Why no data would help, with data_needs: []"),
      audit_allow: z.array(z.object({ value: z.string(), reason: z.string() })).optional()
        .describe("Numbers in the answer that are not statistics (a bill number, a count of sources)"),
      dollar_basis_ok: z.object({ reason: z.string() }).optional(),
      rounding_ties_ok: z.array(z.object({ fact: z.string(), reason: z.string() })).optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(s, T.recordDecisions));

  server.registerTool("check_key", {
    title: "Check key",
    description: "Whether a source's API key is set up (never shows the key) and, if not, what the user does.",
    inputSchema: { source: z.string() },
    annotations: READ,
  }, wrap(s, T.checkKey));

  server.registerTool("fetch", {
    title: "Fetch data",
    description: "Download data from the agency into this session's workspace (CSV per request, data dictionary, " +
      "README with the citation and terms, request.json with every URL made). Returns a summary (rows, columns, a " +
      "few rows), the files, the citation and notes; status partial when a row cap was hit. Refuses (gate_blocked) " +
      "until source_brief, request_schema and record_decisions are done for this source.",
    inputSchema: { source: z.string(), spec: specSchema, force: z.boolean().optional().describe("Fetch again even if the workspace has this exact request") },
    annotations: NET,
  }, wrap(s, T.fetchData));

  server.registerTool("manual_bundle", {
    title: "Manual download bundle",
    description: "When this server cannot get the data (no key stored here, a host that refuses scripts, a network " +
      "block): write one bundle for one or more sources with download scripts (.sh and .ps1, every request built in, any " +
      "key asked with hidden input on the user's own computer) and INSTRUCTIONS.md. Then ingest the files the user downloads.",
    inputSchema: { sources: z.array(z.object({ source: z.string(), spec: specSchema })).min(1),
      reason: z.string().optional().describe("Why the user downloads by hand (shown in INSTRUCTIONS.md)") },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, wrap(s, T.manualBundle));

  server.registerTool("ingest", {
    title: "Ingest downloaded files",
    description: "Package files the user downloaded (from manual_bundle, a keyless_file, or the agency's site) like a " +
      "fetch: CSVs, data dictionary, README and provenance. The same gate as fetch applies.",
    inputSchema: { source: z.string(), spec: specSchema,
      files: z.array(z.string()).min(1).describe("Paths of the downloaded files or their folder") },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, wrap(s, T.ingest));

  server.registerTool("read_file", {
    title: "Read workspace file",
    description: "A text file from this session's workspace (a fetched CSV, README, request.json), up to 100 KB.",
    inputSchema: { path: z.string().describe("Relative to the workspace, or a path a fetch result listed"),
      max_bytes: z.number().optional() },
    annotations: READ,
  }, wrap(s, T.readFile));

  for (const t of [...ANALYSIS_TOOLS, ...REPORT_TOOLS]) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema,
      annotations: t.annotations ?? { readOnlyHint: false, openWorldHint: false } }, wrap(s, t.handler));
  }

  server.registerPrompt("analyze", {
    title: "Analyze with U.S. government data",
    description: "Start a data question with the full method (asks the critical questions before fetching).",
    argsSchema: { question: z.string().describe("The question to answer") },
  }, ({ question }) => ({
    messages: [{ role: "user", content: { type: "text",
      text: redact(`${fs.readFileSync(path.join(GUIDE_DIR, "WORKFLOW.md"), "utf8")}\n\n---\n\nQuestion: ${question}`) } }],
  }));

  server.registerResource("source", new ResourceTemplate("source://{id}", {
    list: () => ({ resources: packIds().map((id) => ({ uri: `source://${id}`, name: `${id} playbook`, mimeType: "text/markdown" })) }),
  }), { title: "Source playbook", description: "A source pack's source.md", mimeType: "text/markdown" }, (uri, { id }) => {
    const pid = String(id);
    if (!packIds().includes(pid)) throw new Error("unknown source id");
    return { contents: [{ uri: uri.href, mimeType: "text/markdown",
      text: redact(fs.readFileSync(path.join(PACKS_DIR, pid, "source.md"), "utf8")) }] };
  });

  server.registerResource("guide", "guide://workflow", { title: "Method guide", mimeType: "text/markdown" }, (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: redact(fs.readFileSync(path.join(GUIDE_DIR, "WORKFLOW.md"), "utf8")) }],
  }));

  return server;
}
