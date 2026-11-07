/**
 * NAEP adapter (port of the Python adapter.py): subject aliases and default scales, error-flag decoding, errors
 * inside HTTP 200.
 *
 * - beforeRequest: subject names are case-insensitive and take aliases (math -> mathematics); the subscale
 *   defaults to the subject's composite (math grade 12 -> MWPCM, the 2005-framework scale); "year" is accepted
 *   for "Year".
 * - normalize: the published values stay as they are. Suppressed estimates arrive as value 999 with stdError -1
 *   and isStatDisplayable 0; a `value_flag` column says "suppressed" for those rows, and every errorFlag column
 *   gets a decoded `<column>_notes` column from the bit table in the NAEP API documentation.
 * - fetch / parseUpload: the generic fetch, but a body that is not valid JSON is repaired before parsing when
 *   the only fault is unescaped double quotes inside string values (type=independentvariables for 2024); a note
 *   says so. Any other malformed body still fails.
 */
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import { Response } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { parsePyJson, pyJsonDumps, pyStr } from "../core/py.js";
import { readCsv } from "../core/tabular.js";

// Error flag bits (NAEP API documentation, "Error Codes"), and whether the statistic is withheld.
const FLAGS: [number, string, boolean][] = [
  [1, "Reporting standard not met", true], [2, "Extreme p", true], [4, "High CV", false],
  [8, "Non-accommodated sample", false], [16, "Exclusion list", true],
  [32, "Non-qualified independent variable", true], [64, "No data", true], [128, "Rounds to zero", false],
  [256, "SE not applicable", false], [512, "Race note type 1", false],
  [2048, "Response rate below 85%", false], [4096, "Response rate below 50%", true],
  [16384, "Significance", false], [32768, "Zero percent response rate", true],
  [131072, "Jurisdiction note", false], [4194304, "Race note type 2", false],
  [8388608, "Race note type 3", false], [16777216, "IEP note", false], [33554432, "IEP2009 note", false],
  [67108864, "DoDEA note", false], [134217728, "Dallas note", false], [268435456, "Skipped variables note", false],
];
const DISPLAY_COLS = ["isStatDisplayable", "isFocalStatDisplayable", "isTargetStatDisplayable", "statDisplayable1",
  "statDisplayable2", "statDisplayable3", "statDisplayable4", "isSigDisplayable", "isGapDisplayable"];
const BOM = new RegExp("^" + String.fromCharCode(0xfeff));

/** Python repr() of a str. */
function repr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n").replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t") + q;
}
const reprAny = (v: unknown): string => (typeof v === "string" ? repr(v) : v === null || v === undefined ? "None"
  : Array.isArray(v) ? `[${v.map(reprAny).join(", ")}]` : pyStr(v));

function catalog(): Record<string, any> {
  return readJson(path.join(PACKS_DIR, "naep"), "endpoints.json")?.catalog || {};
}

function subject(cat: Record<string, any>, v: unknown): any | null {
  const s = (v === null || v === undefined || v === "" || v === 0 || v === false ? "" : pyStr(v)).trim().toLowerCase();
  if (s in cat && String(cat[s].kind || "").startsWith("subject")) return cat[s];
  for (const c of Object.values(cat)) if (String(c.kind || "").startsWith("subject") && c.id === s) return c;
  return null;
}

