/**
 * check_key's live test (the packs' ping hooks), through MCP so every output passes the redaction the server applies.
 * Accepted and rejected answers come from fixtures (FRED's recorded series call; hand-written Census pages); an
 * unreachable host is a fetch that fails, with the URLs it was asked for checked: the key goes only to its own site.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { fixtures, isolate, newSession } from "./helpers.js";

const FAKE = "FAKEKEY-check-0123456789abcdef";
let client: Client;
const outputs: string[] = [];

async function check(source: string, extra: Record<string, unknown> = {}): Promise<any> {
  const r: any = await client.callTool({ name: "check_key", arguments: { source, ...extra } });
  const text = r.content[0].text as string;
  outputs.push(text);
  expect(r.isError).toBeFalsy();
  return JSON.parse(text);
}

/** Hand-written fixtures in a temporary folder: {"GET <url>": {body, status}}. */
function handFixtures(entries: Record<string, { body: string; status?: number }>): void {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "da-mcp-fx-"));
  fs.writeFileSync(path.join(d, "index.json"), JSON.stringify(entries));
  process.env.DATA_ANALYST_FIXTURES = d;
}

const CENSUS_PING = "GET https://api.census.gov/data/2023/acs/acs5?get=NAME&for=us%3A1";

beforeAll(async () => {
  isolate();
  process.env.CENSUS_API_KEY = FAKE;
  process.env.FRED_API_KEY = FAKE + "-fred";
  process.env.DATA_GOV_API_KEY = FAKE + "-dg";
  const server = createServer(newSession());
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("check_key live test", () => {
  it("an accepted key (census, an adapter's ping)", async () => {
    handFixtures({ [CENSUS_PING]: { body: '[["NAME","us"],\n["United States","1"]]' } });
    const k = await check("census");
    expect(k.key.configured).toBe(true);
    expect(k.key.live).toMatchObject({ tested: true, outcome: "accepted" });
    expect(k.key.live.code).toBeUndefined();
    expect(k.can_fetch).toBe(true);
    expect(k.fix).toBeUndefined();
  });

  it("an accepted key (fred, a deep pack's ping, recorded)", async () => {
    fixtures("fred");
    const k = await check("fred");
    expect(k.key.live).toMatchObject({ tested: true, outcome: "accepted" });
    expect(k.can_fetch).toBe(true);
  });

  it("a rejected key (census invalid_key page)", async () => {
    handFixtures({ [CENSUS_PING]: { body: "<html><head><title>Invalid Key</title></head><body>Invalid Key: the key " +
      "you supplied is not valid.</body></html>" } });
    const k = await check("census");
    expect(k.key.live).toMatchObject({ tested: true, outcome: "rejected", code: "key_rejected" });
    expect(k.key.live.fix).toContain("mistyped or expired");
    expect(k.key.live.fix).toContain("setup census");
    expect(k.can_fetch).toBe(false);
    expect(k.fix).toBe(k.key.live.fix);
  });

  it("a rejected key (fred, HTTP 400 api_key not registered)", async () => {
    handFixtures({ "GET https://api.stlouisfed.org/fred/series?series_id=GNPCA&file_type=json": { status: 400,
      body: '{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not registered.  ' +
        'Read https://fred.stlouisfed.org/docs/api/api_key.html for more information."}' } });
    const k = await check("fred");
    expect(k.key.live).toMatchObject({ tested: true, outcome: "rejected", code: "key_rejected" });
    expect(k.can_fetch).toBe(false);
  });

  it("an unreachable host: not a verdict on the key, and the key went only to its own site", async () => {
    delete process.env.DATA_ANALYST_FIXTURES;
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    }));
    const k = await check("census");
    expect(k.key.live).toMatchObject({ tested: true, outcome: "unreachable", code: "agency_unavailable" });
    expect(k.key.live.detail).toContain("ENOTFOUND");
    expect(k.key.live.fix).toContain("check_key again");
    expect(k.can_fetch).toBe(true);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(new URL(u).hostname).toBe("api.census.gov");
  });

  it("an answer that says neither (HTTP 503) is unclear", async () => {
    handFixtures({ [CENSUS_PING]: { status: 503, body: "Service Unavailable" } });
    const k = await check("census");
    expect(k.key.live).toMatchObject({ tested: true, outcome: "unclear", code: "agency_unavailable" });
  });

  it("a source without a live check, live: false, and no key: not tested", async () => {
    let k = await check("fda");
    expect(k.key.configured).toBe(true);
    expect(k.key.live).toMatchObject({ tested: false });
    expect(k.key.live.reason).toContain("not tested");
    k = await check("census", { live: false });
    expect(k.key.live).toEqual({ tested: false, reason: "not asked (live: false)" });
    k = await check("eia");
    expect(k.key.configured).toBe(false);
    expect(k.key.live).toEqual({ tested: false, reason: "no key is set up" });
  });

  it("never shows a key", () => {
    expect(outputs.length).toBeGreaterThan(5);
    for (const o of outputs) expect(o).not.toContain(FAKE);
  });
});
