# Report patterns for federal workforce data products

Use this file to shape both the analysis and the report. The aim is a product a careful reviewer
(OPM, CRS, GAO, the Partnership for Public Service) would recognize: a precisely stated universe and
counting basis, numbered exhibits with notes and source lines, data shipped with the report, and the
limits of the public files stated plainly.

## Typical questions and how they are framed
These recur in published work, so there is usually a precedent to follow and a number to benchmark.
- **Size of the federal workforce** (status, September snapshots): total and by department or agency,
  over 5 to 20 years; permanent (`nsftp_indicator`) vs. all; full-time vs. other schedules. Headline
  style: "In September 2025, 2.2 million civilian employees worked for executive branch agencies covered
  by OPM's data, about X percent fewer than a year earlier." Always say what EHRI excludes (USPS, the
  intelligence community) because readers compare with "3 million federal workers" figures.
- **Workforce changes, 2025 onward** (separations and accessions): separations by type (quits,
  retirements, RIFs, Deferred Resignation Program), hiring, net change by agency; rates per 100
  employees. Separate the deferred resignation wave (`drp_indicator`; most effective in September 2025) from
  normal attrition, and transfers between agencies from exits from government.
- **Retirement wave / aging:** age-bracket composition, share 55+ or 60+, length of service, the
  retirement-eligible proxy (fields.md §4), by agency or occupation; retirement separation rates.
- **Occupations and skills:** IT (2210), cybersecurity proxies, STEM and health shares, mission-critical
  series (e.g. 0602 physicians, 0610 nurses, 1811 criminal investigators — redacted pay!), supervisory
  ratios (supervisors per employee).
- **Pay:** median and distribution by grade, pay plan, occupation or agency; GS grade structure; growth
  in nominal and real terms (deflate with CPI-U or the ECI and cite it). Always quote redaction coverage
  and avoid governmentwide pay averages.
- **Location:** employees by state or metro area, Washington-area share. Redaction removes DoD and
  security staff, so present location only for the covered part, or by department excluding DoD, and say so.
- **Veterans, education, probationary employees** (tenure group 2), **bargaining unit coverage**.

## Benchmarks (compute the same definition and compare)
- FWD dashboards ("Workforce Size & Composition", "Workforce Changes", "Compensation") for the same month.
- OPM's earlier FedScope tables and "Sizing Up the Executive Branch" reports (September snapshots).
- Congressional Research Service reports on the size of the federal workforce; GAO reports on agency
  workforce planning, retirements and the 2025 workforce reductions; Partnership for Public Service "Fed
  Figures". BLS Current Employment Statistics "federal government" employment includes USPS, so expect
  a gap of roughly 600,000 and explain it.
- OPM's subject reports (veterans employment, ...) can count only employees in pay status, fewer than the
  snapshot's on-board total: the FY2024 veterans report gives 27.4 percent in Table 1 (in pay status) and
  27.8 percent in Table 6 (on board, as the FWD files give it). Match the table to the universe you use.
Search with WebSearch, read the page, and cite it (`references` in report.json). Never cite from memory.

## Conventions to follow
**Population and definitions**
- State the universe: executive-branch civilian employees covered by EHRI; which snapshot month; all
  vs. permanent (NSFTP) vs. full-time; any agency exclusions you made.
- State the counting basis for actions (effective month or processing month) and the period (fiscal or
  calendar year).
- Rates use average headcount over the period as the denominator; say "per 100 employees" or "percent".
- Group by codes; show the latest name.

**Precision and suppression**
- Counts: round to the nearest hundred or thousand in prose ("about 447,200"), exact in tables. A
  rounded number is its own fact: register it with a rounding format (`num:-2` hundreds, `num:-3`
  thousands) so the answer gate finds it.
- Flag rates and pay statistics for groups with fewer than 30 records (`low_n`) and avoid publishing
  pay for very small groups (individuals could be identified).
- No sampling error: do not write "statistically significant". Describe differences as differences in
  the records, and discuss data-quality limits (redaction, late reports, missing submissions) instead.

**Publication structure (mirrored in `build_report.py`, `"mode": "report"`)**
The default layout, the **exhibit chartbook**, runs in this order:
1. **Cover:** "Month Year", the title (with the period for trend reports), and a hero chart.
2. **At a Glance** (one page, about 300-420 words): a framing paragraph (what was examined, the
   universe, the period) and 3-5 bullets with a **bold lead phrase.** naming a section and the key numbers.
3. **Contents** and **List of Exhibits** (built automatically).
4. **Notes About This Report:** calendar vs. fiscal years; rounding; data source and universe (with the
   EHRI exclusions); the snapshot month; the counting basis for actions; redaction of pay and location;
   key definitions; a pointer to Appendix A.
5. **Introduction:** a lead paragraph with the headline numbers; question-style subheadings, one per
   section; "What Data Were Used?"; "How Do These Figures Compare With Other Counts?" when relevant.
6. **Thematic sections** (2-5): a summary page, then one exhibit per page with 2-4 paragraphs beside it.
7. **Appendix A: Data and Methods:** files and versions (the manifest), universe, definitions, counting
   basis, redaction coverage table, late-reporting check, benchmark comparison, limitations (§1 of
   fields.md: what the public files cannot show).
8. **About This Document** (optional).

**Chart forms**
- Trends: line charts, at most 4-5 series (facet or pick the largest agencies plus "all other").
- Agencies or occupations at one point in time: horizontal bars, sorted.
- Composition (age brackets, separation types): stacked bars.
- Monthly actions around an event (e.g. September 2025): columns by month, with the event noted.
- No dual axes, pie charts or 3-D.
