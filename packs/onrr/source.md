# ONRR natural resources revenue data: federal and Native American royalties, rents, bonuses, disbursements and production
Depth: standard. Key: none. The Office of Natural Resources Revenue's open data (Natural Resources Revenue Data,
revenuedata.onrr.gov), as its CSV downloads:
- revenue companies paid for extracting oil, gas, coal, minerals and renewable energy on federal onshore and
  offshore lands and Native American lands (royalties, rents, bonuses, other revenues), by year or month;
- disbursements of that money to the U.S. Treasury, states and counties, and federal funds;
- production volumes on those lands.

## When to use
- Federal royalties and other mineral revenue by state, county, offshore region, commodity or year; offshore
  lease bonuses; how much a state received (disbursements); oil, gas and coal produced on federal lands.
- Not here: total U.S. or state production and prices on all lands (eia); federal receipts in the budget
  (treasury MTS, omb); severance taxes states levy themselves (census government finances).

## Endpoints
All take `state` (full name), `from`/`to` (years).

| Endpoint | Columns | More filters |
|---|---|---|
| `fiscal_year_revenue`, `calendar_year_revenue`, `monthly_revenue` (`Date` MM/DD/YYYY; 42 MB) | Fiscal Year (or Calendar Year, Date), Land Class, Land Category, State, County, FIPS Code, Offshore Region, Revenue Type, Mineral Lease Type, Commodity, Product, Revenue | `commodity`, `revenue_type`, `land_class` |
| `fiscal_year_disbursements` | Fiscal Year, Fund Type, Source, State, County, Disbursement | `fund_type` |
| `fiscal_year_production`, `calendar_year_production` | Fiscal Year (or Calendar Year), Land Class, Land Category, State, County, FIPS Code, Offshore Region, Product, Volume | `product` |

## Spec examples
```json
{"description": "Federal mineral revenue in New Mexico by type and commodity, FY2025",
 "requests": [{"name": "nm_fy2025", "endpoint": "fiscal_year_revenue", "params": {"state": "New Mexico", "from": "2025", "to": "2025"}}]}
```
```json
{"description": "Disbursements to Wyoming, FY2020-2025",
 "requests": [{"name": "wy_disb", "endpoint": "fiscal_year_disbursements", "params": {"state": "Wyoming", "from": "2020", "to": "2025"}}]}
```

## Data format and traps
- Revenue is in dollars, as text. Rows can be negative (adjustments and refunds: 3,486 negative rows in the
  fiscal-year file of 2026-11-07). Sum them with the rest; never drop them.
- Revenue by state is where the resource is (onshore federal land). Offshore revenue has no state (`State`
  empty, `Offshore Region` = Gulf of America, Pacific, Alaska, Atlantic). Native American revenue (`Land Class`
  Native American) has no state or county in these files. A state total from the State column
  is federal onshore revenue only: say so.
- Revenue and disbursements are different money flows and years: disbursements follow collection, and offshore
  revenue reaches states under their own formulas. Never subtract one from the other.
- `Product` carries the unit in production files (Oil (bbl), Gas (mcf), Coal (tons) ...): never add volumes
  across products.
- The current fiscal year is partial. Fiscal years run October-September. Revenue starts FY2004 (CY2003);
  older years are in separate historical files (not covered).

## Access
No key. `fetch` reads revenuedata.onrr.gov/downloads/<file>.csv (revenuedata.doi.gov redirects there; verified
2026-11-07; up to 42 MB) and filters it. Manual: the Downloads page, then `ingest`. The site's documentation
pages under /downloads/ describe each field.

## Citation and terms
"U.S. Department of the Interior, Office of Natural Resources Revenue, Natural Resources Revenue Data, <file>,
revenuedata.onrr.gov, retrieved <date>." Public domain (17 U.S.C. 105).
