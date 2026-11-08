# data-analyst-mcp (maintainers)

A TypeScript/Node MCP server for U.S. government data, over stdio (local) and streamable HTTP (hosted). This repo
owns its pack data, code and recorded fixtures.

- **Layout.**
  - `packs/<id>/`: data only (policy.json, endpoints.json, source.md, docs/, assets/).
  - `src/core/`: the engine (keys, http, policy, packs, generic-rest, tabular, package).
  - `src/adapters/<id>.ts`: a standard pack's adapter. `src/deep/<id>.ts`: a deep pack. Both are registered in
    `src/adapters/index.ts`.
  - `src/tools.ts`: tool logic. `src/server.ts`: MCP registration and instructions. `src/session.ts`: the gate.
  - `guide/WORKFLOW.md`: the method, served by the `guide` tool, with `guide/references/`.
  - `test/packs/<id>/fixtures/`: recorded responses, unchanged.
- **Commands.**
  - `npm test`: offline, fixtures only.
  - `npm run typecheck`, `npm run build`.
  - `npm run smoke`: live, over stdio. `npm run smoke:http`: live, over HTTP.
- **Adding or changing a pack.**
  1. Write its adapter hooks (see the `Adapter` type in `src/core/packs.ts`), or a deep pack (`DeepPack`).
  2. Register it in `src/adapters/index.ts`.
  3. Record fixtures (`DATA_ANALYST_RECORD=<dir>` saves live responses) and add tests in `test/packs/`.
  `packs/port.json` lists the packs that need code beyond endpoints.json. A pack is `ready` once that code is
  registered. Until then `fetch` refuses it with `not_supported`, so nothing is guessed.
- **Python-compatible text, on purpose.**
  - URLs are encoded as urllib does (`pyUrlencode`), so the recorded fixture keys match.
  - API JSON is parsed with `parsePyJson`. A published `4.0` stays `"4.0"`, and big integers stay exact, so CSVs
    are exactly as published. Use `Number()` before arithmetic on such values.
  - CSVs are written with CRLF line ends and minimal quoting. Booleans are written `True`/`False`.
- **Invariants (tests enforce them).**
  - No tool output contains a key: every result goes through `redact`, and test/mcp.test.ts injects fake keys.
  - A path a model supplies goes through `src/core/guard.ts` (`checkReadable`, `checkFiles`, `workspaceFile`,
    `reportPathProblems`): never a key file, never a file holding a key. test/secrets.test.ts checks every tool path.
  - No written file keeps a key: `package.write` and `result()` scrub with `scrubFile`/`takeScrubbed`, the cache and
    the replication ZIP never take one, and remote `/files` refuses one.
  - A key goes only to its client's own site (`Client.keyAllowed`): never along a link from a response. On a
    cross-host redirect, query and header keys are dropped; a body key (BLS) follows a 307/308 wherever it points.
  - `fetch` is gated on `source_brief`, `request_schema` and `record_decisions`.
  - Every success carries a `citation`, and every failure a `code` and `fix`.
  - Never write inside the package folder at run time.
  - Never invent data.
- **Do not mention** third-party government-data services or projects, or where this code came from, in code, docs
  or commits.

## Status
- **Done (0.3):**
  - 76 packs: 64 adapters in `src/adapters/`, 6 deep packs in `src/deep/`, 5 on endpoints.json alone, and
    census-geocoder;
  - published-table reading in `src/core/tabular.ts`: `$tsv`, `header_row: 0` (every line numbered),
    `header_lines` with `carry` (stacked headers), zip `member` and `prefer`, `skip_sheets`; header order is kept
    (`withColumns`, `sheetNames`);
  - manual bundles and `ingest`;
  - `.xls` reading (SheetJS);
  - the analysis tools (`src/analysis/`: compute, facts, write_table, rerun, cite, handoff) and the report tools
    (`src/report/`: audit_answer, build_report, style_check, audit_report, scan_secrets);
  - hosted mode (`src/remote/`: streamable HTTP, signed links, uploads, OAuth accounts, encrypted per-user keys).
  - 0.3 adds selective loading (`packEnabled`/`hiddenForKeys` in `src/core/packs.ts`, CLI flags in
    `takeGlobalFlags`), `requests` on results, the off-loopback refusal, the `Client` response cache (only for
    `cache.mode: persistent`), the `--workspace` option, `paired_with` (`src/core/routing.ts`) and the library entry
    `src/index.ts`. The library uses `runFetch` and `runIngest`, the same code as the tools without the gate.
  - 0.4 adds secret protection: redaction of every encoded form, primed at startup (`rememberServerSecrets`,
    `knownKeys`); the path guard `src/core/guard.ts`; scrubbing of written files and the cache; same-site keys
    (`Client.keyAllowed`); hosted pages with tokens in the URL fragment, security headers, HKDF keys from a 32+
    character `DATA_ANALYST_SECRET` (keys stored by 0.3 still open). Tests: test/secrets.test.ts.
- **Checks.** Every test file passes and `npm run typecheck` is clean.
  - test/e2e.test.ts runs the whole answer workflow through MCP to AUDIT PASSED.
- **Open:**
  - usda-fna's PDF endpoints (no PDF text reader).
  - Deep packs have no hook to write their own manual bundle: the opm and ipums bundle writers are exported but
    not reachable from `manual_bundle`.
  - actuaries and usda-outlook could use `manualItemsAsync` to look up the newest links live.
  - No per-source statistics helpers (survey weights, replicate-weight standard errors): `compute` covers general
    analysis.
  - ipums has no manual bundle; opm's bundle covers only pinned months; opm tables over 1M rows come only as Parquet,
    which `compute` cannot read; ipums report packages carry no download scripts.
  - npm publish, and an eval run with a model.
  - Manual only (the sites refuse this server): hud-ahar, cdc-wonder, foreign-assistance, cpsc NEISS. Readers checked
    only on files written in the tests: hud-ahar (huduser.gov refuses scripts) and
    cdc-wonder (wonder.cdc.gov refuses this client). Check them on a real downloaded workbook or export.
  - Not covered yet: NSF NCSES survey tables, the FJC Integrated Database, TIGERweb boundaries
    (census-geocoder), BJS corrections reports beyond the listed packages.
- **Pack-specific redaction patterns** (`keys.addPattern(re, pack)`) apply only inside that pack's calls
  (`withPackScope`). In one server process every pack is loaded, so a global pattern would redact other packs' data.
