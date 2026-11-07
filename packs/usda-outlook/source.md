# USDA forecasts and projections (WASDE, ERS farm income forecasts, USDA Agricultural Baseline)
Depth: standard. Key: none. USDA's own outlook numbers: the monthly World Agricultural Supply and Demand
Estimates (WASDE), the Economic Research Service (ERS) farm income and wealth forecasts and statistics, and the
10-year USDA Agricultural Projections (the baseline). Published files only.

## When to use
- What USDA projects for a commodity this marketing year: U.S. and world production, use, exports, ending stocks,
  season-average farm price (WASDE); how a projection moved from month to month; country detail (world tables).
- Net farm income, net cash farm income, cash receipts by commodity, government payments, expenses, farm assets,
  debt and equity, U.S. (1910 on) and by state (from 1924 to 2008 depending on the item; net farm income 1949 on), with
  the current-year forecast; how past forecasts compared with the final estimates (farm_income_archive).
- USDA's 10-year supply, use and price projections and long-term farm income projections (baseline).
- Not here: survey estimates of acreage, yield, production, inventories, prices received and the Census of
  Agriculture (usda-nass, Quick Stats); food composition (usda-fooddata); food and nutrition assistance programs
  (not this pack); futures prices (not a government source). The ERS API (api.ers.usda.gov, needs an api.data.gov
  key) serves the same farm income data and is not used here.

## Endpoints and datasets
No key; all files verified live 2026-10-30. Filters are case-insensitive, exact after collapsing spaces, one
value or a list.

