/**
 * HUD User FMR / Income Limits API adapter (token in an Authorization: Bearer header).
 *
 * Responses are wrapped in {"data": ...} with a different shape per resource (documented on
 * https://www.huduser.gov/portal/dataset/fmr-api.html):
 *   fmr/data            one area; basicdata is an object (one row) or, for Small Area FMR metros, a list
 *                       with one entry per ZIP plus "MSA level"
 *   fmr/statedata       {"year", "metroareas": [...], "counties": [...]}  -> one row per area, area_type column
 *   il/data, mtspil     one area with nested limit objects -> one row, the nested keys become columns
 *   list*               a list (a bare list is accepted too)
 * il/statedata is not documented; lists inside it are turned into rows the same way (unverified).
 */
import fs from "node:fs";
import path from "node:path";
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { columnsOf, withColumns } from "../core/package.js";
import { parsePyJson, pyStr } from "../core/py.js";
import { readExcel } from "./_hud_excel.js";

const STATE_EPS = ["fmr_state", "il_state", "list_counties"];
const ENTITY_EPS = ["fmr", "income_limits", "mtspil"];

/** Python repr() of a str. */
function repr(s: unknown): string {
  if (s === null || s === undefined) return "None";
  const t = String(s);
  const q = t.includes("'") && !t.includes('"') ? '"' : "'";
  return q + t.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n") + q;
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

function payload(data: any): any {
  return isObj(data) && "data" in data ? data.data : data;
}

/** Flatten nested limit groups (very_low.il50_p1 -> il50_p1); keep the group-free keys as they are. */
function limits(d: Record<string, any>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(d)) {
    if (isObj(v)) Object.assign(out, v);
    else if (!Array.isArray(v)) out[k] = v;
  }
  return out;
}

function shape(kind: string, data: any, params: Record<string, unknown>): Row[] {
  const d = payload(data);
  if (d === null || d === undefined) return [];
  if (kind === "fmr") {
    let head: Row = Object.fromEntries(Object.entries(d).filter(([k]) => !["basicdata", "basicdata_prevyear", "percentage_change"].includes(k)));
    head = { entityid: params.entityid ?? "", ...head };
    const bd = d.basicdata;
    if (Array.isArray(bd)) return bd.map((b: any) => ({ ...head, ...b }));
    if (isObj(bd)) {
      const b: Row = { ...bd };
      if ("year" in b && !("year" in head)) head.year = b.year;
      delete b.year;
      return [{ ...head, zip_code: "", ...b }];
    }
    return [head];
  }
  if (kind === "fmr_state") {
    const rows: Row[] = [];
    for (const [group, label] of [["metroareas", "metro"], ["counties", "county"]]) {
      for (const a of d[group] || []) rows.push({ year: d.year ?? "", area_type: label, ...a });
    }
    return rows;
  }
  if (kind === "income_limits" || kind === "mtspil") return [{ entityid: params.entityid ?? "", ...limits(d) }];
  if (kind === "il_state") {
    if (Array.isArray(d)) return d.filter(isObj).map(limits);
    const rows: Row[] = [];
    for (const [k, v] of Object.entries<any>(d)) {
      if (Array.isArray(v)) rows.push(...v.filter(isObj).map((x) => ({ group: k, year: d.year ?? "", ...limits(x) })));
    }
    return rows.length ? rows : [limits(d)];
  }
  if (Array.isArray(d)) return d.filter(isObj);
  return isObj(d) ? [d] : [];
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {}, n = r.name, ep = r.endpoint || "";
    if (STATE_EPS.includes(ep) && p.statecode && !/^[A-Za-z]{2}$/.test(pyStr(p.statecode))) {
      probs.push(`request ${repr(n)}: statecode must be a two-letter code such as MA`);
    }
    const e = p.entityid ? pyStr(p.entityid) : "";
    if (ENTITY_EPS.includes(ep) && e && /^\d{5}$/.test(e)) {
      probs.push(`request ${repr(n)}: a 5-digit county FIPS is not a HUD entity id; append 99999 ` +
        `(${e}99999) or look it up with list_counties`);
    }
  }
  return probs;
}

