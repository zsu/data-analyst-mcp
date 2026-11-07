# NREL / NLR Developer APIs (alt fuel stations, utility rates, solar resource, PVWatts)
Depth: standard. Key: optional (DATA_GOV_API_KEY; DEMO_KEY works for a few requests). EV charging and
alternative fuel stations (AFDC Station Locator), utility electricity rates, solar resource, PVWatts.

## When to use
- EV chargers and alternative fuel stations by state, ZIP, network, charging level, fuel type, status;
  stations near a point; modeled rooftop PV output (PVWatts v8); average solar irradiance by month; the
  electricity rates of the utility serving a point (2012 data).
- Not here: state electricity prices, generation and consumption over time (eia), vehicle
  registrations (not covered), EV recalls (nhtsa), weather (noaa).
- The laboratory was renamed from the National Renewable Energy Laboratory (NREL) to the National
  Laboratory of the Rockies (NLR); the API moved from developer.nrel.gov (no longer resolves) to
  developer.nlr.gov with the same paths and keys. The pack id stays `nrel`.

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `alt_fuel_stations` | one row per station (current snapshot) | `fuel_type` (ELEC, E85, CNG, LPG, BD, HY, LNG, RD), `state`, `zip`, `city`, `status` (E open, P planned, T temporarily unavailable), `access` (public/private), `ev_network`, `ev_charging_level` (1, 2, dc_fast), `ev_connector_type`, `owner_type` |
| `alt_fuel_nearest` | stations nearest a point, with `distance` (miles) | `latitude`+`longitude` (required), `radius`, plus the filters above |
| `alt_fuel_station` | one station | `id` |
| `utility_rates` | one row: residential, commercial, industrial $/kWh and utility name | `lat`, `lon` |
| `solar_resource` | 13 rows (jan-dec, annual): `avg_dni`, `avg_ghi`, `avg_lat_tilt` in kWh/m2/day | `lat`, `lon` |
| `pvwatts` | 12 monthly rows: `ac_kwh`, `dc_kwh`, `poa_kwh_m2`, `solrad_kwh_m2_day`, plus `ac_annual`, `capacity_factor`; with `timeframe=hourly`, 8,760 hourly rows instead (see traps) | `lat`, `lon`, `system_capacity` (kW), `module_type`, `losses` (%), `array_type`, `tilt`, `azimuth`, `timeframe` |
| `alt_fuel_csv` | the station list as CSV with label headers (manual route) | as `alt_fuel_stations` |

Catalog aliases (`--search`): `ev_chargers`, `hydrogen_stations`, `electricity_rates`, `solar`, `pv_output`
(they name the endpoint; set `fuel_type` yourself).

## Spec examples
```json
{"description": "Open public DC fast charging stations in Vermont",
 "requests": [{"name": "vt_dcfast", "endpoint": "alt_fuel_stations",
   "params": {"state": "VT", "fuel_type": "ELEC", "ev_charging_level": "dc_fast", "status": "E", "access": "public"}}]}
```
```json
{"description": "Montpelier, VT: solar resource and a 4 kW fixed roof-mount PV system",
 "requests": [{"name": "montpelier_solar", "endpoint": "solar_resource", "params": {"lat": 44.26, "lon": -72.58}},
              {"name": "montpelier_pv", "endpoint": "pvwatts",
               "params": {"lat": 44.26, "lon": -72.58, "system_capacity": 4, "module_type": 0, "losses": 14,
                          "array_type": 1, "tilt": 30, "azimuth": 180}}]}
```

## Data format and traps
- **Stations vs ports**: each row is a station; EV port counts are `ev_level1_evse_num`,
  `ev_level2_evse_num`, `ev_dc_fast_num`. Say which one is counted. `ev_connector_types` is a list
  written as `TESLA; J1772COMBO`.
- **Defaults include every station**: without `status` and `access` the API returns all stations, open
  (E), planned (P) and temporarily unavailable (T), public and private (checked live 2026-10-22: the same
  count as `status=all&access=all`). For "open public stations" pass `status=E` and `access=public`;
  say which set was counted. When a fetch stops at `max_rows`, the notes give the matching total
  (`total_results`).
- **City**: the API has no city filter (sent, `city` answers 0 rows, verified 2026-10-28). The pack never
  sends it: it fetches the `state` (or `zip`) and keeps the rows whose `city` matches, ignoring case. Leave
  `max_rows` unset with `city`: a state fetch cut short leaves the city's rows incomplete (the fetch is then
  `partial` and says so). A
  place's stations can be listed under a neighbouring city name or ZIP: check the state table's `city`
  and `zip` values before counting.
- **Addresses are not accepted**: the API removed `location` (nearest stations) and `address`
  (utility_rates, solar_resource) and answers HTTP 422; pass decimal `latitude`/`longitude` (`lat`/`lon`).
  Geocode a place name yourself (e.g. Census geocoder) and say which coordinates were used.
- The station list is a current snapshot, not a history: closed or replaced stations are gone, so counts
  by `open_date` (filled for current stations, verified 2026-10) understate earlier years badly; treat a
  past count built from `open_date` as a lower bound and say so. `date_last_confirmed` shows staleness.
- **utility_rates** comes from a 2012 source (`metadata.sources`: "Ventyx Research (2012)"): average
  rates of one utility, not current tariffs. For current prices use eia (retail sales and revenue).
- **solar_resource** is a long-term average (Perez-SUNY/NREL, 2012 release) in kWh/m2/day. PVWatts uses
  NSRDB typical-meteorological-year data; `ac_kwh` is modeled AC energy per month (kWh), not a
  measurement, and depends on every input (pass `losses`, e.g. 14 percent).
- **pvwatts hourly**: `timeframe=hourly` gives one row per hour of the typical year (`step` 0-8759,
  `month`, `day`, `hour`); `ac_w`/`dc_w` are average power in watts over the hour (sum over hours / 1000 =
  kWh), irradiance (`poa_w_m2`, `dn_w_m2`, `df_w_m2`) is in W/m2, `tamb_c`/`tcell_c` in C, `wspd_m_s` in m/s.
  The typical year has no Feb 29 and is not a calendar year.
- Paging: `limit` up to 200 with `offset` (the fetcher pages; `offset` works on v1.json though only the
  nearest endpoint documents it). HTTP 422 means an invalid parameter value.
- Coordinates are decimal degrees (WGS84); `distance` is in miles.

## Access
Key optional. With `DATA_GOV_API_KEY` (free at https://developer.nlr.gov/signup/ or
https://api.data.gov/signup/; the same api.data.gov key works) the limit is 1,000 requests an hour per
key; without one the fetcher sends `DEMO_KEY`, documented as 30 requests an hour and 50 a day per IP address
(the `X-RateLimit-Limit` header showed 10 an hour on 2026-10-22), so a keyless run fits only a few requests. Manual route: links in `manual_download/INSTRUCTIONS.md` (replace `{API_KEY}` with a key
or `DEMO_KEY`); without any key, the AFDC Station Locator (https://afdc.energy.gov/stations) and
https://afdc.energy.gov/data_download export station CSVs, and https://pvwatts.nlr.gov downloads PVWatts
monthly results as CSV. Upload the files, then `--ingest`.

## Citation and terms
"National Laboratory of the Rockies (formerly NREL), U.S. Department of Energy, <dataset>, developer.nlr.gov
API, retrieved <date>." For station data also cite the Alternative Fuels Data Center (afdc.energy.gov).
Open DOE data; redistribution allowed with attribution and no implied endorsement. Rate limits:
https://developer.nlr.gov/docs/rate-limits/.
