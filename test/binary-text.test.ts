/**
 * A CSV or TSV endpoint, or an uploaded .csv, that is handed a workbook, an archive or a PDF refuses it instead of
 * writing the bytes out as rows and columns.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { binaryKind, parseUpload, records } from "../src/core/generic-rest.js";
import { load } from "../src/core/packs.js";
import { isolate } from "./helpers.js";

beforeAll(() => isolate());

const XLS = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504, 0)]);
const body = (b: Buffer) => ({ body: b, text: () => b.toString("latin1"), json: () => null });

describe("binary bodies on text endpoints", () => {
  it("names what the body is", () => {
    expect(binaryKind(XLS)).toMatch(/\.xls/);
    expect(binaryKind(Buffer.from(zipSync({ "a.csv": Buffer.from("a\n1") })))).toMatch(/zip/);
    expect(binaryKind(Buffer.from("%PDF-1.7\n"))).toMatch(/PDF/);
    expect(binaryKind(Buffer.from("year,value\r\n2024,1\r\n"))).toBeNull();
  });

  it("a CSV or TSV endpoint refuses a workbook or a PDF", () => {
    expect(() => records({ records: "$csv" }, body(XLS))).toThrow(/expected CSV text, got a legacy Excel \(\.xls\) workbook/);
    expect(() => records({ records: "$tsv" }, body(Buffer.from("%PDF-1.4 ...")))).toThrow(/expected TSV text, got a PDF/);
    expect(records({ records: "$csv" }, body(Buffer.from("year,value\r\n2024,1\r\n")))).toEqual([{ year: "2024", value: "1" }]);
  });

  it("an upload holding a workbook is refused, under any extension", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "da-bin-"));
    const txt = path.join(d, "table.txt"), csv = path.join(d, "table.csv");
    fs.writeFileSync(txt, XLS);
    fs.writeFileSync(csv, XLS);
    const p = await load("va");
    const req = { name: "t", endpoint: "csv", params: { dataset: "sg3h-czz6" } };
    expect(() => parseUpload(p, req, [txt])).toThrow(/got a legacy Excel/);
    const q = await load("cdc");
    expect(() => parseUpload(q, { name: "t", endpoint: "query", params: { dataset: "leading_death" } }, [csv]))
      .toThrow(/table\.csv is a legacy Excel \(\.xls\) workbook, not CSV text/);
  });
});
