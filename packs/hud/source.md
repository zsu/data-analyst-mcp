# HUD Fair Market Rents and Income Limits API (HUD User)
Depth: standard. Key: required (HUD_USER_TOKEN). HUD's Fair Market Rents (FMRs, including Small Area
FMRs by ZIP) and Section 8 and Multifamily Tax Subsidy Project (LIHTC) income limits, by county, New
England town, metro FMR area and state, per federal fiscal year.

## When to use
- Fair Market Rent by bedroom count for a county, metro or state; Small Area FMRs by ZIP; HUD
  income limits (30%, 50%, 80% of area median) by household size; area median family income as HUD
  sets it; MTSP (LIHTC) limits.
- Not here: market rents and home values from surveys (census ACS median gross rent), house price
  indexes (fred, FHFA), homelessness counts and public housing (not covered), mortgage complaints
  (cfpb). FMRs are policy values (the 40th percentile gross rent standard), not observed averages.

## Endpoints and datasets
| Endpoint | Returns (one row per) | Parameters |
|---|---|---|
| `fmr` | area, or ZIP for Small Area FMR metros | `entityid`, `year` |
| `fmr_state` | metro area and county/town of a state (`area_type`) | `statecode`, `year` |
| `income_limits` | area: median_income, il30_p1..p8, il50_p1..p8, il80_p1..p8 | `entityid`, `year` |
| `mtspil` | area: MTSP limits by percent and household size | `entityid`, `year` |
| `il_state` | areas of a state (shape undocumented; unverified) | `statecode`, `year` |
| `list_states` | state: state_code, state_name, state_num | |
| `list_counties` | county or town: fips_code (the entity id), county_name, town_name | `statecode`, `updated` (2025) |
| `list_metro_areas` | metro FMR area: cbsa_code (entity id), area_name | `updated` (2025) |
Entity ids: county = state FIPS + county FIPS + "99999" (Accomack County, VA = 5100199999); New
England towns have their own 10-digit codes (Wallingford town, VT = 5002175925); metro areas look
like METRO47900M47900. Get them from `list_counties` / `list_metro_areas`.

## Spec examples
```json
{"description": "FMRs for Wallingford town, VT (FY2017) and the Washington DC metro (Small Area FMRs)",
 "requests": [{"name": "wallingford_2017", "endpoint": "fmr", "params": {"entityid": "5002175925", "year": 2017}},
              {"name": "dc_metro", "endpoint": "fmr", "params": {"entityid": "METRO47900M47900"}}]}
```
```json
{"description": "Income limits for Autauga County, AL, and FMRs for every area of Massachusetts",
 "requests": [{"name": "autauga_il", "endpoint": "income_limits", "params": {"entityid": "0100199999"}},
              {"name": "ma_fmr", "endpoint": "fmr_state", "params": {"statecode": "MA"}}]}
```
```json
{"description": "Virginia county entity ids",
 "requests": [{"name": "va_counties", "endpoint": "list_counties", "params": {"statecode": "VA"}}]}
```

## Data format and traps
- FMRs are monthly gross rents (shelter rent plus utilities) in dollars, generally at the 40th
  percentile of recent movers' rents; they are a program standard, not an average rent.
- Years are federal fiscal years, but the effective dates differ: FMRs take effect October 1 before the
  fiscal year (FY2027 on October 1, 2026); income limits and MTSP limits take effect when HUD publishes
  them in spring (FY2026 on May 1, 2026). So in autumn the latest FMR year is one ahead of the latest
  income-limit year. `year` defaults to the latest year of each; always set it for a reproducible number
  and report it as "FY".
- Numbers sometimes arrive as text with a decimal ("758.0") and sometimes as integers (1772),
  depending on resource and year; convert in `analysis.py`.
- Small Area FMR metros (`smallarea_status` "1") return one row per ZIP plus a `zip_code` "MSA level"
  row; use the MSA level row for the metro value and never average ZIP rows.
- County and metro values differ: a metropolitan county's FMR is its HUD metro FMR area's value
  (`metro_name`); counties in one metro share it.
- Income limits: il30 = extremely low, il50 = very low, il80 = low income, for 1-8 person households;
  `median_income` is HUD's area median family income for that year. Limits are capped and adjusted by
  HUD rules, so il80 is not always 1.6 x il50.
- Income Limits 2025 changed some county FIPS codes (HUD's own example is Connecticut): call
  `list_counties` / `list_metro_areas` with `updated: 2025` for IL 2025 ids.
- A 5-digit county FIPS is not an entity id; the pack refuses it with the fix. '0600000001' is not a valid
  county code (the format is state FIPS + county FIPS + 99999).
- `il_state`'s response is not documented; the pack turns its lists into rows but the columns are
  unverified. Prefer `income_limits` per area.
- Error codes (HUD documentation): 401 bad token, 403 token not registered for this dataset (add the
  "FMR and IL" dataset to the token on HUD User), 404 no data for the id or year.
- Verification status: built from HUD's documented responses (tests use doc_* fixtures); not checked
  against a live token.

## Access
Key required: a free HUD User access token (https://www.huduser.gov/hudapi/public/register; select the
"Fair Market Rents and Income Limits" dataset, then Create New Token). Store it as `HUD_USER_TOKEN`
with the setup script; it is sent as `Authorization: Bearer <token>`. Rate limits are not published;
the pack sends at most one request a second.
Manual route: the bundle's download scripts send the token header from the user's own computer
(browser links alone answer 401). Without a token, use the published files: FMRs at
https://www.huduser.gov/portal/datasets/fmr.html and income limits at
https://www.huduser.gov/portal/datasets/il.html (pick the fiscal year; take the "revised" workbook when
there is one, e.g. FY26_FMRs_revised.xlsx) and upload it named after the request (`<name>.xlsx` or `.csv`,
e.g. `fmr_fy2027.xlsx` for request `fmr_fy2027`). Ingest reads JSON, CSV and Excel (pandas with
openpyxl; a workbook with malformed metadata is read anyway) and keeps only the rows of the request's
`entityid` (columns `hud_area_code`, `metro_code`, `fips`, `fips2010`) or `statecode`; it refuses a file with
no row for the id. A metro area comes back as one row per county or town, all with the metro's values. The
workbooks' columns differ by year (`metro_code`/`areaname`/`fips2010` in FY2022, `hud_area_code`/
`hud_area_name`/`fips` in FY2026-FY2027; FMRs in `fmr_0`..`fmr_4`), and nothing in the file states its fiscal
year: check the file name. Verified with the FY2022, FY2026 and FY2027 FMR workbooks on 2026-10-22. These pages need a
browser: scripted requests to huduser.gov/portal get HTTP 202 with an empty body (checked 2026-10-22).

## Citation and terms
"U.S. Department of Housing and Urban Development, Fair Market Rents (or Income Limits), FY<year>, HUD
User, retrieved <date>." Public domain U.S. government data; redistribution allowed. Name the fiscal
year in every citation.
