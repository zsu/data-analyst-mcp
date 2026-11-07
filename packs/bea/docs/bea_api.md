# BEA Data API reference

The pack's `bea_api.py` and `fetch.py` already implement this: key lookup and redaction, throttling,
error handling, response quirks, tidy output, and the no-key bulk route. Read this file when you need a
dataset or parameter the friendly spec does not cover, or when debugging an API error.

Contents: 1. Endpoint and methods · 2. Datasets and GetData parameters (NIPA, FixedAssets, MNE,
GDPbyIndustry, ITA, IIP, InputOutput, IntlServTrade, IntlServSTA, Regional) · 3. Response structure and
special values · 4. Rate limits · 5. Error codes · 6. Registration, terms, attribution · 7. Time periods,
revisions, release timing · 8. Common table codes · 9. Implementation checklist

**Bulk files (no key).** Besides the API, BEA posts complete files that `fetch.py` reads when no key works:
- NIPA: `https://apps.bea.gov/national/Release/TXT/` → `NipaDataA.txt`, `NipaDataQ.txt`, `NipaDataM.txt`
  (`%SeriesCode,Period,Value`), `SeriesRegister.txt` (`SeriesCode,SeriesLabel,MetricName,CalculationType,
  DefaultScale,TableId:LineNo|...,SeriesCodeParents`; DefaultScale -6 = millions) and `TablesRegister.txt`.
  Every published NIPA and NIUnderlyingDetail table can be rebuilt from them (TableId:LineNo → series).
- Regional: `https://apps.bea.gov/regional/zip/<NAME>.zip`. State tables come in family zips (`SAGDP.zip`,
  `SQGDP.zip`, `SAINC.zip`, `SQINC.zip`, `SAPCE.zip`, `SARPP.zip`, `SAOR.zip`); county tables one per zip
  (`CAINC1.zip`, `CAINC4.zip`, `CAGDP2.zip`, `CAGDP9.zip`, ...); MSA price parities in `MARPP.zip`. Inside:
  `<TABLE>__ALL_AREAS_<first>_<last>.csv` (wide: GeoFIPS, GeoName, Region, TableName, LineCode,
  IndustryClassification, Description, Unit, then one column per year or `2026:Q1` quarter; footer lines
  give "Last updated: ..."), plus `definition.xml` (line definitions) and `Footnotes.html`. A missing zip
  returns HTTP 200 with an HTML page, so check for the `PK` zip signature. Zips for API-only tables
  (metro-area GDP and income, MSA personal income) do not exist.
- GDP by industry: `https://apps.bea.gov/industry/Release/XLS/GDPxInd/` → `ValueAdded.xlsx` (sheets
  `TVA101-A`, `TVA101-Q` ... `TVA113-A`), `GrossOutput.xlsx` (`TGO1xx`), `IntermediateInputs.xlsx` (`TII1xx`). Each
  sheet: title, `[unit]`, period range, "Data published <date>", then a header row starting `Line` and one row per
  industry; footnotes below. A `Contents` sheet lists the codes. `fetch.py` reads them with the standard library.
- Data are the same, latest vintage as the API. Bulk files are large (NIPA quarterly 35 MB; some county
  zips 45 MB) but need no key and count against no rate limit.


Compiled 2026-10-19. Main source: *BEA API for Data Retrieval User Guide* (PDF, main body dated April 20, 2026, 69 pages including appendices). Other sources are the live swagger.json, the Terms of Service PDF, BEA's own `us-bea/beaapi` Python package (v0.2.0, Feb 2026), test calls made with an invalid key, and the BEA pages listed at the end.
Tags: **[guide]** user guide PDF; **[swagger]** apps.bea.gov/api/swagger/swagger.json; **[live]** observed today with an invalid key; **[beaapi]** source code of BEA's official Python client; **[2024-htm]** Wayback copy (2024-03-16) of the older HTML guide. **UNVERIFIED** means no primary source was checked or data calls were not possible.

---------------------------------------------------------------------------------------------------
## 1. Endpoint, request format, methods

