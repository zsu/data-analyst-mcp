# FHFA House Price Index, conforming loan limits and Public Use Databases (fhfa.gov files)
Depth: standard. Key: none. The Federal Housing Finance Agency's House Price Index (U.S., divisions, states,
metros, counties, ZIP3), the conforming loan limits for Fannie Mae and Freddie Mac by county, and the FHLBank
loan-level Public Use Database, read from FHFA's published files.

## When to use
- House price levels and growth (monthly U.S. and census divisions; quarterly states and metros; annual counties
  and three-digit ZIP codes), as an input to housing, property-tax or mortgage questions; the conforming loan
  limit for a county and year (baseline and high-cost); loan-level FHLBank mortgage acquisitions.
- Not here: Case-Shiller or Zillow indexes (not federal); FRED also carries many FHFA HPI series (USSTHPI
  all-transactions U.S., HPIPONM226S purchase-only U.S. SA monthly, <ST>STHPI by state) and is simpler for one
  series: use fred when the question needs only those. Mortgage originations and denials by lender
  (HMDA: not covered; the cfpb pack holds complaints only); FHA loan limits (not covered; the hud pack has Fair
  Market Rents and income limits only).

## Endpoints and datasets
Base `https://www.fhfa.gov`, keyless files, stable names overwritten in place at each release (verified live
2026-10-30). The pack downloads the whole file and keeps the rows that match the filters; `max_rows` counts
rows after filtering. Filters match without case or surrounding spaces; a list matches any of its values.

| Endpoint | File, size | Filters | Columns, units, coverage |
|---|---|---|---|
| `hpi_master` | `/hpi/download/monthly/hpi_master.csv`, 17 MB, 186,000 rows | `hpi_type`, `hpi_flavor`, `frequency`, `level`, `place_id`, `place_name`, `where`, `min_year`, `max_year` | `hpi_type, hpi_flavor, frequency, level, place_name, place_id, yr, period, index_nsa, index_sa, rstderr, note`; `period` is the month (monthly) or quarter; index points |
| `hpi_state` | `/hpi/download/quarterly_datasets/hpi_at_state.csv`, 188 KB | `state`, `where`, `min_year`, `max_year` | `state, yr, qtr, index_nsa` (the file has no header row; the pack names the columns): all-transactions, NSA, 1975Q1 on, 1980Q1 = 100 |
| `hpi_annual` | `/hpi/download/annual/hpi_at_{geography}.xlsx`, `geography` = `national`, `state`, `cbsa`, `county`, `zip3` (0.02-5.3 MB) | `where` on the file's columns, `min_year`, `max_year` | annual all-transactions, developmental: `Year`, `Annual Change (%)`, `HPI` (first year = 100), `HPI with 1990 base`, `HPI with 2000 base`; geography columns `State, Abbreviation, FIPS` (state), `State, County, FIPS code` (county), `CBSA, Name` (cbsa), `Three-Digit ZIP Code` (zip3); through the last full year (2025 on 2026-10-30) |
| `loan_limits` | `/document/d/cll/fullcountyloanlimitlist{year}_hera-based_final_flat.csv`, 280 KB, about 3,235 counties | `year` (2024 on, required), `state`, `where` | `fips_state_code, fips_county_code, county_name, state, cbsa_number, one_unit_limit, two_unit_limit, three_unit_limit, four_unit_limit` in dollars (renamed and cleaned so all years match) |
| `fhlb_pudb` | `/document/d/pud/{year}-pudb.csv`, `year` 2023-2025, 12 MB | `where` (e.g. `{"FIPSStateNumericCode": "50"}`) | one row per FHLBank single-family loan; codes in FHFA's PUDB definitions PDF on https://www.fhfa.gov/data/pudb |

`hpi_master` contents (rows by `hpi_type`/`hpi_flavor`/`frequency`/`level`): purchase-only monthly for the U.S.
(`place_id` USA) and the nine census divisions (`DV_ENC`, `DV_ESC`, `DV_MA`, `DV_MT`, `DV_NE`, `DV_PAC`, `DV_SA`,
`DV_WNC`, `DV_WSC`) from 1991-01; quarterly purchase-only, all-transactions (from 1975) and expanded-data for the
U.S., divisions and states; `MSA` rows: all-transactions and expanded-data for 410 metros and metro divisions
(`place_id` = CBSA code), purchase-only for the 100 largest; distress-free (14 metros), non-metro (state),
manufactured-home (U.S. and divisions) and developmental Puerto Rico indexes. Catalog aliases (`--search`) point
to these endpoints. Not wrapped: the ZIP5 (40 MB .xlsx) and census tract (90 MB .csv) annual files, the
quarterly expanded-data and purchase-only .xlsx variants (the same series are in `hpi_master`), and the release
summary workbooks (`hpi_po_monthly_sa.xlsx`, a formatted table of percent changes, not a data table).

