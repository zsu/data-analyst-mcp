# IRS Statistics of Income: individual income tax data by geography (irs.gov)
Depth: standard. Key: none. Counts and amounts from all individual income tax returns (Forms 1040), by ZIP code,
county and state and by AGI size class, plus taxpayer migration between states and counties.

## When to use
- Number of returns, adjusted gross income (AGI), wages, dividends, capital gains, business income, deductions
  (itemized, SALT, mortgage interest), credits (EITC, child tax credit) and tax liability for a ZIP code, county
  or state; average AGI per return; the income mix of a place; returns with AGI of $200,000 or more (ZIP,
  county) or $1 million or more (state).
- Households (returns), people and AGI moving into or out of a state or county between two filing years.
- Not here: person- or household-level income, poverty and median household income (census: ACS); personal
  income and GDP by state or county (bea); national tables such as Publication 1304 / Table 1.1 (SOI publishes
  them as .xls workbooks only: https://www.irs.gov/statistics/soi-tax-stats-individual-statistical-tables-by-size-of-adjusted-gross-income;
  manual); business, corporate, estate and exempt-organization statistics (other SOI pages, not covered);
  tax-return microdata: the Individual Public-Use Microdata File is not public (it was sold under license; tax
  years 2012-2015 are no longer available, and SOI has announced a synthetic file instead), so no row-level data.

## Endpoints and datasets
One all-states CSV per year under `https://www.irs.gov/pub/irs-soi/` (verified 2026-10-30). The adapter
picks the file, downloads it, and keeps only the asked rows (and `columns`) while reading.

| Endpoint (alias) | File | Rows | Years | Size |
|---|---|---|---|---|
| `zip_agi` (`zip`) | `{yy}zpallagi.csv`; `agi_classes: false` = `{yy}zpallnoagi.csv` | state x ZIP x AGI class 1-6 | TY2011-2023 | 216 MB (TY2022) |
| `county_agi` (`county`) | `{yy}incyallagi.csv`; `agi_classes: false` = `{yy}incyallnoagi.csv` | state x county x AGI class 1-8 | TY2011-2023 | 36 MB |
| `state_agi` (`state`) | `{yy}in55cmcsv.csv` (2019-2023), `18in55cmagi.csv`, `{yy}in54cmcsv.csv` (2012, 2014-2017) | state x AGI class 0-10 | TY2012, 2014-2023 | 0.8 MB |
| `migration` (`migration`) | `{state,county}{inflow,outflow}{y1y2}.csv` | focus place x other place | filing years 2011-2012 to 2022-2023 | 0.1 / 4.5 MB |

Parameters: `tax_year` (or `start_year`/`end_year`, one file each), `state` (USPS, FIPS or name, or a list;
`state_agi` also takes `US`, `PR`, `OA`), `zipcode` (5-digit strings), `county` (3-digit code with `state`,
5-digit FIPS, or the published name such as "Montgomery County"), `agi_stub`, `agi_classes`, `columns` (e.g.
`["N1", "A00100"]`; identifier columns always kept). `zip_agi` requires `state` or `zipcode`. Migration:
`level` (state|county), `direction` (inflow|outflow), `y1` (or `start_y1`/`end_y1`) = the first filing year
(2022 = the 2022-2023 file), `state` and `county` = the place whose inflow or outflow is kept.
Latest posted (checked 2026-10-30): TY2023 for ZIP, county and state data; 2022-2023 for migration. A year
not posted yet ends with `not_found` naming the file. Variable lists and layouts: each year's users guide on
the index pages (ZIP `{yy}zpdoc.docx`, county `{yy}incydocguide.docx`, state `{yy}incmdocguide.doc`,
migration `{y1y2}inpublicmigdoc.pdf`).

## Spec examples
```json
{"description": "Maryland counties, tax year 2022: returns and AGI by AGI class",
 "requests": [{"name": "md_county", "endpoint": "county_agi",
               "params": {"tax_year": 2022, "state": "MD", "columns": ["N1", "N2", "A00100", "A00200"]}}]}
```
```json
{"description": "Two ZIP codes, all returns, 2021-2023",
 "requests": [{"name": "zips", "endpoint": "zip_agi",
               "params": {"start_year": 2021, "end_year": 2023, "state": "MD", "zipcode": ["20601", "20852"],
                          "agi_classes": false, "columns": ["N1", "A00100"]}}]}
```
```json
{"description": "Moves into and out of Florida, 2022-2023",
 "requests": [{"name": "fl_in", "endpoint": "migration",
               "params": {"level": "state", "direction": "inflow", "y1": 2022, "state": "FL"}},
              {"name": "fl_out", "endpoint": "migration",
               "params": {"level": "state", "direction": "outflow", "y1": 2022, "state": "FL"}}]}
```

## Data format and traps
- Output `<out>/data/irs-soi/<name>.csv`. Column names are upper-cased (the files mix `agi_stub`/`AGI_STUB`,
  `zipcode`/`ZIPCODE`, `mars1`/`MARS1`, `n1`/`N1`); `TAX_YEAR` (migration: `Y1_YEAR`, `Y2_YEAR`) comes
  first. Numbers are written without thousands separators or trailing zero decimals (the state files print
  `3,095,140`, the county and ZIP files `40530.0000`); nothing else is changed.
- Units: `N...` = number of returns with the item (N1 all returns, N2 individuals); `A...` = amount in
  **thousands of dollars** (A00100 = AGI, A00200 = wages, A59660 = EITC, A10300 = total tax liability, A18425 /
  A18500 = state and local income / real estate taxes). AGI per return = A00100 * 1000 / N1. Returns are
  rounded to the nearest 10 (ZIP, county, state; ZIP and county since at least TY2016).
