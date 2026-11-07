# FRED, ALFRED and GeoFRED (Federal Reserve Bank of St. Louis)
Depth: deep. Key: optional (FRED_API_KEY). Over 800,000 U.S. and international economic series (GDP and
potential output, prices, rates, budget, labor, states), their past vintages (ALFRED), state and county
cross-sections (GeoFRED), and FRED's release calendar.

## When to use
- GDP, potential output and the output gap, PCE and CPI inflation (CPI-W for COLAs, chained CPI), interest
  rates and Treasury yields, the federal deficit, debt and net interest by fiscal year, recessions (USREC),
  state comparisons, and anything about revisions ("as first reported", "as published on a date").
- When a release comes out (`release_dates`), or every series of one release at once (`release_observations`).
- Not here: BLS detail with preliminary flags, footnotes and significance thresholds (bls); BEA tables with
  line numbers and vintages (bea); Treasury daily statements and auctions (treasury); budget projections
  (use the agency's own files). FRED mirrors BLS and BEA series: prefer the original pack when its flags matter.

## Endpoints and datasets
| What | How | Key |
|---|---|---|
| Series data, latest | spec `series` → API `series/observations`, or keyless `fredgraph.csv` | optional |
| As-of vintages | `"vintage": {"as_of": [dates]}` → API `vintage_dates`, or keyless `alfredgraph.csv` | optional |
| First release / full revision history | `"vintage": "first_release"` / `"all"` (real-time window 1776-07-04..9999-12-31) | required |
| FRED-side transforms / frequency conversion | `units` (pc1, pca ...), `frequency` + `aggregation_method` (prefer your own computation from native data) | optional |
| Series metadata | `request_schema` search `describe IDs` (API: title, units, frequency, SA, source, release, notes; keyless: XLSX README sheet) | optional |
| Search | `request_schema` search `"words" [limit N]` (`series/search`, by popularity) | required |
| Vintage dates | `request_schema` search `vintagedates ID` | required |
| GeoFRED cross-section | spec `regional`: `[{"series_id": "CAUR", "region_type": "state", "date": "2025-01-01"}]` (group found from any member) | required |
| Release calendar | `request_schema` search `release_dates [ID] [START] [END]` (20 rows shown) or spec `release_dates` → `release_dates.csv` | required |
| Whole release | spec `release_observations`: `[{"release_id": 53, "limit": 10000, "max_pages": 5, "series": [IDs]}]` (FRED API v2, cursor-paged) | required |
Common releases: 10 CPI, 50 Employment Situation, 53 GDP, 18 H.15 interest rates. Verified IDs by topic
(output, prices, labor, rates, budget, income, recessions, states): docs/series.md.

## Spec examples
```json
{"description": "Output gap since 2007",
 "series": [{"id": "GDPC1", "label": "Real GDP"}, {"id": "GDPPOT", "label": "Real potential GDP"}],
 "start": "2007-01-01", "recessions": true}
```
```json
{"description": "Real GDP 2020 Q2: first release vs. two later vintages",
 "series": [{"id": "GDPC1", "start": "2020-04-01", "end": "2020-04-01", "vintage": "first_release"},
            {"id": "GDPC1", "start": "2020-04-01", "end": "2020-07-01", "vintage": {"as_of": ["2020-08-27", "2021-07-29"]}}]}
```
```json
{"description": "Net interest as a share of GDP, fiscal years",
 "series": [{"id": "FYOINT"}, {"id": "GDP"}, {"id": "FYOIGDA188S", "label": "benchmark"}], "start": "1999-01-01",
 "release_dates": {"release_id": 53, "start": "2026-10-01", "end": "2026-12-31"}}
```
Per series (or globally): `start`, `end`, `vintage`, `units`, `frequency`, `aggregation_method`; packaging
only: `label`, `source`, `copyright` (`public_domain` / `citation_required` / `preapproval_required`) with
`copyright_basis`. Request only what the question needs (FRED's terms forbid wholesale downloading).
Tools: `request_schema` (the spec format; a search finds series, with a key), `fetch` with the spec (without a key
it takes the keyless route when the request needs no key-only feature), and `manual_bundle` then `ingest` for files
the user downloads.

## Data format and traps
Output in `data/fred/`: `fred_observations.csv` (series_id, label, variant, vintage, date, value,
realtime_start, realtime_end), `series.csv` (title, units, frequency, seasonal_adjustment, last_updated,
fiscal_year, first/last date, n_obs, n_missing, n_future, source, release, copyright, citation, notes),
`regional.csv`, `release_dates.csv`, `release_series.csv` + `release_observations.csv`, `raw/`,
`request.json`, `README.md`. Build tables with `compute` (filter by variant, `pivot_wider` on date for one column
per series) and register cited numbers with `facts`. Read `series.csv` and the README's "Read this before
analyzing" first.
- **Keys of a row**: `variant` = ID plus a suffix per option that changes the data (`GDPC1_asof`,
  `CPIAUCSL_pc1`, `GDP_aavg`, `GDPC1_first_release`); `vintage` = `latest`, the as-of date, `first_release`,
  or (full history) the publication date. Filter one variant and `pivot_wider` on `vintage` to put each vintage
  in a column.
- **Units**: millions vs billions (FYOINT millions, GDP billions: divide FYOINT by 1,000 before the share); SAAR
  levels are already annual rates (average quarters, never sum); index levels are not prices.
- **Missing values** are empty (`.` in the API). October 2025 was not collected for CPI, CPS, LAUS. FRED's own
  frequency conversion averages whatever exists (a quarter with a missing month still gets a value): prefer
  native data and convert only complete periods (count the months in each; `compute`'s `to_fiscal` flags
  incomplete fiscal years).
- **Projections are not data**: GDPPOT, NGDPPOT and NROU run about ten years ahead (`n_future` > 0);
  drop periods that have not ended (2026 Q4 on 2026-10-20) before computing anything from them.
- **Fiscal years** (October to September): dollar series are dated at the fiscal year's end (2025-09-30 =
  FY2025), ratio series at January 1 of the fiscal year's number; `compute`'s `fiscal_year` maps both. FRED's
  FY*GDA188S ratios divide by calendar-year GDP, and are updated about once a year (OMB data), so their GDP
  can predate BEA's latest annual update (FYOIGDA188S FY2025, updated April 2026: 3.15 against 3.18 on
  fiscal-year GDP of the September 2026 vintage): a fiscal-year-GDP ratio differs by a few hundredths;
  name both causes, with the series' `last_updated`, when the benchmark misses.