| Endpoint | Returns (one row per) | Key parameters | Units, frequency, coverage |
|---|---|---|---|
| `wasde` | report table x commodity x region x attribute x marketing year (USDA's long CSV, columns as published: WasdeNumber, ReportDate, ReportTitle, Attribute, ReliabilityProjection, Commodity, Region, MarketYear, ProjEstFlag, AnnualQuarterFlag, Value, Unit, ReleaseDate, ReleaseTime, ForecastYear, ForecastMonth) | `report` (YYYY-MM or `latest`) or `start_report`/`end_report` (a range, at most 72); filters `commodity`, `region`, `attribute`, `report_title`, `market_year`, `proj_est` (`proj`/`est`/`none`), `include_reliability` | Unit column per row (Million Bushels, Million Metric Tons, 480 Lb. Bales, $/bu ...); monthly, January 2021 report on (about 5,000 rows a month) |
| `farm_income` | year x state x variable of one ERS release, columns as published plus `release_date` and `estimate_type` (forecast/estimate) | `release` (`latest` or YYYY-MM-DD / YYYY-MM, 2014-08 on); one of `variable`, `key` (artificialKey), `search` is required; `state` (US or two-letter); `year` or `start_year`/`end_year` | `Amount` in `unit_desc` ($1,000 nominal; $1,000 per farm; Percent; Ratio), `ChainType_GDP_Deflator` (latest year = 100); annual, three releases a year |
| `farm_income_summary` | line item of the "U.S. farm sector financial indicators" table of the latest release: `section`, `item`, `unit`, one column per year (forecast year marked `2026F`), percent-change columns | none | billion dollars (or percent: see `unit`; the `Change ...` columns are always percent) |
| `farm_income_archive` | year x release x item: `year`, `release_year`, `release_month`, `release_number`, `item`, `amount` | `item` (`nfi` net farm income, `nci` net cash income, `cr_all` cash receipts), `year` or `start_year`/`end_year` | $1,000 nominal; U.S. only; every release from February 1977, first 15 releases per year |
| `baseline` | default: commodity x attribute x year of `Projections<year>.csv` (`year_type`, `year`, `value`, `unit`, `attribute`, `commodity`, `commodity_type`, `year_of_projection`); or the rows of one .xlsx table in the ZIP | `edition` (`latest` full release, `early`, or the last projection year e.g. 2034); `member` (glob, default `Projections*.csv`); CSV filters `commodity`, `attribute`, `year`; .xlsx `sheet`, `header_row` | units per row; one edition a year (early release in December, full report in February), current year plus 10 projection years |

Baseline 2035 ZIP members (full release): Projections2026.csv; U.S. Feed Grains, Wheat, Rice, Soybeans and
products, Upland Cotton, Sugar, Livestock, Dairy, Fruits Nuts and Vegetables projections; U.S. Farm receipts
expenses and income projections (Table 26); U.S. Agricultural trade long-term fiscal years projections; U.S.
Acreage and Conservation Reserve Program, U.S. Macroeoconomic (sic), Global GDP, Population and Real Exchange Rate
assumptions; the report PDF (not read). A wrong `member` fails with the list of members.

WASDE report tables (`report_title`): U.S. Feed Grain and Corn / Wheat / Wheat by Class / Rice / Sorghum, Barley,
and Oats / Soybeans and Products (Domestic Measure) / Cotton / Sugar / Meats / Egg / Milk Supply and Use, U.S.
Dairy Prices, U.S. Quarterly Animal Product Production, U.S. Quarterly Prices for Animal Products, World and U.S. Supply and Use for Grains /
Oilseeds / Cotton, World Wheat / Coarse Grain / Corn / Rice (Milled Basis) / Soybean / Soybean Meal / Soybean Oil /
Cotton Supply and Use, Mexico Sugar, and the "Reliability of ... Projections" tables.

## Spec examples
```json
{"description": "Latest WASDE U.S. corn balance sheet",
 "requests": [
  {"name": "corn_us", "endpoint": "wasde",
   "params": {"report_title": "U.S. Feed Grain and Corn Supply and Use", "commodity": "Corn"}}]}
```
```json
{"description": "Month-to-month path of the 2026/27 U.S. corn ending stocks projection",
 "requests": [
  {"name": "corn_es_path", "endpoint": "wasde",
   "params": {"start_report": "2026-05", "end_report": "latest", "report_title": "U.S. Feed Grain and Corn Supply and Use",
              "commodity": "Corn", "attribute": "Ending Stocks", "market_year": "2026/27"}}]}
```
```json
{"description": "Net farm income forecast, U.S. and Iowa, latest release; the summary table; past forecasts; baseline corn",
 "requests": [
  {"name": "nfi", "endpoint": "farm_income",
   "params": {"variable": ["Net farm income", "Net cash income"], "state": ["US", "IA"], "start_year": 2000}},
  {"name": "summary", "endpoint": "farm_income_summary", "params": {}},
  {"name": "nfi_vintages", "endpoint": "farm_income_archive", "params": {"item": "nfi", "start_year": 2015}},
  {"name": "baseline_corn", "endpoint": "baseline", "params": {"commodity": "Corn"}},
  {"name": "baseline_income", "endpoint": "baseline", "params": {"member": "*Farm receipts*"}}]}
```
To discover farm income variable names, fetch with `"search": "government payments"` and `"state": "US"`, then
use the exact `VariableDescriptionTotal` (or `artificialKey`, e.g. FIAUSNTFI--P = U.S. net farm income, FIAUSNTCI--P = U.S. net cash income; "net cash farm income"
is published as "Net cash income").

## Data format and traps
- **Projection, estimate, history (WASDE).** Each report covers three marketing years: the current one flagged
  `Proj.` (projection), the one before `Est.` (estimate), and the one before that unflagged (history). The flags
  appear as `(Proj.)`/`(Est.)` in the world-summary and wheat-by-class tables; `proj_est` matches both. Every
  report revises the projection: the CSV holds only that month's value (the PDF/text report also prints the
  previous month's column), so a revision is the difference between two reports (`start_report`/`end_report`).
  Example (verified): 2026/27 U.S. corn ending stocks were 1,567 million bushels in September 2026 and 1,849 in
  October 2026.
- **The same item appears in several tables, in different units.** U.S. corn ending stocks are in "U.S. Feed
  Grain and Corn Supply and Use" (million bushels) and "World Corn Supply and Use" (million metric tons), and in
  the reliability table (past forecast errors, in percent and years). Always set `report_title`; the fetch notes
  warn when rows come from more than one table. The reliability tables are dropped unless
  `include_reliability` is true. Commodity names differ by table: "Oilseed, Soybean" in the soybean tables,
  "Rice, milled" or "Rice" or "Rice, Rough" for rice, "Coarse Grain" and "Coarse Grains" both occur.
- **Marketing years differ by commodity** (corn, sorghum and soybeans September-August; wheat, barley and oats
  June-May; rice and cotton August-July; soybean oil and meal October-September); livestock, dairy and sugar
  tables use calendar or fiscal years (`MarketYear` 2026). Quarterly livestock rows carry `AnnualQuarterFlag`
  I-IV. Never compare a marketing-year value with a calendar-year one.
- **WASDE months.** The CSV series starts with the January 2021 report. There is no October 2025 report (lapse in
  federal funding); the May and June 2026 reports were reissued as corrected v2 reports and have no CSV at the
  usual name (HTTP 404, verified 2026-10-30): a range skips them with a note. `latest` takes the newest report
  date on the ESMIS publication page; USDA posts the CSV the day after the release, so on release day the pack
  falls back to the previous month and says so. Older months: the consolidated CSV (2010-2026) on the Historical
  WASDE Report Data page (browser only; scripts get HTTP 403), uploaded with --ingest; whether it holds the
  reissued May/June 2026 values is unverified.
- **Farm income forecasts.** ERS releases three times a year (February, late August/early September, late
  November/early December; next: December 2, 2026). A year is forecast in February of that year, updated in
  September, December and the next February, and becomes an estimate in the September release of the next year
  (ERS archive readme). The CSV has no F marker; the pack's `estimate_type` applies that rule to the release date
  (September 2026 release: 2026 forecast, 2025 and earlier estimates). State rows exist only for estimate years
  (none for 2026 in the September 2026 release). There was no December 2025 release (lapse in funding).
- **Nominal vs inflation-adjusted.** `Amount` is nominal, in thousands of dollars ($1,000) for most items:
  158353790 = $158.4 billion. Inflation-adjusted (real, latest-year dollars) = Amount x 100 /
  ChainType_GDP_Deflator; ERS's own real figures use this index (2025 net farm income 162614960 x 100 / 97.089 =
  $167.5 billion in 2026 dollars, so the 2026 forecast is $9.1 billion lower in real terms, as ERS reports). The
  deflator is blank for early years. `farm_income_summary` and the archive are nominal only.
