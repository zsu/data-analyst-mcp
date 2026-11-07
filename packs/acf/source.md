# HHS Administration for Children and Families program data (TANF financial and caseload data, CCDF expenditures)
Depth: standard. Key: none. State-level TANF spending (federal TANF and state maintenance-of-effort funds by
category), TANF caseloads (families and recipients by state and month) and Child Care and Development Fund (CCDF)
expenditures, as published by ACF in Excel workbooks. Manual download only: acf.gov refuses scripts.

## When to use
- TANF money: how states use the TANF block grant and their own MOE funds (basic cash assistance, child care, work
  and training, tax credits, child welfare, program management...), transfers of TANF funds to CCDF and the Social
  Services Block Grant (SSBG), unspent (unobligated) balances, the Contingency Fund, MOE against the 80%/75% rule.
- TANF caseloads: families (total, two-parent, one-parent, no-parent/child-only) and recipients (total, adults,
  children) by state and month, fiscal- and calendar-year averages; TANF alone, separate state programs (SSP-MOE)
  or both.
- CCDF: child care spending by state, category (administration, quality, direct services...) and funding stream
  (mandatory, matching, discretionary, MOE, CARES/CRRSA/ARP), by fiscal year or by grant year.
- Not here: federal grant awards and obligations to states as transactions (usaspending); poverty, income and
  program participation from surveys (census, ipums); TANF as a federal budget account (omb, treasury); children
  served by CCDF (ACF-800/801 "CCDF Data Tables", not covered by this pack).

## Endpoints and datasets
Nothing is fetched: `--check` always gives `manual_download` with the acf.gov page and workbook links (verified
2026-10-30 from Internet Archive captures, since acf.gov refuses scripts), and `--ingest` reads the saved .xlsx
(.xls with xlrd). One CSV per request; every row has `row` (sheet row) and `sheet`.

| Endpoint | Returns | Key parameters | Coverage (files verified) |
|---|---|---|---|
| `tanf_financial` | one table of the TANF & MOE Financial Data workbook | `fiscal_year`, `table` (default A.1) | FY 2014-2018, 2020-2024 (FY 2019: page only) |
| `tanf_caseload` | one table of a caseload workbook | `fiscal_year`, `program` (tanf, ssp, tanf_ssp), `table` (default families) | FY 2018-2025 |
| `ccdf_expenditures` | one table of a CCDF expenditure workbook | `fiscal_year`, `file` (all_years, grant_year), `as_of`, `table` | all_years FY 2019-2022; grant_year GY 2020-2022 as of 9/30/2022 |

For other years the manual item is the year's page (the file name changes every year); some older years publish
only PDF or web tables, which `--ingest` cannot read.

`tanf_financial` `table` (FY 2015-2024 workbooks, same layout): `A.1` national spending by category (columns
Federal Funds, State MOE in TANF and Separate State Programs, All Funds, Percent of Total Funds Used); `A.2`/`A.3`
comparison with the prior year; `A.4` MOE by state, two years; `A.5` federal funds available (label/value);
`A.6` federal funds by state (awards, carryover, transfers, expenditures, unliquidated, unobligated); `B` total
(federal + MOE) by state, one column per category ("1. Awarded" ... "6. Basic Assistance", "6.a. ..." ...
"24. Total Expenditures", "27. Federal Unliquidated Obligations", "28. Unobligated Balance"); `C.1` federal only;
`C.2` state MOE only; `C.3` MOE against 100%/80%/75% of the requirement; a state name or USPS code (`Alabama`, `DC`)
for that state's A.1-style table; `E.1` by funding stream, `E.2` SFAG, `E.3` MOE in TANF, `E.4` MOE in separate
state programs, `E.5` Contingency Fund; `F` transitional services and Job Access (two blocks, `block` column).

