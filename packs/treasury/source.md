# U.S. Treasury Fiscal Data (fiscaldata.treasury.gov)
Depth: deep. Key: none. Official federal finance statistics from the Bureau of the Fiscal Service: debt,
deficits, receipts and outlays (Monthly Treasury Statement), Treasury cash (Daily Treasury Statement),
interest expense and average rates on the debt, the debt limit, auctions, exchange rates; 185 endpoints.

## When to use
- National debt (total, held by the public, intragovernmental; daily since 1993, yearly since 1790), debt by
  security type, debt subject to the limit; monthly and fiscal-year receipts, outlays and deficits; receipts
  by source, outlays by function and by agency; gross interest expense, net interest, average interest rates
  on outstanding debt; the TGA cash balance and daily deposits and withdrawals; auction results; exchange
  rates for federal reporting; gifts to reduce the debt; savings bonds; buybacks.
- Not here: market yields and the daily par yield curve (treasury-yields); GDP and CPI (bea, bls, fred; or
  `--context gdp|cpi` here, for real dollars and "% of GDP"); budget projections (CBO); historical tables in
  % of GDP and the President's budget (OMB); who holds the debt by country (Treasury TIC, not Fiscal Data);
  state and local finances (Census).
- Deliver data plus a short answer by default; a report only when asked (SKILL.md).

## Endpoints and datasets
Base `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/` + a path with a fixed version (v1 or
v2: the other returns 404). `--search "interest expense"` searches the live catalog (falls back to the
bundled `catalog.json`: a snapshot of the live catalog plus this
guidance); `--fields <endpoint>` gives fields, types, units, row count, first and last row; add `--filter
'{"record_date": "2026-09-30"}' --values` to see which values each code and description column holds;
`--endpoints` lists the curated rows below. Full question-to-endpoint table: `docs/datasets.md`; API rules,
field meanings and the numbered gotchas: `docs/api_guide.md`; framing and conventions: `docs/report_patterns.md`.

| Question | Endpoint | Rows to use | Stock/flow | Units |
|---|---|---|---|---|
| Total debt, held by the public, intragovernmental (daily) | `v2/accounting/od/debt_to_penny` | one row per business day | stock | $ |
| Debt at fiscal year end since 1790 | `v2/accounting/od/debt_outstanding` | one row per year | stock | $ |
| Debt by security type (monthly) | `v1/debt/mspd/mspd_table_1` | `security_type_desc`, `security_class_desc`; skip "Total" rows | stock | $M |
| Debt subject to the limit | `v1/debt/mspd/mspd_table_2`, `v1/accounting/dts/debt_subject_to_limit` | `debt_catg_desc` | stock | $M |
| Monthly receipts, outlays, deficit since FY1981 | `v1/accounting/mts/mts_receipts_outlays_deficit_surplus` | `amt_category` | flow | $M |
| Receipts, outlays, deficit since FY2015 | `v1/accounting/mts/mts_table_1` | months: latest `record_date`, `record_type_cd` MTH; full FY: the September release's "Year-to-Date" row (`record_type_cd` SL, `data_type_cd` T) in the current-year block (`sequence_number_cd` 2.13; 1.13 is the prior year) | flow | $ |
| Receipts by source, outlays by function | `v1/accounting/mts/mts_table_9` | September `record_date`; `data_type_cd` D components, T "Total" | flow | $ |
| Outlays by agency, bureau, program | `v1/accounting/mts/mts_table_5` | `record_type_cd` A agency totals; D rows sum to "Total Outlays". A program account is a `classification_desc` line under its agency (Medicaid: "Grants to States for Medicaid" under HHS, `record_type_cd` P; FY2019 $409.4 billion = OMB Table 8.5): fetch the agency's rows and match the line by name (`--values` lists up to 200 lines per column under a narrow filter) | flow | $ |
| Gross interest expense | `v2/accounting/od/interest_expense` | all rows (detail only) sum to the total; MTS leaves out the GAS "Restoration of Interest" line (FY2025 on); TIPS lines include inflation compensation, a separate GAS "Inflation Compensation" line is not TIPS (docs/datasets.md) | flow | $ |
| Outlays by budget function (Social Security 650, Medicare 570, defense 050, net interest 900 ...) | MTS Table 9 (`v1/accounting/mts/mts_table_9`) | function rows add to total outlays; a function is not CBO's program measure (Social Security 650 includes administration; CBO reports benefits; Medicare 570 is gross of some offsetting receipts CBO nets) | flow | $M |
| Individual income tax refunds | DTS Table V `v1/accounting/dts/income_tax_refunds_issued` (cash, checks + EFT, refundable credits included, Treasury Offset Program offsets excluded); MTS Table 4 refunds (budget basis: refundable credits above liability are outlays) | the two differ by tens of billions a year and peak in different months (DTS February, MTS April): name the basis | flow | $M |
| Savings bond (Series I) rates | `v1/accounting/od/i_bonds_interest_rates` | one row per earning period and issue month back to 1998: the rate announced for new bonds is the row whose issue month falls in its own earning period; the composite rate has a 0% floor (May 2009, May 2015), so the published formula does not reproduce those rows; dates are `earning_period_start` (no `record_date`) | stock (a rate) | % |
| Average interest rate on the debt | `v2/accounting/od/avg_interest_rates` | `security_desc` "Total Interest-bearing Debt", "Total Marketable" (these totals leave out TIPS and FRNs: weighting the component rates by MSPD amounts reproduces them only without those two [derived 2026-10-21]); the TIPS rate is the real coupon, without inflation compensation: not comparable with nominal rates | stock | % |
| Treasury cash (TGA) | `v1/accounting/dts/operating_cash_balance` | see trap on 2022-04-18 | stock | $M |
| Daily deposits and withdrawals | `v1/accounting/dts/deposits_withdrawals_operating_cash` | `transaction_type`, `transaction_catg` | flow | $M |
| Auction results | `v1/accounting/od/auctions_query` | completed auctions (non-null `high_yield`); `original_security_term` to include reopenings; `inflation_index_security` No for nominal notes and bonds (TIPS are `security_type` Note too); use `bid_to_cover_ratio` as published (excludes SOMA) | event | mixed |
| Exchange rates | `v1/accounting/od/rates_of_exchange` | latest `effective_date` per quarter | stock | foreign units per USD |