- **Release files.** The release CSV is cp1252 (unit_desc arrives padded with non-breaking spaces; the pack strips
  them) and holds about 470,000 rows (111 MB): the pack streams it and keeps only the asked rows, so a filter is
  required. Releases up to November 2017 are plain CSVs of about 93 MB (slow). Each release revises history back
  several years, so do not mix years from different releases in one series without saying so.
- **Archive.** `farm_income_archive` is ERS's compendium of past releases (release_number 1 = first forecast,
  5 = first estimate, up to 15), U.S. only, three items; ERS calls it a research file, not an official record.
  Before August 2014 release months are ERS's assumption (February, August, November).
- **Baseline is not a forecast.** The USDA Agricultural Projections are a conditional scenario under current law
  and policy and specific macroeconomic, weather and trade assumptions, prepared by the Interagency Agricultural
  Projections Committee; the first years start from the WASDE of the November before (the 2035 edition: November
  2025). Say "USDA projects under its baseline assumptions", never "USDA forecasts". The early release (December)
  has fewer tables and can differ from the full release (February). `year_of_projection` is the edition year
  (2026 for "projections to 2035"). The CSV is rounded relative to the .xlsx tables (ERS readme).
- **.xlsx tables.** Read as published, row by row; the header row is the first row with three or more filled cells
  unless `header_row` is given; unit and section labels stay as rows ("Billion dollars", "Cash income
  statement"). Floats are written in their shortest exact form (540.87533065185278 -> 540.875330651853).

## Access
No key. Hosts: www.usda.gov (WASDE CSVs), esmis.nal.usda.gov (WASDE release dates), www.ers.usda.gov (farm
income, baseline). Limit used: one request per second. The usda.gov WASDE web pages answer scripts with HTTP 403
(Akamai bot filter) while the data files answer; the pack reads only the files, ESMIS and the ERS pages, and never
works around a 403. Route `api` fetches the files; the ERS file links change media ids and are read from the pages
each run.

Manual route (a browser): WASDE, open
`https://www.usda.gov/sites/default/files/documents/oce-wasde-report-data-YYYY-MM.csv` for the month (or the
Historical WASDE Report Data page for the consolidated CSV); farm income, open the data-files page
(https://www.ers.usda.gov/data-products/farm-income-and-wealth-statistics/data-files-us-and-state-level-farm-income-and-wealth-statistics)
and download the release ZIP ("September 3, 2026 release"), the "U.S. farm sector financial indicators" .xlsx or
the data archive ZIP; baseline, open https://www.ers.usda.gov/data-products/agricultural-baseline-database and
download the ZIP under "Most Recent Full-Release". Upload the files unchanged (agency file names are accepted);
--ingest applies the same filters as the fetch.

## Citation and terms
U.S. Department of Agriculture, <dataset> (World Agricultural Outlook Board, World Agricultural Supply and Demand
Estimates, report of <month>; or Economic Research Service, Farm Income and Wealth Statistics, release of <date>;
or USDA Agricultural Projections to <year>, Interagency Agricultural Projections Committee), usda.gov /
ers.usda.gov, retrieved <date>. Name the WASDE report month or the ERS release date: each is a vintage. Public
domain U.S. government works (17 U.S.C. 105); redistribution allowed with attribution.
