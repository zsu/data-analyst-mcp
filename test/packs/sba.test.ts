/**
 * sba: fixture r001 (data.sba.gov/data.json) was recorded on 2026-11-07. The FOIA CSVs (60 to 255 MB) are over the
 * fixture size limit; the streaming filter and the cohort totals are tested on rows in the files' layouts through ingest.
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

  it("totals an uploaded 7(a) file per approval cohort", async () => {
    const H7 = '"AsOfDate","Program","GrossApproval","SBAGuaranteedApproval","ApprovalFY","ProcessingMethod","NaicsCode","ProjectState","LoanStatus","GrossChargeOffAmount"';
    const spec = { requests: [{ name: "c7a", endpoint: "cohorts", params: { file: "uploaded_resources/FOIA_7a_FY2010_FY2019_asof_260930", group_by: ["naics2"] } }] };
    const s = newSession();
    fixtures("sba");
    await prepare(s, "sba", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "sba-up-"));
    fs.writeFileSync(path.join(up, "7a.csv"), "﻿" + [H7,
      '"2026-09-30"," 7A","100000.0","75000.0","2010","SBA Express Program","722511","GA","P I F","0.0"',
      '"2026-09-30"," 7A","50000.0","25000.0","2010","SBA Express Program","722513","GA","CHGOFF","20000.5"',
      '"2026-09-30"," 7A","30000.0","15000.0","2010","SBA Express Program","721110","TX","CANCLD","0.0"',
      '"2026-09-30"," 7A","40000.0","30000.0","2010","Preferred Lenders Program","541110","TX","COMMIT",',
      '"2026-09-30"," 7A","60000.0","45000.0","2011","Preferred Lenders Program","722511","TX","EXEMPT","0.0"'].join("\r\n"));
    const r: any = await T.ingest(s, { source: "sba", spec, files: [up] });
    expect(r.status).toBe("ok");
    const t = csv(s, "sba", "c7a");
    expect(t.map((x) => `${x.ApprovalFY}/${x.naics2}`)).toEqual(["2010/54", "2010/72", "2011/72"]);
    const c = t.find((x) => x.ApprovalFY === "2010" && x.naics2 === "72")!;
    expect(c).toMatchObject({ as_of: "2026-09-30", loans: "3", gross_approval: "180000", sba_guaranteed: "115000",
      loans_disbursed: "2", disbursed_gross_approval: "150000", disbursed_sba_guaranteed: "100000",
      loans_pif: "1", loans_chgoff: "1", loans_cancld: "1", gross_chargeoff_amount: "20000.5", loans_other_status: "0" });
    expect(t.find((x) => x.naics2 === "54")).toMatchObject({ loans_undisbursed: "1", loans_disbursed: "0" });
  });

  it("leaves the guaranty columns out of 504 cohorts and checks group_by", async () => {
    const spec = { requests: [{ name: "c504", endpoint: "cohorts", params: { file: "uploaded_resources/FOIA_504_FY2010_Present_asof_260930", state: "VT" } }] };
    const s = newSession();
    fixtures("sba");
    await prepare(s, "sba", spec);
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "sba-up-"));
    fs.writeFileSync(path.join(up, "504.csv"), [HEAD + ',"LoanStatus","GrossChargeOffAmount"',
      '"2026-09-30","504","A","43500.0","2024","721110","VT","NOT FUNDED","0.0"',
      '"2026-09-30","504","B","100000.0","2024","722511","VT","PIF","0.0"',
      '"2026-09-30","504","C","90000.0","2024","541110","NH","CHGOFF","9000.0"'].join("\r\n"));
    const r: any = await T.ingest(s, { source: "sba", spec, files: [up] });
    expect(r.status).toBe("ok");
    const [c] = csv(s, "sba", "c504");
    expect(c).toMatchObject({ ApprovalFY: "2024", loans: "2", loans_undisbursed: "1", loans_disbursed: "1", disbursed_gross_approval: "100000" });
    expect("sba_guaranteed" in c).toBe(false);
    const bad = { requests: [{ name: "c", endpoint: "cohorts", params: { file: "uploaded_resources/FOIA_504_FY2010_Present_asof_260930", group_by: "Lender" } }] };
    const s2 = newSession();
    fixtures("sba");
    await prepare(s2, "sba", bad);
    expect((await failure(T.fetchData(s2, { source: "sba", spec: bad }))).code).toBe("invalid_request");
  });

  it("asks for a filter", async () => {
    const spec = { requests: [{ name: "all", endpoint: "foia", params: { file: "uploaded_resources/FOIA_504_FY2010_Present_asof_260930" } }] };
    const s = newSession();
    fixtures("sba");
    await prepare(s, "sba", spec);
    expect((await failure(T.fetchData(s, { source: "sba", spec }))).code).toBe("invalid_request");
  });
});
