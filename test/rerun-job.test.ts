/**
 * The rerun as a background job (src/analysis/rerun_job.ts): a worker thread, one job per workspace, "call again"
 * when the call must answer first; and open_workspace, which reopens an earlier workspace after a restart.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { awaitRerun, RerunPending, startRerun, workspaceStamp } from "../src/analysis/rerun_job.js";
import { TOOLS as ANALYSIS } from "../src/analysis/tools.js";
import { TOOLS as REPORT } from "../src/report/tools.js";
import { listWorkspaces, openWorkspaceTool } from "../src/workspace_tool.js";
import { workspaceRoot } from "../src/core/env.js";
import { Session } from "../src/session.js";
import { failure, isolate, newSession } from "./helpers.js";

beforeAll(() => {
  isolate();
  delete process.env.DATA_ANALYST_RERUN_INLINE;
});

const tool = (name: string) => [...ANALYSIS, ...REPORT].find((t) => t.name === name)!.handler;

function put(ws: string, rel: string, text: string): void {
  const p = path.join(ws, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/** A workspace with one data table and one exhibit made by compute (so it has a recipe to replay). */
async function workspace(s = newSession()): Promise<Session> {
  put(s.workspace, "data/x/t.csv", "g,v\r\na,1\r\na,2\r\nb,5\r\n");
  await tool("compute")(s, { inputs: { t: "data/x/t.csv" }, save_as: "exhibits/sums.csv",
    steps: [{ groupby: ["g"], rollup: { total: "sum(v)" } }] });
  return s;
}

describe("rerun job", () => {
  it("replays in a worker, keeps one job per workspace, and keeps the finished result", async () => {
    const s = await workspace();
    const job = startRerun(s.workspace)!;
    expect(job.worker).toBeDefined(); // a worker thread, not this one
    expect(startRerun(s.workspace)).toBe(job); // a second call waits on the same job
    const r = await awaitRerun(s.workspace, Date.now() + 60_000);
    expect(r.exhibits["exhibits/sums.csv"]).toEqual({ same: true });
    expect(startRerun(s.workspace)).toBe(job); // nothing changed: the result is kept
    const t = Date.now();
    await awaitRerun(s.workspace);
    expect(Date.now() - t).toBeLessThan(1000);
  }, 60_000);

  it("starts over when the files it reads change", async () => {
    const s = await workspace();
    await awaitRerun(s.workspace, Date.now() + 60_000);
    const before = workspaceStamp(s.workspace);
    put(s.workspace, "data/x/t.csv", "g,v\r\na,1\r\na,3\r\nb,5\r\n"); // same size, new content
    expect(workspaceStamp(s.workspace)).not.toBe(before);
    const r = await awaitRerun(s.workspace, Date.now() + 60_000);
    expect(r.exhibits["exhibits/sums.csv"].same).toBe(false);
    expect(r.exhibits["exhibits/sums.csv"].detail).toContain("inputs changed");
  }, 60_000);

  it("answers 'still running' at the deadline, and the same job finishes", async () => {
    const s = await workspace();
    const e = await awaitRerun(s.workspace, Date.now()).catch((x) => x);
    expect(e).toBeInstanceOf(RerunPending);
    expect((await awaitRerun(s.workspace, Date.now() + 60_000)).exhibits["exhibits/sums.csv"].same).toBe(true);
  }, 60_000);

  it("the rerun tool says in_progress with retry_after_s, then answers", async () => {
    const s = await workspace();
    process.env.DATA_ANALYST_RERUN_WAIT_S = "0";
    try {
      const f = await failure(Promise.resolve().then(() => tool("rerun")(s, {})));
      expect(f.code).toBe("in_progress");
      expect(f.retry_after_s).toBe(30);
      expect(f.fix).toContain("does not start another");
    } finally {
      delete process.env.DATA_ANALYST_RERUN_WAIT_S;
    }
    const ok: any = await tool("rerun")(s, {});
    expect(ok.summary.reproduced).toBe(true);
  }, 60_000);
});

describe("open_workspace", () => {
  it("lists earlier workspaces and reopens one; refuses anything else", async () => {
    const old = await workspace(new Session()); // under the workspace root, as a server process makes it
    put(old.workspace, "report.json", JSON.stringify({ title: "Maryland federal employees" }));
    const s = new Session(); // the restarted server's new, empty workspace
    const list: any = openWorkspaceTool(s, {});
    const row = list.summary.workspaces.find((w: any) => w.name === old.id);
    expect(row.title).toBe("Maryland federal employees");
    expect(row.has).toEqual(expect.arrayContaining(["report.json", "data"]));
    const empty0 = new Session();
    const names = listWorkspaces(s.workspace).map((w) => w.name);
    expect(names).not.toContain(empty0.id); // an empty workspace is not listed ...
    expect(listWorkspaces(s.workspace).find((w) => w.name === s.id)).toMatchObject({ current: true, has: [] }); // ... but this one is

    const r: any = openWorkspaceTool(s, { path: old.id }); // by name, or by path
    expect(r.summary.workspace).toBe(fs.realpathSync(old.workspace));
    expect(s.workspace).toBe(fs.realpathSync(old.workspace));
    expect(r.notes.join(" ")).toContain("source_brief");

    for (const p of [path.dirname(old.workspace), workspaceRoot() + "/..", newSession().workspace, "nope"]) {
      expect((await failure(Promise.resolve().then(() => openWorkspaceTool(s, { path: p })))).code).toBe("invalid_request");
    }
    const empty = new Session();
    expect((await failure(Promise.resolve().then(() => openWorkspaceTool(s, { path: empty.workspace })))).message)
      .toContain("holds no workspace files");
  });

  it("is refused on the hosted server", async () => {
    process.env.DATA_ANALYST_MODE = "remote";
    try {
      expect((await failure(Promise.resolve().then(() => openWorkspaceTool(newSession(), {})))).code).toBe("not_supported");
    } finally {
      delete process.env.DATA_ANALYST_MODE;
    }
  });
});
