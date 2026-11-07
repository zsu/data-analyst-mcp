# Lobbying Disclosure (LDA.gov API)
Depth: standard. Key: optional (LDA_API_KEY; without it 15 requests a minute). Federal lobbying
registrations (LD-1), quarterly activity reports with income or expenses and issues lobbied (LD-2), and
lobbyists' semiannual contribution reports (LD-203), 1999 to date, from the Senate Office of Public Records.

## When to use
- Lobbying spending by a company, trade group or firm per quarter or year; who lobbied for a client; which
  issues (general issue codes) and bills (specific-issues text) a client lobbied on; lobbyists' former
  government positions; contributions and honoraria reported by registrants and lobbyists.
- Not here: campaign contributions from individuals and PACs to candidates (fec); bill details and votes
  (congress); foreign agents (FARA, not covered); state lobbying (not covered).

## Endpoints and datasets
| Endpoint | Returns (one row per) | Key parameters |
|---|---|---|
| `filings` | filing (LD-1 or LD-2): registrant, client, period, income, expenses, activities as JSON, `is_amendment`, `is_termination` | `filing_year`, `filing_period`, `filing_type`, `registrant_name`, `client_name`, `client_state`, `lobbyist_name`, `lobbyist_covered_position`, `filing_specific_lobbying_issues`, `foreign_entity_country`, `filing_amount_reported_min/max`, `filing_dt_posted_after/before`, `ordering` |
| `filing_activities` | lobbying activity within a filing: issue code, specific issues text, lobbyists, entities contacted | same as `filings`, plus `issue_code` (filtered by the pack after download) |
| `filing` | one filing, every field | `filing_uuid` |
| `contributions` | LD-203 contribution item (contributor, payee, honoree, amount, date); a report with none gives one row with `no_contributions=True` | `filing_year`, `filing_period` (mid_year, year_end), `registrant_name`, `lobbyist_name`, `contribution_payee`, `contribution_honoree`, `contribution_type`, `contribution_amount_min/max`, `contribution_date_after/before` |
| `registrants`, `clients`, `lobbyists` | entity records with ids | `registrant_name`, `client_name`, `lobbyist_name`; registrants `id`, `state`; clients `id`, `client_state` (the API ignores `state`, `client_id` and `registrant_id` there and returns every row; the pack renames them) |
| `issue_codes`, `filing_types`, `government_entities` | code lists | none |

Name filters match substrings without case ("pfizer" matches "PFIZER INC." and its outside firms'
reports for Pfizer). Issue codes (catalog, `--search health`): HCR health, MMM Medicare/Medicaid, PHA
pharmacy, TAX, BUD budget/appropriations, DEF defense, ENV environment, ENG energy, FUE fuel/gas/oil,
TRD trade, FIN financial institutions, BAN banking, SCI science/technology, TEC telecommunications, CPI
computer industry, IMM immigration, LBR labor, TRA transportation, AGR agriculture, HOU housing, CSP
consumer issues, HOM homeland security, INS insurance, CPT copyright/patent/trademark (79 in all:
`issue_codes`).

## Spec examples
```json
{"description": "Pfizer's own lobbying reports for Q1 2024, and the tax activities in them",
 "requests": [
  {"name": "pfizer_q1_2024", "endpoint": "filings",
   "params": {"registrant_name": "Pfizer", "client_name": "Pfizer", "filing_year": 2024, "filing_period": "first_quarter"}},
  {"name": "pfizer_q1_2024_tax", "endpoint": "filing_activities",
   "params": {"registrant_name": "Pfizer", "client_name": "Pfizer", "filing_year": 2024,
              "filing_period": "first_quarter", "issue_code": "TAX"}}]}
```
```json
{"description": "Every firm's 2024 reports for one client (in-house and outside firms)",
 "requests": [{"name": "client_2024", "endpoint": "filings", "params": {"client_name": "Pfizer", "filing_year": 2024}}]}
```
```json
{"description": "LD-203 contributions reported by one lobbyist in 2024",
 "requests": [{"name": "lobbyist_2024", "endpoint": "contributions", "params": {"lobbyist_name": "Pomper", "filing_year": 2024}}]}
```

