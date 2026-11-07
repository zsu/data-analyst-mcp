# FHWA Highway Statistics: travel, drivers, vehicles, roads, motor fuel and highway finance by state
Depth: standard. Key: none. The tables of FHWA's annual Highway Statistics series, as the Excel files FHWA
publishes, read line by line or with a named stacked header. Examples: VM-2 (vehicle-miles of travel by state
and functional system), DL-22 (licensed drivers by age and sex), MV-1 (registered vehicles), HM-20 (public road
length), MF-1 (state motor-fuel tax receipts), FE-9 (Highway Trust Fund receipts attributable to each state).

## When to use
- Driving and roads by state: vehicle-miles traveled, per capita (with census population), licensed drivers,
  registered vehicles, road miles, fuel tax receipts, Highway Trust Fund flows.
- Not here: national monthly travel and transportation indicators (bts); fuel prices and consumption totals
  (eia); traffic deaths and recalls (nhtsa); federal highway grants by recipient (usaspending).

## Endpoints
| Endpoint | Returns | Parameters |
|---|---|---|
| `table` | one Highway Statistics table: without `header_lines`, every line numbered (`row`, `col1`...); with it, named columns | `year` (edition, e.g. `2023`), `table` (`vm2`, `dl22`, `mv1`, `hm20`, `mf1`, `fe9` ...), `sheet`, `header_lines`, `header_row`, `carry` |

The table list is at https://www.fhwa.dot.gov/policyinformation/statistics/2023/ (each table page has an XLSX
link). Verified 2026-11-07: vm2 (2023, 2024), dl22, mv1, hm20, mf1, fe9 (2023). `mf2` is not a 2023 file.

## Spec examples
```json
{"description": "Vehicle-miles traveled by state, 2023 (VM-2)",
 "requests": [{"name": "vm2_2023", "endpoint": "table", "params": {"year": "2023", "table": "vm2", "header_lines": "5-8"}}]}
```
```json
{"description": "Licensed drivers by age, 2023 (DL-22, all drivers): first look at the lines",
 "requests": [{"name": "dl22_total", "endpoint": "table", "params": {"year": "2023", "table": "dl22", "sheet": "TOTAL"}}]}
```

## Data format and traps
- Read the raw lines first. Each table has its own layout:
  - VM-2 and HM-20: title lines, the date line, then a four-line header (lines 5-8).
  - MV-1 and MF-1: the header starts on line 4 or 5.
  - DL-22: one sheet per sex (MALES, FEMALES, TOTAL).
  - FE-9: two pages.
  Some workbooks have a hidden CRYSTAL_PERSIST sheet first; it is left out of the sheet numbering.
- Stacked headers: only the top header line spans right by default (`carry: "top"`), because FHWA centers labels
  over columns without merging them. In VM-2 2023:
  - the RURAL and URBAN spans come out right;
  - column 18, the grand TOTAL of rural and urban, is named `URBAN | TOTAL_col18`; rename it;
  - the columns after it (`URBAN | State Cd`, `URBAN | RINT` ...) are a hidden copy with database codes; drop
    them.
  Always compare names with the numbered lines.
- Units are in each table's title or date line: VM-2 is in millions of vehicle-miles, MF-1 in thousands of dollars.
  Values are stored numbers as text, often with float noise (`5798.6313300000002`): round to the published
  precision.
- Rows include state rows, a Total row, and footnote or blank rows below; Puerto Rico and DC appear in some tables.
  Keep state rows by name before ranking. Footnotes are on a separate `footnotes` sheet or below the table.
- Editions: "Highway Statistics 2023" holds mostly 2023 data; tables are revised in later editions and some are
  published later than others. State the edition and table.

## Access
No key. `fetch` reads https://www.fhwa.dot.gov/policyinformation/statistics/<year>/xls/<table>.xlsx (verified
2026-11-07). Manual: open the table page and click XLSX, then `ingest`.

## Citation and terms
"U.S. Department of Transportation, Federal Highway Administration, Highway Statistics 2023, Table VM-2,
retrieved <date>." Public domain (17 U.S.C. 105).
