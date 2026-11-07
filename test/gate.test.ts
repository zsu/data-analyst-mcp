/** The fetch gate: brief, schema and decisions must come first; each refusal names the next step. */
import { beforeAll, describe, expect, it } from "vitest";
import { allPacks } from "../src/core/packs.js";
import * as T from "../src/tools.js";
import { failure, fixtures, isolate, newSession } from "./helpers.js";

const SPEC = { description: "Leading causes of death, New York, 2017", requests: [{ name: "ny_causes_2017",
  endpoint: "query", params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'", $order: "deaths DESC" } }] };

beforeAll(() => {
  isolate();
  fixtures("cdc");
});

describe("fetch gate", () => {
  it("refuses before source_brief", async () => {
    const f = await failure(T.fetchData(newSession(), { source: "cdc", spec: SPEC }));
    expect(f.code).toBe("gate_blocked");
    expect(f.fix).toContain("source_brief");
  });

  it("refuses before request_schema", async () => {
    const s = newSession();
    await T.sourceBrief(s, { source: "cdc" });
    const f = await failure(T.fetchData(s, { source: "cdc", spec: SPEC }));
    expect(f.code).toBe("gate_blocked");
    expect(f.fix).toContain("request_schema");
    expect(f.fix).toContain('["query"]');
  });

  it("refuses until every critical question is settled, and says which", async () => {
    const s = newSession();
    const brief: any = await T.sourceBrief(s, { source: "cdc" });
    expect(brief.questions_to_ask.map((q: any) => q.id)).toEqual(["cdc:1", "cdc:2"]);
    await T.requestSchema(s, { source: "cdc", names: ["query"] });
    let f = await failure(T.fetchData(s, { source: "cdc", spec: SPEC }));
    expect(f.code).toBe("gate_blocked");
    expect(f.unsettled).toEqual(["cdc:1: not recorded", "cdc:2: not recorded"]);

    // a Don't know needs the resolution chosen; settled_by_request needs the user's words
    const r: any = T.recordDecisions(s, { questions: [{ id: "cdc:1", how: "dont_know" }, { id: "cdc:2", how: "not_asked",
      reason_code: "settled_by_request" }] });
    expect(r.status).toBe("partial");
    f = await failure(T.fetchData(s, { source: "cdc", spec: SPEC }));
    expect(f.code).toBe("gate_blocked");

    T.recordDecisions(s, { questions: [{ id: "cdc:1", how: "dont_know", resolution: "final counts (2017 is final)" },
      { id: "cdc:2", how: "not_asked", reason_code: "settled_by_request", request: "leading causes of death in New York, counts" }] });
    const ok: any = await T.fetchData(s, { source: "cdc", spec: SPEC });
    expect(ok.status).toBe("ok");
  });

  it("one question can cover several ids", async () => {
    const s = newSession();
    await T.sourceBrief(s, { source: "cdc" });
    await T.requestSchema(s, { source: "cdc", names: ["query"] });
    T.recordDecisions(s, { questions: [{ id: "counts_final", covers: ["cdc:1", "cdc:2"], answer: "final counts", how: "answered" }] });
    expect((await T.fetchData(s, { source: "cdc", spec: SPEC }) as any).status).toBe("ok");
  });

  it("a blocking question skipped once must be followed up", async () => {
    const s = newSession();
    T.recordDecisions(s, { questions: [{ id: "which_state", blocking: true, how: "skipped", resolution: "New York" }] });
    const r: any = T.recordDecisions(s, { questions: [{ id: "which_state", blocking: true, how: "skipped", resolution: "New York" }] });
    expect(r.problems.join(" ")).toContain("asked once more");
  });

  it("packs whose code is not ported are refused with not_supported", async () => {
    const notReady = (await allPacks()).find((p) => p.missing.length);
    if (!notReady) return; // every pack is ported
    const s = newSession();
    await T.sourceBrief(s, { source: notReady.id });
    const f = await failure(T.fetchData(s, { source: notReady.id, spec: { requests: [{ name: "x", endpoint: "y" }] } }));
    expect(f.code).toBe("not_supported");
  });
});
