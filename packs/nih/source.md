# NIH RePORTER (research grants)
Depth: standard. Key: none. NIH (and AHRQ, CDC centers, FDA, VA) extramural and intramural research awards from the
RePORTER API v2: one row per project per fiscal year, with organization, investigator, institute, award
amount and RCDC spending categories; plus publications linked to projects.

## When to use
- NIH funding by institute, organization, state, investigator, activity code or topic, by fiscal year;
  lists of grants on a topic; publications (PMIDs) of a project.
- Not here: NIH's official RCDC category totals (published at report.nih.gov; not computed by this API),
  clinical trials (clinical-trials), all federal grants and contracts across agencies (usaspending),
  health outcomes (cdc), drug approvals (fda), industry payments (open-payments).

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `projects` | award rows (POST /projects/search; 500 a page, at most 15,000) | criteria keys below, `include_fields`, `sort_field`, `sort_order` |
| `publications` | `coreproject, pmid, applid` rows (500 a page, at most 10,000) | `core_project_nums`, `pmids` or `appl_ids` |

Criteria keys (put directly in `params`; the adapter builds RePORTER's `criteria` object; a raw
`criteria` object is merged too): `fiscal_years` [2024], `agencies` ["NCI", "NIA"], `org_states` ["VT"],
`org_names`, `org_cities`, `activity_codes` ["R01"], `pi_names` [{"last_name": "...", "first_name": "..."}],
`project_nums`, `appl_ids`, `award_amount_range` {"min_amount", "max_amount"}, `include_active_projects`,
`covid_response`, `text` or `phrase` (searched in title, terms and abstract; `text_fields` narrows it),
`spending_categories` (RCDC names or ids: `["Cancer", "Opioids"]`), `exclude_subprojects` (default true).

Text search: `text` matches **every word anywhere** in those fields, in any order (RePORTER operator
`and`), so a two-word topic also returns projects that use both words apart; `phrase` matches the **exact
phrase** (operator `advanced`, quoted; a list matches any of the phrases). When the user names a topic of
several words (a disease, a technique), use `phrase`; use `text` for words that may appear apart. The
fetch note says which was used (verified 2026-10: a two-word disease name, one fiscal year: 312 projects
with every word, 301 with the phrase).

RCDC categories: `--search "alzheimer"` lists names and ids (308 categories observed in live records,
e.g. Cancer 132, Breast Cancer 120, Alzheimer's Disease 40, Diabetes 224, HIV/AIDS 284, Opioids 3951,
Mental Health 443, Cardiovascular 140). Institute codes: NCI, NHLBI, NIDDK, NINDS, NIA, NIAID, NIGMS, NIMH,
NIDA, NICHD, NEI, NIEHS, NIAAA, NHGRI, NIBIB, NIMHD, NCATS, NLM, FIC, OD (`--search` lists them).

Default `include_fields` (PascalCase, as the API wants): ApplId, ProjectNum, CoreProjectNum,
SubprojectId, FiscalYear, ProjectTitle, Organization, ContactPiName, AgencyIcAdmin, AgencyIcFundings,
ActivityCode, FundingMechanism, AwardAmount, DirectCostAmt, IndirectCostAmt, project dates, IsActive,
SpendingCategoriesDesc, CongDist, ProjectDetailUrl. Add AbstractText or Terms if needed;
`"include_fields": "all"` returns everything (large). Result columns are snake_case
(`award_amount`, `organization.org_name`, `agency_ic_admin.abbreviation`).

## Spec examples
```json
{"description": "NCI breast cancer projects at Vermont organizations, FY2024",
 "requests": [{"name": "vt_nci_breast_2024", "endpoint": "projects",
   "params": {"fiscal_years": [2024], "org_states": ["VT"], "agencies": ["NCI"], "phrase": "breast cancer"}}]}
```
```json
{"description": "NIA Alzheimer's (RCDC) awards, FY2023 and FY2024",
 "requests": [{"name": "nia_ad_2023", "endpoint": "projects", "params": {"fiscal_years": [2023], "agencies": ["NIA"], "spending_categories": ["Alzheimer's Disease"]}},
              {"name": "nia_ad_2024", "endpoint": "projects", "params": {"fiscal_years": [2024], "agencies": ["NIA"], "spending_categories": ["Alzheimer's Disease"]}}]}
```
```json
{"description": "Publications of project R01CA282725",
 "requests": [{"name": "pubs", "endpoint": "publications", "params": {"core_project_nums": ["R01CA282725"]}}]}
```
One request per fiscal year keeps each under the 15,000-record cap and makes the totals easy to check.

