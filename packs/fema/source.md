# OpenFEMA (FEMA open data API)
Depth: standard. Key: none. FEMA disaster declarations since 1953, Individual and Public Assistance, NFIP
flood insurance claims and policies, hazard mitigation grants, mission assignments, by state, county, ZIP.

## When to use
- Disaster declarations by state, year, incident type; FEMA aid after a disaster (housing assistance,
  IHP registrations, Public Assistance obligations, per-disaster financial totals); NFIP flood claims
  and policies; hazard mitigation grants; FEMA tasking of other agencies (mission assignments).
- Not here: earthquake events and streamflow (usgs), weather alerts and forecasts (nws), historical
  weather (noaa), federal spending in general (usaspending), Census population for per-capita rates (census).

## Endpoints and datasets
One endpoint per dataset (JSON, `$top`/`$skip` paging of 10,000 rows) plus `query` for any other entity.

| Endpoint | Dataset (version/entity) | Grain |
|---|---|---|
| `disaster_declarations` | v2/DisasterDeclarationsSummaries | one row per disaster x designated area (county, tribe) |
| `disaster_summaries` | v1/FemaWebDisasterSummaries | one row per disaster: IHP, HA, ONA approved; PA, HMGP obligated |
| `housing_owners`, `housing_renters` | v2/HousingAssistanceOwners, ...Renters | disaster x county x city x ZIP |
| `ihp_registrations` | v2/RegistrationIntakeIndividualsHouseholdPrograms | disaster x county x city x ZIP |
| `ihp_valid_registrations` | v2/IndividualsAndHouseholdsProgramValidRegistrations | one row per registration (26 M rows) |
| `public_assistance` | v2/PublicAssistanceGrantAwardActivities | award activity (project version) |
| `pa_projects` | v2/PublicAssistanceFundedProjectsDetails | funded project |
| `nfip_claims` | v3/NfipClaims | one claim (2.7 M rows) |
| `nfip_policies` | v3/NfipPolicies | one policy transaction (75 M rows) |
| `hmgp_summaries` | v3/HazardMitigationGrantProgramDisasterSummaries | disaster x program |
| `mission_assignments` | v2/MissionAssignments | mission assignment amendment |
| `fema_regions`, `datasets` | v2/FemaRegions, v1/DataSets | reference; DataSets lists every entity, version, record count |
| `query` | `version` + `entity` path parameters, CSV | any CSV-capable entity, e.g. v1/DeclarationDenials |

Parameters on every endpoint: `$filter` (OData), `$select`, `$orderby`, `$count` (`true` adds the total to
`metadata.count`). Paging parameters are set by the fetcher; use `max_rows` on the request.
`--search "flood insurance"` finds a dataset alias.
`query` asks for CSV, so it works only for entities whose `distribution` in `datasets` lists `csv`:
IpawsArchivedAlerts v1 is JSON-only and answers HTTP 400 "does not support csv format"; an entity can be
listed in `datasets` and still answer 404 (PublicAssistanceProjectsStatus v1, verified 2026-10-22). For a
JSON-only entity use the manual route (JSON page links) and `--ingest`.

## Spec examples
```json
{"description": "Major disaster declarations in Vermont, FY2023 (one row per county)",
 "requests": [{"name": "vt_dr_fy2023", "endpoint": "disaster_declarations",
   "params": {"$filter": "state eq 'VT' and fyDeclared eq 2023 and declarationType eq 'DR'", "$orderby": "id"}}]}
```
```json
{"description": "NFIP claims in Vermont with a 2023 date of loss (selected fields)",
 "requests": [{"name": "vt_claims_2023", "endpoint": "nfip_claims",
   "params": {"$filter": "state eq 'VT' and yearOfLoss eq 2023",
              "$select": "id,dateOfLoss,yearOfLoss,floodEvent,state,countyCode,ratedFloodZone,netBuildingPaymentAmount,netContentsPaymentAmount"},
   "max_rows": 50000}]}
```
```json
{"description": "Any other OpenFEMA entity as CSV",
 "requests": [{"name": "regions", "endpoint": "query", "params": {"version": "v2", "entity": "FemaRegions"}}]}
```

