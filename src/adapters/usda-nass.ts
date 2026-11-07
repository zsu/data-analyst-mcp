/**
 * USDA NASS Quick Stats adapter (key in the "key" query parameter).
 *
 * - Filter values in Quick Stats are upper case ("CORN", "IOWA", "AREA PLANTED"); beforeRequest upper-cases
 *   the *_desc, state_name, county_name and state_alpha values so "corn" works. Operators (__GE, __LE,
 *   __LT, __GT, __LIKE, __NOT_LIKE, __NE) pass through unchanged.
 * - Value is published text: "510,000", or a suppression code such as "(D)". normalize() keeps Value and
 *   adds value_num (the number without commas, empty for codes) and value_flag (the code). "CV (%)" gets
 *   the same treatment (cv_num, cv_flag).
 * - Errors come back as {"error": ["exceeds limit = 50000"]} (also inside HTTP 200, handled here).
 * - get_param_values answers {"<param>": [values]} (or a bare list, per the documentation): one row per value.
 */
import { manualItems as grManualItems } from "../core/generic-rest.js";
import type { Adapter, Pack, Row, Spec, SpecRequest } from "../core/packs.js";
import { parseQsl, pyStr, quotePlus, urlsplit, urlunsplit } from "../core/py.js";

const UPPER = /^(.*_desc|state_name|county_name|state_alpha|asd_desc|region_desc)(__.*)?$/s;
const CODE = /^\(([A-Z]{1,2})\)$/;
/** float() text: digits with an optional sign, point and exponent, or inf/nan (Python accepts them). */
const PY_FLOAT = /^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i;
const repr = (s: unknown) => (s === null || s === undefined ? "None" : `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);

function checkError(_status: number, body: Buffer): string | null {
  const head = body.subarray(0, 400);
  if (head.subarray(0, 1).toString("latin1") === "{" && head.includes('"error"')) {
    let err: any;
    try {
      err = JSON.parse(body.toString("utf8")).error;
    } catch {
      return null;
    }
    let msg = Array.isArray(err) ? err.map(pyStr).join("; ") : err === null || err === undefined ? "None" : pyStr(err);
    if (msg.includes("exceeds limit")) {
      msg += " (more than 50,000 rows: add filters such as year, state_alpha, short_desc, or split the years)";
    }
    return msg;
  }
  return null;
}

function beforeRequest(_req: SpecRequest, _ep: any, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k] = typeof v === "string" && UPPER.test(k) && k !== "param" ? v.toUpperCase() : v;
  return out;
}

function num(v: unknown): [string, string] {
  const s = (v === null || v === undefined || v === "" || v === 0 || v === false ? "" : pyStr(v)).trim();
  const m = CODE.exec(s);
  if (m) return ["", m[1]];
  const t = s.replace(/,/g, "");
  return PY_FLOAT.test(t.trim()) ? [t, ""] : ["", s];
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  if (req.endpoint === "param_values") {
    const out: Row[] = [];
    for (const r of rows) {
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      for (const [k, v] of Object.entries(r)) {
        const vals = Array.isArray(v) ? v : [v];
        const param = k === "value" ? (req.params || {}).param ?? k : k;
        for (const x of vals) out.push({ param, value: x });
      }
    }
    return out;
  }
  for (const r of rows) {
    if ("Value" in r) [r.value_num, r.value_flag] = num(r.Value);
    if ("CV (%)" in r) [r.cv_num, r.cv_flag] = num(r["CV (%)"]);
  }
  return rows;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    const ep = "endpoint" in r ? r.endpoint : "query";
    const filtered = Object.keys(p).some((k) => ["year", "commodity_desc", "short_desc", "statisticcat_desc"].some((x) => k.startsWith(x)));
    if (ep === "query" && !filtered && !r.dataset) {
      probs.push(`request ${repr(r.name)}: add at least a commodity_desc or short_desc and a year filter ` +
        "(Quick Stats refuses queries over 50,000 rows)");
    }
  }
  return probs;
}

/** urlencode(pairs, safe="{}"): the {API_KEY} placeholder stays readable. */
const encodeSafe = (s: string) => quotePlus(s).replace(/%7B/g, "{").replace(/%7D/g, "}");

/** API links with format=CSV and {API_KEY}; the Quick Stats web page needs no key (see source.md). */
function manualItems(spec: Spec, pack: Pack): any[] {
  const reqs = (spec.requests || []).map((r) => ({ ...r, params: beforeRequest(r, null, r.params || {}) }));
  const items = grManualItems(pack, { ...spec, requests: reqs });
  for (const it of items) {
    if (it.url.includes("/api/api_GET/")) {
      const parts = urlsplit(it.url);
      const q = parseQsl(parts.query).map(([k, v]) => [k, k === "format" ? "CSV" : v]);
      it.url = urlunsplit({ ...parts, query: q.map(([k, v]) => `${encodeSafe(k)}=${encodeSafe(v)}`).join("&") });
      it.filename = it.filename.replace(/\.json$/, ".csv");
    }
    it.note = "needs your free Quick Stats key in place of {API_KEY}; without a key, build the same query on " +
      "https://quickstats.nass.usda.gov/ and use Get Data > Spreadsheet";
  }
  return items;
}

const adapter: Adapter = { checkError, beforeRequest, normalize, checkSpec: (spec) => checkSpec(spec), manualItems };
export default adapter;
