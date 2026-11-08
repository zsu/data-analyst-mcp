# report.json: the full schema (`build_report`)

`build_report` takes this object, saves it as `report.json` in the workspace and builds `report.html` and
`replication_package.zip`. Every key below is optional unless marked **required**; every path is relative to
the workspace. The layout and what each part should say are in `guide("report_patterns")` section 5; the
wording rules are in `guide("style")`. This page lists what the builder reads.

## Text in any prose field

- Paragraphs are separated by a blank line. A block whose lines all start with `- ` or `* ` becomes a list.
  A prose field may be a string or a list of strings (each one a block).
- Inline: `**bold**`, `*italic*`, `` `code` ``, `[text](https://...)`.
- Facts: `{{name}}` or `{{name|fmt}}` (a fact from `facts.json`, in the formats the `facts` tool accepts). A
  fact that is not in `facts.json`, or a malformed placeholder, stops the build. A fact that opens a sentence
  is capitalized.
- Citations: `[@id]` or `[@id1; @id2]`, each id an entry of `references`. An unknown id stops the build.
- Footnotes: `[^n]` points to item n (from 1) of the footnote list in scope (see Footnotes below).
- Placeholders are not filled inside `data`, `chart` or `path` values, nor in the top-level `data_files`,
  `facts`, `provenance`, `request`, `sources` and `replication`.

## Top level

| Key | Type | What it does |
| --- | --- | --- |
| `mode` | `"report"` (default) or `"paper"` | `report`: the exhibit chartbook. `paper`: prose-led, exhibits in the running text. |
| `title` | string | The page title and heading. |
| `subtitle` | string | The line under the title. |
| `date` | `YYYY-MM-DD` | Shown as "Month Year". Missing: today, with a note. |
| `organization` | string | Shown with the date above the title. |
| `status` | string | A badge after the date (for example "Draft"). |
| `sources` | list | Pack ids used (`"fred"`), or objects `{"source": "<id>", "spec": {...}}` (`id` also works). Missing: the folders under `data/`. Each source's notices, redistribution rules and vintage block are applied. |
| `request` | string | The user's request, quoted at the top of Data and Methods. |
| `citation` | string | Replaces the generated data citations (Data Citation in the methods, REPLICATION.md). |
| `facts` | path | The facts file. Default `facts.json`. |
| `provenance` | path, or `{"<id>": path}` | Each source's provenance file. Default: the first of `request.json`, `fetch_spec.json`, `manifest.json`, `extract_spec.json` in `data/<id>/`. |
| `cover` | object | Report mode only: `{"exhibit": n, "title": "..."}`. Exhibit n's chart is drawn on the cover (it must have a chart, not a table). `title` replaces the exhibit's title there. |
| `at_a_glance` | object | Report mode: `{"text": "framing paragraph", "findings": [...]}`. A finding is `{"lead": "Section name.", "text": "..."}` (the lead is printed bold) or a string. Missing findings: `summary` is used. |
| `summary` | list | Paper mode: the Summary paragraphs (same finding forms). Report mode: the At a Glance findings when `at_a_glance.findings` is empty. |
| `highlights` | list | Number tiles `{"label", "value", "note"}`, in At a Glance (report) or Summary (paper). |
| `notes_page` | string or list | Report mode: Notes About This Report. When `data_needs` is not empty, a line pointing to Appendix A is added. |
| `introduction` | object | Report mode: `{"title": "Introduction", "text": "...", "subsections": [{"heading", "body"}], "footnotes": [...]}`. Subsection headings are listed in the contents. |
| `sections` | list | `{"heading", "body", "exhibits": [n, ...], "footnotes": [...]}`. See Sections. |
| `exhibits` | list | See Exhibits. Numbered 1, 2, ... in list order. |
| `methods` | string or list | The prose of Appendix A: Data and Methods (Appendix: Data and Methods in a paper). |
| `appendixes` | list | Report mode: `{"title", "body"}`, lettered Appendix B, C, ... after Appendix A. |
| `references` | list | `{"id", "label", "citation", "url", "accessed", "used_for", "opened", "quote"}`. `[@id]` prints `label` (else `id`). `opened` and `quote` are checked against the snapshot `cite` saved. |
| `assumptions` | list | `{"parameter", "value", "basis", "evidence"}`; with `"basis": "judgment"` also `why_not_empirical` and `sensitivity` (a row in `exhibits/sensitivity.csv`). |
| `footnotes` | list | The report's Notes (see Footnotes). |
| `about` | string or list | About This Document. Report mode always prints the section; a paper prints it only when given. |
| `data_files` | list | `{"label", "path"}`: files linked under Data Underlying the Exhibits, with checksums in the Audit Trail. Every path must exist. Files a source's terms keep local are dropped from the links, with a note. The ZIP is added. |
| `clearance` | list | `{"source", "key", "basis", "redistribute": true or false}`: one entry per key a source withholds (for example a FRED series whose copyright is not cleared). `"redistribute": true` lets its rows into shared files; `basis` is required by the audit. `source` may be left empty to match any source. |
| `copyright_clearance` | list | The same, by series: `{"series_id", "basis", "redistribute"}`. |
| `replication` | object | `files`: the top-level files of the ZIP (default `spec.json`, `plan.json`, `analysis.py`, `facts.json`, `decisions.json`, `report.json`); `extra`: more files to add; `include_data: false`: leave the data files out (`data_dictionary.csv` stays). Exhibit CSVs and `exhibits/*.json` are always added. `include_microdata` is ignored. |

