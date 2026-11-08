# GovInfo collections: how each one is packaged and counted

From the govinfo playbook's "Data format and traps" section: read it before a request of this kind.

- Cost estimates: the budget office's own estimates are not a GovInfo collection. Two partial routes,
  both text, not tables: (1) `collection: GOVPUB` with the publisher filter
  (`publisher: "Congressional Budget Office"`, a report subset) returns the reports GPO has catalogued
  (765 records in Oct 2026, far from the office's full list of publications);
  (2) `collection: CRPT` with `phrase: "cost estimate"` finds committee reports, which usually reprint the
  estimate for a reported bill in the report text. Congress.gov bill records (congress pack, endpoint
  `bill_cbo_estimates`) list the titles and links of the estimates for a bill. No API here returns the
  estimated dollar figures as data.
- CREC (daily Congressional Record): one package per issue date, but a two-book day can appear twice
  (`CREC-2025-03-11` and `CREC-2025-03-11-i45`, same pages; `-i46` the second book): deduplicate by
  `volume` + `issue` before counting issues or summing pages. Other suffixes are distinct issues, not
  duplicates: `-v169`/`-v170` on January 3 (two volumes, the outgoing and incoming Congress) and a day with
  `-i64`/`-i65`. Chamber sections are granules of class SENATE, HOUSE, EXTENSIONS and DAILYDIGEST (the
  summary's `download.pdfSenateLink` / `pdfHouseLink` too). Early-January issues of a calendar year
  belong to the outgoing Congress (volume and congress differ; `CREC-2015-01-02` is volume 160 but is
  labelled congress 114), and an issue can be missing. Proceedings print under the legislative day, not the calendar day: a
  Senate session that runs on (July 1, 2025, a continuation of June 30's legislative day) has no issue of its
  own, so `granules` for that date returns no rows; find the issue with `search` (CREC, a phrase from the
  proceedings) instead. `pages` counts PDF pages (Daily Digest and front
  matter included), so it runs about 1 percent above the Résumé of Congressional Activity's numbered pages.
- "How many pages is the law": the convention is its Statutes at Large pages (first page to the last
  `[[Page ... STAT. ...]]` marker of `text`, e.g. 139 Stat. 72-401 is 330 pages); the slip-law and enrolled-bill
  PDFs differ by a page or so (cover, signatures). Say which measure the answer uses.
- CPD (Compilation of Presidential Documents, 1993 on; daily from 2009-01-20): one package per document,
  docClass PRESDOC plus a few DIGEST, ACTSAPPROVED, CHECKLIST and NOMINATIONS rows (in a transition year the
  outgoing President's supplements, `DCPD-2025DIGEST-BIDEN` and the like, are docClass PRESDOC too: count
  numbered DCPD-YYYY0NNNN packages). The `published` list has no document type; each `package` summary has
  `dcpdCategory` (level1 "Executive Orders", "Proclamations" ...), and `search` takes `collection:CPD AND
  cpdcategory:proclamation` (signing remarks included). Some orders are missing or have no number in the
  title, and `dateIssued` can be a day after signing. Count executive orders from the
  federal-register pack (`executive_orders`, by signing date) and use CPD as the cross-check.
- CRPT (committee reports): one package per numbered report (its parts and errata inside it); GovInfo's
  browse pages count documents (parts and errata), so they run above the report count. `published` CRPT also
  lists GPO duplicate packages (GPO-J6-REPORT, GPO-CRPT-117hrpt646): keep `packageId` CRPT-*. A few
  `dateIssued` values are wrong (three Dec-2022 reports dated 2021-12-31): count by Congress, not by date.
- CPRT (committee prints, "select prints": GovInfo is not a census of them): summaries carry no
  `committees`; attribute a print to its committee by `suDocClassNumber` (the `Y 4.` stem, without the
  `-NN` series suffix; a few prints have two classes or none). `published` with collection CPRT also returns
  packages of other collections (GPO-PLUMBOOK-2024, collectionCode GPO): keep `collectionCode` CPRT.
  GovInfo's browse pages count documents (errata included), not packages.
- STATUTE: one package per volume and volume = a session of Congress, not a calendar year. A law goes in
  the volume of the session that passed it, not the year it was signed: laws signed in early January after
  a session ends are in the closing session's volume (116-344, signed 2021-01-13, in vol. 134; 118-274,
  2025-01-06, in vol. 138), and numbering can interleave (113-74, signed 2014-01-16, closes vol. 127 while
  113-73 opens vol. 128). Assign laws to volumes from the granules, never by date. Granule `dateIssued` can
  be wrong by a year (117-343's granule says 2022-01-05; signed 2023-01-05). Count laws by granules
  with `granuleClass` PUBLICLAW (granules also hold proclamations and concurrent resolutions). Older
  summaries (vol. 127) have no `pages`; `pages` counts front matter too. A granule id carries its start page
  (`STATUTE-136-Pg6299`; a continuation adds a suffix, `STATUTE-135-Pg2531-2`). Each volume prints public
  laws, then private laws, then concurrent resolutions and proclamations, with a few blank pages between the
  parts. The public laws' pages run from the first law's start page to the **last law's last page**: the last
  `[[Page N STAT. M]]` marker in that law's `text` (`packageId` PLAW-...). The next granule's start page
  overstates it by 3 or 4 pages (6 more in vol. 136, where private laws come first); with the end from the
  text, the 116th-118th Congresses give 8,432, 8,742 and 4,350 pages, the figures in Brookings' Vital
  Statistics on Congress (Table 6-4).
- BUDGET: one package per volume (`BUDGET-2027-BUD` main volume, `-PER` Analytical Perspectives, `-APP`
  Appendix). Summaries report collectionCode GPO (FY2017 and FY2027 alike) although `published` with
  collection BUDGET lists them. Recent summaries' `pages` equals the PDF's page count; older ones (FY2017)
  carry none: download `https://www.govinfo.gov/content/pkg/<packageId>/pdf/<packageId>.pdf`, count its pages
  (pypdf) and record them in `published/`. A missing volume (FY2026 had no Analytical
  Perspectives) is a 404: allow_empty. OMB posts supplemental chapters outside the volumes.
- USCOURTS (federal court opinions): one package per case, one granule per opinion; `search` returns one row
  per opinion (`collection:USCOURTS AND courttype:appellate`, `courtname:fifth`; `ingestdate:range(...)`
  filters on the date added to GovInfo, not the opinion date, and 2025 opinions keep arriving in 2026). A year of appellate opinions (about 15,000) passes the
  10,000-row search cap: split by half-year. The court code is in the packageId (`USCOURTS-ca5-...`; the
  Federal Circuit is ca13). Courts choose what they send (the Ninth Circuit sends precedential opinions only),
  so a ranking reflects submission practice, not caseload: say so; the AO's Judicial Business tables (B-12)
  count opinions by circuit.
- CFR: one package per title, edition and volume (`CFR-2025-title40-vol17`). `dateIssued` is the
  "revised as of" date (January 1 for titles 1-16, April 1 for 17-27, July 1 for 28-41, October 1 for
  42-50), not the posting date, which lags by months: a recent
  edition can be incomplete, with volumes missing (404) while `volumeCount` counts them. `published`
  rows carry no page count, so a title's pages take one `package` call per volume (`pages`, every PDF page
  including front matter); give missing volumes `"allow_empty": true` and say they are missing, or fill
  them from the prior edition as a labeled sensitivity case. Some volumes are covers only (`coveronly`).
- Bill to law: `related_collection` with `accessId` BILLS-...enr and `collection` PLAW gives the law's
  package, citation and date (the plain `related` lists only the collections). An enrolled version's
  `dateIssued` is GPO's print date, not the enrollment date: it can fall after the signing (BILLS-119hr1enr
  is dated 2025-07-09, signed 2025-07-04).
- PLAW holds private laws too: `published` rows carry `docClass` PUBLIC or PRIVATE (packageId `publ` /
  `pvtl`); 2022 had 247 public and 2 private. Count public laws on `docClass == "PUBLIC"`. For PLAW,
  `dateIssued` is usually the approval date, but GovInfo has errors (PLAW-119publ76 is dated 2025-02-06; it
  was approved 2026-02-06): for counts by date, check the Office of the Federal Register's list or the
  congress pack's `laws`.
