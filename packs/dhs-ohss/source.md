# DHS Office of Homeland Security Statistics (Yearbook of Immigration Statistics)
Depth: standard. Key: none. The DHS Yearbook of Immigration Statistics tables (green cards / lawful permanent
residents, refugees, asylees, naturalizations, nonimmigrant admissions, enforcement actions) by fiscal year, read
from the workbooks posted on ohss.dhs.gov, plus the quarterly Legal Immigration and Adjustment of Status Report.

## When to use
- Official annual counts of people obtaining green cards (LPR status) by class of admission (family, employment,
  diversity, refugee/asylee adjustments), country of birth or last residence, state, metro area, age, sex,
  occupation; refugee arrivals; asylum grants (affirmative and defensive); naturalizations; nonimmigrant (I-94)
  admissions by class (tourists, students, H-1B and other workers), country, state; apprehensions, encounters,
  removals, returns and Title 42 expulsions.
- The current fiscal year so far, by quarter: `lir_table` (preliminary).
- Not here: the foreign-born population or immigrants' characteristics from surveys (census ACS); visa issuance
  (State Department, not covered); immigration court cases (EOIR, not covered); monthly enforcement statistics: the
  OHSS "Immigration Enforcement and Legal Processes Monthly Tables" stop at November 2024 and the page says the
  report "is delayed while it is under review" (verified 2026-10-30); this pack does not read them.

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `yearbook_table` | one sheet of a yearbook workbook, as published | `topic`, `fiscal_year`, `table`, `header_row` |
| `lir_table` | one sheet of the quarterly report workbook (FY2016 on) | `fiscal_year`, `table`, `header_row` |
| `yearbook_files` | the data files posted for a year: `fiscal_year, topic, title, url, format` | `fiscal_year` (one, a list, or newest), `topic` |
| `lir_files` | the quarterly report workbooks: `fiscal_year, through_quarter, title, url` | none |

Topics (FY2024 table numbers; earlier years number them differently, e.g. FY2023 refugees 13-15, asylees 16-19,
naturalizations 20-24, nonimmigrants 25-32, enforcement 33-42):
| `topic` | Tables | Notes |
|---|---|---|
| `lpr` | 1-12 and LPRSuppTable 1-4 | Table 6: type and major class, 10 years; Table 7: detailed class (IR1, CR6 ...), one year; Table 3: country of birth; Table 2: last residence; Table 4: state; Table 5: metro (CBSA) |
| `lpr_expanded` | Tables 8-11 split by adjustments of status / new arrivals | separate workbook |
| `refugees` / `asylees` | 13-15 / 16-20 | up to FY2022 one combined workbook (`refugees_asylees`; `refugees` and `asylees` both find it) |
| `naturalizations` | 21-25 and 3 supplemental tables | |
| `nonimmigrant` | 26-33, NISuppTable1-3 | |
| `enforcement` | 33-42 (FY2023) | FY2024 is "coming soon" on its page (2026-10-30): ask for FY2023 |
| `*_supplementary` | the separate supplementary zip of FY2015-2021 | from FY2022 the same tables are in the main workbook (the pack uses it and says so) |

Coverage: data workbooks for FY2015 on (.xlsx from FY2022, a .zip of one .xlsx per table for FY2015-2021); older
years are PDF only. Without `fiscal_year` the pack takes the newest year page that posts the topic's file and says
which. `table` is the sheet name (`"Table 6"`, `"LPRSuppTable 1"`, `"NISuppTable1"`, FY2015-2021 `"Table 7D"`), or a
number (`"6"`); a missing or wrong name fails with every sheet and its title, so a first request can be used to see
them. `yearbook_files` shows what a year has. `--search` finds topics by words (green card, deportation, H-1B).

## Spec examples
```json
{"description": "Persons obtaining LPR status by type and major class of admission, FY2015-2024",
 "requests": [{"name": "lpr_class", "endpoint": "yearbook_table",
               "params": {"topic": "lpr", "fiscal_year": 2024, "table": "Table 6"}}]}
```
```json
{"description": "Green cards by country of birth (newest yearbook) and removals by nationality (FY2023)",
 "requests": [{"name": "lpr_birth", "endpoint": "yearbook_table", "params": {"topic": "lpr", "table": "Table 3"}},
              {"name": "removals", "endpoint": "yearbook_table",
               "params": {"topic": "enforcement", "fiscal_year": 2023, "table": "Table 42"}}]}
```
```json
{"description": "This fiscal year's green cards by class and quarter, and what the FY2024 yearbook page posts",
 "requests": [{"name": "lir_class", "endpoint": "lir_table", "params": {"table": "Table 1B"}},
              {"name": "files", "endpoint": "yearbook_files", "params": {"fiscal_year": 2024}}]}
```

