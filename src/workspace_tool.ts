/**
 * open_workspace: continue in an earlier workspace after the server restarted (local mode). Each server process
 * starts in a new folder under the workspace root, so a client that restarts the server mid-analysis would
 * otherwise lose sight of its data, facts and report (the files stay on disk).
 *
 *   no path   the recent workspaces under the root: name, path, when changed, what each holds, the report title
 *   path      a folder directly under the workspace root that holds a workspace (decisions.json, facts.json or
 *             data/): later tools read and write there. Nothing else is reachable: not a folder elsewhere, not
 *             the root itself, not the hosted server's account state.
 * Hosted mode refuses it: each signed-in user's workspace is their own.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { mode, workspaceRoot } from "./core/env.js";
import { fail } from "./envelope.js";
import type { Session } from "./session.js";
import type { ToolDef } from "./toolkit.js";

const MARKS = ["report.json", "answer.md", "facts.json", "decisions.json", "data"];
const LIST_MAX = 10;

function realDir(p: string): string | null {
  try {
    const r = fs.realpathSync(p);
    return fs.statSync(r).isDirectory() ? r : null;
  } catch {
    return null;
  }
}

function describe(dir: string, current: string) {
  const has = MARKS.filter((m) => fs.existsSync(path.join(dir, m)));
  const changed = Math.max(fs.statSync(dir).mtimeMs, ...has.map((m) => fs.statSync(path.join(dir, m)).mtimeMs));
  let title = "";
  try {
    title = String(JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")).title ?? "");
  } catch {
    try {
      title = fs.readFileSync(path.join(dir, "answer.md"), "utf8").split(/\r?\n/).find((l) => l.trim()) ?? "";
    } catch {
      // neither: no title
    }
  }
  return { name: path.basename(dir), path: dir, changed: new Date(changed).toISOString(), has,
    title: title.replace(/^#+\s*/, "").slice(0, 160), current: dir === current };
}

export function listWorkspaces(current: string) {
  const root = realDir(workspaceRoot());
  if (!root) return [];
  const cur = realDir(current) ?? path.resolve(current);
  return fs.readdirSync(root).filter((f) => f !== "state").map((f) => realDir(path.join(root, f)))
    .filter((d): d is string => !!d && path.dirname(d) === root)
    .map((d) => describe(d, cur)).filter((w) => w.has.length || w.current)
    .sort((a, b) => (a.changed < b.changed ? 1 : a.changed > b.changed ? -1 : 0)).slice(0, LIST_MAX);
}

export function openWorkspaceTool(s: Session, a: { path?: string }) {
  if (mode() === "remote") {
    throw fail("not_supported", "open_workspace works on a local server only", "On the hosted server the workspace is " +
      "kept with the signed-in session: continue in this one.");
  }
  if (a.path === undefined || a.path === "") {
    const ws = listWorkspaces(s.workspace);
    return { status: "ok", summary: { current: s.workspace, workspaces: ws }, files: [],
      notes: ws.length ? [] : ["No earlier workspace with data, facts or a report is under the workspace root."],
      next: "Call open_workspace with the path of the workspace the analysis was in (its title and files say which)." };
  }
  const root = realDir(workspaceRoot());
  const want = realDir(path.isAbsolute(a.path) || !root ? a.path : path.join(root, a.path));
  if (!root || !want || path.dirname(want) !== root || path.basename(want) === "state") {
    throw fail("invalid_request", `${a.path} is not a workspace under ${workspaceRoot()}`,
      "Give the path (or name) of a workspace that open_workspace without arguments lists.");
  }
  if (!MARKS.some((m) => fs.existsSync(path.join(want, m)))) {
    throw fail("invalid_request", `${a.path} holds no workspace files (no decisions.json, facts.json or data/)`,
      "Call open_workspace without arguments and pick a workspace that lists files.");
  }
  const before = s.workspace;
  s.reopen(want);
  const w = describe(want, want);
  return { status: "ok", summary: { workspace: want, previous: before, has: w.has, title: w.title }, files: [],
    notes: ["The workspace's files and its method record (decisions.json) are back. source_brief and request_schema " +
      "were seen by the earlier server process: call them again for a source before a new fetch from it."],
    next: "Continue where the analysis stopped (for a report: audit_report; build_report first if report.json is not listed)." };
}

export const TOOLS: ToolDef[] = [{
  name: "open_workspace",
  title: "Reopen a workspace",
  description: "Continue in an earlier workspace after the server restarted (a restart starts a new, empty workspace; " +
    "the earlier files stay on disk). Without path: the recent workspaces with their titles and files. With path: " +
    "later tools work in that workspace. Use it when a tool says report.json, facts.json or data files are missing " +
    "although an earlier call made them. Local server only.",
  inputSchema: { path: z.string().optional().describe("A workspace path or name from the list; omit to list them") },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  handler: openWorkspaceTool,
}];