## Data format and traps
- **Declarations are per area.** `disaster_declarations` has one row per designated county or tribal
  area; a disaster with 14 counties is 14 rows. Count disasters with distinct `disasterNumber` (or
  `femaDeclarationString`, e.g. DR-4720-VT). `declarationType`: DR major disaster, EM emergency, FM fire
  management. `fyDeclared` is the federal fiscal year (October-September), not the calendar year;
  `declarationDate` gives the calendar date.
- **OData filters**: text in single quotes (`state eq 'VT'`), numbers bare (`fyDeclared eq 2023`), dates
  as `declarationDate ge '2020-01-01T00:00:00.000z'`. Field names are case-sensitive and differ by
  dataset: `state` (declarations, NFIP claims, housing), `stateAbbreviation` (Public Assistance),
  `propertyState` (NFIP policies), `damagedStateAbbreviation` (valid registrations), `stt` (mission
  assignments), `disasterState` with the full name (`disasterState eq 'Vermont'`, HMGP summaries; verified
  2026-10). An unknown field fails with "Field ... not found"; fetch 5 rows unfiltered to see the names. Functions:
  `contains(floodEvent,'Harvey')`, `startswith(...)`. A filter that matches nothing fails the fetch with
  "returned no rows".
- **NFIP storm names** (`floodEvent`) are FEMA's labels ("Vermont/New York Flooding", "Hurricane Harvey",
  some run together like "2026-03-KonaStorm"); match with `contains(floodEvent,'Harvey')` and check the
  distinct values. `yearOfLoss` / `dateOfLoss` place a claim in time. Total paid = net building + net
  contents + net ICC payment amounts. NFIP records are redacted by FEMA (no names or addresses; locations generalized).
- **Money** is nominal dollars. PA `federalShareObligated` changes as projects are versioned; IHP amounts
  are approved, not necessarily disbursed. Say "obligated" or "approved", not "spent".
- **Size**: `nfip_policies` (75 M) and `ihp_valid_registrations` (26 M) need narrow filters; `max_rows`
  defaults to 200,000. Ask for `$select` fields to keep files small.
- **Paging**: the fetcher asks for 10,000 rows per call (`$top`; 1,000 when not set) and pages with `$skip`.
  Set `$orderby` (default `id` where the entity has one) so pages do not overlap; `pa_projects` and
  `hmgp_summaries` have no `id` field (verified 2026-10).
- `fema_regions` has 11 rows (the ten regions plus FEMA Headquarters). CSV from `query` keeps every column,
  including map geometry (`regionGeometry` is 200-450 KB a row); add `$select` when the shapes are not needed.
- Booleans are written as `True`/`False` by the named endpoints (JSON) but as `0`/`1` by `query` (CSV);
  dates are ISO 8601 UTC strings (`2023-07-14T00:00:00.000Z`).
- Versions: OpenFEMA versions each dataset separately (v1, v2, v3) and deprecates old versions; the
  `datasets` endpoint lists current versions and `depDate`, and a retired version answers 404 (the fetch
  says "not found"): check `datasets` before assuming the data are missing. NFIP entities
  were renamed from FimaNfipClaims/FimaNfipPolicies to NfipClaims/NfipPolicies (v3).
- Data are refreshed daily to weekly (`lastRefresh`), and recent disasters change as aid is processed.

## Access
No key, no published rate limit (the fetcher sends 3 requests a second). Route `api` when www.fema.gov
answers. Manual route: `manual_download/INSTRUCTIONS.md` lists one JSON link per 10,000-row page (append
`&$format=csv` for CSV); or download a whole dataset as CSV or Parquet from its page at
https://www.fema.gov/about/openfema/data-sets, filter it locally, and upload the subset; then `--ingest`.

## Citation and terms
"Federal Emergency Management Agency, OpenFEMA <dataset>, www.fema.gov/api/open, retrieved <date>."
Every product must carry the OpenFEMA statement (in policy notices): "This product uses the Federal
Emergency Management Agency's OpenFEMA API, but is not endorsed by FEMA," plus the statement that FEMA
cannot vouch for data or analyses derived after retrieval. U.S. government data; redistribution allowed
under the OpenFEMA terms (https://www.fema.gov/about/openfema/terms-conditions).
