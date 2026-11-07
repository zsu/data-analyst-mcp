# IPUMS microdata (USA/ACS, CPS and other collections)
Depth: deep. Key: required (IPUMS_API_KEY) for the API; the website builds the same extract with a free
account and no key. Person-level survey microdata (ACS, decennial census, CPS ASEC and monthly, IPUMS-I,
ATUS, NHIS, MEPS) as filtered extracts, for weighted estimates.

## When to use
- Custom tabulations the published tables do not give: employment, earnings, hourly wages, poverty,
  health insurance, immigrants (nativity, citizenship, birthplace), veterans, education, by any
  combination of groups; public vs. private pay; minimum-wage exposure (CPS outgoing rotation groups).
- Choose the collection (details: `docs/variables.md` section 1):
  ACS 1-year (`usYYYYa`, ~3.3M persons) for states and small groups; ACS 5-year (`usYYYYc`) for very small
  groups or areas (pooled period, no year-to-year change); CPS ASEC (`cpsYYYY_03s`) for annual income,
  poverty and insurance (income refers to the previous year; series from 1962); CPS basic monthly
  (`cpsYYYY_MMs`) for monthly labor force and hourly/weekly earnings; NHIS (`ihYYYY`) for insurance at the
  interview, access to care, conditions and health status; MEPS (`mpYYYY`) for health care spending
  (total, out-of-pocket, by payer) and insurance over a whole year (`docs/variables.md` sections 8-9).
- Recent ACS PUMS years, one CPS month or one ASEC year: the census pack serves the same Census files directly
  (census key, seconds, public domain; replicate weights for ACS and for the ASEC from 2005). Use this pack
  for what only IPUMS adds: codes harmonized across years (EDUC, OCC1990), CPI99, attached spouse or parent
  traits, CPS panels (CPSIDP), ASEC standard errors before 2005, years before 2004 (ACS) or 1989 (CPS), NHIS, MEPS, ATUS,
  historical censuses and international samples.
- Not here: published ACS tables by geography (census pack), official BLS rates and CPS-based series
  (bls, fred), federal workforce administrative records (opm), published health statistics (cdc) and
  Medicare program data (cms). Prefer a published table when it answers the question; microdata are for
  what tables cannot do.
- Your estimates are your own and people may quote them: accuracy comes first.

## Endpoints and datasets
| Call (`https://api.ipums.org`, `?collection=<c>&version=2`) | Returns |
|---|---|
| `GET /metadata/samples` | sample IDs and descriptions (`request_schema` with `search: "usa 2023"`) |
| `POST /extracts` (body built from the spec) | `{number, status}` |
| `GET /extracts/{number}` | status queued/started/produced/completed/failed/canceled, `downloadLinks` |
| `GET downloadLinks.data.url`, `.ddiCodebook.url` | the gzipped CSV and the DDI XML codebook |

There is no variable-metadata endpoint for microdata: variable names and verified codes are in
`docs/variables.md` (sections 4-7, ready-made variable sets by topic); after a download,
`data/ipums/codebook.csv` is the authority. API body details, timing and errors: `docs/ipums_api.md`.
Collections with API extracts: usa, cps, ipumsi, atus, ahtus, mtus, nhis, meps, dhs (case selection and
monetary adjustment only for usa, cps, ipumsi: `fetch` refuses them elsewhere (`invalid_request`), so mark the group with a domain mask and deflate with CPI-U after download; NHIS has no data quality flags, MEPS no attached characteristics;
dhs needs an account approved by The DHS Program, so a 401/403 there usually means that approval is
missing). Codes, weights and recodes are documented for usa, cps, nhis and meps; for the others, work from
the collection's website and `codebook.csv`.

Tools: `request_schema` (`names: ["usa"]` etc. gives the spec format, weights and sample IDs; a search such as
`cps 2023` lists sample IDs, with a key), `fetch` (submits the extract, waits, downloads and packages it; it
reuses a finished extract and, when a wait timed out, collects the extract still running at IPUMS: its number
is saved in `data/ipums/extract_spec.json`, so call `fetch` again with the same spec; `force: true` submits a new
one), and `ingest` (the .csv.gz and .xml the user downloaded). Small CPS extracts take about a minute;
multi-year ACS 5-30 minutes; one `fetch` waits `max_wait_s` (default 600). A blocked fetch returns an error
with its fix: follow it; never invent or substitute data.

