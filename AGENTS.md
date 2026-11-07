# data-analyst-mcp (maintainers)

A TypeScript/Node MCP server (stdio now, streamable HTTP later) for U.S. government data. It is a **fork and
port** of the Python data-analyst skill (`../data-analyst`). After the one-time import, this repo owns its
pack data, and nothing syncs back.

- **Layout.**
  - `packs/<id>/`: data only (policy.json, endpoints.json, source.md, docs/, assets/).
  - `src/core/`: the engine (keys, http, policy, packs, generic-rest, tabular, package).
  - `src/adapters/<id>.ts`: a standard pack's adapter. `src/deep/<id>.ts`: a deep pack. Both are registered in
    `src/adapters/index.ts`.
  - `src/tools.ts`: tool logic. `src/server.ts`: MCP registration and instructions. `src/session.ts`: the gate.
  - `guide/WORKFLOW.md`: the method, i.e. SKILL.md rewritten to name the MCP tools.
  - `test/packs/<id>/fixtures/`: recorded responses, in the Python format, unchanged.
- **Commands.**
  - `npm test`: offline, fixtures only.
  - `npm run typecheck`, `npm run build`.
  - `npm run smoke`: live, over stdio.
  - `npm run parity [ids]`: byte-compares CSVs with the Python fetch.py on the same fixtures; specs are in
    `test/parity/<id>.json`.
- **Porting a pack.**
  1. Port its `adapter.py` hooks (camelCase names, see the `Adapter` type in `src/core/packs.ts`) or its deep
     `fetch.py`.
  2. Register it in `src/adapters/index.ts`.
  3. Port `tests/sources/<id>/test_<id>.py` to `test/packs/`.
  4. Add parity specs and get `npm run parity <id>` to SAME.
  `packs/port.json` lists the packs whose Python version had code beyond endpoints.json. A pack is `ready` once
  that code is registered. Until then `fetch` refuses it with `not_supported`, so nothing is guessed.
- **Python-compatible text, on purpose.**
  - URLs are encoded as urllib does (`pyUrlencode`), so the recorded fixture keys match.
  - API JSON is parsed with `parsePyJson`. A published `4.0` stays `"4.0"`, and big integers stay exact, so CSVs
    are exactly as published. Use `Number()` before arithmetic on such values.
  - CSVs are written with CRLF line ends and minimal quoting. Booleans are written `True`/`False`.
- **Invariants (tests enforce them).**
  - No tool output contains a key: every result goes through `redact`, and test/mcp.test.ts injects fake keys.
  - `fetch` is gated on `source_brief`, `request_schema` and `record_decisions`.
  - Every success carries a `citation`, and every failure a `code` and `fix`.
  - Never write inside the package folder at run time.
  - Never invent data.
- **Do not mention** third-party government-data services in code, docs or commits.

## Port status
- **Done (0.3):**
  - all 62 packs, plus census-geocoder (new, no Python counterpart): 51 adapters in `src/adapters/`, 6 deep packs in `src/deep/`, 5 on endpoints.json alone;
  - manual bundles and `ingest`;
  - `.xls` reading (SheetJS, with the same cells as xlrd);
  - the analysis tools (`src/analysis/`: compute, facts, write_table, rerun, cite, handoff) and the report tools
    (`src/report/`: audit_answer, build_report, style_check, audit_report, scan_secrets);
  - hosted mode (`src/remote/`: streamable HTTP, signed links, uploads, OAuth accounts, encrypted per-user keys).
  - 0.3 adds selective loading (`packEnabled`/`hiddenForKeys` in `src/core/packs.ts`, CLI flags in
    `takeGlobalFlags`), `requests` on results, the off-loopback refusal, the `Client` response cache (only for
    `cache.mode: persistent`), the `--workspace` option, `paired_with` (`src/core/routing.ts`) and the library entry
    `src/index.ts`. The library uses `runFetch` and `runIngest`, the same code as the tools without the gate.
- **Checks.** Every test file passes and `npm run typecheck` is clean.
  - Parity is SAME on 142 of 145 cases. The 3 DIFFs come from Python's side: cms orders `_flag` columns from a
    set, so the order changes with the hash seed, and fdic's `float()` accepts underscores in a data dictionary.
  - test/e2e.test.ts runs the whole answer workflow through MCP to AUDIT PASSED.
- **Open:**
  - usda-fna's PDF endpoints (no PDF text reader that matches pypdf).
  - Deep packs have no hook to write their own manual bundle: the opm and ipums bundle writers are exported but
    not reachable from `manual_bundle`.
  - actuaries and usda-outlook could use `manualItemsAsync` to look up the newest links live.
  - Each pack's `lib/` statistics helpers are not ported: `compute` covers general analysis, but there are no
    survey standard errors yet.
  - npm publish, and an eval run with a model.
- **Pack-specific redaction patterns** (`keys.addPattern(re, pack)`) apply only inside that pack's calls
  (`withPackScope`). In one server process every pack is loaded, so a global pattern would redact other packs' data.
