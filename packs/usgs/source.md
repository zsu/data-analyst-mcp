# USGS earthquakes (ComCat) and Water Data (streamflow, groundwater)
Depth: standard. Key: optional (DATA_GOV_API_KEY, for water data volume only). Earthquake events
worldwide from the USGS ComCat catalog; U.S. streamflow, gage height, water temperature and groundwater
levels from the USGS Water Data OGC API (the successor of NWIS Water Services).

## When to use
- Earthquakes by time, magnitude, depth, area (circle or box), PAGER alert level; counts per year;
  real-time feeds. Daily or 15-minute streamflow and stage at a gage; latest values across a state;
  annual peak flows; groundwater levels; finding monitoring sites by state, county, HUC or box.
- Not here: flood insurance and disaster aid (fema), weather and precipitation (noaa; forecasts nws),
  drinking-water systems and violations (epa), water quality samples (Water Quality Portal, not covered).

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `earthquakes` | one row per event: `mag`, `magType`, `place`, `time_utc`, `latitude`, `longitude`, `depth_km`, `felt`, `cdi`, `mmi`, `alert`, `tsunami`, `sig`, `status`, `id` | `starttime`, `endtime`, `minmagnitude`, `maxmagnitude`, `latitude`+`longitude`+`maxradiuskm`, `minlatitude`..`maxlongitude`, `mindepth`, `maxdepth`, `alertlevel`, `eventtype`, `orderby` |
| `earthquakes` with `eventid` | one row for that event (same columns) | `eventid` (e.g. from a search row's `id`) |
| `earthquake_count` | one row: `count`, `maxAllowed` | same filters |
| `earthquake_feed` | a real-time summary feed | `feed`: significant_month, 4.5_week, 2.5_day, all_hour ... |
| `water` | rows of one OGC collection | `collection` (alias), `monitoring_location_id`, `parameter_code`, `statistic_id`, `time`, `state_code`, `county_code`, `site_type_code`, `bbox`, `properties` |

`collection` aliases: `daily` (daily values), `continuous` (15-minute values), `latest-continuous`,
`latest-daily`, `monitoring-locations` (site metadata with coordinates), `field-measurements`,
`latest-field-measurements`, `channel-measurements` (width, area, velocity taken with streamflow
measurements), `peaks` (annual peaks), `time-series-metadata` (which parameters a site has, begin/end), `parameter-codes`,
`statistic-codes`; shortcuts `streamflow_daily` (= daily) and `groundwater_levels` (= field-measurements).
Parameter codes: 00060 discharge (ft3/s), 00065 gage height (ft), 00010 water temperature (C), 00045
precipitation (in), 00400 pH, 00300 dissolved oxygen (mg/L), 00095 specific conductance (uS/cm), 72019
depth to water (ft below land surface). Daily statistic ids: 00003 mean, 00001 maximum, 00002 minimum.

## Spec examples
```json
{"description": "M6+ earthquakes worldwide in 2024 and their count",
 "requests": [{"name": "m6_2024", "endpoint": "earthquakes", "params": {"starttime": "2024-01-01", "endtime": "2025-01-01", "minmagnitude": 6}},
              {"name": "m6_2024_count", "endpoint": "earthquake_count", "params": {"starttime": "2024-01-01", "endtime": "2025-01-01", "minmagnitude": 6}}]}
```
```json
{"description": "Potomac River near Washington (01646500): daily mean discharge, 2024",
 "requests": [{"name": "potomac_2024", "endpoint": "water",
   "params": {"collection": "daily", "monitoring_location_id": "01646500", "parameter_code": "00060",
              "statistic_id": "00003", "time": "2024-01-01/2024-12-31"}}]}
```
```json
{"description": "Stream gages in Vermont",
 "requests": [{"name": "vt_sites", "endpoint": "water",
   "params": {"collection": "monitoring-locations", "state_code": "VT", "site_type_code": "ST"}}]}
```

## Data format and traps
- **Earthquake time** is published as epoch milliseconds (`time`, `updated`); the pack adds `time_utc`
  and `updated_utc` (ISO, UTC). `starttime`/`endtime` are UTC; `endtime` is exclusive at its instant
  (use the next day's date to include a whole day). Local dates differ near midnight.
- **Magnitude types differ** (`magType` mww, mb, ml, md ...); they are not interchangeable at low
  magnitudes. Catalog completeness changes over time and place: small events (below about M2.5 outside
  dense networks, below about M4.5 worldwide) are missing from older years, so trends in counts of small
  quakes reflect network growth. Compare counts only above a threshold that is complete for the period.
- `eventtype` defaults to all events (quarry blasts and explosions included); set `eventtype=earthquake`
  for earthquake counts. `status` automatic events are revised; reviewed ones are final but can still
  change. `alert` is the PAGER level (green, yellow, orange, red), blank for most events.
- **An area crossing the 180th meridian** (Pacific islands and arcs, far-eastern Russia) is one box with
  `maxlongitude` above 180: 170E to 170W is `minlongitude` 170, `maxlongitude` 190 (the service takes
  -360 to 360; rows still come back in -180..180; verified 2026-10: one box returns exactly the events of
  the two halves). `minlongitude` above `maxlongitude` is refused. If you split one area into two boxes
  (one ending at 180, one starting at -180), give both the same latitude bounds and filters, or the strip
  where they differ is left out silently; one box avoids that.
- FDSN returns at most 20,000 events per call (`maxAllowed`); the pack always sets `limit` and pages
  with `offset`. `depth_km` is kilometres; coordinates are WGS84.
- **Water rows are not in time order** (verified): sort by `time`. `value` is text; `unit_of_measure`
  names the unit (ft^3/s). Recent values are `Provisional` (`approval_status`) and may be revised or
  deleted; `Approved` values are the published record. Gaps (ice, equipment) are absent days;
  `qualifier` carries value flags (for example estimated or ice-affected) when present.
- Site ids: `monitoring_location_id` is `USGS-<site number>` (the pack adds the prefix to a bare number;
  on `monitoring-locations`, whose rows are the sites, the pack sends it as `id`, the only site filter there);
  site numbers keep leading zeros (01646500), so keep them as text. `state_code` is FIPS (the pack
  converts VT or Vermont); `county_code` is 3-digit.
- `time` takes an ISO 8601 interval (`2024-01-01/2024-12-31`, open-ended `2024-01-01/..`) or a duration
  (`P7D`). `continuous` values are every 15 minutes: one year at one site is about 35,000 rows.
- `latest-continuous` with `state_code` gives the most recent value of every time series in the state.
- Paging follows the OGC `next` links (cursor) up to `max_rows` (default 200,000).
- This replaced the legacy NWIS Water Services (waterservices.usgs.gov), which USGS is retiring; the
  `ogcapi/v0` paths still answer but link to `v1`, which the pack uses.

## Access
Earthquakes need no key. Water data work without a key at low volume (USGS states only a few anonymous
requests an hour); an api.data.gov key in `DATA_GOV_API_KEY` (free at https://api.waterdata.usgs.gov/signup/)
raises it to about 1,000 an hour and is sent as the `X-Api-Key` header to api.waterdata.usgs.gov only.
Manual route: links in `manual_download/INSTRUCTIONS.md` (earthquake links: add `&format=csv` for CSV;
water links: `f=csv`, and follow the `next` link for more pages); or the earthquake search page
https://earthquake.usgs.gov/earthquakes/search/ (Output Options > CSV) and https://waterdata.usgs.gov
(site page > download). Upload the files, then `--ingest`.

## Citation and terms
Earthquakes: "U.S. Geological Survey, Earthquake Hazards Program, ANSS Comprehensive Earthquake Catalog
(ComCat), earthquake.usgs.gov, retrieved <date>." Water: "U.S. Geological Survey, USGS Water Data for the
Nation, site <id>, api.waterdata.usgs.gov, retrieved <date>." Public domain (U.S. government works);
credit the USGS. Redistribution allowed.
