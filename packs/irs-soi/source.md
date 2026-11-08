# IRS Statistics of Income: tax statistics by geography, national tables, business, estate and nonprofits (irs.gov)
Depth: standard. Key: none. Counts and amounts from tax returns: individual returns (Forms 1040) by ZIP code,
county and state and by AGI size class, taxpayer migration between states and counties, and the SOI published
tables (national individual tables and tax shares by percentile, corporations, partnerships, sole
proprietorships, the IRS Data Book, historical tables, estate and gift tax, personal wealth, exempt organizations,
international), plus the Exempt Organizations Business Master File and the Form 990 extracts.

## When to use
- Number of returns, adjusted gross income (AGI), wages, dividends, capital gains, business income, deductions
  (itemized, SALT, mortgage interest), credits (EITC, child tax credit) and tax liability for a ZIP code, county
  or state; average AGI per return; the income mix of a place; returns with AGI of $200,000 or more (ZIP,
  county) or $1 million or more (state).
- Households (returns), people and AGI moving into or out of a state or county between two filing years.
- Budget and economic estimates from published tax data (`table`): national income and tax by size of AGI, income
  taxed at each rate (static revenue effect of a rate change), average tax rates and tax shares of the top 1%,
  0.1% ..., the corporate tax base (net income, income subject to tax, tax after credits by industry or asset
  size), pass-through business income (partnerships, S corporations, sole proprietorships), IRS gross collections
  and refunds by type of tax and by state, estate and gift tax by size of estate and by state, wealth of top
  wealth holders, the nonprofit sector (Form 990 totals, private foundations), controlled foreign corporations,
  foreign tax credits and country-by-country reports. Recipes: `docs/estimate_patterns.md`.
- One nonprofit or the nonprofits of a state (`eo_bmf`: registry; `eo_extract`: Form 990 financial data).
- Not here: person- or household-level income, poverty and median household income (census: ACS); personal
  income, GDP and corporate profits in the national accounts (bea); federal receipts by month and the budget
  totals (treasury, omb); projections (CBO, not covered); tax-return microdata: the Individual Public-Use
  Microdata File is not public (it was sold under license; tax years 2012-2015 are no longer available, and SOI
  has announced a synthetic file instead), so no row-level data; Form 990 e-file XML (100-500 MB zips of single
  returns); tax gap estimates (PDF only); the Corporation Source Book (frozen at 2013).

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

## Published tables (`table`, `table_list`)
SOI publishes its national statistics as .xls/.xlsx workbooks, one per table and year. `packs/irs-soi/tables.json`
catalogs 125 of them (checked 2026-11-08); `table_list` lists them (`product`, `query`; `live: true` adds the
years posted now). File names change over the years (the Data Book renumbered its tables in 2006, `97in11.xls`,
`ccr`/`nr`/`tabl` suffixes), so the adapter reads the table's index page and takes the year's link from it; a link
the page gets wrong is corrected in the catalog (`overrides`: partnership Tables 5 and 7 for 2023).

| Product (ids) | Tables | Years | Year |
|---|---|---|---|
| Individual, Publication 1304 (`in_1.1` ... `in_3.6`) | 1.1 income and tax by size of AGI, 1.2 by marital status, 1.4 sources of income, 1.4A capital gains, 1.6 age, 1.7 dependents, 2.1 itemized deductions, 2.5 EITC, 2.7 ACA, 3.1-3.6 tax computation, tax by rate (3.5: income taxed at each rate) | TY1996-2023 | tax year |
| Individual, percentiles (`shares_4.1`, `shares_4.2`, `shares_4.3`) | returns, AGI floor, AGI, income tax, average tax rate and shares, top 0.001% ... top 50% and bottom 50% | 2001-2023 in one file | edition |
| Corporations, Publication 16 (`corp_1` ... `corp_14`) | 1 minor industry, 2.1-2.4A size of total assets (2.3 C corporations, 2.4 S corporations), 3.x size of receipts, 4 size of tax, 5.x minor industry, 6-9 S corporations, 10 foreign (1120-F), 11 tax and credits, 12-14 COGS, depreciation, research credit; `corp_1-CV` coefficients of variation | TY2014-2023 (Table 1 from 1994) | tax year |
| Partnerships (`partnership_1` ... `_7`, `_10`, `_23`) | by industrial group: income and deductions, balance sheets, rental real estate, income allocated to partners, LLCs, receipts, foreign transactions | TY1993-2023 | tax year |
| Sole proprietorships (`soleprop_1` ... `_4`) | by industrial sector: receipts, deductions, payroll, net income; income statements; size of receipts; returns with Schedule C | TY1996-2023 | tax year |
| Integrated business data (`business_1`, `business_3`) | returns, receipts and net income by form of business, 1980-2015; by NAICS sector | to 2015 | edition / tax year |
| IRS Data Book (`databook_1-1` ... `_1-8`, `_3-1`, `_6-1`, `_6-2`) | collections and refunds by type of tax, returns filed, by state; gross collections by type of tax 1960 onward (1-6); audit coverage; costs; cost of collecting $100 | FY1995-2025 | fiscal year |
| Historical tables (`historical_1` ... `_24`) | individual series since 1913/1950, corporations since 1909, NIPA vs SOI income (8, 15), excise taxes by type FY1999 onward (20), returns filed (21), corporate rates 1909-2010 (24) | one file each | edition |
| Estate, gift, wealth (`estate_1` ... `_5`, `gift_1`, `wealth_1` ... `_6`) | estate returns by size of gross estate and tax status, by state, charitable bequests, beneficiaries, occupation; gift returns; top wealth holders | FY2001-2024; gift 2003-2021; wealth 2001-2019 | filing year |
| Exempt organizations (`eo_1` ... `_4`, `eo_excise`, `pf_1` ... `_4`) | Form 990 501(c)(3) by asset size, by Code section, 990-EZ, Form 4720 excise; private foundations | 1985-2024 | tax year |
| International (`cfc_1` ... `_3`, `ftc_1` ... `_3`, `cbc_1A` ... `cbc_4`) | controlled foreign corporations, corporate foreign tax credit, country-by-country reports | to 2021/2023 | tax year |