## Data format and traps
- A row is one award (project-year). The same core project can have several rows in a year
  (supplements such as `3P01CA240685-04S1`, revisions). Count projects with `core_project_num`; sum
  `award_amount` over all rows for money.
- `award_amount` is total cost (direct + indirect) of that award in the fiscal year, in dollars;
  co-funded awards list each institute's share in `agency_ic_fundings` (JSON text). The `agencies`
  criterion selected the administering institute in all 500 rows checked; attribute money by
  `agency_ic_admin` or split by `agency_ic_fundings`, and say which.
- Multi-project awards: subproject rows repeat money already in the parent's `award_amount` (NCI P01,
  FY2024: 105 parent rows $187,410,847; with subprojects 704 rows, the 599 subproject rows adding
  $187,438,749 of repeated money, verified 2026-10-22). The pack sends `exclude_subprojects: true` unless
  the spec sets it false; never sum both.
- Fiscal years are federal (October-September). Recent years grow as awards are added during the year.
- One `projects` search returns at most 15,000 records (offset + limit <= 15,000; limit <= 500, verified).
  A `publications` search returns at most 10,000 (offset above 9,999 answers HTTP 400, verified
  2026-10-22). The pack stops at the cap with a note ("stopped at N rows"); split by fiscal year, institute
  or state, or split the project numbers / PMIDs over several requests.
- Paging needs a stable order: unsorted, the order shifts between pages, so rows repeat at a page boundary
  while as many others are skipped (the row count still matches `meta.total`; verified 2026-10-28). The
  pack sorts project searches that may need more than one page (no `max_rows`, or above 500) by `appl_id`
  unless the spec sets `sort_field`, and drops any row repeated across pages with a note that rows may be
  missing. With that default, a cut at `max_rows` keeps the lowest `appl_id`s, not the most relevant rows
  (the note says so): to keep a top N, set `sort_field` (`award_amount`, `desc`); to rank every row, fetch
  them all (no cut) and sort the CSV. A `max_rows` of 500 or less is one page in the API's own order
  (relevance for a text search), so its cut carries no appl_id note.
- `include_fields` names are PascalCase and case-sensitive; an unknown name is dropped without an error
  (the column is simply absent). Organization fields come as one block: ask for `Organization` (giving
  `organization.org_name`, `organization.org_state`, ...); `OrgName` or `OrgState` return nothing.
- RCDC tags overlap (a project carries many categories) and NIH's published RCDC totals use its own
  weighting and inclusion rules: a sum of `award_amount` over tagged projects is "funding of projects
  tagged X", not NIH's official category total. Text search is broader and noisier still.
- RCDC ids: 27 is "Adolescent Sexual Activity", not Cancer (use the category names). A category total
  must sum all rows, not the top 50 awards.
- Dates are ISO timestamps (`2023-09-19T00:00:00`); `is_active` is True/False text.

## Access
No key. NIH asks for no more than one request per second and large jobs at night or on weekends
(api.reporter.nih.gov); the pack sends one per second. Route `api` when the host answers. Manual route:
the API takes POST requests, so the bundle's download_data.sh / .ps1 scripts (one command, no Python) are the way to run the
same queries elsewhere; or run the search at https://reporter.nih.gov/advanced-search, Export to CSV and
upload it (the export uses display column names, not the API names). Bulk files by fiscal year:
https://reporter.nih.gov/exporter.

## Citation and terms
"National Institutes of Health, RePORTER: <description>, api.reporter.nih.gov, retrieved <date>."
U.S. government data in the public domain; redistribution allowed. Abstracts are written by applicants:
quote briefly.
