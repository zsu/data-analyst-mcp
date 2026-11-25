# HHS poverty guidelines (ASPE Poverty Guidelines API: the federal poverty level by year, area and household size)
Depth: standard. Key: none. The poverty guidelines the Department of Health and Human Services publishes each
January (the "federal poverty level", FPL), from the Office of the Assistant Secretary for Planning and
Evaluation: annual income by household size for the 48 contiguous states and DC, Alaska and Hawaii, 1983 to the
current year.

## When to use
- The income limit behind an eligibility rule stated as a percent of poverty (Medicaid expansion at 138 percent,
  CHIP, ACA premium tax credits at 100-400 percent, SNAP gross income at 130 percent, school meals at 130 and 185
  percent, LIHEAP, Head Start), to cost a change in the percent or to count who is eligible (with microdata).
- How the guidelines moved over time (they are indexed to the CPI-U), or a projection of next year's guideline
  from a CPI-U forecast.
- Not here: the number or share of people in poverty (census ACS or CPS ASEC, which use the Census Bureau's
  poverty thresholds, a different measure); income relative to poverty person by person (ipums, census
  microdata); program income limits that are not a percent of the guidelines (HUD area median income: hud);
  SNAP's own published income and deduction standards (usda-fna); the guidelines before 1983.

## Endpoints and datasets
Base `https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines/api`, keyless, JSON (verified live
2026-11-25). One CSV per request.

| Endpoint | Returns (one row per) | Key parameters | Coverage |
|---|---|---|---|
| `guidelines` | year x area x household size: `year, state, area, household_size, poverty_guideline` | `year` (one, a list or a range `"2015-2024"`, required), `state` (`us`, `ak`, `hi`; one or a list; default `us`), `household_size` (1 to 20; one, a list or a range; default `1-8`) | 1983 to the current year |

- `poverty_guideline` is annual income in nominal dollars of the guideline year. `state` is `US` (48 contiguous
  states and DC), `AK` or `HI`; `area` names it.
- The pack sends one call per combination (at most 600 a request) and checks every reply against what was asked.

## Spec examples
```json
{"description": "HHS poverty guidelines for households of 1 to 8 persons, 48 contiguous states and DC, 2024-2026",
 "requests": [
  {"name": "fpl", "endpoint": "guidelines", "params": {"year": "2024-2026", "state": "us", "household_size": "1-8"}}]}
```
```json
{"description": "Poverty guideline for a family of four, all three areas, 2015 and 2025",
 "requests": [
  {"name": "fpl4", "endpoint": "guidelines", "params": {"year": [2015, 2025], "state": ["us", "ak", "hi"], "household_size": 4}}]}
```

## Data format and traps
- Guideline year is not program year. HHS publishes year Y's guidelines in the Federal Register in January
  (late January or February in some years) and they take effect on publication. Medicaid and CHIP use the
  current year's guidelines (many states from April 1); ACA premium tax credits for coverage year Y use the
  guidelines of year Y-1; SNAP sets its income limits each October 1 (the start of the fiscal year) from the
  guidelines published that January. Name the guideline year with every limit.
- A percent of poverty is the guideline times the percent (138 percent for a family of four in 2025 is
  1.38 x 32,150). Program rules round in their own ways (monthly limits, to the dollar): for an exact program
  limit, use the program's published table and say which you used.
- Above 8 persons the guideline adds a fixed amount per additional person (5,380 in 2024 for the contiguous
  states); the API applies it for sizes 9 to 20.
- Guidelines are not thresholds. The Census Bureau's poverty thresholds (by family size and number of
  children, for the official poverty rate) differ from the guidelines, which are a simplification of them for
  administrative use. Never mix the two in one series.
- Alaska and Hawaii have their own, higher guidelines; there are no guidelines for Puerto Rico or the
  territories (programs there use the contiguous-states figures or their own rules).
- The guidelines are nominal and indexed to the CPI-U of the prior calendar year (rounded). Deflate with care:
  real growth of the guidelines is close to zero by design.
- The API never answers with an error: a year it does not have (before 1983, or the next year before it is
  published) returns the latest year; an unknown area returns `us`; a size that is not a number returns size 1.
  The pack refuses such values in the spec and checks each reply, so a missing year fails instead of being
  filled with another year's numbers.

## Access
No key; the host answers scripts (verified 2026-11-25). Limit used: four requests per second. `fetch` works
directly. Manual: the current tables at https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines
and the earlier years under "Prior HHS Poverty Guidelines and Federal Register References" on the same site;
record copied figures with `write_table` (`published/<name>.csv`) and name the page.

## Citation and terms
U.S. Department of Health and Human Services, Office of the Assistant Secretary for Planning and Evaluation, HHS
Poverty Guidelines (<years and areas>), aspe.hhs.gov, retrieved <date>. A U.S. government work in the public
domain (17 U.S.C. 105); redistribution allowed. The legal text is each year's Federal Register notice (Annual
Update of the HHS Poverty Guidelines).
