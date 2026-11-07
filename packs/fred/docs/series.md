# FRED series for budget and economic analysis

Every ID below was checked to exist on 2026-10-20 (titles, units, frequency and adjustment as FRED shows
them). FRED edits titles and adds series; confirm with `fetch.py --source fred --describe <IDs>` before downloading, and
read the title back against the concept. Copyright tags were read on the series page only where marked ✔;
read the page for the others before sharing data.

Contents: 1. Output and potential · 2. Prices · 3. Labor · 4. Interest rates · 5. The federal budget ·
6. Income and other · 7. Recessions · 8. States and areas · 9. Finding a series you do not know

## 1. Output and potential output
| ID | What | Units, frequency | Notes |
|---|---|---|---|
| `GDP` | Gross domestic product | Billions of dollars, quarterly, SAAR | Nominal; the denominator for shares of GDP (average the 4 quarters of a fiscal year) |
| `GDPA` | GDP, annual | Billions of dollars, annual | Calendar year; the denominator of FRED's FY*GDA188S ratios |
| `FYGDP` | GDP, fiscal year (OMB) | Billions of dollars, annual, fiscal year (dated Sep 30) | OMB's figure from its latest budget; lags BEA revisions. The mean of the four quarters of `GDP` is the current-vintage alternative |
| `GDPC1` | Real GDP | Billions of chained 2017 dollars, quarterly, SAAR | BEA; Public Domain ✔ |
| `A191RL1Q225SBEA` | Real GDP, percent change from preceding period | Percent, quarterly, SAAR | BEA's published growth rate: the benchmark for `annualized(GDPC1)` |
| `A939RX0Q048SBEA` | Real GDP per capita | Chained 2017 dollars, quarterly, SAAR | |
| `GDPPOT` | Real potential GDP (CBO) | Billions of chained 2017 dollars, quarterly, NSA | CBO; Public Domain ✔; **projected ~10 years ahead**; last updated with CBO's latest outlook, so it may rest on an older GDP vintage than GDPC1 |
| `NGDPPOT` | Nominal potential GDP (CBO) | Billions of dollars, quarterly | Projections as above |
| `NROU` | Noncyclical rate of unemployment (CBO) | Percent, quarterly | Projections as above |
| `GDPDEF` | GDP implicit price deflator | Index 2017=100, quarterly, SA | |

Output gap = `GDPC1 / GDPPOT - 1` (both chained 2017 dollars), on dates both have (`tsstats.common_end`).

## 2. Prices
| ID | What | Units, frequency | Notes |
|---|---|---|---|
| `PCEPI` | PCE price index | Index 2017=100, monthly, SA | The measure in the Federal Reserve's 2 percent objective; CBO projects it alongside the CPI-U |
| `PCEPILFE` | Core PCE price index | Index 2017=100, monthly, SA | |
| `CPIAUCSL` | CPI-U, all items | Index 1982-84=100, monthly, SA | Monthly changes |
| `CPIAUCNS` | CPI-U, all items | Index 1982-84=100, monthly, NSA | 12-month changes as BLS reports them; annual averages |
| `CPILFENS` | Core CPI-U, not seasonally adjusted (12-month changes) | Index 1982-84=100, monthly, NSA | |
| `CPILFESL` | Core CPI-U | Index 1982-84=100, monthly, SA | |
| `CWUR0000SA0` | CPI-W, all items | Index 1982-84=100, monthly, NSA | Social Security COLA: average of July-September over the same quarter a year earlier |
| `SUUR0000SA0` | Chained CPI-U (C-CPI-U) | Index Dec 1999=100, monthly, NSA | Tax-bracket indexing; preliminary for 10-12 months |
| `T10YIE` | 10-year breakeven inflation | Percent, daily | Market-based expectation (10-year nominal minus 10-year TIPS yield) |
| `T5YIE` | 5-year breakeven inflation | Percent, daily | 5-year nominal minus 5-year TIPS yield; monthly averages `T5YIEM` |
| `T5YIFR` | 5-year, 5-year forward inflation expectation | Percent, daily | (((1+b10/100)^10/(1+b5/100)^5)^(1/5)-1)*100 from the 10- and 5-year breakevens; monthly `T5YIFRM` |
| `UMCSENT` | University of Michigan consumer sentiment | Index 1966:Q1=100, monthly, NSA | **Posted on FRED one month late** at UMich's request: the latest final and preliminary months are on sca.isr.umich.edu (save them in published/). UMich moved from phone to web interviews in 2024, which shifts levels |

