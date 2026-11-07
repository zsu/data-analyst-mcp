# FRED, ALFRED and GeoFRED: what the scripts rely on

Checked live on 2026-10-20 unless marked "(docs)". `sources/fred/fred_api.py` implements all of this; read
this file when a download fails or a request needs a parameter the spec does not expose.

## Two routes
| | FRED API (`api.stlouisfed.org/fred/`) | Keyless graph downloads (`fred.stlouisfed.org/graph/`) |
|---|---|---|
| Key | `api_key=<32 lowercase letters/digits>` query parameter; free at https://fredaccount.stlouisfed.org/apikeys; one key per user (terms) | none |
| Data | `series/observations`, JSON, `"."` = missing | `fredgraph.csv?id=X`, `""` = missing |
| Metadata | `series` (title, units, frequency, SA, last_updated, **notes**), `series/release`, `release/sources` (the source agency for the citation) | `fredgraph.xlsx?id=A,B,...` README sheet: title, units, frequency, SA, "Data Updated". No notes, source or copyright |
| Vintages (ALFRED) | `realtime_start/realtime_end`, `vintage_dates`, `output_type` (1 by real-time period, 2/3 by vintage, 4 initial release), `series/vintagedates` | `alfred.stlouisfed.org/graph/alfredgraph.csv?id=X,X&vintage_date=D1,D2&cosd=..,..&coed=..,..` (one repeated ID per vintage; columns `X_YYYYMMDD`). No first-release or full history |
| Search | `series/search` (`search_text`, `order_by=popularity`, `filter_variable`, `tag_names`) | none: use https://fred.stlouisfed.org/searchresults/?st=... in a browser, then `--describe` |
| Regional | GeoFRED `geofred/series/group?series_id=`, `geofred/regional/data` (`series_group`, `region_type` state/county/msa/bea/frb/necta/censusregion/country, `date`, `season`, `units`, `frequency`) | explicit per-area IDs (CAUR, TXUR ...; CAPCPI ...) through fredgraph.csv |
| Errors | HTTP 400 JSON `{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not registered. ..."}`; 429 above 120 requests a minute; 404 unknown series (docs) | 404 with an **HTML page** for an unknown ID (not CSV); check the content |
| Limits | 120 requests/minute; `limit` 100000 observations per call (paged); 2000 vintage dates per call (docs) | not published: be gentle (the scripts wait 0.55 s between requests); a graph holds **at most 12 series** and silently drops the rest |

## Parameters worth knowing (`series/observations`, and the graph equivalents)
- Dates: `observation_start`/`observation_end` (graph: `cosd`/`coed`, one value per ID).
- `units` (graph: `transformation`): `lin` levels, `chg` change, `ch1` change from a year ago, `pch` percent
  change, `pc1` percent change from a year ago, `pca` compounded annual rate, `cch`/`cca` continuously
  compounded, `log`. The column becomes `X_PC1` etc. on the graph route.
- `frequency` (graph: `fq` = Monthly, Quarterly, Annual ...) with `aggregation_method` `avg`/`sum`/`eop`
  (graph: `fam`). Only to a lower frequency. **FRED averages whatever observations exist**: a quarter with a
  missing month still gets a value (CPI, October 2025). The skill prefers native frequency plus
  `tsstats.to_frequency`, which refuses incomplete periods.
- Several IDs in one graph CSV: date bounds must be given per ID (`cosd=a,b`); mixed frequencies come back as
  a **zip** with `monthly.csv`, `quarterly.csv`. The scripts send one ID per CSV request.

## Dates that mean something else
- Fiscal-year dollar series (FYONET, FYFR, FYFSD, FYOINT) are dated at the **end** of the fiscal year
  (2025-09-30 = FY2025); fiscal-year percent-of-GDP series (FYFSGDA188S, FYOIGDA188S) at **January 1** of the
  fiscal year's number. `tsstats.fiscal_year_label` maps both to 2025.
- Quarterly data are dated at the first day of the quarter (2026-04-01 = 2026 Q2); monthly at the first of
  the month; weekly at the week's end day (MORTGAGE30US: Thursday); "Quarterly, End of Period" stocks
  (FYGFDPUN, GFDEBTN) are still dated at the quarter's first day.
- CBO series (GDPPOT, NGDPPOT, NROU) run about **ten years into the future**: projections, not data.
- USREC is 1 "from the period following the peak through the trough": the first shaded month is the month
  after the NBER peak.

