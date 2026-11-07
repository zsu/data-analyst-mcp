# Regulations.gov (API v4)
Depth: standard. Key: optional (DATA_GOV_API_KEY; the public DEMO_KEY works at about 10 requests an hour).
Federal rulemaking dockets, the documents in them (proposed and final rules, notices, supporting
material) and the public comments agencies have posted.

## When to use
- How many comments a docket or proposed rule has (posted), comments over time, documents in a docket,
  rules open for comment now, dockets an agency opened, comment deadlines.
- Not here: the published rule text and Federal Register metadata such as significance, executive
  orders, page counts by year (federal-register); CFR text (govinfo); bills (congress). Agencies with
  their own comment systems (SEC, FCC, FERC) are missing or incomplete.

## Endpoints and datasets
| Endpoint | Returns (one row per) | Key parameters |
|---|---|---|
| `documents` | document | `filter[searchTerm]`, `filter[agencyId]`, `filter[docketId]`, `filter[documentType]` (Proposed Rule, Rule, Notice, Supporting & Related Material, Other), `filter[frDocNum]`, `filter[withinCommentPeriod]`, `filter[commentEndDate][ge/le]`, `filter[postedDate][ge/le]`, `sort` |
| `document` | one document (full metadata) | `documentId`, `include=attachments` |
| `comments` | posted comment (id, title, dates) | `filter[docketId]` or `filter[commentOnId]` (document objectId), `filter[agencyId]`, `filter[searchTerm]`, `filter[postedDate][ge/le]`, `filter[lastModifiedDate][ge/le]`, `sort` |
| `comment_count` | one row: the filters and `totalElements` | same filters as `comments` |
| `comment` | one comment with its text | `commentId`, `include=attachments` |
| `dockets` | docket | `filter[searchTerm]`, `filter[agencyId]`, `filter[docketType]` (Rulemaking, Nonrulemaking), `sort` |
| `docket` | one docket (title, RIN, abstract) | `docketId` |

Columns drop the API's `attributes.` prefix (values unchanged). IDs: docket `EPA-HQ-OAR-2023-0072`;
document `EPA-HQ-OAR-2023-0072-0001` (docket + sequence); `objectId` (`0900006485a3507a`) is a separate
internal id, the one `filter[commentOnId]` needs. `--search` lists catalog aliases (agency acronyms).

## Spec examples
```json
{"description": "Power-plant greenhouse gas rule: proposed rule documents and posted comments",
 "requests": [
  {"name": "docket_rules", "endpoint": "documents",
   "params": {"filter[docketId]": "EPA-HQ-OAR-2023-0072", "filter[documentType]": "Proposed Rule"}},
  {"name": "docket_comments", "endpoint": "comment_count", "params": {"filter[docketId]": "EPA-HQ-OAR-2023-0072"}}]}
```
```json
{"description": "EPA proposed rules posted in 2025",
 "requests": [{"name": "epa_prop_2025", "endpoint": "documents",
   "params": {"filter[agencyId]": "EPA", "filter[documentType]": "Proposed Rule",
              "filter[postedDate][ge]": "2025-01-01", "filter[postedDate][le]": "2025-12-31"},
   "max_rows": 2000}]}
```
```json
{"description": "Rules open for comment now at FDA",
 "requests": [{"name": "fda_open", "endpoint": "documents",
   "params": {"filter[agencyId]": "FDA", "filter[withinCommentPeriod]": "true", "sort": "commentEndDate"}}]}
```

## Data format and traps
- Posted is not received. `comment_count` and `comments` count comments the agency posted. Agencies post
  one copy of a mass-mail campaign (the rest counted in the agency's own tally or attached), withhold
  abusive or duplicate submissions, and post with delays. Example: docket EPA-HQ-OAR-2023-0072 showed
  8,202 posted comments in Oct 2026; an agency's own "comments received" figure can be much larger.
  Say "posted comments".
- A docket's comments cover every document in it; comments on one rule need `filter[commentOnId]` with
  that document's `objectId` (not its documentId). New documents can show 0 comments for weeks.
- At most 10,000 rows per query: page size 250, page number at most 40 (HTTP 400 above). For more, sort by
  `lastModifiedDate` and repeat with `filter[lastModifiedDate][ge]` set to the last value seen, or split
  by `filter[postedDate]` ranges.
- Date filters: `filter[postedDate]` and `filter[commentEndDate]` take `YYYY-MM-DD`;
  `filter[lastModifiedDate]` takes `YYYY-MM-DD HH:MM:SS` (Eastern time). Returned timestamps are UTC
  (`2023-05-23T04:00:00Z` is May 23 Eastern).
- `documentType` values are labels with spaces and capitals ("Proposed Rule"); "Rule" means final rule.
  `subtype` adds detail ("Supplemental Notice of Proposed Rulemaking (SNPRM)", "Extension of Comment Period").
- List rows hold only summary fields; full text and submitter fields need `comment` or `document`, one call
  each. Comment titles often contain the submitter's name as posted.
- `withdrawn` documents and comments stay in results with `withdrawn=True`; filter them out when counting.
- Agency coverage varies: agencies joined Regulations.gov at different times and some post only part of
  their dockets; independent agencies such as SEC, FCC and FERC use their own systems.

## Access
Key optional: DATA_GOV_API_KEY (free, https://api.data.gov/signup/), sent as the `api_key` query
parameter. Without it the pack uses `DEMO_KEY`: about 10 requests an hour per IP address on this API
(observed X-RateLimit-Limit 10), enough for a few small requests; a key allows 1,000 an hour (observed).
Larger specs make `--check` ask for the key. Manual route: INSTRUCTIONS.md lists JSON links with
`api_key=DEMO_KEY` (one per 250 rows); open each in a browser, save it, upload. On www.regulations.gov a
docket's Browse Documents / Browse Comments lists have a Download button (CSV).

## Citation and terms
"Regulations.gov API v4 (eRulemaking Program, GSA), <query>, api.regulations.gov, retrieved <date>."
Agency documents and metadata are public domain; redistribution allowed. Required notice: comments are
posted as received and posted counts differ from comments received. Comment attachments can contain
copyrighted material or personal details; report counts and metadata, quote sparingly.
