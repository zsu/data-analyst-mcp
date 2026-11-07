/** open-payments: ported from tests/sources/open-payments/test_open_payments.py (same fixtures, same values). */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as T from "../../src/tools.js";
import { csv, failure, fetchOk, fixtures, isolate, newSession, prepare } from "../helpers.js";

beforeAll(() => isolate());

const SRC = "open-payments";
const SPEC = { description: "Industry payments to Vermont recipients, program year 2024: state totals and Pfizer general payments",
  requests: [
    { name: "vt_totals_2024", endpoint: "query",
      params: { dataset: "state_totals", where: { state_code: "VT", program_year: "2024" },
        columns: ["state_code", "program_year", "payment_type", "recipient_type", "total_number_of_physicians",
          "total_payment_amount_physician", "total_payment_count_physician"] } },
    { name: "vt_pfizer_2024", endpoint: "query",
      params: { dataset: "general_2024", where: { recipient_state: "VT" },
        conditions: [{ property: "applicable_manufacturer_or_applicable_gpo_making_payment_name", value: "%pfizer%", operator: "LIKE" }],
        columns: ["record_id", "covered_recipient_type", "recipient_city", "applicable_manufacturer_or_applicable_gpo_making_payment_name",
          "total_amount_of_payment_usdollars", "date_of_payment", "nature_of_payment_or_transfer_of_value"] } }] };

async function check(spec: any): Promise<any> {
  const s = newSession();
  fixtures(SRC);
  await prepare(s, SRC, spec);
  return failure(T.fetchData(s, { source: SRC, spec }));
}

describe("open-payments", () => {
  it("fetches by the api route", async () => {
    const s = newSession();
    const r = await fetchOk(s, SRC, SPEC);
    expect(r.status).toBe("ok");
    expect(r.summary.route).toBe("api");
    const tot = csv(s, SRC, "vt_totals_2024");
    const gen = tot.filter((t) => t.payment_type === "General" && t.recipient_type === "Covered Recipient Physician");
    expect(gen[0].total_payment_amount_physician).toBe("1324575.46");
    const pf = csv(s, SRC, "vt_pfizer_2024");
    expect(pf.length).toBe(26);
    expect(pf.every((p) => p.applicable_manufacturer_or_applicable_gpo_making_payment_name.toUpperCase().startsWith("PFIZER"))).toBe(true);
  });

  it("an unfiltered payment file is invalid_request", async () => {
    const f = await check({ requests: [{ name: "all", endpoint: "query", params: { dataset: "general_2024" } }] });
    expect(f.code).toBe("invalid_request");
  });

  it("an amount comparison is invalid_request (text columns)", async () => {
    const bad = { requests: [{ name: "big", endpoint: "query", params: { dataset: "general_2024", where: { recipient_state: "VT" },
      conditions: [{ property: "total_amount_of_payment_usdollars", value: "900", operator: ">" }] } }] };
    const f = await check(bad);
    expect(f.code).toBe("invalid_request");
    expect(f.message).toContain("TEXT");
  });

  it("manual links carry the filters", async () => {
    const s = newSession();
    const r: any = await T.manualBundle(s, { sources: [{ source: SRC, spec: SPEC }] });
    const urls = JSON.parse(fs.readFileSync(path.join(r.bundle, "manifest.json"), "utf8")).items.map((i: any) => i.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u: string) => u.includes("/datastore/query/") && u.includes("conditions%5B0%5D"))).toBe(true);
  });
});
