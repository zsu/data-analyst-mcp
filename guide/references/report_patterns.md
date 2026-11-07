# Analysis and report patterns (every source)

Use this file to frame the analysis, choose the critical questions, and shape the product. The aim is work
a careful analyst at a statistical or policy agency would recognize: the right measure, the right period,
stated units and dollar basis, numbers that tie to the published source, every number traceable to a cell,
and limitations stated plainly. It holds only cross-source guidance. Each pack's `source.md` adds its own
measures, traps and benchmarks ("Data format and traps"), and deep packs keep longer notes in `docs/`:
read those for the sources a question uses (treasury: stocks and flows of the budget; bls and fred:
growth measures, vintages, seasonal adjustment; bea: chained dollars and revisions; ipums: weights,
universes, replicate standard errors; opm: redaction of pay and location).

## 1. Critical questions bank

Ask only the ones the request leaves open **and** that would change a headline number: at most four, in one
round, with "Don't know — decide for me" on each and the recommended option first. A source's `clarify`
list (`fetch.py --source <id> --clarify`) names the questions specific to it; merge them with these and keep
the four that matter most.

Each question has exactly one "Don't know" option, never a separate "Skip". A skipped or unanswered
question is a "Don't know" and is decided by the rule in the last column. The exception is a blocking
question about what the user means (which program, place or population): ask it once more, then take the
literal reading and say so first. Record every question, its answer and its resolution in
`decisions.json` → `questions` (schema: `scripts/report/method_audit.py`).

| Choice | Ask when | Options (recommended first) | How to decide when the user does not know |
|---|---|---|---|
| **Which measure** | two or more published measures answer the question | the measure the question's institution uses · the alternative | Use the measure the relevant agency or law uses (PCE price index for macro inflation, CPI-W for Social Security COLAs, debt held by the public for economic analysis, budget-basis series for budget questions); report the other as a sensitivity |
| **Period basis** | annual figures | Calendar year · Federal fiscal year (October to September) | Budget amounts: fiscal years, with fiscal-year GDP for shares of GDP. Economic and survey series: calendar years |
| **Time span** | the request names no years | last 10 complete years · since a business-cycle peak · longest available | 10 complete years; for a change over "the past N years", compare endpoints N years apart and name the years. A partial latest year only as "year to date" against the same months a year earlier |
| **Dollar basis** | comparisons across more than about 3 years | Nominal · Real (named index, latest full year's dollars) · Share of GDP | Nominal for levels people quote, plus real or share of GDP when growth over a decade is the point; run both and say whether the conclusion changes |
| **Growth measure** | annual growth of output or prices | Q4 over Q4 · annual average over annual average · quarterly annualized · year over year | Q4 over Q4 for annual growth of GDP and inflation; annual averages for rates; quarterly annualized for the latest quarter; name the measure every time |
| **Frequency conversion** | the sources differ in frequency | average · end of period · sum | Rates and prices: average. Stocks (debt, balances, headcount): end of period. Flows: sums of complete periods only (`combine.to_fiscal` flags incomplete years) |
| **Vintage** | the question is about what was known at a time, or about revisions | latest · as published on a date · first release | Latest, unless the timing matters; then the vintage just before that date, and say so |
| **Seasonal adjustment** | monthly or quarterly series | SA · NSA | SA for short-run changes and charts; NSA for 12-month changes and annual averages where the agency does so |
| **Population or universe** | survey and administrative microdata | the published universe · a narrower group | The universe of the benchmark publication (for example civilian noninstitutionalized people age 16 or older); prime-age work uses ages 25 to 54 |
| **Geography** | places are compared | states · counties · metro areas | The finest level with reliable estimates; say which vintage of boundaries |
| **Product** | the user did not ask for a report | Short answer + data (default) · Full HTML report · Data files only | The default; offer the report in one line |
| **Audience and organization** | a report is wanted | Neutral analyst product · Named organization | Neutral unless the user names one |

Not critical (decide and record them in the methods): CSV vs JSON, field selection, chart type, rounding,
the exact endpoint when two give identical published totals, series IDs (resolve them with `--search`).

## 2. Conventions

**Periods and timing**
- The federal fiscal year runs October 1 to September 30 and is named for the year it ends. Write "fiscal
  year 2025" in prose and "FY2025" only in tables and charts (`combine.fiscal_year`, `combine.to_fiscal`).
- Say how current the data are: "data through September 2026, retrieved October 20, 2026". The report
  builder adds each source's retrieval date and vintage (the Data Vintage block); the methods say which
  release the estimates come from.
- Survey income questions often refer to the previous calendar year (CPS ASEC 2023 = 2022 income); check the
  pack's traps before labeling years.

**Stocks, flows and rates**
- Stocks (debt, cash, headcount): end-of-period value or period average, never a sum. Flows (receipts,
  outlays, hires): sums of complete periods; never sum year-to-date values across months.
- Rates: define the numerator, denominator and universe at first use. Differences of rates are in
  percentage points (the `pp` and `pp100` formats).
- Annualized rates: quarterly growth at an annual rate is `(Q_t/Q_{t-1})^4 - 1`. Levels already at an
  annual rate (SAAR) are not multiplied by four; a fiscal-year GDP is the mean of four quarterly values.

**Units and signs**
- Read every source's units from its data dictionary or series table (thousands, millions, an index, a
  percent). Convert once, in `analysis.py`, and name the unit in every exhibit subtitle.
