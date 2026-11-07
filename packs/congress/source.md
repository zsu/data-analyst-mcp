# Congress.gov API (Library of Congress) with House and Senate roll-call votes
Depth: standard. Key: optional (DATA_GOV_API_KEY; the public DEMO_KEY works at about 10 requests an
hour; roll-call XML needs no key). Bills, actions, cosponsors, CRS summaries, laws, members, committees,
committee reports, hearings, nominations, treaties and CRS reports from Congress.gov, and member-level
roll-call votes from the House Clerk (1990 on) and the Senate (1989 on).

## When to use
- Status, actions and sponsors of a bill; cosponsors by party; bills a member sponsored; laws enacted per
  Congress; how each party and member voted; committee referrals and reports; nominations and
  confirmations; CRS reports and summaries.
- Not here: full text search of bills and the text itself (govinfo `search`, `text`); rules and
  executive orders (federal-register); lobbying on a bill (senate-lobbying); campaign money (fec).

## Endpoints and datasets
| Endpoint | Returns (one row per) | Key parameters |
|---|---|---|
| `bills`, `bills_congress` | bill (number, title, `introducedDate`, latest action) | `congress`, `billType`, `fromDateTime`, `toDateTime`, `sort` (`updateDate+desc` default, `updateDate+asc`, `introducedDate+desc`, `introducedDate+asc`), `title_contains` |
| `bill` | one bill (sponsor, policy area, laws, counts) | `congress`, `billType`, `billNumber` |
| `bill_actions`, `bill_cosponsors`, `bill_committees`, `bill_subjects`, `bill_summaries`, `bill_text`, `bill_titles`, `bill_related`, `bill_amendments` | action, cosponsor, committee, subject, summary, text version, title, related bill, amendment | same three |
| `bill_cbo_estimates` | cost estimate listed for the bill: title, date, cbo.gov link | same three |
| `bill_votes` | recorded vote on the bill with totals by party (`members: true`: member x vote) | same three, `chamber`, `members` |
| `roll_call` | member's vote on one roll call | `chamber` (house, senate), `roll`; House `year` or `congress`+`session`; Senate `congress`+`session` |
| `senate_votes` | Senate vote in a session (date, issue, question, result, yeas, nays; `en_bloc` = nominations voted together, their issues joined by "; ") | `congress`, `session` |
| `house_votes`, `house_vote` | House vote (115th Congress, 2017, on); party totals for one vote | `congress`, `session`, `voteNumber` |
| `laws`, `laws_congress` | law (public or private) | `laws`: `congress`, `lawType` (pub, priv; path /law/{congress}/{lawType}); `laws_congress`: `congress` only, public and private together (a `lawType` param there is ignored by the API) |
| `summaries` | CRS summary updated in a period | `congress`, `billType`, `fromDateTime` |
| `members`, `members_congress`, `members_state`, `members_district`, `member` | member (bioguideId, party, state, terms) | `congress`, `stateCode`, `district`, `currentMember`, `bioguideId`. `members_congress` lists everyone who served at any time in that Congress (later entrants too); `partyName` is the current party; `terms` merges continuous service in a chamber into one start/end-year item (no swearing-in dates). Membership on a date (e.g. the opening day) comes from that day's roll calls; the Senate may hold none on the opening day (2025: first on Jan 9), and the House's quorum call and first vote can differ by a member. A current member's `terms` item has no `endYear`. Members seated in the lame duck before a Congress (Kim, Schiff in Dec 2024) have `startYear` the year before: "first elected in November" counts them. Join Senate XML to Congress.gov names without accents ("Lujan"/"Luján") |
| `member_sponsored`, `member_cosponsored` | bill a member sponsored or cosponsored | `bioguideId` |
| `committees`, `committee`, `committee_bills`, `committee_bills_congress`, `committee_reports`, `hearings` | committee, bill, report, hearing | `congress`, `chamber`, `committeeCode` (hsba00), `reportType` (hrpt, srpt, erpt). `committee_bills` spans every Congress (`fromDateTime` filters on update date); `committee_bills_congress` takes `congress` and returns that Congress only and gives one row per bill with only its **latest** committee activity and that date: count referrals as all rows of the bills of that Congress except "Reported Original Measure" and "Bills of Interest", never only "Referred To" rows, and take referral dates from `bill_committees` |
| `hearing` | one printed hearing: title, dates held, committees, citation | `congress`, `chamber`, `jacketNumber` (from `hearings`) |
| `nominations`, `nomination`, `nomination_actions` | nomination (PN), its actions | `congress`, `nominationNumber` |
| `treaties`, `amendments`, `congress_info` | treaty, amendment, session dates | `congress` |
| `committee_meetings`, `committee_meeting` | meetings of a chamber's committees (hearings, markups, business meetings); one meeting: date, type ("Open Hearing", "Markup"), title, committees, status | `congress`, `chamber` (house, senate, nochamber), `eventId`. The list has only eventIds: `for_each` over it for dates and committees (about one call per meeting; check the count). `hearings` is printed hearings only. A meeting's `committees` can lack `name` and can repeat a systemCode: deduplicate by code and take names and parents from `committees`. Status: count Scheduled and Rescheduled (the record carries the new date), not Canceled or Postponed. A reconvened markup is its own event; Rules Committee sessions are all typed "Meeting" |
| `amendments_type`, `amendment` | amendments of one type; one amendment (submittedDate, purpose, amended bill) | `congress`, `amendmentType` (samdt, hamdt, suamdt), `amendmentNumber`. Lists carry no submitted date (most rows have no latestAction either); amendment numbers run in submission order, so a count by a date is the highest number submitted by then: read the boundary amendments' `submittedDate` with `amendment` (or `for_each`) |
| `crs_reports`, `crs_report` | CRS report (id, title, date, status); one report with authors, summary, links | `fromDateTime`, `toDateTime`, `title_contains`, `reportNumber` |

