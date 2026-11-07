/**
 * Smoke test over real stdio: start the built server (node dist/bin/cli.js) as an assistant would, walk the
 * workflow on one live source (no fixtures: this makes real requests), and print a short report.
 *
 *   npm run build && npx tsx scripts/smoke.ts [source]      (default cdc)
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k, v]) =>
  v !== undefined && k !== "DATA_ANALYST_FIXTURES")) as Record<string, string>;
env.DATA_ANALYST_OUT = path.join(os.tmpdir(), "data-analyst-mcp-smoke");
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, "dist", "bin", "cli.js")], env });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: JSON.parse(r.content[0].text) };
};

console.log("server:", client.getServerVersion());
console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
const found = await call("find_sources", { question: "leading causes of death in Vermont" });
console.log("route:", found.data.candidates.slice(0, 3).map((c: any) => `${c.source} ${c.score}`).join("; "));
const blocked = await call("fetch", { source: "cdc", spec: { requests: [{ name: "x", endpoint: "query", params: { dataset: "leading_death" } }] } });
console.log("fetch before brief:", blocked.data.code);
const brief = await call("source_brief", { source: "cdc" });
await call("record_decisions", { questions: brief.data.questions_to_ask.map((q: any) => ({ id: q.id, how: "dont_know",
  resolution: "agency convention" })) });
await call("request_schema", { source: "cdc", names: ["query"] });
const t0 = Date.now();
const r = await call("fetch", { source: "cdc", force: true, spec: { description: "Leading causes of death, Vermont, 2017",
  requests: [{ name: "vt_2017", endpoint: "query", max_rows: 20,
    params: { dataset: "leading_death", $where: "state = 'Vermont' AND year = '2017'", $order: "deaths DESC" } }] } });
console.log(`live fetch (${Date.now() - t0} ms):`, r.isError ? r.data : {
  status: r.data.status, rows: r.data.summary.tables[0].rows, first: r.data.summary.tables[0].preview_csv.slice(0, 2),
  citation: r.data.citation.text, request: r.data.citation.request_urls[0] });
await client.close();
