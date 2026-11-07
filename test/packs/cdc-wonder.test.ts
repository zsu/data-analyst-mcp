/**
 * cdc-wonder: manual only (wonder.cdc.gov refuses this client), so there are no recorded fixtures. The export
 * reader is tested on a few lines written here in the layout described in source.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { exportRows } from "../../src/adapters/cdc-wonder.js";
import * as T from "../../src/tools.js";
import { csv, failure, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const EXPORT = ['"Notes"\t"State"\t"State Code"\t"Deaths"\t"Population"\t"Crude Rate"',
  '\t"Alabama"\t"01"\t812\t5108468\t15.9', '\t"Alaska"\t"02"\t201\t733406\t27.4',
  '"Total"\t\t\t1013\t5841874\t17.3', '"---"', '"Dataset: Underlying Cause of Death, 2018-2023, Single Race"',
  '"Query Parameters:"', '"---"'].join("\r\n");

describe("cdc-wonder", () => {
  it("reads an export up to its notes", () => {
    const rows = exportRows(EXPORT);
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({ State: "Alabama", "State Code": "01", Deaths: "812" });
    expect(rows[2].Notes).toBe("Total");
  });

  it("refuses fetch and ingests the uploaded export", async () => {
    const spec = { description: "Suicide deaths by state, 2023", requests: [{ name: "suicide_2023", endpoint: "export",
      params: { database: "Underlying Cause of Death, 2018-2023, Single Race" } }] };
    const s = newSession();
    fixtures("cdc-wonder");
    await prepare(s, "cdc-wonder", spec);
    const f = await failure(T.fetchData(s, { source: "cdc-wonder", spec }));
    expect(f.code).toBe("agency_unavailable");
    expect(f.message).toContain("data use restrictions");
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "wonder-up-"));
    fs.writeFileSync(path.join(up, "suicide_2023.txt"), EXPORT);
    const r: any = await T.ingest(s, { source: "cdc-wonder", spec, files: [up] });
    expect(r.status).toBe("ok");
    expect(csv(s, "cdc-wonder", "suicide_2023").map((x) => x.State)).toEqual(["Alabama", "Alaska", ""]);
  });
});
