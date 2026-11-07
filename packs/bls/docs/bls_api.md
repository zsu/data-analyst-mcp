# BLS Public Data API cheat sheet

The `fetch` tool already handles all of this. Read this file when you debug an API problem or need a feature
the bls spec does not expose. Behaviors marked ✔ were tested on 2026-10-19.

## Versions and limits (https://www.bls.gov/developers/api_faqs.htm)
| | v2, registered key | v1, no key |
|---|---|---|
| Queries per day | 500 | 25 |
| Series per query | 50 | 25 |
| Years per query | 20 | 10 |
| Requests per 10 seconds | 50 | 50 |
| Annual averages, catalog (titles), net/percent changes | yes | no |

- Register at https://data.bls.gov/registrationEngine/ (email + organization; the key arrives by email
  from labstat@bls.gov). **Keys expire after a year**; a rejected key that used to work is usually expired.
- Daily limits are per key (v2) or per IP address (v1). This server does not count the queries used today;
  only BLS knows how many remain, and it says so only by refusing once the limit is used up.
- Calling v2 without a key works ✔ but gets v1 limits and no catalog ("The catalog has been disabled for
  this request").

## Endpoint
`POST https://api.bls.gov/publicAPI/v2/timeseries/data/` (or `/v1/`) with `Content-Type: application/json`:
```json
{"seriesid": ["LNS14000000", "CES0000000001"], "startyear": "2015", "endyear": "2024",
 "annualaverage": true, "catalog": true, "calculations": true, "aspects": false,
 "registrationkey": "<key>"}
```
- `GET .../timeseries/data/<SERIES_ID>` returns the last three years of one series; `?latest=true` the latest value.
- A bare GET of the endpoint returns HTTP 415 and costs no query ✔ (it shows the host is reachable, but not
  whether POSTs are blocked: see HTTP 503 below).
- Responses:
  `{"status": "REQUEST_SUCCEEDED", "message": [...], "Results": {"series": [{"seriesID", "data": [...], "catalog"?}]}}`.
  Each observation: `{"year": "2026", "period": "M09", "periodName": "September", "latest": "true",
  "value": "4.2", "footnotes": [{"code": "P", "text": "preliminary"}], "calculations"?: {...}}`.

## Gotchas (all handled by fetch; check for them in any code you write yourself)
- **HTTP 200 even on failure ✔.** Read `status` and `message`. A rejected key gives
  `REQUEST_NOT_PROCESSED` and a message that **echoes the key** ✔, so always pass messages through `redact()`.
- **Silent truncation ✔.** Asking v1 for more than 10 years returns `REQUEST_SUCCEEDED` with only 10 years
  and the message "Year range has been reduced to the system-allowed limit of 10 years." fetch splits
  the request so this never happens and stops if it does.
- **Bad series IDs do not fail the request ✔.** The series comes back with `"data": []` and a message such as
  "Series does not exist", "Database is locked for Series X" or "No Data Available for Series X Year: 2024".
  fetch lists them in `problems`.
- **Missing values ✔** come as `"value": "-"` with a footnote, for example code `X` / `9` "Data unavailable due
  to the 2025 lapse in appropriations" (October 2025 CPI, CPS and LAUS were not collected) or code `10`
  (CPS weekly earnings, 2025 Q4 not produced). They are empty in `bls_series.csv`.
- **"Unable to get Catalog Data for series X" ✔** can come back for some series (JOLTS, for example) even on v1,
  which never asks for the catalog. It is informational: the data are complete. It is kept in
  `series.csv` `bls_messages`; titles then come from data.bls.gov (`request_schema` search `describe <ID>`).
- **Preliminary values ✔** carry footnote code `P` (CES: the two latest months; JOLTS and LAUS: the latest).
- **Population controls ✔.** CPS January values carry footnote code `12` when new population controls were
  introduced: levels (employment, labor force) are not comparable from December to January; rates are
  little affected. Say so when comparing levels across January.
- **Periods:** `M01`–`M12` months, `M13` annual average (v2 with `annualaverage`), `Q01`–`Q04` quarters,
  `Q05` annual average of a quarterly series, `S01`/`S02` half-years, `S03` annual, `A01` annual (OEWS).
- **Calculations** (v2): `net_changes` and `pct_changes` over 1, 3, 6 and 12 months, BLS's own numbers.
  They are the best benchmark for changes you compute (`bls_pct_12m` etc. in `bls_series.csv`).
- HTTP 429 means the rate or daily limit was hit; the client backs off once, then fetch fails with
  `agency_unavailable` (the daily limit resets the next day).
- HTTP 503 "The BLS website is busy" (an HTML page) can answer POSTs for hours while the bare GET still
  answers 415 (seen 2026-10-22); after retries fetch fails with `agency_unavailable`.

## Other BLS data services (not used by fetch)
- QCEW has its own open-data CSV slices (https://www.bls.gov/cew/additional-resources/open-data/); QCEW
  series (prefix EN) are also in the time-series API.
- Bulk flat files (download.bls.gov/pub/time.series/) need a User-Agent with a contact email; this pack does
  not use them. A very large request (hundreds of series) is split across days or narrowed instead.
- Web pages on www.bls.gov often answer HTTP 403 to scripts and to WebFetch. Read publications in the
  browser, or through the Wayback Machine (`https://web.archive.org/web/<year>/<url>`), and cite the original URL.
  `https://data.bls.gov/timeseries/<ID>` (series titles, used by the `request_schema` search `describe <ID>`)
  does answer scripts ✔.
