/**
 * Per-session state: the workspace folder and the evidence the fetch gate checks.
 *
 * The gate (fetch refuses until each is true for the source, in this session):
 *   1. source_brief(id) was returned (the model has the playbook and the questions to ask);
 *   2. request_schema returned the schema of every endpoint the spec uses;
 *   3. record_decisions covers each of the source's critical questions (`<id>:<n>`, from source_brief) with an
 *      answer, a "Don't know", a skip, or a reason it was not asked (settled_by_request with the user's words,
 *      or no_user when nobody can answer).
 * decisions.json in the workspace is the method record, merged by question id.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "./core/env.js";

export type Question = {
  id: string; question?: string; covers?: string[]; blocking?: boolean; asked?: boolean; options?: string[];
  answer?: string; how?: "answered" | "dont_know" | "skipped" | "not_asked"; reason_code?: "no_user" | "settled_by_request";
  request?: string; resolution?: string; assumption?: string; rationale?: string; followed_up?: boolean;
};

export class Session {
  id: string;
  /** Changed only by reopen (open_workspace, local mode). */
  workspace: string;
  briefed = new Set<string>();
  /** Packs whose request_schema spec_format was already sent (it is the same every call). */
  specFormatSent = new Set<string>();
  schemas = new Map<string, Set<string>>();
  /** Remote mode: the signed-in account whose stored keys this session uses (OAuth subject). */
  account: string | null = null;
  /** Remote mode: a download URL for a file in the workspace (null in local mode: paths are shown). */
  linker: ((abs: string) => string) | null = null;
  /** Remote mode: the page where the signed-in user stores their own keys (write-only). */
  keysUrl: string | null = null;
  /** Remote mode: the page where the user uploads files a manual bundle downloaded (into <workspace>/uploads). */
  uploadUrl: string | null = null;
  /** Remote mode: the signed-in user's stored keys (keys.ts withKeyProvider). */
  keyProvider: ((env: string) => string | undefined) | null = null;
  lastSeen = Date.now();

  constructor(id?: string, workspace?: string) {
    this.id = id || `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`;
    this.workspace = path.resolve(workspace || path.join(workspaceRoot(), this.id));
    fs.mkdirSync(this.workspace, { recursive: true });
  }

  /** Continue in an earlier workspace (after a server restart): its files and decisions.json come back; the fetch
   * gate's evidence (source_brief and request_schema seen) is this process's own and starts empty. */
  reopen(dir: string): void {
    this.workspace = path.resolve(dir);
    this.id = path.basename(this.workspace);
  }

  sawSchema(source: string, names: string[]): void {
    if (!this.schemas.has(source)) this.schemas.set(source, new Set());
    names.forEach((n) => this.schemas.get(source)!.add(n));
  }

  get decisionsPath(): string {
    return path.join(this.workspace, "decisions.json");
  }

  decisions(): any {
    try {
      return JSON.parse(fs.readFileSync(this.decisionsPath, "utf8"));
    } catch {
      return { questions: [] };
    }
  }

  /** Merge questions (by id) and other top-level fields into decisions.json. */
  recordDecisions(update: { questions?: Question[]; disclosures?: Record<string, string>; [k: string]: unknown }): any {
    const d = this.decisions();
    const byId = new Map<string, Question>((d.questions || []).map((q: Question) => [q.id, q]));
    for (const q0 of update.questions || []) {
      // the method audit reads `asked` (default true): a question recorded as not asked says so explicitly
      const q = q0.asked === undefined && q0.how ? { ...q0, asked: q0.how !== "not_asked" } : q0;
      byId.set(q.id, { ...(byId.get(q.id) || {}), ...q });
    }
    d.questions = [...byId.values()];
    if (update.disclosures) d.disclosures = { ...(d.disclosures || {}), ...update.disclosures };
    for (const [k, v] of Object.entries(update)) if (k !== "questions" && k !== "disclosures") d[k] = v;
    fs.writeFileSync(this.decisionsPath, JSON.stringify(d, null, 2));
    return d;
  }

  /** Problems with how a question was settled (empty = settled). */
  static questionProblems(q: Question): string[] {
    const how = q.how || (q.answer && q.answer !== "dont_know" ? "answered" : q.answer === "dont_know" ? "dont_know" : undefined);
    if (!how) return [`${q.id}: no answer and no "how" (answered, dont_know, skipped or not_asked)`];
    if (how === "answered" && !q.answer) return [`${q.id}: how is "answered" but there is no answer`];
    if (how === "not_asked") {
      if (q.reason_code === "settled_by_request" && !q.request) return [`${q.id}: settled_by_request needs "request", the user's own words`];
      if (q.reason_code !== "settled_by_request" && q.reason_code !== "no_user") {
        return [`${q.id}: a question not asked needs reason_code settled_by_request or no_user`];
      }
    }
    if ((how === "dont_know" || how === "skipped" || q.reason_code === "no_user") && !q.resolution) {
      return [`${q.id}: a "Don't know", skip or no_user question needs the resolution you chose`];
    }
    if (how === "skipped" && q.blocking && !q.followed_up) return [`${q.id}: a skipped blocking question is asked once more first`];
    return [];
  }

  /** The source's critical-question ids not yet settled, with why. */
  unsettled(source: string, clarify: string[]): string[] {
    const qs: Question[] = this.decisions().questions || [];
    const out: string[] = [];
    clarify.forEach((_, i) => {
      const cid = `${source}:${i + 1}`;
      const q = qs.find((x) => x.id === cid || (x.covers || []).includes(cid));
      if (!q) out.push(`${cid}: not recorded`);
      else out.push(...Session.questionProblems(q));
    });
    return out;
  }
}