`congress` may be `"current"`. Bill types: hr, s, hjres, sjres, hconres, sconres, hres, sres.
`title_contains` keeps rows whose title holds the phrase as given: its words in that order, each matching
at the start of a word, any case ("water rights" never matches "Rights of ... Water Users"; "port" never
matches "support", but "veteran" finds "Veterans"); a list keeps titles holding any of its phrases (forms
that do not start the same: `["levy", "levies"]`). To match words in any order or apart, list each form
as its own phrase (`["water rights", "rights to water"]`) or filter on one distinctive word and read the
titles in the CSV: this matters most for `crs_reports`, where `title_contains` is the only text filter; a
multi-word phrase that keeps nothing says so in the error or note. It filters after download, so combine
it with `max_rows` or a date range. It reads the list's display `title` only: a bill whose official title alone has
the word is missed (often more bills than the display titles hold), and the fetch notes this every time.
**For "X in the title", the route is GovInfo's title search, never a full-text phrase search** (`phrase`
searches the whole text and misses many bills): source govinfo, endpoint `search`, params
`{"collection": "BILLS", "congress": 118, "title": "<phrase>"}` (one per word form, or
`query: "title:tariff OR title:tariffs"`), strip the version suffix from `packageId` and deduplicate, then
confirm each bill with `bill_titles` (`for_each` on congress, billType, billNumber); say which title the count uses. `--search votes` lists catalog aliases (committee codes, bill types).

## Spec examples
```json
{"description": "Laken Riley Act (119th S. 5): bill, cosponsors and every recorded vote by party",
 "requests": [
  {"name": "s5_bill", "endpoint": "bill", "params": {"congress": 119, "billType": "s", "billNumber": 5}},
  {"name": "s5_cosponsors", "endpoint": "bill_cosponsors", "params": {"congress": 119, "billType": "s", "billNumber": 5}},
  {"name": "s5_votes", "endpoint": "bill_votes", "params": {"congress": 119, "billType": "s", "billNumber": 5}}]}
```
```json
{"description": "How each member voted on final passage of H.R. 5376 (117th) in both chambers",
 "requests": [
  {"name": "senate_325", "endpoint": "roll_call", "params": {"chamber": "senate", "congress": 117, "session": 2, "roll": 325}},
  {"name": "house_420", "endpoint": "roll_call", "params": {"chamber": "house", "year": 2022, "roll": 420}}]}
```
```json
{"description": "Public laws of the 118th Congress and CRS reports updated since September 2026",
 "requests": [
  {"name": "laws_118", "endpoint": "laws", "params": {"congress": 118, "lawType": "pub"}},
  {"name": "crs_fall", "endpoint": "crs_reports", "params": {"fromDateTime": "2026-09-01T00:00:00Z"}}]}
```

