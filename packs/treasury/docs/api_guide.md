# U.S. Treasury Fiscal Data API guide

The pack's `fetch.py` and `treasury_api.py` already implement paging, filters, retries, the
row-count check and the `fields=` aggregation guard. Read this file to choose endpoints and rows, to
interpret fields, and when debugging. Contents: 1 API basics · 2 Catalog · 3 Key endpoints · 4 Gotchas ·
5 Manual download · 6 Recipes.

Researched 2026-10-19. Facts marked **[live]** were checked with real HTTP calls (Python urllib) on that date. Facts marked **[docs]** come from https://fiscaldata.treasury.gov/api-documentation/. Facts marked **[unverified]** could not be confirmed. The data values below are as served on 2026-10-19.

---

## 1. API basics

| Item | Value |
|---|---|
| Base URL | `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/` **[live]** |
| Full URL | base + endpoint, e.g. `.../fiscal_service/v2/accounting/od/debt_to_penny` |
| Versions | Each endpoint has one fixed version, `v1` or `v2`. You cannot swap them: `v1/accounting/od/debt_to_penny` returns 404, and `v3/...` returns 404. Of the 180 endpoints, 159 are v1 and 21 are v2. **[live]** Take the version from the catalog (`endpoint_txt`). |
| Auth | None. No key, no registration. **[docs+live]** The docs list `403 "API Key is not valid"` but no key exists. |
| Methods | GET only. CORS is `Access-Control-Allow-Origin: *`. **[live]** |
| Rate limits | None documented. 60 requests at 10 concurrent all returned 200 in 4 s, with no rate-limit or Retry-After headers. **[live]** Still keep concurrency at about 4 or less and back off on 429/5xx; whether there is a hidden limit is **[unverified]**. |
| Default page | `page[number]=1`, `page[size]=100` **[live]** |
| Max page size | **10000**. `page[size]=10001` returns 400: `"Limit '10001' is invalid. Expected an integer between 1 and 10000."` **[live]** 10,000 DTS rows came back as about 5.4 MB of JSON in about 3.5 s. |
| Default sort | The first column ascending, usually `record_date`, so oldest rows come first. **[docs+live]** Use `sort=-record_date` to get the latest. |

### Query parameters
- **`fields=`**: a comma-separated list of columns, e.g. `fields=record_date,tot_pub_debt_out_amt`. See the aggregation gotcha in section 4. Unknown field: 400 `Field 'foo' does not exist`.
- **`filter=`**: `field:op:value`. Combine conditions with commas, which act as AND:
  `filter=record_date:gte:2024-01-01,record_date:lte:2024-12-31,security_type_desc:eq:Marketable`
  - Operators: `eq`, `lt`, `lte`, `gt`, `gte`, `in`. **[docs+live]** There is no `neq`, `like` or `contains` (each returns 400 `Operator ':neq:' is not supported.`). There is no OR across fields.
  - `in` takes a parenthesised list: `filter=record_date:in:(2024-01-02,2024-01-03)` or `classification_desc:in:(National Defense,Medicare)`. **[live]**
  - Dates use `YYYY-MM-DD`. A bad date value such as `eq:notadate` returns **200 with empty data**, not an error. **[live]**
  - Numeric comparisons on currency/number strings compare numerically. `tot_pub_debt_out_amt:gte:30000000000000` correctly returns 2022-01-31 first. **[live]**
  - Values that contain commas or parentheses still work with `eq` when URL-encoded (e.g. `classification_desc:eq:Education, Training, Employment, and Social Services` and `account_type:eq:Treasury General Account (TGA) Closing Balance`). **[live]** Always URL-encode the value.
  - Null matching: `filter=debt_held_public_amt:eq:null` matches the literal string "null". **[live]**
  - **Repeating `filter=` does not combine.** Only the last one is applied, silently. **[live]** Put every condition in one `filter=` with commas.
- **`sort=`**: `sort=-record_date,src_line_nbr` sorts by several keys; `-` means descending. **[docs+live]** Unknown field: 400.
- **`format=`**: `json` (default), `csv`, `xml`. **[live]** An unsupported value such as `format=xlsx` silently returns JSON. CSV comes back as `text/csv` with `content-disposition: attachment; filename=<timestamp>.csv`. CSV has **no meta or links block**, so you lose total-count and must page blindly. It respects `page[size]`, and nulls appear as `"null"`. XML uses `<root-element><data><data-element>...`.
- **`page[number]=`, `page[size]=`**: page numbers start at 1. A page number past the end returns 400 `Page #99999 is out of range.` **[live]** URL-encoding the brackets (`page%5Bsize%5D`) also works.