## Spec examples
```json
{"description": "Net interest and average rates, FY2015-FY2025",
 "as_of": "2025-09-30",
 "datasets": [
   {"name": "mts9", "endpoint": "v1/accounting/mts/mts_table_9",
    "filter": {"record_date": {"gte": "2014-09-30"}, "record_calendar_month": "09"}},
   {"name": "rates", "endpoint": "v2/accounting/od/avg_interest_rates",
    "filter": {"record_date": {"gte": "2014-10-01"}, "security_desc": ["Total Interest-bearing Debt", "Total Marketable"]}}]}
```
```json
{"description": "Debt to the penny, fiscal year ends 2015-2025", "as_of": "2025-09-30",
 "datasets": [{"name": "debt", "endpoint": "v2/accounting/od/debt_to_penny",
               "filter": {"record_date": {"gte": "2014-09-01"}}}]}
```
Per dataset: `name` (file `<name>.csv`), `endpoint`, `filter` (bare value = eq, list = in, or
`{"gte": ...}`; a string is raw API syntax), optional `fields`, `date_field` (some endpoints use
`operation_date`, `effective_date` ...), `sort`, `allow_empty`. `as_of` adds `<date_field> <= as_of` to
every dataset so reruns are reproducible; leave it out only for "latest" lookups.

