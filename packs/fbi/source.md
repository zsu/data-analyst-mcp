# FBI Crime Data Explorer (UCR, NIBRS, hate crime, arrests, police employees)
Depth: standard. Key: optional (DATA_GOV_API_KEY; DEMO_KEY works for a few requests). Agency-reported crime
data from the FBI Uniform Crime Reporting (UCR) Program, served by the Crime Data Explorer (CDE) API.

## When to use
- Offenses and clearances by month (violent, property, homicide, robbery ...), national, state or agency;
  arrests; NIBRS incident breakdowns (victim, offender, location, weapon); Supplementary Homicide Reports;
  hate crimes by bias; law enforcement employees; law enforcement suicide data (LESDC).
- Not here: victimization surveys including crimes not reported to police (BJS NCVS, not covered), prisons
  and sentencing (BJS / U.S. Sentencing Commission), federal prosecutions and DOJ announcements (doj-news,
  which is text), the FBI's annual "Crime in the Nation" estimate tables (published reports).
- Not wrapped by this pack, though the CDE API has them (verified 2026-10): NIBRS estimates with lower and
  upper bounds (`/nibrs-estimation/national|region|state/<numeric offense ID>?year=`, years 2021 and 2022
  only, other years HTTP 400; the offense and state IDs are numeric codes not documented here) and use of
  force participation (`/uof?year=&location=`). Use them only after checking the codes on the CDE site.

## Endpoints and datasets
Most endpoints come in three levels: `_national`, `_state` (`state` = CA), `_agency` (`ori` = DE0010100).
| Endpoint family | Returns | Parameters |
|---|---|---|
| `agencies_by_state` | agencies: ORI, name, type, county, `is_nibrs`, `nibrs_start_date` | `state` |
| `summarized_*` | monthly offenses and clearances (counts, rates per 100,000), population covered | `offense` V P HOM RPE ROB ASS BUR LAR MVT ARS, `from`, `to` |
| `arrest_*` | `type=counts`: monthly arrests and rates; `type=totals`: by sex, race, age, offense | `offense` (all, 11, 30, 150 ...), `from`, `to`, `type` |
| `nibrs_*` | `counts`: monthly offenses; `totals`: victim/offender/location/weapon breakdowns | `offense` (09A, 13A, 23* ...), `from`, `to`, `type` |
| `shr_*` | expanded homicide: monthly victims or breakdowns (weapon, circumstance, relationship) | `from`, `to`, `type` |
| `supplemental_*` | expanded property offenses | `offense` NB NL NMVT NROB, `from`, `to` |
| `hate_crime_*`, `hate_crime_bias_*` | `type=totals` (default): incidents by bias, category, offense, location, offender over the span; `type=counts`: monthly incidents, offenses and coverage | `bias` (12, 21 ...), `from`, `to`, `type` |
| `pe_national` / `pe_state` / `pe_agency` | officers and civilians by sex, employees per 1,000 people, yearly | `from`, `to` (YYYY) |
| `lesdc` | Law Enforcement Suicide Data Collection, one chart and year | `chartType`, `year` |
Code lists are in the catalog: `--search "drug"` finds arrest codes 150-160, `--search "anti-jewish"` the bias
code. `from`/`to` take MM-YYYY or a year (2019 becomes 01-2019 as `from`, 12-2019 as `to`).

## Spec examples
```json
{"description": "Violent crime, United States, monthly 2019-2023",
 "requests": [{"name": "violent_us", "endpoint": "summarized_national", "params": {"offense": "V", "from": "2019", "to": "2023"}}]}
```
```json
{"description": "Homicide in Texas vs the nation; drug abuse arrests nationally",
 "requests": [{"name": "hom_tx", "endpoint": "summarized_state", "params": {"state": "TX", "offense": "HOM", "from": "2018", "to": "2023"}},
              {"name": "drug_arrests", "endpoint": "arrest_national", "params": {"offense": "150", "from": "2018", "to": "2023"}}]}
```
```json
{"description": "Hate crimes in 2023 by bias; agencies in Delaware",
 "requests": [{"name": "hate_us", "endpoint": "hate_crime_national", "params": {"from": "2023", "to": "2023"}},
              {"name": "de_agencies", "endpoint": "agencies_by_state", "params": {"state": "DE"}}]}
```
```json
{"description": "Arrests by sex, race and age, each year 2021-2023 (totals: one request per year)",
 "requests": [{"name": "arrests_2021", "endpoint": "arrest_national", "params": {"offense": "all", "from": "2021", "to": "2021", "type": "totals"}},
              {"name": "arrests_2022", "endpoint": "arrest_national", "params": {"offense": "all", "from": "2022", "to": "2022", "type": "totals"}},
              {"name": "arrests_2023", "endpoint": "arrest_national", "params": {"offense": "all", "from": "2023", "to": "2023", "type": "totals"}}]}
```

