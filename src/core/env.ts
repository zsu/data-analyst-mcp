/**
 * Where this runs, where its files are, and what it can write.
 *
 * Modes (DATA_ANALYST_MODE):
 *   local   (default) an MCP server on the user's own computer, started by their assistant over stdio
 *           (`npx data-analyst-mcp`): keys come from the environment or ~/.config/data-analyst/keys.json, and
 *           the user can run `npx data-analyst-mcp setup <source>` in their own terminal.
 *   remote  a hosted server (`serve --http`): keys come only from the server's environment (operator keys)
 *           or the per-user store; key files are never read; workspaces are per session and temporary.
 * Nothing is ever written inside the package folder (packs/, guide/): it may be read-only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The package root (holds packs/ and guide/): two levels above src/core or dist/core. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PACKS_DIR = process.env.DATA_ANALYST_PACKS_DIR || path.join(ROOT, "packs");
export const GUIDE_DIR = path.join(ROOT, "guide");

export type Mode = "local" | "remote";
const TRUTHY = new Set(["1", "true", "yes"]);

export function mode(): Mode {
  return (process.env.DATA_ANALYST_MODE || "").trim().toLowerCase() === "remote" ? "remote" : "local";
}

export function truthy(v: string | undefined): boolean {
  return TRUTHY.has((v || "").trim().toLowerCase());
}

export function writable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write_test_${process.pid}`);
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Persistent cache root (DATA_ANALYST_CACHE, else ~/.cache/data-analyst); a temp folder when not writable. */
export function cacheRoot(): string {
  const want = process.env.DATA_ANALYST_CACHE || path.join(os.homedir(), ".cache", "data-analyst");
  return writable(want) ? want : path.join(os.tmpdir(), "data-analyst-cache");
}

/** Root for session workspaces: DATA_ANALYST_OUT, else <tmp>/data-analyst-mcp. */
export function workspaceRoot(): string {
  return process.env.DATA_ANALYST_OUT || path.join(os.tmpdir(), "data-analyst-mcp");
}

/** The command a local user runs in their own terminal to store a key with hidden input. */
export function setupCommand(source: string): string {
  return `npx -y data-analyst-mcp setup ${source}`;
}
