# CMS Provider Data and Medicare data (data.cms.gov)
Depth: standard. Key: none. Care Compare provider datasets (hospitals, nursing homes, home health, hospice,
dialysis) and Medicare statistics from data.cms.gov's data-api (enrollment, geographic variation in
spending, Part B/D drug spending, inpatient and physician utilization).

## When to use
- Quality and characteristics of named providers: hospital star ratings, mortality, readmissions,
  infections, HCAHPS; nursing home ratings, staffing, deficiencies; home health, hospice, dialysis.
- Medicare totals by place and year: beneficiaries (Original Medicare vs Medicare Advantage), FFS spending
  per capita, drug spending by drug, DRG discharges and payments, opioid prescribing rates.
- Not here: Medicaid and CHIP enrollment, spending and drug data (medicaid), Medicare Trustees Report
  projections and national health expenditures (actuaries), industry payments to doctors
  (open-payments), drug safety and recalls (fda), health insurance coverage rates (census ACS), deaths and
  disease rates (cdc). Medicare claims microdata (LDS/RIF files) need a CMS data use agreement: not covered.

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `provider` | rows of one Provider Data dataset (500 a page) | `dataset` (alias or id like `xubh-q36u`), `where`, `conditions`, `sort`, `columns` |
| `medicare` | rows of one data-api dataset (5,000 a page) | `dataset` (alias or UUID), `where`, `keyword`, `columns`, `sort` |

Provider aliases (`--endpoints` lists all; `--search "dialysis"` also searches the live catalog of 237
Provider Data datasets and returns their ids): `hospital_info`, `hospital_mortality`,
`hospital_readmissions`, `hospital_infections`, `hospital_timely_care`, `hospital_spending`,
`hospital_patient_survey`, `nursing_home_info`, `nursing_home_deficiencies`, `nursing_home_quality`,
`home_health_info`, `hospice_info`, `dialysis_info`.

