# Social Security and Medicare Trustees Reports and National Health Expenditure data (SSA and CMS actuaries)
Depth: standard. Key: none. The published tables of the Medicare Trustees Report and the National Health
Expenditure Accounts (CMS Office of the Actuary, fetched from www.cms.gov), and the single-year tables of the
Social Security (OASDI) Trustees Report (SSA Office of the Chief Actuary, manual route only: www.ssa.gov refuses
scripts).

## When to use
- Trust fund outlooks: Medicare HI (Part A) and SMI (Parts B and D) income, cost, reserves and depletion; Social
  Security OASI, DI and combined OASDI income and cost rates, reserves, trust fund ratios, covered workers per
  beneficiary, and the demographic and economic assumptions behind them (fertility, mortality, immigration,
  population, wages, CPI, interest rates); Medicare spending as a share of GDP over 75 years.
- National health spending: total and per capita national health expenditures (NHE) and their share of GDP since
  1960; spending by type of service (hospital, physician, drugs...) and by source of funds (out of pocket, private
  insurance, Medicare, Medicaid, other); spending by sponsor (households, business, governments); the 10-year
  NHE projections.
- Not here: Medicare claims, enrollment and provider data (cms pack, data.cms.gov); federal outlays for Medicare
  and Social Security as budget accounts (treasury pack: Monthly Treasury Statement); health insurance coverage
  from surveys (census). NHE is national spending by all payers, not federal spending.

