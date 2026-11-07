/**
 * The result envelope every tool returns.
 *   success: { status: "ok" | "partial", summary, files, citation?, notes }
 *   failure: { status: "error", code, message, fix, retry_after_s?, upstream_excerpt? }
 * Every string passes through redact() before it leaves the server.
 */
import type { SourceRecord } from "./core/context.js";
import { mode, setupCommand } from "./core/env.js";
import { DataError } from "./core/http.js";
import { redactDeep } from "./core/keys.js";
import type { Policy } from "./core/policy.js";
import * as pol from "./core/policy.js";

export type Code = "invalid_request" | "not_found" | "not_supported" | "agency_rejected" | "agency_unavailable" |
  "key_missing" | "key_rejected" | "rate_limited" | "gate_blocked" | "server_error";

export type Failure = { status: "error"; code: Code; message: string; fix: string; retry_after_s?: number;
  upstream_excerpt?: string; [k: string]: unknown };

export type Citation = { text: string; publisher: string; title: string; page_url: string; request_urls: string[];
  retrieved_at: string; vintage: string; notices: string[] };

export class ToolError extends Error {
  constructor(public failure: Failure) {
    super(failure.message);
  }
}

export function fail(code: Code, message: string, fix: string, extra: Record<string, unknown> = {}): ToolError {
  return new ToolError({ status: "error", code, message, fix, ...extra });
}

/** The citation object attached to every successful data result. */
export function citation(P: Policy, o: { route?: string; text?: string; requests?: SourceRecord[]; retrieved?: string;
  vintage?: string; dataset?: string }): Citation {
  const retrieved = o.retrieved || new Date().toISOString();
  return {
    text: o.text || pol.citation(P, o.route || "", { retrieved, vintage: o.vintage || "", dataset: o.dataset || "" }),
    publisher: P.agency, title: P.title, page_url: P.homepage,
    request_urls: [...new Set((o.requests || []).map((r) => r.url))].slice(0, 5),
    retrieved_at: retrieved, vintage: o.vintage || "", notices: P.notices || [],
  };
}

function keyFix(P: Policy): string {
  const env = P.auth.env || "the key";
  const signup = P.auth.signup_url ? ` A free key is at ${P.auth.signup_url}.` : "";
  const keyless = P.routes?.manual?.how ? ` Without a key: ${P.routes.manual.how}` : "";
  if (mode() === "remote") {
    return `Tell the user this source needs ${env}: they add their own key on this server's settings page (never in ` +
      `chat).${signup}${keyless}`;
  }
  return `Give the user this command to run in their own terminal (never run it for them, never ask for the key in ` +
    `chat): ${setupCommand(P.id)} . It asks for the key with hidden input and stores it; then call fetch again.${signup}${keyless}`;
}

/** A DataError from a pack as a Failure with the code and fix the model acts on. */
export function fromDataError(e: DataError, P?: Policy): Failure {
  const m = e.message;
  const ra = e.retryAfter !== undefined ? { retry_after_s: Math.ceil(e.retryAfter) } : {};
  switch (e.kind) {
    case "spec":
      return { status: "error", code: "invalid_request", message: m, fix: "Fix the request from request_schema and source_brief, then call fetch again." };
    case "bad_request":
    case "api":
      return { status: "error", code: "agency_rejected", message: m, upstream_excerpt: m.slice(0, 600),
        fix: "The agency refused a value: change it as the message says (request_schema lists valid parameters; " +
          "source_brief has the traps). Never repeat the call unchanged." };
    case "not_found":
      return { status: "error", code: "not_found", message: m,
        fix: "Check the IDs or codes against source_brief and request_schema (search). If the item really does not " +
          'exist yet, add "allow_empty": true to that request and say so in the answer.' };
    case "key_missing":
      return { status: "error", code: "key_missing", message: m, fix: P ? keyFix(P) : "A key is needed for this source." };
    case "auth":
      return { status: "error", code: "key_rejected", message: m,
        fix: (P ? keyFix(P) : "") + " The stored key was rejected: it may be mistyped or expired." };
    case "rate_limit":
      return { status: "error", code: "rate_limited", message: m, ...ra,
        fix: "Wait as retry_after_s says, then call again with fewer or smaller requests." };
    case "rate":
      return { status: "error", code: "agency_unavailable", message: m, ...ra,
        fix: "The agency's rate limit is spent. Do not retry before retry_after_s; say so to the user, and use another " +
          "source only if it has the same measure." };
    case "network":
    case "http":
    case "blocked":
      return { status: "error", code: "agency_unavailable", message: m, ...ra,
        fix: "The agency did not answer (already retried). Tell the user the data could not be fetched now, with this " +
          "message" + (P?.routes?.manual?.how ? `, and the manual route: ${P.routes.manual.how}` : "") +
          ". Never substitute numbers from memory." };
    case "install_deps":
      return { status: "error", code: "not_supported", message: m, fix: "This file type cannot be read here; follow the message." };
    case "fixture_missing":
    default:
      return { status: "error", code: "server_error", message: m, fix: "Report this error to the user; do not retry unchanged." };
  }
}

/** Any thrown value as a redacted Failure. */
export function toFailure(e: unknown, P?: Policy): Failure {
  if (e instanceof ToolError) return redactDeep(e.failure);
  if (e instanceof DataError) return redactDeep(fromDataError(e, P));
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return redactDeep({ status: "error", code: "server_error", message: msg,
    fix: "An unexpected error: report it to the user; do not retry unchanged." } as Failure);
}
