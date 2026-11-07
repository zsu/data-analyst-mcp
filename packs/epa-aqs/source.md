# EPA Air Quality System (AQS) Data Mart API
Depth: standard. Key: required (AQS_API_KEY plus AQS_EMAIL). Ambient air pollution measured at
thousands of U.S. monitors: criteria pollutants (ozone, PM2.5, PM10, SO2, CO, NO2, lead) and more, as
annual, quarterly or daily summaries, raw samples, and monitor metadata. Historical data only.

## When to use
- Measured pollutant concentrations by state, county, site, CBSA or box; annual means and percentiles;
  daily values during episodes (wildfire smoke); which monitors operate where.
- Not here: facility emissions, toxic releases, compliance (epa: GHGRP, TRI, ECHO); today's AQI and
  forecasts (AirNow, not covered); the UV index (epa). Without a key, annual and daily summaries come
  from EPA's AirData yearly files through `--ingest` (see Access).

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `data` | rows of one AQS service | `service` (annualData, quarterlyData, dailyData, sampleData, monitors), `geo` (byState, byCounty, bySite, byCBSA, byBox), `param`, `bdate`, `edate`, `state`, `county`, `site`, `cbsa`, `minlat`/`maxlat`/`minlon`/`maxlon`, `duration`, `cbdate`/`cedate` |
| `list` | code lists | `list` (states, countiesByState, sitesByCounty, cbsas, classes, parametersByClass, pqaos, mas; there is no durations list: duration codes are on AQS's code-table pages), `state`, `county`, `pc` |

`param` aliases: `ozone` 44201 (ppm), `pm25` 88101 (FRM/FEM, ug/m3), `pm25_nonfrm` 88502, `pm10` 81102,
`so2` 42401 (ppb), `co` 42101 (ppm), `no2` 42602 (ppb), `lead` 14129 (ug/m3); or up to 5 codes
comma-separated. Geography needs: byState `state`; byCounty `state`+`county`; bySite +`site`; byCBSA
`cbsa`; byBox the four bounds. States may be FIPS (06), USPS (CA) or names; the pack converts them.

## Spec examples
```json
{"description": "Annual ozone summaries for every Vermont monitor, 2022-2023",
 "requests": [{"name": "vt_ozone", "endpoint": "data",
   "params": {"service": "annualData", "geo": "byState", "param": "ozone", "bdate": "20220101",
              "edate": "20231231", "state": "VT"}}]}
```
```json
{"description": "Daily PM2.5 in Los Angeles County, June 2024",
 "requests": [{"name": "la_pm25_daily", "endpoint": "data",
   "params": {"service": "dailyData", "geo": "byCounty", "param": "88101", "bdate": "20240601",
              "edate": "20240630", "state": "06", "county": "037"}}]}
```
```json
{"description": "Ozone monitors in North Carolina operating in 2024",
 "requests": [{"name": "nc_monitors", "endpoint": "data",
   "params": {"service": "monitors", "geo": "byState", "param": "44201", "bdate": "20240101",
              "edate": "20241231", "state": "37"}}]}
```

## Data format and traps
Unverified: the pack was built without a key, so the summary column names below (pollutant_standard,
sample_duration, observation_percent, event_type ...) follow the AQS documentation and AirData file
layouts, not a live response; check `data_dictionary.csv` after the first fetch.
- **Same-year rule**: `bdate` and `edate` must be in one calendar year (except `monitors`). The pack
  splits a longer range into one call per year (notes say how many). Annual and quarterly services use
  only the year part of the dates and return whole years.
- **Several rows per monitor**: summaries have one row per site x parameter x POC (parameter occurrence
  code: several instruments at one site) x `sample_duration` x `pollutant_standard` (and for daily
  data per day). Filter `pollutant_standard` (e.g. "Ozone 8-hour 2015", "PM25 Annual 2012") and
  `sample_duration` before averaging, or values are double counted.
- Statistics differ by standard: ozone compliance uses the 4th-highest daily maximum 8-hour average;
  PM2.5 annual uses `arithmetic_mean`, 24-hour uses the 98th percentile (`ninety_eighth_percentile`).
  These are monitor statistics, not official design values (EPA publishes those separately).
- Units are per parameter (`units_of_measure`): ozone and CO in ppm, SO2 and NO2 in ppb, PM in
  micrograms per cubic meter (local conditions for PM2.5, STP for PM10).
- Completeness: `observation_percent` and `validity_indicator` say whether a year meets data
  requirements; exclude incomplete years from trends. `event_type` separates values with and without
  exceptional events (wildfire smoke): "No Events", "Events Included", "Events Excluded".
- Data lag about 6 months and are revised until certified (`certification_indicator`,
  `date_of_last_change`).
- `sampleData` (hourly or finer) is very large: one site, one parameter, short periods. AQS asks for at
  most 1,000,000 rows per request.
- AQS returns HTTP 200 with Header status "No data matched your selection" for an empty result, and
  "Failed" (or HTTP 400) with an error list for a bad request. The documentation's example responses
  call the row list "Body"; the live API calls it "Data" (both are read).
- Codes are text with leading zeros: state "06", county "037", site "0014"; keep them as text.

## Access
Key required: a free AQS key is emailed after a sign-up request (open
https://aqs.epa.gov/data/api/signup?email=YOUR_EMAIL with your address). Store the key in `AQS_API_KEY`
(the setup script) and the registered email in `AQS_EMAIL` (an environment variable or the same
"env" block of keys.json, where the setup script puts both); both are sent as query parameters and never recorded. Limits (AQS terms):
no more than 10 requests a minute, a 5-second pause between requests, one request at a time; the pack
waits 5 seconds between calls, so multi-year requests take a while. Accounts that break the terms may be
disabled. Without a key (`keyless_file` in `--check`): EPA's AirData yearly files hold the same annual and
daily summaries for every U.S. monitor, at https://aqs.epa.gov/aqsweb/airdata/ (list:
download_files.html): `annual_conc_by_monitor_<year>.zip` (all parameters, about 4 MB) for `annualData`,
`daily_<code>_<year>.zip` (one parameter, 2-10 MB; e.g. daily_88101_2023.zip) for `dailyData`; one file per
year; sizes checked 2026-10-28 (hourly files are 70+ MB: not a keyless route here). Give the .zip as
downloaded (or its CSV) to `--ingest` with the same spec: it keeps the rows the spec asks for (state,
county, site or box, parameter, dates; never filter by hand) and renames the columns to the API's names
where they differ (`site_num` -> `site_number`, `parameter_name` -> `parameter`, `1st_max_value` ->
`first_max_value`, `98th_percentile` -> `ninety_eighth_percentile`, ...). Daily requests take one parameter
code each; `quarterlyData`, `sampleData`, `monitors` and `byCBSA` (the files carry CBSA names, not codes)
need the key. AirData files are rebuilt about twice a year, so they can lag the API. Or
https://www.epa.gov/outdoor-air-quality-data (a browser page). With a key elsewhere: the links in
`manual_download/INSTRUCTIONS.md` (replace `{API_KEY}` and `{AQS_EMAIL}`). Then `--ingest`.

## Citation and terms
"U.S. Environmental Protection Agency, Air Quality System (AQS) Data Mart, <service, parameter,
geography>, aqs.epa.gov/data/api, retrieved <date>." Public domain (U.S. government work);
redistribution allowed. Terms of service (request limits): https://aqs.epa.gov/aqsweb/documents/data_api.html.
