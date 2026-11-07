# CMS Open Payments (openpaymentsdata.cms.gov)
Depth: standard. Key: none. Payments and other transfers of value from drug and device manufacturers and
group purchasing organizations to physicians, non-physician practitioners and teaching hospitals
(the Sunshine Act data), program years 2019-2025, plus CMS's summary tables.

## When to use
- Payments to a named physician (NPI), hospital, or the recipients in a state or city; payments by a
  company; totals by state, specialty, company or nature of payment (food, consulting, royalties).
- Research payments and physician ownership or investment interests (separate datasets).
- Not here: Medicare payments to providers for care (cms), drug approvals, recalls and adverse events (fda),
  clinical trials (clinical-trials), NIH grants (nih), lobbying (senate-lobbying). Program years before 2019
  are not in this API (CMS archives them on its website).

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `query` | rows of one dataset (500 a page) | `dataset` (alias or UUID), `where`, `conditions`, `sort`, `columns` |

Catalog aliases (`--endpoints` lists all 35 with ids; `--search "teaching hospital"` also searches the live
metastore of 74 datasets):
- Payment-level files, one per program year 2019-2025: `general_<year>`, `research_<year>`,
  `ownership_<year>` (e.g. `general_2024`; about 91 columns; millions of rows a year, so a filter is
  required).
- Summaries (all years, a `program_year` column, plus `program_year` "ALL" rollup rows in some, e.g.
  `state_totals`: filter one year and never sum across ALL, verified 2026-10): `national_totals`, `national_by_specialty`,
  `state_totals`, `state_by_nature`, `by_reporting_entity`, `by_entity_and_nature`,
  `by_recipient_and_entity`, `by_recipient_and_nature`, `by_physician`, `by_teaching_hospital`,
  `summary_dashboard`; profiles: `recipient_profiles`, `entity_profiles`, `teaching_hospital_profiles`.

Useful payment-file columns: `covered_recipient_npi`, `covered_recipient_profile_id`,
`covered_recipient_type`, `covered_recipient_specialty_1`, `recipient_state`, `recipient_city`,
`applicable_manufacturer_or_applicable_gpo_making_payment_name` (the payer),
`submitting_applicable_manufacturer_or_applicable_gpo_name` (the filer, can differ),
`total_amount_of_payment_usdollars`, `date_of_payment`, `nature_of_payment_or_transfer_of_value`,
`form_of_payment_or_transfer_of_value`, `name_of_drug_or_biological_or_device_or_medical_supply_1`,
`dispute_status_for_publication`, `change_type`, `program_year`, `record_id`.

Filters: `where` `{"recipient_state": "VT"}` (equality; a list value means IN); `conditions`
`[{"property": ..., "value": "%pfizer%", "operator": "LIKE"}]` with `= <> < <= > >= LIKE IN "NOT IN"
BETWEEN CONTAINS "STARTS WITH"` (the last two from the host's OpenAPI at /api/1; verified 2026-10). LIKE is case-insensitive (verified); company names vary ("PFIZER INC.", "Pfizer Laboratories"),
so match with `%name%` and check the distinct names returned.

## Spec examples
```json
{"description": "Industry payments in Vermont by recipient type and payment type, 2024",
 "requests": [{"name": "vt_totals_2024", "endpoint": "query",
   "params": {"dataset": "state_totals", "where": {"state_code": "VT", "program_year": "2024"}}}]}
```
```json
{"description": "Pfizer general payments to Vermont recipients, 2024",
 "requests": [{"name": "vt_pfizer_2024", "endpoint": "query",
   "params": {"dataset": "general_2024", "where": {"recipient_state": "VT"},
              "conditions": [{"property": "applicable_manufacturer_or_applicable_gpo_making_payment_name",
                              "value": "%pfizer%", "operator": "LIKE"}],
              "columns": ["record_id", "covered_recipient_type", "recipient_city", "total_amount_of_payment_usdollars",
                          "date_of_payment", "nature_of_payment_or_transfer_of_value"]}}]}
```
```json
{"description": "All general payments to one physician, 2023 and 2024",
 "requests": [{"name": "npi_2023", "endpoint": "query", "params": {"dataset": "general_2023", "where": {"covered_recipient_npi": "1234567890"}}, "allow_empty": true},
              {"name": "npi_2024", "endpoint": "query", "params": {"dataset": "general_2024", "where": {"covered_recipient_npi": "1234567890"}}, "allow_empty": true}]}
```
(1234567890 is a placeholder that matches nothing; replace it with the real NPI, looked up in
`recipient_profiles` by name and state, and drop `allow_empty` so a wrong NPI fails loudly.)

## Data format and traps
- Every column is stored and returned as text, amounts included (`"16.38"`), and dates are MM/DD/YYYY
  text. So `sort` and `<`, `>`, `BETWEEN` compare characters: sorting amounts descending returns
  "995.27", "99.99", ... and `> 900` matches "91.06" (both verified). The pack refuses such comparisons
  (override with `"text_compare_ok": true`); filter by equality and rank or sum in `analysis.py`.
- A program year is the year of payment; files for a year are published the following June 30 and
  republished when CMS refreshes the data (all datasets were last modified 2026-06-30). Totals for recent
  years can change after a refresh: report the retrieval date.
- Records are self-reported by the paying companies. Recipients may dispute them
  (`dispute_status_for_publication`); some are delayed for product development
  (`delay_in_publication_indicator`). A payment does not imply wrongdoing or a conflict of interest; say so.
- `number_of_payments_included_in_total_amount` > 1 means one row bundles several payments; count rows
  as records, not as individual payments, unless you use that column.
- Non-physician practitioners (nurse practitioners, physician assistants, etc.) are covered recipients from
  program year 2021; physician-only trends must filter `covered_recipient_type`.
- The research and ownership files are not part of general-payment totals; summary tables split amounts by
  `payment_type` (General, Research) and recipient type. Do not add summary rows across both splits.
- Names are upper-case in payment files; city and company spellings vary. Prefer NPI or
  `covered_recipient_profile_id` to identify a person.
- `limit` is capped at 500 by this API (verified); the pack pages. Queries on the payment files take 2-5 s
  a page; sort makes them slower.
- Old dataset ids stop working when CMS republishes; summaries are addressed by alias here.

## Access
No key. Route `api` when openpaymentsdata.cms.gov answers (the host sits behind a bot filter that has
refused some user agents with HTTP 403; the pack's client is accepted). Manual route: INSTRUCTIONS.md lists
JSON links with the filters applied (500 rows each; save under the shown names and upload), or use the
site's search (by physician, hospital or company) and its export, then upload the file.

## Citation and terms
"Centers for Medicare & Medicaid Services, Open Payments: <dataset>, openpaymentsdata.cms.gov, retrieved
<date>." The datasets carry the licence https://www.usa.gov/government-works (public domain);
redistribution allowed. Reports must state that the records are reported by industry, published as
reported, and do not by themselves indicate wrongdoing (policy notice and audit hook).
