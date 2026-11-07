# Bureau of Labor Statistics Public Data API
Depth: deep. Key: optional (BLS_API_KEY). BLS time series: jobs (CES, CPS, JOLTS), prices (CPI, PPI), wages
(CES earnings, ECI, OEWS), productivity, and state, metro and county labor markets (LAUS, state CES).

## When to use
- Unemployment (U-3, U-6), participation, payrolls by industry, job openings and quits, CPI and its
  components, PPI, average hourly earnings and real wages, the ECI, productivity and unit labor costs,
  state and county unemployment (LAUS), state payrolls, wages by occupation (OEWS), QCEW series (prefix EN).
- Questions phrased as "the jobs report", "inflation", "wage growth", even with no series ID: picking and
  verifying the ID is your job, never a question for the user.
- Not here: PCE prices, GDP, income (bea; fred mirrors them); interest rates and budget series (fred,
  treasury); worker microdata (ipums CPS); federal employees (opm). FRED mirrors many BLS series, but this
  pack keeps BLS's preliminary flags, footnotes and gaps.

## Endpoints and datasets
| What | How | Notes |
|---|---|---|
| Time series data | spec `series` / `build` → POST `api.bls.gov/publicAPI/v2` (key) or `/v1` (no key) | monthly (M01-M12), quarterly (Q01-Q04), semiannual (S01-S02), annual (A01; M13/Q05/S03 = BLS annual averages, v2 only) |
| Series titles | `request_schema` search `describe ID ...` (or just the IDs; data.bls.gov/timeseries/ID; no key, no query used) | read title, SA/NSA, units back against the concept; a missing title = no such ID, except OEWS (OE...), whose IDs are only decoded from their layout (a `note` says so) |
| Offline decode | `request_schema` search `decode ID ...` | survey prefix and S/U code |
| Topic catalog | `request_schema` search `"words"` (offline, about 70 common series by topic: employment, unemployment, wages, cpi, cpi_components, ppi, productivity, jolts, oews) | |
| ID builders | spec `build` entries: `{"kind": "laus", "state": "MD", "measure": "unemployment_rate", "seasonal": "U"}`, `{"kind": "laus", "county": "24005"}`, `{"kind": "ces_state", "state": "MD", "industry": "<8 digits>"}`, `{"kind": "state", "state": "MD"}`, `{"kind": "oews", "occupation": "15-1252", "state": "MD", "measure": "annual_median_wage"}`, `{"kind": "jolts", "industry": "all", "measure": "quits"}` (national JOLTS by industry; rate, or level with `"rate": false`). The search `build {json}` previews the IDs an entry makes | patterns and measures in docs/series_ids.md §4; `request_schema` names `["build"]` lists every kind's parameters |

Verified common IDs (docs/series_ids.md has the full table and the ID structure of every survey):
U-3 `LNS14000000` (NSA `LNU04000000`); U-6 `LNS13327709`; participation `LNS11300000`; prime-age
employment-population ratio `LNS12300060`; payrolls `CES0000000001` (thousands); private AHE
`CES0500000003`; CPI-U all items `CUUR0000SA0` (NSA) / `CUSR0000SA0` (SA); core `CUUR0000SA0L1E`; CPI-W
`CWUR0000SA0`; chained CPI-U `SUUR0000SA0`; PPI final demand `WPSFD4`; job openings `JTS000000000000000JOL`;
quits rate `JTS000000000000000QUR`; ECI `CIS1010000000000I`; productivity `PRS85006092`; state
unemployment `LASST<fips>0000000000003`.

