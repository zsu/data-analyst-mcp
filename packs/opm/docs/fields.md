# OPM workforce data: fields, codes and traps

Read §1 and §2 before choosing data for any analysis; they decide whether a question can be answered
at all. `data_dictionary.csv` (in `sources/opm/lib/`, and copied into every `data/opm/` folder) has the
official definition of all 72 fields and which datasets carry each one.

## Contents
1. What the data are (and are not)
2. Traps that silently produce wrong numbers
3. Key fields and codes
4. Standard definitions
5. Columns to request for common questions

## 1. What the data are (and are not)
- **Source:** OPM's Enterprise Human Resources Integration (EHRI) system, fed by agencies' core HR
  systems. **Administrative records for the whole covered workforce, not a survey**: no weights, no
  sampling error. A difference of 50 employees is a real difference in the records; whether it is
  meaningful depends on reporting quality, not on a confidence interval.
- **One row = one employee** (employment: on board on the last day of the month) or **one personnel
  action** (accessions, separations). `count` is always 1. There is **no person identifier**, so you
  cannot follow individuals across months, link a separation to the employee's earlier record, or
  distinguish one person's two actions.
- **Coverage:** civilian employees of the executive branch, **except** USPS, the Postal Regulatory
  Commission, CIA, NSA, DIA, NGA, ODNI, the White House Office, the Office and Residence of the Vice
  President, Census Bureau temporary workers, Foreign Service personnel at State, TVA, the Federal
  Reserve Board of Governors (CFPB *is* included, under the Federal Reserve), the PHS Commissioned
  Corps, nonappropriated-fund employees, foreign nationals overseas, and most of the legislative and
  judicial branches (a few bodies do report: the Government Publishing Office `LP` and some judicial-branch
  records `JL` appear; drop them by `agency_code` for an executive-branch count and say so). Uniformed
  military are not civilians and are not in the data. Totals are therefore below
  "all federal employees" figures that include USPS (about 600,000) or the intelligence community.
- **Not in the public files:** sex, race, ethnicity, disability, citizenship, exact age (only 5-year
  `age_bracket`), names, performance ratings, awards, telework, leave, bonuses, total compensation,
  benefits, retirement eligibility dates, adverse-action detail (removals, probationary terminations
  and suspensions are withheld by OPM policy). Say so plainly when a question needs them, and offer
  what the data can show instead (for example age bracket and length of service as a proxy for
  retirement eligibility).

## 2. Traps that silently produce wrong numbers
1. **Redacted pay and location (the big one).** `annualized_adjusted_basic_pay`, all `duty_station_*`
   fields, CBSA/CSA, `locality_pay_area*`, `bargaining_unit*` and `personnel_office_identifier_code`
   are the string `REDACTED` for:
   - **every Department of Defense employee** (Army, Navy, Air Force, and defense agencies: about
     680,000 people, a third of the workforce), in every year;
   - security/sensitive agencies: FBI, DEA, ATF, TTB, Secret Service, CBP, ICE, Bureau of Prisons, U.S.
     Attorneys' offices, DHS intelligence (HSOS04) — outside the Washington area;
   - sensitive occupations in any agency: series 0007, 0082, 0083, 0084, 0132, 0134, 0401 (DHS), 0436,
     0512, 0840, 0930, 1169, 1171 (IRS), 1801, 1802, 1805, 1810, 1811, 1812, 1816, 1854, 1881, 1884,
     1890, 1895, 1896.
   Result: about 45 to 48 percent of employment records lack pay and location (DHS about 76 percent,
   Justice about 66 percent, Treasury and Energy about 17 percent, most others under 5 percent).
   **Consequences:** a "governmentwide average salary" from these files is the average of non-DoD,
   non-security employees, and state counts undercount every state with a big DoD presence. Always run
   `stats.redaction_coverage()`, save `coverage.csv`, report the coverage next to every pay or location
   figure, and restrict the stated universe ("employees whose pay is published, which excludes DoD …").
   OPM's own "Average salary" (Table Builder, dashboards) is the mean over every record of the group whose
   pay is published, on any work schedule; the pack's default universe (full-time, per annum) differs by up
   to $10,000 a department: match OPM's definition when benchmarking against it, and show the other as a
   sensitivity.
   For full state counts (DoD included), OPM's Federal Workforce Data location dashboard
   (data.opm.gov/explore-data/analytics/location) publishes them; FedScope's old state tables also included
   DoD. Read them into `published/` (SKILL.md §2) and keep the file-based count as the covered-part check.
   OPM's Table Builder and dashboards count separations and accessions by effective date: count the same
   way to match them. Processing month differs a lot for FY2026, because about 11,000 Deferred Resignation
   separations effective before October 2025 were processed in FY2026 files (it flips the sign of a
   year-over-year comparison).
   Read the map's state values: the dashboard's state table puts the D.C. commuting area in its own "D.C.
   AREA" row, so its MD, VA and WV rows leave out their D.C.-area employees (Aug 2026: MD 54,097 in the
   table, 121,612 on the map). The map has a "table view" (states 25 to a page) that lists the map's values;
   the dashboard is a live app with no JSON to fetch, so read that view in a browser. The location map counts employees in pay status, 1 to 2 percent below the
   files' on-board count; the Demographics dashboard (age, education, veteran status by department) and
   Table Builder match the files exactly (Aug 2026), so they benchmark shares and headcounts by department.
   Headcounts by department, occupation, grade, age, education and so on are complete — only pay and
   location are withheld.
