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
Microdata (one row per person; see the PUMS and CPS trap below): `acs1_pums` latest/acs/acs1/pums (2004-2024),
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
Find others: `fetch.py --source census --search "median household income"` (latest ACS 5-year) or
`--search "2020/dec/pl: total population"`; then `group_variables` for the whole table.

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

```json
{"description": "Share of people without health coverage in December, SIPP 2024 (weighted by WPFINWGT)",
 "requests": [{"name": "sipp_coverage_dec", "endpoint": "query",
   "params": {"dataset": "2024/sipp", "get": "TAGE,RHLTHMTH,TPTOTINC", "MONTHCODE": "12"}}]}
```

```json
{"description": "Uninsured rate, Maryland, ACS 2024 1-year PUMS with replicate weights; CPS September 2026",
 "requests": [{"name": "md_pums", "endpoint": "query",
   "params": {"dataset": "2024/acs/acs1/pums", "get": "AGEP,HICOV,RELSHIPP,ESR,PINCP", "state": "MD",
              "replicates": true}},
  {"name": "cps_sep", "endpoint": "query",
   "params": {"dataset": "2026/cps/basic/sep", "get": "PRTAGE,PEMLR,PRCITSHP", "PRTAGE": "25:54"}}]}
```

```json
{"description": "Retail sales, 2026 to date; customs duty on imports from China, August 2026, by HS chapter",
 "requests": [{"name": "retail_2026", "endpoint": "query",
   "params": {"dataset": "eits_retail", "get": "cell_value,data_type_code,category_code,seasonally_adj,time_slot_id,error_data",
              "for": "us:*", "time": "2026"}},
  {"name": "china_duty_2026_08", "endpoint": "query",
   "params": {"dataset": "trade_imports_hs", "get": "CTY_NAME,I_COMMODITY,GEN_VAL_MO,CON_VAL_MO,DUT_VAL_MO,CAL_DUT_MO",
              "CTY_CODE": "5700", "COMM_LVL": "HS2", "time": "2026-08"}}]}
```
```json
{"description": "State and local government finances by state, 2024",
 "requests": [{"name": "govfin_2024", "endpoint": "query",
   "params": {"dataset": "govs_finances", "get": "AGG_DESC,GOVTYPE,AMOUNT,AMOUNT_CV", "for": "state:*", "time": "2024"}}]}
```

