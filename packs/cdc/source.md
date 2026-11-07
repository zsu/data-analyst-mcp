# CDC Open Data (data.cdc.gov)
Depth: standard. Key: none. U.S. health statistics published on CDC's Socrata portal: causes of death, life
expectancy, mortality and birth indicators, overdose deaths, PLACES county and city health measures.

## When to use
- Deaths by cause, state and year; overdose deaths; life expectancy; provisional weekly deaths; PLACES
  (BRFSS-model) county and city indicators such as obesity, diabetes, smoking; disability prevalence.
- Not here: health insurance coverage (census ACS), Medicare and Medicaid providers (cms), drug approvals
  and recalls (fda), clinical trials (clinical-trials), NIH grants (nih).

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `query` | JSON rows of one dataset | `dataset` (alias or id), `$select`, `$where`, `$group`, `$order`, `$q` |
| `csv` | the same as CSV (manual route) | same |

Catalog aliases (`fetch.py --source cdc --endpoints` lists all 17; `--search "overdose"` finds one):
`leading_death` (bi63-dtpu, 1999-2017), `life_expectancy` (w9j2-ggv5, 1900-2018), `mortality_rates`
(489q-934x, quarterly, rolling: only about the last three years, 2023 Q1-2025 Q3 when verified 2026-10;
wide, one `rate_<state>` column per state, so filter by `cause_of_death`, not by state),
`life_expectancy_state` (it4f-frdc, 2021 only), `places_county` (swc5-untb) and `places_city` (eav7-hnsx: cities,
towns and CDPs), both the latest PLACES release in long format (one row per location and `measureid`, value in
`data_value`, `year` per measure; each measure has a crude and an age-adjusted row: filter `datavaluetypeid`
`CrdPrv` or `AgeAdjPrv`), `cities_500_2019` (dxpw-cm5u, the older 500 Cities file: 2016-2017 estimates,
500 large cities, wide columns such as `obesity_crudeprev`; not current), `weekly_deaths`
(r8kw-7aab, see the `group` trap), `drug_overdose_provisional` (xkb8-kh2a, monthly 12-month-ending counts), `birth_indicators`
(76vv-a7x8). Any other data.cdc.gov dataset works by its 4x4 id.

## Spec examples
```json
{"description": "Leading causes of death, New York, 2017",
 "requests": [{"name": "ny_causes_2017", "endpoint": "query",
   "params": {"dataset": "leading_death", "$where": "state = 'New York' AND year = '2017'", "$order": "deaths DESC"}}]}
```
```json
{"description": "Provisional overdose deaths, United States, 12-month ending",
 "requests": [{"name": "od_us", "endpoint": "query",
   "params": {"dataset": "drug_overdose_provisional", "$where": "state = 'US' AND indicator = 'Number of Drug Overdose Deaths'"},
   "max_rows": 20000}]}
```
Look at a dataset's columns before filtering: fetch one row (`"$limit"` is set by paging, so use a
narrow `$where`), or open the dataset page.

## Data format and traps
- Every value arrives as text. Numbers keep their published form; convert in `analysis.py`.
- Column names differ per dataset (`deaths`, `data_value`, `predicted_value`). Read `data_dictionary.csv`.
- State is written differently by dataset: full names ("New York") in leading causes of death,
  postal codes ("NY") in PLACES and COVID tables, "US" for the nation in VSRR. Use `combine.state()`.
- SoQL text values need single quotes, and matching is case-sensitive. A filter that matches nothing makes
  the fetch fail with "returned no rows": check the values first.
- Provisional data (weekly deaths, VSRR overdose, quarterly mortality) are revised for months and may be
  incomplete for recent periods; report the data date. Small counts are suppressed in several tables.
- Leading causes of death ends in 2017 and life expectancy in 2018 on this portal; newer years are in CDC
  WONDER (not covered here). Say so instead of mixing sources silently.
- Paging uses `$limit`/`$offset` with a stable `$order` (default `:id`); without a key Socrata throttles
  heavy use (about 1,000 requests an hour). A `$group` query fails with the default order ("Column ':id'
  is not in group by"): give it an explicit `$order` on a selected or grouped column.
- Mixed granularity: `weekly_deaths` (r8kw-7aab) stacks By Week, By Month, By Year and By Total rows in the
  column `group`; summing without a filter counts each death several times. `group` is a SoQL reserved
  word: write it with backticks, `` "$where": "`group` = 'By Week' AND state = 'Ohio'" `` (unquoted it
  fails to parse). Its `state` column holds "United States" (excludes Puerto Rico) and "New York City"
  apart from "New York" (the rest of the state): never add states to the national row. Before summing any
  dataset, check for a column like this that mixes levels or totals.

## Access
No key. Route `api` when data.cdc.gov answers. Manual route: each request gets CSV links (one per 50,000
rows) in `manual_download/INSTRUCTIONS.md`; or open `https://data.cdc.gov/d/<id>`, Export > CSV, upload.

## Citation and terms
"Centers for Disease Control and Prevention, <dataset name>, data.cdc.gov, retrieved <date>." Public
domain; attribute CDC and do not imply endorsement. Redistribution allowed.
