# openFDA (api.fda.gov)
Depth: standard. Key: optional (DATA_GOV_API_KEY). FDA's open data: drug, device, food, animal and tobacco
adverse event reports; drug, device and food recalls; drug labels, NDC directory, Drugs@FDA approvals,
drug shortages; device 510(k), PMA, classification, UDI; substances and UNII.

## When to use
- What is reported about a product: top adverse reactions for a drug, device malfunction reports over
  time, supplement adverse events (CAERS), tobacco problem reports.
- Recalls (enforcement reports) by class, firm, state, reason and date; drug shortages; label text
  (boxed warnings, indications); approvals and application history; device clearances.
- Not here: incidence or risk of side effects (no denominators: use trials or studies), clinical trials
  (clinical-trials), Medicare drug spending (cms), payments to doctors (open-payments), deaths by cause
  (cdc), nutrition facts (usda-fooddata).

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `search` | records (1,000 a page, at most 26,000) | `dataset`, `search`, `sort` |
| `count` | `term,count` rows (top 1,000; 999 without a key) or `time,count` for a date field | `dataset`, `search`, `count`, `limit` |

`dataset` aliases (`--endpoints` lists all 24; the path form `drug/event` works too): `drug_event`
(FAERS), `drug_label`, `drug_ndc`, `drug_enforcement`, `drugsfda`, `drug_shortages`, `device_event`
(MAUDE), `device_510k`, `device_classification`, `device_enforcement`, `device_recall`, `device_pma`,
`device_registration`, `device_udi`, `food_enforcement`, `food_event` (CAERS), `animal_event`,
`tobacco_problem`, `nsde`, `substance`, `unii`, `crl` (complete response letters),
`historical_document`, `device_covid19serology` (archived).

Search syntax (Lucene-like; the pack URL-encodes it): `field:value`, `field:"exact phrase"`,
`receivedate:[20240101 TO 20241231]`, `AND` / `OR` / `NOT`, `_exists_:field`, `_missing_:field`. Use
`.exact` for whole phrases in `count` and exact matches (`patient.drug.openfda.generic_name.exact:"METFORMIN
HYDROCHLORIDE"`); without `.exact`, counts split phrases into words.

Common count fields: drug_event `patient.reaction.reactionmeddrapt.exact`,
`patient.drug.openfda.brand_name.exact`, `serious`, `receivedate`; enforcement `classification.exact`,
`status.exact`, `state.exact`, `report_date`; device_event `event_type.exact`,
`device.generic_name.exact`; drug_ndc `pharm_class.exact`, `dea_schedule`; drug_shortages `status` and
`therapeutic_category` (their `.exact` variants answer 404 "Nothing to count"; verified 2026-10-22).

## Spec examples
```json
{"description": "Metformin adverse-event reports received in 2024: top 10 reactions",
 "requests": [{"name": "metformin_reactions_2024", "endpoint": "count",
   "params": {"dataset": "drug_event",
              "search": "patient.drug.openfda.generic_name.exact:\"METFORMIN HYDROCHLORIDE\" AND receivedate:[20240101 TO 20241231]",
              "count": "patient.reaction.reactionmeddrapt.exact", "limit": 10}}]}
```
```json
{"description": "Class I food recalls reported in 2024",
 "requests": [{"name": "food_recalls_class1_2024", "endpoint": "search",
   "params": {"dataset": "food_enforcement", "search": "classification:\"Class I\" AND report_date:[20240101 TO 20241231]",
              "sort": "report_date:asc"}}]}
```
```json
{"description": "Drug recall enforcement reports by report date, 2023-2024",
 "requests": [{"name": "drug_recalls_daily", "endpoint": "count",
   "params": {"dataset": "drug_enforcement", "search": "report_date:[20230101 TO 20241231]", "count": "report_date"}}]}
```
A date-field count gives one row per date that has records (`time` = YYYYMMDD; enforcement reports
are published weekly, so 104 dates for 2023-2024); dates with no records are absent. Aggregate to months
or years in analysis.

## Data format and traps
- Adverse event reports (FAERS, MAUDE, CAERS, animal, tobacco) are voluntary, unverified reports. A
  report does not show the product caused the event; counts reflect reporting (publicity, litigation,
  market size) as much as harm, and they are not incidence or risk rates. Say so in every use.
