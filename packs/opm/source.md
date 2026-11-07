# OPM Federal Workforce Data (FWD / EHRI)
Depth: deep. Key: none. Record-level files of the federal civilian workforce from OPM's EHRI system:
monthly employment (status) snapshots, accessions (hires) and separations, with redaction-aware pay.

## When to use
- How many federal employees (by department, agency, occupation, grade, state, age, service); hires,
  separations, quits, retirements, RIFs, deferred resignations; hiring and separation rates; GS pay and
  salaries; composition (STEM, IT, veterans, supervisors, probationary tenure); changes since a date.
- Feasibility first: the public files have **no** sex, race, ethnicity, disability, names, performance
  ratings, awards, telework, total compensation, retirement eligibility dates, person identifiers
  (no tracking across months), USPS or intelligence-agency staff, uniformed military. Say so at once and
  offer the closest answerable version (e.g. age bracket and length of service as a retirement proxy).
- Not here: public vs. private pay from survey data (ipums CPS/ACS), federal spending (usaspending,
  treasury), government employment totals including USPS and state/local (bls CES).
- Records of the whole covered workforce, not a sample: no weights, no sampling error, no "statistically
  significant"; uncertainty is coverage, redaction, late reporting and revisions.

## Endpoints and datasets
| Dataset | Content | Rows per file | Size | Periods |
|---|---|---|---|---|
| `employment` | everyone on board on the last day of the month (`snapshot_yyyymm`) | ~2.0-2.3 million | 26-75 MB | quarterly 2005 to March 2011, monthly from June 2011; latest about two months back |
| `accessions` | actions that brought people in, **processed** in the month | 10k-60k | <1 MB | monthly from 2005-01 |
| `separations` | actions that took people out, processed in the month | 10k-120k | 0.1-4 MB | monthly from 2005-01 |

API (`https://data.opm.gov/api/v1/files`, no key): `GET /{dataset}` lists files
`{filename, publishDate, version, current, month, year}`; `GET /{dataset}/{year}/{MM}/{version}/download`
returns one Parquet file (the API serves Parquet only). OPM reissues files (versions 1-5 seen; one has
`current: true`); a first release (`_1`) of the latest month is usually revised later. Current versions have
64 (employment), 68 (accessions) and 69 (separations) columns, all strings. Endpoint details, file
sizes and other OPM tools (Table Builder, dashboards, Data Quality page): `docs/opm_api.md`. Field codes,
the 72-field dictionary and column sets per question: `docs/fields.md` (read sections 1-2 once per
analysis) and `lib/data_dictionary.csv`. Precedents, benchmarks and conventions: `docs/report_patterns.md`.