## Spec examples
```json
{"description": "Latest FHFA purchase-only HPI for the U.S., monthly, seasonally adjusted",
 "requests": [{"name": "us_po_monthly", "endpoint": "hpi_master",
   "params": {"hpi_type": "traditional", "hpi_flavor": "purchase-only", "frequency": "monthly", "place_id": "USA"}}]}
```
```json
{"description": "Vermont: quarterly purchase-only index since 2024, all-transactions since 2025, annual county indexes",
 "requests": [
  {"name": "vt_po", "endpoint": "hpi_master", "params": {"hpi_flavor": "purchase-only", "level": "State", "place_id": "VT", "min_year": 2024}},
  {"name": "vt_at", "endpoint": "hpi_state", "params": {"state": "VT", "min_year": 2025}},
  {"name": "vt_counties", "endpoint": "hpi_annual", "params": {"geography": "county", "where": {"State": "VT"}, "min_year": 2015}}]}
```
```json
{"description": "2026 conforming loan limits, California counties",
 "requests": [{"name": "ca_2026", "endpoint": "loan_limits", "params": {"year": 2026, "state": "CA"}}]}
```
Put several geographies in one request (`"place_id": ["USA", "DV_PAC"]`) rather than one request each: every
`hpi_master` request downloads the 17 MB file again.

## Data format and traps
- Three flavors: purchase-only (sales prices of Fannie Mae and Freddie Mac mortgages; the flagship, from 1991),
  all-transactions (adds refinance appraisals; from 1975; quarterly only) and
  expanded-data (purchase-only plus county recorder and FHA data; quarterly). They differ in level and growth:
  name the flavor in every answer and never splice them.
- NSA vs SA: `index_sa` exists only for purchase-only and expanded-data; all-transactions is NSA only (empty
  `index_sa`). FHFA's monthly release reports SA month-over-month changes; its year-over-year change matches SA
  (Aug 2026: SA 444.61 / 434.04 = +2.4 %, the release's figure; NSA 450.45 / 439.64 gives +2.5 %).
- Index levels are relative to a base period that differs by series (purchase-only 1991-01 or 1991Q1 = 100,
  all-transactions 1980Q1 = 100, annual files three bases); compare growth rates, never levels across series or
  geographies (a state at 600 is not "more expensive" than one at 400).
- Revisions: every release re-estimates the whole history (the July 2026 monthly change was revised from 0.3 % to
  0.2 % in the October 27, 2026 release). The files are overwritten in place, so a refetch can change past values;
  cite the retrieval date.
- Latest periods (2026-10-30): monthly through 2026-08, quarterly through 2026Q2, annual through 2025.
  `rstderr` (revision standard error) and `note` are mostly empty; purchase-only state rows flag small samples in
  the xlsx files, not in `hpi_master`.
- The annual county, CBSA, ZIP3 and state files are labeled developmental by FHFA; a "." in the file (written as
  an empty cell) means too few sales. Their `HPI` column is 100 in each area's own first year, so use `HPI with
  2000 base` or `Annual Change (%)` to compare areas. The .xlsx stores numbers as binary floats; the pack writes
  them in shortest form (69.15, not 69.150000000000006), the same value.
- Conforming loan limits are set per calendar year by county and number of units (1-4). The 2026 baseline
  one-unit limit is $832,750 (3,075 of 3,235 counties; 2025: $806,500); high-cost areas (HERA: 115 % of the local
  median home value) go up to a ceiling of 150 % of the baseline, $1,249,125 in 2026. Alaska, Hawaii, Guam and the
  U.S. Virgin Islands have a higher baseline ($1,249,125) and can exceed the ceiling (Maui and Kalawao, HI:
  $1,299,500). The next year's file appears when FHFA announces the limits in late November; a year not yet
  published answers 404. Files before 2024 are .xlsx (2022-2023) or older formats: manual download.
- The 2025 and 2026 loan-limit files differ in layout (2026: "One-Unit\nLimit" headers, "$832,750 " values,
  "01"/"001" FIPS; 2025: "One_Unit_Limit", 806500, "1"/"1"); the pack renames columns to snake_case, writes
  plain dollars and zero-pads FIPS, and says so in a fetch note. `cbsa_number` 99999 means not in a CBSA.
- `fhlb_pudb` is FHLBank loan-level data (not Fannie Mae and Freddie Mac): many columns hold codes, and
  placeholder values (e.g. 9999, 9999-12-31) appear where a field does not apply; read the definitions PDF
  before summarizing any column. The Enterprise
  (Fannie Mae, Freddie Mac) PUDB is in zips of 13-136 MB per year on https://www.fhfa.gov/data/pudb: not
  wrapped (manual download, then analysis on the uploaded file).
- FHFA can answer HTTP 200 with a web page when a file moves; the pack refuses such a reply rather than reading it.

## Access
No key, no API: files on www.fhfa.gov, which answers scripts (verified 2026-10-30). Limit used: one request per
second. Route `api` downloads the file; `manual`: open the link in `manual_download/INSTRUCTIONS.md`, save the
file under the name shown and upload it (the pack applies the same filters to the upload). Index pages:
https://www.fhfa.gov/data/hpi/datasets (every HPI file), https://www.fhfa.gov/data/conforming-loan-limit (loan
limits by year, with FAQs and the announcement), https://www.fhfa.gov/data/pudb (Public Use Databases and their
definitions).

## Citation and terms
Federal Housing Finance Agency, <dataset> (e.g. "FHFA House Price Index, purchase-only, seasonally adjusted"),
www.fhfa.gov, retrieved <date>. U.S. government work in the public domain (17 U.S.C. 105): redistribution
allowed; cite FHFA as the source and name the index flavor and adjustment.
