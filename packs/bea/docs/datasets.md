# Choosing BEA data: datasets, tables, lines and concepts

Read §1 to pick the dataset, §2 for verified tables and lines, §3 for the concepts that decide whether a
number is right. Confirm names before you download: `fetch.py --source bea --find "<words>"` (NIPA titles, no key),
`fetch.py --source bea --lines <NIPA table>` (line numbers and series codes, no key), and with a key
`fetch.py --source bea --values Regional TableName` or `--find "<words>" --dataset Regional`. Line numbers can change at
comprehensive updates, so select NIPA series by table + line *and* check the description or series code.

## Contents
1. Which dataset answers which question
2. Verified tables and lines
3. Concepts that change the answer
4. Geography notes (states, counties, metro areas)
5. Benchmarks: BEA's own numbers to check against

## 1. Which dataset answers which question

| Question | Dataset (fetch.py `dataset`) | Typical tables | Bulk (no key)? |
|---|---|---|---|
| GDP growth, components, contributions, prices (national) | `NIPA` | T10101, T10102, T10104-T10106, T10111, T11706 | yes |
| Personal income, saving rate, PCE, PCE inflation | `NIPA` | T20100 (A/Q), T20600 (M), T20804/T20805/T20806/T20807 (M) | yes |
| GDP and income per capita | `NIPA` | T70100: line 1 GDP per capita (current dollars), line 10 real GDP per capita (chained 2017 dollars), line 3 personal income; descriptions repeat ("Gross domestic product" on lines 1 and 10; "Current dollars"/"Chained (2017) dollars" under disposable personal income on lines 4 and 12): select by line or series code (RC current, RX real). Annual values are annual GDP over annual population, not the mean of the quarterly ratios | yes |
| Shares of GDP (consumption, investment, government purchases, net exports) | `NIPA` | T10110 (percent of GDP, as BEA publishes it); T10105 lines 22-26 for government consumption and gross investment levels | yes |
| Government receipts, spending, deficits (NIPA basis) | `NIPA` | T30100 (total), T30200 (federal), T30300 (state and local); total spending includes transfers, so "government's share of GDP" as purchases is T10110 / T10105 lines 22-26, not Table 3.1 | yes |
| Corporate profits, saving and investment, trade in the NIPAs | `NIPA` | T61600D, T50100, T40100 | yes |
| Detailed PCE, inventories, auto sales (lower quality) | `NIUnderlyingDetail` | U20305, U20405, U70205S | no: API (the flat files hold only the U-table lines shared with published tables) |
| State GDP, by industry, real and nominal | `Regional` | SAGDP2 (current $), SAGDP9 (real), SAGDP11 (contributions), SQGDP9 (quarterly real) | yes |
| State personal income, per capita income, population | `Regional` | SAINC1 (summary), SAINC4 (components), SQINC1 (quarterly), SAINC5N (earnings by industry) | yes |
| State PCE, price levels (RPPs), real personal income | `Regional` | SAPCE1-SAPCE4, SARPP, SARPI | yes |
| County income and GDP | `Regional` | CAINC1, CAINC4, CAINC5N, CAINC30, CAGDP2, CAGDP9 | yes |
| Metro-area price parities | `Regional` | MARPP | yes |
| Value added, gross output by industry (national) | `GDPbyIndustry` with workbook codes (`"table": "TVA105"`) | TVA105 value added, TVA106 real value added, TVA101 real growth, TVA102 contributions to real GDP growth, TVA110 shares of GDP; TGO1xx gross output; A and Q | yes (public workbooks) |
| Same, detail the workbooks lack (Industry filters, UnderlyingGDPbyIndustry) | `GDPbyIndustry` / `UnderlyingGDPbyIndustry` (`params`: TableID, Frequency, Year, Industry) | list with `--values GDPbyIndustry TableID` | no: API |
| Trade balance, current account, by country | `ITA` (`params`: Indicator, AreaOrCountry, Frequency, Year) | Indicator BalGds (goods balance); list others with `--values ITA Indicator` | no: API (keyless: the current account balance is NIPA T4030B line 50 "Balance on current account, ITAs" in the bulk files, or FRED `IEABC` (quarterly); T4030B can keep an older ITA vintage for some years (2010-2012 differ by a few hundred million): check against IEABC; trade balances: the FRED pack's monthly series BOPGSTB, BOPGTB, BOPSTB, EXPCH/IMPCH; see fred `docs/series.md`) |
| Services trade by type and country | `IntlServTrade` | TypeOfService, TradeDirection, AreaOrCountry | no: API |
| Net international investment position | `IIP` | TypeOfInvestment, Component | no: API (keyless: the FRED pack's `IIPUSNETIQ` quarterly / `IIPUSNETIA` annual net position) |
| Foreign direct investment, multinationals | `MNE` | DirectionOfInvestment, Classification | no: API |
| Capital stock, depreciation | `FixedAssets` | FAAt201 (see `--values FixedAssets TableName`) | no: API |
| Input-output use and make tables | `InputOutput` | TableID 56 (see `--values InputOutput TableID`) | no: API |

Things BEA does not publish, so say so rather than improvise: GDP forecasts (BEA publishes history only; CBO, the
Federal Reserve and private forecasters project), monthly GDP, unemployment and jobs (BLS), CPI (BLS; BEA's measure is
the PCE price index), federal budget data on a fiscal-year basis (Treasury, OMB, CBO).

## 2. Verified tables and lines

NIPA lines below were checked against SeriesRegister.txt (September 2026 release). "SAAR" = seasonally adjusted at
annual rates.

| Table | Line | Series | What it is | Unit |
|---|---|---|---|---|
| T10101 | 1 | A191RL | Real GDP, percent change from preceding period | percent, annual rate (Q is annualized) |
| T10101 | 2 | DPCERL | Real PCE, percent change | percent, annual rate |
| T10102 | 1+ | — | Contributions to percent change in real GDP | percentage points |
| T10104 | 1 | — | GDP price index | index, 2017 = 100 |
| T10105 | 1 / 2 / 7 / 15 / 22 | A191RC / DPCERC / A006RC / A019RC / A822RC | GDP / PCE / investment / net exports / government, current dollars | millions of dollars (unit_mult 6), SAAR for Q |
| T10106 | 1 | A191RX | Real GDP | millions of chained 2017 dollars, SAAR for Q |
| T10111 | 1 | A191RO | Real GDP, percent change from the same quarter a year ago | percent |
| T11706 | 1 / 2 / 3 | A191RX / A261RX / LB000009 | Real GDP / real GDI / average of GDP and GDI | chained 2017 dollars |
| T20100 | 1 / 27 / 37 / 35 / 40 | A065RC / A067RC / A067RX / A072RC / B230RC | Personal income / disposable personal income / real DPI / saving rate / population (thousands) | millions; percent; thousands |
| T20600 | 1 / 35 | A065RC / A072RC | Monthly personal income / saving rate | SAAR millions; percent |
| T20600 | 37 / 43 | A067RX / A067RM | Monthly real disposable personal income / its percent change from the preceding month (not annualized) | chained-dollar SAAR millions; percent |
| T20804 | 1 / 25 | DPCERG / DPCCRG | PCE price index / core PCE price index (excluding food and energy), monthly | index, 2017 = 100 |
| T20807 | 1 / 25 | DPCERGM / DPCCRGM | PCE / core PCE prices, percent change from the preceding month | percent, **not annualized** |
| T20811 | 32 / 37 | BPCERO / BPCCRO | PCE / core PCE prices, percent change from the month one year ago (the 12-month inflation rate; the table's title says "Real PCE", lines 1-31 are quantities) | percent |
| T70100 | 1 / 3 | A939RC / A792RC | GDP per capita / personal income per capita, current dollars | dollars |

GDP-by-industry workbook tables (checked in ValueAdded.xlsx, September 2026): line 1 = gross domestic product,
line 2 = private industries, then NAICS sectors and subsectors (indentation kept in `dims`). TVA105 is in millions of
dollars; TVA106 in millions of chained 2017 dollars and has an extra "Not allocated by industry" line, so line numbers
differ between tables: match industries by description and order. Duplicate names (for example "General
government" under federal and under state and local) are told apart by line number within a table.

Regional lines (checked in the bulk files' `definition.xml` or the API guide):

| Table | Line | What it is | Unit |
|---|---|---|---|
| SAGDP2 / SQGDP2 | 1 = all-industry total, 2 = private industries, then NAICS sectors | GDP, current dollars | millions of current dollars |
| SAGDP9 / SQGDP9 | same lines as SAGDP2 | Real GDP | millions of chained 2017 dollars |
| SAINC1 / SQINC1 / CAINC1 | 1 = personal income, 2 = population, 3 = per capita personal income | income (millions for states, thousands for counties); people; dollars |
| SAINC4 / CAINC4 | 10 = personal income, 20 = population, 30 = per capita personal income; other lines are components | as above |
| SARPP / MARPP | 1 = all items RPP | index, U.S. = 100; published about a year after state income (in October 2026 the latest RPPs and SARPI are for 2024): for the latest income year, say which RPP year you used |

API table names sometimes carry an `N` suffix (`SAGDP9N`, `SAGDP2N`); the bulk files drop it. `fetch.py` accepts either.

## 3. Concepts that change the answer

- **Nominal vs. real.** Current-dollar series include price changes; chained-dollar (real) series remove them. Growth
  "of the economy" means real GDP unless the user says otherwise. Real values are in chained 2017 dollars (the reference
  year since the 2023 comprehensive update; check `unit` in the data).
- **Chained dollars do not add.** Real components do not sum to real GDP, and real state GDP does not sum to real U.S.
  GDP. Compute shares from current-dollar values, and use BEA's published contributions (T10102, SAGDP11) for what
  drove growth, never differences of chained-dollar components.
- **Annual rates.** Quarterly and monthly dollar levels are SAAR: a quarter's value is what the year would total at
  that pace. Average the quarters for an annual figure; do not add them.
- **Growth measures differ.** BEA's headline quarterly growth is the change from the preceding quarter at a compound
  annual rate (T10101). Alternatives: year-over-year (T10111), fourth quarter over fourth quarter, and annual average
  over annual average (the annual line of T10101). They can differ by more than a percentage point in turning years,
  so name the measure in every exhibit and sentence. For multi-year spans ("since 2019"), report the cumulative
  change (`change_between`) and the average annual rate (`cagr`); the two order areas identically, so the choice to
  test with `sensitivity()` is the start and end period, above all a base year inside a recession or other shock.
- **Price measures.** The PCE price index (T20804) is the Federal Reserve's inflation target measure; the GDP price
  index (T10104) covers all domestic production. Core PCE excludes food and energy.
- **Per capita.** Use BEA's per capita lines when they exist (T70100, SAINC1 line 3); otherwise divide by population
  in the same table (T20100 line 40 is in thousands). State per capita income in real terms needs RPPs (SARPI).
  BEA publishes no real GDP per capita by state: divide SAGDP9 line 1 (millions of chained 2017 dollars) by
  SAINC1 line 2 (resident population, same vintage). The U.S. row computed this way sits a little above
  T70100 line 10, whose population includes the armed forces overseas: say so when comparing.
- **Vintage.** BEA serves only its latest estimates. GDP has advance, second and third estimates each quarter,
  annual updates every September (revising several years) and comprehensive updates about every five years. Record
  the release in Data and Methods ("estimates as released on September 30, 2026"), and do not compare a number from an
  old publication with today's estimate without saying that revisions may explain the difference. Old vintages:
  https://apps.bea.gov/histdata/ (not through the API). Next releases: https://www.bea.gov/news/schedule.
- **Suppressed cells.** Regional and industry tables use `(D)` (suppressed to avoid disclosure), `(NA)`, `(NM)`,
  `(L)` and others. They are not zeros. A ranking or total that needs a suppressed cell must say so or drop the area.
- **Calendar years.** All BEA annual data are calendar years, including federal government spending in the NIPAs
  (unlike budget data, which use fiscal years). NIPA government spending also differs from budget outlays in concept.
- **Industry classification.** Regional and GDP-by-industry data use NAICS. Long state series by industry begin in
  1997 (SIC-based data before that are not comparable).

## 4. Geography notes

- `geo_fips`: `00000` = United States; `SS000` = states (`06000` California); `91000`-`98000` = BEA regions;
  five-digit county FIPS (`06037` Los Angeles County).
- Independent cities are their own county-level areas: "Baltimore (Independent City), MD" is 24510, "Baltimore,
  MD" is Baltimore County (24005); Virginia's independent cities are often combined with a county
  ("Albemarle + Charlottesville"). Match by FIPS, not by name.
- County tables (CAINC*) and state tables (SAINC*) come out on different schedules: from late September to
  early December the state table carries the newer annual revision, so a county's state row in CAINC1 and the
  same state in SAINC1 can differ. Compare a county with its state from the same table.
- `geo_fips: "STATE"` returns the 50 states, the District of Columbia and the U.S. total. Say whether D.C. is
  included in rankings ("the 50 states and the District of Columbia").
- In the state GDP tables (SAGDP*), the U.S. row is national GDP (it matched NIPA T10106 line 1 to rounding in the
  September 2026 vintage); the *sum of the states* is what differs, because it leaves out federal military and
  civilian activity overseas and uses different source data (BEA footnote 1, in `notes.csv`). For other tables, read
  the table's footnotes in `notes.csv` before comparing a state total with a NIPA figure. Compare states with the U.S.
  figure from the same table.
- **Metro areas:** since February 2026 BEA no longer produces GDP or personal income for metropolitan statistical
  areas, micropolitan areas, metropolitan divisions, combined areas or metro/nonmetro portions. For a metro estimate,
  sum the component counties' current-dollar values (county-to-MSA delineations:
  https://apps.bea.gov/regional/geography.htm; BEA's tool: https://github.com/us-bea/bea_geo_aggregator), say that
  it is an aggregation of county data, and do not sum chained-dollar values. Older metro estimates are in
  https://apps.bea.gov/histdata/. MSA price parities (MARPP) are still published.

## 5. Benchmarks

Compute what you can from levels and check it against BEA's own published numbers with
`stats.check_against_published()`; any mismatch beyond rounding means a selection or method error:
- real GDP growth from T10106 levels vs. T10101 line 1 (quarterly, annualized) or the annual line;
- year-over-year growth vs. T10111;
- monthly PCE inflation from T20804 (`growth`, plain monthly change) vs. T20807, and 12-month inflation (`yoy`)
  vs. T20811 lines 32 / 37;
- the U.S. row of SAGDP9 / SAGDP2 vs. NIPA T10106 / T10105 line 1 levels (they match within a few million dollars; a free
  check that the state table, line and units were read right);
- shares of GDP from T10105 current dollars vs. the "percent of GDP" figures in BEA releases.
Also compare the headline number with the latest BEA news release (https://www.bea.gov/news) and say in Data and
Methods whether it matches.
