# Variables and samples for policy questions

Codes marked ✔ were checked against real extracts (ACS 2023, CPS ASEC 2023, CPS June 2023; NHIS 2024 and
MEPS 2022, October 2026). After every download, `data/ipums/codebook.csv` is the authority, so check any
code you are unsure of.

Contents: 1. Choosing a collection · 2. Sample IDs · 3. Weights · 4. IPUMS-USA (ACS) variables ·
5. IPUMS-CPS variables · 6. Missing and top codes · 7. Ready-made variable sets by topic ·
8. IPUMS NHIS variables · 9. IPUMS MEPS variables

## 1. Choosing a collection
| Question needs | Use | Why |
|---|---|---|
| State/sub-state detail, small groups (birthplace, occupation), a large sample | **USA, ACS 1-year** (`usYYYYa`) | About 3.3M persons a year |
| Very small groups or geographies | **USA, ACS 5-year** (`usYYYYc`) | About 16M persons, but the period is pooled, so it can't show change year to year |
| Annual income, poverty, health insurance, program receipt, a long time series (1962+) | **CPS ASEC** (`cpsYYYY_03s`) | The official income and poverty source. Income refers to the **previous** calendar year |
| Monthly labor force, unemployment, hourly/weekly earnings (minimum wage) | **CPS basic monthly** (`cpsYYYY_MMs`, March basic = `cpsYYYY_03b`) | BLS labor force concepts. Pool 12 months for a sample of about 1.2M records a year |
| Long-run history (1850–2000) | USA decennial census samples | |
| Health insurance at the interview, access to care, health status and conditions, by custom groups | **NHIS** (`ihYYYY`) | NCHS's household health survey: about 33k sample adults and 8k sample children a year (2024) |
| Health care spending (total, out-of-pocket, by payer), use of services, insurance over the year | **MEPS** (`mpYYYY`) | AHRQ's household panel: about 22k persons a year (2022), spending for the whole calendar year |

The ACS starts in 2000 (large samples from 2005, group quarters from 2006). CPS ASEC starts in 1962.
**ACS 2020 1-year** is IPUMS's experimental-weights release, so note this when using it.

## 2. Sample IDs ✔
- `python <skill>/scripts/fetch.py --source ipums --list-samples usa --match 2023` lists sample IDs and descriptions.
- **USA:**
  - `us2023a` = 2023 ACS 1-year
  - `us2023b` = 2023 PRCS (Puerto Rico)
  - `us2023c` = 2019–2023 ACS 5-year
  - `us2000a` = 2000 5% census
- **CPS:**
  - `cps2023_03s` = ASEC 2023
  - basic monthly: `cpsYYYY_MMb`, or `cpsYYYY_MMs` when that month carries a supplement (2025: `_01b`,
    `_02s`, `_03b`, `_04b` ...); take the IDs from `--list-samples cps --match YYYY`, never by pattern
  - **October 2025 was not collected** (lapse in appropriations): 2025 has 11 monthly samples, so a 2025
    annual average divides pooled weights by 11, not 12
- **NHIS:** `ih2024` = 2024 NHIS (`--list-samples nhis`). **MEPS:** `mp2022` = 2022 MEPS full year
  (`--list-samples meps`; the newest full-year file lags about two years).

