# Philadelphia Fed Real-Time Data Research Center (SPF, Greenbook/Tealbook, Livingston, Real-Time Data Set)
Depth: standard. Key: none. Private-sector consensus forecasts (Survey of Professional Forecasters, quarterly since
1968:Q4; Livingston Survey, twice a year since 1946), Federal Reserve Board staff Greenbook/Tealbook projections
(released with a five-year lag), and the Real-Time Data Set for Macroeconomists (every data vintage of GDP, CPI,
unemployment and more), all as the Philadelphia Fed's published .xlsx workbooks.

## When to use
- What professional forecasters expect for real GDP growth, unemployment, payrolls, CPI/PCE and core inflation,
  Treasury yields, over the next quarters and years; 5- and 10-year inflation expectations (CPI10, PCE10); how
  forecasts changed from survey to survey; disagreement among forecasters (dispersion); the probability of a decline
  in real GDP (Anxious Index); what Fed staff projected at past FOMC meetings (Greenbook, through 2020); the data as
  they were known on a past date, first releases and revisions (Real-Time Data Set).
- Not here: the FOMC participants' Summary of Economic Projections, market-implied rates or inflation (breakevens:
  fred, T10YIE), budget-agency projections (use the agency's own files), the NY Fed's Survey of Consumer
  Expectations (not covered; nyfed has the NY Fed's reference rates, SOMA and dealer data), Federal Reserve Board
  statistical releases and the Survey of Consumer Finances (fed-board), current data series (fred, bls, bea). Single-series vintage
  histories of a FRED series are also in fred (ALFRED); use `rtdsm` here when the SPF information set matters.

## Endpoints and datasets
Base `https://www.philadelphiafed.org/-/media/FRBP/Assets/Surveys-And-Data`, keyless, one .xlsx workbook per call
(verified live 2026-10-30). One worksheet (`sheet`, case-sensitive) becomes one CSV.

| Endpoint | Returns (one row per) | Key parameters | Units, coverage |
|---|---|---|---|
| `spf` | survey (`survey` 2026Q3, plus YEAR, QUARTER) | `file` `medianLevel`, `medianGrowth`, `meanLevel`, `meanGrowth`; `sheet` = variable (RGDP, NGDP, PGDP, UNEMP, EMP, CPI, CORECPI, PCE, COREPCE, TBILL, TBOND, HOUSING, INDPROD, RCONSUM, CPI10, PCE10, RGDP10 ...) | level units of each variable (below); 1968:Q4 to 2026:Q3 |
| `spf_dispersion` | survey (`Survey_Date(T)` 2026Q3) | `measure` 1 (levels), 2 (q/q growth), 3 (100*log P75/P25); `sheet` | 25th/75th percentile across forecasters and their gap, horizons T..T+4 |
| `spf_prob` | survey | `sheet` PRGDP, PRPGDP, PRUNEMP, PRCCPI, PRCPCE, RECESS | mean probabilities in percent |
| `greenbook` | Greenbook (`greenbook_date`, DATE = year.quarter, GBdate) | `sheet` gRGDP, gPGDP, UNEMP, gPCPI, gPCPIX, gPPCE, gPPCEX, gRPCE, gRBF, gRRES, gRGOVF, gRGOVSL, gNGDP, HSTART, gIP | g = q/q annualized percent; 1967 to December 2020 |
| `livingston` | survey, June and December (`survey_date`, Date) | `file` `medians`, `means`, `MedianGrowthRate`, `MeanGrowthRate`; `sheet` RGDPX, GDPX, CPI, PPI, UNPR, IP, TPHS, TBILL, TBOND, PRIME, SPIF, ... | levels or annualized growth; 1946 to June 2026 |
| `rtdsm` | observation date (DATE 2025:Q4), one column per vintage | `file` stem (ROUTPUTQvQd, pcpiMvMd, rucQvMd, employMvMd, NOUTPUTQvQd, PQvQd, RCONQvQd) or alias (`real_gdp`, `cpi`, `unemployment`, `payrolls`, `nominal_gdp`, `gdp_price_index`, `real_consumption`, `real_gdp_monthly_vintages`) | levels as published in each vintage |

SPF column names (`spf` level files): VAR1 = last quarter of history the panel saw (the quarter before the survey),
VAR2 = current-quarter nowcast, VAR3..VAR6 = the next four quarters, VARA = annual average for the survey year,
VARB, VARC, VARD = the following years (C and D only for UNEMP, RGDP, TBILL, TBOND and, for CPI/PCE, C). Growth files:
dvar2..dvar6 = annualized q/q growth of the median (mean) level from the previous horizon (dvar2 = VAR2 over VAR1).
Not wrapped: individual responses (SPFmicrodata.xlsx, 25 MB: download it by hand from .../individual-forecasts and
upload one sheet saved as CSV), the Greenbook column-format zips, Livingston individual data.

## Spec examples
```json
{"description": "Latest SPF real GDP outlook: median levels, q/q growth, and the 2026Q3 vintage for the 2025 base year",
 "requests": [
  {"name": "rgdp_level", "endpoint": "spf", "params": {"file": "medianLevel", "sheet": "RGDP"}},
  {"name": "rgdp_growth", "endpoint": "spf", "params": {"file": "medianGrowth", "sheet": "RGDP"}},
  {"name": "rgdp_vintages", "endpoint": "rtdsm", "params": {"file": "real_gdp"}}]}
```
```json
{"description": "Inflation expectations: SPF CPI path and 10-year CPI, Livingston CPI, disagreement on GDP growth",
 "requests": [
  {"name": "cpi", "endpoint": "spf", "params": {"file": "medianLevel", "sheet": "CPI"}},
  {"name": "cpi10", "endpoint": "spf", "params": {"file": "medianLevel", "sheet": "CPI10"}},
  {"name": "liv_cpi", "endpoint": "livingston", "params": {"file": "medians", "sheet": "CPI"}},
  {"name": "rgdp_disp", "endpoint": "spf_dispersion", "params": {"measure": 2, "sheet": "RGDP"}}]}
```
```json
{"description": "Fed staff (Greenbook) real GDP and core PCE projections, and the Anxious Index",
 "requests": [
  {"name": "gb_rgdp", "endpoint": "greenbook", "params": {"sheet": "gRGDP"}},
  {"name": "gb_core_pce", "endpoint": "greenbook", "params": {"sheet": "gPPCEX"}},
  {"name": "recess", "endpoint": "spf_prob", "params": {"sheet": "RECESS"}}]}
```

## Data format and traps
- Survey date is not the forecast date. Each row is one survey; the columns are horizons relative to it. The survey
  in quarter T is taken in its middle month, after the BEA advance report for T-1 (the 2026:Q3 survey was released
  August 14, 2026; the 2026:Q4 survey comes in mid-November). VAR1 is history, not a forecast. Annual columns are
  fixed calendar years within a year (VARA = 2026 in every 2026 survey) and shift in each first-quarter survey.
- Annual real GDP growth as the SPF release reports it ("annual-average over annual-average") is NOT in any
  growth file. Compute it: RGDPA divided by the previous year's annual average, minus 1, where the previous year's
  average is the mean of its four quarters in the `rtdsm` real GDP vintage of the same quarter (column ROUTPUT26Q3
  for the 2026:Q3 survey; its 2026:Q2 value equals that survey's RGDP1). Verified: 24,359.09 / 23,850.43 = +2.1%
  for 2026, the release's 2.1; later years are RGDPB/RGDPA (2.2 for 2027), RGDPC/RGDPB, RGDPD/RGDPC. The
  Philadelphia Fed's annual-history file (annual-historical-values-by-survey-date-selected-variables.xlsx) stopped
  at the 2025:Q3 survey; do not rely on it.
- Quarterly growth (`medianGrowth` dvar2..dvar6) is annualized q/q percent ((X_t/X_t-1)^4 - 1), computed by the
  Philadelphia Fed from the median levels: it is the growth of the median, not the median of growth. The release
  rounds: drgdp2 2.4624 is "2.5 percent" for 2026:Q3.
- CPI, CORECPI, PCE, COREPCE in the level files are inflation rates, not index levels: VAR1..VAR6 are annualized
  q/q rates, VARA..VARC fourth-quarter over fourth-quarter (CPIA 3.561 = 3.6 percent for 2026 in the 2026:Q3
  survey). They have no growth-file sheets. CPI10/PCE10 are 10-year annual-average inflation (every survey);
  RGDP10, PROD10, STOCK10, BOND10, BILL10 appear in first-quarter surveys only (#N/A otherwise).
- Units: NGDP billions of dollars SAAR; RGDP billions of chained dollars SAAR whose base year changes over the
  survey's history (1958 in 1968, ... 2012 for 2018:Q3-2023:Q3, 2017 since 2023:Q4; GNP before 1992, fixed-weight
  before 1996). Never compare RGDP levels across a base-year change; compare growth rates. UNEMP percent; EMP
  thousands (the release converts annual-average changes to jobs per month: (EMPA - previous year)/12); HOUSING
  millions of units; TBILL, TBOND, BOND, BAABOND percent. BOND and BAABOND history (VAR1) is #N/A: Moody's does not
  let the Bank publish it.
- Missing values are "#N/A" in the files; the CSV has empty cells. YEAR and QUARTER keep the published text
  ("2026.0000"); use `survey`. Mean files are pulled by outliers; the release uses medians.
- Number of forecasters changes by survey (32 in 2026:Q3); not in the median files.
- Dispersion: measure 1 sheets are level variables (UNEMP, TBILL, CPI, ...), measures 2 and 3 cover the NIPA
  variables (RGDP, NGDP, ...). Header row is row 10 (the pack reads it). Sheet names can differ in case from the
  level files (Dispersion_1 `SPR_Tbond_Tbill` vs medianLevel `SPR_TBOND_TBILL`); a wrong name lists the sheets.
- Probabilities (`spf_prob`): PRGDP1.. are mean probabilities for ranges of annual-average growth (PRGDP/PRPGDP)
  or Q4/Q4 core inflation (PRCCPI/PRCPCE) for the survey year and the following years, stacked in one row; the
  number of ranges, the range limits and the number of years changed in 1981:Q3, 1992:Q1, 2009:Q2, 2020:Q2 and
  2024:Q2, and before 1981:Q3 PRGDP was nominal GNP. Map columns to ranges with the SPF documentation
  (spf-documentation.pdf, section 6) for the survey dates used; do not assume today's bins for old surveys.
- Greenbook/Tealbook: five-year release lag (latest Greenbook in the data: December 4, 2020). Several Greenbooks per
  quarter share one DATE (2020.4 twice): use `greenbook_date`. B4..B1 are the staff's history for T-4..T-1 (B1 can
  still be an estimate), F0 the current quarter, F1..F9 ahead. Real GNP before December 11, 1991, fixed weights
  before January 26, 1996 (the Documentation sheet of GBweb_Row_Format.xlsx lists the breaks).
- Livingston: `Date` is an Excel serial day number (46174 = 2026-06-01; the pack adds `survey_date`). Surveys in June
  and December; X_BP/X_BY base values are the last data known (April/Q1 for June, October/Q3 for December), and before
  June 2004 they are unreliable except for CPI (the Bank's own caveat): use the growth files for old surveys.
- `rtdsm`: wide, one column per vintage (ROUTPUT65Q4 ... ROUTPUT26Q3, 245 columns); a vintage holds the whole history
  as published then, #N/A for dates not yet published. Levels change base year across vintages.
- A wrong file name returns HTTP 200 with an HTML "Error - 404" page; the pack reports it as a wrong file name.

## Access
No key; the host answers scripts (verified 2026-10-30, Python user agent). Limit used: one request a second. The
workbooks are 0.1-0.7 MB (SPFmicrodata.xlsx 25 MB is not wrapped). Route `api`. Manual route: the links in
`manual_download/INSTRUCTIONS.md` download the same workbooks; upload them unchanged and the pack reads the sheet in
the spec. Pages listing the files: https://www.philadelphiafed.org/surveys-and-data/real-time-data-research/ then
`median-forecasts`, `mean-forecasts`, `dispersion-forecasts`, `probability-variables`, `individual-forecasts`,
`greenbook`, `livingston-historical-data`, `real-time-data-set-full-time-series-history`. Release dates:
.../survey-of-professional-forecasters/spf-release-dates.txt. Documentation: spf-documentation.pdf and
livingston-documentation.pdf on the same pages.

## Citation and terms
Federal Reserve Bank of Philadelphia, Real-Time Data Research Center, <dataset>, philadelphiafed.org, retrieved
<date>. For SPF numbers name the survey ("Survey of Professional Forecasters, 2026:Q3"). The Bank's online terms of
use allow informational, educational and research use; credit the Bank and do not imply its endorsement. Greenbook
projections are Federal Reserve Board staff forecasts published by the Philadelphia Fed; say so.