## Spec examples
```json
{"collection": "usa", "description": "Prime-age employment by nativity, ACS",
 "samples": ["us2013a", "us2018a", "us2023a"],
 "variables": ["AGE", "SEX", "CITIZEN", "EDUCD", "EMPSTAT", "INCWAGE", "CPI99"],
 "case_selections": {"AGE": {"min": 25, "max": 54}}}
```
```json
{"collection": "cps",
 "description": "CPS ASEC 2024: federal civilian vs private-sector wage and salary workers",
 "samples": ["cps2024_03s"],
 "variables": ["AGE", "SEX", "RACE", "HISPAN", "EDUC", "CLASSWLY", "INCWAGE", "WKSWORK1", "UHRSWORKLY",
               "FULLPART", "OCCLY", "INDLY", "STATEFIP", "VETSTAT", "FIRMSIZE", "REPWTP"],
 "case_selections": {"CLASSWLY": [22, 25]}}
```
Optional keys: `case_select_who` (`individuals` | `households`), `attached_characteristics`
(`{"EDUC": ["spouse"]}`), `data_quality_flags` (list or true), `adjust_monetary_values` (list),
`case_selections` with `{"detailed": [...]}` for detailed codes, `data_format`, `data_structure`, `max_wait_s`.
Keep extracts lean: only the variables used, case selections for the universe, only the needed years.
Name explicitly: `CPI99` (constant dollars), `REPWTP` (replicate weights), the detailed variable you
select on (`EDUCD`). Confirm sample IDs with a `request_schema` search before submitting.

## Data format and traps
`fetch` writes `data/ipums/`: `ipums_extract.csv` (uppercase mnemonics, raw IPUMS codes, one row per
person), `codebook.csv` (variable, value, value_label), `variables.csv`, the DDI `.xml`,
`extract_spec.json` (spec + exact API body + extract number), `request.json`, `README.md` (citation,
weights, terms).
- **Weights on every estimate**: PERWT / HHWT (USA; household measures on PERNUM == 1), ASECWT (CPS
  ASEC; WTFINL is not offered for ASEC samples: the API refuses it with HTTP 400, verified 2026-10), WTFINL (CPS monthly; COMPWT for employment levels that match BLS), EARNWT (earnings questions, outgoing
  rotation groups), SAMPWEIGHT (NHIS 2019 on: sample adults `ASTATFLG == 1` and sample children
  `CSTATFLG == 1`, never summed across items of different universes), PERWEIGHT (MEPS; 0 = out of scope).
  Pooling years: average yearly estimates or divide weights by the number of years.
- **Health surveys**: NHIS trends break at the 2019 redesign (and 2020 was collected partly by phone, with
  `PARTWEIGHT`); NHIS EMPSTAT from 2019 is employed / not employed only. MEPS dollars are nominal for the
  calendar year, spending is highly skewed (screen outliers, add medians), and `CHGTOT` is charges, not
  payments. Variable names differ from USA/CPS and between NHIS and MEPS (HINOTCOVE vs. HINOTCOV): use
  `docs/variables.md` sections 8-9.
- **Missing and top codes**: treat every code whose `codebook.csv` label says N/A, NIU, missing or unknown
  as missing (`compute` `filter` or `derive`); then look at the min and max of every dollar and hours variable. USA INCWAGE 999999 = N/A, 999998 = missing; CPS INCWAGE 99999999 NIU;
  HHINCOME 9999999 (USA); UHRSWORKLY 999 NIU. An unremoved 9999999 is the classic IPUMS mistake.
- **Outliers**: screen every dollar variable and derived hourly wages for extreme values. In recent ASECs each
  income component is top-coded or swapped at about 1,099,999; INCWAGE sums two of them (INCLONGJ +
  OINCWAGE), so it reaches 2,199,998 (ASEC 2026: 220 records at $1M or more). A few such records can
  move a small cell's mean by 10+ percent: report a stated rule and the sensitivity.
- **Universe**: CPS CLASSWLY 25 (federal) includes active-duty armed forces: drop them via OCCLY/INDLY
  military codes (see `docs/variables.md` 5). GQ in (1, 2, 5) for the household population (USA).
  Report how many records each filter drops (a sample-flow table).
- **Dollar year**: CPS ASEC year t reports income for t-1. Convert with CPI99 (request it) or
  `adjust_monetary_values`; IPUMS does not recommend the ACS ADJUST factor for analysis across years. But
  Census's published ACS dollar tables (B19013, S1901) are in survey-year dollars computed with ADJINC: to
  match them, multiply by ADJUST (without it, medians come out about 1.5 percent low, inside the margins of
  error, so the benchmark check would not show the bias). State the dollar year.
