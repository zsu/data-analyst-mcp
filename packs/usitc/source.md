# USITC Harmonized Tariff Schedule (HTS REST API: duty rates by HTS line)
Depth: standard. Key: none. The current Harmonized Tariff Schedule of the United States from the U.S.
International Trade Commission: every HTS line with its general (MFN), special (trade agreement and preference)
and column 2 duty rates, units of quantity, and the chapter 99 headings (additional duties) its footnotes name.

## When to use
- The statutory duty rate on a product or a range of HTS lines, as the rate input to a customs revenue
  estimate (rate times import value) or to the static cost of a tariff change; which lines are duty free; which
  trade agreement partners get duty-free or reduced rates (program codes in `special`); the text of chapter 99
  additional duties (Section 232, Section 301 and other actions, headings 9903.xx.xx) and which lines point to
  them.
- Not here: import values, quantities and duties actually collected by product and country (census
  international trade; it needs CENSUS_API_KEY); customs duty receipts in the federal budget (treasury, Monthly
  Treasury Statement); tariff rates of past revisions through the API (see traps). Trade elasticities and
  revenue scores are not published here.

## Endpoints and datasets
Base `https://hts.usitc.gov/reststop`, keyless, JSON (verified live 2026-11-04). One CSV per request.

| Endpoint | Returns (one row per) | Key parameters | Notes |
|---|---|---|---|
| `schedule` | HTS line, in schedule order | `from`, `to` (HTS numbers, 4 to 10 digits; `to` includes every line under it: `8703` to `8703` is the whole heading, `8703` to `8704` both headings) | headings, subheadings (8-digit, where rates sit) and statistical suffixes (10-digit); about 60 rows per heading, 17,000+ statistical lines in all |
| `search` | matching HTS line | `keyword` (word, phrase or HTS number) | same columns; loose match (lines matching any word, plus chapter 99 and 9902 lines); use it to find headings, then fetch them with `schedule` |
| `current_release` | one row | none | the revision the API serves now, e.g. `2026HTSRev22` |
| `releases` | edition or revision | none | name, description, date posted, status (`current` or `archive`), since 2015 |

Columns of `schedule` and `search`: `htsno`, `indent` (0 = heading; deeper = narrower), `description` (a line's
full meaning includes the descriptions of the lines above it with lower indent), `units`, `general`, `special`,
`other` (column 2: only the countries listed in general note 3(b)), `footnotes`, `quotaQuantity`,
`additionalDuties`. Columns added by the pack: `rate_line` (the line whose rates apply), `general_effective`,
`general_rate_type` (`free`, `ad_valorem`, `specific`, `compound`, `chapter99`, `other`, `none`),
`general_ad_valorem_pct` (number, only for Free = 0 or a plain percent), `chapter99_refs`.

## Spec examples
```json
{"description": "Current HTS revision and the general duty rates on passenger cars and light trucks (headings 8703-8704)",
 "requests": [
  {"name": "release", "endpoint": "current_release", "params": {}},
  {"name": "vehicles", "endpoint": "schedule", "params": {"from": "8703", "to": "8704"}}]}
```
```json
{"description": "HTS lines matching lithium-ion batteries, and the Section 301 China headings 9903.88",
 "requests": [
  {"name": "li_ion", "endpoint": "search", "params": {"keyword": "lithium-ion"}},
  {"name": "s301", "endpoint": "schedule", "params": {"from": "9903.88", "to": "9903.89"}}]}
```

## Data format and traps
- Rates are published text. `general` may be `Free`, a percent (`2.5%`), a specific rate (`1.7¢/kg`,
  `$1.646/kg`, `3.2¢/liter`), a compound rate (a specific rate plus a percent), or text. Only Free and plain percents become
  `general_ad_valorem_pct`; a specific or compound rate needs the unit value (import value per kg or liter,
  from census trade data) to convert to an ad valorem equivalent: say so, never guess the conversion.
- Rates sit on the line that carries them, usually the 8-digit subheading; 10-digit statistical lines and
  label rows are blank in `general`. Use `rate_line` and `general_effective` (the pack's carry-down from the
  nearest line above whose number it extends), not the blank `general` of a 10-digit line. Rows with an empty
  `htsno` are label rows ("Other:") that only give context.
- `search` returns scattered lines: a statistical line whose rate line is not among the hits has
  `general_rate_type` `none`. Take the rate from `schedule` for that heading, never from a neighbouring hit.
- Additional duties are not in `general`. Chapter 99 lines (9903.xx.xx) hold Section 232, Section 301,
  safeguard and other actions as text such as "The duty provided in the applicable subheading + 25%"; a line's
  `footnotes` / `chapter99_refs` point to some of them, but coverage is decided by the chapter 99 notes and
  their product lists, country of origin and exclusions. Each footnote in `footnotes` starts with the rate column it
  concerns (`[general]`, `[other]`...): a reference marked `[other]` concerns column 2 only. Report the statutory general rate and any additional
  duty separately and name the chapter 99 heading; do not add them without checking the heading's scope.
- `special` lists the rate with program codes in parentheses (for example A, AU, CL, KR, S); the codes are
  defined in General Note 3(c) of the HTS. `other` (column 2) applies only to the countries in general note 3(b).
- The API serves only the current revision: the `release` parameter of the export is ignored (verified
  2026-11-04: the same bytes for any value). Always fetch `current_release` and name the revision with every
  rate. Rates of an earlier date come from the archived revision files (manual route).
- Statutory rates are not effective rates: duty collected over import value is lower where imports enter
  under trade agreements, preference programs or exclusions. For collected duty use census trade data
  (calculated duty) or treasury customs receipts.
- `from`/`to` take digits with or without dots (the pack sends the dotted form: the API answers undotted
  numbers with no rows, and keeps only lines up to the `to` line itself, so the pack asks past `to` and cuts the
  reply there). A range over many chapters returns tens of thousands of rows (the pack stops at 30,000 and says
  so): fetch one chapter or heading range per request.

## Access
No key; the host answers scripts (verified 2026-11-04). Limit used: one request per second. Route `api`;
`manual` is the browser: the links in `manual_download/INSTRUCTIONS.md` open each JSON reply (save the page,
upload it with --ingest), or use Export on https://hts.usitc.gov/ (choose the HTS range and JSON or CSV).
Past revisions: the archive on https://hts.usitc.gov/ lists every edition and revision (`releases` gives the
names) with downloadable files.

## Citation and terms
U.S. International Trade Commission, Harmonized Tariff Schedule of the United States (<dataset>; name the
revision, e.g. 2026 HTS Revision 22), hts.usitc.gov, retrieved <date>. A U.S. government work in the public
domain (17 U.S.C. 105); redistribution allowed. The HTS General Notes and chapter notes are the legal text
that decides how a rate applies.
