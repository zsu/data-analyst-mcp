# New York Fed Markets Data API (reference rates, SOMA, Treasury operations, primary dealers)
Depth: standard. Key: none. The Federal Reserve Bank of New York's open market data: the SOFR and EFFR
overnight reference rates, what the Fed's System Open Market Account (SOMA) holds, the Fed's own Treasury
purchases and sales, and primary dealer positions.

## When to use
- The overnight rate path behind a debt-service or interest-cost projection (SOFR for secured funding, EFFR for
  the policy-rate benchmark, with the target range); how much of the federal debt the Fed holds, by security
  type, maturity and CUSIP, and its weighted average maturity; the pace of Fed bill purchases or runoff; dealers'
  net positions in Treasuries as a measure of market absorption.
- Not here: Treasury market yields (treasury-yields), what the government pays on its debt and auction results
  (treasury), long histories of the policy rate and the Fed balance sheet total (fred: FEDFUNDS, SOFR, WALCL).
  The Fed's remittances to Treasury and its income statement are not in this API.

## Endpoints and datasets
Base `https://markets.newyorkfed.org/api`, keyless, JSON (verified live 2026-10-30). One CSV per request.

| Endpoint | Returns (one row per) | Key parameters | Units, frequency, coverage |
|---|---|---|---|
| `rates` | business day, newest first | `family` (`secured` or `unsecured`), `ratetype` (`sofr`, `tgcr`, `bgcr` are secured; `effr`, `obfr` unsecured), `startDate`, `endDate` | percent, with percentiles 1/25/75/99 and `volumeInBillions`; EFFR rows carry `targetRateFrom` and `targetRateTo`; SOFR from 2018-04-02 |
| `soma_summary` | weekly as-of date, oldest first | none (the whole history, about 1,200 rows) | dollars by class: `bills`, `notesbonds`, `tips`, `frn`, `mbs`, `cmbs`, `agencies`, `total`; 2003-07-09 on |
| `soma_asofdates` | published as-of date (column `value`), newest first | none | weekly (Wednesdays) |
| `soma_tsy_holdings` | CUSIP held on one date | `date` (an as-of date) | dollars (`parValue`), `percentOutstanding` as a fraction of the issue, `securityType` Bills, NotesBonds, TIPS, FRNs; about 430 rows |
| `soma_tsy_wam` | one row | `holdingtype` (`all`, `bills`, `notesbonds`, `tips`, `frn`), `date` | weighted average maturity in years |
| `tsy_operations` | Fed Treasury operation | `operation` (`purchases`, `sales`, `all`), `include` (`summary` or `details`), `startDate`, `endDate` | dollars par amounts submitted and accepted; `details` adds the securities as JSON text |
| `pd_series` | weekly as-of date | `timeseries` (a key from `pd_catalog`) | millions of dollars; weekly since 2013 |
| `pd_catalog` | primary dealer series | none | about 1,500 keys with descriptions; search the file for the key you need |

Not wrapped: month-end SOMA holdings for all history (`/soma/tsy/get/monthly.json`, 26 MB): get the dates you need
from `soma_asofdates` and fetch `soma_tsy_holdings` per date instead. Repo operations, MBS operations, FX swaps and
securities lending exist in the API (`/api/rp`, `/api/ambs`, `/api/fxs`, `/api/seclending`) but are not wrapped.

## Spec examples
```json
{"description": "SOFR and EFFR since January 2026",
 "requests": [
  {"name": "sofr", "endpoint": "rates", "params": {"family": "secured", "ratetype": "sofr", "startDate": "2026-01-01", "endDate": "2026-10-29"}},
  {"name": "effr", "endpoint": "rates", "params": {"family": "unsecured", "ratetype": "effr", "startDate": "2026-01-01", "endDate": "2026-10-29"}}]}
```
```json
{"description": "Fed Treasury holdings: weekly totals and the latest maturity profile",
 "requests": [
  {"name": "soma_weekly", "endpoint": "soma_summary", "params": {}},
  {"name": "soma_dates", "endpoint": "soma_asofdates", "params": {}},
  {"name": "tsy_wam", "endpoint": "soma_tsy_wam", "params": {"holdingtype": "all", "date": "2026-10-28"}},
  {"name": "tsy_cusips", "endpoint": "soma_tsy_holdings", "params": {"date": "2026-10-28"}}]}
```
```json
{"description": "Fed bill purchases in October 2026 and dealer net Treasury positions",
 "requests": [
  {"name": "purchases", "endpoint": "tsy_operations", "params": {"operation": "purchases", "include": "summary", "startDate": "2026-10-01", "endDate": "2026-10-29"}},
  {"name": "dealer_net_tsy", "endpoint": "pd_series", "params": {"timeseries": "PDPOSGST-TOT"}}]}
```
The `date` of `soma_tsy_holdings` and `soma_tsy_wam` must be an as-of date from `soma_asofdates` (the latest is
the first row); another date answers an empty or error reply.

## Data format and traps
- Rates are percent, not fractions. `rates` rows are newest first; sort by `effectiveDate` for a time series.
  SOFR and EFFR are different things: SOFR prices Treasury-collateralized overnight borrowing, EFFR is the
  unsecured interbank rate that the target range governs. A published rate can be revised the next business day
  (`revisionIndicator`); the pack does not re-fetch.
- SOMA values are dollars (par), not millions. `soma_summary` `total` includes MBS and agencies; the Treasury
  part is bills + notesbonds + tips + frn, and `tips` is par without `tipsInflationCompensation` (a separate
  column). Do not add them to compare with Treasury's market value of debt: SOMA is at par, and Treasury's
  debt outstanding (treasury pack) is a different measure.
- Holdings are published with a lag of about a week; the as-of date is a Wednesday. `percentOutstanding` is a
  fraction (0.09 is 9 percent of the issue). `maturityDate` lets you build a maturity ladder: group by year of
  `maturityDate` and sum `parValue`.
- `tsy_operations` amounts are dollars par. Reserve-management bill purchases, QT-era reinvestments and
  coupon sales appear as different `operationType` values; filter on it rather than assuming purchases are
  all one program. `operationDirection` is P (purchase) or S (sale).
- Primary dealer values are millions of dollars; a key whose description ends "Change From Previous Week" is a
  change, not a level. Descriptions combine LONG and SHORT: the `-TOT` keys are net positions (long minus short).
  The series breaks (SBN2024 and earlier) change the definitions at the break; `pd_catalog` shows which break a
  key belongs to. State it when a series crosses one.
- The API caps nothing documented on date ranges, but a long range of daily rates is one JSON of a few
  hundred KB; ask only for the period needed.

## Access
No key; the host answers scripts (verified 2026-10-30). Limit used: one request per second. Route `api`;
`manual` is the browser: the links in `manual_download/INSTRUCTIONS.md` open each JSON in the browser (save the
page, upload it with --ingest), or use the downloads on newyorkfed.org (reference rates, SOMA holdings, Treasury
operations, primary dealer statistics).

## Citation and terms
Federal Reserve Bank of New York, Markets Data APIs (<dataset>), markets.newyorkfed.org, retrieved <date>.
Public data from the Federal Reserve Bank of New York; follow its terms of use
(https://www.newyorkfed.org/terms-of-use); redistribution allowed with attribution. The API documentation is
at https://markets.newyorkfed.org/static/docs/markets-api.html.
