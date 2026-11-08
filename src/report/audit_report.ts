/**
 * Release gate for a report or paper (a port of report/audit_report.py). Run before handing anything to the user.
 * One gate for every source pack: the shared checks, plus each used source's policy (report.json "sources",
 * else the data/<id>/ folders). FAIL-level checks:
 *   facts        every fact traced to a CSV cell matches that cell exactly; derived facts state a derivation;
 *                a fact's source pack ("pack") is one of the sources used
 *   numbers      no number is typed into the prose by hand: each must be a {{fact}}, a year, or listed in
 *                report.json "audit_allow" with a reason
 *   exhibits     every exhibit CSV exists and has the columns its chart uses; every exhibit has a source line
 *                that names one of the sources used
 *   links        every relative link resolves and none points at data a source's terms keep local; with online
 *                every external link answers HTTP < 400
 *   html         report.html exists, is newer than its inputs, loads nothing external, starts with the AI
 *                disclaimer, and has no unresolved {{placeholders}} or raw [@cite] / [^n] markup
 *   vintage      provenance per source; the Data Vintage block; the methods state the vintage; preliminary,
 *                projected and past-vintage facts say so where they are cited
 *   policy       every notice of every used source is on the page; each source's audit hooks pass; a withheld
 *                key has a report.json "clearance" entry with its basis
 *   secrets      no API key or key-shaped value in any workspace file, including the members of the ZIP
 *   style        prose meets the style guide target (>= 90%)
 *   structure    report mode: the exhibit-chartbook parts are present
 *   questions ... benchmark   the method record (method_audit.ts)
 *   replication  replication_package.zip holds REPLICATION.md, facts.json, the exhibit data and their recipes
 *                (exhibits/lineage.json), per source its allowed data with provenance or (definition_only) its
 *                reproduce/<id>/ bundle, and nothing a source's terms forbid; with rerun, every exhibit recipe
 *                and table fact is replayed and must come out the same
 */
import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { guardedGet } from "../analysis/cite.js";
import { lineagePacks } from "../analysis/compute.js";
import { mode as serverMode } from "../core/env.js";
import { reportPathProblems } from "../core/guard.js";
import * as pol from "../core/policy.js";
import type { Policy } from "../core/policy.js";
import * as MA from "./method_audit.js";
import type { Result } from "./method_audit.js";
import * as PS from "./policyset.js";
import { echoSources, knownKeys, relHits, scanTree } from "./scan_secrets.js";
import * as SC from "./style_check.js";
import { csvGrid, fixed, fullmatch, readDict, readText, repr, rx, sorted, str, sub, toFloat, unescapeHtml } from "./py.js";

const FACT_RE = /\{\{[^}]*\}\}/g;
const NUM_RE = /(?<![\w.])[-−]?\$?\d[\d,]*(?:\.\d+)?%?/g;
const PROSE_KEYS = ["subtitle", "summary", "sections", "methods", "footnotes", "about", "highlights", "exhibits",
  "at_a_glance", "notes_page", "introduction", "appendixes", "cover", "assumptions"];
