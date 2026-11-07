# Style guide for data reports

The rules that matter for a short data product: summary, exhibit-driven sections, notes and sources, a
data-and-methods appendix, and an optional About This Document. Convention below: **OK** = correct,
**Not** = incorrect. Spelling follows the first entry in Merriam-Webster's online dictionary (www.m-w.com);
otherwise defer to *The Chicago Manual of Style*. These rules distill the house style of U.S. statistical
and policy publishers; they are organization-neutral. Where an organization is named in a report
(`organization` in `report.json`), the examples below write `<Organization>`. One guide for every source;
a pack's `source.md` adds only its own names, units and citation forms (for example the dataset to cite).

## 1. Tone and voice

- **Write for an intelligent, well-informed reader** with no formal economics training. Do not
  talk down; avoid jargon; explain each concept as it comes up.
- **Jargon only when essential for precision, defined at first use.** Short definitions go in parentheses right after
  the term (*the quintile (one-fifth) of households with the highest earnings*); longer ones in a separate sentence or a
  footnote. Or avoid the term altogether. Always define: *mean*, *median*, *quintile*, *standard deviation*,
  *transfers*, *nominal*, *real* (*real earnings (that is, earnings adjusted to remove the effects of inflation)*).
- **Plain English; omit needless words.** OK: *because, now, to, about, use, before, after, later, if, can, help,
  spending, except for, daily, end*. Not: "due to the fact that", "at the present time", "in order to", "for the purpose
  of", "regarding/concerning", "utilize", "prior to", "subsequent to", "upon", "expenditures", "facilitate", "is able
  to", "in the event that", "with the exception of", "period of time", "a larger number of".
- **Active voice.** Passive only to stress the action or when the actor is unknown or unimportant (projections
  often qualify: *Employment is projected to grow*). *will likely* is fine. **No contractions.** Cut *fairly, quite, rather, somewhat*,
  *very* (unless it makes a needed distinction), *lion's share*, *appear to/seem to*. Avoid emphatic *do/did*.
