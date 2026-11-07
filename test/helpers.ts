/**
 * Offline test helpers. Each test runs against the pack's recorded fixtures (test/packs/<id>/fixtures, the
 * Python skill's recordings, unchanged), in a fresh temporary workspace, with no key in reach: key variables are
 * removed and the config folders point at an empty temp home.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../src/core/packs.js";
import { readCsv } from "../src/core/tabular.js";
import { ToolError } from "../src/envelope.js";
import { Session } from "../src/session.js";
import * as T from "../src/tools.js";

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

export function isolate(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "da-mcp-home-"));
  for (const k of Object.keys(process.env)) {
    if (k.endsWith("_API_KEY") || ["AQS_EMAIL", "HUD_USER_TOKEN", "DATA_ANALYST_RECORD"].includes(k)) delete process.env[k];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.DATA_ANALYST_CONFIG_DIR = path.join(home, ".config", "data-analyst");
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.DATA_ANALYST_OUT = path.join(home, "out");
  return home;
}

export function fixtures(source: string): void {
  process.env.DATA_ANALYST_FIXTURES = path.join(TEST_DIR, "packs", source, "fixtures");
}

export function newSession(): Session {
  return new Session(undefined, fs.mkdtempSync(path.join(os.tmpdir(), "da-mcp-ws-")));
}

/** Run the steps the gate requires for a source: brief, schema of every endpoint the spec uses, decisions. */
export async function prepare(s: Session, source: string, spec: any): Promise<void> {
  const brief: any = await T.sourceBrief(s, { source });
  const names = T.usedRequests(await load(source), spec);
  if (names.length) await T.requestSchema(s, { source, names });
  T.recordDecisions(s, { questions: brief.questions_to_ask.map((q: any) => ({ id: q.id, question: q.question,
    how: "not_asked", reason_code: "settled_by_request", request: "test request" })) });
}

/** prepare + fetch; returns the result. */
export async function fetchOk(s: Session, source: string, spec: any): Promise<any> {
  fixtures(source);
  await prepare(s, source, spec);
  return T.fetchData(s, { source, spec });
}

export function csv(s: Session, source: string, name: string): Record<string, string>[] {
  return readCsv(fs.readFileSync(path.join(s.workspace, "data", source, `${name}.csv`), "utf8")) as Record<string, string>[];
}

/** The failure envelope a tool call throws (fails the test when it does not throw). */
export async function failure(p: Promise<unknown> | (() => unknown)): Promise<any> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof ToolError) return e.failure;
    throw e;
  }
  throw new Error("expected a ToolError");
}

/** A fake key for each variable the source's auth uses (as the Python tests set them): URLs drop keys, so the
 * recorded fixtures still match. Returns the variable names set. */
export async function fakeKeys(source: string, value = "x".repeat(40)): Promise<string[]> {
  const a = (await load(source)).policy.auth;
  const names = [a.env, ...(a.alt_env || []), ...Object.values(a.extra || {})].filter((x): x is string => !!x);
  for (const n of names) process.env[n] = n.includes("EMAIL") ? "test@example.com" : value;
  return names;
}
