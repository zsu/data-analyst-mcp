# Consumer Product Safety Commission: product recalls and NEISS injury data
Depth: standard. Key: none.
- Recalls: from the SaferProducts.gov Recall API, one row per recall with products, units, hazards, injuries,
  remedies, firms and countries.
- NEISS: the National Electronic Injury Surveillance System, a probability sample of hospital emergency
  departments with weights for national estimates of product-related injuries. NEISS is manual only: the user
  downloads the yearly file and uploads it.

## When to use
- Which consumer products were recalled, when, why (hazard), how many units, the remedy, who made, imported
  or sold them, and where they were made; recalls that mention injuries or deaths.
- Emergency-department-treated injuries associated with consumer products: national estimates by product,
  age, sex, body part, diagnosis, disposition, location.
- Not here: vehicle, tire and car-seat recalls (nhtsa); food, drug, device and cosmetic recalls (fda);
  injury deaths from death certificates (cdc).

## Endpoints
| Endpoint | Returns | Parameters |
|---|---|---|
| `recalls` | one row per recall: `recall_number`, `recall_date`, `title`, `products`, `product_types`, `number_of_units`, `hazards`, `injuries`, `remedies`, `remedy_options`, `manufacturers`, `importers`, `distributors`, `retailers`, `manufacturer_countries`, `upcs`, `description`, `url`, `last_publish_date`, `recall_id` | API filters (at least one): `RecallDateStart`, `RecallDateEnd`, `LastPublishDateStart` (YYYY-MM-DD), `RecallNumber`, `ProductName`, `ProductType`, `RecallTitle`, `RecallDescription`, `Manufacturer`, `Retailer`, `Importer`, `Injury`, `Remedy`; filtered here: `hazard`, `country` |
| `neiss` | the uploaded NEISS year as published: `CPSC_Case_Number`, `Treatment_Date`, `Age`, `Sex`, `Race`, `Other_Race`, `Hispanic`, `Body_Part`, `Body_Part_2`, `Diagnosis`, `Diagnosis_2`, `Other_Diagnosis`, `Other_Diagnosis_2`, `Disposition`, `Location`, `Fire_Involvement`, `Alcohol`, `Drug`, `Product_1`, `Product_2`, `Product_3`, `Narrative`, `Stratum`, `PSU`, `Weight` (2019 on; earlier years lack the `_2`, `Hispanic`, `Alcohol`, `Drug`, `Product_3` columns) | `year` (required), `product` (codes kept in any product column) |

## Spec examples
```json
{"description": "Consumer product recalls announced in 2025 with fire hazards",
 "requests": [{"name": "fire_2025", "endpoint": "recalls",
   "params": {"RecallDateStart": "2025-01-01", "RecallDateEnd": "2025-12-31", "hazard": "fire"}}]}
```
```json
{"description": "Crib recalls since 2020",
 "requests": [{"name": "cribs", "endpoint": "recalls", "params": {"ProductName": "crib", "RecallDateStart": "2020-01-01"}}]}
```
```json
{"description": "NEISS 2024 cases (manual: manual_bundle, then ingest)",
 "requests": [{"name": "neiss_2024", "endpoint": "neiss", "params": {"year": "2024"}}]}
```

## Data format and traps
- Recall filters (verified 2026-11-07):
  - Text filters match part of the field. With no filter the API returns nothing, so the pack asks for one.
  - An unknown parameter is ignored silently. Only the names above are sent; check the rows match what was
    asked.
  - The API's `Hazard`, `ManufacturerCountry` and `ProductModel` filters match nothing, so use `hazard` and
    `country` here (they filter the returned rows). Narrow by date first.
- One recall can cover several products. The list fields are joined with ` | `. `number_of_units` is free text
  as published ("About 10,318", "5.9 million", "About 338,800 (In addition, about 36,300 were sold in Canada)"):
  parse it with care, never sum it blindly, and say when Canadian or Mexican units are included.
- `retailers` is free text ("Sold At: ... from May 2025 through September 2026 for about $20") and sometimes also
  names the seller or importer. `recall_date` is the announcement date. A recall number's first two digits are
  CPSC's fiscal year (27xxx = FY2027, from October 2026).
- Recalls are announcements, not incidents: a count of recalls measures CPSC and firm actions, not product
  danger.
- NEISS is a sample: each case has a `Weight`. National estimates are the sum of weights; the number of cases is
  not an estimate. Report the number of cases behind every estimate, and say when an estimate rests on few
  cases. CPSC's NEISS Estimates Query Builder gives the case count, coefficient of variation and 95% confidence
  interval for its own estimates: prefer those for a published-quality figure. Standard errors need the
  `Stratum` and `PSU` design and are not computed here.
- NEISS counts injuries *associated with* a product, not caused by it: a fall in a bathtub involves the
  bathtub. Products are codes (`Product_1` ... `Product_3`); a case can involve up to three. The codes and the
  values of `Body_Part`, `Diagnosis`, `Disposition` and `Location` are in the NEISS Coding Manual and the data
  dictionary (https://www.cpsc.gov/s3fs-public/DataDictionary042022.xlsx). `Age` 201-223 means 1-23 months. Treatment
  year, not incident year.
- The `Narrative` is free text from the hospital record. Quote it only as examples, never as counts.

## Access
No key. `fetch` works for recalls (www.saferproducts.gov). NEISS: www.cpsc.gov answers scripts with HTTP 403, and
the archived yearly files sit behind a form, so `fetch` refuses `neiss` and points to `manual_bundle`. The user
opens https://www.cpsc.gov/cgibin/NEISSQuery/home.aspx in a browser, picks a User Affiliation, chooses the year
under "Archived Annual NEISS Data" with File Format "Tab Delimited Text" (Excel also works), clicks Find Data,
saves the file and uploads it; then `ingest`.

## Citation and terms
"U.S. Consumer Product Safety Commission, Recalls (SaferProducts.gov Recall API), retrieved <date>" or "U.S.
Consumer Product Safety Commission, National Electronic Injury Surveillance System (NEISS), <year> data,
downloaded <date>." Public domain (17 U.S.C. 105). Estimates computed from NEISS cases are the analyst's own,
not CPSC's: say so.