## 3. Weights (auto-included) ✔
| Collection / file | Person weight | Household weight | Notes |
|---|---|---|---|
| USA (ACS/census) | `PERWT` | `HHWT` (one row per household: `PERNUM == 1`) | `REPWTP` replicate weights (80) for SEs; request them explicitly |
| CPS ASEC | `ASECWT` | `ASECWTH` | `WTFINL` is **empty** on ASEC records |
| CPS basic monthly | `WTFINL` | `HWTFINL` | `ASECWT` is empty on monthly records. Labor-force **levels** to match BLS: `COMPWT` (composite weight, request it), which reproduces BLS's total monthly employment exactly (2024: 161,346 thousand; `WTFINL` gives about 0.4 percent more) and subgroups closely (women 25-54: annual levels within 0.1 percent, single months within about 0.4 percent). Shares barely differ |
| CPS earnings (outgoing rotation, MISH 4 and 8) | `EARNWT` | | For `EARNWEEK2`, `HOURWAGE2` and `UNION` (union membership is asked in the outgoing rotation only; BLS's rate is members / employed wage and salary workers, self-employed excluded). Pooling months: divide by the number of months (12; 11 for 2025) for annual-average counts |
| NHIS 2019 on | `SAMPWEIGHT` | | One sample adult and one sample child per household: `ASTATFLG` 1 = sample adult, `CSTATFLG` 1 = sample child. Adults sum to the civilian noninstitutionalized adult population (2024: 260M), children to 72M. 2020 sample adults: `PARTWEIGHT` when pooling 2019-2020 (2020 only) |
| NHIS before 2019 | `PERWEIGHT` (person file), `SAMPWEIGHT` (sample adult/child items) | | The weighting changed in 2019: IPUMS advises against comparing trends across 2019 |
| MEPS | `PERWEIGHT` | | 0 for persons out of scope (about 3% of records): keep them in the file for the variance, out of every estimate. `SAQWEIGHT` for the adult self-administered questionnaire, `DIABWEIGHT` for the diabetes survey |

Pooling several years for one estimate: either average the yearly estimates, or divide the weights by the number of years so that totals stay annual.

**Standard errors.** Census recommends replicate weights.
- **USA (ACS):** request `REPWTP` to get 80 columns. They add a lot of size to multi-year extracts; `stats.lin_se` with the automatic `STRATA` and `CLUSTER` is a fallback only: it can be far off for quantities the ACS weights are raked to (age, sex: median-age margins came out 3 to 13 times the replicate ones) and understate others. Prefer replicates; to save size, case-select a second extract with REPWTP to the areas compared.
- **CPS ASEC:** request `REPWTP` to get 160 columns, then use `stats.rep_se` or `wls(se="replicate")`.
- **NHIS, MEPS:** no replicate weights; Taylor linearization with the design variables (added automatically):
  `lin_se(df, z, **survey_design(df, "nhis"))`. For NHIS it uses STRATA and PSU, kept apart across design
  periods (IPUMS's STRATA and PSU are consistent only within a period, such as 2006-2015 or 2016 on). For one
  MEPS year it uses STRATANN and PSUANN; for pooled MEPS years, STRATAPLD and PSUPLD. Compute on the whole file with a domain mask
  (`share_z`, `mean_z`) rather than on filtered rows. Check ✔: NHIS 2024 uninsured ages 18-64, 11.6% with
  SE 0.34 points (NCHS: 11.6%); MEPS 2022 mean spending $6,765 per person, SE $178 (AHRQ: $6,765).

**Extract gotchas (found in test runs):**
- IPUMS adds the detailed version of a variable automatically (EDUC also brings EDUCD; EMPSTAT brings EMPSTATD).
- `dataQualityFlags` is not available for every variable and sample (for example INCWAGE in ASEC 2024), and the request then fails with a 400 error. Remove the flag and resubmit.
- An invalid case-selection code (for example CLASSWLY 23 in ASEC 2024) also returns a 400 error. Check the codes in `data/ipums/codebook.csv` of a small test extract.

## 4. IPUMS-USA (ACS) variables
**Technical (auto):** YEAR, SAMPLE, SERIAL, CBSERIAL, HHWT, CLUSTER, STRATA, GQ, PERNUM, PERWT.
- GQ ✔: 1, 2 and 5 are households; 3 = institutions; 4 = other group quarters. Restrict to GQ in (1,2,5) for the household population.

**Demographics:** AGE (0–99 top-coded), SEX (1 male, 2 female), RACE / RACED, HISPAN (0 not Hispanic), MARST, RELATE, STATEFIP, PUMA, MET2013, COUNTYFIP.
MET2013 is built from PUMAs on the 2013 OMB delineations (MET2013ERR gives the misassignment): Census's 2024
metro tables use the 2023 delineations, which moved counties (Dutchess, Orange and Pike left the New York
metro), so a metro computed from MET2013 can differ from the published one beyond sampling error (New York
no-vehicle share 2024: 30.6 against 31.4). Compare households counts first, and name the delineation.
Parents (CPS ASEC; own children in the household): YNGCH (age of the youngest own child, 99 = none), NCHILD
(number of own children), NCHLT5 (own children under 5). BLS's Employment Characteristics of Families counts
mothers 16 and over, civilian, by the youngest child's age (under 6, 6 to 17), as an annual average of the
monthly CPS: a March ASEC figure differs by about its standard error.
Living with parents as Census's Table AD-1 counts it (CPS ASEC): RELATE 301 (child of the householder), all
persons in the age group including armed forces in households (no POPSTAT filter), ASECWT; college students in
dorms are coded in their parents' household. Reproduced AD-1 exactly for 2019 and 2025 [checked 2026-10-22].

**Nativity and immigration** ✔
- `CITIZEN`: 0 N/A (born in the US), 1 born abroad of American parents, 2 naturalized citizen, 3 not a citizen, 4 not a citizen but has first papers, 5 foreign born with status not reported. **Foreign born = CITIZEN in 2–5.** Native = 0 or 1.
- `BPL` / `BPLD`: birthplace. 1–56 US states, 100–120 US territories (110 = Puerto Rico), 150+ foreign (200 Mexico, 500 China, 515 Philippines, 521 India, ...). Check `codebook.csv`.
- `YRIMMIG`: year of immigration. `YRSUSA1`: years in the US (0 = N/A or under 1 year).
- `NATIVITY` is **not** available in ACS samples; use CITIZEN.

**Education** ✔
- `EDUC` (general, 00–11) and `EDUCD` (detailed). Use **EDUCD** for degree groups.
- EDUCD codes: 2–61 less than a high school diploma; 62–64 high school diploma or GED; 65–83 some college or an associate's degree (65, 71 some college; 81–83 associate's); 101 bachelor's degree; 114 master's degree; 115 professional degree; 116 doctorate; 0/1 N/A; 999 missing.
- `stats.educ_group(df, "usa", "educ4" | "educ5")` implements these groups (pre-1990 census codes: 60 "Grade 12" counts as high school, 100 as bachelor's, 110–113 as master's).

**Work** ✔
- `EMPSTAT`: 0 N/A (under 16), 1 employed, 2 unemployed, 3 not in labor force. `EMPSTATD` has detail (armed forces = 13/14).
- `LABFORCE`: 0 N/A, 1 no, 2 yes.
- `CLASSWKR`: 1 self-employed, 2 works for wages. `CLASSWKRD` ✔: 13 self-employed not incorporated, 14 self-employed incorporated, 22 wage/salary private, 23 wage/salary nonprofit, **25 federal government**, 26 armed forces, 27 state government, 28 local government, 29 unpaid family worker.
- `UHRSWORK`: usual hours per week last year (0 = N/A, 99 = 99+).
- `WKSWORK1`: weeks worked last year (available for ACS 2019+ and censuses). `WKSWORK2`: intervals (1 = 1–13 … 6 = 50–52) for 2008–2018.
- Full-time, full-year = UHRSWORK ≥ 35 and weeks ≥ 50 (for 2008–18 use WKSWORK2 = 6).
- `OCC`, `OCC2010` (harmonized), `OCCSOC`; `IND`, `IND1990`, `INDNAICS`. The extract's `codebook.csv` has no
  value labels for these: `IND`/`OCC` use the Census code list of the survey year (CPS 2024: construction
  industry IND 0770; construction and extraction occupations OCC 6200-6950), listed on the variable's IPUMS
  page (cps.ipums.org/cps-action/variables/IND#codes_section). Check a code set against a BLS table (cpsaat18
  for industries, cpsaat11 for occupations) before using it.
- `TRANWORK` ✔: usual means of transportation to work last week. 0 N/A (not a worker or not at work that week),
  10-15 car, truck or van, 31-39 public transit and taxi, 50 bicycle, 60 walked, 70 other, **80 worked at home**.
  Census's commuting tables (B08301, B08101) count workers 16+ at work last week, i.e. TRANWORK > 0: keep that
  universe explicitly (`clean_missing` turns 0 into NaN, and `share(...)` would then count those people as
  "no" in the denominator). `TRANTIME` one-way travel minutes (0 N/A: not a commuter, or worked at home;
  values above a state's top code are replaced by the state mean of those values; check `codebook.csv` for
  suppression codes such as 888 in some years), `DEPARTS` departure time.

**Income** (amounts for the past 12 months, as reported). IPUMS does **not** recommend multiplying by the Census adjustment factor `ADJUST`. A single constant can't fix the varying reference periods, and IPUMS found the effect too small to change results (https://usa.ipums.org/usa/acsincadj.shtml). Use CPI99 to compare across years, and state the dollar year. To reproduce a Census published ACS dollar
table (B19013, S1901), multiply by `ADJUST` as Census does with ADJINC.
- `INCWAGE`: wage and salary income (999999 N/A, 999998 missing; state-specific top codes).
- `INCEARN`: total earnings, including self-employment.
- `INCTOT`, `FTOTINC`, `HHINCOME` (9999999 N/A).
- `POVERTY` ✔: income as a percent of the poverty threshold (0 N/A, 501 = 501+).
- `CPI99` ✔: the multiplier that converts to 1999 dollars. **It is not added automatically. Request it.** For example, ACS 2013 = 0.715, 2018 = 0.663, 2023 = 0.547 (multiply by CPI99, then divide by the target year's CPI99).

**Health insurance** ✔: `HCOVANY` (1 none, 2 covered), `HCOVPRIV`, `HINSEMP`, `HINSPUR`, `HCOVPUB`, `HINSCAID` (Medicaid), `HINSCARE` (Medicare), `HINSVA`. Items are 1 no, 2 yes. ACS 2008+.

**Veterans and disability** ✔
- `VETSTAT`: 0 N/A, 1 not a veteran, 2 veteran.
- `VETSTATD`: detail. 11 = no service (never served). Other codes cover current active duty and Reserve or Guard training only; check `codebook.csv`.
- `VET01LTR`: served September 2001 or later (0 N/A, 1 did not serve this period, 2 served this period). Also `VET90X01`, `VET75X90`, ...
- `VETDISAB`: VA service-connected disability rating.
- `DIFFREM`, `DIFFPHYS`, `DIFFMOB`, `DIFFCARE`, `DIFFSENS`, `DIFFEYE`, `DIFFHEAR`: 1 no, 2 yes.

**Programs and housing:** `FOODSTMP` (1 no, 2 yes), `INCWELFR`, `INCSUPP` (SSI), `INCSS`, `OWNERSHP`, `RENTGRS`, `VALUEH`, `MORTAMT1`, `MIGRATE1`.

**Computer and internet (ACS, household)**: `CINETHH` internet access, `CIHISPEED` broadband (cable,
fiber, DSL; 2024 has only codes 10 yes and 20 no, though the codebook lists 11-17), `CISAT` satellite,
`CIDATAPLN` cellular data plan, `CIDIAL` dial-up, `CIOTHSVC` other. Census's "broadband of any type" (S2801,
B28002) is any subscription except dial-up alone. 2023-2024 files carry suppression codes 8/88
("Suppressed", a few hundred Pennsylvania households): `clean_missing` drops them; say so. Household
estimates: request `"data_structure": {"householdOnly": {}}` (one row per household, HHWT, REPWT), but it
drops person variables: for estimates by the householder's age, sex or race keep the rectangular extract,
case-select `RELATE` 1 (householder) and weight by HHWT with REPWT1-80.

## 5. IPUMS-CPS variables
**Technical (auto):** YEAR, SERIAL, MONTH, CPSID, CPSIDP, ASECFLAG, PERNUM, plus the weights above.

**Demographics:** AGE (0–85; 80 = 80–84 and 85 = 85+ in recent years), SEX, RACE, HISPAN, MARST, STATEFIP, METFIPS.

**Nativity** ✔ (1994+)
- `NATIVITY`: 0 unknown, 1 both parents native, 2 father foreign, 3 mother foreign, 4 both parents foreign, 5 foreign born
  (by birthplace: it includes CITIZEN 2 and 3, so it is **not** BLS's foreign born). Use it for parents' nativity.
- `CITIZEN`: 1 born in the US, 2 born in US outlying areas, 3 born abroad of American parents, **4 naturalized**, **5 not a citizen**.
  BLS's foreign born ("not U.S. citizens at birth") = CITIZEN 4-5; it reproduces BLS's published medians by nativity.
- `BPL`, `YRIMMIG`.

**Education** ✔
- `EDUC` (one detailed 3-digit variable): 2–72 less than high school, 73 high school diploma or equivalent, 81 some college with no degree, 91/92 associate's degree, 111 bachelor's, 123 master's, 124 professional degree, 125 doctorate, 1 NIU, 999 missing.
- Pre-1992 years-of-schooling codes are 80–122.

**Labor force (monthly concept)** ✔
- `EMPSTAT`: 0 NIU, 1 armed forces, 10 at work, 12 has a job but was not at work, 20–22 unemployed, 30–36 not in labor force (32 unable to work, 36 retired).
- `LABFORCE`: 0 NIU, 1 no, 2 yes.
- `CLASSWKR`: same codes as CLASSWLY below.
- `UHRSWORKT`: usual hours, all jobs (997 hours vary, 999 NIU). `AHRSWORKT`: actual hours.
- `DURUNEMP`, `WHYUNEMP`, `OCC2010`, `IND1990`.

**Earnings (outgoing rotation groups, monthly)** ✔
- `EARNWEEK2`: weekly earnings (999999.99 NIU; top-coded). `EARNWEEK` (9999.99 NIU) ends in March 2023:
  an extract asking for it for later months fails with HTTP 400.
- `HOURWAGE2` (999.99 NIU; `HOURWAGE` likewise replaced), `PAIDHOUR` (1 no, 2 yes paid hourly).
- To match BLS's usual weekly earnings: full time = usual hours 35 or more, plus workers whose hours vary
  (`UHRSWORK1` 997) who usually work full time (`WKSTAT` 10-13 or 21; usually part time: 14, 15, 20, 22, 40-42;
  BLS classes people absent from work by their usual status, and the 2014/2024 shares for women 25-54 match
  BLS's LNU02600062 / LNU02000062); `clean_missing` blanks 997, so take
  the full-time flag from the raw column (or from `WKSTAT` alone) first. Medians interpolated in $50 intervals centred on
  multiples of $50 (`wmedian_binned(x, w, width=50, offset=25)`); 2025 averages 11 months (no October).
- Use the `EARNWT` weight.
- Use these for minimum-wage and hourly-wage distributions.

**ASEC annual (refers to the previous calendar year)** ✔
- `INCWAGE`: wage and salary income (99999999 NIU, 99999998 missing).
- `INCTOT`, `FTOTVAL`, `HHINCOME`, `INCSS`, `INCSSI`, `INCUNEMP`.
- `CLASSWLY`: class of worker on the longest job last year. 0 NIU, 13/14 self-employed, 22 private (for-profit and nonprofit; there is no separate code 23 in ASEC 2024), **25 federal government**, 27 state, 28 local, 29 unpaid family.
  - ⚠ Code 25 **includes active-duty armed forces** (about 300 records in ASEC 2024). Remove them with the occupation or industry last year: request `OCCLY` / `INDLY` and drop the military codes (OCCLY 9840, INDLY 9890 in ASEC 2016-2025). The extract's codebook carries no labels for these two variables: check the IPUMS variable pages, and check that both codes flag the same federal records.
  - Postal Service workers (INDLY 6370) are about 14% of the federal records. Run a sensitivity test with and without them.
- `INCWAGE` in recent ASECs is the sum of two separately top-coded (or swapped) components, `INCLONGJ` (longest job) and `OINCWAGE` (other jobs), each capped at about **1,099,999**, so INCWAGE reaches **2,199,998** ✔ (ASEC 2026: 220 records at $1M or more). INCBUS and INCFARM are capped near 1,100,000. Screen the components to find top-coded records. A few such records in a small cell (for example federal workers with a high school diploma) can move that group's mean by 10 or more percent. Run `screen_outliers`, and show the results with and without them.
- `WKSWORK1`: weeks worked last year.
- `UHRSWORKLY`: usual hours per week last year (999 NIU).
- `FULLPART`: 1 full-time, 2 part-time last year.
- Hourly wage last year = INCWAGE ÷ (WKSWORK1 × UHRSWORKLY).
- Poverty: `OFFPOV` (official; 1 below, 2 above, 99 NIU = unrelated children under 15, whom the official
  rate leaves out) and `SPMPOV` (supplemental; covers everyone). Person rates of both use `ASECWT`, matching
  Census's P60 tables.
- Health insurance: `ANYCOVLY` (any coverage last year: Census's headline "uninsured for the entire year" is
  ANYCOVLY = 1, and 99 NIU = infants born after the year), `ANYCOVNW` (at the interview), `HIMCAIDLY`,
  `HIMCARELY`, `GRPCOVLY`, ... The CPS codes run the other way from the ACS ones (ACS `HCOVANY` 1 = none):
  read `codebook.csv` before coding. Census's P60 universe keeps armed forces living in households. Coverage
  definitions changed in 2014 and 2019, so check the variable pages.

**Veterans** ✔: `VETSTAT` (0 NIU, 1 no service, 2 yes), `VETLAST` (period of last service). BLS tabulates
veterans in the monthly CPS with a separate veterans weight controlled to VA population estimates, which IPUMS
carries only for 1994-2009: with `WTFINL`, employed veterans come out about 10 percent below BLS's published
counts (2026: 7.0 against 7.9 million) while total employment matches. Benchmark against BLS's veterans
release and say so; a share computed with `WTFINL` is low by about that much.

## 6. Missing and top codes
`stats.clean_missing(df, collection, codebook=...)` blanks codes whose `codebook.csv` label says N/A, NIU, missing or unknown, plus the hard-coded income and hours codes in `stats.MISSING`. Categorical status variables (EMPSTAT, SEX, ...) are kept as they are and handled by the recode helpers. Always look at the min and max of every dollar or hours variable before taking a mean. An unremoved 9999999 code is the classic IPUMS mistake.

## 7. Ready-made variable sets by topic
- **Employment by nativity (ACS):** AGE SEX CITIZEN BPL YRSUSA1 EDUCD EMPSTAT LABFORCE INCWAGE UHRSWORK WKSWORK1 (+ PERWT auto). Case selection AGE 25–54.
- **Federal vs. private pay (CPS ASEC):** AGE SEX RACE HISPAN EDUC CLASSWLY INCWAGE WKSWORK1 UHRSWORKLY FULLPART OCCLY INDLY STATEFIP VETSTAT CPI99 REPWTP. Case selection CLASSWLY 22, 25. (OCCLY/INDLY describe the same job as CLASSWLY, last year's; OCC2010/IND1990 describe the current job.)
- **Federal vs. private pay (ACS alternative, a bigger sample):** AGE SEX EDUCD CLASSWKRD INCWAGE WKSWORK1 UHRSWORK OCC2010 STATEFIP. Case selection CLASSWKRD 22, 23, 25.
- **Veterans' labor force (ACS):** AGE SEX VETSTAT VET01LTR VETDISAB EMPSTAT LABFORCE EDUCD INCWAGE. Case selection SEX 1, AGE 22–44.
- **Health insurance (ACS):** AGE SEX HCOVANY HCOVPRIV HINSEMP HINSCAID HINSCARE POVERTY STATEFIP CITIZEN.
- **Poverty (CPS ASEC):** AGE SEX OFFPOV SPMPOV FTOTVAL REPWTP (OFFPOV is IPUMS's corrected official status: use it rather than
  POVERTY; REPWTP gives the standard errors; `case_select_who: households` for family measures).
- **Minimum wage exposure (CPS monthly ORG):** AGE SEX EDUC HOURWAGE2 PAIDHOUR EARNWEEK2 UHRSWORKT STATEFIP CLASSWKR (+ EARNWT), pooled over 12 months.
- **Insurance and access (NHIS):** AGE SEX RACENEW HISPYN REGION POVERTY USBORN CITIZEN EDUC HINOTCOVE HIPRIVATEE HIMCAIDE HIMCAREE USUALPL DELAYCOST YBARCARE (+ SAMPWEIGHT, STRATA, PSU auto). No case selection in NHIS: mark the group with a domain mask after download.
- **Chronic conditions and risk factors (NHIS):** AGE SEX RACENEW HISPYN EDUC POVERTY HYPERTENEV DIABETICEV ASTHMAEV BMICALC SMOKESTATUS2 HEALTH.
- **Spending by payer (MEPS):** AGE SEX RACEA HISPYN REGIONMEPS POVCAT COVERTYPE HINOTCOV EXPTOT EXPSELFPAY EXPMCPAY EXPMAPAY EXPPRPAY RXEXPTOT HEALTH (+ PERWEIGHT, STRATANN, PSUANN auto).

## 8. IPUMS NHIS variables
**Technical (auto) ✔:** YEAR, SERIAL, STRATA, PSU, NHISHID, PERNUM, NHISPID, HHX, SAMPWEIGHT, ASTATFLG,
CSTATFLG. From 2019 the extract holds only sample adults (`ASTATFLG` 1) and sample children (`CSTATFLG` 1):
2024, 32,629 adults and 8,360 children. Adult-only items (EMPSTAT, EDUC, conditions) are NIU (0) for children.
- **Design break:** the 2019 questionnaire and weighting redesign: don't compare trends across it. 2020 was
  collected partly by telephone during the pandemic, with a partial panel (`PARTWEIGHT`, see section 3); some
  2020-2021 items cover only some quarters (IPUMS: zero the missing quarters' weights and scale by 4 ÷ quarters).
- **Demographics ✔:** AGE (85 = 85+; 997-999 unknown, blanked by `clean_missing`), SEX (1 male, 2 female, 7-9
  unknown), RACENEW (100 White only, 200 Black only, 300 AIAN only, 400 Asian only, 510/520/540 other or
  multiple, 997-999 unknown), HISPYN (1 no, 2 yes), REGION (1 Northeast, 2 Midwest, 3 South, 4 West).
- **Nativity ✔:** `USBORN` 20 born in the U.S., 10 no (2024 has only 10 and 20; 11 territory and 12 abroad in
  other years), 96-99 NIU/unknown; `CITIZEN` 1 not a citizen, 2 citizen, 7-9 unknown.
  `stats.foreign_born(df, "nhis")` uses USBORN.
- **Education ✔ (sample adults):** `EDUC` 100-116 less than high school, 200-202 diploma or GED, 300-303 some
  college or associate, 400 bachelor's, 500 graduate (no detail), 510 master's, 520-522 professional or
  doctorate, 530 other, 996-999 unknown. `stats.educ_group(df, "nhis")`.
- **Employment ✔ (sample adults):** `EMPSTAT` from 2019 only 100 employed, 200 not employed, 999 unknown (no
  unemployed vs. out of the labor force split); earlier years 110-122 employed, 210-217 unemployed, 220 not in
  labor force. `stats.emp_status(df, "nhis")` returns "not employed" for 200.
- **Income ✔:** `POVERTY` family income to poverty ratio in categories (11-14 below 1.00, 21-25 1.00-1.99,
  31-38 2.00 and over, 98 undefinable, 99 unknown).
- **Insurance ✔ (at the interview, all persons):** `HINOTCOVE` 1 covered, **2 uninsured**, 7-9 unknown (NCHS's
  headline "uninsured at the time of interview"); `HIPRIVATEE`, `HIMCAIDE`, `HIMCAREE` 1 no, 2 yes, 3 yes without
  detail (count 2 and 3 as covered), 7-9 unknown.
- **Access ✔:** `USUALPL` usual place of care (1 none, 2 yes, 3 more than one place: count 2 and 3), `DELAYCOST`
  delayed care because of cost and `YBARCARE` needed care but couldn't afford it (1 no, 2 yes).
- **Conditions and risk ✔ (sample adults):** `HYPERTENEV`, `ASTHMAEV` (1 no, 2 yes), `DIABETICEV` (2 yes, 3
  borderline), `SMOKESTATUS2` (10-13 current, 20 former, 30 never), `BMICALC` (0 NIU, 996 not calculable: both
  blanked by `clean_missing`; 2020/2022/2024 include sample children ages 10-17), `HEALTH` (1 excellent ... 5 poor).
- Benchmarks: NCHS Health Insurance Coverage (annual and early release) and the NHIS Interactive Summary
  Health Statistics for Adults/Children.

## 9. IPUMS MEPS variables
**Technical (auto) ✔:** YEAR, PERNUM, DUID, PID, MEPSID, PANEL, PANELYR, RELYR, PSUANN, STRATANN, PSUPLD,
STRATAPLD, PERWEIGHT, SAQWEIGHT, DIABWEIGHT. A year's file pools the panels in the field that year (2022:
panels 24, 26 and 27). Spending, use and coverage are for the **whole calendar year**; dollars are nominal for
that year (convert with a named price index; health spending usually with the PCE health index or CPI medical care).
- **Not in IPUMS MEPS:** `EMPSTAT` and `CITIZEN` (the API rejects them); `INSCOV` and the NHIS `...E` insurance
  names do not exist either: use the names below.
- **Demographics ✔:** AGE (age on 31 December; 85 = 85+; 996 missing, blanked by `clean_missing`), SEX,
  RACEA (100 White, 200 Black, 3xx AIAN, 4xx Asian/Pacific Islander), HISPYN (1 no, 2 yes), REGIONMEPS
  (1 Northeast, 2 Midwest, 3 South, 4 West), USBORN (as NHIS).
- **Education ✔:** `EDUC` uses the NHIS coding (section 8), but children carry their grade in school (101-116),
  and 530 "other degree" is about 8% of persons: restrict to adults (25+ for attainment) and say how 530 is treated.
- **Income ✔:** `POVCAT` 1 poor (<100% of poverty), 2 near poor (100-124%), 3 low (125-199%), 4 middle
  (200-399%), 5 high (400%+), AHRQ's standard income groups. `POVLEV` continuous.
- **Insurance over the year ✔:** `HINOTCOV` 1 covered, **2 uninsured all year**, 9 unknown (2022: 6.4%);
  `COVERTYPE` 1 private, 2 Medicaid and other public, 3 other, 4 uninsured (AHRQ's hierarchy for persons under
  65; `COVTYPEAGE` adds age 65+); `HIPRIVATE`, `HIMACHIP`, `HIMCARE` (1 no, 2 yes).
- **Spending ✔ (annual dollars, no missing codes):** `EXPTOT` total payments; by payer `EXPSELFPAY`
  (out-of-pocket), `EXPMCPAY` Medicare, `EXPMAPAY` Medicaid, `EXPPRPAY` private insurance (2022 shares of the
  total: 13.6, 26.3, 12.4, 41.9 percent) and others (`EXPVAPAY`, `EXPTRIPAY`, `EXPOFPAY`, `EXPOLPAY`, `EXPWCPAY`,
  `EXPOTHPAY`); prescription drugs `RXEXPTOT`. Other service groups (office-based, hospital, emergency room)
  have their own variables: look them up on meps.ipums.org and test the names with `--dry-run` plus a submit.
  `CHGTOT` is charges, not payments: never mix them.
- **Skew:** spending is extremely concentrated (the top 1 percent hold about a fifth of the total; 2022 maximum
  $1.3M). Report means with SEs, add medians or the share with any spending, and run `screen_outliers`.
- **Access ✔:** `USUALPL` as in NHIS.
- Benchmarks: AHRQ MEPS-HC summary tables and Statistical Briefs (for example #560: 2022 mean $6,765 per person).
