# Census time series: economic indicators, trade, government finances, Household Pulse, HVS

From the census playbook's "Data format and traps" section: read it before a request of this kind.

- Time series (`timeseries/...`): give `time` (`2026`, `2026-08`, `2026-Q2`, or `from 2024-01 to 2026-08`).
  Economic indicators (eits) return one row per code combination: `category_code` (industry or tax type),
  `data_type_code` (level, percent change, ...), `seasonally_adj` (yes/no), `time_slot_id`, `error_data` (yes =
  the row is a margin or standard error, not an estimate). The codes are not in the API's metadata: run one
  narrow query and read the codes that come back, or the program's definitions page (census.gov/econ/currentdata),
  then filter on them; never sum across data types or adjustment flags. Monthly indicators are revised (advance,
  preliminary, revised): say which release. Units: retail and construction $ millions, housing units in
  thousands, QTAX `CELL_VALUE` $ millions (variables.json labels say so); government finances `AMOUNT` $ thousands
  with a coefficient of variation `AMOUNT_CV` (percent, sample-based local figures). Government finance years are
  each government's fiscal year, not the calendar year. International trade: values in dollars; `GEN_VAL_MO`
  general imports vs `CON_VAL_MO` imports for consumption; `CAL_DUT_MO` is the duty calculated on imports for
  consumption (an estimate of duty owed, not Treasury's customs receipts); `COMM_LVL` HS2/HS4/HS6/HS10 must be
  fixed or totals double-count; `CTY_CODE` country codes (5700 China, 2010 Mexico, 1220 Canada); it takes no
  for= geography; `SUMMARY_LVL` CGP rows are country groups, not countries (drop them before summing).
- Household Pulse (`pulse`, `pulse_covid`) is an experimental data product: an online survey of adults 18+ in
  housing units, contacted by e-mail and text, with weighted response rates of 4.7 to 7.3 percent at the end
  (7.3 percent in week 63, October 2023; 4.7 percent in Phase 4.2 cycle 09, September 2024; each period's Source
  and Accuracy statement, census.gov/programs-surveys/household-pulse-survey/technical-documentation.html). Say so
  with every figure. `pulse` (timeseries/hhpulse) is long: one row per `MEASURE_NAME` (13 measures: EXPENSE,
  FOODSCARCE, ENERGYBILL, EVICTFOR, PRICEINCR, PRICEWORRY, LONELY, ...), `CYCLE` and geography; filter
  `MEASURE_NAME` and `CYCLE`. It holds `time=2024` only (Phase 4.0 cycles 01-03, 4.1 04-07, 4.2 08-09, January 9 to
  September 16, 2024); `time=2025` returns no rows. `pulse_covid` (timeseries/hps) is wide: `<M>_RATE`,
  `<M>_RT_MOE`, `<M>_TOTAL`, `<M>_MOE`, `<M>_UNIV` per collection `WEEK` (01-63, April 2020 to October 2023; from
  Phase 2 a "week" is a two-week collection period). Questions came and went, so a measure is empty in weeks
  that did not ask it (EXPENSE is empty in weeks 01-12, first asked in week 13, August 2020). The survey ended on 2024-09-16 and continued from 2025 inside HTOPS,
  whose tables are not on the API.
  `RATE` is the percent of `UNIVERSE` (`TOTAL` / `UNIVERSE`; EXPENSE, 2024 cycle 09: 87,697,083 / 236,337,862 =
  37.1), not of `UNITS_TOTAL` (all adults). Report `RATE_MOE` (`<M>_RT_MOE`) with every rate; Census uses
  90 percent confidence intervals for Pulse, but the API does not state the level of its margins. State margins
  are several times the national one (cycle 09 EXPENSE: Maryland 34.3 +/- 3.4, nation 37.1 +/- 0.7): test a
  difference against both margins before calling it one. Do not splice `pulse_covid` and `pulse` into one series
  or compare across phases without saying the question set and contact frame changed (Phase 4.2 added prepaid
  wireless numbers, "potentially impacting comparability with previous cycles", Phase 4.2 User Notes).
- HVS (`eits_homeownership`, timeseries/eits/hv) is quarterly (`time=2025-Q3`), from the CPS: `category_code`
  RATE has `data_type_code` HOR (homeownership rate, not seasonally adjusted), SAHOR (seasonally adjusted,
  `seasonally_adj` yes), RVR (rental vacancy rate), HVR (homeowner vacancy rate), and E_HOR, E_RVR, E_HVR
  (`error_data` yes: the 90 percent margin of error in percentage points, e.g. 0.5 for HOR); category ESTIMATE
  holds the housing inventory in thousands (TOTAL, OCC, OWNOCC, RNTOCC, VACANT, RENT, SALE, SEASON, ...). Never
  mix HOR and SAHOR in one series. The API has the nation only; the release's Table 4 is the benchmark (2025
  HOR 65.1, 65.0, 65.3, 65.7 matched the API on 2026-11-03). Fourth quarter 2025 rests on November and December
  only: October 2025 was not collected during the lapse in federal funding (release footnote); say so when it
  is used.

## Spec examples
```json
{"description": "Retail sales, 2026 to date; customs duty on imports from China, August 2026, by HS chapter",
 "requests": [{"name": "retail_2026", "endpoint": "query",
   "params": {"dataset": "eits_retail", "get": "cell_value,data_type_code,category_code,seasonally_adj,time_slot_id,error_data",
              "for": "us:*", "time": "2026"}},
  {"name": "china_duty_2026_08", "endpoint": "query",
   "params": {"dataset": "trade_imports_hs", "get": "CTY_NAME,I_COMMODITY,GEN_VAL_MO,CON_VAL_MO,DUT_VAL_MO,CAL_DUT_MO",
              "CTY_CODE": "5700", "COMM_LVL": "HS2", "time": "2026-08"}}]}
```
```json
{"description": "State and local government finances by state, 2024",
 "requests": [{"name": "govfin_2024", "endpoint": "query",
   "params": {"dataset": "govs_finances", "get": "AGG_DESC,GOVTYPE,AMOUNT,AMOUNT_CV", "for": "state:*", "time": "2024"}}]}
```
```json
{"description": "Adults with difficulty paying usual household expenses, nation, every 2024 Pulse cycle; homeownership rate 2025",
 "requests": [{"name": "pulse_expense_2024", "endpoint": "query",
   "params": {"dataset": "pulse", "get": "MEASURE_NAME,MEASURE_LABEL,RATE,RATE_MOE,TOTAL,UNIVERSE,CYCLE,PHASE,COL_START_DATE,COL_END_DATE",
              "for": "us:*", "time": "2024", "MEASURE_NAME": "EXPENSE"}},
  {"name": "homeownership_2025", "endpoint": "query",
   "params": {"dataset": "eits_homeownership", "get": "cell_value,data_type_code,category_code,seasonally_adj,time_slot_id,geo_level_code,error_data",
              "for": "us:*", "time": "2025", "category_code": "RATE"}}]}
```