### JSON response shape [live]
```json
{"data":[{"record_date":"2026-10-15","tot_pub_debt_out_amt":"40388317675071.91", ...}],
 "meta":{"count":1,                 // rows on this page
         "labels":{"record_date":"Record Date", ...},     // pretty names
         "dataTypes":{"record_date":"DATE","tot_pub_debt_out_amt":"CURRENCY", ...},
         "dataFormats":{"record_date":"YYYY-MM-DD","tot_pub_debt_out_amt":"$10.20", ...},
         "total-count":8414, "total-pages":8414},
 "links":{"self":"&page%5Bnumber%5D=1&page%5Bsize%5D=1","first":"...","prev":null,
          "next":"&page%5Bnumber%5D=2&page%5Bsize%5D=1","last":"&page%5Bnumber%5D=8414&page%5Bsize%5D=1"}}
```
- `links.*` are **query-string fragments that start with `&`**, not full URLs, and they hold only the page parameters, not your filter, sort or fields. **[live]** Do not follow them blindly; build the next URL yourself.
- No `Link` HTTP header was observed, although the docs mention one. **[live]**

### Getting all rows
`fetch.py` pages with `page[size]=10000`, sorts by the date column plus `src_line_nbr` (a tiebreaker keeps
pages stable), and checks the row count against `meta.total-count`. Some tables are huge:
`treasury_offset_program` has 3.5M rows, `utf_*` 2.4M and `fip_statement_of_account_table3` 2.2M. Always
filter by date, and check the catalog `row_count` (`fetch.py --search`) first.

### Data types (`meta.dataTypes`) and formats [live]
Every value is a **JSON string**, including numbers, and nulls are the string `"null"`. **[docs+live]**

| dataType | dataFormat hint | Meaning / parse |
|---|---|---|
| `DATE` | `YYYY-MM-DD` | date |
| `CURRENCY` | `$10.20` | dollars with cents → Decimal/float |
| `CURRENCY0` | `$1,000,000` | whole units. **In DTS this means millions of dollars**; MSPD `*_mil_amt` is millions with decimals |
| `CURRENCY1`, `CURRENCY3`, `CURRENCY9` | n/a | currency with 1, 3 or 9 decimals (rare) |
| `NUMBER` | `10.2` | float |
| `INTEGER` | `10` | int |
| `PERCENTAGE`, `PERCENTAGE_PRECISE` | `10.2%` | **already in percent units** (`"3.870"` means 3.87%) |
| `YEAR`/`QUARTER`/`MONTH`/`DAY` | `YYYY`/`Q`/`MM`/`DD` | strings; MONTH/DAY are zero-padded (`"09"`) |
| `STRING` | `String` | text; some carry trailing spaces (TOP `agency_id: "7 "`) |

Counts across the whole catalog: STRING 765, CURRENCY 451, YEAR 354, QUARTER 298, DATE 242, NUMBER 233, INTEGER 176, MONTH 151, DAY 149, CURRENCY0 129, PERCENTAGE 24, CURRENCY3 7, CURRENCY1 5, CURRENCY9 2, PERCENTAGE_PRECISE 2, and null 222 (no type in the catalog).

### Errors [live]
| Case | HTTP | Body |
|---|---|---|
| Unknown field in fields, filter or sort | 400 | `{"error":"Invalid Query Param","message":"Invalid query parameter: Field 'foo' does not exist. For more information, please see the documentation."}` |
| Unsupported operator | 400 | `... Operator ':like:' is not supported. ...` |
| page[size] > 10000 | 400 | `... Limit '10001' is invalid. Expected an integer between 1 and 10000. ...` |
| Page out of range | 400 | `... Page #99999 is out of range. ...` |
| Wrong endpoint or version | 404 | **HTML page** ("404 Error: The requested page could not be found"), not JSON. Do not call `json.loads` before checking the status. |
| Bad filter value (e.g. a malformed date) | 200 | empty `data`, `total-count: 0` |
| Documented but not seen | 403 "API Key is not valid", 500 | **[docs]** |

---

## 2. Machine-readable catalog: YES

**`GET https://api.fiscaldata.treasury.gov/services/dtg/metadata/`** **[live]** returns a JSON array of **56 datasets** (about 1.3 MB) covering **180 endpoints with a non-null endpoint_txt, all of which returned 200 to `page[size]=1` [live]**. The site's own JS also uses it. The `?dataset_id=` parameter is ignored and the full list is always returned.