2. **Counting accessions and separations.** A file holds actions *processed* that month; 5 to 10
   percent are effective in earlier months (some a year or more back). Two defensible bases:
   - **effective month** (`period` after `clean()`): what happened when; needs the files for later
     months too, and the most recent two or three months are incomplete;
   - **processing month** (`file_period`): what was recorded each month; complete as soon as the file
     is out.
   Pick one, state it, and show the other in a sensitivity check when they differ. `stats.late_reporting()`
   shows how much arrives late.
3. **Versions and revisions.** Use `current` versions; numbers in an earlier report can differ because
   OPM has since reissued the file. Pin versions to reproduce exactly.
4. **Pay plans change too.** Wildland firefighters moved from GS to their own pay plan GW in 2025 (about
   16,000 to 17,000 employees at Agriculture and Interior): a GS-only series breaks there; count GS+GW for
   a like-for-like trend. OPM's "pay plan and grade" dashboard table counts permanent full-time employees only
   (`nsftp_indicator` = Y): filter the same way to match it.
5. **Agency names change; codes are stable.** For example, "DEPARTMENT OF DEFENSE" also appears as
   "DEPARTMENT OF WAR" on OPM pages from 2025. Group by `department_code`, `agency_code`,
   `agency_subelement_code`, `occupational_series_code`, and display the latest label
   (`stats.latest_labels()`). Reorganizations (new subelements, transfers between agencies) show up
   as jumps: check before calling them hiring or losses. Occupational series move too: wildland firefighters
   were reclassified from 0462 (Forestry Technician) into 0456 (Wildland Fire Management, created 2022), and
   the 0x99 student-trainee series swing with internship cycles; check the receiving series before calling
   a drop a loss.
6. **Snapshot frequency.** Employment files are quarterly before 2011. A fiscal-year average headcount
   uses 12 monthly snapshots from FY2012 on and four before. `action_rate()` flags `partial_period`.
7. **Missing agency submissions.** An agency that misses a month shows a dip and a rebound. Check the
   FWD Data Quality page ("Missing EHRI files") before reporting a one-month change.
8. **Sentinel values.** `NO DATA REPORTED`, `INVALID`, `UNSPECIFIED`, `*` appear in coded fields;
   `clean()` turns them into missing. Report how many records are missing for the fields you use. A department
   code reported as missing on records with a valid agency code is filled from that agency's department (each
   agency code belongs to one department), so department totals add up to the governmentwide total.
9. **Pay oddities.** Pay is annualized basic pay plus locality or special-rate supplement, after the
   pay cap — not total compensation (no overtime, awards, benefits). Records with pay 0 (without
   compensation), hourly or per-diem pay bases, intermittent and seasonal schedules distort means.
   Default pay universe: full-time (`work_schedule_code` F), per annum (`pay_basis_code` PA), pay > 0
   (`stats.pay_universe`). Physicians (VM/VN pay plans), some financial regulators and SES earn above
   the GS cap legitimately; screen with `screen_pay()` but do not drop them without a reason.
