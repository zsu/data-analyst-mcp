# Census microdata: ACS PUMS, CPS and SIPP

From the census playbook's "Data format and traps" section: read it before a request of this kind.

- SIPP (`sipp`, `20XX/sipp`): public-use microdata, one row per person per reference month (MONTHCODE
  1-12). The reference year is the calendar year before the file's label: `2024/sipp` was collected in
  2024 about January-December 2023; say "2023" for its figures. Filter MONTHCODE (12 = December) for a
  point in time, or average the months for the year. The pack always adds SSUID, PNUM (person = SSUID + PNUM), MONTHCODE and
  WPFINWGT, the person weight: every estimate is weighted by WPFINWGT, never a row count. No geography but
  `state`, which filters TST_INTV (state of the interview address); SIPP is designed for national estimates.
  -9 means NA or missing in most variables: drop it before summing. Standard errors need the replicate
  weights, which are not on the API (bulk file `rw<YYYY>_csv.zip`, REPWGT1-REPWGT240, at
  https://www2.census.gov/programs-surveys/sipp/data/datasets/<YYYY>/; method in the year's user guide); without them
  give the point estimate and say no standard error was computed. Variable names and codes:
  `request_schema` search `"<YYYY>/sipp: health insurance"` or the dataset's variables.json. The bulk primary file
  (`pu<YYYY>_csv.zip`, about 100 MB) has every variable, for a manual download.
- ACS PUMS and CPS microdata (`acs1_pums`, `acs5_pums`, `cps_asec`, `<YYYY>/cps/basic/<mon>`): one row per
  person, values and codes exactly as published, with `<request>_codebook.csv` (every code's label, the
  variable's suggested weight). The pack adds the keys and weights: ACS SERIALNO, SPORDER, PWGTP (persons), WGTP
  (households: SPORDER 1 with RELSHIPP 20); ASEC H_SEQ, A_LINENO, PERIDNUM, MARSUPWT, HSUP_WGT; basic HRHHID,
  HRHHID2, PULINENO, PWSSWGT (final weight), PWCMPWGT (composite: employment levels that match BLS). For hourly
  and weekly earnings in a basic month, request PWORWGT (outgoing rotation groups, HRMIS 4 and 8). Every estimate
  is weighted, never a row count. Filters are upper-case variable predicates (`"AGEP": "25:54"`, `"HICOV": 2`),
  repeated on every call; geography: `state`, or `for: "public use microdata area:*"` with a state (ACS);
  no state = the nation (ACS fetched state by state, 51 calls, about 2 minutes for the 3.4 million persons).
  Every result has a `state` column (the FIPS code): group on it. The ACS PUMS state variable is `ST` through
  the 2022 file and `STATE` from 2023 on (1-year, 5-year and Puerto Rico; the other name is not a variable).
  `replicates: true` adds PWGTP1-80 for ACS (`"household"`: WGTP1-80, `"both"`); columns past 50 come in
  further calls joined on the keys. For the ASEC (2005 on) it adds PH_SEQ and PPPOS and joins PWWGT1-160 from
  Census's replicate weight file (CPS_ASEC_ASCII_REPWGT_<year> on www2.census.gov, about 70 MB, no key), after
  two gates: the file's weight sums equal the totals its SAS layout states, and every person's PWWGT0 equals
  MARSUPWT (2020: the 2020-based file is tried when the main one does not match). Census's replicate standard error
  is sqrt(4/80 * sum of squared replicate differences), MOE = 1.645 * SE (`compute`'s `replicate_se` step with
  `method: "sdr"` gives both; see Analysis below). Checked 2026-11-04 with that method: Maryland's 2024 uninsured rate in the civilian
  noninstitutionalized population from PUMS was 6.26 +/- 0.32 percent, published S2701 6.3 +/- 0.3; the nation
  8.19 vs 8.2.
  - Universe: published insurance and labor tables use the civilian noninstitutionalized population
    (drop RELSHIPP 37, the institutionalized group quarters population, and ESR 4-5, armed forces). Codes below zero or 0 often mean N/A (PINCP -19999 under 15, ESR 0 under 16): read the codebook.
  - Dollars: ACS amounts need ADJINC (ADJHSG for housing costs), which the pack adds when a dollar variable asks
    for it: value * ADJINC / 1,000,000 is in the survey year's dollars, as the published tables are. PUMS is a
    subsample of the full ACS: a PUMS figure differs slightly from the published table (inside its MOE);
    publish your figure as your own calculation and benchmark it against the table.
  - CPS: ASEC income, poverty (PERLIS) and full-year insurance (COV) refer to the previous calendar year; NOW_COV
    is coverage at the interview. Census's method for standard errors: weight MARSUPWT with replicates
    PWWGT1-160, SE = sqrt(4/160 * sum of squared differences); household estimates on householders only, with
    HSUP_WGT and the same replicates. Checked 2026-11-04 with that method: 2025 official poverty from the 2026 ASEC was
    34,505 thousand +/- 909 and 10.2 +/- 0.3 percent (PERLIS 1 among PERLIS != -1), P60-290 Table 1 34,510 +/- 909
    and 10.2 +/- 0.3. Before 2005 there is no replicate file: use the ipums pack.
    The API's 2020 and 2021 ASEC weights are the 2010-Census-based ones (their PWWGT0 matched the main replicate
    file, checked 2026-11-04); Census advises its 2020-based weights to compare those years with 2022 on, and
    they are not on the API: say which weights a 2020-2021 comparison uses.
    ASEC files before 2001 take no state geography on the API (HTTP 500): fetch the nation and filter on the
    file's state variable, or use ipums. Older files lack some keys and weights (HRHHID2 before 2004, PERIDNUM
    in early ASECs): the pack leaves them out and says so. CPS basic monthly has no replicate weights at all; month-to-month person links need HRHHID, HRHHID2 and
    PULINENO with care (ipums CPSIDP links them). CPS codes differ from ACS codes (PEMLR, PRCITSHP, A_HGA /
    PEEDUCA): recode each survey from its own codebook.
  - Analysis: build tables with `compute`. Standard errors: fetch with `replicates`, then a `replicate_se` step,
    e.g. `{"groupby": ["state"], "replicate_se": {"estimates": {"uninsured": "sum(PWGTP * (HICOV == 2)) / sum(PWGTP)"},
    "weight": "PWGTP", "replicates": "PWGTP1:PWGTP80", "method": "sdr"}}` (ASEC: `MARSUPWT`, `"PWWGT1:PWWGT160"`;
    household estimates: `WGTP`/`HSUP_WGT` with their replicates on one row per household). A difference between
    years or groups needs its SE from the same replicates: write it as one estimate. CPS basic monthly and SIPP from
    the API have no replicate weights: say no standard error was computed. This server has no PUMS recode helpers.

## Spec examples
```json
{"description": "Share of people without health coverage in December, SIPP 2024 (weighted by WPFINWGT)",
 "requests": [{"name": "sipp_coverage_dec", "endpoint": "query",
   "params": {"dataset": "2024/sipp", "get": "TAGE,RHLTHMTH,TPTOTINC", "MONTHCODE": "12"}}]}
```
```json
{"description": "Uninsured rate, Maryland, ACS 2024 1-year PUMS with replicate weights; CPS September 2026",
 "requests": [{"name": "md_pums", "endpoint": "query",
   "params": {"dataset": "2024/acs/acs1/pums", "get": "AGEP,HICOV,RELSHIPP,ESR,PINCP", "state": "MD",
              "replicates": true}},
  {"name": "cps_sep", "endpoint": "query",
   "params": {"dataset": "2026/cps/basic/sep", "get": "PRTAGE,PEMLR,PRCITSHP", "PRTAGE": "25:54"}}]}
```
