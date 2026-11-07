/**
 * NIH RePORTER API v2 adapter (POST /projects/search, /publications/search).
 *
 * - Friendly spec keys are moved into the "criteria" object: text / phrase -> advanced_text_search,
 *   spending_categories names -> RCDC ids (table in endpoints.json "rcdc_categories"), everything else as given.
 * - exclude_subprojects defaults to true: a multi-project award is listed once as the parent and again for each
 *   subproject, and the subproject amounts are part of the parent's award_amount.
 * - include_fields defaults to a compact set; "all" sends none (every field).
 * - Paging: limit at most 500, offset + limit capped at 15,000 (projects) and offset at most 9,999
 *   (publications: endpoint max_rows 10,000). checkSpec refuses searches with no criteria and max_rows above
 *   the endpoint's cap.
 * - Paging needs a stable order: project searches that may need more than one page sort by appl_id unless the
 *   spec sorts (truncated_note says a cut kept the lowest appl_ids). The core drops rows repeated across pages.
 */
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import type { Adapter } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyStr } from "../core/py.js";
import { pyJsonClient } from "./_govinfo_json.js";
import { getCloseMatches, pyInt, pyRepr, pySplit, pyStrip, truthy } from "./_govinfo_py.js";

const HERE = path.join(PACKS_DIR, "nih");
const TOP = new Set(["criteria", "include_fields", "exclude_fields", "sort_field", "sort_order", "offset", "limit"]);
const DEFAULT_FIELDS = ["ApplId", "ProjectNum", "CoreProjectNum", "SubprojectId", "FiscalYear", "ProjectTitle",
  "Organization", "ContactPiName", "AgencyIcAdmin", "AgencyIcFundings", "ActivityCode", "FundingMechanism", "AwardAmount",
  "DirectCostAmt", "IndirectCostAmt", "ProjectStartDate", "ProjectEndDate", "AwardNoticeDate", "IsActive",
  "SpendingCategoriesDesc", "CongDist", "ProjectDetailUrl"];
const NO_SUBPROJECT_KEYS = ["exclude_subprojects"];

function eps(): any {
  return readJson(HERE, "endpoints.json") || {};
}

/** An object of endpoints.json as [key, value] pairs in file order (JSON.parse moves integer-like keys first). */
function orderedEntries(field: string): [string, string][] {
  const text = fs.readFileSync(path.join(HERE, "endpoints.json"), "utf8");
  const at = text.indexOf(`"${field}"`);
  if (at < 0) return [];
  const open = text.indexOf("{", at);
  const close = text.indexOf("}", open);
  const out: [string, string][] = [];
  const rx = /("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")/g;
  const body = text.slice(open, close);
  for (let m; (m = rx.exec(body)); ) out.push([JSON.parse(m[1]), JSON.parse(m[2])]);
  return out;
}

/** RCDC names or ids -> ids; returns [ids, unknown names]. */
export function rcdcIds(values: unknown): [number[], string[]] {
  const byName = new Map<string, number>();
  for (const [k, v] of orderedEntries("rcdc_categories")) byName.set(v.toLowerCase(), parseInt(k, 10));
  const ids: number[] = [], bad: string[] = [];
  for (const v of Array.isArray(values) ? values : [values]) {
    if ((typeof v === "number" && Number.isInteger(v)) || typeof v === "boolean" || /^\d+$/.test(pyStr(v))) ids.push(pyInt(v));
    else if (byName.has(pyStr(v).toLowerCase())) ids.push(byName.get(pyStr(v).toLowerCase())!);
    else bad.push(pyStr(v));
  }
  return [ids, bad];
}