```
[ { dataset_id: "015-BFS-2014Q1-13",          # MTS; DTS="015-BFS-2014Q1-03"; Debt to Penny="015-BFS-2014Q3-065"
    title, short_description, long_description, notes_and_known_limitations,   # markdown text
    publisher, update_frequency ("Daily"|"Monthly"|"Quarterly"|"Semi-Annually"|"Annually"|"As Needed"|"... (Discontinued)"),
    metadata_complete, dataset_path ("monthly-treasury-statement"  -> website slug),
    pdf_path, master_static_filename ("MTS_all_tables" or null), popularity_rank (1 = most popular),
    apis: [ { api_id, table_name, table_description, row_definition, update_frequency,
              last_updated "YYYY-MM-DD", earliest_date, latest_date, row_count,
              api_sort_order_nbr, endpoint_txt "/services/api/fiscal_service/v1/accounting/mts/mts_table_1",
              static_filename, api_notes_and_limitations,
              fields: [ { column_name, definition, table_name, pretty_name,
                          data_type ("DATE","CURRENCY",...), is_required, sort_order_nbr } ] } ] } ]
```
- It has per-table fields with definitions, frequency, earliest and latest date, row count and last-updated date. That is enough to drive endpoint discovery, field validation and staleness checks.
- A few `apis` entries have `endpoint_txt: null`: "(Updated)" variants, Monthly Treasury Disbursements, Combined Statement, and Account of Receipts and Expenditures. These are website-only or file-only. Skip them.
- **`/services/dtg/metadata/summary`** **[live]**: a lighter array of 56 entries `{dataset_id, short_description, long_description, apis:[{api_id,last_updated,earliest_date,latest_date}]}`. Use it as a cheap freshness check.
- **`/services/dtg/publishedfiles?dataset_id=<id>`** **[live]**: a list of published report files `[{report_date, path:"/static-data/published-reports/mts/MonthlyTreasuryStatement_202609.pdf", report_group_desc, report_group_id, ...}]`. Prefix the path with `https://fiscaldata.treasury.gov`. For MTS this goes back to 1954-02-28 as PDFs, so it is useful for citing the official PDF.
- The docs page also has a "List of Endpoints" table ("179 rows" per the docs). It is rendered from the same data, so use the metadata endpoint instead.
- Separately, the Fiscal Service Data Registry (fiscal.treasury.gov/data-registry) holds element definitions. It is not needed.

---

## 3. Key endpoints (all verified live with `page[size]=1`)

Paths are relative to the base URL. "Start" is the catalog `earliest_date`. Units: $ = dollars and cents; $M = millions.

