# OMB President's Budget data via GovInfo (Historical Tables, Public Budget Database, Federal Credit Supplement)
Depth: standard. Key: none. The Office of Management and Budget's budget data files, read from GovInfo's
stable URLs: the Historical Tables (receipts, outlays, deficits, debt, budget authority since 1789/1940/1962),
the Public Budget Database (every budget account, every year since 1962), and the Federal Credit Supplement
(credit subsidy rates of loan and loan guarantee programs).

## When to use
- Long federal budget histories on one consistent basis: totals, on-/off-budget, percent of GDP, outlays by
  function, subfunction and agency, mandatory vs discretionary (BEA category), receipts by source, debt held by
  the public, grants to states, payments for individuals, federal employment (FTE); the account-level detail
  behind them (Public Budget Database); credit subsidy rates by program (Federal Credit Supplement).
- The President's estimates for the current year and the budget year onward (labelled "estimate"): proposals,
  not law and not outcomes.
- Not here: monthly or daily Treasury cash results, debt to the penny, interest rates on the debt (treasury);
  Treasury yields (treasury-yields); GDP and NIPA government accounts (bea); spending by award or recipient
  (usaspending). The Mid-Session Review is published as PDF only and is not read by this pack.

## Endpoints and datasets
Files at `https://www.govinfo.gov/content/pkg/BUDGET-<FY>-<PKG>/...`, keyless (verified live 2026-10-30). `fy` is
the budget's fiscal year (the edition): FY2027 = the budget released in 2026. Default `fy`: the newest edition
GovInfo has (tries next year, this year, last year). One CSV per request; every table gets a `sheet_row` column.

| Endpoint | Returns | Key parameters | Units, coverage |
|---|---|---|---|
| `historical_table` | one Historical Table as published, multi-row headers joined ("Total Outlays", "On-Budget Receipts", "As Percentages of GDP Gross Federal Debt") | `fy`, `table` ("1.1", "3.2", "8.5" or alias `table_1_1`), optional `header_row`, `header_rows` | per table: millions, billions, percent of GDP, constant FY 2017 dollars (the units line is in the notes); 1789/1901/1930/1940/1962/1976 on |
| `budget_database` | Public Budget Database: one row per account line with Agency/Bureau/Account codes and names, Treasury and CGAC agency codes, Subfunction Code/Title, BEA Category (Mandatory, Discretionary, Net interest), Grant/non-grant split (outlays only), On- or Off- Budget, then one column per year | `fy`, `kind` = `budget_authority` (1976 on) / `outlays` (1962 on) / `receipts` (1962 on; source category columns instead of subfunction) | thousands of dollars; through the edition's last projection year (FY2027: 2031); 5,000-6,000 rows (receipts about 260) |
| `credit_supplement` | one Federal Credit Supplement table, label rows (agency, bureau, account) kept in order | `fy`, `table` 1-10 | Table 1 direct loans and Table 2 loan guarantees: subsidy rate (percent), obligations/commitments and average loan size (thousands of dollars) for the current year and the budget year; 3-6 subsidy assumptions; 7-8 reestimates by cohort; 9-10 disbursement rates |

Historical Table numbers (FY2026 and FY2027 editions have the same 57 tables): 1.1-1.4 summary (1.2 % of GDP, 1.3
constant dollars), 2.1-2.5 receipts by source, 3.1-3.2 outlays by function/subfunction, 4.1-4.2 outlays by agency,
5.1-5.6 budget authority, 6.1 composition of outlays, 7.1-7.3 debt and debt limit, 8.1-8.8 mandatory/discretionary
(BEA categories; 8.5 mandatory programs, 8.7 discretionary), 9.1-9.9 investment and R&D, 10.1 GDP and deflators,
11.1-11.3 payments for individuals, 12.1-12.3 grants to state and local governments, 13.1 Social Security and
Medicare trust funds, 14.1-14.6 total (federal, state, local) government, 15.1 health, 16.1-16.2 FTE employees.
`--search "<words>"` finds a table in the catalog (aliases `table_s_t`, `pbd_outlays`, `fcs_table1` ...).