`tanf_caseload` `table`: `families`, `two_parent`, `one_parent`, `no_parent`, `recipients`, `adults`, `children`
(one row per state, columns `2024-10` ... `2025-12`, `Average FY 2025`, `Average CY 2025`); `avg_families`,
`avg_recipients` (fiscal- and calendar-year averages, `block` = "Fiscal Year 2025 (October - September)" or
"Calendar Year ..."; FY-only files have no block); a month `2025-03` (all seven counts by state for that month).

`ccdf_expenditures` `table`: all_years `1a` (spending in the FY by fund and grant year), `2a` (unliquidated and
unobligated funds), `3a` (by state and category), `4a` (by state and fund, default); grant_year `1b` (by category,
default), `2b` (awards and TANF transfers by state), `3b` mandatory, `4b` matching, `5b` state match (FMAP), `6b`
discretionary, `7b`/`8b` MOE, higher numbers for CARES/CRRSA/ARP in GY 2020-2021.

State tables get a `state_code` column (USPS; `US` for "U.S. TOTAL", "U.S. Totals" and CCDF "Total").

## Spec examples
```json
{"description": "FY 2024 TANF and MOE spending: national categories and basic assistance by state",
 "requests": [
  {"name": "categories", "endpoint": "tanf_financial", "params": {"fiscal_year": 2024, "table": "A.1"}},
  {"name": "by_state", "endpoint": "tanf_financial", "params": {"fiscal_year": 2024, "table": "B"}}]}
```
```json
{"description": "TANF families by state and month, FY 2025, and the fiscal/calendar-year averages",
 "requests": [
  {"name": "families", "endpoint": "tanf_caseload", "params": {"fiscal_year": 2025, "table": "families"}},
  {"name": "averages", "endpoint": "tanf_caseload", "params": {"fiscal_year": 2025, "table": "avg_families"}}]}
```
```json
{"description": "CCDF spending in FY 2022 by state and funding stream",
 "requests": [{"name": "ccdf_funds", "endpoint": "ccdf_expenditures",
               "params": {"fiscal_year": 2022, "file": "all_years", "table": "4a"}}]}
```
Run `--check` (it writes the manual bundle), have the user save the workbook(s) from a browser, then `--ingest`.

## Data format and traps
- Dollars are nominal, as reported by states, in dollars (not thousands); floats are written in their shortest
  form (3162142819.8699999 -> 3162142819.87). "Percent of Total Funds Used" is a fraction (0.218 = 21.8%). A cell
  holding only "-" (caseload "data inapplicable") is written empty; "N/A" stays as published.
- Fiscal year = federal FY (October-September). ACF revises: a workbook's prior-year column (A.2-A.4) is "as of"
  a stated date and differs from that year's own workbook; caseload files are replaced in place with revised
  months (FY 2024 October 2023 TANF families: 856,530 in the FY file, 854,981 in the later 15-month file). Cite the
  file you ingested.
- Federal vs state: "Federal Funds" are the TANF block grant (SFAG) plus Contingency Funds; "State MOE in TANF and
  Separate State Programs" are state funds counted toward the maintenance-of-effort requirement, including MOE
  spent in separate state programs outside TANF. All Funds = both. C.2 (MOE) has no award, transfer or carryover
  columns (empty).
- Transfers: "Transferred to CCDF Discretionary" and "Transferred to SSBG" are federal TANF funds moved to those
  block grants; they are in TOTAL FUNDS USED but not in TOTAL EXPENDITURES (FY 2024: expenditures $35.00 billion,
  transfers $2.52 billion, total funds used $37.52 billion). TANF money transferred to CCDF reappears in CCDF
  discretionary spending (CCDF Table 2b "TANF Transfer"): never add the two datasets' child care amounts without
  removing it. ACF's headline child care share (17.0% in FY 2024) counts child care spending plus the transfer to
  CCDF ((5.006 + 1.387) / 37.516 billion); A.1's "Child Care" row alone is 13.3%. Unobligated balances are federal
  funds left unspent (FY 2024: $7.99 billion; $9.66 billion with unliquidated obligations).