| Dataset (slug) | Endpoint | Freq | Start | Holds / key fields |
|---|---|---|---|---|
| Debt to the Penny (`debt-to-the-penny`) | `v2/accounting/od/debt_to_penny` | Daily (business days) | 1993-04-01 | `record_date, debt_held_public_amt, intragov_hold_amt, tot_pub_debt_out_amt` ($). DHP and intragov are "null" through 2005-03-30. |
| Historical Debt Outstanding (`historical-debt-outstanding`) | `v2/accounting/od/debt_outstanding` | Annual | 1790-01-01 | `record_date, debt_outstanding_amt` ($). Early years are dated Jan 1; recent ones are dated Sep 30 (fiscal year end). |
| MTS (`monthly-treasury-statement`) Table 1 | `v1/accounting/mts/mts_table_1` | Monthly | 2015-03-31 | Summary of receipts, outlays and deficit by month: `current_month_gross_rcpt_amt, current_month_gross_outly_amt, current_month_dfct_sur_amt` ($) + hierarchy cols |
| MTS Table 2 | `v1/accounting/mts/mts_table_2` | Monthly | 2015-03-31 | Budget and off-budget results, financing |
| MTS Table 3 | `v1/accounting/mts/mts_table_3` | Monthly | 2015-03-31 | Summary receipts and outlays |
| MTS Table 4 | `v1/accounting/mts/mts_table_4` | Monthly | 2015-03-31 | Receipts: `current_month_{gross_rcpt,refund,net_rcpt}_amt`, `current_fytd_*`, `prior_fytd_*` ($) |
| MTS Table 5 | `v1/accounting/mts/mts_table_5` | Monthly | 2015-03-31 | Outlays by agency, bureau and program: `current_month_{gross_outly,app_rcpt,net_outly}_amt`, `current_fytd_*`, `prior_fytd_*` ($). About 810 rows per month. |
| MTS Table 5m | `v1/accounting/mts/mts_table_5m` | Monthly | 2015-03-31 | Receipts offset against outlays |
| MTS Table 6, 6a–6e | `v1/accounting/mts/mts_table_6` … `mts_table_6e` | Monthly | 2015-03-31 | Means of financing, agency borrowing, investments, loan financing |
| MTS Table 7 | `v1/accounting/mts/mts_table_7` | Monthly | 2015-03-31 | Receipts and outlays by month, Oct to Sep across the FY |
| MTS Table 8 | `v1/accounting/mts/mts_table_8` | Monthly | 2015-03-31 | Trust fund impact |
| MTS Table 9 | `v1/accounting/mts/mts_table_9` | Monthly | 2015-03-31 | Receipts by source and outlays by function: `current_month_rcpt_outly_amt, current_fytd_rcpt_outly_amt, prior_fytd_rcpt_outly_amt` ($). 33 rows per month. |
| MTS Table 9 subfunctions | `v1/accounting/mts/mts_table_9_outlays_functions_subfunctions` | Monthly | 2015-03-31 | Outlays by function and subfunction |
| MTS long history | `v1/accounting/mts/mts_receipts_outlays_deficit_surplus` | Monthly | **1980-10-31** | `record_date, amt_category` (Receipts / Outlays / Deficit/Surplus (-) / Borrowing from the Public / Reduction of Operating Cash / By Other Means), `mil_amt` (**$M**). The simplest monthly deficit series. |
| MTS distributed offsetting receipts | `v1/accounting/mts/mts_distributed_offsetting_receipts` | Monthly | 2024-10-31 | |
| DTS (`daily-treasury-statement`) Operating Cash Balance | `v1/accounting/dts/operating_cash_balance` | Daily | 2005-10-03 | `account_type, close_today_bal, open_today_bal, open_month_bal, open_fiscal_year_bal` (**$M**), `table_nbr, table_nm, sub_table_name`. See the 2022 change in section 4. |
| DTS Deposits and Withdrawals | `v1/accounting/dts/deposits_withdrawals_operating_cash` | Daily | 2005-10-03 | `account_type, transaction_type` (Deposits/Withdrawals), `transaction_catg, transaction_catg_desc, transaction_today_amt, transaction_mtd_amt, transaction_fytd_amt` (**$M**) |
| DTS Public Debt Transactions | `v1/accounting/dts/public_debt_transactions` | Daily | 2005-10-03 | `transaction_type` (Issues/Redemptions), `security_market, security_type, security_type_desc, transaction_{today,mtd,fytd}_amt` ($M) |
| DTS Adjustment to cash basis | `v1/accounting/dts/adjustment_public_debt_transactions_cash_basis` | Daily | 2005-10-03 | |
| DTS Debt Subject to Limit | `v1/accounting/dts/debt_subject_to_limit` | Daily | 2005-10-03 | `debt_catg, debt_catg_desc, close_today_bal, open_today_bal, open_month_bal, open_fiscal_year_bal` ($M) |
| DTS Income Tax Refunds | `v1/accounting/dts/income_tax_refunds_issued` | Daily | 2005-10-03 | |
| DTS Federal Tax Deposits | `v1/accounting/dts/federal_tax_deposits` | Daily | 2005-10-03 | **Ends 2023-02-13** |
| DTS Short-Term Cash Investments | `v1/accounting/dts/short_term_cash_investments` | Daily | 2005-10-03 | **Ends 2023-02-13** |
| DTS Inter-Agency Tax Transfers | `v1/accounting/dts/inter_agency_tax_transfers` | Daily | **2023-02-14** | |
| Average Interest Rates (`average-interest-rates-treasury-securities`) | `v2/accounting/od/avg_interest_rates` | Monthly | 2001-01-31 | `security_type_desc` (Marketable / Non-marketable / Interest-bearing Debt), `security_desc`, `avg_interest_rate_amt` (PERCENTAGE, in %). Includes "Total Marketable", "Total Non-marketable" and "Total Interest-bearing Debt" rows; "Total Marketable" leaves out TIPS and FRNs. |
| Interest Expense (`interest-expense-debt-outstanding`) | `v2/accounting/od/interest_expense` | Monthly | 2010-05-31 | `expense_catg_desc, expense_group_desc, expense_type_desc, month_expense_amt, fytd_expense_amt` ($). Detail rows only, with no total rows seen. |
| Rates of Exchange (`treasury-reporting-rates-exchange`) | `v1/accounting/od/rates_of_exchange` | Quarterly | 2001-03-31 | `country, currency, country_currency_desc` (e.g. `Euro Zone-Euro`), `exchange_rate` (**foreign units per 1 USD**), `effective_date`. About 170 rows per quarter. Also `rates_of_exchange_source`. |
| MSPD (`monthly-statement-public-debt`) | `v1/debt/mspd/mspd_table_1` (summary), `_2` (statutory limit), `_3`, `_3_market`, `_3_nonmarket` (CUSIP detail), `_4`, `_5` (STRIPS) | Monthly | 2001-01-31 | Table 1: `security_type_desc, security_class_desc, debt_held_public_mil_amt, intragov_hold_mil_amt, total_mil_amt` (**$M**). 3_market: `security_class2_desc` (CUSIP), `interest_rate_pct, yield_pct, issue_date, maturity_date, issued_amt, outstanding_amt` ($M). |
| Auctions (`treasury-securities-auctions-data`) | `v1/accounting/od/auctions_query` | As needed | 1979-11-15 | About 120 cols: `record_date` (= issue date), `cusip, security_type, security_term, auction_date, issue_date, maturity_date, offering_amt, high_yield, high_discnt_rate, high_investment_rate, int_rate, bid_to_cover_ratio, total_tendered, total_accepted, primary_dealer_accepted, direct_bidder_accepted, indirect_bidder_accepted, soma_accepted, reopening, ...` |
| Upcoming Auctions | `v1/accounting/od/upcoming_auctions` | As needed | 2024-03-08 | |
| Record-Setting Auction (`record-setting-auction-data`) | `v2/accounting/od/record_setting_auction` | As needed | snapshot (20 rows) | `security_type, security_term, low_rate_pct, first_auc_date_low_rate, high_rate_pct, high_offer_amt, high_bid_cover_ratio, ...`. A snapshot: record_date = today. |
| Gift Contributions (`gift-contributions-reduce-debt-held-by-public`) | `v2/accounting/od/gift_contributions` | Monthly | 1996-09-30 | `record_date, contribution_amt` ($) |
| Schedules of Federal Debt | `v1/accounting/od/schedules_fed_debt`, `..._fytd`; daily: `schedules_fed_debt_daily_activity`, `..._daily_summary` | Monthly/Daily | 2005-10-31 | $M; lags about 1 month |
| Revenue Collections (`revenue-collections-management`) | `v2/revenue/rcm` | Daily | 2004-10-01 | `electronic_category_desc, channel_type_desc, tax_category_desc, net_collections_amt` ($) |
| TROR (`treasury-report-on-receivables`) | `v2/debt/tror` | Quarterly | 2016-12-31 | Per agency × receivable type, about 230 `*_amt` / `*_cnt` columns. Also `v2/debt/tror/data_act_compliance` (120-day referral compliance). |
| Treasury Offset Program (`top-treasury-offset-program`) | `v1/debt/treasury_offset_program` | Monthly | 2010-10-01 | 3.5M rows: `record_date, net_offset_cnt, net_offset_amt, agency, payment_type, debt_category, state_cd, fiscal_year, ...`. Filter it. |
| Judgment Fund (`judgment-fund-report-to-congress`) | `v2/payments/jfics/jfics_congress_report` | Annual | 2009-09-30 | Per payment: `defendant_agency_nm, judgment_type_cd, payment_sent_dt, confirmed_payment_amt, principal_amt, attorneys_fee_amt, interest_amt, ...` |
| Federal Credit Similar Maturity Rates (`fed-credit-similar-maturity-rates`) | `v1/accounting/od/federal_maturity_rates` | Annual | 1992-09-30 | `one_year_or_less, between_1_and_5_years, between_5_and_10_years, between_10_and_20_years, twenty_years_or_greater` (NUMBER, %) |
| Savings Bonds Value Files | `v2/accounting/od/sb_value` | Semi-annual | 1992-05-31 | **No `record_date`.** Columns: `redemp_period, redemption_year, redemption_month, series_cd, issue_year, issue_jan_amt ...` |
| I Bonds Interest Rates | `v1/accounting/od/i_bonds_interest_rates` | Semi-annual | 1998-09-01 | **No `record_date`.** Columns: `earning_period, earning_period_start, ..., fixed_rate, semi_annual_inflation_rate, combined_rate` |
| Savings Bonds Issues/Redemptions | `v1/accounting/od/savings_bonds_report`, `savings_bonds_pcs`, `savings_bonds_mud` | Monthly | 1998–2019 | report: `series_cd, bonds_issued_cnt, bonds_redeemed_cnt, bonds_out_cnt, ...` |
| Accrual Savings Bonds Redemption Tables | `v2/accounting/od/redemption_tables` | discontinued 2023-05 | 1999-03-31 | no record_date |
| U.S. Treasury-Owned Gold | `v2/accounting/od/gold_reserve` | Monthly | 2012-01-31 | `facility_desc, form_desc, location_desc, fine_troy_ounce_qty, book_value_amt` |
| TIPS and CPI | `v1/accounting/od/tips_cpi_data_detail`, `..._summary` | Monthly | 1998/2008 | no record_date (`index_date`, `cusip`) |
| Financial Report of the U.S. Government | `v2/accounting/od/statement_net_cost`, `v2/accounting/od/balance_sheets`, `v1/accounting/od/{net_position,social_insurance,long_term_projections,...}` | Annual | 1995+ | |
| Treasury Bulletin | `v1/accounting/tb/{pdo1_...,ofs1_...,ofs2_estimated_ownership_treasury_securities,ffo5_internal_revenue_by_state,...}` | Quarterly | 2021 | ownership of Treasuries (OFS-2), receipts by state (FFO-5) |
| Buybacks | `v1/accounting/od/buybacks_operations`, `buybacks_security_details` | As needed | 2000-03-09 | date column is `operation_date` (no record_date) |
| Others in the catalog | Treasury Certified Interest Rates (`tcir_*`), SLGS (`slgs_*`), FRN daily indexes, Federal Investments/Borrowings Program (`fip_*`, `fbp_*`), UTF (`utf_*`, which use `eff_date`), Treasury Managed Accounts (`tma_*`), Title XII advances, Receipts by Department, Electronic Securities Transactions (`securities_*`), Trust-fund reports | | | Use the catalog |

