# OPM Federal Workforce Data API cheat sheet

`sources/opm/opm_api.py` and `sources/opm/fetch.py` (run as `scripts/fetch.py --source opm`) implement all of this. Read this file when debugging or
when you need something `spec.json` does not expose. Source: https://data.opm.gov/get-data/api-access
(checked October 2026; the page is a JavaScript app, so read it in a browser, not with curl).

## Basics
- Base URL `https://data.opm.gov/api/v1/files`. **No authentication, no key, no account.**
- Data are public (OPM releases them under its Public Data Release Policy), so the filtered data may ship
  with a report and its replication package.
- OPM releases each month's data about five weeks after the month ends (for example, August data on
  October 7). The FWD Data Sources page shows the next release date.

## Endpoints
| What | Call | Returns |
|---|---|---|
| List files | `GET /api/v1/files/{dataset}` | JSON list: `{filename, publishDate, version, current, month, year}` (~75 KiB) |
| Download | `GET /api/v1/files/{dataset}/{year}/{month}/{version}/download` | one Parquet file |

`dataset` is `employment`, `accessions` or `separations`. `month` is two digits (`08`).

List filters (query string): `current=true|false`, `version`, `month` (`09`, `Sep`, `September`),
`year` (YYYY), `dataCapturedThrough` (MM/DD/YYYY), `publishedBefore` / `publishedAfter` (MM/DD/YYYY, inclusive).

Response codes: 200 ok; 204 no content; 400 malformed or over the 25 MB request limit; 404 file not
found (a wrong version returns "The specified blob does not exist."); 429 rate limit; 500 server error.
The client retries 429 and 5xx with backoff.

## Files
| Dataset | Content | Rows per file | Size | Periods |
|---|---|---|---|---|
| employment | status snapshot: every employee on board on the last day of the month | ~2.0-2.3 million | 26-75 MB | quarterly (Mar/Jun/Sep/Dec) 2005 to March 2011, monthly from June 2011 (no Jan, Feb, Apr, May 2011), latest about two months back |
| accessions | personnel actions that brought people in, **processed** in the month | 10k-60k | 0.06-1 MB | monthly from 2005-01 |
| separations | personnel actions that took people out, processed in the month | 10k-120k | 0.1-4 MB | monthly from 2005-01 |

- **Versions:** OPM reissues files when late or corrected agency submissions arrive (versions 1 to 5
  seen). Exactly one version per month has `current: true`; use it unless reproducing earlier work, in
  which case pin the versions from `data/opm/manifest.json` (`fetch.py --source opm ... --pin`).
- **Schema changes:** current versions have 64 (employment), 68 (accessions) and 69 (separations)
  columns. Some older, superseded versions had only 31 columns, so always use current versions, and
  check `missing_columns` in the manifest.
- Every column is a string in Parquet, including numbers (`count`, `annualized_adjusted_basic_pay`,
  `length_of_service_years`). `stats.clean()` converts them.
- Download speed seen: a 57 MB employment file in about 4 seconds. Ten years of September snapshots
  (11 files, ~750 MB raw) take one to three minutes plus processing. Raw files are cached in
  `<cache root>/opm-fwd` (`~/.cache/data-analyst/opm-fwd`; `$OPM_CACHE_DIR` overrides).

## Formats
- **API:** Parquet only. Query parameters such as `?format=txt` are ignored (checked October 2026).
  Parquet is columnar and compressed: the August 2026 employment month is 57 MB for 2.0 million rows ×
  64 columns.
- **Data Downloads web page** (https://data.opm.gov/get-data/data-downloads): each file's **Download**
  menu offers **.TXT** and **.JSON** only. The download runs through the page's live server connection
  (no plain URL to script), so these suit users clicking in a browser. Expect them to be several
  times larger than Parquet. OPM warns that employment files exceed Excel's row limit. The exact TXT
  delimiter was not confirmed; `opm_io.py` sniffs it (comma, pipe, tab, semicolon, caret) and expects
  field names in the first row.
- **Data dictionary:** an Excel file (`FWD Data Dictionary.xlsx`); the skill ships it as
  `sources/opm/lib/data_dictionary.csv`, so it never needs downloading.
- **Reading Parquet** needs one engine: pyarrow (preferred), fastparquet, duckdb or polars.
  Environments without any can still work from a CSV `data/` folder or the website's TXT/JSON.

## Other OPM tools (no API)
- **Table Builder** (https://data.opm.gov/explore-data/data/table-builder): aggregate tables in a browser;
  the fallback when a user cannot download files at all.
- **Dashboards** ("Workforce Insights" pages): published headline figures to benchmark against.
- **FedScope** (fedscope.opm.gov) was the predecessor; FWD replaced it. Older reports cite FedScope's
  September snapshots, which is why September is the conventional annual snapshot.
- **Data Quality page** (https://data.opm.gov/resources/data-quality): validation errors by agency and a
  "Missing EHRI files" report. Check it when an agency's count jumps or drops.
