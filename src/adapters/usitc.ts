/**
 * USITC Harmonized Tariff Schedule REST API (port of the Python adapter.py): rate columns made usable for duty
 * estimates.
 *
 * The API gives duty rates as published text ("2.5%", "Free", "1.7¢/kg on lead content", "The duty provided in the
 * applicable subheading + 25%") and only on the line that carries the rate; the 10-digit statistical lines below
 * it are blank. normalize keeps every published column and adds:
 *   rate_line               the HTS number whose rates apply to this line: itself, or the nearest line above it
 *                           with a general rate whose number this line's number extends
 *   general_effective       the general (column 1) rate of that line, as published
 *   general_rate_type       free | ad_valorem | specific | compound | chapter99 | other | none
 *   general_ad_valorem_pct  the percent as a number when the effective rate is Free (0) or a plain percent
 *   chapter99_refs          9903.xx.xx headings named in the line's footnotes
 * and writes footnotes ("[other] See 9903.90.08.") and units as text.
 */
import type { Adapter, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyFloatRepr, pyStr } from "../core/py.js";

const PCT = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/;
const CH99 = /\b99\d\d\.\d\d\.\d\d\b/g;
const SPECIFIC = /(¢|\$)\s*\d|\d\s*(¢|\$)|\/(kg|liter|l|doz|no|pr|m2|t|each|head|gross|pf\.? liter)\b/i;

function rateType(text: unknown): string {
  const t = pyStr(text || "").trim();
  if (!t) return "none";
  if (t.toLowerCase().startsWith("free")) return "free";
  if (t.toLowerCase().startsWith("the duty provided")) return "chapter99";
  if (PCT.test(t)) return "ad_valorem";
  const hasPct = t.includes("%");
  const hasSpec = SPECIFIC.test(t);
  if (hasPct && hasSpec) return "compound";
  if (hasSpec) return "specific";
  return "other";
}

/** The ad valorem percent as Python writes the float ("0.0", "2.5"), or "". */
function pct(text: string, kind: string): string {
  if (kind === "free") return "0.0";
  if (kind === "ad_valorem") return pyFloatRepr(Number(PCT.exec(text)![1]));
  return "";
}

const digits = (hts: unknown) => pyStr(hts || "").replace(/\D/g, "");

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.startsWith("[")) {
    try {
      const x = JSON.parse(v);
      return Array.isArray(x) ? x : [];
    } catch {
      return [];
    }
  }
  return [];
}

function footText(v: unknown): string {
  const out: string[] = [];
  for (const f of asList(v)) {
    if (f && typeof f === "object" && !Array.isArray(f)) {
      const o = f as Record<string, any>;
      const val = pyStr(o.value || "").trim();
      const cols = (o.columns || []).join(",");
      if (val) out.push(cols ? `[${cols}] ${val}` : val);
    } else if (f) out.push(pyStr(f));
  }
  return out.join(" | ");
}

/** HTS number in the API's dotted form (8703.80.00.20); "" when it is not 4 to 10 digits in pairs. */
function dotted(hts: unknown): string {
  const d = digits(hts);
  if (![4, 6, 8, 10].includes(d.length)) return "";
  const parts = [d.slice(0, 4)];
  for (let i = 4; i < d.length; i += 2) parts.push(d.slice(i, i + 2));
  return parts.join(".");
}

/** The first number past every line under hts at its level: 8703 -> 8704, 8703.80 -> 8703.81. */
function after(hts: string): string {
  const i = hts.lastIndexOf(".");
  const [head, last] = i < 0 ? ["", hts] : [hts.slice(0, i), hts.slice(i + 1)];
  const nxt = String(Number(last) + 1).padStart(last.length, "0");
  if (nxt.length > last.length) { // 9999 or .99: no next number at this level
    const n = digits(hts).length;
    return n < 10 ? hts + ".99".repeat(Math.floor((10 - n) / 2)) : hts;
  }
  return head ? `${head}.${nxt}` : nxt;
}

