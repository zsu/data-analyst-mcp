# IRS exempt organizations: eo_bmf and eo_extract

From the irs-soi playbook's "Exempt organizations (`eo_bmf`, `eo_extract`)" section.

- `eo_bmf`: `https://www.irs.gov/pub/irs-soi/eo_{st}.csv` (one per state, PR, XX = international; updated monthly,
  1,975,975 organizations on 2026-10-13), 28 columns. Filters: `ntee` (prefix), `subsection` (`03` = 501(c)(3)),
  `ein`, `name`, `columns`. EIN and ZIP stay text. ASSET_AMT, INCOME_AMT, REVENUE_AMT are whole dollars from the
  latest return on file (TAX_PERIOD differs by organization). Codes: https://www.irs.gov/pub/foia/ig/tege/eo-info.pdf.
- `eo_extract`: the SOI annual extract of Form 990 (`form: 990`), 990-EZ (`990ez`) or 990-PF (`990pf`) data,
  `{yy}eoextract990.zip` etc. (2018-2024; `{yy}eofinextract...` 2012-2017), listed on
  soi-tax-stats-annual-extract-of-tax-exempt-organization-financial-data. The 2024 Form 990 zip is 57 MB holding a
  247 MB CSV of 246 columns; it is read as a stream keeping only `ein` or the organizations of `state` (their EINs
  from the current EO BMF, so an organization that moved or lost exemption is missed). The 990-PF CSV drops EIN
  leading zeros: they are restored. Field definitions: `{yy}eofinextractdoc.xlsx`. Years whose zip holds a
  fixed-width `.dat` file (some of 2012-2017) are refused.
