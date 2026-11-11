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
  - 77 packs: 65 adapters in `src/adapters/`, 6 deep packs in `src/deep/`, 5 on endpoints.json alone, and
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
  - 0.5 adds:
    - `compute` reads `data/<id>/*.parquet` (the reader is `src/core/parquet.ts`, typed as the same CSV would be)
      and takes `{path, columns}` inputs (only those columns are decoded; a cap, `PARQUET_MAX_CELLS`, refuses
      more); its `replicate_se` step (`src/analysis/replicate.ts`) gives replicate-weight SEs and MOEs (sdr, fay,
      jk1, brr, custom), from microdata weights or from published replicate estimates.
    - `check_key` tests a set-up key live through the pack's `ping` (`Adapter.ping`, `DeepPack.ping`: census, eia,
      epa-aqs, noaa, usgs, bea, fred, ipums): accepted, rejected, unreachable or unclear. Tests: test/check-key.test.ts.
    - fred falls back to the keyless graph downloads when the key is rejected or the API is down.
    - the `guide` topic `report_schema` (`guide/references/report_schema.md`): every report.json key build_report reads.
  - 0.6 adds:
    - irs-soi reads the SOI published tables (`table`, `table_list`): 125 tables in `packs/irs-soi/tables.json`
      (Publication 1304 and tax shares by percentile, Publication 16, partnerships, sole proprietorships, the IRS
      Data Book, historical tables, estate, gift, wealth, exempt organizations, international). The year's file is
      taken from the table's index page, never built. One layout reader for all of them
      (`src/adapters/_irs-soi_tables.ts`): column-number row, stacked headers, page blocks, side-by-side panels,
      sections, row levels, markers as `FLAG`. Also `eo_bmf` and `eo_extract` (`src/adapters/_irs-soi_eo.ts`).
      Estimate recipes: `packs/irs-soi/docs/estimate_patterns.md`. Tests: test/packs/irs-soi-tables.test.ts.
    - `xlsxSheets`/`xlsSheets` take an optional `marks` output: each cell's number-format marker and indent
      (`formatMark`), for tables that mark cells by format only.
  - 0.7 adds:
    - long reruns (`src/analysis/rerun_job.ts`): the rerun runs in a worker thread (`rerun_worker.ts`; from the
      sources it loads with tsx), one job per workspace keyed by a fingerprint of the files it reads; a call waits
      `DATA_ANALYST_RERUN_WAIT_S` (45) and then answers `in_progress` (call again: it waits on the same job). The
      finished result is kept until those files change. The worker's heap is `DATA_ANALYST_RERUN_HEAP_MB` (default
      60 percent of the allowed memory); only a worker that cannot load falls back to an in-thread replay, never
      one that ran out of memory. `DATA_ANALYST_RERUN_INLINE=1` replays in-thread with nothing kept (tests that
      stub `rerunWorkspace`). The rerun parses each input once across recipes. Tests: test/rerun-job.test.ts.
    - `open_workspace` (`src/workspace_tool.ts`, local only) lists and reopens earlier workspaces after a restart.
    - census microdata: a renamed variable is named in the error (`renameHint`: ACS PUMS `ST` is `STATE` from the
      2023 files on).
  - 0.8 adds smaller results and faster compute (tests: test/results-size.test.ts):
    - Results are compact JSON. Long lists are shortened (`src/core/compact.ts`): numbered runs collapse
      (`PWGTP1-80`), and an unknown name lists the nearest names, not every column.
    - `source_brief` leaves the playbook's Access section out unless asked (`sections`, `full`), and the notes on
      `paired_with`. Product-specific traps live in `packs/<id>/docs/*.md` (census microdata and timeseries,
      govinfo collections, congress votes and nominations_crs, irs-soi tables and eo), read through `doc`.
    - `guide` takes `section`; a topic over 12k returns its outline (`src/core/sections.ts`). New topics: `report`
      (one page for a report) and `compute` (verbs, functions, replicate_se; the compute description is short).
    - fetch: the preview reads the file's head, at most 12 columns, without replicate-weight runs. The request
      URLs are not repeated in the citation.
    - compute: previews are rounded and narrow, facts return `{name, value, text}`, and request_schema shortens
      deep schemas unless `detail: true`.
    - `build_report` takes `patch` (dotted paths), or no report (it rebuilds report.json), and returns the style
      score. The audits list failures only (`verbose: true` lists every check), with `check_counts`.
    - `read_file` takes `match` and reads 20 KB by default. `handoff` sends its previews once, in `text`.
      record_decisions takes the audit fields in `method`.
    - Annotations: fetch is not read-only, and workspace writers are `destructiveHint: false`. open_workspace is
      not listed in hosted mode.
    - compute speed and size (`src/analysis/compute.ts`):
      - a dry run of the steps on empty tables catches a misspelt column before the parse;
      - a single-input recipe that narrows (select, rollup, replicate_se, pivot_wider with id_cols) reads only
        the columns it names (`neededColumns`);
      - parsed CSV grids are cached by path and hash (`DATA_ANALYST_PARSE_CACHE_MB`, default 512);
      - caps: `CSV_MAX_RAW_CELLS` and `PARQUET_MAX_CELLS`;
      - derive adds columns in place to rows the pipeline owns.
    - `package.write` writes `<name>.parquet` beside a microdata CSV of 5 MB or more (`FileTable`), and compute
      decodes only the needed columns from it.
    - The replication ZIP keeps one copy of each table. A data file over 10 MB stays out with a re-fetch note
      (`sizeRule`), and an unchanged package is not zipped again.
    - On the Maryland PUMS run (62,777 × 175):
      - recipes: 2.6-20.6 s → 1-12 s, with the same outputs; the rest is replicate_se arithmetic;
      - ZIP: 10.3 MB → 0.3 MB;
      - census brief: 40k → 20.5k chars.
    - Not done: a background (worker) path for a long compute. No recipe on the measured run came near the
      60 s client limit.
  - 0.9 adds rma (USDA Risk Management Agency): the crop insurance Summary of Business by year, state, county,
    crop, plan and coverage level (`coverage`) and the reinsurance results (`reinsurance`). Headerless delimited
    files are read with `delimiter` and `columns` on the endpoint (`tsvRecords`). Tests: test/packs/rma.test.ts.
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
