# Congress nominations, CRS reports and cost estimates

From the congress playbook's "Data format and traps" section: read it before a request of this kind.

- Cost estimates: `bill_cbo_estimates` gives only what Congress.gov lists: title, publication date,
  description and a cbo.gov link for each estimate. No dollar figures are in the API; the estimate
  itself is a PDF or web page (committee reports in govinfo CRPT often reprint it as text).
- CRS: `crs_reports` lists reports Congress.gov publishes (newest first, about 14,000 in Oct 2026);
  there is no keyword search: use a date range and `title_contains`, then `crs_report` for the summary.
  `fromDateTime`/`toDateTime` filter on the UPDATE date (one September window returned 1,244 products
  published 2004-2026): for "published in a month" filter the rows on `publishDate` afterwards. `publishDate`
  is the current version's date, so a product first issued in the month and revised later drops out (a
  floor, say so). The list's `version` is not the product version: `crs_report` gives `currentVersion`.
  `bill_summaries` are CRS summaries of each bill version (HTML in `text`, plain in `text_plain`); some fields
  are over 131,072 characters: when reading the CSV with your own code, raise the reader's field size limit first.
- Nominations (traps seen in Oct 2026 data; the Senate Résumé's "Civilian nominees" table is the benchmark):
  military and "Other Civilian" lists (Foreign Service, PHS, NOAA officers) are list nominations without a
  description; `nominationType` (`isCivilian`, `isMilitary`) is missing on some rows of older Congresses
  (every row of the 119th has one); a PN split into parts
  (PN12-41) counts once per part; en bloc votes confirm many nominees at once. `latestAction` is the last
  step, which can be a later procedural motion ("motion to reconsider tabled") or, for a nomination held over,
  its confirmation in the next session: count outcomes by date from `nomination_actions`, within the
  session's dates. A split PN's actions need `nominationNumber` "1255-17": `"for_each": {"csv":
  "data/congress/<noms>.csv", "column": "citation", "param": "nominationNumber", "strip": "PN"}` (`number` alone
  returns nothing for a split PN). The naive count (civilian flag + `latestAction` "Confirmed") gave 60 percent for 2023
  against the Résumé's 47.