## 3. Labor
| ID | What | Units, frequency |
|---|---|---|
| `UNRATE` | Unemployment rate | Percent, monthly, SA |
| `PAYEMS` | All employees, total nonfarm | Thousands, monthly, SA |
| `CIVPART` | Labor force participation rate | Percent, monthly, SA |
| `CNP16OV` | Civilian noninstitutional population 16+ | Thousands, monthly, NSA |
| `CES0500000003` | Average hourly earnings, total private | Dollars per hour, monthly, SA |
| `ECIWAG` | ECI, wages and salaries, private industry | Index Dec 2005=100, quarterly, SA |

For more detail on BLS series (demographic groups, industries, significance), the bls pack is the
better tool; FRED mirrors the same data.

## 4. Interest rates
| ID | What | Units, frequency |
|---|---|---|
| `DFEDTARU` / `DFEDTARL` | Federal funds target range, upper / lower limit (FOMC) | Percent, daily (steps on decision dates). "Cut since the peak": when the path reverses, report the net change and the gross cuts separately (2024-2026: 1.75 points of cuts, 1.50 net after a 2026 raise); the Board's Open Market Operations table is the benchmark |
| `FEDFUNDS` | Effective federal funds rate | Percent, monthly average |
| `DFF` | Effective federal funds rate | Percent, daily (7-day) |
| `DGS10` | 10-year Treasury constant-maturity yield | Percent, daily (business days; gaps on holidays) |
| `GS10` | 10-year Treasury yield | Percent, monthly average |
| `TB3MS` | 3-month Treasury bill, secondary market | Percent, monthly (discount basis) |
| `MORTGAGE30US` | 30-year fixed mortgage rate (Freddie Mac) | Percent, weekly ending Thursday |
| `T10Y2Y` / `T10Y2YM` | 10-year minus 2-year Treasury spread (curve inversion when negative) | Percentage points, daily / monthly average |
| `T10Y3M` | 10-year minus 3-month Treasury spread | Percentage points, daily |

Use the monthly averages (GS10, TB3MS) for annual or fiscal-year averages; CBO's interest-rate projections
are calendar- or fiscal-year averages of these rates.

## 5. The federal budget
| ID | What | Units, frequency | Notes |
|---|---|---|---|
| `FYFR` | Federal receipts (revenues) | Millions of dollars, annual, **fiscal year** | OMB/Treasury; dated Sep 30 |
| `FYONET` | Federal net outlays | Millions of dollars, annual, fiscal year | |
| `FYFSD` | Federal surplus or deficit (negative = deficit) | Millions of dollars, annual, fiscal year | |
| `FYOINT` | Federal outlays: interest | Millions of dollars, annual, fiscal year | OMB, Public Domain ✔. OMB's net interest (budget function 900, matches OMB Historical Table 3.1): $970.1 billion in FY2025. CBO's Monthly Budget Review reports "net interest on the public debt" above $1 trillion for FY2025, a different budget category; say which one the text means and benchmark it against its own source |
| `FYFSGDA188S` | Surplus or deficit as percent of GDP | Percent of GDP, annual (fiscal year, dated Jan 1) | |
| `FYOIGDA188S` | Interest outlays as percent of GDP | Percent of GDP, annual (fiscal year, dated Jan 1) | Benchmark only: divides by calendar-year GDP (GDPA), not fiscal-year GDP |
| `FYGFDPUN` | Federal debt held by the public | Millions of dollars, quarterly, end of period | |
| `FYGFGDQ188S` | Debt held by the public as percent of GDP | Percent of GDP, quarterly, SA | |
| `GFDEBTN` | Total public debt | Millions of dollars, quarterly, end of period | Includes intragovernmental debt: not "debt held by the public" |
| `GFDEGDQ188S` | Total public debt as percent of GDP | Percent of GDP, quarterly, SA | |
| `A091RC1Q027SBEA` | Federal interest payments (NIPA) | Billions of dollars, quarterly, SAAR | National-accounts basis, not budget basis |
| `W006RC1Q027SBEA` | Federal current tax receipts (NIPA) | Billions of dollars, quarterly, SAAR | NIPA basis |
| `FGEXPND` | Federal current expenditures (NIPA) | Billions of dollars, quarterly, SAAR | NIPA basis |

