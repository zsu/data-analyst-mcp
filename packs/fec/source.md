# OpenFEC (Federal Election Commission API)
Depth: standard. Key: optional (DATA_GOV_API_KEY; the public DEMO_KEY works for a few requests an hour).
Federal campaign finance from reports filed with the FEC: candidates, committees, financial totals,
itemized contributions and disbursements, independent expenditures. Coverage starts around 1980 and
varies by table; check the earliest cycle before a long trend.

## When to use
- Money raised and spent by candidates in a race; totals per cycle; small-donor share (by size); where
  contributions come from (by state, employer, occupation); PAC and party money; outside spending for or
  against a candidate; who a committee paid.
- Not here: lobbying spending and lobbyists' LD-203 contributions (senate-lobbying); state and local
  races (not covered); votes and bills (congress).

## Endpoints and datasets
| Endpoint | Returns (one row per) | Key parameters |
|---|---|---|
| `candidates_search` | candidate | `q` (name), `state`, `office` (H, S, P), `party`, `election_year`, `cycle`, `district` |
| `candidate`, `candidate_totals` | candidate record; totals per cycle | `candidate_id`, `cycle`, `election_full` |
| `candidates_totals` | candidate with receipts, disbursements, cash | `office`, `election_year`, `state`, `district`, `is_active_candidate`, `sort` |
| `elections` | candidate in one race with totals | `office` (house, senate, president), `cycle`, `state`, `district`, `election_full` |
| `committees`, `committee`, `committee_totals` | committee; record; totals per cycle | `q`, `committee_type`, `designation`, `organization_type`, `committee_id`, `cycle` |
| `schedule_a` | itemized receipt | `committee_id`, `contributor_name`, `contributor_employer`, `contributor_occupation`, `contributor_state`, `contributor_zip`, `is_individual`, `two_year_transaction_period`, `min_amount`, `min_date`, `per_page` |
| `schedule_b` | itemized disbursement | `committee_id`, `recipient_name`, `recipient_committee_id`, `disbursement_description`, `two_year_transaction_period` |
| `schedule_e` | independent expenditure | `candidate_id`, `committee_id`, `support_oppose_indicator` (S, O), `cycle`, `is_notice` |
| `contributions_by_size`, `contributions_by_state` | size bucket or state for a candidate | `candidate_id`, `cycle`, `election_full` |
| `committee_contributions_by_state`, `contributions_by_employer`, `contributions_by_occupation`, `disbursements_by_recipient` | state, employer, occupation or recipient for a committee | `committee_id`, `cycle` |
| `independent_expenditures_by_candidate` | support and oppose totals for a candidate | `candidate_id`, `cycle`, `election_full` |

IDs: candidates `S6PA00217` (office letter, first-run year digit, state, number), committees `C00431056`.
Find them with `candidates_search` or `committees` first. Committee types (catalog `committee_types`):
P, H, S candidate committees; Q, N PACs; O super PAC; V, W hybrid PAC; X, Y party; I independent
expenditure filers. A company's PAC is found with `committees` `q=<company>` and `organization_type=C`.

## Spec examples
```json
{"description": "2024 Pennsylvania Senate race and one candidate's small-donor and outside-spending profile",
 "requests": [
  {"name": "pa_senate_2024", "endpoint": "elections", "params": {"office": "senate", "state": "PA", "cycle": 2024}},
  {"name": "casey_by_size", "endpoint": "contributions_by_size", "params": {"candidate_id": "S6PA00217", "cycle": 2024}},
  {"name": "casey_outside", "endpoint": "independent_expenditures_by_candidate",
   "params": {"candidate_id": "S6PA00217", "cycle": 2024}}]}
```
```json
{"description": "Top 2024 House fundraisers in Texas",
 "requests": [{"name": "tx_house_2024", "endpoint": "candidates_totals",
   "params": {"office": "H", "state": "TX", "election_year": 2024, "is_active_candidate": "true"}, "max_rows": 200}]}
```
```json
{"description": "Contributions from committees (PACs) to one campaign, first 500",
 "requests": [{"name": "pac_receipts", "endpoint": "schedule_a",
   "params": {"committee_id": "C00431056", "two_year_transaction_period": 2024, "is_individual": "false"}, "max_rows": 500}]}
```

## Data format and traps
- Cycles: `cycle` and `two_year_transaction_period` are two-year periods named by the even year (2024 =
  2023-2024). `election_full=true` (the default here for races and candidate totals) adds up the whole
  election period: 6 years for a Senate seat, 4 for President. Say which one a number uses.
- Itemized is not total: Schedule A lists contributions over $200 per contributor per cycle (and some
  below); most small-dollar money is only in the unitemized totals. `contributions_by_size` bucket `0`
  is $200 and under, built from reported unitemized totals plus small itemized items (its `count` is
  empty). Use `candidate_totals` for receipts and the size buckets for donor mix.
- Earmarked and conduit money (ActBlue, WinRed) appears twice in itemized data: once at the conduit and
  once at the recipient (`memo_code` X marks memo entries). Leave memo rows out when summing receipts.
- Rows marked `- UNITEMIZED` in `contributor_name` (joint fundraising transfers) are aggregate amounts,
  not one contribution.
- Keyset paging: Schedules A, B and E page with `last_indexes` (the pack does it); `count` there is
  approximate when `is_count_exact` is false. Pages are at most 100 rows; a 50,000-row download is 500
  requests, so narrow by committee, date or amount first.
- Totals are revised when committees amend reports; recent quarters change for months. Report the
  retrieval date and `coverage_end_date`.
- Employer and occupation are typed by contributors ("SELF", "RETIRED", "NOT EMPLOYED", spelling
  variants); group with care and say so. The by-employer aggregate does not merge variants.
- Amounts are dollars (numbers). Independent expenditures `support_oppose_indicator`: S support, O oppose;
  24/48-hour notices (`is_notice=true`) are later repeated in regular reports, so do not add both.
- Candidate names are "LAST, FIRST" in capitals; party codes are three letters (DEM, REP, LIB, GRE, IND).

## Access
Key optional: DATA_GOV_API_KEY (https://api.data.gov/signup/), sent as `api_key`. DEMO_KEY allows only
a few requests an hour per IP; with a key the limit is per key. FEC documents 1,000 calls an hour for a
key and 7,200 an hour (120 a minute) on request to APIinfo@fec.gov (API description, 2026-10-22), but the
response header showed X-RateLimit-Limit 60 on a standard key (Oct 2026): plan for 60 and pace large specs. Larger specs make `--check` ask for the key.
Manual route: INSTRUCTIONS.md lists JSON links with `api_key=DEMO_KEY` (itemized schedules: the first
100 rows only); or set the same filters on https://www.fec.gov/data/ and use Export (CSV); whole
cycles are in the bulk files at https://www.fec.gov/data/browse-data/?tab=bulk-data.

## Citation and terms
"Federal Election Commission, OpenFEC API, <query>, api.open.fec.gov, retrieved <date>." Public
records; aggregate tables may be published. Required notice: information about individual contributors
may not be sold or used to solicit contributions or for commercial purposes (52 U.S.C. 30111(a)(4)).
Do not publish contributor-level lists (names, addresses) beyond what the analysis needs.
