# Census Geocoder (addresses and coordinates to census geographies)
Depth: standard. Key: none. Turns a one-line U.S. address into its matched address, coordinates and census
geography codes, or a point (longitude, latitude) into its geography codes. Use it to join an address or a
place to census, cdc, hud, usaspending or fema data by FIPS code.

## When to use
- "Which census tract, county or congressional district is this address in", "the FIPS codes of these places",
  "the coordinates of an address" (nrel, nws and epa take coordinates).
- Not population or statistics: those come from census (ACS, decennial) with the codes found here.
- Not here: international addresses, PO boxes, and batches of many addresses. The batch form takes up to 10,000
  per file on the geocoder's website: point the user to it; this pack geocodes one address per request.

## Endpoints
| Endpoint | Returns | Parameters |
|---|---|---|
| `address` | one row per match: `input`, `matched_address`, `lon`, `lat`, `tiger_line_id`, `tiger_side`, `state_fips`, `state_usps`, `county_fips` (5 digits), `tract_geoid` (11), `block_geoid` (15), and `<layer>.GEOID` / `<layer>.NAME` for every layer | `address`, `benchmark`, `vintage`, `layers` |
| `address_location` | one row per match with coordinates and TIGER line, no geographies (faster) | `address`, `benchmark` |
| `coordinates` | one row: `lon`, `lat` and the same geography columns | `x` (longitude), `y` (latitude), `benchmark`, `vintage`, `layers` |
| `benchmarks` | the address-range benchmarks served | none |
| `vintages` | the geography vintages of a benchmark | `benchmark` |

## Spec examples
```json
{"description": "Census geographies of the White House, current boundaries",
 "requests": [{"name": "white_house", "endpoint": "address",
               "params": {"address": "1600 Pennsylvania Ave NW, Washington, DC 20500"}}]}
```
```json
{"description": "Tract and county of a point in Baltimore, 2020 census boundaries",
 "requests": [{"name": "baltimore_point", "endpoint": "coordinates",
               "params": {"x": -76.6122, "y": 39.2904, "benchmark": "Public_AR_Current", "vintage": "Census2020_Current"}}]}
```

## Units and traps
- **Match the vintage to the data you join.** Tract and block codes change with each decennial census, and
  county codes changed in Connecticut (planning regions from 2022). Joining ACS 2023 data? Use an ACS vintage;
  2020 census counts? `Census2020_Current`. Say which vintage was used.
- **No match is not an error of the data.** An address can fail to match (a new street, a typo, a rural route):
  the request returns no rows. Add `"allow_empty": true` when that is a possible answer, and say the address did
  not match. A fuzzy address can match more than one place: check `matched_address` before using the codes.
- **Coordinates are interpolated** along the street segment's address range, not a rooftop position.
- `x` is longitude and `y` is latitude, in that order.
- Layer names carry their year (`120th Congressional Districts`, `2026 State Legislative Districts - Upper`):
  read the column names in the data dictionary.

## Access
The API answers from anywhere without a key. Without network access, use the manual bundle, or the geocoder's
web form (Find Geographies) and save the JSON.

## Citation and terms
U.S. Census Bureau, Census Geocoder, <dataset>, geocoding.geo.census.gov, retrieved <date>. Public domain. The
API terms ask for the notice: "This product uses the Census Bureau Data API but is not endorsed or certified by
the Census Bureau."
