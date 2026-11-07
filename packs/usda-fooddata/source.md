# USDA FoodData Central
Depth: standard. Key: optional (DATA_GOV_API_KEY; DEMO_KEY otherwise). Nutrient composition of foods:
Foundation Foods, SR Legacy, the Food and Nutrient Database for Dietary Studies (FNDDS, foods as eaten in
NHANES), and the Branded Foods database (label data of commercial products).

## When to use
- Calories, macronutrients, vitamins and minerals of a food or a list of foods; comparing products;
  nutrient profiles of a food category; branded products of a brand owner.
- Not here: what people eat or how much (NHANES intake, not covered), food prices (not covered), food
  recalls and safety (fda), crop and livestock statistics (usda-nass), school meals or SNAP (not covered).

## Endpoints and datasets
| Endpoint | Returns | Parameters |
|---|---|---|
| `search` | foods matching words or field queries (`foodCategory:"Cheese"`), with nutrients (200 a page) | `query` (required), `dataType`, `brandOwner`, `sortBy`, `sortOrder` |
| `food` | one food (all nutrients) | `fdcId`, `format` (full, abridged), `nutrients` |
| `foods` | up to 20 foods by id per request (the pack's limit; see traps) | `fdcIds` (list), `format` (default abridged), `nutrients` |
| `list` | every food of a data type, paged | `dataType`, `sortBy`, `sortOrder` |

`dataType` values (catalog aliases in `--endpoints`): `Foundation`, `SR Legacy`, `Survey (FNDDS)`,
`Branded` (a list means any of them). `nutrients` takes nutrient NUMBERS (not ids): 208 energy kcal,
203 protein, 204 total fat, 205 carbohydrate, 269 total sugars, 291 fiber, 307 sodium, 301 calcium,
303 iron, 306 potassium, 601 cholesterol, 606 saturated fat, 605 trans fat, 401 vitamin C, 320 vitamin A
RAE, 328 vitamin D, 255 water (table in endpoints.json `nutrient_numbers`).

Request option `layout`: `"long"` (default) gives one row per food and nutrient with columns `fdcId`,
`description`, `dataType`, `brandOwner`, `foodCategory`, `servingSize`, `servingSizeUnit`,
`publishedDate`, `nutrient_number`, `nutrient_id`, `nutrient_name`, `unit`, `value`, `derivation`;
`"foods"` gives one row per food with `foodNutrients` as JSON text.

## Spec examples
```json
{"description": "Cheddar cheese (Foundation) nutrients",
 "requests": [{"name": "cheddar_foundation", "endpoint": "search", "params": {"query": "cheddar", "dataType": ["Foundation"]}}]}
```
```json
{"description": "Energy, protein and fat of two cheeses",
 "requests": [{"name": "two_cheeses", "endpoint": "foods", "params": {"fdcIds": [328637, 169901], "nutrients": "203,204,208"}}]}
```
```json
{"description": "Branded products in one food category (first 5,000; totalHits says how many), with nutrients",
 "requests": [{"name": "cheese_category", "endpoint": "search", "max_rows": 5000,
   "params": {"query": "foodCategory:\"Cheese\"", "dataType": ["Branded"]}}]}
```
```json
{"description": "Sodium in branded potato chips (first 1,000 products)",
 "requests": [{"name": "chips_sodium", "endpoint": "search", "max_rows": 1000,
   "params": {"query": "potato chips", "dataType": ["Branded"]}}]}
```
Search, then pick foods by `fdcId` and `dataType`; keep the id in the report so the numbers can be traced.

## Data format and traps
- Nutrient values are per 100 g of edible food (per 100 ml for beverages measured in ml), for every data type.
  Branded foods convert the label to 100 g: a cheese with `servingSize` 28 g lists protein 21.4, which is
  per 100 g, not per serving (checked). Per-serving amounts = value x servingSize / 100.
- Energy appears more than once: kcal (208) and kJ (268); newer Foundation foods carry only
  957 "Energy (Atwater General Factors)" and 958 "(Atwater Specific Factors)" and no 208 (checked for raw
  apples). Filter by `nutrient_number` and `unit`, never by name alone, and say which energy is used.
  Branded beverages are per 100 ml (orange juice: 46 kcal, serving 240 ml).
- Unit spelling differs by endpoint: search and abridged records use "G", "MG", "UG", "KCAL"; full records
  use "g", "mg", "kcal". Compare case-insensitively.
- Search matches words loosely and ranks by score: "cheddar cheese" returned 301 Foundation and SR
  Legacy hits, including imitation cheese. Check `description` and `dataType`, or use `+word` and quoted
  phrases (a quoted phrase must stand in that order in the description, so it can return very few rows;
  check the count, and use a field query for a category). `totalHits` can be large for Branded (60,638 for "cheese").
- **Field queries** (Lucene style, verified 2026-10-28): `query` can name a field, `foodCategory:"Cheese"`
  (Branded: 23,601 products), `ingredients:"annatto"`, `brandOwner:"..."`, `description:...`, and combine
  them with `+` (must) and `-` (must not): `+foodCategory:"Cheese" +ingredients:"annatto"`. **For "products in
  a category", filter on `foodCategory`, never a union of word searches** (word searches pull in other
  products and miss products whose names lack the word). Quote a value of several words: unquoted, only the
  first word is bound to the field (`foodCategory:Breakfast Cereals` searched "Cereals" everywhere, 12,661
  hits). The quoted value matches those words in order within the category name, any case: "Breakfast
  Cereals" also matches "Breakfast Cereals - Hot And Cold". A value that differs from FDC's spelling (an
  extra space or other separator, a made-up name) returns 0 rows, another category, or the front server's
  HTML 400 page: copy the name exactly. Category names: run a word search with `"layout": "foods"` and count
  its `foodCategory` column (Branded names such as "Cheese", "Yogurt"; Foundation and SR Legacy use groups
  such as "Dairy and Egg Products"); the complete Branded list is the `branded_food_category` column of the
  Branded download (https://fdc.nal.usda.gov/download-datasets). Say which category names the answer used.
- The same food appears in several data types with different values (Foundation vs SR Legacy cheddar).
  Do not mix data types in one comparison without saying so.
- A missing nutrient is not zero: Branded products only list label nutrients; SR Legacy and Foundation
  analyze different sets. The long layout has no row for a nutrient that was not reported.
- `derivation` tells analytical vs calculated or imputed values (Foundation, SR Legacy).
- `publishedDate` (search) and `publicationDate` (food records) name the release of the record.
- Paging: `pageSize` at most 200 (HTTP 400 above it, verified).
- An HTML "400 Bad Request" page (from the front server) can answer a valid request that works moments
  later; the API's own parameter errors are JSON or text. The pack retries the HTML page up to 3 times; if
  it persists, run again later rather than rewriting a correct spec.
- `foods` ids: the API spec documents at most 20 `fdcIds`; live (2026-10-22) it returned up to 50 and
  silently dropped the rest, with no error. The pack refuses more than 20 per request: split a longer
  list into several requests. Ids that are not found are omitted too, so compare the row count with the
  ids asked for.

## Access
Key optional: `DATA_GOV_API_KEY` (free api.data.gov key; sign up at https://fdc.nal.usda.gov/api-key-signup),
sent as `api_key`. FDC allows 1,000 requests an hour per key; exceeding it blocks the key for an hour
(FDC API guide). Without a key the pack uses `DEMO_KEY`, whose hourly and daily limits are much lower
(api.data.gov; enough for a few searches). Route `api` either way. Manual route: INSTRUCTIONS.md links
carry DEMO_KEY and open in a browser (save as the shown names, upload); whole data types (CSV or JSON)
are at https://fdc.nal.usda.gov/download-datasets.

## Citation and terms
"U.S. Department of Agriculture, Agricultural Research Service. FoodData Central: <description>.
fdc.nal.usda.gov, retrieved <date>." Public domain, CC0 1.0; USDA asks that FoodData Central be cited as
the source. Redistribution allowed.
