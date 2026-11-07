/**
 * USDA FoodData Central adapter (api.nal.usda.gov/fdc/v1).
 *
 * layout (request option, default "long"):
 *   long   one row per food and nutrient: fdcId, description, dataType, brandOwner, foodCategory, ...,
 *          nutrient_number, nutrient_name, unit, value (+ derivation when given). Search results, abridged
 *          and full food records name their nutrient fields differently (nutrientNumber/value,
 *          number/amount, nutrient.number/amount); all three are mapped to the same columns, values as
 *          published.
 *   foods  one row per food; foodNutrients stays a JSON text column.
 * Lists given for dataType or fdcIds are sent as comma-separated text. Keys: DATA_GOV_API_KEY (api.data.gov),
 * else DEMO_KEY (low hourly and daily limits).
 */
import { manualItems as grManualItems, parseUpload as grParseUpload, resolve } from "../core/generic-rest.js";
import type { Adapter, Pack, Row, Spec, SpecRequest } from "../core/packs.js";
import { parsePyJson, pyStr } from "../core/py.js";

const FOOD_COLS = ["fdcId", "description", "dataType", "brandOwner", "brandName", "gtinUpc", "foodCategory",
  "foodCategory.description", "ndbNumber", "foodCode", "servingSize", "servingSizeUnit", "publishedDate", "publicationDate"];
const LAYOUTS = ["long", "foods"];
const repr = (s: unknown) => (s === null || s === undefined ? "None" : `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);

/** Python truthiness of a JSON value. */
const truthy = (v: unknown) => !(v === null || v === undefined || v === "" || v === 0 || v === false ||
  (Array.isArray(v) && !v.length) || (typeof v === "object" && v !== null && !Array.isArray(v) && !Object.keys(v).length));
const or = (...vs: unknown[]) => vs.find(truthy) ?? vs[vs.length - 1];
const isDict = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function beforeRequest(_req: SpecRequest, _ep: any, params: Record<string, unknown>): Record<string, unknown> {
  const p = { ...params };
  for (const k of ["dataType", "fdcIds", "nutrients"]) if (Array.isArray(p[k])) p[k] = (p[k] as unknown[]).map(pyStr).join(",");
  return p;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const name = r.name;
    if (!LAYOUTS.includes(r.layout ?? "long")) probs.push(`request ${repr(name)}: layout must be one of ('long', 'foods')`);
    const ids = (r.params || {}).fdcIds;
    if (ids !== null && ids !== undefined) {
      const n = Array.isArray(ids) ? ids.length : pyStr(ids).split(",").filter((x) => x.trim()).length;
      if (n > 20) {
        probs.push(`request ${repr(name)}: ${n} fdcIds; the foods endpoint is documented for at most 20 per request ` +
          "and silently drops extra ids (past 50), so split it into requests of 20 or fewer");
      }
    }
  }
  return probs;
}

function nutrient(n: Record<string, any>): Row {
  const nut = isDict(n.nutrient) ? n.nutrient : {};
  const der = isDict(n.foodNutrientDerivation) ? n.foodNutrientDerivation : {};
  return { nutrient_number: or(n.nutrientNumber, n.number, nut.number, ""), nutrient_id: or(n.nutrientId, nut.id, ""),
    nutrient_name: or(n.nutrientName, n.name, nut.name, ""), unit: or(n.unitName, nut.unitName, ""),
    value: n.value !== null && n.value !== undefined ? n.value : "amount" in n ? n.amount : "",
    derivation: or(n.derivationDescription, der.description, "") };
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  if ((req.layout ?? "long") !== "long") return rows;
  const out: Row[] = [];
  for (const r of rows) {
    const raw = r.foodNutrients;
    let nuts: any[] = [];
    if (typeof raw === "string" && raw.startsWith("[")) {
      try {
        nuts = parsePyJson(raw);
      } catch {
        nuts = [];
      }
    }
    const base: Row = {};
    for (const c of FOOD_COLS) if (c in r) base[c] = r[c] ?? "";
    if (!nuts.length) {
      out.push({ ...base, nutrient_number: "", nutrient_id: "", nutrient_name: "", unit: "", value: "", derivation: "" });
      continue;
    }
    for (const n of nuts) if (isDict(n)) out.push({ ...base, ...nutrient(n) });
  }
  return out;
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items = grManualItems(pack, spec); // core applies beforeRequest to the links
  for (const it of items) {
    it.note = ((it.note ? it.note.replace(/\.+$/, "") + ". " : "") + "DEMO_KEY works in a browser for a few requests an hour; replace " +
      "it with your own api.data.gov key for more. Full datasets (CSV/JSON): " +
      "https://fdc.nal.usda.gov/download-datasets").trim();
  }
  return items;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const rows = grParseUpload(pack, { ...req, layout: "foods" }, files);
  return normalize(req, resolve(pack, req)[0], rows);
}

const adapter: Adapter = { beforeRequest, checkSpec: (spec) => checkSpec(spec), normalize, manualItems, parseUpload };
export default adapter;