- **Vintages**: compare growth rates and ratios across vintages, not levels (real GDP was in 2012 dollars
  before September 2023, 2017 dollars since); `units` in series.csv is FRED's label today. First release
  needs the whole real-time window (else HTTP 400 "No vintage dates exist"); an as-of vintage ends where that
  vintage's data ended (later dates are absent, not missing). In as-of rows `realtime_start` is FRED's window
  clipped to the as-of date, not the date the value was first published: for publication dates ask
  `"vintage": "all"`. Not every vintage is a revision: some only
  change the number of decimals or leave periods empty, and a comprehensive update can arrive in several
  vintages. Find updates by changes larger than rounding over the periods both vintages hold.
- **Keyless limits**: a graph download holds at most 12 series (with as-of vintages fetch asks 12 at a
  time); mixed
  frequencies come as a zip; an unknown ID answers HTTP 404 with an HTML page. The keyless route gives no
  source, notes or copyright (`copyright` = `unknown`): for a report, read the tag on each series page
  (https://fred.stlouisfed.org/series/ID: "Public Domain: Citation Requested", "Copyrighted: Citation
  Required", "Copyrighted: Pre-Approval Required"; ignore the generic banner) and add `source`, `copyright`,
  `copyright_basis` to the spec; fetching again rebuilds data/fred/ from raw/ without downloading.
- With a key, `copyright` comes from the series' FRED tag (`public_domain`, `citation_required`,
  `preapproval_required`; `copyright_basis` names the tag; verified 2026-10). Only when the tag cannot be read
  does it fall back to the notes (`copyrighted` / `no_copyright_notice`), and `no_copyright_notice` is not
  proof of public domain: read the series page. `release_series.csv` carries FRED's own tag (v2 `copyright_id`).