/** Python int(float(flag)), or null where Python raises. */
function toInt(flag: unknown): bigint | null {
  if (typeof flag === "boolean") return flag ? 1n : 0n;
  if (typeof flag === "number") return Number.isFinite(flag) ? BigInt(Math.trunc(flag)) : null;
  if (typeof flag !== "string") return null;
  const s = flag.trim();
  if (!s || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? BigInt(Math.trunc(n)) : null;
}

export function decode(flag: unknown): string {
  const n = toInt(flag);
  if (n === null) return "";
  return FLAGS.filter(([bit]) => (n & BigInt(bit)) !== 0n).map(([, label]) => label).join("; ");
}

export function withheld(flag: unknown): boolean {
  const n = toInt(flag);
  if (n === null) return false;
  return FLAGS.some(([bit, , hide]) => hide && (n & BigInt(bit)) !== 0n);
}

function beforeRequest(_req: SpecRequest, ep: any, params: Record<string, unknown>): Record<string, unknown> {
  const cat = catalog();
  if ("year" in params && !("Year" in params)) {
    const y = params.year;
    delete params.year;
    params.Year = y;
  }
  const subj = subject(cat, params.subject);
  if (subj) {
    params.subject = subj.id;
    if (!params.subscale && "subscale" in (ep?.params || {})) {
      const g12 = pyStr(params.grade) === "12" && subj.subscale_grade12;
      params.subscale = g12 ? subj.subscale_grade12 : subj.subscale;
    }
  }
  for (const k of ["Year", "jurisdiction", "stattype"]) {
    const v = params[k];
    if (Array.isArray(v)) params[k] = v.map(pyStr).join(",");
  }
  return params;
}

/** Generic links, built from the same parameters the fetch sends (aliases and default scales). */
function manualItems(spec: Spec, pack: Pack): any[] {
  const s: Spec = JSON.parse(JSON.stringify(spec));
  for (const r of s.requests || []) {
    const [ep, params, probs] = gr.resolve(pack, r);
    if (!probs.length) r.params = beforeRequest(r, ep, params);
  }
  return gr.manualItems(pack, s);
}

function checkSpec(spec: Spec): string[] {
  const cat = catalog();
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    const name = repr(String(r.name)), ep = r.endpoint;
    const subj = subject(cat, p.subject);
    if (p.subject && !subj) {
      probs.push(`request ${name}: unknown subject ${reprAny(p.subject)} (reading, math, science, writing, ` +
        "civics, history, geography, economics, tel, music)");
    }
    if (subj && subj.grades?.length && p.grade !== null && p.grade !== undefined && p.grade !== "" &&
      !subj.grades.includes(Math.trunc(Number(p.grade)))) {
      probs.push(`request ${name}: ${subj.id} is assessed in grades [${subj.grades.join(", ")}]`);
    }
    const yv = "Year" in p ? p.Year : "year" in p ? p.year : "";
    const years = Array.isArray(p.Year) ? p.Year.map(pyStr).join(",") : Array.isArray(yv) ? reprAny(yv) : yv === null ? "None" : pyStr(yv);
    const j0 = "jurisdiction" in p ? p.jurisdiction : "";
    const juris = Array.isArray(j0) ? j0.join(",") : j0 === null ? "None" : pyStr(j0);
    const count = (s: string) => s.split(",").filter(Boolean).length;
    if (ep === "compare_years" && count(years) < 2) probs.push(`request ${name}: compare_years needs two or more years in Year`);
    if (["compare_jurisdictions", "gap_years_across_jurisdictions", "gap_groups_across_jurisdictions"].includes(ep || "") &&
      count(juris) < 2) probs.push(`request ${name}: ${ep} needs two or more jurisdictions`);
    if (ep === "gap_years_across_jurisdictions" && count(years) !== 2) {
      probs.push(`request ${name}: gap_years_across_jurisdictions needs exactly two years`);
    }
    if (["compare_groups", "gap_groups_across_years", "gap_groups_across_jurisdictions"].includes(ep || "") &&
      ["", "TOTAL"].includes(pyStr("variable" in p ? p.variable : "").toUpperCase())) {
      probs.push(`request ${name}: ${ep} needs a group variable such as GENDER or SDRACE, not TOTAL`);
    }
  }
  return probs;
}

function checkError(_status: number, body: Buffer): string | null {
  let d: any;
  try {
    d = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body).replace(BOM, ""));
  } catch {
    return null;
  }
  if (d && typeof d === "object" && !Array.isArray(d) &&
    (![undefined, null, 200].includes(d.statusCode) || typeof d.result === "string")) {
    const res = d.result === undefined || d.result === null ? "None" : pyStr(d.result);
    return "NAEP data service error: " + [...res].slice(0, 300).join("").split("\n")[0];
  }
  return null;
}

function normalize(_req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  for (const r of rows) {
    let hidden = false;
    for (const col of Object.keys(r)) {
      if (col.toLowerCase().endsWith("errorflag") || col.startsWith("errorFlag")) {
        r[col + "_notes"] = decode(r[col]);
        hidden = hidden || withheld(r[col]);
      }
    }
    for (const col of DISPLAY_COLS.slice(0, 7)) if (col in r && pyStr(r[col]) === "0") hidden = true;
    if (["value", "focalValue", "stat1"].some((k) => k in r)) r.value_flag = hidden ? "suppressed" : "";
  }
  return rows;
}

// ---------------------------------------------------------------------- malformed JSON (stray quotes)
const WS = " \t\r\n";

/** Escape double quotes inside JSON strings that the server left unescaped. A quote inside a string closes it
 * only when the next non-blank character is structural: ':' '}' ']' or the end, or ',' followed by the start of
 * another key or value ('"', '{', '[', a digit or '-'). Otherwise it is text. */
export function repairQuotes(text: string): string {
  const out: string[] = [];
  const n = text.length;
  let inStr = false;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (!inStr) {
      inStr = ch === '"';
      out.push(ch);
    } else if (ch === "\\") {
      out.push(text.slice(i, i + 2));
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < n && WS.includes(text[j])) j++;
      const nxt = j < n ? text[j] : "";
      let closes = ["", ":", "}", "]"].includes(nxt);
      if (nxt === ",") {
        let k = j + 1;
        while (k < n && WS.includes(text[k])) k++;
        closes = k < n && ('"{[-'.includes(text[k]) || /\p{Nd}/u.test(text[k]));
      }
      if (closes) {
        inStr = false;
        out.push(ch);
      } else out.push('\\"');
    } else out.push(ch);
  }
  return out.join("");
}