## Terms of use (https://fred.stlouisfed.org/docs/api/terms_of_use.html, https://fred.stlouisfed.org/legal/)
- Every user uses their own API key. Never share or embed one; the scripts keep the key out of every file.
- No wholesale downloading, and no building a cache or archive of FRED content: request only the series and
  dates the question needs. The `<out>/data/fred/` folder is the working copy for one analysis.
- Products built on the API carry: "This product uses the FRED® API but is not endorsed or certified by the
  Federal Reserve Bank of St. Louis." (`fred_api.NOTICE`; the report builder adds it.)
- Copyright: each series page shows a tag: **Public Domain: Citation Requested**, **Copyrighted: Citation
  Required**, or **Copyrighted: Pre-Approval Required** (S&P, some Moody's, ICE BofA ... series; for example
  SP500: reproduction needs the owner's written permission). Every page also shows a generic banner "Data in
  this graph are copyrighted": ignore the banner, read the **tag**. With a key the scripts read that tag
  from `fred/series/tags` (group `cc`, e.g. "public domain: citation requested"; verified live 2026-10-22)
  and fall back to the notes ("Copyright, ..." → `copyrighted`) only when the tags cannot be read; keyless
  downloads are `unknown`. `no_copyright_notice` (notes fallback) is not proof of public domain: USREC's
  notes carry no "Copyright", yet its tag is Copyrighted: Citation Required (checked 2026-10-20). Both are shareable with a
  citation; for a report, read the tag of any series from a private publisher before sharing its data.
- Citation (the series page's "Suggested Citation"): "U.S. Bureau of Economic Analysis, Real Gross Domestic
  Product [GDPC1], retrieved from FRED, Federal Reserve Bank of St. Louis; https://fred.stlouisfed.org/series/GDPC1,
  October 20, 2026."

## Keyed responses (checked live with a key, 2026-10-20)
- **As of a date** (`vintage_dates=D1,D2`): rows by real-time period (`realtime_start`/`realtime_end`); the
  scripts assign each row to every requested vintage date inside its period.
- **Full history** (`realtime_start=1776-07-04&realtime_end=9999-12-31`): one row per value and real-time period;
  `vintage` = the date the value was published. `tsstats.real_time(df, variant, date)` rebuilds the series as known
  on a date.
- **First release** (`output_type=4`): needs the same full real-time window, or FRED answers HTTP 400 "No
  vintage dates exist for the specified real-time period". Each row's `realtime_start` is its first publication
  date (GDPC1 2020 Q2: 17,205.822, published 2020-07-30).
- **GeoFRED** `regional/data`: `{"meta": {"title", "region", "seasonality", "units", "frequency", "data": {date:
  [{region, code, value (a number), series_id}]}}}`. The title can name a different month than the date key
  (a September title for 2026-08-01 data); trust the date key. `series/group` gives the group, region type,
  season, units, frequency and `max_date` for a member series (CAUR → group 1224, 50 states and DC).
- Output types 2 and 3 (by vintage, in columns) are not used by the scripts; `observation_rows` parses their
  documented `<ID>_<YYYYMMDD>` columns in case a raw file has them.
- In the manual bundle, a GeoFRED request without `series_group` takes two calls; `download_fred.sh` and `download_fred.ps1` chain them.
- `series/vintagedates` of a derived series lists only the releases in which one of its (rounded) values changed:
  A191RL1Q225SBEA has 68 vintages since July 30, 2020, GDPC1 has 74. Count or list releases from the levels
  series (or the union), never from a growth-rate series alone.

## Release calendar and whole releases (added in the data-analyst port, checked live 2026-10-20)
- `fred/release/dates?release_id=N&realtime_start=D&realtime_end=9999-12-31&include_release_dates_with_no_data=true`
  lists a release's dates, scheduled future dates included (Employment Situation, release 50: 2026-10-02,
  2026-11-06, 2026-12-04); `fred/releases/dates` lists every release between two dates. The one-release form
  gives no `release_name`. `fetch.py --release-dates [ID]` or spec `release_dates`.
- FRED API v2 `fred/v2/release/observations?release_id=N&format=json&limit=L` returns every series of a
  release with its observations and FRED's copyright tag (`copyright_id`, e.g. "public domain: citation
  requested"), which v1 does not expose. Paging: `has_more` + `next_cursor` ("SERIES_ID,YYYY-MM-DD"); a page
  can end inside a series, so the next page continues it (the pack merges them). **The key goes in the header
  `Authorization: Bearer <key>`**; `api_key` in the query answers HTTP 401 `{"code":401,"message":"Missing or
  invalid credentials."}`. v2 error
  bodies arrive gzip-compressed even without `Accept-Encoding`. Release 53 (GDP) holds thousands of series:
  cap with `limit`, `max_pages` and a `series` filter.
