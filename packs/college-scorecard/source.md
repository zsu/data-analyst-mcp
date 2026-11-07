# College Scorecard (U.S. Department of Education)
Depth: standard. Key: optional (DATA_GOV_API_KEY; DEMO_KEY works for a few requests). Institution-level
cost, aid, debt, completion, earnings and admissions data for every U.S. college that takes federal aid.

## When to use
- Compare colleges on tuition, net price, admission rate, completion rate, median debt, Pell share and
  median earnings 6, 7 or 10 years after entry; list schools in a state, by ownership or by degree type.
- Not here: K-12 achievement (naep), enrollment and finance surveys beyond what Scorecard carries (IPEDS
  itself, not covered), student loan portfolio totals (fred, treasury), earnings by occupation (bls).
- One row per institution (UNITID). Field-of-study (program) data exist but are very large per school.

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `schools` | institutions, one row each, the chosen `fields` as dotted columns | filters on any field, `fields`, `sort` |

Filters: `school.state` (DE or DE,MD), `school.ownership` (1 public, 2 private nonprofit, 3 for-profit),
`school.degrees_awarded.predominant` (0-4: not classified, certificate, associate, bachelor's, graduate),
`school.name` (word search), `id` (UNITID, comma list), any field with `__range=lo..hi` (e.g.
`latest.admissions.admission_rate.overall__range=0..0.2`). Short aliases: `name`, `state`, `ownership`,
`predominant_degree` (also inside `sort`, with the catalog aliases: `name:asc`). `fields` takes a list or comma string of field names or catalog aliases:
`admission_rate`, `size`, `tuition_in_state`, `tuition_out_of_state`, `net_price`, `attendance_cost`,
`median_debt`, `pell_rate`, `loan_rate`, `completion_rate`, `retention_rate`, `earnings_6yr`,
`earnings_7yr` (live from October 2026), `earnings_10yr`, `default_rate_3yr`, `share_first_generation`,
demographics, `locale`, `hbcu`, `operating` (`--search "earnings"` lists them with the dotted names). Without `fields` the pack sends a
popular set of 16 fields. Year-specific values: replace `latest.` with a year (`2019.student.size`).

## Spec examples
```json
{"description": "Public bachelor's colleges in Delaware and Maryland, by 10-year earnings",
 "requests": [{"name": "de_md_public", "endpoint": "schools",
   "params": {"state": "DE,MD", "ownership": 1, "predominant_degree": 3,
              "sort": "latest.earnings.10_yrs_after_entry.median:desc"}}]}
```
```json
{"description": "Most selective colleges: admission rate under 10%",
 "requests": [{"name": "selective", "endpoint": "schools",
   "params": {"latest.admissions.admission_rate.overall__range": "0.001..0.1",
              "fields": ["name", "state", "admission_rate", "net_price", "earnings_10yr", "completion_rate"],
              "sort": "latest.admissions.admission_rate.overall:asc"}}]}
```
```json
{"description": "One school by UNITID",
 "requests": [{"name": "mit", "endpoint": "schools",
   "params": {"id": 166683, "fields": ["name", "admission_rate", "net_price", "earnings_10yr", "completion_rate"]}}]}
```

## Data format and traps
- Rates are shares 0-1 (admission rate 0.0455 = 4.55%); dollars are nominal per year. `latest.` means the
  most recent value the Department publishes for each measure; measures come from different years (cost
  and admissions are recent, earnings follow cohorts that entered about a decade earlier). Name the
  data year from the documentation when a year matters.
- Earnings, debt and net price cover only students who received federal (Title IV) aid; earnings are
  medians of those working and not enrolled. Schools with few aided students are suppressed: the API
  returns empty cells (the CSV files write `PrivacySuppressed`). Empty does not mean zero.
- An unknown field name is silently dropped (no error): check the CSV columns. Without `fields` the API
  returns about 3,000 fields per school, so the pack always sends a field list.
- `per_page` above 100 is silently cut to 100; the pack pages (100 a page, pages start at 0) up to
  `max_rows` (default 10,000; 6,278 institutions in October 2026). Do not set `page`/`per_page` yourself.
- The 6-, 7- and 10-year earnings measure different entry cohorts: the 7-year median is often below the
  6-year one for the same school (three large universities checked, 2026-10). Do not read the three as one
  cohort's earnings growth; compare schools on the same measure.
- Sorting puts schools with no value last (verified for a descending earnings sort).
- `admission_rate` is exactly 0 for a few schools (3 of the 40 under 0.1 in October 2026, small or
  specialized schools that enroll students): a reporting artifact, not the most selective, yet an ascending
  sort puts them first. Start selectivity ranges above zero (`__range=0.001..0.1`) and say zeros were left out.
- `__range` works only on the API's indexed columns; others answer HTTP 400 `unknown_column` (verified
  for 7-year earnings, 2026-10). Filter such fields in the analysis instead.
- Coded columns stay numeric; the pack adds `<column>_label` for ownership and degree codes.
- Name search matches words, so "Delaware" also finds "Delaware State" and "Delaware Technical"; use `id`
  once you know the school. Branch campuses have their own UNITIDs; some outcomes are reported only at the
  parent (OPEID) level.
- `latest.repayment.3_yr_repayment.overall` returns a count (5,295 for one university), not a rate: read
  the data dictionary before using repayment fields. Three-year default rates are near zero for recent
  cohorts because federal loan repayment was paused from 2020 to 2023.
- Field-of-study fields (`latest.programs.cip_4_digit`) return hundreds of nested records per school (1.8 to
  2.4 MB for one large university, 2026-10); request them for one `id` at a time. They arrive as JSON text
  in one cell.

## Access
Key optional: DATA_GOV_API_KEY (free at https://api.data.gov/signup/), sent as `api_key`; without one the
pack sends DEMO_KEY (api.data.gov: 30 requests an hour and 50 a day per IP address). A personal key allows 1,000
requests an hour. Route `api` when api.data.gov answers. Manual route: `manual_download/INSTRUCTIONS.md`
lists JSON page links with `api_key=DEMO_KEY` (one per 100 schools); open each, save under the name
shown, upload, then `--ingest`. Without the links: https://collegescorecard.ed.gov/data/ has the full
institution-level CSV (zip) and the data dictionary (xlsx); its variable names differ (UNITID, INSTNM,
MD_EARN_WNE_P10), so map them with the dictionary.

## Citation and terms
"U.S. Department of Education, College Scorecard, <data year / file>, api.data.gov/ed/collegescorecard,
retrieved <date>." Public domain (U.S. government work). Redistribution allowed. Say in the report that
earnings and debt cover federally aided students only (audit hook).
