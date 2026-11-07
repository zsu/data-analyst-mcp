# Bureau of Economic Analysis (BEA) Data API and bulk files
Depth: deep. Key: required (BEA_API_KEY) for the API; the bulk route needs none. U.S. national accounts
(GDP, income, PCE and its prices, saving, profits, government), state and county GDP and income, regional
price parities, GDP by industry, trade and international accounts, multinationals, fixed assets, input-output.

## When to use
- GDP and its growth, contributions, prices and deflators; personal income, disposable income, saving rate;
  PCE and core PCE price indexes (the Federal Reserve's inflation measure); corporate profits; NIPA
  government receipts and spending (calendar years); GDP and personal income by state and county; per capita
  income; RPPs; value added and gross output by industry; goods and services trade balances by country;
  current account; investment position; direct investment; capital stocks.
- Not here: CPI, jobs, unemployment, wages by occupation (bls); budget data by fiscal year (treasury);
  market interest rates (treasury-yields; fred); forecasts (BEA publishes history only); monthly GDP.
- The deliverable decides the work: data only (download, short preview, stop), an answer (compute with
  `compute`, answer with the numbers, measure and vintage), or a report (`guide`'s report steps).

## Endpoints and datasets
One API endpoint (`https://apps.bea.gov/api/data`, GET, key in `UserID`), 13 datasets. Bulk files serve
the most used ones without a key and count against no limit.

| `dataset` | What | Spec keys | Bulk (no key)? |
|---|---|---|---|
| `NIPA` | national accounts tables `T10101` ... (titles: `request_schema` search) | `table`, `frequency` A/Q/M, `years`, `line_code` | yes (NIPA flat files) |
| `NIUnderlyingDetail` | detail tables `U20305` ... (lower quality) | same | no (flat files hold only shared lines) |
| `FixedAssets` | `FAAt101` ... annual | `table`, `years` | no |
| `Regional` | state `SA*`/`SQ*`, county `CA*`, metro `MA*` tables | `table`, `line_code`, `geo_fips`, `years` | yes for STATE, COUNTY, postal code (its counties), FIPS lists, MARPP |
| `GDPbyIndustry` | workbook codes `TVA101`-`TVA113`, `TGO1xx`, `TII1xx` | `table`, `frequency` A/Q, `years` | yes (public workbooks) |
| `GDPbyIndustry` (API) | `TableID` 1, 5, 6, 25 ...; `Industry` filters | `params` | no |
| `UnderlyingGDPbyIndustry`, `ITA`, `IIP`, `IntlServTrade`, `IntlServSTA`, `MNE`, `InputOutput` | see `request_schema` with `names: ["<name>"]` | `params` (raw API names) | no |

Verified lines (September 2026 vintage): T10101 line 1 real GDP percent change (annual rate); T10106 line 1
real GDP (millions of chained 2017 dollars, SAAR); T10105 line 1 nominal GDP; T10111 line 1 year-over-year
real GDP change; T10102 contributions; T20100 lines 1/27/37/35/40 personal income / DPI / real DPI / saving
rate / population (annual and quarterly only: monthly values are in T20600, whose line numbers differ, so
check them with the search `lines T20600`; a table is monthly only when its title says so, and the bulk route refuses
frequency M for any other table); T20804 lines 1/25 PCE / core PCE price index (monthly; published changes: T20807 month over month, not
annualized, T20811 lines 32/37 over 12 months); T70100 lines 1/3 GDP and income
per capita (BEA divides by unrounded population: real GDP over T70100's population, published in thousands,
can miss the published per-capita level by just over 0.5 dollars; allow for that rounding in the benchmark and
say so). Federal civilian wages per FTE (T60600D) jump in 2024-2025: Deferred Resignation staff on paid
administrative leave stayed on the payroll while BEA cut the quantity of federal labor (FAQ 1479,
bea.gov/help/faq/1479): never read those years as federal pay raises; use OPM pay or the GS raise. Regional: SAGDP2/SAGDP9 line 1 all-industry total (current / chained 2017 dollars); SAINC1 and
CAINC1 lines 1/2/3 personal income / population / per capita income; SAINC4/CAINC4 lines 10/20/30; SARPP
and MARPP line 1 all-items RPP. API names may carry an `N` (`SAGDP9N`); the bulk files drop it: both work.
BEA marks nothing as preliminary in the data, but the latest quarter or year of every table is an early
estimate that BEA will revise: register facts from it with `preliminary: true` in `facts` and say so. A year that has
been through an annual update (published at the end of September) is revised, not early: say "subject to
revision at the next annual update" instead.
More tables, the question-to-table map and concepts: `docs/datasets.md`. API parameters, response quirks,
error codes and limits: `docs/bea_api.md`. Report conventions: `docs/report_patterns.md`.

Discovery with `request_schema` (no key unless noted): `search: "real gross domestic product"` (NIPA titles
and workbook tables), `search: "Regional income"` (the first word names the dataset; API datasets need a key),
`search: "lines T10106"` (lines and series codes), `names: ["ITA"]` (required parameters, rules, spec keys,
and with a key BEA's current parameters); with a key (cached a day): `search: "values Regional TableName"`,
`search: "values Regional LineCode TableName=SAINC1"`. `source_brief` lists the 13 datasets.

## Spec examples
```json
{"description": "Real GDP growth, national and by state, 2019 to 2025",
 "requests": [
  {"id": "gdp_pct", "dataset": "NIPA", "table": "T10101", "line_code": 1, "frequency": "Q", "years": "2019-2025"},
  {"id": "gdp_real", "dataset": "NIPA", "table": "T10106", "line_code": 1, "frequency": "Q", "years": "2019-2025"},
  {"id": "state_real", "dataset": "Regional", "table": "SAGDP9", "line_code": 1, "geo_fips": "STATE", "years": "2019-2025"},
  {"id": "va_ind", "dataset": "GDPbyIndustry", "table": "TVA105", "frequency": "A", "years": "2024-2025"}]}
```
```json
{"description": "Per capita personal income, two counties, last five years",
 "requests": [{"id": "cty_pi", "dataset": "Regional", "table": "CAINC1", "line_code": [1, 3],
               "geo_fips": ["06037", "17031"], "years": "LAST5"}]}
```
```json
{"description": "U.S. goods trade balance with China (needs a key)",
 "requests": [{"id": "ita", "dataset": "ITA",
   "params": {"Indicator": "BalGds", "AreaOrCountry": "China", "Frequency": "A", "Year": "2023,2024"}}]}
```
`years`: `"2019-2025"`, a list, `"ALL"` or `"LAST5"`; `line_code`: a number, list or `"ALL"` (NIPA: BEA
sends the whole table and the rows are filtered); `geo_fips`: `STATE`, `COUNTY`, a postal code (its
counties), FIPS codes (`"06"` = `06000`). Keys a dataset does not use are reported in the result's notes. When a growth
rate is computed from levels, also request BEA's published percent change so it can be checked.

## Data format and traps
`fetch` writes `data/bea/`: `bea_data.csv` (tidy: `request_id, dataset, table, line, series_code,
description, geo_fips, geo_name, geo_level, industry, time_period, date, year, subperiod, frequency, value,
flag, unit, metric, unit_mult, note_ref, dims`), `notes.csv` (BEA's footnotes: units, reference year, what
the U.S. row means, flag codes), `request.json` (calls without the key, bulk files, route, vintage,
checksums) and `README.md`. Read the README and `notes.csv` before analysing (the NIPA bulk files carry no
footnotes: on the `bulk` route `notes.csv` has only the pack's own note; read a table's footnotes on its
apps.bea.gov page, or fetch it through the API with a key). `line` holds BEA's line numbers, which can carry
letters: match lines exactly (as text, or with `series_code`), never by integer order.
- **Units:** `value` is as BEA prints it; base units = value x 10^`unit_mult` (`compute` `derive`:
  `value * pow(10, unit_mult)`).
  Check `unit` and `metric` (current dollars, chained dollars, index, percent change) for every series.
- **Special values** `(D)` suppressed, `(NA)` not available, `(NM)` not meaningful, `(L)` under $50,000 or 10
  jobs, `(S)`, `(X)`, `(*)` (MNE: rounds to zero): `value` is empty and the code is in `flag`. Never a zero;
  list the rows with a `flag` and drop or footnote the area.
- **No sums of chained dollars**, of components or of states; shares from current dollars; drivers of growth
  from BEA's contributions tables (T10102, SAGDP11). SAAR levels are averaged, not added, for annual values.
- **Growth measures differ** by a point or more: quarterly at a compound annual rate (BEA's headline:
  (level / previous level)^4 - 1), year over year (T10111), Q4 over Q4, annual average; "since <year>":
  cumulative change and the average annual rate. Name the measure everywhere; show the alternatives as a
  sensitivity.
- **Check against BEA's published numbers** (docs/datasets.md section 5): growth
  from T10106 levels vs T10101; the U.S. row of SAGDP9 vs T10106 line 1. A mismatch beyond rounding is an
  error; a difference from an older release is a revision (compare dates with the vintage in README.md).
- **Vintage:** BEA serves only its latest estimates (advance, second, third; annual updates each September;
  comprehensive updates every five years). Record the release date; old vintages are at apps.bea.gov/histdata.
- **Geography:** every row has `geo_level` (nation, region, state, county, msa); a COUNTY bulk download also
  holds state and U.S. rows: filter before summing. `STATE` = 50 states + D.C. + U.S. (say whether D.C. is
  ranked). Since February 2026 BEA no longer produces GDP or personal income for metro areas: sum component
  counties' current-dollar values and say so. Rank on unrounded values; name near-ties.
- **Calendar years** everywhere (NIPA federal spending too, unlike fiscal-year budget data). NIPA line
  numbers change at comprehensive updates: check the description or series code, not only the line.
  GDP-by-industry line numbers differ between tables (TVA106 has an extra line): match by description.
- **No standard errors** exist for BEA estimates: never "statistically different".
- Analysis: build growth rates, shares and comparisons with `compute` on `data/bea/bea_data.csv`, and check each
  headline against the published table.

## Access
- **Key** `BEA_API_KEY` (free, https://apps.bea.gov/API/signup/; BEA emails it and it works only after the
  activation link is clicked). Found, in order, in the environment, `BEA_API_KEY_FILE`, keys.json, Claude Code
  settings.json and `~/.bea/api_key`; the user stores it with `npx -y data-analyst-mcp setup bea` in their own
  terminal. Never ask for the key in chat. BEA puts it in the URL and echoes it in every
  reply: the server scrubs both (the key and the USERID echo); never build your own API URLs.
- **Limits** per key: 100 requests, 100 MB and 30 errors a minute; going over blocks the key for a minute to
  an hour (HTTP 429, never retried). The client spaces calls 0.75 s, waits before crossing 100 MB a minute,
  stops after 30 errors a minute or 10 in a run, validates table and line names against cached metadata
  first, and checks dataset parameter rules offline (`invalid_request`), so errors are not spent.
- **Routes** (`route` in the result): `reuse_existing` (`data/bea/` already holds the request; `force: true`
  downloads again), `api` (key works), `bulk` (no usable key and every request is in the bulk files: NIPA
  flat files, state and county zips, GDP-by-industry workbooks; same latest estimates; the spec's
  `"prefer": "bulk"` forces it, `"prefer": "api"` never falls back). A key BEA rejects or has locked out falls
  back to the bulk files when they hold every request. Errors: `key_missing` (no key and a request needs the
  API: the user runs `npx -y data-analyst-mcp setup bea`, or `manual_bundle`), `key_rejected`,
  `rate_limited`, `agency_rejected` (fix the spec; never loop: errors count against the key) and
  `agency_unavailable` (BEA unreachable; never invent or recall data). Bulk files are cached in
  `<cache_root>/bea/bulk` (`DATA_ANALYST_CACHE` sets the root) and revalidated by Last-Modified; NIPA files are
  12-37 MB, county zips up to 50 MB.
- **Manual download:** `manual_bundle` writes `manual_download/`: `INSTRUCTIONS.md` with the links, and
  `download_data.sh` (macOS, Linux) and `download_data.ps1` (Windows), one-command scripts that download the
  public files and ask for the key with hidden input only when an API request needs it. Send both scripts and
  INSTRUCTIONS.md, and give the one command for the user's system (`user_commands`). BEA repeats the key inside
  API replies: `ingest` removes it. Then `ingest` with the uploaded files or their folder (on a hosted server,
  `files: ["uploads"]`). Say in the methods that the files were downloaded by hand.

## Citation and terms
"U.S. Bureau of Economic Analysis, <tables>, <route> (accessed <date>)." The exact line is in
`data/bea/README.md`; include the release (vintage) when it matters. Source line: "Analyst calculations using
data from the Bureau of Economic Analysis." BEA data are public domain: redistribution allowed (data files
may ship in a replication package). Products that use the API must show: "This product uses the Bureau of
Economic Analysis (BEA) Data API but is not endorsed or certified by BEA." (the API terms' wording) Do not
imply BEA endorsement.