Endpoints without `record_date` (sorting or filtering on it gives 400): `buybacks_*` (`operation_date`), `i_bonds_interest_rates`, `sb_value`, `redemption_tables`, `tips_cpi_data_*`, `utf_*` (`eff_date`). **[live/catalog]** Read the catalog `fields` to find the date column.

---

## 4. Gotchas (all verified live unless marked)

**Values and units**
1. **Every value is a string**, and nulls are the literal string `"null"` in JSON, CSV and XML. Convert with a helper (`None if v == "null" else Decimal(v)`). D rows (data_type_cd "D") can also have "null" amounts, e.g. MTS Table 4 "Individual Income Taxes" header-like detail rows.
2. **Units differ by dataset.** Debt to the Penny, Historical Debt, MTS tables 1–9, interest expense, gift contributions and RCM are in **dollars and cents** (e.g. `"404371348973.70"` = $404.4B). **DTS (all tables) is in millions** (CURRENCY0, "rounded to the nearest million"). MSPD `*_mil_amt` and `mts_receipts_outlays_deficit_surplus.mil_amt` are **millions**. Check `meta.dataTypes` and the field name (`mil_`). Percentages are already in percent.
3. **Deficit sign conventions conflict.** MTS Table 1 `current_month_dfct_sur_amt` is **positive for a deficit and negative for a surplus** (per the field definition and data: April shows a negative value). `mts_receipts_outlays_deficit_surplus` "Deficit/Surplus (-)" is also positive for a deficit. MTS Table 5's "Total Surplus (+) or Deficit (-)" row is **negative for a deficit** (-1,992,473,224,352.42 for FY2026).

