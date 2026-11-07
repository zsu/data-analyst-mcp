/**
 * Smoke test of the hosted mode from the built CLI: start `serve --http` on a free port, connect over streamable
 * HTTP, make one live fetch, and download the CSV through its signed link. Makes real requests.
 *
 *   npm run build && npx tsx scripts/smoke-http.ts
 */
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});
const env = { ...process.env, DATA_ANALYST_OUT: path.join(os.tmpdir(), "data-analyst-mcp-smoke-http") } as Record<string, string>;
delete env.DATA_ANALYST_FIXTURES;
const proc = spawn(process.execPath, [path.join(here, "dist", "bin", "cli.js"), "serve", "--http", "--port", String(port)],
  { env, stdio: ["ignore", "ignore", "pipe"] });
await new Promise<void>((resolve, reject) => {
  proc.stderr!.on("data", (d) => String(d).includes("MCP at") && resolve());
  proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
});
const base = `http://127.0.0.1:${port}`;
try {
  const client = new Client({ name: "smoke-http", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base)));
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);
  console.log("tools:", (await client.listTools()).tools.length);
  const brief = await call("source_brief", { source: "cdc" });
  await call("record_decisions", { questions: brief.questions_to_ask.map((q: any) => ({ id: q.id, how: "dont_know",
    resolution: "agency convention" })) });
  await call("request_schema", { source: "cdc", names: ["query"] });
  const r = await call("fetch", { source: "cdc", spec: { description: "Leading causes of death, Vermont, 2017", requests: [{
    name: "vt_2017", endpoint: "query", max_rows: 20, params: { dataset: "leading_death", $where: "state = 'Vermont' AND year = '2017'" } }] } });
  console.log("fetch:", r.status, r.summary?.tables?.[0]?.rows, "rows; files:", r.files?.[0]);
  const link = r.links?.["data/cdc/vt_2017.csv"];
  const csv = await (await fetch(link)).text();
  console.log("signed download:", link?.slice(0, 40) + "…", "->", csv.split(/\r?\n/)[1]);
  console.log("health:", await (await fetch(`${base}/healthz`)).json());
  await client.close();
} finally {
  proc.kill();
}
