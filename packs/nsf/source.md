# National Science Foundation awards (NSF Award Search API)
Depth: standard. Key: none. NSF's awards (grants, cooperative agreements, fellowships to institutions) from the
Award Search API, one row per award:
- title and abstract;
- awardee institution, location and congressional district, and the place of performance;
- PI and co-PIs;
- NSF directorate, division and program;
- amounts obligated and estimated; award, start and expiration dates.

## When to use
- NSF funding to a university, a state or a program; NSF awards on a research topic; a researcher's NSF
  awards; new awards in a period.
- Not here: NIH grants (nih); all federal grants by agency and recipient, including NSF in USAspending's
  accounting (usaspending); national R&D spending statistics (NSF NCSES surveys such as HERD and Federal Funds for
  R&D are not covered here); patents (uspto).

## Endpoints
| Endpoint | Returns | Parameters (at least one filter) |
|---|---|---|
| `awards` | one row per award: `id`, `title`, `awardeeName`, `awardeeCity`, `awardeeStateCode`, `awardeeDistrictCode`, `perfStateCode`, `pdPIName`, `piFirstName`, `piLastName`, `coPDPI`, `dirAbbr`, `divAbbr`, `orgLongName`, `fundProgramName`, `fundsObligatedAmt`, `estimatedTotalAmt`, `date`, `startDate`, `expDate`, `transType`, `cfdaNumber`, `abstractText` ... | `keyword`, `awardeeName`, `awardeeStateCode`, `perfStateCode`, `pdPIName`, `fundProgramName`, `id`, and date ranges `dateStart`/`dateEnd` (award date), `startDateStart`/`startDateEnd`, `expDateStart`/`expDateEnd` (MM/DD/YYYY) |

## Spec examples
```json
{"description": "NSF awards mentioning quantum, made in January 2026",
 "requests": [{"name": "quantum_jan26", "endpoint": "awards",
   "params": {"keyword": "quantum", "dateStart": "01/01/2026", "dateEnd": "01/31/2026"}}]}
```
```json
{"description": "NSF awards to Vermont institutions, FY2026",
 "requests": [{"name": "vt_fy26", "endpoint": "awards",
   "params": {"awardeeStateCode": "VT", "dateStart": "10/01/2025", "dateEnd": "09/30/2026"}}]}
```

## Data format and traps
- Dollars:
  - `fundsObligatedAmt` is the money obligated to date (it grows with continuing increments).
  - `estimatedTotalAmt` is the expected total over the award's life.
  - Name which one you use. Summing `estimatedTotalAmt` over awards made in a year gives commitments, not
    spending.
  - `fundsObligated` lists the obligations by fiscal year as text.
- Dates are MM/DD/YYYY, both in filters and in the rows. `dateStart`/`dateEnd` filter the award date (`date`),
  not the period of performance.
- Collaborative research: each collaborating institution has its own award with the same title. Count awards, or
  group by title, and say which.
- `totalCount` can exceed the awards returned: 12 counted and 11 returned for keyword "quantum", January 2026, on
  2026-11-07. Report the rows you have.
- Keyword search matches title and abstract text, including unrelated uses of the word: read the titles before
  counting.
- Paging is 25 awards a page (1-based offset); requests stop at 10,000 rows. Narrow by date or state.
- People's contact fields (PI and program officer e-mail and phone) are dropped; names stay.

## Access
No key. `fetch` uses api.nsf.gov (verified 2026-11-07). Manual: https://www.nsf.gov/awardsearch/ (Advanced Search,
export CSV), or the API links in INSTRUCTIONS.md; then `ingest`. API documentation:
https://resources.research.gov/common/webapi/awardapisearch-v1.htm.

## Citation and terms
"U.S. National Science Foundation, NSF Award Search, <query>, api.nsf.gov, retrieved <date>." Public domain (17
U.S.C. 105).
