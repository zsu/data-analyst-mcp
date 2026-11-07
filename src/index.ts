/**
 * data-analyst-mcp as a library: the same sources, fetch engine, analysis and audits as the MCP server, for
 * code that is not a model. No ask-first gate here (that gate is for assistants): the caller decides.
 *
 *   import { route, brief, requestSchema, fetchSource } from "data-analyst-mcp";
 *   const r = await fetchSource("cdc", { description: "NY deaths 2017", requests: [{ name: "ny", endpoint: "query",
 *     params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'" } }] }, { out: "./out/ny" });
 *   console.log(r.summary.tables[0].rows, r.citation.text);
 *
 * Every function returns the result envelope the tools return; a failure throws ToolError, whose `failure`
 * carries the code, message and fix.
 */
import path from "node:path";
import * as packs from "./core/packs.js";
import { fail } from "./envelope.js";
import { Session } from "./session.js";
import * as T from "./tools.js";
import * as analysisCompute from "./analysis/compute.js";
import * as analysisFacts from "./analysis/facts.js";
import { rerunWorkspace } from "./analysis/rerun.js";
import { writeTable as writeMethodTable } from "./analysis/write_table.js";
import * as reportTools from "./report/tools.js";
import * as analysisTools from "./analysis/tools.js";

export { createServer, INSTRUCTIONS, VERSION } from "./server.js";
export { Session } from "./session.js";
export { ToolError } from "./envelope.js";
export type { Citation, Code, Failure } from "./envelope.js";
export type { Adapter, DeepPack, Pack, Row, Spec, SpecRequest, Tables } from "./core/packs.js";
export type { Policy } from "./core/policy.js";
export type { RerunResult } from "./analysis/rerun.js";

/** The hosted mode's express app (see src/remote/app.ts), loaded on demand. */
export async function createApp(o: import("./remote/app.js").RemoteOptions) {
  return (await import("./remote/app.js")).createApp(o);
}

/** A session that only carries a workspace folder (the library has no gate and no conversation). */
function at(out: string): Session {
  return { workspace: path.resolve(out), briefed: new Set(), schemas: new Map() } as unknown as Session;
}

const scratch = () => at(path.resolve("out"));

/** A pack, or ToolError invalid_request for an unknown or disabled source (as the tools answer). */
async function source(id: string) {
  try {
    return await packs.load(id);
  } catch (e) {
    if (e instanceof packs.UnknownSource) throw fail("invalid_request", e.message, "listSources() gives the source ids.");
    throw e;
  }
}

/** Every enabled source: id, title, agency, key need, domains, example questions, ready. */
export async function listSources() {
  return (await T.findSources(scratch(), {})).sources;
}

/** Sources ranked for a question (a hint). */
export async function route(question: string, limit = 8) {
  return packs.route(question, limit);
}

export const loadPack = packs.load;

/** A source's playbook, questions to ask, key status, rules and request index (or one doc with `doc`). */
export async function brief(source: string, doc?: string) {
  return T.sourceBrief(scratch(), { source, ...(doc ? { doc } : {}) });
}

/** Full schemas of named requests, or a catalog search. */
export async function requestSchema(source: string, o: { names?: string[]; search?: string }) {
  return T.requestSchema(scratch(), { source, ...o });
}

/** Fetch into <out>/data/<source>/ (out defaults to ./out). The same code path as the fetch tool, without the gate. */
export async function fetchSource(sourceId: string, spec: any, o: { out?: string; force?: boolean } = {}) {
  return T.runFetch(await source(sourceId), spec, path.resolve(o.out || "out"), !!o.force);
}

/** Package files downloaded by hand, like a fetch. */
export async function ingest(sourceId: string, spec: any, files: string[], o: { out?: string } = {}) {
  return T.runIngest(await source(sourceId), spec, files, path.resolve(o.out || "out"));
}

/** A manual-download bundle (scripts the user runs on their own computer) for one or more sources. */
export async function manualBundle(sources: { source: string; spec: any }[], o: { out?: string; reason?: string } = {}) {
  return T.manualBundle(at(o.out || "out"), { sources, reason: o.reason });
}

/** Build an exhibit with declarative steps (saved with its lineage for rerun); the compute tool's result envelope. */
export function compute(out: string, args: analysisCompute.ComputeArgs) {
  return analysisTools.computeTool(at(out), args) as { status: string; summary: any; files: string[]; notes?: string[] };
}

/** Register the numbers an answer cites (facts.json); the facts tool's result, with each fact's text to quote. */
export function registerFacts(out: string, args: Parameters<typeof analysisFacts.registerFacts>[1]) {
  return analysisTools.factsTool(at(out), args) as { status: string; facts: { name: string; value: unknown; text: string }[] };
}

/** benchmark.csv, sensitivity.csv or published/<name>.csv. */
export function writeTable(out: string, args: Parameters<typeof writeMethodTable>[1]) {
  return writeMethodTable(path.resolve(out), args);
}

/** Replay every exhibit and fact. */
export function rerun(out: string) {
  return rerunWorkspace(path.resolve(out));
}

/** Record the method record (questions, literature, references, assumptions, data needs) in decisions.json. */
export function recordDecisions(out: string, update: Parameters<Session["recordDecisions"]>[0]) {
  return new Session(undefined, path.resolve(out)).recordDecisions(update);
}

/** The quick-answer gate: every check with PASS/FAIL; passes only with "AUDIT PASSED". */
export function auditAnswer(out: string, answer: string, o: { online?: boolean; rerun?: boolean } = {}) {
  return reportTools.auditAnswerTool(at(out), { answer, ...o });
}

/** Build report.html and the replication ZIP from a report object. */
export function buildReport(out: string, report: unknown) {
  return reportTools.buildReportTool(at(out), { report });
}

/** The report gate. */
export function auditReport(out: string, o: { online?: boolean; rerun?: boolean } = {}) {
  return reportTools.auditReportTool(at(out), o);
}
