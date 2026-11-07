# EPA Envirofacts and ECHO (TRI, GHGRP, SDWIS, Superfund, compliance and enforcement)
Depth: standard. Key: none. EPA facility data from Envirofacts (Toxics Release Inventory, Greenhouse
Gas Reporting Program, Safe Drinking Water, Superfund sites, any other Envirofacts table) and ECHO
(facility compliance, violations, inspections, enforcement cases and penalties), plus UV index forecasts.

## When to use
- Facilities that report toxic releases or greenhouse gases; large emitters by state and sector; public
  water systems and drinking-water violations; Superfund sites and NPL status; facilities in violation
  of the Clean Air or Clean Water Act; EPA enforcement cases and penalties.
- Not here: ambient air pollution measurements (epa-aqs, needs a key), weather (noaa), streamflow
  (usgs), national GHG inventory totals (EPA's Inventory of U.S. Greenhouse Gas Emissions, not covered:
  GHGRP covers large facilities only).

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `envirofacts` | rows of one Envirofacts table, paged by 5,000 | `table` (alias or schema.table), `filters` |
| `echo_facilities` | ECHO facility rows (compliance status, violation quarters, inspections, IDs) | `program` (air, cwa, rcra, sdw, echo), `p_st`, `p_co`, `p_fips`, `p_ct`, `p_zip`, `p_fn`, `p_act`, `p_maj`, `p_ncs` (NAICS), `p_sic`, `p_qiv`, `qcolumns` |
| `echo_cases` | civil and criminal enforcement cases with penalties | `p_state`, `p_law`, `p_case_category`, `p_case_status`, `p_milestone_fy`, `p_civil_criminal_indicator`, `p_fed_penalty` |
| `echo_facility_detail` | Detailed Facility Report for one FRS id (one row; sections as JSON text) | `p_id` |
| `uv_daily`, `uv_daily_city`, `uv_hourly` | today's UV index forecast | `zip`, or `city` + `state` |

