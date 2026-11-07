# HUD Annual Homelessness Assessment Report (AHAR) data: Point-in-Time and Housing Inventory Counts
Depth: standard. Key: none. Manual only. HUD's AHAR data workbooks from the 2025 AHAR Part 1 page on HUD User:
- Point-in-Time (PIT) counts of people experiencing homelessness on one night in January, by Continuum of Care
  (CoC) and by state, 2007-2025.
- PIT counts of veterans, 2011-2025.
- The Housing Inventory Count (HIC) of beds and units, by CoC and by state.
The workbooks have one sheet per year. huduser.gov refuses scripts, so the user downloads the workbook and
uploads it.

## When to use
- How many people experience homelessness in a state or CoC, sheltered vs unsheltered; individuals vs
  people in families; chronically homeless; veterans; unaccompanied youth; change over time.
- Shelter and housing capacity: emergency shelter, transitional housing, safe haven, rapid re-housing and
  permanent supportive housing beds by CoC or state.
- Not here: Fair Market Rents and income limits (hud, with a HUD User token); renters' cost burden and
  doubled-up households (census ACS); homelessness among students (school-year counts by the Department of
  Education); public housing.

## Endpoints
Every endpoint is a workbook (fetch refuses them; `manual_bundle` gives the links, then `ingest`):

| Endpoint | Workbook (2025 edition) |
|---|---|
| `pit_by_coc` | 2007-2025-PIT-Counts-by-CoC.xlsb |
| `pit_by_state` | 2007-2025-PIT-Counts-by-State.xlsb |
| `hic_by_coc` | 2007-2025-HIC-Counts-by-CoC.xlsx |
| `hic_by_state` | 2007-2025-HIC-Counts-by-State.xlsx |
| `veterans_by_coc` | 2011-2025-PIT-Veteran-Counts-by-CoC.xlsx |
| `veterans_by_state` | 2011-2025-PIT-Veteran-Counts-by-State.xlsx |

Parameters:
- `year` (required): the sheet to read, named for the count year.
- `sheet`: any other sheet by name.
- `header_row`: the header line, 1-based (default 1).

## Spec examples
```json
{"description": "PIT counts by state, 2025 and 2020",
 "requests": [{"name": "pit_2025", "endpoint": "pit_by_state", "params": {"year": "2025"}},
              {"name": "pit_2020", "endpoint": "pit_by_state", "params": {"year": "2020"}}]}
```

## Data format and traps
- Read the columns before using them. The workbook layout was not checked here, because the files cannot be
  downloaded by script. The pack reads the year's sheet with its header row as published; a missing sheet fails
  with the list of sheet names. If the first rows are titles, set `header_row`. Columns are kept exactly as named
  in the workbook, which typically embeds the year in each name, so the same measure has a different name in
  each year's sheet: rename before joining years.
- The PIT count is one night in late January, not the number of people homeless over a year. HUD requires a
  sheltered count every year but an unsheltered count only every other year (odd years), so a CoC's
  even-year unsheltered number may be carried forward from the year before. In 2021 many CoCs did no
  unsheltered count because of COVID-19, and the 2021 AHAR reported sheltered counts only: 2021 totals are not
  comparable. Say which year and which population.
- Populations overlap: individuals plus people in families make up the total, while chronically homeless,
  veterans and youth are subsets of it. Never add subpopulations to the total.
- CoCs are HUD's planning areas: one city, a county, several counties or a "balance of state". CoC numbers
  (like "CA-500") and boundaries change; CoCs merge. Do not equate a CoC with a city without saying so. A state's
  total is the sum of its CoCs.
- HIC counts beds and units on the PIT night, not people. Permanent supportive housing and rapid re-housing
  beds hold formerly homeless people, who are not in the PIT count.
- Values are counts as published (numbers in the workbook). Blank cells are blanks: never fill them with 0.

## Access
No key. Manual only: www.huduser.gov answers scripts with an empty HTTP 202 challenge (verified 2026-11-07). The
user opens https://www.huduser.gov/portal/datasets/ahar/2025-ahar-part-1-pit-estimates-of-homelessness-in-the-us.html
in a web browser, downloads the workbook (the `manual_bundle` links point at the files) and uploads it as saved;
then `ingest`. Older AHAR editions have their own pages under https://www.huduser.gov/portal/datasets/ahar.html.

## Citation and terms
"U.S. Department of Housing and Urban Development, 2025 Annual Homelessness Assessment Report (AHAR) to Congress,
Part 1, 2007-2025 Point-in-Time Estimates by State (or by CoC; Housing Inventory Count), HUD User, downloaded
<date>." Public domain (17 U.S.C. 105).
