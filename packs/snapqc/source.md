# SNAP Quality Control (QC) public-use microdata
Depth: standard. Key: none. One record per sampled SNAP unit (about 45,000 a year): household members, income,
deductions, benefit and QC findings, with weights to the national caseload; CSV files FY 2014 to the latest (FY 2024).

## When to use
Characteristics of SNAP households and participants that program totals do not give: shares with earnings,
children, elderly or disabled members, noncitizens; gross and net income relative to poverty; deductions;
benefit distributions; ABAWD status; categorical eligibility; what a rule change would do to current units
(the file is the base of FNA's QC Minimodel and its *Characteristics of SNAP Households* report).
Not here: caseload and benefit totals by state and month (usda-fna snap_state_monthly: administrative counts,
not a sample); payment error rates as published (FNA publishes them; the file's STATUS/AMTERR are review
findings, not the official rate); FY 1996-2013 (SAS, Stata and SPSS files only: not read); counties or
sub-state areas (removed from the public file); standard errors (replicate weights are SAS datasets: not read).

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `units` | One row per sampled SNAP unit: id columns HHLDNO STATE STATENAME YRMONTH HWGT FYWGT, plus `fiscal_year`, `database`, `state_abbr` and the chosen variables, values as published | `fiscal_year` (required; one or a list), `variables` (default core set; names, stems with `*`, or `"all"`), `state`, `month` (YYYYMM), `period` (FY 2020) |
| `persons` | One row per person slot with any value (`person` 1-16, 1-18 in FY 2024): person-level stems (default FSAFIL REL AGE SEX RACETH CTZN DIS WORK) with the unit's ids, weights and `variables` (default FSUSIZE FSBEN) | as units, plus `person_variables` (stems), `participants_only` (FSAFIL = 1) |
| `summary` | Weighted totals by state and `US`: `units`, `persons` (FSUSIZE), `benefits` (FSBEN, dollars a month), `benefit_per_unit`, `benefit_per_person`, with `sample_units` and the weight used | `fiscal_year`, `state`, `month`, `period` |

Default `variables` (units): FSUSIZE CERTHHSZ CTPRHH FSBEN RAWBEN FSGRINC FSNETINC FSEARN FSUNEARN TPOV FSKID
FSNKID FSELDER FSNELDER FSDIS FSNONCIT COMPOSITION WRK_POOR TANF_IND CAT_ELIG HOMEDED REP_SYS STATUS AMTERR
REGIONCD; ones missing in an older year are skipped with a note (FY 2014 has no FSKID, FSELDER, FSDIS, STATENAME).
A variable asked for by name that the year lacks is an error. `--search <words>` searches the 204-entry catalog
(the FY 2024 quick-reference codebook: every unit variable and person stem, with its group). Labels and codes
are FY 2024's; check the year's technical documentation before reading codes of another year.

## Spec examples
```json
{"description": "SNAP QC FY 2024: weighted totals by state; Oklahoma units with earnings and poverty ratio",
 "requests": [
  {"name": "totals", "endpoint": "summary", "params": {"fiscal_year": 2024}},
  {"name": "ok_units", "endpoint": "units",
   "params": {"fiscal_year": 2024, "state": "OK", "variables": ["FSUSIZE", "FSBEN", "FSEARN", "TPOV", "FSKID"]}}]}
```
```json
{"description": "SNAP QC FY 2023-2024: participant ages and sex, national",
 "requests": [{"name": "people", "endpoint": "persons",
   "params": {"fiscal_year": [2023, 2024], "person_variables": ["AGE", "SEX"], "participants_only": true}}]}
```

## Data format and traps
- **Weights.** Estimates need weights. FYWGT gives the average month of the fiscal year (what FNA's
  *Characteristics* report uses: sum FYWGT over all rows). HWGT is one month's weight: select `YRMONTH` and use
  HWGT. Several months: HWGT / number of months. Units = sum of weights; persons = sum of weight x FSUSIZE (or
  person rows with FSAFIL = 1); benefits = sum of weight x FSBEN. Unweighted counts are sample sizes, not
  caseloads. Verified: the FY 2024 file reproduces the technical documentation's Table II.3 exactly (21,594,587
  units, 40,168,146 persons, $7,366,534,428 a month); `summary` says so in its notes.
