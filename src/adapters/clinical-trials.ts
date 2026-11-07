/**
 * ClinicalTrials.gov API v2 adapter.
 *
 * - Lists (filter.overallStatus, filter.ids, fields, sort) may be given as JSON lists; they are sent joined
 *   with "|" (the API accepts "|" or ",").
 * - phase / study_type convenience keys become aggFilters codes. Codes verified 2026-10-20 against the
 *   registry's field counts: phase 0 = EARLY_PHASE1, 1-4, NA = not applicable; studyType int / obs / exp.
 * - Records are nested (protocolSection.identificationModule.nctId ...). normalize() renames every column
 *   to its shortest unique path suffix within the table (nctId, briefTitle, startDateStruct.date,
 *   leadSponsor.name; generic last parts such as name, count, type keep their parent); values are untouched.
 * - pageSize is capped at 1,000 by the API; paging follows nextPageToken.
 */
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import type { Adapter, Row } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyStr } from "../core/py.js";
import { pyRepr } from "./_govinfo_py.js";

const HERE = path.join(PACKS_DIR, "clinical-trials");
const LISTS = ["filter.overallStatus", "filter.ids", "fields", "sort"];

function enums(): any {
  return readJson(HERE, "endpoints.json")?.enums || {};
}

function asList(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  if (Array.isArray(v)) return v.map(pyStr);
  return pyStr(v).replace(/,/g, "|").split("|").filter(Boolean);
}

const GENERIC = new Set(["name", "class", "count", "type", "date", "value", "id", "status", "role", "description", "title"]);

function shortNames(keys: string[]): Record<string, string> {
  const parts = new Map(keys.map((k) => [k, k.split(".")]));
  const out: Record<string, string> = {};
  for (const [k, segs] of parts) {
    const start = GENERIC.has(segs[segs.length - 1]) && segs.length > 1 ? 2 : 1;
    let found = false;
    for (let n = start; n <= segs.length; n++) {
      const cand = segs.slice(-n).join(".");
      let count = 0;
      for (const o of parts.values()) if (o.slice(-n).join(".") === cand) count++;
      if (count === 1) {
        out[k] = cand;
        found = true;
        break;
      }
    }
    if (!found) out[k] = k;
  }
  return out;
}

const adapter: Adapter = {
  beforeRequest(_req, _ep, params) {
    const p: Record<string, unknown> = { ...params };
    for (const k of LISTS) if (Array.isArray(p[k])) p[k] = (p[k] as unknown[]).map(pyStr).join("|");
    const en = enums();
    const agg = pyStr(p.aggFilters || "").split(",").filter(Boolean);
    delete p.aggFilters;
    const ph = asList(p.phase).filter((x) => x.toUpperCase() in en.phase).map((x) => en.phase[x.toUpperCase()]);
    delete p.phase;
    if (ph.length) agg.push("phase:" + ph.join(" "));
    const st = asList(p.study_type).filter((x) => x.toUpperCase() in en.studyType).map((x) => en.studyType[x.toUpperCase()]);
    delete p.study_type;
    if (st.length) agg.push("studyType:" + st.join(" "));
    if (agg.length) p.aggFilters = agg.join(",");
    return p;
  },

  checkSpec(spec) {
    const probs: string[] = [];
    const en = enums();
    for (const r of spec.requests || []) {
      const name = r.name;
      const prm = r.params || {};
      for (const x of asList(prm.phase)) {
        if (!(x.toUpperCase() in en.phase)) probs.push(`request ${pyRepr(name)}: phase ${pyRepr(x)} is not one of ${pyRepr(Object.keys(en.phase))}`);
      }
      for (const x of asList(prm.study_type)) {
        if (!(x.toUpperCase() in en.studyType)) {
          probs.push(`request ${pyRepr(name)}: study_type ${pyRepr(x)} is not one of ${pyRepr(Object.keys(en.studyType))}`);
        }
      }
      for (const x of asList(prm["filter.overallStatus"])) {
        if (!en.overallStatus.includes(x)) {
          probs.push(`request ${pyRepr(name)}: status ${pyRepr(x)} is not one of ${pyRepr(en.overallStatus)} (upper case)`);
        }
      }
      if (r.endpoint === "field_values" && asList(prm.fields).length > 1) {
        probs.push(`request ${pyRepr(name)}: field_values takes one field per request`);
      }
      if ((r.endpoint === undefined || r.endpoint === null || r.endpoint === "studies") &&
        !Object.keys(prm).some((k) => k.startsWith("query.") || k.startsWith("filter.") || ["aggFilters", "phase", "study_type"].includes(k))) {
        probs.push(`request ${pyRepr(name)}: give a query.* search or a filter (the registry has 600,000+ studies)`);
      }
    }
    return probs;
  },

  normalize(_req, _ep, rows) {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
    const m = shortNames(keys);
    return rows.map((r) => {
      const o: Row = {};
      for (const [k, v] of Object.entries(r)) o[m[k]] = v;
      return o;
    });
  },

  manualItems(spec, pack) {
    const items = gr.manualItems(pack, spec);          // core applies beforeRequest to the links
    for (const it of items) {
      if (it.url.includes("/studies?")) {
        it.note = "First 1,000 studies only. For all of them, run the same search on https://clinicaltrials.gov/ " +
          "(Advanced Search) and use Download > CSV, then upload that file.";
      }
    }
    return items;
  },
};

export default adapter;
