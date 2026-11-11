/**
 * A zip member is read whole: a published file of a few hundred thousand records (crop, county and plan files
 * reach 150,000 lines a year) must come through without running out of stack.
 */
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { records } from "../src/core/generic-rest.js";
import { tsvRecords } from "../src/core/tabular.js";

describe("zip records", () => {
  it("reads a member of 200,000 rows", () => {
    const lines = ["year,value", ...Array.from({ length: 200000 }, (_, i) => `2024,${i}`)].join("\r\n");
    const body = Buffer.from(zipSync({ "big.csv": Buffer.from(lines) }));
    const rows = records({ records: "$zip:*.csv" }, { body, text: () => "", json: () => null });
    expect(rows.length).toBe(200000);
    expect(rows[199999]).toEqual({ year: "2024", value: "199999" });
  });
});

describe("numbered records", () => {
  it("numbers every line of a long text file", () => {
    const text = Array.from({ length: 200000 }, (_, i) => `a\t${i}`).join("\n");
    const rows = tsvRecords({ header_row: 0 }, text);
    expect(rows.length).toBe(200000);
    expect(rows[199999]).toEqual({ row: 200000, col1: "a", col2: "199999" });
  });
});
