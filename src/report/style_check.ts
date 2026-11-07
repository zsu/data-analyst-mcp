/**
 * Check the prose in report.json against the style guide (a port of report/style_check.py). Results are
 * returned only; nothing is written into the report. One rule set for every source pack: the Roman-numeral
 * exceptions for "I" (Title I, level I, Schedule I), U.S.C./C.F.R. citations, and dates, quarters, fiscal years,
 * titles, levels and codes before a small numeral are allowed. Score = percent of sentences with no issue.
 */
import { rx, search, finditer, split, splitlines, pyRound, strip } from "./py.js";

const ABBREV = ["U.S.C.", "C.F.R.", "U.S.", "e.g.", "i.e.", "vs.", "etc.", "No.", "Dr.", "Mr.", "Ms.", "Jan.", "Feb.", "Aug.",
  "Sept.", "Oct.", "Nov.", "Dec.", "a.m.", "p.m.", "approx.", "Inc.", "Jr.", "St."];

export function stripMd(s: string): string {
  s = s.replace(/\{\{[^}]*\}\}/g, "X");                 // {{fact|fmt}} placeholders stand for one number
  s = s.replace(/`[^`]*`/g, "X");                       // code spans count as one technical name
  s = s.replace(/\[\^\d+\]/g, "");
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, (_m, a) => a);
  return s.replaceAll("**", "").replaceAll("*", "");
}

/** [where, paragraph] pairs of prose that the style rules apply to. */
export function paragraphs(R: any): [string, string][] {
  const out: [string, string][] = [];
  const add = (where: string, text: unknown): void => {
    if (Array.isArray(text)) {
      for (const t of text) add(where, t);
      return;
    }
    const s = text === null || text === undefined || text === "" ? "" : typeof text === "string" ? text : String(text);
    for (const block of split(/\n\s*\n/, strip(s))) {
      const lines = splitlines(block).map((l) => strip(l)).filter((l) => l);
      if (lines.length && lines.every((l) => l.startsWith("- ") || l.startsWith("* "))) {
        for (const l of lines) out.push([where, stripMd(l.slice(2))]);
      } else if (lines.length) out.push([where, stripMd(lines.join(" "))]);
    }
  };
  const leadText = (s: any) => (s && typeof s === "object" && !Array.isArray(s) ? (s.lead ?? "") + " " + (s.text ?? "") : s);
  add("subtitle", R.subtitle);
  for (const s of R.summary || []) add("summary", leadText(s));
  const g = R.at_a_glance || {};
  add("at a glance", g.text);
  for (const s of g.findings || []) add("at a glance", leadText(s));
  add("notes page", R.notes_page);
  const intro = R.introduction || {};
  add("introduction", intro.text);
  for (const x of intro.subsections || []) add(`introduction '${x.heading ?? ""}'`, x.body);
  add("introduction footnotes", intro.footnotes);
  for (const s of R.sections || []) {
    add(`section '${s.heading ?? ""}'`, s.body);
    add(`section '${s.heading ?? ""}' footnotes`, s.footnotes);
  }
  (R.exhibits || []).forEach((e: any, i: number) => {
    add(`exhibit ${i + 1} text`, e.text);
    add(`exhibit ${i + 1} notes`, e.notes);
  });
  add("methods", R.methods);
  for (const a of R.appendixes || []) add(`appendix '${a.title ?? ""}'`, a.body);
  add("footnotes", R.footnotes);
  add("about", R.about);
  return out.filter(([, p]) => strip(p));
}

export function sentences(par: string): string[] {
  let t = par;
  ABBREV.forEach((a, i) => (t = t.replaceAll(a, `\x00${i}\x00`)));
  const res: string[] = [];
  for (let p of split(/(?<=[.!?;:])\s+(?=[A-Z0-9"“($])/, t)) {
    ABBREV.forEach((a, i) => (p = p.replaceAll(`\x00${i}\x00`, a)));
    if (strip(p)) res.push(strip(p));
  }
  return res;
}

export function words(sent: string): string[] {
  return (sent.match(/[A-Za-z0-9$%][\w$%’'.,/-]*/g) || []).filter((w) => /\w/.test(w));
}

const STYLE_RULES: [RegExp, string][] = ([
  [String.raw`\d\s?%`, "use 'percent' in text, not '%'"],
  [String.raw`\bcompared to\b`, "'compared with' for differences"],
  [String.raw`\butiliz`, "'use', not 'utilize'"],
  [String.raw`\bimpact(?:s|ed|ing)?\b(?=\s+(?:the|their|its|on)\b)`, "avoid 'impact' as a verb; use 'affect'"],
  [String.raw`\bdata (?:is|was|shows|suggests|indicates)\b`, "'data' takes a plural verb"],
  [String.raw`^\d`, "do not start a sentence with a numeral; spell it out or recast"],
  [String.raw`\b(?:e\.g\.|i\.e\.|etc\.)`, "write 'for example' / 'that is'; avoid 'etc.' in text"],
  [String.raw`\bin order to\b`, "'to', not 'in order to'"],
  // "I" as a pronoun, not the Roman numeral ("Executive Schedule level I", "Title I", "Phase I")
  [String.raw`\b(?:[Ww]e|[Oo]urs?|us|[Yy]ou|[Yy]ours?)\b|(?<!level )(?<!Level )(?<!Title )(?<!Part )(?<!Phase )(?<!Tier )` +
    String.raw`(?<!schedule )(?<!Schedule )(?<!Appendix )(?<!Volume )(?<!War )(?<!Class )(?<!Category )\bI\b(?![.-]\w)`,
  "no first or second person; name the organization or write 'this analysis'"],
  [String.raw`!`, "no exclamation marks"],
  [String.raw`(?<![\d./-])\b\d{1,4}\s?-\s?\d{1,4}\b(?![-./\d])`, "ranges: 'from X to Y' or an en dash (2013–2023), never a hyphen"],
  [String.raw`\baged\s+\d`, "'ages 25 to 54', not 'aged'"],
  [String.raw`\bpersons\b`, "'people', not 'persons'"],
  [String.raw`\bgender\b`, "'sex' for survey classifications"],
  [String.raw`\b(?:fell|rose|increased|decreased|declined|grew|changed)\s+due to\b`, "'because of' after a verb; 'due to' only after a noun"],
  [String.raw`\bper cent\b`, "'percent'"],
  [String.raw`\bimpact(?:s|ed)?\s+(?:the|their|its|on)\b`, "never 'impact' as a verb; use 'affect'"],
  [String.raw`(?i)\b(?:he or she|his or her|him or her)\b`, "avoid 'he or she'; make it plural, rewrite, or use singular 'they'"],
  [String.raw`(?i)\btimes (?:less|lower|smaller|fewer|more|higher|larger|greater)\b`, "not 'times less/more'; write 'one-third as large' or 'six times as much as'"],
  [String.raw`(?i)\b(?:appears?|appeared|seems?|seemed) to\b`, "avoid vague 'appear to' / 'seem to'; state what the data show"],
  [String.raw`(?i)\baround\s+\$?\d`, "'about' or 'roughly', not 'around'"],
  [String.raw`(?i)\bpercentage points? of\b`, "never 'percentage points of'; write 'by 2 percentage points' or 'by 2 percent of GDP'"],
  [String.raw`(?i)\b(?:fairly|quite|somewhat)\b|\brather\b(?!\s+than)`, "cut vague modifiers ('fairly', 'quite', 'rather', 'somewhat')"],
  [String.raw`(?i)\b(?:prior|subsequent) to\b`, "'before' / 'after'"],
  [String.raw`(?i)\b(?:regarding|concerning|upon)\b`, "'about' or 'on' (plain English)"],
  [String.raw`(?i)\bthe elderly\b|\belderly (?:people|adults|population)\b`, "give the age range ('people age 65 or older'), not 'elderly'"],
  [String.raw`\b(?:Blacks|Whites)\b`, "'Black' and 'White' are adjectives ('Black workers'), never nouns for people"],
  [String.raw`\b(?:black|white) (?:people|workers|men|women|adults|children|residents|households|families|respondents)\b`, "capitalize 'Black' and 'White' as racial designations"],
  [String.raw`\bAmericans\b`, "'U.S. residents' (or 'U.S. citizens'), not 'Americans'"],
  [String.raw`\breform\b`, "'reform' is not neutral; use 'change' or 'restructure'"],
  [String.raw`(?i)\b(?:full|part) time\b`, "'full-time' / 'part-time' are always hyphenated"],
  [String.raw`(?i)\band/or\b`, "'X, Y, or both', not 'and/or'"],
  [String.raw`(?i)\bdata set\b`, "'dataset' (one word)"],
  [String.raw`(?<=\s)Internet\b`, "'internet' is lowercase"],
  [String.raw`\bthe Fed\b`, "'the Federal Reserve', not 'the Fed'"],
  [String.raw`(?i)\banalytic\b`, "'analytical', not 'analytic'"],
  [String.raw`(?i)\bmethodology\b`, "'method' or 'approach', not 'methodology'"],
  [String.raw`(?i)\blion's share\b`, "avoid 'lion's share'; give the share"],
  [String.raw`(?i)\bbetween (?:19|20)\d\d and (?:19|20)\d\d\b`, "date ranges: 'from 2013 to 2023', not 'between ... and'"],
  [String.raw`(?i)\bfrom (?:19|20)\d\d\s?[–-]\s?(?:19|20)\d\d\b`, "do not mix 'from' with a dash; 'from 2013 to 2023'"],
] as [string, string][]).map(([p, m]) => [rx(p), m]);