How a table is found: Table s.t is GovInfo granule `TAB-<s+1>-<t>` (Table 1.1 = BUDGET-2027-TAB-2-1.xlsx); the pack
checks the sheet's title row names the table. Editions that do not follow it (FY2026 publishes one workbook,
BUDGET-2026-TAB.xlsx, sheets hist01z1 ...; FY2015 and earlier other numbers and .xls files) are read from the
package zip `BUDGET-<FY>-TAB.zip` (1-6 MB), and the note says which member. Public Budget Database: granules 1-3
(.xlsx; FY2015 and other older editions CSV only, read the same way). FY2026 has no Public Budget Database on
GovInfo. Credit supplement: one workbook (FY2024 on) or one file per table (FY2018-FY2023).

## Spec examples
```json
{"description": "Receipts, outlays and deficit since 1940, and as percent of GDP (FY2027 edition)",
 "requests": [
  {"name": "summary", "endpoint": "historical_table", "params": {"fy": 2027, "table": "1.1"}},
  {"name": "summary_gdp", "endpoint": "historical_table", "params": {"fy": 2027, "table": "1.2"}},
  {"name": "debt", "endpoint": "historical_table", "params": {"fy": 2027, "table": "7.1"}}]}
```
```json
{"description": "Outlays by account and BEA category; outlays by function and subfunction",
 "requests": [
  {"name": "pbd_outlays", "endpoint": "budget_database", "params": {"fy": 2027, "kind": "outlays"}},
  {"name": "by_subfunction", "endpoint": "historical_table", "params": {"fy": 2027, "table": "3.2"}}]}
```
```json
{"description": "Credit subsidy rates of direct loan and loan guarantee programs",
 "requests": [
  {"name": "direct_loans", "endpoint": "credit_supplement", "params": {"fy": 2027, "table": 1}},
  {"name": "guarantees", "endpoint": "credit_supplement", "params": {"fy": 2027, "table": 2}}]}
```

## Data format and traps
- Edition matters. Each edition revises history (concepts and reclassifications). Verified: FY2024 total outlays
  are 6,750,856 million in the FY2026 edition and 6,735,261 million in the FY2027 edition, because the FY2027
  edition lowers "International Assistance Programs" (FY2024: 35,798 to 20,194 million; FY2020-FY2023 too).
  Treasury's final Monthly Treasury Statement shows 6,751.6 billion. Take a series from one edition, cite the
  edition (`fy`), and expect small differences from Treasury figures.
- Actual vs estimate. A year labelled "<year> estimate" (row label in year-row tables, column header in
  year-column tables such as 3.2, 4.1, 5.x) is the President's projection: the current year (fy - 1) is an
  estimate, the budget year (fy) and later are proposals. The notes say how many estimate years a table has.
  Coverage differs within one edition: in FY2027, Tables 1.1-1.4, 7.1-7.2 and 14.x end with actual 2025 (no
  estimates), 9.x, 12.3 and 16.x run to 2027, the others to 2031. In FY2026 every table ends with actual 2024.
- Units differ by table (FY2027 edition, checked table by table): the units line is in the notes when the table
  has one, otherwise the units are in the column names ("In Millions of Dollars ...", "As Percentages of GDP
  ..."). Millions of dollars: most tables (1.1, 1.4, 2.1, 2.4, 2.5, 3.2, 4.1, 5.x amounts, 7.2, 8.5, 8.7, 9.4-9.9,
  11.2, 11.3, 12.x, 13.1). Billions: 1.3, 7.3, 8.1, 8.2, 8.6, 8.8, 14.1, 14.2, 14.4, 14.6, 15.1. Percent of GDP:
  1.2, 2.3, 8.4, 14.3, 14.5 (and part of 1.3, 7.1, 14.1, 14.6). Percent composition: 2.2, 4.2, 5.3, 5.5, 8.3, 9.3.
  Constant (FY 2017) dollars: 1.3, 8.2, 8.6, 8.8, 9.2 (part). 10.1: GDP in billions and price indexes (FY 2017 =
  1.000). 16.1 thousands of FTEs, 16.2 percent. Tables 3.1 and 6.1 stack blocks in different units under label
  rows ("In millions of dollars:", "As percentages of GDP:"), so "Total, Federal outlays" appears once per
  block: the pack adds a column `units_block`; filter on it. Public Budget Database: thousands of dollars (FY2024
  outlays sum to 6,735,261,000 thousand = Table 1.1). Credit supplement: "Dollars in thousands" except rates
  (percent).
