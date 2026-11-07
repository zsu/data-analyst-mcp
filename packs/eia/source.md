# EIA Open Data API v2 (U.S. Energy Information Administration)
Depth: standard. Key: optional (EIA_API_KEY; without it api.data.gov's DEMO_KEY, a few requests an
hour). Electricity, petroleum, natural gas, coal, nuclear, state energy (SEDS), Monthly Energy Review,
Short-Term and Annual Energy Outlooks, international energy, by period, state, sector and fuel.

## When to use
- Electricity prices, sales, revenue and customers by state and sector; generation and fuel use by
  state and fuel; power-plant emissions; generator capacity.
- Crude oil (WTI, Brent) and product spot prices; weekly retail gasoline and diesel prices; crude
  production, stocks, imports; natural gas prices, production, consumption; coal production.
- State energy consumption, production, prices and expenditures per capita or in total (SEDS); U.S.
  totals (Monthly Energy Review, total-energy); projections (STEO, AEO).
- Not here: the energy component of the CPI (bls), energy industry jobs (bls), energy-related federal
  spending (usaspending), greenhouse-gas inventories beyond energy CO2 (epa), international peers'
  energy use per capita when the World Bank series suffices (world-bank).

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `data` | rows of a leaf route: period, facet columns, data columns, units | `route`, `data`, `facets`, `state`, `msn`, `frequency`, `start`, `end`, `sort` |
| `routes` | child routes (browse the tree; route "" = top) | `route` |
| `facets` | facets a route offers | `route` |
| `facet_values` | values of one facet | `route`, `facet` |
| `metadata` | one row: frequencies, facets, data columns with units, start/end | `route` |

Route aliases (`--search "words"`, `--endpoints`): `retail_sales` electricity/retail-sales (price,
sales, revenue, customers; facets stateid, sectorid RES COM IND TRA OTH ALL), `power_operations`
(generation by location, sectorid, fueltypeid), `power_emissions_by_state`, `generator_capacity`,
`seds` (seriesId = MSN code, stateId), `total_energy` (msn), `steo`, `aeo_2026`, `spot_prices`
petroleum/pri/spt (series RWTC = WTI Cushing, RBRTE = Brent), `gasoline_diesel_retail`
petroleum/pri/gnd (EMM_EPMR_PTE_NUS_DPG U.S. regular gasoline, EMD_EPD2D_PTE_NUS_DPG U.S. diesel),
`crude_production`, `petroleum_supply`, `petroleum_stocks_weekly`, `petroleum_imports`,
`crude_imports_by_origin`, `natural_gas_prices`, `natural_gas_supply`, `natural_gas_production`,
`natural_gas_consumption`, `coal_production`, `coal_consumption_quality`, `nuclear_outages`,
`international`, `co2_emissions_aggregates` (deprecated by EIA: use SEDS).
SEDS codes (catalog): TETCB total consumption, TETPB consumption per capita, TEPRB primary production,
TETCD average price, TETXB end-use consumption, TPOPP population, ESTCB electricity, CLTCB coal, NNTCB
natural gas, PATCB petroleum, RETCB renewables, NUETB nuclear, ELISB net interstate electricity flow.

## Spec examples
```json
{"description": "Residential electricity price, Maryland and U.S., annual 2020-2024",
 "requests": [{"name": "md_res_price", "endpoint": "data",
   "params": {"route": "retail_sales", "state": ["MD", "US"], "facets": {"sectorid": ["RES"]},
              "frequency": "annual", "start": "2020", "end": "2024"}}]}
```
```json
{"description": "Energy consumption per capita by state, 2023 (SEDS)",
 "requests": [{"name": "per_capita_2023", "endpoint": "data",
   "params": {"route": "seds", "msn": "TETPB", "start": "2023", "end": "2023"}, "max_rows": 100}]}
```
```json
{"description": "WTI monthly spot price and weekly U.S. regular gasoline since 2024",
 "requests": [{"name": "wti", "endpoint": "data",
   "params": {"route": "spot_prices", "facets": {"series": ["RWTC"]}, "frequency": "monthly", "start": "2024-01"}},
  {"name": "gasoline", "endpoint": "data",
   "params": {"route": "gasoline_diesel_retail", "facets": {"series": ["EMM_EPMR_PTE_NUS_DPG"]},
              "frequency": "weekly", "start": "2024-01-01"}}]}
```
Unknown facet values: `{"name": "f", "endpoint": "facet_values", "params": {"route": "seds", "facet": "seriesId"}}`.

