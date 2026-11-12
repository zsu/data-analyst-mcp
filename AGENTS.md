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
- **Checks.** Every test file passes and `npm run typecheck` is clean.
  - test/e2e.test.ts runs the whole answer workflow through MCP to AUDIT PASSED.
- **Open:**
  - usda-fna's PDF endpoints (no PDF text reader).
  - Deep packs have no hook to write their own manual bundle: the opm and ipums bundle writers are exported but
    not reachable from `manual_bundle`.
  - actuaries and usda-outlook could use `manualItemsAsync` to look up the newest links live.
  - No design-based (linearized, STRATA/PSU) standard errors: NHIS and MEPS have no replicate weights, so their
    SEs are not computed here.
  - ipums has no manual bundle; opm's bundle covers only pinned months; ipums report packages carry no download
    scripts.
  - npm publish, and an eval run with a model.
  - Manual only (the sites refuse this server): hud-ahar, cdc-wonder, foreign-assistance, cpsc NEISS. Readers checked
    only on files written in the tests: hud-ahar (huduser.gov refuses scripts) and
    cdc-wonder (wonder.cdc.gov refuses this client). Check them on a real downloaded workbook or export.
  - Not covered yet: NSF NCSES survey tables, the FJC Integrated Database, TIGERweb boundaries
    (census-geocoder), BJS corrections reports beyond the listed packages.
  - irs-soi does not read: Form 990 e-file XML, the tax gap (PDF only), the Corporation Source Book (frozen at
    2013), fixed-width `.dat` Form 990 extracts (some of 2012-2017), older table series under other numbers
    (e.g. Publication 1304 `in01ar` before 2012).
- **Pack-specific redaction patterns** (`keys.addPattern(re, pack)`) apply only inside that pack's calls
  (`withPackScope`). In one server process every pack is loaded, so a global pattern would redact other packs' data.
