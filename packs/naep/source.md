# NAEP, The Nation's Report Card (NAEP Data Service)
Depth: standard. Key: none. National, state and large-district results of the National Assessment of
Educational Progress: average scale scores, achievement levels and percentiles by subject, grade, year and
student group, with standard errors and NAEP's own significance tests.

## When to use
- K-12 achievement: reading and mathematics (grades 4 and 8, every two years; grade 12 less often),
  science, writing, civics, U.S. history, geography, economics, technology and engineering literacy,
  music. States versus the nation, change since 2019, gaps by race, sex, economic disadvantage.
- Not here: state test results (each state's own exams, not comparable across states), graduation rates
  and school finance (nces or ed packs if present), college outcomes (college-scorecard).
- NAEP is a sample survey: every number is an estimate. It reports groups, never students or schools.

## Endpoints and datasets
All endpoints call `GetAdhocData.aspx` with a different `type`; standard errors come from `QCData=true`
(set by default).

| Endpoint | Returns | Key parameters |
|---|---|---|
| `scores` | estimates: `value`, `stdError`, `cellN`, `errorFlag` | `subject`, `grade`, `jurisdiction`, `Year`, `variable`, `stattype`, `subscale` |
| `achievement_levels` | % below Basic, at/above Basic, at/above Proficient, at Advanced | same (stattype fixed) |
| `compare_years` | year-vs-year test: `focalValue`, `targetValue`, `gap`, `sig`, `pValue`, `seDiff` | `Year` = 2+ years |
| `compare_jurisdictions` | every ordered pair of jurisdictions, tested | `jurisdiction` = 2+ codes |
| `compare_groups` | categories of one variable, tested (male vs female) | `variable` (not TOTAL) |
| `gap_years_across_jurisdictions` | is one place's change different from another's? | 2 years, 2+ jurisdictions |
| `gap_groups_across_years` | did a group gap change over time? | `variable`, 2+ years |
| `gap_groups_across_jurisdictions` | is a group gap larger in one place? | `variable`, 2+ jurisdictions |
| `variables` | independent variables for a subject, cohort (1, 2, 3 = grades 4, 8, 12), year | `subject`, `cohort`, `Year` |

Codes (`--search` finds them; `--endpoints` lists the catalog):
- Subjects: `reading`, `math` (= mathematics), `science`, `writing`, `civics`, `history`, `geography`,
  `economics` (grade 12), `tel` (grade 8), `music` (grade 8). Aliases: `ela`, `us history`. The pack
  fills `subscale` with the composite scale: RRPCM, MRPCM (math grade 12: MWPCM), SRPUV, WRIRP, CIVRP,
  HRPCM, GRPCM, ERPCM, TRPUN, MUSRP. Subscales: `--search geometry`.
- `variable`: TOTAL, SDRACE (race/ethnicity), GENDER, ECONDIS (economically disadvantaged), PARED,
  SCHTYPE, CHRTRPT, UTOL4 (city/suburb/town/rural), CENSREG, IEP, LEP; crosstab `SDRACE+GENDER`.
  SLUNCH3 (lunch eligibility) ends in 2022: in 2024 every SLUNCH3 cell is 999 "Non-qualified independent
  variable", and ECONDIS carries the poverty split (its 2019 and 2022 values equal SLUNCH3's; verified
  2026-10-28). A trend through 2024 uses ECONDIS for every year.
- `stattype`: MN:MN mean; ALC:BB / ALC:AB / ALC:AP / ALC:AD cumulative levels; ALD:* discrete levels;
  RP:RP row percent; percentiles PC:P1, PC:P2, PC:P5, PC:P7, PC:P9 (10th, 25th, 50th, 75th, 90th; other
  PC codes answer HTTP 400 "The Statistic PC:P3 is not valid.", verified 2026-10); SD:SD.
- `jurisdiction`: NP national public, NT national (public and private), NR private, NL large city,
  state postal codes, DS DoDEA, TUDA districts (XN New York City, XC Chicago, XL Los Angeles, ...).
  NR has rows only through 2013 (later years return an empty result, verified 2026-10); for later years
  use `jurisdiction=NT` with `variable=SCHTYPE` (Public, Catholic, Other private, Bureau of Indian
  Education, Department of Defense: no combined private row, and Other private is often suppressed).
- `Year`: 2024, a list 2024,2019, or Current / Prior / Base. Suffix R2 = the old non-accommodated sample.