Medicare aliases: `monthly_enrollment` (2013-present, monthly plus `MONTH = "Year"` rows), `geo_variation`
(2014-2024, national/state/county), `ma_geo_variation`, `partd_spending_by_drug` and
`partb_spending_by_drug` (wide: one column set per year, e.g. `Tot_Spndng_2020` ... `Tot_Spndng_2024`),
`partd_opioid_geo` (2013-), `inpatient_geo_2024`, `inpatient_provider_2024`, `physician_geo_2024`,
`partd_prescribers_geo_2024`, `market_saturation_county`. The `_2024` datasets hold one data year each;
other years are separate data.cms.gov datasets with their own UUIDs (find them on the dataset page's
"API" panel or in https://data.cms.gov/data.json) and work in `dataset` directly.

Filters:
- `where`: `{"column": "value"}` equality; a list value means IN (both endpoints; matching ignores case on the
  data-api). Rows outside the filter values fail the fetch rather than pass silently. Provider column names are snake_case
  (`state`, `citytown`, `facility_id`); data-api names are as published (`BENE_GEO_LVL`, `Brnd_Name`).
- `conditions` (provider only): `[{"property": "facility_name", "value": "%MAYO%", "operator": "LIKE"}]`;
  operators `= <> < <= > >= LIKE IN "NOT IN" BETWEEN`. LIKE matching is case-insensitive.
- `sort`: `"facility_id"` or `"-hospital_overall_rating"`; `columns`: a list of column names. Column names
  differ by dataset (the id column is not `facility_id` in every dataset): a name the dataset lacks answers
  HTTP 400 "Column not found", and the pack then names the unknown column(s) and lists the dataset's columns.

## Spec examples
```json
{"description": "Vermont hospitals: overall star rating",
 "requests": [{"name": "vt_hospitals", "endpoint": "provider",
   "params": {"dataset": "hospital_info", "where": {"state": "VT"},
              "columns": ["facility_id", "facility_name", "citytown", "hospital_type", "hospital_overall_rating"],
              "sort": "facility_id"}}]}
```
```json
{"description": "Medicare FFS standardized spending per capita by state, 2024",
 "requests": [{"name": "ffs_spending_2024", "endpoint": "medicare",
   "params": {"dataset": "geo_variation", "where": {"YEAR": "2024", "BENE_GEO_LVL": "State", "BENE_AGE_LVL": "All"},
              "columns": ["YEAR", "BENE_GEO_DESC", "BENES_OM_CNT", "TOT_MDCR_STDZD_PYMT_PC", "TOT_MDCR_PYMT_PC"]}}]}
```
```json
{"description": "Medicare enrollment, United States, annual",
 "requests": [{"name": "enroll_us", "endpoint": "medicare",
   "params": {"dataset": "monthly_enrollment", "where": {"BENE_GEO_LVL": "National", "MONTH": "Year"},
              "columns": ["YEAR", "TOT_BENES", "ORGNL_MDCR_BENES", "MA_AND_OTH_BENES"]}}]}
```
To see a dataset's columns, fetch with `"max_rows": 5` and no `columns`, then read `data_dictionary.csv`.

## Data format and traps
- Every value is text, as published: numbers, `"Not Available"` (provider ratings), footnote codes in
  `*_footnote` columns. Convert in `analysis.py`; treat "Not Available" and footnoted cells as missing,
  never as zero.
- Provider Data columns are stored as text, so `sort` and `<`/`>`/`BETWEEN` compare characters, not
  numbers or dates (`"-hospital_overall_rating"` puts "Not Available" first; `"91.06" > "900"`). The pack
  refuses comparisons against numbers or MM/DD/YYYY dates (set `"text_compare_ok": true` on a condition to
  override); fetch with equality filters and rank in `analysis.py`.
- data-api silently ignores a filter on a column that does not exist and drops unknown `columns` names
  (verified). The pack therefore always returns the filter columns and fails the request if a filter or
  requested column is absent, rather than hand back an unfiltered table. Names are case-sensitive.
- Provider Data measures cover rolling reporting windows that differ by measure (`start_date`,
  `end_date` columns); the star rating is recalculated periodically. Report the window, not "2026".
- Geographic Variation, inpatient and physician datasets cover fee-for-service (Original Medicare)
  beneficiaries only; Medicare Advantage enrollees are excluded. Compare places with standardized amounts
  (`*_STDZD_*`), which remove geographic price adjustments; actual amounts include them.
- Rates in data-api tables are fractions (`MA_PRTCPTN_RATE = 0.3213` is 32.13%).
- Geography codes differ: `geo_variation` uses postal codes in `BENE_GEO_DESC` for states ("AK");
  `monthly_enrollment` has `BENE_STATE_ABRVTN` and `BENE_STATE_DESC`; provider data use `state` = "VT".
  County FIPS fields may be padded with spaces. Use `combine.state()` to align.
- Small cells are suppressed under CMS's cell-size rule (counts under 11). data-api datasets publish a
  suppressed cell as the text "*" (verified in `monthly_enrollment` and `geo_variation`, 2026-10-22); the pack
  writes an empty cell plus a `<column>_flag` column reading "suppressed (*)". Treat them as missing, never as
  zero. Other datasets leave the value blank and say why in a flag column (`partd_prescribers_geo_2024`:
  `GE65_Sprsn_Flag` "*" or "#"): flag columns keep their text. A descending data-api `sort` on a numeric column
  puts the "*" rows first (numbers themselves sort numerically): take the top N in `analysis.py` after
  dropping suppressed rows, not with `sort` plus `max_rows`.
- Part B/D spending by drug is wide (columns per year) and has `Mftr_Name = "Overall"` summary rows plus
  one row per manufacturer: filter to "Overall" before summing, or totals double.
- Provider Data API: `limit` is capped at 1,500 by the API; the pack pages 500 rows at a time. The service
  is slow (15-50 s a page observed) and answers intermittent HTTP 503; the client retries.
- `/datastore/query/{distribution_id}/0` returns 404; the pack uses `/datastore/query/{dataset_id}/0` (index 0 = the dataset's only CSV distribution).

## Access
No key. Route `api` when data.cms.gov answers. Manual route: INSTRUCTIONS.md lists one JSON link per page
with the filters already applied (open in a browser, save under the shown name, upload). Alternatively,
open the dataset page (`https://data.cms.gov/provider-data/dataset/<id>`, or the Medicare dataset's page
from `--endpoints`), click Download for the full CSV and upload it; the CSV uses display-style column
names ("Facility ID"), so say which columns to use.

## Citation and terms
"Centers for Medicare & Medicaid Services, <dataset name>, data.cms.gov, retrieved <date>." U.S.
government work in the public domain (data.cms.gov terms of use); redistribution allowed. Cite CMS, the
dataset, and the reporting period.