/** Python repr() of a scalar (for messages). */
const repr = (v: unknown) => (typeof v === "string" ? (v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v}'`) : pyStr(v));

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    if (r.endpoint !== "schedule") continue;
    const p: Record<string, any> = r.params || {};
    for (const k of ["from", "to"]) {
      if (p[k] !== null && p[k] !== undefined && p[k] !== "" && !dotted(pyStr(p[k]))) {
        probs.push(`${r.name}: ${k}=${repr(p[k])} is not an HTS number (4, 6, 8 or 10 digits, e.g. 8703 or 8703.80)`);
      }
    }
    const f = dotted(pyStr(p.from || "")), t = dotted(pyStr(p.to || ""));
    if (f && t && f > t) probs.push(`${r.name}: from ${pyStr(p.from)} is after to ${pyStr(p.to)}`);
  }
  return probs;
}

function beforeRequest(_req: SpecRequest, ep: any, params0: Record<string, unknown>): Record<string, unknown> {
  // The API compares numbers as text and keeps lines <= to, so to=8703 returns the heading row alone, and it
  // answers undotted numbers with nothing. Send dotted numbers and the number just past `to`; normalize cuts the
  // reply there, so `to` includes every line under it.
  if (ep.path !== "/exportList") return params0;
  const params = { ...params0 };
  if (dotted(pyStr(params.from || ""))) params.from = dotted(pyStr(params.from));
  if (dotted(pyStr(params.to || ""))) params.to = after(dotted(pyStr(params.to)));
  return params;
}

const DROP = new Set(["addiitionalDuties", "superior", "hasHighlight", "htmlStatNote", "selector", "unique"]);

function normalize(req: SpecRequest, ep: any, rows0: Row[]): Row[] {
  if (ep.path !== "/exportList" && ep.path !== "/search") return rows0;
  let rows = rows0;
  if (ep.path === "/exportList") {
    const to = dotted(pyStr((req?.params || {}).to || ""));
    if (to) {
      const stop = after(to);
      const i = rows.findIndex((r) => {
        const hts = pyStr(r.htsno || "").trim();
        return !!hts && hts >= stop;
      });
      if (i >= 0) rows = rows.slice(0, i);
    }
  }
  const out: Row[] = [];
  const parent = new Map<number, [string, string]>(); // indent -> (htsno, general) of the nearest line above with a general rate
  for (const r of rows) {
    const nw: Row = {};
    for (const [k, v] of Object.entries(r)) if (!DROP.has(k) && !k.startsWith("highlight")) nw[k] = v;
    const indent = Number(pyStr(r.indent || 0) || 0);
    const general = pyStr(r.general || "").trim();
    const hts = pyStr(r.htsno || "").trim();
    for (const k of [...parent.keys()].filter((k) => k >= indent)) parent.delete(k);
    let line: string, eff: string;
    if (general) {
      parent.set(indent, [hts, general]);
      [line, eff] = [hts, general];
    } else {
      // only a line whose number the child extends (search results skip lines, label rows have none)
      const d = digits(hts);
      const above = [...parent.keys()].sort((a, b) => a - b).filter((k) => k < indent && d && d.startsWith(digits(parent.get(k)![0])))
        .map((k) => parent.get(k)!);
      [line, eff] = above.length ? above[above.length - 1] : ["", ""];
    }
    const kind = rateType(eff);
    const foot = footText(r.footnotes);
    nw.footnotes = foot;
    nw.units = asList(r.units).map(pyStr).join(", ");
    nw.rate_line = line;
    nw.general_effective = eff;
    nw.general_rate_type = kind;
    nw.general_ad_valorem_pct = pct(eff, kind);
    nw.chapter99_refs = [...new Set(foot.match(CH99) || [])].join(" ");
    out.push(nw);
  }
  return out;
}

const adapter: Adapter = { checkSpec, beforeRequest, normalize, rateType, dotted };
export default adapter;
