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

## Quick start

Requires Node.js 22 or later. Most sources need no key, so steps 2 and 3 are optional.

### 1. Add the server to your client

**Claude Code**

```bash
claude mcp add data-analyst -- npx -y data-analyst-mcp
```

Add `--scope user` to make it available in every project. To pass a key here, put `-e` before the `--`, for example
`claude mcp add data-analyst -e DATA_GOV_API_KEY=your-key -- npx -y data-analyst-mcp`.

**Claude Desktop**: `claude_desktop_config.json`, in `~/Library/Application Support/Claude/` (macOS) or
`%APPDATA%\Claude\` (Windows). Settings → Developer → Edit Config opens it. Restart Claude Desktop after editing.

```json
{
  "mcpServers": {
    "data-analyst": {
      "command": "npx",
      "args": ["-y", "data-analyst-mcp"],
      "env": { "DATA_GOV_API_KEY": "your-key" }
    }
  }
}
```

**Cursor**: the same `mcpServers` block in `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project).

**VS Code**: `.vscode/mcp.json` uses `servers` instead of `mcpServers`. An `inputs` entry makes VS Code ask for the key
once and store it, so the key is not written into a file you might commit.

```json
{
  "inputs": [
    { "type": "promptString", "id": "data-gov-key", "description": "api.data.gov API key", "password": true }
  ],
  "servers": {
    "data-analyst": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "data-analyst-mcp"],
      "env": { "DATA_GOV_API_KEY": "${input:data-gov-key}" }
    }
  }
}
```

**Codex**: `~/.codex/config.toml`

```toml
[mcp_servers.data-analyst]
command = "npx"
args = ["-y", "data-analyst-mcp"]

[mcp_servers.data-analyst.env]
DATA_GOV_API_KEY = "your-key"
```

Leave out the `env` block if you have no keys, or if you store them with `setup` (step 2).

**Until the package is published to npm**, build it and point the client at the build:

```bash
git clone https://github.com/zsu/data-analyst-mcp.git
```

```bash
cd data-analyst-mcp && npm install && npm run build
```

Then use `"command": "node", "args": ["<path>/data-analyst-mcp/dist/bin/cli.js"]` in the configs above, and
`node dist/bin/cli.js setup <source>` in place of `npx -y data-analyst-mcp setup <source>` below.

### 2. Add keys (optional)

Each key is free. Without a key, a source either falls back to a keyless route with lower limits, or offers a
manual download (`manual_bundle`): the user downloads the files in a browser, and the server packages them.

