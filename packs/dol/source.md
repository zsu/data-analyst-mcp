# Department of Labor (DOL Open Data API: OSHA, WHD, ETA unemployment claims, MSHA; OUI unemployment insurance trust fund files)
Depth: standard. Key: required for API data (DOL_API_KEY); the dataset catalog and the unemployment insurance
trust fund files (oui.doleta.gov) are keyless. OSHA inspections, violations and accident investigations; Wage
and Hour Division enforcement cases (back wages, penalties); weekly unemployment insurance claims (national and
state); MSHA mines, inspections and violations; the other 45 datasets of the DOL API v4; and each state's
unemployment trust fund by month (ETA 2112: balances, UI tax contributions, interest, benefits paid) with the
quarterly UI Data Summary (Title XII loan balances, solvency measures).

## When to use
- Workplace safety enforcement: OSHA inspections by state, industry (NAICS/SIC), establishment, type;
  violations and penalties; fatality and injury investigations. Mine safety (MSHA).
- Wage theft enforcement: WHD cases with back wages, employees owed, civil money penalties by law
  (FLSA minimum wage and overtime, child labor, FMLA, Davis-Bacon, SCA, H-1B, H-2A).
- Weekly initial and continued UI claims, national (seasonally adjusted and not) and by state.
- Unemployment insurance trust fund finances (keyless): a state's trust fund balance by month since 1979, UI tax
  (contribution) receipts, Treasury interest credited, benefits paid, federal program flows (ETA 2112); the
  latest quarter's trust fund and Title XII loan balances, tax rates, reserve ratio and average high cost
  multiple by state (UI Data Summary). The annual Trust Fund Solvency Report
  (https://oui.doleta.gov/unemploy/solvency.asp, PDF only, not fetched) is the published benchmark for solvency
  measures (average high cost multiple, reserve ratio, Title XII advances since 2020).
- Not here: unemployment rate, payroll jobs, wages, CPI, injury and illness rates (bls); the
  official monthly employment situation (bls); federal workforce (opm); federal contracts to the
  employers (usaspending); Treasury's daily Unemployment Trust Fund account balances (state and federal
  accounts) and Title XII advances by state (treasury: utf_account_balances, title_xii).