- Pick one sign convention for deficits and changes and state it in the notes.
- Use the fact formats for scale (`usd_b`, `from_millions:dollars_b`, `kmillions`; see
  `scripts/analysis/factfmt.py`) rather than dividing by hand.

**Real dollars**
- Deflate with a named price index over the same period basis as the values, into the dollars of the latest
  complete period (`combine.deflate`); name the index and base year in the notes.
- Chained-dollar components do not add to their totals: compute shares in nominal terms.

**Combining sources** (`scripts/analysis/combine.py`)
- Before any join, `align_check(frames, on, units)`: the same keys, the same period basis, units named.
  State codes through `state()` / `add_state_codes()`, never by hand.
- One source per measure: when two sources publish the same measure, say which one is used and why; do not
  splice them into one series without a break note.
- Record each exhibit's lineage with `save_exhibit(df, OUT, "exhibits/exhibit_n.csv", packs=[...])` and give
  facts a `pack=` when several sources are in the folder. The audit checks that every lineage and fact pack
  is a source of the report.

**Revisions and provenance**
- Agencies revise: payroll benchmarks, seasonal factors, GDP vintages, survey reweighting, file versions.
  Record the retrieval date (each `data/<id>/request.json` has it) and note revisions when a comparison
  spans releases. Register preliminary, projected or past-vintage values with `preliminary=True`,
  `projection=True` or `vintage=` and say so where they are cited (the audit enforces it).
- Never present a projection as data; cite it as the projecting agency's.

**Precision and suppression**
- Survey estimates: weight them (the pack names the weight), keep unweighted cell sizes, and suppress or
  footnote cells below the pack's threshold. Say whether differences that drive conclusions are large
  relative to sampling error; use the pack's standard-error helpers when it has them.
- Administrative files with redaction (withheld pay or location): report coverage and say how the
  estimates treat redacted records; the pack's audit hooks require it.

**Correlation, not cause**
- An event "coincided with" a change unless a method that supports a causal claim was used. No forecasts
  of your own; cite other forecasts as theirs.

## 3. Benchmarks and checks

