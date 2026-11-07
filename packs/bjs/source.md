# Bureau of Justice Statistics: National Crime Victimization Survey and corrections statistics
Depth: standard. Key: none. Two kinds of data:
- NCVS Select records from BJS's API at api.ojp.gov: the person and household files of the National Crime
  Victimization Survey, 1993-2024 (collection years), one row per victimization, person or household, with
  weights.
- The CSV tables of BJS reports from bjs.ojp.gov: Criminal Victimization (official NCVS numbers, rates and
  standard errors), Prisoners (National Prisoner Statistics), Jail Inmates, Probation and Parole, Capital
  Punishment.

## When to use
- Crime as victims report it, including crimes never reported to police: violent and property victimization
  numbers and rates; the share reported to police; victim characteristics (age, sex, race, income); weapon,
  injury and victim-offender relationship.
- People in prison or jail, on probation or parole, under sentence of death; imprisonment rates by state.
- Not here: crimes known to police, arrests and hate crimes (fbi); federal prosecutions and DOJ press releases
  (doj-news); homicide (NCVS covers nonfatal crimes only; deaths by assault are in cdc); state court cases.

## Endpoints
| Endpoint | Returns | Parameters |
|---|---|---|
| `query` | NCVS Select records (JSON rows, every value text) | `dataset` (catalog alias or 4x4 id), `$select` (plain columns), `$where`, `$order` |
| `statistical_table` | one CSV table of a report package | `report` (code or alias), `member` (file, e.g. `cv24t01.csv`), `header_lines` or `header_row` |

NCVS Select datasets: `personal_victimization` (gcuy-rt5g), `personal_population` (r4j4-fdwx),
`household_victimization` (gkck-euys), `household_population` (ya4e-n9zp). Report packages (verified
2026-11-07): `cv24` and `cv23` (Criminal Victimization, 2024 and 2023), `p23st` (Prisoners in 2023), `ji24st`
and `ji23st` (Jail Inmates), `ppus23` (Probation and Parole, 2023), `cp22st` (Capital Punishment, 2022). In a
package, `<code>t01.csv` is table 1, `at01` appendix table 1 (estimates with standard errors and confidence
intervals), `f01` figure 1. A `member` that matches nothing fails with the list of files in the zip.

## Spec examples
```json
{"description": "Violent victimization numbers and rates, 2020-2024, as BJS published them",
 "requests": [{"name": "cv24_t01", "endpoint": "statistical_table",
   "params": {"report": "cv24", "member": "cv24t01.csv", "header_lines": "11-12"}}]}
```
```json
{"description": "2024 violent victimizations by type and reporting to police, from NCVS Select records",
 "requests": [{"name": "violent_2024", "endpoint": "query", "params": {"dataset": "personal_victimization",
   "$select": "year, newoff, notify, newwgt", "$where": "year = '2024' AND newcrime = '1'"}},
  {"name": "persons_2024", "endpoint": "query", "params": {"dataset": "personal_population",
   "$select": "year, wgtpercy", "$where": "year = '2024'"}}]}
```
Then `compute`: the sum of `newwgt` by `newoff` gives victimizations. Divide by the sum of `wgtpercy` for the
year and multiply by 1,000 for the rate per 1,000 persons age 12 or older.

## Data format and traps
- Report tables (`statistical_table`): the first fetch, without `header_lines`, gives every line numbered (`row`,
  `col1`...). Lines 1-8 are the BJS banner, file name, title, report, data source, authors and version date;
  the title repeats above the header. Read the header line numbers, then fetch again with `header_lines` (e.g.
  `11-12`). Column names join the stacked header (`2024* | Number`, `2024* | Rate per 1,000/a`). A column of
  footnote marks next to a value is named `<parent>_colN`: `†` or `‡` mean the difference from the comparison year
  (marked `*`, e.g. `2024*`) is significant at the 95% or 90% level (table 1's notes).
  Values are text with thousands separators (`6,671,640`). Row labels carry footnote letters (`Total violent
  crime/b`), and the notes below the table explain them. Sub-rows are indented into the next column (`col2`).
  Keep the footnote and significance notes with any number you quote.
- NCVS codes, from BJS's NCVS Select codebooks (person and household level):
  - `newcrime` (person) is 1 violent crime, 2 personal theft/larceny. `newoff` (person) is 1 rape/sexual
    assault, 2 robbery, 3 aggravated assault, 4 simple assault, 5 personal theft/larceny. `seriousviolent` 1
    is violent crime excluding simple assault.
  - Household: `newcrime` 3 is property crime; `newoff` is 6 burglary/trespassing, 7 motor-vehicle theft,
    8 theft.
  - Demographic codes (`ager` 1-6, `sex`, `race_ethnicity` 1-6, `hincome1`, ...), the `notify` codes (reported to
    police) and residue codes (98, -1 "invalid until ...") are in the codebooks:
    https://bjs.ojp.gov/document/NCVS_Select_person_level_codebook.pdf and
    https://bjs.ojp.gov/document/NCVS_Select_household_level_codebook.pdf. Read the code before filtering on it.
- Weights:
  - `newwgt` is the series-adjusted victimization weight; use it for victimization counts (`wgtviccy` is the
    unadjusted annual weight).
  - `wgtpercy` (persons) and `wgthhcy` (households) are the population weights, the rate denominators.
  - For prevalence (unique victims), use `wgt_ovam_per` and the `victim` flag.
  - Never count rows: each row stands for thousands of victimizations.
- Reproducing BJS: the sum of `newwgt` over 2024 violent records is 6,671,636, and BJS publishes 6,671,640
  (rounded to tens). The types match the same way (rape/sexual assault 560,890; robbery 642,150). Standard errors
  and significance tests need the design variables (`pseudostratum`, `secucode`) and BJS's generalized variance
  method; they are not computed here. Take them from the report's appendix tables, or say that none were computed.
- 2024 is the legacy-instrument half of a split sample (109,341 persons). Weights are larger and estimates less
  precise (the codebook). Collection year: crimes are counted in the interview year, not the
  year they happened. Victimizations outside the U.S. are excluded.
- Every column is text: quote values in `$where` (`year = '2024'`). Aggregate SoQL (`sum`, `count`, `$group`)
  is refused before the request is sent, because the site answers it with a bot check. Fetch plain columns and
  aggregate with `compute`. A year of `personal_population` has well over 100,000 rows, so select only the
  columns you need.
- Small cells: a weighted sum over a handful of records is not a reliable estimate. When a tabulation splits a
  year finely (by place size, race and crime type), say how many records are behind each cell, and prefer the
  report tables, whose notes flag unreliable estimates. The person populations behind the rates are in
  Criminal Victimization appendix tables (2024: appendix table 19).

## Access
No key. `fetch` uses api.ojp.gov (records) and bjs.ojp.gov (report zips). Keep requests few: the site has a bot
check. Manual: `https://api.ojp.gov/bjsdataset/v1/<id>.csv?$where=year='2024'&$limit=200000` in a browser, or
the "Data tables" zip on the report's page (https://bjs.ojp.gov/library/publications/...), then `ingest`. API
documentation: https://bjs.ojp.gov/national-crime-victimization-survey-ncvs-api.

## Citation and terms
"U.S. Department of Justice, Bureau of Justice Statistics, National Crime Victimization Survey, NCVS Select
<dataset> (or <report title and NCJ number>, table <n>), bjs.ojp.gov, retrieved <date>." Public domain (17 U.S.C.
105). A tabulation of NCVS Select records is the analyst's own estimate, not a BJS estimate: say so.