## Data format and traps
- Output is one long table per request: `section` (e.g. `offenses/actuals`, `offenses/rates`,
  `populations/participated_population`, `tooltips/Percent of Population Coverage`, `bias_section/offense_type`),
  `series` (e.g. "United States Offenses", "Delaware Clearances"), `key` (label or MM-YYYY), `period`
  (YYYY-MM), `year`, `month`, `value`, `unit`, `data_through`, `last_refresh`, `span_from`, `span_to` (the
  request's from/to). Filter on `section` first.
- Rates are **monthly** offenses per 100,000 of the **participating** population (verified: Jan 2020 rate
  29.06 = 93,464 offenses / 321,657,569 participated population x 100,000). Annual rates are the sum of
  monthly rates only if coverage is stable; better: sum actuals and divide by the average participated
  population. State requests also return the United States series for comparison.
- **NIBRS transition.** The FBI retired the summary reporting system (SRS) on January 1, 2021 and accepted
  only NIBRS submissions for 2021; many large agencies had not converted. National population coverage fell
  from 96.0% (June 2020) to 77.1% (June 2021) and was back to 95.3% (June 2022) (verified from the
  coverage series). National violent offenses summed to 1,273,168 in 2020, 932,588 in 2021 and 1,271,298 in
  2022: the 2021 drop is missing agencies, not less crime. Never compare 2021 counts with other years;
  compare rates and always report coverage (`tooltips/Percent of Population Coverage`). State coverage in
  2021 ranges from near 100% to very low; check it per state. From 2022 the FBI again accepted SRS-format
  submissions (background, not verified against the API here).
- NIBRS (`nibrs_*`) counts only NIBRS agencies, so before 2021 it covers a minority of the population and
  trend breaks follow agencies' `nibrs_start_date`. NIBRS counts every offense in an incident; summary (SRS)
  counts used the hierarchy rule (most serious offense only), so NIBRS and summarized numbers differ.
- Some December values are much higher than other months (national violent rate 57.3 in Dec 2020 against
  about 30 in other months; 38.1 in Dec 2022). Verified in the data; the cause (agencies reporting annual
  totals in December) is a likely explanation, not verified. Do not read it as seasonality.
- `type=totals` breakdowns (hate crime, arrests, NIBRS, SHR) are summed over the whole `from`-`to` span and
  have no period; `span_from`/`span_to` say what a row covers (verified 2026-10: a two-year request equals
  the sum of the two one-year requests). For a breakdown by year, make one request per year and stack the
  tables; never divide a multi-year total by the number of years.
- These are offenses reported by agencies, not estimates for the whole population; the FBI's national
  estimates (Crime in the Nation, and the API's NIBRS estimates for 2021-2022) impute non-reporting
  agencies and will differ.
- Hate crime counts depend heavily on agency participation and local practice; zero often means "not
  reported". The default `type=totals` reply carries no participation figure; `type=counts` on the same
  endpoint returns monthly `actuals` plus `populations/participated_population` and `tooltips/Percent of
  Population Coverage` (verified 2026-10). Fetch both to state coverage per year; for a breakdown per year,
  make one totals request per year (`from` = `to` = the year). Past years change as late submissions arrive:
  the CDE count for a year can exceed the FBI's first annual report, so cite `last_refresh`. Clearances are offenses cleared in the month, possibly from earlier months' offenses.
- Agency rows: `ori` is the 9-character agency ID; `county_group` is the county key the API groups by.
- Errors: an invalid offense or a date not in MM-YYYY answers HTTP 400 with a plain-text message.

## Access
Key optional: DATA_GOV_API_KEY (free at https://api.data.gov/signup/) sent as `API_KEY`; without one the
pack sends DEMO_KEY, limited per IP address to 30 requests an hour and 50 a day (api.data.gov developer
manual, https://api.data.gov/docs/developer-manual/); a personal key allows 1,000 requests an hour.
Responses carry `X-RateLimit-Limit: 10` (window not documented); the pack keeps to one request a second. Route `api` when
api.usa.gov answers. Manual route: `manual_download/INSTRUCTIONS.md` lists one JSON link per request with
`API_KEY=DEMO_KEY`; open each, save under the name shown, upload, then `--ingest`. Without the links: the
Crime Data Explorer (https://cde.ucr.cjis.gov/) charts have a download button (CSV), and its Documents &
Downloads page has full NIBRS and SRS files by state and year (not parsed by this pack).

## Citation and terms
"Federal Bureau of Investigation, Crime Data Explorer, <series>, api.usa.gov/crime/fbi/cde, retrieved <date>."
Public domain (U.S. government work); attribute the FBI UCR Program, do not imply endorsement.
Redistribution allowed. A report must state agency participation or coverage (audit hook).
