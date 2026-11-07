# Federal Register (federalregister.gov API)
Depth: standard. Key: none. Every Federal Register document since 1994: final and proposed rules, agency
notices, executive orders, proclamations and other presidential documents, plus public inspection.

## When to use
- Counts and lists of executive orders by president or year; final or proposed rules by agency, year,
  docket, RIN or CFR part; significant rules (EO 12866 flag); comment deadlines; what publishes tomorrow
  (public inspection).
- Not here: public comments and docket contents (regulations), the legal text of the CFR or full text of
  older Federal Register issues (govinfo, collections CFR and FR), bills and laws (congress), presidential
  documents before 1994 (govinfo CPD covers 1993 on; earlier ones are in the printed Weekly Compilation).

## Endpoints and datasets
| Endpoint | Returns (one row per) | Key parameters |
|---|---|---|
| `documents` | document | `conditions[term]`, `conditions[type][]` (RULE, PRORULE, NOTICE, PRESDOCU), `conditions[agencies][]` (slug), `conditions[publication_date][gte/lte/year]`, `conditions[significant]`, `conditions[docket_id]`, `conditions[regulation_id_number]`, `conditions[cfr][title]`/`[part]`, `order`, `fields[]` |
| `executive_orders` | executive order | `conditions[president][]`, `conditions[publication_date][year]`, `conditions[signing_date][gte/lte]`, `conditions[term]` |
| `document_counts` | group (key, name, count) | `facet` (daily, weekly, monthly, quarterly, yearly, agency, topic, section, type, subtype) plus the same `conditions[...]` filters |
| `document` | one document, all metadata | `document_number` |
| `public_inspection_current` | document filed for publication | none |
| `public_inspection` | document on inspection that day | `conditions[available_on]` (YYYY-MM-DD) |
| `agencies` | agency (id, name, slug, parent_id) | none |

Parameter names are the API's own, brackets included; a list value repeats the parameter
(`"conditions[type][]": ["RULE", "PRORULE"]`). President slugs: `donald-trump`, `joe-biden`,
`barack-obama`, `george-w-bush`, `william-j-clinton`. Default `fields[]` for `documents`:
document_number, citation, publication_date, signing_date, effective_on, type, subtype, title, abstract,
action, agency_names, executive_order_number, proclamation_number, president, docket_ids,
regulation_id_numbers, significant, comments_close_on, page_length, start_page, end_page, html_url,
pdf_url. Other fields: `body_html_url`, `raw_text_url`, `full_text_xml_url`, `cfr_references`,
`topics`, `disposition_notes`, `dates`, `correction_of`. `--search` finds the catalog aliases.

## Spec examples
```json
{"description": "Executive orders published in 2024",
 "requests": [{"name": "eo_2024", "endpoint": "executive_orders",
   "params": {"conditions[president][]": "joe-biden", "conditions[publication_date][year]": "2024"}}]}
```
```json
{"description": "EPA final rules per year, and the significant ones since 2024",
 "requests": [
  {"name": "epa_rules_by_year", "endpoint": "document_counts",
   "params": {"facet": "yearly", "conditions[type][]": "RULE", "conditions[agencies][]": "environmental-protection-agency"}},
  {"name": "epa_significant", "endpoint": "documents",
   "params": {"conditions[type][]": "RULE", "conditions[agencies][]": "environmental-protection-agency",
              "conditions[significant]": "1", "conditions[publication_date][gte]": "2024-01-01"}}]}
```
```json
{"description": "Documents on public inspection now",
 "requests": [{"name": "pi_today", "endpoint": "public_inspection_current"}]}
```

## Data format and traps
- At most 10,000 documents per query (the API refuses `page x per_page` above 10,000 with HTTP 400);
  `max_rows` is 10,000. For more, split the query by date range. `count` in the response is also
  capped at 10,000 for broad queries; use `document_counts` (facets) for totals.
- Pages past `total_pages` (shown as at most 50) silently return page 1 again. The pack pages with
  `per_page=1000`, so 10 pages reach the cap first; do not hand-craft `page` values. `per_page` below 20
  is ignored (per_page=1 returns 20 rows); use `max_rows` to cut a list.
- Paging is by page number over an order that is not unique (many documents share a date), so a long
  list can repeat a document on two pages and skip another (`order=oldest`: 2 of 10,000 rules repeated,
  verified 2026-10-22). The pack drops repeated `document_number`s; a skipped one is not recovered, so for
  exact counts use `document_counts` facets or split the query by date range into lists well under 10,000.
- Executive orders by year count by signing date on the Federal Register's own yearly tables: filter
  `executive_orders` with `conditions[signing_date][gte/lte]`; `conditions[publication_date][year]` and
  the `document_counts` facets count by publication date, which moves late-December orders into the next year.
- Counts by year: `document_counts` with `facet=yearly` uses publication date. 1994 is a partial year
  (the database starts in 1994). `key` is the period start date; `name` is the label.
- Corrections: `documents` leaves correction notices out by default (`conditions[correction]=0`; `1` gives
  only corrections), but `document_counts` counts them unless you pass `conditions[correction]=0`. OFR's
  own statistics (federalregister.gov/reader-aids/federal-register-statistics: documents and pages by
  category and year; read it in a browser, scripted requests are redirected) count corrections within each
  type: compare with those totals with corrections in. A year's page count is its highest `end_page`;
  blank pages are not in the API, so OFR's TOTAL can be a page or two higher. Executive orders are counted by `executive_order_number`; a few presidential
  documents of other kinds carry no number.
- `significant` comes from the Unified Agenda's EO 12866 flag and is missing for many older rules and
  for notices: a missing value does not mean "not significant".
- Agency filters take slugs (`environmental-protection-agency`), not acronyms. Sub-agencies have their
  own slugs (`federal-aviation-administration`); a document matches every agency it lists, and
  sub-agency documents usually list the parent department too. Get slugs from `agencies`.
- `agency_names` is a "; "-joined list; a document can have several agencies, so counts by agency add
  up to more than the document count.
- Text values are as published: `abstract` can be empty; `type` is a label ("Rule", "Proposed Rule",
  "Notice", "Presidential Document") while the filter takes the code (RULE, PRORULE, NOTICE, PRESDOCU).
- Public inspection documents are not yet published; their numbers and dates can change and some are
  withdrawn before publication.

## Access
No key. Route `api` when www.federalregister.gov answers (no documented rate limit; the pack sends at most
2 requests a second). Manual route: INSTRUCTIONS.md lists one JSON link per 1,000 documents; open each,
save it under the given name, and upload. A link with `/documents.csv` instead of `/documents.json`
returns CSV for the same query (fewer columns). The search page https://www.federalregister.gov/documents/search
offers the same filters and CSV or JSON export under the results.

## Citation and terms
"Office of the Federal Register (NARA), Federal Register API, <query>, federalregister.gov, retrieved
<date>." Public domain; redistribution allowed. Required notice: federalregister.gov is not the official
legal edition; the official edition (PDF) is on govinfo.gov, linked in `pdf_url`.