## Data format and traps
- Congress numbers: the n-th Congress runs two years from January 3 of 1789 + 2(n-1) (March 4 before
  1935): 119th = 2025-2026, 118th = 2023-2024. January 1-2 of an odd year still belong to the previous
  Congress. Session 1 is the odd year, session 2 the even year (a session can run into early January).
- Bill numbers restart every Congress: always carry `congress` and `billType` with the number.
- Counting bills: the `bills` list includes numbers "Reserved for the Speaker" / "Minority Leader" (no
  `latestAction`, no bill): drop them (11 in the 119th) to match the Résumé of Congressional Activity.
  "Passed the House": a House passage action in `bill_actions` (actionCode 8000, "Passed/agreed to in
  House"), or any later Senate or presidential action; never infer it from `latestAction` text ("Motion to
  reconsider laid on the table" follows failed votes too). Paged lists print no call count in `--check`:
  count about one call per 250 rows.
- Congressional Review Act disapprovals: joint resolutions whose titles read "Disapproving the rule
  submitted by ..." (older) or "Providing for congressional disapproval under chapter 8 of title 5" (newer):
  match "disapprov", then drop D.C. Council disapprovals (Home Rule Act, e.g. H.J.Res. 142 of the 119th).
- Becoming law: `bill.laws` (and `latestAction.text` "Became Public Law No: 119-1.") marks enacted
  bills; `laws` lists them. `latestAction` is not always the enactment (a committee report filed after
  signing replaces it: H.R. 1043, PL 119-68): count laws from `laws`, and take the signing date from
  `bill_actions` ("Became Public Law"), never from `latestAction.actionDate`. The `bills` lists carry
  `introducedDate` (and sort by it) but no `policyArea`; the `laws` lists carry neither and ignore `sort`
  (verified 2026-10-22): those need one `bill` call per law, a second spec with
  `"for_each": {"csv": "data/congress/<laws>.csv", "map": {"billType": "type", "billNumber": "number"},
  "lower": true}` (bill numbers repeat across types; `--check` gives the call count). Counting "bills passed" needs a chamber action, not `latestAction` alone.
- Votes: a bill usually has several recorded votes (cloture, motions to proceed, amendments, passage,
  conference). `bill_votes` lists every one with the action text. Final passage is each chamber's LAST
  recorded vote that cleared the bill ("On Passage", "On Passage of the Bill", "On Motion to Concur ...",
  "On Agreeing to the Conference Report"): take the latest date, not the first "On Passage". A bill used
  as a vehicle for other text (CHIPS and Science moved as H.R. 4346, first passed as a legislative-branch
  appropriation) has an early "On Passage" vote on the old text; the Clerk's `description` can keep the
  old title. Voice votes and unanimous consent leave no roll call and no row.
- Zero rows can be the right answer (no private laws in the 118th Congress, no votes on a bill): mark
  such requests `"allow_empty": true`, or the fetch stops and names them.
- Party totals: House rows take the Clerk's totals by party; Senate rows are counted from the member
  list (`yea_D`, `nay_R`, ...; independents as I). `not_voting` counts absent members; vacant seats are
  not counted anywhere, so totals can be under 435 or 100. The Vice President's tie-breaking vote is in
  `tie_breaker`, not in the member rows.
- Member ids differ by source: House rows and Congress.gov use bioguide ids (A000370); Senate XML uses
  LIS ids (S354). Join Senate votes to members by name and state, or a crosswalk, not by id.
- `vote` keeps the published word (Yea, Aye, Nay, No, Present, Not Voting, Guilty); `position` maps it
  to yea, nay, present, not_voting or other. House "Aye"/"No" are recorded votes, same meaning.
- Cosponsors: `sponsorshipWithdrawnDate` marks withdrawals (still listed);
  `cosponsors.countIncludingWithdrawnCosponsors` in `bill` counts them. Count by `party` for a party split.
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
  exceed Python's csv limit: read with pandas or call `csv.field_size_limit(10**8)` first.
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
- Paging: 250 per request (`limit`/`offset`). Lists default to the newest update first.
- Vetoes: a vetoed bill's `latestAction` often is a later procedural step, and no endpoint filters bills by
  action. Read `bill_actions` (for_each over candidate bills that passed both chambers and are not law) for
  the action "Vetoed by President" (actionCode 31000 in 2026 data) and override votes ("...objections of the
  President to the contrary notwithstanding"). The Senate's veto page (senate.gov/legislative/vetoes, regular
  and pocket vetoes per President) is the benchmark. Reserved bill numbers (H.R. 1-10, S. 1-10 for leaders)
  have no actions: allow_empty or drop them first.
- Whole-session vote counts and party splits: no endpoint returns party totals in bulk, so a session takes
  one `roll_call` per vote (about 1,000 a year, several minutes). For the House's questions and results
  (`house_votes` has no question column; `house_vote` keeps only party totals), `for_each` over the
  `house_votes` list's `rollCallNumber` with `roll_call` `"summary": "true"` and the year: one row per vote with
  question ("On Motion to Suspend the Rules and Pass"), vote type ("2/3 YEA-AND-NAY"), result and totals. `house_votes` lists quorum calls too (vote
  type "Quorum"): the Résumé counts them apart from yea-and-nay and recorded votes. The Speaker election's
  member rows have position `other` (votes are names). Say how independents are counted in a party split.
- `house_votes`/`house_vote` (Congress.gov) start with the 115th Congress (2017; the 114th lists 0 votes,
  verified 2026-10-22); `roll_call` reads the Clerk
  XML for 1990 on (and falls back to the Congress.gov member list for the 115th on if the Clerk file
  cannot be read). Senate XML covers the 101st Congress (1989) on.
- Dates: Congress.gov timestamps are UTC (`2025-01-22T...Z`); vote `date` is the vote's own calendar
  date (ISO), `date_published` keeps the source text.

## Access
Key optional: DATA_GOV_API_KEY (https://api.data.gov/signup/), sent as `api_key` to api.congress.gov
only (Congress.gov documents 5,000 requests an hour for a key; DEMO_KEY about 10 an hour per IP, observed
limit 10). Specs needing more than a few Congress.gov calls make `--check` ask for the key. House Clerk
and Senate XML need no key. Manual route: INSTRUCTIONS.md lists Congress.gov JSON links with
`api_key=DEMO_KEY` and the vote XML links (clerk.house.gov/evs/<year>/roll<NNN>.xml;
www.senate.gov/legislative/LIS/roll_call_votes/vote<congress><session>/vote_<c>_<s>_<NNNNN>.xml);
for `bill_votes` the bill's actions JSON lists each vote's XML link. Upload the files for `--ingest`.
senate.gov sometimes refuses scripts (HTTP 403, seen from some networks in Oct 2026; `--check` tries it when
the spec needs Senate votes): the route is then `manual_download`. Without a user to save the XML, the
Congressional Record prints each Senate roll call's names. The reliable path is the page: the vote's
`bill_actions` text cites it ("Record Vote Number: 7 ... (CR S250-251)"); list that day's issue with govinfo
`granules` (`packageId` CREC-<date>), take the Senate granule whose id holds the page (`...-PgS250`, or the
last one starting before it), and read it with govinfo `text` (`packageId` + `granuleId`); check the
`[Rollcall Vote No. 7 Leg.]` line in it. A `search` (collection CREC, `phrase: "Rollcall Vote No. 7 Leg"`)
can find it too but missed 2 of 4 votes in Jan 2025 tests: never treat an empty search as "no vote". The
Record lists names only (YEAS / NAYS / NOT VOTING): take party and state from `members_congress`, and say the
split came from the Record. Votes print under the legislative day, which can be an earlier date (the Senate's
July 1, 2025 votes are in `CREC-2025-06-30`). Request House votes alone (`"chamber": "house"`) so a Senate
block does not stop them. A whole session of Senate votes (counts, shares by question) comes from the Daily
Digest: govinfo `published` CREC for the session's dates, `granules` for_each, keep the Daily Digest Senate
granules, `text` for_each, then parse "(Vote No. N)" and the running "(Total--N)". Traps seen in 2025: a few
votes are not numbered in the Digest (take them from the Record's Senate pages), the form "(Vote 569)" and page
markers inside a reference, a misprinted number (the running total proves the right one), and Digests that
reprint earlier votes (deduplicate by number). "Ex."/"Leg." marks the session the vote was taken in, not its
subject: classify nominations by the question text. Benchmark the count with the Résumé of Congressional
Activity (Daily Digest, early January: 659 Senate yea-and-nay votes in 2025).

## Citation and terms
"Library of Congress, Congress.gov API, <query>, api.congress.gov, retrieved <date>"; for votes add
"roll-call votes from the Clerk of the U.S. House of Representatives (clerk.house.gov) and the U.S.
Senate (senate.gov)". Public domain legislative data; attribute the source. Redistribution allowed.