## Spec examples
```json
{"description": "CPI-U all items, U.S. city average, 2017-2026",
 "series": [{"id": "CUUR0000SA0", "label": "CPI-U all items (NSA)"}],
 "start_year": 2017, "end_year": 2026}
```
```json
{"description": "Unemployment rate and nonfarm payrolls, 2017-2026",
 "series": [{"id": "LNS14000000", "label": "Unemployment rate"},
            {"id": "CES0000000001", "label": "Total nonfarm payrolls"}],
 "start_year": 2017, "end_year": 2026}
```
```json
{"description": "Maryland labor market and software developer wages",
 "series": ["LNS13327709"],
 "build": [{"kind": "state", "state": "MD"}, {"kind": "laus", "county": "24005"},
           {"kind": "oews", "occupation": "15-1252", "measure": "annual_median_wage", "state": "MD"}],
 "start_year": 2025, "end_year": 2026}
```
Options: `annual_average`, `calculations` (BLS's 1/3/6/12-month changes, the best benchmark) and `catalog`
need a key; without one they are dropped and request.json records that. Ask for one extra year before the
start when computing 12-month changes. Tools: `request_schema` (the spec format; a search such as
`describe CUUR0000SA0` gives a series' title and dimensions), `fetch` with the spec (without a key it takes the
keyless route and drops the key-only options), and `manual_bundle` then `ingest` for files the user downloads.

## Data format and traps
Output in `data/bls/`: `bls_series.csv` (series_id, label, year, period, period_name, freq, date,
value, value_raw, preliminary, footnote_codes, footnotes, latest; plus `bls_net_*m` / `bls_pct_*m` with
calculations), `series.csv` (title, title_source, survey, seasonal, frequency, first/last period, n_obs,
n_missing, n_preliminary, has_annual_average, bls_messages), `raw/response_NN.json`, `request.json`, `README.md`.
Build tables from `bls_series.csv` with `compute` (filter by series_id, `pivot_wider` on date for one column per
series) and register cited numbers with `facts`.
- **Wrong series is the classic silent error**: SA vs NSA (third letter S/U), U-3 vs U-6, all employees vs
  production workers, levels in thousands (CES, CPS, JOLTS levels) vs rates, CPI is an index (1982-84=100),
  never a price. Read every title (`request_schema` search with the IDs) before use.
- **Missing values**: BLS shows `-` (value empty, footnote says why), or returns no row at all for the period
  (some CPI items in November 2025): `series.csv` counts both in `n_missing` and lists the second kind in
  `absent_periods`. October 2025 was not collected for the CPI, CPS and LAUS (lapse in appropriations); CPS weekly earnings 2025 Q4 not produced. A change across a
  gap is missing: match each value to the period a month or year earlier by date, never by row position (a
  `lag()` over rows silently steps over an absent period). BLS's FAQ on the lapse says
  October 2025 rents were carried forward from April 2025, which held down shelter and core CPI from November
  2025 to about April 2026: say so when a change spans those months.
- **Preliminary values** carry footnote `P` (`preliminary` = 1) per series, not per row: national CES the two latest (state and metro CES, SM, only the latest)
  months, JOLTS and LAUS the latest month. Label them "preliminary" wherever cited. Import/export price
  indexes (MXP, `EI...`) are revised for three months after release but carry no `P` flag: register those
  months in `facts` with `preliminary: true` yourself. MXP indexes are not seasonally adjusted (use NSA for every change).
- **Revisions**: CES revises two prior months each release and benchmarks each February; CPI seasonal
  factors are revised each February for five years; LAUS and state CES are model-based and revised each
  March; chained CPI-U is interim for 10 to 12 months. State the retrieval date.
- **Federal employment (CES)**: `CES9091000001` federal, `CES9091100001` except USPS (the closest match to
  OPM's FWD, which leaves out USPS), `CES9091912001` USPS. CES counts anyone paid for the pay period that
  includes the 12th: employees on paid leave or ongoing severance and furloughed staff paid later are
  employed, so 2025's deferred resignations left CES only when they came off payrolls (October 2025, first
  printed as -179,000; Economics Daily, "Federal employment reached lowest level since 2014"). OPM counts
  on-board staff on the month's last day: the two differ in timing as well as coverage.
- **CPS January population controls** (footnote 12): levels jump December to January; compare rates.
- **BLS answers HTTP 200 on failure**; the pack checks `status`. A bad ID returns no data with a message
  ("Series does not exist", "No Data Available for Series X Year: 2026"): fetch lists it in `problems`.
  v1 silently truncates to 10 years; the pack splits requests so this cannot happen and stops if it does.
- **OEWS** (period A01) returns only the latest survey year (2025 on 2026-10-20), with May of that year as
  the reference period (the CSV's July 1 `date` is a placeholder). BLS still defines a top-code footnote
  ("equal to or greater than $115.00 per hour or $239,200 per year", May 2025), but values above it are
  published as point estimates when BLS has them (anesthesiologists' national median 391,490 with no
  footnote, verified 2026-10-22): read `footnotes` per value; only a footnoted value is a bound ("at least"). County LAUS is NSA only and lags a month.
- **Productivity and costs (PR)**: BLS's annual change comes from annual output over annual hours, not the
  mean of the quarterly indexes (2025 productivity on 2026-10 data: quarterly mean 2.5, published 2.1): take annual PR
  figures from the release's annual table (save it in published/) or the annual period. The latest quarters
  are revised each release without a `P` flag: register them in `facts` with `preliminary: true`.
- **Annual medians**: CPS median usual weekly earnings (LEU/LES, quarterly) have annual medians that BLS
  computes from the year's sample, not from the quarters (2024 high school graduates: published 930, mean of
  quarters 935). Take them from v2 `annual_average` (period Q05), from FRED's annual copies (`<id>A`, e.g.
  `LEU0252917300A`, identical to BLS's tables) or from the annual table (cpsaat37) in `published/`.
  By education (25 and over, full time): `request_schema` search `"weekly earnings education"`.
- **Annual averages**: prefer BLS's M13 (v2 + `annual_average`); never average a year with a missing month. Without a key, a mean of the 12 published (rounded) months can miss BLS's annual
  average by 0.1 (2019 prime-age women's participation rate, LNU01300062: 76.05 rounds to 76.1, BLS publishes 76.0
from unrounded months; a mean that lands exactly on .x5 is a tie whichever way it rounds):
  use BLS's published annual table (e.g. cpsaat03) in `published/` for the headline and show the computed
  mean as the cross-check.
- **Rounding like BLS**: index percent changes from the published three-decimal values, rounded to one
  decimal; rates to one decimal; payroll changes to the nearest thousand.
- **Significance**: monthly changes are "statistically significant" only beyond the published 90-percent
  thresholds (CES about 122,000; unemployment rate about 0.3 point); otherwise
  "little changed". Thresholds and other conventions: docs/analysis_patterns.md.
- Choices that change headline numbers (measure, SA/NSA, baseline, deflator): docs/analysis_patterns.md §1.

## Access
- Key: optional, free at https://data.bls.gov/registrationEngine/ (emailed in minutes; **expires after a
  year**). The user stores it with `npx -y data-analyst-mcp setup bls` in their own terminal; the server reads it
  from BLS_API_KEY, BLS_API_KEY_FILE, keys.json, Claude Code settings.json or ~/.bls/api_key.
