# Report patterns for IPUMS data products

Use this file to shape the analysis for every product, and the layout when a report or paper is
built. The questions and conventions apply to quick answers too; the publication structure applies only
in report or paper mode. The aim is a product a careful reviewer would recognize: precise populations,
weighted estimates, a lead summary with numbers, numbered exhibits that each carry notes and a source
line, exhibit data shipped alongside, and limitations stated plainly.

## Typical questions and how they are framed

These recur in published work by statistical and policy agencies (Census Bureau, BLS, GAO, CRS,
state agencies, research institutes), so there is usually a precedent to follow and benchmark against.

- **Employment of immigrants** (ACS, CPS ASEC): people ages 25 to 54, split by sex, by nativity and
  citizenship, by education and by birthplace. Measures: weighted population counts (millions),
  employment rates (employed ÷ population) and average annual earnings of workers. Headline style:
  "In 2018, 46 million people living in the United States, or 14 percent of the population, had been
  born in other countries." Public IPUMS data **cannot** identify legal status (published work that
  reports it imputes it), so report nativity and citizenship (naturalized vs. noncitizen) instead, and
  say so.
- **Public-sector vs. private-sector pay** (CPS): full-time, full-year civilian workers, in 5 education
  groups (high school diploma or less; some college; bachelor's degree; master's degree; professional
  degree or doctorate). Measures: average hourly wages (annual wages ÷ annual hours), then
  regression-adjusted differences that control for education, experience, occupation, employer size,
  region, veteran status and demographics. With IPUMS alone: raw wage gaps, and optionally an OLS on
  log hourly wage with controls. Benefits are **not** in IPUMS, so say so.
- **Veterans' labor market outcomes** (CPS, ACS): for example, men ages 22 to 44 who left active duty
  after September 2001, compared with men who never served. Measures: labor force participation rate,
  unemployment rate (unemployed ÷ labor force) and earnings, by age group and by disability rating.
- Other recurring uses of the same data:
  - labor force projections by age and sex (CPS monthly);
  - minimum wage analyses that count affected workers by hourly wage (CPS outgoing rotation groups: EARNWEEK, HOURWAGE, EARNWT);
  - health insurance coverage by source (ACS HCOV*, CPS ASEC);
  - distribution of household income and poverty (CPS ASEC);
  - immigration surges (ACS and CPS: education and labor force participation of recent arrivals, using YRIMMIG / YRSUSA1);
  - state-level profiles (ACS: large samples with STATEFIP and PUMA detail).
- **Health insurance and access by group** (NHIS): uninsured at the interview, private vs. public coverage,
  no usual place of care, care delayed or forgone because of cost, by age (0-17, 18-64, 65+), poverty ratio,
  race and Hispanic origin, nativity. Benchmark the headline against NCHS's annual Health Insurance Coverage
  report (2024: 8.2% of all ages and 11.6% of adults 18-64 uninsured). NHIS has no state identifier in the
  public files: state estimates come from the ACS.
- **Health care spending** (MEPS): mean and median spending per person, the share with any spending,
  out-of-pocket spending and payer shares, by age, insurance type (`COVERTYPE`) and income group (`POVCAT`).
  Benchmark against AHRQ's MEPS-HC summary tables or Statistical Briefs (2022: $6,765 per person). Name the dollar
  year; per-person means hide extreme concentration, so pair them with medians or the top-percentile share.

## Conventions to follow

**Population and definitions**
- State the universe exactly: age range, civilian vs. all, noninstitutional (USA GQ 1, 2 or 5 = households), years and geography.
- The prime-age default is 25–54. It avoids school-age and retirement-age confounding.
- **Employment rate** = employed ÷ population. **Unemployment rate** = unemployed ÷ labor force. **Participation rate** = labor force ÷ population.
- **Earnings:** say whose earnings are averaged. Usually it is workers with positive wages, sometimes full-time, full-year workers only. Also say whether self-employment income is included (INCWAGE excludes it; INCEARN in the ACS includes it).

**Estimation**
- Always weight. In the USA collection use PERWT (HHWT for household measures). In the CPS ASEC use ASECWT, in CPS basic monthly use WTFINL (COMPWT for labor-force levels that match BLS), and in the CPS outgoing rotation groups use EARNWT. In NHIS (2019 on) use SAMPWEIGHT on sample adults or sample children; in MEPS use PERWEIGHT (SAQWEIGHT for questionnaire items).
- Report the unweighted cell size internally. Suppress or footnote cells with fewer than about 100 respondents; unstable estimates are not published.
- **Dollars:** convert to a single year's dollars and name the year and index ("in 2023 dollars, using the CPI-U-RS"; the PCE price index is a common choice for earnings and income), with CPI99 or `adjustMonetaryValues`. CPS ASEC income is for the **previous calendar year** (ASEC 2023 means 2022 income). ACS income is for the past 12 months, and IPUMS expresses it in survey-year dollars.
- **Top-coding:** INCWAGE is top-coded, which mostly matters for means at high education levels. Mention it.
- **Sampling error:** for differences that drive conclusions, note whether they are large relative to sampling error. ACS replicate weights (REPWTP, 80) and CPS ASEC replicate weights (REPWTP, 160) give proper standard errors. CPS basic monthly files have none (REPWTP is ASEC-only) and no design variables: give an approximate SE (clustered by household, `SERIAL` within month) and say it is approximate.

