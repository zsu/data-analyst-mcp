# HMDA mortgage lending data (FFIEC HMDA Data Browser API: applications and originations by loan type, purpose, applicant and place)
Depth: standard. Key: none. The Home Mortgage Disclosure Act data that mortgage lenders report each year to the
Federal Financial Institutions Examination Council, published by the Consumer Financial Protection Bureau:
counts and total loan amounts of applications and loans by action taken (originated, denied, ...), loan type
(conventional, FHA, VA, USDA), purpose, lien, property type and applicant race, ethnicity and sex, for the
nation, states, counties and metro areas, 2018 on.

## When to use
- Volume of government-backed mortgage lending: FHA-insured, VA-guaranteed and USDA (RHS/FSA) guaranteed loans
  originated by year and state, county or metro area, in count and dollars, to project new guarantee
  commitments of those programs or to pair with their credit subsidy rates (omb, Federal Credit Supplement).
- The FHA or VA share of home purchase lending; refinance waves (refinancing and cash-out refinancing against
  home purchase); manufactured home and multifamily lending.
- Denial rates (denied over originated plus approved not accepted plus denied) by loan type, place or applicant
  group.
- Not here: loan-level records or rate spread, income, credit score and LTV detail (the national loan-level
  files at ffiec.cfpb.gov/data-publication, manual); years before 2018 (the older HMDA format, not served by
  this API); house prices (fhfa); mortgage rates (fred, nyfed); complaints about lenders (cfpb); program outlays
  and subsidy costs (omb, treasury, usaspending).

## Endpoints and datasets
Base `https://ffiec.cfpb.gov/v2/data-browser-api/view`, keyless, JSON (verified live 2026-11-25). One CSV per
request.

| Endpoint | Returns (one row per) | Key parameters | Coverage |
|---|---|---|---|
| `aggregations` | year x place x filter values: `year, geography, geography_code, <filters>, <filter>_label, count, loan_amount` | `years` (required; one, a list or a range `"2018-2024"`), exactly one of `states` (`CA`), `counties` (`06037`), `msamds` (`35614`), `actions_taken` (required) and at most one more filter | 2018 to the latest year |
| `nationwide` | year x filter values, `geography` = `nation` | `years`, `actions_taken` (required) and at most one more filter | 2018 to the latest year |

Filters (one value or a list; every value gets its own rows): `actions_taken` (1 originated, 2 approved not
accepted, 3 denied, 4 withdrawn, 5 closed incomplete, 6 purchased, 7 and 8 preapprovals), `loan_types`
(1 conventional, 2 FHA, 3 VA, 4 USDA RHS/FSA), `loan_purposes` (1 purchase, 2 improvement, 31 refinancing,
32 cash-out refinancing, 4 other, 5 not applicable), `lien_statuses` (1 first, 2 subordinate),
`construction_methods` (1 site-built, 2 manufactured), `total_units` (`1` ... `>149`), `dwelling_categories`,
`loan_products` (`FHA:First Lien`), `races`, `ethnicities`, `sexes` (derived applicant groups, as text).
- `count` is the number of records; `loan_amount` is their total loan amount in nominal dollars.
- The pack sends one call per year and place and adds `year`, `geography` and `geography_code` (at most 400
  calls a request). Coded filters get a `_label` column.

## Spec examples
```json
{"description": "FHA, VA and USDA guaranteed home loans originated nationwide, 2022-2024",
 "requests": [
  {"name": "govt_loans", "endpoint": "nationwide", "params": {"years": "2022-2024", "actions_taken": 1, "loan_types": [2, 3, 4]}}]}
```
```json
{"description": "FHA-insured loans originated and denied in Texas and Ohio, 2023",
 "requests": [
  {"name": "fha_tx_oh", "endpoint": "aggregations", "params": {"years": 2023, "states": ["TX", "OH"], "actions_taken": [1, 3], "loan_types": 2}}]}
```

## Data format and traps
- The API sums lists of years or places: `years=2022,2023` or `states=CA,TX` gives one figure with no year or
  state on it. The pack therefore makes one call per year and place; never add the rows of different filters
  together unless the categories are exclusive (each filter's values are).
- At most two filters per request (the API refuses a third): `actions_taken` and one more. For a cross of loan
  type and purpose, use `loan_products` or one request per purpose.
- `actions_taken` is required here. Without it the API counts every record: applications, denials, withdrawals
  and purchased loans together. Purchased loans (6) repeat loans that the originating lender also reported, so
  leave them out of origination counts.
- `ages` is not applied by the API (it answers as if absent), so the pack refuses it. The pack checks every row
  carries each filter asked.
- Reporting thresholds: HMDA covers lenders above the asset and loan-volume thresholds (small banks and credit
  unions in rural areas may be exempt), so totals are reported lending, most but not all of the market. For an
  FHA or VA program total, use the agency's own endorsement or guaranty counts (HUD FHA reports, VA) as the
  benchmark; HMDA is the geographic and borrower detail.
- Loan amounts in the public data are rounded to the midpoint of a 10,000-dollar band, so sums are close to but
  not exactly the dollars lent.
- Metro codes: for the largest MSAs (New York, Los Angeles, Chicago and others) HMDA uses metropolitan division
  codes; the MSA code answers count 0, not an error. The pack notes a place where every count is 0. County codes
  must be 5 digits (`06037`; `6037` answers HTTP 404).
- Vintage: each year is first published as a snapshot (spring of the next year) and revised in the one- and
  three-year datasets; the Data Browser serves its latest copy. Cite the retrieval date. The API's own message
  for a year it lacks names an old range ("2018-2023"); the latest year it serves is newer.
- Race, ethnicity and sex are derived from the applicant and co-applicant (`Joint` when they differ).

## Access
No key; the host answers scripts (verified 2026-11-25). Limit used: two requests per second. `fetch` works
directly. Manual: the Data Browser at https://ffiec.cfpb.gov/data-browser/data/ (pick year, geography and
filters, View Summary Table, Download CSV) or the national files at https://ffiec.cfpb.gov/data-publication/.

## Citation and terms
Federal Financial Institutions Examination Council, Home Mortgage Disclosure Act data, HMDA Data Browser
(<years, geography, filters>), ffiec.cfpb.gov, retrieved <date>. U.S. government works in the public domain
(17 U.S.C. 105); redistribution allowed.