const MONTHS = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|` +
  String.raw`Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`;
const UA = "data-analyst-audit/1.0";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) data-analyst-audit";
export const CHECKS = ["facts", "numbers", "exhibits", "links", "html", "vintage", "policy", "secrets", "style", "structure",
  "questions", "literature", "disclosures", "references", "assumptions", "sensitivity", "data_needs", "benchmark", "replication"];

/** [where, text] for every human-readable string in the report (not data paths or charts). */
export function proseStrings(R: any): [string, string][] {
  const out: [string, string][] = [];
  const walk = (where: string, x: unknown): void => {
    if (typeof x === "string") out.push([where, x]);
    else if (Array.isArray(x)) x.forEach((v, i) => walk(`${where}[${i}]`, v));
    else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        if (["data", "chart", "path", "exhibits"].includes(k) && where.startsWith("sections")) continue;
        if (k === "exhibit" && where.startsWith("cover")) continue;
        if (["data", "chart", "path", "source", "rows"].includes(k)) continue;
        walk(`${where}.${k}`, v);
      }
    }
  };
  for (const k of PROSE_KEYS) if (k in R) walk(k, R[k]);
  if ("title" in R) out.push(["title", R.title]);
  return out;
}

/** URLs in text; balanced parentheses stay in ("...RA%20(GW).aspx"), a closing one after the URL does not. */
export function findUrls(s: string): string[] {
  return s.match(/https?:\/\/(?:[^\s"'<>()[\]\\]|\([^\s"'<>()]*\))+/g) || [];
}

// ---------------------------------------------------------------------- what is not a statistic
const ref = String.raw`\d+(?:\.\d+)*[A-Z]?`;
type Rule = [RegExp, string | ((m: RegExpExecArray) => string)];
const R_ = (src: string, repl: Rule[1] = " "): Rule => [rx(src), repl];
const EXEMPT: Rule[] = [
  R_(String.raw`\[\^\d+\]`),                                                  // footnote markers
  R_(String.raw`\]\([^)]*\)|https?://\S+`),                                   // link targets
  // "Tables 1.1.1, 1.1.2 and 2.6" / "Exhibits 2, 3, and 4" are lists; "Exhibit 2, 45 percent" is a reference
  R_(String.raw`\b(?:Exhibits|Figures|Tables|Appendixes|Boxes|Chapters|Lines|Sections)\s+${ref}` +
    String.raw`(?:\s*(?:,?\s*(?:and|to)|[–,/-])\s*${ref})*\b`),
  R_(String.raw`\bTables?\s+\d+(?:\.\d+)+[A-Z]?\b`),                          // NIPA tables such as Table 1.1.6
  R_(String.raw`(?i)\b\d{1,2}\s?(?:Yr|Mo|Wk)s?\b`),                           // maturity labels: 10 Yr, 3 Mo
  R_(String.raw`(?i)\b(?:Exhibit|Figure|Table|Appendix|Box|Chapter|Part|Title|Volume|Vol\.|Note|FAQ)\s+\d+[a-z]?` +
    String.raw`(?:\s*(?:[–-]|to)\s*\d+[a-z]?)?\b`),
  R_(String.raw`\b(?:Executive [Oo]rders?|EOs?|E\.\s?O\.|Proclamations?|Public Land Orders?)\s+(?:No\.\s*)?` +
    String.raw`\d{3,6}(?:\s*(?:[–-]|to|through|,?\s*and|,?\s*or|,)\s*\d{3,6})*\b`),     // EO 14296
  // survey variable codes: RELATE 1, OWNERSHP in (1, 2), GQ = 2 (two-letter names need the operator); REPWT1-80
  R_(String.raw`\b[A-Z]{2,}\d+\s*[-–]\s*\d+\b`),
  R_(String.raw`\b(?:(?!(?:USA|GDP|GNP|CPI|PCE|PPI|ECI|EITC|ACS|CPS|BLS|BEA|OPM|FRED)\b)[A-Z][A-Z0-9_]{2,15}` +
    String.raw`(?:\s*==?\s*|\s+(?:in|is)\s+|\s+)|[A-Z]{2}(?:\s*==?\s*|\s+in\s+))\(?\d{1,3}(?:\s*(?:,|,?\s+(?:or|and))\s+\d{1,3})*\)?` +
    String.raw`(?![\d%/]|\.\d|[,–-]\d|\s*(?:%|percent|points?|million|billion|thousand))`),
  R_(String.raw`(?i)\b(?:versions?|vintages?|editions?|waves?|releases?)\s+\d+(?:\s*(?:,|,?\s*(?:and|or))\s*\d+)*\b` +
    String.raw`(?!\s*(?:%|percent))`),                                        // version 1; file versions 4, 4 and 3
  R_(String.raw`(?i)\bcongress(?:es)?\s*(?:=\s*)?\d{2,3}\b(?!\s*(?:%|percent))`),     // congress 118
  R_(String.raw`(?i)\b(?:foot)?notes?\s+\d+[a-z]?(?:\s*(?:,|and|to|–|-)\s*\d+[a-z]?)*\b`),   // footnote 5
  R_(String.raw`(?i)(?:=|equals?)\s*100\b(?!\s*(?:%|percent))`),             // an index base: (U.S. = 100), 2017=100
  // a confidence level is a convention, not a statistic: "90 percent margin of error", "significant at 90%"
  R_(String.raw`(?i)\b(?:90|95|99)\s*(?:%|percent)(?=\s+(?:confidence|margins?|level|MOE|CI)\b)|` +
    String.raw`\b(?:significant|confidence)\s+(?:at|level\s+of)\s+(?:the\s+)?(?:90|95|99)\s*(?:%|percent)`),
  R_(String.raw`(?i)\bin\s+sample\s+\d+(?:\s*(?:,|and|or)\s*\d+)*`),         // CPS months in sample 4 and 8
  R_(String.raw`(?i)\b(?:IPUMS\s+\w+\s+)?extract\s+(?:no\.\s*|number\s+|#)?\d+\b`),   // IPUMS extract 30
  // ages define a universe: "aged 16", "ages 25 to 64", "65 and older", "children under 15 who"
  R_(String.raw`(?i)\b(?:aged?|ages)\s+\d{1,3}(?:\s*(?:to|through|[–-]|and)\s*\d{1,3})?\b(?!\s*(?:%|percent|\.\d))`),
  R_(String.raw`(?i)\b\d{1,3}\s+(?:years?\s+)?(?:(?:and|or)\s+(?:over|older|up|above)|or\s+more\b(?=\s*(?:years|[,.;)]|$)))`),
  R_(String.raw`(?i)\b(?:age[sd]?\s+|adults\s+|people\s+|workers\s+)\d{1,3}\+`),       // "adults 25+"
  R_(String.raw`(?i)\b(?:ch|chap|sec|art|para|pt|vol|no|pp?)\.\s*\d+(?:\.\d+)*(?:\s*[–-]\s*\d+)?\b`),
  R_(String.raw`(?i)\bpages?\s+\d+(?:\s*(?:[–-]|to|and)\s*\d+)?(?!\s*(?:%|percent))\b`),  // page 9
  R_(String.raw`\b[A-Z]{2,6}-\d{2}-[0-9A-Z]{1,8}\b`),                         // GAO-26-900644, USDL-26-0229
  R_(String.raw`(?<![\d.])(?:1\.645|1\.96|2\.576)(?![\d])`),                  // z critical values
  R_(String.raw`(?i)\b(?:under|younger than|older than)\s+(?:age\s+)?\d{1,2}(?=\s+(?:years?\b|year-olds?\b|who\b|in\b|and\b|or\b)|\s*[(),;:]` +
    String.raw`|\s*\.(?!\d)|\s*$)`),
  R_(String.raw`(?i)\b(?:at|those|workers|people|persons|adults|men|women|group)\s+\d{1,2}\s*(?:to|through|[–-])\s*\d{2}\b` +
    String.raw`(?!\s*(?:%|percent|\.\d))|\b\d{2}-to-\d{2}\b`),                // "5.7 percent at 25 to 64"
  // "youngest child is 6 to 17", "a child under 18", "children aged 6-17": the group's ages
  R_(String.raw`(?i)\b(?:child|children|kids?|son|daughter)\s+(?:is\s+|are\s+|was\s+|aged?\s+)?` +
    String.raw`(?:(?:under|over|younger than|older than)\s+)?\d{1,2}(?:\s*(?:to|through|[–-])\s*\d{1,2})?\b` +
    String.raw`(?!\s*(?:%|percent|\.\d))`),
  R_(String.raw`(?i)\b(?:employees|workers|people|persons|adults|children|staff|residents|individuals|those)\s+` +
    String.raw`(?:under|over|younger than|older than)\s+(?:age\s+)?\d{1,2}\b(?!\s*(?:%|percent|\.\d))`),
  R_(String.raw`(?i)\b(?:Parts|Titles|Volumes|Vols\.)\s+\d+(?:\s*(?:[–-]|to|through|,?\s*and|,?\s*or|,)\s*\d+)*\b`),
  // statute and regulation citations: 2 U.S.C. 653, 42 USC § 1983, 40 CFR 60.5, 138 Stat. 2687, 89 FR 12345
  R_(String.raw`\b\d+\s+(?:U\.?\s?S\.?\s?C\.?(?:A\.?)?|C\.?\s?F\.?\s?R\.?|Stat\.|F\.?\s?R\.?|Fed\.\s?Reg\.)\s*` +
    String.raw`(?:§+\s*|part\s+|pt\.\s*)?\d[\w.\-()]*(?:\s*(?:,|,?\s*(?:and|or|through|to))\s*\d[\w.\-()]*(?!\w)` +
    String.raw`(?!\s*(?:U\.?\s?S\.?\s?C|C\.?\s?F\.?\s?R|Stat\.|F\.?\s?R\b|Fed\.|%|percent|points?|million|billion|` +
    String.raw`thousand|(?!(?:and|or|through|to)\b)[a-z]{3,})))*`),
  R_(String.raw`\b\d{1,4}(?:\([a-zA-Z0-9]{1,4}\))+`),                        // provisions: INA 236(c), 241(a)(2)
  R_(String.raw`(?i)\b(?:status\s+|error\s+)?codes?\s+\d[\d\-.]*(?:\s*\([^)\n]{0,60}\))?` +
    String.raw`(?:\s*(?:,|and|or)\s*\d[\d\-.]*(?:\s*\([^)\n]{0,60}\))?)*`),   // code 2 (...), 4 (...) or 5
  R_(String.raw`(?i)\b(?:issues?|volume)\s+(?:no\.\s*)?\d+(?:\s*(?:[–-]|to|through|and)\s*\d+)?\b` +
    String.raw`(?!\s*(?:%|percent))`),                                        // volume 171, issues 204 to 206
  R_(String.raw`(?i)\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\s*(?:[–-]|to|through|` +
    String.raw`and)\s*\d{1,2}(?=,?\s+\d{4}\b)`),                              // February 12 to 13, 2024
  R_(String.raw`(?i)\b(?:returns?|returned|gives?|gave|got|answers?|answered)\s+(?:an?\s+)?(?:http\s+)?(?:status\s+)?` +
    String.raw`(?:200|301|302|400|401|403|404|406|410|429|500|502|503|504)\b(?!\s*(?:%|percent|rows?|records?))`),
  R_(String.raw`(?i)\b(?:roll(?:\s+calls?)?(?:\s+votes?)?|votes?)\s+(?:nos?\.?\s*)?\d+(?:\s*(?:,|and|or|&)\s*\d+)+\b`),
  R_(String.raw`(?i)\b(?:line|section|sec\.|§|session|roll(?: call)?(?: vote)?|vote|no\.|http(?: error)?|error code|` +
    String.raw`status code|function)\s*\d[\d.\-/]*`),                         // line 32, roll 404, HTTP 403, session 2
  R_(String.raw`(?i)\b(?:roll(?:\s+calls?)?(?:\s+votes?)?|votes?|lines|sections)\s+(?:nos?\.?\s*)?\d+\s*(?:to|through|[–-])\s*` +
    String.raw`\d+\b(?!\s*(?:%|percent))`),                                   // "votes 1 to 659"
  // bill and law numbers, ranges too (H.R. 1-10,564); a lone "S" needs its period and no letter or dot before it
  R_(String.raw`(?<![\w.'’])(?:H\.\s?R\.?|HR|S\.|H\.\s?J\.\s?Res\.?|S\.\s?J\.\s?Res\.?|H\.\s?Con\.\s?Res\.?|` +
    String.raw`S\.\s?Con\.\s?Res\.?|H\.\s?Res\.?|S\.\s?Res\.?|P\.\s?L\.?|PL|Pub\.\s?L\.?|Public Law|Private Law|S\.\s?Amdt\.?|H\.\s?Amdt\.?|S\.\s?Up\.\s?Amdt\.?|SA|` +
    String.raw`H\.\s?Rept\.?|S\.\s?Rept\.?)\s*\d[\d,]*(?:\s*[–-]\s*\d[\d,]*)?` +
    String.raw`(?:(?:,\s*|,?\s+(?:and|or)\s+|(?<=,)\s+)\d[\d,]*(?:[–-]\d+)?(?![\d.])` +
    String.raw`(?!\s*(?:%|percent|other|more|bills?|laws?|votes?|members?|senators?|times)\b))*`),
  R_(String.raw`(?i)\bFIPS\s*\d+|\(\d{5}\)`),                                 // geography codes: FIPS 24031, (24510)
  R_(String.raw`\b[A-Z]{1,2}\s?\d+\.[A-Z][A-Za-z]{0,4}\s?\d+(?:/\d+)?(?::[\w./-]*)?`),   // SuDoc: Y 4.J 89/2:
  R_(String.raw`(?i)\b9/11\b|\bpost-9/11\b`),
  R_(String.raw`\b\d{4}(?:[-–]\d{2,4})?\s*=\s*100\b`),                        // index bases: 1982-84=100, 2017=100
  R_(String.raw`\b\d{4}-\d{2}(?:-\d{2})?\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b`),     // ISO and m/d/y dates
  R_(String.raw`(?i)(?<!from )(?<!rose )(?<!fell )\b(?:about|roughly|approximately|between|some|around)?\s*` +
    String.raw`\d+(?:\.\d+)?\s+to\s+\d+(?:\.\d+)?(?=\s*(?:%|percent)\s+(?:range|of\s+(?:the|all|total)|target|` +
    String.raw`guidance|recommended|band))`),                                 // a guideline range: 15 to 20 percent range
  R_(String.raw`(?i)\b(?:about|roughly|approximately|between)\s+\d+(?:\.\d+)?\s+(?:to|and)\s+\d+(?:\.\d+)?` +
    String.raw`(?=\s*(?:%|percent)?)`),                                       // an approximate range: about 45 to 48
  R_(String.raw`\b(?:17|18|19|20)\d\d\s*–\s*\d{2,4}\b`),                      // year ranges with a dash: 1982–84
  R_(String.raw`(?i)(\d\.\d+)-(day|week|month|quarter|year)s?\b`, (m) => `${m[1]} ${m[2]}`),   // a 1.6-year rise
  R_(String.raw`(?i)(?<![\d.])\b(?:1|2|3|4|5|6|7|8|9|10|12|13|14|15|17|18|20|21|24|25|26|28|30|31|36|40|45|` +
    String.raw`50|52|60|75|90|100|120|180|270|360|365)-(?:day|week|month|quarter|year)s?\b`),
  // standard terms and windows (4-week bill, 10-year note, 30-day average); "43-day shutdown" is a statistic
  R_(String.raw`(?i)\b(?:1|3|6|12|24|36)[ -]months?\b(?!\s+(?:earlier|later|before|after|ahead|ago|lag|` +
    String.raw`lead|behind)\b)`),
  R_(String.raw`\bU-[1-6]\b|\b\d{4}(?:-\d{2,4})?\s*=\s*100\b|\b[MQS]\d{2}\b|\bQ[1-4]\b`),
  R_(String.raw`\b(?:19|20)\d\d\s?[QM]\d{1,2}\b`),                            // periods such as 2026Q2 or 2026M09
  R_(String.raw`\b[A-Za-z]+-\d+\b`),                                          // names with a number: COVID-19, H-1
  R_(String.raw`\b\d{1,2}\s+` + MONTHS + String.raw`\b`),                     // "30 September 2026"
  // "March 31, 2026", "October 1-3", "January 17 and 21, 2025"; a comma list of days is dates only when it closes
  // with "and 20" or a year ("On March 3, 12 states" is not)
  R_(MONTHS + String.raw`\.?\s+\d{1,2}(?:\s*,\s*\d{1,2}\b)+(?:\s*,?\s*(?:and|or|&)\s*\d{1,2}\b(?:,?\s+\d{4}\b)?|` +
    String.raw`,?\s+\d{4}\b)`),
  R_(MONTHS + String.raw`\.?\s+\d{1,2}(?:\s*(?:[–-]|and|&|or)\s*\d{1,2}\b(?!\.\d))*\b,?`),
  // FY2024-25, FY2020 to FY2026, fiscal years 2024 and 2025; "FY2024 and 146,482" keeps its number
  R_(String.raw`(?i)\b(?:fiscal years?|FY)\s*\d{2,4}(?:\s*[–-]\s*(?:FY\s?)?(?:(?:19|20)\d\d|\d\d)\b(?![,.]\d)` +
    String.raw`|\s*(?:to|and|through)\s*(?:FY\s?)?(?:19|20)\d\d\b(?![,.]\d))?`),
  R_(String.raw`\b(?:FY|Q)\s?\d{1,4}\b`),                                     // FY2025, FY 2025, Q4
  R_(String.raw`(?m)^\s*\d{1,2}[.)]\s`),                                      // list markers "1. " "2) "
  R_(String.raw`(?im)^(\s*\|\s*(?:\*\*)?(?:total|all)\b.*)$`,                 // a share table's total row: 100 percent
    (m) => sub(/\b100(?:\.0+)?\s*(?:%|percent)/, " ", m[1])),
  // a table's first column is its labels ("35 to 44", "Under 35", "2019 Q1"), when the row has more cells
  R_(String.raw`(?m)^(\s*\|)([^|\n]*)(?=\|[^\n]*\|)`, (m) => m[1] + m[2].replace(/\d/g, " ")),
  R_(String.raw`(?m)^\s*\|\s*\d+\s*(?:\(tie\)|=)?\s*\|`, "| |"),              // a rank or code in the first column
  R_(String.raw`(?<![\d.,])0\d+\b(?![.,]\d)`),                                // zero-padded codes: 0301, 06037
  R_(String.raw`(?i)\b(?:series|codes?|occupation|naics|soc|cip|sic|psc|nigp)\s+\(?\d{3,}[\d\-.]*\)?(?!\s*(?:%|percent))` +
    String.raw`|\b(?:series|codes?|occupation|naics|soc|cip|sic|psc|nigp)\s+\d[\d\-.]*` +
    String.raw`(?:\s*\([^)\n]{0,60}\))?(?:\s*(?:,|and|or)\s*\d[\d\-.]*(?:\s*\([^)\n]{0,60}\))?)*`),
  R_(String.raw`(?i)\b(?:90|95|99)\s*(?:%|percent)(?=[\s-]*(?:confidence|margin|moe|ci\b|interval|level|signific))`),
  R_(String.raw`\b\d+(?:st|nd|rd|th)\b`),                                     // ordinals: 118th Congress
];
const CODE_STAT = rx(String.raw`\s*[-−]?\$?[\d,.]+\s*(?:%|percent|percentage points?|pp|million|billion|trillion)?\s*`);

