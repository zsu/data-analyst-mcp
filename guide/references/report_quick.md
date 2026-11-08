# Report in short

What `build_report` and `audit_report` need, in one page. The full references are by section:
`guide("report_schema")` (every report.json key), `guide("report_patterns")` (structure, benchmarks, chart forms)
and `guide("style")` (the house style). Ask for a section only when this page does not settle a question.

## The steps
1. Every number in the prose is a fact: register it with `facts`, write it as `{{name}}` (or `{{name|fmt}}`).
   References are `[@id]`, footnotes `[^n]`. A number typed by hand fails the audit unless `audit_allow` lists it.
2. Every exhibit is a CSV in `exhibits/` saved by `compute` or `write_table`.
3. `build_report` with the report object. It writes report.json, report.html and replication_package.zip, and
   returns the style score with the sentences to fix. Later fixes: `build_report` with `patch`
   (`{"sections.0.body": "..."}`) or with no report (it rebuilds from report.json). Never send the whole object
   again for a small fix.
4. `audit_report` (`rerun: true` replays every recipe and fact). It returns the failures only. Fix them and
   rebuild until it prints AUDIT PASSED. A rerun that is still going answers `in_progress`: call again.

## What the audit requires (report mode)
- `at_a_glance.text` and 3 to 5 findings, each `{"lead": "Section name.", "text": "..."}`.
- `notes_page`; `introduction.text` and `introduction.subsections` (question-style headings, one per section).
- 2 or more `sections`, each showing an exhibit (`"exhibits": [n]`, and "see Exhibit n" in the body).
- `text` on every exhibit; `about`; `methods` (Appendix A: request, sources, filters, universes, weights,
  deflator, benchmarks, vintages, limitations).
- When a source records a vintage, `methods` or `notes_page` states it and says the source revises its data.
- `sources`: the pack ids used. The builder adds each source's notices, the Data Vintage block, the assumptions
  table and the citation; never type those by hand.

## A minimal report
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
                "chart": {"type": "line", "x": "month", "y": "value", "date": "date", "format": "pct100", "decimals": 1},
                "source": "Analyst calculations using data from the Bureau of Labor Statistics."}],
  "methods": "...", "about": "..."
}
```
`mode: "paper"` is prose-led, with the exhibits in the running text (a `summary` list instead of `at_a_glance`).

## Charts
`chart`: `{"type", "x", "y", ...}`; every name is a column of the exhibit CSV. Types: `line` (default), `column`,
`hbar`, `stacked`, `stacked_h`, `table`. Long data: `series` (a column); wide data: `y` as a list. Others:
`filter`, `x_order`, `series_order` (at most 8 series), `date` (ISO dates, a calendar axis), `recessions`,
`format` (`number`, `pct` for fractions, `pct100`, `dollars`), `decimals`, `y_min`/`y_max`, `columns`.

## Style rules the build checks
- No first person ("we", "our", "I") and no contractions; the analysis *estimates*.
- *percent* in words; *percentage points* for differences; zero to nine in words, 10 and up in numerals; no
  sentence starts with a numeral.
- Ranges *from X to Y*; ages *ages 25 to 54*; years in full.
- Plain words: none of "e.g.", "i.e.", "etc.", "utilize", "prior to", "regarding", "methodology", "data set".
- Sentences short; titles and headings in headline style; every exhibit has a units line and a source line.
- Define each rate, universe and abbreviation at first use. Name the dollar year and the price index.
