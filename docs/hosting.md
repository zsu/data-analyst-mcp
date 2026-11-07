# Hosting data-analyst-mcp (remote mode, claude.ai custom connector)

`data-analyst-mcp serve --http` serves MCP over streamable HTTP at `/mcp`. Run it behind HTTPS (a reverse
proxy or a platform's TLS). A claude.ai connector needs a public HTTPS URL that Anthropic's servers can reach.

## Settings (environment)
| Variable | Meaning |
|---|---|
| `DATA_ANALYST_PUBLIC_URL` | the public base URL, e.g. `https://data.example.org` (OAuth metadata and links use it) |
| `PORT`, `HOST` | listen address (Docker image: `8080`, `0.0.0.0`) |
| `DATA_ANALYST_ACCOUNTS=1` | OAuth sign-in with per-user keys (needs `DATA_ANALYST_SECRET`) |
| `DATA_ANALYST_SECRET` | a long random string: it signs links and derives the key-encryption keys. Keep it stable and secret; changing it makes stored keys unreadable |
| `DATA_ANALYST_AUTH_TOKEN` | instead of accounts: one shared bearer token (for clients that can send headers) |
| `DATA_ANALYST_STATE_DIR` | accounts, OAuth clients and grants (Docker: the `/state` volume) |
| `DATA_ANALYST_OUT` | session workspaces (temporary; deleted when a session is idle for `DATA_ANALYST_IDLE_MINUTES`, default 120) |
| `DATA_ANALYST_CALLS_PER_MINUTE` | per-client-IP limit on `/mcp` (default 240) |
| `DATA_ANALYST_TRUST_PROXY=1` | behind a proxy: take the client IP from `X-Forwarded-For` |
| `DATA_ANALYST_OPEN=1` | run without authentication off loopback, on purpose |
| `DATA_ANALYST_SOURCES`, `DATA_ANALYST_DOMAINS` | serve only these sources or domains (e.g. `fred,treasury`, `economy,health`) |
| `DATA_ANALYST_HIDE_UNCONFIGURED=1` | leave out of listings the sources whose required key is not set up |
| `FRED_API_KEY`, `CENSUS_API_KEY`, ... | the operator's own keys, used for everyone who has none stored |

## Three ways to run it
- **Open** (`DATA_ANALYST_OPEN=1`). Anyone with the URL can use the keyless sources and the operator's keys. This is
  the simplest setup, but you pay the agencies' rate limits for everyone. Off loopback the server refuses to start
  without an auth mode unless this is set, so an open server is always a choice.
- **Accounts** (`DATA_ANALYST_ACCOUNTS=1`). claude.ai registers itself (dynamic client registration) and the user
  signs in on this server's consent page. That creates an account: a key ring with no email or password. The user
  can reconnect later with the account code shown once. A user stores their own keys on a write-only page: a key
  error gives them its link. Keys are encrypted with AES-256-GCM and used only inside that user's tool calls.
- **Shared token** (`DATA_ANALYST_AUTH_TOKEN`), for private deployments and clients that send an `Authorization` header.

## Where keys live, and who can see them
- **The model never sees a key.** Tools return statuses ("stored", "not set"), never values, and every result is
  redacted again before it leaves the server.
- **claude.ai** stores only the OAuth token for this server, and sends it with each tool call.
- **This server** stores the user's agency keys encrypted under `DATA_ANALYST_SECRET`, in `DATA_ANALYST_STATE_DIR`
  (files 0600). Tokens are stored as hashes. The operator's keys are environment variables.
- **What remains your responsibility:** the security of the host, the secret, the state volume and your logs
  (the server logs no request bodies).

## Deploy (Docker)
```bash
docker build -t data-analyst-mcp .
```

```bash
docker run -d -p 8080:8080 -v da-state:/state -e DATA_ANALYST_PUBLIC_URL=https://data.example.org -e DATA_ANALYST_ACCOUNTS=1 -e DATA_ANALYST_SECRET="$(openssl rand -hex 32)" data-analyst-mcp
```

Put TLS in front of it (a reverse proxy, Fly.io, Render, Cloud Run). Then in claude.ai: **Settings → Connectors →
Add custom connector**, URL `https://data.example.org/mcp`.

**Caution:** generate the secret once and keep it, for example in your platform's secret store. Do not use a new
`$(openssl rand ...)` on each start: with a new secret, the stored keys can no longer be decrypted.

## What differs from the local (npx) server
- **Files.** Results give relative paths plus signed download links (24 hours, while the session lasts),
  never server paths.
- **Manual downloads.** A manual bundle comes with an upload page; `ingest` reads only files uploaded to the session.
- **Keys.** Key files on the host are never read; only the environment and the per-user store are used.
- **Cache.** The persistent download cache is off unless `DATA_ANALYST_CACHE` is set.