- **Benchmark every headline number** against a published figure from the source (the release table, the
  statement of record, the agency's own derived series) and save each comparison in `exhibits/benchmark.csv`
  (measure, period, computed, published, source, URL, accessed date). Say "matches" only for rows in that
  file; a source not opened is "not checked". A difference above rounding means a filter, units or
  period-basis mistake.
- Components must add to their published totals; check internal identities when the downloaded table is
  itself the total.
- Before writing: units (millions vs. billions), dates (fiscal-year end vs. start), the last date of every
  series (a lagging series silently shortens a ratio), projections cut off, no silent conversion across a gap.
- **Evidence before judgment.** Each key definition and parameter goes in `decisions.json` → `assumptions`
  with a basis, strongest first: `empirical` (estimated from the data in `analysis.py`; the evidence names the
  exhibit CSV or `{{fact}}`), `literature` (a published estimate), `precedent` (the agency's own practice),
  both cited as an opened `[@ref]`, `user` (the user's answer), and only then `judgment`. A judgment call
  states `why_not_empirical` and has a row in `exhibits/sensitivity.csv` (parameter, base, alternative,
  headline_base, headline_alt, conclusion_changes). The audit fails anything weaker.
- **Literature.** Record each search (query, date, what it found) in `literature_search` and each opened
  source in `references` (citation, url, accessed, `opened: true`).
- **Data that would improve the estimates.** `data_needs` names the data that would replace each judgment
  call or unchecked benchmark: `data`, `improves`, `effect`, `how_to_get`, `from_user`. The builder lists them
  in Appendix A, and the quick answer gives the top three. `[]` with a `data_needs_note` when none would help.
- Quick answers pass the same gate: `scripts/report/audit_answer.py <out> --online --rerun`.

## 4. Numbers, facts and the audit

- Every number in the prose is a `{{fact}}` from `facts.json` (`scripts/analysis/facts.py`), a year, or
  listed in `audit_allow` with a reason. Facts read their value back from the saved CSV cell; derived facts
  state their derivation; each fact records its source pack.
- `scripts/report/build_report.py` fills the placeholders; `scripts/report/audit_report.py --rerun` is the
  release gate. Fix every FAIL before handing anything over; the style score is printed, never written into
  the report.

## 5. Publication structure (`build_report.py`, `"mode": "report"`)

The default layout, the **exhibit chartbook**, runs in this order:
1. **Cover:** "Month Year", the title (with the period for trend reports), and a hero chart with its own
   title and unit label.
2. **At a Glance** (about 300 to 420 words): one framing paragraph (what was examined, the measures or
   population, the period), then 3 to 5 bullets, each opening with a **bold lead phrase.** that names a
   section, followed by 2 to 4 sentences with the key numbers.
3. **Contents** and **List of Exhibits** (built automatically, grouped by section).
4. **Notes About This Report:** calendar or fiscal years; rounding; seasonal adjustment; nominal or real
   dollars (index and base year); the data sources, retrieval dates and vintages; key definitions;
   recession shading; partial-period coverage; where the data are posted.
5. **Introduction:** a lead paragraph with the headline numbers; question-style subheadings, one per section
   ("How Did Interest Costs Change?"); then "What Data Were Used?" and, when updating earlier work, "How Do
   These Estimates Compare With Published Figures?".
6. **Thematic sections** (2 to 5): each opens with 1 to 3 summary paragraphs, then one exhibit per page with
   2 to 4 narrative paragraphs beside the chart (level, change, comparison; "see Exhibit 3"). Below each
   chart: the data source line, then the notes, then lettered notes.
7. **Appendix A: Data and Methods:** the request, sources and rows used, filters, cut-off dates, universes and
   weights, period basis, deflator, benchmarks, revisions and vintages, limitations. The builder adds the
   Data Vintage block, the assumptions table, the data files, the citation and every required notice.
   Optional **Appendix B, C ...** (definitions, a glossary).
8. **References**, then **About This Document** (who asked, who prepared it, with what data and tools, the
   reviewers if any, the date).
9. Supplementary: **Replication Materials** (the ZIP and the embedded code) and the **Audit Trail**
   (provenance per source, checksums, the source cell and source pack of every number).

Use `"mode": "paper"` for a prose-led product with the exhibits in the running text. Long-form reports with
chapters and boxes are not built; adapt the chartbook instead.

## 6. Data files and redistribution

Each source's policy decides what leaves the analysis folder (the builder applies it, the audit enforces it):
- `allowed` (public domain, open licence): the data go into the replication package as retrieved.
- `aggregates_only`: tables of estimates go in; row-level files (the policy's `microdata_globs`) stay local.
- `definition_only` (IPUMS-style terms): no data file leaves; the package carries the request definition and
  `reproduce/<id>/`: `download_<id>.sh` / `.ps1` (one command downloads the data under the reader's own
  account: the request is built in and the key is asked for with hidden input), the request (`spec.json`, IPUMS
  `extract_spec.json`) and `REPRODUCE.md` (the commands, then `--ingest` and `lib/run_analysis.py`). The page
  attaches all of them with Download buttons. The page never links the extract.
- `withhold` (for example FRED series whose copyright is not cleared): their rows are dropped from shared
  files, and each one needs a `clearance` entry in report.json with its basis (`"redistribute": true` only
  when the owner's terms or permission allow it).
- Data files over 50 MB stay out of the package with a note; they can be downloaded again.
Exhibit CSVs are aggregates and ship with the product unless a source's audit hook forbids them.

## 7. Chart forms

- Trends over time: line charts with at most 4 to 5 series (facet rather than drawing 8 lines). A line chart
  with an ISO `date` column gets a real date axis, so gaps show; `"recessions": true` shades
  `exhibits/recessions.csv`. Trailing-12-month lines suit very seasonal monthly flows.
- Group comparisons at a point in time: grouped columns, or horizontal bars when labels are long; sort them.
- Composition: horizontal bars for one period; stacked columns over time with at most about 6 groups plus
  "Other".
- Deficits and other signed values: columns with the sign convention stated.
- No dual axes, no pie charts, no 3-D. Scale amounts in the exhibit CSV and name the unit in the subtitle.

## 8. Reading publications that block scripts

Some publishers refuse scripts and the in-app browser (HTTP 403, a bot check). Fetch
`https://web.archive.org/web/<year>/<full url>` and extract the text (pypdf for PDFs). If the plain year
URL returns HTML, use a CDX timestamp with `id_` (for example
`https://web.archive.org/web/20240430034127id_/<url>`). Cite the original URL.