- Tax year vs filing year: TY2022 files tabulate returns processed in calendar 2023, mostly for tax year 2022,
  with a few late prior-year returns as a proxy for returns filed later. Migration years are filing years:
  2022-2023 compares addresses on returns filed in 2022 (TY2021) and 2023 (TY2022); N2 and AGI come from the
  year-2 return, so AGI is TY2022 income. Not everyone files: these are filers, not the population.
- AGI classes (`AGI_STUB`), checked in the users guides: ZIP 1 = $1 under $25,000, 2 = $25,000-50,000, 3 =
  50,000-75,000, 4 = 75,000-100,000, 5 = 100,000-200,000, 6 = $200,000 or more (same 2011-2023; returns with
  negative AGI are excluded from ZIP data). County 2012-2023: 1 = under $1 (zero or negative AGI, so A00100
  can be negative), 2 = $1-10,000, 3 = 10,000-25,000, 4 = 25,000-50,000, 5 = 50,000-75,000, 6 = 75,000-100,000,
  7 = 100,000-200,000, 8 = $200,000 or more; county TY2011 had 7 classes (2 = $1 under $25,000). State:
  0 = all returns, 1-7 as county, 8 = 200,000-500,000, 9 = 500,000-1,000,000, 10 = $1,000,000 or more. The
  no-class files have AGI_STUB 0.
- Totals inside the files: ZIP `00000` = the state total and `99999` = ZIPs with fewer than 100 returns or a
  single building/nonresidential ZIP combined; county `COUNTYFIPS 000` = the state total. Drop them before
  summing places. State totals here differ from the state file (`state_agi`, the complete tabulation):
  ZIP/county data drop returns without a ZIP or with a ZIP that does not match the state, and APO/FPO,
  foreign and territory addresses (TY2022 Maryland N1: 3,054,110 in ZIP data vs 3,095,140 in state data).
- Disclosure: items with fewer than 20 returns in an AGI class are merged into another class of the same ZIP or
  county (marked `**` in the Excel files only; the CSV gives no flag), items with fewer than 20 returns in the
  place are dropped, and a return dominating a cell is removed from it. The CSV files have no empty cells
  (checked in 22zpallagi.csv): a dropped item shows as 0, so a 0 in a small place or class can mean
  "suppressed" as well as "none"; small places and classes are approximate.
- State file: 50 states, DC, `OA` (other areas: APO/FPO, citizens abroad) and `US` (total); `PR` (Puerto
  Rico) from TY2018 (checked in the 2012-2023 files).
- Geography: STATEFIPS and COUNTYFIPS are text with leading zeros (keep them as strings; county FIPS =
  STATEFIPS + COUNTYFIPS). COUNTYNAME is cut to 20 characters ("Prince George's Coun" in TY2022): filter and
  join on FIPS, not names (a `county` name still matches a cut name it begins with). The address is the mailing address on the return and is assigned to a county from
  its ZIP code; ZIP codes are USPS codes, not Census ZCTAs.
- Variables change by year (e.g. TY2023 added N07262/N07265 and dropped N07260); a `columns` item missing in a
  year gives a note. Check the year's users guide before comparing an item across years.
- Migration rows (`ROW_TYPE`, added by the adapter): `total_us_and_foreign` (code 96), `total_us` (97),
  `total_same_state` (97; county 97/001), `total_different_state` (county 97/003), `total_foreign` (98),
  `non_migrants` (same place both years), `foreign` (57: overseas, Puerto Rico, APO/FPO, Virgin Islands),
  `other_flows` (58/59: county flows under 20 returns pooled as same state, different state, or by region),
  `flow` (one origin-destination pair), `state_summary` (state header rows in 2011-2017 county files). Sum
  only `flow` rows, or use the totals; never sum all rows. Net migration = inflow minus outflow from the two
  files for the same place and years.
- Migration suppression: cells below 10 returns (state) or 20 (county) are published as `-1`; the adapter
  writes them empty and names them in `SUPPRESSED`. Since 2018-2019 county files have no state totals (use the
  state files) and county flows need not add to state totals. The 2022-2023 file uses an updated return
  matching that includes about 5 percent more returns than the prior method, and 2011-2012 started a new series
  (primary, secondary and dependent TINs matched): mark the break when comparing across these years.
- Migration covers matched filers only: a filer who did not file in both years, or switched between an ITIN and
  an SSN, is not counted; dependents in year 2 are excluded.

## Access
No key. Route `api` when www.irs.gov answers: one GET per file; `zip_agi` streams the file (about 216 MB) to a
temporary folder outside the skill, filters it and deletes it, so it needs disk space and about a minute.
Manual route: INSTRUCTIONS.md lists the direct link of each file (the all-states CSV under its published name,
e.g. `22incyallagi.csv`); download it from the index page (ZIP: soi-tax-stats-individual-income-tax-statistics-zip-code-data-soi,
county: soi-tax-stats-county-data, state: soi-tax-stats-historic-table-2, migration: soi-tax-stats-migration-data,
all under https://www.irs.gov/statistics/), upload it unchanged, and `--ingest` filters it like the API route.
Per-state Excel files, years before the CSV files, and the national .xls tables are manual and not read here.

## Citation and terms
"Internal Revenue Service, Statistics of Income Division, <product, e.g. County Data, Tax Year 2022>,
irs.gov/statistics, retrieved <date>." Public domain (U.S. government work); redistribution allowed.