**Publication structure (mirrored in `build_report.py`, `"mode": "report"`; only when a report is asked for)**

The report layout, the **exhibit chartbook**, runs in this order:
1. **Cover:** "Month Year", the title (with the period for trend reports), and a hero chart that has its own title and unit label.
2. **At a Glance** (one page of about 300–420 words):
   - one framing paragraph saying what was examined, the population, the period and the dimensions;
   - 3–5 bullets, each opening with a **bold lead phrase.** that names a section, followed by 2–4 sentences with the key numbers.
3. **Contents:** the Introduction subsections, each section with an "Exhibits a–b" sub-line, the appendixes, and About This Document when there is one.
4. **List of Exhibits:** grouped under section headings, each entry "N. Title, years".
5. **Notes About This Report** (also titled "Notes" or "Notes and Definitions"). Short unnumbered paragraphs covering:
   - calendar years;
   - "Numbers in the text and exhibits may not add up to totals because of rounding.";
   - the dollar year and deflator;
   - the data source and universe;
   - key definitions;
   - recession shading, if any;
   - where the data are posted.
6. **Introduction** (or "Summary and Introduction"):
   - a lead paragraph with the headline numbers;
   - question-style subheadings, one per section ("How Do Demographic Factors Relate to …?");
   - closing subsections such as "Why Focus on People Ages 25 to 54?", "What Data Were Used?" and, when updating earlier work, "What Is New in This Report?".
7. **Thematic sections** (2–5, unnumbered):
   - Each opens on a full-width page with 1–3 summary paragraphs.
   - Then comes **one exhibit per page**: "Exhibit N." with a title-case title ending in ", 1998 to 2018", a unit label above the chart, and 2–4 narrative paragraphs beside it (levels, changes, comparisons, "(see Exhibit 5)").
   - Below the chart: the data source line ("Data source: `<organization>`, using data from …", or "Data source: Analyst calculations using data from …" when no organization is named), then the notes, then lettered notes ("a.").
8. **Appendix A: Data and Methods** (or "Appendix: Estimating …"): data, sample, universe, weights, imputations, reliability, comparison with other estimates. Sometimes followed by **Appendix B: Definitions**, an alphabetical glossary.
9. **About This Document** (optional), in this order:
   - who requested it, or what question prompted it;
   - who prepared it, with what data and tools;
   - the reviewers, if any;
   - the date.
10. **Footnotes** are numbered in each part (restarting in each section), and cite publications as: Organization, *Title* (Month Year), URL.

Other variants, not built by `build_report.py`:
- **Long-form**:
  - a Summary with Figure S-1 / Table S-1;
  - "Chapter N:" sections in two-column prose with embedded "Figure 1-1." / "Table 2-3.";
  - Boxes;
  - a List of Tables and Figures at the back.
- **Hybrid**: full-width pages each with a heading, a paragraph and unnumbered charts; sources pooled in an appendix.
- Use `"mode": "paper"` when a prose-led product is wanted.

**Reading PDFs from sites that block scripts:** some publishers refuse scripts and the in-app browser (HTTP 403, bot-check slider). Fetch `https://web.archive.org/web/<year>/<full pdf url>` and extract the text with pypdf. If the plain year URL returns HTML, use a CDX timestamp with `id_` (for example `https://web.archive.org/web/20240430034127id_/<url>`). Cite the original URL.

**Data files:** the codebook, the extract definition (`spec.json`, `data/ipums/extract_spec.json`), the download
files in `reproduce/ipums/` (`download_ipums.sh` / `.ps1` with the extract built in, run with one command;
`extract_spec.json`; `DOWNLOAD.md`; `REPRODUCE.md`), all attached to the page with Download buttons,
and each exhibit's CSV ship with the product, so every number can be traced and the data requested again.
The extract CSV (microdata) stays local: the IPUMS terms forbid redistributing it, so the report never links
or embeds it, and it goes into a shared package only when the user confirms permission
(`"replication": {"include_microdata": true}`).

**Chart forms**
- Trends over time: line charts with at most 4–5 series. Facet (one exhibit per sex) rather than drawing 8 lines.
- Group comparisons at a point in time: grouped columns, or horizontal bars when the category labels are long (education, birthplace).
- Composition (wages + benefits, population by status): stacked columns.
- No dual axes, no pie charts, no 3-D.
