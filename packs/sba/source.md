# SBA loan data: 7(a) and 504 loans (FOIA loan-level files), activity reports, disaster loans
Depth: standard. Key: none. The U.S. Small Business Administration's loan data on data.sba.gov:
- the 7(a) and 504 FOIA files: one row per approved loan since FY1991, with borrower, lender or Certified
  Development Company, amount, dates, industry, location and status;
- through the catalog, the activity reports and disaster loan workbooks.

## When to use
- SBA 7(a) or 504 loans by state, county, congressional district, industry (NAICS), lender, fiscal year; loan
  sizes; charge-offs and paid-in-full status; franchise loans.
- Not here: all federal loans and grants by recipient (usaspending); PPP loans (not in these files); bank
  lending in general (fdic, fed-board); business counts (census CBP).

## Endpoints
| Endpoint | Returns | Parameters |
|---|---|---|
| `list_files` | every file in data.sba.gov's catalog: `dataset`, `title`, `format`, `file` (the path for `foia`, CSVs only), `url`, `modified` | `search` (e.g. `7(a) & 504 FOIA`) |
| `foia` | the loans of one FOIA file that pass the filters, columns as published | `file` (from `list_files`), and at least one of `state` (ProjectState), `fiscal_year`, `from`/`to` (ApprovalFY), `naics` (prefix) |

Files of 2026-11-07 (as of September 30, 2026): `uploaded_resources/FOIA_7a_FY1991_FY1999_asof_260930`,
`..._FY2000_FY2009_...`, `..._FY2010_FY2019_...`, `..._FY2020_Present_...`, `uploaded_resources/FOIA_504_FY1991_FY2009_asof_260930`,
`..._504_FY2010_Present_...`. The as-of part changes each quarter: run `list_files` first.

## Spec example
```json
{"description": "504 loans in Vermont approved FY2024-2025",
 "requests": [{"name": "files", "endpoint": "list_files", "params": {"search": "7(a) & 504 FOIA"}},
  {"name": "vt_504", "endpoint": "foia", "params": {"file": "uploaded_resources/FOIA_504_FY2010_Present_asof_260930",
    "state": "VT", "from": "2024", "to": "2025"}}]}
```

## Data format and traps
- 504 columns (FOIA_504): AsOfDate, Program, LocationID, BorrName, BorrStreet, BorrCity, BorrState, BorrZip, CDC_Name ...,
  ThirdPartyLender_Name, ThirdPartyLender_City, ThirdPartyLender_State, ThirdPartyDollars, GrossApproval,
  ApprovalDate, ApprovalFY, FirstDisbursementDate, ProcessingMethod, TermInMonths, NaicsCode, NaicsDescription,
  FranchiseCode, FranchiseName, ProjectCounty, ProjectState, SBADistrictOffice, CongressionalDistrict,
  BusinessType, BusinessAge, LoanStatus, PaidInFullDate, ChargeOffDate, GrossChargeOffAmount, JobsSupported,
  CollateralInd. 7(a) files have the lender instead of CDC and third-party columns (BankName, BankFDICNumber,
  BankNCUANumber, BankStreet, BankCity, BankState, BankZip), plus SBAGuaranteedApproval, InitialInterestRate,
  FixedorVariableInterestInd, RevolverStatus and SoldSecMrktInd. Read the data dictionary in `list_files`
  (7a_504_foia_data_dictionary.xlsx) before use.
- `state` filters `ProjectState` (where the project is), not `BorrState`. ApprovalFY is the federal fiscal
  year (October-September).
- Dollars are text with a decimal (`263000.0`). In 504 loans, `GrossApproval` is the CDC/SBA debenture and
  `ThirdPartyDollars` the private lender's first lien: the project is larger than either. In 7(a),
  `SBAGuaranteedApproval` is SBA's guaranteed part of `GrossApproval`: say which you sum.
- `LoanStatus` and charge-off fields are as of the file's `AsOfDate`: recent loans have had little time to
  default. Compare charge-off rates by approval cohort, not across all years.
- Borrowers are named businesses (sometimes sole proprietors with a home address). Analyse in aggregate; do not
  single out individuals.
- Size: the files are 60 to 255 MB. `fetch` streams them and keeps only the rows that pass the filters
  (Vermont 504 FY2024-2025: 35 loans, about 7 s, on 2026-11-07).

## Access
No key. `fetch` uses data.sba.gov (`/data.json` for the catalog, `/sites/default/files/...` for files; the CKAN API
answers 404; verified 2026-11-07). Manual: download the CSV from data.sba.gov ("7(a) & 504 FOIA"), then `ingest`
with the same filters.

## Citation and terms
"U.S. Small Business Administration, 7(a) & 504 FOIA, <file> (as of <date>), data.sba.gov, retrieved <date>."
Public data released by SBA under FOIA.