`table` aliases (`--search "drinking water"`): `tri_facility` (tri.tri_facility), `tri_reporting_form`
(tri.tri_reporting_form: chemical and year per form), `tri_release_qty` (tri.tri_release_qty: release
amount per medium, joined by `doc_ctrl_num`), `ghg_emitters` (ghg.ghg_emitter_sector), `sdwis_systems`
(sdwis.water_system), `sdwis_violations` (sdwis.violation), `superfund_sites` (sems.envirofacts_site).
Any other table works by its schema.table name (Envirofacts model: https://www.epa.gov/enviro/envirofacts-data-service-api).

`filters`: `{"column": "value"}` (equals, AND-ed) or `[["column", "operator", "value"], ...]` with
operators equals, notEquals, lessThan, lessThanEqual, greaterThan, greaterThanEqual, beginsWith,
endsWith, contains. Value matching is case-insensitive (verified).

## Spec examples
```json
{"description": "Vermont: GHGRP emitters in 2022 and Superfund sites on the final NPL",
 "requests": [{"name": "vt_ghg_2022", "endpoint": "envirofacts",
               "params": {"table": "ghg_emitters", "filters": [["state", "equals", "VT"], ["year", "equals", 2022]]}},
              {"name": "vt_npl", "endpoint": "envirofacts",
               "params": {"table": "superfund_sites", "filters": {"fk_ref_state_code": "VT", "npl_status_code": "F"}}}]}
```
```json
{"description": "Vermont: major Clean Air Act facilities and CAA enforcement cases",
 "requests": [{"name": "vt_major_air", "endpoint": "echo_facilities", "params": {"program": "air", "p_st": "VT", "p_maj": "Y"}},
              {"name": "vt_caa_cases", "endpoint": "echo_cases", "params": {"p_state": "VT", "p_law": "CAA"}}]}
```

## Data format and traps
- **ECHO parameter names differ by service** (verified 2026-10-20): facility searches take `p_st`;
  case searches take `p_state` and silently ignore `p_st`, returning every state (313,071 cases instead
  of 467 for VT). The pack refuses `p_st` on `echo_cases` and stops when ECHO reports a parameter it did
  not understand. Major facilities: `p_maj=Y` (`p_pc=MAJOR` has no effect). Other parameters ECHO takes
  without filtering (verified 2026-10-22), which the pack refuses: `p_naics` on facility searches (NAICS
  is `p_ncs`, 2-6 digits as a prefix; few cwa permits carry a NAICS code), and on case searches `p_fy`
  (use `p_milestone_fy`, one fiscal year), `p_crim` (use `p_civil_criminal_indicator`: CI, CR or ALL) and
  `p_name` (accepted, never filters: filter `CaseName` after fetching). `p_co` (county name, with `p_st`)
  returns 0 rows on `air` searches: use `p_fips` (5-digit county FIPS). Codes, not words:
  `p_case_status=CLS` (closed), `CNC` (concluded), `FOI` (final order issued); `p_fed_penalty` takes only
  ANY, LE5000, GT5000, GT50000, GT100000, GT500000, GT1000000, GT2500000.
- ECHO has a query-size limit: a search matching too many rows (e.g. all air facilities nationwide,
  280,376) returns "Queryset Limit would be exceeded"; filter by state or more. The fetch notes carry
  ECHO's summary counts (QueryRows, violation and inspection counts, TotalPenalties).
- ECHO money is text like `$40,000.00` and dates `MM/DD/YYYY`; the pack adds `<column>_usd` and
  `<column>_iso` columns and keeps the published ones. Penalties are nominal dollars assessed in the
  settlement, not necessarily collected. Compliance status columns describe the last 3 years (12
  quarters), as of ECHO's weekly refresh.
- **Columns**: facility searches return each program's default columns (about 60 for `air`). For others,
  pass `qcolumns` (comma-separated column ids); the ids and names are listed keylessly by
  `https://echodata.epa.gov/echo/<program>_rest_services.metadata?output=JSON` (`ResultColumns`). The pack
  sends `qcolumns` to both steps (search and `get_qid`); check that the column you need is in the CSV.
- **GHGRP** rows are facility x gas x year: `co2e_emission` is metric tons CO2-equivalent for that gas
  (the global-warming potentials follow EPA's current GHGRP rule; check before comparing across rule
  changes); sum over gases for a facility total. Only
  facilities above 25,000 t CO2e a year report, and some sectors report as suppliers, not emitters.
- **TRI** `tri_facility` lists facilities, not quantities: releases are in `tri_release_qty` (pounds;
  grams for dioxins; per form, joined to `tri_reporting_form` by `doc_ctrl_num`, to facilities by `tri_facility_id`).
  Reporting year Y first appears as preliminary data in the summer of Y+1.
- **SDWIS**: `state_code` is the system's address state, `primacy_agency_code` the regulating state
  (verified: a VT-address system regulated as CT); filter by `primacy_agency_code` for "systems in a
  state". `pws_type_code`: CWS community, NTNCWS non-transient non-community, TNCWS transient.
  `pws_activity_code` A active, I inactive. Violations: `is_health_based_ind` Y for health-based.
- **Superfund**: `npl_status_code` F final NPL, P proposed, D deleted, N not on the NPL; many SEMS sites
  are not NPL sites.
- Envirofacts values are mostly text; dates as `YYYY-MM-DD HH:MM:SS`. Column names are lower case and
  table-specific. A wrong column gives HTTP 500 "The column, <schema.table.column> does not exist"; a wrong table HTTP 404.
- UV index is a forecast for today only (0-2 low, 3-5 moderate, 6-7 high, 8-10 very high, 11+ extreme).

## Access
No key. Route `api` when data.epa.gov and echodata.epa.gov answer (the fetcher sends 2 requests a
second). Manual route: `manual_download/INSTRUCTIONS.md` lists Envirofacts CSV links (5,000 rows each)
and, for ECHO, the first-step link plus the `get_qid` link to open with the QueryID it returns. Or use
https://enviro.epa.gov, https://echo.epa.gov/facilities/facility-search and
https://echo.epa.gov/facilities/enforcement-case-search (Download Data); full-year TRI and GHGRP files
are on epa.gov (TRI Basic Data Files; GHGRP data sets). Upload the files, then `--ingest`.

## Citation and terms
"U.S. Environmental Protection Agency, <dataset, e.g. Greenhouse Gas Reporting Program (GHGRP) via
Envirofacts / ECHO enforcement case search>, retrieved <date>." Public domain (U.S. government work);
cite EPA and do not imply endorsement (https://www.epa.gov/web-policies-and-procedures/epa-disclaimers).
Redistribution allowed.