/** The text with what is not a statistic blanked out: {{facts}}, code, links, footnote marks, table and exhibit
 * references, bill and law numbers, roll calls and line numbers, dates in any common form, periods and terms such
 * as 10-year note or U-6. Shared by the report audit and the quick-answer audit. */
export function exempt(text: string): string {
  let t = text.replace(FACT_RE, " ");
  // a bare integer in backticks is a code (`0301`, `25`); a number with a unit, decimals or commas is checked
  t = sub(/`([^`]*)`/, (m) => (fullmatch(CODE_STAT, m[1]) && !/^\s*\d+\s*$/.test(m[1]) ? m[0].replace(/^`+|`+$/g, "") : " "), t);
  for (const [re, repl] of EXEMPT) t = sub(re, repl, t);
  return t;
}

/** Numbers typed by hand (exempted: years, references, dates, periods). */
export function hardNumbers(text: string, allow: Set<string>): string[] {
  const t = exempt(text);
  const bad: string[] = [];
  for (const m of t.matchAll(NUM_RE)) {
    const tok = m[0];
    const core = tok.replace(/\$/g, "").replace(/%/g, "").replace(/,/g, "").replace(/−/g, "-").replace(/^-+/, "");
    const v = toFloat(core);
    if (v === null) continue;
    if (tok.replace(/,+$/, "") === core && /^\d+$/.test(core) && core.length === 4 && v >= 1900 && v <= 2100) continue;
    if (allow.has(tok) || allow.has(core)) continue;
    bad.push(tok);
  }
  return bad;
}

export const notes: string[] = MA.NOTES;

/** Missing or malformed parts of the exhibit-chartbook layout (report mode). */
export function structureProblems(R: any): string[] {
  const out: string[] = [];
  const g = R.at_a_glance || {};
  const findings = (g.findings && g.findings.length ? g.findings : R.summary) || [];
  if (!g.text) out.push("at_a_glance.text: add the framing paragraph (what was examined, population or measures, period)");
  if (!(findings.length >= 3 && findings.length <= 5)) out.push(`At a Glance has ${findings.length} findings; a chartbook uses 3 to 5`);
  if (findings.some((f: any) => !(f && typeof f === "object" && f.lead))) {
    out.push("each At a Glance finding needs a bold 'lead' naming its section, e.g. 'Unemployment.'");
  }
  if (!R.notes_page || (Array.isArray(R.notes_page) && !R.notes_page.length)) {
    out.push("notes_page missing: calendar or fiscal years, rounding, seasonal adjustment, dollar year and deflator, data " +
      "sources, retrieval dates and vintages, definitions");
  }
  const intro = R.introduction || {};
  if (!intro.text) out.push("introduction.text missing: a lead paragraph with the headline numbers");
  if (!intro.subsections || !intro.subsections.length) {
    out.push("introduction.subsections missing: one question-style heading per section, plus the data used");
  }
  const secs = R.sections || [];
  if (secs.length < 2) out.push(`${secs.length} section(s); a chartbook has 2 to 5 thematic sections`);
  secs.forEach((s: any, k: number) => {
    if (!s.exhibits || !s.exhibits.length) out.push(`section ${k + 1} (${repr(s.heading ?? null)}) shows no exhibit`);
  });
  (R.exhibits || []).forEach((e: any, i: number) => {
    if (!String(e.text ?? "").trim()) out.push(`exhibit ${i + 1}: add 'text', the 2 to 4 paragraphs shown beside the chart`);
    if (!/(?:19|20)\d\d(?:\s*Q[1-4])?\s*$/.test(String(e.title ?? ""))) {
      MA.note(`exhibit ${i + 1} title should end with its period, e.g. ', 2013 to 2023' or ', 2019 Q1 to 2026 Q2'`);
    }
  });
  if (!R.about) out.push("about missing: About This Document (who asked, who prepared it, with what data and tools, date)");
  return out;
}

export function* allStrings(x: unknown): Generator<string> {
  if (typeof x === "string") yield x;
  else if (Array.isArray(x)) for (const v of x) yield* allStrings(v);
  else if (x && typeof x === "object") for (const v of Object.values(x)) yield* allStrings(v);
}

/** [ok, message] for one external link (HTTP < 400; 403 and time-outs to scripts are accepted with a note). */
export async function checkUrl(u: string): Promise<[boolean, string]> {
  let status: number | null = null, err: any = null;
  const codes: number[] = [];
  if (serverMode() === "remote") {
    // every hop through the guarded lookup: a redirect or a DNS change cannot reach a private address
    try {
      const r = await guardedGet(u, 20);
      if (r.status < 400) return [true, `${u}: HTTP ${r.status}`];
      status = r.status;
      codes.push(r.status);
    } catch (e: any) {
      if (/^refused/.test(String(e?.message))) return [false, `${u}: ${e.message}`];
      err = e;
    }
  }
  for (const ua of serverMode() === "remote" ? [] : [UA, BROWSER_UA]) {  // some hosts refuse a browser-like agent, others anything else
    status = null;
    try {
      const r = await fetch(u, { method: "GET", headers: { "User-Agent": ua }, signal: AbortSignal.timeout(20000), redirect: "follow" });
      status = r.status;
      try {
        await r.body?.cancel();
      } catch {
        // ignore
      }
      if (status < 400) return [true, `${u}: HTTP ${status}`];
    } catch (e) {
      err = e;
    }
    if (status !== null) codes.push(status);
  }
  const real = codes.find((c) => ![401, 403, 429].includes(c) && c >= 400);   // a real answer beats a timeout
  if (real !== undefined) return [false, `${u}: HTTP ${real}`];
  const text = err ? `${err.name || ""} ${err.message || ""} ${err.cause?.code || ""} ${err.cause?.message || ""}` : "";
  const timedOut = status === null && /timed? ?out|timeout|aborted/i.test(text);
  const dropped = status === null && /reset|10054|remote end closed|remotedisconnected|eof occurred|socket hang up|other side closed/i.test(text);
  const n = status === 403 ? "HTTP 403 to scripts" : timedOut ? "timed out for scripts"
    : dropped ? "connection dropped for scripts (throttling)" : null;
  return [!!n, `${u}: ${n ? n + "; open it in a browser to confirm" : err ? (err.cause?.message || err.message || String(err)) : status}`];
}

export function namesSource(text: string, policies: Record<string, Policy>): boolean {
  const t = text.toLowerCase();
  for (const [sid, P] of Object.entries(policies)) {
    const cands = [P.agency || "", P.title || "", ...(P.aliases || [])];
    if (cands.some((c) => c && t.includes(c.toLowerCase()))) return true;
    if (new RegExp(`(?<![a-z0-9])${sid.toLowerCase().replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![a-z0-9])`).test(t)) return true;
    const short = (P.title || "").replace(/\s*\(.*?\)/g, "").trim().toLowerCase();
    if (short && t.includes(short)) return true;
  }
  return false;
}

/** Python's text-mode read: universal newlines. */
export function readTextFile(p: string): string {
  return readText(p).replace(/\r\n?/g, "\n");
}

function readJson(p: string): any {
  try {
    return JSON.parse(readText(p));
  } catch (e) {
    // JSON.parse quotes the start of the text: name the file only
    if (e instanceof SyntaxError) throw new Error(`${path.basename(p)} is not valid JSON`);
    throw e;
  }
}

const mtime = (p: string) => fs.statSync(p).mtimeMs;

export async function audit(reportPath: string, htmlPath?: string, online = false, rerunIt = false): Promise<Result[]> {
  const base = path.dirname(path.resolve(reportPath));
  const R = MA.merged(base, readJson(reportPath));
  const mode = R.mode || "report";
  htmlPath = htmlPath || path.join(base, "report.html");
  const results: Result[] = [];
  const res = (check: string, ok: unknown, msg: string) => void results.push([check, !!ok, msg]);
  const outside = reportPathProblems(base, R);
  if (outside.length) {
    res("paths", false, `report.json names files outside the workspace or where keys are kept: ${JSON.stringify(outside)} ` +
      "(every path is relative to the report's folder)");
    return results;
  }

  // ---- sources and their policies
  const ids = PS.usedSources(base, R);
  let policies: Record<string, Policy> = {};
  try {
    policies = PS.loadPolicies(ids);
  } catch (e) {
    if (!(e instanceof PS.SourceError)) throw e;
    res("policy", false, e.message);
  }
  if (!ids.length) res("policy", false, 'no source used: list report.json "sources" or fetch into data/<id>/');
  const page = fs.existsSync(htmlPath) ? readTextFile(htmlPath) : "";
  const pageText = unescapeHtml(page.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

  // ---- facts
  const fpath = path.join(base, R.facts || "facts.json");
  const facts: Record<string, any> = fs.existsSync(fpath) ? readJson(fpath) : {};
  const cited = new Set([...JSON.stringify(R).matchAll(/\{\{\s*([A-Za-z_]\w*)/g)].map((m) => m[1]));
  if (cited.size && !Object.keys(facts).length) res("facts", false, `report cites ${cited.size} facts but ${path.relative(base, fpath)} is missing`);
  for (const name of sorted(cited)) {
    const f = facts[name];
    if (f === undefined || f === null) {
      res("facts", false, `{{${name}}} is cited but not registered in facts.json`);
      continue;
    }
    const pk = f.pack;
    const pks: string[] = typeof pk === "string" ? [pk] : Array.isArray(pk) ? pk : [];
    const unknown = pks.filter((p) => !(p in policies));
    if (unknown.length && Object.keys(policies).length) {
      res("facts", false, `${name}: source pack ${repr(unknown)} is not one of the sources used (${repr(ids)})`);
    }
    res("facts", ...MA.checkFact(name, f, base));
  }
  if (!cited.size) res("facts", false, "the prose cites no {{facts}}; every number in the text must come from facts.json");

  // ---- hand-typed numbers
  const allow = new Set<string>((R.audit_allow || []).map((x: any) => (x && typeof x === "object" ? str(x.value) : str(x))));
  const found = new Map<string, string[]>();
  for (const [where, text] of proseStrings(R)) {
    for (const tok of hardNumbers(text, allow)) found.set(tok, [...(found.get(tok) || []), where]);
  }
  for (const tok of sorted(found.keys())) {
    res("numbers", false, `hand-typed number '${tok}' in ${sorted(new Set(found.get(tok)!)).join(", ").slice(0, 120)} ` +
      "-> make it a {{fact}} or add it to audit_allow with a reason");
  }
  if (!found.size) res("numbers", true, "every number in the prose is a registered fact, a year, or allowed");

  // ---- exhibits
  (R.exhibits || []).forEach((e: any, j: number) => {
    const i = j + 1;
    if (!e.source) res("exhibits", false, `exhibit ${i}: no source line`);
    else if (Object.keys(policies).length && !namesSource(e.source, policies)) {
      res("exhibits", false, `exhibit ${i}: the source line names none of the sources used ` +
        `(${Object.values(policies).map((P) => P.agency).join(", ")})`);
    }
    if (!("data" in e)) return;
    const p = path.join(base, e.data);
    if (!fs.existsSync(p)) {
      res("exhibits", false, `exhibit ${i}: ${e.data} missing`);
      return;
    }
    const cols = new Set(csvGrid(readText(p))[0] || []);
    const c = e.chart || {};
    const need = [c.x, c.series, ...(Array.isArray(c.y) ? c.y : [c.y]), ...Object.keys(c.filter || {}), ...(c.columns || [])];
    const miss = need.filter((n) => n && !cols.has(n));
    res("exhibits", !miss.length, miss.length ? `exhibit ${i}: missing columns ${repr(miss)}` : `exhibit ${i}: ok`);
  });
  const linPath = path.join(base, "exhibits", "lineage.json");
  if (fs.existsSync(linPath) && Object.keys(policies).length) {
    const lin = readJson(linPath);
    for (const [ex, v] of Object.entries<any>(lin && typeof lin === "object" ? lin : {})) {
      const pks = lineagePacks(v);
      const bad = pks.filter((p) => !(String(p) in policies));
      if (bad.length) res("exhibits", false, `${ex}: lineage names ${repr(bad)}, which are not sources of this report`);
    }
  }

  // ---- links
  const withheld: Record<string, Set<string>> = {};
  for (const [sid, P] of Object.entries(policies)) withheld[sid] = PS.withheldKeys(base, sid, P, R);
  for (const d of R.data_files || []) {
    const ok = fs.existsSync(path.join(base, d.path));
    res("links", ok, `${d.path}: ${ok ? "exists" : "MISSING"}`);
    const dd = PS.decide(d.path, base, policies, R, withheld);
    if (!dd.ok && dd.policy) res("links", false, `${d.path}: linked, but ${dd.reason}`);
  }
  if (page) {
    const hrefs = [...page.matchAll(/href=['"]([^'"#]+)['"]/g)].map((m) => m[1]);
    const local = sorted(new Set(hrefs.filter((h) => !/^[a-z]+:/.test(h))));
    const outDir = path.dirname(path.resolve(htmlPath));
    for (const h of local) {
      const relp = path.relative(base, path.join(outDir, h)).replaceAll("\\", "/");
      const dd = PS.decide(relp, base, policies, R, withheld);
      if (!dd.ok && dd.policy) res("links", false, `report.html links ${relp}: ${dd.reason}`);
      else if (!fs.existsSync(path.join(outDir, h))) res("links", false, `report.html links ${h}, which does not exist`);
    }
  }
  const urls = sorted(new Set([...allStrings(R)].flatMap(findUrls).map((u) => u.replace(/[.,;:]+$/, ""))));
  for (const u of urls) {
    if (!online) res("links", true, `${u}: not requested (use online: true to verify)`);
    else res("links", ...(await checkUrl(u)));
  }

  // ---- html
  if (!page) res("html", false, `${path.relative(base, htmlPath)} does not exist; call build_report`);
  else {
    const dpath = path.join(base, "decisions.json");
    const newest = Math.max(mtime(reportPath), ...[fpath, dpath].filter((p) => fs.existsSync(p)).map(mtime),
      ...(R.exhibits || []).filter((e: any) => e.data && fs.existsSync(path.join(base, e.data))).map((e: any) => mtime(path.join(base, e.data))));
    const up = mtime(htmlPath) >= newest;
    res("html", up, up ? "report.html is up to date" : "report.html is older than its inputs; rebuild it");
    const ext = page.match(/(?:\bsrc\s*=\s*["']|<link[^>]+href\s*=\s*["']|@import\s+|url\(\s*["']?)(?:https?:)?\/\//gi) || [];
    res("html", !ext.length, !ext.length ? "no external resources" : `${ext.length} external resource loads`);
    const first = page.indexOf('class="disclaimer"');
    res("html", first !== -1 && first < page.indexOf('class="masthead'), "AI disclaimer at top of page");
    const visible = page.replace(/<blockquote>[\s\S]*?<\/blockquote>|<pre\b[\s\S]*?<\/pre>|<script\b[\s\S]*?<\/script>/g, "");
    const k = visible.indexOf("{{");
    res("html", k === -1, k === -1 ? "no unresolved {{placeholders}}"
      : `unresolved placeholder near: ${repr(visible.slice(Math.max(0, k - 60), k + 40))}`);
    const left = visible.match(/\[@[^\]]*\]|\[\^\d+\]/g) || [];
    res("html", !left.length, !left.length ? "no raw citation or footnote markup"
      : `raw markup left in the page: ${repr(sorted(new Set(left)).slice(0, 5))}; use [@id] or [@a; @b] and [^n] with matching entries`);
  }

  // ---- vintage
  let anyVintage = false;
  for (const sid of Object.keys(policies)) {
    const [rel, P] = PS.provenance(base, sid, R);
    res("vintage", !!rel, rel ? `${sid}: provenance ${rel}` : `${sid}: no provenance file in data/${sid}/ (request.json): the ` +
      `retrieval date cannot be stated; fetch with the fetch tool (source ${sid})`);
    anyVintage = anyVintage || Object.keys(PS.vintageFields(P)).length > 0;
  }
  if (page && Object.keys(policies).length) {
    res("vintage", page.includes("Data Vintage"), page.includes("Data Vintage") ? "Data Vintage block present"
      : "report.html lacks the Data Vintage block; rebuild with build_report");
  }
  if (anyVintage) {
    const methods = JSON.stringify(R.methods ?? "") + JSON.stringify(R.notes_page ?? "");
    const ok = /vintage|released|release of|as of|revis/i.test(methods);
    res("vintage", ok, ok ? "methods state the vintage and revisions" : "a source records vintage information: the methods " +
      "or notes page must say which release (vintage) the data come from and that the source revises them");
  }
  const prose = new Map<string, string>();
  for (const [w, s] of proseStrings(R)) {        // a tile, finding or exhibit is one unit: its parts are read together
    const unit = w.replace(/\.(?:label|value|note|lead|text|title|subtitle|notes)$/, "");
    prose.set(unit, ((prose.get(unit) || "") + " " + s).trim());
  }
  const labels: Record<string, [RegExp, string]> = {
    preliminary: [/preliminar|subject to revision|advance estimate|revis/i, 'say so ("preliminary", "advance estimate", "subject to revision")'],
    projection: [/project|forecast|estimate[sd]? for|expect/i, 'say it is a projection ("projected", "the agency projects")'],
    vintage: [/as (?:first )?(?:reported|published|estimated)|first (?:release|estimate|reported)|initial(?:ly)?|vintage|real[- ]time|at the time|originally/i,
      'say which vintage ("as first reported", "as published in July 2020")'] };
  for (const name of sorted(cited)) {
    const f = facts[name] || {};
    const hits = [...prose.values()].filter((s) => new RegExp(String.raw`\{\{\s*` + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + String.raw`\b`).test(s));
    for (const [flag, [pat, fix]] of Object.entries(labels)) {
      if (f[flag]) {
        const ok = hits.every((s) => pat.test(s));
        res("vintage", ok, ok ? `${name}: ${flag} value is labeled as such` : `${name} is a ${flag} value: ${fix} where it is cited`);
      }
    }
  }

  // ---- policy: notices, audit hooks, clearances
  for (const n of pol.notices(Object.values(policies))) {
    const norm = n.replace(/\s+/g, " ").trim();
    const ok = pageText.includes(norm);
    res("policy", ok, ok ? `notice present: ${norm.slice(0, 60)}` : `required notice missing from report.html: ` +
      `${repr(norm.slice(0, 100))}; rebuild with build_report`);
  }
  for (const [sid, P] of Object.entries(policies)) {
    for (const [status, hid, msg] of PS.runAuditHooks(P, base, R, facts, pageText)) res("policy", status === "PASS", `${sid} hook ${hid}: ${msg}`);
    const [w, rows] = PS.withholdRows(base, sid, P);
    if (w) {
      const clear = PS.clearances(R);
      const byKey = new Map(rows.map((x) => [String(x[w.key || ""] ?? ""), x]));
      for (const r of byKey.values()) {
        const k = String(r[w.key || ""] ?? "");
        const c = PS.clearanceFor(clear, sid, k);
        const ok = !!(c && String(c.basis ?? "").trim());
        res("policy", ok, ok ? `${sid} ${k}: ${str(r[w.column] ?? null)}, cleared (${str(c.basis)})` : `${sid} ${k}: ${w.column} ` +
          `${str(r[w.column] ?? null)}; read the terms for it or ask the user, then add report.json "clearance": {"source", ` +
          '"key", "basis", "redistribute": true|false}');
      }
    }
  }

  // ---- secrets
  const hits = relHits(scanTree([base], knownKeys(), echoSources(policies).length > 0)[0], base);
  res("secrets", !hits.length, !hits.length ? "no API key or credential in any output file" : hits.slice(0, 10).join("; "));

  // ---- style
  const sc = SC.score(JSON.parse(JSON.stringify(R).replace(FACT_RE, "X")))[0];
  res("style", sc >= SC.TARGET, `style guide ${fixed(sc, 0)}% (target ${SC.TARGET}%); call style_check for details`);

  // ---- structure (report mode: exhibit chartbook)
  if (mode === "report") {
    for (const problem of structureProblems(R)) res("structure", false, problem);
    res("structure", true, "chartbook parts checked");
  }

  // ---- method record: questions, literature, references, assumptions; benchmarks
  results.push(...MA.checkMethod(R, base, facts), ...MA.checkBenchmark(base, facts));
  const norm = (s: unknown) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
  for (const [k] of MA.escapes(R)) {            // each unverifiable claim must reach the reader
    const text = (R.disclosures || {})[k];
    if (text) {
      const shown = norm(pageText).includes(norm(text));
      res("disclosures", shown, shown ? `${k}: disclosure shown on the page` : `${k}: the disclosure ${repr(text)} is not on ` +
        "the page: rebuild (the builder prints it in Appendix A)");
    }
  }

  // ---- replication package
  const zp = path.join(base, "replication_package.zip");
  if (!fs.existsSync(zp)) res("replication", false, "replication_package.zip missing; call build_report");
  else {
    let z: Record<string, Uint8Array> = {};
    try {
      z = unzipSync(fs.readFileSync(zp));
    } catch {
      res("replication", false, "replication_package.zip is not a readable ZIP; call build_report");
    }
    const names = new Set(Object.keys(z));
    const need = ["REPLICATION.md", "facts.json"];
    need.push(...["spec.json", "plan.json", "exhibits/lineage.json"].filter((x) => fs.existsSync(path.join(base, x))));
    need.push(...(R.exhibits || []).filter((e: any) => e.data).map((e: any) => String(e.data).replaceAll("\\", "/")));
    for (const [sid, P] of Object.entries(policies)) {
      if (P.redistribution.mode === "definition_only") {
        need.push(`reproduce/${sid}/REPRODUCE.md`);
        for (const ext of [".sh", ".ps1"]) {             // one-command download scripts with the request built in
          if (![...names].some((n) => n.startsWith(`reproduce/${sid}/`) && n.endsWith(ext))) need.push(`reproduce/${sid}/download_*${ext}`);
        }
      } else {
        const [rel] = PS.provenance(base, sid, R);
        if (rel) need.push(rel);
      }
    }
    const miss = need.filter((n) => !names.has(n));
    res("replication", !miss.length, !miss.length ? "package complete" : `package lacks ${repr(miss)}`);
    const viol: string[] = [];
    for (const n of sorted(names)) {
      if (n === "REPLICATION.md" || n.endsWith("/")) continue;
      const d = PS.decide(n, base, policies, R, withheld);
      if (!d.ok && d.policy) viol.push(`${n} (${d.reason})`);
    }
    for (const [sid, P] of Object.entries(policies)) {            // core's own check, on the source's own files
      const scope = [...names].filter((n) => n.startsWith(`data/${sid}/`) || !["data/", "exhibits/", "lib/"].some((x) => n.startsWith(x)));
      viol.push(...PS.checkPackage(P, scope).map((n) => `${n} (core.policy.check_package: ${sid})`));
    }
    res("replication", !viol.length, !viol.length ? "no file the source terms forbid"
      : "package holds files the source terms forbid: " + sorted(new Set(viol)).slice(0, 6).join("; "));
    for (const [sid, P] of Object.entries(policies)) {            // withheld rows must not be in shared CSVs
      const keys = withheld[sid] || new Set<string>();
      const w = P.redistribution.withhold || {};
      if (!keys.size) continue;
      for (const n of names) {
        if (n.startsWith(`data/${sid}/`) && n.endsWith(".csv") && n !== `data/${sid}/${w.meta}`) {
          const d = readDict(Buffer.from(z[n]).toString("utf8"));
          if (d.fields.includes(w.key)) {
            const leaked = sorted(new Set(d.rows.map((r) => String(r[w.key] ?? "")).filter((v) => keys.has(v))));
            res("replication", !leaked.length, !leaked.length ? `${n}: no withheld rows` : `${n} holds rows of withheld ${w.key} ${repr(leaked.slice(0, 5))}`);
          }
        }
      }
    }
  }
  if (rerunIt) {
    const tracked = (R.exhibits || []).filter((e: any) => e.data).map((e: any) => path.join(base, e.data));
    results.push(...(await MA.rerun(base, fpath, tracked)));
  }
  return results;
}
