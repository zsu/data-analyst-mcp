# Federal Reserve Board data (DDP releases, Z.1 Financial Accounts, Survey of Consumer Finances)
Depth: standard. Key: none. The Board of Governors' own statistical releases through its Data Download Program
(G.19 consumer credit, Senior Loan Officer survey, H.8 bank balance sheets, H.6 money stock, G.17 industrial
production, charge-offs, debt service ratios, Z.1 packages ...), the Financial Accounts of the United States (Z.1)
from its bulk CSV files, and the triennial Survey of Consumer Finances (SCF) chart data and summary tables.

## When to use
- Consumer credit outstanding (revolving, nonrevolving, by holder, interest rates on cards and auto loans); sector
  balance sheets and who holds what (household net worth B.101, Treasury securities by holder, federal government
  financial assets and liabilities); bank lending standards (SLOOS); family income and wealth by age, income,
  education, race in the SCF (medians, means, ownership rates, 1989-2025); a whole release package at once.
- Not here: one series' long history or its past vintages (fred has most Board series: TOTALSL, REVOLSL, household
  net worth BOGZ1FL152090005Q, SLOOS DRTSCILM; ALFRED keeps vintages), Treasury yields as a curve (treasury-yields),
  SOFR/EFFR, SOMA holdings and dealer data (nyfed), forecasts of these series (philfed for private and Greenbook
  forecasts), household debt from credit records (NY Fed Household Debt and Credit report: not covered), bank-level
  data (fdic). SCF microdata are not wrapped (see Access).

## Endpoints and datasets
Base `https://www.federalreserve.gov`, keyless (verified live 2026-10-30). Long format for `ddp` and `z1`: one row
per series and date, with the series' own description and units on every row.

| Endpoint | Returns (one row per) | Key parameters | Units, coverage |
|---|---|---|---|
| `ddp` | series x date: `date`, `series`, `value`, `value_flag`, `description`, `unit`, `multiplier`, `currency`, `unique_id` | `rel` (release code), `package` (id, title or catalog alias), `series_ids`, `from`, `to`, `lastobs` | value x multiplier in unit; each release's own frequency and history |
| `ddp_packages` | package of a release: `package_title`, `package` (id), `listed` | `rel` | G19 7 packages, Z1 435, SLOOS 1 |
| `z1` | series x date: `date` (1945:Q4 ... 2026:Q2), `series`, `value`, `value_flag`, `description`, `line`, `units`, `table`, `table_published` | `table` (S1M.b or B.101), `series_ids`, `start`, `end` | millions of dollars; current release only |
| `z1_tables` | Z.1 table: `new` (S1M.b), `old` (B.101), `title` | none | 218 tables |
| `scf_chart` | survey year x group (`year`, `Category`), one column per item | `group` (all, agecl, edcl, famstruct, housecl, inccat, nwcat, occat1, occat2, racecl4), `stat` (median, mean, have) | thousands of 2025 dollars (median/mean), percent of families (have); 1989-2025, triennial |
| `scf_table` | non-empty sheet row: `row`, `c1`..`cN` (raw grid) | `file` (`scf2025_tables_public_real_historical` or `..._nominal_historical`), `sheet` ('Table 4') | as titled on the sheet |

Release codes for `rel`: G19 consumer credit, Z1 financial accounts, SLOOS, SCOOS, H8 commercial bank assets and
liabilities, H6 money stock, H15 interest rates, H41 Fed balance sheet, H3 reserves, G17 industrial production,
G20 finance companies, CHGDEL charge-offs and delinquencies, DSR / FOR debt service ratios, CP commercial paper, H10
exchange rates, E2 business lending terms, PRATES policy rates. Catalog aliases for `package` (they carry the
release): `g19_all`, `g19_sa`, `g19_terms`, `g19_holders_nsa`, `g19_flows`, `sloos`, `scoos`, `z1_b101`, `z1_l101`,
`z1_f101`, `z1_l106`, `h15_treasury_cmt`, `h6_monthly`, `h8_all_banks_sa`, `g17_summary`, `chgdel_rates_all`,
`debt_service`, `prates_daily` (`--search` finds them). Z.1 DDP packages are titled by the new table codes:
"S1M.b (Q)" = B.101 quarterly, "(A)" annual.

## Spec examples
```json
{"description": "Total consumer credit outstanding (seasonally adjusted) since 2025 and the SLOOS",
 "requests": [
  {"name": "g19_sa", "endpoint": "ddp", "params": {"package": "g19_sa", "from": "2025-01",
   "series_ids": ["DTCTL.M", "DTCTLR.M", "DTCTLN.M", "DTCTL_@%A_BA.M"]}},
  {"name": "sloos", "endpoint": "ddp", "params": {"package": "sloos", "lastobs": 8}}]}
```
```json
{"description": "Household and nonprofit balance sheet (B.101) and federal government levels (L.106) since 2020",
 "requests": [
  {"name": "b101", "endpoint": "z1", "params": {"table": "B.101", "start": "2020"}},
  {"name": "l106", "endpoint": "z1", "params": {"table": "L.106", "start": "2020"}},
  {"name": "z1_tables", "endpoint": "z1_tables", "params": {}}]}
```
```json
{"description": "SCF 1989-2025: median net worth and income by race, ownership rates, Table 4",
 "requests": [
  {"name": "race_median", "endpoint": "scf_chart", "params": {"group": "racecl4", "stat": "median"}},
  {"name": "all_have", "endpoint": "scf_chart", "params": {"group": "all", "stat": "have"}},
  {"name": "table4", "endpoint": "scf_table", "params": {"file": "scf2025_tables_public_real_historical", "sheet": "Table 4"}}]}
```
A package can also be named by title with its release: `{"rel": "H8", "package": "All Commercial Banks, SA (Weekly)"}`;
an ambiguous or unknown title lists the candidates. `ddp_packages` lists every title and id of a release.

