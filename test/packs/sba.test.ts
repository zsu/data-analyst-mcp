/**
 * sba: fixture r001 (data.sba.gov/data.json) was recorded on 2026-11-07. The FOIA CSVs (60 to 255 MB) are over the
 * fixture size limit; the streaming filter is tested on rows in the 504 file's layout through ingest.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const HEAD = '"AsOfDate","Program","BorrName","GrossApproval","ApprovalFY","NaicsCode","ProjectState"';

describe("sba", () => {
  it("lists the FOIA files from the catalog", async () => {
    const s = newSession();
    const r = await fetchOk(s, "sba", { description: "SBA FOIA files", requests: [{ name: "files", endpoint: "list_files", params: { search: "7(a) & 504 FOIA" } }] });
    expect(r.status).toBe("ok");
    const f = csv(s, "sba", "files");
    expect(f.some((x) => x.file === "uploaded_resources/FOIA_504_FY2010_Present_asof_260930")).toBe(true);
  });

  it("streams an uploaded FOIA file through the filters", async () => {
    const spec = { requests: [{ name: "vt", endpoint: "foia", params: { file: "uploaded_resources/FOIA_504_FY2010_Present_asof_260930", state: "vt", from: "2024", naics: "72" } }] };
    const s = newSession();
    fixtures("sba");
    await prepare(s, "sba", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "sba-up-"));
    fs.writeFileSync(path.join(up, "vt.csv"), "﻿" + [HEAD,
      '"2026-09-30","504","Ace Hospitality, LLC","43500.0","2024","721110","VT"',
      '"2026-09-30","504","B Corp","100000.0","2023","722511","VT"',
      '"2026-09-30","504","C Corp","90000.0","2025","541110","VT"',
      '"2026-09-30","504","D Corp","80000.0","2025","722511","NH"'].join("\r\n"));
    const r: any = await T.ingest(s, { source: "sba", spec, files: [up] });
    expect(r.status).toBe("ok");
    expect(csv(s, "sba", "vt").map((x) => x.BorrName)).toEqual(["Ace Hospitality, LLC"]);
  });

  it("asks for a filter", async () => {
    const spec = { requests: [{ name: "all", endpoint: "foia", params: { file: "uploaded_resources/FOIA_504_FY2010_Present_asof_260930" } }] };
    const s = newSession();
    fixtures("sba");
    await prepare(s, "sba", spec);
    expect((await failure(T.fetchData(s, { source: "sba", spec }))).code).toBe("invalid_request");
  });
});
