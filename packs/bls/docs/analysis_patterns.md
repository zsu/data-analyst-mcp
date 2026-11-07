# Analysis patterns for BLS time series

Read this once at the start of any analysis. It lists the choices that change headline numbers (and
so become the critical questions), BLS's own conventions to follow, and how a BLS data product is
laid out.

Contents: 1. Critical questions catalog · 2. Conventions · 3. Benchmarks and reliability ·
4. Typical questions · 5. Publication structure · 6. Chart forms

## 1. Critical questions catalog
Ask only the ones the request leaves open **and** that would change a headline number. Each has a
default rule for "Don't know — decide empirically".

| Choice | Typical options | Default rule when the user does not know |
|---|---|---|
| **Which measure** | Unemployment: U-3 (official) vs. U-6. Wages: average hourly earnings (CES, all employees or production and nonsupervisory), median weekly earnings (CPS, full-time), ECI (fixed job mix). Inflation: CPI-U, CPI-W, C-CPI-U; headline vs. core. Jobs: payroll (CES) vs. household (CPS) employment | Use the measure BLS leads with in its news release (U-3, CES payrolls, CPI-U headline). For wages, show AHE and say that composition shifts move it (2020); add ECI when the period includes large composition changes |
| **Seasonal adjustment** | SA vs. NSA | Month-to-month or short-run changes, levels in charts: SA. 12-month changes of the CPI: NSA (BLS's headline 12-month CPI change uses NSA indexes). Import/export price indexes have no SA version: NSA throughout. Annual averages: NSA (BLS computes them from NSA data) |
| **Frequency** | Monthly, quarterly, annual averages | Monthly for spans up to about 10 years; annual averages for long histories. Use BLS-published annual averages (v2 key) over computed ones |
| **Period and baseline** | Since a date (Feb 2020 pre-pandemic peak, Jan 2021, 10 years), calendar years, a recession | The business-cycle peak before the event the user cares about (Feb 2020 for the pandemic); otherwise the latest 10 years. Show a sensitivity with one alternative baseline (2019 average) |
| **Nominal vs. real** | Current dollars vs. constant dollars; deflator CPI-U, CPI-W, C-CPI-U (PCE is BEA, not BLS) | Real, deflated as BLS does it: CPI-W for production and nonsupervisory employees, CPI-U for all employees and other groups (all items, NSA for annual, SA for monthly), base = latest full year; say "in <year> dollars". CPI-U-RS is not in the API |
| **Change measure** | Net change, percent change, 12-month change, annualized 3- or 6-month rate, CAGR | Follow the series' BLS convention: payrolls as net change (thousands); rates as percentage-point change; prices and wages as 12-month percent change, plus annualized 3-month for momentum |
| **Geography** | U.S., state (LAUS, CES state), metro, county | As asked. State unemployment: LAUS SA. Note that LAUS and state CES are model-based and revised each March |
| **Gaps and preliminary data** | Interpolate a missing month or leave it; include preliminary months | Leave gaps empty; compute changes only between published values (say so); include preliminary values but label them |
| **Comparison groups** | Demographic groups (CPS), industries (CES), areas | As asked; flag thin CPS groups (small groups have wide confidence intervals; use 12-month averages or annual averages) |

Ask at most four, in one round. A question about which series ID to use is never put to the user:
resolve it yourself with `--describe` and the tables in `series_ids.md`.

## 2. Conventions
- **Definitions:** unemployment rate = unemployed ÷ labor force; participation rate = labor force ÷
  civilian noninstitutional population; employment-population ratio = employed ÷ population. CES counts
  jobs (a person with two jobs counts twice); CPS counts people.
- **Units:** CES and CPS levels are in thousands. JOLTS levels are in thousands; rates are percentages.
  CPI is an index (1982-84=100); never report an index level as a price.
- **Percent changes of indexes:** compute from the published index values (rounded to three decimals) and
  round the result to one decimal; that reproduces BLS's published CPI changes.
- **Social Security COLA** (SSA's rule, not a BLS series): the CPI-W, not seasonally adjusted (`CWUR0000SA0`),
  averaged over July-September and rounded to three decimals, compared with the same average of the last
  year a COLA was paid; the percent increase rounded to one decimal is the COLA payable from the next
  January. SSA announces it with the September CPI (mid-October); benchmark against SSA's announcement.
- **12-month change across a gap:** October 2026 vs. October 2025 has no value when October 2025 was not
  collected. Say so; do not substitute September or an interpolated value.
- **Revisions:** CES revises the two prior months each release and benchmarks every February (back to the
  previous March); seasonal factors for CPI are revised each February for five years; LAUS is revised each
  March; C-CPI-U is final 10 to 12 months later. State the retrieval date (the builder adds it).
- **January population controls (CPS):** levels shift in January; compare levels across Januaries only with
  a note, or use rates.
- **Annual averages:** BLS's M13 values are preferred. A computed average needs all 12 months; a year with a
  gap has no computed average (`tsstats.annual_average` returns NaN).
- **Recessions (NBER):** March–November 2001, December 2007–June 2009, February–April 2020. Use the note
  "Recessions begin just after a peak in economic activity and run through the subsequent trough."
- **Correlation, not cause:** a policy or event "coincided with" a change unless a method that supports a
  causal claim was used.

## 3. Benchmarks and reliability
- **Benchmark every headline number** against a BLS publication: the latest news release (Employment
  Situation, CPI, JOLTS, Employment Cost Index, Productivity and Costs, State Employment and Unemployment),
  or the API's own `calculations` (fetch with a key and `"calculations": true`; they arrive as
  `bls_pct_12m`, `bls_net_1m` ... columns). Record the comparison in Data and Methods.
- **Statistical significance:** BLS tests at the 90-percent level. Published thresholds (read the current
  technical note before using, they are updated; values below are from 2026-10-19):
  - CES total nonfarm monthly change: about ±122,000 (Employment Situation technical note).
  - CPS monthly change in unemployment: about ±425,000; in the unemployment rate: about ±0.3 percentage point.
  - JOLTS: median standard errors in the "significant change" tables on the JOLTS page.
  - CPI: standard errors of 1-, 2-, 6- and 12-month changes on the CPI variance estimates page.
  `tsstats.significant(change, "ces_total_nonfarm_monthly_change")`. Call a change "statistically significant"
  only when it exceeds the threshold; otherwise "little changed" (BLS's own phrase) or "about the same".
- Sampling error does not apply to QCEW (a census of UI records), but revisions do.

## 4. Typical questions
- **Labor market since the pandemic:** unemployment (U-3, U-6), participation and prime-age employment rate,
  payrolls vs. February 2020, job openings and quits. Benchmark: the latest Employment Situation and JOLTS.
- **Inflation:** 12-month CPI-U change (NSA), core vs. headline, contributions of food, energy, shelter;
  3-month annualized core for momentum. Benchmark: CPI news release table A.
- **Real wages:** BLS's own real AHE: `CES0500000013` all employees (CPI-U), `CES0500000032` production and
  nonsupervisory employees (CPI-W, `CWSR0000SA0`), as the Real Earnings release reports them; real median weekly
  earnings, `LES1252881600` seasonally adjusted, as the Usual Weekly Earnings release headlines it); ECI vs. CPI over 12 months.
- **States and metros:** LAUS unemployment rates ranked, change over a year; state payrolls (SM).
- **Industries:** CES employment by supersector, net change since a baseline; JOLTS by industry.
- **Productivity and labor costs:** quarterly annualized rates; long-run averages by business cycle.

## 5. Publication structure (the report builder's `"mode": "report"`)
Same exhibit chartbook as the style guide describes:
1. Cover with the month and year, the title with the period, and an optional hero chart.
2. **At a Glance:** one framing paragraph (which measures, which period) and 3–5 findings, each with a bold
   lead naming its section.
3. Contents and List of Exhibits (built automatically).
4. **Notes About This Report:** calendar years; rounding; seasonal adjustment; dollar year and deflator;
   data source and retrieval date; definitions; preliminary values and gaps; recession shading.
5. **Introduction:** a lead paragraph with the headline numbers; question-style subsections ("How Has
   Unemployment Changed Since 2019?") and "What Data Were Used?".
6. **Sections** (2–5): a summary page, then one exhibit per page with 2–4 paragraphs beside the chart
   (level, change, comparison).
7. **Appendix A: Data and Methods:** series IDs and titles, seasonal adjustment, definitions, computations
   (change measures, deflation, annual averages), benchmark comparisons, significance thresholds,
   limitations. The builder appends the data vintage and the BLS terms statement.
8. References; About This Document (optional); replication materials and audit trail.

Exhibit titles end with the period: "Unemployment Rate, January 2019 to September 2026". The units line
names the adjustment: "Percent, seasonally adjusted". Source line: "Analyst calculations using data from the
Bureau of Labor Statistics, Current Population Survey (series LNS14000000)."

## 6. Chart forms
- Trends: line charts, at most 4–5 series; facet rather than crowd. Monthly x-axis labels "Sep 2026"
  (`tsstats.to_exhibit`).
- Changes by group at one date: horizontal bars when labels are long (industries, states), columns otherwise.
- Composition (contributions to CPI change, payroll gains by industry): stacked columns.
- Index comparisons (wages vs. prices): rebase both to 100 at the same date (`tsstats.rebase`).
- No dual axes, no pies, no 3-D. Do not draw a line through a gap: leave the cell empty in the exhibit CSV.
