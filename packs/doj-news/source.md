# Department of Justice News (justice.gov press releases and blog)
Depth: standard. Key: none. DOJ press releases (about 274,000 since the late 1990s, from Main Justice,
the 94 U.S. Attorney's Offices, FBI, DEA, ATF and other components) and Justice Blog entries (about
3,300), with title, date, component, topic, teaser and full HTML text.

## When to use
- Finding, listing and quoting DOJ announcements: indictments, pleas, sentences, settlements, policy
  statements; which components announced what, and when; full text of one release.
- **This is text, not statistics.** A count of press releases is a count of announcements, which depend
  on press office practice, not a measure of prosecutions, convictions or crime. Say so whenever releases
  are counted. For case statistics use the U.S. Sentencing Commission or EOUSA caseload reports (not
  covered here); for crime counts use the `fbi` pack; for court filings, `courtlistener` if present.
- Not here: speeches and congressional testimony (no API endpoint; `/api/v1/speeches.json` answers 404).

## Endpoints and datasets
| Endpoint | Returns | Key parameters |
|---|---|---|
| `press_releases` | releases, newest first by default (50 a page) | `parameters[title]`, `parameters[date]`, `since`, `until`, `fields`, `sort`, `direction` |
| `press_release` | one release with full `body` | `uuid`, `fields` |
| `blog_entries` | blog entries, newest first by default | `since`, `until`, `fields`, `sort`, `direction` |
| `blog_entry` | one entry with full `body` | `uuid`, `fields` |

Fields: `uuid, title, date, created, changed, url, component, topic, teaser, body, number, attachment,
image` (blog: `attachments`). The pack's default `fields` leaves out `body` to keep lists small; ask for
`body` explicitly, or fetch single releases. `--search "topics"` lists the components and topics.

## Spec examples
```json
{"description": "Press releases with 'health care fraud' in the title, January to March 2025",
 "requests": [{"name": "hcf_q1_2025", "endpoint": "press_releases",
   "params": {"parameters[title]": "\"health care fraud\"", "since": "2025-01-01", "until": "2025-03-31"},
   "max_rows": 5000}]}
```
```json
{"description": "All press releases on one day, with full text",
 "requests": [{"name": "releases_2025_06_02", "endpoint": "press_releases",
   "params": {"parameters[date]": "2025-06-02", "fields": "uuid,title,date,component,topic,url,body"}}]}
```
```json
{"description": "One release in full",
 "requests": [{"name": "release", "endpoint": "press_release",
   "params": {"uuid": "2715a413-eb10-4d71-b4fd-9fd3e3eb0c0a"}}]}
```

## Data format and traps
- `date` is a Unix timestamp as text ("1748865600"), the release date. The pack adds `date_iso`
  (YYYY-MM-DD, the release day; releases are stamped at Eastern midnight or later, so the UTC day is the
  Eastern day). `created`/`changed` are web-publishing times and arrive as HTML (verified 2026-10):
  `<time datetime="2009-01-05T14:20:07-05:00">1231183207</time>`; the pack's `created_iso`/`changed_iso`
  take the day of the datetime attribute (Eastern time). `changed` moves with every later edit.
- Title filter (verified 2026-10): `"fentanyl trafficking"` with double quotes matches the phrase (1,012
  releases); without quotes all words in any order (2,191). Matching is case-insensitive substring
  matching on the title only, not the body.
- `parameters[date]` takes one day (YYYY-MM-DD or a Unix timestamp); a month such as "2025-06" returns
  nothing. Ranges use the pack's `since`/`until`: the list is read newest posted first until the postings
  are 14 days older than `since` (see the next point), scanning at most 30,000 records (600 pages); a note
  says when it stopped early.
- Without `sort=date` the API's order is not chronological (an unsorted title search starts in 2014); the
  pack defaults to `sort=date`, `direction=DESC`. The API keeps no stable order among releases of the same
  day (one `date` stamp for about 100 a day), so paging by date repeats some and skips as many (verified
  2026-10: a quarter of 1,500 rows were repeats). The pack therefore pages by `created` (posting time, to
  the second) and returns the rows in date order; with `since` it reads 14 days of postings past it, since a
  release can be posted days before its date (up to 11 seen; one posted earlier still would be missed). A
  `max_rows` cut keeps the newest posted rows (its note says so): for "the latest N by date", fetch a date
  range instead. A release that still comes back twice (one posted during the fetch) is dropped with a note.
  A spec-chosen `sort=created` or `changed` is sent as given.
- `component` and `topic` are lists (JSON text in the CSV); the pack adds `component_names` and
  `topic_names` ("; "-joined). A release can name several components (USAO plus DEA plus FBI) and has
  zero or more topics; topic tagging is inconsistent, especially before about 2015, so do not count by
  topic for trends without checking coverage. U.S. Attorney's Offices appear as "USAO - <State>, <District>".
- **Coverage breaks (verified 2026-10).** Dated releases start in January 2009 (the oldest dated title
  matches; a few records have an empty `date`). U.S. Attorney's Office releases start only in January 2013;
  before then the archive has Main Justice components only (Civil Rights Division, Criminal Division, FBI
  ...), and USAO releases are most of it afterwards. From 2013 one announcement is often posted twice (the
  Main Justice release and a USAO copy with a near-identical title). Any count by year that spans 2013
  compares different sets of offices: start trends in 2013, or count releases that list a Main Justice
  component (`component_names` entries not starting "USAO") for a series consistent across 2013. The fetch
  adds a note when rows predate 2013.
- `body` and `teaser` are HTML; the pack adds `body_text` / `teaser_text` with tags removed. Quote from
  the text, link the `url`. Titles and component/topic names come with HTML entities (`&#039;`); the pack
  unescapes them (`'`).
- `number` (OPA release number such as 25-123) is often empty, especially for USAO releases.
- Releases name defendants. A charge is an allegation: report it as such, and do not compile profiles of
  private individuals.
- The page size is at most 50; more than 4 requests a second may be blocked (DOJ API documentation).

## Access
No key. Route `api` when www.justice.gov answers; the pack sends at most 3 requests a second. Manual
route: `manual_download/INSTRUCTIONS.md` lists one JSON link per page (50 records each, newest posted first);
`since`/`until` are applied when the files are ingested. Without the links: use the filters at
https://www.justice.gov/news (type, component, topic, date range) and copy titles, dates and URLs into a
CSV with columns `title,date_iso,component_names,url`.

## Citation and terms
"U.S. Department of Justice, <press releases / blog, filter>, justice.gov News API, retrieved <date>."
Cite individual releases by title, date and URL. Public domain U.S. government text
(https://www.justice.gov/legalpolicies); photos and quoted third-party material may carry their own
rights. Redistribution allowed. The audit hook requires a report to describe releases as announcements.
