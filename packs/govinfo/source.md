# GovInfo (Government Publishing Office API)
Depth: standard. Key: optional (DATA_GOV_API_KEY; the public DEMO_KEY works at about 10 requests an hour).
Official publications of all three branches: bill text versions, public laws, Statutes at Large, U.S.
Code, Congressional Record, committee reports and hearings, Federal Register and CFR, the Budget,
agency publications catalogued by GPO.

## When to use
- Which bills or reports use a phrase; full text of a bill version or law; a law's sections and the U.S.
  Code sections it amends; public laws enacted in a date range; committee reports, hearings and Congressional Record issues on a topic; agency reports in GOVPUB.
- Not here: bill status, sponsors, cosponsors, actions and votes (congress); rule metadata and counts
  (federal-register); public comments (regulations). Cost estimates as numbers are not available from
  any API in this skill (see traps).

## Endpoints and datasets
| Endpoint | Returns (one row per) | Key parameters |
|---|---|---|
| `search` (POST) | matching package or granule: title, packageId, dateIssued, collectionCode, governmentAuthor, links | `text` (plain words, escaped), `phrase` (exact, escaped), `all_words` (every word, anywhere: an upper bound), `any` (list of words or phrases, OR), `title` (words or phrase in the title field: the title search, escaped), `query` (raw syntax, unescaped), `collection`, `congress`, `billtype`, `publisher`, `date_from`, `date_to`, `sort` (relevance, newest, oldest) |
| `published` | package issued in a date range (complete list) | `start_date`, `end_date`, `collection` (required), `congress`, `docClass`, `billVersion` |
| `package` | one package's metadata | `packageId` |
| `related_collection` | related package of one collection (an enrolled bill's public law) | `accessId`, `collection` |
| `granules` | granule in a package (CREC articles, FR documents, CFR parts) | `packageId` |
| `related` | related collection for a package (bill versions, status, reports, CREC, signing statements) | `accessId` |
| `text` | one row: package_id, title, date_issued, pages, characters, text_status, pdf_url, text (+ granule_id, granule_class with `granuleId`) | `packageId`, or `congress` + `billtype` + `number` (+ `version`, default `enr`); `granuleId` for one granule (a Record article: packages of over 25 granules have no whole text); `max_chars` |
| `sections` | section of a public law (USLM XML): identifier, num, heading, within (enclosing titles), usc_amended, usc_cited, usc_classified, amending_actions, characters, text | `packageId` (PLAW, 113th Congress on), `max_chars` (per section) |

Collections (catalog aliases, `--search "reports"`): BILLS, BILLSTATUS, BILLSUM, PLAW, STATUTE, USCODE,
CRPT, CREC, CRECB, CHRG, CPRT, CDOC, SERIALSET, FR, CFR, ECFR, CPD, PPP, BUDGET, ERP, ECONI, GAOREPORTS
(an archive: 16,569 GAO reports and decisions dated 1989-06-22 to 2008-09-18 only, verified 2026-10-22;
later ones are on gao.gov, which no pack serves),
GOVPUB, USCOURTS and more. Package ids: `BILLS-118hr4763eh` (congress, type, number, version),
`PLAW-117publ169` (public law 117-169), `CRPT-118hrpt100`, `CREC-2024-03-07`, `FR-2024-01-02`,
`CFR-2024-title40-vol1`. Bill versions: ih/is introduced, rh/rs reported, eh/es engrossed (passed one
chamber), enr enrolled (passed both).

## Spec examples
```json
{"description": "Bills in the 118th Congress that use the phrase 'payment stablecoin'",
 "requests": [{"name": "stablecoin_bills", "endpoint": "search",
   "params": {"collection": "BILLS", "congress": 118, "phrase": "payment stablecoin", "sort": "newest"}}]}
```
```json
{"description": "Laws (public and private) issued in 2024, and the text of one",
 "requests": [
  {"name": "laws_2024", "endpoint": "published",
   "params": {"start_date": "2024-01-01", "end_date": "2024-12-31", "collection": "PLAW"}},
  {"name": "law_text", "endpoint": "text", "params": {"packageId": "PLAW-118publ201"}}]}
```
```json
{"description": "The sections of Public Law 118-190 and the U.S. Code sections each one amends",
 "requests": [{"name": "law_sections", "endpoint": "sections",
   "params": {"packageId": "PLAW-118publ190", "max_chars": 500}}]}
```
```json
{"description": "Budget office publications catalogued by GPO since June 2026 (a subset of its reports)",
 "requests": [{"endpoint": "search", "params": {"collection": "GOVPUB", "date_from": "2026-06-01",
   "sort": "newest", "publisher": "Congressional Budget Office"}, "name": "budget_office_reports"}]}
```

## Data format and traps
- Filters go inside the query string. GovInfo ignores `collection`, `congress` or `billType` sent as
  separate JSON fields (verified: a body field `collection` returned other collections); the pack writes
  them as `collection:BILLS AND congress:118 AND (...)`. Words in `text` all have to match (implicit AND).
- Escaping: `text` and `phrase` lose `: ( ) [ ] { } " \ * ? ~ ^ !` and the words AND/OR/NOT, so user text
  cannot change the query (a stray backslash once drew HTTP 500; it did not on 2026-10-22, but the
  escaping stays). Use `query` only for deliberate
  GovInfo syntax (`title:"tax"`, `OR`), and quote phrases there yourself. Never put `dateIssued:` in
  `query` (HTTP 500 every time, verified 2026-10-28; check_spec refuses it): use `date_from`/`date_to`.
  An HTTP 500 that repeats for one query while simpler searches answer is caused by the query, not an outage.
- **Completeness of "documents that mention X"**: GovInfo's quoted (exact-phrase) search can miss documents
  that hold the phrase, even in their titles (BILLS of one Congress: a two-word phrase quoted 58, as
  `title:"..."` 110; one word quoted 44 vs 92 unquoted; checked 2026-10-28). `phrase` stays the quoted search
  (a one-word phrase is sent unquoted); for a multi-word phrase the fetch also counts the same search with
  all the words and notes when the phrase result is under half that count and at least 20 documents short
  (a phrase is always rarer than its words apart, so a smaller gap is expected). `all_words` returns that complete
  candidate list: an upper bound, since the words may stand apart; confirm the phrase in the text of the
  documents that matter (`text`, `for_each` on `packageId`), or call the count "documents containing all
  the words". Unquoted words are stemmed only for dictionary words (a new coinage's plural is not): search
  every form with `any` (`["levy", "levies", "levied"]`), deduplicate by `packageId`, and say in the method
  note which forms and which search (`text`, `phrase`, `all_words`, `any`) were used.
- **A full-text phrase search is not a title search.** `phrase`, `text`, `all_words` and `any` search the whole
  document, and the quoted search misses many documents (above). For "X in the title" (a bill's official or
  short title), search the title field: `query: 'title:"<phrase>"'` with `collection: BILLS` and `congress`
  (`collection:BILLS AND congress:<n> AND title:"<phrase>"` is what is sent), deduplicate versions to bills,
  then confirm each bill's titles with the congress pack's `bill_titles` (`for_each`). That is the route the
  congress pack's `title_contains` note points to.
- BILLS has one package per printed version, so a search counts versions, not bills: strip the version
  suffix from `packageId` (`BILLS-118hr4763eh` -> 118 hr 4763) and deduplicate before counting bills. A
  version code can end in a digit (`BILLS-118hr7643rh2`, a second reported print): parse `[a-z]+\d*`.
- `search` stops at `max_rows` (default 10,000); `count` is GovInfo's estimate of all matches. Relevance
  order changes as content is added; use `published` for complete, stable lists by date and collection.
- `dateIssued` and the search date filters mean different things by collection: for hearings (CHRG) it is
  the hearing date (equal to `heldDates`), and `date_from`/`date_to` filter on it; when a document became
  available is `dateIngested` (search rows; `published` rows and package summaries carry no ingestion date, so
  "how soon after signing did a law reach GovInfo" needs `search` with collection PLAW). Search returns one row
  per granule: count distinct packages.
  Addenda and errata are packages of their own ("Addendum to ...", "Errata for ...": 25 of 303 Senate CHRG
  packages for 2025, 23 of them Judiciary): drop them by title before counting hearings. CHRG holds printed
  hearings only, months after they are held; meetings as held (hearings, markups) are the congress pack's
  `committee_meetings`. A committee's hearings are best selected by its SuDoc class
  (`query: 'collection:CHRG AND congress:118 AND sudocclass:"y 4.j 89/2:"'`, Senate Judiciary), which also
  leaves out joint hearings another committee printed.
- `dateIssued` is otherwise the publication date; for GOVPUB catalog records it can be a cataloguing date that is
  later than the document itself (seen in Oct 2026: a record ingested in 2024 shows dateIssued 2026-06-27).
  Check the PDF before dating a document from GOVPUB.
- Cost estimates: the budget office's own estimates are not a GovInfo collection. Two partial routes,
  both text, not tables: (1) `collection: GOVPUB` with the publisher filter
  (`publisher: "Congressional Budget Office"`, a report subset) returns the reports GPO has catalogued
  (765 records in Oct 2026, far from the office's full list of publications);
  (2) `collection: CRPT` with `phrase: "cost estimate"` finds committee reports, which usually reprint the
  estimate for a reported bill in the report text. Congress.gov bill records (congress pack, endpoint
  `bill_cbo_estimates`) list the titles and links of the estimates for a bill. No API here returns the
  estimated dollar figures as data.
- `text` returns the GPO plain-text rendition (`[[Page 138 STAT. 2687]]` page markers kept). Large
  packages (an omnibus law) give a text column of several MB; set `max_chars` to keep a sample. Some
  packages have only PDF: the request then fails with "no text rendition". Committee reports and hearings
  keep their text per granule: `text` reads the granules and fills `committees` from them; a package of
  more than 25 granules fails with a hint (list `granules`, then `text` per `granuleId`), it is never cut.
- **A text rendition can be a placeholder.** For a document GPO did not convert, the text is a cover page plus
  `[TEXT NOT AVAILABLE REFER TO PDF]`, served like real text (`truncated` false). Every `text` row carries
  `text_status`: `full`; `pdf_only` (the placeholder and little else); `partial_pdf` (a placeholder inside
  real text: some parts are only in the PDF); `near_empty` (no placeholder, but under 100 characters per PDF
  page). The fetch marks the table incomplete and names the `pdf_only`/`near_empty` rows. Their words were not
  read: keep them out of term counts and "the full text of all N" (say "N - k read; k only as PDF"), and read
  them at `pdf_url` (GovInfo's public PDF) when they matter.
- `sections` reads GPO's USLM XML (United States Legislative Markup), which GovInfo has for public laws from
  the 113th Congress (2013) on. Bills have only the older bill XML, Statutes at Large only a whole-volume file
  (tens of MB), and most private laws have no USLM: use `text` for those (GovInfo answers a missing USLM
  file with HTTP 400). Sections inside a title carry it in `within`. Sections quoted inside an amendment are
  the new Code text and are not rows. U.S. Code references are split three ways. `usc_amended`: a
  reference in the same sentence as an amending action ("is amended", "striking", "inserting").
  `usc_cited`: other references. `usc_classified`: margin notes ("31 USC 1101 note"), which show where the
  Office of the Law Revision Counsel places the provision. All are `"; "`-joined: split them before
  counting. Amendments to a named Act that cite no Code section ("Section 102(d) of the ... Act") appear
  only in `text`. GPO converts laws to USLM automatically and warns that compacts and unusual structures
  may be marked up inconsistently, so check a surprising count against `text`.
- Committees: the package summary and `governmentAuthor` name only the chamber. Per committee, search with
  `query: 'collection:CRPT AND congress:118 AND committee:"Natural Resources"'`: the field matches words of
  any committee name in either chamber (that query also returns Senate Energy and Natural Resources
  reports), so split by `packageId` (`hrpt` House, `srpt` Senate) and confirm with `text`'s `committees`.
- `published` dates are inclusive here (GovInfo's own end date is exclusive; the adapter adds a day). The FR
  collection also holds a yearly index package (`GPO-FR-INDEX-2024`, docClass GPO): count issues on
  docClass FR. For FR, `pages` (package summary) counts the PDF's pages including unnumbered front matter,
  about 8 more per issue than the Office of the Federal Register's numbered pages.
- Per-package figures (pages; volume and issue, which CREC's `published` titles also carry: "Volume 171,
  Issue 45") are in `package` summaries: fetch the `published` list,
  then one `package` request per row with `"for_each": {"csv": "data/govinfo/<list>.csv", "column":
  "packageId"}` (SKILL.md §3).
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
  (pypdf) and record them in `published/` (SKILL.md §2). A missing volume (FY2026 had no Analytical
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
- `governmentAuthor` is a "; "-joined list. `collectionCode` can hold two codes (`SERIALSET;CRPT`).
- Paging: `search` uses GovInfo's `offsetMark` cursor (100 per page); `published` and `granules` follow
  `nextPage` (1,000 per page).

## Access
Key optional: DATA_GOV_API_KEY (https://api.data.gov/signup/, also linked from GovInfo's own
https://www.govinfo.gov/api-signup), sent as `api_key` to api.govinfo.gov only.
Without it the pack uses DEMO_KEY (observed limit 10 requests an hour per IP); larger specs make `--check`
ask for the key. Text pages on www.govinfo.gov never get the key. Manual route: GET links in
INSTRUCTIONS.md carry `api_key=DEMO_KEY`; text items link the keyless public page
`https://www.govinfo.gov/content/pkg/<id>/html/<id>.htm`; searches are POST requests (one command
runs download_data.sh / .ps1), or search on https://www.govinfo.gov/app/search and save the result list.

## Citation and terms
"U.S. Government Publishing Office, GovInfo, <query or package>, api.govinfo.gov, retrieved <date>."
Public domain unless a document marks copyrighted content; redistribution allowed. Cite the package id
and the official PDF for legal text.