- Limits: v2 with a key 500 queries a day, 50 series and 20 years per query; v1 without a key 25 queries a
  day (per IP), 25 series and 10 years per query; 50 requests per 10 seconds. fetch splits the request into
  queries that fit these limits; it does not count the queries used today. BLS sometimes answers POSTs with
  HTTP 503 "The BLS website is busy" (an HTML page) for hours (seen 2026-10-22, cleared the same day); fetch
  then fails with `agency_unavailable`. Fetch once more later (do not loop), or use the fred pack for series FRED
  mirrors (same values, but no preliminary flags or footnotes; FRED carries the headline CPS series, not detail
  such as the prime-age ratios by sex LNS12300061/62).
- How fetch proceeds: a folder that already holds the same request is reused (`force: true` downloads again;
  after a week BLS has probably published newer data). With a working key it uses v2. With no key, or a
  rejected one, it takes keyless v1 when the request fits (25 queries a day): mention once that a key raises
  the limits. A request too big for v1 with no key fails with `key_missing`: the user stores a key with
  `npx -y data-analyst-mcp setup bls` in their own terminal; never ask for the key in chat. A used-up daily
  limit fails with `agency_unavailable` (it resets the next day). A spec problem fails with `invalid_request`.
- Manual download: `manual_bundle` writes `manual_download/` with INSTRUCTIONS.md, `download_data.sh`,
  `download_data.ps1`, spec.json and `manifest.json` (the POST requests built into both scripts, kept as a
  record). Send the user INSTRUCTIONS.md and the scripts. Each script is self-contained and runs with one command
  (`bash ~/Downloads/download_data.sh`, or `powershell -NoProfile -ExecutionPolicy Bypass -File
  "$HOME\Downloads\download_data.ps1"`); it asks for the key with hidden input only when the request needs
  v2 (`BLS_API_KEY` wins), saves `response_NN.json` next to itself and lists them for upload. Then call
  `ingest` with the uploaded files or their folder; it reports any series and years no response covers.
- Key handling: BLS echoes a rejected key in its error text; the pack registers a 32-hex redaction pattern
  and scrubs every message, raw file and request.json. Never print, log or pass the key on a command line.

## Citation and terms
- Citation: "U.S. Bureau of Labor Statistics, <series IDs>, retrieved <Month D, YYYY> through the BLS Public
  Data API (https://www.bls.gov/developers/)." `data/bls/README.md` has it filled in.
- Required statement (terms of service, https://www.bls.gov/developers/termsOfService.htm), with the
  retrieval date, wherever BLS data are published: "BLS.gov cannot vouch for the data or analyses derived
  from these data after the data have been retrieved from BLS.gov." Never use the BLS logo.
- Redistribution: allowed. BLS data are U.S. government works in the public domain; the data and raw
  responses may go in a replication package.
- Audit hooks in policy.json: the report must state the retrieval date, carry the statement, call cited
  preliminary values preliminary, and keep `data/bls/request.json`.
- Long references: docs/series_ids.md (ID structure, verified IDs, builders, common ID mix-ups),
  docs/analysis_patterns.md (critical questions, conventions, significance, report layout),
  docs/bls_api.md (API behaviour and errors, checked live).