**Fiscal year and dates**
4. The fiscal year runs Oct 1 to Sep 30. `record_fiscal_year` is the FY of `record_date` (e.g. 2026-10-15 is FY 2027, Q1). `record_date` = "the date that data was published", which for MTS is the month-end the statement covers.
5. **MTS Table 1 repeats history at every record_date.** Each monthly release has a "FY prior" block and a "FY current" block with every month so far (28 rows in the Sept 2026 release). So `filter=classification_desc:eq:October,record_fiscal_year:eq:2026` returns 24 rows: 12 releases × 2 FYs. To get the FY a month belongs to, follow `parent_id` to the `S` row whose `classification_desc` is "FY 2026". To build a monthly series, take **only the latest record_date** (it carries revised values), or take the current-FY block from each release.
6. **Revisions happen.** October 2025 outlays were 688,721,399,756.50 in the Oct–Dec 2025 releases and 688,704,092,972.07 from the Jan 2026 release onward. The latest release wins. `classification_id` changes in every publication (per its definition), so do not join across record_dates on it; join on `src_line_nbr`, `classification_desc` or `line_code_nbr` instead (those are stable **[unverified]** across years).
7. Several MTS tables carry `current_month_*`, `current_fytd_*` and `prior_fytd_*`. Do not sum fytd values across months.

