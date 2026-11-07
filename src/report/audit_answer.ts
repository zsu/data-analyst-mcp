/**
 * Release gate for a quick answer (the default product): a port of report/audit_answer.py. Run it on the reply as
 * it will be sent. The same method rules as a report (method_audit.ts) on decisions.json, plus the parts of the
 * report audit that apply without a page. FAIL-level checks:
 *   facts        facts.json exists; every fact traced to a CSV cell matches that cell; others state a derivation
 *   answer       answer.md (the reply as it will be sent): every number in it is a registered fact as rounded in the
 *                text, or listed in decisions.json "audit_allow" with a reason; dollar amounts of different years
 *                compared only with their basis stated (nominal or real), or "dollar_basis_ok" with a reason
 *   questions    one "Don't know" option per question, no "Skip"; skipped or unanswered = "Don't know", resolved;
 *                not asked only with reason_code no_user or settled_by_request (quoting the request)
 *   literature   the searches run (query, date, what was found), or reason_code no_search_tool / network_blocked
 *   disclosures  each no_user question and unavailable search has a line in "disclosures" the answer carries
 *   references   citation, URL or DOI, accessed date, opened (a page the cite tool saved, unchanged; its quote is
 *                on it); every [@id] resolves
 *   assumptions  basis empirical > literature > precedent > user > judgment with its evidence
 *   sensitivity  each sensitivity.csv row's headlines are registered facts and conclusion_changes agrees with them
 *   benchmark    exhibits/benchmark.csv compares the headline numbers with published figures
 *   vintage      every source in data/<id>/ has its provenance file; every table read by hand from an agency page,
 *                in published/<name>.csv, gives source_url and accessed on each row
 *   links        with online, every external link in decisions.json answers HTTP < 400
 *   secrets      no API key or key-shaped value in any file of the workspace
 *   replication  with rerun, every exhibit recipe and table fact is replayed and reproduces facts.json and the
 *                exhibit CSVs exactly
 */
import fs from "node:fs";
import path from "node:path";
import { redact } from "../core/keys.js";
import { pyFloatRepr } from "../core/py.js";
import type { Policy } from "../core/policy.js";
import * as AR from "./audit_report.js";
import { roundingTie } from "../analysis/facts.js";
import * as MA from "./method_audit.js";
import type { Result } from "./method_audit.js";
import * as PS from "./policyset.js";
import { echoSources, knownKeys, relHits, scanTree } from "./scan_secrets.js";
import { escapeRe, end, finditer, fullmatch, lstrip, match, repr, rx, search, sorted, split, splitlines, str, strip,
  sub, toFloat, pyRound, type M } from "./py.js";

export const CHECKS = ["facts", "answer", "policy", "questions", "literature", "disclosures", "references", "assumptions",
  "sensitivity", "data_needs", "benchmark", "vintage", "links", "secrets", "replication"];

type Facts = Record<string, any>;
export type Num = { tok: string; num: number; unit: string; scale: number; tol: number; dec?: number; neg: boolean;
  dollar: boolean; plus?: boolean; line?: string; approx?: boolean; unit_after?: boolean; counts?: boolean; table?: boolean };
type Disp = [number, string, number | null];
type Shown = [string, Disp, any];

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const isDigit = (c: string) => /^\d$/.test(c);
/** str.rfind(ch, 0, endPos) */
const rfind = (s: string, ch: string, endPos: number) => (endPos <= 0 ? -1 : s.lastIndexOf(ch, endPos - ch.length));
const count = (s: string, ch: string, a = 0, b = s.length) => s.slice(a, b).split(ch).length - 1;
const cellsOf = (line: string) => strip(strip(line), "|").split("|");

// ---------------------------------------------------------------------- the answer text
const SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, k: 1e3, m: 1e6, mn: 1e6,
  bn: 1e9, b: 1e9, t: 1e12, tn: 1e12 };
const ANSWER_NUM = rx(String.raw`(?i)(?<![\w.,\-–/#@:])(?P<neg>[-−])?\$?(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)` +
  String.raw`(?P<unit>[\s-]*(?:%|percent(?:age[\s-]points?)?|percentage[\s-]points?|pp\b|p\.p\.|basis[\s-]points?|bps?\b` +
  String.raw`|(?:thousand|million|billion|trillion)\b|(?:k|m|mn|bn|b|t|tn)\b))?` +
  String.raw`(?![\w/]|[-–](?!points?\b|percent|(?:days?|weeks?|months?|hours?|pages?|volumes?|records?|rows?|` +
  String.raw`people|persons|jobs|units|members|employees)\b)|\.\d|,\d)`);   // "9.9-point drop" and "43-day shutdown" are checked
const TALLY = rx(String.raw`(?<![\w.,/$#-])(\d{1,3})\s*[-–]\s*(\d{1,3})(?![\w/%]|[.,]\d|\s*(?:percent|years?|months?))`);
const VOTE_WORDS = rx(String.raw`(?i)\b(?:vote[sd]?|voting|roll|tally|yeas?|nays?|passed|failed|sustain\w*|overr\w*|` +
  String.raw`adopted|confirmed|rejected|agreed|cloture|motion|margin)\b`);
const RANK_WORDS = rx(String.raw`(?i)\b(?:top|bottom|first|last|next|past|other)\s+\d{1,2}\b` +
  // "all 50 states" names a universe; "all 79 succeeded" is a result to check
  String.raw`|\ball\s+\d{1,2}(?=\s+(?:[a-z-]+\s+)?(?:states?|areas?|jurisdictions?|departments?|` +
  String.raw`agencies|counties|districts|metros?|cities|countries|sectors|industries|categories|groups|` +
  String.raw`members|senators|committees|months|quarters|years|weeks|days|volumes|series|rows|columns|` +
  String.raw`components|occupations|figures|values|estimates)\b)`);
const FLAG_WORDS: Record<string, RegExp> = {
  preliminary: rx(String.raw`preliminar|subject to revision|advance estimate|first estimate|early estimate|(?:will|to) be revised|provisional`, "i"),
  projection: rx(String.raw`project|forecast|estimate|expect|outlook`, "i"),
  vintage: rx(String.raw`as (?:first )?(?:reported|published|estimated)|first (?:release|estimate|reported)|` +
    String.raw`initial(?:ly)?|vintage|real[- ]time|at the time|originally|first published|revis|` +
    String.raw`(?:advance|second|third|earlier|annual|comprehensive|benchmark)\s+(?:estimates?|updates?|releases?|revisions?)`, "i") };

// a year qualifies these ("2017 dollars", "2025 estimates"); another plural after 1789-2100 makes it a count
const YEAR_NOUNS = new Set(("dollars prices levels estimates values data figures rates terms numbers quarters months years " +
  "editions vintages releases budgets elections sessions laws acts amendments appropriations reports surveys tables files " +
  "samples weights results rules standards projections baselines totals peaks highs lows averages volumes issues q1 q2 q3 q4").split(" "));
const VERBS_S = new Set(("does goes shows appears remains marks sees seems ends begins starts covers includes contains lists " +
  "looks gives brings rises falls stands follows means makes takes holds runs gets comes becomes needs uses matches leads adds " +
  "plus thus less across towards versus always also").split(" "));
// a bare 1789-2100 integer in prose is a count only after such a word and before a plural noun ("had 2017 pages")
const COUNT_BEFORE = rx(String.raw`(?i)\b(?:had|has|have|against|totaled|totalled|totaling|totalling|were|are|was|is|` +
  String.raw`about|nearly|almost|roughly|approximately|exactly)\s+$`);
const SEP_ROW = rx(String.raw`\s*\|?[\s:|-]+\|?\s*`);
const YEAR_COL = rx(String.raw`\**\s*(?:years?|period|fy|fiscal|calendar|date|vintage|edition|session|` +
  String.raw`congress|month|quarter|as of|latest|release)\b`);

/** Is this bare 1789-2100 integer a year? It is, unless it reads as a count. */
function yearLike(t: string, m: M, text?: string): boolean {
  const a = rfind(t, "\n", m.index) + 1;
  const b = t.indexOf("\n", end(m));
  const line = b < 0 ? t.slice(a) : t.slice(a, b);
  if (lstrip(line).startsWith("|")) {
    const cells = cellsOf(line);
    const cell = count(line.slice(0, m.index - a), "|") - 1;
    const nxt = b >= 0 ? t.slice(b + 1).split("\n")[0] : "";
    if (cell <= 0 || (fullmatch(SEP_ROW, nxt) && nxt.includes("-"))) return true;       // first column or header row
    const orig = text ? cellsOf(sourceLine(text, t, m.index)) : cells;
    if (cell >= orig.length || strip(strip(strip(orig[cell]), "*")) !== strip(m[0])) return true;   // a label or a date
    const rows = splitlines(t.slice(0, a));
    const sep = rows.map((l, i) => (fullmatch(SEP_ROW, l) && l.includes("-") ? i : -1)).filter((i) => i >= 0);
    if (sep.length && sep[sep.length - 1] >= 1) {
      const head = cellsOf(rows[sep[sep.length - 1] - 1]).map((c) => strip(c).toLowerCase());
      const col = cell < head.length ? head[cell] : "";
      return !!match(YEAR_COL, col);
    }
    return true;
  }
  if (!search(COUNT_BEFORE, t.slice(Math.max(0, m.index - 20), m.index))) return true;
  const after = match(/\s+([a-z]{4,}s)\b/, t.slice(end(m), end(m) + 40));
  return !(after && !YEAR_NOUNS.has(after[1]) && !VERBS_S.has(after[1]));
}

const APPROX = rx(String.raw`(?i)\b(?:about|nearly|almost|roughly|approximately|around|some|close to|more than|less than|over|under)\s*\$?$`);
// a unit shared with the next number: "3.4 and 3.6 percent", "between 2.1 and 2.5 percent"
const UNIT_AFTER = rx(String.raw`(?i)(?:\s*(?:,|and|or|to|–|-)\s*(?:[A-Za-z]+\s+){0,3}[-−+]?\d[\d,.]*)*\s*(?:%|percent|percentage points?|points?|pp\b|basis points?)`);
const COUNT_NOUN = rx(String.raw`(?i)\s+(?:of\s+(?:the\s+)?\d|(?!percent|points?|pp\b|basis|in\b|and\b|or\b|to\b|vs\b|from\b|at\b|for\b|on\b|by\b)[a-z]{3,})`);

const tokRe = (tok: string) => new RegExp(String.raw`(?<![\w.,$-])` + escapeRe(tok) + String.raw`(?![\d])`);

/** Where the number tok stands in x as a whole number (not "0.6 percent" inside "30.6 percent"); -1 if not. */
export function at(x: string, tok: string): number {
  const m = tokRe(tok).exec(x);
  return m ? m.index : -1;
}
const has = (x: string, tok: string) => at(x, tok) >= 0;

/** The line of the original text that holds position pos of its exempted copy t. */
function sourceLine(text: string, t: string, pos: number): string {
  const i = count(t, "\n", 0, pos);
  const lines = text.split("\n");
  if (count(text, "\n") === count(t, "\n") && i < lines.length) return lines[i];
  const j = t.indexOf("\n", pos);
  return t.slice(rfind(t, "\n", pos) + 1, j >= 0 ? j : t.length);
}

const PERIOD_COUNT = rx(String.raw`(?i)\b\d{1,2}\s+of\s+(?:the\s+)?\d{1,2}\s+(?:days|weeks|months|quarters|years)\b|\(\d\)`);

