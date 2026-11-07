# U.S. Courts caseload statistics: federal court and bankruptcy filings, terminations and pending cases
Depth: standard. Key: none. The Administrative Office of the U.S. Courts' caseload statistics tables, as the
Excel files on uscourts.gov, read line by line or with a named stacked header. They cover bankruptcy filings by
chapter, business vs nonbusiness, and district; district court civil and criminal cases and defendants; courts
of appeals; magistrate judges; jurors; all by circuit and district for 1-, 3- or 12-month periods.

## When to use
- Bankruptcy filings by chapter and district; trends in business or consumer bankruptcies.
- Federal civil cases and criminal defendants filed, terminated and pending; appeals by circuit; how long cases
  take (median times in some tables).
- Not here: crimes and arrests (fbi), victimization and prisoners (bjs), DOJ press releases (doj-news), case
  documents or dockets (not covered), state courts.

## Endpoints
| Endpoint | Returns | Parameters |
|---|---|---|
| `table` | one caseload table: without `header_lines`, every line numbered (`row`, `col1`...); with it, named columns | `file` (the file name without .xlsx), `sheet`, `header_lines`, `header_row`, `carry` |

The file name is on the table's entry in https://www.uscourts.gov/statistics-reports/caseload-statistics-data-tables
("Download xlsx"):
- `bf_` is the Bankruptcy Filings series: `bf_f2_0930.2026` is table F-2 for the 12 months to September 30, 2026;
  `bf_f2.1_` is the one-month table and `bf_f2.3_` the three-month table.
- `stfj_` is the Statistical Tables for the Federal Judiciary: `stfj_b_630.2026` is table B (courts of appeals),
  June 30, 2026.
- The date part is not zero-padded the same way in every series: copy it.

## Spec example
```json
{"description": "Bankruptcy filings by chapter and district, 12 months to September 30, 2026 (table F-2)",
 "requests": [{"name": "f2", "endpoint": "table",
   "params": {"file": "bf_f2_0930.2026", "header_lines": "3-5", "carry": "all"}}]}
```

## Data format and traps
- Read the raw lines first. In F-2, line 2 is the title (with line breaks), lines 3-5 are the header, and the
  rows begin with the national Total.
- Stacked headers: `carry: "all"` gives F-2's names (`Predominant Nature of Debt | Business | Chapter 7`). Check
  the names against the numbered lines for any other table.
- Rows mix levels: `Total`, then each circuit (`     1st`, indented, a subtotal) and its districts (`ME`,
  `MA`, ...; DC stands alone). Keep districts or circuits, never both, when summing. A circuit row's label keeps
  its leading spaces: trim it.
- Some workbooks have a second sheet with more columns (F-2's second sheet: chapters 9, 12 and 15).
- Header cells carry footnote marks (`Total Other Chapters ¹`); the notes are below the table.
- Periods: the file name and title give the period end date and length. Compare like periods (12 months to
  September 30 with the same a year earlier), and say whether the table is 1, 3 or 12 months.
- Counts are cases (bankruptcy petitions, civil cases) or defendants (criminal tables), as the title says.

## Access
No key. `fetch` reads www.uscourts.gov/sites/default/files/document/<file>.xlsx (verified 2026-11-07). The FJC
Integrated Database (case-level records, www.fjc.gov/research/idb) is not covered. Manual: Download xlsx from the
Data Tables page, then `ingest`.

## Citation and terms
"Administrative Office of the U.S. Courts, Table F-2, U.S. Bankruptcy Courts, Business and Nonbusiness Cases
Commenced, by Chapter of the Bankruptcy Code, During the 12-Month Period Ending September 30, 2026, uscourts.gov,
retrieved <date>." Public domain (17 U.S.C. 105).
