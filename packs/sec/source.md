# SEC EDGAR (XBRL financial data, filings, full-text search)
Depth: standard. Key: none (set SEC_USER_AGENT, see Access). Financial statement values that public
companies tag in XBRL (2009-), every company's filing history, EDGAR full-text search (2001-) and
insider ownership filings (Forms 3, 4, 5).

## When to use
- A company's revenue, net income, assets, EPS, cash flow over time (`company_concept`, `company_facts`);
  one line item across all filers for a period, for rankings and screens (`frames`); a company's 10-K,
  10-Q, 8-K list with links (`submissions`); which filings mention a phrase (`full_text_search`);
  insider Form 4 filings for an issuer (`insider_filings`); ticker or name to CIK (`company_search`).
- Not here: stock prices and market data (not covered); bank Call Reports (fdic: banks file there,
  holding companies file here); consumer complaints about companies (cfpb); federal contracts
  (usaspending). Transaction details inside a Form 4 (shares, prices) are in the linked filing, not here.

## Endpoints and datasets
| Endpoint | Returns (one row per) | Key parameters |
|---|---|---|
| `company_concept` | reported fact of one concept | `cik` or `ticker`, `tag`, `taxonomy` (us-gaap), `unit`, `forms`, `frames_only`, `duration` |
| `company_facts` | fact, all concepts of a company | `cik`/`ticker`, `tags` (comma list), `taxonomy`, `unit`, `forms`, `frames_only`, `duration` |
| `frames` | company, for one concept and period | `tag`, `period` (CY2023, CY2023Q1, CY2023Q4I), `unit` (USD, shares, USD-per-shares) |
| `submissions` | filing | `cik`/`ticker`, `forms` ("10-K,10-Q"), `since` (YYYY-MM-DD), `all` (older files too) |
| `full_text_search` | matching document | `q`, `forms`, `startdt`, `enddt`, `ciks` |
| `insider_filings` | Form 4 (or 3, 5) filing | `cik`/`ticker`, `forms` (4), `startdt`, `enddt` |
| `company_search` | matching company or person (none: an empty table with a note, the other requests still run) | `text` |
Fact rows: cik, entity_name, taxonomy, tag, label, unit, start, end, period_days, val, fy, fp, form,
filed, accn, frame. Common tags (`--search "revenue"`): Revenues,
RevenueFromContractWithCustomerExcludingAssessedTax, NetIncomeLoss, OperatingIncomeLoss, Assets,
Liabilities, StockholdersEquity, EarningsPerShareDiluted, NetCashProvidedByUsedInOperatingActivities.

## Spec examples
```json
{"description": "Apple annual net income, one value per fiscal year",
 "requests": [{"name": "aapl_net_income", "endpoint": "company_concept",
   "params": {"ticker": "AAPL", "tag": "NetIncomeLoss", "forms": "10-K", "frames_only": true, "duration": "annual"}}]}
```
```json
{"description": "Goodwill impairment losses reported for calendar Q4 2023, all companies",
 "requests": [{"name": "goodwill_impairment_2023q4", "endpoint": "frames",
   "params": {"tag": "GoodwillImpairmentLoss", "period": "CY2023Q4"}}]}
```
```json
{"description": "8-K documents mentioning goodwill impairment, 1-5 January 2024; Apple Form 4s, Q1 2025",
 "requests": [
   {"name": "goodwill_8k", "endpoint": "full_text_search",
    "params": {"q": "\"goodwill impairment\"", "forms": "8-K", "startdt": "2024-01-01", "enddt": "2024-01-05"}},
   {"name": "aapl_form4", "endpoint": "insider_filings", "params": {"cik": "320193", "startdt": "2025-01-01", "enddt": "2025-03-31"}}]}
```

## Data format and traps
- Values (`val`) are in the unit shown, unscaled: USD in dollars (Apple's 112010000000 is $112.0
  billion), EPS in USD/shares, counts in shares. Ratio units are spelled differently per endpoint:
  company_concept and company_facts key them `USD/shares` (a `USD-per-shares` filter there keeps
  nothing), while the frames URL needs `USD-per-shares` (`USD/shares` is HTTP 404); verified 2026-10-22.
  The pack accepts either spelling in `unit` and sends the one each endpoint uses; the `unit` column
  always reads `USD/shares`.