- Keyless graph CSVs can carry one more digit than the API (GDPPOT differs in the 17th significant digit).
- Metro CPI IDs on FRED often keep BLS's pre-2018 area codes: FRED `CUURA101SA0` (New York) is BLS
  `CUURS12ASA0`, `CUURA207SA0` (Chicago) is `CUURS23ASA0`; the values are identical (checked 2026-10-22), but
  the bls pack and data.bls.gov answer "not found" for the FRED ID. Current codes: BLS's cu.area list.
- GeoFRED: trust the date key; the title can name a later month. `release_observations` stops after
  `max_pages` (README notes the next cursor); filter with `series`.
- Choices that change headline numbers, benchmarks, report layout: docs/analysis_patterns.md. API details
  and errors (checked live): docs/fred_api.md.

## Access
- Key: optional, free at https://fredaccount.stlouisfed.org/apikeys (one per user; never share or embed
  one). The user stores it with `npx -y data-analyst-mcp setup fred` in their own terminal (FRED answers HTTP 400
  naming api_key when it rejects a key); the server reads FRED_API_KEY, FRED_API_KEY_FILE, keys.json,
  Claude Code settings.json or ~/.fred/api_key. v1 takes it as `api_key` (dropped from every recorded URL); v2
  (release observations) as `Authorization: Bearer` (a query key answers HTTP 401).
- Limits: 120 requests a minute (the client paces at 1.8 a second), 100,000 observations per call (paged).
- How fetch proceeds: a folder that already holds the same request is reused (also when only labels, sources
  or copyright changed: it is rebuilt from raw/; `force: true` downloads again). With a stored key it uses the
  API. Without one it takes FRED's keyless graph downloads when the request needs no key-only feature: mention
  once what a key adds. A key-only feature with no key fails with `key_missing`: the user stores a key with
  `npx -y data-analyst-mcp setup fred` in their own terminal; never ask for the key in chat; offer as-of
  vintages or explicit state IDs instead. A spec problem fails with `invalid_request`.
- Manual download: `manual_bundle` writes `manual_download/INSTRUCTIONS.md`, which lists one browser link per
  keyless file (no key, no software) plus one command per OS (`bash ~/Downloads/download_data.sh`, or
  `powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\download_data.ps1"`). Each script has
  the requests built in, asks for the key with hidden input only when a request needs one (`FRED_API_KEY`
  wins), and saves next to itself. The scripts make one request per file: they cannot send v2's Bearer header
  (whole releases need a fetch with a key) or chain GeoFRED's two-step lookup (put `series_group` in the spec's
  `regional` block to make it one step). Send INSTRUCTIONS.md and both scripts. The user uploads every file
  unchanged; then `ingest` with the uploaded files or their folder reads the CSV, XLSX and JSON files (release
  pages are merged).

## Citation and terms
- Cite each series as FRED suggests (in `series.csv` and the README): "U.S. Bureau of Economic Analysis, Real
  Gross Domestic Product [GDPC1], retrieved from FRED, Federal Reserve Bank of St. Louis;
  https://fred.stlouisfed.org/series/GDPC1, October 20, 2026."
- Required notice in any product built on the API: "This product uses the FRED® API but is not endorsed or
  certified by the Federal Reserve Bank of St. Louis." Never use the FRED or St. Louis Fed logo.
- Cache: none. FRED's terms (https://fred.stlouisfed.org/docs/api/terms_of_use.html,
  https://fred.stlouisfed.org/legal/) forbid archives and wholesale downloads; only this run's data/fred/
  copy is kept.
- Redistribution: allowed with citation, except series tagged Copyrighted: Pre-Approval Required (S&P, some
  Moody's and ICE indexes): policy.json `withhold` drops their rows (series.csv `copyright` =
  `preapproval_required`) from shared files unless the user has the owner's permission (record it).
