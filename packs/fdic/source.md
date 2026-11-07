# FDIC BankFind Suite API
Depth: standard. Key: none. FDIC data on every FDIC-insured bank and savings institution: institution
profiles, failures and assistance since 1934, quarterly Call Report financials, annual state
summaries, branch deposits (Summary of Deposits), structure-change history and office locations.

## When to use
- Bank failures (counts, assets at failure, estimated cost to the Deposit Insurance Fund) by year or
  state; the largest banks in a state; number of banks over time; one bank's quarterly assets, deposits,
  income, ROA/ROE; branch-level deposits and market share by county or city; mergers and charter
  changes.
- Not here: consumer complaints about banks (cfpb); bank holding company securities filings and
  XBRL financials (sec); interest rates and money supply (fred); credit union data (NCUA, not covered).

## Endpoints and datasets
Every endpoint takes `filters`, `fields`, `sort_by`, `sort_order` (ASC/DESC); paging is automatic
(`limit`/`offset`, 1,000 a page, at most 10,000 a page server-side). `--search "deposits"` lists fields.
`failures`, `history`, `financials`, `sod` and `summary` also aggregate server-side (FDIC swagger; checked
live 2026-10-22): `agg_by` (UPPERCASE field) turns the rows into one bucket per value with `count`,
`agg_sum_fields` adds `sum_<FIELD>`, `agg_term_fields` adds `count_<FIELD>_<value>` columns. Without
`agg_limit` every bucket is returned; `agg_limit` caps the buckets silently (the rest are dropped), so leave
it out unless you want a top-N. A term field the API cannot count answers HTTP 400.
| Endpoint | Returns (one row per) | Key fields | Coverage |
|---|---|---|---|
| `institutions` | institution (CERT) | CERT, NAME, CITY, STALP, ACTIVE, BKCLASS, REGAGNT, ASSET, DEP, REPDTE; `search` | open and closed |
| `failures` | failure or assistance transaction | CERT, NAME, PSTALP, FAILDATE, FAILYR, RESTYPE, RESTYPE1, QBFASSET, QBFDEP, COST | 1934- |
| `financials` | institution x quarter | CERT, REPDTE (YYYYMMDD), ASSET, DEP, NETINC, ROA, ROE, LNLSNET, ... (1,000+ fields) | 1984-, quarterly |
| `summary` | state x year x charter group | STNAME, YEAR, CB_SI, BANKS, ASSET, DEP, NETINC; `agg_by`, `agg_sum_fields` | 1934-, annual |
| `sod` | branch x year (June 30) | CERT, NAMEFULL, BRNUM, CITYBR, STALPBR, CNTYNAMB, DEPSUMBR, YEAR | 1994-, annual |
| `history` | structure event | CERT, INSTNAME, EFFDATE, CHANGECODE, CHANGECODE_DESC | |
| `locations` | office or branch | CERT, NAME, OFFNAME, CITY, STALP, ZIP, COUNTY, LATITUDE, LONGITUDE | current |
| `demographics` | institution x quarter | CERT, REPDTE, office counts, CBSA, metro flags | |

Filter syntax (Elasticsearch query string): `STALP:"WY" AND ACTIVE:1`, `ASSET:[1000000 TO *]`,
`REPDTE:[20240101 TO 20241231]`, `FAILDATE:[2008-01-01 TO 2010-12-31]`, `FAILYR:2023`,
`CERT:3511`, `NOT BKCLASS:"N"`. Quote text values; ranges use `[a TO b]`, `*` is open-ended.

## Spec examples
```json
{"description": "Bank failures in 2023 (failures only, not assistance)",
 "requests": [{"name": "failures_2023", "endpoint": "failures",
   "params": {"filters": "FAILYR:2023 AND RESTYPE:\"FAILURE\"",
              "fields": "CERT,NAME,CITY,PSTALP,FAILDATE,QBFASSET,QBFDEP,COST,RESTYPE1", "sort_order": "ASC"}}]}
```
```json
{"description": "Wells Fargo Bank (CERT 3511) quarterly assets and net income, 2024",
 "requests": [{"name": "wells_2024", "endpoint": "financials",
   "params": {"filters": "CERT:3511 AND REPDTE:[20240101 TO 20241231]",
              "fields": "CERT,REPDTE,ASSET,DEP,NETINC,ROA", "sort_order": "ASC"}}]}
```
```json
{"description": "Banks, assets and deposits by state, 2025 (national total row included)",
 "requests": [{"name": "states_2025", "endpoint": "summary",
   "params": {"filters": "YEAR:2025", "fields": "STNAME,YEAR,CB_SI,BANKS,ASSET,DEP,NETINC"}}]}
```
Find a bank's CERT first: `institutions` with `"search": "NAME:Wells"` and `fields` CERT,NAME,ACTIVE.

## Data format and traps
- Dollar amounts (ASSET, DEP, NETINC, COST, QBFASSET, DEPSUMBR) are in THOUSANDS of dollars:
  Wells Fargo's ASSET 1907928000 is $1.9 trillion; SVB's COST 18744254.463 is about $18.7 billion.
- Call Report income fields (NETINC, INTINC, NONII, ...) are year-to-date: Q1 is three months, Q4 the
  full year. Quarterly flows are the difference between consecutive quarters of the same year. ROA and
  ROE are already annualized percents.
- `failures` holds both failures (RESTYPE "FAILURE", 3,524) and open-bank assistance transactions
  (RESTYPE "ASSISTANCE", 593) as of 2026-10; filter `RESTYPE:"FAILURE"` to count failures. COST is an
  estimate and is revised as receiverships close; it is empty or 0 for some (Signature Bank shows 0).
- `summary` rows are split by charter group (CB_SI: CB commercial banks, SI savings institutions): add
  both for a state. It also holds aggregate rows "All States and Territories", "U.S. States and DC" and
  "U.S. Territories": use one of them for the nation and never sum all rows (that triple counts).
  State names are as FDIC writes them ("District Of Columbia").
- Dates come in different shapes per endpoint: FAILDATE "3/10/2023", institutions REPDTE
  "06/30/2026", financials REPDTE "20240331", history EFFDATE "2010-03-20T00:00:00". The adapter adds
  a `<column>_iso` (YYYY-MM-DD) column and keeps the published one. Filters use the endpoint's own form.
- State code field differs: STALP (institutions, financials, locations), PSTALP (failures, history),
  STALPBR (branch state in sod), STNAME (summary, full name).
- Without `fields` every row carries hundreds of columns; the pack refuses `financials`,
  `institutions` and `demographics` requests without it. `ID` is FDIC's row key, not a bank id.
- `institutions` holds closed institutions too: add `ACTIVE:1` for open ones (4,219 open, 2026-10).
- Old names: the API moved to `https://api.fdic.gov/banks`
  (the old host answers 301); failures use `NAME` (not INSTNAME); the charter field is `BKCLASS`
  (CHARTER_CLASS does not exist).

## Access
No key. Route `api` when api.fdic.gov answers. Manual route: INSTRUCTIONS.md lists one CSV link per
1,000 rows (`format=csv`); open them in a browser and upload the files. Or use BankFind Suite
(https://banks.data.fdic.gov/bankfind-suite/): pick the tab (Institutions, Failures, Financials,
Summary of Deposits), set the same filters, Download as CSV, upload. Field definitions:
https://banks.data.fdic.gov/docs/.

## Citation and terms
"Federal Deposit Insurance Corporation, BankFind Suite API (<endpoint>), api.fdic.gov/banks, retrieved
<date>." Public domain U.S. government data; attribute FDIC and do not imply endorsement.
Redistribution allowed.