## Spec examples
```json
{"description": "Grade 4 reading, nation: 2024 vs 2019, estimates and test",
 "requests": [{"name": "read4_np", "endpoint": "scores",
               "params": {"subject": "reading", "grade": 4, "jurisdiction": "NP", "Year": "2024,2019"}},
              {"name": "read4_change", "endpoint": "compare_years",
               "params": {"subject": "reading", "grade": 4, "Year": "2024,2019"}}]}
```
```json
{"description": "Grade 8 math 2024: Massachusetts and Mississippi vs the nation; percent proficient",
 "requests": [{"name": "math8_states", "endpoint": "compare_jurisdictions",
               "params": {"subject": "math", "grade": 8, "jurisdiction": "NP,MA,MS", "Year": "2024"}},
              {"name": "math8_levels", "endpoint": "achievement_levels",
               "params": {"subject": "math", "grade": 8, "jurisdiction": "NP,MA,MS", "Year": "2024"}}]}
```
```json
{"description": "Grade 4 reading gap by economic disadvantage, 2019 to 2024",
 "requests": [{"name": "poverty_gap", "endpoint": "gap_groups_across_years",
               "params": {"subject": "reading", "grade": 4, "variable": "ECONDIS", "Year": "2024,2019"}}]}
```

## Data format and traps
- **Estimates with standard errors.** NAEP tests a sample of students, so `value` is an estimate and
  `stdError` its standard error. Two numbers that differ may not differ significantly. Say a change or a
  gap is real only when NAEP's test says so: use `compare_*` / `gap_*` and read `sig`: HIGHER, LOWER, or
  EQUAL (= not significantly different), with `pValue` against `critPValue` (0.05; multiple-comparison
  adjusted by NAEP for families, `famSize`). Do not run your own t-test on rounded numbers. Report the
  standard error or the significance result next to every comparison (the audit checks this).
- In comparison rows `gap` = focal minus target; every pair appears twice (A vs B and B vs A). Keep one.
- **Suppressed estimates arrive as `value` 999 with `stdError` -1** and `isStatDisplayable` 0 (reporting
  standard not met, too few students). The pack adds `value_flag` = "suppressed" for those rows: drop them,
  never average 999. When every estimate of a request or of one year is withheld, the fetch notes it with
  the reasons (a variable not reported that year names its replacement). `errorFlag` is a bit sum; the pack decodes it into `errorFlag_notes` ("Reporting
  standard not met", "Race note type 1", ...). Notes such as 512 keep the value; they are footnotes.
- Values are unrounded (216.113410808617). NAEP publishes whole-number scores; round for display only,
  and test on the unrounded values (or use NAEP's `sig`).
- Scales differ by subject and are not comparable across subjects. Reading and math grades 4 and 8 are
  0-500 scales; math grade 12 (MWPCM) and science (SRPUV) are 0-300 and start a new trend line (2005,
  2009 frameworks): do not join them to older years on other scales.
- Achievement levels are cumulative (`ALC:AP` = at or above Proficient includes Advanced). "Proficient"
  is NAEP's demanding standard, not grade-level performance.
- NP (public schools) is the comparison base for states; NT includes private schools. States are public
  only. State samples are far smaller than national ones (`cellN`: 6,025 for California vs 144,652 for
  NP, grade 4 reading 2019), so state standard errors are several times larger.
- Accommodations: since 1996 (math) / 1998 (reading) results include accommodated students (sample R3);
  `Year` with suffix R2 gives the earlier non-accommodated sample. Trend tables mix them at the break.
- Years: reading and math 2024, 2022, 2019, 2017, ...; other subjects are irregular (see the catalog
  descriptions; `Year=Current` returns the latest). A year that was not
  assessed answers HTTP 400 with a long server message ("did not return exactly 1 framework").
- `variables` (type=independentvariables) for 2024 arrives as malformed JSON for some subjects and
  cohorts: survey items quoted inside `longLabel` are not escaped (verified 2026-10). The pack escapes such
  stray quotes before parsing and adds a note; the labels are kept as published. Other years parse as is.
- The `scores` default `Year=Current` changes after each release; write explicit years in specs that
  must reproduce.
- Not every jurisdiction exists for every subject and grade (unverified in detail: grade 12 state
  results are rare, TUDA districts are mostly reading and math, grades 4 and 8); a missing combination
  fails with HTTP 400 or returns suppressed rows. Check one request first.

## Access
No key. Route `api` when www.nationsreportcard.gov answers. Each request is one GET returning one JSON
page. Manual route: `manual_download/INSTRUCTIONS.md` lists the same links (with QCData=true); open each,
save the JSON under the name shown, upload, then `--ingest`. Without the links, build the table in the
NAEP Data Explorer (https://www.nationsreportcard.gov/ndecore/landing): choose subject, grade,
jurisdictions, variables and statistics (include standard errors), run the significance test there, and
download the Excel output; upload it and say which table it is.

## Citation and terms
"U.S. Department of Education, Institute of Education Sciences, National Center for Education
Statistics, National Assessment of Educational Progress (NAEP), <subject, grade, years>, retrieved
<date>." NCES materials are public domain unless marked; cite the source. Redistribution allowed.
Reports must mention standard errors or statistical significance (audit hook `naep_uncertainty`).