const SMALL_NUM = rx(String.raw`(?<![\w$.,–-])([1-9])(?![\w.,%–-])` +
  String.raw`(?!\s*(?:percent|percentage|million|billion|trillion|to\s+1|U\.S\.C\.|C\.F\.R\.))`);
const REF_BEFORE = rx(String.raw`(?:(?:Exhibits?|Figures?|Tables?)(?:\s+\d+\s*(?:,?\s*(?:and|to)|[–,-]))*|Appendix|Box|Chapter|` +
  String.raw`ages?|age|grade|Grade|Section|step|[Nn]o\.|group|code|level|[Tt]itle|[Pp]art|Q|FY|` +
  String.raw`(?:January|February|March|April|May|June|July|August|September|October|November|December|` +
  String.raw`Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?)\s*$`);

export function styleIssues(sent: string): string[] {
  const out: string[] = [];
  for (const [pat, msg] of STYLE_RULES) if (msg && search(pat, sent)) out.push(msg);
  for (const m of finditer(SMALL_NUM, sent)) {
    if (!search(REF_BEFORE, sent.slice(0, m.index))) {
      out.push(`spell out '${m[1]}' (zero through nine in words, unless percent, money, or a reference)`);
      break;
    }
  }
  const n = words(sent).length;
  if (n > 40) out.push(`${n} words: consider splitting (prefer plain, direct sentences)`);
  return out;
}

export const TARGET = 90;

/** [score %, sentences, compliant, issue rows] for the report's prose. */
export function score(R: any): [number, number, number, { where: string; sentence: string; issues: string[] }[]] {
  const rows: { where: string; sentence: string; issues: string[] }[] = [];
  let total = 0, clean = 0;
  for (const [where, par] of paragraphs(R)) {
    for (const s of sentences(par)) {
      const iss = styleIssues(s);
      total++;
      if (!iss.length) clean++;
      else rows.push({ where, sentence: s, issues: iss });
    }
  }
  return [total ? pyRound((100 * clean) / total, 1) : 100.0, total, clean, rows];
}

/** The style_check.py result for a report.json object. */
export function styleCheck(R: any, min?: number) {
  const target = min ?? TARGET;
  const [sc, total, clean, rows] = score(R);
  const pass = sc >= target;
  return { mode: R.mode || "report", standard: "Style guide", sentences: total, compliant: clean, score: sc, target, pass,
    summary: `Style guide: ${clean}/${total} sentences compliant = ${sc}% (target ${target}%) -> ${pass ? "PASS" : "REVISE"}`,
    issues: rows.map((r) => ({ ...r, sentence: r.sentence.slice(0, 160) })) };
}

