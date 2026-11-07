# Treasury International Capital (TIC): foreign holdings of U.S. Treasury and other securities
Depth: standard. Key: none. The TIC system's published text tables on ticdata.treasury.gov. Major Foreign
Holders of Treasury Securities by country, monthly: the latest 13 months (SLT Table 5) and the history from
March 2000 (mfhhis01.txt), in billions. SLT Table 1: foreign holdings, net purchases and valuation changes of
U.S. long-term securities (Treasuries, agency bonds, corporate bonds, equities) by country, monthly from
September 2011, in millions.

## When to use
- Who holds the U.S. debt abroad: holdings of Treasury securities by Japan, China, the UK and others;
  rankings; trends; the foreign-official part (central banks and governments) and its split into bills and
  bonds/notes.
- Foreign holdings of U.S. corporate bonds, agency bonds and stocks by country; net foreign purchases or
  sales by month (long-term securities, Table 1).
- Not here: total debt held by the public and intragovernmental holdings (treasury: Debt to the Penny, MSPD);
  the Fed's holdings and the full who-holds-what balance sheet (fed-board Z.1, table L.210); the balance of
  payments and international investment position (bea); exchange rates (treasury, fred).

## Endpoints
| Endpoint | Returns | Parameters (all filter the published file; none is sent) |
|---|---|---|
| `major_foreign_holders` | slt_table5.txt, long: `country`, `kind`, `period` (YYYY-MM), `holdings_billions`; the latest 13 months | `country` (a name or a list) |
| `major_foreign_holders_history` | mfhhis01.txt, the same columns plus `comparison_only`; March 2000 to the last full year | `country`, `from`, `to` (YYYY-MM), `include_comparison` |
| `holdings_by_country` | slt_table1.txt as published: `country`, `country_code`, `date`, then `for_lt_<type>_<pos|net|valchg>` for total, treas, agcy, corp, eqty | `country` (name or 5-digit code), `from`, `to` |

`kind` is `country`, `all_other`, `grand_total` or `foreign_official` (the rows "Of Which: Foreign
Official", "... Treasury Bills", "... T-Bonds & Notes").

## Spec examples
```json
{"description": "China's and Japan's holdings of Treasury securities, the latest 13 months",
 "requests": [{"name": "mfh", "endpoint": "major_foreign_holders",
   "params": {"country": ["Japan", "China, Mainland", "Grand Total"]}}]}
```
```json
{"description": "China's Treasury holdings since 2010, monthly",
 "requests": [{"name": "china", "endpoint": "major_foreign_holders_history",
   "params": {"country": "China, Mainland", "from": "2010-01"}},
  {"name": "china_recent", "endpoint": "major_foreign_holders", "params": {"country": "China, Mainland"}}]}
```
```json
{"description": "Japan's holdings of U.S. long-term securities by type, 2026",
 "requests": [{"name": "japan_lt", "endpoint": "holdings_by_country", "params": {"country": "Japan", "from": "2026-01"}}]}
```

## Data format and traps
- Units differ: Major Foreign Holders is in billions of dollars, SLT Table 1 in millions. Values are kept as
  published text (one decimal in billions); convert with `Number()` before arithmetic.
- The measures differ. Major Foreign Holders counts all Treasury securities, bills included, at market value.
  Table 1's `for_lt_treas_pos` counts long-term Treasuries only (no bills). The two are not interchangeable.
- Custody bias, as the files note: holdings are attributed to the country where the securities are held in
  custody, not the owner. Belgium, Luxembourg, the Cayman Islands, Ireland and the UK hold securities for
  others; China's holdings held through Belgian custody show up under Belgium. Say "held in custody in" or
  quote Treasury's caveat when ranking countries.
- Names change between files: `Korea, South` (table 5 and most years) vs `Korea` (some years of the history); history rows before about
  2011 include groups such as "Oil Exporters" and "Carib Bnkng Ctrs" (footnote marks like "2/" are removed from
  labels). Check the names in the rows before filtering a long series.
- Revisions: the latest 13 months (table 5) are revised each month and after each annual survey, so the same
  month can differ by a few tenths from the history file (UK, December 2025: 863.2 vs 863.1, files of
  2026-11-07). Use table 5 for the last 13 months and the history for older months, and say so.
- Series breaks: the history repeats June in 2002-2011 (March in 2000). The first value is the new series (based
  on the June benchmark survey), the second the previous series "for comparison only". By default only the first
  is kept; `include_comparison: true` adds the second with `comparison_only` True. Do not compare across a break
  without saying so.
- In those break years the published file puts January in a 14th column, one line above its row label; the
  pack reads it from there (Japan, January 2005: 679.5).
- "n.a." marks a country not shown separately in that month (Luxembourg before June 2002): keep it, and never
  treat it as zero.
- `All Other` and `Grand Total` are rows: drop them (filter `kind = country`) before ranking or summing
  countries. The foreign-official rows are part of the grand total, not more countries.
- Table 1's file ends with a definitions footer; rows without a YYYY-MM `date` are dropped.

## Access
No key. `fetch` reads the three files whole (largest about 1 MB) and filters them locally. Manual: open
https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table5.txt (or mfhhis01.txt,
slt_table1.txt) in a browser, save it, and `ingest` the .txt file. The older `mfh.txt` at the same address stopped
at January 2023: do not use it. Release calendar and notes: https://home.treasury.gov/data/treasury-international-capital-tic-system.

## Citation and terms
"U.S. Department of the Treasury, Treasury International Capital (TIC) System, Major Foreign Holders of Treasury
Securities (or SLT Table 1), ticdata.treasury.gov, retrieved <date>." Public domain (17 U.S.C. 105).