Keys of the method record, normally written with `record_decisions` (`decisions.json`) and merged into the
report (lists are joined; for `references` and `assumptions`, report.json wins on the same `id` or `parameter`): `questions`, `literature_search`, `references`,
`assumptions`, `disclosures`, `data_needs` (`{"data", "effect", "how_to_get", "from_user"}`),
`data_needs_note`, `audit_allow` (numbers allowed in the prose, `{"value", "reason"}`) and `rounding_ties_ok`
(`{"fact", "reason"}`).

## Sections

- Report mode: `sections[].exhibits` must show every exhibit exactly once, in order (`[1]`, `[2, 3]`, ...),
  and every section needs a `body` (its summary paragraphs). The build stops otherwise.
- Paper mode: the exhibits listed in a section follow its body; exhibits no section lists go at the end
  under Exhibits.

## Exhibits

| Key | What it does |
| --- | --- |
| `title` | **Required.** End it with its period (", 2013 to 2023"). |
| `subtitle` | The units line ("Percent", "Billions of 2024 dollars"). |
| `text` | Report mode: the 2 to 4 paragraphs beside the chart (not printed in a paper). |
| `data` | The exhibit CSV (`exhibits/<name>.csv`, written by `compute`). Its download name is the file name. |
| `rows` | Instead of `data`: the rows inline, a list of objects. |
| `chart` | See Charts. Missing, or `"type": "table"`: a table only, shown open. |
| `source` | The data source line under the chart ("Analyst calculations using data from ..."). The audit requires it to name a source used. |
| `notes` | The notes line under the source line. |

## Charts

`chart` is `{"type", "x", "y", ...}`; `x`, `y`, `series` and every `filter` and `columns` name are columns of
the exhibit CSV.

| Key | What it does |
| --- | --- |
| `type` | `line` (default), `column` (vertical bars, grouped when there are several series), `hbar` (horizontal bars), `stacked` (stacked columns), `stacked_h` (stacked horizontal bars), `table` (no chart). |
| `x` | The category or time column. |
| `y` | The value column, or a list of value columns (one series each; `series` is then ignored). |
| `series` | A column whose values become the series (long data). Without it, one series named `series_name`, else the exhibit subtitle, else `y`. |
| `series_name` | The name of the single series when there is no `series` column. |
| `filter` | `{"column": value}` or `{"column": [values]}`: only these rows are drawn (the table and download keep every row). Each (series, x) pair must be one row, or the build stops and asks for a `filter`. |
| `x_order` | The order of the x categories (values not listed follow, in data order). |
| `series_order` | The order of the series (and of the legend). More than 8 series returns a note (unreadable). |
| `date` | Line charts: the column of ISO dates (`YYYY-MM-DD`; default `date`). When every x has one, the axis is a real calendar axis, so gaps show. |
| `recessions` | Line charts with a date axis: `true` shades the periods in `exhibits/recessions.csv` (columns `start`, `end`, saved with `compute`), or a path to another such file. The file must exist. The NBER note is added to the exhibit notes. |
| `recession_note` | Replaces that note. |
| `format` | `number` (default), `pct` (fractions shown times 100), `pct100` (already in percent), `dollars`. |
| `decimals` | Decimals of the values on the chart. |
| `y_min`, `y_max` | Fix the value axis. |
| `columns` | The columns the table and download show (and the chart reads), in this order. Each must be in the CSV. |

## Footnotes

- Global: `footnotes` at the top level, printed as Notes; `[^n]` anywhere refers to them, unless a
  narrower list is in scope.
- Report mode: a section with its own `footnotes` gets its own numbering, printed at the end of the section;
  `[^n]` in its body and in the text, source and notes of its exhibits refers to that list. The same holds for
  `introduction.footnotes`, for the introduction's text and subsections.
- Paper mode: only the global list is used.

## What the audit checks on top (report mode)

`audit_report` fails a chartbook without: `at_a_glance.text`; 3 to 5 findings, each with a `lead`; a
`notes_page`; `introduction.text` and `introduction.subsections`; 2 or more sections, each showing an
exhibit; `text` on every exhibit; `about`. When a source records vintage information, `methods` or
`notes_page` must state the vintage and that the source revises its data.

## A minimal report

The builder accepts this; the audit also wants 3 to 5 findings and 2 or more sections.

```json
{
  "mode": "report", "title": "Unemployment, 2019 to 2025", "date": "2026-11-01", "sources": ["bls"],
  "cover": {"exhibit": 1},
  "at_a_glance": {"text": "...", "findings": [{"lead": "Unemployment.", "text": "The rate was {{ur_last}}."}]},
  "notes_page": ["Unless otherwise indicated, all years are calendar years."],
  "introduction": {"text": "...", "subsections": [{"heading": "How Did Unemployment Change?", "body": "..."}]},
  "sections": [{"heading": "Unemployment", "body": "... (see Exhibit 1).[^1]", "exhibits": [1],
                "footnotes": ["Seasonally adjusted."]}],
  "exhibits": [{"title": "Unemployment Rate, 2019 to 2025", "subtitle": "Percent", "text": "...",
                "data": "exhibits/unemployment.csv",
                "chart": {"type": "line", "x": "month", "y": "value", "date": "date", "recessions": true,
                          "format": "pct100", "decimals": 1},
                "source": "Analyst calculations using data from the Bureau of Labor Statistics."}],
  "methods": "...", "about": "..."
}
```
