# ForeignAssistance.gov: U.S. foreign aid by country, sector and agency
Depth: standard. Key: none. The aggregate data files of ForeignAssistance.gov, the U.S. government's foreign
assistance reporting site (State Department and USAID). They give foreign aid by:
- recipient country or region;
- international (OECD DAC) and U.S. government sector;
- managing agency;
- funding agency and account.
Each file has transaction type (obligations, disbursements, appropriated and planned, President's budget
requests) and fiscal year, in current and constant dollars.

## When to use
- How much U.S. aid a country received; the largest recipients; aid by sector (health, peace and security,
  humanitarian, economic development, democracy); which agencies manage it; trends since the 1940s (in constant
  dollars).
- Not here: award-level federal grants and contracts with recipient names (usaspending); federal budget totals
  by function (omb, treasury); other donors' aid (world-bank has some ODA indicators).

## Endpoints
All take the same filters (applied to the published file): `country` (ISO3 code like `UKR`, or the name),
`fiscal_year`, `from`/`to`, `transaction_type` (name or id).

| Endpoint | File | Columns before the amounts |
|---|---|---|
| `by_country` | us_foreign_aid_country.csv | Country Code, Country Name, Region ID, Region Name, Income Group Acronym, Income Group Name |
| `by_dac_sector` | us_foreign_aid_dac_sector.csv | International Category ID/Name, International Sector Code/Name (no country) |
| `by_usg_sector` | us_foreign_aid_usg_sector.csv | US Category ID/Name, US Sector ID/Name, Country Code/Name |
| `by_managing_agency` | us_foreign_aid_implementing.csv | Managing Agency ID/Acronym/Name, Country Code/Name |
| `by_funding_agency` | us_foreign_aid_funding.csv | Funding Agency ID/Acronym/Name, Funding Account ID/Name, Country Code/Name |

Every file then has `Transaction Type ID`, `Transaction Type Name`, `Fiscal Year`, `current_amount` and
`constant_amount`.

## Spec examples
```json
{"description": "U.S. aid obligations to Ukraine, FY2020-2025",
 "requests": [{"name": "ukraine", "endpoint": "by_country",
   "params": {"country": "UKR", "from": "2020", "to": "2025", "transaction_type": "Obligations"}}]}
```
```json
{"description": "Aid to Ukraine by managing agency, FY2023",
 "requests": [{"name": "ukraine_agency_2023", "endpoint": "by_managing_agency",
   "params": {"country": "UKR", "fiscal_year": "2023", "transaction_type": "Obligations"}}]}
```

## Data format and traps
- Transaction types are different measures; never add them:
  - 2, Obligations: commitments made, FY1946 on.
  - 3, Disbursements: money paid out, FY2001 on.
  - 1, Appropriated and Planned: FY2004-2023.
  - 18, President's Budget Requests: FY2005-2024.
  (Ranges in the by-country file of 2026-10-30.)
- Obligations and disbursements in one year are not the same money: disbursements lag obligations.
- Dollars are whole dollars as text. `constant_amount` is inflation-adjusted and equals `current_amount` in the
  latest complete year (FY2025 in the files of 2026-10-30), so it is in that year's dollars. Name the base year.
- Fiscal years run October to September. The newest year (2026 in those files) holds partial reporting or
  budget figures only: do not compare it with full years.
- The country file includes regions and worldwide programs as rows (`WLD` World, `AFR` Africa Region, `ASN` Asia
  Region ...). Former countries have the code `NULL` ("Soviet Union (former)"). Kosovo is `CS-KM`. Some names
  contain line breaks. Drop regional rows before ranking countries, and say that regional and worldwide programs
  are not attributed to countries.
- Sector and agency files split the same money by country and category: totals from different files agree
  only roughly (late or unattributed reporting). Do not mix files in one sum.
- Security and military assistance appears where agencies report it (e.g. State and Defense programs): check
  the managing-agency file before calling a total "civilian" or "military".

## Access
No key. Manual only: on 2026-11-07 foreignassistance.gov answered this server's requests with HTTP 403 (a plain
browser download works), and the site's Data API at /data-api/ answered 404, its documentation listing
authentication errors. So `fetch` refuses and `manual_bundle` gives the link. The user downloads the CSV
from https://foreignassistance.gov/data (Data Download; files up to 22 MB, e.g.
https://foreignassistance.gov/static/us_foreign_aid_country.csv) and uploads it, and `ingest` applies the
filters.

## Citation and terms
"U.S. Department of State and USAID, ForeignAssistance.gov, <file> (data last updated <date shown on the site>),
retrieved <date>." Open Data License (as stated on the site).
