# CBP nationwide encounters: border apprehensions and inadmissibles by month, region, demographic and citizenship
Depth: standard. Key: none. U.S. Customs and Border Protection's monthly Nationwide Encounters data files (the CSVs
behind CBP's encounters dashboard). They count Border Patrol apprehensions (between ports of entry) and Office of
Field Operations inadmissibles (at ports of entry), under Title 8. Breakdowns: fiscal year and month, land border
region, area of responsibility (Border Patrol sector or field office) or state, demographic and citizenship.

## When to use
- Southwest border encounters by month; year-over-year change; encounters by citizenship, demographic (single
  adults, family units, unaccompanied children, accompanied minors), component, sector or field office, or state.
- Not here: annual immigration statistics (green cards, refugees, naturalizations, removals: dhs-ohss); asylum
  and immigration court cases (not covered); trade and customs duties (census, usitc, treasury).

## Endpoints
| Endpoint | Returns | Parameters |
|---|---|---|
| `list_files` | the encounter CSVs on CBP's document page, newest first: `file`, `by` (area of responsibility or state), `fiscal_years`, `url` | none |
| `encounters` | one file's rows as published | `file` (from `list_files`), filters `region`, `component`, `fiscal_year`, `citizenship` |

Columns:
- By area of responsibility (`-aor`): Fiscal Year, Month Grouping, Month (abbv), Component, Land Border Region,
  Area of Responsibility, AOR (Abbv), Demographic, Citizenship, Title of Authority, Encounter Type, Encounter
  Count.
- By state (`-state`): Fiscal Year, Month Grouping, Month (abbv), Land Border Region, State, Demographic,
  Citizenship, Title of Authority, Encounter Count.

## Spec example
```json
{"description": "Southwest border encounters by month, FY2024 to date (file of November 2026)",
 "requests": [{"name": "files", "endpoint": "list_files"},
  {"name": "swb", "endpoint": "encounters",
   "params": {"file": "2026-11/nationwide-encounters-fy24-fy27-oct-aor", "region": "Southwest Land Border"}}]}
```
Run `list_files` first: the newest file is replaced every month (paths verified 2026-11-07).

## Data format and traps
- Each file covers about four fiscal years, the last one partial (`2027 (FYTD)`). Earlier months are revised in
  later files: use the newest file, and do not mix files.
- `Month Grouping` is `FYTD` for the months that fall in the current fiscal year-to-date period, marked in every
  year for comparison (only OCT in the November 2026 file), and `Remaining` for the others. Months are abbreviations (`OCT` ... `SEP`), and the fiscal year starts in October. Build a
  date before plotting (FY2025 OCT = October 2024).
- Encounters are events, not people: one person can be encountered more than once.
- OFO inadmissibles and Border Patrol apprehensions are different events. Add them only for "total
  encounters", and say so.
- `Land Border Region` `Other` holds encounters away from land borders (airports, seaports, coastal).
- `Citizenship` lists the main countries and groups the rest as `OTHER`: a country absent from the list is
  inside OTHER, not zero. Demographic codes: `FMUA` is individuals in family units, `UAC` unaccompanied children,
  plus Single Adults and Accompanied Minors.
- Counts are text; sum with `Number()`. Every row of the November 2026 files is Title 8: older files also have
  Title 42 expulsions (March 2020 to May 2023), which are encounters too.

## Access
No key. `fetch` reads www.cbp.gov (verified 2026-11-07; the files are 2-5 MB). Manual: the document page's CSV
links, then `ingest`.

## Citation and terms
"U.S. Customs and Border Protection, Nationwide Encounters, <file name>, cbp.gov, retrieved <date>." Public
domain (17 U.S.C. 105).
