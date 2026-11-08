# compute: steps, expressions and survey standard errors

`compute` runs declarative steps over full workspace tables (`data/<id>/<table>.csv` or `.parquet`, earlier
exhibits, `published/*.csv`) and saves `exhibits/<name>.csv` with its lineage, so the rerun gate can replay it.

## Steps
Each step is an object with one verb:
- `{filter: expr}`, `{derive: {col: expr, ...}}` (a later name may use an earlier one in the same step),
  `{select: [cols]}`, `{rename: {old: new}}`.
- `{groupby: [keys], rollup: {col: aggregate expr}}`. `groupby` also goes with `derive` or `filter`: per-group
  windows and shares.
- `{join: alias, on: [keys] | {left: right}, how: inner|left, suffix?: ["_x", "_y"]}`.
- `{pivot_wider: {names_from, values_from, id_cols?, fill?}}`, `{pivot_longer: {cols, names_to, values_to}}`.
- `{orderby: [col, "-col" for descending]}`, `{slice: n | [start, end]}`, `{dedupe: true | [cols]}`,
  `{concat: [aliases]}`.
- `{as: name}` keeps the current table under a name; `{from: name}` switches to a table.
- Combine helpers:
  - `{fiscal_year: {date, as?}}`.
  - `{to_fiscal: {date, value, how: sum|mean|last, freq: M|Q}}` adds `periods` and `complete`; incomplete years
    are flagged, never full.
  - `{state_codes: col}` adds `state_usps`, `state_fips`, `state_name`.
  - `{deflate: {value, period, index: alias, index_period?, index_value, name: "CPI-U, BLS CUUR0000SA0", base?: "2024", as?}}`.
  - `{align_check: {tables: [aliases or "this"], on: [keys], units: {alias: "billions of dollars, nominal, fiscal years"}}}`
    refuses repeated keys, missing units and no overlap. Run it before a join of two sources.

## Expressions
Column names (`col("a b")` for odd names), numbers, `"text"`, `true`/`false`/`null`, `+ - * / % **`,
`== != < <= > >=`, `&& || !` (and/or/not), `c ? a : b`. Nothing else runs: no property access, no other calls.
CSV cells that are plain numbers are numbers; `"1,234"` stays text until `number()`; an empty cell is null (a
gap). Parquet cells are typed the same way. The functions, aggregates and windows are listed at the end.

## Big inputs
Read only the columns needed: `{alias: {path, columns: [...]}}`. compute also reads only the columns a recipe
names when it can tell them from the steps. A file over the cell cap is refused: name its columns, or use the
Parquet file when the fetch wrote one.

## Survey standard errors (replicate weights)
`{groupby?: [keys], replicate_se: {estimates: {rate: "sum(PWGTP * (HICOV == 2)) / sum(PWGTP)"}, weight: "PWGTP",
replicates: "PWGTP1:PWGTP80" | [cols], method: sdr|fay|jk1|brr|custom, rho? (fay), scale? (custom),
also?: {n: "count()"}, confidence?: 90|95|99}}`

It recomputes each weighted estimate with every replicate weight in place of the weight, and adds `<name>_se`
and `<name>_moe` (90 percent by default, as Census publishes).
- SE = sqrt(c × Σ_r (estimate_r − estimate)²).
- c = 4/R for sdr (ACS PUMS 4/80, CPS ASEC 4/160); 1/(R(1−rho)²) for fay; (R−1)/R for jk1; 1/R for brr.
  Use the method the pack's notes name.
- An SE of a difference or ratio needs it as one estimate, e.g.
  `"sum(W*(YEAR==2024)*X)/sum(W*(YEAR==2024)) - sum(W*(YEAR==2023)*X)/sum(W*(YEAR==2023))"`.

`{replicate_se: {estimate: col, replicates, method, as?}}` instead reads a table that already holds replicate
estimates (one row per estimate) and adds `<as>_se` and `<as>_moe` to each row.
