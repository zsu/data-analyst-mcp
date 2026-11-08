# Census Bureau Data API (ACS, decennial census, population estimates, ACS PUMS, CPS and SIPP microdata, economic indicators, trade, government finances)
Depth: standard. Key: required (CENSUS_API_KEY). American Community Survey 1-year and 5-year estimates,
2020 and 2010 decennial census counts, population estimates, County Business Patterns and the Economic
Census, for the nation, states, counties, places, tracts and ZIP code areas; person microdata: ACS PUMS (with
replicate weights), CPS basic monthly and ASEC, SIPP person-months;
time series of monthly economic indicators, imports and exports by commodity, and state and local government
taxes, finances and pensions; quarterly homeownership and vacancy rates (HVS); the experimental Household Pulse
Survey (2020-2024).

## When to use
- Population, age, race and Hispanic origin, household income, per capita income, poverty, home values,
  rents, tenure, education, health insurance, commuting, language, for any U.S. geography; state or
  county profiles; population denominators for per-capita figures (federal spending, deaths, energy use).
- Custom tabulations the published tables do not give, from recent person microdata (Census codes, weighted
  by the pack's added weights): ACS PUMS (`acs1_pums`, `acs5_pums`; 2004 on, states and PUMAs, standard errors
  from PWGTP1-80), one CPS basic month (`<YYYY>/cps/basic/<mon>`, 1989 on: labor force, hours, weekly earnings)
  or one CPS ASEC year (`cps_asec`, 1992 on: income, poverty, insurance of the previous year; standard errors
  from 2005 on, with Census's 160 replicate weights).
- Month-to-month income, program participation (SNAP, SSI, Medicaid, unemployment benefits), health
  coverage spells, assets and debts of the same people over time: SIPP microdata (`sipp`), national
  estimates weighted by the pack.
- Monthly retail sales, housing starts, construction spending; quarterly state and local tax revenue
  (QTAX) and public pension assets; annual state and local government revenue, spending, debt, state tax
  collections and pension systems; monthly imports and exports by HS commodity and country, with the duty
  calculated on imports (tariff revenue by product or country).
- Homeownership rate and rental and homeowner vacancy rates, quarterly, for the nation (`eits_homeownership`).
- Household hardship from the Household Pulse Survey, April 2020 to September 2024: difficulty paying usual
  household expenses, food scarcity, unable to pay an energy bill, likelihood of eviction or foreclosure, price
  worries (`pulse` for 2024, `pulse_covid` for 2020-2023), for the nation, states and metros.
- Not here: monthly unemployment and jobs (bls), GDP and personal income by state (bea); microdata with codes
  harmonized across years, CPI99, spouse or parent traits, CPS panels, ASEC standard errors before 2005,
  years before 2004 (ACS) or 1989 (CPS), NHIS, MEPS, ATUS and historical censuses (ipums); international comparisons (world-bank), federal spending
  by state (usaspending, which ships stale population figures: use this pack for the denominator).
  Household Pulse from 2025 on (HTOPS: census.gov tables and public-use files only, not on the API) and HVS
  rates by region, state or metro (census.gov/housing/hvs/data/rates.html): published tables, not covered.

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `query` | one row per geography; ACS estimates with their margins of error | `dataset`, `get`, `for`, `in`, `ucgid`, or `state` / `county` / `place` / `zcta` names; predicates such as `YEAR`, `HISP` |
| `group_variables` | every variable of a table: code, label, concept | `dataset`, `group` (B19013, S1701, DP03, P1) |
| `groups` | every table of a dataset | `dataset` |

Datasets (catalog aliases; `latest/...` resolves to the newest vintage the API serves, checked each run):
`acs5` latest/acs/acs5 (2024 = 2020-2024, all geographies), `acs1` latest/acs/acs1 (2024; areas of
65,000+), `acs5_subject` / `acs1_subject` (S tables: rates and medians), `acs5_profile` /
`acs1_profile` (DP02-DP05; percent estimates end in PE), `acs1_supplemental` (acsse, areas 20,000+),
`dec_pl_2020` 2020/dec/pl, `dec_dhc_2020`, `dec_dp_2020`, `dec_sf1_2010`, `pep_charv` latest/pep/charv
(vintage 2023 is the newest on the API in October 2026; for the latest vintage without a Census key use FRED
`<ST>POP`, e.g. `MDPOP`, resident population in thousands as of July 1, or Census's NST-EST xlsx; for
every county, a fred `regional` request with any county population series and `region_type: county`
returns the national cross-section for one date, to filter by state FIPS),
`pep_population_2021` 2021/pep/population (POP_2020, POP_2021; states and above only),
`pep_population_2019` (2010-2019, down to places), `cbp` 2023/cbp,
`ecnbasic_2022`, `sipp` latest/sipp (SIPP microdata; 2022-2025 on the API, one per calendar year).
Microdata (one row per person; the traps are in doc "microdata"): `acs1_pums` latest/acs/acs1/pums (2004-2024),
`acs5_pums` latest/acs/acs5/pums (2009-2024), `acs1_pumspr` (Puerto Rico), `cps_asec` latest/cps/asec/mar
(1992-2026, survey year: income is for the year before), CPS basic monthly `<YYYY>/cps/basic/<jan..dec>`
(1989-2026).
Time series (no vintage in the path; select periods with `time`): `eits_retail` timeseries/eits/marts,
`eits_housing_starts` timeseries/eits/resconst, `eits_construction` timeseries/eits/vip, `eits_qtax`
timeseries/eits/qtax, `eits_pensions` timeseries/eits/qpr, `eits_homeownership` timeseries/eits/hv (other indicators: timeseries/eits/m3, mtis,
mrts, ftd, bfs, qfr, qss), `trade_imports_hs` / `trade_exports_hs` timeseries/intltrade/imports|exports/hs
(also .../naics, .../statehs, .../porths, .../enduse), `govs_finances` timeseries/govslocalfin (2017-2024),
`govs_state_finances` timeseries/govsstatefin (1967-2024), `govs_state_tax` timeseries/govsstatetax
(2016-2025), `govs_pensions` timeseries/govspension (2012-2025); every dataset: https://api.census.gov/data/timeseries.json.
Household Pulse (experimental): `pulse` timeseries/hhpulse (Phase 4, 2024 cycles 01-09, one row per
`MEASURE_NAME`), `pulse_covid` timeseries/hps (2020-2023 weeks 01-63, one column set per measure).
Any path works (`2019/acs/acs1`, `2023/acs/acs5/subject`).
Common variables: B01003_001E population, B01002_001E median age, B19013_001E median household income,
B19301_001E per capita income, B17001_002E below poverty (universe B17001_001E), S1701_C03_001E poverty
rate, B25077_001E median home value, B25064_001E median gross rent, B15003_022E bachelor's degree
(universe B15003_001E), B23025_005E unemployed (labor force B23025_003E), P1_001N 2020 count.
Find others: `request_schema` search `"median household income"` (latest ACS 5-year) or
`"2020/dec/pl: total population"`; then `group_variables` for the whole table.

## Spec examples
```json
{"description": "Median household income, Maryland counties, latest ACS 5-year",
 "requests": [{"name": "md_county_income", "endpoint": "query",
   "params": {"dataset": "acs5", "get": "NAME,B19013_001E", "for": "county:*", "state": "Maryland"}}]}
```
```json
{"description": "Home value and rent in Montgomery County MD; population of Baltimore city",
 "requests": [{"name": "montgomery_housing", "endpoint": "query",
   "params": {"dataset": "acs5", "get": ["NAME", "B25077_001E", "B25064_001E"], "state": "MD", "county": "Montgomery"}},
  {"name": "baltimore_pop", "endpoint": "query",
   "params": {"dataset": "acs5", "get": "NAME,B01003_001E", "state": "MD", "place": "Baltimore"}}]}
```
```json
{"description": "Poverty rate by state, ACS 1-year 2024, and the 2020 Census count",
 "requests": [{"name": "poverty_2024", "endpoint": "query",
   "params": {"dataset": "2024/acs/acs1/subject", "get": "NAME,S1701_C03_001E", "for": "state:*"}},
  {"name": "pop_2020", "endpoint": "query",
   "params": {"dataset": "dec_pl_2020", "get": "NAME,P1_001N", "for": "state:*"}}]}
```

## Data format and traps
- Margins of error: every ACS `...E` estimate is fetched with its `...M` margin of error (`...PE` with
  `...PM`), each in its own column, at the 90% confidence level. They are never dropped (`moe: false`
  is refused). Standard error = MOE / 1.645. Two estimates differ significantly only if
  |a - b| > 1.645 * sqrt(SE_a^2 + SE_b^2); say so before ranking small areas.
- Special values (any number <= -1,000,000) are not data: -666666666 (estimate not computable),
  -999999999 (N, too few cases), -888888888 (X, not applicable), -222222222 and -333333333 (MOE not
  computable), -555555555 (controlled estimate: treat the MOE as zero). The pack writes an empty cell
  and a `<column>_flag` column with the meaning; JSON nulls (no data for the geography) are flagged too.
- Top-coding: median home value 2000001 means $2,000,000 or more; median gross rent 2001, 3501 or 4001
  means $2,000, $3,500 or $4,000 or more (by year). The value stays, with a flag. Medians in an open
  interval are not exact; the group() call returns the EA annotation (median+, median-).
- Values arrive as text, exactly as published; NAME reads "Montgomery County, Maryland". Geography
  code columns (state, county, place, tract) are strings with leading zeros: keep them as text.
- 1-year vs 5-year: 1-year (normally released each September for the prior year; the 2025 release was not on
  the API on 2026-10-20) covers only areas of 65,000+
  and has no tracts, block groups or ZCTAs; 5-year (normally each December) covers all areas but pools
  five years. Never compare a 1-year with a 5-year figure, and do not compare overlapping 5-year
  periods (2019-2023 vs 2020-2024). No standard 2020 ACS 1-year release exists (experimental only).
- Dollars are inflation-adjusted to the last year of the period (2024 dollars for 2020-2024); adjust
  before comparing releases. Universes differ by table (households vs population for whom poverty is
  determined): use the table's total as the denominator.
- Geography vintage: codes and boundaries change. Connecticut uses nine planning regions (county codes
  110-190) instead of its eight counties from ACS 2022 on. Name resolution uses the dataset's own NAME
  list when a key is set, else the Census 2020 reference files (noted in the output; they lack the CT
  planning regions). Ambiguous names (Baltimore County vs Baltimore city) are refused with choices; a
  place name prefers the incorporated place over a CDP of the same name.
- A query whose geography matches nothing returns HTTP 204 (reported as no rows). At most 50 variables
  per call, margins of error included: split larger requests. ZCTAs (`zcta`) do not nest in states.
- 2020 Census counts below the state level carry differential-privacy noise; decennial variables end
  in N and have no MOE. Population estimates (pep) are revised every vintage: name the vintage.
- PEP coverage on the API (checked 2026-10-22): pep/charv exists only as vintage 2023 (nation, state,
  county, metro areas; no places); 2021/pep/population has states and above only; 2019/pep/population is
  the last API vintage with place and county subdivision estimates. Vintages 2022 and 2024-2025 (county
  and city/town totals for 2022-2025) are not on the API: use the Census estimates files at
  https://www.census.gov/programs-surveys/popest/data/tables.html (manual download) and name the vintage.
- ACS PUMS, CPS and SIPP microdata (`acs1_pums`, `acs5_pums`, `cps_asec`, `cps/basic`, `sipp`): read
  `source_brief({source: "census", doc: "microdata"})` before the first fetch. It has the keys and weights the
  pack adds, the `ST`/`STATE` rename, replicate weights and standard errors, universes, ADJINC, and the
  checked benchmarks.
- Time series (`timeseries/...`: economic indicators, international trade, government finances, Household
  Pulse, HVS): read `source_brief({source: "census", doc: "timeseries"})` before the first fetch. It has the
  `time` forms, the code columns to fix, units, revisions and each survey's caveats.
- Key: since 2026-05-12 every data query needs a key; the API redirects keyless queries to a "Missing
  Key" page, which the pack reports as a key error. Metadata (variables, discovery) still answer
  without a key.

## Access
Key required: free at https://api.census.gov/data/key_signup.html (an e-mail with an activation link).
With no key stored, fetch fails with `key_missing`: the user stores one with `npx -y data-analyst-mcp setup
census` in their own terminal (never in chat); where the server cannot reach the API, the error suggests
`manual_bundle`. Limits are not published; the pack sends at most 3 requests a second. Manual route:
`manual_bundle` writes `manual_download/INSTRUCTIONS.md`, which lists one JSON link per request with
`{API_KEY}` to replace in the browser (or one command runs download_data.sh / .ps1, which asks for the key with
hidden input); upload the files, then `ingest`. Without the bundle:
https://data.census.gov, search the table (B19013), set geography and year, Download Table > CSV, and
upload it saying it is a data.census.gov export (one estimate and one MOE column per geography; `ingest`
reads it long: label, geography, measure, value). Its table JSON (data.census.gov/api/access/data/table, no
key) is read too, keeping the spec's `get` variables and their MOEs: one table per file, so give each table its
own request and save its JSON as `<request name>.json` (e.g. `...table?id=ACSDT1Y2024.B25031&g=310XX00US<CBSA code>`
for a metro area; worked keyless on 2026-10-22).
Keyless, for a published ACS detailed table (a benchmark): the table-based summary file, one pipe-delimited
file per table, e.g. https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/1YRData/acsdt1y2024-b08013.dat
(5-year: 5YRData/acsdt5y...); geography ids are in the same folder's documentation. Subject and profile
tables (S2801, DP02) without a key: https://data.census.gov/api/access/data/table?id=ACSST1Y2024.S2801&g=010XX00US$0400000
returns the table JSON (all states); `ingest` reads it (it is a benchmark: file it under `published/`
when no census fetch was made).
Keyless, for state population totals (PEP): the fred pack's `<ST>POP` series (thousands, July 1) come with
no key at all, through its keyless graph route, with the usual data/fred/ dictionary and provenance. They
are annual and can lag a new Census vintage by weeks: compare the latest year with the Census release
before using them, and name the vintage. (A cross-section of every county through fred `regional` needs a
FRED key.) A Census estimates file (popest tables) that is still needed is a published table: save it under
`published/` with `source_url` and `accessed` on every row, never straight into `data/census/`.

## Citation and terms
"U.S. Census Bureau, <dataset, e.g. 2020-2024 American Community Survey 5-year estimates, table
B19013; 2024 American Community Survey 1-year Public Use Microdata Sample; or 2024 Survey of Income and Program
Participation, public-use file>, Census Data API, retrieved <date>." Microdata estimates are your own: "Analyst
calculations using the 2024 ACS 1-year PUMS." Public domain. Required notice (Terms of Service): "This
product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau."
Redistribution allowed. Metadata (variables lists) is cached on disk for 30 days; data are not.