function before(params: Record<string, unknown>): Record<string, unknown> {
  return params.statecode ? { ...params, statecode: pyStr(params.statecode).toUpperCase() } : params;
}

const noNone = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null || v === undefined ? "" : v]));

async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const c = gr.clientFor(pack);
  const tables: Tables = {};
  const notes: string[] = [];
  for (const r of spec.requests) {
    const [ep, params0, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    const params = before(params0);
    const [p, query] = gr.split(ep, params);
    const rows = shape(r.endpoint || "", await c.getJson(p, query), params);
    if (r.endpoint === "il_state") notes.push(`${r.name}: il/statedata is not documented by HUD; check the columns before use.`);
    if (!rows.length && !r.allow_empty) {
      throw new DataError(`request ${repr(r.name)} returned no rows: check the entity id or state code`, "bad_request");
    }
    tables[r.name] = rows.map(noNone);
  }
  return [tables, notes];
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items = gr.manualItems(pack, { ...spec, requests: (spec.requests || []).map((r) => ({ ...r, params: before(r.params || {}) })) });
  for (const it of items) {
    it.note = "needs your HUD_USER_TOKEN in an 'Authorization: Bearer' header: use the download script " +
      "(a browser link alone answers 401)";
    // without a token the user uploads HUD's published FMR / income-limits file instead (source.md, Access)
    it.also_ext = [".csv", ".xlsx", ".xls"];
  }
  return items;
}

// columns of HUD's published FMR and income-limits files that hold an entity id or a state code
const ENTITY_COLS = ["hud_area_code", "metro_code", "fips", "fips2010", "fips2000"];
const STATE_COLS = ["stusps", "state_alpha"];

/** A published file covers every area of the year: keep the rows of the requested entity or state. */
function subset(rows: Row[], params: Record<string, unknown>, name: string, fname: string): Row[] {
  if (!rows.length) return rows;
  const cols = new Set(Object.keys(rows[0]));
  const ent = params.entityid ? pyStr(params.entityid) : "";
  const st = params.statecode ? pyStr(params.statecode).toUpperCase() : "";
  if (ent) {
    const use = ENTITY_COLS.filter((c) => cols.has(c));
    if (!use.length) return rows;
    const keep = rows.filter((r) => use.some((c) => pyStr(r[c] ?? "").trim() === ent));
    if (!keep.length) {
      throw new DataError(`request ${repr(name)}: ${fname} has no row for entity id ${ent} (looked in ${use.join(", ")}); ` +
        "check the id and that the file is the requested fiscal year", "bad_request");
    }
    return keep;
  }
  if (st) {
    const use = STATE_COLS.filter((c) => cols.has(c));
    const keep = rows.filter((r) => use.some((c) => pyStr(r[c] ?? "").trim().toUpperCase() === st));
    return use.length ? keep : rows;
  }
  return rows;
}

function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [, params] = gr.resolve(pack, req);
  const rows: Row[] = [];
  const cols: string[] = [];
  const seen = new Set<string>();
  const note = (names: string[]) => names.forEach((c) => !seen.has(c) && (seen.add(c), cols.push(c)));
  for (const p of [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const low = p.toLowerCase(), base = path.basename(p);
    if (low.endsWith(".csv")) {
      rows.push(...subset(gr.parseUpload(pack, req, [p]), params, req.name, base));
      continue;
    }
    if (low.endsWith(".xlsx") || low.endsWith(".xls")) {
      let recs: Row[];
      try {
        recs = readExcel(fs.readFileSync(p), low.endsWith(".xls"));
      } catch (e) {
        throw new DataError(`cannot read ${base} (${e instanceof Error ? e.name : "Error"}); save it as CSV and upload ` +
          "again", "bad_request");
      }
      const kept = subset(recs, params, req.name, base);
      if (kept.length) note(columnsOf(recs) || Object.keys(kept[0]));
      rows.push(...kept);
      continue;
    }
    rows.push(...shape(req.endpoint || "", parsePyJson(fs.readFileSync(p, "utf8").replace(/^﻿/, "")), before(params)));
  }
  for (const r of rows) note(Object.keys(r));
  return withColumns(rows.map(noNone), cols);
}

const adapter: Adapter = { checkSpec, fetch, manualItems, parseUpload };
export default adapter;
