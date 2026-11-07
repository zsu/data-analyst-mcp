# Porting a deep pack (Python → TypeScript)

Deep packs are bea, bls, fred, ipums, opm and treasury. Each has its own spec format and its own command line,
`sources/<id>/fetch.py` in the Python skill, plus API and IO modules (`<id>_api.py`, ...) and a `lib/` folder.
Read `AGENTS.md` and `docs/porting-adapters.md` first. The core mapping, Python semantics, parity, the
do-not-edit list and the report format there all apply. The differences are below.

## What to write
1. **`src/deep/<id>.ts`.** Its default export is a `DeepPack` (type in `src/core/packs.ts`). It is found by file
   name; do not register it. Split large code into `src/deep/_<id>_<name>.ts`.
   - **`operations`:** the request index `source_brief` shows. Name each kind of thing a spec can ask for, for
     example fred `series`, `release_dates`, `vintage`; treasury one per dataset kind or `dataset`; bea `NIPA`,
     `Regional`, `GDPbyIndustry`, ...
   - **`schema(names, pack)`:** what `request_schema` returns. Merge the info commands into it: treasury
     `--fields` and `--values`, bea parameter values, bls series-id rules. It may be async and may call the API;
     tests replay fixtures.
   - **`uses(spec)`:** which operations a spec uses. The gate requires their schemas to have been read.
   - **`specExample`:** one valid spec, taken from the playbook.
   - **`search(query, pack)`:** for `--search`.
   - **`checkSpec(spec, pack)`:** the problems `--check` reported as fix_spec.
   - **`fetch({pack, spec, workspace, force})`:** download and write `<workspace>/data/<id>/` exactly as the Python
     fetch does: the same CSV names and bytes, request.json fields, README and extra files (e.g. series.csv or
     vintage files). Reuse `src/core/package.ts` `write()` when the Python code used `package.write`; otherwise
     port the pack's own writer. Return a `DeepResult`: data_dir, tables (name, file, rows, columns), notes,
     problems (cut or incomplete tables, which make the result partial), retrieved, citation, vintage, route,
     and files (extra files to list). Reuse existing data when `!force` and the folder already holds this spec, as
     Python does.
   - **`ingest`:** port `--ingest`. **`manualItems`:** port `--manual-bundle`'s items, as `{name, url,
     filename, needs_key, method, body, note, optional}` for `src/core/manual.ts`. **`keylessFiles`:** port it
     where the pack has one.
   - Port the Python `--check` route logic only where it changes what is fetched (a keyless or bulk route
     chosen when no key is set). The server already handles key-missing and network failures.
2. **Pack data the Python code reads** (`catalog.json`, `lib/data_dictionary.csv`, a series-id table in
   `lib/*.py`) goes under `packs/<id>/`. Copy JSON and CSV as they are, and convert Python data tables to JSON.
   This is the one exception to "do not edit packs/".
3. **`lib/` analysis helpers** (`tstats`, `tsstats`, `stats`) are for the model's own analysis scripts, not fetching.
   Do **not** port them now; they become `compute` functions later. Port a lib function only if fetch uses it.
4. **Tests** go in `test/packs/<id>.test.ts`, ported from `tests/sources/<id>/test_<id>.py`. Use `fakeKeys(id)`
   where Python passed a key.
5. **Parity:** write `test/parity/<id>.json`; `npx tsx scripts/parity.ts <id>` runs Python's
   `fetch.py --source <id> spec --out` on the same fixtures. Every case must be SAME (all CSVs byte-identical).

Done means the vitest file passes, parity is SAME, and tsc shows no errors in `src/deep/<id>*`.
