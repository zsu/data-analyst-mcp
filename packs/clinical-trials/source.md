# ClinicalTrials.gov (API v2)
Depth: standard. Key: none. The U.S. registry of clinical studies (about 608,000 records, worldwide):
conditions, interventions, sponsors, phases, status, enrollment, dates, locations, results flags.

## When to use
- Lists and counts of trials by condition, drug or device, sponsor (industry, NIH, other federal),
  phase, status, start year or location; one study's protocol record; registry-wide tallies by phase,
  status or sponsor class.
- Not here: trial outcome numbers in analysis-ready form (the results module is deeply nested; use the
  study record for one trial), NIH grant money (nih), drug approvals and adverse events (fda), industry
  payments to investigators (open-payments).

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `studies` | one row per study (1,000 a page, cursor paging) | `query.*`, `filter.*`, `aggFilters`, `phase`, `study_type`, `fields`, `sort` |
| `study` | one study, all modules (or `fields`) | `nct_id`, `fields` |
| `field_values` | `value, studiesCount` across the registry | `fields` (one field, e.g. `Phase`, `OverallStatus`, `LeadSponsorClass`) |

Searches (Essie syntax; `AND`, `OR`, quotes): `query.cond` (condition, matches synonyms), `query.intr`
(intervention), `query.term` (anywhere), `query.spons` / `query.lead` (sponsor / lead sponsor),
`query.titles`, `query.outc`, `query.locn`, `query.id`. Filters: `filter.overallStatus` (list:
RECRUITING, NOT_YET_RECRUITING, ACTIVE_NOT_RECRUITING, ENROLLING_BY_INVITATION, COMPLETED, SUSPENDED,
TERMINATED, WITHDRAWN, UNKNOWN), `filter.ids`, `filter.geo` (`distance(39.0,-77.1,50mi)`),
`filter.advanced` (`AREA[StartDate]RANGE[2024-01-01,MAX]`), `aggFilters` (`results:with`, `sex:f`).
Convenience: `phase` (EARLY_PHASE1, PHASE1-4, NA; a list means any of them) and `study_type`
(INTERVENTIONAL, OBSERVATIONAL, EXPANDED_ACCESS) become `aggFilters`.

Default `fields`: NCTId, BriefTitle, OverallStatus, Phase, StudyType, LeadSponsorName, LeadSponsorClass,
Condition, InterventionType, InterventionName, EnrollmentCount, EnrollmentType, StartDate,
PrimaryCompletionDate, CompletionDate, HasResults. Other piece names (LocationState, Sex, MinimumAge,
OfficialTitle, ...) are listed at https://clinicaltrials.gov/data-api/about-api/study-data-structure; an
unknown name is refused by the API (HTTP 400 naming it).

## Spec examples
```json
{"description": "Recruiting phase 3 sickle cell trials",
 "requests": [{"name": "scd_phase3_recruiting", "endpoint": "studies",
   "params": {"query.cond": "sickle cell", "filter.overallStatus": ["RECRUITING"], "phase": "PHASE3"}}]}
```
```json
{"description": "Industry-sponsored interventional semaglutide trials started since 2020",
 "requests": [{"name": "sema", "endpoint": "studies",
   "params": {"query.intr": "semaglutide", "study_type": "INTERVENTIONAL",
              "filter.advanced": "AREA[LeadSponsorClass]INDUSTRY AND AREA[StartDate]RANGE[2020-01-01,MAX]"}}]}
```
```json
{"description": "All registered studies by phase", "requests": [{"name": "phase_counts", "endpoint": "field_values", "params": {"fields": "Phase"}}]}
```

## Data format and traps
- Columns are renamed to their shortest unique path (`nctId`, `briefTitle`, `startDateStruct.date`,
  `leadSponsor.name`, `enrollmentInfo.count`); values are as published. Lists of strings are joined with
  "; " (`conditions`, `phases` such as "PHASE1; PHASE2"); lists of objects (`interventions`) are JSON text.
- Dates can be partial: "2024-05" (month only) is common (490 of 1,000 asthma start dates checked).
  Parse both forms; do not invent a day.
- `enrollmentInfo.type` is ESTIMATED for ongoing studies and ACTUAL after completion; do not sum the two
  as if both were actual participants.
- One study can list several phases and conditions: counts by phase or condition overlap. `field_values`
  counts studies per value, and studies with no value are reported separately by the API (missing count).
- Status UNKNOWN means the record has not been verified for a long time; the last known status is lost.
  Status, enrollment and dates change as sponsors update records: report the retrieval date.
- `leadSponsor.class`: INDUSTRY, NIH, FED, OTHER_GOV, NETWORK, INDIV, OTHER (seen in live records).
- The registry is worldwide; "U.S. trials" need `query.locn` or `AREA[LocationCountry]"United States"` and a
  study with any U.S. site counts as U.S.
- `pageSize` is capped at 1,000 (larger values are reduced silently); the pack pages with
  `nextPageToken` up to `max_rows` (default 100,000). `totalCount` comes with the first page.
- aggFilters phase codes are `0` (EARLY_PHASE1) and `NA` (not applicable);
  `early_phase1` and `not_applicable` match nothing (verified against registry counts).
- Rate limit: ClinicalTrials.gov documents a per-IP request limit (about 50 a minute; not verified here);
  the pack sends at most one request a second.

## Access
No key. Route `api` when clinicaltrials.gov answers. Manual route: INSTRUCTIONS.md gives the API link for
the first 1,000 studies (JSON, open in a browser); for more, run the same search on
https://clinicaltrials.gov/ (Advanced Search), choose Download, CSV, all studies and the columns needed,
and upload the file (its columns use display names such as "NCT Number").

## Citation and terms
"ClinicalTrials.gov, National Library of Medicine, <search description>, clinicaltrials.gov API v2,
retrieved <date>." Registry data are offered by NLM for public reuse; records are submitted by sponsors
(https://clinicaltrials.gov/about-site/terms-conditions). Redistribution allowed with attribution.