- One fact appears many times: each 10-K repeats prior years (and 10-Ks contain Q4-only durations),
  so a raw concept has several rows per period. For a clean annual series use `forms: "10-K"`,
  `frames_only: true` (one value per period, the latest filed) and `duration: "annual"` (350-380
  day facts; `period_days` shows the length). Instant (balance-sheet) facts have no `start`.
  SEC leaves many periods without any framed fact (two retailers' last 5-6 fiscal years, checked
  2026-10-28), so `frames_only` keeps the framed fact where there is one and otherwise the latest-filed
  fact of that period (its `frame` is empty), but only for lengths the series has (annual, quarter, instant,
  from the framed facts or `duration`): unframed 6- and 9-month year-to-date facts overlap and are skipped.
  The fetch notes how many periods were restored and skipped.
- `fy` and `fp` describe the FILING, not the fact: Apple's fiscal 2007 net income carries fy 2009 from a
  10-K/A. Label periods by `end` (or `frame`), never by `fy`.
- Fiscal vs calendar: `frame` (CY2023, CY2023Q4, CY2023Q4I) maps each fact to the nearest calendar
  period; Apple's fiscal year ending 2023-09-30 is frame CY2023. `frames` compares companies with
  different fiscal years in the same calendar slot; say so when ranking.
- Tags differ across companies and years: revenue is `Revenues` for some filers and
  `RevenueFromContractWithCustomerExcludingAssessedTax` (ASC 606, 2018-) for others; `Liabilities` is
  missing for many filers (use LiabilitiesAndStockholdersEquity minus StockholdersEquity and say so).
  Tags are case-sensitive; a tag the company never used answers 404: the fetch still runs every other
  request and names each missing one. To try several candidate tags at once, use `company_facts` with
  `tags` (it notes the ones not reported), or mark the uncertain requests `"allow_empty": true`.
- `frames` lists only companies that tagged that concept for that exact period; absence is not zero.
- Full-text search returns documents, not filings: a filing's main document and each exhibit are
  separate rows (same `adsh`). Count distinct `adsh` for filings. The index returns at most 10,000
  hits (100 per page); totals of 10,000 mean "10,000 or more". Coverage starts in 2001.
- `submissions` holds about the latest 1,000 filings (Apple: 1,001 back to 2015); `all: true` also
  reads the older files (Apple: one more file, 1994-2015).
- Insider rows give the reporting owner's name and CIK; the trade itself is in the filing (index_url).
- EDGAR search sometimes answers HTTP 200 with an error body ("errorType"); the pack reports it as an
  error. Retry after a minute.

## Access
No key. SEC's fair-access policy asks automated tools to declare who they are with a contact email in
the User-Agent and to stay under 10 requests a second (this pack sends at most 5). Set
`SEC_USER_AGENT` (environment variable, or "env" in keys.json or Claude Code's settings.json) to e.g.
`"Jane Analyst jane.analyst@example.org"`; without it the pack sends a generic tool name, which
data.sec.gov and efts.sec.gov accepted in 2026-10 but SEC may block. The pack never sends a GitHub
URL (SEC answers 403 to those). Tickers are resolved with EDGAR's company search (efts), because
www.sec.gov/files/company_tickers.json refuses User-Agents without an email.
Manual route: INSTRUCTIONS.md lists the data.sec.gov / efts JSON links (a browser sends its own
User-Agent); save each under the name shown and upload. Requests that use a ticker need the CIK for
the manual links: find it at https://www.sec.gov/edgar/searchedgar/companysearch.

## Citation and terms
"U.S. Securities and Exchange Commission, EDGAR <API> (<company or concept>), data.sec.gov, retrieved
<date>." Filings are public records; SEC data are public domain. Redistribution allowed. Values are as
filed by the companies (not audited by SEC); cite the filing (accn) for a key number.
