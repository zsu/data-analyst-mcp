# National Weather Service API (forecasts, alerts, observations)
Depth: standard. Key: none (an identifying User-Agent is sent). Current U.S. forecasts (7-day and
hourly), active and recent watches/warnings/advisories, and the latest week of station observations.

## When to use
- "What is the forecast", "which warnings are in effect", "current conditions at a station", "alerts
  issued for a state in the last few days".
- **Forecasts are not historical data.** They change every hour and the API keeps no forecast archive;
  report the retrieval time (`generated_at`) with any forecast. Past weather (observed temperature,
  precipitation, normals) comes from noaa; past disasters from fema. The API keeps only the alerts
  issued in the past seven days (`/alerts`; NCEI holds the official archive) and seven days of observations.
- Coverage: the United States and its territories and adjacent waters; other points have no forecast.

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `forecast` | 14 twelve-hour periods (about 7 days): temperature (F), wind, precipitation chance, short and detailed text, plus `office`, `grid_x`, `grid_y`, `generated_at` | `lat`, `lon` |
| `forecast_hourly` | about 156 hourly periods | `lat`, `lon` |
| `point` | one row: forecast office (`gridId`), grid, zones, county, time zone | `lat`, `lon` |
| `alerts_active` | one row per alert in effect now | `area` (state code), `zone`, `point` (lat,lon), `event`, `severity`, `urgency`, `certainty`, `status`, `message_type` |
| `alerts_recent` | alerts issued in the past seven days, newest first (paged); an earlier `start` returns nothing older | the same, plus `start`, `end`, `limit` |
| `alert_types` | every alert event name | none |
| `stations_near` | observation stations near a point, nearest first, with `distance.value` (m) | `lat`, `lon` |
| `observations` | observations at a station (about the last 7 days), newest first | `station` (e.g. KDCA), `start`, `end`, `limit` |
| `observation_latest` | the latest observation | `station` |

## Spec examples
```json
{"description": "Washington, DC: 7-day forecast and the nearest stations",
 "requests": [{"name": "dc_forecast", "endpoint": "forecast", "params": {"lat": 38.8894, "lon": -77.0352}},
              {"name": "dc_stations", "endpoint": "stations_near", "params": {"lat": 38.8894, "lon": -77.0352}, "max_rows": 10}]}
```
```json
{"description": "Weather alerts in effect in New Mexico, and severe ones issued in the past seven days",
 "requests": [{"name": "nm_alerts", "endpoint": "alerts_active", "params": {"area": "NM"}, "allow_empty": true},
              {"name": "nm_recent_severe", "endpoint": "alerts_recent",
               "params": {"area": "NM", "severity": "Severe"}, "allow_empty": true}]}
```
```json
{"description": "Last 24 observations at Reagan National Airport",
 "requests": [{"name": "dca_obs", "endpoint": "observations", "params": {"station": "KDCA", "limit": 24}, "max_rows": 24}]}
```

## Data format and traps
- **Units differ by product.** Forecasts are in U.S. units (`temperatureUnit` F; `windSpeed` text such
  as "5 to 10 mph"). Observations are SI with a unit per field: `temperature.value` in degrees C
  (`wmoUnit:degC`), `windSpeed.value` in km/h, pressure in Pa, visibility and elevation in m. Convert
  explicitly. Blank values are missing sensors; `*.qualityControl` flags (MADIS codes) say how far to trust a value: Z preliminary, no QC;
  C coarse pass (level 1); S screened (levels 1-2); V verified (levels 1-3); Q questioned (passed 1, failed
  2 or 3); X rejected; G / B subjectively good / bad; T air temperature returned where virtual temperature
  could not be computed (https://madis.ncep.noaa.gov/madis_sfc_qc_notes.shtml).
- **Time zones**: forecast `startTime`/`endTime` carry the local offset (-04:00); observation
  `timestamp` and alert times are ISO 8601 with offsets; compare as aware datetimes.
- **Empty is an answer for alerts**: no active alerts in an area is a normal result. Set
  `"allow_empty": true` on alert requests (the pack also reports an empty active-alert result in the
  notes instead of failing).
- Alerts: `id` is the alert URN; `event` names the hazard (Flood Warning, Heat Advisory ...);
  `messageType` alert/update/cancel, so one hazard can appear as several messages; count unique
  `event` + `areaDesc` + `onset` or use `references` to de-duplicate. Alert polygons are not kept.
  `areaDesc` lists zones or counties, separated by "; ".
- `area` takes state and territory codes (VT, PR, GU); marine areas use `region`.
- Points take at most 4 decimal places (the pack rounds). A forecast grid is 2.5 km; offices
  (`gridId`) are 3-letter codes such as LWX.
- Booleans are written `True`/`False` (`isDaytime`). `probabilityOfPrecipitation.value` is a percent
  and may be blank.
- The API sometimes answers 500/503 for a minute when a forecast office's grid is updating; the
  fetcher retries twice, then run again.

## Access
No key. NWS asks clients to send an identifying User-Agent; the pack sends its own, and
`NWS_USER_AGENT` (e.g. "my-analysis (me@example.com)") replaces it. NWS says the User-Agent will be
replaced by an API key in the future (not yet as of 2026-10); if requests start failing with HTTP
401/403, check https://www.weather.gov/documentation/services-web-api for a key. Route `api` when api.weather.gov
answers. Manual route: open the links in `manual_download/INSTRUCTIONS.md` in a browser and save the JSON
(for forecasts, open the point link, then the URL in its `properties.forecast` field, and save that page);
or read https://forecast.weather.gov and https://alerts.weather.gov. Upload the files, then `--ingest`.

## Citation and terms
"National Weather Service, <product, e.g. 7-day forecast for 38.8894,-77.0352 issued <generated_at>>,
api.weather.gov, retrieved <date and time>." NWS information is public domain (U.S. government work;
https://www.weather.gov/disclaimer). Redistribution allowed; credit NWS and do not imply endorsement.
