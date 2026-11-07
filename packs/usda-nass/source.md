# USDA NASS Quick Stats
Depth: standard. Key: required (USDA_NASS_API_KEY). Every published NASS estimate: crop acreage,
yield, production and stocks; livestock inventories and production; prices received; farm economics;
and the Census of Agriculture (every five years, to the county), national to county level.

## When to use
- Crop production, area planted and harvested, yield by state or county and year; livestock and
  poultry inventories; milk and egg production; prices received by farmers; Census of Agriculture
  counts (farms, land in farms, sales, operator demographics) by county.
- Not here: food prices paid by consumers (bls CPI); farm income and balance sheet forecasts (USDA ERS,
  not covered); crop insurance (not covered); agricultural trade (census trade); food safety
  recalls (fda).

## Endpoints and datasets
| Endpoint | Returns (one row per) | Parameters |
|---|---|---|
| `query` | published value (at most 50,000 a request) | any Quick Stats column as a filter, plus operators |
| `count` | the number of rows a query would return | same filters |
| `param_values` | value a parameter takes | `param` (e.g. commodity_desc, short_desc) plus filters |
Filters (the "What, Where, When" columns): `source_desc` (SURVEY, CENSUS), `sector_desc`,
`group_desc`, `commodity_desc`, `class_desc`, `statisticcat_desc`, `unit_desc`, `short_desc` (the
full data item, most precise), `domain_desc` (TOTAL for no breakdown), `agg_level_desc` (NATIONAL,
STATE, COUNTY, ...), `state_alpha`, `state_name`, `county_name`, `county_code`, `year`, `freq_desc`,
`reference_period_desc`. Operators go on the parameter name: `year__GE=2012` (>=), `year__LE` (<=),
`__LT` (<), `__GT` (>), `__LIKE`, `__NOT_LIKE`, `__NE` (not equal) (API page, quickstats.nass.usda.gov/api).
Catalog aliases for `short_desc` (`--endpoints`): corn_production, corn_yield, corn_planted,
corn_price, soybean_production, soybean_yield, wheat_production, cattle_inventory, hogs_inventory,
milk_production (names from Quick Stats usage, NOT verified live: no key; check with `param_values`).

## Spec examples
```json
{"description": "Corn in Virginia since 2012 (the documented example), and how many rows it has",
 "requests": [{"name": "corn_va", "endpoint": "query",
               "params": {"commodity_desc": "CORN", "year__GE": 2012, "state_alpha": "VA"}},
              {"name": "corn_va_count", "endpoint": "count",
               "params": {"commodity_desc": "CORN", "year__GE": 2012, "state_alpha": "VA"}}]}
```
```json
{"description": "Corn for grain production by state, 2024 (survey)",
 "requests": [{"name": "corn_states_2024", "endpoint": "query",
   "params": {"short_desc": "corn_production", "source_desc": "SURVEY", "agg_level_desc": "STATE",
              "year": 2024, "reference_period_desc": "YEAR"}}]}
```
```json
{"description": "Every sector name",
 "requests": [{"name": "sectors", "endpoint": "param_values", "params": {"param": "sector_desc"}}]}
```

## Data format and traps
- `Value` is text as published: "510,000" with commas, or a code. The pack adds `value_num`
  (no commas; empty for codes) and `value_flag`. Codes (NASS): (D) withheld to avoid disclosing
  individual operations, (Z) less than half the rounding unit, (NA) not available, (X) not applicable,
  (S) insufficient reports, (H)/(L) coefficient of variation above 99.95% / below 0.05%. Never read a
  code as zero (the code list is from NASS publications, not the API page). `CV (%)` is documented
  for the 2012 Census of Agriculture only; it gets `cv_num` / `cv_flag`.
- A broad filter mixes many data items: commodity_desc CORN alone returns acres, production, yield,
  stocks, prices, grain and silage, and SURVEY plus CENSUS rows. Filter on `short_desc` (or
  statisticcat_desc + unit_desc + util_practice_desc) and `domain_desc: TOTAL`, and check
  `count` first; more than 50,000 rows is refused ("exceeds limit = 50000").
- SURVEY and CENSUS values for the same item differ (methods, coverage, timing): never splice them.
- Several values per year: `reference_period_desc` (YEAR, MARKETING YEAR, a month, a week,
  "FIRST OF JAN") and `freq_desc` separate them. Forecasts (e.g. "YEAR - AUG FORECAST") are revised
  until the annual summary; use the final YEAR row for history.
- Values are upper case ("CORN", "IOWA"); the pack upper-cases filter values. State totals do not always
  add to the national value (suppression, "OTHER STATES" rows); county rows may be withheld (D).
- Units are in `unit_desc` (BU, ACRES, BU / ACRE, $ / BU, HEAD, LB, $); production is in units, not
  thousands. Census of Agriculture years: 2002, 2007, 2012, 2017, 2022.
- Verification status: built from the Quick Stats API documentation (tests use doc_* fixtures from its
  examples); not checked against a live key.

## Access
Key required: free, by email, at https://quickstats.nass.usda.gov/api (accept the terms, enter an
email; the key arrives by mail). Store it as `USDA_NASS_API_KEY` with the setup script; it goes in the
`key` query parameter. Rate limits are not published (NASS may block heavy use); the pack sends at
most one request a second. Manual route without a key: build the query at
https://quickstats.nass.usda.gov/ (Program, Sector, Group, Commodity, Category, Data Item, Geographic
Level, State, Year), choose Get Data, then the Spreadsheet link (CSV), and upload it; ingest reads the
CSV (same columns as the API). With a key, the bundle's script downloads `format=CSV` links.
Very large extracts: the bulk files at https://www.nass.usda.gov/datasets/ (tab-delimited, gzip).

## Citation and terms
"USDA National Agricultural Statistics Service, Quick Stats, <data item>, quickstats.nass.usda.gov,
retrieved <date>." Public domain U.S. government data; redistribution allowed. Name the program
(Survey or Census) and reference period with every number. Required notice (API terms, "Attribution"):
"This product uses the NASS API but is not endorsed or certified by NASS." The report carries it (policy.json `notices`).