- **Single endpoint:** `https://apps.bea.gov/api/data` (also accepts `.../api/data/`) [guide]. The guide says "All API access is through this URI; no other paths are used."
- **Requests:** HTTP **GET** with query-string parameters only. Every request needs `UserID` and `method`. GetData and the parameter metadata methods also need `DatasetName`.
- **Case:** parameter names are case-insensitive [live]: `userid=…&METHOD=getdatasetlist&resultformat=xml` worked, and the server echoes names and values in UPPERCASE in `Request.RequestParam`. Method names and dataset names are case-insensitive too (the guide's own examples use `GETDATASETLIST`, `getparameterlist`, `INTLSERVTRADE`, `underlyingGDPbyIndustry`). Case-insensitivity of other parameter *values*, such as table names, is UNVERIFIED (likely), so pass codes exactly as returned by GetParameterValues.
- **Multiple values:** use one comma-separated string, e.g. `Year=2022,2023,2024` or `Frequency=A,Q,M` [guide]. URL-encode it, although commas work raw.
- **`ResultFormat`:** `JSON` (the default, also used when the value is invalid) or `XML` [guide]. Content-Type is `application/json` or `application/xml` [live].
- **Other features:** an optional `jsonp=<callbackName>` wraps the response for legacy browsers. CORS headers are on all responses [guide].
- **Encoding:** beaapi decodes responses as `iso-8859-1` because "utf-8 returns decode errors" [beaapi].
- **Methods** [guide] (the guide has a separate section for each):

| method | required params (besides UserID) | returns `Results.` |
|---|---|---|
| `GetDataSetList` | – | `Dataset[]` {DatasetName, DatasetDescription} |
| `GetParameterList` | `DatasetName` | `Parameter[]` {ParameterName, ParameterDataType (string/integer), ParameterDescription, ParameterIsRequiredFlag 0/1, ParameterDefaultValue, MultipleAcceptedFlag 0/1, AllValue} |
| `GetParameterValues` | `DatasetName`, `ParameterName` | `ParamValue[]`, usually {Key, Desc}. Some datasets use other attribute names, e.g. FixedAssets in 2024-htm: `TableID`/`Description`. Read the keys generically. |
| `GetParameterValuesFiltered` | `DatasetName`, `TargetParameter`, plus filter params | `ParamValue[]` {Key, Desc}. **Not supported by every dataset**: NIPA returns error 34. Supported by Regional, and ITA in the beaapi README example (`targetparameter='Indicator', AreaOrCountry='China', Frequency='A', Year='2011'`). Support in other datasets is UNVERIFIED. |
| `GetData` | `DatasetName` + dataset-specific params | `Dimensions`, `Data`, `Notes` (+ dataset extras); see §3 |

- The guide says that for NIPA/NIUnderlyingDetail/FixedAssets, "passing a TableName value" to GetParameterValues tells you the valid frequencies and years for that table. The exact request form is UNVERIFIED.
- **Key format:** a 36-character GUID, e.g. `11111111-2222-3333-4444-555555555555` in the guide's example [guide]. beaapi strips spaces and rejects any key whose length is not 36 [beaapi].

---------------------------------------------------------------------------------------------------
## 2. Datasets and GetData parameters

**Current dataset list** (from the GetDataSetList example in the April 2026 guide; the same 13 appear in swagger and the beaapi README):
NIPA, NIUnderlyingDetail, MNE, FixedAssets, ITA, IIP, InputOutput, IntlServTrade, IntlServSTA, GDPbyIndustry, Regional, UnderlyingGDPbyIndustry, APIDatasetMetaData.

**Retired (calls "will no longer function")** [guide App. A/I/J]:
- `RegionalData` (2019)
- `RegionalIncome` and `RegionalProduct` (Dec 2019). Use `Regional` instead. Crosswalk: apps.bea.gov/regional/pdf/RegionalApi.pdf, e.g. RegionalIncome SA1 → SAINC1, CA4 → CAINC4; RegionalProduct GDP_SAN → SAGDP2N, RGDP_SAN → SAGDP9N, RGDP_SQN → SQGDP9.

**Retired parameters:**
- NIPA/NIUnderlyingDetail `TableID` was replaced by `TableName` (Feb 2018). The guide has crosswalks, e.g. TableID 1 = T10101.
- FixedAssets `TableID` → `TableName` (Oct 2018).
- NIPA `ShowMillions` was discontinued in Oct 2017 [2024-htm], although swagger still lists it. Use UNIT_MULT instead.

**NIUnderlyingDetail is still active.** It is in the 2026 guide, swagger, signup page and TablesRegister.txt (U-prefixed tables). Some underlying tables were dropped: Section 0 inventories/sales tables 4AU*, 4BU*, 6U, 7U (2024-07-01), and 9.2U and 9.5U (2025-09-25) [discontinued-stats page]. BEA caution: underlying detail is lower quality than the published aggregates [guide App. C/L].

The tables below use these columns: Req = required; Multi = multiple values accepted; All = "all" keyword. Parameter details come from the guide appendices.

### NIPA (App. B) and NIUnderlyingDetail (App. C): same parameters
| param | Req | Multi | All | notes |
|---|---|---|---|---|
| TableName | Y | N | – | e.g. `T10101`, `U20305`. One table per request. |
| Frequency | Y | Y | – | `A`, `Q`, `M`. Frequencies a table lacks are skipped; if none match, an error is returned. |
| Year | Y | Y | `X` or `ALL` | Q/M requests return all available periods within each requested year. |

Examples:
- `?UserID=KEY&method=GetData&DataSetName=NIPA&TableName=T10101&Frequency=A,Q&Year=ALL`
- `?UserID=KEY&method=GetData&DataSetName=NIPA&TableName=T20600&Frequency=M&Year=2015,2016`
- `?UserID=KEY&method=GetData&DataSetName=NIUnderlyingDetail&TableName=U70205S&Frequency=M&Year=2015,2016`

### FixedAssets (App. D)
| param | Req | Multi | All |
|---|---|---|---|
| TableName (e.g. `FAAt201`) | Y | N | – |
| Year | Y | Y | `X` or `ALL` |

Annual only. Updated once a year, typically late August to early October.
Example: `?UserID=KEY&method=GetData&DataSetName=FixedAssets&TableName=FAAt201&Year=ALL`
Caveat: swagger names the parameter `tableID` while the guide uses `TableName`. Prefer `TableName`.

### MNE (App. E): two request types
- **Direct Investment (DI):**
  - Required: `DirectionOfInvestment` (`Outward` or `Inward`), `Classification` (single value, e.g. `Country`, `CountryByIndustry`), `Year` (multiple values or `all`).
  - Optional: `SeriesID` (multiple; default all, `0` = all), `Country` (3-digit codes; `000` = all-countries total, `all` = every country and region), `Industry` (4-digit NAICS-like codes; `0000` = all-industries total, `all` = every industry), `GetFootnotes` (`Yes` or `No`, default No).
- **Activities of MNEs (AMNE):**
  - Required: `DirectionOfInvestment` (`Outward`, `Inward`, `State` or `Parent`), `OwnershipLevel` (`0` = majority-owned affiliates, `1` = all affiliates; must be 1 when Direction=Parent), `NonBankAffiliatesOnly` (`0` = bank and nonbank affiliates, which suits outward 2009+ and inward 2007+; `1` = nonbank only, for earlier years), `Classification`, `Year`.
  - Optional: `SeriesID`, `Country`, `Industry`, `State` (2-digit FIPS; `00` = US total, `70` = other US areas, `75` = foreign, `all`), `GetFootnotes`.
  - With `State`, only employment (and, for limited years, gross property, plant and equipment) is available.
- Swagger also lists the undocumented parameters `investment` and `parentInvestment` (meaning UNVERIFIED).

Examples:
- `?UserID=KEY&method=GetData&DataSetName=MNE&SeriesID=30&Year=2011,2012&Country=650,699&DirectionOfInvestment=Outward&Classification=Country`
- `?UserID=KEY&method=GetData&DataSetName=MNE&Year=2011&Country=all&Industry=0000&DirectionOfInvestment=Inward&Classification=Country&SeriesID=8&OwnershipLevel=0&NonbankAffiliatesOnly=0&GetFootnotes=Yes`

### GDPbyIndustry (App. F; the PDF page footers mislabel this appendix as "Appendix E - MNE")
| param | Req | Multi | All |
|---|---|---|---|
| TableID (integer) | Y | Y | `ALL` |
| Frequency | Y | Y | `A` and/or `Q` |
| Year | Y | Y | `ALL` |
| Industry | Y | Y | `ALL` |

- Annual data start in 1997 (1998 for percent-change and contributions tables). Quarterly data start in 2005.
- In GetParameterValues, a description marked "(A)" means annual and "(Q)" means also quarterly.
- Requesting Q for a table that is annual-only gives error 204.

Examples:
- `?UserID=KEY&method=GetData&DataSetName=GDPbyIndustry&TableID=1&Frequency=A&Year=2011,2012&Industry=ALL`
- `?UserID=KEY&method=GetData&DataSetName=GDPbyIndustry&TableID=ALL&Frequency=A,Q&Year=2010&Industry=11`

### UnderlyingGDPbyIndustry (App. L)
- Same 4 parameters as GDPbyIndustry, all required, but **Frequency=A only** (Q gives error 206, "Invalid frequency: Q").
- Data run from 1997 to the present.

Example: `?UserID=KEY&method=GetData&DataSetName=UnderlyingGDPbyIndustry&TableID=210&Frequency=A&Year=2012,2013&Industry=ALL`

### ITA, International Transactions (App. G). All parameters optional and multi-valued.
- `Indicator` (default All; e.g. `BalGds`, `PfInvAssets`)
- `AreaOrCountry` (default `AllCountries` = total; `All` = every area and country; e.g. `China`)
- `Frequency` (`A`, `QSA`, `QNSA`)
- `Year` (default All)

**Rule:** you can request multiple Indicators only with exactly one AreaOrCountry that is not All or AllCountries. Likewise, a list of countries (or AllCountries) works only with exactly one Indicator.

Examples:
- `?UserID=KEY&method=GetData&DataSetName=ITA&Indicator=BalGds&AreaOrCountry=China&Frequency=A&Year=2011,2012`
- `?UserID=KEY&method=GetData&DataSetName=ITA&Indicator=PfInvAssets&AreaOrCountry=AllCountries&Frequency=QNSA&Year=2013`

### IIP, International Investment Position (App. H). All optional and multi-valued.
- `TypeOfInvestment` (e.g. `FinAssetsExclFinDeriv`, `FinLiabsFoa`)
- `Component` (`Pos` = position; changes such as `ChgPosTrans`, `ChgPosPrice`)
- `Frequency` (`A`, `QNSA`)
- `Year`

**Rule:** more than one TypeOfInvestment requires exactly one Year that is not ALL, and more than one Year requires exactly one TypeOfInvestment.

Examples:
- `?UserID=KEY&method=GetData&DataSetName=IIP&TypeOfInvestment=FinAssetsExclFinDeriv&Component=ChgPosPrice&Frequency=A&Year=ALL`
- `?UserID=KEY&method=GetData&DataSetName=IIP&TypeOfInvestment=FinLiabsFoa&Component=Pos&Frequency=QNSA&Year=2013`

### InputOutput (App. K)
| param | Req | Multi | All |
|---|---|---|---|
| TableID (integer) | Y | Y | none |
| Year | Y | Y | `ALL` |

Some tables exist only for benchmark years (e.g. Use tables in purchasers' prices: 2007).
Examples:
- `?UserID=KEY&method=GetData&DataSetName=InputOutput&TableID=56&Year=2010,2011,2012,2013`
- `?UserID=KEY&method=GetData&DataSetName=InputOutput&TableID=56,57&Year=2007`

The guide warns that IO parameter values change, so always refresh them with GetParameterValues.

### IntlServTrade (App. M). Annual data, updated each July. All optional and multi-valued.
- `TypeOfService` (default All; e.g. `AllServiceTypes`, `Telecom`)
- `TradeDirection` (`Exports`, `Imports`, `Balance`, `SupplementalIns`)
- `Affiliation` (`AllAffiliations`, `Unaffiliated`, `Affiliated`, `UsParents`, `UsAffiliates`)
- `AreaOrCountry` (default `AllCountries`; `All` = every area and country)
- `Year`

**Rule:** multiple TypeOfService values require one specific AreaOrCountry, and a list of countries requires one specific TypeOfService.

Examples:
- `?UserID=KEY&method=GetData&DataSetName=IntlServTrade&TypeOfService=AllServiceTypes&TradeDirection=Imports&Affiliation=AllAffiliations&AreaOrCountry=Germany&Year=2014,2015`
- `?UserID=KEY&method=GetData&DataSetName=IntlServTrade&TypeOfService=Telecom&TradeDirection=Exports&Affiliation=UsParents&AreaOrCountry=AllCountries&Year=All`

### IntlServSTA (App. O, Oct 2023). Annual data, updated each October. All optional and multi-valued.
- `Channel` (`Mofas`, `Mousas`, `AllChannels`, `Trade`, `UsExportsByMousas`, `UsImportsFromMofas`)
- `Destination`:
  - MOFAs: `AllForeign`, `ForeignAffs`, `ForeignUnaff`, `HostCtry`, `HostCtryAffs`, `HostCtryUnaff`, `ForeignOther`, `ForeignOtherAffs`, `ForeignOtherUnaff`
  - MOUSAs: `AllUs`
- `Industry` (default `AllInd` = total; `All` = every industry; e.g. `RetailTrade`, `Mining`)
- `AreaOrCountry` (default `AllCountries`)
- `Year`

Examples:
- `?UserID=KEY&method=GetData&DataSetName=IntlServSTA&Channel=Mofas&Destination=AllForeign&Industry=RetailTrade&AreaOrCountry=India&Year=2015,2016`
- `?UserID=KEY&method=GetData&DataSetName=IntlServSTA&Channel=Mousas&Destination=AllUs&Industry=Mining&AreaOrCountry=Europe`

### Regional (App. N, dated April 24, 2026)
| param | Req | Multi | special values |
|---|---|---|---|
| TableName | Y | N | one table per request |
| LineCode | Y | N | integer, or `ALL`. With `ALL`, **only one GeoFips** is allowed. |
| GeoFips | Y | Y (unless LineCode=ALL) | `STATE`, `COUNTY`, `MSA`, `MIC`, `PORT`, `DIV`, `CSA`, `TERR`, a state postal abbreviation (all counties in that state, e.g. `NY`), or a list of 5-digit codes |
| Year | N | Y | default `LAST5`; also `LAST10`, `ALL` |

- **GeoFips codes:** `00000` = US; states are `SS000` (e.g. `01000` Alabama); counties are `SSCCC`; BEA regions are `91000`–`98000` (e.g. `97000` Rocky Mountain, `98000` Far West); `72000` = Puerto Rico (PRGDP* tables). Component counties of each MSA: apps.bea.gov/regional/geography.htm.
- **GetParameterValuesFiltered (Regional)** accepts comma-separated lists for TableName and LineCode, unlike GetData:
  - `TargetParameter=LineCode&TableName=SAINC4`: line codes for a table
  - `TargetParameter=Year&TableName=CAINC5N&GeoFips=01001`: years available
  - `TargetParameter=GeoFips&TableName=CAINC4&LineCode=10`: geographies
  - `TargetParameter=TableName&GeoFips=00000&Year=2024`: tables
- **Feb 2026 change:** BEA **stopped producing GDP and personal income for MSAs, MICs, DIVs, CSAs and metro/nonmetro PORTs** in the county tables (CAINC1/4/5N/5S/6N/6S/30, CAGDP1/2/8/9/11). It announced this in 2025 and in the 2026-02-05 county release. MARPI/PARPI (real personal income) for MSAs and portions were dropped on 2026-02-19 [discontinued-stats page; us-bea/bea_geo_aggregator README; FAQ 1481].
  - Expect `MSA`/`PORT` GeoFips to fail or return only historical data for these tables (UNVERIFIED which).
  - BEA's `bea_geo_aggregator` repo rebuilds MSA estimates from county data. The archive apps.bea.gov/histdata/ has the old MSA vintages.
  - Status of MARPP and PARPP (regional price parities) by MSA is UNVERIFIED. They are still listed in App. N.
- **Earlier cuts** (2024): SAEMP25, SAEMP27, SAINC45, CAEMP25, CAINC35, CAINC45 discontinued; specific lines dropped, e.g. CAINC4 7010/7020/7040, CAINC30 240–310, SAINC30 270/280/310.

Examples:
- `?UserID=KEY&method=GetData&datasetname=Regional&TableName=CAINC1&LineCode=1&GeoFips=COUNTY&Year=2012,2013`
- `?UserID=KEY&method=GetData&datasetname=Regional&TableName=SAINC1&LineCode=3&GeoFips=STATE&Year=2013`
- `?UserID=KEY&method=GetData&datasetname=Regional&TableName=SAGDP9N&LineCode=2&GeoFips=STATE&Year=ALL` (the guide calls this "Real GDP for all states")

### APIDatasetMetaData (still listed; not documented in the guide)
- Swagger shows one required parameter, `dataset`. beaapi calls `method=GetData&datasetname=APIDatasetMetaData&dataset=NIPA,NIUnderlyingDetail,FixedAssets`.
- **The response is not wrapped in `Results`.** It looks like `BEAAPI.Datasets[]`, each with {Datasetname, MetaDataUpdated, `APITable[]`}. Each APITable has {TableId, TableName (the title), ReleaseDate, NextReleaseDate, `Line[]`}, and each Line has {SeriesCode, RowNumber, LineDescription, LineNumber, ParentLineNumber, Tier, Path}.
- ReleaseDate looks like `"Feb 28 2019  8:30AM"` [beaapi README]. Only NIPA, NIUnderlyingDetail and FixedAssets are known to be supported [beaapi].
- Its structure comes from beaapi source only, so treat it as UNVERIFIED live.

---------------------------------------------------------------------------------------------------
## 3. GetData response structure

Common shape [guide]: `{"BEAAPI":{"Request":{"RequestParam":[{ParameterName,ParameterValue}…]},"Results":{…}}}`. Results usually contains:
- **`Dimensions[]`**: {Ordinal, Name, DataType ("string" or "numeric"), IsValue ("1" for the value column)}.
  - Regional sometimes omits `Ordinal` [beaapi].
  - Fields within a Data row are **not in a guaranteed order**, so always read them by name.
- **`Data[]`**: one object per observation; **every field is a string**.
- **`Notes[]`**: {NoteRef, NoteText}.
  - A `NoteRef` on a data row (or on Results) points to a note. It can hold several comma-separated refs, or extra symbols (e.g. `"2 *"` matches notes "2" and "*").
  - Regional also returns notes with `NoteRef` `"Note."` (units) and `" "` (e.g. "Last updated: February 5, 2026-- new statistics for 2024; revised statistics for 2020-2023.").
  - For NIPA, every row has at least one NoteRef pointing to the table title. In practice it is the TableName, e.g. `T20305` [beaapi README].
- **Extras:**
  - Regional: `Statistic`, `UnitOfMeasure`, `PublicTable`, `UTCProductionTime` (e.g. `2026-03-25T19:25:39.113`), `NoteRef` [guide].
  - NIPA: `Statistic` ("NIPA Table"), `UTCProductionTime` [beaapi].
- **Quirks** [beaapi]:
  - `Results` can be a **1-element list** instead of an object (unwrap it).
  - **IIP puts `Data` at `BEAAPI.Data`**, not inside Results.
  - `Data` (and `Notes`) can be a single **object** instead of a list when there is only one observation.
  - `Error` can appear at `BEAAPI.Error` as well as `Results.Error`, and can be a list.

**Fields per dataset** ([guide] where marked; otherwise [beaapi]):
- **NIPA / NIUnderlyingDetail / FixedAssets** [guide]: TableName, SeriesCode, LineNumber, LineDescription, TimePeriod, METRIC_NAME (the guide writes "Metric_Name", but live output uses `METRIC_NAME`), CL_UNIT, UNIT_MULT, DataValue, NoteRef.
  - Sample row: `{"TableName":"T20305","SeriesCode":"DPCERC","LineNumber":"1","LineDescription":"Personal consumption expenditures (PCE)","TimePeriod":"2015Q1","METRIC_NAME":"Current Dollars","CL_UNIT":"Level","UNIT_MULT":"6","DataValue":"12,119,763","NoteRef":"T20305"}`. The commas are inferred from the guide ("formatted with commas"); beaapi removes them.
  - SeriesCode values may repeat across LineNumbers. Key on (LineNumber, TimePeriod).
- **Regional** [guide]: Code (`TABLE-LINE`, e.g. `CAINC1-3`), GeoFips, GeoName (may end in ` *` when there is a footnote), TimePeriod, CL_UNIT (e.g. "Dollars"), UNIT_MULT, DataValue, NoteRef. beaapi also expects an optional `Description`.
- **ITA / IIP** [guide]: Indicator or TypeOfInvestment, AreaOrCountry or Component, Frequency, Year, TimeSeriesId, TimeSeriesDescription, TimePeriod, CL_UNIT (e.g. USD), UNIT_MULT, DataValue (**may be blank**), NoteRef (may be blank).
- **IntlServTrade** [guide]: TypeOfService, TradeDirection, Affiliation, AreaOrCountry, Year, TimeSeriesId, TimeSeriesDescription, TimePeriod, CL_UNIT, UNIT_MULT, DataValue (may be blank), NoteRef.
- **IntlServSTA** [guide]: Channel, Destination, Industry, AreaOrCountry, Year, TimeSeriesId, TimeSeriesDescription, TimePeriod, CL_UNIT, UNIT_MULT, DataValue, NoteRef.
- **GDPbyIndustry** [beaapi]: TableID, Frequency, Year, Quarter (equals Year when Frequency=A, otherwise I–IV), Industry, `IndustrYDescription` (sic, odd capitalisation), DataValue, NoteRef.
- **UnderlyingGDPbyIndustry** [beaapi]: TableID, Frequency, Year, Industry, IndustrYDescription, DataValue, NoteRef.
- **InputOutput** [beaapi]: TableID, Year, RowCode, RowDescr, RowType, ColCode, ColDescr, ColType, DataValue, NoteRef.
- **MNE** [beaapi]: SeriesID, SeriesName, Row, RowCode, Column, ColumnCode, ColumnParent, ColumnParentCode, ColumnGParent, ColumnGParentCode, TableScale, Year, TableRowDisplayOrder, TableColumnDisplayOrder, DataValue, DataValueUnformatted. `RowCode` can be `' '` on several rows, so key with the display-order fields too.
- **GDPbyIndustry / UnderlyingGDPbyIndustry / InputOutput:** "Blanks will not be returned for missing data" [guide].

**Value handling:**
- DataValue is a string that may contain thousands separators, e.g. "1,337". Strip commas before parsing.
- Real value = DataValue × 10^UNIT_MULT (6 = millions, 9 = billions) [guide].
- CL_UNIT tells you the unit, e.g. "USD", "PC" (percent), "Level", "Dollars" [guide].
- Non-numeric DataValues that beaapi handles:
  - `(D)` = suppressed to avoid disclosing data of individual companies or establishments; also used for MNE, Regional and Fixed Assets cells. BEA FAQ: "A (D) indicates a data suppression".
  - `(NM)` = not meaningful.
  - `(NA)` = not available.
  - `(*)` = MNE: nonzero value that rounds to zero (beaapi maps it to 0).
  - `n.s.` = MNE: not shown.
  - `n.a.` = not available.
  - beaapi only blanks `(D)` and `(NM)` when NoteRef has the same code.
- Regional table symbols `(L)` (less than $50,000 or fewer than 10 jobs, shown as 0), `(S)`, `(X)`, `(T)`, `(NA)` are **UNVERIFIED**: no BEA page found that defines them.
- Robust approach: if `DataValue.replace(',','')` does not parse as a float, store NaN and keep the raw string in a `flag` column.

---------------------------------------------------------------------------------------------------
## 4. Rate limits and throttling

**Current guide (2026)**, per user account:
- **100 requests/minute**, and/or
- **100 MB of data retrieved/minute**, and/or
- **30 errors/minute**.

If any limit was exceeded in the previous minute, every further request errors during the timeout. The guide says the timeout is "currently one minute – but may change dynamically to accommodate API activity levels". BEA says it adjusts these limits periodically.

**Throttled response:**
- **HTTP 429 Too Many Requests**, with a `Retry-After` header in seconds (example `retry-after: 59`). The value counts down on each further request until the timeout ends.
- JSON body error, e.g. `APIErrorCode "7"` "Request Denied - exceeded Requests per minute quota." Matching messages for the data-volume and error quotas presumably exist; their wording and codes are UNVERIFIED.

**Contradiction: lockout length.** BEA's own code says the block lasts **1 hour**:
- beaapi: `BACKOFF_SECS = 60*60`, and the message "your requests will be blocked for the next hour".
- bea_geo_aggregator README (2026): "temporarily blocked from the API for an hour".
- Plan for up to 1 hour, and obey `Retry-After` when it is present.

**Older limits** [2024-htm, archived Mar 2024]: 1000 calls/min, 30 errors/min, 50 MB/min. Current limits are **lower on requests (100) and higher on data volume (100 MB)**.

**No documented maximum on rows or response size.** Signs of an oversized request:
- An empty 200 body. beaapi reads this as "Likely the query timed out. Try again with narrower parameters."
- An HTML error page ("An error occurred while executing the application").

**Guidance** [guide]:
1. Fetch only after releases; check the schedule.
2. Count requests and bytes and pause before reaching the limits. beaapi counts 100 MB as 100·1000·1024 bytes and leaves headroom of 1 request, 1 error and the largest recent response.
3. On a 429, pause for the `Retry-After` period (the guide says 60 s); retrying during the timeout just extends it.
4. Use a single thread and run requests one after another. beaapi warns that throttling cannot coordinate across processes.
5. Use `ALL`/`X` on **at most one parameter**.

**Ways to split requests:** by year range (e.g. 10-year chunks for Q/M NIPA data), by one table per call (already required for NIPA/Regional), by GeoFips list instead of `COUNTY`+`ALL`, and one LineCode per call for Regional.
Errors count toward the 30/min limit, so validate parameters with metadata calls first and never retry on API error codes.

---------------------------------------------------------------------------------------------------
## 5. Error codes

Errors normally arrive as **HTTP 200** with `Results.Error {APIErrorCode, APIErrorDescription}`. There may also be `ErrorDetail {Description}` children; in JSON, collect every key other than code and description. Throttling is the exception: HTTP 429.

**The guide has no master table.** Every code BEA documents or that was observed:

| code | description (verbatim) | source |
|---|---|---|
| 1 | Invalid Request - Invalid API UserId. | guide; live (GUID-shaped bad key on GetData or a bad method) |
| 3 | The BEA API UserID provided in the request does not exist. | 2024-htm |
| 4 | This UserId is not active. Please activate it and try again. | live (key `X`; and an all-zero GUID on GETDATASETLIST). Also what an unactivated key would return (inferred). |
| 7 | Request Denied - exceeded Requests per minute quota. | guide (sent with HTTP 429) |
| 34 | The GetParameterValuesFiltered method has not been implemented on this dataset (coming soon). | guide (NIPA) |
| 40 | The dataset requested requires parameters that were missing from the request | guide. Regional also uses 40 for invalid values: detail such as "TableName entered is invalid" or "TableName entered is incompatible with the entered GeoFips, LineCode and Year", plus suggested values. |
| 201 | Error retrieving Fixed Assets data. (detail e.g. "Invalid table IDs were requested.", "The requested parameters did not return data.") | 2024-htm |
| 203 | No parameter values match the filtered list requested (Regional GetParameterValuesFiltered; detail e.g. "LineCode entered is invalid", "Values of GeoFips and LineCode are incompatible") | guide |
| 204 | Error retrieving GDP by Industry data. (detail e.g. "This TableID is not published quarterly: 25", "Quarterly data begin in 2005. Invalid year: 1997", "Invalid industry: 111CA", "No data exist for selected criteria") | guide |
| 205 | Error retrieving Input-Output data. ("No data exist for selected criteria") | guide |
| 206 | Error retrieving GDP by Industry data. (UnderlyingGDPbyIndustry: "Invalid frequency: Q", "Invalid year: 1996", "Invalid industry: 11") | guide |

- NIPA, ITA, IIP, MNE and IntlServ* also have error codes; the guide says only "an error will be returned". Those codes are UNVERIFIED.
- An unregistered key gave code 1 on some requests and code 4 on others [live], so treat both as "bad or inactive key".
- **Missing `UserID` returns HTTP 200 with an empty body** (Content-Length 0) [live].

---------------------------------------------------------------------------------------------------
## 6. Registration, terms of service, attribution

- **Registration:** https://apps.bea.gov/API/signup/ (`/api/` redirects there).
  - The form asks for name or organization, email, a CAPTCHA, and a tick for "I agree to the Terms of Service". **A person must complete it**; the skill must not try.
  - BEA emails a **36-character UserID** and a link; **the key works only after the link is clicked** [guide].
  - Disposable email addresses are refused, and such registrations may be removed without notice [guide].
  - Contact: developers@bea.gov.
- **Terms of Service** (apps.bea.gov/API/_pdf/bea_api_tos.pdf). **Required attribution** for any service that uses the API, "displayed prominently": **"This product uses the Bureau of Economic Analysis (BEA) Data API but is not endorsed or certified by BEA."**
  - You may name BEA as the source, but not in a way that implies endorsement.
  - You may not modify or misrepresent content and still credit BEA.
  - BEA may limit access, monitor usage, and block users who try to exceed or get around limits, temporarily or permanently.
  - The API is provided "as is"; federal law governs.
- **Citation format** (bea.gov/help/guidelines-for-citing-bea): `U.S. Bureau of Economic Analysis, "Table 1.1.1. Percent Change From Preceding Period in Real Gross Domestic Product" (accessed <date>).` Include the vintage of the estimate when relevant, e.g. "second estimates for the second quarter of 2012".
- **Key storage:** keep the key in an environment variable or `.env` (beaapi suggests a `.env` with `beakey=…`). Never log the full URL with the key in it.

---------------------------------------------------------------------------------------------------
## 7. Time periods, revisions, release timing

- **TimePeriod formats:**
  - Annual: `YYYY`
  - Quarterly: `YYYYQn` (e.g. `2015Q1`)
  - Monthly: `YYYYMx` per the guide ("x is the month digit"). In practice months are zero-padded, `2024M01`: this is UNVERIFIED, so parse with the regex `^(\d{4})M(\d{1,2})$`.
- **The Year parameter takes years only.** For Q/M data, ask for the years and you get every quarter or month in them; filter afterwards.
- **Frequency codes by dataset:** NIPA/NIUD `A`, `Q`, `M`; GDPbyIndustry `A`, `Q`; ITA `A`, `QSA`, `QNSA`; IIP `A`, `QNSA`. Regional chooses frequency through the table: SA* = annual, SQ* = quarterly, CA* = county annual.
- **Only the latest estimates.** API data update "on the same release schedule as other published sources of BEA data (e.g. Interactive Tables)" [guide]. The Interactive Tables "only display the most recently released data" and do not identify vintage [citing guidelines].
  - **There is no vintage or as-of parameter.**
  - To spot a revision, use Regional `UTCProductionTime` and "Last updated" notes, or APIDatasetMetaData `ReleaseDate`/`NextReleaseDate`.
  - Past vintages: BEA Data Archive https://apps.bea.gov/histdata/ (not through the API). Third-party vintage sources such as ALFRED are UNVERIFIED here.
- **Release schedule:** https://www.bea.gov/news/schedule. Machine-readable: **https://apps.bea.gov/API/signup/release_dates.json** (keys are release names, each with `release_dates[]` as ISO-8601 UTC strings, e.g. "Gross Domestic Product", "Personal Income and Outlays", "GDP by County and Personal Income by County"; there is also a `file_last_updated` key). An ICS feed is at /news/schedule/ics/online-calendar-subscription.ics.
- **Upcoming releases (as of today):** GDP advance estimate for 2026Q3 and Personal Income and Outlays for Sept 2026, both 2026-10-29 at 8:30 ET. Releases come out at 8:30 AM ET.
- **Annual cycles:** FixedAssets, late August to early October. IntlServTrade, July. IntlServSTA, October.

---------------------------------------------------------------------------------------------------
## 8. Common table codes

**NIPA TableName** (titles checked against TablesRegister.txt, apps.bea.gov/national/Release/TXT/TablesRegister.txt, CSV `TableId,TableTitle`, 318 tables including U*, GFS*, OECD*, Rf*). Frequencies follow BEA convention: Q tables also have A, and monthly tables are named. Confirm with GetParameterValues.

| TableName | title |
|---|---|
| T10101 | 1.1.1 Percent Change From Preceding Period in Real GDP (line 1 = GDP, series A191RL) |
| T10102 | 1.1.2 Contributions to Percent Change in Real GDP |
| T10103 | 1.1.3 Real GDP, Quantity Indexes |
| T10104 | 1.1.4 Price Indexes for GDP |
| T10105 | 1.1.5 Gross Domestic Product (nominal) |
| T10106 | 1.1.6 Real GDP, Chained Dollars |
| T10107 | 1.1.7 Percent Change From Preceding Period in Prices for GDP |
| T10109 | 1.1.9 Implicit Price Deflators for GDP |
| T10111 | 1.1.11 Real GDP: Percent Change From Quarter One Year Ago |
| T10204 / T10205 / T10206 | 1.2.x GDP by Major Type of Product (prices / nominal / real) |
| T10501–T10506 | 1.5.x GDP, Expanded Detail |
| T10604 | 1.6.4 Price Indexes for Gross Domestic Purchases |
| T11000 | 1.10 Gross Domestic Income by Type of Income |
| T11200 | 1.12 National Income by Type of Income |
| T11706 | 1.17.6 Real GDP, Real GDI, and Other Major NIPA Aggregates, Chained Dollars |
| T20100 | 2.1 Personal Income and Its Disposition |
| T20301 / T20304 / T20305 / T20306 | 2.3.x PCE by Major Type of Product: real % change / price indexes / nominal / real |
| T20600 | 2.6 Personal Income and Its Disposition, Monthly |
| T20801–T20807 | 2.8.x PCE by Major Type of Product, Monthly. T20804 = **PCE price indexes, monthly** (PCE and core PCE); T20805 = nominal; T20806 = real; T20807 = % change in prices. |
| T30100 / T30200 / T30300 | 3.1 / 3.2 / 3.3 Government (total / federal / state and local) current receipts and expenditures |
| T40100 | 4.1 Foreign Transactions in the NIPAs |
| T50100 | 5.1 Saving and Investment by Sector |
| T61600D | 6.16D Corporate Profits by Industry |
| T70100 | 7.1 Selected Per Capita Product and Income Series |
| U20304/U20305/U20306, U20404/U20405/U20406 | NIUnderlyingDetail PCE detail: by type and function / by type of product |
| U70205S | Auto and Truck Unit Sales, Production, Inventories, Expenditures, and Price |
| U90100 | Reconciliation of Percent Change in the CPI with Percent Change in the PCE Price Index |

- Line numbers within a table are not fixed across comprehensive revisions. Pick series by `SeriesCode` + `LineDescription`, not by LineNumber alone.
- Discontinued 2025-09-25: T20700A (2.7A), T31400 (3.14), and the 6.xA/B/C historical industry tables. T6xxxxD tables are still listed.

**Regional TableName** (App. N list). Inside a table, LineCode picks the statistic; `Code` = `TABLE-LINE`.

| TableName | content | LineCode convention |
|---|---|---|
| SAINC1 / SQINC1 / CAINC1 | personal income summary: state annual 1929→, state quarterly 1948→, county 1969→ | 1 = personal income (thousands of $ for county, millions for state), 2 = population, 3 = per-capita PI ($) [guide] |
| SAINC4 / SQINC4 / CAINC4 | personal income (and employment) by major component | 10 = personal income, 20 = population, 30 = per-capita PI (the guide's examples use CAINC4 lines 10 and 30); other lines are components (UNVERIFIED) |
| SAINC5N / CAINC5N, SAINC6N / CAINC6N, SAINC7N | earnings / compensation / wages by NAICS industry | industry line codes; list them with GetParameterValuesFiltered |
| SAINC30 / CAINC30 | economic profile | see the cuts in §2 |
| SAINC35, SAINC40, SAINC50, SAINC51 | transfers, property income, taxes, disposable PI | – |
| SASUMMARY | state annual income and product summary (1998→) | – |
| SAGDP1–SAGDP11 (also written SAGDP2N, SAGDP9N…) | annual state GDP: 2 = current $ by industry, 3 = taxes less subsidies, 4 = compensation, 8 = quantity index, 9 = real (chained) GDP, 11 = contributions | industry lines. Line 1 = all-industry total (verified in the SAGDP9 bulk file: line 1 "All industry total", line 2 "Private industries"). The guide's SAGDP9N "Real GDP" example uses LineCode=2. |
| SQGDP1, SQGDP2, SQGDP8, SQGDP9, SQGDP11 | quarterly state GDP (2005→) | same as SAGDP |
| CAGDP1, CAGDP2, CAGDP8, CAGDP9, CAGDP11 | county GDP (2001→; MSA rows dropped Feb 2026) | industry lines |
| SARPP / MARPP / PARPP | regional price parities: state / MSA / portion (2008→) | e.g. 1 = all items RPP (UNVERIFIED) |
| SAPCE1–SAPCE4 | PCE by state (1997→) | – |
| SAACArts* / SAAC* | arts and culture satellite account by state (2001→); the program is "no longer regularly produced" (2026-02-10) | – |
| TASUMMARY(1), TASUMMARY2; PRGDP*-* | U.S. territories; Puerto Rico GDP (GeoFips=72000) | – |

**Table-name inconsistency:** the 2026 App. N list writes `SAGDP2`, `SAGDP9`, `TASUMMARY`, but its own example and RegionalApi.pdf use `SAGDP9N`/`SAGDP2N`, and the guide's GetParameterValues sample shows `TASUMMARY1`. **Always resolve names with `GetParameterValues(DatasetName=Regional, ParameterName=TableName)`** before calling GetData.

---------------------------------------------------------------------------------------------------
## 9. Implementation checklist for the skill
1. Read the key from the environment, check it is 36 characters, and redact it in logs.
2. Use metadata calls (cached) to check TableName, LineCode, Frequency and Year before calling GetData.
3. Request `ResultFormat=JSON`. Parse defensively:
   - unwrap a list-valued `Results`
   - look for `Error` at both `BEAAPI` and `Results`
   - handle `BEAAPI.Data` (IIP) and single-object `Data`
   - treat an empty body or HTML as a server failure
4. Raise errors with APIErrorCode, description and ErrorDetail. Do not retry on codes 1, 3, 4, 40 or 2xx. On HTTP 429 or code 7, sleep for `Retry-After` (or 60 s), and if the block continues assume up to 1 hour.
5. Throttle on the client to at most about 90 requests/min, a running byte budget under 100 MB/min, and an error budget under 30/min, all single-threaded.
6. Parse values: strip commas, map suppression codes to NaN while keeping the raw flag, apply UNIT_MULT, parse TimePeriod (`Y`, `YQn`, `YMmm`), and join Notes through NoteRef.
7. Show the ToS attribution sentence in outputs and record `UTCProductionTime` or the date retrieved as the vintage.

---------------------------------------------------------------------------------------------------
## URLs opened
- https://apps.bea.gov/api/_pdf/bea_web_service_api_user_guide.pdf (pypdf, 69 pp.)
- https://apps.bea.gov/API/signup/ and https://apps.bea.gov/api/ (redirect to signup), https://apps.bea.gov/developers/ (redirect)
- https://apps.bea.gov/API/_pdf/bea_api_tos.pdf
- https://apps.bea.gov/API/swagger/index.htm and https://apps.bea.gov/api/swagger/swagger.json
- https://apps.bea.gov/API/docs/index.htm; https://apps.bea.gov/api/bea_web_service_api_user_guide.htm (now 404)
- https://web.archive.org/web/20240316125212/https://apps.bea.gov/API/bea_web_service_api_user_guide.htm
- https://apps.bea.gov/api/data?… (invalid-key test calls, 7 requests)
- https://apps.bea.gov/national/Release/TXT/TablesRegister.txt
- https://apps.bea.gov/regional/pdf/RegionalApi.pdf; https://apps.bea.gov/regional/definitions/
- https://www.bea.gov/data/discontinued-or-delayed-statistics; https://www.bea.gov/itable/discontinued-data-tables
- https://www.bea.gov/help/guidelines-for-citing-bea; https://www.bea.gov/resources/for-developers; https://apps.bea.gov/developers/r-index.htm
- https://www.bea.gov/news/schedule; https://apps.bea.gov/API/signup/release_dates.json; https://apps.bea.gov/histdata/
- https://api.github.com/orgs/us-bea/repos; github.com/us-bea/beaapi (README.md, CHANGELOG.md, beaapi/{__init__, api_request, response_to_dict, response_to_table, throttling_caller, get_data, get_row_data_value, beaapi_error, update_metadata}.py, docs/example_tables.ipynb)
- https://raw.githubusercontent.com/us-bea/bea_geo_aggregator/HEAD/README.md
- https://reaproject.org/united-states-sub/analysis/personal-income-ca05n/ (no symbol definitions found)
