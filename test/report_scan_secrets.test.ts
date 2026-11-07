/** scan_secrets: the 32-hex rule for key-echoing sources applies everywhere except other sources' own data (a port of
 * tests/test_scan_secrets.py, plus the scan cases of test_report_chain.py's TestSecrets). */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanFile, scanText, scanTree } from "../src/report/scan_secrets.js";
import { isolate } from "./helpers.js";

const HEX = "0123456789abcdef0123456789abcdef";

function write(p: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

describe("hex32 scope", () => {
  let out: string;
  beforeEach(() => {
    isolate();
    out = fs.mkdtempSync(path.join(os.tmpdir(), "da-scan-"));
    write(path.join(out, "data", "bls", "series.csv"), "series_id,value\nCUUR0000SA0,1\n");
  });
  afterEach(() => fs.rmSync(out, { recursive: true, force: true }));
  const scan = () => scanTree([out], [], true)[0];

  it("ids in a non-echoing source are not keys", () => {
    write(path.join(out, "data", "usgs", "sites.csv"), `id,station\nsite_${HEX},A\n`);
    expect(scan()).toEqual([]);
  });

  it("hex in the answer or the echoing source still fails", () => {
    write(path.join(out, "answer.md"), `The request used ${HEX}.\n`);
    write(path.join(out, "data", "bls", "errors.txt"), `key ${HEX} invalid\n`);
    const hits = scan();
    expect(hits.some((h) => h.includes("answer.md"))).toBe(true);
    expect(hits.some((h) => h.includes("errors.txt"))).toBe(true);
  });

  it("pdf document ids are not keys", () => {
    write(path.join(out, "published", "raw", "statement.pdf"),
      Buffer.from(`%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<</ID[<${HEX.toUpperCase()}><${HEX}>]>>\n%%EOF\n`, "latin1"));
    expect(scan()).toEqual([]);
    expect(scanTree([out], [HEX], true)[0].length).toBeGreaterThan(0);
  });

  it("saved reference pages are not keys", () => {
    const page = path.join(out, "references", "nber2008.html");
    write(page, `<script src="https://cdn-cookieyes.com/client_data/${HEX}/script.js"></script>\n`);
    expect(scan()).toEqual([]);
    expect(scanTree([out], [HEX], true)[0].length).toBeGreaterThan(0);
    write(page, `<a href="https://api.eia.gov/v2/x?api_key=${HEX}">x</a>\n`);
    expect(scan().length).toBeGreaterThan(0);
    write(path.join(out, "notes", "references", "x.txt"), `token ${HEX}\n`);      // only the top folder
    expect(scan().some((h) => h.includes("notes"))).toBe(true);
  });

  it("a site key in a page the cite tool downloaded is not a secret; key values still are", () => {
    const page = path.join(out, "references", "cpi_series.html");
    const site = "Ab12C-dE34F-gH56i-Jk78L-mN90o";
    const body = `<script>window._API_key="${site}",function(){}</script>\n`;
    write(page, body);
    const rec = (o: object = {}) => write(path.join(out, "references", "opened.json"), JSON.stringify({ cpi_series: {
      url: "https://example.gov/timeseries/X", file: "references/cpi_series.html",
      sha256: crypto.createHash("sha256").update(body).digest("hex"), bytes: body.length, opened: "2026-11-07T00:00:00Z",
      via: "download", content_type: "text/html", ...o } }));
    expect(scan().length).toBeGreaterThan(0);                                        // no record: scanned as any file
    rec();
    expect(scan()).toEqual([]);
    expect(scanTree([out], [site], true)[0].length).toBeGreaterThan(0);              // a configured key value: still caught
    rec({ via: "file" });                                                            // text the model passed in
    expect(scan().length).toBeGreaterThan(0);
    rec({ url: "https://example.gov/x?api_key=zq99999999999999999999" });            // fetched with a credential
    expect(scan().length).toBeGreaterThan(0);
    rec();
    write(page, body + `<p>api_key = "zq99999999999999999999"</p>\n`);               // changed since it was saved
    expect(scan().length).toBeGreaterThan(0);
  });

  it("zip members follow the same rule", () => {
    write(path.join(out, "replication_package.zip"), Buffer.from(zipSync({
      "data/usgs/sites.csv": Buffer.from(`id\nsite_${HEX}\n`), "notes.txt": Buffer.from(`token ${HEX}\n`) })));
    const hits = scan();
    expect(hits.some((h) => h.includes("data/usgs"))).toBe(false);
    expect(hits.some((h) => h.includes("notes.txt"))).toBe(true);
  });

  it("a literal key is caught anywhere", () => {
    const key = "zz" + HEX.slice(0, 30);
    write(path.join(out, "data", "usgs", "sites.csv"), `id\n${key}\n`);
    expect(scanTree([out], [key], true)[0].length).toBeGreaterThan(0);
  });
});

describe("scan files and text", () => {
  it("finds key-shaped values, keys in zip members, and never prints a key", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "da-scan-"));
    try {
      const key = "zq" + "9".repeat(30);
      write(path.join(tmp, "a.txt"), `url https://x.org/api?series=1&api_key=${key}\n`);
      write(path.join(tmp, "ok.txt"), "url https://x.org/api?api_key=[REDACTED] and {API_KEY}\nsha " + "ab".repeat(32) + "\n");
      write(path.join(tmp, "p.zip"), Buffer.from(zipSync({ "inner.txt": [Buffer.from(`the key is ${key.toUpperCase()}`), { level: 6 }] })));
      expect(scanFile(path.join(tmp, "a.txt"), []).length).toBeGreaterThan(0);
      expect(scanFile(path.join(tmp, "ok.txt"), [], true)).toEqual([]);
      const hits = scanFile(path.join(tmp, "p.zip"), [key]);
      expect(hits.some((h) => h.includes("p.zip!inner.txt"))).toBe(true);
      expect(hits.every((h) => !h.includes(key) && !h.includes(key.toUpperCase()))).toBe(true);
      write(path.join(tmp, "h.txt"), "error: invalid key 0123456789abcdef0123456789abcdef\n");
      expect(scanFile(path.join(tmp, "h.txt"), [])).toEqual([]);
      expect(scanFile(path.join(tmp, "h.txt"), [], true).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a 32-hex series id in a URL is not a key; a registrationkey is", () => {
    const hexid = "d7e27b7b09a3a7feae95b9c61781fcd8";
    expect(scanText(`https://www.federalreserve.gov/x.aspx?rel=H15&series=${hexid}`, [], true)).toEqual([]);
    expect(scanText(`https://api.bls.gov/x?registrationkey=${hexid}`, [], true).length).toBeGreaterThan(0);
  });
});
