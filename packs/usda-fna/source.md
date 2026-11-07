# USDA Food and Nutrition Administration: SNAP, WIC and child nutrition program data, SNAP State Options Report and SNAP State Activity Reports
Depth: standard. Key: none. FNA's Program Data tables cover participation, meals and costs. SNAP, WIC and the child
nutrition programs (school lunch and breakfast, special milk, CACFP, summer meals) are national from FY 1969 and by
state for recent years and months. Two SNAP reports cover states:
- the State Options Report gives each agency's policy options, waivers and projects (editions 1-17, 2002-2025);
- the State Activity Reports give participation, issuance, admin costs, hearings, fraud and claims (FY 2004-2023).

## When to use
- Participation, meals or costs of SNAP, WIC or the child nutrition programs:
  - national, by year since 1969 (`*_annual`) or by month for the last four fiscal years (`*_monthly`);
  - by state for the last five fiscal years (`*_state`) or the latest three months (`*_latest`);
  - SNAP by state and month from FY 2020 (`snap_state_monthly`);
  - WIC by state agency, tribal organization and month, with participant categories (`wic_agency_monthly`).
- Which states use an option or waiver (BBCE, ABAWD time limit waiver, simplified reporting, drug felony ban,
  combined application projects ...). One state's choices compared with another's. A state's SNAP administrative
  cost, federal share, cost per case, fair hearings, fraud investigations, disqualifications or claims for
  FY 2019-2023 (tidy rows), or for FY 2004-2018 (page text).