/** The statistics in an answer: {tok, num, unit ("pct", "pp", "bp", "scaled" or ""), scale, tol}. Years, dates, table
 * and line references, bill and law numbers, ordinals, list markers and "top 5" are skipped. */
export function answerNumbers(text: string): Num[] {
  const t = sub(PERIOD_COUNT, " ", sub(RANK_WORDS, " ", AR.exempt(text)));
  const out: Num[] = [];
  for (const m of finditer(ANSWER_NUM, t)) {
    const g = m.groups!;
    const num = g.num.replace(/,/g, ""), unit = strip(g.unit || "", " -").toLowerCase();
    const v = Number(num);
    if (!unit && !num.includes(".") && !g.num.includes(",") && v >= 1789 && v <= 2100 && yearLike(t, m, text)) continue;
    const kind = ["percentage", "pp", "p.p"].some((p) => unit.startsWith(p)) ? "pp" : ["%", "percent"].some((p) => unit.startsWith(p)) ? "pct"
      : ["basis", "bp"].some((p) => unit.startsWith(p)) ? "bp" : unit ? "scaled" : "";
    const dec = num.includes(".") ? num.split(".")[1].length : 0;
    const line = sourceLine(text, t, m.index);
    out.push({ tok: strip(m[0]), num: v, unit: kind, scale: SCALE[unit] ?? 1.0, tol: 0.5 * 10 ** -dec, dec,
      neg: !!g.neg, dollar: m[0].includes("$"), plus: !g.neg && t.slice(Math.max(0, m.index - 1), m.index) === "+", line,
      approx: !!search(APPROX, t.slice(Math.max(0, m.index - 25), m.index)),
      unit_after: !!match(UNIT_AFTER, t.slice(end(m), end(m) + 40)),
      counts: !num.includes(".") && !!match(COUNT_NOUN, t.slice(end(m), end(m) + 25)),
      table: lstrip(line).startsWith("|") });
  }
  for (const m of finditer(TALLY, t)) {           // "passed 236-188", "| 248-177 |": yeas and nays, each a fact
    const line = sourceLine(text, t, m.index);
    if (!search(VOTE_WORDS, t.slice(Math.max(0, m.index - 45), end(m) + 25)) && !lstrip(line).startsWith("|")) continue;
    if (search(rx(String.raw`(?i)\b(?:votes?|rolls?|roll\s+calls?|numbers?|nos?\.?|#)\s*$`), t.slice(Math.max(0, m.index - 15), m.index))) continue;
    for (const gi of [1, 2]) {
      out.push({ tok: m[gi], num: Number(m[gi]), unit: "", scale: 1.0, tol: 0.5, dec: 0, neg: false, dollar: false, plus: false,
        line, approx: false, unit_after: false, counts: true, table: lstrip(line).startsWith("|") });
    }
  }
  return out;
}

/** A fact's value (with its sign) in the unit its format shows, that unit's kind and the format's digits. */
export function factDisplay(f: any): Disp | null {
  let v = toFloat(f?.value);
  if (v === null || f?.value === null || f?.value === undefined) return null;
  const fmt = String(f.fmt || "");
  const nums = fmt.split(":").filter((p) => /^\d+$/.test(lstrip(p, "-")));
  const digits = nums.length ? Number(nums[0]) : null;
  const parts = fmt.split(":").filter((p) => p && !/^\d+$/.test(lstrip(p, "-")) && p !== "abs");
  let mult = 1.0;
  while (parts.length && ["signed", "abs", "from_thousands", "from_millions", "from_billions"].includes(parts[0])) {
    mult *= ({ from_thousands: 1e3, from_millions: 1e6, from_billions: 1e9 } as Record<string, number>)[parts.shift()!] ?? 1.0;
  }
  const kind = parts.length ? parts[0] : "";
  v *= mult;
  if (kind === "pct" || kind === "pp") return [v * 100, kind, digits];
  if (kind === "pct100" || kind === "pp100") return [v, kind.slice(0, -3), digits];
  if (kind === "bp" || kind === "bp100") return [v * (kind === "bp" ? 1e4 : 100), "bp", digits];
  if (kind === "thousands" || kind === "kmillions") return [v * 1e3, "base", digits];
  if (kind.endsWith("_scaled")) {
    const k = ({ m: 1e6, b: 1e9, t: 1e12 } as Record<string, number>)[kind[4]];
    if (k === undefined) return [v, "base", digits];
    return [v * k, "money", digits];
  }
  if (kind.startsWith("dollars") || kind.startsWith("usd")) return [v, "money", digits];
  if (kind) return [v, "base", digits];
  return [v, "", digits];
}

/** Does answer number n show this fact? */
export function matches(n: Num, shown: number, kind: string, digits: number | null = null): boolean {
  const dec = n.dec ?? 0;
  if ((n.neg && shown >= 0) || (n.dollar && !["money", "", "pub", "pubnum"].includes(kind))
    || (n.plus && shown < -n.tol) || (n.table && shown < -n.tol && !n.neg)) return false;   // a table cell states its sign
  shown = Math.abs(shown);
  kind = kind === "money" ? "base" : kind;
  let x = n.num, tol = n.tol * 1.0001 + 1e-12;
  let cands: number[];
  if (["pubpct", "pubpp", "pubnum", "pub"].includes(kind)) {   // a published benchmark figure, as benchmark.csv writes it
    if (digits !== null && dec < digits) return false;          // quoted at its published precision
    const units = ({ pubpct: ["pct", ""], pubpp: ["pp", ""], pubnum: ["", "scaled"] } as Record<string, string[]>)[kind];
    const okUnit = (units === undefined || units.includes(n.unit)) && !(n.dollar && (kind === "pubpct" || kind === "pubpp"));
    return okUnit && Math.abs(x - shown) <= tol;
  }
  if (n.unit === "pct" || n.unit === "pp") {    // a percent is not a percentage-point difference
    if ((kind === "pct" || kind === "pp") && digits !== null && dec < Math.max(digits, 0) && !n.approx) return false;
    cands = kind === n.unit ? [shown] : kind === "" ? [shown, shown * 100] : [];
  } else if (n.unit === "bp") {
    cands = kind === "bp" ? [shown] : kind === "" ? [shown * 1e4, shown * 100] : [];
  } else if (n.unit === "scaled") {
    if (kind === "" && Math.abs(x - shown) <= tol) return true;  // a published figure kept in its table's unit
    x *= n.scale;
    tol *= n.scale;
    cands = kind === "base" || kind === "" ? [shown] : [];
  } else if (["pct", "pp", "bp"].includes(kind) && !n.table && n.counts && !n.unit_after) {
    return false;               // a bare count ("13 of the 15") is not the fact "-13 percent"
  } else if (["pct", "pp", "bp"].includes(kind) && digits !== null && dec !== Math.max(digits, 0)) {
    return false;               // a bare "70" is not the fact shown as "70.4 percent"
  } else {
    if (kind === "base" && digits !== null && digits > 0 && dec < digits && !n.approx && Math.abs(x - shown) <= tol) return false;
    const down = (n.tok.includes(".") || n.tok.includes(",")) && n.table ? [1e-3, 1e-6, 1e-9, 1e-12] : [];
    cands = ["pct", "pp", "bp"].includes(kind) ? [shown] : kind === "base" ? [1, ...down].map((k) => shown * k)
      : [1, 100, ...down].map((k) => shown * k);
  }
  return cands.some((c) => Math.abs(x - c) <= tol);
}

