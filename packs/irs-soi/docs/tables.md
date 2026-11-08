# IRS SOI published tables (table, table_list)

From the irs-soi playbook's "Published tables (`table`, `table_list`)" section.

SOI publishes its national statistics as .xls/.xlsx workbooks, one per table and year. `packs/irs-soi/tables.json`
catalogs 125 of them (checked 2026-11-08); `table_list` lists them (`product`, `query`; `live: true` adds the
years posted now). File names change over the years (the Data Book renumbered its tables in 2006, `97in11.xls`,
`ccr`/`nr`/`tabl` suffixes), so the adapter reads the table's index page and takes the year's link from it; a link
the page gets wrong is corrected in the catalog (`overrides`: partnership Tables 5 and 7 for 2023).

| Product (ids) | Tables | Years | Year |
|---|---|---|---|
| Individual, Publication 1304 (`in_1.1` ... `in_3.6`) | 1.1 income and tax by size of AGI, 1.2 by marital status, 1.4 sources of income, 1.4A capital gains, 1.6 age, 1.7 dependents, 2.1 itemized deductions, 2.5 EITC, 2.7 ACA, 3.1-3.6 tax computation, tax by rate (3.5: income taxed at each rate) | TY1996-2023 | tax year |
| Individual, percentiles (`shares_4.1`, `shares_4.2`, `shares_4.3`) | returns, AGI floor, AGI, income tax, average tax rate and shares, top 0.001% ... top 50% and bottom 50% | 2001-2023 in one file | edition |
| Corporations, Publication 16 (`corp_1` ... `corp_14`) | 1 minor industry, 2.1-2.4A size of total assets (2.3 C corporations, 2.4 S corporations), 3.x size of receipts, 4 size of tax, 5.x minor industry, 6-9 S corporations, 10 foreign (1120-F), 11 tax and credits, 12-14 COGS, depreciation, research credit; `corp_1-CV` coefficients of variation | TY2014-2023 (Table 1 from 1994) | tax year |
| Partnerships (`partnership_1` ... `_7`, `_10`, `_23`) | by industrial group: income and deductions, balance sheets, rental real estate, income allocated to partners, LLCs, receipts, foreign transactions | TY1993-2023 | tax year |
| Sole proprietorships (`soleprop_1` ... `_4`) | by industrial sector: receipts, deductions, payroll, net income; income statements; size of receipts; returns with Schedule C | TY1996-2023 | tax year |
| Integrated business data (`business_1`, `business_3`) | returns, receipts and net income by form of business, 1980-2015; by NAICS sector | to 2015 | edition / tax year |
| IRS Data Book (`databook_1-1` ... `_1-8`, `_3-1`, `_6-1`, `_6-2`) | collections and refunds by type of tax, returns filed, by state; gross collections by type of tax 1960 onward (1-6); audit coverage; costs; cost of collecting $100 | FY1995-2025 | fiscal year |
| Historical tables (`historical_1` ... `_24`) | individual series since 1913/1950, corporations since 1909, NIPA vs SOI income (8, 15), excise taxes by type FY1999 onward (20), returns filed (21), corporate rates 1909-2010 (24) | one file each | edition |
| Estate, gift, wealth (`estate_1` ... `_5`, `gift_1`, `wealth_1` ... `_6`) | estate returns by size of gross estate and tax status, by state, charitable bequests, beneficiaries, occupation; gift returns; top wealth holders | FY2001-2024; gift 2003-2021; wealth 2001-2019 | filing year |
| Exempt organizations (`eo_1` ... `_4`, `eo_excise`, `pf_1` ... `_4`) | Form 990 501(c)(3) by asset size, by Code section, 990-EZ, Form 4720 excise; private foundations | 1985-2024 | tax year |
| International (`cfc_1` ... `_3`, `ftc_1` ... `_3`, `cbc_1A` ... `cbc_4`) | controlled foreign corporations, corporate foreign tax credit, country-by-country reports | to 2021/2023 | tax year |

Parameters: `table` (an id, or a product word and number: "corporation 2.1", "data book 1-6"); `year` (or
`tax_year`, `fiscal_year`, `filing_year`; `start_year`/`end_year`, one workbook each); default the latest posted.
A whole-series table (`shares_4.x`, `databook_1-6`, `historical_*`, `business_1`) holds every year in one file:
the latest edition is read and the years are rows or columns (filter them with `rows`, `section` or `columns`).
`rows` keeps rows by label (an exact label, else the labels containing the text), `section` by section label,
`columns` by published column number or header text; `layout: "wide"` gives one row per line; `sheet` picks a
sheet of a multi-sheet workbook; `header_lines` overrides the header reading (rarely needed: see the notes).

How a workbook is read (no settings per table): title and headnote lines; the header lines down to the row of
column numbers (`1`, `(1)`, or `-1` shown as `(1)`); label-only lines become `SECTION` (a label running over two
lines is joined); the row level comes from the cell indent (or leading spaces) and gives `LEVEL` and `PARENT`;
footnote lines after the last data line go to the notes. A sheet printed as pages (1998 tables: columns 1-20 on
page 1, 21-40 on page 2) is read block by block; side-by-side panels (older partnership and sole proprietorship
tables) take each cell's label from the nearest label column to its left. A table without column numbers
(Publication 16 Table 2.1 for 2014, some historical tables) is read with the header down to the first line with
a label and a number, and says so in the notes, with `COL` empty.

Output (long, the default): `TABLE, YEAR, YEAR_TYPE, SHEET, SECTION, LINE, LEVEL, PARENT, ROW_LABEL, COL, COLUMN,
VALUE, FLAG, UNITS`. `COLUMN` joins the header lines with " | " ("All returns | Adjusted gross income less deficit
| Amount"); `COL` is the published column number, stable within a year (not across years: check `COLUMN`).
`VALUE` is the number as published (no thousands separators); `FLAG` holds the cell's markers: `*` estimate based
on few sample returns (high sampling variability; in newer workbooks the `*` is only in the number format and is
read from it), `**` data combined or suppressed, `d`/`[d]` deleted to avoid disclosure (included in totals), `[n]`
a footnote (e.g. `[2]` less than 0.05 percent), `n.a.` not available, `--`/`-` zero or not applicable as the
table's footnotes say. `UNITS` is the money unit of the headnote (usually thousands of dollars; gift tables whole
dollars; historical tables millions or billions); count, percent and average columns are as their header says.