- A FAERS report lists every drug the patient took (`patient.drug[].drugcharacterization`: 1 suspect,
  2 concomitant, 3 interacting) and several reactions. Searching a drug name matches reports where it
  was only concomitant; a `count` on reactions counts reports containing each term, so terms overlap.
- `count` returns at most 1,000 terms (the API refuses more), sorted by count: the tail is cut off. Without
  a key, `limit=1000` answers HTTP 403 API_KEY_MISSING on some datasets (drug_event, device_event) while 999
  works, so keyless counts are sent with at most 999 (verified 2026-10-22). When the list is as long as
  the limit the pack says "stopped at N terms" (status partial). A date-field count ignores `limit` and
  returns every date.
- A count on a field that the dataset cannot count answers HTTP 404 "Nothing to count"; the pack reports
  openFDA's message (it is not a "no match"): fix the field name or drop or add `.exact`.
- `search` pages with `limit` (at most 1,000) and `skip` (at most 25,000), so one request yields at most
  26,000 records (verified); split larger pulls by date range, or use the bulk downloads.
- A search that matches nothing is HTTP 404 "No matches found" in openFDA; the pack reports it as an
  error naming the search (set `"allow_empty": true` to keep an empty table).
- Dates are text `YYYYMMDD` (`report_date`, `receivedate`, `recall_initiation_date`). Recall
  `report_date` is when FDA published the enforcement report, often weeks after initiation.
- Two device recall datasets with different fields. `device_enforcement` (enforcement reports, like drug and
  food) has `report_date`, `recall_initiation_date`, `classification` and `recall_number`.
  `device_recall` (FDA's recall database, one row per product recall) has no `report_date` or class: its
  dates are `event_date_initiated`, `event_date_posted` (when FDA posted it) and `event_date_terminated`
  (`YYYY-MM-DD`; a range search takes `event_date_posted:[20250101 TO 20251231]`), the firm is
  `recalling_firm` (word match: `recalling_firm:acme`), and it adds `root_cause_description`,
  `recall_status`, `product_res_number`, `res_event_number` (one event spans several product recalls: count
  events, not rows, for "how many recalls") and `product_code` (verified 2026-10-28).
- Exception: drug_shortages dates (`initial_posting_date`, `update_date`, `discontinued_date`) are
  `MM/DD/YYYY` text. A range search on them needs ISO dates (`initial_posting_date:[2020-01-01 TO
  2020-12-31]`); the `[20200101 TO 20201231]` form finds nothing (verified 2026-10-22). Sorting and date
  counts on them work (count `time` comes back as YYYYMMDD). Convert before comparing with other datasets.
- Enforcement reports (drug, device and food recalls) start on 2012-06-20 (`sort=report_date:asc`, verified
  2026-10-22); earlier recalls are not in the API. Say so for questions about recalls before mid-2012.
- Nested records: lists of objects become JSON text columns (`patient.drug`, `products`, `openfda.*`
  lists joined by "; "). Use `count` for tallies instead of parsing them where possible.
- `serious` is 1 (serious) or 2 (not serious); `patient.patientsex` 0 unknown, 1 male, 2 female.
- Freshness differs by dataset; report `meta.last_updated`. On 2026-10-20 FAERS was last updated
  2026-07-30 (quarterly releases), recalls, MAUDE, labels, NDC and shortages within the previous two weeks,
  and `device_covid19serology` in 2022 (archived).
- The `openfda` annotation block (brand, generic name, manufacturer) is missing on many records,
  especially older ones; a search on `openfda.*` fields misses those records.

## Access
Key optional: `DATA_GOV_API_KEY` (an api.data.gov key; sign up at https://open.fda.gov/apis/authentication/),
sent as `api_key`. That page says a key is required to call the API, but keyless calls work (verified
2026-10-22), within the lower limits below and the 999-term count limit. Without a key openFDA allows
240 requests a minute and 1,000 a day per IP; with one, 120,000 a day (openFDA documentation). Route `api` either way. Manual route: INSTRUCTIONS.md lists the
query URLs (JSON, no key needed; one per 1,000 records); open, save under the shown name, upload. Whole
datasets: https://open.fda.gov/data/downloads/ (zipped JSON).

## Citation and terms
"U.S. Food and Drug Administration, openFDA: <dataset>, api.fda.gov, retrieved <date>." Public domain,
CC0 1.0 (https://open.fda.gov/license/); redistribution allowed. Reports must carry the notice that the
data are not validated for clinical use and that adverse event counts are not rates (policy notice and
audit hook).