Parameters: `table` (an id, or a product word and number: "corporation 2.1", "data book 1-6"); `year` (or
`tax_year`, `fiscal_year`, `filing_year`; `start_year`/`end_year`, one workbook each); default the latest posted.
A whole-series table (`shares_4.x`, `databook_1-6`, `historical_*`, `business_1`) holds every year in one file:
the latest edition is read and the years are rows or columns (filter them with `rows`, `section` or `columns`).
`rows` keeps rows by label (an exact label, else the labels containing the text), `section` by section label,
`columns` by published column number or header text; `layout: "wide"` gives one row per line; `sheet` picks a
sheet of a multi-sheet workbook; `header_lines` overrides the header reading (rarely needed: see the notes).

How a workbook is read (no settings per table): title and headnote lines; the header lines down to the row of
column numbers (`1`, `(1)`, or `-1` shown as `(1)`); label-only lines become `SECTION` (a label running over two
lines is joined); the row level comes from the cell indent (or leading spaces) and gives `LEVEL` and `PARENT`;
footnote lines after the last data line go to the notes. A sheet printed as pages (1998 tables: columns 1-20 on
page 1, 21-40 on page 2) is read block by block; side-by-side panels (older partnership and sole proprietorship
tables) take each cell's label from the nearest label column to its left. A table without column numbers
(Publication 16 Table 2.1 for 2014, some historical tables) is read with the header down to the first line with
a label and a number, and says so in the notes, with `COL` empty.

Output (long, the default): `TABLE, YEAR, YEAR_TYPE, SHEET, SECTION, LINE, LEVEL, PARENT, ROW_LABEL, COL, COLUMN,
VALUE, FLAG, UNITS`. `COLUMN` joins the header lines with " | " ("All returns | Adjusted gross income less deficit
| Amount"); `COL` is the published column number, stable within a year (not across years: check `COLUMN`).
`VALUE` is the number as published (no thousands separators); `FLAG` holds the cell's markers: `*` estimate based
on few sample returns (high sampling variability; in newer workbooks the `*` is only in the number format and is
read from it), `**` data combined or suppressed, `d`/`[d]` deleted to avoid disclosure (included in totals), `[n]`
a footnote (e.g. `[2]` less than 0.05 percent), `n.a.` not available, `--`/`-` zero or not applicable as the
table's footnotes say. `UNITS` is the money unit of the headnote (usually thousands of dollars; gift tables whole
dollars; historical tables millions or billions); count, percent and average columns are as their header says.

## Exempt organizations (`eo_bmf`, `eo_extract`)
- `eo_bmf`: `https://www.irs.gov/pub/irs-soi/eo_{st}.csv` (one per state, PR, XX = international; updated monthly,
  1,975,975 organizations on 2026-10-13), 28 columns. Filters: `ntee` (prefix), `subsection` (`03` = 501(c)(3)),
  `ein`, `name`, `columns`. EIN and ZIP stay text. ASSET_AMT, INCOME_AMT, REVENUE_AMT are whole dollars from the
  latest return on file (TAX_PERIOD differs by organization). Codes: https://www.irs.gov/pub/foia/ig/tege/eo-info.pdf.