- Rows and columns nest: category rows are followed by their sub-rows (Basic Assistance, then Basic Assistance
  excluding relative foster care..., then Relative Foster Care...; Early Care and Education = Child Care + Pre-K/Head
  Start; Program Management = Administrative Costs + Assessment/Service Provision + Systems). In B/C/E, "6." and
  "6.a."/"6.b." columns likewise. Summing all rows double counts: use the TOTAL rows or only top-level items.
- "Assistance" vs "non-assistance": basic assistance is ongoing cash aid; child care, work supports, short-term
  benefits and services are mostly non-assistance; "Authorized Solely Under Prior Law" lines are pre-1996 AFDC/EA
  uses allowed to continue. Child care appears as "Child Care (Assistance and Non-Assistance)".
- Categories follow the ACF-196R form from FY 2015 on (the FY 2015 and FY 2024 workbooks have the same rows,
  verified); FY 2014 and earlier used the older ACF-196 categories (not checked by the pack): do not build one
  series across FY 2014/2015 without mapping categories.
- Caseload: a family (case) is the assistance unit; recipients are people (adults + children). No-parent families
  are mostly child-only cases (no adult in the grant), so adult recipients are far fewer than families. TANF and
  SSP-MOE are separate files; tanf_ssp is their sum. Averages are means of monthly counts (fractional). U.S. Totals
  include Guam, Puerto Rico and the Virgin Islands. The FY 2018, 2024 and 2025 files run 15 months (October to the
  next December) with calendar-year averages; other years stop in September. Month columns come as Excel dates
  or "Oct-20" and are written "2020-10".
- State names differ by table ("DIST.OF COLUMBIA", "District of Columbia"); join on `state_code`.
- CCDF: all_years = spending during a fiscal year from every open grant year (one FY of outlays); grant_year = one
  year's award, reported as of 9/30 of the grant year and later years until spent (the GY tables change between
  reports). Mandatory and discretionary are federal; matching has a federal and a state share (FMAP); MOE and State
  Match are state funds. Negative amounts are adjustments (e.g. American Samoa in FY 2022). Table 3a's state totals
  exclude ARP Stabilization grants (sheet footnote); Table 4a includes them as a column. OCC separates FY and GY
  from FY 2018 on.
- Footnotes and titles under or above a table are not written; open the workbook for them.

## Access
No key. acf.gov (and acf.hhs.gov, which redirects there) answers every non-browser request, direct .xlsx links
included, with an AWS WAF JavaScript challenge (HTTP 202, empty body, header x-amzn-waf-action: challenge; verified
2026-10-30). The pack never tries to get around it: `--check` returns `manual_download` and a fetch stops as
`blocked`. Steps for the user:
1. Open the link in INSTRUCTIONS.md in a web browser (the workbook link, or the year's page when the pack has no
   verified file name: TANF financial `https://acf.gov/ofa/data/tanf-financial-data-fy-<year>`, caseload
   `https://acf.gov/ofa/data/tanf-caseload-data-<year>`, CCDF via
   `https://acf.gov/occ/data/child-care-and-development-fund-expenditure-data-list-all-years`).
2. Click the XLSX link (caseload: the TANF, SSP-MOE or TANF & SSP-MOE file; the "15 Months" one when the page has
   two; CCDF: the "all appropriation years" page or the grant-year "Tables 1b-..." page, then its XLSX).
3. Save the .xlsx and upload it unchanged; `--ingest` picks the table named in the request. One workbook serves
   every table of that year: requests on the same workbook need it uploaded once.
The download scripts in the bundle will get the empty challenge page; saving from a browser works.

## Citation and terms
"U.S. Department of Health and Human Services, Administration for Children and Families, <dataset> (acf.gov,
workbook saved from the agency's site), retrieved <date>." Name the workbook and its fiscal year. Works of the
U.S. government, public domain (17 U.S.C. 105): redistribution allowed.
