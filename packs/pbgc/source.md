# PBGC Pension Insurance Data Tables
Depth: standard. Key: none. The Pension Benefit Guaranty Corporation's annual data tables on the two federal
pension insurance programs for private defined benefit plans: single-employer (S- tables) and multiemployer
(M- tables): PBGC's finances, claims, benefit payments, insured plans and participants, premiums, plan funding,
guarantee limits, special financial assistance. One Excel workbook per edition, one sheet per table.

## When to use
- PBGC net position, premium income, claims, trusteed terminations, benefits paid and payees; numbers of insured
  plans and participants (by size, status, industry, state); aggregate funding and underfunding of insured
  plans; premium rates and maximum guaranteed benefits by year; multiemployer financial assistance and special
  financial assistance (SFA) paid.
- Not here: plan-level Form 5500 filings (DOL EFAST, not wrapped), Social Security, federal employee
  retirement (opm), PBGC's budget accounts in the federal budget (omb: Public Budget Database, agency "Pension
  Benefit Guaranty Corporation").

## Endpoints and datasets
The pack reads the index page https://www.pbgc.gov/about/reports/pension-insurance-data, takes the Excel link of
the edition (file paths differ by year, so they are scraped, never built) and reads one sheet (verified live
2026-10-30). Editions with Excel: 2010-2024 (2011 is .xls). Default edition: the newest (2024, "1st
Installment", posted 08/04/2026).

| Endpoint | Returns | Key parameters | Notes |
|---|---|---|---|
| `data_table` | one table as published, header rows joined ("Trusteed Termination Data Claims ($ millions)"), `sheet_row` | `year` (edition), `table` ("S-1", "M-4", also s1 / s_1; GLANCE), optional `header_row`, `header_rows` | title (from the workbook's listing), source line and footnotes go into the notes |
| `table_list` | the edition's DATA BOOK LISTING: `table`, `title` (with the table's own years), `program`, `section`, `in_workbook` | `year` | `in_workbook` = no: listed but not in this installment |
| `editions` | `year`, `label` (installment, posting or revision date), `url`, `format` | none | |

Tables in the 2024 listing (numbers change between editions: check `table_list`): S-1 net financial position,
S-2 premiums, benefits, expenses; S-3 to S-13 terminations and claims (by size, funded ratio, industry; S-5 top 10
firms); S-14 to S-19 benefit payments and payees; S-20 to S-27 insured plans and participants (S-22 by status,
S-24/25 hybrid plans, S-26/27 frozen plans); S-28 to S-33 premiums (S-29 premium rate history); S-34 to S-41
funding (S-41 by state); S-42 by region and state; S-43 maximum guaranteed benefits; S-44 to S-49 partial risk
transfers. M-1 net position, M-2 premiums and assistance, M-3 financial assistance payments (traditional and SFA),
M-4/M-5 insured participants and plans, M-6 to M-13 participants by status, industry, funding; M-14 maximum
guarantee; M-15 premium rates; M-16 to M-19 zone status and administrative expenses; M-20/M-21 SFA by plan size and
industry. `--search "<words>"` searches the catalog (aliases `s_1`, `m_20`, `glance`; numbering of the 2023
edition).

## Spec examples
```json
{"description": "Single-employer and multiemployer net position, FY1980-2025",
 "requests": [
  {"name": "se_position", "endpoint": "data_table", "params": {"year": 2024, "table": "S-1"}},
  {"name": "me_position", "endpoint": "data_table", "params": {"year": 2024, "table": "M-1"}}]}
```
```json
{"description": "Premium rate history and what the 2024 installment holds",
 "requests": [
  {"name": "premium_rates", "endpoint": "data_table", "params": {"year": 2024, "table": "S-29"}},
  {"name": "tables", "endpoint": "table_list", "params": {"year": 2024}}]}
```
```json
{"description": "Participants by status (Form 5500 based; not in the 2024 1st installment)",
 "requests": [{"name": "status", "endpoint": "data_table", "params": {"year": 2023, "table": "S-22"}}]}
```

## Data format and traps
- Edition year is not the data year. Each table has its own range, in its title: the 2024 edition holds PBGC
  financial and payment data through fiscal year 2025 (S-1 1980-2025), premium filing data for 2024, Form 5500
  based data (participants by status, funding, industry, state) through plan year 2023 (about a two-year lag),
  and premium rates and guarantee limits through 2026. Quote the year from the table, never the edition.
- Installments: the 2024 edition is a "1st Installment" holding only S-1 to S-21, S-29, S-43, M-1 to M-5, M-14,
  M-15, M-20, M-21; its listing names all the tables. A table it lacks fails with a message that says so: take it
  from the 2023 edition (posted 12/18/2025). Editions are revised in place (the 2022 edition: "Revised
  12/18/2025"); `editions` shows the label.
- Table numbers change between editions: premium rate history is S-29 in 2024 but S-39 in 2018; check the title in
  the notes or `table_list` before comparing editions.
- Single-employer and multiemployer are separate programs with separate funds, premiums and guarantees (the
  multiemployer guarantee is much lower: M-14 vs S-43). Never add S- and M- figures unless the table does (GLANCE
  has a combined column).
- Fiscal year vs plan year: financial, claims and payment tables use PBGC's fiscal year (October-September);
  insured plan, participant, premium and funding tables use the plan year (or premium filing year).
- Trusteed vs ongoing plans: claims, terminations and payee tables (S-3 to S-19) cover plans PBGC has taken over
  (trusteed) or that ended in a standard termination; insured plan and participant tables (S-20 on, M-4 on) cover
  ongoing insured plans. Benefit payments are PBGC's payments to participants of trusteed plans.
- Units are in the column names ("Assets ($ millions)") or in a row above the header, which the notes carry
  ("Plan Size (in thousands)" on M-4: participants in thousands). Shares are stored as fractions where the PDF
  shows percent (2023 S-22: Active Participants 0.326 = 32.6 percent).
- Rows are as published: grouped early years ("1975 - 1979", "1981 - 1994"), then single years; S-1 and M-1 have
  1980, 1985, 1990, then every year from 1995. "Total" rows sit at the bottom. Footnote numbers are attached to
  labels and column names ("Total 10", "Trusteed Terminations 1"); the footnotes are in the notes. Markers are
  kept as text: "---" not applicable, "N/A". Label-only rows (GLANCE "Fiscal Year 2025:") have empty values.
- Before 1999, Form 5500 based tables cover only plans with 100 or more participants (2023 S-22 note).

## Access
No key; www.pbgc.gov answers scripts (verified 2026-10-30); limit used one request per second. Route `api`: the
index page plus one workbook per edition (1-3 MB), read once per run. Manual route: open the index page in a
browser, click the Excel link in the row of the edition (e.g. "2024 Pension Insurance Data Tables (1st
Installment)"), save it under the name in INSTRUCTIONS.md and upload it; the same workbook serves every table of
that edition. The PDF beside it has the same tables with titles. 2025 is not posted yet (its expected URL
answers 404).

## Citation and terms
Pension Benefit Guaranty Corporation, <year> Pension Insurance Data Tables, Table <S-1> "<title>", www.pbgc.gov,
retrieved <date>. U.S. government work in the public domain (17 U.S.C. 105): free to reuse and redistribute.
