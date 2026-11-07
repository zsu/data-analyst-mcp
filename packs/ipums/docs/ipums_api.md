# IPUMS API v2 cheat sheet (microdata)

`sources/ipums/ipums_api.py` and `sources/ipums/fetch.py` (run as `scripts/fetch.py --source ipums`) already implement all of this. Read this file
when you need a feature the friendly spec doesn't expose, or when debugging an API error.

## Auth
- Header `Authorization: <key>`. The key comes from env `IPUMS_API_KEY`; never print or log it.
- The **401** error usually means one of two things. Either the key is wrong, or the account isn't registered for that collection. Registration is separate per collection (usa.ipums.org, cps.ipums.org, ...). Tell the user which collection to register for, then stop.

- When the key is missing, rejected or the API is unreachable, `fetch.py --source ipums` exits with code 4. A sandbox
  user then downloads on their own computer with one command that runs
  `<out>/manual_download/ipums/download_ipums.sh` or `download_ipums.ps1` (self-contained scripts with the
  extract built in that ask for the key with hidden input, submit, poll and download; curl steps and website
  steps are in `INSTRUCTIONS.md`), and the files are packaged with `fetch.py --source ipums ... --ingest`. The three calls are POST `/extracts`, GET `/extracts/{number}`
  until `status` is `completed`, then GET `downloadLinks.data.url` and `downloadLinks.ddiCodebook.url`
  (all with the Authorization header).

## Endpoints (`https://api.ipums.org`, every call takes `?collection=<c>&version=2`)
| What | Call |
|---|---|
| List sample IDs | `GET /metadata/samples?collection=usa&version=2&pageSize=500` returns `{data:[{name, description}], links:{nextPage}}` |
| Submit extract | `POST /extracts?collection=usa&version=2` with a JSON body (below) returns `{number, status:"queued"}` |
| Status | `GET /extracts/{number}?collection=usa&version=2` returns `status`: queued, started, produced, completed, failed, canceled |
| Recent extracts | `GET /extracts?collection=usa&version=2&pageSize=10` |
| Download | `GET <downloadLinks.data.url>` with the same Authorization header |

There is **no variable-metadata endpoint for microdata**. Get variable names from
`docs/variables.md`, or from the collection's website (`https://usa.ipums.org/usa-action/variables/<NAME>`).
After the download, `codebook.csv` holds the authoritative codes.

## Extract body
```json
{
  "description": "Prime-age employment by nativity",
  "dataStructure": {"rectangular": {"on": "P"}},
  "dataFormat": "csv",
  "samples": {"us2023a": {}, "us2018a": {}},
  "variables": {
    "AGE":     {"caseSelections": {"general": ["25", "26", "27"]}},
    "EDUCD":   {},
    "INCWAGE": {"dataQualityFlags": true, "adjustMonetaryValues": true},
    "EDUC":    {"attachedCharacteristics": ["spouse", "head"]}
  },
  "caseSelectWho": "individuals"
}
```
- `dataFormat`: `csv` (the default here, a gzipped CSV), `fixed_width`, `stata`, `spss`, `sas9`. CSV is the most portable choice for analysts. Every extract also comes with a DDI XML codebook.
- `dataStructure`: `{"rectangular":{"on":"P"}}` gives one row per person with household variables repeated on each row. `{"hierarchical":{}}` gives separate H and P records; avoid it. `{"householdOnly":{}}` is USA only.
- `caseSelections.general` lists codes as strings. The API accepts unpadded codes (`"25"`, as tested on CPS AGE). For a *detailed* variable code, use `{"detailed": [...]}`.
- Case selection on several variables is AND-ed. Several codes within one variable are OR-ed.
- `caseSelectWho`: `individuals` (the default) keeps only matching persons. `households` keeps everyone in a household that contains a matching person; use it for family or household measures.
- `attachedCharacteristics`: `mother`, `father`, `spouse`, `head`. Each adds a column such as `EDUC_SP`.
- `adjustMonetaryValues: true` (usa/cps/ipumsi) adds a CPI-adjusted copy of a dollar variable, for example `INCWAGE_CPIU_2010`. Check `variables.csv` for its label and base year.
- `dataQualityFlags: true` adds a `Q<VAR>` column showing whether the value was allocated or imputed.
- Technical variables are added automatically (YEAR, SERIAL, PERNUM and the weights, plus SAMPLE/CBSERIAL/CLUSTER/STRATA/GQ for USA, plus MONTH/CPSID/ASECFLAG for CPS, STRATA/PSU/SAMPWEIGHT/ASTATFLG/CSTATFLG for NHIS, PSUANN/STRATANN/PSUPLD/STRATAPLD/PERWEIGHT/SAQWEIGHT/DIABWEIGHT for MEPS).

## Timing and limits
- A small CPS, NHIS or MEPS extract finishes in about 10–60 s (one NHIS or MEPS year: 11 s in October 2026). ACS 1-year extracts take minutes. Multi-year ACS 5-year or full-count extracts can take 30+ minutes.
- If the fetch times out, the extract keeps running at IPUMS. Resume it with `python <skill>/scripts/fetch.py --source ipums --resume usa:<number> --out <dir>`.
- Extract files expire after about 72 hours. The definition saved in `data/extract_spec.json` can be resubmitted at any time.
- On 429 or 5xx errors the client backs off and retries automatically.

## Collections that support microdata extracts through the API
`usa`, `cps`, `ipumsi`, `atus`, `ahtus`, `mtus`, `nhis`, `meps`, `dhs`. Case selection and monetary adjustment are
available for usa, cps and ipumsi only (`--check` refuses them for the others: route `fix_spec`). The API also refuses data quality flags for NHIS and attached characteristics for MEPS; it rectangularizes NHIS on person or injury records (`P`, `I`) and MEPS on person or round records (`P`, `R`), and both allow hierarchical extracts (developer.ipums.org, checked 2026-10). NHIS and MEPS
variable names, weights and design variables are in `variables.md` sections 8-9. An unknown variable name returns
HTTP 400 listing every invalid name ("Invalid variable name: EMPSTAT"), and a variable outside the chosen samples
says so ("PARTWEIGHT: This variable is not available in any of the samples currently selected"): fix and resubmit.