Budget-basis (OMB/Treasury, fiscal year) and NIPA-basis (BEA, calendar quarters) measures differ in timing and
coverage; never mix them in one ratio without saying so. For CBO's own baseline projections and historical
budget data, use CBO's data files (cbo.gov), not FRED.

## 6. Income and other
| ID | What | Units, frequency |
|---|---|---|
| `PCE` | Personal consumption expenditures | Billions of dollars, monthly, SAAR |
| `DSPIC96` | Real disposable personal income | Billions of chained 2017 dollars, monthly, SAAR |
| `PSAVERT` / `A072RC1Q156SBEA` | Personal saving rate (NIPA Table 2.6 / 2.1 line 35) | Percent of disposable income, monthly / quarterly |
| `MEHOINUSA672N` | Real median household income (Census) | Dollars of the latest year (C-CPI-U), annual |
| `SP500` | S&P 500 index | Index, daily; **Copyrighted: Pre-Approval Required** ✔ (only 10 years on FRED) |

**International trade** (the Census/BEA monthly release, FT-900, mirrored keyless; BEA's ITA needs a key)
| ID | What | Units, frequency |
|---|---|---|
| `BOPGSTB` / `BOPGTB` / `BOPSTB` | Trade balance: goods and services / goods / services, balance of payments basis | Millions of dollars, monthly, SA |
| `BOPTEXP` / `BOPTIMP` | Exports / imports of goods and services, BOP basis | Millions of dollars, monthly, SA |
| `EXPCH` / `IMPCH` | Goods exports to / imports from China, Census basis (other partners: EXP / IMP + country code) | Millions of dollars, monthly, NSA |

Annual totals are sums of the months; the June annual revision replaces the first-published year. Partner
balances are on the Census basis, as the release gives them.

## 4b. Money stock (Federal Reserve H.6, monthly)
`M2SL` M2 (billions of dollars, SA), `M1SL` M1, `M2NS` M2 not adjusted, `WM2NS` weekly M2. The H.6 has not
published growth rates since February 2021: 12-month growth is computed from levels (`pc1`), and the H.6
data file is the level benchmark.

## 5a. Industrial production and capacity utilization (Federal Reserve G.17, monthly)
`INDPRO` industrial production, total (index 2017=100), `IPMAN` manufacturing; `TCU` capacity
utilization, total (percent), `MCUMFN` manufacturing (checked with `--describe` on 2026-10-21). The
latest months are preliminary and revised for several months. G.17 states the gap to the long-run
average as the difference of its one-decimal rates (76.9 - 79.4 = 2.5 points below): compute it the
same way to match, and show the unrounded gap as a sensitivity.

## 5c. Housing starts and permits (Census New Residential Construction, monthly)
`HOUST` total starts, `HOUST1F` single-family, `PERMIT` permits (thousands of units, SAAR; checked with
`--describe` on 2026-10-21); `HOUSTNSA` not adjusted. The latest month is preliminary and revised twice.
An annual total from FRED sums rounded months: Census's annual sheet sums unrounded estimates (0.1 apart).

## 5b. Unemployment insurance claims (DOL, weekly)
`ICSA` initial claims (SA), `IC4WSA` 4-week moving average (SA), `ICNSA` (NSA), `CCSA` continued claims.
Weeks end on Saturday; the latest week is an advance figure (preliminary). The keyless route when the dol
pack has no key. A calendar-year average needs all the weeks of the year (`to_frequency` refuses a partial
year).

## 6a. Household debt service (Federal Reserve DSR release)
Quarterly, percent of disposable personal income: `TDSP` total, `MDSP` mortgage, `CDSP` consumer debt
service. The Fed rebuilt the series on credit-bureau data in 2024: its levels are about 2.5 points above the
archived lender-based series (2007 Q4 15.8 against 13.3), so never mix the two; the latest quarter is
preliminary. Benchmark: federalreserve.gov/releases/dsr.

## 6b. Federal Reserve balance sheet (H.4.1)
Weekly, millions of dollars (checked with `--describe` on 2026-10-21). Wednesday levels: `WALCL` total
assets, `TREAST` Treasury securities held outright, `WSHOMCB` mortgage-backed securities, `WSHOSHO` all
securities held outright, `WLRRAL` reverse repurchase agreements (liability). Week averages (not Wednesday
levels; do not mix with the above): `WRESBAL` reserve balances, `WTREGEN` Treasury General Account.
`RRPONTSYD` overnight reverse repos is daily and in billions. Changes between two weeks are differences of
published levels, not published figures: say so in benchmark.csv. Other assets (premiums, loans, the
rest) are total minus the securities.

## 6d. House prices and the international investment position
| ID | What | Units, frequency | Notes |
|---|---|---|---|
| `CSUSHPINSA`, `CSUSHPISA` | S&P CoreLogic Case-Shiller U.S. National home price index, NSA / SA | Index Jan 2000=100, monthly, two months' lag | `copyright` preapproval_required: say the values may not be republished; S&P's release leads with NSA 12-month changes |
| `USSTHPI` | FHFA all-transactions house price index, U.S. | Index 1980:Q1=100, quarterly | Public domain |
| `IIPUSNETIQ`, `IIPUSNETIA` | U.S. net international investment position (BEA), quarterly / annual | Millions of dollars | The keyless route to BEA's IIP (the BEA pack needs a key for IIP); preliminary for the latest quarter |

## 6c. Exchange rates (Federal Reserve H.10)
| ID | What | Units, frequency | Notes |
|---|---|---|---|
| `DTWEXBGS` | Nominal broad dollar index (trade-weighted, 26 currencies) | Index Jan 2006=100, daily | The Fed's headline dollar index; checked against H.10 [2026-10-22] |
| `TWEXBGSMTH` | Nominal broad dollar index, monthly average | Index Jan 2006=100, monthly | A year-to-date change can differ in sign between daily end points and monthly averages: say which |
| `RTWEXBGS` | Real broad dollar index | Index Jan 2006=100, monthly | Adjusted for relative consumer prices |
| `DEXUSEU`, `DEXJPUS`, `DEXCHUS`, `DEXCAUS`, `DEXMXUS` | Bilateral rates: dollars per euro; yen, yuan, Canadian dollars, pesos per dollar | daily | Mind the quote direction (US per foreign for the euro) |

## 7. Recessions
`USREC` (monthly; FRBSL from NBER dates; **Copyrighted: Citation Required** ✔), `USRECQ` (quarterly), `USRECD`
(daily). 1 from the month after the NBER peak through the trough. `"recessions": true` in the spec adds USREC;
`tsstats.recession_periods` turns it into spans for chart shading.
Sahm rule: `SAHMREALTIME` (real-time, as first published; empty where a month's unemployment rate was not
collected, Oct 2025) and `SAHMCURRENT` (from current UNRATE vintages): the 3-month average of the unemployment
rate minus its low of the prior 12 months; 0.50 or more signals a recession start.

## 8. States and areas
- Unemployment rate: `<ST>UR` (CAUR, TXUR ...), monthly, SA (BLS LAUS).
- Per capita personal income: `<ST>PCPI` (CAPCPI ...), annual (BEA).
- A full cross-section in one call needs a key: spec `"regional": [{"series_id": "CAUR", "region_type": "state",
  "date": "2026-08-01"}]` (GeoFRED finds the group from any member series). Without a key, list the 50 state IDs
  plus DC explicitly; check each with `--describe` (a 404 means the pattern does not hold for that series).

## 9. Finding a series you do not know
1. With a key: `python <skill>/scripts/fetch.py --source fred --search "federal outlays interest" --limit 15` (sorted by
   popularity; prefer the most popular series from the official source).
2. Without a key: search https://fred.stlouisfed.org/searchresults/?st=<words> in the browser (or WebSearch
   "site:fred.stlouisfed.org <words>").
3. Confirm with `--describe`: title, units, frequency, seasonal adjustment, last updated. Prefer the series
   published by the original agency (BEA, BLS, OMB, Treasury, CBO, the Board of Governors) over derived copies,
   and an SA series for short-run changes, NSA for 12-month changes and annual averages.
