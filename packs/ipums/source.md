# IPUMS microdata (USA/ACS, CPS and other collections)
Depth: deep. Key: required (IPUMS_API_KEY) for the API; the website builds the same extract with a free
account and no key. Person-level survey microdata (ACS, decennial census, CPS ASEC and monthly, IPUMS-I,
ATUS, NHIS, MEPS) as filtered extracts, for weighted estimates with standard errors computed by you.

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
| `GET /metadata/samples` | sample IDs and descriptions (`--list-samples usa --match 2023`) |
| `POST /extracts` (body built from spec.json) | `{number, status}` |
| `GET /extracts/{number}` | status queued/started/produced/completed/failed/canceled, `downloadLinks` |
| `GET downloadLinks.data.url`, `.ddiCodebook.url` | the gzipped CSV and the DDI XML codebook |

There is no variable-metadata endpoint for microdata: variable names and verified codes are in
`docs/variables.md` (sections 4-7, ready-made variable sets by topic); after a download,
`data/ipums/codebook.csv` is the authority. API body details, timing and errors: `docs/ipums_api.md`.
Collections with API extracts: usa, cps, ipumsi, atus, ahtus, mtus, nhis, meps, dhs (case selection and
monetary adjustment only for usa, cps, ipumsi: `--check` refuses them elsewhere, so mark the group with a domain mask and deflate with CPI-U after download; NHIS has no data quality flags, MEPS no attached characteristics;
dhs needs an account approved by The DHS Program, so a 401/403 there usually means that approval is
missing). Codes, weights and recodes are documented for usa, cps, nhis and meps; for the others, work from
the collection's website and `codebook.csv`, and the recode helpers refuse them.

Commands (always through the dispatcher: `python "<skill>/scripts/fetch.py" --source ipums ...`):
```
<out>/spec.json --out <out> --check           # route: reuse_existing | api | run_setup | cloud_secret |
                                              #   cloud_allowlist | manual_download | fix_spec | report_error
<out>/spec.json --out <out>                   # submit, wait, download, package (reuses / resumes itself)
<out>/spec.json --out <out> --dry-run         # print the API request body only
--resume cps:123 --out <out>                  # collect an extract submitted earlier
--list-samples usa --match 2023               # sample IDs (needs a key)
<out>/spec.json --out <out> --manual-bundle   # website steps + download_ipums.sh/.ps1 + curl steps
<out>/spec.json --out <out> --ingest [FILES]  # package the .csv.gz + .xml the user downloaded
<out>/spec.json --out <out> --reproduce-bundle <out>/reproduce   # definition + scripts for a package
```
`--check` contacts IPUMS at most once (a metadata call) and submits nothing. Route `api` with a
`resume` field means the extract was already submitted: run `next_command`. Small CPS extracts take about
a minute; multi-year ACS 5-30 minutes (run in the background; a timed-out wait keeps running at IPUMS
and the next run resumes it). Exit 4 = blocked: follow the printed route; never invent or substitute data.

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
`case_selections` with `{"detailed": [...]}` for detailed codes, `data_format`, `data_structure`.
Keep extracts lean: only the variables used, case selections for the universe, only the needed years.
Name explicitly: `CPI99` (constant dollars), `REPWTP` (replicate weights), the detailed variable you
select on (`EDUCD`). Confirm sample IDs with `--list-samples` before submitting.