```json
{"description": "Adults with difficulty paying usual household expenses, nation, every 2024 Pulse cycle; homeownership rate 2025",
 "requests": [{"name": "pulse_expense_2024", "endpoint": "query",
   "params": {"dataset": "pulse", "get": "MEASURE_NAME,MEASURE_LABEL,RATE,RATE_MOE,TOTAL,UNIVERSE,CYCLE,PHASE,COL_START_DATE,COL_END_DATE",
              "for": "us:*", "time": "2024", "MEASURE_NAME": "EXPENSE"}},
  {"name": "homeownership_2025", "endpoint": "query",
   "params": {"dataset": "eits_homeownership", "get": "cell_value,data_type_code,category_code,seasonally_adj,time_slot_id,geo_level_code,error_data",
              "for": "us:*", "time": "2025", "category_code": "RATE"}}]}
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
- 1-year vs 5-year: 1-year (normally released each September for the prior year; the 2025 release was not on the API on 2026-10-20) covers only areas of 65,000+
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
- SIPP (`sipp`, `20XX/sipp`): public-use microdata, one row per person per reference month (MONTHCODE
  1-12). The reference year is the calendar year before the file's label: `2024/sipp` was collected in
  2024 about January-December 2023; say "2023" for its figures. Filter MONTHCODE (12 = December) for a
  point in time, or average the months for the year. The pack always adds SSUID, PNUM (person = SSUID + PNUM), MONTHCODE and
  WPFINWGT, the person weight: every estimate is weighted by WPFINWGT, never a row count. No geography but
  `state`, which filters TST_INTV (state of the interview address); SIPP is designed for national estimates.
  -9 means NA or missing in most variables: drop it before summing. Standard errors need the replicate
  weights, which are not on the API (bulk file `rw<YYYY>_csv.zip`, REPWGT1-REPWGT240, at
  https://www2.census.gov/programs-surveys/sipp/data/datasets/<YYYY>/; method in the year's user guide); without them
  give the point estimate and say no standard error was computed. Variable names and codes:
  `--search "<YYYY>/sipp: health insurance"` or the dataset's variables.json. The bulk primary file
  (`pu<YYYY>_csv.zip`, about 100 MB) has every variable, for a manual download.
- ACS PUMS and CPS microdata (`acs1_pums`, `acs5_pums`, `cps_asec`, `<YYYY>/cps/basic/<mon>`): one row per
  person, values and codes exactly as published, with `<request>_codebook.csv` (every code's label, the
  variable's suggested weight). The pack adds the keys and weights: ACS SERIALNO, SPORDER, PWGTP (persons), WGTP
  (households: SPORDER 1 with RELSHIPP 20); ASEC H_SEQ, A_LINENO, PERIDNUM, MARSUPWT, HSUP_WGT; basic HRHHID,
  HRHHID2, PULINENO, PWSSWGT (final weight), PWCMPWGT (composite: employment levels that match BLS). For hourly
  and weekly earnings in a basic month, request PWORWGT (outgoing rotation groups, HRMIS 4 and 8). Every estimate
  is weighted, never a row count. Filters are upper-case variable predicates (`"AGEP": "25:54"`, `"HICOV": 2`),
  repeated on every call; geography: `state`, or `for: "public use microdata area:*"` with a state (ACS);
  no state = the nation (ACS fetched state by state, 51 calls, about 2 minutes for the 3.4 million persons).
  `replicates: true` adds PWGTP1-80 for ACS (`"household"`: WGTP1-80, `"both"`); columns past 50 come in
  further calls joined on the keys. For the ASEC (2005 on) it adds PH_SEQ and PPPOS and joins PWWGT1-160 from
  Census's replicate weight file (CPS_ASEC_ASCII_REPWGT_<year> on www2.census.gov, about 70 MB, no key), after
  two gates: the file's weight sums equal the totals its SAS layout states, and every person's PWWGT0 equals
  MARSUPWT (2020: the 2020-based file is tried when the main one does not match). Standard error: `pums.rep_se` (lib/pums.py), sqrt(4/80 * sum of squared
  replicate differences), MOE = 1.645 * SE. Checked 2026-11-04: Maryland's 2024 uninsured rate in the civilian
  noninstitutionalized population from PUMS was 6.26 +/- 0.32 percent, published S2701 6.3 +/- 0.3; the nation
  8.19 vs 8.2.
  - Universe: published insurance and labor tables use the civilian noninstitutionalized population
    (`pums.civilian_noninst`: RELSHIPP 37 is the institutionalized group quarters population, ESR 4-5 armed
    forces). Codes below zero or 0 often mean N/A (PINCP -19999 under 15, ESR 0 under 16): read the codebook.
  - Dollars: ACS amounts need ADJINC (ADJHSG for housing costs), which the pack adds when a dollar variable asks
    for it: value * ADJINC / 1,000,000 is in the survey year's dollars, as the published tables are. PUMS is a
    subsample of the full ACS: a PUMS figure differs slightly from the published table (inside its MOE);
    publish your figure as your own calculation and benchmark it against the table.
  - CPS: ASEC income, poverty (PERLIS) and full-year insurance (COV) refer to the previous calendar year; NOW_COV
    is coverage at the interview. Standard errors: `pums.rep_se(df, f, weight="MARSUPWT")` (PWWGT1-160,
    SE = sqrt(4/160 * sum of squared differences)); household estimates on `pums.householders(df, "asec")` with
    `weight="HSUP_WGT"` and the same replicates. Checked 2026-11-04: 2025 official poverty from the 2026 ASEC was
    34,505 thousand +/- 909 and 10.2 +/- 0.3 percent (PERLIS 1 among PERLIS != -1), P60-290 Table 1 34,510 +/- 909
    and 10.2 +/- 0.3. Before 2005 there is no replicate file: use the ipums pack.
    The API's 2020 and 2021 ASEC weights are the 2010-Census-based ones (their PWWGT0 matched the main replicate
    file, checked 2026-11-04); Census advises its 2020-based weights to compare those years with 2022 on, and
    they are not on the API: say which weights a 2020-2021 comparison uses.
    ASEC files before 2001 take no state geography on the API (HTTP 500): fetch the nation and filter on the
    file's state variable, or use ipums. Older files lack some keys and weights (HRHHID2 before 2004, PERIDNUM
    in early ASECs): the pack leaves them out and says so. CPS basic monthly has no replicate weights at all; month-to-month person links need HRHHID, HRHHID2 and
    PULINENO with care (ipums CPSIDP links them). CPS codes differ from ACS codes (PEMLR, PRCITSHP, A_HGA /
    PEEDUCA): `lib/pums.py` recodes take the survey (`"acs"`, `"asec"`, `"basic"`).
  - Analysis helpers: `pums = pack_lib("census", "pums", OUT, SKILL)` (`load`, `rep_se`, `wshare`, `wmean`,
    `wtotal`, `adjusted`, `civilian_noninst`, `uninsured`, `emp_status`, `foreign_born`, `educ_group`,
    `householders`); grouped tables, binned medians and regressions from `pack_lib("ipums", "stats", ...)`.
- Time series (`timeseries/...`): give `time` (`2026`, `2026-08`, `2026-Q2`, or `from 2024-01 to 2026-08`).
  Economic indicators (eits) return one row per code combination: `category_code` (industry or tax type),
  `data_type_code` (level, percent change, ...), `seasonally_adj` (yes/no), `time_slot_id`, `error_data` (yes =
  the row is a margin or standard error, not an estimate). The codes are not in the API's metadata: run one
  narrow query and read the codes that come back, or the program's definitions page (census.gov/econ/currentdata),
  then filter on them; never sum across data types or adjustment flags. Monthly indicators are revised (advance,
  preliminary, revised): say which release. Units: retail and construction $ millions, housing units in
  thousands, QTAX `CELL_VALUE` $ millions (variables.json labels say so); government finances `AMOUNT` $ thousands
  with a coefficient of variation `AMOUNT_CV` (percent, sample-based local figures). Government finance years are
  each government's fiscal year, not the calendar year. International trade: values in dollars; `GEN_VAL_MO`
  general imports vs `CON_VAL_MO` imports for consumption; `CAL_DUT_MO` is the duty calculated on imports for
  consumption (an estimate of duty owed, not Treasury's customs receipts); `COMM_LVL` HS2/HS4/HS6/HS10 must be
  fixed or totals double-count; `CTY_CODE` country codes (5700 China, 2010 Mexico, 1220 Canada); it takes no
  for= geography; `SUMMARY_LVL` CGP rows are country groups, not countries (drop them before summing).
- Household Pulse (`pulse`, `pulse_covid`) is an experimental data product: an online survey of adults 18+ in
  housing units, contacted by e-mail and text, with weighted response rates of 4.7 to 7.3 percent at the end
  (7.3 percent in week 63, October 2023; 4.7 percent in Phase 4.2 cycle 09, September 2024; each period's Source
  and Accuracy statement, census.gov/programs-surveys/household-pulse-survey/technical-documentation.html). Say so
  with every figure. `pulse` (timeseries/hhpulse) is long: one row per `MEASURE_NAME` (13 measures: EXPENSE,
  FOODSCARCE, ENERGYBILL, EVICTFOR, PRICEINCR, PRICEWORRY, LONELY, ...), `CYCLE` and geography; filter
  `MEASURE_NAME` and `CYCLE`. It holds `time=2024` only (Phase 4.0 cycles 01-03, 4.1 04-07, 4.2 08-09, January 9 to
  September 16, 2024); `time=2025` returns no rows. `pulse_covid` (timeseries/hps) is wide: `<M>_RATE`,
  `<M>_RT_MOE`, `<M>_TOTAL`, `<M>_MOE`, `<M>_UNIV` per collection `WEEK` (01-63, April 2020 to October 2023; from
  Phase 2 a "week" is a two-week collection period). Questions came and went, so a measure is empty in weeks
  that did not ask it (EXPENSE is empty in weeks 01-12, first asked in week 13, August 2020). The survey ended on 2024-09-16 and continued from 2025 inside HTOPS,
  whose tables are not on the API.
  `RATE` is the percent of `UNIVERSE` (`TOTAL` / `UNIVERSE`; EXPENSE, 2024 cycle 09: 87,697,083 / 236,337,862 =
  37.1), not of `UNITS_TOTAL` (all adults). Report `RATE_MOE` (`<M>_RT_MOE`) with every rate; Census uses
  90 percent confidence intervals for Pulse, but the API does not state the level of its margins. State margins
  are several times the national one (cycle 09 EXPENSE: Maryland 34.3 +/- 3.4, nation 37.1 +/- 0.7): test a
  difference against both margins before calling it one. Do not splice `pulse_covid` and `pulse` into one series
  or compare across phases without saying the question set and contact frame changed (Phase 4.2 added prepaid
  wireless numbers, "potentially impacting comparability with previous cycles", Phase 4.2 User Notes).
- HVS (`eits_homeownership`, timeseries/eits/hv) is quarterly (`time=2025-Q3`), from the CPS: `category_code`
  RATE has `data_type_code` HOR (homeownership rate, not seasonally adjusted), SAHOR (seasonally adjusted,
  `seasonally_adj` yes), RVR (rental vacancy rate), HVR (homeowner vacancy rate), and E_HOR, E_RVR, E_HVR
  (`error_data` yes: the 90 percent margin of error in percentage points, e.g. 0.5 for HOR); category ESTIMATE
  holds the housing inventory in thousands (TOTAL, OCC, OWNOCC, RNTOCC, VACANT, RENT, SALE, SEASON, ...). Never
  mix HOR and SAHOR in one series. The API has the nation only; the release's Table 4 is the benchmark (2025
  HOR 65.1, 65.0, 65.3, 65.7 matched the API on 2026-11-03). Fourth quarter 2025 rests on November and December
  only: October 2025 was not collected during the lapse in federal funding (release footnote); say so when it
  is used.
- Key: since 2026-05-12 every data query needs a key; the API redirects keyless queries to a "Missing
  Key" page, which the pack reports as a key error. Metadata (variables, discovery) still answer
  without a key.

## Access
Key required: free at https://api.census.gov/data/key_signup.html (an e-mail with an activation link).
Store it with the setup script (route `run_setup`); in a sandbox the route is `manual_download`. Limits
are not published; the pack sends at most 3 requests a second. Manual route: `manual_download/
INSTRUCTIONS.md` lists one JSON link per request with `{API_KEY}` to replace in the browser (or one
command runs download_data.sh / .ps1, which asks for the key with hidden input); upload the files, then `--ingest`. Without the bundle:
https://data.census.gov, search the table (B19013), set geography and year, Download Table > CSV, and
upload it saying it is a data.census.gov export (one estimate and one MOE column per geography; `--ingest`
reads it long: label, geography, measure, value). Its table JSON (data.census.gov/api/access/data/table, no
key) is read too, keeping the spec's `get` variables and their MOEs: one table per file, so give each table its
own request and save its JSON as `<request name>.json` (e.g. `...table?id=ACSDT1Y2024.B25031&g=310XX00US<CBSA code>`
for a metro area; worked keyless on 2026-10-22).
Keyless, for a published ACS detailed table (a benchmark): the table-based summary file, one pipe-delimited
file per table, e.g. https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/1YRData/acsdt1y2024-b08013.dat
(5-year: 5YRData/acsdt5y...); geography ids are in the same folder's documentation. Subject and profile
tables (S2801, DP02) without a key: https://data.census.gov/api/access/data/table?id=ACSST1Y2024.S2801&g=010XX00US$0400000
returns the table JSON (all states); `--ingest` reads it (it is a benchmark: file it under `published/`
when no census fetch was made).
Keyless, for state population totals (PEP): the fred pack's `<ST>POP` series (thousands, July 1) come with
no key at all, through its keyless graph route, with the usual data/fred/ dictionary and provenance. They
are annual and can lag a new Census vintage by weeks: compare the latest year with the Census release
before using them, and name the vintage. (A cross-section of every county through fred `regional` needs a
FRED key.) A Census estimates file (popest tables) that is still needed is a published table: save it under
`<out>/published/` with `source_url` and `accessed` on every row, never straight into `data/census/`.

## Citation and terms
"U.S. Census Bureau, <dataset, e.g. 2020-2024 American Community Survey 5-year estimates, table
B19013; 2024 American Community Survey 1-year Public Use Microdata Sample; or 2024 Survey of Income and Program
Participation, public-use file>, Census Data API, retrieved <date>." Microdata estimates are your own: "Analyst
calculations using the 2024 ACS 1-year PUMS." Public domain. Required notice (Terms of Service): "This
product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau."
Redistribution allowed. Metadata (variables lists) is cached on disk for 30 days; data are not.