- **Who speaks.** Never "we", "our" or "I" in a report or paper. When the product names an organization, use its
  name: *<Organization> estimates that …* (the full name at first reference in each stand-alone part, then the
  short name or abbreviation; never "the" before an abbreviation). When no organization is named, write in the
  third person: *this analysis*, *the estimates*, *the data show*, *the employment rate was …*. The verb
  *estimates* takes *that*; the noun takes the possessive (*the analysis's estimates of the share*).
- **Say what was done, in plain verbs.** *estimates*, *projects*, *expects*, *finds*, *shows* — not "predicts".
  *assume* is for stated policy or scenario specifications, not for the analyst's own estimates (*the estimates
  are based on …*, *in this analysis's assessment …*). A model or scenario does not "assume"; it *reflects the
  assumption*. *forecast* only for economic projections (past tense *forecast*, Not "forecasted").
- **Neutral tone.** Report what the data show and what a change would do. Do not add policy advice unless the user
  asked for recommendations, and then keep them in a clearly labeled section. Avoid *reform* (implies improvement);
  use *change*. Describe associations; do not imply causation the analysis cannot support.
- **Conditional for anything hypothetical**: *the option would raise...*; *might* (Not *may*) for hypotheticals. *may have*
  = writer does not know; *might have* = could have happened, but did not. Keep tenses in sequence: *if borrowers
  defaulted, the lenders would cover...* / *if borrowers default, the lenders will cover...*. An *if* clause needs no
  subjunctive (*if the funding was insufficient*); keep the subjunctive for demands, requests, and conditions contrary to
  fact (*requires that spending be offset*; *if the program were created now*).
- **Projections:** *would* for outcomes under stated conditions (*if current laws remained in place...*), *will* for
  unconditional statements. Often better: present tense inside the projection (*In these projections, the deficit
  amounts to...*), passive (*is projected to climb*), or infinitive (*the analysis expects real GDP to grow*). Not "the
  analysis projects outlays to exceed"; OK *the analysis projects that outlays will exceed*.
- **People-first language.** *people* (Not "persons"); *individual* only to contrast with a group. *U.S. residents* (or
  *U.S. citizens* when citizenship matters), not "Americans". *non–U.S. national* or a fuller description, not "alien"
  (except in legal terms). *people age 65 or older*, not "the elderly". *workers in blue-collar jobs*, not "blue-collar
  workers". *substance use disorder*. *crewed/staffed*, *work hours*, *personnel/workforce*, not "manned", "man-hours",
  "manpower".
- **Pronouns for an unidentified person:** make it plural, rewrite without a pronoun, use singular *they*, or repeat
  the noun. An organization or legislative body is *it*, never "they".
- **Openers and reference.** *And*/*But* may open a sentence sparingly for emphasis, never a paragraph. Few "There
  are"/"It is" openers. *first, second*, Not "firstly". No "as noted above"/"as discussed above". Point back with
  *that*, not "this" (*this* only for what is about to be mentioned, or inside bulleted lists and options). Never a bare
  "those" or "some": OK *people without health insurance*, *some workers without health insurance*.

## 2. Numbers

- **Zero through nine in words; 10 and up in numerals** (ordinals too, no superscript): *two groups, 10 years, the
  seventh month, the 21st century*.
- **Parallelism:** if any number in a same-category pair or series in the sentence or paragraph is 10+, all are
  numerals: *7 grants in 2025 and 47 grants from 2025 to 2030*. Other categories keep the general rule.
- **Always numerals for**: percentages (*8 percent*), money (*$4 million*, *a 6 cent tax*), ratios (*4 to 1*, *a
  4-to-1 ratio*), units of measure, hours of the day, and **ages of people**: *workers ages 25 to 54*, *people age 65 or
  older*, *a 30-year-old*, *workers in their 40s*, *the under-25 population* (Not "aged 25 to 54"). Ages of things and
  spans of time follow the general rule: *three-year period*, *six hours*.
- **Sentence start:** spell out (*Twenty-five states...*); rewrite to avoid a large number or a year. OK: *Employment
  rose in 2019*; Not: "2019 saw a rise in employment".
- **Large numbers:** commas for 1,000–999,999 (not years or page numbers); from 1 million up, numeral + word: *6 million
  people*, *$57.9 billion*.
- **percent**, one word, spelled out in text and tables — never "%" or "per cent" in text. On a figure, a % or $ sign
  is acceptable when it makes the figure easier to read quickly. *Percent* only after a number (*23 percent of
  workers*); *percentage* for an unspecified share (*rose as a percentage of income*) and as the adjective (*percentage
  change*). Verb agrees with the "of" noun: *40 percent of the spending is*; *35 percent of the workers are*.
- **share vs. percentage:** *share* only for a part of a whole (*the share of workers who were foreign-born*);
  *percentage* also compares two quantities where the first is not part of the second (*rent as a percentage of
  income*). Do not call values expressed as percentages "ratios".
- **Percentage points for differences between percentages.** OK: *the rate rose by 3 percentage points, from 18 percent
  to 21 percent* (an increase of about 17 percent); Not: "rose 3 percent". Plural even below one (*0.2 percentage
  points*), except *1 percentage point* and *0.1 percentage point*. Prefer *a reduction of 9 percentage points* to *a 9
  percentage-point reduction*. Never "percentage points of" something (Not "2 percentage points of GDP").
- **Avoid very large percentages** for changes: *more than quadrupled*, Not "increased by 325 percent". Never "times
  less/lower/smaller" or "times more/higher": OK *one-third as large*, *six times as much as*; *50 percent larger than*
  (Not "half again as large as").
- **about/approximately/roughly** only when a number is rounded more than usual or less precise than numbers nearby
  (*about 20 percent* for a value of 22 percent; plain *22 percent* for 21.8). Not "around".
- **Decimals:** leading zero below one (*0.3 percent*), except quantities that cannot exceed one (*p < .05*, *a
  probability of .95*). Seldom more than two places. Match precision across a series (*18.8 percent ... 20.0 percent*).
- **Fractions:** use decimals for data (*26.5 percent*); fractions only for general statements (*one-third of the
  time*) or policy parameters stated as fractions. Hyphenate spelled-out fractions (*one-fifth*, *two and one-half
  times*). Do not switch between fractions and percentages for similar numbers (*67 percent agreed, and 12 percent were
  undecided*).
- **Zero:** spell out in text. In tables and figures, *0* — never "0.0", "-0", or "0 percent"; a value that rounds to
  zero gets an asterisk and a note (*\* = between zero and 0.5 percent*), defined as narrowly as the values allow.
- **Rounding note**, once, at the front: *Numbers in the text, tables, and figures may not add up to totals because of rounding.*
- **Money:** $ sign for specific amounts, words for indefinite (*several million dollars*); a sum is singular (*$800
  million is...*); *in 2025 dollars* (Not "in constant 2025 dollars"); *current dollars* must be explained at first use.
  No hyphen with money modifiers (*a $3 million increase*). Cents: all *39 cents* in a passage of amounts under a
  dollar, or *$0.89* alongside dollar amounts.
- **Inflation adjustment:** name the index at first use (*adjusted for inflation using the price index for personal
  consumption expenditures (PCE)*, or *using the CPI-U-RS*). Do not use *inflation* for a subset of prices
  (*wage growth*, Not "wage inflation").
- **Values in two units:** second one in parentheses or commas, preceded by *or*: *employment rose by 400,000 (or 6
  percent)*.
- **Ranges.** En dash only when the range precedes the noun (*the 2025–2029 period*), mostly for years and pages; *to*
  when it follows (*the period from 2025 to 2029*). For other values, rewrite (*a loss of $3.7 billion to $4.2
  billion*). Dates: *from . . . to* (Not "between 2010 and 2019"; never mix "from 2010–2019"); do not mix *from . . .
  through* and *from . . . to* in one document. After a verb, drop *from*: *costs were 31 to 40 percent more*. The unit
  need not be repeated (*7 to 11 percent*, *0.5 to 0.6 percentage points*), except for a change over time (*rose from
  4.6 percent to 9.6 percent*). Repeat *million*/*billion* (*$3 billion to $4 billion*).
- **Years** in full: *the 1990s*, *2007–2015* (Not "'90s", "2007–15"); no apostrophe in plural years.
- **Fiscal vs. calendar year:** if a report mixes them, say which in the text; if most years are one type, put a note at
  the front (*Unless this report indicates otherwise, all years referred to are calendar years.*). Spell out and
  lowercase *fiscal year 2024* / *calendar year 2024* — never "FY 2024", "fiscal 2024", "CY 2024". Survey and most
  economic series are calendar-year; budget series are federal fiscal years. Say which in the front notes.
- **Dates:** *October 1, 2023,* (comma after the year mid-sentence); *the October 2023 survey*; *In January 2026,* (comma
  after an introductory date). Seasons lowercase, no "of": *spring 2025*.
- **Comparisons with counts:** *fewer* for countables, *less* for amounts — and *less* for percentages (*less than 60
  percent of people*) and single amounts (*less than 30 minutes*). *more than/over* and *less than/under* are
  interchangeable. *majority* only for countable things; prefer *most*. *by 2031* vs. *in 2031*: use *in* when the event
  happens in that year. *average annual* (Not "annualized"); *annual average* as a noun or column head. *another* only
  when repeating the same number; otherwise *an additional $X* / *$X more*.

## 3. Word usage for economic, labor and demographic analysis

- **affect / effect / impact:** *affect* is the verb, *effect* the noun. Never *impact* as a verb; as a noun only for a
  major effect.
- **compare with / compare to:** *compared with* for differences and similarities (nearly all comparisons in a data
  report); *compared to* only to liken unlike things; *comparable to*. In simple comparisons, prefer a comparative +
  *than*: OK *The rate was 5 percentage points higher in 2022 than in 2020*. "*X grew by 3.5 percent, compared with 2.9
  percent last year*" is acceptable. Compare like with like (Not "Compared with this fiscal year, the request...").
  *similar to*. *relative to* → *in relation to*, *compared with*, or a comparative. *contrast with* (different) / *in
  contrast to* (opposite).
- **data** is always plural (*the data are*); *dataset* (one word), *data file*, *database*.
- **because / since / as / while / with:** *since* for time, *because* for cause; never *as* for "because". *while* =
  at the same time; for contrast use *whereas*, *although*, or *but*. No *with* as a quasi-conjunction: Not "Employment
  rose, with women accounting for most of the gain"; OK *Employment rose; women accounted for most of the gain*. Comma
  before *because* after a negative clause.
- **that / which:** *that* = restrictive, no comma; *, which* = nonrestrictive.
- **based on / on the basis of:** *estimates based on survey data* (modifies a noun) vs. *the share was estimated on
  the basis of survey data* (modifies a verb). At the start of a sentence about the estimates, *On the basis of* (or better,
  *Using*).
- **due to** only after a noun (*the decline due to...*); after a verb, *because of*.
- **include / comprise / consist of:** *include* = partial list; *consists of*, *comprises*, *is composed of* =
  complete. Never "is comprised of".
- **primary / primarily** for one thing only; for several use *key, main, major, principal*, *mainly, mostly*.
- **mean / median:** a mean is an average; a median is the middle value. Always define on first reference and say which
  you report.
- **if / whether:** *if* for a condition, *whether* for alternatives; *whether*, Not "whether or not" (unless it means
  "regardless"). *in which*, not "where", for circumstances.
- **Describing changes.** Prefer the measure itself to "the level of". Then:
  - *rates* (employment, unemployment, participation, poverty), *prices*, *costs*: *higher/lower*, *rise/fall*,
    *increase/decrease* (Not "larger", "grow");
  - *earnings, income, wages*: *higher/lower* (Not "larger/smaller"); *rise, fall, grow, shrink, increase, decrease*;
  - *shares*, *deficits*, *benefits*: *larger/smaller* (Not "higher/lower"); *grow/shrink*, *increase/decrease* (Not
    "rise/fall");
  - *percentages*, *outlays*, *revenues*: either set;
  - *spending*: *higher/lower*; any verb;
  - *growth*: *faster/slower*; *accelerate/slow*.
  When in doubt, *increase/decrease* and *greater than/less than* fit all.
- **rate / share / number of:** *rate* for a defined ratio; *share* for part of a
  whole; *the number of* + singular verb; *a number of* + plural (but prefer *some, several, many*). Define every rate at
  first use (numerator, denominator, universe).
- **Labor terms:**
  - *labor force* (never hyphenated): people age 16 or older in the civilian noninstitutionalized population who have
    jobs or are unemployed (available for work and either actively seeking work or expecting to be recalled from a
    temporary layoff). *workforce* is one word.
  - *labor force participation rate*: the percentage of the civilian noninstitutionalized population age 16 or older
    that is in the labor force.
  - *unemployment rate*: the percentage of people in the labor force who are not working but are available for work and
    either actively seeking work or expecting recall.
  - *civilian noninstitutionalized population*: excludes active-duty armed forces and people in penal or mental
    institutions or homes for the elderly or infirm.
  - *discouraged workers* are not in the labor force.
  - The *household survey* (Current Population Survey) counts people employed; the *establishment survey* counts jobs.
- **Macroeconomic and budget terms** (define each at first use): *real GDP* is GDP adjusted to remove the effects of
  inflation, in *chained 2017 dollars* ("chained", never "constant", for chained-dollar measures); *nominal* = current
  dollars. *Potential GDP* and *the output gap* (real GDP minus potential, as a percentage of potential) carry the
  estimating agency's name; a *positive* gap is output above potential (Not "a surplus"). Growth: *at an annual rate*
  (quarterly change), *fourth quarter to fourth quarter*, or *on a calendar-year basis*; say which every time. Prices
  *rise* and *fall*; the inflation *rate* is *higher* or *lower* (Not "inflation grew"); name the index (*PCE price
  index*, *CPI-U*; *core* = excluding food and energy). Interest-rate changes are in *percentage points* in text (basis
  points only in a table note). *the deficit* (outlays minus revenues), *debt held by the public*, *net interest*;
  deficits and debt are *larger/smaller* and *grow/shrink*, as a *percentage of GDP*. *seasonally adjusted* and *at an
  annual rate* go in the units line. *vintage*: the data as published on a given date (*as first reported*, *as
  revised*); never call a projection "data" (*the agency projects*).
- **Poverty:** *federal poverty thresholds* (Census Bureau, statistical use) vs. *federal poverty guidelines* (HHS,
  program eligibility). "Poverty line/level" only if defined first.
- **Income** is generally singular (*changes in income*); *after-tax* / *before-tax* (Not "posttax"); *individual income
  taxes* (Not "personal income taxes"). *employment-based health insurance* (Not "employer-sponsored"). Quintiles
  are *lowest (bottom), second, middle, fourth, highest (top)*, defined as fifths at first use.
- **Hyphenation of common modifiers:**
  - always hyphenated: *full-time, part-time, well-off, blue-collar, white-collar, well-being, cost-effective,
    labor-intensive, tax-exempt, decision-maker*;
  - hyphenated only before a noun: *low-income/high-income families*, *long-term*, *short-term*, *better-off*,
    *private-sector*, *public-sector*, *out-of-pocket*;
  - never hyphenated: *labor force, health care, income tax, minimum wage* (but *minimum-wage worker*), *child tax
    credit*, *day care*.
  Write *families with low income* first, then *low-income families*. *people in the lowest income category* (no
  hyphen).
- **Closed and fixed forms:** *onetime*, *underway*, *dataset*, *middle-aged*, *socioeconomic*, *postsecondary*, *childcare*, *nonprofit*, *nationwide*,
  *policymaker*, *homeowner*, *layoff* (n.) / *lay off* (v.), *take-up* (n.) / *take up* (v.), *follow-up* (n.).
- **foreign-born / native-born:** hyphenate as compound adjectives before and after the
  noun, following Merriam-Webster. Define each at first use with the Census definition.
- **prime-age:** hyphenate before a noun (*prime-age workers*); define once as *ages 25 to 54*.
- **Race and ethnicity:** call them *racial and ethnic groups*. Capitalize *Black* and *White*; never use
  either as a noun for people (Not "Blacks", "Whites"). *Asian*, *Hispanic* (preferred to *Latino/Latina* for data
  categories), *African American*, *Native American* (*Indian* only in proper names), *Pacific Islander* — never
  hyphenated. List categories alphabetically (*Asian, Black, Hispanic, White*), with the composite group last (default
  name *Some Other Race or Multiracial*). Always explain the scheme: whether categories are mutually exclusive, that all
  people reporting Hispanic ethnicity are in *Hispanic*, which races make up the composite, and (with percentages if
  possible) whether one group dominates it.
- **sex, not gender,** for survey classifications: *classified by age, sex, and family income*.
- **Possessives, not nouns as adjectives:** *workers' earnings*, *the Census Bureau's data*, *hospitals' financial
  performance*, *the government's share*. At most two nouns in a row (three if two form a known compound): *income tax
  rates*, but *changes to income tax rates* (Not "income tax rate changes"). Singular noun after a plural possessive
  (*people whose income is low*; *homeowners ... their primary residence*). *census data*, *the census*.
- **Other choices:** *past* (Not "historical"/"past history"); *during the past year* (Not "the last year"); *method* or
  *approach*, not "methodology" (*analytical method*); *analytical* (Not "analytic"); *selected occupations* (Not "select"); *often* only for repetition
  in time (Not "localities often reported" for "many localities reported"); *across* only for "throughout", not for
  "between/among"; *X, Y, or both*, never "and/or"; *only* right before the word it limits; *usage rates* but *use* as a
  noun; *cut* only when "reduce" vs. "eliminate" is clear; *a false range* ("ranging from bookkeeping to customer
  service") → *include*; *throughout* without "the entire".
- **Spellings:** *toward, upward, judgment, adviser, sizable, preventive, forgo, email, website, web page, the web,
  internet* (lowercase), *PDF*. **Methods after results**, in an appendix if needed.

## 4. Capitalization and punctuation

- **Headline style for titles and headings:** capitalize first, last, and major words; lowercase *a, an, the*, the
  conjunctions *and, or, but, nor, for, so, yet*, and prepositions of three letters or fewer (*in, of, to, for, per*)
  unless part of a verb (*Clean Up*); capitalize prepositions of four letters or more (*With, Through, From*). Both
  parts of a hyphenated compound, including prefix compounds (*Foreign-Born, Long-Term, Anti-Inflationary*); a
  hyphenated suffix stays lowercase. *Versus* spelled out, not italicized, capitalized in titles.
- **Specific parts of a report capitalized:** *Figure 3, Table 2, Appendix A, Exhibit 4*; lowercase general references
  (*the figures in this report*; *see the appendix* when there is only one). *appendixes* (Not "appendices"). First
  callout in the form *see Figure 2* (Not "Figure 2 shows", "refer to Figure 2"); repeat *see* for each (*see Figure 2
  and see Figure 3*); *see Figure 4, top panel*.
- **Lowercase general terms** (*federal, the federal government, state, the program, the act, executive branch*);
  capitalize proper names (*Social Security, Medicare, the Northeast, the South*; but *western Missouri*). Legislative
  bodies and agencies are capitalized when named in full (*the Census Bureau*, *the Bureau of Labor Statistics*).
- **Serial comma:** *age, sex, and education*. No comma between two verbs sharing one subject.
- **Semicolons** before *however/thus/therefore/indeed* joining clauses, and between series items with internal commas.
  *therefore* at a sentence start takes a comma.
- **Colons** only after an independent clause; never between a verb or preposition and its object. Capitalize after the
  colon if a full sentence follows. Periods and commas go inside quotation marks; colons, semicolons, and dashes outside.
- **Dashes:** em dash (—), no spaces, at most one or one pair per sentence. En dash (–) for ranges before a noun
  (*2010–2019*) and multiword compounds (*post–Great Recession*, *New Mexico–Arizona border*).
- **Minus and multiplication signs:** a true minus (−) in text and figures; a hyphen in tables and table/figure notes. A
  true multiplication sign (×), never "x" or "*".
- **Compound modifiers:** hyphenate before the noun (*employment-based insurance*, *cost-of-living adjustment*,
  *inflation-adjusted estimate*), open after (*an adjustment in the cost of living*); never after an *-ly* adverb
  (*federally backed*). Number + noun hyphenated (*five-year period*, *11-year lag*), but not money, percentages, or
  abbreviated units (*11 percent decline*). Series keep suspended hyphens (*low- and middle-income families*). Familiar
  open compounds stay open (*health care costs, income tax receipts, labor force*). *very* drops the hyphen (*a very low
  income family*). Verb phrases are open (*phase out*; *the phaseout*).
- **Prefixes mostly closed** (*nonwhite, postsecondary, socioeconomic, midyear, prepandemic, coworker*); hyphen before a
  capital or number (*mid-2020s, sub-Saharan, post–Cold War*), in multiword compounds (*non-means-tested*), with *all-,
  ex-, self-*, and to prevent confusion (*re-create*). *bimonthly/semimonthly* → *every two months* / *twice a month*.
- **Abbreviations:** use only for terms of three or more words that appear more than a few times. Spell out at first
  use with the abbreviation in parentheses (*American Community Survey (ACS)*), and again in each stand-alone part
  (summary, notes page, box, appendix, About This Document); in a footnote, introduce it only if used more than once
  there. Once introduced, the full name, the abbreviation, or *the survey* are interchangeable. *U.S.* only as an
  adjective; *the United States* as a noun. Plurals take no apostrophe (*the GSEs*); possessives do (*ACS's*). Most
  abbreviations take no periods. *the IRS* but *BLS, EPA, OMB, USDA* (no "the"); be consistent. Treat each source's
  dataset abbreviations (*ACS*, *CPS*, *MTS*, *CPI*) consistently across sections, spelled out at first use in every
  stand-alone part; after the first mention prefer plain names (*the household survey*). Spell out state names in text (*Fall River,
  Massachusetts*); in a crowded table use *Nev., Pa.* (postal codes only with zip codes).
- **No Latin abbreviations in text:** *for example, that is, and others, and so forth, in itself, annually* — Not
  "e.g.", "i.e.", "et al.", "etc.", "per se", "per annum", "vis-à-vis". *per capita, ad hoc, a priori, de facto, versus*
  are not italicized.
- **Quotation marks** for a word or term referred to as itself, at first reference only, and not after *called*,
  *known as*, *referred to as*. Sparingly for emphasis or jargon (rewriting is better).
- **Lists:** items in a sentence go in alphabetical order unless another logic (size, importance) applies. Bulleted
  lists, sparingly: introduce with a complete sentence plus colon; items parallel, first word capitalized; no item longer
  than about one-third of a column. Sentences end with periods; fragments end with commas (semicolons if any item has
  internal commas), with *and*/*or* after the next-to-last item and a period on the last. Key-takeaway bullets may open
  with a boldface sentence-case lead-in. Number a list only for order or later reference.

## 5. Exhibits (tables and figures)

- **Titles** define the data shown (*Employment Rates of People Ages 25 to 54*). Message titles (*Foreign-Born Workers'
  Share Has Grown*) are acceptable only if used consistently through the document. For subgroup comparisons, end the
  title with a *by* phrase: *Share of Veterans Ages 22 to 54, by VA Disability Rating*. Leave years out of the title
  when the axis or column heads show them, unless needed to tell exhibits apart. No two exhibits share a title. Either
  always spell out a name in titles or always abbreviate it (and define it in a note).
- **Units line** under the title, sentence case: *Percent*, *Millions of people*, *2025 dollars*, *Percentage points*.
  The unit is not the idea: Not "Percentage change"; OK unit *Percent* with *Annual Change in ...* in the title. On a
  figure, the unit sits above the y-axis; a non-year x-axis unit goes below the x-axis. A different unit within a table
  goes in parentheses in the row's first entry or the column head.
- **Stubs, column heads, labels, panel heads:** sentence case (capitalize only the first word; nothing in parentheses).
  Totals rows, column heads, and panel heads in boldface. Supplemental rows at the bottom follow a boldface stub
  *Addendum:* (formerly "Memorandum").
- **Captions:** each figure generally gets one, adding reasons or implications rather than restating the chart; numbers
  in a caption should be visible in the figure.
- **Notes, in this order:**
  1. **Data source note.** *Data source: <Organization>.* for the organization's own data; *Data source: <Organization>,
     using data from [sources, alphabetically].* when the analysis modified others' data (growth rates, tabulations,
     fiscal-year totals, weighting, inflation adjustment — that is, most exhibits). When no organization is named: *Data source: Analyst calculations
     using data from [sources].* *Data sources: Bureau of Labor Statistics; Census Bureau.* for unmodified data. Name
     the survey or series when it helps, note revision dates for revised data, and say which source covers which part.
     A data-and-methods appendix may be cited: *using data described in Appendix A*. End with the URL where the
     exhibit's data are posted, if any. No abbreviations in source notes (*the staff of the Joint Committee on
     Taxation*; *Bureau of Labor Statistics*, Not "BLS" at first mention).
  2. **General notes**, broadest first; in multipanel exhibits, in panel order.
  3. **Abbreviations note:** abbreviations alphabetically, then *n.a. = not applicable*, *N.A. = not available*, *n.e. =
     not estimated*, then asterisk notations (*\* = between zero and 0.5 percent*). *GDP* needs no definition.
  4. **Footnotes** to specific cells or labels, with superscript lowercase letters ordered left to right, top to bottom.
- **Recessions** shaded in figures get the note *Shaded areas indicate recessions as dated by the NBER* (builder adds it).
- **Referring to a stub or label in text:** quote it as capitalized in the exhibit, with a singular verb (*"Other
  sources" consists of...*), or describe it generically to avoid the quotation marks.
- Rounding note once at the front; table zeros per Section 2.

**Standard pattern for exhibits:**
- Label *Exhibit n.* (or *Figure n.*); number consecutively; appendix exhibits get their own sequence (*Figure A-1*).
- **Data source line:** name the original agency and the dataset or series, then any intermediary: *Data source:
  Analyst calculations using data from the Bureau of Labor Statistics (Current Population Survey, series LNS14000000),
  retrieved October 20, 2026.* For data reached through an aggregator, *... from the Bureau of Economic Analysis,
  retrieved from FRED, Federal Reserve Bank of St. Louis*; for microdata, *... as provided by IPUMS USA*. With several
  sources, list them alphabetically and say which covers which part. Or *Data source: <Organization>, using data from
  …* when an organization is named. Give the retrieval date or vintage for data that are revised. The audit checks that
  every source line names a source the report used.
- **General notes:** full sentences ending in periods, in this order: the measure and universe (*civilian employees
  on board at the end of September*, *people ages 25 to 54*); definitions; period basis (*Years are federal fiscal
  years, which run from October 1 to September 30.*); seasonal adjustment; weighting; dollar year and price index;
  preliminary, projected or missing values (*Data for October 2025 were not collected.*); redaction or suppression;
  sign conventions (*A positive value is a deficit.*); the vintage when not the latest; recession shading (the builder
  adds the note).
- **Text callouts:** *see Exhibit 2*; each section opens with its key finding and the exhibit supports it.

## 6. Footnotes and references

**Footnotes in text:** use them to cite an authority or give a brief explanation (or a long definition), and keep them
few — if most readers would ask the question, answer it in the text. Number consecutively, restarting in the summary,
each chapter, each appendix, and each box. Place the number at the end of the sentence, after the punctuation, one per
sentence (combine sources into one note); every footnote ends with a period. Give the full reference each time (no
short-form repeats); *ibid.* (not italicized) for a source identical to the preceding note. Multiple references:
reverse chronological order, separated by semicolons. Omit "the" before organizations, periodicals, and publishers in
citations. Use headline-style capitalization for titles but keep the source's own hyphenation (en dash for year ranges).

**Reference format:** Author, *Title*, extra information (Publisher, Date), pages, URL.
- Author: first and last names; more than three authors → *and others* (Not "et al."); an organization can be the
  author.
- Titles: italics for books, reports, and journals; quotation marks and roman type for articles, web pages, and
  datasets.
- Date in parentheses; a web page with no date gets *(accessed Month Day, Year)*.
- URL: drop "http://" when the address has "www."; link to a summary page rather than a PDF, and give a PDF's file size
  if you must link to one (*(3 MB)*); DOI for journal articles; never a URL alone.
- Court cases in italics with italic *v.*, naming the court and year in text.
- Examples: *Bureau of Labor Statistics, "Foreign-Born Workers: Labor Force Characteristics—2023," news release
  (May 2024), www.bls.gov/news.release/forbrn.nr0.htm.* — *Rose M. Kreider and Diana B. Elliott, America's Families and
  Living Arrangements: 2007, Current Population Reports P20-561 (Census Bureau, September 2009), www.census.gov/...* —
  *Kenneth A. Couch and Dana W. Placzek, "Earnings Losses of Displaced Workers Revisited," American Economic Review,
  vol. 100, no. 1 (March 2010), pp. 572–589, https://doi.org/10.1257/aer.100.1.572.* — web page or data table:
  *Organization, "Page Title" (date or accessed date), Table n, URL.*
- **Datasets and series** (data-table rule)**:** *Agency, "Dataset or Table Title" (dataset, accessed Month Day,
  Year), Table n, URL.* Copy the citation the source asks for from `data/<id>/README.md` (each pack writes it, for
  example a series citation with its ID, an extract's DOI and version, or a statement's table number). Required notices
  (API terms such as "uses the ... API but is not endorsed or certified by ...", or a statement that the agency cannot
  vouch for derived analyses) are added by the report builder from each source's policy; never drop them and never use
  an agency's logo.

## 7. Editor's checklist

1. No "we"/"our"/"I"; the organization by name (full name at first reference in each stand-alone part) or the third
   person (*this analysis*); *estimates that*; no "predicts"/"assumed" for the analysis's own estimates; no
   contractions; no unrequested advice; no "reform"?
2. Every technical term, rate, universe, mean/median, *real*, and abbreviation defined at first use — and again in each
   stand-alone section?
3. Zero–nine spelled out, 10+ numerals, same-category series consistent; no sentence starts with a numeral or a year?
4. *percent* spelled out; *percentage points* for differences (never "of GDP"); *share* only for part of a whole; no
   "times less"; no huge percentage changes?
5. Ranges: en dash only before a noun; *from X to Y* for dates (no "between"); unit repeated only for a change over time;
   years in full?
6. Ages as *ages 25 to 54*, *age 65 or older*, in numerals; no "the elderly"?
7. Calendar-year, rounding, retrieval-date and vintage notes at the front; dollar year and price index named (*in
   2025 dollars*); preliminary and projected values called so?
8. Hyphens: *full-time/part-time/well-off* always; *low-income* only before a noun, after *families with low income* at
   first use; none after *-ly*; *very* drops it?
9. Word choices: *data are*, *dataset*, *compared with* (or *than*), *affect/effect*, *because* (not "since"/"as"),
   *whereas/although* (not "while") for contrast, no *with* clauses, *that/which* commas, *fewer/less*, *due to* only
   after a noun, *analytical*, *method*?
10. Change verbs fit the measure: rates and wages *higher/lower, rise/fall*; shares *larger/smaller, grow/shrink*;
    growth *faster/slower*?
11. Race and ethnicity: *Black*, *White* capitalized and never nouns; categories alphabetical with the composite last;
    scheme explained; *sex* for the survey variable?
12. Pronouns: no "he or she"; singular *they* or a plural rewrite; organizations are *it*?
13. Titles and headings in headline style (*Anti-Inflationary*); serial comma; first callouts as *see Exhibit n*?
14. Every exhibit: number, title (with *by* for subgroups), units line, then notes in order — *Data source:* line (no
    abbreviations, sources alphabetical), general notes (universe, definitions, weights, years), abbreviations,
    lettered footnotes; stubs in sentence case?
15. Table zeros as *0* or an asterisk with a narrow note; true minus in text and figures, hyphen in tables; decimals
    consistent within each series?
16. Footnotes: full references ending in periods, one per sentence, after the punctuation; URLs to summary pages; PDF
    sizes noted?
17. None of "e.g.", "i.e.", "etc.", "et al.", "utilize", "prior to", "regarding", "upon", "around" for approximately,
    "appear to", "lion's share", "Americans", "and/or", "methodology", "data set", "Internet"?