## Data format and traps
Output in `<out>/data/ipums/`: `ipums_extract.csv` (uppercase mnemonics, raw IPUMS codes, one row per
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
- **Missing and top codes**: run `clean_missing(df, collection, codebook=...)`; then print min/max of
  every dollar and hours variable. USA INCWAGE 999999 = N/A, 999998 = missing; CPS INCWAGE 99999999 NIU;
  HHINCOME 9999999 (USA); UHRSWORKLY 999 NIU. An unremoved 9999999 is the classic IPUMS mistake.
- **Outliers**: `screen_outliers` on every dollar variable and derived hourly wages. In recent ASECs each
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
  (USA has no NATIVITY for ACS). `foreign_born()` applies both. CPS EMPSTAT 10/12 employed, 20-22 unemployed. Check `codebook.csv`.
- **Extract gotchas**: IPUMS adds detailed versions automatically (EDUC brings EDUCD); a data-quality
  flag or case-selection code that a sample lacks returns HTTP 400 (fix spec.json and resubmit);
  ACS 2020 1-year has experimental weights.
- **Standard errors for every compared estimate**: ACS `rep_se` with REPWTP (80) for person estimates, or
  REPWT with `weight="HHWT", prefix="REPWT"` for household estimates (tenure, household income), Census's own
  method; `lin_se` with STRATA and CLUSTER (added automatically) can understate a PUMS margin (half of the
  replicate one in a 2024 tenure check): prefer `rep_se` when the replicates are in the extract; CPS ASEC `rep_se` with REPWTP (160)
  for person estimates, or REPWT (160) with `weight="ASECWTH", prefix="REPWT"` on householders
  (`RELATE == 101`) for household estimates such as median household income (P60 tables). NHIS and MEPS have
  no replicate weights: `lin_se(df, z, **survey_design(df, collection))`, on the whole file with a domain mask
  (`share_z`, `mean_z`); helpers `uninsured`, `fair_poor_health`, `sample_adults`, `default_weight`, `pool_weight`. CPS basic monthly has
  no replicate weights and no design variables in the public files: an SE clustered by household is
  approximate, and the answer says so: `lin_se(df, z, strata=<a constant column>, cluster="CPSID")`. BLS's
  CPS variance parameters do not apply to union or earnings estimates. Union membership (`UNION`, with
  `EARNWT`): IPUMS's universe starts at age 15; BLS's published rates are for 16 and over (BLS also
  publishes the annual rate as `LUU0204899600`). Call a difference
  "statistically different" only beyond 1.645 standard errors (90 percent); otherwise "about the same".
  Thin cells (`low_n`, fewer than 100 records) are footnoted or suppressed.
- **Medians of dollar amounts**: reported income heaps on round numbers, so a plain weighted median sits
  on a heap ($60,000) and its replicate SE can come out 0. Census publishes medians interpolated within
  $2,500 intervals: use `median_binned` / `wmedian_binned` to compare with Census (P60 tables) and for
  standard errors; BLS weekly earnings use $50 intervals centred on multiples of $50 (`width=50, offset=25`);
  state which median you report. CPS earnings after March 2023: `EARNWEEK2`/`HOURWAGE2` (docs/variables.md).
- **Composition**: show the raw and a model-adjusted gap (`wls`, `standardize`); run `sensitivity()` on
  every threshold or definition; benchmark a headline number against a published figure (Census, BLS).
- Public IPUMS data cannot show legal status, benefits, or full administrative controls: say so.

Analysis helpers: `sources/ipums/lib/stats.py` (`load`, `clean_missing`, `grouped` with `mean`, `median`,
`median_binned`, `share`, `total`; recodes `emp_status`, `educ_group`, `foreign_born`, `age_group`; `rep_se`, `lin_se`,
`screen_outliers`, `wls`, `standardize`, `sensitivity`; its own `Facts` registry, formats in
`scripts/analysis/factfmt.py`):
```python
import sys, os
OUT = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(OUT, "lib"), os.path.join(OUT, "lib", "ipums"), r"<skill>/sources/ipums/lib"]  # SKILL.md section 4
from stats import *     # alone; with bea, ipums or opm too: st = pack_lib("ipums", "stats", OUT, SKILL)
D, C = f"{OUT}/data/ipums", "cps"                # "usa" (ACS), "cps", "nhis" or "meps"; codes differ
df = clean_missing(load(f"{D}/ipums_extract.csv"), C, codebook=f"{D}/codebook.csv")
df["emp"] = emp_status(df, C)
t = grouped(df, ["YEAR", "SEX"], "ASECWT", {"employment_rate": share(lambda d: d.emp == "employed", col="emp"),
                                          "median_earnings": median_binned("EARN", where=lambda d: d.EARN > 0)})
```
Typical questions, conventions (populations, definitions, benchmarks) and chart forms:
`docs/report_patterns.md`.

## Access
- Key: `IPUMS_API_KEY`, free at https://account.ipums.org/api_keys; the account must be registered
  separately for each collection (usa.ipums.org, cps.ipums.org, ...). Found, in order, in the environment
  variable, the file named by `IPUMS_API_KEY_FILE`, `env.IPUMS_API_KEY` in keys.json, then in Claude Code's settings.json,
  `~/.ipums/api_key`. A 401/403 with a key set means a wrong key or an unregistered collection (route
  `report_error`): never point at the setup script then. No key on a local/ssh machine: route
  `run_setup` (the user runs the skill's setup script with `-Source ipums` / `ipums` in their own
  terminal; never ask for the key in chat).
- Manual route (sandbox, hosted chat, no key, no network): `--check` writes
  `<out>/manual_download/ipums/` with `INSTRUCTIONS.md` (Option A without a key: the IPUMS website
  extract builder, listing the exact samples, variables, case selections, CSV format and description;
  Option B with a key: one command, `bash ~/Downloads/download_ipums.sh` (macOS/Linux) or `powershell
  -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\download_ipums.ps1"` (Windows), runs a
  self-contained script with the extract built in: it asks for the key with hidden input, submits (or
  reuses an extract number), waits and saves the `.csv.gz` and `.xml` next to itself; curl steps as a
  fallback using `extract_spec.json`). Send INSTRUCTIONS.md, both scripts and `extract_spec.json`
  (`download_scripts`, `request_body`) and give the command for the user's system (`user_commands`).
  After the upload: `--ingest` with the uploaded files or their folder. It warns when a
  requested variable is missing from the file (likely on the website route: ask the user to add it).
- Record the route (API, reused, hand-downloaded) and the extract number in the methods.

## Citation and terms
Cite IPUMS as `data/ipums/README.md` says (taken from the extract's DDI, with the versioned DOI; the
unversioned DOI does not resolve), e.g. "IPUMS CPS [dataset], DOI 10.18128/D030.V13.0. Minneapolis, MN:
IPUMS." Source line: "Analyst calculations using data from IPUMS-CPS (Current Population Survey)."
Redistribution: **definition_only**. The IPUMS terms forbid redistributing extracts (except a subset to
meet journal requirements): the extract stays in `data/ipums/` for the user's own use; never put
microdata in an artifact, published page, sent file or package. `extract_spec.json`, `README.md`,
`codebook.csv`, `variables.csv` and `request.json` may be shared, with the reproduce scripts
(`--reproduce-bundle`), so readers request the same extract under their own account. Aggregated
estimates and exhibit tables may be published. IPUMS deletes extract files about 72 hours after they are
built; the definition can be resubmitted any time.