## Data format and traps
- **Layout kept as published.** Columns are the sheet's header (the first row with two or more filled cells, or
  `header_row`; the note says which row). Two header rows are joined: "Adjustments of status Quarter 1", "2014
  Criminal". Upper-case label rows (TOTAL, ADJUSTMENTS OF STATUS, NEW ARRIVALS, REGION, COUNTRY, AGE) are not rows:
  they fill a first column `section`, so `Total` appears once per section (Table 6: TOTAL / ADJUSTMENTS OF STATUS /
  NEW ARRIVALS; Table 3: REGION and COUNTRY). Filter on `section` before summing, and never add a region to its
  countries. Year tables such as Table 1 and Table 33 are printed in side-by-side panels (`Year`, `Number`,
  `Year_col3`, `Number_col4` ...): stack them yourself. Values are text; labels keep footnote markers
  ("Children1", "All other countries1"); the footnotes, Notes and Source lines are in the fetch notes.
- **Codes are not numbers**: `D` = data withheld to limit disclosure, `-` = zero (in some older tables "zero or not
  available"), `X` = not applicable, `NA` = not available. The note counts each code found. Treat them as missing,
  never as 0 unless the footnote says zero.
- **Rounding and revisions.** The FY2024 LPR and nonimmigrant workbooks, the FY2023 enforcement workbook and the
  FY2025 quarterly report round every cell to the nearest 10 ("Totals may not sum due to rounding"); the FY2019
  workbooks give exact counts with `D` cells (verified on those files; other years unchecked). Each yearbook
  re-publishes 10 years of history from the current system of record, so earlier years change between editions
  (FY2019 LPR total 1,031,765 in the FY2019 file, 1,031,770 in the FY2024 file). Take a series from one edition.
- **Fiscal years**: October 1 to September 30 (FY2024 = Oct 2023-Sep 2024). FY1976 includes 15 months (July 1975 to
  September 1976).
- **LPR counts**: "persons obtaining lawful permanent resident status" = adjustments of status (already in the
  U.S.) plus new arrivals (immigrant visas from abroad). FY2024: 1,364,090 total = 782,800 adjustments + 581,290
  new arrivals (Table 6/7). Refugees and asylees appear when they adjust to LPR status (possible after a year in the
  U.S.), not when they arrive or are granted asylum: refugee *arrivals* (Tables 13-15) and LPR *refugee adjustments* (Table 6) are different counts.
  Classes: immediate relatives of U.S. citizens (no numerical cap), family-sponsored preferences, employment-based
  preferences, diversity, refugees, asylees, other; Table 7 gives the detailed class codes.
- **Country**: LPR and naturalization tables use country of birth (and LPR Tables 2/11 last residence); refugee,
  asylee, enforcement tables and the quarterly report use country of nationality; nonimmigrant tables use country
  of citizenship or residence. They are not interchangeable.
- **Events, not people**: nonimmigrant admissions count arrival events ("not unique individuals"; repeat visits
  count again; most short-term land admissions from Canada and Mexico are excluded); Table 26's "Total all
  admissions" is an estimate rounded to the nearest 100,000, while the I-94 rows are counts. Apprehensions,
  encounters, removals and returns are events: one person can be counted more than once in a year. Removals are
  based on an order of removal; returns are not; Title 42 expulsions (COVID-19 public health grounds) are a separate column.
- **Quarterly report (`lir_table`)**: preliminary (data available one month after the quarter), revised in later
  editions; final annual counts come in the yearbook (FY2025 report: 1,320,080 LPRs through quarter 4).
- New classes appear over time (E1S/E1Y, L2S/L2Y from January 2022): a class absent in early years may be folded
  into another (see the footnotes).

## Access
No key, no API: the pack reads public pages and workbooks on ohss.dhs.gov (1 request a second). File names carry
upload dates and are re-posted with new names after revisions, so the pack scrapes the year page each run and the
manual item names the file found. The site sits behind Akamai, which refused this pack's scripted requests with
HTTP 403 from one machine on 2026-10-30 while a browser read the same pages: a 403 ends the script route with
`blocked`, and the route check then offers the manual route.

Manual download: open https://ohss.dhs.gov/topics/immigration/yearbook, choose the fiscal year ("About the 2024
Yearbook"), and download the topic's data tables file (e.g. "Lawful Permanent Residents 2024 Data Tables (xlsx)";
FY2015-2021 offer a .zip; "Expanded ... Tables 8-11" is in the Download Data list at the bottom). For the quarterly
report open https://ohss.dhs.gov/topics/immigration/legal-immigration-and-adjustment-status-report and download the
fiscal year's .xlsx. Upload the file unchanged under the name in INSTRUCTIONS.md; `--ingest` reads the requested
sheet the same way as the script route.

## Citation and terms
U.S. Department of Homeland Security, Office of Homeland Security Statistics, <Yearbook of Immigration Statistics
FY2024, Table 6 | Legal Immigration and Adjustment of Status Report FY2025>, ohss.dhs.gov, retrieved <date>.
Name the edition (fiscal year of the yearbook) and the table. Public domain (U.S. government work, 17 U.S.C. 105):
tables and data may be redistributed. No required notice.
