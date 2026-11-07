# Medicaid and CHIP open data (data.medicaid.gov)
Depth: standard. Key: none. CMS's Medicaid and CHIP datasets: monthly enrollment by state, expansion (new adult
group) enrollment, renewals, managed care, CMS-64 expenditure extracts, State Drug Utilization Data and NADAC drug
prices.

## When to use
- National or state Medicaid and CHIP enrollment (the monthly enrollment report numbers), ACA expansion adults,
  unwinding-era renewals and disenrollments, managed care penetration, the federal share of expansion and
  FFCRA/CAA 2023 increased-FMAP spending by quarter, Medicaid outpatient drug spending by drug and state, and
  pharmacy acquisition costs (NADAC).
- Not here: Medicare, hospitals and nursing homes (cms); national health expenditure accounts and Medicaid
  outlays in the federal budget (treasury, usaspending); Medicaid coverage rates from surveys (census ACS/CPS).
  Current CMS-64 expenditure reports (fiscal years after 2016) are not in this API: see Access.

## Endpoints and datasets
Base `https://data.medicaid.gov`, DKAN, keyless, JSON (verified live 2026-10-30). One CSV per request.

| Endpoint | Returns | Key parameters |
|---|---|---|
| `query` | rows of one dataset (`/api/1/datastore/query/{dataset}/0`), 5,000 per page, all pages | `dataset` (alias or id), `conditions[i][property]`, `conditions[i][value]`, `conditions[i][operator]` (i = 0-3), `conditions[0][value][0..9]` (a list for `in`), `sorts[i][property]` and `sorts[i][order]` (i = 0-1), `properties[0..11]` (columns to return) |
| `datasets` | the whole catalog, one row per dataset (about 560): `identifier`, `title`, `modified`, `theme`, `distribution` | none |
| `dataset_info` | one dataset's metadata: `modified`, `description`, download URL, data dictionary link | `dataset` |

Catalog aliases (`--search <words>` lists them with descriptions; `datasets` lists every id):

| Alias | Dataset | Grain, coverage |
|---|---|---|
| `enrollment` | Applications, Eligibility Determinations, and Enrollment (Performance Indicator) | state x month, 2013-09 to latest (202607 on 2026-10-30) |
| `eligibility_processing`, `renewal_outcomes_updated` | renewals, ex parte, procedural disenrollment | state x month, 2023-03 on |
| `chip_enrollment`, `chip_enrollment_historic` | separate CHIP enrollment (T-MSIS) | state x coverage month, 2023-04 on; lags (latest 202603, T-MSIS data through 202606, on 2026-10-30) |
| `new_adult` | Medicaid and expansion (VIII group) enrollees | state x month |
| `eligibility_group_monthly`, `managed_care_monthly` | T-MSIS (TAF) enrollees by eligibility group or managed care type, with a data-quality flag `dunusable` | state x month, 2016 on |
| `managed_care_summary`, `managed_care_share`, `managed_care_plans`, `managed_care_population`, `mltss` | managed care enrollment (as of July 1) | state (or plan) x year, 2016 on |
| `cms64_new_adult`, `cms64_ffcra`, `cms64_caa2023` | quarterly CMS-64 expenditures, total computable and federal share | state x quarter (`quarter_end_date`) |
| `cms64_fmr`, `cms64_fmr_national` | CMS-64 Financial Management Report by service category | fiscal year 2016 ONLY |
| `sdud_2020` ... `sdud_2026` | State Drug Utilization Data | state x NDC x quarter x utilization type; 1.3 million rows a year |
| `nadac_2024`, `nadac_2025`, `nadac_2026`, `nadac_comparison`, `nadac_first_time` | NADAC per unit, weekly | NDC x effective date; 1.3 million rows a year |
| `eligibility_levels` | income limits as % of poverty | state; 2018, not updated |

