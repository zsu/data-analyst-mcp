/**
 * The rerun in its own thread (rerun_job.ts starts it): replaying large microdata recipes takes minutes of CPU, and
 * in the server's own thread nothing else could be answered meanwhile. Posts {result} or {error}.
 */
import { parentPort, workerData } from "node:worker_threads";
import { rerunWorkspace } from "./rerun.js";

try {
  parentPort!.postMessage({ result: await rerunWorkspace(workerData.workspace) });
} catch (e) {
  parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) });
}
