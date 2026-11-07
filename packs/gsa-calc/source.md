# GSA CALC+ Labor Ceiling Rates (Quick Rate API)
Depth: standard. Key: none. Awarded hourly ceiling rates for labor categories on GSA Multiple Award
Schedule (MAS) services contracts: labor category title, vendor, contract, price for the current and
next two option years, education, minimum experience, worksite, business size, clearance, SIN.

## When to use
- Market research and cost estimates (IGCEs): what schedule contractors may charge per hour for a kind
  of labor, by education, experience, worksite or business size; every rate on one contract.
- Not here: wages actually paid to workers (bls OEWS, opm for federal pay), what agencies actually spent
  or ordered (usaspending, fpds), GSA per diem rates (gsa per diem pack if present).
- These are ceiling prices (maximum, fully burdened hourly prices including overhead and profit), not
  prices paid and not wages. Task orders are often priced below the ceiling.

## Endpoints and datasets
One host: `https://api.gsa.gov/acquisition/calc/v3/api/ceilingrates/` (no key; verified 2026-10).

| Endpoint | Returns | Key parameters |
|---|---|---|
| `rates` | rate rows (JSON), pages of 500, at most 10,000 rows | `keyword` or `search`, filters, `ordering`, `sort` |
| `rates_export` | the same search as one CSV export, no 10,000 cap; rates identical in every exported column appear once | same |
| `rate_stats` | one row over all matches: count, min, max, mean, std_dev_sample, median, p10-p90 | same filters |
| `rate_facets` | counts by education_level, worksite, business_size, security_clearance, min_years_experience, labor_category (top 500) | same filters |
| `suggest_labor_category` / `suggest_vendor_name` / `suggest_contract` | values containing a text, with counts | `prefix` |

Search modes: `keyword` = wildcard over labor category, vendor and contract number (2+ characters);
`search` = exact, case-sensitive `field:value` on `labor_category`, `vendor_name` or `idv_piid`.
Filter parameters (the pack turns them into `filter=field:value`): `education_level` (HS, AA, BA, MA,
PHD; several as `BA|MA`), `experience_range` (`3,10`), `min_years_experience`, `price_range` (`50,150`),
`current_price`, `worksite` (customer, contractor, virtual), `business_size` (S, O), `security_clearance`
(yes, no), `sin` (54151S), `category`, `subcategory`; or a raw list in `filter`.
Columns (rates, rates_export): `labor_category`, `vendor_name`, `idv_piid` (contract), `current_price`,
`next_year_price`, `second_year_price`, `education_level`, `min_years_experience`, `worksite`,
`business_size`, `security_clearance`, `schedule`, `sin`, `category`, `subcategory`, `contract_start`,
`contract_end`; `rates` adds `id`, `data_source`, `_timestamp` (index build time) and date codes.

## Spec examples
```json
{"description": "Data scientist ceiling rates, master's degree, small business; statistics over all matches",
 "requests": [{"name": "ds_ma_small", "endpoint": "rates",
               "params": {"keyword": "data scientist", "education_level": "MA", "business_size": "S"}},
              {"name": "ds_stats", "endpoint": "rate_stats", "params": {"keyword": "data scientist"}}]}
```
```json
{"description": "Every rate on one contract, and exact title spellings",
 "requests": [{"name": "contract_rates", "endpoint": "rates", "params": {"search": "idv_piid:47QREA22D000R"}},
              {"name": "titles", "endpoint": "suggest_labor_category", "params": {"prefix": "software eng"}}]}
```
```json
{"description": "All engineer rates, 5-15 years experience, customer site (more than 10,000 rows)",
 "requests": [{"name": "eng_export", "endpoint": "rates_export",
               "params": {"keyword": "engineer", "experience_range": "5,15", "worksite": "customer"}}]}
```

## Data format and traps
- **One rate appears once per worksite.** A vendor that offers a category at both customer and contractor
  sites has two rows with the same price. Counts, means and medians over rows (including `rate_stats`)
  weight such categories twice. De-duplicate on (`idv_piid`, `labor_category`, `current_price`) when the
  question is about distinct offers, and say which way you counted.