10. **Strings everywhere.** Codes keep leading zeros (`occupational_series_code` "0346", `grade` "08").
   Do not convert codes to integers.
11. **Separations on the last day of a month show up in the next snapshot.** An employee whose
   separation takes effect on the last day of a month is still on board in that month's snapshot. A
   wave of end-of-month separations (retirements on September 30 or December 31, or the 2025 Deferred
   Resignation Program, effective September 30) therefore shows up in the following month's
   headcount. In 2025: counted across the files available in October 2026, 132,949 separations were
   effective in September (106,883 of them deferred resignations; earlier files showed fewer because
   actions keep arriving late, see `late_reporting`), but headcount fell 28,342 from August to September
   and 92,685 from September to October. A September-to-September change misses such a wave. When separations bunch at the end of
   the period's last month, also show the change to the next month's snapshot, or use December
   snapshots, and say which you used.

## 3. Key fields and codes
| Field | Datasets | Notes |
|---|---|---|
| `snapshot_yyyymm` | E | month of the status snapshot |
| `personnel_action_effective_date_yyyymm` | A, S | effective month of the action |
| `department_code` / `department` | all | the 15 executive departments: AG Agriculture, CM Commerce, DOD Defense, ED Education, DN Energy, HE HHS, HS Homeland Security, HU HUD, DJ Justice, DL Labor, ST State, IN Interior, TR Treasury, TD Transportation, VA Veterans Affairs; independent agencies have their own codes (SZ SSA, EP EPA, ...) |
| `agency_code` / `agency` | all | e.g. AR Army, NV Navy, AF Air Force, VA, HS |
| `agency_subelement_code` | all | bureau or component, e.g. IN05 Bureau of Land Management, TR93 IRS |
| `cfo_act_agency_indicator` | all | CFO ACT AGENCY (24 large agencies) / OTHER AGENCY |
| `separation_category_code` | S | SA transfer out (individual), SB transfer out (mass), SC quit, SD retirement voluntary, SE retirement early out, SG retirement other, SH reduction in force (RIF), SJ termination (expired appointment/other), SL other separation |
| `drp_indicator` | S | Y = separated under the 2025 Deferred Resignation Program (about 96,000 processed in the September 2025 file alone; about 107,000 effective in September 2025 across all files as of October 2026; coded as quit or retirement) |
| `accession_category_code` | A | AA transfer in (individual), AB transfer in (mass), AC new hire competitive service, AD new hire excepted service, AE new hire SES |
| `work_schedule_code` | all | F full-time, P part-time, I intermittent, G full-time seasonal, Q part-time seasonal, J intermittent seasonal; the files also hold B, R, S, T and blank: read their labels with `--values work_schedule` and state the grouping (part-time = P, Q, S, T, R; intermittent = I, J) |
| `pay_plan_code` | all | GS General Schedule (~63 percent), WG/WL/WS wage grade, VN/VM VA medical, NH/ND DoD demo, AD administratively determined, SV TSA, ES Senior Executive Service |
| `grade`, `step_or_rate_type_code` | all | strings; GS grades "01" to "15" |
| `pay_basis_code` | all | PA per annum, PH per hour, SY school year, PD per diem, WC without compensation |
| `annualized_adjusted_basic_pay` | all | dollars as a string, or REDACTED |
| `occupational_series_code` | all | 4-digit OPM series ("2210" IT management); `occupational_group_code` 2-digit family; `occupational_category_code` P/A/T/C/O/B (professional, administrative, technical, clerical, other white collar, blue collar) |
| `stem_occupation_type` | all | science, technology, engineering, mathematics, health, all other |
| `supervisory_status_code` | all | 2 supervisor or manager, 4 supervisor (CSRA), 5 management official, 6 leader, 7 team leader, 8 all other |
| `appointment_type_code`, `tenure_code`, `position_occupied_code` | all | permanence and service: 10 career, 15 career-conditional, 30/32/35/38 excepted permanent, 50/55 SES; tenure 1 career, 2 conditional (probationary), 3 term; position 1 competitive, 2 excepted, 3/4 SES |
| `nsftp_indicator` | all | Y = nonseasonal full-time permanent (OPM's standard "permanent workforce" universe) |
| `age_bracket` | all | LESS THAN 20, 20-24, …, 60-64, 65 OR MORE |
| `education_level_bracket` | all | HIGH SCHOOL OR LESS, SOME COLLEGE OR ASSOCIATES DEGREE, BACHELORS DEGREE, MASTERS OR PROFESSIONAL DEGREE, DOCTORATE DEGREE |
| `length_of_service_years` | all | federal civilian plus creditable military service, years with one decimal. **Definition break in March 2026**: from the 2026-03 file it equals years since the leave service computation date for every record; before, for only 72-79 percent (a quarter of records ran about 4 years shorter). A change across March 2026 (+1.6 years Sep 2024 to Aug 2026 as published) is mostly this break: compare on one basis (years since `service_computation_date_leave`) and say so. OPM's Table Builder metric "Average length of service" follows the published field |
| `veteran_indicator` | all | Y / N, derived by OPM from several veteran fields |
| `bargaining_unit_status` | all | ELIGIBLE_IN_BU, ELIGIBLE_NOT_IN_BU, NOT_ELIGIBLE (or REDACTED) |
| `duty_station_state_abbreviation` | all | state of the worksite (REDACTED as in §2) |

## 4. Standard definitions
- **Headcount (on-board employment):** employees in the status file for the month. Annual series use
  the **September** snapshot (end of the fiscal year; FedScope and OPM convention) unless the user
  wants calendar-year (December) or another month. State the month. End-of-month separations leave
  the headcount only in the next month's snapshot (§2.10).
- **Permanent workforce:** `nsftp_indicator` = Y (nonseasonal, full-time, permanent). Common in OPM
  and CRS work when temporary and seasonal swings would mislead.
- **Separation rate:** separations in the period ÷ average headcount in the period (mean of the monthly
  snapshots). Report quit, retirement, RIF and transfer rates separately when they matter; transfers
  between agencies are separations for the losing agency but not losses to the government.
- **Accession (hiring) rate:** accessions ÷ average headcount. New hires = AC, AD, AE; transfers in are
  not new to government.
- **Net change:** headcount at the end minus headcount at the start (from status files). Accessions
  minus separations will not match it exactly (conversions, late actions, coverage changes); say so if
  both are shown.
- **Average and median pay:** of full-time, per-annum employees whose pay is published (§2.1).
  Prefer the median for comparisons across groups; quote coverage.
- **Retirement-eligible proxy:** no birth date or retirement plan is public. Age 60 or older with 20 or
  more years of service, or age 62+ with 5+ years, approximates FERS eligibility; label it a proxy.
- **Fiscal year:** October through September (`fiscal_year` from `clean()`; FY2025 = October 2024 to
  September 2025). Say "fiscal year 2025" in prose.

## 5. Columns to request for common questions
Keep `spec.json` lean: ten September snapshots with all 64 columns are ~20 million rows.
- Headcount trends by agency: `department_code, department, agency_code, agency, nsftp_indicator, work_schedule_code`
- Composition (age, tenure, education): add `age_bracket, length_of_service_years, education_level_bracket, supervisory_status_code, veteran_indicator`
- Occupations: `occupational_series_code, occupational_series, occupational_category_code, stem_occupation_type, grade, pay_plan_code`
- Pay: `annualized_adjusted_basic_pay, pay_plan_code, grade, pay_basis_code, work_schedule_code, occupational_series_code, duty_station_state_abbreviation` (+ the department/agency codes to measure redaction)
- Turnover: separations `separation_category_code, separation_category, drp_indicator, agency_code, department_code, age_bracket, length_of_service_years`; accessions `accession_category_code, …`; and the employment snapshots of the same months for the denominator
- Location: `duty_station_state_abbreviation, duty_station_state, core_based_statistical_area` (redaction!)
