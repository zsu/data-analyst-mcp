# Bureau of Transportation Statistics Open Data (data.bts.gov)
Depth: standard. Key: none. BTS's Socrata portal: Monthly Transportation Statistics (134 national monthly
indicators), border crossings at land ports of entry, the Transportation Services Index, air fares, T-100
air traffic, motor fuel, bikeshare and freight indicators.

## When to use
- National monthly transportation indicators: airline passengers (SA and NSA), on-time performance,
  transit ridership by mode, freight rail carloads and intermodal units, vehicle miles traveled, truck
  tonnage index, regular gasoline and diesel prices, auto and truck sales, transportation fatalities,
  the Transportation Services Index (TSI), transportation employment and spending.
- Inbound crossings by port, state, border, month and measure (trucks, personal vehicles, pedestrians...).
- Average domestic air fare by quarter or carrier; T-100 passengers, seats and freight by airport.
- Not here: vehicle recalls and crash complaints (nhtsa); crash fatality microdata (FARS, nhtsa);
  gasoline prices by region and fuel supply (eia); trade values by commodity (census trade); GDP itself
  (bea; the GDP column here is a copy).

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `query` | JSON rows of one dataset | `dataset` (alias or id), `$select`, `$where`, `$group`, `$order`, `$q` |
| `csv` | the same as CSV (manual route) | same |

Catalog aliases (`fetch.py --source bts --endpoints` lists all 19; `--search "air fare"` finds datasets
AND Monthly Transportation Statistics columns):
| Alias | Id | Content | Frequency, coverage |
|---|---|---|---|
| `monthly_stats` | crem-w557 | 134 national indicators, one row per month | monthly, 1947- (most series 2000-) |
| `border_crossings` | keg4-3bc2 | port_name, state, port_code, border, date, measure, value | monthly, 1996- |
| `tsi` | bw6n-ddqk | TSI freight, passenger, combined + SA components | monthly |
| `airfare_quarterly` | h77j-murt | average domestic air fare | quarterly |
| `t100_segment_origin` | r495-tyji | passengers, seats, freight, mail by origin airport | annual |
| `motor_fuel_sales` | kbvr-tyu5 | gasoline and special fuel sales by state (FHWA) | monthly |
| `supply_chain` | y5ut-ibwt | freight and supply-chain indicators | weekly/monthly |
Others: `tet`, `daily_mobility` (ended 2024), `airfare_carrier`, `t100_segment`, `motor_fuel_tax`,
`vehicles_entering`, `container_ports`, `bikeshare_ridership`, `bikeshare_systems`, `state_tpfs`,
`transport_satellite`, `air_fuel_efficiency`. Any other data.bts.gov dataset works by its 4x4 id.

Useful `monthly_stats` columns (published titles in `endpoints.json` "monthly_stats_fields"):
`transportation_services_index_freight` / `_passenger` / `_combined`, `u_s_airline_traffic_total_non_seasonally_adjusted`
(passengers), `system_use_u_s_airline_2` (total, SA), `u_s_marketing_air_carriers_on_time_performance_percent`,
`system_use_transit_ridership` (urban rail, adjusted), `system_use_transit_ridership_1` (fixed-route bus),
`system_use_freight_rail` (carloads), `system_use_freight_rail_1` (intermodal units), `system_use_highway_vehicle_4`
(VMT, all systems), `truck_tonnage_index`, `highway_fuel_prices_regular` ($/gallon),
`highway_fuel_prices_on_highway` (diesel), `auto_sales_saar_millions`, `safety_highway_fatalities`,
`rail_fatalities`, `amtrak_on_time_performance`.

## Spec examples
```json
{"description": "TSI freight, gasoline price and airline passengers, first half of 2024",
 "requests": [{"name": "tsi_2024h1", "endpoint": "query",
   "params": {"dataset": "monthly_stats",
     "$select": "date, transportation_services_index_freight, highway_fuel_prices_regular, u_s_airline_traffic_total_non_seasonally_adjusted",
     "$where": "date >= '2024-01-01' AND date <= '2024-06-01'", "$order": "date"}}]}
```
```json
{"description": "Truck crossings into Texas by port, January 2025",
 "requests": [{"name": "tx_trucks_2025_01", "endpoint": "query",
   "params": {"dataset": "border_crossings", "$select": "port_name, sum(value) AS trucks",
     "$where": "state = 'Texas' AND measure = 'Trucks' AND date = '2025-01-01T00:00:00'",
     "$group": "port_name", "$order": "trucks DESC"}}]}
```
Select only the columns you need from `monthly_stats`: a full row has 136 columns (date, a row `index`
and 134 indicators; verified 2026-10, BTS adds series over time).

## Data format and traps
- Every value arrives as text ("135.2", "70060000.0"); convert in `analysis.py`. Dates are floating
  timestamps (`2024-01-01T00:00:00.000`, first of the month); compare with quoted ISO dates.
- `monthly_stats` has one row per month for every month since 1947, mostly empty before 2000, and the
  latest months are partly empty because each series is published with its own lag (the TSI about two
  months, GDP quarterly). Filter on the column you need (`<col> IS NOT NULL`), not on another column. Filtering
  on `general_economic_indicators IS NOT NULL` (quarterly GDP) silently drops two months of every three.
- Column names are opaque: `system_use_transit_ridership` is urban rail only; `_1` is bus, `_2` other
  modes. `general_economic_indicators` is real GDP (quarterly, SAAR, in dollars); `_3` is the unemployment
  rate. Check the title with `--search` before using a column.
- Seasonal adjustment: the airline traffic `..._non_seasonally_adjusted` columns are NSA; the
  `system_use_u_s_airline*` columns are SA. Do not mix them in one trend.
- Series are revised: the TSI and SA series change with each release; report the retrieval date.
- Border crossings count inbound crossings only (no outbound). `measure` values (verified 2026-10):
  Trucks, Personal Vehicles, Personal Vehicle Passengers, Pedestrians, Buses, Bus Passengers, Trains,
  Train Passengers ("Rail Containers Loaded/Empty" no longer exist). `state` is the
  full name ("Texas"); `border` is "US-Mexico Border" or "US-Canada Border". Sum `value` over ports for
  a state total; trucks and passengers are different units, never add measures together.
- SoQL text values need single quotes and matching is case-sensitive. A filter that matches nothing
  makes the fetch fail with "returned no rows". Paging is `$limit`/`$offset` with a stable `$order`.

## Access
No key. Route `api` when data.bts.gov answers (Socrata throttles heavy keyless use; it
publishes no number). Manual route: each request gets CSV links (one per 50,000 rows) in
`manual_download/INSTRUCTIONS.md`; or open `https://data.bts.gov/d/<id>`, choose Export > CSV, and
upload the file. For `monthly_stats` the full CSV export (all 136 columns) is simplest.

## Citation and terms
"Bureau of Transportation Statistics, <dataset name>, data.bts.gov, retrieved <date>." BTS data are
public domain U.S. government works; cite BTS as the source. Redistribution allowed. Several series
are compiled by BTS from other agencies (EIA fuel prices, FHWA VMT, BEA GDP, AAR rail): name the
original agency when the report relies on one series.