## Endpoints and datasets
| Endpoint | Key | Returns | Key parameters |
|---|---|---|---|
| `query` | yes | rows of one dataset | `dataset`, `filters`, `search`, `state`, `filter_object`, `fields`, `sort_by`, `sort` |
| `datasets` | no | the 45-dataset catalog: agency, api_url, name, frequency, tags | none |
| `dataset_info` | no | the field dictionary: column_name, data_type, column_desc | `dataset_id` (number or alias) |
| `ui_trust_fund` | no | ETA 2112, one row per state and month (1979-01 on), dollars, 134 readable columns | `state` (code or list), `start`, `end` (YYYY-MM), `latest` (true: each state's newest month), `fields` |
| `ui_data_summary` | no | UI Data Summary, latest calendar-year quarter, one row per state + United States | `sheet`: Financial (default), Wage and Tax Rate, Regular Benefits, Benefits and Duration, Labor Force |

Main aliases (`--search "words"` or `--endpoints` for all 45): `osha_inspection` (OSHA/inspection,
daily; state field site_state; default sort open_date), `osha_violation` (issuance_date),
`osha_accident` (event_date), `osha_accident_injury`, `osha_accident_abstract`, `whd_enforcement`
(WHD/enforcement, quarterly; st_cd; findings_end_date), `eta_ui_national_weekly_claims`
(ETA/ui_national_weekly_claims, rptdate), `eta_ui_state_weekly_claims` (st; rptdate),
`msha_mines`, `msha_inspection`, `msha_violation`, `msha_accident`, `eta_apprenticeship_data`,
`eta_otaa_petition` (trade adjustment petitions), `wb_ndcp` (childcare prices), `vets_4212`.
Codes (DOL's field dictionary, `dataset_info` osha_inspection, verified 2026-10): OSHA insp_type
A accident, B complaint, C referral, D monitoring, E variance, F follow-up, G unprogrammed related,
H planned, I programmed related, J unprogrammed other, K programmed other, L other, M fatality/catastrophe,
N unprogrammed emphasis; viol_type S serious, W willful, R repeat, O other-than-serious, U
unclassified; degree_of_inj 1 fatality, 2 hospitalized, 3 not hospitalized.

`ui_trust_fund` columns are `st`, `rptdate` (last day of the month) and `<line item>_<account>` from the ETA 2112
data map (ET Handbook 402; the file's codes c1..c136 are mapped in endpoints.json `columns`). Accounts: `total`
(the report's column C, sum of the other three), `clearing` (state clearing account, where taxes arrive), `utf`
(the state's account in the Unemployment Trust Fund at Treasury), `bpa` (benefit payment account). Main columns:
`balance_close_utf` (c87, the state trust fund balance at month end), `balance_close_total` (c85, all three
accounts), `balance_forward_*` (start of month), `deposits_*` and `disbursements_*` (totals),
`dep_ui_contributions_total` (c9, net UI tax contributions), `dep_penalty_interest_total`,
`dep_treasury_interest_utf` (c14, interest credited by Treasury), `dep_reimb_*` (reimbursing employers),
`dep_federal_share_eb_utf`, `dep_other_sources_1..5_*`, `dis_ui_benefits_total` (c51, net regular UI benefits),
`dis_state_share_eb_total`, `dis_ucfe_*`, `dis_ucx_*`, pandemic programs (`dep_/dis_fpuc`, `pua`, `peuc`,
`meuc`, `temporary_federal_comp`), `dis_other_*`, `withholding_*`. `ui_data_summary` Financial columns:
`cyq` (2026.2 = April-June 2026), `quarter_end`, `state`, `st`, `revenues_thousands`,
`net_trust_fund_balance_thousands` (balance minus loans), `tf_balance_thousands`, `loan_balance_thousands`
(Title XII), `interest_earned_thousands`, `current_taxable_wage_base` (dollars), `note`; Wage and Tax Rate:
`tf_as_pct_of_total_wages` (the reserve ratio), `ahcm`, `hcm`, tax rates.

## Spec examples
```json
{"description": "WHD enforcement cases in Texas, newest first",
 "requests": [{"name": "whd_tx", "endpoint": "query", "params": {"dataset": "whd_enforcement", "state": "TX"},
   "max_rows": 5000}]}
```
```json
{"description": "OSHA accident and complaint inspections of Amazon establishments in California since 2024",
 "requests": [{"name": "amazon_ca", "endpoint": "query",
   "params": {"dataset": "osha_inspection", "state": "CA", "search": {"estab_name": "amazon"},
              "filters": {"insp_type": ["A", "B"], "open_date": {"gt": "2024-01-01"}}}}]}
```
```json
{"description": "Weekly national UI claims since 2020 with the column dictionary",
 "requests": [{"name": "ui_national", "endpoint": "query",
   "params": {"dataset": "eta_ui_national_weekly_claims", "filters": {"rptdate": {"gt": "2019-12-31"}}, "sort": "asc"}},
  {"name": "ui_fields", "endpoint": "dataset_info", "params": {"dataset_id": "eta_ui_national_weekly_claims"}}]}
```
```json
{"description": "UI trust fund: Wyoming's latest month, two states since 2025, Title XII loans and solvency (keyless)",
 "requests": [{"name": "wy_latest", "endpoint": "ui_trust_fund", "params": {"state": "WY", "latest": true}},
  {"name": "ca_tx", "endpoint": "ui_trust_fund", "params": {"state": ["CA", "TX"], "start": "2025-01",
   "fields": ["balance_close_utf", "dep_ui_contributions_total", "dep_treasury_interest_utf", "dis_ui_benefits_total"]}},
  {"name": "loans", "endpoint": "ui_data_summary", "params": {"sheet": "Financial"}},
  {"name": "solvency", "endpoint": "ui_data_summary", "params": {"sheet": "Wage and Tax Rate"}}]}
```

## Data format and traps
- Field names are DOL's, not friendly ones. The UI claims tables use coded columns: national `c1`/`c2`
  seasonal factors (initial, continued), `c3` covered employment, `c4` initial claims NSA, `c5` initial
  claims SA, `c6` continued claims NSA, `c7` continued claims SA, `c8`/`c9` 4-week averages (SA);
  state `st`, `c3` state UI initial claims, `c8` state UI continued weeks claimed, `c18` covered
  employment (12-month average), `c19` 13-week insured unemployment rate (extended-benefit trigger), and more (the fetch notes list every column; or use
  `dataset_info`). `rptdate` is the week-ending date. State tables are not seasonally adjusted.
- Filters: `filters` {field: value} is an exact, case-sensitive equals; a list means `in`; {"gt": x,
  "lt": y, "neq": z, "like": "%x%"} adds those operators (DOL has only eq, neq, gt, lt, in, not_in,
  like). `search` {field: text} matches a substring in several spellings (as typed, UPPER, lower,
  Title), because `like` is case-sensitive and has no implicit wildcards: OSHA estab_name is upper case,
  WHD trade_nm mixed. Mixed-case names in other spellings ("McDonald's" vs "MCDONALDS") still differ:
  try variants. All conditions are combined with AND; a raw `filter_object` is ANDed too.
- Date fields: comparisons on dates with gt/lt are as the API evaluates them (unverified without a key:
  check the first rows). Dates come as text, some with a time (`2005-12-20T00:00:00`).
- Sorting defaults to the dataset's date field, newest first; `"sort_by": ""` keeps the API's own order.
  Paging is limit/offset, 1,000 rows per call (the API allows up to 10,000 rows or 5 MB).
- Field names are checked by `--check` against the keyless field dictionary (`dataset_info`), so a wrong
  name is `fix_spec` even without a key (when the dictionary cannot be read, the check is skipped; a field
  the API has but the dictionary lacks: `"check_fields": false` on that request). `osha_inspection` has no county field: filter on
  `site_city` or `site_zip` (or fetch the state and select in analysis.py).
- An unmatched filter returns no rows (the fetch then fails with a hint); an unknown field or operator
  is an HTTP 400 with the API's message.
- Counts of inspections, violations or cases measure enforcement activity, which depends on staffing and
  targeting; they are not rates of violations. OSHA state-plan states run their own inspections
  (reporting_id tells the office). Penalties: initial vs current (after settlement) differ.
- WHD: a change in data collection on 2025-10-01 changed how violations are counted (case_violtn_cnt and
  related columns per DOL's field notes); back wages are amounts agreed to be paid, not collected.
- Names that do not exist: ETA/ui_claims_national and ETA/ui_claims_state (the live names are
  ui_national_weekly_claims and ui_state_weekly_claims); OSHA accident has no state field.
- ETA 2112 (`ui_trust_fund`): amounts in dollars (CA's June 2026 balance_close_utf 18,308,724.16 = the Data
  Summary's 18,309 thousand). Monthly by state, 53 jurisdictions (50 states, DC, PR, VI); `rptdate` is the month
  end. States report with lags (in the 2026-10-30 file 39 states had September 2026, others stopped at August or
  June): use `latest` per state and say each state's month; earlier months are revised when states resubmit. The
  file is replaced in place (23 MB; the whole file is downloaded and filtered). Flows are for the month, balances
  at month end; the report's own identities hold (balance_close = balance_forward + deposits - disbursements, per
  account). The map prints c23 twice on line 17; the report edits show the benefit payment account cell is c24
  (dep_interstate_benefits_bpa).
- Trust fund balance: `balance_close_utf` is the state's report of its Unemployment Trust Fund account. The Data
  Summary's `tf_balance_thousands` is Treasury's cash balance at quarter end (Bureau of the Public Debt, per its
  definitions) and can differ from the state's report (June 2026: equal for AK, AZ, AR, CA, CO, DC; WY 576.5
  million in the Data Summary vs 571.9 million in the 2112). Say which one you use. Neither nets out loans: a
  borrowing state can show a positive balance (CA) while it owes billions.
- Title XII loans: the 2112 has no line named for federal (Title XII) advances; they appear to arrive through
  the Other Sources lines (CA's dep_other_sources_2_utf, about $0.5 billion a month in 2026) but this is NOT
  verified (ET Handbook 401's reporting instructions could not be read: dol.gov refuses scripts). For loans
  outstanding use `ui_data_summary` Financial `loan_balance_thousands` (end of quarter, from Treasury;
  CA 18.72 billion in 2026 Q2) and `net_trust_fund_balance_thousands` (balance minus loans), or Treasury's
  daily Title XII advance data (treasury pack, v2/accounting/od/title_xii; linked from
  https://oui.doleta.gov/unemploy/budget.asp). States may also owe non-Title XII debt (bonds), which no column
  here includes.
- Federal accounts: the Unemployment Trust Fund also holds federal accounts (ESAA for administration, EUCA for
  the federal share of extended benefits, FUA for Title XII loans to states) funded by the federal unemployment
  (FUTA) tax; they are not in the 2112 or the
  Data Summary (Treasury's UTF account balances: treasury pack, v1/accounting/od/utf_account_balances). The national total of state
  balances is not the trust fund total.
- UI Data Summary (`ui_data_summary`): one quarter only (the file is replaced each quarter: 2026.2 in 2026-10);
  money in thousands of dollars except `current_taxable_wage_base` (dollars) and rates in percent; the Wage and
  Tax Rate sheet (tax rates, reserve ratio `tf_as_pct_of_total_wages`, `ahcm`, `hcm`) lags two quarters (2025.4)
  and its solvency measures exclude non-Title XII debt; `NA` (e.g. a borrowing state's AHCM) is empty; `note`
  carries the "*" footnote (states missing some monthly revenue reports); Labor Force covered employment lags
  6 months and is in thousands. AHCM = reserve ratio / average of the three highest calendar-year benefit cost
  rates in the last 20 years (Data Summary definitions); the Solvency Report calls an AHCM above 1.0 the
  minimum adequate level going into a recession.

## Access
Key: free; register at https://dataportal.dol.gov/registration (login.gov), then copy a key from
https://dataportal.dol.gov/api-keys (up to 5 keys; sharing keys is prohibited). The key travels as the
`X-API-KEY` query parameter (DOL API User Guide; the pack never logs it). Without a key only `datasets`
and `dataset_info` run (route `api`); data requests route to `run_setup` (local) or `manual_download`
(sandbox). Manual route: `manual_download/INSTRUCTIONS.md` has one link per 1,000 rows with
`{API_KEY}` to replace (or one command runs download_data.sh / .ps1, which asks for the key hidden); upload, then `--ingest`. Other
sources of the same data: the API Query Builder on each dataset page, https://www.osha.gov/data,
https://enforcedata.dol.gov, https://oui.doleta.gov/unemploy/claims.asp (weekly claims).
The unemployment insurance trust fund files need no key and never receive it (a separate client fetches them
from oui.doleta.gov): `ui_trust_fund` and `ui_data_summary` route `api` without a key (or `bulk` when only
oui.doleta.gov answers). Manual: download https://oui.doleta.gov/unemploy/csv/ar2112.csv (listed on
https://oui.doleta.gov/unemploy/DataDownloads.asp with its data map) or
https://oui.doleta.gov/unemploy/data_summary/SummaryTables.xlsx (https://oui.doleta.gov/unemploy/data_summary/DataSum.asp),
upload it unchanged, then --ingest (the spec's state, month and field filters are applied then).

## Citation and terms
"U.S. Department of Labor, <agency> <dataset name>, DOL Open Data API, retrieved <date>." For the trust fund
files: "U.S. Department of Labor, Employment and Training Administration, Office of Unemployment Insurance,
ETA 2112 UI Financial Transaction Summary (ar2112.csv) [or UI Data Summary, <quarter>], oui.doleta.gov,
retrieved <date>." Public domain;
redistribution allowed. Enforcement records name employers: present them as DOL records (findings and
citations can be contested). Not verified live in this pack's tests (no key): data columns and the
filter syntax follow the DOL API User Guide and the field dictionaries.