## Data format and traps
Output in `<out>/data/treasury/`: `<name>.csv` (API field names, values exactly as published, "null" ->
empty), `fetch_spec.json` (query URLs, row counts, first and last date, labels, types, unit hints, SHA-256,
route) and `README.md` (data dictionary with every code column's values). Read data with `lib/tstats.load()`:
plain `pd.read_csv` turns codes into numbers ("1.10" -> 1.1, "09" -> 9) and keeps the CSV apostrophe on
negative amounts.
- **Units differ:** MTS tables 1-9, Debt to the Penny, interest expense are dollars; DTS, MSPD (`*_mil_amt`)
  and the long MTS series (`mts_receipts_outlays_deficit_surplus.mil_amt`) millions: read the field name;
  percentage fields are already percent. **Signs:** MTS Table 1 shows a deficit as positive, Table 5 negative.
- **Stocks vs flows:** debt, cash, rates take the end-of-period value or the average (`period_end`,
  `period_mean`); receipts, outlays, deficits, interest sum months (`period_sum`, check `complete`) or read the
  September fiscal-year-to-date value. Never sum year-to-date values or stock levels.
- **Hierarchies double count:** MTS mixes headers (S), details (D) and totals (T); choose one level and prove
  it with `check_unique` and `check_total` against the published total. Table 4's D rows do not sum to the
  total (use Table 9). The same letter can be a value of two code columns: filter on the column it is in.
- **One release, several periods:** MTS Table 1 holds the prior and current fiscal year blocks
  (`sequence_number_cd` 1.x and 2.x), each with its months and a "Year-to-Date" row; its only amount columns
  are `current_month_gross_rcpt_amt`, `_gross_outly_amt`, `_dfct_sur_amt` (positive = deficit). Tables 9
  and others carry `current_fytd_*` / `prior_fytd_*` columns instead.
- **Dates without a record:** Debt to the Penny and DTS have rows only on business days. For a requested
  weekend or holiday (January 20, 2025 was both Inauguration Day and a federal holiday), use the last record
  before it (its close equals the next statement's opening balance) and say so; count calendar days from
  the requested date and business days from the records, and name which one a per-day figure uses.
- **Net vs gross receipts:** MTS receipts are net of refunds. When refunds are large the two can move in
  opposite directions (FY2026 customs: gross up 57 percent, net down 11 percent after $145 billion of tariff
  refunds): show gross, refunds and net (Table 4) and say which one the headline uses.
- **Latest release wins:** MTS releases repeat and revise earlier months: build monthly series from the latest
  `record_date`, full years from September releases; the next September restates the year (FY2024's deficit
  moved by $16 billion).
- **`fields=` that drops row-identity columns makes the API group and sum rows**; fetch.py compares row
  counts with and without it and stops.
- **Filter values:** exact text, case-sensitive; a malformed date returns no rows, not an error; values with
  `&` or `,` (and parentheses inside an `in` list; `eq` with parentheses works, verified 2026-10) are
  mishandled by the API, so fetch.py applies those conditions locally (recorded as
  `local_filter`). A filter matching nothing is `fix_spec` unless `allow_empty`.
- **Format changes:** DTS operating cash changed on 2022-04-18 (before: the TGA/FRA row's `close_today_bal`;
  after: the "Closing Balance" row's `open_today_bal`); DTS categories are renamed over time. Debt to the
  Penny's held-by-public and intragovernmental fields are null before 2005-03-31.
- **Fiscal years** run October 1 to September 30, named for the year they end (`fiscal_year()`); the September
  MTS comes out mid-October. Find the latest complete period from the data (`--fields`), not from memory;
  label partial years and compare them with the same months a year earlier.
- **Real dollars and GDP:** `--context cpi|gdp --start <first FY>` writes `context_cpi.csv` / `context_gdp.csv`
  (FRED, then BLS or World Bank); `cpi_index(out, "FY")`, `deflate`, `fy_gdp` (average of four quarterly SAARs,
  Oct-Sep; refuses the calendar-year fallback). Incomplete periods are flagged: say provisional.
- **Volume vs rate questions** ("more debt or higher rates?"): `decompose()` splits the change exactly.
- Analysis helpers: `lib/tstats.py` (`load, fiscal_year, add_periods, period_end, period_sum, period_mean,
  trailing_sum, cagr, decompose, cpi_index, deflate, fy_gdp, cy_gdp, check_unique, check_total, sensitivity,
  Facts`); the shared `scripts/analysis/factfmt.py` formats (`usd_b:1` from dollars, `usd_b_scaled:1` from billions, `pct100:1` for a field already in percent, `pct:1` for a 0-1 share, `bp:0`).
  ```python
  sys.path.insert(0, r"<skill>/sources/treasury/lib"); from tstats import *
  m9 = load(OUT, "mts9")              # reads OUT/data/treasury/mts9.csv with the API's types
  ```
- **Benchmark** each headline against the official statement for the same date (MTS, MSPD, DTS, Treasury's
  press release, CBO's Monthly Budget Review; for auctions, TreasuryDirect's results files
  `https://www.treasurydirect.gov/xml/R_YYYYMMDD_n.xml`, keyless, a separate system from Fiscal Data); when the table is the statement itself, check its identities
  (components add to the total; receipts - outlays = -deficit). Statement PDFs:
  `https://fiscaldata.treasury.gov/static-data/published-reports/mts/MonthlyTreasuryStatement_YYYYMM.pdf` and
  `.../dts/DailyTreasuryStatement_YYYYMMDD.pdf`; MSPD: `.../mspd-entire/MonthlyStatementPublicDebt_Entire_YYYYMM.pdf`. The fiscaldata.treasury.gov dataset pages draw their tables
  with JavaScript: a fetch tool sees no values there (use the API or the PDFs). The PDFs are compressed:
  a web fetch tool cannot read them; save the file and extract its text locally (pypdf). The API rows are
  the statement's own figures, so an API value equal to the PDF's is a transcription check, not an
  independent one. cbo.gov refuses scripted downloads (HTTP 403), and a browser pane may only download its
  PDF: when no one can open it, record CBO's Monthly Budget Review as "not checked" in benchmark.csv (with a
  data_needs entry), or ask the user to upload the PDF.
- **Identity gaps:** in `mts_receipts_outlays_deficit_surplus`, receipts minus outlays misses the deficit line by
  a few million in some months (Sep 2022 by $10 million, Mar 2024 by $270 million, as published): use the
  deficit line for deficits, check an identity with a tolerance of a few hundred million, and tie fiscal-year
  totals to the September MTS.
- **Coverage:** MTS Tables 1 to 9 start in March 2015, so FY2015 is their first full year; a filter from an
  earlier date returns rows from 2015 on without an error. For earlier years use
  `mts_receipts_outlays_deficit_surplus` (totals from FY1981) or OMB's Historical Tables through FRED
  (`FYOINT` net interest, `FYFSD` deficit, `FYONET` outlays, in millions), and say where the series join.
  FRED carries only those totals: a receipt or outlay line before FY2015 (customs duties, a function) comes from
  OMB's Historical Tables (Table 2.5 receipts by source, 3.2 outlays by function, 10.1 GDP; FY1940 on) through
  the omb pack (`historical_table`, any budget edition); each edition revises history, so name the edition.

## Access
- No key, no registration, GET only, no documented rate limit (the client keeps 4 requests a second and
  backs off on 429/5xx). Pages of up to 10,000 rows; fetch.py pages and checks the row count against
  `total-count`.
- Routes (`--check`, shared names): `reuse_existing`; `api` (the API answers; also a row count per dataset);
  `fix_spec` (a filter matches no rows or names an unknown field: see `dataset_counts`, check values with
  `--fields ... --values`); `report_error` (the user's own machine cannot reach the API: internet, VPN, proxy
  `HTTPS_PROXY`; a bundle with curl and PowerShell commands is written as the other option); `cloud_allowlist`
  (allow `api.fiscaldata.treasury.gov` and restart, or download by hand); `manual_download` (sandbox).
- Manual download: `<out>/manual_download/treasury/INSTRUCTIONS.md` has one CSV link per dataset (10,000 rows
  each; more pages with `page%5Bnumber%5D=2` saved as `<name>_2.csv` ...), curl and PowerShell lines, and the
  dataset page whose Download button gives the whole table. Upload the CSV or ZIP files unchanged (not
  re-saved in Excel); `--ingest <files>` with the uploaded files or their folder applies the spec's
  filter locally, strips the apostrophe guard, drops duplicate rows and warns about a missing page.
- Exit codes: 0 ok; 2 spec or API error (bad field, filter, endpoint, aggregation); 3 unexpected; 4 the API
  cannot be reached (follow the printed route; never invent or recall numbers).

## Citation and terms
"U.S. Department of the Treasury, Bureau of the Fiscal Service, Fiscal Data (https://fiscaldata.treasury.gov),
<endpoints>; retrieved <date> through the Fiscal Data API." (exact line in `data/treasury/README.md`). Source
line: "Analyst calculations using data from the Department of the Treasury, Bureau of the Fiscal Service,
Monthly Treasury Statement (retrieved <date>)." Public domain: redistribution allowed; cite the retrieval
date because Treasury revises some series.