| Variable | Sources | Without it | Free key |
|---|---|---|---|
| `AQS_API_KEY` + `AQS_EMAIL` | epa-aqs | manual download only | [aqs.epa.gov](https://aqs.epa.gov/data/api/signup?email=YOUR_EMAIL) |
| `BEA_API_KEY` | bea | bulk files for the main tables; the API-only datasets need the key | [apps.bea.gov](https://apps.bea.gov/API/signup/) |
| `BLS_API_KEY` | bls | 25 queries a day, 25 series and 10 years each; no annual averages or catalog titles | [data.bls.gov](https://data.bls.gov/registrationEngine/) |
| `CENSUS_API_KEY` | census | manual download only | [api.census.gov](https://api.census.gov/data/key_signup.html) |
| `DATA_GOV_API_KEY` | college-scorecard, congress, fbi, fda, fec, govinfo, nrel, regulations, usda-fooddata, usgs | `DEMO_KEY` or keyless, at a few requests an hour (fda: 1,000 a day; usgs earthquakes never need a key) | [api.data.gov](https://api.data.gov/signup/) |
| `DOL_API_KEY` | dol | catalog and field lists only; data queries need the key | [dataportal.dol.gov](https://dataportal.dol.gov/registration) |
| `EIA_API_KEY` | eia | `DEMO_KEY`, about 10 requests an hour | [eia.gov](https://www.eia.gov/opendata/register.php) |
| `FRED_API_KEY` | fred | observations only; search, vintages, revision history and GeoFRED need the key | [fredaccount.stlouisfed.org](https://fredaccount.stlouisfed.org/apikeys) |
| `HUD_USER_TOKEN` | hud | manual download only | [huduser.gov](https://www.huduser.gov/hudapi/public/register) |
| `IPUMS_API_KEY` | ipums | build the extract on the IPUMS website (free account) | [account.ipums.org](https://account.ipums.org/api_keys) |
| `LDA_API_KEY` | senate-lobbying | 15 requests a minute instead of 120 | [lda.gov](https://lda.gov/api/register/) |
| `NOAA_API_KEY` | noaa | the keyless data and station-search endpoints; Climate Data Online v2 needs the key | [ncei.noaa.gov](https://www.ncei.noaa.gov/cdo-web/token) |
| `USDA_NASS_API_KEY` | usda-nass | manual download only | [quickstats.nass.usda.gov](https://quickstats.nass.usda.gov/api) |
| `USPTO_API_KEY` | uspto | manual download only | [data.uspto.gov](https://data.uspto.gov/apis/getting-started) |

Two settings are not keys. SEC asks every client to identify itself, so set `SEC_USER_AGENT` to your name and email
(`"Jane Doe jane@example.com"`). `NWS_USER_AGENT` is optional and does the same for the weather service.

**Store a key with `setup` (recommended).** It shows the signup link, reads the key with hidden input, and writes
it to `~/.config/data-analyst/keys.json`. The key stays out of client config files, and every client reads it. It
works mid-session, with no restart.

```bash
npx -y data-analyst-mcp setup congress
```

`setup` takes any source that uses the key: `setup congress` stores `DATA_GOV_API_KEY`, and all 10 api.data.gov
sources use it. `setup epa-aqs` also asks for `AQS_EMAIL`. Or put the variables in the client's `env` block, as in step 1.
[API keys](#api-keys) lists every place the server looks.

### 3. Check it

Ask your assistant: *"Is my api.data.gov key set up?"* The `check_key` tool reports whether the key was found and where,
never its value. To list only the sources you can use, start the server with `--hide-unconfigured` (see
[Options](#options)).

### 4. Try it

- *"How has the unemployment rate compared with CPI inflation since 2020?"*
- *"What is the median household income in each county of Ohio?"*
- *"Which drugs had the most reported adverse events last year?"*
- *"How much did each federal agency spend in fiscal year 2024?"*
- *"How many unhealthy air-quality days did Phoenix have in 2023?"*

The assistant asks the questions that change the answer first (which measure, which years, which population),
then fetches, computes and cites.

To host the server for claude.ai or a team, see [docs/hosting.md](docs/hosting.md).

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

[Quick start](#2-add-keys-optional) lists the keys and how to get them. When a fetch needs a key that is not set up,
`fetch` returns `key_missing` with a `setup` command for **you** to run in your own terminal. The model never asks
for a key in chat. `setup` writes `~/.config/data-analyst/keys.json`, the same file the Python skill uses.

The local (stdio) server looks for a key in this order. `DATA_GOV_API_KEY` is the example; each source's variable is named in
its `source_brief`.

1. The `DATA_GOV_API_KEY` environment variable, for example in the MCP client's `env` block.
2. The file named by `DATA_GOV_API_KEY_FILE` (for secret managers and mounted secrets).
3. `"env": {"DATA_GOV_API_KEY": "..."}` in `~/.config/data-analyst/keys.json` (or `$DATA_ANALYST_CONFIG_DIR/keys.json`).
   `setup` writes this file.
4. `"env": {"DATA_GOV_API_KEY": "..."}` in Claude Code's `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`).
5. `~/.data-gov/api_key`, a file that holds only the key.

The files are read again on each lookup, so a key stored during a session works without a restart.

No key value ever appears in a tool result: every output is redacted, and a test checks this. The hosted server
reads keys only from its environment and from each user's encrypted store (see [docs/hosting.md](docs/hosting.md)).

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
