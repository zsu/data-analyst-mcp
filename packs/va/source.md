# VA Open Data (data.va.gov) and NCVAS Veteran Statistics
Depth: standard. Key: none. Department of Veterans Affairs open data on www.data.va.gov (Socrata): the
VetPop2023 veteran population projections (nation, state, county, congressional district, VISN), disability
compensation and pension recipients and dollars, plus the NCVAS Geographic Distribution of VA Expenditures
(GDX) workbooks from www.va.gov/vetdata.

## When to use
- Number of veterans by state, county, congressional district, age, sex, period of service or
  race/ethnicity, 2000-2023 (estimates) and 2023-2053 (projections); projected veteran deaths by county.
- VA spending by state, county or congressional district (GDX); disability compensation recipients by county
  and rating; pension recipients by state; estimated annual compensation and pension dollars by state.
- Not here: survey counts of veterans and their income, poverty or disability (census ACS, ipums);
  veterans' unemployment (bls); VA obligations by award or recipient (usaspending); VA budget outlays
  (treasury).
- Not public: VA enrollment and health care use projections from the Enrollee Health Care Projection Model
  (internal to VA; only summaries appear in the budget submission). Current VA health care enrollees or
  patients by state are not on data.va.gov as a table (only FY2015 enrollees by county, as a file). Patients and
  average spending per patient by priority group exist only as old Excel files through FY2018
  (https://www.data.va.gov/d/f2az-8wb5 and https://www.data.va.gov/d/4rcf-gbi9): manual, not the API.

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `query` | JSON rows of one data.va.gov dataset | `dataset` (alias or 4x4 id), `$select`, `$where`, `$group`, `$order`, `$q` |
| `csv` | the same as CSV (manual route) | same |
| `gdx_state_direct`, `gdx_state_indirect` | GDX workbook, state sheets (direct: compensation & pension, DIC and survivors pension, insurance, adapted housing; indirect: medical VA care and community care, education, readiness & employment, loan guaranty, construction, memorial, autos) | `fy` (two digits, default `25`) |
| `gdx_county_direct`, `gdx_county_indirect`, `gdx_cd_direct`, `gdx_cd_indirect` | the county and congressional-district sheets (119th Congress in FY25) | `fy` |

Catalog aliases (`fetch.py --source va --endpoints` lists all 29; `--search "pension"` finds one). VetPop2023
projections, one row per September 30 from 2023 to 2053: `vetpop_national` (wubk-nag4, sex x 15 age
groups), `vetpop_national_pos` (weu6-zpb9), `vetpop_national_race` (8zhc-knsi), `vetpop_state` (f43c-vb9n,
state x sex x 15 age groups), `vetpop_state_pos` (6kr5-skza, column `pos`), `vetpop_state_race` (ig48-b5dn),
`vetpop_county` (jrjd-qghv, 5-digit `fips`, 4 age groups, 781,200 rows), `vetpop_cd118` (vggh-gqm3, value
column `veteran`), `vetpop_cd119` (tggd-2yxt, FY2025-2028 totals only), `vetpop_visn` (3aej-m45q),
`vetpop_state_fy2026` (w6fb-7dn4, one FY2026 total per state), `vetpop_deaths_county` (5wjp-xu42, wide
fy2024-fy2075). VetPop2023 estimates 2000-2023, wide (one `fy2000` ... `fy2023` column per year):
`vetpop_est_national` (6xz6-j7yi), `vetpop_est_national_age` (y4w4-egzx), `vetpop_est_state` (ii4k-rqz2),
`vetpop_est_state_age` (yhrg-r4u8); `vetpop_est_state_race` (a2rs-k43v, long, FY2005-2023). Benefits:
`comp_recipients_county_fy2025` (95an-zhhy; also `_fy2024` 74ts-jsvb, `_fy2023` 5uqy-ph6a),
`pension_recipients_state_fy2025` (bm86-dmni; `_fy2024` vp34-vuw8), `comp_expenditures_state_fy2024`
(ibas-uwj3; `_fy2023` 2sc2-zyk7), `pension_expenditures_state_fy2024` (sbtk-kfnm; `_fy2023` ik8k-96ns),
`comp_rolls_pos_state` (y326-jukp, FY2022-2024), `pension_pct_state` (n849-uby9), `hc_comp_users_trend`
(ygu4-bebf). Any other data.va.gov table works by its 4x4 id; find ids in https://www.data.va.gov/data.json
(the Socrata discovery API returns nothing for this portal). A dataset that is a file, a story or a map
(e.g. the NCVAS State Summaries) answers HTTP 403 "non-tabular": download it by hand.

## Spec examples
```json
{"description": "Veterans by state, VetPop2023 projection for September 30, 2025",
 "requests": [{"name": "veterans_by_state_2025", "endpoint": "query",
   "params": {"dataset": "vetpop_state", "$select": "state, sum(veterans) AS veterans",
              "$where": "date = '2025-09-30'", "$group": "state", "$order": "state"}}]}
```
```json
{"description": "Texas veterans by sex, all periods of service, FY2023-FY2026",
 "requests": [{"name": "tx_all_veterans", "endpoint": "query",
   "params": {"dataset": "vetpop_state_pos",
              "$where": "state = 'Texas' AND pos = '(a) All Veterans (b+c)' AND date <= '2026-09-30'",
              "$order": "date, sex"}}]}
```
```json
{"description": "VA expenditures by state, GDX FY2025",
 "requests": [{"name": "gdx_direct_fy25", "endpoint": "gdx_state_direct", "params": {"fy": "25"}},
              {"name": "gdx_indirect_fy25", "endpoint": "gdx_state_indirect", "params": {"fy": "25"}}]}
```

## Data format and traps
- VetPop is a projection model, not a count. VetPop2023 uses data through 2023-09-30; every later date is a
  projection, and 2000-2023 values are model estimates. Say "projected" for any year after 2023 and name the
  model (VetPop2023). NCVAS says to round VetPop numbers to the nearest 1,000. A newer VetPop model replaces
  the whole series: do not mix values from different models.
- Dates are fiscal-year ends: `date` = September 30 of the fiscal year (`2025-09-30T00:00:00.000`); filter
  with `date = '2025-09-30'`. The estimate tables use wide `fy2000` ... `fy2023` columns instead. Benefit
  tables are "as of" the end of the fiscal year in their title (FY2025 = 2025-09-30).
- No total rows in VetPop tables: sex is only Female and Male; a state total is the sum of its sex x age rows.
  Values are rounded per cell on data.va.gov, so sums differ by a few from NCVAS's workbooks and between
  tables (Texas 2025: 1,518,969 from `vetpop_state`, 1,518,967 from `vetpop_state_pos`; verified
  2026-10-30). `vetpop_cd119` and `vetpop_est_state_race` hold unrounded decimals.
- Period of service and race/ethnicity groups overlap: `pos` "(a) All Veterans (b+c)" is the total, (b)-(g) are
  aggregates of the single periods (h)-(x), and race rows include "All Veterans", "White, alone" and "White
  alone, Not Hispanic or Latino" and "Hispanic or Latino (of any race)". Pick one row or one exclusive set;
  never sum the column.
- Geography: `state` is a full name, plus "Puerto Rico" and "Island Areas & Foreign" in VetPop (53 values;
  `vetpop_state_fy2026` has 50 states and Puerto Rico, no DC). County tables carry a 5-digit FIPS text (`fips`,
  `fips_code`, `county_fips`, keep leading zeros); districts are "CD 1" (118th) or "CD 01" (119th). Use
  `combine.state()` for codes.
- Every value arrives as text. SoQL text values need single quotes and match case-sensitively; a filter that
  matches nothing makes the fetch fail with "returned no rows".
- Suppression: blank cells in recipient tables are small counts withheld for privacy, so parts may not add up
  to the total (Alabama FY2025 pension: total 3,229, male 3,007 + female 221). Keep blanks empty; never fill
  with 0.
- Expenditure tables (`comp_expenditures_*`, `pension_expenditures_*`) hold dollars as text with a prefix
  and commas (`[$$]3,729,011,236`): strip `[$$]` and commas in analysis.py. Their age columns have cryptic
  names (see `--endpoints`), and the age bands differ between compensation and pension. `comp_rolls_pos_state`
  holds counts as text with commas and "Not included". The expenditure tables end with a "Grand Total" row and
  include "Philippines", "Other Foreign" and "Unknown"; pension recipient tables include "US Territories
  (excluding Puerto Rico)" and "Other Foreign Countries". Drop those rows before summing or ranking states.
- GDX (`gdx_*`): the FY2025 workbook is in dollars (with cents, stored as floats such as
  `4663993962.5200005`) and lists 50 states, DC, Guam and Puerto Rico (two-digit `St_FIPS`), then rows
  without a code ("Foreign Countries", "Freely Associated States", "Other US Territories", "Unknown", "Grand
  total") and note lines in the code column. Keep rows whose `St_FIPS` is two digits (district sheets: a
  `St_CD` such as `AL01`; county sheets: a non-empty `County`) before summing or ranking. The first column
  `col1` is always empty. Layouts change by year: FY2024 has state sheets in thousands of dollars ($000s) but
  county and district sheets in dollars, other program categories and a different third sheet name; FY2023
  and earlier have one sheet per state in $000s. The endpoints are verified only on FY25: for another year,
  read the workbook's second row (units) and headers first. GDX is NCVAS's estimate of where money went
  (allocated by recipient residence or facility), not an accounting of obligations. GDX FY21 and FY22 on
  data.va.gov (qhqa-74yq, 2hnn-8vkt) hold only the title page: use the workbooks.
- Paging uses `$limit`/`$offset` with a stable `$order` (default `:id`); a `$group` query needs its own
  `$order` on a grouped column. Without an app token Socrata throttles heavy use; aggregate with
  `$select`/`$group` instead of downloading the county table.

## Access
No key. Route `api` when www.data.va.gov answers (GDX also needs www.va.gov). Manual route: each request gets
CSV links (one per 50,000 rows) or the GDX workbook link in `manual_download/INSTRUCTIONS.md`; or open
`https://www.data.va.gov/d/<id>`, choose Export > CSV, and upload the file. NCVAS's own workbooks are the
source of truth and the manual alternative: VetPop2023 tables 1L-11L at
https://www.va.gov/vetdata/veteran_population.asp (e.g.
https://www.va.gov/VETDATA/docs/Demographics/New_Vetpop_Model/1L_VetPop2023_National_NCVAS.xlsx; they are
pivot tables filtered to one date, unrounded) and GDX at https://www.va.gov/vetdata/docs/GDX/GDX_FY25.xlsx.

## Citation and terms
"U.S. Department of Veterans Affairs, National Center for Veterans Analysis and Statistics, <dataset name>,
data.va.gov and va.gov/vetdata, retrieved <date>." For GDX, NCVAS asks for "Geographic Distribution of VA Expenditures for Fiscal
Year 2025, the National Center for Veterans Analysis and Statistics, Department of Veterans Affairs". Public
domain (17 U.S.C. 105); redistribution allowed.
