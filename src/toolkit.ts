/**
 * Tool definitions that modules contribute without editing server.ts: src/analysis/tools.ts and
 * src/report/tools.ts each export `TOOLS: ToolDef[]`, and server.ts registers every one with the same wrapper
 * (redaction, remote links, the error envelope) as its own tools.
 */
import type { ZodRawShape } from "zod";
import type { Session } from "./session.js";

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; destructiveHint?: boolean };
  /** Throw ToolError (envelope.ts) for a failure with a code and a fix; return a JSON-able result. */
  handler: (s: Session, args: any) => unknown | Promise<unknown>;
};
