/** The report tools (see docs/porting-report.md). server.ts registers every entry of TOOLS. */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fail } from "../envelope.js";
import type { Session } from "../session.js";
import type { ToolDef } from "../toolkit.js";
import * as AA from "./audit_answer.js";
import * as AR from "./audit_report.js";
import { build, BuildError } from "./build_report.js";
import { NOTES, type Result } from "./method_audit.js";
import { SourceError } from "./policyset.js";
import { scanWorkspace } from "./scan_secrets.js";
import { styleCheck } from "./style_check.js";

const checks = (results: Result[]) => results.map(([check, ok, message]) => ({ check, status: ok ? "PASS" : "FAIL", message }));

function readReport(s: Session): any {
  const p = path.join(s.workspace, "report.json");
  if (!fs.existsSync(p)) {
    throw fail("not_found", "report.json is not in the workspace", "Call build_report with the report object first.");
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw fail("invalid_request", `report.json is not valid JSON: ${(e as Error).message}`, "Call build_report with a valid report object.");
  }
}

async function guarded<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BuildError || e instanceof SourceError) {
      throw fail("invalid_request", e.message, "Fix report.json, the facts or the workspace as the message says, then call the tool again.");
    }
    if (e instanceof SyntaxError) {
      throw fail("invalid_request", `a workspace JSON file is not valid: ${e.message}`,
        "Rewrite the file the message names (record_decisions, facts) and call the tool again.");
    }
    throw e;
  }
}

export async function auditAnswerTool(s: Session, a: { answer: string; online?: boolean; rerun?: boolean }) {
  if (typeof a.answer !== "string" || !a.answer.trim()) {
    throw fail("invalid_request", "answer is empty", "Pass the reply exactly as you will send it to the user.");
  }
  const p = path.join(s.workspace, "answer.md");
  fs.writeFileSync(p, a.answer.endsWith("\n") ? a.answer : a.answer + "\n", "utf8");
  return guarded(async () => {
    NOTES.length = 0;
    const results = await AA.audit(s.workspace, !!a.online, !!a.rerun);
    const out = AA.printed(results, AA.CHECKS, a.answer, NOTES);
    return { status: "ok", summary: out.verdict, passed: out.passed, checks: checks(results), report: out.lines.join("\n"),
      files: [p], notes: [...NOTES],
      next: out.passed ? "Send the answer exactly as audited (with every disclosure line it carries)."
        : "Fix every FAIL (each message says what to do), then call audit_answer again with the revised reply. Never send an answer that failed." };
  });
}

export async function buildReportTool(s: Session, a: { report: any }) {
  if (!a.report || typeof a.report !== "object" || Array.isArray(a.report)) {
    throw fail("invalid_request", "report must be a report.json object", "Pass the report as an object (title, sections, exhibits, ...).");
  }
  const p = path.join(s.workspace, "report.json");
  fs.writeFileSync(p, JSON.stringify(a.report, null, 2), "utf8");
  return guarded(() => {
    const r = build(p);
    return { status: "ok", summary: { mode: r.mode, sources: r.sources, exhibits: r.exhibits, facts_cited: r.facts_cited,
      bytes: r.bytes, external_refs: r.external_refs, package_members: r.package.members, left_out: r.package.left_out,
      notices: r.notices }, files: [r.report, r.package.file, p], notes: r.notes,
      next: "Call audit_report (rerun: true) before handing the report to the user; fix every FAIL and rebuild." };
  });
}

export async function auditReportTool(s: Session, a: { online?: boolean; rerun?: boolean }) {
  readReport(s);
  return guarded(async () => {
    NOTES.length = 0;
    const results = await AR.audit(path.join(s.workspace, "report.json"), undefined, !!a.online, !!a.rerun);
    const out = AA.printed(results, AR.CHECKS, "", NOTES);
    return { status: "ok", summary: out.verdict, passed: out.passed, checks: checks(results), report: out.lines.join("\n"),
      files: [path.join(s.workspace, "report.html")], notes: [...NOTES],
      next: out.passed ? "Hand the report and replication_package.zip to the user."
        : "Fix every FAIL, call build_report again, then audit_report again." };
  });
}

