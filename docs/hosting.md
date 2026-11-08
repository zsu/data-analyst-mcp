# Hosting data-analyst-mcp (remote mode, claude.ai custom connector)

`data-analyst-mcp serve --http` serves MCP over streamable HTTP at `/mcp`. Run it behind HTTPS (a reverse
proxy or a platform's TLS). A claude.ai connector needs a public HTTPS URL that Anthropic's servers can reach.

## Settings (environment)
| Variable | Meaning |
|---|---|
| `DATA_ANALYST_PUBLIC_URL` | the public base URL, e.g. `https://data.example.org` (OAuth metadata and links use it) |
| `PORT`, `HOST` | listen address (Docker image: `8080`, `0.0.0.0`) |
| `DATA_ANALYST_ACCOUNTS=1` | OAuth sign-in with per-user keys (needs `DATA_ANALYST_SECRET`) |
| `DATA_ANALYST_SECRET` | a random string of at least 32 characters (the server refuses to start with a shorter one): it signs links and derives the key-encryption keys. Keep it stable and secret; changing it makes stored keys unreadable |
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

### Why it refuses to start without one
On an address other than loopback, an open server lets anyone who reaches it spend three things: the operator's
keys, the agencies' rate limits on the server's IP, and its disk (workspaces and uploads). So `serve --http`
exits with an error unless you pick a mode. On `127.0.0.1` it starts without one.

A container has to listen on `0.0.0.0` to receive traffic, even when Docker publishes the port to your own
machine only. The image sets `HOST=0.0.0.0`, so the check applies there too. For a server only you can reach, publish
on loopback and say so:

```bash
docker run -p 127.0.0.1:8080:8080 -e DATA_ANALYST_OPEN=1 data-analyst-mcp
```

## When a source needs a key
For each fetch, the server uses the first of these that applies:

1. **The user's own stored key** (accounts mode only).
2. **The operator's key** from the environment (`FRED_API_KEY` ...). It is shared by everyone who has none stored.
3. **The source's public demo key**, where the agency has one (api.data.gov's `DEMO_KEY`: a few requests an hour).
4. **The source's keyless or bulk-file route**, when it has one and the request needs no key-only feature.
5. **Otherwise `key_missing`.** Its fix depends on the mode:
   - **Accounts:** a one-hour link to the user's write-only keys page. The user stores the key there, never in
     chat, and the model calls the tool again.
   - **Open or shared token:** no per-user store exists. The fix points to a keyless source, or to `manual_bundle`:
     the user runs the download script on their own computer (with their own key if they have one), then uploads
     the files on the session's upload page, and the model calls `ingest`.

A host that refuses scripts goes to the manual bundle the same way, in every mode. To keep sources that will only
return `key_missing` out of listings, set `DATA_ANALYST_HIDE_UNCONFIGURED=1`.

## Where keys live, and who can see them
- **The model never sees a key.** Tools return statuses ("stored", "not set"), never values. Every result, error,
  prompt and resource is redacted again before it leaves the server, for every key in any form it can be echoed in
  (as is, URL-encoded, JSON-escaped), and so are this server's own secrets (`DATA_ANALYST_SECRET`,
  `DATA_ANALYST_AUTH_TOKEN`).
- **No tool reads a key file.** Paths a model names (`ingest` files, a `for_each` table, `report.json` paths,
  `read_file`) are refused when they are outside the session, in the state folder or another place keys are kept,
  or when the file holds a key.
- **No file keeps a key.** A key an agency echoes in a response is replaced with `[REDACTED]` in every file written
  to the workspace (the result says which), the download cache never stores it, and a download link refuses a file
  that still holds one. A response fetched with a user's own key is never cached.
- **Keys go only to their agency.** A key is sent only to the agency's own site: never along a next-page link to
  another site, and never from https to http. On a redirect to another host, a key in the URL or a header is
  dropped; a key in the request body (BLS) follows a 307/308 redirect wherever it points.
- **claude.ai** stores only the OAuth token for this server, and sends it with each tool call.
- **This server** stores the user's agency keys encrypted under a key derived from `DATA_ANALYST_SECRET` (HKDF, one
  key for links and another for encryption), in `DATA_ANALYST_STATE_DIR` (files 0600). Tokens are stored as hashes.
  The operator's keys are environment variables.
- **Links and logs.** The keys page (`/keys#<token>`, one hour) and the upload page (`/upload#<token>`, 24 hours)
  carry their token in the URL fragment, which browsers never send: it is in no access log and no `Referer`. File
  download links (`/files/<token>`, 24 hours) do carry theirs in the path, so keep proxy access logs private. Every
  response is `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, never framed, and runs no script without its
  own CSP nonce. The consent page shows where the sign-in returns to, not only the client's chosen name.
- **What remains your responsibility:** the security of the host, the secret, the state volume and your logs
  (the server logs no request bodies and no tokens of its own).

## Deploy (Docker)
```bash
docker build -t data-analyst-mcp .
```

Generate the secret once, into a file only you can read (not on the command line, where it stays in shell history
and in `docker inspect`):

```bash
umask 077 && openssl rand -base64 48 | tr -d '\n' > da-secret && printf 'DATA_ANALYST_SECRET=%s\n' "$(cat da-secret)" > da.env
```

```bash
docker run -d -p 8080:8080 -v da-state:/state --env-file da.env -e DATA_ANALYST_PUBLIC_URL=https://data.example.org -e DATA_ANALYST_ACCOUNTS=1 data-analyst-mcp
```

Put TLS in front of it (a reverse proxy, Fly.io, Render, Cloud Run). Then in claude.ai: **Settings → Connectors →
Add custom connector**, URL `https://data.example.org/mcp`.

**Caution:** keep the secret, for example in your platform's secret store. Do not generate a new one on each start:
with a new secret, the stored keys can no longer be decrypted. Keys stored by an earlier version still open
with the same secret, and are re-encrypted under the new derivation the next time the user saves a key; links issued
by an earlier version stop working after the upgrade (users ask the assistant for a new one).

## What differs from the local (npx) server
- **Files.** Results give relative paths plus signed download links (24 hours, while the session lasts),
  never server paths.
- **Manual downloads.** A manual bundle comes with an upload page; `ingest` reads only files uploaded to the session.
- **Keys.** Key files on the host are never read; only the environment and the per-user store are used.
- **Cache.** The persistent download cache is off unless `DATA_ANALYST_CACHE` is set. Even then, a response fetched
  with a user's own stored key is never cached: the cache is shared by every user.
