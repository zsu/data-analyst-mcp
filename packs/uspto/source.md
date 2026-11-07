# USPTO Open Data Portal (patent applications, PTAB, petitions, bulk datasets)
Depth: standard. Key: required (USPTO_API_KEY). U.S. patent applications and grants from the Patent File
Wrapper (bibliographic data, status, prosecution events, continuity, assignments, term adjustment), PTAB
trials, final petition decisions, and the bulk-dataset directory, via api.uspto.gov.

## When to use
- Patents or applications by company, inventor, CPC class, filing or grant date; the status and history
  of one application; ownership (assignments); continuation families; PTAB IPR/PGR trials; petitions.
- Not here: trademarks (not in this pack), full patent text search (USPTO Patent Public Search at
  https://ppubs.uspto.gov, a web tool), patent counts by state or country as official statistics (USPTO
  PTMT reports, not covered), R&D spending (nsf or bea packs if present).
- Counts built from search results are your own tabulations, not official USPTO statistics: say so.

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `applications_search` | applications/grants matching a query, one row each | `q`, `filters`, `rangeFilters`, `sort`, `fields`, `facets` |
| `application` | everything for one application | `applicationNumberText` (digits) |
| `application_meta_data`, `_continuity`, `_assignment`, `_transactions`, `_adjustment`, `_foreign_priority`, `_attorney` | one section of an application | `applicationNumberText` |
| `application_documents` | documents in the file wrapper (codes, dates, download links) | `applicationNumberText`, `documentCodes`, `officialDateFrom/To` |
| `datasets_search` / `dataset_product` | bulk products (grant XML PTGRXML, pre-grant APPXML, assignments, research data) and their files | `q`, `productIdentifier`, `fileDataFromDate/ToDate` |
| `petition_decisions_search` | final petition decisions | `q`, `filters`, `rangeFilters`, `sort` |
| `ptab_proceedings_search` / `ptab_proceeding` | PTAB trials (IPR, PGR, CBM, DER) | `q`, `trialNumber` (IPR2023-00001) |
| `ptab_decisions_search` | PTAB trial decisions | `q` |

Search syntax (`q`): free text; `field:value`; `AND` `OR` `NOT`; wildcards `*` `?`; phrases in double
quotes; ranges `applicationMetaData.filingDate:[2024-01-01 TO 2024-12-31]`; comparisons
`applicationMetaData.applicationStatusCode:>600`. `filters` is `'field v1,v2'` (values OR-ed, filters
AND-ed); `rangeFilters` is `'field from:to'` (dates and numbers only). Field names are dotted paths, e.g.
`applicationMetaData.firstApplicantName`, `applicationMetaData.cpcClassificationBag`,
`applicationMetaData.grantDate`, `applicationMetaData.applicationTypeCode` (UTL, DES, PLT, PPA, REI).
Field dictionary: https://data.uspto.gov/documents/documents/patent-data-schema.json (sign-in needed).
`--search "trial"` lists the catalog notes (type codes, trial types, bulk product ids).

## Spec examples
```json
{"description": "Utility patents granted to one applicant in 2024 (selected fields)",
 "requests": [{"name": "pacbio_2024_grants", "endpoint": "applications_search",
   "params": {"q": "applicationMetaData.firstApplicantName:\"Pacific Biosciences of California, Inc.\"",
              "filters": "applicationMetaData.applicationTypeCode UTL",
              "rangeFilters": "applicationMetaData.grantDate 2024-01-01:2024-12-31",
              "fields": "applicationNumberText,applicationMetaData.patentNumber,applicationMetaData.grantDate,applicationMetaData.inventionTitle,applicationMetaData.cpcClassificationBag",
              "sort": "applicationMetaData.grantDate asc"}, "max_rows": 2000}]}
```
```json
{"description": "One application: record, prosecution history, continuity",
 "requests": [{"name": "app", "endpoint": "application", "params": {"applicationNumberText": "14412875"}},
              {"name": "app_events", "endpoint": "application_transactions", "params": {"applicationNumberText": "14412875"}},
              {"name": "app_family", "endpoint": "application_continuity", "params": {"applicationNumberText": "14412875"}}]}
```
```json
{"description": "IPR trials numbered IPR2024-* (PTAB query form not verified with a key)",
 "requests": [{"name": "ipr_2024", "endpoint": "ptab_proceedings_search",
   "params": {"q": "IPR2024*"}, "max_rows": 3000}]}
```
Do not set `limit`/`offset`: paging is automatic (100 per page); cap with `max_rows`.

