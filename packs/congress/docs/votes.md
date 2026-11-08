# Congress votes: roll calls, party totals and member ids

From the congress playbook's "Data format and traps" section: read it before a request of this kind.

- Votes: a bill usually has several recorded votes (cloture, motions to proceed, amendments, passage,
  conference). `bill_votes` lists every one with the action text. Final passage is each chamber's LAST
  recorded vote that cleared the bill ("On Passage", "On Passage of the Bill", "On Motion to Concur ...",
  "On Agreeing to the Conference Report"): take the latest date, not the first "On Passage". A bill used
  as a vehicle for other text (CHIPS and Science moved as H.R. 4346, first passed as a legislative-branch
  appropriation) has an early "On Passage" vote on the old text; the Clerk's `description` can keep the
  old title. Voice votes and unanimous consent leave no roll call and no row.
- Party totals: House rows take the Clerk's totals by party; Senate rows are counted from the member
  list (`yea_D`, `nay_R`, ...; independents as I). `not_voting` counts absent members; vacant seats are
  not counted anywhere, so totals can be under 435 or 100. The Vice President's tie-breaking vote is in
  `tie_breaker`, not in the member rows.
- Member ids differ by source: House rows and Congress.gov use bioguide ids (A000370); Senate XML uses
  LIS ids (S354). Join Senate votes to members by name and state, or a crosswalk, not by id.
- `vote` keeps the published word (Yea, Aye, Nay, No, Present, Not Voting, Guilty); `position` maps it
  to yea, nay, present, not_voting or other. House "Aye"/"No" are recorded votes, same meaning.
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