## Data format and traps
- Income or expenses, not both: an outside firm reports `income` from each client; an organization
  lobbying for itself reports `expenses` (all its lobbying costs, which usually include what it paid
  outside firms). Total spend for a company = its own `expenses`; adding the firms' `income` from it
  double counts. Amounts are dollars as text ("3550000.00"); LD-2 instructions round amounts of $5,000
  or more to the nearest $10,000, and an amount under $5,000 is reported as empty.
- Amendments: an amended report (`filing_type` 1A, 2A, ... and `is_amendment=True`) restates the same
  registrant, client and period; both stay in the data. Example: Pfizer Q1 2024 original Q1 $3,550,000,
  amendment 1A $3,740,000. Keep the latest `dt_posted` per registrant, client, year and period before
  summing. Terminations (1T, 1@, ...) end a registration; quarterly codes ending in Y (Q1Y, 1AY) mean
  no activity. Pre-2008 codes differ (MM mid-year, YY year-end, MA amendment); `filing_type_display`
  spells every code out.
- `filing_activities` repeats each filing's income or expenses on every activity row: never sum amounts
  over activities. An issue code shows that the filing lobbied on the issue, not how much was spent on it.
- `issue_code` is not an API filter (the API has none); the pack downloads the filings matching the other
  filters and keeps matching activities, so always give a registrant, client, year or period too.
- Filings and contributions need at least one filter to page past the first 25 rows (the pack refuses
  specs without one). Page size is fixed at 25 (larger values are silently capped), so 1,000 filings take
  40 requests: about 3 minutes without a key at 15 requests a minute.
- Periods: quarterly reports since 2008 (`first_quarter` ... `fourth_quarter`); before 2008 reports were
  semiannual (`mid_year`, `year_end`) under different rounding and threshold rules. Compare years with
  annual totals, not quarters, across 2008. The database starts in 1999.
- Government entities per activity exist only for filings posted after 2021-02-14; older filings list
  entities for the filing as a whole (LDA API caveat).
- **Repeated filings.** A filter on what a filing holds (`filing_specific_lobbying_issues`, `lobbyist_name`,
  `lobbyist_covered_position`, `foreign_entity_*`, and for LD-203 the `contribution_*` item filters) makes
  the API return a filing once per matching activity, lobbyist or item (live 2026-10-28: one page held 25
  rows for 17 filings), and its `count` counts the repeats. The pack keeps one row per `filing_uuid` (per `id`
  for registrants, clients, lobbyists) before splitting into activities or items, and the fetch notes how
  many repeats it dropped. Count filings by distinct `filing_uuid` in any file you build yourself.
- `filing_specific_lobbying_issues` searches free text written by the filer: bill numbers appear in many
  forms ("H.R. 4763", "HR 4763", "H.R.4763"); try several. Search syntax (verified 2026-10-22): plain
  words must all match (AND: `broadband spectrum` found fewer filings than either word), `OR` between
  words matches either, double quotes make a phrase (`"broadband spectrum"`), and `-word` excludes.
- Moved host: the old lda.senate.gov API was sunset on 2026-07-31 (it now redirects); this pack uses
  lda.gov only.

## Access
Key optional: LDA_API_KEY (free, https://lda.gov/api/register/), sent as the header
`Authorization: Token <key>`; 120 requests a minute instead of 15. The pack paces itself under the
anonymous limit; a 429 answer asks to wait (Retry-After can be 25 minutes), so do not retry in a loop.
Manual route: INSTRUCTIONS.md lists the first JSON page of each request (no key; follow `next` links for
more), or use https://lda.gov/filings/public/filing/search/ and
https://lda.gov/filings/public/contribution/search/ and download the result lists.

## Citation and terms
"U.S. Senate Office of Public Records, Lobbying Disclosure Act database (LDA.gov API), <query>, data
accessed <date>." The terms require the access date and this statement in any report: "Senate Office of
Public Records cannot vouch for the data or analyses derived from these data after the data have been
retrieved from LDA.gov." Do not modify content and still cite it as LDA.gov; the Senate seal may not be
used. Redistribution of the records is allowed.