export function styleCheckTool(s: Session, a: { report?: any; min?: number }) {
  const R = a.report && typeof a.report === "object" ? a.report : readReport(s);
  const r = styleCheck(R, a.min);
  return { status: "ok", summary: r.summary, passed: r.pass, score: r.score, target: r.target, sentences: r.sentences,
    compliant: r.compliant, issues: r.issues, files: [], notes: [] };
}

export function scanSecretsTool(s: Session, a: { sources?: string[] }) {
  const r = scanWorkspace(s.workspace, a.sources);
  return { status: "ok", summary: r.message, passed: r.ok, files_scanned: r.files, hits: r.hits, files: [], notes: [] };
}

export const TOOLS: ToolDef[] = [
  {
    name: "audit_answer",
    title: "Audit a quick answer",
    description: "The release gate for a quick answer: call it with the reply exactly as you will send it, after the facts, " +
      "decisions, references (cite) and exhibits/benchmark.csv are in the workspace. It saves the reply as answer.md and " +
      "checks that every number in it is a registered fact as its format prints it (or a credited published figure, or in " +
      "decisions.json audit_allow), that directions, years, rows and names match those facts, that dollar comparisons " +
      "across years state nominal or real, the method record (questions, literature, disclosures, references opened, " +
      "assumptions, sensitivity, data needs, benchmark), provenance, links (online: true requests them) and secrets; " +
      "rerun: true replays every exhibit recipe and fact. Returns every check with PASS/FAIL and its message, and " +
      "\"AUDIT PASSED\" only when nothing fails. Send the answer only after it passes.",
    inputSchema: {
      answer: z.string().describe("The reply as it will be sent (Markdown)"),
      online: z.boolean().optional().describe("Also request every external link"),
      rerun: z.boolean().optional().describe("Replay every exhibit recipe and recompute every fact"),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    handler: auditAnswerTool,
  },
  {
    name: "build_report",
    title: "Build the report",
    description: "Build a self-contained HTML report or paper (report.html) and replication_package.zip from a report.json " +
      "object (mode report: an exhibit chartbook; mode paper: prose-led). Facts are cited as {{name}} or {{name|fmt}}, " +
      "references as [@id], footnotes as [^n]; exhibits name a CSV in exhibits/ and a chart {type, x, y, series, ...}. " +
      "Each source's notices, Data Vintage block and redistribution rules are applied (microdata and withheld rows never " +
      "enter the ZIP). Returns the report.html and ZIP paths; call audit_report next.",
    inputSchema: {
      report: z.record(z.string(), z.any()).describe("The report.json object (title, mode, sources, at_a_glance, sections, exhibits, methods, ...)"),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    handler: buildReportTool,
  },
  {
    name: "audit_report",
    title: "Audit the report",
    description: "The release gate for a report built with build_report: facts, hand-typed numbers, exhibits, links (online: " +
      "true requests them), the page (up to date, disclaimer, nothing external, no raw markup), vintage, each source's " +
      "notices and audit hooks, clearances, secrets, style, chartbook structure, the method record, benchmarks and the " +
      "replication package; rerun: true replays every exhibit recipe and fact. Returns every check with PASS/FAIL and its " +
      "message, and \"AUDIT PASSED\" only when nothing fails.",
    inputSchema: {
      online: z.boolean().optional().describe("Also request every external link"),
      rerun: z.boolean().optional().describe("Replay every exhibit recipe and recompute every fact"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    handler: auditReportTool,
  },
  {
    name: "style_check",
    title: "Check the report's style",
    description: "Lint the prose of report.json (or the report object given) against the house style guide: percent in " +
      "words, no first person, small numbers spelled out, plain words, sentence length. Returns the score (percent of " +
      "sentences with no issue; target 90) and every sentence with its issues. Nothing is written into the report.",
    inputSchema: {
      report: z.record(z.string(), z.any()).optional().describe("A report.json object; default: the workspace's report.json"),
      min: z.number().optional().describe("The target score (default 90)"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: styleCheckTool,
  },
  {
    name: "scan_secrets",
    title: "Scan for keys",
    description: "Check every workspace file (and every member of a ZIP) for an API key or credential: the value of any key " +
      "this server can find, key-shaped assignments and URL parameters, and for sources that echo keys any 32-hex token. " +
      "Lists file names and line numbers only, never values. Both audits run it too.",
    inputSchema: {
      sources: z.array(z.string()).optional().describe("Source ids used (default: the data/<id>/ folders)"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: scanSecretsTool,
  },
];