- Percent of GDP uses fiscal-year GDP (Table 10.1), not calendar-year GDP from BEA.
- Fiscal years run October-September since FY1977 (July-June before). `TQ` is the transition quarter (July-
  September 1976), its own row or column: not part of 1976 or 1977.
- On-budget + off-budget = total (unified budget). Off-budget is the Social Security trust funds and the Postal
  Service. Tables 3.2, 4.1 and others show "(On-budget)" and "(Off-budget)" lines under a total: do not add them
  to the total.
- Rows are as published: label-only rows ("050 National Defense:", "Department of Agriculture", "Farm Service
  Agency:") have empty values, and subtotal and total rows sit among detail rows. Never sum a whole column;
  select the lines you need (by label and `sheet_row` order).
- Year-column tables (3.2, 4.1, 5.x, 8.5, 12.3 ...) have years as column names ("1962" ... "TQ" ... "2026
  estimate"); year-row tables (1.1, 7.1, 10.1) have the year in the first column ("1789-1849", "1901", "TQ",
  "2026 estimate").
- Published markers are kept as text: ".........." = not applicable / no amount, "*" = $500 thousand or less
  (or under 0.05 percent), "N/A" = not available, "......" in the credit supplement = no program that year.
  Convert to numbers only after deciding how to treat them. Footnotes (e.g. budget figures before 1933 follow
  the administrative budget concept) are in the notes.
- Public Budget Database: codes are text with leading zeros ("001", "00"); some account codes are blank and some
  Treasury/CGAC codes are a space. An account can appear on several rows (one per subfunction, BEA category,
  grant split, on/off-budget). Offsetting receipts are negative rows in the outlays file (e.g. "Undistributed
  Offsetting Receipts", "Receipts, Central fiscal operations"); the receipts file is governmental receipts only
  (FY2024 sums to 4,919,884,000 thousand = Table 1.1). Budget authority is not outlays: BA is what may be
  obligated, outlays what is spent.
- Credit supplement: a negative subsidy rate means the program is estimated to make money for the government; the
  rates are percent of disbursements. Columns are the current year (fy - 1) and the budget year (fy), both
  estimates. Leader dots after labels are removed; nothing else is changed.
- Constant-dollar tables use OMB's deflators (Table 10.1), not CPI: say which when comparing.

## Access
No key. GovInfo answers scripts (verified 2026-10-30); limit used two requests per second. A file that does not
exist answers HTTP 302 to GovInfo's error page (HTML, status 200): the pack treats it as missing, tries the
package zip for Historical Tables, and otherwise fails with a message naming the URLs (never an empty table).
Route `api` reads the files directly. Manual route: the bundle lists the GovInfo URL of each file (open it in a
browser, save under the name shown, upload); for a Historical Table whose link shows the error page, download
`https://www.govinfo.gov/content/pkg/BUDGET-<FY>-TAB.zip` and upload the zip. The same files are on whitehouse.gov
with dated paths: https://www.whitehouse.gov/omb/information-resources/budget/historical-tables/ (hist01z1_fy2027.xlsx,
hist_fy2027.zip) and https://www.whitehouse.gov/omb/information-resources/budget/supplemental-materials/
(budauth_fy2027.xlsx, outlays_fy2027.xlsx, receipts_fy2027.xlsx, cr_supp_fy2027.xlsx); whitehouse.gov removes older
editions, GovInfo keeps them (back to the FY1996 budget, file formats vary).

## Citation and terms
Office of Management and Budget, Budget of the U.S. Government, Fiscal Year <fy>, <Historical Tables / Public
Budget Database / Federal Credit Supplement>, GovInfo (www.govinfo.gov), retrieved <date>. Name the table (e.g.
"Historical Table 1.1") and the edition. U.S. government work in the public domain (17 U.S.C. 105): free to
reuse and redistribute.