## Data format and traps
- Every row carries its units: `price-units` ("cents per kilowatt-hour"), `units` ("$/BBL", "$/GAL"),
  `unit` ("Million Btu"). Read them; never assume. Prices are nominal dollars.
- Columns differ by route: retail-sales has `price`, `sales`, `revenue`, `customers` (ask for them in
  `data`); most petroleum and gas routes have `value` with `series`, `duoarea`, `product`, `process`
  descriptions. Values are numbers or numeric text; markers such as "W" (withheld), "NA" or "--"
  become empty cells with a `<column>_flag` column.
- `period` format follows the frequency: YYYY, YYYY-MM, YYYY-Q1, YYYY-MM-DD (weekly rows are dated by
  the week's day, e.g. Mondays for retail gasoline). `start`/`end` must use the same format;
  the API reads a bare year on a monthly series as January only, so the pack widens `start: 2023` /
  `end: 2023` to the whole year for monthly, quarterly, weekly, daily and hourly data (verified 2026-10).
- Facet ids are case-sensitive and differ by route: `stateid` (retail-sales, emissions), `stateId`
  (SEDS), `location` (power operations, coal). The pack's `state` fills the right one from the catalog;
  region codes (US, NEW, MAT, PACC ...) are values too. An unknown facet is an HTTP 400 with the valid
  list ("Invalid facet 'x' provided. The only valid facets are ...").
- Sector "ALL" and region totals ("US") are rows next to the parts: filter before summing.
- SEDS is annual with a lag (2024 the latest year in October 2026) and is revised each release; per
  capita uses SEDS's own population (TPOPP). Monthly series are revised; the latest months are
  preliminary. The total-energy metadata lists an end period far ahead (2121-12): always set `end`.
- Paging: `offset`/`length`, at most 5,000 rows per call; `response.total` is the full count. Default
  sort is period descending (newest first); give `"sort": "period:asc"` for oldest first.
- Routes that do not exist: coal/production (use coal/aggregate-production) and
  nuclear/status-operable-units (use nuclear-outages/us-nuclear-outages). SEDS codes TETCD and TETXB
  are average price and end-use consumption, not per-capita consumption and expenditures.

## Access
Key optional: free at https://www.eia.gov/opendata/register.php (the API runs on api.data.gov, so any
api.data.gov key works as EIA_API_KEY). Without a key the pack sends DEMO_KEY, which allowed 10
requests an hour from one address when checked (HTTP 429 beyond); store a key with the setup script
for real work. Route `api` when api.eia.gov answers (responses can take 10-30 seconds).
Keyless file (`keyless_file` and `keyless_files` in `--check`; after a fetch stops at HTTP 429 on DEMO_KEY,
the blocked route offers them too): every petroleum series is also a keyless Excel file,
`https://www.eia.gov/dnav/pet/hist_xls/<series><d|w|m|a>.xls` (daily, weekly, monthly, annual; e.g.
`EMM_EPMR_PTE_NUS_DPGm.xls`, `MGFUPUS2m.xls`, `RWTCd.xls`; 30-500 KB; checked 2026-10-30). It covers a
request of a `petroleum/*` route with `facets: {"series": [one id]}` and no other facet (a series lacks a file
at a frequency EIA does not publish for it: `MGFUPUS2w.xls` is HTTP 404). Download each `keyless_files` url
under its filename into a new folder and run `ingest_command` on it (needs the xlrd package; without it
`--check` lists no file and `--ingest` stops with `install_deps`): it keeps the request's dates and records
the route as `keyless_file`. Ingested rows have `period`, `series`, `series-description`, `value`, `units`
only: `units` is the file's wording ("Dollars per Gallon" where the API says "$/GAL"), and the duoarea,
product and process columns are absent. Periods follow the API's formats (the file dates monthly rows the
15th and annual rows July 1; the pack keeps YYYY-MM and YYYY). Manual route:
`manual_download/INSTRUCTIONS.md` has one JSON link per 5,000 rows carrying DEMO_KEY (replace it with
your key if the hourly limit is hit); upload, then `--ingest`. Alternatives: the API browser
https://www.eia.gov/opendata/browser/ (CSV/Excel download) or the data pages on eia.gov.

## Citation and terms
"U.S. Energy Information Administration, <series or route description>, EIA Open Data API v2,
retrieved <date>." Data from a keyless file cite "Petroleum & Other Liquids data series history
(www.eia.gov/dnav/pet)" instead of the API: data/eia/README.md and the report's citation do so when
request.json's route is `keyless_file`. Public domain; EIA asks to be cited as the source. Redistribution allowed.
