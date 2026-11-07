# Report patterns for BEA data products

Use this file to shape both the analysis and the product. The aim is something a careful reviewer would
recognize: precise measures (real or nominal, which growth rate, which release), a lead summary with
numbers, numbered exhibits that each carry notes and a source line, data shipped alongside, and
limitations stated plainly.

## Typical questions and how they are framed

These recur in work by statistical and policy agencies (BEA itself, CBO, the Federal Reserve, CRS, GAO,
state budget offices, research institutes), so there is usually a precedent to follow and benchmark against.

- **How fast is the economy growing?** (NIPA T10101, T10106, T10102). Measures: real GDP growth, quarterly
  at an annual rate and annual; contributions of consumer spending, investment, government and net exports
  (from T10102, not computed). Headline style: "Real GDP increased at an annual rate of 2.2 percent in the
  second quarter of 2026, according to BEA's third estimate." Name the estimate (advance, second, third) and
  compare with the previous quarter and the prior-year average.
- **Inflation by BEA's measure** (T20804, T20807; T10104 for GDP prices). PCE and core PCE price indexes,
  12-month changes for monthly data; compare with the Federal Reserve's 2 percent objective only as a fact,
  not advice.
- **Household income and saving** (T20100, T20600, T70100). Personal income, disposable personal income in
  real terms, the saving rate, per capita amounts. Distinguish personal income (includes transfers and
  employer contributions) from household money income in Census surveys.
- **Which states (or counties) are growing fastest?** (SAGDP9, SQGDP9, SAINC1, CAINC1). Real GDP growth or
  per capita income by state, ranked; regional patterns (BEA regions); industry drivers (SAGDP11
  contributions, SAGDP2 shares). Report the U.S. figure from the same table, say whether D.C. is included,
  and note (D) suppressions.
- **Industry structure** (GDPbyIndustry; SAGDP2 by state). Value added shares of GDP in current dollars;
  real growth by industry; long series start in 1997 (NAICS).
- **Trade and international position** (ITA, IntlServTrade, IIP). Goods and services balances by country,
  current account as a share of GDP (use T10105 for GDP).
- **Government in the economy** (T30100-T30300). Receipts, expenditures, net saving on a NIPA, calendar-year
  basis; explain how it differs from budget (fiscal-year) data when the reader may compare them.
- **Cost of living across places** (SARPP, MARPP, SARPI). Regional price parities (U.S. = 100) and real
  personal income; say that RPPs compare price levels across places in one year, not changes over time.

## Conventions to follow

**Measures and definitions**
- Real values in chained (2017) dollars; current-dollar values in nominal terms; say which in every exhibit
  subtitle ("Billions of chained 2017 dollars", "Percent change at an annual rate").
- Growth rates: name the measure (quarter at an annual rate, year over year, Q4 over Q4, annual average).
- Shares of GDP or of the U.S. total: current dollars only.
- Per capita: BEA's published per capita lines first; otherwise the population line of the same table.
- Rankings: say how many areas are ranked and what happens with suppressed values or ties.

**Accuracy**
- Every computed growth rate or share that BEA also publishes is checked against BEA's number
  (`check_against_published`), and the check is reported in Data and Methods.
- The vintage: the release date and estimate (for example "the third estimate for the second quarter of 2026,
  released September 25, 2026", or "state GDP as released on September 30, 2026") is in the notes page and
  in Data and Methods; the products say estimates are subject to revision.
- No sampling error is attached to BEA estimates, so there are no standard errors and no "statistically
  different". Describe differences by size; for small differences, note that revisions are often of that size
  (find and cite BEA's latest revision study, published in the *Survey of Current Business*, for the typical
  size of revisions to the measure at hand), and say so instead of overinterpreting.
- Do not attribute causes beyond what the accounts show. "Growth was led by consumer spending" is a
  contribution fact; "because of tariffs" is not something BEA data establish.

**Publication structure (mirrored in `build_report.py`, `"mode": "report"`)**

The default layout, the **exhibit chartbook**, runs in this order:
1. **Cover:** "Month Year", the title (with the period for trend reports), and a hero chart that has its own title and unit label.
2. **At a Glance** (one page of about 300–420 words):
   - one framing paragraph saying what was examined, the population, the period and the dimensions;
   - 3–5 bullets, each opening with a **bold lead phrase.** that names a section, followed by 2–4 sentences with the key numbers.
3. **Contents:** the Introduction subsections, each section with an "Exhibits a–b" sub-line, the appendixes, and About This Document when there is one.
4. **List of Exhibits:** grouped under section headings, each entry "N. Title, years".
5. **Notes About This Report** (also titled "Notes" or "Notes and Definitions"). Short unnumbered paragraphs covering:
   - calendar years;
   - "Numbers in the text and exhibits may not add up to totals because of rounding.";
   - real vs. nominal, the chained-dollar reference year, seasonal adjustment at annual rates;
   - the data source, tables and vintage (release date), and that BEA revises its estimates;
   - key definitions (the growth measure, per capita, the areas covered);
   - recession shading, if any;
   - where the data are posted.
6. **Introduction** (or "Summary and Introduction"):
   - a lead paragraph with the headline numbers;
   - question-style subheadings, one per section ("Which States Grew Fastest?");
   - closing subsections such as "How Are Growth Rates Measured?", "What Data Were Used?" and, when updating earlier work, "What Is New in This Report?".
7. **Thematic sections** (2–5, unnumbered):
   - Each opens on a full-width page with 1–3 summary paragraphs.
   - Then comes **one exhibit per page**: "Exhibit N." with a title-case title ending in ", 1998 to 2018", a unit label above the chart, and 2–4 narrative paragraphs beside it (levels, changes, comparisons, "(see Exhibit 5)").
   - Below the chart: the data source line ("Data source: `<organization>`, using data from …", or "Data source: Analyst calculations using data from …" when no organization is named), then the notes, then lettered notes ("a.").
8. **Appendix A: Data and Methods** (or "Appendix: Estimating …"): data and vintage, tables and lines, definitions, computations, checks against BEA's published figures, revisions and limitations. Sometimes followed by **Appendix B: Definitions**, an alphabetical glossary.
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

**Data files:** `data/bea_data.csv`, `data/notes.csv`, `data/request.json` and each exhibit's CSV ship with the report, so every number can be traced. BEA data are public domain, so the replication package includes the data.

**Chart forms**
- Trends over time: line charts with at most 4–5 series; quarterly growth rates as columns (positive and negative bars read better than a line).
- Levels and growth together: two exhibits, not a dual axis.
- Group comparisons at a point in time (states, industries): horizontal bars sorted by value; for all 50 states plus D.C., a sorted bar chart or a table, with the U.S. value marked in the notes or as its own bar.
- Composition (contributions to growth, shares of GDP): stacked columns, with the total shown as its own series or in the text.
- No dual axes, no pie charts, no 3-D. Maps need a library the builder does not have; use sorted bars.