## Data format and traps
- Records are deeply nested. The CSV flattens objects into dotted columns
  (`applicationMetaData.patentNumber`); lists of objects (`inventorBag`, `assignmentBag`,
  `eventDataBag`, `parentContinuityBag`) become JSON text in one cell, and lists of strings
  (`cpcClassificationBag`) become "; "-joined text. Parse them in `analysis.py`; use `fields` to keep
  rows small.
- One row per application, not per patent: an application without `patentNumber` was not granted (yet).
  Status is a code plus `applicationStatusDescriptionText` ("Patented Case" = 150).
- Dates are ISO (YYYY-MM-DD). Filing, effective filing, earliest publication and grant dates differ by
  years; continuations share an effective filing date with their parent. Pick one and say which.
- Applicant and assignee names are free text with variants ("Inc." vs "INC.", subsidiaries). Group names
  deliberately; the first applicant is not always the current owner (check `assignmentBag`).
- Recent years are incomplete: applications publish about 18 months after filing, so filing-year counts
  for the last two years undercount.
- Coverage of older applications in ODP is uneven (older third-party docs say filings since 2001);
  unverified for the current release: check counts before analysing pre-2001 years.
- `facets` counts come back in the response body, not as rows; the generic fetch keeps only rows.
- Unverified (no key when built): the maximum page size (the pack uses 100), the GET form and record keys
  of the PTAB endpoints (`patentTrialProceedingDataBag`, `patentTrialDecisionDataBag`), and `documentBag`. The search response shape is verified from USPTO's documented example.
  If a PTAB request fails with HTTP 400/404, report it and use the ODP web search instead.
- Records name inventors, attorneys, examiners and addresses (published by law). Report aggregates.

## Access
Key required for every call: a free ODP API key, sent in the `X-API-KEY` header. Getting one needs a
USPTO.gov account with multi-factor authentication and an ID.me identity check
(https://data.uspto.gov/apis/getting-started). Since 2026-10-08 keys of accounts missing the extra profile
fields are deactivated; reactivate under Manage API Key. Without a key, `--check` answers `run_setup`
(local terminal), `cloud_secret` or `manual_download`.
Limits (USPTO rate-limits page): one request at a time per key (parallel calls with the same key are
blocked), 4 to 15 requests a second, 5 million metadata calls and 1.2 million document calls a week,
reset Sunday 00:00 UTC; on HTTP 429 wait at least 5 seconds. The pack sends 4 a second, never in parallel.
Manual route: browser links cannot send the header, so `manual_download/` holds scripts
(`download_data.sh`, `.ps1`; one command, no Python) that ask for USPTO_API_KEY with hidden input on the
user's computer and save the JSON
files; upload them and run `--ingest`. Without a key: sign in at https://data.uspto.gov (required since
2026-06-18), use the Patent File Wrapper search page, save the results, and upload them. Bulk XML files
(PTGRXML, APPXML) are listed by `datasets_search`; this pack does not parse them.

## Citation and terms
"United States Patent and Trademark Office, Open Data Portal API, <endpoint/query>, api.uspto.gov,
retrieved <date>." Patent bibliographic data are U.S. government information, not subject to copyright
(USPTO terms of use: https://www.uspto.gov/terms-use-uspto-websites). Redistribution allowed; keep
personal names out of published tables unless the question is about them.