- **Codes differ by collection**: CPS EDUC is one detailed 3-digit variable (73 high school, 111
  bachelor's); USA uses EDUCD for degree groups. Foreign born (not a citizen at birth): CPS CITIZEN 4-5
  (not NATIVITY 5, which adds people born in outlying areas or abroad of American parents); ACS CITIZEN 2-5
  (USA has no NATIVITY for ACS): use the right one for the collection. CPS EMPSTAT 10/12 employed, 20-22 unemployed. Check `codebook.csv`.
- **Extract gotchas**: IPUMS adds detailed versions automatically (EDUC brings EDUCD); a data-quality
  flag or case-selection code that a sample lacks returns HTTP 400 (fix the spec and fetch again);
  ACS 2020 1-year has experimental weights.
- **Standard errors**: this server has no replicate-weight or design-based standard errors yet. Report
  which weight each estimate uses and that standard errors were not computed; without them, never call a
  difference "statistically different" (when standard errors exist, the rule is beyond 1.645 standard errors,
  90 percent; otherwise "about the same"). The methods, for reference: ACS person estimates use REPWTP (80
  replicates), household estimates (tenure, household income) REPWT with HHWT, Census's own method; a
  linearized SE with STRATA and CLUSTER (added automatically) can understate a PUMS margin (half of the
  replicate one in a 2024 tenure check), so replicates are preferred. CPS ASEC: REPWTP (160) for person
  estimates, or REPWT (160) with ASECWTH on householders (`RELATE == 101`) for household estimates such as
  median household income (P60 tables). NHIS and MEPS have no replicate weights: their SEs come from the
  design variables, estimated on the whole file with a domain mask, not on filtered rows. CPS basic monthly
  has no replicate weights and no design variables in the public files: an SE clustered by household
  (CPSID) is approximate, and the answer says so. BLS's CPS variance parameters do not apply to union or
  earnings estimates. Union membership (`UNION`, with `EARNWT`): IPUMS's universe starts at age 15; BLS's
  published rates are for 16 and over (BLS also publishes the annual rate as `LUU0204899600`).
  Thin cells (fewer than 100 records) are footnoted or suppressed.
- **Medians of dollar amounts**: reported income heaps on round numbers, so a plain weighted median sits
  on a heap ($60,000) and its replicate SE can come out 0. Census publishes medians interpolated within
  $2,500 intervals: use such a binned median to compare with Census (P60 tables); BLS weekly earnings use
  $50 intervals centred on multiples of $50 (edges at $25, $75, ...); state which median you report. CPS earnings after March 2023: `EARNWEEK2`/`HOURWAGE2` (docs/variables.md).
- **Composition**: show the raw and a composition-adjusted gap (standardized to a common group mix); test
  every threshold or definition for sensitivity; benchmark a headline number against a published figure (Census, BLS).
- Public IPUMS data cannot show legal status, benefits, or full administrative controls: say so.

Analysis: build tables with `compute` on `data/ipums/ipums_extract.csv`, decoding values with `codebook.csv`. This
server has no IPUMS recode helpers or replicate-weight standard errors yet: say which weight you used, and that
standard errors were not computed.
Typical questions, conventions (populations, definitions, benchmarks) and chart forms:
`docs/report_patterns.md`.

## Access
- Key: `IPUMS_API_KEY`, free at https://account.ipums.org/api_keys; the account must be registered
  separately for each collection (usa.ipums.org, cps.ipums.org, ...). Found, in order, in the environment
  variable, the file named by `IPUMS_API_KEY_FILE`, `env.IPUMS_API_KEY` in keys.json, then in Claude Code's settings.json,
  `~/.ipums/api_key`. A 401/403 with a key set means a wrong key or an unregistered collection
  (`key_rejected`): never point at `setup` then. No key (`key_missing`): the user runs
  `npx -y data-analyst-mcp setup ipums` in their own terminal (never ask for the key in chat), or uses the
  manual route below.
- Manual route (sandbox, hosted chat, no key, no network): `manual_bundle` cannot write an IPUMS bundle yet
  (it returns `not_supported`). Give the user the website steps yourself: on the collection's website
  (usa.ipums.org, cps.ipums.org, ...), with a free account and no key, build the extract with the spec's exact
  samples, variables, case selections, CSV format and description, then download the `.csv.gz` data file and
  the `.xml` DDI codebook. After the upload: `ingest` with the files or their folder (on a hosted server,
  `files: ["uploads"]`). It warns when a requested variable is missing from the file (likely on the website
  route: ask the user to add it).
- Record the route (API, reused, hand-downloaded; `route` in `data/ipums/request.json`) and the extract
  number in the methods.

## Citation and terms
Cite IPUMS as `data/ipums/README.md` says (taken from the extract's DDI, with the versioned DOI; the
unversioned DOI does not resolve), e.g. "IPUMS CPS [dataset], DOI 10.18128/D030.V13.0. Minneapolis, MN:
IPUMS." Source line: "Analyst calculations using data from IPUMS-CPS (Current Population Survey)."
Redistribution: **definition_only**. The IPUMS terms forbid redistributing extracts (except a subset to
meet journal requirements): the extract stays in `data/ipums/` for the user's own use; never put
microdata in an artifact, published page, sent file or package. `extract_spec.json`, `README.md`,
`codebook.csv`, `variables.csv` and `request.json` may be shared, so readers request the same extract
under their own account. Aggregated
estimates and exhibit tables may be published. IPUMS deletes extract files about 72 hours after they are
built; the definition can be resubmitted any time.