Commands (`python "<skill>/scripts/fetch.py" --source opm ...`):
```
<out>/spec.json --out <out> --check          # route: reuse_existing | api | install_deps | fix_spec |
                                             #   cloud_allowlist | manual_download | report_error
<out>/spec.json --out <out>                  # download (or reuse cache), filter, package
<out>/spec.json --out <out> --dry-run        # the files it would fetch (versions, URLs)
<out>/spec.json --out <out> --pin            # re-fetch the exact versions in data/opm/manifest.json
<out>/spec.json --out <out> --manual-bundle  # INSTRUCTIONS.md, urls.txt, a runnable fetch.py copy
<out>/spec.json --out <out> --ingest [FILES] # data/ folder or ZIP, API Parquet, website TXT/JSON (.gz/.zip)
--list employment                            # months available, quarterly and partial years, latest files
```
Run `next_command` in the background when `plan.est_minutes` > 2. Exit 3 = `install_deps` (pandas or a
Parquet reader missing: try pyarrow, then fastparquet, duckdb or polars; else the bundle's CSV route).

## Spec examples
```json
{"description": "Separations by type, VA and DHS, FY2025",
 "datasets": {"separations": {"from": "2024-10", "to": "2025-09"},
              "employment":  {"from": "2024-09", "to": "2025-09"}},
 "columns": ["department_code", "department", "agency_code", "agency", "separation_category_code",
             "separation_category", "drp_indicator", "nsftp_indicator"],
 "filters": {"department_code": ["VA", "HS"]}}
```
```json
{"description": "Headcount and basic pay, latest snapshot and year-end comparisons",
 "datasets": {"employment": {"periods": ["2024-09", "2025-09", "latest"]}},
 "columns": ["department_code", "department", "agency_code", "agency", "nsftp_indicator", "work_schedule_code",
             "pay_basis_code", "pay_plan_code", "grade", "annualized_adjusted_basic_pay"]}
```
```json
{"description": "September headcount by department, 2015-2025",
 "datasets": {"employment": {"from": "2015-09", "to": "2025-09", "months": [9]}},
 "columns": ["department_code", "department"], "aggregate": {"by": ["department_code", "department"]}}
```
Each dataset takes `from`/`to` (`"latest"` allowed) with optional `months`, or `periods` (single months).
Filter values are strings exactly as in the data (`"08"`, `"0343"`). Request only the columns needed
(always the `*_code` columns for groups); ten September snapshots with all 64 columns are ~20 million rows.
`aggregate` collapses each file to counts, pay sums and redaction counts (no medians then); it keeps only the
`aggregate.by` columns (a column listed elsewhere is refused), and pay_sum / pay_n cover full-time, per-annum
records with reported pay (the `pay_summary` universe). Flows need
every month of the period plus the employment snapshots of those months for the denominator; counting by
effective month also needs the next two or three files (late reports).

## Data format and traps
Output in `<out>/data/opm/`: `opm_<dataset>.parquet` (when a writer exists), `opm_<dataset>.csv` up to
1,000,000 rows (`.csv.gz` above that when no Parquet writer exists), `manifest.json` (every source file,
version, publish date, SHA-256, rows, missing columns), `request.json`, `data_dictionary.csv`,
`README.md`, `spec_used.json`. Read the printed `warnings`: a filter column absent from an older file
means those rows were NOT filtered; missing requested columns are filled with nulls.
- **Redacted pay and location (the big one)**: `annualized_adjusted_basic_pay`, all `duty_station_*`,
  CBSA/CSA, locality pay area, bargaining unit and personnel office are `REDACTED` for every DoD employee,
  for security agencies (FBI, DEA, ATF, Secret Service, CBP, ICE, BOP, ...) and sensitive occupations:
  about 45 to 48 percent of employment records. Never call an average over unredacted records "the
  federal average". Run `redaction_coverage()` by the groups reported, save `<out>/coverage.csv`, quote
  coverage beside every pay or location figure, and discuss redaction in the methods (the audit checks
  both). Headcounts by department, occupation, grade, age and education are complete.
- **Counting actions**: files hold actions processed in the month; 5-10 percent are effective earlier.
  Effective month (`period`, recent months incomplete) or processing month (`file_period`): state which,
  show the other as a sensitivity (`late_reporting()`).
- **End-of-month separations** (September 30 retirements, the 2025 Deferred Resignation Program) leave
  the headcount only in the next month's snapshot: show the change to the next snapshot too.
- **Table facts**: group by codes, but register each table cell's fact with `where=` the row's label as
  printed (the department name), so the answer gate can tie the cell to its row.
- **Codes, not names**: names change (OPM's dashboards say Department of War; the files label code DOD "DEPARTMENT OF DEFENSE" through 2026-08); group by `*_code`,
  display `latest_labels()`. Codes are strings with leading zeros: never cast to integers.
- **Versions**: use current versions; earlier reports may differ because files were reissued; pin to
  reproduce. Employment is quarterly before 2011 (`partial_period` flags short fiscal years).
- **Sentinels** `NO DATA REPORTED`, `INVALID`, `UNSPECIFIED`, `*` become missing in `clean()`; report the
  missing counts for the fields used (`missing_summary`). A missing `department_code` with a valid
  `agency_code` (HUD, Dec 2024-Mar 2025: 410-435 employees a month) is filled by `clean()` from the agency's
  department, with a note: keep `agency_code` in `aggregate.by` so it can be. Agencies that miss a submission show a dip and
  rebound: check the FWD Data Quality page before reporting a one-month change of more than ~5 percent.
- **Pay universe**: full-time (`work_schedule_code` F), per annum (`pay_basis_code` PA), pay > 0
  (`pay_universe`); basic pay plus locality, not total compensation; `screen_pay()`; prefer medians.
- **Denominators**: rates use `average_headcount` over the same period, universe and filters
  (`action_rate`); small groups (`low_n`, fewer than 30 records) are footnoted or suppressed.
- Coverage exclusions mean totals are below figures that include USPS (~600,000) or the intelligence
  community: say "employees covered by OPM's data".
- Shares: OPM's dashboards divide by all employees, "Data not available" included; `shares()` leaves missing
  categories out unless `keep_missing=True`. Match the dashboard with `keep_missing=True`; report the other as
  a sensitivity when the missing count moves (one agency's missing education can jump between snapshots).

Analysis helpers: `sources/opm/lib/stats.py` (`load`, `clean`, `headcount`, `shares`, `redaction_coverage`,
`missing_summary`, `pay_summary`, `screen_pay`, `average_headcount`, `action_rate`, `late_reporting`,
`latest_labels`, `suppress`, `standardize`, `sensitivity`, `wls`, its own `Facts`; formats in
`scripts/analysis/factfmt.py`, including `:abs`):
```python
import sys, os
OUT = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(OUT, "lib"), os.path.join(OUT, "lib", "opm"), r"<skill>/sources/opm/lib"]  # SKILL.md section 4
from stats import *     # alone; with bea, ipums or opm too: st = pack_lib("opm", "stats", OUT, SKILL)
emp = clean(load(f"{OUT}/data/opm", "employment"))
sep = clean(load(f"{OUT}/data/opm", "separations"))
t = action_rate(sep, emp, by=["department_code"], period="fiscal_year")
redaction_coverage(emp, ["period", "department_code"]).to_csv(f"{OUT}/coverage.csv", index=False)
```

## Access
- No key, no account. Route `api` when data.opm.gov answers. OPM releases a month's files about five
  weeks after it ends. Raw files are cached in `$OPM_CACHE_DIR` or `<cache root>/opm-fwd` (the shared
  cache root, `~/.cache/data-analyst`; a temp folder in sandboxes) for 30 days, keyed by file name and
  version; `--no-cache` deletes them after use.
- Before a manual task, check whether a simple total is on OPM's own pages (Workforce Insights
  dashboards, Table Builder at https://data.opm.gov/explore-data/data/table-builder; JavaScript apps: use
  browser tools). Quote the page, month and definition, and say it was read, not computed.
- Manual route (sandbox, hosted chat without the host allowed, Parquet unreadable): `<out>/manual_download/opm/`
  holds `INSTRUCTIONS.md`, `spec.json`, `download_opm.sh` / `download_opm.ps1` (the request built in; no
  Python, no key), a runnable copy of the fetcher with the shared `core/` modules and, when the file list was
  reachable, `urls.txt`. Send them as the route JSON says (`download_scripts`, `user_commands`). Option A
  (recommended): the user runs the one command for their system, which saves the raw Parquet files.
  Option B (much smaller upload for many employment months): `python fetch.py spec.json --out .` on their
  computer (Python with pandas and pyarrow), then upload the `data/` folder as a ZIP. Option C (no Python): on
  https://data.opm.gov/get-data/data-downloads click Download > .TXT (or .JSON) per month; keep names or
  rename like `separations_202608_1.txt`. Option D: Table Builder export for simple counts. Then
  `--ingest` with the uploaded files or their folder. A month inferred from content must be confirmed with the user;
  files outside the spec's periods are skipped; website files carry no version (`_web`). Say in the
  methods that the files were downloaded by hand.

## Citation and terms
"U.S. Office of Personnel Management, Federal Workforce Data (FWD), Enterprise Human Resources
Integration (EHRI) <datasets> files, accessed <date> through the FWD API
(https://data.opm.gov/get-data/api-access)." Give file versions from `manifest.json` in the methods.
Source line: "Analyst calculations using data from the Office of Personnel Management's Federal
Workforce Data (EHRI ... files, <months>)." Redistribution: **allowed** (public data under OPM's Public
Data Release Policy); the filtered files may ship in a replication package (files over 50 MB stay out
and are re-downloadable). OPM withholds pay and location for privacy and security (`REDACTED`): disclose
coverage, and never try to infer withheld values.
