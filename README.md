# data-analyst-mcp

An MCP server for official U.S. government data. It asks the user the questions that change a headline
number before fetching anything, gets the data from the agency at call time, packages it (CSV, data
dictionary, provenance) and cites every result. It is a TypeScript port of the data-analyst skill, with the
same 62 source packs.

> **Status: 0.3.** Every one of the 62 source packs is ported, plus a Census Geocoder pack (63 sources). The test suite runs offline on recorded
> fixtures. 145 parity cases compare the output CSVs, byte for byte, with the Python skill's on the same
> fixtures. The analysis and audit tools are ported too, and so are hosted mode (streamable HTTP, a claude.ai
> connector) and per-user keys.
> One gap remains: usda-fna's three PDF endpoints need a PDF text reader, and return `not_supported`.
> The package is not published to npm yet.

## Install

Requires Node.js 22 or later.

**Claude Code**

```bash
claude mcp add data-analyst -- npx -y data-analyst-mcp
```

**Claude Desktop, Cursor, VS Code and other clients** (`mcpServers` config):

```json
{ "mcpServers": { "data-analyst": { "command": "npx", "args": ["-y", "data-analyst-mcp"] } } }
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.data-analyst]
command = "npx"
args = ["-y", "data-analyst-mcp"]
```

Until the package is published to npm, point the client at a local build instead:
`node <path>/data-analyst-mcp/dist/bin/cli.js` (after `npm install && npm run build`).

## How it works

| Tool | What it does |
|---|---|
| `guide` | the method: framing, asking only critical questions, the accuracy checklist, combining sources |
| `find_sources` | ranks the sources for a question, or lists them all |
| `source_brief` | one source's playbook, its **questions_to_ask**, key status, rules and request index |
| `request_schema` | full parameters of the requests to use; searches a source's catalog |
| `record_decisions` | how each critical question was settled (answered, Don't know, skipped, not asked and why) |
| `fetch` | downloads into the session workspace; returns a summary, the files, the citation and notes |
| `manual_bundle`, `ingest` | a one-command download for the user's own computer, then packaging what they downloaded |
| `compute` | builds exhibits from the full tables with declarative steps (a whitelisted expression language, no eval); the steps are recorded for `rerun` |
| `facts`, `write_table`, `cite` | register the numbers cited, write the benchmark and sensitivity tables, snapshot cited pages |
| `audit_answer`, `rerun` | the release gate: every number in the answer is a registered fact, the method record is complete, and the analysis reproduces |
| `build_report`, `style_check`, `audit_report` | an HTML report and replication ZIP, only when asked |
| `handoff` | the per-source data hand-off |
| `check_key` | whether a key is set up (never shows it) |
| `read_file` | a small text file from the workspace |

**Asking before fetching is enforced, not just suggested.** `fetch` returns `gate_blocked` until, for that
source, the model has read `source_brief` and the schemas of the requests it uses, and has recorded how each
critical question was settled. The model asks the questions in chat, in one round. A blocking question that
the user skips is asked once more. The server also exposes an `analyze` prompt and `source://<id>`
resources, for clients that let users pick prompts or attach resources.

**Results** have one shape. Success: `{status: "ok" | "partial", summary, files, citation, notes}`. Failure:
`{status: "error", code, message, fix, retry_after_s?}`. The codes are `invalid_request`, `not_found`,
`not_supported`, `agency_rejected`, `agency_unavailable`, `key_missing`, `key_rejected`, `rate_limited`,
`gate_blocked` and `server_error`.

## Options

| Option (flag / environment) | What it does |
|---|---|
| `--sources fred,treasury` / `DATA_ANALYST_SOURCES` | serve only these sources |
| `--domains economy,health` / `DATA_ANALYST_DOMAINS` | serve only the sources in these domains |
| `--hide-unconfigured` / `DATA_ANALYST_HIDE_UNCONFIGURED=1` | leave out of listings the sources whose required key is not set up |
| `--workspace <folder>` / `DATA_ANALYST_WORKSPACE` | (stdio) one fixed analysis folder, so a fetch is reused after a restart |

```json
{ "mcpServers": { "data-analyst": { "command": "npx", "args": ["-y", "data-analyst-mcp", "--domains", "economy,health"] } } }
```

The tool list stays the same size whatever is enabled: sources are found with `find_sources`, not loaded as
tools.

Every result lists its upstream requests (`requests`: method, credential-free URL, status, cached, time), and
`citation` names the publisher, page and retrieval date. Requests are rate-limited per host (a token bucket),
retried with backoff on 429 and 5xx (honoring Retry-After), and kept within each agency's per-minute budgets.

**Caching follows each source's terms.**
- A source whose policy allows persistent copies (`cache.mode: persistent`) can be cached on disk in
  `DATA_ANALYST_CACHE` (default `~/.cache/data-analyst`). census and bea do; opm's terms allow it, but its port
  downloads again for now.
- Most sources allow reuse only inside the analysis folder, and FRED none at all. For those, a fixed
  `--workspace` gives reuse across restarts without keeping copies anywhere else.

## As a library

```ts
import { route, brief, fetchSource, compute, registerFacts } from "data-analyst-mcp";

const r = await fetchSource("cdc", { description: "NY deaths 2017", requests: [{ name: "ny", endpoint: "query",
  params: { dataset: "leading_death", $where: "state = 'New York' AND year = '2017'" } }] }, { out: "./out/ny" });
console.log(r.summary.tables[0].rows, r.citation.text);
```

- **The functions:** the same sources, engine, analysis and audits as the server. The exports are `listSources`,
  `route`, `brief`, `requestSchema`, `fetchSource`, `ingest`, `manualBundle`, `compute`, `registerFacts`,
  `writeTable`, `rerun`, `recordDecisions`, `auditAnswer`, `buildReport`, `auditReport`, `createServer` and
  `createApp`, plus their types.
- **No ask-first gate:** it is for assistants, so the library leaves it out.
- **Errors:** a failure throws `ToolError`; its `failure` holds the code and the fix.

## API keys

Most sources need no key. For one that does, `fetch` returns `key_missing` with a command for **you** to
run in your own terminal. The model never asks for a key in chat.

```bash
npx -y data-analyst-mcp setup fred
```

`setup` reads the key with hidden input and stores it in `~/.config/data-analyst/keys.json`, the same file the
Python skill uses. Keys can also come from environment variables (for example `FRED_API_KEY`) set in the MCP
client's `env` block. No key value ever appears in a tool result: every output is redacted, and a test checks
this.

## Hosted mode (claude.ai connector)

`data-analyst-mcp serve --http` serves MCP at `/mcp` over streamable HTTP. With `DATA_ANALYST_ACCOUNTS=1`, users
sign in through OAuth and store their own API keys on a write-only page. The keys are encrypted at rest, and the
model never sees them. See [docs/hosting.md](docs/hosting.md) and the `Dockerfile`.

## Workspace

Each session writes to its own folder under `$DATA_ANALYST_OUT` (default: the system temp folder,
`data-analyst-mcp/<session>`), with `data/<source>/` and `decisions.json` inside. Nothing is written inside the
package.

## Development

```bash
npm install
npm test
npm run build
npm run smoke
npm run parity
```

- `npm test` runs offline, on recorded fixtures.
- `npm run smoke` drives the built server over stdio and makes one live fetch.
- `npm run parity` compares the output with the Python skill's, byte for byte. It needs `../data-analyst` and Python.