## Data format and traps
- DDP units: `value` x `multiplier` is in `unit`. "Currency" with multiplier 1000000 = millions of dollars: G.19
  total consumer credit DTCTL.M 5,196,778.44 for 2026-08 is $5,196.8 billion, as on the G.19 release page
  (verified 2026-10-30). Percent-change series (`..._@%A_BA.M`) are seasonally adjusted annual rates. ND in a cell
  = no data (`value` empty, `value_flag` ND); blank cells are dropped.
- G.19 series names say SA or NSA; the headline is SA. "Owned and securitized" totals include securitized pools.
  Consumer credit excludes loans secured by real estate (mortgages, home equity). Student loans sit mostly in the
  federal government holder (NSA). Discontinued series end with a note in the description ("discontinued after
  February 2011"). Levels are end of month; G.19 comes out about five weeks after the month.
- The pack always downloads the whole package and applies `from`, `to`, `lastobs` and `series_ids` itself: the DDP's
  own date subsetting answered some new date combinations with an empty file (and a from without a to always did)
  in testing on 2026-10-30. An empty file is retried twice, then reported (a wrong package id also gives one).
- DDP retirement: the Board removes the DDP's "Build Your Package" feature the week of November 9, 2026, "in
  preparation for the eventual retirement of the DDP"; the preformatted packages this pack uses still worked on
  2026-10-30. If `ddp` fails with HTML or empty files, use fred for the series, the release's own page (CSV/XML
  files), or `z1` for the Financial Accounts.
- Z.1 levels vs flows: series codes start with FL (level, end of period), LM (level at market value), FA
  (transactions, seasonally adjusted annual rate), FU (transactions, not seasonally adjusted), FR (revaluations), FV
  (other volume changes); `units` states it per series. Flows at annual rates are four times a quarter's flow: do not
  add four quarters of FA. Levels are not seasonally adjusted. Millions of dollars.
- Z.1 table names changed: the zip and the DDP use new codes (S1M.b, S1M.s, S1M.t, S1311.s); the published table names
  (B.101 balance sheet, L.101 levels, F.101 flows, L.106 federal government, L.210 Treasury securities) map through
  `z1_tables`; `z1` accepts either. The first observations are annual (1945:Q4 ... 1951:Q4, fourth quarters only),
  quarterly from 1952:Q1. Every quarterly release revises history and the zip holds only the current release
  (2026:Q2, released September 2026); say which release the numbers come from. Household net worth (FL152090005.Q,
  B.101 line 42) for 2026:Q2: 195,870,496 = $195.9 trillion. Households here include nonprofit organizations
  (S14.b / B.101.h is households alone).
- SCF is triennial (1989 ... 2022, 2025); no years in between. Chart data are in thousands of 2025 dollars
  (1989 median net worth 118.74 equals Table 4 of the real tables); the `nominal` tables workbook is in dollars of
  each survey year: never mix the two. Before-tax income is for the calendar year before the survey.
- SCF medians and means of an asset or debt are among families that hold it (`have` = percent holding it): the median
  directly held bond holding of 140 (2025) applies to the 1.3 percent who hold bonds. Net worth and income medians
  cover all families. Medians do not add up (median assets minus median debt is not median net worth).
- SCF units are families (the survey's primary economic unit), not Census households. Groups: racecl4 = White
  non-Hispanic, Black non-Hispanic, Hispanic, Other; inccat and nwcat are percentile groups recomputed each survey.
  Estimates have sampling error (standard errors in 2025_tables1_2_stderrs.xlsx on the SCF page).
- `scf_table` returns the sheet as a grid because the summary tables have titles, two header rows (year, then
  Median/Mean) and section rows: read the cells, keep the `row` number when citing.

## Access
No key; the host answers scripts (verified 2026-10-30, Python user agent). Limit used: one request a second. The Z.1
zip is 8.3 MB (downloaded once per run for all `z1` requests); a full DDP package is up to about 1 MB; the SCF
tables workbook 2.5 MB. Manual route: the bundle links the files (a DDP package given by title links its release's
Choose page: pick the package, Format package, CSV, Download file; upload the CSV as downloaded). SCF microdata
(summary extract scfp2025excel.zip, 2.1 MB, and the full public data) are on https://www.federalreserve.gov/econres/scfindex.htm
and are not wrapped: each family appears five times (five implicates), weights must be divided by five when the
implicates are stacked, and standard errors need the replicate weights; a custom tabulation from them is the
analyst's own estimate and must say so.

## Citation and terms
Board of Governors of the Federal Reserve System, <dataset> (name the release, e.g. "G.19 Consumer Credit, October
7, 2026" or "Financial Accounts of the United States, Z.1, 2026:Q2"; for SCF "2025 Survey of Consumer Finances"),
federalreserve.gov, retrieved <date>. Board website content is in the public domain unless otherwise indicated
(https://www.federalreserve.gov/disclaimer.htm); cite the Board as the source.