## Endpoints and datasets
CMS pages read by the pack (verified 2026-10-30): the Trustees Report & Trust Funds page (links "<year> Expanded
and Supplementary Tables and Figures (ZIP)" for 2022-2026) and the NHE historical and projected pages. The pack
reads the link from the page, downloads the ZIP and reads one table. One CSV per request.

| Endpoint | Returns | Key parameters | Coverage |
|---|---|---|---|
| `medicare_tr_files` | one row per workbook sheet of a Medicare Trustees Report ZIP: `table`, `sheet`, `title`, `format` | `report_year` (default latest) | 2022-2026 reports |
| `medicare_tr_table` | one table, one row per year | `table` (file name or a unique part of it), `sheet`, `report_year`, `header_row`, `layout` | history from 1966/1967, projections to 2035 (short range) or 2100 (long range) |
| `nhe_files` | the tables of one NHE download | `file` | latest release only |
| `nhe_table` | one NHE table, years as columns | `file`, `table` (not needed when the ZIP holds one), `sheet`, `header_row`, `layout` | see below |
| `ssa_tr_table` | one OASDI single-year table (sheet of SingleYearTRTables_TR<year>.xlsx), one row per year and alternative | `table` (IV.B1, V.A3, VI.G2...), `report_year` (default 2026) | 1940s/1970-2100 |

Medicare ZIP tables (2026, `table` names): Operations of the Hospital Insurance (HI) Trust Fund For Calendar Years;
Operations of the Supplementary Medical Insurance (SMI) Trust Fund / of the Part B Account / of the Part D
Account; Total Medicare Income, Expenditures and Trust Fund Assets; HI Cost and Income Rates; Ratio of Assets at the
Beginning of the Year to Expenditures During the Year for the HI Trust Fund; HI and SMI Incurred Expenditures as a
Percentage of the Gross Domestic Product (and "... under IAS", the illustrative alternative scenario); Medicare
Sources of Non-Interest Income as a Percentage of ...; Medicare Enrollment by Part and in Total; HI and SMI
Average per Beneficiary Costs; Ratio of HI Covered Workers to HI Beneficiaries; Ratio of HI Taxable Payroll to GDP;
HI / SMI Cost-sharing and Premium Amounts; Components of ... HI Inpatient Hospital Payments; Relationship between
Increases in HI Expenditures and Increases in Taxable Payroll. Each has a `Notes` sheet (`"sheet": "Notes"`).
`"table": "Figures"` is the figures workbook: `sheet` is the figure number (II.D1, III.B2, V.B1 ...).

NHE `file` values: `summary` (NHE summary including share of GDP, CY 1960-2024, CSV), `service_funds` (NHE by type
of service and source of funds, CY 1960-2024, CSV, amounts in millions), `tables` (NHE Tables 01-25, e.g. "Table 01"
aggregate and per capita, "Table 03" by source of funds, "Table 05" by sponsor), `projections_tables` (Table01-Table18,
2013-2034, e.g. "Table01" NHE and economic indicators, "Table03" by source of funds), `projections_data` (by type of
service and source of funds, 1960-2034, columns "2024 Historical", "2025 Projected"...).

SSA single-year tables (2026 workbook sheets): IV.B1-IV.B3 income rates, cost rates and balances (percent of taxable
payroll, of GDP); IV.B4 covered workers and beneficiaries; IV.B5 trust fund ratios; V.A1-V.A5 fertility, mortality,
immigration, population (V.A3), period and cohort life expectancy; V.B1-V.B2 economic assumptions; V.C4-V.C5 OASI
and DI beneficiaries; V.C7 scheduled benefit amounts; VI.G1 economic variables (GDP, taxable payroll); VI.G2-VI.G5
trust fund operations in current dollars and in CPI-indexed 2026 dollars.

## Spec examples
```json
{"description": "2026 Medicare Trustees Report: HI trust fund operations and Medicare spending as a share of GDP",
 "requests": [
  {"name": "hi_ops", "endpoint": "medicare_tr_table", "params": {"report_year": 2026, "table": "Operations of the Hospital Insurance (HI) Trust Fund"}},
  {"name": "medicare_gdp", "endpoint": "medicare_tr_table", "params": {"report_year": 2026, "table": "HI and SMI Incurred Expenditures as a Percentage of the Gross Domestic Product"}},
  {"name": "tables", "endpoint": "medicare_tr_files", "params": {"report_year": 2026}}]}
```
```json
{"description": "National health expenditures 1960-2024 and projections to 2034",
 "requests": [
  {"name": "nhe_summary", "endpoint": "nhe_table", "params": {"file": "summary", "layout": "long"}},
  {"name": "nhe_by_payer", "endpoint": "nhe_table", "params": {"file": "service_funds"}},
  {"name": "nhe_projected", "endpoint": "nhe_table", "params": {"file": "projections_tables", "table": "Table01"}}]}
```
```json
{"description": "2026 OASDI Trustees Report: combined trust fund operations and population",
 "requests": [
  {"name": "oasdi_ops", "endpoint": "ssa_tr_table", "params": {"report_year": 2026, "table": "VI.G2"}},
  {"name": "population", "endpoint": "ssa_tr_table", "params": {"report_year": 2026, "table": "V.A3"}}]}
```
Keep SSA requests in their own spec: a spec with any SSA request goes to the manual route as a whole.

## Data format and traps
- How tables are read: title lines and footnotes go to the fetch notes; the column names join the header rows
  (merged cells spread over their columns), so they keep the published footnote markers ("OASI Cost ratec",
  "Balance at end of year (see note 21) (Trust Fund)"). A label row inside the data ("Intermediate:",
  "Amount in Billions", "Year 2024 Amount in Billions") becomes `section`; `row` is the sheet row. An indented
  label column gets `indent` (spaces as published), `group` (nearest unindented row above) and `parent` (nearest
  row above with less indent). `parent` is derived from the published indentation, which is not always consistent
  (NHE Table 1 indents "Government Administration..." less than its siblings): check it against the table. When
  detection fails, pass `header_row` (1-based, or a list). NHE historical Table 04 stacks one block per year:
  `section` names the year.
- Values are as published, except: a cell holding only a dash ("not applicable", e.g. Medicare before July 1966,
  Part D before 2004) is empty; CSV "$" and thousands separators are dropped ("5,278.60" -> 5278.60); Excel floats
  are written with Excel's 15 significant digits (74.099999999999994 -> 74.1); a cell stored as a percent-format
  fraction is written as displayed (0.371 shown as 37.1% -> 37.1; the note gives the count). SSA cells holding a
  footnote letter instead of a number stay as published: "b" in IV.B5 = reserves depleted at the start of the year,
  "e" in IV.B1 = between -0.005 and 0.005. SSA years can carry footnote letters ("2033b"): use the `year` column.
  The Figures workbook holds chart data at full precision, some as fractions (II.F1, III.B3) and some as percents:
  read the figure title for the unit.
- Assumptions: SSA tables stack Historical data, Intermediate, Low-cost and High-cost blocks (`section`); the
  intermediate assumptions are the Trustees' central projection. Medicare tables show historical years then the
  intermediate projection; Medicare's illustrative alternative scenario (IAS) is a separate table, not a forecast.
- Units differ by table: nominal (current) dollars, CPI-indexed constant dollars (VI.G4, VI.G5), percent of GDP,
  percent of taxable payroll (cost and income rates). Medicare operations tables are in millions on a cash basis;
  SSA VI.G2 is in billions. NHE `service_funds` is in millions, `summary` and the tables in billions. Never mix
  them without converting.
- Years: Trustees Report tables are calendar years. The report year is not the data year: the 2026 Medicare
  report has actual data through 2025, projections from 2026. NHE historical data come out once a year around the
  turn of the year and revise earlier years (the historical page was last modified 2026-01-14, data through 2024;
  comprehensive benchmark revisions every five years, 2024 the latest); projections come out mid-year (the
  projected page was last modified 2026-06-24: projections 2025-2034 from the 2024 base). A new release replaces
  the files under the same names: say which release was used.
- Depletion dates are per fund. From the 2026 report files (read 2026-10-30): HI reserves become depleted in 2033
  (Operations of the HI Trust Fund, note 21; the year-end 2033 balance is negative and hypothetical); OASI in 2032
  and combined OASDI in 2034, with DI not depleted within the 75-year period (SSA IV.B5; VI.G2 footnote b: combined
  2034, 2048, 2032 under intermediate, low-cost, high-cost). Combined OASDI is a hypothetical fund. Values after
  depletion are not payable benefits: SSA stops the series ("not shown"), Medicare shows negative balances.
- NHE covers all payers (households, employers, all governments); it is not federal spending and not Medicare
  outlays in the budget sense. Health consumption expenditures exclude investment (research, structures).
- Coverage of the pack: only the latest NHE release (the CMS file names have no year); Medicare ZIPs for the 2022-2026
  reports (older reports are PDFs). SSA two-block tables (IV.B5 with its text block on depletion years) read with
  some header rows as `section`: check the columns.

## Access
CMS: no key, the host answers scripts (verified 2026-10-30); route `api`, one request per second. If a CMS page
changes so the link is not found, the fetch says so; download the ZIP by hand (manual route) and upload it.
SSA: www.ssa.gov answers every script (urllib, curl) with HTTP 403 "Access Denied" (Akamai bot filter, verified
2026-10-30), so `ssa_tr_table` never fetches: `--check` returns `manual_download` with a bundle and a fetch stops as
`blocked` with the same route. The user opens https://www.ssa.gov/oact/TR/2026/lrIndex.html in a web browser, clicks
the "Excel" link of the single-year tables (SingleYearTRTables_TR2026.xlsx, about 400 KB, every sheet in one
file), saves it and uploads it; `--ingest` reads the sheet named by `table`. Other report tables (e.g. the
long-range actuarial balance in section IV.B) are on the report pages https://www.ssa.gov/oact/TR/2026/ (HTML, not
read by the pack). Manual route for CMS: the bundle links the ZIP named on the page; upload it as downloaded.

## Citation and terms
Social Security Administration and Centers for Medicare & Medicaid Services, Offices of the Chief Actuary, <spec
description> (Trustees Report tables and National Health Expenditure data, ssa.gov/oact and cms.gov), retrieved
<date>. Name the report year (e.g. "2026 Medicare Trustees Report", "2026 OASDI Trustees Report") and the NHE
release in the text. Public domain (U.S. government works, 17 U.S.C. 105): redistribution allowed.