/** [data, repaired]: strict JSON first; the stray-quote repair only when that fails. A body the repair cannot
 * fix throws the original error. */
export function loadsTolerant(raw: Buffer | Uint8Array): [any, boolean] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(BOM, "");
  try {
    return [parsePyJson(text), false];
  } catch (e) {
    try {
      return [parsePyJson(repairQuotes(text)), true];
    } catch {
      throw e;
    }
  }
}

/** A core Client whose responses that need the quote repair come back with the repaired body. */
function tolerant(pack: Pack): [ReturnType<typeof gr.clientFor>, string[]] {
  const c = gr.clientFor(pack);
  const repaired: string[] = [];
  const orig = c.request.bind(c);
  c.request = async (...a: Parameters<typeof orig>) => {
    const resp = await orig(...a);
    const head = resp.body.subarray(0, 1).toString("latin1");
    if (head !== "{" && head !== "[") return resp;
    let data: any, fixed: boolean;
    try {
      [data, fixed] = loadsTolerant(resp.body);
    } catch {
      return resp; // the generic code reports the real error
    }
    if (!fixed) return resp;
    repaired.push(resp.url);
    return new Response(resp.status, resp.headers, Buffer.from(pyJsonDumps(data, false, false), "utf8"), resp.url, resp.cached);
  };
  return [c, repaired];
}

/** A request (or a year of it) whose every estimate is withheld returns status ok and rows of 999: say so, with
 * the reasons, and name the variable that replaced a non-qualified one. */
export function withheldNote(req: SpecRequest, rows: Row[]): string | null {
  const flagged = rows.filter((r) => "value_flag" in r);
  if (!flagged.length) return null;
  const byYear = new Map<string, Row[]>();
  for (const r of flagged) {
    const y = pyStr("year" in r ? r.year : "");
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(r);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const empty = [...byYear].filter(([, rs]) => rs.every((r) => r.value_flag === "suppressed")).map(([y]) => y).sort(cmp);
  if (!empty.length) return null;
  const gone = flagged.filter((r) => empty.includes(pyStr("year" in r ? r.year : "")));
  const whySet = new Set<string>();
  for (const r of gone) {
    for (const [k, v] of Object.entries(r)) {
      if (k.endsWith("_notes") && v) for (const x of pyStr(v).split(";")) whySet.add(x.trim());
    }
  }
  const why = [...whySet].sort(cmp);
  const which = empty.length === byYear.size ? "every estimate" : `every estimate for ${empty.join(", ")}`;
  let note = `${req.name}: ${which} is withheld (value 999, value_flag suppressed): ` +
    `${why.join("; ") || "no reason given"}. Do not report or average these cells.`;
  if (why.includes("Non-qualified independent variable")) {
    const v = (req.params || {}).variable;
    const variable = v ? pyStr(v) : "";
    const succ = Object.values(catalog()).filter((c: any) => c.kind === "variable" && variable.split("+").includes(c.id) &&
      c.successor).map((c: any) => c.successor);
    note += ` The variable ${variable} is not reported for that assessment` +
      (succ.length ? `; use ${succ.join(", ")} instead (see source.md).` : "; find its replacement with a request_schema search.");
  }
  return note;
}

/** The generic fetch through the tolerant client; a note says how many responses needed the repair, and one says
 * when every estimate of a request or a year is withheld. */
async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  const [c, repaired] = tolerant(pack);
  const [tables, notes] = await gr.fetchSpec(pack, spec, c);
  for (const r of spec.requests) {
    const t = tables[r.name];
    const note = withheldNote(r, Array.isArray(t) ? t : []);
    if (note) notes.push(note);
  }
  if (repaired.length) {
    notes.push(`${repaired.length} NAEP response(s) were malformed JSON (unescaped quotes inside text ` +
      "labels, e.g. type=independentvariables); the pack escaped them before parsing. Labels are as published.");
  }
  return [tables, notes];
}

/** Uploaded pages (JSON as saved from the links, or CSV), with the same quote repair. */
function parseUpload(pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const [ep] = gr.resolve(pack, req);
  let rows: any[] = [];
  for (const p of [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const raw = fs.readFileSync(p);
    if (p.toLowerCase().endsWith(".csv")) {
      rows = rows.concat(readCsv(new TextDecoder("utf-8").decode(raw).replace(BOM, "")));
      continue;
    }
    const recs = gr.dig(loadsTolerant(raw)[0], ep.records ?? "");
    rows = rows.concat(recs === null || recs === undefined ? [] : Array.isArray(recs) ? recs : [recs]);
  }
  return normalize(req, ep, gr.clean(rows, ep));
}

const adapter: Adapter = { beforeRequest, manualItems, checkSpec, checkError, normalize, fetch, parseUpload,
  loadsTolerant, withheldNote, repairQuotes, decode };
export default adapter;
