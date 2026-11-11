# USDA RMA federal crop insurance: Summary of Business (liability, premium, subsidy, indemnity) and reinsurance results
Depth: standard. Key: none. The Risk Management Agency's public data files (pubfs-rma.fpac.usda.gov), which
run the Federal Crop Insurance Corporation's program:
- the Summary of Business by commodity year, state, county, crop, insurance plan, coverage category, delivery
  type and coverage level: policies, units, insured quantity, liability, total premium, premium subsidy,
  indemnity and loss ratio (1989 on);
- the Standard Reinsurance Agreement results by reinsurance year and fund, national or by state: gross and
  retained liability, premium and indemnity, and the insurance companies' net underwriting gain or loss
  (2014 on).

## When to use
- Crop insurance cost inputs: premium subsidies (the federal share of premium) by state, crop, plan or coverage
  level; indemnities and loss ratios over time; liability and insured acres; the effect of a change in subsidy
  rates by coverage level; companies' underwriting gains, a program cost beside subsidies.
- Not here: crop insurance outlays by fiscal year as the budget records them (treasury MTS, omb; USDA's
  budget account is the Federal Crop Insurance Corporation Fund); crop production, prices and acreage on all
  farms (usda-nass, usda-outlook); farm commodity program payments.

## Endpoints
| Endpoint | Rows | Filters |
|---|---|---|
| `coverage` (`year`, a commodity year; 3 to 30 MB a year, 150,000 rows recently) | one per year, state, county, crop, plan, coverage category, delivery type and coverage level | `state` (abbreviation or FIPS), `county` (FIPS), `commodity` (name or code), `plan` (abbreviation or code), `coverage_category`, `delivery_type` |
| `reinsurance` (`year`, a reinsurance year; `level` National or State) | one per fund (and state), plus the published Total row | `state` |

Columns of `coverage`, as the layout document names them: Commodity Year, Location State Code, Location State
Abbreviation, Location County Code, Location County Name, Commodity Code, Commodity Name, Insurance Plan Code,
Insurance Plan Name Abbreviation, Coverage Category, Delivery Type, Coverage Level, Policies Sold Count,
Policies Earning Premium Count, Policies Indemnified Count, Units Earning Premium Count, Units Indemnified Count,
Quantity Type, Net Reported Quantity, Endorsed/Companion Acres, Liability Amount, Total Premium Amount, Subsidy
Amount, State/Private Subsidy, Additional Subsidy, EFA Premium Discount, Indemnity Amount, Loss Ratio.

## Spec examples
```json
{"description": "Iowa corn crop insurance by plan and coverage level, crop year 2024",
 "requests": [{"name": "ia_corn_2024", "endpoint": "coverage", "params": {"year": "2024", "state": "IA", "commodity": "Corn"}}]}
```
```json
{"description": "Standard Reinsurance Agreement results by fund, national, reinsurance year 2024",
 "requests": [{"name": "sra_2024", "endpoint": "reinsurance", "params": {"year": "2024", "level": "National"}}]}
```

## Data format and traps
- Dollars, as published (whole dollars in `coverage`; reinsurance sheets carry decimals). Loss Ratio is
  indemnity / total premium, as a decimal (`.33`); recompute it from summed dollars, never average it.
- Total Premium Amount is the full premium. The federal premium subsidy is Subsidy Amount. The farmer-paid
  premium is total premium less Subsidy Amount, State/Private Subsidy, Additional Subsidy (the 2021-2022
  Pandemic Cover Crop Program) and EFA Premium Discount. The subsidy rate (subsidy / premium) is set by law for
  each coverage level and unit structure; read it from the data, never assume it.
- The Summary of Business holds premium, subsidy and indemnity only. The program's full cost also includes
  delivery expense (A&O) reimbursements to companies and their underwriting gains under the reinsurance
  agreement (`reinsurance`: Net Gain/Loss, positive is a company gain), which are not in `coverage`.
- Years: commodity (crop) year in `coverage`; reinsurance year (July to June) in `reinsurance`. Neither is the
  federal fiscal year. Open years (the current and next crop years) are updated every week and late years still
  change as claims settle; give the file date (the zip's member date) with the numbers.
- Quantity Type is the unit of Net Reported Quantity (Acres, Colonies, Trees, Vines, NotReported...): never add
  quantities across types. Insured acres are counted once per plan line, so acres across crops add, but the
  Endorsed/Companion Acres of an SCO, STAX or ECO endorsement are on top of the underlying policy's acres.
- Indemnities can be negative (adjustments: 25 rows in the 2024 file of 2026-11-11). Sum them with the rest.
- Policy and unit counts are not available for CLIP and some area plans (zeros), so counts do not add across
  plans to a farm count.
- County 999 (All Other Counties) and commodity 9999 (All Other Crops) are published groupings; keep them in
  totals.
- `reinsurance` has a Total row (sum of the funds; State: all states): drop it before summing. Retained figures
  include the 6.5 percent net book quota share (the sheet's footnote). Fund A is assigned (mostly ceded to
  FCIC), fund C commercial.
- Older years and other files on the server: by type, practice and unit structure (sobtpu, 1999 on), cause of
  loss by month (colsom), livestock (LRP, LGM, DRP). Not read here.

## Access
No key. `fetch` reads pubfs-rma.fpac.usda.gov/pub/Web_Data_Files (verified 2026-11-11: sobcov zips up to
3 MB compressed, 28 MB of text; reinsurance .xls 30 to 50 KB) and filters the rows here. Manual: the same
folders in a browser, then `ingest` the zip or workbook. The layout documents sit beside the files
(SOB_State_County_Crop_with_Coverage_Level_1989_Forward.pdf).

## Citation and terms
"U.S. Department of Agriculture, Risk Management Agency, Summary of Business (State/County/Crop with Coverage
Level), sobcov_<year>.zip, pubfs-rma.fpac.usda.gov, retrieved <date>." For reinsurance: "..., Standard
Reinsurance Agreement Report, <year> <National|State> ...". Public domain (17 U.S.C. 105).
