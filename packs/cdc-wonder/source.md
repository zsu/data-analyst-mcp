# CDC WONDER: mortality, natality and population query results (manual export)
Depth: standard. Key: none. Manual only. CDC WONDER (NCHS vital statistics) query results that the user runs on
the WONDER web site and exports. Deaths by underlying or multiple cause (ICD-10), births (natality), infant
deaths, with populations and crude and age-adjusted rates, by year, state, county, age, sex, race and Hispanic
origin, as grouped in the query.

## When to use
- Deaths and death rates for causes, years and places that the cdc pack's Socrata tables do not have: cdc's
  leading causes end in 2017 and life expectancy in 2018, while WONDER has final data to the latest year;
  county rates; any ICD-10 code or group; age-adjusted rates by demographic group.
- Births by mother's characteristics, infant mortality.
- Not here: provisional weekly deaths and overdose counts that cdc's Socrata tables carry (cdc); health
  insurance (census); injuries treated in emergency departments (cpsc NEISS).

## Endpoints
| Endpoint | Returns | Parameters |
|---|---|---|
| `export` | the uploaded WONDER export as published: one column per Group By field (name and code columns, e.g. `Year`, `Year Code`), then `Deaths`, `Population`, `Crude Rate`, `Age Adjusted Rate` ... as chosen; `Notes` (`Total` on total rows) | `database` (required: the WONDER database name), `query` (the query in words) |

## Spec examples
```json
{"description": "Age-adjusted suicide death rates by state, 2023 (WONDER export)",
 "requests": [{"name": "suicide_2023", "endpoint": "export",
   "params": {"database": "Underlying Cause of Death, 2018-2023, Single Race",
              "query": "Group By State; Year 2023; ICD-10 113 Cause List: Intentional self-harm (suicide); age-adjusted rates"}}]}
```

## Data format and traps
- The export layout was not checked against a real file here. The reader takes the first line as the header
  and stops at the "---" line, where WONDER's notes begin. Read the columns and the notes (the uploaded file is
  kept in `raw/`) before using the table. Cite the query criteria the notes list.
- `Notes` = "Total" marks total rows: drop them before summing groups.
- Suppression and reliability: WONDER shows small counts as "Suppressed" and flags some rates "Unreliable". Keep
  them as text and never fill them with 0. The data use restrictions forbid presenting or publishing any
  statistic representing nine or fewer births or deaths, including rates based on them: aggregate further
  instead.
- Compare places or years with age-adjusted rates, not crude ones, and say which standard population (WONDER
  states it in the notes).
- Databases differ: single-race (2018 on) and bridged-race (1999-2020) files use different race categories.
  Final and provisional data differ. Do not join years across databases without saying so. Causes are ICD-10;
  name the codes.
- Values are text with WONDER's formatting; convert with `Number()` after removing thousands separators.

## Access
Manual only: wonder.cdc.gov answers this client with HTTP 403 (verified 2026-11-07). The WONDER API would also
require every query to accept the data use restrictions on the user's behalf. The user opens
https://wonder.cdc.gov/, chooses the database, reads and accepts the data use restrictions, sets the query,
clicks Send, then Export, and uploads the saved .txt; then `ingest`.

## Citation and terms
"Centers for Disease Control and Prevention, National Center for Health Statistics. <database name> on CDC
WONDER Online Database, accessed <date>." Data use restrictions: https://wonder.cdc.gov/datause.html (statistical
reporting and analysis only; no re-identification; no statistics on nine or fewer births or deaths).
