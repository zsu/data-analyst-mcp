/**
 * The rerun as a background job, so a tool call returns before its client gives up waiting (a chat that reaches
 * this server through the desktop app waits 60 s; replaying a state's PUMS recipes can take minutes).
 *
 *   one job per workspace, keyed by a fingerprint of the files the rerun reads (facts, lineage, exhibits, data,
 *   published): a call while it runs waits on that same job; a call after it finished gets its result at once;
 *   a call after those files changed stops the old job and starts a new one.
 *   The job runs in a worker thread (the server keeps answering meanwhile); where no worker can start, inline.
 *   awaitRerun waits until a deadline, then throws RerunPending: the tool says "call again".
 *   DATA_ANALYST_RERUN_INLINE=1: every call replays in this thread, nothing kept (tests that stub the rerun).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { Worker } from "node:worker_threads";
import { rerunWorkspace, type RerunResult } from "./rerun.js";

/** How long a tool call waits for the rerun before answering "in progress" (seconds; under the 60 s clients wait). */
export function rerunWaitMs(): number {
  const v = Number(process.env.DATA_ANALYST_RERUN_WAIT_S);
  return (Number.isFinite(v) && v >= 0 ? v : 45) * 1000;
}

const inlineOnly = () => process.env.DATA_ANALYST_RERUN_INLINE === "1";

export class RerunPending extends Error {
  constructor(public elapsedS: number) {
    super(`the rerun is still replaying the exhibit recipes (${elapsedS} s so far); it continues in the background`);
  }
}

type Job = { stamp: string; started: number; worker?: Worker; done: Promise<void>;
  result?: RerunResult; error?: string; finished?: number };
const JOBS = new Map<string, Job>();

const READ = ["facts.json", "exhibits", "data", "published"];

/** Every file the rerun reads: path, size and modification time, and the content of files under 5 MB (a quick
 * same-size edit keeps its size and can keep its time stamp). */
export function workspaceStamp(ws: string): string {
  const h = createHash("sha256");
  const walk = (rel: string) => {
    const abs = path.join(ws, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) walk(path.join(rel, f));
    } else {
      h.update(`${rel}\u0000${st.size}\u0000${st.mtimeMs}\n`);
      if (st.size < 5 << 20) h.update(fs.readFileSync(abs));
    }
  };
  READ.forEach(walk);
  return h.digest("hex");
}

/** The rerun worker's heap (MB): DATA_ANALYST_RERUN_HEAP_MB, else 60 percent of the memory this process may use
 * (a container's limit when it has one), at least the server's own heap limit. Node's default heap follows the
 * machine's memory (about 2 GB in a small container), and replaying a state's PUMS recipes can need more. */
export function rerunHeapMb(): number {
  const set = Number(process.env.DATA_ANALYST_RERUN_HEAP_MB);
  if (Number.isFinite(set) && set >= 256) return Math.floor(set);
  const own = Math.floor(v8.getHeapStatistics().heap_size_limit / 1048576);
  const cap = (process as any).constrainedMemory?.() || 0;
  const mem = cap > 0 && cap < os.totalmem() ? cap : os.totalmem();
  return Math.max(own, Math.floor((mem * 0.6) / 1048576));
}

function workerFile(): { url: URL; execArgv: string[] } {
  const ts = import.meta.url.endsWith(".ts"); // run from the sources (tests, tsx): the worker needs the same loader
  return { url: new URL(ts ? "./rerun_worker.ts" : "./rerun_worker.js", import.meta.url), execArgv: ts ? ["--import", "tsx"] : [] };
}

function start(ws: string, stamp: string): Job {
  const job: Job = { stamp, started: Date.now(), done: Promise.resolve() };
  const inline = async () => {
    try {
      job.result = await rerunWorkspace(ws);
    } catch (e) {
      job.error = e instanceof Error ? e.message : String(e);
    }
  };
  job.done = new Promise<void>((resolve) => {
    const finish = () => ((job.finished = Date.now()), (job.worker = undefined), resolve());
    let w: Worker;
    const heap = rerunHeapMb();
    try {
      const f = workerFile();
      w = new Worker(f.url, { workerData: { workspace: ws }, execArgv: f.execArgv,
        resourceLimits: { maxOldGenerationSizeMb: heap } });
    } catch {
      void inline().then(finish);
      return;
    }
    job.worker = w;
    let answered = false;
    w.on("message", (m: { result?: RerunResult; error?: string }) => {
      answered = true;
      job.result = m.result;
      job.error = m.error;
      void w.terminate();
      finish();
    });
    w.on("error", (e: any) => {
      if (answered) return;
      answered = true;
      // only a worker that could not load (no file, no loader) replays here instead; never one that ran out of
      // memory: the same replay in the server's own thread would take the whole server down
      if (/ERR_WORKER_(PATH|INIT_FAILED|INVALID_EXEC_ARGV)|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|Cannot find (module|package)/
        .test(`${e?.code} ${e?.message}`)) {
        void inline().then(finish);
      } else {
        job.error = e?.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? `the replay ran out of memory (${heap} MB for the rerun): give the server more memory, or set ` +
            "DATA_ANALYST_RERUN_HEAP_MB higher, or make the exhibits from smaller inputs (fetch only the columns used)"
          : e?.message || String(e);
        finish();
      }
    });
    w.on("exit", () => {
      if (!answered) {
        answered = true;
        if (JOBS.get(ws) === job) job.error = "the rerun stopped before it finished";
        finish();
      }
    });
    w.unref(); // a pending rerun never keeps the process alive
  });
  return job;
}

/** The workspace's rerun job, started (or restarted after its files changed) if needed. */
export function startRerun(workspace: string): Job | null {
  if (inlineOnly()) return null;
  const ws = path.resolve(workspace);
  const stamp = workspaceStamp(ws);
  const old = JOBS.get(ws);
  if (old && old.stamp === stamp) return old;
  if (old?.worker) void old.worker.terminate();
  const job = start(ws, stamp);
  JOBS.set(ws, job);
  return job;
}

/** The rerun's result, waiting until `until` (ms since the epoch; default now + rerunWaitMs()). Throws RerunPending
 * when it is still running then, and Error when the rerun itself failed. */
export async function awaitRerun(workspace: string, until = Date.now() + rerunWaitMs()): Promise<RerunResult> {
  if (inlineOnly()) return rerunWorkspace(path.resolve(workspace));
  const job = startRerun(workspace);
  if (!job) return rerunWorkspace(path.resolve(workspace));
  if (job.finished === undefined) {
    const left = until - Date.now();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job.done, new Promise<void>((r) => (timer = setTimeout(r, Math.max(0, left))))]);
    clearTimeout(timer);
  }
  if (job.finished === undefined) throw new RerunPending(Math.round((Date.now() - job.started) / 1000));
  if (job.error !== undefined) throw new Error(job.error);
  return job.result!;
}