**MTS hierarchy and double counting**
8. Hierarchy columns: `parent_id` (the parent's classification_id, or "null" at the top), `classification_id`, `classification_desc`, `table_nbr`, **`src_line_nbr`** (the row number on the printed MTS table, i.e. the print line; integer, 1..N within a table and release), `print_order_nbr`, `line_code_nbr` (10, 20, 30… sequence), `sequence_level_nbr` (depth 1–5), `sequence_number_cd` (an outline number such as `1.3.2`).
   - `data_type_cd`: **D** = detail, **S** = sub-header (amounts "null"), **T** = total.
   - `record_type_cd`: Table 1 MTH = month, SL = special line. Table 4 RSG = receipt source group, SRS = source sub-row. Table 5 A = Agency, B = Bureau, BG = Bureau Group, C = Chapter, P = Program, SL = Special Line, UOR/UORG = undistributed offsetting receipts. Table 9 F = Function, RSG, SL.
   - In DTS and Debt to the Penny, `src_line_nbr` is likewise the row on the published report.
   - The same letter can be a value of two code columns (`T` is a `data_type_cd`; Table 1's totals have `record_type_cd` SL). Filter on the column the value is in; `fetch.py --fields <ep> --filter … --values` shows the combinations.
   - **Table 1 holds two fiscal years per release** [live, 2026-09-30 release]: block 1 = prior FY (S header "FY 2025", 12 MTH rows, a "Year-to-Date" row with `record_type_cd` SL and `data_type_cd` T, `sequence_number_cd` 1.13), block 2 = current FY (the same, 2.x). The September release's 2.13 row is the current fiscal year as first published; the next September's 1.13 row is the same year as revised. Check: receipts − outlays = −deficit on every Year-to-Date row.
   - Generally, one release can carry several periods, as columns (`current_month_*`, `current_fytd_*`, `prior_fytd_*`; DTS today / mtd / fytd) or as row blocks (Table 1). A failing `check_unique` on (record_date, classification_desc) is the usual symptom.
9. **Summing all rows double counts.** Table 9 for Sep 2026 has 33 rows: a "Receipts" S header, 9 RSG D rows (6 top-level sources plus the 3 children of the Social Insurance S header), a "Total" T row, a "Net Outlays" S header, 19 function D rows, and a "Total" T row. Use `data_type_cd == "D"` for components and the `T` row named "Total" for totals. Table 5: the sum of all D rows exactly equals the "Total Outlays" T row (7,395,799,983,313.23), but adding the T rows ("Total--Department of ...", "Total On-Budget"/"Off-Budget", "Total Surplus...") inflates it about 4×. **Table 4 is different**: its D rows do not sum to total receipts, because some components only carry amounts on T rows (e.g. "Total -- Individual Income Taxes"). Read the T/SL rows "Total -- Receipts", "Total -- On-Budget" and "Total -- Off-Budget" instead. For receipts by source, prefer Table 9.
10. **The `fields=` subset aggregates.** If the fields you request leave out columns that make rows unique, the API **groups and sums**. Examples: `mts_table_9?fields=record_date,current_month_rcpt_outly_amt&filter=record_date:eq:2026-09-30` returned one row of 2,285,298,771,157.00, which is receipts + outlays + totals all double-summed. DTS `fields=record_date,transaction_type,transaction_today_amt` returned Deposits 898,351, which is the details plus the "Total Deposits" row (449,175 × 2). The docs mention this. Debt to the Penny with `fields=record_fiscal_year,tot_pub_debt_out_amt` did *not* aggregate, so the behavior varies by table. **Rule: always include record_date and the row-identity columns (`src_line_nbr` or the description columns) in `fields`, or omit `fields`.**

**DTS structure changes**
11. **Operating Cash Balance changed format on 2022-04-18** (first "Treasury General Account (TGA) Closing Balance" row). Before: one row per account (`Federal Reserve Account` until 2021-09-30, then `Treasury General Account (TGA)` from 2021-10-01, plus `Supplementary Financing Program Account` and `Short-Term Cash Investments (Table V)`), with `close_today_bal` = the closing balance. From 2022-04-18 there are 4 rows: "Treasury General Account (TGA) Opening Balance", "Total TGA Deposits (Table II)", "Total TGA Withdrawals (Table II) (-)" and "Treasury General Account (TGA) Closing Balance". **`close_today_bal` is "null"** and the day's amount is in **`open_today_bal`**, which acts as a "today" column; open_month_bal and open_fiscal_year_bal act as MTD and FYTD. A TGA balance series must switch logic at 2022-04-18: before, the TGA/FRA row's `close_today_bal`; after, the "Closing Balance" row's `open_today_bal`.
12. In DTS Deposits/Withdrawals, from 2022-04-18 there are extra total rows with `account_type` "Treasury General Account Total Deposits" / "... Total Withdrawals" (`transaction_catg` "null"). Detail rows have `account_type` "Treasury General Account (TGA)". Before that, account_type was "Federal Reserve Account" and there were also "Short-Term Cash Investments" rows. Detail sums differ from the totals by about ±1 (rounding to millions). The category text changed too: "Public Debt Cash Issues (Table III-B)" became "(Table IIIB)". Deposits and withdrawals include gross **Public Debt Cash Issues/Redemptions**; exclude these for "operating" flows. Match categories with fuzzy or normalized text.
13. Federal Tax Deposits and Short-Term Cash Investments tables end 2023-02-13; Inter-Agency Tax Transfers starts 2023-02-14. The DTS notes say DTS debt figures are in millions and **do not total TPDO**. Use Debt to the Penny for total debt.
14. Debt totals differ by dataset because of FFB debt and rounding. Debt to the Penny is to the cent, while MSPD, DTS and Schedules of Federal Debt are in millions, and Schedules excludes FFB debt (per the catalog's TPDO disclaimer).

**Filter values with special characters** [live, 2026-10-20]
10a. A filter value containing `&` or `,` matches nothing, even URL-encoded (`interest_expense` "Foreign Series Notes & Bonds": 0 rows, 2 exist). Inside `in:(...)` a value with `,` or parentheses is **silently dropped** ("Treasury Floating Rate Notes (FRN)" in a list: 1 row instead of 4). `eq` with parentheses works. `fetch.py` applies such conditions locally instead (it downloads under the rest of the filter, then applies them; README and `fetch_spec.json` record it as `local_filter`). In hand-written API URLs, leave such values out and filter afterwards.

**CSV output**
15a. **API CSV prefixes negative numbers with an apostrophe** (`'-334128106.88`), a spreadsheet formula-injection guard. JSON does not. `fetch.py --ingest` and `tstats.load()` strip it; any other CSV reader would turn every negative value into text or NaN. [live]

**Other**
15. FX: a quarter can have **several rows per currency**. Amendments keep the quarter's `record_date` but have a later `effective_date` (102 such rows since 2023, e.g. Argentina-Peso effective 2023-05-15 under record_date 2023-03-31). Deduplicate on (country_currency_desc, record_date) by taking the max effective_date, or filter on effective_date.
16. Auctions: `record_date` is the issue date, and upcoming or announced auctions appear with "null" results (`high_yield`, `bid_to_cover_ratio`, ...). Filter `auction_date:lte:<today>` or drop rows where results are null. Some numeric-looking columns are typed STRING (`price_per100`, `high_price`).
17. Record-Setting Auction is a snapshot table, and its record_date is the refresh date.
18. A single endpoint can be huge. Check the catalog `row_count` before pulling and use date filters.
19. A non-JSON error page (HTML 404) is possible, so check the status before parsing.
20. Treasury Bulletin, Financial Report and Judgment Fund are annual or quarterly and lag by months. Always report `latest_date` from the catalog or the data rather than assuming the data is current.

---

## 5. Website and manual download fallback

- **Dataset page URL pattern:** `https://fiscaldata.treasury.gov/datasets/<dataset_path>/`, where `dataset_path` comes from the catalog. Examples: `/datasets/monthly-treasury-statement/`, `/datasets/daily-treasury-statement/`, `/datasets/debt-to-the-penny/`, `/datasets/average-interest-rates-treasury-securities/`, `/datasets/treasury-reporting-rates-exchange/`, `/datasets/historical-debt-outstanding/`, `/datasets/monthly-statement-public-debt/`, `/datasets/treasury-securities-auctions-data/`, `/datasets/interest-expense-debt-outstanding/`. The MTS page fetched live (200).
- **Download button:** each dataset page has a "Download" panel. You choose one table or "All Data Tables", a date range and a format (**CSV, JSON or XML**), and the result is a **zip** for multi-table or large requests. From the site JS (**[live]**, read from the source; the end-to-end flow was **[unverified]**): the browser opens a WebSocket to `wss://downloads.fiscaldata.treasury.gov/main`, sends {apiIds, dateRange, fileTypes}, polls `https://fiscaldata.treasury.gov/static-data/downloads/zip/<requestToken>/status.json`, then downloads `https://fiscaldata.treasury.gov<final_file_name>`. Zip names derive from `master_static_filename` (e.g. `MTS_all_tables`, `DTS_all_tables`, `MSPD_all_tables`). This is **not a stable direct-file URL**, so it suits manual use only.
- The "API Quick Guide" CSV link on dataset pages is just `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/<endpoint>?format=csv` (from the site JS), so it returns only the first 100 rows unless the user adds `&page[size]=10000&page[number]=N`.
- CSV from the website versus the API: website downloads are whole-table or date-range files with no pagination limit, and their headers use the **same snake_case column names** with "null" strings. The site may also offer pretty-name headers **[unverified]**. API CSV is paginated, has no meta, and its filename is a timestamp.
- **Published PDFs** (the official statements) can be listed with `/services/dtg/publishedfiles?dataset_id=<id>` and live at `https://fiscaldata.treasury.gov/static-data/published-reports/...`. The MTS PDF for 2026-09 returned a binary PDF **[live]**.
- **Fallback instruction for users without API access:** "Open https://fiscaldata.treasury.gov/datasets/<slug>/, click *Download*, choose the table, date range and *CSV*, unzip, and give the CSV path to the skill." The skill should accept those CSVs: same column names, values as strings, "null" for missing.

---

## 6. Recipes

- Latest debt: `v2/accounting/od/debt_to_penny?sort=-record_date&page[size]=1`
- FY deficit to date (latest): `v1/accounting/mts/mts_table_1?sort=-record_date,src_line_nbr&page[size]=40`, then keep rows with max record_date and take the "Year-to-Date" row (`record_type_cd` SL, `data_type_cd` T) with `sequence_number_cd` 2.13 (the current fiscal year).
- Annual deficits with revisions: `v1/accounting/mts/mts_table_1?filter=record_calendar_month:eq:09,classification_desc:eq:Year-to-Date&page[size]=10000`. Take each fiscal year from the next September's 1.13 row (revised), and the latest year from its own 2.13 row.
- Long monthly deficit series: `v1/accounting/mts/mts_receipts_outlays_deficit_surplus?filter=amt_category:eq:Deficit/Surplus (-)&page[size]=10000` ($M, from FY1981).
- Outlays by function, FYTD: `v1/accounting/mts/mts_table_9?filter=record_date:eq:<latest>,record_type_cd:eq:F`
- Receipts by source: the same call with `record_type_cd:eq:RSG,data_type_cd:eq:D`
- TGA closing balance since 2022-04-18: `v1/accounting/dts/operating_cash_balance?filter=account_type:eq:Treasury General Account (TGA) Closing Balance&fields=record_date,open_today_bal&page[size]=10000`
- Average rate on all interest-bearing debt: `v2/accounting/od/avg_interest_rates?filter=security_desc:eq:Total Interest-bearing Debt&page[size]=10000`
- FX for a currency: `v1/accounting/od/rates_of_exchange?filter=country_currency_desc:eq:Euro Zone-Euro&sort=-record_date`
- Completed 10-year note auctions: `v1/accounting/od/auctions_query?filter=security_term:eq:10-Year,security_type:eq:Note,auction_date:lte:<today>&sort=-auction_date`. This returned only original issues; the latest was 2026-08-12. Reopenings carry terms like "9-Year 10-Month", so filter on `original_security_term:eq:10-Year` to include them, and add `inflation_index_security:eq:No`: TIPS are `security_type` "Note" too (`security_type:eq:TIPS` matches nothing), so without it real-yield TIPS auctions mix in. **[live 2026-10-21]**: 502 rows with TIPS, 362 nominal notes; the 2026-09-17 auction is a TIPS reopening, 2026-10-07 a nominal one. `bid_to_cover_ratio` is the published ratio, which excludes SOMA (Federal Reserve) tenders: `total_tendered / total_accepted` includes them and comes out lower (Jan 2025: 2.25 against the published 2.53).
- Freshness check: `/services/dtg/metadata/summary`, then compare `latest_date`.
