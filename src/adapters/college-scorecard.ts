/**
 * College Scorecard adapter (port of the Python adapter.py).
 *
 * - beforeRequest: short aliases (name, state, ownership, predominant_degree) become the API's dotted field
 *   filters; `fields` may be a list and may use catalog aliases (earnings_10yr); without `fields` the popular set
 *   is sent (the API would otherwise return about 3,000 fields per school).
 * - normalize: adds label columns for the coded ownership and degree fields (the codes stay).
 * - manualItems: links carry api_key=DEMO_KEY, because api.data.gov refuses a request without a key.
 */
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import type { Adapter, Pack, Row, Spec, SpecRequest } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyStr, pyUrlencode } from "../core/py.js";

const POPULAR = ["id", "school.name", "school.state", "school.city", "school.ownership", "school.degrees_awarded.predominant",
  "latest.admissions.admission_rate.overall", "latest.student.size", "latest.cost.tuition.in_state",
  "latest.cost.tuition.out_of_state", "latest.cost.avg_net_price.overall",
  "latest.aid.median_debt.completers.overall", "latest.aid.pell_grant_rate",
  "latest.completion.rate_suppressed.overall", "latest.earnings.10_yrs_after_entry.median",
  "latest.earnings.6_yrs_after_entry.median"];
const ALIASES: Record<string, string> = { name: "school.name", state: "school.state", ownership: "school.ownership",
  predominant_degree: "school.degrees_awarded.predominant" };
const OWNERSHIP: Record<string, string> = { "1": "Public", "2": "Private nonprofit", "3": "Private for-profit" };
const DEGREE: Record<string, string> = { "0": "Not classified", "1": "Certificate", "2": "Associate", "3": "Bachelor's",
  "4": "Graduate" };
const LABELS: Record<string, Record<string, string>> = { "school.ownership": OWNERSHIP,
  "school.degrees_awarded.predominant": DEGREE, "school.degrees_awarded.highest": DEGREE };

function catalog(): Record<string, any> {
  return readJson(path.join(PACKS_DIR, "college-scorecard"), "endpoints.json")?.catalog || {};
}

function fields(v: unknown): string {
  const cat = catalog();
  const items = Array.isArray(v) ? v : pyStr(v).split(",");
  const out: string[] = [];
  for (const x of items.map((i) => pyStr(i).trim())) if (x) out.push(x in cat ? cat[x].id : x);
  if (!out.includes("id")) out.unshift("id");
  return [...new Set(out)].join(",");
}

/** sort=<field>[:asc|desc][,...] with the same short names as filters and fields (name -> school.name, catalog
 * aliases): the API answers HTTP 400 to a short name inside sort. */
function sortParam(v: unknown): string {
  const cat = catalog();
  const out: string[] = [];
  for (const part of pyStr(v).split(",").map((x) => x.trim())) {
    if (!part) continue;
    const i = part.indexOf(":");
    const [f0, sep, d] = i < 0 ? [part, "", ""] : [part.slice(0, i), ":", part.slice(i + 1)];
    const f1 = f0.trim();
    const f = ALIASES[f1] ?? (f1 in cat ? cat[f1].id : f1);
    out.push(f + sep + d.trim());
  }
  return out.join(",");
}

function beforeRequest(_req: SpecRequest, _ep: any, params: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = { ...params };
  for (const [short, full] of Object.entries(ALIASES)) {
    if (short in p) {
      const v = p[short];
      delete p[short];
      if (!(full in p)) p[full] = v;
    }
  }
  p.fields = fields(p.fields || POPULAR);
  if (p.sort) p.sort = sortParam(p.sort);
  delete p._fields;
  for (const [k, v] of Object.entries(p)) if (Array.isArray(v)) p[k] = v.map(pyStr).join(",");
  return p;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    if ("per_page" in p || "page" in p) {
      probs.push(`request '${r.name}': do not set page/per_page (the pack pages, 100 a page); use max_rows to limit the rows`);
    }
    const f = Array.isArray(p.fields) ? p.fields.join(",") : pyStr(p.fields || "");
    if (f.includes("programs") && !p.id) {
      probs.push(`request '${r.name}': field-of-study (programs) fields are very large; request them for one school id at a time`);
    }
  }
  return probs;
}

function normalize(_req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  for (const r of rows) {
    for (const [col, labels] of Object.entries(LABELS)) {
      if (col in r && r[col] !== "") r[col + "_label"] = labels[pyStr(r[col])] ?? "";
    }
  }
  return rows;
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const base = String(pack.endpoints?.base_url || "").replace(/\/+$/, "");
  const byName = new Map((spec.requests || []).map((r) => [r.name, r]));
  const items = gr.manualItems(pack, spec);
  for (const it of items) {
    const r = byName.get(it.request);
    if (!r) continue;
    const [ep, params] = gr.resolve(pack, r);
    const [p, query] = gr.split(ep, beforeRequest(r, ep, params));
    const part = String(it.name).split("#").pop() || "";
    const page = /^\d+$/.test(part) ? Number(part) - 1 : 0;
    Object.assign(query, { page, per_page: 100, api_key: "DEMO_KEY" });
    it.url = `${base}/${p.replace(/^\/+/, "")}?` + pyUrlencode(query);
    it.note = (it.note ? it.note + "; " : "") +
      "api_key=DEMO_KEY is api.data.gov's public demo key (about 10 requests an hour); replace it with your " +
      "own free key from https://api.data.gov/signup/ if the link answers OVER_RATE_LIMIT.";
  }
  return items;
}

const adapter: Adapter = { beforeRequest, checkSpec, normalize, manualItems };
export default adapter;
