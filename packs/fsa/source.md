# Federal Student Aid Data Center (student loan portfolio, Title IV volume by school)
Depth: standard. Key: none. U.S. Department of Education, Office of Federal Student Aid: the federal student
loan portfolio (outstanding balances and recipients by program, loan status, delinquency, repayment plan, loan
type, borrower state, age and debt size; quarterly from NSLDS) and Direct Loan and grant (Pell, TEACH) volume by
school and award-year quarter (from COD). Published .xls workbooks, read into tidy rows (needs the Python
package xlrd).

## When to use
- How much federal student debt is outstanding, and how it splits by program (Direct Loans, FFEL, Perkins),
  status (repayment, deferment, forbearance, default), delinquency, repayment plan (IBR, PAYE, SAVE...),
  loan type (Stafford, Grad PLUS, Parent PLUS, consolidation), borrower state, age or debt size.
- Loans originated and disbursed, and Pell/TEACH grants disbursed, by school, state and program, per award year.
- Not here: college costs, completion, earnings and debt at graduation by institution (college-scorecard);
  federal outlays and awards for student aid (treasury, usaspending); household debt from
  surveys (fred for the Fed's G.19 consumer credit series); enrollment counts (IPEDS, not a pack).

## Endpoints and datasets
| Endpoint | Returns (one row per ...) | Params | Units | Coverage |
|---|---|---|---|---|
| `portfolio_summary` | period x program (Direct Loans, FFEL, Perkins, Total) | none | $ billions, millions | FY2007-2012 annual, FY2013 Q1 on |
| `portfolio_by_loan_status` | period x status | `sheet`: Direct Loan (default), FFEL, ED-Held FFEL, Federally Managed | $ billions, millions | FY2013 Q3 on (ED-held FFEL FY2016 on) |
| `portfolio_by_loan_type` | period x loan type | none | $ billions, millions | FY2014 Q2 on |
| `portfolio_by_delinquency` | period x days delinquent (loans in repayment) | `sheet`: DLPortfoliobyDelinquencyStatus, ED-HeldFFELbyDelinquencyStatus, FedManagedPortbyDelinquencyStat | $ billions, millions | FY2013 Q3 on |
| `portfolio_by_repayment_plan` | period x plan | `sheet`: DLPortfoliobyRepaymentPlan, DL-IDRbyPFH, ED-HeldFFELbyRepaymentPlan, ED-HeldFFEL-IDRbyPFH, FedManagedPortbyRepaymentPlan, FedManaged-IDRbyPFH | $ billions, millions | FY2013 Q3 on |
| `portfolio_by_location` | borrower state (+ Other, Not Reported), latest quarter only (`as_of`) | none | $ billions, borrowers in thousands | one quarter |
| `portfolio_by_age` | period x age band | none | $ billions, borrowers in millions | FY2017 Q2 on |
| `portfolio_by_debt_size` | period x balance band | none | $ billions, borrowers in millions | FY2017 Q2 on |
| `dl_volume_by_school` | school x loan program | `award_year` (2025-26), `quarter` 1-4, `sheet` (Award Year Summary = cumulative, default; Quarterly Activity), `state`, `school` | counts, dollars | award years 2018-19 on |
| `grant_volume_by_school` | school x grant program | same as above | recipients, dollars | award years 2018-19 on |

Portfolio columns: `report` (the sheet title), `fiscal_year`, `quarter` (Q1-Q4; empty for the annual rows),
`period_end`, `category`, then `dollars_outstanding_billions` and `recipients_millions` (Total:
`unduplicated_recipients_millions`; Stafford (Combined): `unique_recipients_millions`; age and debt size:
`borrowers_millions`). Location: `as_of`, `location`, `balance_billions`, `borrowers_thousands`. Volume:
`award_year`, `activity` (quarter / award year to date), `period_start`, `period_end`, `as_of`, `ope_id`, `school`,
`state`, `zip_code`, `school_type`, `program`, `recipients`, `loans_originated_count`, `loans_originated_dollars`,
`disbursements_count`, `disbursements_dollars` (grants: `recipients`, `disbursements_dollars`).

## Spec examples
```json
{"description": "Total federal student loan portfolio by program, every quarter",
 "requests": [{"name": "portfolio", "endpoint": "portfolio_summary", "params": {}}]}
```
```json
{"description": "Federally managed loans by status, and Direct Loans by repayment plan",
 "requests": [{"name": "status", "endpoint": "portfolio_by_loan_status", "params": {"sheet": "Federally Managed"}},
              {"name": "plans", "endpoint": "portfolio_by_repayment_plan", "params": {}}]}
```
```json
{"description": "Direct Loans and Pell Grants at Texas schools, award year 2024-25 (whole year)",
 "requests": [{"name": "dl_tx", "endpoint": "dl_volume_by_school", "params": {"award_year": "2024-25", "quarter": 4, "state": "TX"}},
              {"name": "pell_tx", "endpoint": "grant_volume_by_school", "params": {"award_year": "2024-25", "quarter": 4, "state": "TX"}}]}
```

## Data format and traps
- Units: portfolio dollars are outstanding principal plus interest in billions (rounded to 0.1 in most
  rows; some rows carry more digits); recipients and borrowers in millions (location: thousands). Volume files
  are in dollars and counts. The Total in `portfolio_summary` may not equal the sum of the programs (rounding,
  timing of data runs: the file says so).
- Recipients are not additive: a recipient is the student (for Parent PLUS the parent borrows, the child is the
  recipient), counted once per program, status or loan type, and many hold several. Use the Total's
  `unduplicated_recipients_millions` for the number of people; never add recipients across categories. The age,
  debt-size and location reports count borrowers, not recipients.
- Programs: Direct Loans (ED-held, made since 2010 alone); FFEL (bank-originated, guaranteed; part is now
  ED-held, the rest commercially held); Perkins (school-held, ended 2017; location/age/debt-size exclude
  interest on school-held Perkins). "Federally managed" = Direct Loans + ED-held FFEL. Loan status, delinquency
  and repayment-plan sheets each cover one portfolio: do not add the Direct Loan and Federally Managed sheets.
- Periods: portfolio rows are federal fiscal years (Oct-Sep): Q1 ends Dec 31 of the prior calendar year, Q4
  ends Sep 30 (`period_end` gives the date). Volume files use award years (Jul 1-Jun 30): award-year quarter 1 =
  Jul-Sep, 4 = Apr-Jun; quarter 4's Award Year Summary is the whole award year. The two calendars do not line up.
- Revisions: volume files are refreshed each quarter for at least seven prior quarters, then final (`as_of`
  shows the run date; some older years were re-run in 2026). Portfolio files are replaced in place quarterly
  and their history can change slightly. Location is one quarter only (as_of 2026-03-31 in the 2026-10 file).
- Status breaks: from March 2020 to August 31, 2023 the payment pause put most ED-held loans in forbearance
  (federally managed loans in repayment: $719 billion in FY2019 Q4, $12 billion in FY2020 Q3; forbearance
  $1,138 billion in FY2023 Q3) and no new defaults arose, so "Cumulative in Default" drifts down until FY2025 and
  then climbs fast as delinquent loans reach default again ($117 billion in FY2025 Q4, $234 billion in FY2026 Q3,
  federally managed); the on-ramp through Sep 30, 2024 kept missed payments out of delinquency; in FY2024 Q4 SAVE borrowers were moved to forbearance by a court
  injunction, and SAVE balances shrink from 2025 as borrowers move to other plans ($450 billion in FY2024 Q4,
  $354 billion in FY2026 Q3). The SAVE column holds REPAYE (which SAVE replaced in 2023) before then; it starts
  in FY2016 Q1. "-" (a plan that did not exist yet) and "NA**"/"NA***" (recipients not available for Other) are
  empty cells; a period-category row with every cell empty is left out.
- Default: "Cumulative in Default" = more than 360 days delinquent (for reporting); loans transferred to the
  Debt Management and Collections System are not in the delinquency report.
- Location: FFEL and Perkins lenders need not report addresses, so "Not Reported" holds about $52 billion;
  state rows are not the full balance of borrowers living there.
- Volume files: one row per school and program with any activity (a "-" program is left out); OPE ID and ZIP
  are text (leading zeros); foreign schools have an empty state. `state` and `school` filter after download.
- Layout check: the reader finds the header row by its first cell ("Federal Fiscal Year", "Location", "OPE
  ID") and fails with "the workbook layout changed" rather than shift columns if FSA moves it.

## Access
No key. Files come from studentaid.gov/sites/default/files/fsawg/datacenter/library/ (fixed names, refreshed in
place; volume files named dl-dashboard-ay2025-2026-q4.xls and grants-ay24-25-q4.xls). Only .xls is published;
reading it needs the Python package xlrd (`install_deps` without it). A file not yet published (the next award
year) is a 404, reported as not found. Manual route: the links in manual_download/INSTRUCTIONS.md, or the Data
Center pages (https://studentaid.gov/data-center/student/portfolio and
https://studentaid.gov/data-center/student/title-iv): download the .xls, upload it, then --ingest. Without
xlrd, save the sheet as CSV including its title rows and upload that.

## Citation and terms
"U.S. Department of Education, Federal Student Aid, <report name>, FSA Data Center (studentaid.gov/data-center),
retrieved <date>." Name the quarter (fiscal-year or award-year) and the as-of date. Public domain (U.S.
government work); aggregate data, redistribution allowed.
