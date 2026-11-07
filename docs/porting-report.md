# Porting the analysis and report layer (Python → TypeScript MCP tools)

The Python skill has the model write and run `<out>/analysis.py`, which uses pandas and `Facts`. It then runs
the report scripts on that folder. On an MCP server (especially a hosted one) the model cannot run our code.
So the same products and the same gates come through **tools that work on the session workspace**. The file
formats stay the Python ones (facts.json, decisions.json, exhibits/*.csv, report.json, benchmark.csv,
sensitivity.csv, references/opened.json), so the audits port almost line for line.

Python sources live in `C:\zsu\Projects\data-analyst\plugins\data-analyst\skills\data-analyst\scripts\`:
`analysis/` (facts, factfmt, combine) and `report/` (build_report, audit_answer, audit_report, method_audit,
policyset, style_check, scan_secrets), plus `core/cite.py` and `core/handoff.py`. Tests are under
`C:\zsu\Projects\data-analyst\tests\`: test_combine, test_handoff, test_method_audit, test_report_chain and
test_scan_secrets. Read `AGENTS.md` and `docs/porting-adapters.md` (Python semantics, do-not-edit list, report
format) first.

## Registering tools
`src/analysis/tools.ts` and `src/report/tools.ts` each export `TOOLS: ToolDef[]` (type in `src/toolkit.ts`).
server.ts already registers every entry, with the shared wrapper (redaction, remote links, error envelope).
Throw `fail(code, message, fix)` from `src/envelope.ts` for failures. **Do not edit** server.ts, tools.ts,
session.ts, envelope.ts or src/core/. Descriptions are written for the model: say when to call the tool and what
comes back.

## Analysis tools (agent 1: `src/analysis/`)
- **`compute`** `{inputs: {alias: "data/<id>/<table>.csv" | "exhibits/<x>.csv"}, steps: [...], save_as:
  "exhibits/<name>.csv", packs?: [...]}`
  - Runs declarative steps over full workspace tables, with **no eval or Function anywhere**. Expressions
    are parsed by our own small parser, against a whitelist of operators and functions.
  - Verbs: `filter`, `derive`, `select`, `rename`, `groupby` + `rollup`, `join` (inner, left; with `on`),
    `pivot_wider`, `pivot_longer`, `orderby`, `slice`, `dedupe`, `concat`.
  - The combine helpers become verbs: `fiscal_year`, `to_fiscal` (with the `complete` flag), `state_codes`
    (add_state_codes), `deflate` (a named index and base). `align_check` is a check that refuses, with
    combine.py's messages.
  - Aggregates: sum, mean, median, min, max, count, first, last, stdev, weighted_mean.
  - Numbers parse from CSV text, so `"1,234"` stays text unless converted with `number()`.
  - It saves the CSV (Python csv conventions, through `writeCsv`) and records its **lineage** in
    `exhibits/lineage.json`: inputs (path and sha256), steps, packs. It returns columns, row count, the first
    rows (at most 50), and the file.
- **`facts`** `{add: [{name, table, where, column, fmt, label, pack, headline, preliminary, vintage,
  projection, se}], derived: [{name, value, derivation, fmt, label, pack}]}`
  - Port facts.py and factfmt.py: same facts.json schema, value read back from the CSV cell, the same
    refusals (NaN, a missing cell, an ambiguous pack), and the same `text`.
- **`rerun`**: export `rerunWorkspace(workspace)` from `src/analysis/rerun.ts`. It replays every exhibit's
  lineage from its inputs and recomputes every table fact. It returns `{exhibits: {path: {same: bool}},
  facts: {name: {stored, rerun, same}}}`. This is the `--rerun` gate.
- **`cite`** `{url, id, text?}`
  - Port core/cite.py. It saves the page (`text`: what the model's own fetch tool returned) into
    references/ and records it in opened.json.
  - Without text, it downloads through `src/core/http.ts`.
  - Remote mode: refuse private and loopback addresses. Resolve the host first, and block 10/8, 172.16/12,
    192.168/16, 127/8, 169.254/16, ::1 and fc00::/7.
- **`handoff`**: port core/handoff.py, the per-source data hand-off as Markdown plus structured data.
- Port test_combine and test_handoff, plus your own tests: `compute` must reject anything outside the
  whitelist (property access, `constructor`, `__proto__`, calls of unknown functions, template strings).

## Report tools (agent 2: `src/report/`)
- **`audit_answer`** `{answer: "<the reply as it will be sent>", online?: boolean, rerun?: boolean}`
  - Writes `<workspace>/answer.md` and runs the audit_answer.py checks, using method_audit.py for the
    decisions.json rules.
  - Returns every check with PASS/FAIL and its message, and `"AUDIT PASSED"` only when nothing fails.
  - `rerun` uses `rerunWorkspace` from `src/analysis/rerun.ts` (agent 1 writes it; until then, import it and
    let rerun tests wait).
- **`build_report`** `{report: <report.json object>}`
  - Port build_report.py: the template is `guide/assets/report_template.html`, the disclaimer
    `guide/assets/disclaimer.txt`.
  - Includes the policy-driven notices, the redistribution rules (policyset.py), vintage blocks, and the
    replication ZIP built with fflate. The ZIP's reproduce section points at this server's tools instead of
    analysis.py.
  - Returns the report.html and zip paths.
- **`style_check`** and **`audit_report`** `{online?, rerun?}`: port them as they are.
- **`scan_secrets`**: port it, and use it inside both audits (no key or key-shaped value in any workspace file).
- Port test_method_audit, test_scan_secrets and test_report_chain. The Python tests build an `<out>` with an
  analysis.py; build the same workspace through `compute` and `facts` instead, and keep every assertion about
  the audit's PASS/FAIL messages.

## Done
`npx vitest run test/analysis*.test.ts` (agent 1) or `test/report*.test.ts` (agent 2) passes, and tsc shows no
errors in your folder. Your final message reports each tool, the tests ported, and any Python check you could not
port and why.
