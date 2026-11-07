# Analysis and report patterns for federal fiscal data

Use this file to frame the analysis, choose the critical questions, and shape the product. The aim is
work a careful budget analyst would recognize: the right measure (stock or flow, gross or net), the
right period (fiscal or calendar year, complete or partial), stated units and dollar basis, numbers that
tie to the published statement, and limitations stated plainly.

## Typical questions and how they are framed

- **Debt level and growth:** "How much has the debt grown since 2015?" Measures: total public debt
  outstanding and debt held by the public (Debt to the Penny) at fiscal-year ends; growth in dollars, in
  percent and per year (CAGR). Benchmark: the September Monthly Statement of the Public Debt.
- **Deficits:** "What was the deficit in FY2025, and how does it compare?" Measures: receipts, outlays and
  the deficit for the fiscal year (MTS Table 1 Year-to-Date, or Table 9 totals), and against the prior
  year. Often as a share of GDP. Benchmark: Treasury's final MTS for September, and CBO's Monthly Budget Review.
- **Fiscal year to date:** "How is FY2026 going so far?" Compare the same months of the prior year (October
  through the latest month), never a partial year with a full year.
- **Composition:** "Where does the money come from and go?" Receipts by source and outlays by function (MTS
  Table 9): levels, shares of the total and changes.
- **Interest costs:** "How fast is interest on the debt rising?" Measures: net interest outlays (MTS Table 9,
  the budget measure) or gross interest expense (`interest_expense`), the average interest rate on
  interest-bearing debt, and interest as a share of outlays or receipts. Decompose growth into the debt-level
  effect and the rate effect when asked why.
- **Cash and the debt limit:** "How much cash does Treasury have?" The TGA closing balance (DTS) and debt
  subject to limit; mind the 2022 DTS format change.
- **Borrowing and auctions:** gross issuance and redemptions (DTS), auction sizes, yields and bid-to-cover by
  security type and term.
- **Exchange rates:** the Treasury reporting rate for a currency over time (not market rates).

## Critical questions bank

Ask only the ones that would change a headline number for this request, at most four, in one round,
with "Don't know — decide for me" on each and the recommended option first. Skip what the request
already settles.

| Choice | Ask when | Options (recommended first, typical) | How to decide empirically when the user doesn't know |
|---|---|---|---|
| **Period basis** | annual figures for budget flows or year-end stocks | Federal fiscal year (Oct–Sep) · Calendar year | Fiscal year for budget measures (precedent: MTS, CBO, OMB); calendar year only to match a calendar-year comparison (GDP from the World Bank, a calendar-year report) |
| **Time span** | the request names no years | last 10 complete fiscal years · since 2015 (MTS API start) · longest available | 10 complete years; include the current partial year only as "year to date" against the same months a year earlier. For **change** over "the past decade / N years", compare endpoints N years apart (latest complete FY vs. latest − N, so N + 1 years shown); for lists or totals, use the N latest complete years. Name the years either way |
| **Debt measure** | any debt question | Debt held by the public · Total public debt outstanding · Debt subject to limit | Held by the public for economic analysis (CBO precedent); total for "the national debt" in plain usage; report both when unsure and say how they differ |
| **Dollar basis** | comparisons across more than about 3 years, or "real" growth | Nominal · Real (CPI-U, latest full fiscal year dollars) · Share of GDP | Nominal for levels people quote; add real or % of GDP when growth over a decade or more is the point; run both and say whether the conclusion changes |
| **Stock: end of period or average** | yearly or monthly debt, cash, rates | End of period · Period average | End of fiscal year (matches published year-end figures); show the average as a sensitivity when the series is volatile (TGA cash) |
| **Interest measure** | interest questions | Net interest (MTS, budget) · Gross interest expense (`interest_expense`) · Interest on debt held by the public only | Net interest for budget questions; gross for "what Treasury pays"; public-issues expense for market-facing costs; state the choice in notes |
| **Gross or net** | receipts or outlays | Net (budget convention) · Gross | Net: it is what the MTS totals and CBO report |
| **Partial latest period** | the latest fiscal year is incomplete | Fiscal year to date vs. same months last year · Exclude it · Trailing 12 months | FYTD against the same months; trailing-12-month totals for trend charts |
| **Product** | the user did not ask for a report | Short answer + data (default) · Full HTML report · Data files only | The default; offer the report in one line |
| **Audience and organization** | a report is wanted | Neutral analyst product · Named organization | Neutral unless the user names one |

Questions that are **not** critical (decide and record them): CSV vs JSON, field selection, chart type,
rounding, the exact endpoint when two give identical published totals.

## Conventions to follow

**Periods and timing**
- The federal fiscal year runs October 1 to September 30 and is named for the year it ends. Write
  "fiscal year 2025" in prose (style guide), "FY2025" only in tables and charts.