function norm(s: unknown): string {
  return strip(strip(String(s).replace(/[*_`>]/g, "").replace(/\s+/g, " ")), ".").toLowerCase();
}

const NUMBER_WORDS: Record<string, number> = Object.fromEntries("zero one two three four five six seven eight nine ten eleven twelve"
  .split(" ").map((w, i) => [w, i]));
export const DOWN_WORDS = rx(String.raw`(?i)\b(?:fell|fall(?:s|ing|en)?|declin\w*|decreas\w*|drop\w*|down|lower\w*|less|loss\w*|` +
  String.raw`lost|negative|shr[ai]nk\w*|shrunk|contract\w*|slow\w*|below|cut|reduc\w*|minus|deficit\w*|` +
  String.raw`behind|short(?:fall)?|trail\w*|lagg\w*|` +
  String.raw`weak\w*|slid\w*|sank|sunk|tumbl\w*|plung\w*|gap|narrow\w*|smaller|fewer|worse|` +
  String.raw`subtract\w*|drag\w*|detract\w*|held back|hold\w* back|offset\w*|outflow\w*|` +
  String.raw`withdr[ae]w\w*|erod\w*|deduct\w*|refund\w*|deficit|shortfall|net of)\b`);
export const UP_WORDS = rx(String.raw`(?i)\b(?:rose|rise[sn]?|rising|gain\w*|increas\w*|grew|grow\w*|added|adding|up|higher|improv\w*|` +
  String.raw`climb\w*|jump\w*|surg\w*|expand\w*)\b`);

/** An audit_allow entry and an answer number compare as written, unit included. */
export function allowKey(s0: unknown): string {
  let s = str(s0);
  const m = /^\s*(\$?[\d,.]+)\s+([a-z]+)\s*$/i.exec(s);
  if (m && !/^(?:percent\w*|thousand|million|billion|trillion|basis|points?|pp|bps?)$/i.test(m[2])) s = m[1];   // "60 days"
  const k = s.replace(/[\s$,\-]/g, "").toLowerCase();
  return k.replace(/percent$/, "%");
}

const below0 = (f: any) => {
  const v = toFloat(f?.value);
  return v !== null && f?.value !== null && v < 0;
};
const negative = (f: any) => below0(f) && !String(f?.fmt || "").includes("abs");
const isChange = (f: any) => /(?:^|:)(?:pp|pp100|bp|bp100|signed)(?::|$)/.test(String(f?.fmt || ""));
const cellKey = (x: unknown) => str(x).replace(/[\s*_`]+/g, " ").trim().toLowerCase();

const NA_CELL = rx(String.raw`(?i)\s*\**\s*(?:n/?a|none|nil|not\s+(?:published|available|reported|applicable|` +
  String.raw`checked|on\s+\w+)|missing|withheld|suppressed|[(]?na[)]?|x|—|–|-|\.\.\.)\s*\**\s*`);
const RANK_CELL = rx(String.raw`(?i)\s*\**\s*(?:#?\d+|(?:rank|no\.?|oldest|youngest|top|bottom|highest|lowest|first|` +
  String.raw`last)\s*\d+)\s*(?:\(tie\)|=)?\s*\**\s*`);

/** The label of a table cell's row; null outside tables, for a period or an unreadable row. */
export function rowLabel(n: Num): string | null {
  const line = n.line || "";
  if (!lstrip(line).startsWith("|")) return null;
  let cells = cellsOf(line);
  let k = cells.findIndex((c) => has(c, n.tok));
  if (k < 0) k = cells.length;
  const names = cells.slice(0, k).filter((c) => /[A-Za-z]/.test(c) && !/\d/.test(c) && !fullmatch(NA_CELL, c));
  const rank = fullmatch(RANK_CELL, cells[0]);
  if (names.length && (!/[A-Za-z]/.test(cells[0]) || rank)) cells = [names[names.length - 1]];
  else if (names.length > 1) cells = [names[names.length - 1]];
  const row = cellKey(cells[0]);
  if (!row || row.length > 60 || periodKey(row.replace(/\s*\(.*\)\s*$/, "")) !== null
    || !/[a-z]{3}|\b\d+(?:st|nd|rd|th)\b|\b[a-z][a-z.]{0,10}\s*\d{1,6}\b/.test(row)
    || /^(?:(?:fy\s?)?\d{4}\s*(?:[–-]|to)\s*\d{2,4}|\d{4}\s*q[1-4]|q[1-4]\s*\d{4})$/.test(row)) return null;
  return row;
}

/** A name as written and its short form: "Natural Resources Committee" -> natural resources. */
export function forms(v0: unknown): Set<string> {
  const v = cellKey(v0);
  let short = v.replace(/^(?:the\s+|u\.?s\.?\s+|(?:house|senate)\s+)?(?:committee\s+on\s+(?:the\s+)?|department\s+of\s+(?:the\s+)?)/, "");
  short = short.replace(/\s+(?:committee|department|agency|administration|bureau|office|county|state)$/, "");
  const alias = new Set<string>(["united states", "u.s. total", "united states total"].includes(v) ? ["u.s."] : []);
  const party: Record<string, string[]> = { democratic: ["democrat", "democrats"], democrat: ["democrats", "democratic"],
    republican: ["republicans"], independent: ["independents"] };
  for (const p of party[v] || []) alias.add(p);
  const out = new Set([v, ...alias]);
  if (short !== v && short.length >= 4 && /[a-z]{3}/.test(short)) out.add(short);
  return out;
}

type Ents = Map<string, [Set<string>, string]>;
/** Names the facts are keyed by, each form to [keys, the name]; periods and codes are not names. */
export function entities(facts: Facts): Ents {
  const out: Ents = new Map();
  for (const f of Object.values(facts || {})) {
    if (!isObj(f)) continue;
    for (const [k, v] of Object.entries(isObj(f.where) ? f.where : {})) {
      const name = cellKey(v);
      if (name.length >= 3 && name.length <= 60 && /[a-z]{3}/.test(name) && !/\d/.test(name)) {
        for (const form of forms(name)) {
          if (!out.has(form)) out.set(form, [new Set(), name]);
          out.get(form)![0].add(String(k));
        }
      }
    }
  }
  return out;
}

const ABBR = rx(String.raw`(?:\b(?:U\.S|U\.K|St|Mt|Ft|Dr|Mr|Ms|Mrs|No|vs|etc|Inc|Co|Corp|Jr|Sr|Gov|Sen|Rep|e\.g|i\.e|approx)\.|\b[A-Z]\.)$`);

/** The block's sentences, not cut after an abbreviation or initial (U.S., St., e.g.). */
export function sentences(block: string): string[] {
  const out: string[] = [];
  for (const piece of split(/(?<=[.;!?])\s+|(?<=[.;!?]\*\*)\s+|(?<=[.;!?]\*)\s+/, block)) {
    if (out.length && search(ABBR, out[out.length - 1])) out[out.length - 1] += " " + piece;
    else out.push(piece);
  }
  return out;
}

const namePat = (e: string, extra = "") => rx(String.raw`(?i)(?<![\w-])` + escapeRe(e) + String.raw`(?![\w-])` + extra);

/** Prose that names an entity right before a number gives that entity's figure; returns the other entity's name. */
export function misnamed(sents: string[], n: Num, fhits: any[], ents: Ents): string | null {
  if (!fhits.length || !fhits.every((f) => isObj(f.where) && Object.keys(f.where).length)) return null;
  const own = new Set<string>();
  for (const f of fhits) for (const v of Object.values(f.where)) for (const form of forms(v)) own.add(form);
  const spots: [string, number][] = [];
  for (const x of sents) for (const m of finditer(tokRe(n.tok), x)) spots.push([x, m.index]);
  for (const [x, i] of spots) {
    let win = x.slice(Math.max(0, i - 40), i);
    win = sub(/\(\s*\d{3,5}\s*,/, (m) => "(" + " ".repeat(m[0].length - 1), win);    // "(1863, "
    const cut = Math.max(0, ...finditer(/\d/, win).map(end));
    win = win.slice(cut);                                                        // since the previous number
    const seen = new Map<string, M>();
    for (const e of ents.keys()) {
      const m = search(namePat(e), win);
      if (m) seen.set(e, m);
    }
    if (cut && seen.size && !strip(win.slice(0, Math.min(...[...seen.values()].map((m) => m.index))))) continue;
    const named = [...seen.entries()].filter(([, m]) => isUpper(m[0][0]) || /^[\s(:+-]*$/.test(win.slice(end(m))))
      .map(([e]) => [e, ents.get(e)![0]] as [string, Set<string>]);
    if (!named.length || new Set([...seen.keys()].map((e) => ents.get(e)![1])).size > 1) continue;
    const gapAt = Math.max(...named.flatMap(([e]) => finditer(namePat(e), win).map(end)));
    const gap = win.slice(gapAt);
    if (!fullmatch(rx(String.raw`(?i)[\s(:,$–+-]*(?:(?:at|was|is|of|with|had|reached|down|up|fell|rose)\s+)?[\s($+]*`), gap)) continue;
    const after = x.slice(i + n.tok.length, i + n.tok.length + 60);
    let follows = false;
    for (const e of own) {
      if (!ents.has(e)) continue;
      const m = search(namePat(e, String.raw`(?!\s*[(:]\s*\$?\d)`), after);
      if (m && m.index < 25 && fullmatch(/\s*(?:[a-z%$]+\s+){0,3}/i, after.slice(0, m.index))) follows = true;
    }
    if (follows) continue;                  // the number's name follows it ("$1,072.6 billion on Medicare")
    if (named.some(([e]) => own.has(e))) continue;
    if (named.some(([, keys]) => [...keys].some((k) => fhits.some((f) => k in f.where)))) return ents.get(named[named.length - 1][0])![1];
  }
  return null;
}

const OTHER = rx(String.raw`(?i)\b(?:than|compar\w*|versus|vs\.?|against|above|below|average|whereas|while|relative|` +
  String.raw`ratio|share|of\s+(?:the|its|their)\s+\w+|percent\s+of)\b`);

/** A where value that names a row (Colorado, 117th, Energy), not a period, code or number. */
function rowName(v0: unknown): string | null {
  const v = cellKey(v0);
  if (v.length >= 2 && v.length <= 60 && ((/[a-z]{3}/.test(v) && !/\d/.test(v)) || /^\d{1,3}(?:st|nd|rd|th)(?:\s+[a-z]+)?$/.test(v))) return v;
  return null;
}

function value(f: any): number {
  const v = toFloat(f?.value);
  return v === null || f?.value === null || f?.value === undefined ? 0.0 : v;
}

const dictEq = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && JSON.stringify(a[k]) === JSON.stringify(b[k]));
};
const without = (o: Record<string, unknown>, k: string) => Object.fromEntries(Object.entries(o).filter(([a]) => a !== k));

/** A clause about one row must cite that row's figure; returns the named row when it cites a sibling's. */
export function clauseOwner(sents: string[], n: Num, fhits: any[], facts: Facts): string | null {
  if (!fhits.length || !fhits.every((f) => isObj(f.where) && Object.keys(f.where).length)) return null;
  const keySets = fhits.map((f) => new Set(Object.entries(f.where).filter(([, v]) => rowName(v)).map(([k]) => k)));
  const keys = [...keySets[0]].filter((k) => keySets.every((s) => s.has(k)));
  const all = Object.values(facts || {}).filter((g) => isObj(g) && isObj(g.where));
  for (const k of keys) {
    const rows = new Set(all.map((f2) => rowName(f2.where[k])).filter((x): x is string => x !== null));
    const own = new Set(fhits.map((f) => rowName(f.where[k])));
    for (const x of sents) {
      const i = at(x, n.tok);
      if (i < 0) continue;
      const named = [...rows].filter((r) => [...forms(r)].some((form) => search(namePat(form), x)));
      if (named.length !== 1 || named.some((r) => own.has(r))) continue;
      const row = named[0];
      const ms = [...forms(row)].flatMap((form) => finditer(namePat(form), x.slice(0, i)))
        .filter((m) => isUpper(m[0][0]) || isDigit(m[0][0]));   // a name, not a phrase ("all civilian workers")
      if (!ms.length || search(OTHER, x.slice(Math.max(...ms.map(end)), i))) continue;
      const stem = (f: any, name: string | null) => strip(sub(namePat(name ?? "None"), "", cellKey(f.label ?? "")));
      const sib = all.filter((g) => rowName(g.where[k]) === row && fhits.some((f) =>
        dictEq(without(g.where, k), without(f.where, k)) && stem(g, row) === stem(f, rowName(f.where[k]))));
      if (sib.length && !sib.some((g) => fhits.some((f) => value(g) === value(f)))) return row;
    }
  }
  return null;
}

const GENERIC_ACR = new Set("GDP USA BLS BEA OPM FRED IPUMS CPS ACS OMB CBO GAO MTS API NSA SA SAAR FY CY NAICS MOE SE CI USD DC".split(" "));
const ACR_BEFORE = rx(String.raw`\b([A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)?)\s*[,:(]?\s*(?:(?:was|is|at|of|up|down|rose|fell|grew|` +
  String.raw`increased|decreased|declined|by|=)\s+){0,2}[+\-−]?\$?$`);
const NOT_THIS = rx(String.raw`(?i)\b(?:instead\s+of|rather\s+than|except|excluding|without|not|than|vs\.?|versus)\s*$`);

/** A measure named by its acronym right before the number must be a fact of that measure; returns the acronym. */
export function measureNamed(sents: string[], n: Num, fhits: any[], facts: Facts): string | null {
  const labels = Object.values(facts || {}).filter(isObj).map((f) => str(f.label || ""));
  if (!fhits.length || !labels.length || !fhits.every((f) => f.label)) return null;
  for (const x of sents) {
    const i = at(x, n.tok);
    if (i < 0) continue;
    const m = search(ACR_BEFORE, x.slice(Math.max(0, i - 40), i));
    if (!m) continue;
    const before = x.slice(Math.max(0, i - 40 - 30), Math.max(0, i - 40) + m.index);
    if (search(NOT_THIS, before)) continue;     // "CPI-W instead of CPI-U, +$21": the acronym is not the measure
    const a = m[1];
    if (GENERIC_ACR.has(a) || a.length < 3) continue;
    const pat = new RegExp(String.raw`(?<![\w-])` + escapeRe(a) + String.raw`(?![\w-])`);
    const carry = labels.filter((lab) => pat.test(lab));
    if (!carry.length || carry.length > labels.length / 2) continue;
    if (!fhits.some((f) => pat.test(str(f.label)))) return a;
  }
  return null;
}

const tableLines = (block: string) => splitlines(strip(block)).filter((l) => lstrip(l).startsWith("|"));

/** A table's columns each hold one measure: a cell whose facts give another column's measure was moved across. */
export function columnMisfits(block: string, facts: Facts): string[] {
  const lines = tableLines(block);
  if (lines.length < 5) return [];
  const named = Object.entries(facts || {}).filter(([, f]) => isObj(f) && f.label);
  if (!named.length) return [];
  const shown = named.map(([k, f]) => [k, factDisplay(f), f] as [string, Disp | null, any]).filter(([, d]) => d) as Shown[];
  const stem = (f: any) => {
    let s = cellKey(f.label);
    for (const v of Object.values(isObj(f.where) ? f.where : {})) s = s.split(cellKey(v)).join(" ");
    return s.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  };
  const cols = new Map<number, [string, Set<string>][]>();
  for (const l of lines.slice(2)) {
    const cells = cellsOf(l).map((c) => strip(c));
    cells.slice(1).forEach((c, j) => {
      const k = j + 1;
      for (const n of answerNumbers(c)) {
        n.table = true;
        const stems = new Set(shown.filter(([, d]) => matches(n, ...d)).map(([, , f]) => stem(f)));
        if (stems.size) {
          if (!cols.has(k)) cols.set(k, []);
          cols.get(k)!.push([n.tok, stems]);
        }
      }
    });
  }
  const mode = new Map<number, string>();
  for (const [k, cells] of cols) {
    if (cells.length < 3) continue;
    const counts = new Map<string, number>();
    for (const [, st] of cells) for (const s of st) counts.set(s, (counts.get(s) || 0) + 1);
    let top = "", nTop = -1;
    for (const [s, c] of counts) if (c > nTop) [top, nTop] = [s, c];
    if (nTop >= Math.max(3, cells.length - 1) && [...counts.values()].filter((c) => c === nTop).length === 1) mode.set(k, top);
  }
  const out: string[] = [];
  for (const [k, cells] of cols) {
    if (!mode.has(k)) continue;
    const others = new Set([...mode.entries()].filter(([j, m]) => j !== k && m !== mode.get(k)).map(([, m]) => m));
    out.push(...cells.filter(([, st]) => !st.has(mode.get(k)!) && [...st].some((s) => others.has(s))).map(([tok]) => tok));
  }
  return out;
}

/** A table whose rows hold facts but none of whose row labels keys a fact (`where=`). */
function unboundTable(block: string, shown: Shown[], facts: Facts): string | null {
  const rows: string[] = [];
  for (const l of tableLines(block).slice(2)) {
    const nums = answerNumbers(l);
    for (const n of nums) n.table = true;
    if (!nums.some((n) => shown.some(([name, d]) => name in (facts || {}) && matches(n, ...d)))) continue;
    const row = nums.length ? rowLabel(nums[0]) : null;
    if (row !== null) rows.push(row);
  }
  if (rows.length < 2) return null;
  const vals = Object.values(facts || {}).filter(isObj).flatMap((f) => Object.values(isObj(f.where) ? f.where : {}).map(cellKey));
  return rows.some((r) => vals.some((v) => new RegExp("^" + escapeRe(r) + String.raw`(?:$|\s*[,;:(–-])`).test(v))) ? null : rows[0];
}

const FROM_TO = rx(String.raw`(?i)\b(rose|risen|increased|grew|grown|climbed|jumped|fell|fallen|declined|dropped|decreased|slipped|shrank|` +
  String.raw`shrunk)\s+(?:[a-z]+\s+){0,3}?from\s+(?:about\s+|roughly\s+)?(-?\$?\d[\d,]*(?:\.\d+)?)\s*` +
  String.raw`(%|percent|thousand|million|billion|trillion)?[^.;\n]{0,40}?\bto\s+(?:about\s+|roughly\s+)?` +
  String.raw`(-?\$?\d[\d,]*(?:\.\d+)?)\s*(%|percent|thousand|million|billion|trillion)?`);
const VS_FROM = rx(String.raw`(?i)(?<![\w.,])(-?\$?\d[\d,]*(?:\.\d+)?)\s*(%|percent|thousand|million|billion|trillion)?` +
  String.raw`(?:\s+(?:in|for)\s+(?:fy\s?)?(?:19|20)\d\d)?\s*,?\s+(up|down|higher|lower)\s+from\s+(?:about\s+)?` +
  String.raw`(-?\$?\d[\d,]*(?:\.\d+)?)\s*(%|percent|thousand|million|billion|trillion)?`);

/** "fell from $890.8 billion to $984.0 billion": a direction word whose own from-to numbers move the other way. */
export function fromToMisreads(text: string): string[] {
  const out: string[] = [];
  const num = (t: string) => Number(t.replace(/\$/g, "").replace(/,/g, ""));
  for (const m of finditer(FROM_TO, text)) {
    const a = m[2], ua = (m[3] || "").toLowerCase(), b = m[4], ub = (m[5] || "").toLowerCase();
    if (/^(?:1[89]|20)\d\d$/.test(a) && /^(?:1[89]|20)\d\d$/.test(b) && !(ua || ub)) continue;
    const x = num(a) * (SCALE[ua || ub] ?? 1.0), y = num(b) * (SCALE[ub || ua] ?? 1.0);
    const up = !/^(?:fell|fallen|declin|drop|decreas|slip|shr)/i.test(m[1]);
    if ((up && y < x) || (!up && y > x)) out.push(m[0].slice(0, 60));
  }
  for (const m of finditer(VS_FROM, text)) {         // "18.3 percent in 2025, down from 16.8 percent": now vs then
    const a = m[1].replace(/,+$/, ""), ua = (m[2] || "").toLowerCase(), word = m[3].toLowerCase();
    const b = m[4].replace(/,+$/, ""), ub = (m[5] || "").toLowerCase();
    if (!ua && /^(?:19|20)\d\d$/.test(a)) continue;   // "in 2025, down from 17.6": the year is not the level
    if ((ua === "%" || ua === "percent") !== (ub === "%" || ub === "percent") && ua && ub) continue;
    const x = num(a) * (SCALE[ua || ub] ?? 1.0), y = num(b) * (SCALE[ub || ua] ?? 1.0);
    const up = ["up", "higher", "rising", "rose"].includes(word);
    if ((up && x < y) || (!up && x > y)) out.push(m[0].slice(0, 60));
  }
  return out;
}

/** A table cell matches a fact of its own row, when facts are registered by that row. */
export function rowOk(n: Num, fhits: any[], facts: Facts): boolean {
  const row = rowLabel(n);
  if (row === null) return true;
  const base = row.replace(/\s*\(.*\)\s*$/, "") || row;    // "retirement (voluntary, early out)" -> retirement
  const pat = new RegExp("^" + escapeRe(row) + String.raw`(?:$|\s*[,;:(–-])`);
  const keyed = (f: any) => Object.values(isObj(f.where) ? f.where : {}).some((v) => pat.test(cellKey(v)) || cellKey(v) === base);
  if (!Object.values(facts || {}).some((f) => isObj(f) && keyed(f))) return true;
  return fhits.some(keyed);
}

const MONTHS: Record<string, number> = Object.fromEntries(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct",
  "nov", "dec"].map((m, i) => [m, i + 1]));
const MONTH_RE = new RegExp(String.raw`\b(` + Object.keys(MONTHS).join("|") + String.raw`)[a-z]*\b`);

/** A period as year*100 + month (month 0 when only a year is given; a quarter is its first month). */
export function periodKey(x0: unknown): number | null {
  const x = strip(strip(strip(str(x0).toLowerCase()), "*"));
  const ym = /^((?:19|20)\d\d)(0[1-9]|1[0-2])$/.exec(x);              // OPM's yyyymm (202508)
  if (ym) return Number(ym[1]) * 100 + Number(ym[2]);
  if (!/^(?:(?:fy\s?)?\d{4}(?:-\d{2}(?:-\d{2})?)?(?:\s*:?\s*q[1-4])?|q[1-4]\s+\d{4}|[a-z]{3,9}\.?\s+\d{4})$/.test(x)) return null;
  const y = /(?<!\d)(17|18|19|20)\d\d(?!\d)/.exec(x);
  if (!y) return null;
  const q = /q([1-4])/.exec(x);
  const m = /(?<!\d)(?:17|18|19|20)\d\d-(\d\d)/.exec(x) || MONTH_RE.exec(x);
  const month = q ? 3 * Number(q[1]) - 2 : m ? (/^\d+$/.test(m[1]) ? Number(m[1]) : MONTHS[m[1].slice(0, 3)]) : 0;
  return Number(y[0]) * 100 + month;
}

/** Months from period fk to period ref; whole years when either gives only a year. */
function lag(ref: number, fk: number): number {
  if (ref % 100 && fk % 100) return (Math.floor(ref / 100) * 12 + (ref % 100)) - (Math.floor(fk / 100) * 12 + (fk % 100));
  return (Math.floor(ref / 100) - Math.floor(fk / 100)) * 12;
}

/** The periods a fact is about, from its `where`; a vintage, release or retrieval date is not one. */
export function factPeriods(f: any): number[] {
  const w: [string, unknown][] = Object.entries(isObj(f?.where) ? f.where : {}).filter(([name]) =>
    !/vintage|release|as_?of|retriev|published|accessed/i.test(name));
  const per = (v: unknown) => periodKey(str(v).replace(/\s*\(.*\)\s*$/, ""));       // "2026 (to Oct 15)"
  let keys = w.map(([, v]) => per(v)).filter((k): k is number => k !== null);
  const monE = w.find(([name]) => /month/i.test(name));
  const mon = monE ? strip(str(monE[1])).toLowerCase() : "";
  const m = /^(?:0?[1-9]|1[0-2])$/.test(mon) ? Number(mon) : /^[a-z]{3,9}\.?$/.test(mon) ? MONTHS[mon.slice(0, 3)] ?? null : null;
  const years = w.map(([name, v]) => [per(v), name] as [number | null, string]).filter(([k]) => k !== null && k % 100 === 0) as [number, string][];
  if (m && years.length === 1) {
    const y = Math.floor(years[0][0] / 100);
    const fv = w.find(([name]) => name === years[0][1])![1];
    const fiscal = /fiscal|\bfy/i.test(years[0][1]) || str(fv).toLowerCase().startsWith("fy");
    keys = [...keys.filter((k) => k !== years[0][0]), (fiscal && m >= 10 ? y - 1 : y) * 100 + m];
  }
  if (keys.some((k) => k % 100)) keys = keys.filter((k) => k % 100);   // the month is the fact's period
  if (!keys.length) {                                // a wide table's column ("share_2019", "2025"): its one year
    const col = str(f?.column || "");
    const ys = /fy|fiscal/i.test(col) ? [] : [...col.matchAll(/(?<!\d)((?:19|20)\d\d)(?!\d)/g)].map((x) => x[1]);
    if (ys.length === 1) keys = [Number(ys[0]) * 100];
  }
  return keys;
}

const NO_BASE = String.raw`(?!\s*(?:dollars|prices|\$|=\s*100))`;   // "2024 dollars" is a price base, not a period
const HEAD_PERIOD = rx(String.raw`(?i)\s*\**\s*((?:fy\s?)?\d{4}(?:-\d{2})?|[a-z]{3,9}\.?\s+\d{4})\b` + NO_BASE);
const HEAD_CMP = rx(String.raw`(?i)\b(?:since|from|vs\.?|versus|change|minus|relative|compared|than|over)\b`);
const HEAD_YEAR = rx(String.raw`(?i)(?<![\w-])(?<!constant\s)(?<!chained\s)((?:fy\s?)?(?:19|20)\d\d(?:-\d{2})?)(?![\w-]|\s*[–-]\s*\d)` + NO_BASE);

/** In a table keyed by periods, a cell whose matching facts all break its column's lag is a value moved. */
export function periodMisfits(block: string, shown: Shown[], facts: Facts): string[] {
  const lines = tableLines(block);
  if (lines.length < 4) return [];
  const cols = new Map<string, [string, Set<number>][]>();
  const head = cellsOf(lines[0]).map((c) => strip(c));
  for (const l of lines.slice(2)) {
    const cells = cellsOf(l).map((c) => strip(c));
    const rk = cells.length ? periodKey(cells[0].replace(/\s*\(.*\)\s*$/, "")) : null;
    cells.slice(1).forEach((c, j) => {
      const k = j + 1;
      let hm: string | null = null;
      if (k < head.length) {
        const m0 = match(HEAD_PERIOD, head[k]);
        if (m0) hm = m0[1];
        else if (!search(HEAD_CMP, head[k])) {
          // one period anywhere in the header: "Share, 2026 (%)", but not "Change since September 2024"
          const found = finditer(HEAD_YEAR, head[k]).map((x) => x[1]);
          if (found.length === 1 && head[k].includes(found[0])) hm = found[0];
        }
      }
      const hk = hm !== null ? periodKey(hm) : null;
      for (const [key, ref] of [["r", rk], ["h", hk]] as [string, number | null][]) {
        if (ref === null) continue;
        for (const n of answerNumbers(c)) {
          n.table = true;
          const lags = new Set<number>();
          let matched = false;
          for (const [name, d, f] of shown) {
            if (name in (facts || {}) && matches(n, ...d)) {
              matched = true;
              const fy = match(/\s*\**\s*(?:fy|fiscal)/i, key === "r" ? cells[0] : head[k]);
              for (let fk of factPeriods(f)) {
                if (fy && fk % 100 >= 10) fk = (Math.floor(fk / 100) + 1) * 100;   // Oct-Dec belong to the next FY
                lags.add(lag(ref, fk));
              }
            }
          }
          if (lags.size || matched) {           // judged by its dated facts; a cell matching only undated ones fits no row
            const ck = `${key}|${k}`;
            if (!cols.has(ck)) cols.set(ck, []);
            cols.get(ck)!.push([n.tok, lags]);
          }
        }
      }
    });
  }
  const out: string[] = [];
  for (const cells of cols.values()) {
    if (cells.length === 2 && cells.some(([, lags]) => lags.has(0))) {
      out.push(...cells.filter(([, lags]) => !lags.has(0)).map(([tok]) => tok));   // "FY2025 | FY2026": each row its own
      continue;
    }
    if (cells.length === 2 && cells.every(([, lags]) => lags.size) && ![...cells[0][1]].some((g) => cells[1][1].has(g))) {
      out.push(...cells.map(([tok]) => tok));   // two rows with no lag in common: their values were swapped
      continue;
    }
    if (cells.length < 3) continue;
    if (cells.filter(([, lags]) => lags.size).length < 3) continue;   // too few dated cells to read the column's lag
    const counts = new Map<number, number>();
    for (const [, lags] of cells) for (const g of lags) counts.set(g, (counts.get(g) || 0) + 1);
    let mode = 0, top = -1;
    for (const [g, c] of counts) if (c > top) [mode, top] = [g, c];
    if (top < cells.length - 1) continue;        // no lag shared by the column: nothing to compare
    out.push(...cells.filter(([, lags]) => !lags.has(mode)).map(([tok]) => tok));
  }
  return out;
}

const YEAR_AFTER = rx(String.raw`(?i)^\s*(?:percent(?:age points?)?|points?|pp)?(?:\s+of\s+(?:the\s+)?(?:[a-z.]{2,15}\s+){0,3}[a-z]{2,15})?\s*` +
  String.raw`(?:in|for|during)\s+(?:the\s+)?` +                          // "percent of GDP in 2019"
  String.raw`(?:(?P<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?` +   // in September 2024
  String.raw`(?:fy\s?)?((?:17|18|19|20)\d\d)` +
  String.raw`\b(?!\s*(?:-|–|to|through)\s*(?:\d|[a-z]{3,9}\.?\s+\d)|\s*(?:dollars|prices|terms|chained|constant|real))|^\s*(?:percent(?:age points?)?|points?)?\s*\((?:fy\s?)?((?:17|18|19|20)\d\d)\)`);
const YB1 = rx(String.raw`(?i)\b(?:in|for|during)\s+((?:fy\s?)?(?:17|18|19|20)\d\d)\b([^\d.;,:]{0,25})$`);
const YB2 = rx(String.raw`(?i)(?<![\w-])((?:fy\s?)?(?:17|18|19|20)\d\d)()\s*\(\s*(?:about\s+)?[$+\-−]?$`);
const YB_CMP = rx(String.raw`(?i)\b(?:to|from|than|vs|versus|compared|since|over|until|through|and)\b`);

/** "for 2025 (men 20.2": a year that dates the number from just before it, as " in 2025" for wrongYear. */
export function yearBefore(before: string, after = ""): string {
  const m = search(YB1, before) || search(YB2, before);
  const own = split(/[,;]/, after.slice(0, 50), 1)[0];    // the number's own clause
  if (!m || search(YB_CMP, m[2]) || /(?<!\d)(?:17|18|19|20)\d\d(?!\d)/.test(own)) return "";
  return ` in ${m[1]}`;
}

const LABEL_YEAR = rx(String.raw`(?i)(?<!since )(?<!from )(?<!to )(?<!through )(?<!until )(?<!before )(?<!after )` +
  String.raw`(?<![\d-])(?:fy\s?)?((?:19|20)\d\d)(?![\d-])`);

/** "6.3 percent in 2019": when every fact the number matches is keyed to periods and none falls in that year. */
export function wrongYear(after: string, fhits: any[]): boolean {
  const m = match(YEAR_AFTER, after);
  if (!m) return false;
  const year = Number(m[2] || m[3]);
  const mon = MONTHS[(m.groups?.mon || "").toLowerCase().slice(0, 3)];
  const keys: number[] = [];
  for (const f of fhits) {
    let ks = factPeriods(f);
    if (!ks.length) {                // a sensitivity fact keyed by its alternative: the one year its label names
      const ys = new Set(finditer(LABEL_YEAR, str(f.label || "")).map((x) => x[1]));
      ks = ys.size === 1 ? [Number([...ys][0]) * 100] : [];
    }
    if (!ks.length) return false;    // a fact without a period could be any year
    keys.push(...ks);
  }
  if (mon && keys.every((k) => k % 100)) return !keys.includes(year * 100 + mon);
  return keys.length > 0 && !keys.map((k) => Math.floor(k / 100)).includes(year);
}

/** The facts of the year the sentence gives for the number, when some match it; otherwise all of fhits. */
export function dated(sents: string[], n: Num, fhits: any[]): any[] {
  for (const x of sents) {
    const i = at(x, n.tok);
    if (i < 0) continue;
    const after = x.slice(i + n.tok.length);
    const m = match(YEAR_AFTER, after.slice(0, 40)) || match(YEAR_AFTER, yearBefore(x.slice(0, i), after));
    if (m) {
      const year = Number(m[2] || m[3]);
      const own = fhits.filter((f) => factPeriods(f).map((k) => Math.floor(k / 100)).includes(year));
      if (own.length) return own;
    }
  }
  return fhits;
}

function pubYearFits(period: string, spots: [string, number][], tok: string): boolean {
  const have = new Set([...period.matchAll(/(?<!\d)((?:17|18|19|20)\d\d)(?!\d)/g)].map((x) => x[1]));
  if (!have.size) return true;
  for (const [x, i] of spots) {
    const after = x.slice(i + tok.length);
    const m = match(YEAR_AFTER, after.slice(0, 40)) || match(YEAR_AFTER, yearBefore(x.slice(0, i), after));
    if (m && !have.has(m[2] || m[3])) return false;
  }
  return true;
}

// a citing word: the number is someone else's ("BLS publishes 770", "matches the published 23.3")
const CITING = rx(String.raw`(?i)benchmark|publish|\breports?\b|\breported\b|\brelease[sd]?\b|according to|official|` +
  String.raw`\bmatch(?:es|ed)?\b|\bagrees?\b|compared? with|vintage|first (?:estimate|release)|superseded|` +
  String.raw`as (?:first )?(?:reported|published)`);
const COMMON = new Set(("the and for from table tables data release report page series news annual monthly latest estimates " +
  "estimate summary file files statistics united states national official published labor force current population survey " +
  "department bureau office averages average income employment economic analysis interactive database dashboard workforce " +
  "federal public monthly weekly quarterly detailed historical with https http www gov htm html pdf xlsx csv").split(" "));

/** The publisher's names in benchmark.csv's source column: acronyms, codes and proper names. */
function sourceWords(sources: string[]): Set<string> {
  const out = new Set<string>();
  for (const src0 of sources) {
    const src = str(src0).replace(/https?:\/\/\S+/g, " ");
    for (const w of src.match(/[A-Za-z][A-Za-z0-9&'-]+/g) || []) {
      const low = w.toLowerCase();
      if (COMMON.has(low) || w.length < 2) continue;
      if (/^[A-Z]{2,}[A-Za-z0-9]*$/.test(w) || /\d/.test(w) || (isUpper(w[0]) && w.length >= 4)) out.add(low);
    }
    // the initials of a capitalized name: "Office of the Federal Register" -> ofr
    for (const run of src.match(/[A-Z][a-z]+(?:\s+(?:(?:of|the|and|for|on)\s+)*[A-Z][a-z]+)+/g) || []) {
      const ini = (run.match(/[A-Z][a-z]+/g) || []).map((x) => x[0]).join("");
      if (ini.length >= 2) out.add(ini.toLowerCase());
    }
  }
  return out;
}

function cites(text: string, ws: Set<string>): boolean {
  const low = text.toLowerCase();
  return !!search(CITING, text) || [...ws].some((w) => new RegExp(String.raw`(?<![\w-])` + escapeRe(w) + String.raw`(?![\w-])`).test(low));
}

/** Is a number that is only a published benchmark figure credited to its publisher? */
function attributed(block: string, n: Num, isTable: boolean, sources: string[] = []): boolean {
  const ws = sourceWords(sources);
  if (!isTable) {
    const lead = match(/\s*(?:[-*]\s+)?\*\*(.+?)\*\*/, block);      // a bold lead-in labels its paragraph
    if (lead && search(CITING, lead[1])) return true;
    const sent = split(/(?<=[.!?])\s+(?=[A-Z*(\[])/, block).filter((x) => has(x, n.tok));
    return (sent.length ? sent : [block]).some((x) => cites(x, ws));
  }
  const lines = tableLines(block);
  if (!lines.length) return true;
  const head = cellsOf(lines[0]).map((c) => strip(c));
  let seen = false;                                   // every cell holding the number sits under a credited header
  const body = lines.length > 2 ? lines.slice(2) : lines;
  const own = body.filter((l) => strip(n.line || "") === strip(l));
  for (const l of own.length ? own : body) {
    const cells = cellsOf(l).map((c) => strip(c));
    for (let k = 0; k < cells.length; k++) {
      if (has(cells[k], n.tok)) {
        seen = true;
        if (!(k < head.length && cites(head[k], ws))) return false;
      }
    }
  }
  return seen;
}

const BENCH_WORDS = rx(String.raw`(?i)benchmark|published|\bmatch(?:es|ed)?\b|\bagrees?\b|compared? with|same as the`);

// ---------------------------------------------------------------------- dollar basis
const CURRENCY = rx(String.raw`(?i)(?:US)?\$\s?\d|\bUSD\s?\d|\d(?:[\d,.]*\d)?\s*(?:thousand|million|billion|trillion)?\s+dollars\b`);
const YEAR = rx(String.raw`(?<![\d$.,])(?:FY\s?)?((?:19|20)\d{2})(?!\d|,\d{3}|\.\d)`);
const CHANGE = rx(String.raw`(?i)\b(?:up|down)\s+(?:\S+\s+){0,3}?from\b|\b(?:rose|risen|rising|rises?|grew|grown|grows?|growth|` +
  String.raw`increas\w*|decreas\w*|fell|fallen|falls?|declin\w*|jump\w*|doubl\w*|tripl\w*|halv\w*|climb\w*|` +
  String.raw`dropp?\w*|compared\s+(?:with|to)|versus|vs\.?|(?:higher|lower|more|less)\s+than)\b` +
  String.raw`|\bfrom\s+\$[\d.,]+[^.;]{0,40}?\bto\s+\$`);
const BASIS = rx(String.raw`(?i)\bnominal\b|\bcurrent[- ](?:dollars?|prices|\$)|\b(?:not|un|without|before)[- ]?` +
  String.raw`(?:being\s+)?(?:adjust\w*|correct\w*)\s+for\s+inflation|\b(?:inflation|price|cpi|pce)[- ]adjusted\b|` +
  String.raw`\badjust\w*\s+(?:\w+\s+)?for\s+(?:inflation|prices)|\breal\s+(?:terms|dollars?|values?|spending|` +
  String.raw`income|incomes|wages?|earnings|growth|prices?|gdp|basis|change|increase|decline|rise|fall)\b|` +
  String.raw`\bin\s+real\b|\bconstant[- ](?:(?:19|20)\d{2}\s+)?(?:dollars?|prices|\$)|\bchained\b|` +
  String.raw`\b(?:19|20)\d{2}\s+dollars\b|\(\s*(?:19|20)\d{2}\s*\$\s*\)|\btoday'?s\s+dollars\b|\bdeflat\w*`);

const years = (s: string) => new Set(finditer(YEAR, s).map((m) => m[1]));
const isTableBlock = (b: string) => splitlines(strip(b)).every((l) => lstrip(l).startsWith("|"));

/** Sentences (and tables) that put dollar amounts of two or more different years side by side. */
export function dollarComparisons(text: string): string[] {
  const found: string[] = [];
  for (const [block] of blocks(text)) {
    const lines = splitlines(strip(block));
    if (lines.every((l) => lstrip(l).startsWith("|"))) {
      const rows = lines.filter((l) => !/^\|?[\s:|-]+\|?$/.test(strip(l))).map((l) => cellsOf(l).map((c) => strip(c)));
      if (rows.length < 2) continue;
      const inHead = new Set(rows[0].flatMap((c) => [...years(c)]));
      const ys = inHead.size > 1 ? inHead : new Set(rows.slice(1).filter((r) => r.length).flatMap((r) => [...years(r[0])]));
      const money = /\$|dollar|\bUSD\b/i.test(rows[0].join(" ")) ||
        rows.slice(1).flatMap((r) => r).filter((c) => search(CURRENCY, c)).length > 1;
      if (ys.size > 1 && money) found.push(strip(lines[0]).slice(0, 80));
      continue;
    }
    const sents = sentences(block);
    sents.forEach((s, i) => {
      const amounts = finditer(CURRENCY, s).length;
      if (amounts && years(s).size > 1 && (amounts > 1 || search(CHANGE, s))) {
        found.push(s.split(/\s+/).filter((x) => x).join(" ").slice(0, 80));
        return;
      }
      const two = sents.slice(i, i + 2).join(" ");             // "$X in 2019. By 2024 it reached $Y, an increase ..."
      if (i + 1 < sents.length && amounts && finditer(CURRENCY, two).length > 1 && years(two).size > 1 && search(CHANGE, sents[i + 1])) {
        found.push(two.split(/\s+/).filter((x) => x).join(" ").slice(0, 80));
      }
    });
  }
  return found;
}

/** FAIL when answer.md compares dollar amounts across years and nowhere says nominal or real. */
export function checkDollarBasis(text: string, D: any): Result {
  const entry = D.dollar_basis_ok;
  const reason = isObj(entry) ? entry.reason : entry;
  const found = dollarComparisons(text);
  if (!found.length) return ["answer", true, "no dollar amounts compared across years"];
  if (search(BASIS, text)) return ["answer", true, "dollar amounts compared across years carry their basis (nominal or real)"];
  if (typeof reason === "string" && strip(reason)) {
    return ["answer", true, `dollar amounts compared across years without a basis: ${strip(reason).slice(0, 80)}`];
  }
  return ["answer", false, `answer.md compares dollar amounts of different years (${found.slice(0, 2).map(repr).join("; ")}) ` +
    "and never says their basis: say whether they are nominal (current dollars, not adjusted for inflation) or real " +
    "(which index, in which year's dollars) next to the first comparison, and record the choice in decisions.json. When " +
    'the basis truly does not matter, give decisions.json "dollar_basis_ok": {"reason": "..."} (record_decisions)'];
}

/** [text to scan, text a label may sit in]: each paragraph; a table with its caption and notes. */
export function blocks(text: string): [string, string][] {
  const paras = split(/\n\s*\n/, text).filter((p) => strip(p));
  return paras.map((p, i) => {
    const t = isTableBlock(p);
    const ctx = [...(t && i ? [paras[i - 1]] : []), p, ...(t && i + 1 < paras.length ? [paras[i + 1]] : [])].join("\n");
    return [p, ctx];
  });
}

/** Counts spelled out as a whole table cell ("| four |"): the facts tool writes 0-9 in words. */
export function tableWords(block: string): Num[] {
  const out: Num[] = [];
  for (const line of splitlines(block)) {
    if (!lstrip(line).startsWith("|")) continue;
    for (const cell of cellsOf(line)) {
      const w = strip(cell).toLowerCase();
      if (w in NUMBER_WORDS) out.push({ tok: w, num: NUMBER_WORDS[w], unit: "", scale: 1.0, tol: 0.5, neg: false, dollar: false });
    }
  }
  return out;
}

const WORD_ALT = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|");
const SUBSET_WORDS = rx(String.raw`(?i)\b(` + WORD_ALT + String.raw`)\s+of\s+(?:the\s+|these\s+|those\s+)?(` + WORD_ALT + String.raw`|\d{1,3})\b`);

/** Data rows of each markdown table in the answer (header and |---| rule not counted). */
export function tableSizes(text: string): Set<number> {
  const sizes = new Set<number>();
  for (const [block] of blocks(text)) {
    const rows = tableLines(block);
    if (rows.length && rows.length === splitlines(strip(block)).length) {
      sizes.add(rows.slice(1).filter((l) => !/^\s*\|[\s:|-]+\|?\s*$/.test(l)).length);
    }
  }
  return sizes;
}

/** "four of the five" in prose over a five-row table summarizes that table: a count to register. */
export function subsetWords(block: string, sizes: Set<number>): Num[] {
  const out: Num[] = [];
  const t = AR.exempt(block);
  for (const m of finditer(SUBSET_WORDS, t)) {
    const line = sourceLine(block, t, m.index);
    if (lstrip(line).startsWith("|")) continue;
    const w = m[1].toLowerCase(), tw = m[2].toLowerCase();
    const total = tw in NUMBER_WORDS ? NUMBER_WORDS[tw] : Number(tw);
    if (!sizes.has(total) || !(NUMBER_WORDS[w] > 0 && NUMBER_WORDS[w] < total)) continue;
    out.push({ tok: m[1], num: NUMBER_WORDS[w], unit: "", scale: 1.0, tol: 0.5, dec: 0, neg: false, dollar: false, plus: false,
      line, approx: false, unit_after: false, counts: true, table: false });
  }
  return out;
}

const PCT_DESC = /%|percent|\bpct\b|\bpp\b|\brates?\b|\bshares?\b|\byields?\b|\bratios?\b/i;
const AMT_DESC = /\$|dollar|\bthousands?\b|\bmillions?\b|\bbillions?\b|\btrillions?\b|\bcount|number/i;
const FELL_BEFORE = rx(String.raw`(?i)\b(?:down|fell|fallen|declined|decreased|dropped|(?:an?\s+)?(?:decline|` +
  String.raw`drop|fall|decrease|reduction|loss)\s+of)\s+(?:by\s+)?(?:about\s+)?$`);
const LOWER_AFTER = rx(String.raw`(?i)\s*(?:percentage\s+points?|points?|pp|basis\s+points?)?\s*(?:below|lower|less|down|fewer|smaller|under)\b`);
const SIZE_LABEL = rx(String.raw`(?i)declin|decreas|drop|fall|fell|loss|fewer|reduc|lower|cut|down|` +
  String.raw`\bgap\b|differen|shortfall|spread|margin|premium|\bminus\b|\bvs\.?\b|\bbelow\b|\bbehind\b|\bshort\b`);
const CMP_AFTER = rx(String.raw`(?i)\s*(?:percent(?:age)?\s+points?|points?|pp|percent|basis\s+points?)?\s*(?:less|lower|below|fewer|smaller|slower|under)\b`);
const UP_AFTER = rx(String.raw`(?i)\s*(?:percent(?:age)?\s+points?|points?|pp|percent|basis\s+points?)?\s*(?:above|higher|more|greater|up|faster)\b`);
const SIZE_BEFORE = rx(String.raw`(?i)(?:\bwithin|\bdiffer\w*\s+by|\bdifference\s+of|\bgap\s+of|±)\s*(?:about\s+)?$`);
const FELL_MINUS = rx(String.raw`(?i)\b(?:fell|falls?|fallen|falling|declined|declines?|decreased|decreases?|dropped|` +
  String.raw`drops?|down|lost|shr[ai]nk|shrunk)\s+(?:by\s+)?(?:about\s+|nearly\s+|almost\s+)?$`);

/** answer.md, the reply as it will be sent: every number in it is a registered fact as its format shows it (or a
 * published benchmark figure, or in audit_allow); it carries every disclosure line; flagged facts are labelled; it
 * reports the benchmark check. Returns [results, answer text]. */
export function checkAnswer(base: string, facts: Facts, D: any): [Result[], string] {
  const p = path.join(base, "answer.md");
  if (!fs.existsSync(p)) {
    return [[["answer", false, "answer.md missing: pass the reply exactly as you will send it to audit_answer (answer)"]], ""];
  }
  const text = AR.readTextFile(p);
  facts = facts || {};
  const out: Result[] = [];
  let shown: Shown[] = Object.entries(facts).map(([name, f]) => [name, factDisplay(f || {}), f || {}] as [string, Disp | null, any])
    .filter(([, d]) => d) as Shown[];
  // a fact printed without its sign (fmt ...:abs) may stand in a table cell as printed or with its sign
  shown = shown.concat(shown.filter(([, d, f]) => d[0] < 0 && String(f.fmt || "").split(":").includes("abs"))
    .map(([name, d, f]) => [name, [Math.abs(d[0]), d[1], d[2]], f] as Shown));
  const bp = path.join(base, "exhibits", "benchmark.csv");     // a published figure the answer compares with
  const benchRows = fs.existsSync(bp) ? MA.readCsv(bp)[1] : [];
  for (const r of benchRows) {
    const b = MA.benchNumber(r.published);
    if (!b) continue;
    // a published figure keeps its kind when the row says it (percent or an amount), never rescaled
    const desc = `${r.published ?? ""} ${r.measure ?? ""} ${r.units ?? ""}`;
    let pct: boolean = PCT_DESC.test(desc);
    const amt = AMT_DESC.test(`${desc} ${r.source ?? ""}`);
    if (!pct && !amt && /\bgrowth\b|\bchanges?\b/i.test(desc)) pct = true;   // a change with no unit: read it as a percent
    let kind = pct && !amt ? "pubpct" : amt && !pct ? "pubnum" : "pub";
    if (kind === "pubpct" && /\bpoints?\b|\bpp\b/i.test(desc)) kind = "pubpp";
    const dec = b[1] < 0.5 ? pyRound(-Math.log10(2 * b[1])) : 0;
    const meta = { _source: `${r.source ?? ""} ${r.url ?? ""}`, _period: str(r.period || ""),
      _measure: ["measure", "geography", "geo", "area", "state", "name", "label", "item", "series", "group"].map((c) => str(r[c] || "")).join(" ") };
    shown.push([`published ${r.measure ?? ""}`, [b[0], kind, dec], meta]);
    // a figure published in thousands (or millions) may be written out: -179 thousand as "179,000"
    const per = /\b(thousands|millions)\b/i.exec(`${r.measure ?? ""} ${r.units ?? ""}`);
    if (per && kind !== "pubpct") {
      const k = per[1].toLowerCase() === "thousands" ? 3 : 6;
      shown.push([`published ${r.measure ?? ""}`, [b[0] * 10 ** k, "pubnum", Math.max(0, dec - k)], meta]);
    }
  }
  const isFactName = (name: string) => Object.prototype.hasOwnProperty.call(facts, name);
  const factToks = new Set(shown.flatMap(([, , f]) => answerNumbers(str(f.text ?? "")).map((n) => n.tok.toLowerCase())));
  const allowed = new Set((D.audit_allow || []).map((a: any) => allowKey(isObj(a) ? a.value : a)));
  const bad: string[] = [], unsigned: string[] = [], unattributed: string[] = [], misrow: string[] = [], wrongyear: string[] = [];
  const unlabelled = new Map<string, string[]>();
  const misnamedL: string[] = [], unbound: string[] = [], cited = new Set<string>();
  const ents = entities(facts);
  const scan = text;
  const lead = blocks(text).slice(0, 2).map(([b]) => b).join("\n");   // a label in the opening covers all
  const sizes = tableSizes(text);
  for (const [block, ctx] of blocks(scan)) {
    const isTable = isTableBlock(block);
    if (isTable) {
      misrow.push(...periodMisfits(block, shown, facts));
      const first = unboundTable(block, shown, facts);
      if (first) unbound.push(first);
    }
    for (const n of [...answerNumbers(block), ...tableWords(block), ...subsetWords(block, sizes)]) {
      n.table = isTable || !!n.table;              // a table under a caption line too
      if (allowed.has(allowKey(n.tok))) continue;
      // a count with its noun ("3 months", "12 states") is no percent: it cannot be a pct, pp or bp fact
      const counted = !n.unit && !!n.counts;
      const hits = shown.filter(([name, d, f]) => matches(n, ...d) && !(n.plus && below0(f))
        && !(counted && isFactName(name) && ["pct", "pp", "bp"].includes(d[1]))).map(([name, , f]) => [name, f] as [string, any]);
      const tokLow = n.tok.toLowerCase();
      if (!hits.length && !factToks.has(tokLow)) bad.push(n.tok);
      const fhits = hits.filter(([name]) => isFactName(name)).map(([, f]) => f);
      if (fhits.length === 1) for (const [name] of hits) if (isFactName(name)) cited.add(name);
      if (hits.length && !fhits.length && !factToks.has(tokLow) && !attributed(block, n, isTable, hits.map(([, f]) => f._source ?? ""))) {
        unattributed.push(n.tok);                 // a published figure passed off as the analysis's own
      }
      const sent0 = sentences(block).filter((x) => has(x, n.tok));
      const spots: [string, number][] = [];
      for (const x of sent0) for (const m of finditer(tokRe(n.tok), x)) spots.push([x, m.index]);
      if (fhits.length && !isTable && !n.table && spots.some(([x, i]) => wrongYear(x.slice(i + n.tok.length).slice(0, 40), fhits)
        || wrongYear(yearBefore(x.slice(0, i), x.slice(i + n.tok.length)), fhits))) {
        const pub = hits.filter(([name, f]) => !isFactName(name) && pubYearFits(f._period ?? "", spots, n.tok)).map(([, f]) => f._source ?? "");
        if (!(pub.length && attributed(block, n, false, pub))) wrongyear.push(n.tok);   // a credited published figure of that year
      }
      if (fhits.length && !isTable && !n.table) {
        const who = misnamed(sent0, n, fhits, ents) || clauseOwner(sent0, n, fhits, facts) || measureNamed(sent0, n, fhits, facts);
        if (who && !hits.some(([name, f]) => !isFactName(name) && [...forms(who)].some((form) => cellKey(f._measure ?? "").includes(form)))) {
          misnamedL.push(`${n.tok} (next to ${who})`);
        }
      }
      const row = isTable ? rowLabel(n) : null;
      const pubSrcs = hits.filter(([name, f]) => !isFactName(name) && (row === null ||
        [...forms(row), strip(row.split(/[-,(]/)[0])].some((form) => form.length >= 3 && cellKey(f._measure ?? "").includes(form))))
        .map(([, f]) => f._source ?? "");
      if (isTable && fhits.length && !rowOk(n, fhits, facts) && !(pubSrcs.length && attributed(block, n, true, pubSrcs))) misrow.push(n.tok);
      const dhits = fhits.length && !n.table ? dated(sent0, n, fhits) : fhits;   // the sentence's year
      const atx = (x: string) => at(x, n.tok);
      if (fhits.length && !n.neg && !n.table && dhits.every((f) => value(f) > 0)
        && (sent0.some((x) => search(FELL_BEFORE, x.slice(Math.max(0, atx(x) - 25), atx(x))))
          || (dhits.every(isChange) && sent0.some((x) => match(LOWER_AFTER, x.slice(atx(x) + n.tok.length)))))
        && !dhits.some((f) => search(SIZE_LABEL, str(f.label ?? "") + " " + str(f.derivation ?? "")))) {
        unsigned.push(n.tok);                     // "down 0.8" for a rise of 0.8
      }
      if (fhits.length && !n.neg && !n.table && dhits.every(negative) && n.num !== 0
        && !(n.unit === "" && n.num <= 12 && Number.isInteger(n.num))) {
        const sl = sentences(block).filter((x) => has(x, n.tok));
        const sent = sl.length ? sl : [block];
        // the words just before the number say its direction ("Virginia rose 25,600"); else the sentence
        const near = sent.filter((x) => has(x, n.tok)).map((x) => x.slice(Math.max(0, atx(x) - 60), atx(x)));
        // or just after it ("426 fewer pages", "0.3 points lower")
        const after = sent.filter((x) => has(x, n.tok)).map((x) => x.slice(atx(x) + n.tok.length, atx(x) + n.tok.length + 30));
        const upNear = near.some((w) => search(UP_WORDS, w) && !search(DOWN_WORDS, w));
        let down = [...near, ...after].some((w) => search(DOWN_WORDS, w));
        if (!down) {                  // a fall word earlier in the sentence with no rise word after it
          for (const x of sent) {
            const pre = x.slice(0, Math.max(atx(x), 0));
            const last = finditer(DOWN_WORDS, pre);
            if (last.length && !search(UP_WORDS, pre.slice(end(last[last.length - 1])))) down = true;
          }
        }
        if (!down && near.some((w) => /\bby\s*$/i.test(w))) down = sent.some((x) => search(DOWN_WORDS, x));
        const cmpAfter = after.some((w) => match(CMP_AFTER, w));
        const size = near.some((w) => search(SIZE_BEFORE, w));
        const upAfter = after.some((w) => match(UP_AFTER, w));
        if ((upNear && !cmpAfter) || upAfter || (!down && !size)) unsigned.push(n.tok);   // "rose 4.2" for -4.2
      } else if (fhits.length && !n.neg && !n.table && n.num !== 0
        && dhits.every((f) => below0(f) && String(f.fmt || "").split(":").includes("abs"))) {
        // a fall printed without its sign (fmt ...:abs) may carry no fall word, but never a rise word
        const close = sentences(block).filter((x) => has(x, n.tok)).map((x) => x.slice(Math.max(0, atx(x) - 25), atx(x)));
        if (close.some((w) => search(UP_WORDS, w) && !search(DOWN_WORDS, w))) unsigned.push(n.tok);
      }
      if (fhits.length && n.neg && !n.table && sent0.some((x) => search(FELL_MINUS, x.slice(Math.max(0, atx(x) - 30), atx(x))))) {
        unsigned.push(n.tok);                     // "fell -8.3 percent": a fall word and a minus sign
      }
      for (const [flag, pat] of Object.entries(FLAG_WORDS)) {   // every reading of this number is flagged: say so here
        const near = ctx + (flag === "preliminary" ? "\n" + lead : "");
        const agg = (xs: any[]) => (flag === "preliminary" ? xs.some((f) => f[flag]) : xs.every((f) => f[flag]));
        let flagged = agg(fhits);
        const pub = hits.filter(([name]) => !isFactName(name)).map(([, f]) => f._source ?? "");
        if (pub.length && attributed(block, n, !!n.table, pub)) {
          // another publisher's figure, credited: our facts count only when they print at the number's own precision
          const exact = fhits.filter((f) => ((factDisplay(f) || [0, "", 0])[2] || 0) <= (n.dec ?? 0));
          flagged = exact.length ? agg(exact) : false;
        }
        if (fhits.length && flagged && !search(pat, near)) {
          if (!unlabelled.has(flag)) unlabelled.set(flag, []);
          unlabelled.get(flag)!.push(n.tok);
        }
      }
    }
  }
  const okTies = new Set((D.rounding_ties_ok || []).map((t: any) => str(isObj(t) ? t.fact : t)));
  const ties = sorted([...cited].filter((n) => !okTies.has(n) && (facts[n] || {}).source && toFloat(facts[n].value) !== null
    && roundingTie(toFloat(facts[n].value)!, pyFloatRepr(toFloat(facts[n].value)!), str(facts[n].fmt || ""))));
  const uniq = (xs: string[]) => [...new Set(xs)].join(", ");
  out.push(["answer", !ties.length, !ties.length ? "no cited figure sits on an unexplained rounding tie"
    : `answer.md cites ${ties.join(", ")}, stored on a rounding tie (one digit past the format, ending in 5): the printed ` +
      "figure depends on digits the CSV dropped. Save the exhibit at full precision (no rounding step) and register again, " +
      "or, when the value is exact at that precision (published so), list it in decisions.json " +
      '"rounding_ties_ok": [{"fact": "<name>", "reason": "..."}]']);
  out.push(["answer", !bad.length, !bad.length ? "every number in answer.md is a registered fact or allowed"
    : `answer.md: ${uniq(bad)} not found among the facts (as their formats show them): register each number with the ` +
      'facts tool (a count in words such as "three of the four" is a number too: count it with compute; a difference in ' +
      "percentage points takes fmt pp or pp100, in basis points bp or bp100; a number written \"44,347 thousand\" or " +
      '"$1.2 billion" is read in base units, so a fact stored in thousands takes fmt thousands:0, and a published figure ' +
      'counts as benchmark.csv gives it), fix the typo, or list it in decisions.json audit_allow {"value", "reason"} when ' +
      'it is not a statistic (the value as written, with its unit: "90 percent")']);
  unsigned.push(...fromToMisreads(blocks(scan).filter(([b]) => !isTableBlock(b)).map(([b]) => b).join("\n")));
  out.push(["answer", !unsigned.length, !unsigned.length ? "every change reads in its own direction"
    : `answer.md: ${uniq(unsigned)}: the direction words disagree with the sign of the facts they match (a negative fact ` +
      "needs fell, declined, down, lower, negative ... next to it; a positive one cannot be written as down or fell): give " +
      "the sign or fix the direction"]);
  out.push(["answer", !wrongyear.length, !wrongyear.length ? "every number dated in the text is a fact of that date"
    : `answer.md: ${uniq(wrongyear)}: the year the text gives next to the number is not one any of the facts it matches is ` +
      "about (those facts are keyed to other periods): check the year or the number"]);
  if (unbound.length) {
    MA.note(`answer.md: the table starting with row ${unbound.map(repr).join(", ")} has no fact registered by its row ` +
      "labels, so a value moved between rows would pass: register each row's facts with where = the row's label as printed");
  }
  out.push(["answer", !misnamedL.length, !misnamedL.length ? "every number beside a name is that name's fact"
    : `answer.md: ${uniq(misnamedL)}: the number matches only facts of other entries of the same kind (another state, ` +
      "industry, group): check the pairing, or register the fact with where = that name"]);
  out.push(["answer", !misrow.length, !misrow.length ? "every table cell is a fact of its own row"
    : `answer.md: table cells ${uniq(misrow)} match facts of other rows only (their labels name another row): check the ` +
      "row, or register the cell's fact with where = the row's label"]);
  const miscol = blocks(scan).filter(([b]) => isTableBlock(b)).flatMap(([b]) => columnMisfits(b, facts));
  out.push(["answer", !miscol.length, !miscol.length ? "every table cell is a fact of its own column"
    : `answer.md: table cells ${uniq(miscol)} hold the measure of another column (their facts' labels match that column's ` +
      "other cells): check the column order"]);
  out.push(["answer", !unattributed.length, !unattributed.length ? "every published figure is credited to its source"
    : `answer.md: ${uniq(unattributed)} match only a published figure in benchmark.csv, not one of this analysis's facts: ` +
      'say whose figure it is ("BLS publishes ...", a "Published" column), or cite the computed fact']);
  const body = norm(text);
  const opening = norm(blocks(text).slice(0, 2).map(([b]) => b).join("\n"));
  const blocking = new Set((D.questions || []).filter((q: any) => isObj(q) && q.blocking && !(q.asked ?? false)).map((q: any) => q.id));
  for (const [k, line] of Object.entries<any>(D.disclosures || {})) {
    if (blocking.has(k) && body.includes(norm(line)) && !opening.includes(norm(line))) {
      out.push(["disclosures", false, `${k}: a blocking question decided without the user: put its disclosure in the ` +
        "answer's opening (title and first paragraph)"]);
    }
    const ok = body.includes(norm(line));
    out.push(["disclosures", ok, ok ? `${k}: carried in answer.md` : `${k}: answer.md must carry this disclosure word for word: ${str(line)}`]);
  }
  for (const [flag, toks] of unlabelled) {
    out.push(["answer", false, `answer.md cites ${flag} values (${uniq(toks)}) without saying so in the opening paragraph ` +
      "or next to them (same paragraph, or the table and its caption)"]);
  }
  const answerToks = answerNumbers(scan);
  const factVals = MA.factValues(facts);
  for (const r of benchRows) {            // a gap beyond rounding on a cited figure: the answer says it and why
    const c = MA.benchNumber(r.computed), pb = MA.benchNumber(r.published);
    const isCited = c && MA.isFact(c[0], Math.max(c[1], Math.abs(c[0]) * 0.005), factVals);
    const sk = MA.SAYS.find((k) => r[k]);
    const says = sk ? strip(String(r[sk])).toLowerCase() : "";
    if (c && pb && isCited && Math.abs(c[0] - pb[0]) > Math.max(pb[1] * 1.0001, Math.abs(pb[0]) * 1e-6) + 1e-12
      && !(says.startsWith("yes") && MA.roundingGap(c, pb, r.published, r.note || r.notes))) {
      const ok = answerToks.some((n) => matches(n, pb[0], "") || Math.abs(n.num - Math.abs(pb[0])) <= n.tol * 1.0001 + 1e-12);
      out.push(["answer", ok, ok ? `benchmark ${r.measure ?? ""}: the published ${str(r.published)} is in answer.md`
        : `benchmark ${r.measure ?? ""} (${r.period ?? ""}): computed ${str(r.computed)} differs from the published ` +
          `${str(r.published)}; answer.md must give the published figure and why (${strip(String(r.note || "")).slice(0, 80)})`]);
    }
  }
  out.push(checkDollarBasis(text, D));
  if (benchRows.some((r) => !String(r.published ?? "").toLowerCase().includes("not checked"))) {
    const ok = !!search(BENCH_WORDS, text);
    out.push(["answer", ok, ok ? "answer.md reports the benchmark check" : "answer.md does not report the benchmark check: " +
      "say which published figure each headline was compared with and whether it matches (exhibits/benchmark.csv)"]);
  }
  return [out, text];
}

/** Tables read by hand from an agency page: each row of published/<name>.csv names its page and date. */
export function checkPublished(base: string): [string, boolean, string, string[]][] {
  const d = path.join(base, "published");
  const out: [string, boolean, string, string[]][] = [];
  for (const f of fs.existsSync(d) && fs.statSync(d).isDirectory() ? fs.readdirSync(d).sort() : []) {
    if (!f.toLowerCase().endsWith(".csv")) continue;
    const [head, rows] = MA.readCsv(path.join(d, f));
    const missing = ["source_url", "accessed"].filter((c) => !head.includes(c));
    const blank = rows.filter((r) => !String(r.source_url || "").startsWith("http") || !/^\d{4}-\d{2}-\d{2}$/.test(strip(String(r.accessed || "")))).length;
    const ok = rows.length > 0 && !missing.length && !blank;
    const msg = ok ? `published/${f}: ${rows.length} rows read from agency pages, each with its source_url and accessed date`
      : `published/${f}: every row needs source_url (the page) and accessed (YYYY-MM-DD)` +
        (missing.length ? `; missing columns ${repr(missing)}` : rows.length ? `; ${blank} row(s) lack them` : "; no rows");
    out.push([f, ok, msg, sorted(new Set(rows.map((r) => String(r.source_url || ""))))]);
  }
  return out;
}

export async function audit(out: string, online = false, rerunIt = false): Promise<Result[]> {
  const base = path.resolve(out);
  const results: Result[] = [];
  const res = (check: string, ok: unknown, msg: string) => void results.push([check, !!ok, msg]);
  if (!fs.existsSync(path.join(base, "decisions.json"))) {
    res("questions", false, "decisions.json missing: record the questions, literature searched, references and " +
      "assumptions (record_decisions)");
  }
  const D = MA.merged(base);
  const fpath = path.join(base, "facts.json");
  const facts: Facts = fs.existsSync(fpath) ? JSON.parse(AR.readTextFile(fpath)) || {} : {};
  if (!Object.keys(facts).length) res("facts", false, "facts.json missing or empty: register every number the answer cites (the facts tool)");
  for (const name of sorted(Object.keys(facts))) res("facts", ...MA.checkFact(name, facts[name] || {}, base));

  const [ans, answerText] = checkAnswer(base, facts, D);
  results.push(...ans, ...MA.checkMethod(D, base, facts), ...MA.checkBenchmark(base, facts));

  const ids = PS.usedSources(base, {});
  let policies: Record<string, Policy> = {};
  try {
    policies = PS.loadPolicies(ids);
  } catch (e) {
    if (!(e instanceof PS.SourceError)) throw e;
    res("vintage", false, e.message);
  }
  if (!ids.length) res("vintage", false, "no source in data/<id>/: fetch the data with the fetch tool");
  for (const [sid, P] of Object.entries(policies)) {        // each source's required statements, in the answer itself
    for (const [status, hid, msg] of PS.runAuditHooks(P, base, null, facts, answerText)) {
      res("policy", status === "PASS", `${sid} hook ${hid}: ${msg.replaceAll("report mentions", "answer.md mentions")}`);
    }
  }
  for (const sid of Object.keys(policies)) {
    const [rel] = PS.provenance(base, sid, {});
    res("vintage", !!rel, rel ? `${sid}: provenance ${rel}` : `${sid}: no provenance file in data/${sid}/ (request.json): the ` +
      "retrieval date cannot be stated");
  }
  const pubUrls: string[] = [];
  for (const [, ok, msg, urlsHere] of checkPublished(base)) {
    res("vintage", ok, msg);
    pubUrls.push(...urlsHere);
  }
  const bp = path.join(base, "exhibits", "benchmark.csv");    // the published figures' pages are links too
  const benchUrls = [...(fs.existsSync(bp) ? MA.readCsv(bp)[1].map((r) => String(r.url || "")) : []), ...pubUrls];
  const urls = sorted(new Set([...AR.allStrings(D), ...benchUrls].flatMap(AR.findUrls).map((u) => u.replace(/[.,;:]+$/, ""))));
  for (const u of urls) res("links", ...(online ? await AR.checkUrl(u) : [true, `${u}: not requested (use online: true to verify)`] as [boolean, string]));

  const hits = relHits(scanTree([base], knownKeys(), echoSources(policies).length > 0)[0], base);
  res("secrets", !hits.length, !hits.length ? "no API key or credential in any output file" : hits.slice(0, 10).join("; "));

  if (rerunIt) {
    const exdir = path.join(base, "exhibits");
    const tracked = fs.existsSync(exdir) ? fs.readdirSync(exdir).filter((f) => f.endsWith(".csv")).sort().map((f) => path.join(exdir, f)) : [];
    results.push(...(await MA.rerun(base, fpath, tracked)));
  }
  return results;
}

/** The lines audit_answer.py prints: one [PASS]/[FAIL] line per check, the failures (and the benchmark counts),
 * notes on what the answer must disclose, then AUDIT PASSED or AUDIT FAILED (n problems). */
export function printed(results: Result[], checks: string[], answerText = "", notes: string[] = []): { lines: string[]; verdict: string; passed: boolean } {
  const lines: string[] = [];
  const fails = results.filter(([, ok]) => !ok);
  for (const name of [...new Set([...checks, ...results.map(([c]) => c)])]) {
    const rs = results.filter(([c]) => c === name);
    if (!rs.length) continue;
    const bad = rs.filter(([, ok]) => !ok);
    lines.push(`[${bad.length ? "FAIL" : "PASS"}] ${name}: ${rs.length - bad.length}/${rs.length} ok`);
    if (name === "benchmark" && !bad.length) for (const r of rs) lines.push(`    ${redact(r[2])}`);
    for (const r of bad) lines.push(`    - ${redact(r[2])}`);
  }
  const low = answerText.toLowerCase();
  for (const [, ok, msg] of results) {          // what the answer must disclose
    if (ok && (msg.includes("disclose") || msg.includes("opening paragraph of the answer"))) {
      const line = msg.includes("disclose in the answer: ") ? strip(msg.split("disclose in the answer: ").slice(1).join("disclose in the answer: ")).toLowerCase() : "";
      if (line && low.includes(line)) continue;
      if (msg.includes("opening paragraph of the answer") && low && !results.some(([c, o]) => c === "disclosures" && !o)) continue;
      lines.push(`note: ${redact(msg)}`);
    }
  }
  for (const n of notes) lines.push(`note: ${redact(n)}`);
  const verdict = "AUDIT " + (!fails.length ? "PASSED" : `FAILED (${fails.length} problems)`);
  lines.push(verdict);
  return { lines, verdict, passed: !fails.length };
}
