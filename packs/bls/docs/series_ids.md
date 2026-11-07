# Series IDs

A wrong series ID is the most common silent error: the number exists, it is just not the number the
user asked about. Before downloading, run `python <skill>/scripts/fetch.py --source bls --describe <ID> ...` and read
the title, the seasonal adjustment and the dimensions back against the request.

Contents: 1. How IDs are built · 2. Verified common series · 3. Finding an ID you do not know · 4. ID builders

## 1. How IDs are built
The first two letters name the survey; for most surveys the third is **S** (seasonally adjusted) or
**U** (not seasonally adjusted). Full formats: https://www.bls.gov/help/hlpforma.htm.

| Prefix | Survey | Structure (after the prefix and S/U) |
|---|---|---|
| LN | Current Population Survey (household survey) | 8-digit series code, e.g. `LNS14000000` |
| CE | Current Employment Statistics (payroll survey), national | 8-digit industry + 2-digit data type (`01` employment, thousands; `02` avg weekly hours; `03` avg hourly earnings; `08` AHE production and nonsupervisory; `11` avg weekly earnings; `13` real AHE, 1982-84 dollars (CPI-U); `32` real AHE of production and nonsupervisory employees (CPI-W)) |
| SM | CES state and metro | 2-digit state FIPS + 5-digit area + 8-digit industry + 2-digit data type |
| CU / CW / SU | CPI-U / CPI-W / chained CPI-U | `R` (monthly) or `S` (semiannual) + 4-char area (`0000` U.S. city average, `S49A` Los Angeles ...) + item (`SA0` all items, `SA0L1E` less food and energy, `SAF1` food, `SAF11` food at home, `SEFV` food away from home, `SA0E` energy, `SAH1` shelter, `SEHA` rent, `SEHC` owners' equivalent rent, `SETB01` gasoline, `SAM` medical care, `SAM2` medical care services, `SETE` motor vehicle insurance, `SETA02` used cars and trucks, `SAS` services) |
| WP / PC | PPI commodities and final demand / industries | `WPSFD4` final demand SA, `WPUFD4` NSA |
| JT | JOLTS | 6-digit industry + 2-digit state + 5-digit area + 2-char size class + 2-char element (`JO` openings, `HI` hires, `QU` quits, `TS` total separations, `LD` layoffs) + `L` level (thousands) or `R` rate |
| LA | Local Area Unemployment Statistics | 2-char area type (`ST` state, `MT` metro, `CN` county) + 13-digit area code + 2-digit measure (`03` rate, `04` unemployed, `05` employed, `06` labor force) |
| EN | QCEW | `U` + area (5) + data type (1) + size (1) + ownership (1) + industry code as written, not padded (`10` = all industries, or the NAICS code): `ENU2403110110` = Montgomery County MD, federal government employment [checked 2026-10-22] |
| OE | OEWS (annual, period A01) | area type + area + industry + occupation (SOC) + data type |
| CI | Employment Cost Index (quarterly) | `CI` + S/U + owner (`1` civilian, `2` private industry, `3` state and local government) + `0` + component (`1` total compensation, `2` wages and salaries, `3` benefits) + `0000000000` + `I` index or `A` 12-month percent change (NSA; BLS's headline 12-month changes): `CIU2020000000000A` private wages and salaries, `CIU3020000000000A` state and local (read back with `--describe` on 2026-10-21) |
| PR | Productivity and costs (quarterly) | `PRS85006092` nonfarm business labor productivity, percent change at annual rate; `PRS85006112` unit labor costs; indexes 2017=100 (for growth since a date): `PRS85006093` productivity, `PRS85006103` hourly compensation, `PRS85006153` real hourly compensation, `PRS85006173` labor share, `PRS85006143` output price deflator |
| LE | CPS usual weekly earnings (quarterly) | `LEU0252881500` median weekly earnings, full-time wage and salary workers |

## 2. Verified common series ✔ (returned data on 2026-10-19; labels checked against the BLS series titles on 2026-10-21)
| Measure | SA | NSA / other |
|---|---|---|
| Unemployment rate (U-3), 16+ | `LNS14000000` | `LNU04000000` |
| U-6 rate | `LNS13327709` | |
| Labor force participation rate | `LNS11300000` | |
| Employment-population ratio | `LNS12300000` | |
| Participation rate, ages 25 to 54 | `LNS11300060` | |
| Employment-population ratio, ages 25 to 54 (total; men `LNS12300061`, women `LNS12300062`) | `LNS12300060` | |
| Employed / unemployed, levels (thousands) | `LNS12000000` / `LNS13000000` | |
| Unemployment rate: men 16+, women 16+ | `LNS14000001`, `LNS14000002` | |
| Unemployment rate: White, Black, Hispanic, Asian | `LNS14000003`, `LNS14000006` (from 1972), `LNS14000009` (from 1973), `LNS14032183` (from 2000) | `LNU04000003`, `LNU04000006`, `LNU04000009`, `LNU04032183` |
| Unemployment rate, ages 16 to 24 / 16 to 19 / 20 to 24 | `LNS14024887` / `LNS14000012` / `LNS14000036` | `LNU04024887` (16 to 24) |
| Unemployment rate by education, 25 and over: less than high school / high school, no college / some college or associate / bachelor's and higher | `LNS14027659` / `LNS14027660` / `LNS14027689` / `LNS14027662` (from 1992) | `LNU04027659` ... (same suffixes) |
| Total nonfarm payrolls (thousands) | `CES0000000001` | `CEU0000000001` |
| Total private / government / manufacturing payrolls | `CES0500000001` / `CES9000000001` / `CES3000000001` | |
| Average hourly earnings, all private employees | `CES0500000003` | |
| AHE, production and nonsupervisory | `CES0500000008` | |
| Real AHE (1982-84 dollars) | `CES0500000013` | |
| Average weekly hours, private | `CES0500000002` | |
| CPI-U all items (1982-84=100) | `CUSR0000SA0` | `CUUR0000SA0` |
| CPI-U less food and energy (core) | `CUSR0000SA0L1E` | `CUUR0000SA0L1E` |
| CPI-U food / energy / shelter / gasoline | | `CUUR0000SAF1` / `CUUR0000SA0E` / `CUUR0000SAH1` / `CUUR0000SETB01` |
| CPI-W, chained CPI-U (C-CPI-U is revised for 10 to 12 months: "Interim") | | `CWUR0000SA0`, `SUUR0000SA0` |
| CPI-U, Los Angeles area | | `CUURS49ASA0` |
| CPI-U, metro areas | | see the area table below |
| PPI final demand | `WPSFD4` | `WPUFD4` |
| Job openings (thousands) / rate | `JTS000000000000000JOL` / `JTS000000000000000JOR` | |
| Hires rate / quits rate | `JTS000000000000000HIR` / `JTS000000000000000QUR` | |
| State unemployment rate (California) | `LASST060000000000003` | `LAUST060000000000003` |
| ECI, total compensation, civilian: index / 12-month change | `CIS1010000000000I` | `CIU1010000000000A` |
| Nonfarm business labor productivity / unit labor costs | `PRS85006092` / `PRS85006112` | |
| Median usual weekly earnings, full-time (current / 1982-84 dollars) | `LES1252881500` / `LES1252881600` (the news release headline) | `LEU0252881500` / `LEU0252881600` |
| OEWS, all occupations, U.S., annual mean wage | | `OEUN000000000000000000004` (annual, latest year only) |

State codes in LA and SM IDs are FIPS codes (`06` California, `36` New York, `48` Texas ...). For other
states, change the two digits and confirm with `--describe`.

## 3. Finding an ID you do not know
1. Build it from the structure in §1 and confirm it with `fetch.py --source bls --describe <ID>`, or build it with `--build` (§4): a missing title means
   the ID does not exist (not for OEWS: data.bls.gov has no catalog page for OE IDs, so `--describe` decodes
   them from their layout and says so; a wrong OEWS ID shows up as a series with no data at fetch time).
2. Search tools for the user or the browser: https://data.bls.gov/dataQuery/find (keyword search),
   https://beta.bls.gov/dataQuery/search, the survey's "Databases, Tables & Calculators" page, or the
   series list behind each table in a BLS news release.
3. Never guess an ID from memory and download it without `--describe`; never report a number from a series
   whose title you have not read.

## 4. ID builders (`fetch.py --source bls --build ...`, or `"build"` in spec.json)
Code: `sources/bls/lib/series_ids.py`. Every
pattern below returned data from the API on 2026-10-20 for Maryland / Baltimore County / SOC 15-1252.

| Builder | Arguments | ID pattern | Example |
|---|---|---|---|
| `laus` (state) | `state` (MD, 24, Maryland), `measure`, `seasonal` S/U | `LA` + S/U + `ST` + FIPS + 11 zeros + measure | `LASST240000000000003` |
| `laus` (county) | `county` (5-digit FIPS), `measure` | `LAUCN` + FIPS + 8 zeros + measure (NSA only) | `LAUCN240050000000003` |
| `ces_state` | `state`, `industry` (8 digits), `datatype` (01 employment), `seasonal` | `SM` + S/U + FIPS + `00000` + industry + datatype | `SMS24000000000000001` |
| `state` | `state` | LAUS rate, employment, labor force (SA) + CES total nonfarm | 4 IDs |
| `oews` | `occupation` (SOC `15-1252`), `measure`, `state` (optional) | `OEU` + `N0000000` or `S`+FIPS+`00000` + `000000` + SOC + datatype | `OEUN000000000000015125213` |
| `jolts` | `industry` (code, name, comma list or `all`), `measure`, `rate` (default true), `seasonal` | `JT` + S/U + industry + `000000000` + element + `R`/`L` | `JTS720000000000000QUR` |

LAUS measures: `unemployment_rate` 03, `unemployment` 04, `employment` 05, `labor_force` 06. OEWS
measures: `employment` 01, `hourly_mean_wage` 03, `annual_mean_wage` 04, `hourly_median_wage` 08,
`annual_10th_percentile_wage` 11, `annual_median_wage` 13, `annual_90th_percentile_wage` 15.
JOLTS measures: `job_openings` JO, `hires` HI, `total_separations` TS, `quits` QU, `layoffs` LD,
`other_separations` OS. JOLTS industry codes (national; the irregular ones end in 099): 000000 total
nonfarm, 100000 total private, 110099 mining and logging, 230000 construction, 300000 manufacturing
(320000 durable, 340000 nondurable), 400000 trade, transportation and utilities (420000 wholesale, 440000
retail, 480099 transportation, warehousing and utilities), 510000 information, 510099 financial activities
(520000 finance and insurance, 530000 real estate), 540099 professional and business services, 600000
private education and health (610000 educational services, 620000 health care and social assistance),
700000 leisure and hospitality (710000 arts, 720000 accommodation and food), 810000 other services, 900000
government (910000 federal, 920000 state and local, 923000 state and local education, 929000 state and local
excluding education). All 28 quits-rate IDs were read back with `--describe` on 2026-10-21. OEWS is
annual (period `A01`) and the API returns only the latest survey year (2025 on 2026-10-20: SOC 15-1252
annual median wage $135,980 U.S., $138,680 Maryland); a request for the current year adds a "No Data
Available" message, not an error. County LAUS lags the state data by a month.

Common ID mix-ups (checked with `--describe` on 2026-10-20): U-6 is `LNS13327709`;
`LNS13023621` is "(Seas) Unemployment Level - Job Losers" (thousands). `WPUFD4` is PPI final demand (not
"finished goods"); `WPUFD49104` is final demand less foods and energy (not "finished consumer foods");
`CES6562000003` covers health care and social assistance. Prefix `EI` is not the Employment Cost
Index; `EI` is import/export prices and the ECI is `CI`.

## Union membership (CPS annual averages, `LU`)
`LUU0204899600` is the union membership rate (percent of employed wage and salary workers), United States;
the last two digits are the state FIPS code (`LUU0204899615` Hawaii, `LUU0204899646` South Dakota).
Annual only (period A01); BLS publishes no state standard errors, and 2025 values are 11-month averages
(October 2025 not collected). BLS's Union Members news release, Table 5, lists every state.

## Metro-area CPI-U (all items, NSA; IDs checked 2026-10-22)
Only New York, Chicago and Los Angeles are priced monthly; the others every other month (odd months: Jan,
Mar ...; even months: Feb, Apr ...), so "the latest" month differs by area and the off months come back
empty (`n_missing`/`absent_periods` count them). Compare 12-month changes at each area's own latest month
(`tsstats.yoy` matches by date) and say which month each is. BLS's news release Table 4 lists them all.

| Series | Area | Priced |
|---|---|---|
| `CUURS11ASA0` | Boston-Cambridge-Newton | odd |
| `CUURS12ASA0` | New York-Newark-Jersey City | monthly |
| `CUURS12BSA0` | Philadelphia-Camden-Wilmington | even |
| `CUURS23ASA0` | Chicago-Naperville-Elgin | monthly |
| `CUURS23BSA0` | Detroit-Warren-Dearborn | even |
| `CUURS24ASA0` | Minneapolis-St. Paul-Bloomington | odd |
| `CUURS24BSA0` | St. Louis | even |
| `CUURS35ASA0` | Washington-Arlington-Alexandria | odd |
| `CUURS35BSA0` | Miami-Fort Lauderdale-West Palm Beach | even |
| `CUURS35CSA0` | Atlanta-Sandy Springs-Roswell | even |
| `CUURS35DSA0` | Tampa-St. Petersburg-Clearwater | odd |
| `CUURS35ESA0` | Baltimore-Columbia-Towson | even |
| `CUURS37ASA0` | Dallas-Fort Worth-Arlington | odd |
| `CUURS37BSA0` | Houston-The Woodlands-Sugar Land | even |
| `CUURS48ASA0` | Phoenix-Mesa-Scottsdale | even |
| `CUURS48BSA0` | Denver-Aurora-Lakewood | odd |
| `CUURS49ASA0` | Los Angeles-Long Beach-Anaheim | monthly |
| `CUURS49BSA0` | San Francisco-Oakland-Hayward | even |
| `CUURS49CSA0` | Riverside-San Bernardino-Ontario | odd |
| `CUURS49DSA0` | Seattle-Tacoma-Bellevue | even |
| `CUURS49ESA0` | San Diego-Carlsbad | odd |
| `CUURS49FSA0` | Urban Hawaii | odd |
| `CUURS49GSA0` | Urban Alaska | even |