const projects = (ep: any) => String(ep.path || "").startsWith("/projects");
const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) ||
  (!!v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

function phraseQuery(phrase: unknown): string {
  const items = Array.isArray(phrase) ? phrase : [phrase];
  return items.filter((x) => pyStrip(pyStr(x))).map((x) => '"' + pyStrip(pyStr(x).split('"').join(" ")) + '"').join(" OR ");
}

const adapter: Adapter = {
  /** generic-rest, with lists of objects written as Python's json.dumps wrote them (see _govinfo_json.ts). */
  async fetch(spec, pack, _route) {
    return gr.fetchSpec(pack, spec, pyJsonClient(gr.clientFor(pack), pack));
  },

  beforeRequest(req, ep, params) {
    const p: Record<string, unknown> = { ...params };
    const crit: Record<string, unknown> = { ...((p.criteria || {}) as object) };
    delete p.criteria;
    const text = p.text ?? null, phrase = p.phrase ?? null;
    delete p.text;
    delete p.phrase;
    const fields = truthy(p.text_fields) ? p.text_fields : "projecttitle,terms,abstracttext";
    delete p.text_fields;
    if (truthy(phrase)) {      // exact phrase: RePORTER's advanced operator with the phrase quoted
      crit.advanced_text_search = { operator: "advanced", search_field: fields, search_text: phraseQuery(phrase) };
    } else if (truthy(text)) {   // every word, anywhere in the fields, any order
      crit.advanced_text_search = { operator: "and", search_field: fields, search_text: text };
    }
    const cats = p.spending_categories;
    delete p.spending_categories;
    if (truthy(cats)) crit.spending_categories = { values: rcdcIds(cats)[0], match_all: "false" };
    for (const k of Object.keys(p)) {
      if (!TOP.has(k)) {
        crit[k] = p[k];
        delete p[k];
      }
    }
    if (projects(ep)) {
      if (!("exclude_subprojects" in crit)) crit.exclude_subprojects = true;
      const onePage = truthy(req.max_rows) && pyInt(req.max_rows) <= 500;
      if (!truthy(p.sort_field) && !onePage) {     // several pages need a stable order, or pages repeat and skip
        p.sort_field = "appl_id";
        p.sort_order = truthy(p.sort_order) ? p.sort_order : "asc";
      }
      const inc = p.include_fields;
      if (inc === null || inc === undefined || inc === "" || (Array.isArray(inc) && !inc.length)) p.include_fields = DEFAULT_FIELDS;
      else if (inc === "all") delete p.include_fields;
    }
    p.criteria = crit;
    return p;
  },

  /** Say how a text search was matched: the same words as a phrase or anywhere give different rows. */
  requestNote(req, _ep, _params) {
    const p = req.params || {};
    const where = truthy(p.text_fields) ? p.text_fields : "title, terms and abstract";
    if (truthy(p.phrase)) {
      return `${req.name}: phrase ${pyRepr(p.phrase)} matched as an exact phrase in ${pyStr(where)} (RePORTER operator ` +
        "advanced); `text` would match every word anywhere.";
    }
    if (truthy(p.text) && pySplit(pyStr(p.text)).length > 1) {
      return `${req.name}: text ${pyRepr(p.text)} matched every word anywhere in ${pyStr(where)}, in any order (RePORTER ` +
        "operator and), so rows need not hold the phrase; use `phrase` for the exact phrase.";
    }
    return null;
  },

  checkSpec(spec) {
    const probs: string[] = [];
    const table = orderedEntries("rcdc_categories").map(([, v]) => v);
    for (const r of spec.requests || []) {
      const name = pyRepr(r.name);
      const prm: Record<string, any> = { ...(r.params || {}) };
      const all = { ...(prm.criteria || {}), ...Object.fromEntries(Object.entries(prm).filter(([k]) => !TOP.has(k))) };
      const crit = Object.entries(all).filter(([k, v]) => ![...NO_SUBPROJECT_KEYS, "text_fields"].includes(k) && !empty(v));
      if (!crit.length) {
        probs.push(`request ${name}: give at least one criterion (fiscal_years, agencies, text, org_states, ` +
          "...); one search returns at most 15,000 records");
      }
      if (truthy(prm.spending_categories)) {
        for (const b of rcdcIds(prm.spending_categories)[1]) {
          const near = getCloseMatches(b, table, 4, 0.5);
          probs.push(`request ${name}: RCDC category ${pyRepr(b)} is not known` +
            (near.length ? `; close: ${pyRepr(near)}` : "; use a request_schema search to find names or pass the numeric id"));
        }
      }
      if (truthy(prm.text) && truthy(prm.phrase)) {
        probs.push(`request ${name}: give text (every word, anywhere) or phrase (exact phrase), not both`);
      }
      if (["number", "string", "boolean"].includes(typeof prm.fiscal_years)) {
        probs.push(`request ${name}: fiscal_years must be a list, e.g. [2024]`);
      }
      const mr = (eps().endpoints?.[r.endpoint || ""] || {}).max_rows;
      const cap = pyInt(truthy(mr) ? mr : 15000);
      if (truthy(r.max_rows) && pyInt(r.max_rows) > cap) {
        const how = cap < 15000 ? "split the project numbers or PMIDs into several requests" : "split by fiscal year, agency or state";
        probs.push(`request ${name}: RePORTER returns at most ${cap.toLocaleString("en-US")} records per ` +
          `${r.endpoint ?? "None"} search; ${how}`);
      }
    }
    return probs;
  },

  manualItems(spec, pack) {
    const items = gr.manualItems(pack, spec);          // core applies beforeRequest to the links
    for (const it of items) {
      it.note = ((it.note ? it.note.replace(/\.+$/, "") + ". " : "") + "POST request: run a download script, or use the RePORTER website " +
        "search (https://reporter.nih.gov/advanced-search) and Export, then upload the CSV.").trim();
    }
    return items;
  },

  /** Search RCDC spending categories and agencies (offline tables in endpoints.json). */
  search(query, _pack) {
    const words = pySplit(query.toLowerCase()).filter((w) => w.length > 1);
    const count = (text: string, w: string) => text.split(w).length - 1;
    const hits: [number, any][] = [];
    for (const [k, v] of orderedEntries("rcdc_categories")) {
      const s = words.reduce((n, w) => n + count(v.toLowerCase(), w), 0);
      if (s) hits.push([s, { rcdc_category: v, id: parseInt(k, 10), use: `"spending_categories": ["${v}"]` }]);
    }
    for (const [k, v] of orderedEntries("agencies")) {
      const s = words.reduce((n, w) => n + count(`${k} ${v}`.toLowerCase(), w), 0);
      if (s) hits.push([s, { agency: k, name: v, use: `"agencies": ["${k}"]` }]);
    }
    const out = hits.sort((a, b) => b[0] - a[0]).map(([, h]) => h);
    return [...out.slice(0, 20), ...(out.length > 20 ? [{ note: "more than 20 matches; narrow the words" }] : []),
      ...(out.length ? [] : [{ note: "no RCDC category or agency matched; use text for free-text search" }])];
  },
};

export default adapter;