- **The unit is the SNAP unit** (people certified together), not the census household; CTPRHH counts everyone in
  the household listed, FSUSIZE the participants. FSAFILi = 1 marks participant i; codes of other values changed in
  FY 2024. In every year checked (2014, 2018, 2021, 2024) the FSAFIL = 1 count equals FSUSIZE.
- **Use the constructed variables** (origin C: FSBEN, FSUSIZE, FSGRINC, FSNETINC, FSERNDED, TPOV) for analysis;
  the RAW* and reported ones are as entered by reviewers. FSBEN is the benefit recalculated by the editor; RAWBEN
  is what was issued. Money is monthly dollars.
- **Years differ.** Variables are added, removed and recoded (FY 2024: income reported in four fields, 14 new income
  types, EITCi dropped, 17th and 18th person slots, new FSAFIL, SEX, CTZN codes). Check each year's codebook
  before pooling years. FY 2024's file also carries FYWGT_OLD and HWGT_OLD, the weights before the August 2026
  correction: do not use them.
- **FY 2020 and FY 2021 are partial.** No QC reviews March-May 2020: `qcfy2020` (default) holds Oct 2019-Feb 2020
  and Jun-Sep 2020 (9 months); `period: per1` is Oct-Feb, `per2` Jun-Sep. In the period files FYWGT is the full
  file's weight (HWGT / 9): summing it over a period does not give that period's average month (summary uses HWGT /
  the state's months in the file and says so). FY 2021 holds July-September 2021 only. Several states have fewer
  sample months in these years.
- **FY 2018 was reweighted**: the listing has two CSV zips; the pack takes the later upload (2020-08) and notes the
  other (the earlier one gives 19,699,024 units, the later 19,726,769).
- **Missing values** are empty cells in the CSV (the public file has one missing code). Empty person slots are not
  people. Person slots are not always contiguous (up to about 2% of units a year): `persons` keeps every slot with a value.
- **Small samples.** Guam (about 200 a year), the Virgin Islands and several states have a few hundred units; FNA's
  documentation warns against state tabulations of some variables (ABWDSTi in Guam, MO, VT, VI, WY). summary notes
  states under 100 sample units. No standard errors from this pack.
- **Sizes.** A year's zip is 1-6 MB (90 MB of CSV); `"variables": "all"` writes every column (1,177 in FY 2024).
  max_rows is 200,000 (persons nationwide is about 100,000 rows a year).
- **STATE** is the FIPS code without a leading zero (1 = Alabama); `state_abbr` is added. 53 agencies: 50 states,
  DC, Guam, Virgin Islands.
- **Gates.** A fetch fails rather than guess when: the zip's CSV is not `qc_pub_fy<YYYY>[_perN].csv`; required
  columns are missing or names repeat; a row's field count differs from the header; HHLDNO repeats; YRMONTH is
  outside the fiscal year; a weight is not positive; or (summary, full-year files) HWGT / the state's months is not
  FYWGT on every row. Several CSVs of one year in one upload folder is also an error.

## Access
No key, no account, no form. snapqcdata.net (Mathematica for USDA FNA) lists the files at
https://snapqcdata.net/datafiles (`?page=0`... `6`, one "Year YYYY" group each, newest first); each fetch reads the
listing and downloads that year's "QC Data | CSV" zip, so a reissued file is picked up. Manual: download the zip
from the listing (INSTRUCTIONS.md has direct links) and upload it; `--ingest` reads the zip or the bare
`qc_pub_fy<YYYY>.csv`. Technical documentation (codebook, weighting, changes) is the PDF in the same year group;
read it before using a variable's codes. The replicate weights (SAS, 22-146 MB) and a SAS program for standard
errors are on the same page.

## Citation and terms
U.S. Department of Agriculture, Food and Nutrition Administration, SNAP Quality Control Database, public-use file
(prepared by Mathematica), snapqcdata.net, retrieved <date>. Cite the fiscal year and the technical documentation
(e.g. Leftin et al., *Technical Documentation for the Fiscal Year 2024 SNAP QC Database and the QC Minimodel*,
Mathematica, August 2026). Redistribution: allowed. A public-use file with identifiers and sub-state geography
removed; USDA's Ag Data Commons copy of FY 2022 carries the U.S. Public Domain label; snapqcdata.net states no terms
(checked 2026-10-31).
