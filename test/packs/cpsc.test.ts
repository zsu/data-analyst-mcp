/**
 * cpsc: fixtures r001 (recalls announced 2026-10-15 to 2026-10-31) and r002 (ProductType Slides since 2025) were
 * recorded from the SaferProducts.gov Recall API on 2026-11-07. NEISS cannot be fetched (cpsc.gov refuses
 * scripts); its upload reader is tested on a few lines written here in the published column layout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

describe("cpsc", () => {
  it("fetches recalls as one row per recall, and filters hazards here", async () => {
    const s = newSession();
    const r = await fetchOk(s, "cpsc", { description: "Recalls late October 2026; fire hazards", requests: [
      { name: "late_oct", endpoint: "recalls", params: { RecallDateStart: "2026-10-15", RecallDateEnd: "2026-10-31" } },
      { name: "slides", endpoint: "recalls", params: { ProductType: "Slides", RecallDateStart: "2025-01-01" } }] });
    expect(r.status).toBe("ok");
    const rows = csv(s, "cpsc", "late_oct");
    expect(rows.length).toBe(23);
    const bodum = rows.find((x) => x.recall_number === "27055")!;
    expect(bodum.recall_date).toBe("2026-10-29");
    expect(bodum.number_of_units).toBe("5.9 million");
    expect(bodum.manufacturer_countries).toBe("Portugal | Thailand");
    expect(csv(s, "cpsc", "slides")[0].product_types).toBe("Slides or Sliding Boards");

    const s2 = newSession();
    await fetchOk(s2, "cpsc", { requests: [{ name: "fire", endpoint: "recalls",
      params: { RecallDateStart: "2026-10-15", RecallDateEnd: "2026-10-31", hazard: "fire", country: "China" } }] });
    const fire = csv(s2, "cpsc", "fire");
    expect(fire.length).toBeGreaterThan(0);
    expect(fire.every((x) => /fire/i.test(x.hazards) && x.manufacturer_countries.split(" | ").includes("China"))).toBe(true);
  });

  it("refuses a recall request without an API filter", async () => {
    const s = newSession();
    fixtures("cpsc");
    const spec = { requests: [{ name: "x", endpoint: "recalls", params: { hazard: "fire" } }] };
    await prepare(s, "cpsc", spec);
    expect((await failure(T.fetchData(s, { source: "cpsc", spec }))).code).toBe("invalid_request");
  });

  it("sends NEISS to the manual route and reads the uploaded year", async () => {
    const spec = { description: "NEISS 2024 cases", requests: [{ name: "neiss_2024", endpoint: "neiss", params: { year: "2024", product: "1807" } }] };
    const s = newSession();
    fixtures("cpsc");
    await prepare(s, "cpsc", spec);
    const f = await failure(T.fetchData(s, { source: "cpsc", spec }));
    expect(f.code).toBe("agency_unavailable");
    expect(f.message).toContain("403");
    const b: any = await T.manualBundle(s, { sources: [{ source: "cpsc", spec }] });
    expect(JSON.stringify(b)).toContain("NEISSQuery/home.aspx");
    const up = fs.mkdtempSync(path.join(os.tmpdir(), "cpsc-up-"));
    const head = "CPSC_Case_Number\tTreatment_Date\tAge\tSex\tProduct_1\tProduct_2\tProduct_3\tNarrative\tStratum\tPSU\tWeight";
    fs.writeFileSync(path.join(up, "neiss_2024.tsv"), [head,
      "240101001\t01/01/2024\t34\t1\t1807\t0\t0\tFELL ON FLOOR\tV\t61\t15.1",
      "240101002\t01/01/2024\t7\t2\t1333\t0\t0\tFELL OFF SKATEBOARD\tS\t42\t80.2",
      "240101003\t01/02/2024\t81\t2\t611\t1807\t0\tSLIPPED IN BATHTUB\tM\t7\t63.5"].join("\r\n"));
    const r: any = await T.ingest(s, { source: "cpsc", spec, files: [up] });
    expect(r.status).toBe("ok");
    const rows = csv(s, "cpsc", "neiss_2024");
    expect(rows.map((x) => x.CPSC_Case_Number)).toEqual(["240101001", "240101003"]);
    expect(rows[1].Weight).toBe("63.5");
  });
});
