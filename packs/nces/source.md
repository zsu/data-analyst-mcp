# National Center for Education Statistics: Digest of Education Statistics tables and IPEDS data files
Depth: standard. Key: none.
- The Digest of Education Statistics: NCES's compendium of published tables (enrollment, teachers, finances,
  graduates, degrees, outcomes, pre-K to postsecondary), as each table's Excel file.
- IPEDS complete data files: one row per postsecondary institution, or institution by category, for every
  survey component (directory, enrollment, completions, admissions, student aid, finance, staff), with their
  data dictionaries.

## When to use
- National or state totals as NCES published them: public school enrollment by grade, teachers and
  pupil/teacher ratios, current expenditure per pupil, high school completers, degrees conferred by field and
  level, enrollment trends.
- A named college or every college in a state: fall or 12-month enrollment, completions by CIP code and award
  level, admissions and test scores, tuition, aid, finance (IPEDS).
- Not here: earnings and debt of graduates by program and institution (college-scorecard); federal student
  loans and Pell totals (fsa); test scores of K-12 students (naep); school-age population, poverty or
  attainment from surveys (census ACS).

## Endpoints
| Endpoint | Returns | Parameters |
|---|---|---|
| `digest_table` | one Digest table: without `header_lines`, every line numbered (`row`, `col1`...); with it, named columns | `edition` (two digits, e.g. `25`), `table` (e.g. `203.10`), `header_lines` (usually `3-4`), `header_row`, `sheet` |
| `ipeds` | an IPEDS complete data file (the revised `_rv` CSV when the zip has one) | `file` (e.g. `HD2023`, `EFFY2023`, `C2023_A`), `unitid`, `state` (filters), `member` |
| `ipeds_dictionary` | that file's dictionary sheet | `file`, `sheet` (`Varlist` default, `Frequencies` for code labels, `Description`) |

## Spec examples
```json
{"description": "Public school enrollment by grade, fall 1980-2024 (Digest 2025 table 203.10)",
 "requests": [{"name": "t203_10", "endpoint": "digest_table", "params": {"edition": "25", "table": "203.10", "header_lines": "3-4"}}]}
```
```json
{"description": "Colleges in Vermont (IPEDS directory 2023-24) and the code labels",
 "requests": [{"name": "vt_colleges", "endpoint": "ipeds", "params": {"file": "HD2023", "state": "VT"}},
              {"name": "hd_codes", "endpoint": "ipeds_dictionary", "params": {"file": "HD2023", "sheet": "Frequencies"}}]}
```

## Data format and traps
- Digest tables:
  - Line 1 is the title, line 2 the units ("[In thousands]": multiply), lines 3-4 the stacked header, and the
    first data line is the row of column numbers ("1", "2", ...): drop it. Notes and the source follow the last
    data line. Verified on table 203.10, Digest 2025; other tables differ, so read the raw lines first.
  - Columns named `<header>_colN` hold footnote marks for the value to their left, or nothing. In table
    203.10's 2024 row, `\3,4\` points to footnotes 3 and 4 below the table. Keep the marks with the value they
    qualify.
  - Values are text with thousands separators. Footnote marks also sit inside header cells (`Ungraded\1\`), and
    some cells start with a line break ("\n1993"): trim them. Symbols such as `†` and `—`, used in many
    tables, are defined in each table's notes; keep them and never treat them as 0. Projections are marked in
    the notes.
  - Each edition renumbers or drops tables, and a table that is not in that edition answers 404. Use the
    current edition's table list (https://nces.ed.gov/programs/digest/current_tables.asp) to find the number.
- IPEDS:
  - Names. Files are named by collection year: HD2023 is the 2023-24 directory, EFFY2023 the 12-month enrollment
    of 2022-23, C2023_A the completions of July 2022-June 2023. Read the dictionary's Introduction sheet to be
    sure.
  - Revisions. When a zip has a revised file (`_rv`, the final release), it is read instead of the provisional
    one; `member` picks the other.
  - Codes. Columns are coded (`SECTOR`, `CONTROL`, `ICLEVEL`; `X`-prefixed imputation flags): label them from
    the dictionary's Frequencies sheet. Negative codes such as -1 and -2 mean not reported or not applicable;
    never sum them.
  - Joining files. UNITID joins files; a parent/child system (`F1SYSTYP` ...) can report for several campuses.
  - Size. Completions files are large (C2023_A has two 60 MB CSVs): filter by `unitid` or `state`. `state`
    works only on files with `STABBR`, so join HD for state.
  - Counting. Enrollment and completions rows are by category (all students, by race, by sex, by CIP and award
    level), and totals are rows of their own (CIPCODE 99, MAJORNUM 1): pick the total row; never sum across
    categories.

## Access
No key. `fetch` reads nces.ed.gov directly (verified 2026-11-07). Manual: the Digest table's Excel link, or the
IPEDS Complete Data Files page (https://nces.ed.gov/ipeds/datacenter/DataFiles.aspx); upload the file as saved;
then `ingest`.

## Citation and terms
"U.S. Department of Education, National Center for Education Statistics, Digest of Education Statistics 2025,
table 203.10" or "... Integrated Postsecondary Education Data System (IPEDS), <file> (<release>), nces.ed.gov,
retrieved <date>." Public domain (17 U.S.C. 105).
