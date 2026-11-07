# USAspending.gov API (federal awards and spending)
Depth: standard. Key: none. Federal contracts, grants, loans, direct payments and other assistance from
FY2008 (searches start 2007-10-01): who received the money, where, from which agency, over time; plus
agency budgetary resources, obligations and outlays.

## When to use
- Top recipients or contractors, spending by awarding agency, program (CFDA/assistance listing), NAICS,
  PSC, state, county or congressional district; trends by fiscal year, quarter or month; award search by
  keyword; one award in detail; an agency's budgetary resources and outlays by year.
- Federal dollars per state (by_geography gives per capita; for per capita with current population use
  census).
- Not here: Treasury receipts, outlays by budget function, debt and the Monthly Treasury Statement
  (treasury), budget proposals and projections, federal employment and pay (opm),
  lobbying (senate-lobbying), campaign money (fec), regulations (federal-register).

## Endpoints and datasets
| Endpoint | Method | Returns | Key parameters |
|---|---|---|---|
| `by_category` | POST | obligations by `category` (awarding_agency, awarding_subagency, funding_agency, recipient, cfda, naics, psc, state_territory, county, district, country, federal_account, defc) | filters below |
| `over_time` | POST | obligations per fiscal year / quarter / month with contract, grant, loan, direct, other splits | `group`, filters |
| `by_geography` | POST | obligations per state, county or district, with population and per capita | `scope`, `geo_layer`, `geo_layer_filters`, filters |
| `awards` | POST | prime awards (one award type group per request) | `award_type` (required), filters, `fields`, `sort`, `order` |
| `award_count` | POST | award counts per type group (one row) | filters |
| `agency` | GET | agency overview | `toptier_code`, `fiscal_year` |
| `agency_budgetary_resources` | GET | budgetary resources, obligated, outlayed by fiscal year | `toptier_code` |
| `toptier_agencies` | GET | every toptier agency: code, abbreviation, current-year amounts | `sort`, `order` |
| `recipient_state` | GET | prime award totals for one state | `state` or `fips`, `year` |
| `award` | GET | one award in detail | `award_id` (generated_internal_id) |

Filter conveniences for every POST endpoint (the pack builds the API's `filters` object; a raw `filters`
object is merged over them): `fiscal_year` (2024 or [2020, 2024]), or `start_date`/`end_date`;
`award_type` (group or codes); `keyword`; `state` (place of performance; MD, 24 or Maryland);
`agency` / `funding_agency` (toptier code, alias, or name); `recipient`.
Award type groups: contracts A B C D; idvs IDV_*; grants 02-05, F001-F002; loans 07 08 F003 F004;
direct_payments 06 10 F006 F007; other_financial_assistance 09 11 -1 F005 F008-F010 (insurance 09 F005).
Agency aliases come from the live reference list (`--search "energy"`): treas 020, hhs 075, dod 097,
ssa 028, va 036, usda 012, opm 024, hud 086, dot 069, ed 091, doe 089, doi 014, dos 019, dol 1601,
doj 015, doc 013, nasa 080, epa 068, sba 073, nsf 049, dhs 070, gsa 047.

## Spec examples
```json
{"description": "Federal obligations in Maryland by awarding agency, FY2024",
 "requests": [{"name": "md_by_agency_fy2024", "endpoint": "by_category",
   "params": {"category": "awarding_agency", "fiscal_year": 2024, "state": "Maryland"}, "max_rows": 25},
  {"name": "nasa_monthly_fy2024", "endpoint": "over_time",
   "params": {"group": "month", "fiscal_year": 2024, "agency": "nasa"}}]}
```
```json
{"description": "Top 100 DoD contract recipients FY2023 and HHS budgetary resources by year",
 "requests": [{"name": "dod_top_recipients", "endpoint": "by_category",
   "params": {"category": "recipient", "fiscal_year": 2023, "agency": "dod", "award_type": "contracts"}, "max_rows": 100},
  {"name": "hhs_budget", "endpoint": "agency_budgetary_resources", "params": {"toptier_code": "hhs"}}]}
```
```json
{"description": "Broadband grants active in FY2024, largest first",
 "requests": [{"name": "broadband_grants", "endpoint": "awards",
   "params": {"award_type": "grants", "fiscal_year": 2024, "keyword": "broadband"}, "max_rows": 200}]}
```

## Data format and traps
- Periods are federal fiscal years: FY2024 = 2023-10-01 to 2024-09-30. `over_time` returns
  `time_period.fiscal_year` and fiscal `month` (1 = October) or `quarter` (1 = Oct-Dec); the pack adds
  `fiscal_period` (FY2024 M01) and `period_start` (2023-10). Calendar years need group=month and
  `combine` helpers; never relabel fiscal years as calendar years.
- Floor: searches refuse dates before 2007-10-01 (FY2008); the pack stops such specs before calling.
  Older awards are only in the website's bulk downloads.
- by_category, over_time and by_geography sum transaction obligations whose action date is in the
  period (`spending_level` "transactions"): new obligations, including negative de-obligations, so a
  category can be negative. `awards` lists awards with activity in the period, but `Award Amount` is
  the award's total obligation over its life (and `Loan Value` the face value for loans), not the
  period's spending: do not sum it as yearly spending.
- Obligations are commitments; outlays are cash paid. Search outlay columns (`total_outlays`) are often
  empty; agency outlays are in `agency_budgetary_resources` (`agency_total_outlayed`). The current
  fiscal year is partial (cumulative through the latest reported period); its next year appears as a
  row of nulls.
- Award searches take codes from ONE award type group (HTTP 422 otherwise); the pack checks this.
  Loans are face value (not subsidy cost); direct payments include Social Security and Medicare
  benefits, which dominate state totals.
- Place of performance vs recipient location differ (headquarters effects: SSA benefits are
  administered from Maryland). Say which `scope` was used. Spending in "multiple states" or foreign
  locations is not in state tables.
- `recipient_state` population and median income come from old Census vintages (2017 estimate, 2016
  ACS in the response); use census for current per-capita denominators. `by_geography` per capita
  uses the population the API ships (2020 Census for states).
- Recipient names are as reported (upper case, variants); parent companies are not rolled up in
  `recipient` category results. Keyword search matches award descriptions and other text fields.
- Data are updated nightly and awards are revised; record the retrieval date. Paging: `page`/`limit`
  in the JSON body (100 per page; `page_metadata.hasNext`); max_rows stops the pack.
- Amounts are nominal dollars. Errors are reported, never swallowed: a 4xx/5xx stops the fetch with
  the API's message (unknown agency codes give HTTP 404).

## Access
No key. Route `api` when api.usaspending.gov answers (search calls can take 10-60 seconds). Manual
route: the search endpoints are POST requests, so a browser cannot open them: run `download_data.sh`
or `download_data.ps1` from the bundle with one command (no Python needed), upload the JSON files, then
`--ingest`. GET items open in a browser. Website alternative: https://www.usaspending.gov/search, set
the time period as fiscal years and the other filters, then Download (award or transaction CSV) or the
results table of a breakdown; upload the CSV and say which view it is.

## Citation and terms
"U.S. Department of the Treasury, USAspending.gov, <view> (<filters, fiscal years>), retrieved <date>."
Public domain (DATA Act data published by Treasury); redistribution allowed. Agency-reported data:
quality varies by agency and recent months are incomplete.
