# CFPB Consumer Complaint Database
Depth: standard. Key: none. Complaints about consumer financial products and services sent to the
Consumer Financial Protection Bureau since 2011 (18.5 million as of 2026-10): product, issue, company,
state, ZIP, dates, company response and timeliness. Narratives are no longer published (since 2026-08-14).

## When to use
- How many complaints, about what, against which companies, from which states; trends by month,
  quarter or year; how companies respond (monetary relief, explanation, untimely); complaints from
  older Americans or servicemembers; reading individual complaint records (no narrative text).
- Not here: bank financial condition or failures (fdic); company financial statements (sec); complaint
  rates per consumer need a denominator from another source (census population, fdic deposits);
  auto safety complaints (nhtsa); FTC fraud reports (not covered).

## Endpoints and datasets
| Endpoint | Returns (one row per) | Key parameters |
|---|---|---|
| `complaints` | complaint (newest first) | filters below; `sort`; `max_rows` (default 10,000) |
| `aggregations` | value of one field, with its count | `agg` (product, issue, company, state, timely, company_response, submitted_via, company_public_response, tags); `sub: true` for sub_product / sub_issue |
| `trends` | period (x value of `by`) | `interval` (year, quarter, month), `date_received_min`, `date_received_max` (both required), `by` |
| `complaint` | one complaint | `complaint_id` |

Filters (all endpoints): `product`, `sub_product`, `issue`, `sub_issue`, `company`, `state`, `zip_code`,
`date_received_min` / `_max` (YYYY-MM-DD, inclusive), `company_received_min` / `_max`,
`company_response`, `submitted_via`, `timely` (Yes/No), `tags`, `search_term` with `field` (all or
company; any other value is HTTP 400). A list value means OR (`"state": ["TX", "OK"]`). `sub_product`
needs exactly one `product` and `sub_issue` exactly one `issue` (see traps). Any other parameter is
refused (`fix_spec`). `--endpoints` lists the product names seen in the database.

## Spec examples
```json
{"description": "Wyoming complaints by product, 2025",
 "requests": [{"name": "wy_by_product", "endpoint": "aggregations",
   "params": {"agg": "product", "state": "WY", "date_received_min": "2025-01-01", "date_received_max": "2025-12-31"}}]}
```
```json
{"description": "Student loan complaints in Wyoming per quarter, 2025, and the latest four",
 "requests": [
   {"name": "wy_student_quarterly", "endpoint": "trends",
    "params": {"interval": "quarter", "product": "Student loan", "state": "WY",
               "date_received_min": "2025-01-01", "date_received_max": "2025-12-31"}},
   {"name": "wy_student_latest", "endpoint": "complaints",
    "params": {"product": "Student loan", "state": "WY", "date_received_min": "2025-01-01",
               "date_received_max": "2025-12-31"}, "max_rows": 4}]}
```
```json
{"description": "Exact company names that match 'wells fargo', with counts",
 "requests": [{"name": "wf_names", "endpoint": "aggregations",
   "params": {"agg": "company", "search_term": "wells fargo", "field": "company"}}]}
```

## Data format and traps
- Counts come from `aggregations` and `trends`; never count by downloading complaints (10,000 rows at
  most per request, and slow). `total_matching` is the number of complaints matching the filters.
- Filters match exact names and are case-sensitive: product, issue and company must be written as CFPB
  writes them ("WELLS FARGO & COMPANY", "Credit card or prepaid card"). A filter that matches nothing
  fails with a hint; find exact names with `aggregations` (agg=company plus a search_term). The pack
  never switches to a fuzzy search on its own.
- Product and issue names changed over time: credit reporting is "Credit reporting, credit repair
  services, or other personal consumer reports" for older complaints and "Credit reporting or other
  personal consumer reports" for newer ones; "Credit card or prepaid card" vs "Credit card"; "Bank
  account or service" (old) vs "Checking or savings account". A trend for one product must list every
  name (a list filter) and say so; check `aggregations` by product over the whole period first.
- Credit reporting complaints dominate (about 15 of 18.5 million under the two credit reporting
  names, 2026-10): totals across all products are driven by them; report them separately.
- Dates: `date_received` and `date_sent_to_company` are timestamps (UTC, `2025-11-28T17:09:59.000Z`);
  both date filters are inclusive by day (verified: Jan 1-15 plus Jan 16-31 equals January). Recent
  periods keep growing for weeks as complaints are processed; `trends` notes an incomplete last period.
- Sub-products and sub-issues: the API ignores `sub_product` and `sub_issue` parameters (HTTP 200 with
  unfiltered totals, verified 2026-10-22) and filters them only as `product` / `issue` values written
  `<parent>` + U+2022 bullet + `<child>`. The pack builds that form from `sub_product` / `sub_issue`, so
  each needs exactly one parent value; a list of children is an OR within that parent. The API also
  ignores any filter name it does not know, so the pack refuses undeclared parameters.
- `company_response` "In progress" complaints are not final. `consumer_disputed` stopped in 2017 and is
  not a filter (the API ignores it; the pack refuses it). ZIP codes may be truncated.
- Narratives: CFPB stopped publishing consumer complaint narratives on 2026-08-14. Live records have no
  `complaint_what_happened`, `has_narrative` is not a filter any more (ignored by the API; the pack
  refuses it), and `field` can no longer search narratives. Narratives previously published (complaints
  received 2011-12-01 through 2026-08-14) are in CFPB's FOIA reading room as zipped exports (manual route):
  https://www.consumerfinance.gov/foia-requests/foia-electronic-reading-room/cfpb-consumer-complaint-database-narratives-archive/
- Complaints are not a statistical sample, companies' volumes reflect their size, and CFPB does not
  verify every allegation: never present counts as prevalence or company quality without context.
- API traps: the `field` parameter is not an aggregation selector (it chooses where
  `search_term` looks); `frm` offset paging is ignored (this pack pages with `search_after`); `/trends`,
  `/geo/states` and `/_suggest_company` return the web page instead of JSON (checked 2026-10-20).

## Access
No key. Route `api` when www.consumerfinance.gov answers. Manual route: INSTRUCTIONS.md gives one
link per request: complaint lists as CSV (`format=csv`, up to 10,000 rows), counts as JSON (one file per
period for trends). Or open https://www.consumerfinance.gov/data-research/consumer-complaints/search/,
set the same filters, choose Export data > CSV, and upload the file. The full database is a bulk CSV
on the same page (very large; filter before downloading).

## Citation and terms
"Consumer Financial Protection Bureau, Consumer Complaint Database, consumerfinance.gov, retrieved
<date>." CC0 (public domain dedication); redistribution allowed. Reports must say that complaints are
not a statistical sample (the audit checks for this).
