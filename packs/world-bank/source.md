# World Bank Indicators API (World Development Indicators and other databases)
Depth: standard. Key: none. Annual (some quarterly/monthly) indicators for about 217 economies and 79
regional and income aggregates: GDP, population, prices, labor, health, education, trade, debt, climate.

## When to use
- International comparisons: the U.S. against peers (G7, OECD members `OED`, high income `HIC`, world
  `WLD`) on GDP per capita, growth, inflation, unemployment, life expectancy, health and education
  spending, R&D, debt, trade shares, CO2 per capita, internet use, migration.
- U.S. population or GDP for per-capita context in an international table.
- Not here: official U.S. national accounts (bea: quarterly, revised, more detail), U.S. prices and jobs
  (bls), U.S. federal debt (treasury), U.S. state or county data (census, bea). For U.S.-only questions
  prefer the U.S. agency source and say why if the World Bank figure is used.

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `indicator` | one row per country and period (and indicator) | `indicator` (code, alias or a list), `country` (ISO2/ISO3, `;`-joined, group alias, `all`), `date` (`2000:2024`), `mrv`, `mrnev`, `source` |
| `indicator_info` | name, unit, definition (`sourceNote`), source organization | `indicator` |
| `countries` | codes, region, income level, lending type | `region`, `incomelevel` |
| `source_indicators` | every indicator of a database | `source_id` (2 = WDI) |
| `topic_indicators` | indicators of a topic | `topic_id` (8 = Health, 3 = Economy and growth) |
| `sources`, `topics` | lists | none |

Catalog aliases (`--endpoints` lists all; `--search "words"` also searches the ~1,500 WDI indicators live):
`gdp` NY.GDP.MKTP.CD, `gdp_lcu` NY.GDP.MKTP.CN, `gdp_constant` NY.GDP.MKTP.KD, `gdp_growth`
NY.GDP.MKTP.KD.ZG, `gdp_per_capita` NY.GDP.PCAP.CD, `gdp_per_capita_ppp` NY.GDP.PCAP.PP.CD,
`exchange_rate` PA.NUS.FCRF, `population` SP.POP.TOTL, `life_expectancy` SP.DYN.LE00.IN,
`health_spending_gdp` SH.XPD.CHEX.GD.ZS, `health_spending_pc` SH.XPD.CHEX.PC.CD, `inflation`
FP.CPI.TOTL.ZG, `unemployment` SL.UEM.TOTL.ZS, `govt_debt` GC.DOD.TOTL.GD.ZS, `gini` SI.POV.GINI,
`rd_spending_gdp` GB.XPD.RSDV.GD.ZS, `co2_per_capita` EN.GHG.CO2.PC.CE.AR5, and more.
Country group aliases: `g7`, `g20_countries` (the 19 member countries, without the EU and AU), `brics`.

## Spec examples
```json
{"description": "GDP per capita, PPP, G7 countries, 2020-2023",
 "requests": [{"name": "g7_gdp_pc_ppp", "endpoint": "indicator",
   "params": {"indicator": "gdp_per_capita_ppp", "country": "g7", "date": "2020:2023"}}]}
```
```json
{"description": "Health spending share of GDP: US, OECD members, world, latest 5 values",
 "requests": [{"name": "health_gdp", "endpoint": "indicator",
   "params": {"indicator": "SH.XPD.CHEX.GD.ZS", "country": ["US", "OED", "WLD"], "mrnev": 5}},
  {"name": "health_gdp_def", "endpoint": "indicator_info", "params": {"indicator": "SH.XPD.CHEX.GD.ZS"}}]}
```
```json
{"description": "Population of every economy and aggregate, 2023",
 "requests": [{"name": "pop_2023", "endpoint": "indicator",
   "params": {"indicator": "population", "country": "all", "date": "2023"}}]}
```

## Data format and traps
- Columns: `indicator.id`, `indicator.value` (name), `country.id` (ISO2, or an internal code for
  aggregates), `country.value`, `countryiso3code`, `date` (the period, text), `value`, `unit`,
  `obs_status`, `decimal`, plus `is_aggregate` (Y/N, added by the pack). Values are numbers as
  published; a period with no value is an empty cell (the API sends null). Rows come newest first.
- Units are in the indicator name: "current US$" (converted at market exchange rates, so it moves with the
  dollar), "constant 2015 US$" (real), "PPP (current international $)" (use for living-standard level
  comparisons), "LCU" (local currency), "%" or "% of GDP". Never mix them in one comparison.
- National accounts are calendar-year for most countries, but some report fiscal years (e.g. India,
  Pakistan, Egypt); WDI states this in the country notes. U.S. federal fiscal years (Oct-Sep) are a
  different basis: convert with `combine.to_fiscal` before joining with treasury or usaspending data.
- Local-currency series (`..CN`, `..KN`) are not comparable across countries; convert with
  PA.NUS.FCRF or use the US$ or PPP series. Euro-area histories are in euros back-converted.
- `country=all` returns countries and the 79 aggregates (World, regions, income groups, IDA/IBRD,
  "Not classified" INX). Filter `is_aggregate == "N"` before summing or ranking countries.
- The latest year is missing for many countries (WDI lags 1-2 years; Gini and poverty only in survey
  years). Use `mrnev` (most recent non-empty values) or report the year per country.
- WDI is revised several times a year (the `lastupdated` date is in raw/). Older vintages differ.
- Archived codes: the API answers HTTP 200 with "The indicator was not found. It may have been deleted
  or archived." The pack turns that into an error. EN.ATM.CO2E.PC (cited in many tools) is archived:
  use EN.GHG.CO2.PC.CE.AR5 (CO2 excluding LULUCF, t CO2e per person; a different definition).
- An unknown country code (even one among several) makes the API answer HTTP 200 with a message (id 120,
  "Invalid value") instead of data; the pack reports it as an error. Check the codes with `countries`.
- Paging is `page`/`per_page` (the pack uses 1,000 per page); `total` is in the first element.
- Several countries: ISO codes joined with `;` (the pack accepts a list or a group alias).
- Several indicators: give `indicator` as a list (codes or aliases). The pack sends them `;`-joined in
  one call; the API accepts that only with a source database id, so the pack adds `source=2` (WDI)
  unless the spec sets `source`. Every listed indicator must be in that database. Rows carry
  `indicator.id`: never mix units of different indicators in one sum or ranking.

## Access
No key, no published rate limit (the pack sends at most 3 requests a second). Route `api` when
api.worldbank.org answers. Manual route: `manual_download/INSTRUCTIONS.md` has one JSON link per page
(open in a browser, save under the name shown, upload, then `--ingest`). Without the bundle:
https://data.worldbank.org/indicator/<CODE>?locations=US-GB-DE, Download > CSV, unzip and upload the
`API_<CODE>_DS2_*.csv` file (wide: one column per year; say so when ingesting).

## Citation and terms
"World Bank, <indicator name> (<code>), World Development Indicators, World Bank Indicators API, retrieved
<date>." Licensed CC BY 4.0 (World Bank Terms of Use for Datasets,
https://www.worldbank.org/ext/en/legal/terms-conditions/datasets): redistribution allowed with
attribution; the report carries the licence notice. Some indicators come from third parties (IMF, ILO,
WHO, UNESCO): name the `sourceOrganization` from `indicator_info` when it matters.
