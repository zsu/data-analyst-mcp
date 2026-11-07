# NOAA NCEI climate data (Access Data Service, Climate Data Online)
Depth: standard. Key: optional (NOAA_API_KEY, only for the cdo_* endpoints). Historical station weather:
GHCN-Daily, monthly and annual summaries, 1991-2020 climate normals, hourly observations, station search.

## When to use
- Observed daily, monthly or annual temperature, precipitation, snowfall, snow depth and wind at a
  weather station, from the 1800s to a few days ago; 30-year climate normals; finding stations in an area.
- Not here: forecasts and active alerts (nws: those are not historical data), earthquakes and
  streamflow (usgs), air pollution (epa-aqs), disaster declarations (fema).
- Prefer the keyless `data` and `station_search` endpoints (NCEI Access Data Service). Use the keyed
  `cdo_*` endpoints only for what ADS cannot do: listing stations or data for a FIPS state/county
  (`locationid`), and dataset/data-type lists.

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `data` (keyless) | one row per station and date, one column per data type (wide) | `dataset`, `stations`, `startDate`, `endDate`, `dataTypes`, `units` (standard default), `includeAttributes`, `includeStationName`, `includeStationLocation` |
| `station_search` (keyless) | one row per station: id, name, longitude, latitude, start/end date, data types | `dataset`, `bbox` (north,west,south,east), `startDate`, `endDate`, `dataTypes`, `stations` (no free-text search: `text` answers HTTP 400) |
| `cdo_data` (key) | long form: one row per station, date, data type (`value`, `attributes`) | `datasetid`, `startdate`, `enddate`, `stationid` or `locationid`, `datatypeid` |
| `cdo_stations`, `cdo_locations`, `cdo_datasets`, `cdo_datatypes` (key) | CDO metadata | `datasetid`, `locationid` (FIPS:36), `extent`, `locationcategoryid` |

`dataset` aliases (ADS id): `daily` / `GHCND` (daily-summaries), `monthly` / `GSOM`
(global-summary-of-the-month), `annual` / `GSOY` (global-summary-of-the-year), `normals_monthly`,
`normals_daily`, `normals_annual` (1991-2020 normals), `hourly` (global-hourly, very large).
Common data types: TMAX, TMIN, TAVG, PRCP, SNOW, SNWD, AWND; normals: MLY-TAVG-NORMAL,
MLY-PRCP-NORMAL, DLY-TMAX-NORMAL, ANN-TAVG-NORMAL.

## Spec examples
```json
{"description": "Central Park, NYC: daily weather in January 2024 and the monthly 1991-2020 normals",
 "requests": [{"name": "cp_daily", "endpoint": "data",
               "params": {"dataset": "daily", "stations": "USW00094728", "startDate": "2024-01-01",
                          "endDate": "2024-01-31", "dataTypes": "TMAX,TMIN,PRCP,SNOW"}},
              {"name": "cp_normals", "endpoint": "data",
               "params": {"dataset": "normals_monthly", "stations": "USW00094728", "startDate": "0001-01-01",
                          "endDate": "9996-12-31", "dataTypes": "MLY-TAVG-NORMAL,MLY-PRCP-NORMAL"}}]}
```
```json
{"description": "Daily-summary stations around Manhattan with data in January 2024",
 "requests": [{"name": "near_manhattan", "endpoint": "station_search",
   "params": {"dataset": "daily", "bbox": "40.9,-74.1,40.6,-73.8",
              "startDate": "2024-01-01T00:00:00", "endDate": "2024-01-31T23:59:59"}}]}
```
```json
{"description": "GSOM stations in New York State (needs NOAA_API_KEY)",
 "requests": [{"name": "ny_stations", "endpoint": "cdo_stations", "params": {"datasetid": "GSOM", "locationid": "FIPS:36"}}]}
```

## Data format and traps
- **Units**: the pack sends `units=standard` (degrees F, inches) unless the spec says `metric` (degrees C,
  mm). Without `units`, GHCN-Daily values come as raw integers in tenths (TMAX 83 = 8.3 C, PRCP 8 =
  0.8 mm): never omit it. Values are not scaled when `units` is set.
- **Wide vs long**: `data` gives one column per data type; a type with no value that day is blank, and
  a type never observed at the station is absent. Data type ids are case-sensitive: a misspelled or
  lower-case type (`tmax`) is silently absent too (HTTP 200). The pack fails a request when none of its
  types came back; when only some are missing, check the columns before reading a gap as no data. `cdo_data` gives one row per value.
- **Station ids**: ADS takes bare ids (USW00094728); CDO takes `GHCND:USW00094728` (the pack strips the
  prefix for `data`). USW = first-order weather station, USC = cooperative, US1 = CoCoRaHS volunteer.
  Name the station in the report; a city's airport and downtown stations differ.
- **Attributes** (`includeAttributes=true`): `<TYPE>_ATTRIBUTES` holds measurement, quality and source
  flags (e.g. `,,W,2400`); a non-empty second field is a quality flag: consider dropping those values.
  Trace precipitation is reported as 0.00 with a T measurement flag.
- **Monthly/annual summaries** (GSOM/GSOY) are computed only when enough days are present; missing
  months are absent rows. DATE is YYYY-MM or YYYY, but `startDate`/`endDate` must be full dates even for
  them (ADS answers HTTP 400 "Invalid ISO Date Time" to YYYY-MM; the pack pads YYYY-MM and YYYY). Normals DATE is the month (01-12) and use the
  sentinel period 0001-01-01 to 9996-12-31.
- Recent days are preliminary and revised by quality control; data reach the API a few days after the observation (4 days on 2026-10-20).
- ADS returns everything in one response (no paging): keep long daily requests to a few stations.
- `station_search` returns the stations matching the area, dataset and period; `end_date` near today
  means the station still reports. `data_types` lists every type ever recorded, not coverage.
- CDO v2 limits: 1,000 rows a page (the pack pages), 5 requests a second and 10,000 a day per token, and
  a date range of at most 1 year (10 years for GSOM/GSOY) per request; the pack refuses longer ranges.

## Access
`data` and `station_search` need no key (route `api`). The `cdo_*` endpoints need a free token
(`NOAA_API_KEY`, sent as the `token` header; request it at https://www.ncei.noaa.gov/cdo-web/token);
without it `--check` returns the setup route for those requests only, and a fetch stops with
`key_missing` before calling CDO (which answers a bare HTTP 400 "Token parameter is required"). Manual route: the links in
`manual_download/INSTRUCTIONS.md` are keyless ADS URLs (change `format=json` to `format=csv` for a
spreadsheet); a station's whole daily record is one CSV at
https://www.ncei.noaa.gov/data/daily-summaries/access/<STATION>.csv (also
`global-summary-of-the-month/access/` and `global-summary-of-the-year/access/`); the CDO web search at
https://www.ncei.noaa.gov/cdo-web/ finds stations. Upload the files, then `--ingest`.

## Citation and terms
"NOAA National Centers for Environmental Information, <dataset> (e.g. Global Historical Climatology
Network - Daily), station <id>, www.ncei.noaa.gov, retrieved <date>." NOAA data are public domain (U.S.
government works); cite NCEI and the dataset. Redistribution allowed.