- Not here:
  - SNAP by state and month before FY 2020 (old .xls files in the same zip; this pack does not read them);
  - characteristics of SNAP households from the Quality Control microdata (snapqcdata.net): snapqc;
  - official payment error rates (PDF charts at https://www.fna.usda.gov/snap/qc/per): not covered;
  - P-EBT and SNAP by county/project area (zips on the SNAP page): not read;
  - poverty and SNAP receipt in household surveys: census (ACS), ipums;
  - federal spending on SNAP by recipient: usaspending.
- The agency was renamed: the Food and Nutrition Service (FNS) is now the Food and Nutrition Administration (FNA).
  fns.usda.gov redirects to www.fna.usda.gov. The reports up to 2025 still say FNS.

## Endpoints and datasets
Verified live 2026-10-30. One CSV per request.

| Endpoint | Returns (one row per) | Key parameters | Coverage |
|---|---|---|---|
| `options_by_state` | agency × policy option: `edition, state, state_abbr, policy_option, option_selection, agencies_with_selection, share_of_agencies` | `state` (names or USPS codes, default all 53), `edition` (`16`, `17`, default 17) | policy options only (13-16 per agency); no waivers or projects |
| `option_states` | agency with a selection: `edition, policy_option, option_selection, state, state_abbr` | `policy` (catalog alias or name, required), `selection` (default: every selection, so each agency once), `edition` | every policy, waiver and project of editions 16-17 |
| `options_report` | PDF page: `edition, edition_label, page, state, text` | `edition` (1-17), `state` (keeps that agency's profile pages; editions 16-17), `pages` | all 17 editions; needs pypdf |
| `activity_tables` | value: `report_fy, table, table_number, table_title, page, state, state_abbr, row_type, measure, data_fy, value, value_num, value_flag` | `fiscal_year` (2019-2023, one or a list), `tables` (keys below, default all), `state` | FY 2019-2023; needs pypdf |
| `activity_report` | PDF page: `report_fy, page, table_title, text` | `fiscal_year` (2004-2023), `pages` | every year; national summary and rankings; needs pypdf |
| `program_table` | value: `table, table_title, data_as_of, state, state_abbr, agency, row_type, period, period_type, fiscal_year, measure, unit, value, value_num, value_flag, status, footnote` | `table` (catalog key, required), `state` (state tables only), `fiscal_year` | 34 FNA Program Data tables (below); updated monthly |
| `snap_state_monthly` | value, same columns | `fiscal_year` (2020 onward, one or a list), `state` | SNAP households, persons, benefits, benefit per household / person by state, FNA region and U.S., each month and the fiscal year |
| `wic_agency_monthly` | value, same columns | `fiscal_year` (2022 onward, one a request), `measures` (default `participants_total`; `all`), `state` | WIC by state agency, tribal organization and region, each month and the fiscal year |

- `program_table` keys (`--endpoints` lists them with descriptions):
  - SNAP: `snap_annual` (FY 1969-), `snap_monthly`, and by state for the latest three months
    `snap_persons_latest`, `snap_households_latest`, `snap_benefits_latest`;
  - WIC: `wic_annual` (FY 1974-), `wic_monthly`; by state for five fiscal years `wic_participation_state`,
    `wic_food_costs_state`, `wic_avg_food_cost_state`, `wic_nsa_costs_state`; and `wic_participation_latest`;
  - child nutrition, national: `nslp_annual`, `sbp_annual`, `smp_annual`, `cacfp_annual`, `sfsp_annual`,
    `school_meals_costs` (cash and commodities, FY 1969-), `nslp_monthly`, `sbp_monthly`, `cacfp_monthly`;
  - child nutrition, by state for five fiscal years: `nslp_participation_state`, `nslp_lunches_state`,
    `nslp_cash_state`, `nslp_commodities_state`, `sbp_participation_state`, `sbp_breakfasts_state`,
    `sbp_cash_state`, `smp_half_pints_state`, `cacfp_attendance_state`, `cacfp_meals_state`, `cacfp_cash_state`,
    `sfsp_attendance_state`, `sfsp_meals_state`, `sfsp_cash_state`; latest three months:
    `nslp_participation_latest`, `sbp_participation_latest`.
- `wic_agency_monthly` measures: `pregnant_women`, `women_fully_breastfeeding`, `women_partially_breastfeeding`,
  `breastfeeding_women_total`, `postpartum_women`, `women_total`, `infants_fully_breastfed`,
  `infants_partially_breastfed`, `infants_fully_formula_fed`, `infants_total`, `children`, `participants_total`,
  `avg_food_cost_per_person`, `food_costs`, `rebates`, `nsa_costs` (fiscal-year total only).

- `--endpoints` lists the policy catalog. Each entry has an alias, the exact dashboard name and its selections.
  Examples:
  - options: `bbce`, `reporting_requirements`, `certification_period_lengths`, `utility_expenses`,
    `employment_training`, `drug_felony`, `tba`, `abawd_exemptions`;
  - waivers: `abawd_waiver`, `telephonic_signature_waiver`, `on_demand_interview_waiver`, `early_denial_waiver`;
  - projects: `cap`, `esap`, `smd`.
- `activity_tables` table keys:
  - participation: `participation_issuance` (FY 2019 only), `average_benefit`, `emergency_allotments`
    (FY 2021-2023), `households_by_benefit_type`, `persons_by_benefit_type`, `issuance_by_benefit_type`;
  - costs: `admin_costs`, `covid_admin_funding` (FY 2021), `admin_costs_per_case`,
    `federal_admin_costs_per_case` (FY 2019-2020), `federal_selected_costs`, `federal_adp_costs`,
    `federal_cert_costs_per_case`;
  - fair hearings and fraud: `fair_hearings`, `adh`, `fraud_investigations`, `prosecutions`, `disqualifications`;
  - claims: `claims_established_dollars`, `claims_established_count`, `claims_collected_by_type`,
    `claims_collected_by_method`;
  - multi-year comparisons, each value with its own `data_fy`: `persons_multiyear`, `households_multiyear`,
    `issuance_multiyear` (three years), `federal_costs_multiyear`, `federal_costs_per_case_multiyear`,
    `federal_cert_costs_multiyear`, `federal_cert_costs_per_case_multiyear`, `fair_hearings_multiyear`,
    `disqualifications_multiyear`, `claims_established_multiyear`, `claims_collected_multiyear` (two years).
- State-level persons, households and total issuance for FY 2020-2023 are in the `*_multiyear` tables. The
  single-year participation table exists only in FY 2019.

## Spec examples
```json
{"description": "Which SNAP agencies use BBCE and have an ABAWD time limit waiver (17th edition)",
 "requests": [{"name": "bbce", "endpoint": "option_states", "params": {"policy": "bbce"}},
              {"name": "abawd_waiver", "endpoint": "option_states", "params": {"policy": "abawd_waiver"}}]}
```
```json
{"description": "Texas and California SNAP policy options, and Texas's full profile with waivers (PDF)",
 "requests": [{"name": "tx_ca", "endpoint": "options_by_state", "params": {"state": ["TX", "CA"]}},
              {"name": "tx_profile", "endpoint": "options_report", "params": {"edition": 17, "state": "TX"}}]}
```
```json
{"description": "SNAP administrative costs and households by state, FY 2022-2023",
 "requests": [{"name": "sar", "endpoint": "activity_tables",
               "params": {"fiscal_year": [2022, 2023], "tables": ["admin_costs", "admin_costs_per_case"]}}]}
```

```json
{"description": "SNAP persons by state and month FY 2025-2026 (TX, CA); school lunch participation by state; WIC children by agency FY 2025",
 "requests": [{"name": "snap_tx_ca", "endpoint": "snap_state_monthly", "params": {"fiscal_year": [2025, 2026], "state": ["TX", "CA"]}},
              {"name": "nslp", "endpoint": "program_table", "params": {"table": "nslp_participation_state"}},
              {"name": "wic_children", "endpoint": "wic_agency_monthly", "params": {"fiscal_year": 2025, "measures": ["children", "participants_total"]}}]}
```

## Data format and traps
Program Data tables (`program_table`, `snap_state_monthly`, `wic_agency_monthly`; verified 2026-10-30):
- **Fiscal years.** Every period is a federal fiscal year (October-September) or a month (`period` 2026-07,
  `fiscal_year` 2026 for Oct 2025-Sep 2026). A school year (SY 2024-25) is not FY 2025. `period_type` says which.
- **Units differ by table.** Read `unit` on every row:
  - the national annual tables are in thousands or millions (SNAP participation in thousands, costs in millions);
  - state and monthly tables are in units;
  - shares are fractions (0-1) in the monthly tables but percent in the annual tables;
  - participation is a monthly average (SNAP, WIC), a 9-month school-year average (NSLP, SBP: summer months
    excluded) or July average daily attendance (SFSP).
- **Fiscal-year rows of a year in progress are partial.** `snap_monthly` "FY 2026" averages Oct-Jul; a
  `snap_state_monthly` FY total averages the months reported (later months print `--`).
- **status**: `initial` (the newest month), `preliminary` (the month before, or a year the workbook calls
  preliminary), else empty. Recent months are revised; label them. The WIC agency workbooks call every year
  "preliminary", even FY 2025, which the listing page calls final.
- **row_type** separates what must not be summed together:
  - `state`: a state or territory (DC, GU, VI, PR, AS, MP); `dod`: Department of Defense schools;
  - `total`: the printed TOTAL; `national`: U.S. rows of the national tables; `region`: FNA regions;
  - WIC by state (`wic_*_state`, `wic_participation_latest`): the `state` row is the state total. Its parts
    (state agency, Indian tribal organizations) are `sub_agency` rows with the part's name in `agency`;
  - WIC by agency (`wic_agency_monthly`): `state_agency` is the state agency alone, without the tribes (Arizona
    146,899 vs 157,533 with them, FY 2025), and `tribal_org` rows carry their state's code.
  - Drop totals, regions and sub-agencies before summing states. The pack checks agency sums against the printed
    totals and notes any difference.
- **Missing values**: `--` (none or not reported), `blank` (an empty cell), `#DIV/0!` (a spreadsheet error), or a
  footnote mark such as `1]` (e.g. reduced-price meals included with free before 1971). `value_flag` holds them;
  a flag is never a zero. `footnote` holds marks printed beside a year or value (`1982 3]`: Puerto Rico left SNAP).
- **Puerto Rico, American Samoa and the Northern Marianas** get Nutrition Assistance Grants, not SNAP: their SNAP
  rows are `--`.
- **The pack never relabels a header.** `wic_participation_latest` labels its middle column with the year before
  (in every release still online, 27wilatest-5 to -10, May-October 2026: "June 2025" over June 2026 values). The
  pack drops the column, names it and marks the request incomplete. Read that month from `wic_agency_monthly`
  instead. Releases -5 to -9 also print "Data as of" a year early (September 11, 2025 for 2026). When "Data as of"
  precedes the table's own latest data, a note says so; `data_as_of` stays as printed, so cite the release by file
  name and retrieval date rather than that date. Any table whose columns no longer match their labels in
  endpoints.json fails with "expected layout"; values in hidden columns (`nslp_monthly`, `cacfp_monthly`) are skipped.
- **File names change.** Each workbook name carries a release number (`snap-persons-10.xlsx`). The pack reads the
  current name from the listing page; a table missing there fails rather than falling back.

SNAP State Options Report and State Activity Reports:
- **Editions are not fiscal years.** The 17th edition (Aug 2025) gives options in place on Oct 1, 2024, from the
  FFY 2025 State Plans. The 16th edition (Jun 2024) is from the FFY 2024 plans. Name the edition with every count.
- **Names change between editions.** Option and selection wording changes from one edition to the next (16th
  "Child support income expense deduction", 17th "Deducted from income"; "entire" vs "whole" household), and
  options come and go in the dashboard: self-employment income and the two noncitizen-income options are 16th
  only; Pledge States, SNAP E&T and nine waivers are 17th only (verified 2026-10-30; the catalog descriptions
  say which). For an option missing from an edition's dashboard, read that edition's PDF. Match by meaning, say so, and never splice editions silently.
- **53 state agencies, not 50 states**: the 50 states, DC, Guam (GU) and the Virgin Islands (VI). The reports' "all
  States" means 53. `agencies_with_selection` and `share_of_agencies` are national counts across the 53
  (the share is a fraction), repeated on each agency's row, not a value for that agency.
- **Several selections per agency**: Certification Period Lengths gives one row per length offered
  ("4,6,12" in `options_by_state`), so states can add up to more than 53.
- **The dashboard is not an API.** The pack checks every exported row against the policy, selection and edition
  asked for: an unknown value makes the dashboard fall back to its default view. If FNA republishes the
  dashboard, the view path changes. The error says so; use `options_report` (the PDF) instead.
- **activity_tables values** are as printed. `value_num` drops `$ , %`. `value_flag` keeps codes: `N/A` (not
  applicable, e.g. no cash issuance), `-`/`--` (none or not reported), `blank` (not printed; a footnote may say
  the data are missing, e.g. DC claims FY 2021). A flag is never a zero.
  - Units: dollars, monthly-average persons or households, counts, and percent (`percent_upheld`,
    `*_percent_change`).
  - Each table also has `row_type = us_total` rows, the printed U.S. line. Drop them before summing agencies.
- **The pack checks each table against the PDF.**
  - A table is kept only if its values line up with its columns and the column labels appear in the printed
    header.
  - A table that fails is dropped, and the fetch reports it as incomplete with the page to read with
    `activity_report`.
  - Agency sums are compared with the printed U.S. total, and the fetch notes any difference. Known published
    differences: FY 2020 emergency-allotment persons and households (the U.S. figure is about 60% of the agency
    sum), FY 2021 cash participation, and the FY 2022 state and federal shares of admin costs (about 0.6%).
  - Report such a difference; do not fix it.
- **Emergency allotments** (pandemic supplements, ended after Feb 2023) are in issuance for FY 2020-2023. The
  reports exclude P-EBT, Disaster SNAP and replacements of stolen benefits.
- **100% federal funding.** ARPA (FY 2021-2023) and CAA 2021 paid 100% federal administrative funding on top of
  the usual 50% share: `arpa_funding` (FY 2022-2023 admin_costs) and `covid_admin_funding` (FY 2021).
- **Mislabeled headers in the source.** The FY 2019-2021 persons multi-year tables print "Households
  Participating" in their column headers. The table title (persons) is right; the pack labels by title.
- **Single-year vs multi-year.** A value can appear in a single-year table and again in a later report's
  multi-year table. They agree where checked (persons, households, issuance, federal costs, FY 2019-2023). Use one
  source per figure.

## Access
- No key. Hosts:
  - www.fna.usda.gov: the Program Data listing pages and workbooks, and the PDFs (files redirect to
    fna-bwbufwdzbabpezgc.z01.azurefd.us);
  - publicdashboards.dl.usda.gov: the Tableau dashboard's CSV exports.
- Plain scripted requests are answered (verified 2026-10-30). The pack sends one request a second.
  `options_by_state` makes one call per two agencies (27 calls for all 53); `option_states` makes one per selection.
  A Program Data request makes two calls (the listing page, then the 15-230 KB workbook);
  `snap_state_monthly` downloads the 1.6 MB SNAP zip once per request.
- The PDF endpoints need the Python package pypdf. Without it the fetch reports `install_deps`; the dashboard
  endpoints do not need it.
- Manual route: `manual_download/INSTRUCTIONS.md` lists every file. Each PDF is a direct download; each dashboard
  `.csv` link downloads a small CSV. Save under the name shown and upload; `--ingest` parses them the same way.
  The Program Data links name the release seen on 2026-10-30 (`-10`). If one is gone, download that table's
  Excel file from its listing page. Uploads are checked by content (title row, fiscal year), not by name.
  Without the bundle:
  - Program Data: https://www.fna.usda.gov/pd/supplemental-nutrition-assistance-program-snap,
    https://www.fna.usda.gov/pd/wic-program, https://www.fna.usda.gov/pd/child-nutrition-tables
  - State Options Report PDFs: https://www.fna.usda.gov/snap/waivers/state-options-report
  - State Activity Reports: https://www.fna.usda.gov/pd/snap-state-activity-reports
  - The dashboard (https://www.fna.usda.gov/data-research/data-visualization/snap/state-options) has no download
    button.

## Citation and terms
U.S. Department of Agriculture, Food and Nutrition Administration, SNAP State Options Report, 17th edition (or SNAP
State Activity Report, FY <year>; or Program Data: <table title>, data as of <data_as_of>), fna.usda.gov, retrieved
<date>. Name the edition (and its as-of date), the report year or the data-as-of date with every number. Public domain (works of a federal agency, 17 U.S.C. 105); redistribution allowed.