Columns of `enrollment` (snake_case, as in the rows): `state_abbreviation`, `state_name`, `reporting_period`
(YYYYMM, int), `state_expanded_medicaid` (Y/N), `preliminary_or_updated` (P/U), `final_report` (Y/N),
`total_medicaid_and_chip_enrollment`, `total_medicaid_enrollment`, `total_chip_enrollment`,
`medicaid_and_chip_child_enrollment`, `total_adult_medicaid_enrollment`, `new_applications_submitted_to_medicaid_and_chip_agencies`,
`total_medicaid_and_chip_determinations`, call-center columns, each with a `..__footnotes` text column. To see any
dataset's columns and types, fetch one row with `"max_rows": 1`, or open `https://data.medicaid.gov/api/1/datastore/query/<id>/0?limit=1&schema=true`.

## Spec examples
```json
{"description": "Medicaid and CHIP enrollment by state, July 2026 (latest, preliminary)",
 "requests": [{"name": "enroll_202607", "endpoint": "query",
  "params": {"dataset": "enrollment", "conditions[0][property]": "reporting_period", "conditions[0][value]": "202607",
             "properties[0]": "state_abbreviation", "properties[1]": "reporting_period", "properties[2]": "preliminary_or_updated",
             "properties[3]": "total_medicaid_and_chip_enrollment", "properties[4]": "total_medicaid_enrollment",
             "properties[5]": "total_chip_enrollment", "properties[6]": "total_medicaid_and_chip_enrollment__footnotes"}}]}
```
```json
{"description": "Vermont and New Hampshire, updated reports since January 2026, newest first",
 "requests": [{"name": "vt_nh", "endpoint": "query",
  "params": {"dataset": "enrollment",
             "conditions[0][property]": "state_abbreviation", "conditions[0][operator]": "in",
             "conditions[0][value][0]": "VT", "conditions[0][value][1]": "NH",
             "conditions[1][property]": "reporting_period", "conditions[1][operator]": ">=", "conditions[1][value]": "202601",
             "conditions[2][property]": "preliminary_or_updated", "conditions[2][value]": "U",
             "sorts[0][property]": "reporting_period", "sorts[0][order]": "desc"}}]}
```
```json
{"description": "Trulicity, national totals (state XX), 2025 Q4; Vermont expansion spending by quarter",
 "requests": [
  {"name": "trulicity", "endpoint": "query",
   "params": {"dataset": "sdud_2025", "conditions[0][property]": "state", "conditions[0][value]": "XX",
              "conditions[1][property]": "product_name", "conditions[1][operator]": "like", "conditions[1][value]": "TRULICITY%",
              "conditions[2][property]": "quarter", "conditions[2][value]": "4"}},
  {"name": "vt_expansion", "endpoint": "query",
   "params": {"dataset": "cms64_new_adult", "conditions[0][property]": "state", "conditions[0][value]": "Vermont"}}]}
```
The bracketed names are plain query keys, sent as written (URL-encoded). Number the conditions from 0 with no gap.

## Data format and traps
- Enrollment is a point-in-time monthly count, not people ever enrolled in the month or year. Footnote columns
  say when a state reports differently, e.g. "Includes Individuals Enrolled At Any Time in Month (Not a
  Point-in-Time Count)" (MT, OH, WV in 2026-07) or "Includes Retroactive Enrollments" (HI, NH). Carry footnotes
  into the answer when a state is singled out.
- Every state-month has TWO rows, preliminary (`P`, `final_report` N) and updated (`U`, `final_report` Y), except
  the latest month, which has only P. Summing a month without filtering on `preliminary_or_updated` doubles it.
  The monthly enrollment report's national total is the sum of the 51 rows (50 states and DC; no national row) of
  one month and one type: 2026-07 P = 72,946,510 total, 65,742,057 Medicaid, 7,204,453 CHIP (matches the
  Medicaid.gov report highlights, verified 2026-10-30). Updated counts run higher than preliminary (2025-06:
  78,223,314 U vs 77,776,382 P). For a time series use U rows and add the latest P month, labeled preliminary.
- `total_medicaid_and_chip_enrollment` includes CHIP: Medicaid only is `total_medicaid_enrollment`. CHIP in
  `enrollment` is all CHIP; `chip_enrollment` is separate CHIP only, from T-MSIS, so it is much smaller (Alabama
  2023-04: 205,859 in `enrollment` vs 70,995 separate CHIP): never mix the two. Adult and child columns are blank
  for some states and months; do not sum them to a national total without checking for blanks.