- `eo_extract`: the SOI annual extract of Form 990 (`form: 990`), 990-EZ (`990ez`) or 990-PF (`990pf`) data,
  `{yy}eoextract990.zip` etc. (2018-2024; `{yy}eofinextract...` 2012-2017), listed on
  soi-tax-stats-annual-extract-of-tax-exempt-organization-financial-data. The 2024 Form 990 zip is 57 MB holding a
  247 MB CSV of 246 columns; it is read as a stream keeping only `ein` or the organizations of `state` (their EINs
  from the current EO BMF, so an organization that moved or lost exemption is missed). The 990-PF CSV drops EIN
  leading zeros: they are restored. Field definitions: `{yy}eofinextractdoc.xlsx`. Years whose zip holds a
  fixed-width `.dat` file (some of 2012-2017) are refused.

## Spec examples
```json
{"description": "Static revenue effect of one more point on the 37 percent rate, TY2023",
 "requests": [{"name": "rate37", "endpoint": "table",
               "params": {"table": "in_3.5", "year": 2023, "rows": ["Total"], "columns": ["37 percent"]}}]}
```
```json
{"description": "Tax shares and average tax rates of the top 1 percent, 2001-2023",
 "requests": [{"name": "top1", "endpoint": "table",
               "params": {"table": "shares_4.1", "columns": ["Top 1 percent"],
                          "section": ["Total income tax share", "Average tax rate", "Adjusted gross income share"]}}]}
```
```json
{"description": "Corporate tax base by asset size and IRS collections by type of tax",
 "requests": [{"name": "corp", "endpoint": "table", "params": {"table": "corp_2.1", "year": 2023,
               "rows": ["Net income (less deficit)", "Income subject to tax", "Total income tax after credits"]}},
              {"name": "coll", "endpoint": "table", "params": {"table": "databook_1-6", "rows": ["2021", "2022", "2023", "2024", "2025"]}}]}
```
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
- Output `data/irs-soi/<name>.csv` in the workspace. Column names are upper-cased (the files mix `agi_stub`/`AGI_STUB`,
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
No key. `fetch` downloads when www.irs.gov answers: one GET per file; `zip_agi` streams the file (about 216 MB) to a
temporary folder outside the workspace, filters it and deletes it, so it needs disk space and about a minute.
Manual route (`manual_bundle`): INSTRUCTIONS.md lists the direct link of each file (the all-states CSV under its published name,
e.g. `22incyallagi.csv`); download it from the index page (ZIP: soi-tax-stats-individual-income-tax-statistics-zip-code-data-soi,
county: soi-tax-stats-county-data, state: soi-tax-stats-historic-table-2, migration: soi-tax-stats-migration-data,
all under https://www.irs.gov/statistics/), upload it unchanged, and `ingest` filters it like `fetch` does.
Per-state Excel files and years before the CSV files are manual and not read here.
`table`: one GET of the table's index page per run, then one GET per workbook (20-300 KB). Manual route: the index
page and the file pattern; upload the workbook under its published name (`23in11si.xls`), and `ingest` reads it
like `fetch` (the year from the name). `eo_bmf`: one GET per state file (up to about 25 MB for California);
`eo_extract`: one GET of the extract page, the state's EO BMF file, and the zip (10-57 MB, held in memory and
read as a stream). Manual: upload the zip under its published name (and `eo_<state>.csv` with `state`).

Traps for estimates from the published tables (see `docs/estimate_patterns.md`):
- Estimates from samples: totals are reliable; cells marked `*` are not; Publication 16 Table 1 has its
  coefficients of variation in `corp_1-CV`.
- Tax year, filing year, fiscal year: Publication 1304 and Publication 16 are tax years; the Data Book is IRS
  fiscal years (October-September) of collections; estate tables are filing years (returns filed in the year, of
  decedents of earlier years). Do not mix them without saying so.
- Lag: the latest tax year is 2-3 years back (TY2023 posted in 2025-2026).
- Definitions change: AGI classes, the "total income tax" item, and table numbers change between years; compare
  `COLUMN` text, not only `COL`, across years.
- Business tables count returns, not firms; the corporate tables include S corporations, REITs and RICs unless the
  table is "other than Forms 1120S, 1120-REIT and 1120-RIC" (`corp_2.3`, `corp_3.3`, `corp_5.3`).

## Citation and terms
"Internal Revenue Service, Statistics of Income Division, <product, e.g. County Data, Tax Year 2022, or
Publication 1304 Table 1.1, Tax Year 2023>, irs.gov/statistics, retrieved <date>." The EO BMF: "Internal Revenue
Service, Exempt Organizations Business Master File Extract, <month year>". Public domain (U.S. government work); redistribution allowed.