- `record_date` is the reporting date (month end for the MTS, business day for the DTS and Debt to the
  Penny). The MTS for September is the final, full-year statement; it is published in mid-October.
- Say how current the data are: "data through September 30, 2025, retrieved October 19, 2026".
- Fix the cut-off in `spec.json` (`as_of`) so reruns return the same rows.

**Stocks and flows**
- Stocks (debt, cash, rates): take the end-of-period value (`period_end`) or the average (`period_mean`).
  Never sum them.
- Flows (receipts, outlays, deficit, interest): sum monthly values (`period_sum`, check `complete`), or read
  the September fiscal-year-to-date value. Never sum fiscal-year-to-date values across months.

**Tying to published totals**
- Every component breakdown must add to its published total (`check_total`), and every headline should
  match the official statement for the same date (the MTS, MSPD or DTS PDF, or Treasury's press summary).
  State the benchmark in Data and Methods. A difference above rounding means a filter or hierarchy mistake.
  When the downloaded table is itself the statement's total, check the internal identities instead, plus
  one independent publication (press release, CBO Monthly Budget Review).
- MTS tables repeat history and revise it. Use the latest release for a monthly series; use the September
  release for a full fiscal year.

**Units and signs**
- MTS tables 1-9, Debt to the Penny and interest expense are in dollars; DTS, MSPD and the long MTS series
  (`mts_receipts_outlays_deficit_surplus`, field `mil_amt`) are in millions. Convert once,
  name the unit in every exhibit subtitle ("Billions of dollars").
- Deficits: MTS Table 1 and the long MTS series show a deficit as positive; MTS Table 5 shows it as negative.
  Pick one convention for the product ("the deficit was $1.8 trillion") and state it.

**Real dollars and GDP**
- Deflate with the CPI-U averaged over the same fiscal year (`cpi_index(out, "FY")`), into the dollars of
  the latest complete fiscal year; name the index and base year in notes.
- Fiscal-year GDP is the average of the four quarterly seasonally adjusted annual rates from October to
  September (`fy_gdp`). Calendar-year GDP (World Bank fallback) does not match fiscal-year budget totals;
  if only that is available, say so or use calendar-year flows.
- An incomplete period (the `complete` flag is False; `tstats` prints a warning) is provisional: say so
  in the text and the exhibit notes, with its coverage ("GDP for three of four quarters"). In October the
  latest fiscal year usually lacks GDP's July–September quarter, so its share of GDP is provisional.

**Revisions and provenance**
- Treasury revises some values in later releases. Record the retrieval date (it is in `data/README.md`)
  and note revisions when a comparison spans releases.

## Publication structure (mirrored in `build_report.py`, `"mode": "report"`)

The default layout, the **exhibit chartbook**, runs in this order:
1. **Cover:** "Month Year", the title (with the period for trend reports), and a hero chart.
2. **At a Glance** (one page of about 300–420 words): one framing paragraph (what was examined, the measures,
   the period), then 3–5 bullets, each opening with a **bold lead phrase.** that names a section, followed by
   2–4 sentences with the key numbers.
3. **Contents** and **List of Exhibits** (built automatically).
4. **Notes About This Report:** fiscal years; rounding; nominal or real dollars (index and base year); the
   data source and retrieval date; sign conventions; partial-year coverage; a pointer to Appendix A.
5. **Introduction:** a lead paragraph with the headline numbers; question-style subheadings, one per section
   ("How Did Interest Costs Change?"); then "What Data Were Used?" and, when updating earlier work,
   "How Do These Estimates Compare With Published Figures?".
6. **Thematic sections** (2–5): each opens with 1–3 summary paragraphs, then one exhibit per page with 2–4
   narrative paragraphs beside the chart (level, change, comparison; "see Exhibit 3").
7. **Appendix A: Data and Methods:** endpoints and rows used, filters, the cut-off date, stock/flow treatment,
   period basis, deflator, benchmark comparison with the published statement, revisions, limitations.
8. **About This Document** (optional).

Use `"mode": "paper"` for a prose-led product with the exhibits in the running text.

## Chart forms
- Trends over fiscal years: line charts (debt, interest, rates) or columns (annual deficits), at most 4–5
  series. Trailing-12-month lines suit monthly flows, which are very seasonal (April tax receipts).
- Composition (receipts by source, outlays by function): horizontal bars for one year, sorted; stacked
  columns for change over time with at most about 6 groups plus "Other".
- Deficits: columns with the sign convention stated; surpluses below zero if shown as negative deficits.
- No dual axes, no pie charts, no 3-D. Scale amounts to billions or trillions in the exhibit CSV and name
  the unit in the subtitle.