- Columns are typed per dataset: `reporting_period`, enrollment counts and SDUD numbers are int/numeric, so
  `<`, `>=`, `between` and sorts are numeric there. Many other datasets store numbers as text (CMS-64,
  managed care, `new_adult`, NADAC comparison): `<`/`>` and sorts on them compare characters ('91' > '100'),
  and values carry thousands separators ("374,032,607", sometimes with a trailing space), `N/A`, `n/a` or `--`
  (not applicable or not reported). Fetch with equality filters and convert in analysis; never compare such
  columns in a condition.
- Filters match without case ("vermont" finds Vermont). `in` needs `conditions[0][value][0]`, `[1]`, ...: one
  value "VT,NH" matches nothing and comes back as no rows. A column that does not exist answers HTTP 400
  "Column not found." without naming it: check spelling against one fetched row.
- Managed care tables use state names with footnote digits glued on ("Arkansas6") and a `TOTALS` row; filter with
  `like` ("Arkansas%") or clean names in analysis. Their counts are as of July 1 of `year`, and some states report
  other dates (see `notes`).
- CMS-64: `cms64_fmr` and `cms64_fmr_national` hold fiscal year 2016 only (every row's `year` is 2016, verified
  2026-10-30); never present them as current. Federal fiscal years run October-September; the quarterly datasets
  give `quarter_end_date` (2014-03-31 is FY2014 Q2). Total computable = federal share + state share; the federal
  share depends on the FMAP, the 90% expansion match (`newly_eligible`) and temporary increases (FFCRA 6.2 points
  from January 2020, phased down by CAA 2023 through December 2023). CMS-64 amounts are dates of payment, net of adjustments for
  prior periods, so a quarter can be negative or lumpy.
- SDUD: state `XX` is the national total; `utilization_type` FFSU (fee-for-service) and MCOU (managed care) are
  separate rows (add them for a state total). Cells with fewer than 11 prescriptions are suppressed:
  `suppression_used` true and empty counts and dollars, so sums are lower bounds. `product_name` is cut to 10
  characters and padded with spaces ("TRULICITY "): filter with `like` and %. `units_reimbursed` is in the drug's
  own units (tablets, mL, each), not prescriptions. `total_amount_reimbursed` is before manufacturer rebates
  (Medicaid's net cost is lower; rebates are confidential). The latest quarters are revised for months.
- NADAC: dollars per `pricing_unit` (EA, ML, GM), one row per NDC per weekly `as_of_date`; the value applies from
  `effective_date`. The yearly datasets are 1.3 million rows: always filter by `ndc` or `ndc_description` (`like`).
- Paging: 5,000 rows a page, offset paging until `count`; the API refuses a page over 8,000. A whole SDUD or NADAC
  year is over a million rows: filter, or the fetch stops at `max_rows` (and says so).

## Access
No key; data.medicaid.gov answers scripts (verified 2026-10-30). Limit used: two requests per second. Route `api`.
Manual: the links in `manual_download/INSTRUCTIONS.md` are the same queries as JSON pages of up to 8,000 rows
(save each, upload with --ingest); or the dataset page `https://data.medicaid.gov/dataset/<id>` (Download = full
CSV with display-style column names; upload it as CSV), or `https://data.medicaid.gov/api/1/datastore/query/<id>/0/download?format=csv`
(full CSV; takes the same `conditions[...]` filters).
Current CMS-64 Financial Management Reports (FY 1997-2024, zip files of Excel workbooks) are only on
https://www.medicaid.gov/medicaid/financial-management/state-expenditure-reporting-for-medicaid-chip/expenditure-reports-mbescbes,
which answers HTTP 403 to scripts: the user downloads them in a browser and the assistant reads the uploaded
workbook. The monthly enrollment report PDFs and highlights are on www.medicaid.gov too (browser only).

## Citation and terms
Centers for Medicare & Medicaid Services, <dataset name>, data.medicaid.gov, retrieved <date>. Public domain
(U.S. Public Domain label on every dataset; 17 U.S.C. 105): redistribution allowed. Name the dataset and say
whether enrollment counts are preliminary or updated.