- Titles are free text chosen by each vendor ("Data Scientist III", "Sr. Data Scientist", "DATA
  SCIENTIST 03"); levels are not comparable across vendors. A `keyword` search also matches vendor names
  and contract numbers. Report the search used and look at `suggest_labor_category` before grouping.
- Filter values are case-sensitive and a wrong value fails silently (verified 2026-10): `worksite` must
  be lower case customer / contractor / virtual ("Contractor/Customer/Both" are ignored and
  return everything); `education_level` must be upper case (lower case is ignored); `business_size` upper
  case (lower case matches nothing). The pack fixes the case and rejects other values. An unknown filter
  field is also silently ignored (HTTP 200, every rate returned; verified 2026-10-22: `filter=schedule:MAS`,
  `filter=labor_category:...` do nothing), so the pack accepts raw `filter` entries only for the fields
  listed above; labor category, vendor and contract go in `search`. An unknown `search` or `ordering`
  field answers HTTP 406 with an empty body (`search` takes only labor_category, vendor_name, idv_piid;
  the pack checks it).
- `search` is exact and case-sensitive ("labor_category:data scientist" finds nothing).
- The JSON search stops at 10,000 rows (hits.total says "10000, gte"); a page past row 10,000 answers HTTP
  406 with an empty body (verified 2026-10-22; the pack never asks for one). Use `rates_export` (CSV, all
  rows; 55,000+ rows for "engineer", about 19 MB) or `rate_stats`.
- `rates_export` writes one line per distinct row of its exported columns: rates identical in all of them
  (same contract, category and prices; different JSON `id`) appear once, so the export can hold fewer rows
  than the search matches ("data scientist": 1,504 rows for 1,516 matches; "accountant" 751 for 755;
  verified 2026-10-28). The fetch counts the matches (one
  `rate_stats` call) and notes any shortfall. Count rates with `rate_stats`; when every rate must be a row,
  use `rates` (JSON, with `id`; at most 10,000).
- A `rates_export` with no matches is only the SEARCH VALUES / FILTER VALUES preamble with no header line;
  the pack reads it as zero rows and fails with "returned no rows" (as the other endpoints do).
- `page_size` is ignored unless `page` is also sent (the pack always sends both).
- `rate_stats` statistics are computed by the search engine over rows: mean and standard deviation are
  exact over the matches; percentiles and median are approximations that can move slightly between calls
  (168.97 and 168.91 for the same query). Prices are dollars per hour, not adjusted for inflation; option
  years (`next_year_price`, `second_year_price`) carry the contract's escalation and may be empty.
- `rates_export` columns are renamed to the JSON names, and two codings are aligned with the JSON:
  business size "small business" / "other than small business" become S / O, security clearance
  "Yes" / "No" become True / False. Education spellings differ from the filter codes (Bachelors, Masters,
  PhD, High School, plus "None" and "Other Tech School or Certification").
- `security_clearance` is True/False text; `worksite` values are Customer_Facility, Contractor_Facility,
  Virtual. Contract dates are YYYY-MM-DD; contracts past `contract_end` drop out of the index.
- The index is rebuilt nightly; results change from day to day. Record the retrieval date.
- The API documentation marks the service as beta; the legacy CALC API was retired in February 2025.

## Access
No key (no api.data.gov key needed; verified without one). Route `api` when api.gsa.gov answers; the
pack keeps to 2 requests a second. Manual route: `manual_download/INSTRUCTIONS.md` gives one CSV export
link per request (`export=y`, every matching row, identical rows once); the browser saves `ceilingrates_results.csv`: rename
it to the name shown, upload, then `--ingest` (the export layout is parsed and renamed as above).
Aggregation and suggestion requests get JSON links instead. Without the links: https://buy.gsa.gov/pricing/
(CALC+ Labor Ceiling Rates), search, set filters, Export, upload.

## Citation and terms
"U.S. General Services Administration, CALC+ Labor Ceiling Rates, api.gsa.gov, retrieved <date>."
Public domain (U.S. government work; GSA website policies). Redistribution allowed. Reports must call
the numbers ceiling rates (audit hook `calc_ceiling_not_paid`).
