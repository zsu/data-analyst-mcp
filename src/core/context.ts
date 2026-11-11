/**
 * The per-call context: the audit trail of HTTP requests made while one tool call runs. In Python this was a
 * process-wide list (one CLI run = one process); a server runs many calls at once, so each gets its own trail.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type SourceRecord = {
  method: string; url: string; status: number; bytes: number; sha256: string; cached: boolean; fetched_at: string;
};

type Run = { sources: SourceRecord[] };
const store = new AsyncLocalStorage<Run>();
const fallback: Run = { sources: [] };

export function withRun<T>(fn: () => T): T {
  return store.run({ sources: [] }, fn);
}

/** The requests made so far in this call (a live array: slice it to keep a part). */
export function trail(): SourceRecord[] {
  return (store.getStore() ?? fallback).sources;
}

type Reporter = (message: string) => void;
const reporter = new AsyncLocalStorage<Reporter>();

/** Run fn with a progress reporter: the server gives one to a tool call whose client asked for progress. */
export function withProgress<T>(report: Reporter, fn: () => T): T {
  return reporter.run(report, fn);
}

/** Say what a long call is doing now. Nothing happens when the client did not ask for progress; never throws. */
export function progress(message: string): void {
  try {
    reporter.getStore()?.(message);
  } catch {
    /* a progress line never fails the call */
  }
}
