# Treasury Daily Interest Rate Statistics (home.treasury.gov)
Depth: standard. Key: none. Treasury's daily market rates: the par yield curve (constant maturity, 1 month to
30 years), the par real yield curve (TIPS), bill rates, and long-term and real long-term rates.

## When to use
- The 10-year, 2-year, 3-month or 30-year Treasury yield on a day or over time; the shape of the curve and
  inversions (for example 10 Yr minus 2 Yr or minus 3 Mo); TIPS real yields and, with the nominal curve,
  breakeven inflation; T-bill discount and coupon-equivalent rates; the long-term composite rate.
- Not here: average interest rates on outstanding federal debt, interest expense and auction results (those
  are Fiscal Data: the treasury pack, which covers what the government pays on its debt while this pack covers
  market yields); policy rates, corporate yields and long FRED histories before 1990 (fred).

## Endpoints and datasets
One CSV per feed and calendar year (verified live 2026-10-20):
`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/<year>/all?type=<feed>&field_tdr_date_value=<year>&_format=csv`.
The adapter requests every year from `start_year` to `end_year` and stacks them.

| Endpoint (alias) | Feed `type` | Columns (percent) | From |
|---|---|---|---|
| `par_yield_curve` (`par`) | `daily_treasury_yield_curve` | 1 Mo, 1.5 Month, 2 Mo, 3 Mo, 4 Mo, 6 Mo, 1 Yr, 2 Yr, 3 Yr, 5 Yr, 7 Yr, 10 Yr, 20 Yr, 30 Yr | 1990 |
| `real_yield_curve` (`real`) | `daily_treasury_real_yield_curve` | 5 YR, 7 YR, 10 YR, 20 YR, 30 YR | 2003 |
| `bill_rates` (`bills`) | `daily_treasury_bill_rates` | 4 to 52 WEEKS BANK DISCOUNT and COUPON EQUIVALENT | 2002 |
| `long_term_rates` (`long_term`) | `daily_treasury_long_term_rate` | LT COMPOSITE (>10 Yrs), TREASURY 20-Yr CMT | 2000 |
| `real_long_term` (`real_long_term`) | `daily_treasury_real_long_term` | LT Real Average (10> Yrs) | 2000 |

Frequency: business days (no rows on weekends and federal holidays). Older history of the same daily
series: fred (DGS10 ...). `--endpoints` and `--search "real yield"` list these.

## Spec examples
```json
{"description": "Par yield curve, 2024-2025",
 "requests": [{"name": "par", "endpoint": "par_yield_curve", "params": {"start_year": 2024, "end_year": 2025}}]}
```
```json
{"description": "TIPS real yields and long-term rates, 2025",
 "requests": [{"name": "real", "endpoint": "real_yield_curve", "params": {"year": 2025}},
              {"name": "lt", "endpoint": "long_term_rates", "params": {"year": 2025}}]}
```
`year` takes one year; `start_year` and `end_year` a range (one request per year, at most 40); with neither,
the current year. A year before a feed starts is refused (`fix_spec`).

## Data format and traps
- Output `<out>/data/treasury-yields/<name>.csv`: `date` (YYYY-MM-DD, converted from the published
  MM/DD/YYYY) then one column per maturity with Treasury's own header ("10 Yr", "1.5 Month", "4 WEEKS BANK
  DISCOUNT"); values are percent as published (two decimals). Rows are oldest first (the files are newest
  first).
- Maturities not published on a date are empty cells (checked in the files): 1 Mo from 2001-07-31, 2 Mo
  from 2018-10-16, 4 Mo from 2022-10-19, 1.5 Month from 2025-02-18, 20 Yr from 1993-10-01; no 30 Yr from
  2002-02-19 to 2006-02-08 (the long-term composite covers that gap). The column set therefore changes
  between years; the stacked table holds the union. An empty cell means "not published", never zero.
- Zeros are real: in near-zero-rate periods Treasury published 0.00 for short maturities (verified
  2026-10-22 in the 2008-2021 files: 1 Mo on 100 days between 2008-12-10 and 2021-06-03, 3 Mo on 18 days,
  2 Mo on 2). Keep them as values; do not treat 0.00 as missing, and do not take logs or ratios of them.
- A listed date can have every maturity empty (2010-10-11, Columbus Day): drop such rows before
  computing changes from the previous day or counting business days.
- Rates are par yields from Treasury's daily curve fit to indicative bid-side price quotes (not trades) for
  the most recently auctioned securities, not traded yields of one security. Method change: a monotone
  convex method replaced the quasi-cubic hermite spline on 2021-12-06, so values before and after that date
  come from different curve fits (Treasury Yield Curve Methodology page,
  https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics/treasury-yield-curve-methodology,
  checked 2026-10-22); mention it when a series spans the change.
- Bill rates: the bank discount rate is lower than the coupon-equivalent (bond-equivalent) yield; compare
  bills with coupons on the coupon-equivalent basis.
- Monthly or annual averages: average the business days with a value (that is how Treasury and the Federal
  Reserve's H.15 average); say so. Spreads are differences in percentage points.
- Treasury occasionally corrects a day's values; the current year's file grows each business day. Record the
  retrieval date.
- The site is slow for clients whose User-Agent contains a URL (about 8 s per request); this pack sends a
  plain one. A year in the future, or before a feed starts, returns HTTP 200 with an empty body.

## Access
No key. Route `api` when home.treasury.gov answers (one request per feed and year, 5-20 KB each). Manual
route: INSTRUCTIONS.md lists one CSV link per year, saved as `<name>_<year>.csv`; or open
https://home.treasury.gov/policy-issues/financing-the-government/interest-rate-statistics, choose the rate
type and the year, Download CSV, and upload each file; then `--ingest`.

## Citation and terms
"U.S. Department of the Treasury, Daily Treasury Par Yield Curve Rates (or the feed used), home.treasury.gov,
retrieved <date>." Public domain (U.S. government work); redistribution allowed.
