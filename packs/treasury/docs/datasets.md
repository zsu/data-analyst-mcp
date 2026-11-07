# Which dataset answers which question

Start here to pick endpoints. Each row says whether the measure is a **stock** (a level at a date:
take the end-of-period value or an average) or a **flow** (an amount over a period: sum months, or
read a fiscal-year-to-date row). Confirm paths and field names live with `fetch.py --source treasury --search` and
`fetch.py --source treasury --fields`; details and pitfalls are in `api_guide.md` (section numbers in brackets).

Units: **$** = dollars and cents; **$M** = millions of dollars; **%** = already in percent.

"Rows to use" always names the column with the value (`data_type_cd` = T, not "the T row"): the same
letter can be a value in two columns. Check live with `fetch.py --source treasury --fields <endpoint> --filter … --values`;
each download's `data/README.md` also lists the values found in every code and description column.

## Question → endpoint

| Question | Endpoint | Rows to use | Stock/flow | Units | Pitfalls |
|---|---|---|---|---|---|
| Total federal debt, debt held by the public, intragovernmental holdings (daily, since 1993) | `v2/accounting/od/debt_to_penny` | one row per business day | stock | $ | DHP and intragov are null before 2005-03-31; the latest day lags one business day |
| Debt at each fiscal year end, back to 1790 | `v2/accounting/od/debt_outstanding` | one row per year | stock | $ | early years dated Jan 1, recent years Sep 30; definitions change over two centuries |
| Debt by security type (bills, notes, bonds, TIPS, FRNs; marketable vs nonmarketable), monthly | `v1/debt/mspd/mspd_table_1` | `security_type_desc`, `security_class_desc`; skip "Total ..." rows when summing | stock | $M | totals differ from Debt to the Penny by rounding and FFB debt [4.14] |
| Debt subject to the statutory limit | `v1/debt/mspd/mspd_table_2` (monthly) or `v1/accounting/dts/debt_subject_to_limit` (daily) | `debt_catg_desc` | stock | $M | |
| Monthly receipts, outlays, deficit (long series since FY1981) | `v1/accounting/mts/mts_receipts_outlays_deficit_surplus` | `amt_category` = Receipts / Outlays / Deficit/Surplus (-) | flow | $M | deficit is **positive** in this table [4.3] |
| Monthly receipts, outlays, deficit (since FY2015, more detail) | `v1/accounting/mts/mts_table_1` | months: the **latest** `record_date` only, `record_type_cd` = MTH; full fiscal year: September `record_date`, `classification_desc` = "Year-to-Date" (`record_type_cd` = SL, `data_type_cd` = T) | flow | $ | each release holds **two fiscal-year blocks**: `sequence_number_cd` 1.x = prior FY (as revised), 2.x = current FY, so "Year-to-Date" appears twice per release [4.8]; releases repeat prior months and revise them: never stack releases [4.5, 4.6]; deficit positive [4.3] |
| Receipts by source (individual, corporate, payroll, excise, customs ...) and outlays by function (defense, Social Security, Medicare, net interest ...) | `v1/accounting/mts/mts_table_9` | September `record_date` for a full FY; `data_type_cd` = D for components, `data_type_cd` = T with `classification_desc` = "Total" for totals; `record_type_cd` = RSG for receipts, F for functions | flow (`current_fytd_*` is cumulative) | $ | Social Insurance is an S header with 3 D children; never sum all rows [4.9] |
| Outlays by function and subfunction | `v1/accounting/mts/mts_table_9_outlays_functions_subfunctions` | D rows at the wanted `sequence_level_nbr` | flow | $ | |
| Receipts detail (gross, refunds, net) | `v1/accounting/mts/mts_table_4` | totals: the rows with `classification_desc` starting "Total -- " (`data_type_cd` = T or `record_type_cd` = SL) | flow | $ | **D rows do not sum to the total** in Table 4 [4.9]; prefer Table 9 for receipts by source |
| Outlays by agency, bureau, program | `v1/accounting/mts/mts_table_5` | `record_type_cd` A = agency totals; D rows sum to "Total Outlays" | flow | $ | Table 5's "Total Surplus (+) or Deficit (-)" is **negative** for a deficit [4.3]; never add T rows to D rows |
| Interest expense on the public debt (gross, by security type) | `v2/accounting/od/interest_expense` | `expense_catg_desc`, `expense_group_desc`, `expense_type_desc`; `month_expense_amt` per month or September `fytd_expense_amt` | flow | $ | detail rows only (no total rows): the sum of **all** rows is the total interest expense (FY2024: $1,133.0 billion). From FY2025 it includes a GAS line "Restoration of Interest" ($4.4 billion in FY2025, $0.4 billion in FY2026) that MTS Table 5 "Interest on Treasury Debt Securities (Gross)" leaves out: drop it to match MTS. Marketable TIPS interest is the sum of the TIPS lines, inflation compensation included ("Int. Expense Inflation Compensation (TIPS)"); the GAS "Inflation Compensation" line is not TIPS, so never select TIPS with a substring such as "Inflation". Marketable = the Treasury Bills, Notes, Bonds, TIPS (both TIPS lines) and FRN lines; the other public-issue lines are nonmarketable held by the public (Savings Bonds, State & Local Government (SLGS), Domestic, Foreign and REA Series) or miscellaneous (Matured Debt, Limited Payability, Recertified Agency Payments), about $8 billion in FY2026: public issues are not all marketable. Check the lines with `--values`. Two categories: INTEREST EXPENSE ON PUBLIC ISSUES (debt held by the public) and ON GOVT ACCOUNT SERIES (trust funds; intragovernmental). The GAS groups "ACCRUAL BASIS GAS EXPENSE" (zero-coupon amortized discount only) and "CASH BASIS GAS PAYMENTS" are different line items, not two versions of the same amount: keep both. Some lines are negative (premiums, collected discounts). Total = gross interest; MTS "Net Interest" (Table 9) is the budget's **net** measure (nets out trust-fund interest and other receipts): say which one is used |
| Average interest rate on the debt | `v2/accounting/od/avg_interest_rates` | `security_desc` = "Total Interest-bearing Debt", "Total Marketable", "Treasury Bills" ... | stock (a rate at month end) | % | rows for totals and components sit side by side; "Total Marketable" leaves out TIPS and FRNs (see source.md) |
| Treasury cash balance (TGA) | `v1/accounting/dts/operating_cash_balance` | before 2022-04-18: TGA / Federal Reserve Account row, `close_today_bal`; from 2022-04-18: "Treasury General Account (TGA) Closing Balance" row, `open_today_bal` | stock | $M | **format change on 2022-04-18** [4.11] |
| Daily deposits and withdrawals by category (tax receipts, Social Security, Medicare, interest ...) | `v1/accounting/dts/deposits_withdrawals_operating_cash` | `transaction_type`, `transaction_catg`; drop the "Total ..." account rows when summing details | flow (`transaction_today_amt`; `_mtd`, `_fytd` are cumulative) | $M | gross public debt cash issues and redemptions are in here: exclude for operating flows; category names change over time [4.12] |
| Gross borrowing: debt issued and redeemed | `v1/accounting/dts/public_debt_transactions` | `transaction_type` Issues / Redemptions, `security_type` | flow | $M | |
| Auction results (yields, bid-to-cover, who bought) | `v1/accounting/od/auctions_query` | completed auctions only (`auction_date` <= today, non-null `high_yield`); `original_security_term` to include reopenings; `inflation_index_security: No` for nominal securities (TIPS are `security_type` Note too) | event | mixed | future auctions have null results [4.16] |
| Exchange rates used for federal reporting | `v1/accounting/od/rates_of_exchange` | `country_currency_desc`; latest `effective_date` per quarter | stock | foreign units per USD | amendments create duplicate quarter rows [4.15] |
| Revenue collections by channel and tax category | `v2/revenue/rcm` | `tax_category_desc`, `channel_type_desc` | flow | $ | collections, not budget receipts |
| Receivables and delinquent debt owed to agencies | `v2/debt/tror` | per agency × receivable type | stock | $ | ~230 columns: select by name |
| Treasury Offset Program collections | `v1/debt/treasury_offset_program` | filter by date and agency | flow | $ | 3.5 million rows: always filter |
| Gifts to reduce the debt | `v2/accounting/od/gift_contributions` | one row per month | flow | $ | |
| Savings bonds, I bond rates | `v2/accounting/od/sb_value`, `v1/accounting/od/i_bonds_interest_rates` | | | | **no record_date**: set `date_field` [3] |
| Buybacks | `v1/accounting/od/buybacks_operations` | | event | $ | date column is `operation_date` |
| Federal government balance sheet, net cost (Financial Report) | `v2/accounting/od/balance_sheets`, `v2/accounting/od/statement_net_cost` | | annual | $ | lags months |

Anything else: `python <skill>/scripts/fetch.py --source treasury --search "<words>"` lists every matching endpoint with
frequency, earliest and latest date, row count and the dataset page.

## Not in Fiscal Data: say so and offer the right source
- **GDP, CPI, inflation**: BEA and BLS, through `fetch.py --source treasury --context` (CPI-U from FRED or BLS; GDP from
  FRED, with an annual World Bank fallback).
- **Budget projections, baselines, scoring**: CBO (https://www.cbo.gov/data/budget-economic-data).
- **Historical budget tables, % of GDP back to 1930, the President's budget**: OMB Historical Tables
  (https://www.whitehouse.gov/omb/budget/historical-tables/).
- **Who holds Treasury debt (foreign holders by country)**: Treasury International Capital (TIC), not
  Fiscal Data; the Treasury Bulletin OFS-2 table (`v1/accounting/tb/ofs2_...`) gives ownership by sector.
- **Market yields (daily Treasury par yield curve)**: the treasury-yields pack (home.treasury.gov interest-rate statistics), not this API;
  Fiscal Data has auction results and average rates on outstanding debt.
- **State and local finances**: Census Bureau Annual Survey of State and Local Government Finances.
