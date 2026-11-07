# Porting a standard pack's adapter (Python → TypeScript)

The Python skill is at `C:\zsu\Projects\data-analyst`. Its pack code is
`plugins/data-analyst/skills/data-analyst/sources/<id>/adapter.py`, and its tests are `tests/sources/<id>/test_<id>.py`.
The pack data (policy.json, endpoints.json, source.md, docs/) is already copied to `packs/<id>/`, and the fixtures to
`test/packs/<id>/fixtures/` (same `index.json` format). Read `AGENTS.md` first.

## What to write, per pack
1. **`src/adapters/<id>.ts`.** Its default export is an `Adapter` object (type in `src/core/packs.ts`). It is
   found by file name, so do not register it anywhere. Port every hook in adapter.py; helpers stay module-private.
   A large adapter may split helpers into `src/adapters/_<id>_<name>.ts`.
2. **`test/packs/<id>.test.ts`.** Port every test in test_<id>.py that checks data or behavior. Use `test/helpers.ts`:
   `isolate`, `fixtures`, `newSession`, `prepare`, `fetchOk`, `csv`, `failure` and `fakeKeys(source)` (sets a fake key, as
   the Python tests do with `env={"X_API_KEY": ...}`; call it in tests that fetch a keyed source). Keep the same specs and the same
   expected values.
3. **`test/parity/<id>.json`.** Write `{"<case>": spec, ...}`, one entry for each spec the Python tests fetch
   successfully offline. Then run `npx tsx scripts/parity.ts <id>`: every case must print **SAME** (byte-identical
   CSVs, the Python fetch.py run on the same fixtures).

Done means `npx vitest run test/packs/<id>.test.ts` passes, parity prints SAME, and
`npx tsc -p tsconfig.json --noEmit 2>&1 | grep "adapters/<id>\|adapters/_<id>"` prints nothing. Other files
may show errors while other packs are being ported; ignore those.

## Hook mapping (snake_case → camelCase, same meaning)
| Python | TypeScript | sync/async |
|---|---|---|
| `fetch(spec, pack, route)` → (tables, notes) | `fetch(spec, pack, route)` → `[tables, notes]` | async |
| `check_spec(spec)` or `check_spec(spec, pack)` | `checkSpec(spec, pack)` → string[] | sync |
| `before_request(req, ep, params)` | `beforeRequest(req, ep, params)` | sync |
| `normalize(req, ep, rows)` | `normalize(req, ep, rows)` | sync |
| `request_note(req, ep, params)` | `requestNote(...)` | sync |
| `check_error(status, body: bytes)` | `checkError(status, body: Buffer)` | sync |
| `manual_items(spec, pack)` | `manualItems(spec, pack)` | sync |
| `parse_upload(pack, req, paths)` | `parseUpload(pack, req, files)` | sync or async |
| `search(query, pack)` | `search(query, pack)` | sync |
| `ping(client)` | `ping(client)` | async |
| `key_only_needs(spec)` | `keyOnlyNeeds(spec)` | sync |
| `refused_hosts(spec)` | `refusedHosts(spec)` | sync |
| `keyless_files(spec, pack)` | `keylessFiles(spec, pack)` | sync |

## Core mapping (import from `src/core/...`, never edit core)
- **`generic-rest.ts`:**
  - `gr.resolve` → `resolve`; `gr.split` → `split`; `gr.client_for` → `clientFor`.
  - `gr.fetch` → `fetchSpec` (async); `gr.fetch_request` → `fetchRequest` (async).
  - `gr._clean` → `clean`; `gr.dig`, `gr.flatten`, `gr.Misses` (`notFound`/`checkEmpty`/`raiseIfAny`) and `gr.INCOMPLETE` keep their names.
  - `gr.manual_items` → `manualItems`; `gr.parse_upload` → `parseUpload`; `gr.search_catalog` → `searchCatalog`;
    `gr.with_record_params` → `withRecordParams`; `gr.records` → `records`.
- **`tabular.ts`:** `gr.xlsx_sheets` → `xlsxSheets`, `gr.xls_sheets` → `xlsSheets` (the same cells as xlrd),
  `gr.grid_records` → `gridRecords`, `gr.sheet_records` → `sheetRecords`, plus `readCsv` (csv.DictReader),
  `writeCsv`, `decodeText`, `unzip` (fflate) and `fnmatch`. For pandas `read_excel(dtype=str)`, check what pandas
  produced on the fixture (for example `"1234.0"`) and reproduce it.
- **`http.ts`:** `Client` (methods `get`, `getJson`, `postJson`, `request`, `download`, all async) and `DataError(msg, kind, status)`.
  `Response.json()` uses the Python-compatible parser.
- **Other modules:**
  - `policy.ts`: `readJson(pack.dir, name)` replaces `packfiles.read_json`.
  - `keys.ts`: `findKey`, `findAuthKey`, `remember`, `addPattern`, `redact`.
  - `package.ts`: `FileTable`. `cache.ts`: `Cache`. `py.ts`: `pyStr`, `pyFloatRepr`, `pyUrlencode`, `pyQuote`, `parsePyJson`, `pyJsonDumps`.

## Python semantics to keep (parity catches every slip)
- **Values from JSON.** A whole-number float arrives as a string such as `"4.0"`, and a huge integer as a digit string.
  Use `Number(x)` before arithmetic. Python `str(x)` is `pyStr(x)`; `str(float)` / `repr(float)` is `pyFloatRepr`.
- **Formatting.** `f"{x:,}"` and `f"{x:.1f}"`: format the way Python does. Python `round()` rounds half to even.
- **Sorting and grouping.** Python sorts strings by code point (use `a < b ? -1 : 1`, not `localeCompare`). A dict keeps
  insertion order (so does a JS object, except for integer-like keys: use a `Map` when keys can look like
  integers).
- **Regex.** `re.match` anchors at the start; `\w` covers Unicode in Python and only ASCII in JS (add the `u` flag
  and `\p{L}` when it matters).
- **Errors.** Keep every error and note message's text.
- **Network.** None in tests: everything runs on the fixtures. A request the fixtures lack fails with
  `fixture_missing`, which means the URL or encoding differs from Python's (compare with `index.json`).

## Do not
- Edit anything under `src/core/`, or `src/tools.ts`, `src/server.ts`, `src/session.ts`, `src/envelope.ts`,
  `src/adapters/index.ts`, `test/helpers.ts`, `scripts/`, fixtures, `packs/`, or another pack's files. If core lacks
  something, implement it inside your adapter's files and list it under "core gaps" in your report.
- Commit, push, install packages, or make network calls.
- Print or store keys.

## Report (final message)
For each pack, give:
- ported / partial / blocked;
- tests ported and passing, and parity cases SAME / total;
- any difference from Python that you could not remove, and why;
- core gaps you worked around;
- Python tests you skipped, and why.

## Core updates made during the port (use these, no workaround needed)
- **Lists of objects in a cell.** `parsePyJson` remembers numbers it holds as text (`"4.0"`, big integers), and
  `pyJsonDumps` writes them back as numbers. So a list of objects that `flatten` writes as JSON text matches
  Python's `json.dumps`.
- **Column order.** JS objects list integer-like keys ("1940", "2024") first. Return
  `withColumns(rows, [...columns in Python's order])` (from `src/core/package.ts`) and `package.write` uses that
  order.
- **Async search.** `Adapter.search` and `DeepPack.search` may be async.
- **Typing tests.** `npm run typecheck` also type-checks test/ and scripts/ (tsconfig.test.json).
