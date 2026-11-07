# Analysis patterns for FRED data (budget and economic analysis)

Read this once at the start of any analysis. It lists the choices that change headline numbers (and so
become the critical questions), the conventions to follow (those of the institution the question comes from, else the source agency's), how to benchmark, and
how a report is laid out.

Contents: 1. Critical questions catalog · 2. Conventions · 3. Benchmarks and checks · 4. Typical questions
· 5. Publication structure · 6. Chart forms

## 1. Critical questions catalog
Ask only the ones the request leaves open **and** that would change a headline number. Each has a default
rule for "Don't know — decide empirically" (show the main alternative as a sensitivity test).

| Choice | Typical options | Default rule when the user does not know |
|---|---|---|
| **Which measure** | Inflation: PCE vs. CPI-U vs. CPI-W vs. C-CPI-U; headline vs. core. Output: real GDP, GDP per capita, GDI. Debt: held by the public vs. total public debt. Interest: budget net interest (FYOINT) vs. NIPA interest payments | The measure the question's institution uses (for example, the Federal Reserve and the budget agencies lead with PCE for inflation and debt **held by the public**); indexing questions use the index the law names (CPI-W for Social Security COLAs, C-CPI-U for tax brackets, CPI-U for most other programs); budget questions use budget-basis series (OMB/Treasury), not NIPA |
| **Calendar or fiscal year** | Calendar year; federal fiscal year (October to September) | Budget amounts (outlays, revenues, deficits, debt, interest): fiscal years, and a share of GDP uses fiscal-year GDP (the average of the four quarters October to September). Economic variables: calendar years, unless they feed a fiscal-year ratio |
| **Nominal or real; deflator; base year** | Current dollars; real via PCE, CPI-U, GDP deflator; base = latest full year or a chosen year | Budget amounts: nominal, plus shares of GDP (the usual convention for comparisons over time). Incomes and wages: real, deflated by PCE or CPI-U when the user's context is CPI-based; base = latest full year; say "in <year> dollars" |
| **Growth measure** | Quarterly annualized; year over year; fourth quarter to fourth quarter; annual average over annual average; CAGR between dates | The publishing agency's convention: BEA's annual growth of GDP is **annual average over annual average** (its headline "real GDP increased 2.8 percent in 2024"); **Q4 over Q4** when comparing with Federal Reserve or CBO projections, which use it; annual average for levels such as unemployment and interest rates; quarterly annualized for the latest quarter (BEA's headline). Name the measure every time |
| **Frequency conversion** | Average, end of period, sum | Rates and prices: average. Stocks (debt, balances): end of period. Flows reported per period (monthly outlays): sum. Never let FRED convert silently: use `tsstats.to_frequency`, which refuses incomplete periods |
| **Vintage** | Latest data; as published on a date (ALFRED); first release; full revision history | Latest, unless the question is about what was known at a time (a baseline's starting point, a forecast evaluation, "as first reported"): then the vintage dated just before that time, and say so. Revision questions compare first release with latest |
| **Seasonal adjustment** | SA vs. NSA | Short-run changes and charts: SA. 12-month changes of CPI and annual averages: NSA (BLS convention). Fiscal-year sums: NSA source data summed over complete years |
| **Period and baseline** | A business-cycle peak (2019 Q4, Feb 2020), a policy date, the last 10 or 20 years | The business-cycle peak before the event the user cares about; otherwise the latest 10 complete years (20 for budget ratios). Show one alternative baseline as a sensitivity |
| **Projections** | Include CBO's projected potential output or NROU beyond the last actual date, or stop at the last actual | Stop at the last actual date for every comparison with data. Use projections only when the user asks about them, labeled as CBO's projections and with the vintage of the outlook |

Ask at most four, in one round. Series IDs are never a question for the user: resolve them with
`docs/series.md`, `--search` and `--describe`.

## 2. Conventions
- **Shares of GDP:** numerator and denominator on the same basis and period. Fiscal-year budget amounts over
  fiscal-year GDP; mind the units (FYOINT in millions, GDP in billions: `tsstats.share_of(..., scale=1000)`).
  Benchmark against FRED's own ratio where one exists (FYOIGDA188S, FYFSGDA188S, FYGFGDQ188S), but know how it is
  built: FRED's annual budget ratios divide the fiscal-year amount by **calendar-year** GDP (GDPA) as published
  when the ratio was last updated (FY2025 interest: 970,065 / about 30,762, GDPA as published in April 2026, = 3.15
  percent; current GDPA is higher after BEA's September 2026 revision; on fiscal-year GDP it is 3.18 percent;
  checked 2026-10-20). CBO and OMB use fiscal-year GDP. So a ratio on fiscal-year GDP differs from
  FRED's annual ratios by a few hundredths of a point; a larger gap means a units or fiscal-year error.
  FYGFGDQ188S is different: quarterly debt over that quarter's annualized GDP, so its Q3 value differs from
  debt over fiscal-year GDP by about 0.5 to 1.5 points (FY2019: 77.5 against 79.0). Never present FRED's
  ratio as a fiscal-year-GDP ratio. `FYGDP` is OMB's fiscal-year GDP (from its latest budget; it lags BEA's
  revisions); averaging the four quarters of `GDP` gives the current-vintage equivalent.
- **Annualized rates:** quarterly GDP growth is reported at an annual rate: `(Q_t/Q_{t-1})^4 - 1`
  (`tsstats.annualized`). GDP levels are already at an annual rate (SAAR): do not multiply by four; a fiscal-year
  GDP is the mean of four quarterly SAAR values, not their sum.
- **Real values:** chained-dollar components do not add up to their totals; do not sum chained-dollar series.
  Compute shares in nominal terms.
- **Indexes:** an index level is not a price. Percent changes of indexes from the published values, rounded to one
  decimal at the end.
- **Fiscal years:** FY2025 = October 1, 2024, to September 30, 2025. `tsstats.fiscal_year_of`,
  `tsstats.fiscal_year_label` (FRED dates fiscal-year dollar series on Sep 30 and some ratios on Jan 1).
- **Gaps:** October 2025 was not collected for the CPI, CPS and LAUS (lapse in appropriations); daily market
  series skip holidays. Changes and averages across a gap need both endpoints or a complete period.
- **Levels across vintages:** a comprehensive revision changes the reference year of chained-dollar series (real
  GDP: chained 2012 dollars in vintages before September 2023, 2017 dollars after) and can redefine nominal
  levels. Compare growth rates, shares and ratios across vintages, and say which base year each vintage uses.
- **Revisions:** BEA revises GDP in each later estimate and in annual and comprehensive updates; CBO's potential
  output is re-estimated with each outlook; BLS revises payrolls and seasonal factors. State the retrieval date
  (the builder adds it), and use ALFRED vintages when the timing matters.
- **CBO projections in FRED** (GDPPOT, NGDPPOT, NROU) reflect the outlook named on the series page
  (last_updated). After a BEA comprehensive revision, an output gap that mixes the new GDP with potential built on
  the old GDP can shift; say so when `last_updated` of the two differs by more than a few months.
- **Recessions:** shade from USREC (downloaded, never from memory) and the builder adds the note.
- **Correlation, not cause:** an event "coincided with" a change unless a method that supports a causal claim was
  used. No forecasts of your own; CBO's or the Federal Reserve's projections are cited as theirs.

## 3. Benchmarks and checks
- **Benchmark every headline number** against a published figure, and save each comparison in
  `exhibits/benchmark.csv` (measure, period, computed, published, source, URL, accessed date):
  - FRED's own derived series: A191RL1Q225SBEA (real GDP growth), FYOIGDA188S / FYFSGDA188S / FYGFGDQ188S
    (budget ratios), the `pc1` transform of a price index (download it as a second variant).
  - The source's release: BEA's GDP release, BLS's CPI release, OMB's Historical Tables, the Treasury's Monthly
    Treasury Statement, CBO's Monthly Budget Review or The Budget and Economic Outlook (cbo.gov, read through
    the browser or the Wayback Machine when scripts are blocked).
  Say "matches" only for rows in that file; a source not opened is "not checked".
- **Sanity checks before writing:** units (millions vs. billions), dates (fiscal-year end vs. start), the last
  date of each series (a lagging annual series silently shortens a ratio), projections cut off, no FRED-side
  conversion across a gap.
- **Sampling error:** most FRED macro series are not survey estimates with published standard errors; do not
  call differences "statistically significant". For survey-based series (unemployment), see the bls pack's
  thresholds or say "little changed" for small moves.

## 4. Typical questions
- **Output gap and potential growth** (GDPC1, GDPPOT, NROU vs. UNRATE): gap by quarter, versus 2019 Q4;
  potential growth Q4/Q4; the unemployment gap.
- **Inflation for indexing or deflating a cost estimate** (CPI-W, CPI-U, C-CPI-U, PCE): Q3-average CPI-W growth
  for COLAs, calendar- or fiscal-year averages, cumulative growth between two dates.
- **Federal interest costs** (FYOINT, FYOIGDA188S, GS10, TB3MS, FYGFDPUN): net interest as a share of GDP by
  fiscal year, the average rate on debt (interest over average debt held by the public), versus market yields.
- **Deficits and debt** (FYFSD, FYFR, FYONET, FYGFGDQ188S): shares of GDP, past averages (50-year average),
  peaks.
- **Revisions and real-time data** (ALFRED): GDP growth as first reported vs. current, the data a past baseline
  used.
- **State comparisons** (GeoFRED or `<ST>UR`, `<ST>PCPI`): rank states, change over a year.

## 5. Publication structure (the report builder's `"mode": "report"`)
1. Cover with the month and year, the title with the period, and an optional hero chart.
2. **At a Glance:** one framing paragraph (which measures, which period, calendar or fiscal years) and 3–5
   findings, each with a bold lead naming its section.
3. Contents and List of Exhibits (built automatically).
4. **Notes About This Report:** calendar or fiscal years; rounding; seasonal adjustment and annual rates; dollar
   year and deflator; data source, retrieval date and vintage; projections; definitions; recession shading.
5. **Introduction:** a lead paragraph with the headline numbers; question-style subsections ("How Large Is the
   Output Gap?") and "What Data Were Used?".
6. **Sections** (2–5): a summary page, then one exhibit per page with 2–4 paragraphs beside the chart (level,
   change, comparison).
7. **Appendix A: Data and Methods:** series IDs and sources, units and conversions, fiscal-year construction,
   deflators, vintages, benchmark comparisons, limitations. The builder appends the data vintage, the series
   citations and the FRED notice.
8. References; About This Document (optional); replication materials and audit trail.

Exhibit titles end with the period: "Output Gap, 2007 Q1 to 2026 Q2"; "Net Interest Outlays as a Percentage of
GDP, Fiscal Years 2000 to 2025". The units line names the basis: "Percent of GDP"; "Billions of chained 2017
dollars, seasonally adjusted annual rate".

## 6. Chart forms
- Trends: line charts with a real date axis (the exhibit CSV keeps the `date` column; `tsstats.to_exhibit`
  writes it) and recession shading (`"recessions": true`); at most 4–5 series.
- Fiscal-year amounts: columns for a few years, a line for long histories; label years by number and say "fiscal
  years" in the title.
- Comparisons at one date (states, components): horizontal bars when labels are long.
- Composition (contributions to growth, outlays by category): stacked columns.
- Indexes compared over time: rebase to 100 at the same date (`tsstats.rebase`).
- No dual axes (put the second measure in its own exhibit), no pies, no 3-D. Leave gaps empty in the exhibit CSV
  so the line breaks there.
