/**
 * usda-fna: the SNAP State Options Report and State Activity Report PDFs (the Python adapter's PDF section).
 *
 * The Python version reads the PDFs' text with pypdf (an optional package). This server has no PDF text reader
 * (core has none, and no package may be added here), so pdfPages() refuses with install_deps (not_supported),
 * as Python does without pypdf. Everything after the text is ported unchanged, so a reader that gives pypdf's
 * page text plugs in at pdfPages: pages come back as text (Unicode NFKC); the State Activity Report state tables
 * for FY 2019-2023 are parsed into tidy rows. pypdf prints each table either column by column (the 53 agency
 * names, then 53 values per column) or row by row (an agency name and its values on one line), and the layout
 * changes between years and tables, so both are read. A table is kept only when its value count equals its
 * column count and every column label's words appear in the printed header (endpoints.json activity_tables);
 * otherwise its rows are dropped and the table is named as incomplete. Agency sums are checked against the
 * printed U.S. row.
 */
import { INCOMPLETE } from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import { pyFloatRepr } from "../core/py.js";
import { fmt0, pyFloat, pyRepr, pyStrip, pySum, SpecError } from "./_usda-fna_book.js";

// ---------------------------------------------------------------------- the 53 SNAP state agencies
export const AGENCIES: [string, string][] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"],
  ["GA", "Georgia"], ["GU", "Guam"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
  ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"],
  ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"],
  ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"],
  ["VI", "Virgin Islands"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"],
  ["WY", "Wyoming"]];
export const NAME = new Map(AGENCIES);
const ABBR = new Map(AGENCIES.map(([a, n]) => [n.toLowerCase(), a]));
const ALIASES: Record<string, string> = { "u.s. virgin islands": "VI", "us virgin islands": "VI", dc: "DC",
  "washington dc": "DC", "washington, d.c.": "DC" };
const NAMES = new Set(NAME.values());
const BY_LENGTH = [...NAME.values()].sort((a, b) => b.length - a.length); // "West Virginia" before "Virginia"
const MISSING = ["N/A", "NA", "-", "--", "—", "–", "*", ""];
const RANGE = /FY\s*(\d{4})\s*[-–]\s*(?:FY\s*)?(\d{4})/;
const WS_RUN = /[\t-\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
const pySplit = (s: string) => pyStrip(s).split(WS_RUN).filter(Boolean);
const splitlines = (s: string) => s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);

/** USPS code of one of the 53 SNAP state agencies (name or code, any case). */
export function agency(x: unknown): string {
  const k = pyStrip(String(x === null || x === undefined || x === "" || x === 0 || x === false ? "" : x).replace(WS_RUN, " ")).toLowerCase();
  if (NAME.has(k.toUpperCase())) return k.toUpperCase();
  if (ABBR.has(k)) return ABBR.get(k)!;
  if (k in ALIASES) return ALIASES[k];
  throw new SpecError(`unknown SNAP state agency ${pyRepr(x)}: give a USPS code (TX) or a name (Texas); the 53 agencies ` +
    "are the 50 states, DC, Guam (GU) and the Virgin Islands (VI)");
}

export function agenciesOf(v: unknown): string[] {
  if (v === null || v === undefined || v === "" || v === "all" || v === "ALL" ||
    (Array.isArray(v) && v.length === 1 && v[0] === "all")) return AGENCIES.map(([a]) => a);
  const vals = Array.isArray(v) ? v : String(v).split(",").filter((x) => pyStrip(x)); // "TX,CA"
  return [...new Set(vals.map(agency))];
}

export function pagesOf(v: unknown): Set<number> | null {
  if (v === null || v === undefined || v === "") return null;
  const out = new Set<number>();
  for (const part of String(v).replace(/ /g, "").split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new SpecError(`pages ${pyRepr(v)}: use page numbers like "9-12" or "44,45"`);
    const a = parseInt(m[1], 10), b = parseInt(m[2] || m[1], 10);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i);
  }
  return out;
}

// ---------------------------------------------------------------------- PDFs
/** The text of each page (Unicode NFKC). No PDF text reader here: refused as Python refuses without pypdf. */
export function pdfPages(_body: Uint8Array): string[] {
  throw new DataError("usda-fna: reading the report PDFs needs a PDF text reader, which this server does not have " +
    "(options_report, activity_report and activity_tables read PDFs). The State Options rows come from " +
    "options_by_state / option_states (no PDF); for a report page, give the user the PDF link from manual_bundle.",
  "install_deps");
}

export function lines(text: string): string[] {
  const ls = splitlines(text).filter((ln) => pyStrip(ln)).map((ln) => pyStrip(ln.replace(WS_RUN, " ")));
  const out: string[] = [];
  for (let ln of ls) {
    // a cell split by pypdf: "$ 5,860,922" and "$867, 586" are one number each
    ln = ln.replace(/\$ (?=[\d(])/g, "$").replace(/(\d), (\d{3})(?!\d)/g, "$1,$2");
    ln = ln.replace(/(\d) %/g, "$1%"); // "-56.1 %"
    const prev = out.length ? out[out.length - 1] : "";
    const joined = `${prev} ${ln}`;
    // an agency name printed on two lines ("District of" / "Columbia", "New" / "Hampshire")
    if (prev && !NAMES.has(prev) && BY_LENGTH.some((n) => n.startsWith(prev + " ") && (joined === n || joined.startsWith(n + " ")))) {
      out[out.length - 1] = joined;
    } else out.push(ln);
  }
  return out;
}

/** {page index: agency name} for the State Agency Profile pages (16th and 17th editions): a page whose first
 * line (after the running header) is an agency name followed by the policy table, and the pages that continue it. */
export function profileStates(pages: string[]): Map<number, string> {
  const out = new Map<number, string>();
  let cur: string | null = null;
  pages.forEach((t, i) => {
    const ls = lines(t).filter((ln) => !ln.startsWith("USDA Food and Nutrition Service"));
    if (ls.length >= 2 && NAMES.has(ls[0]) && ls[1].startsWith("Policy Option")) {
      cur = ls[0];
      out.set(i, cur);
    } else if (cur && ls.length && /^(Waiver Implementation|Demonstration Project|Policy Option)/.test(ls[0])) out.set(i, cur);
    else cur = null;
  });
  return out;
}

export function reportRows(pages: string[], ed: string, params: Record<string, any>, eps: any): Record<string, unknown>[] {
  const prof = profileStates(pages);
  const keep = pagesOf(params.pages);
  const want = params.state !== null && params.state !== undefined && params.state !== "" ? NAME.get(agency(params.state))! : null;
  if (want && ![...prof.values()].includes(want)) {
    throw new DataError(`usda-fna: no State Agency Profile pages for ${want} were found in edition ${ed} (the 16th and ` +
      "17th editions have them; older editions are laid out differently): request the edition " +
      "without state, or the pages you need", "bad_request");
  }
  const label = eps.options_reports[ed].label;
  const out: Record<string, unknown>[] = [];
  pages.forEach((t, i) => {
    if ((keep === null || keep.has(i + 1)) && (want === null || prof.get(i) === want)) {
      out.push({ edition: parseInt(ed, 10), edition_label: label, page: i + 1, state: prof.get(i) ?? "", text: pyStrip(t) });
    }
  });
  return out;
}

/** The State Activity Report's fiscal year: from the cover ("State Activity Report FY 2023" / "Fiscal Year
 * 2019"), else the latest year most table titles end with ("TABLE 5: ... - FY 2023"). */
export function reportYear(pages: string[]): number | null {
  const m = /State Activity Report\s*(?:FY|Fiscal Year)\s*(\d{4})/.exec((pages.length ? pages[0] : "").replace(WS_RUN, " "));
  if (m) return parseInt(m[1], 10);
  const ends: number[] = [];
  for (const t of pages) {
    for (const ln of lines(t)) {
      if (/^TABLE\s+\d+\s*:/i.test(ln) && /\d{4}/.test(ln)) {
        ends.push(Math.max(...[...ln.matchAll(/(?:FY\s*)?(\d{4})/g)].map((x) => parseInt(x[1], 10))));
      }
    }
  }
  if (!ends.length) return null;
  // max(set(ends), key=ends.count): the most frequent year (a tie goes to the first in set order, here the smallest)
  const distinct = [...new Set(ends)].sort((a, b) => a - b);
  let best = distinct[0], n = -1;
  for (const y of distinct) {
    const c = ends.filter((e) => e === y).length;
    if (c > n) [best, n] = [y, c];
  }
  return best;
}

export function activityPageRows(pages: string[], fy: number, params: Record<string, any>): Record<string, unknown>[] {
  const keep = pagesOf(params.pages);
  const out: Record<string, unknown>[] = [];
  pages.forEach((t, i) => {
    if (keep !== null && !keep.has(i + 1)) return;
    const title = lines(t).find((ln) => /^table\s+\d+/i.test(ln)) ?? "";
    out.push({ report_fy: fy, page: i + 1, table_title: title, text: pyStrip(t) });
  });
  return out;
}

// ---------------------------------------------------------------------- SAR state tables
/** [value_num, value_flag] for a published cell: numbers lose $ , %; codes go to the flag. */
function value(v: string): [string, string] {
  const s = pyStrip(v);
  if (MISSING.includes(s.toUpperCase())) return ["", s || "blank"];
  const neg = s.startsWith("(") && s.endsWith(")");
  const x = s.replace(/^[()]+|[()]+$/g, "").replace(/\$/g, "").replace(/,/g, "").replace(/%/g, "");
  let f = pyFloat(x);
  if (f === null) return ["", s];
  f = neg ? -f : f;
  return [Number.isInteger(f) && !x.includes(".") ? BigInt(f).toString() : pyFloatRepr(f), ""];
}

function agencyLine(ln: string): string | null {
  for (const n of BY_LENGTH) if (ln === n || ln.startsWith(n + " ")) return n;
  return null;
}

const headHas = (headNs: string, label: string) => (label.match(/[A-Za-z0-9]+/g) || []).every((w) => headNs.includes(w.toLowerCase()));

/** [table key, rows, problem] for one PDF page; [null, [], null] when it is not a parsed state table. */
export function parseTablePage(text: string, page: number, fy: number, eps: any): [string | null, Record<string, unknown>[], string | null] {
  const ls = lines(text);
  const t = ls.findIndex((ln) => /^TABLE\s+\d+\s*:/i.test(ln));
  if (t < 0) return [null, [], null];
  let a = -1;
  for (let i = t + 1; i < ls.length; i++) {
    if (agencyLine(ls[i])) {
      a = i;
      break;
    }
  }
  if (a < 0) return [null, [], null];
  const head = ls.slice(t, a).join(" ");
  const num = parseInt(/^TABLE\s+(\d+)/i.exec(ls[t])![1], 10);
  const m = /^(TABLE\s+\d+\s*:.*?FY\s*\d{4}(?:\s*[-–]\s*(?:FY\s*)?\d{4})?)/i.exec(head);
  const title = m ? m[1] : ls[t];
  if (/ranked/i.test(head)) return [null, [], null];
  const rng = RANGE.exec(head);
  const defs: Record<string, any> = eps.activity_tables;
  const keys = Object.entries(defs).filter(([, d]) => new RegExp(d.title, "i").test(head) &&
    !(d.not && new RegExp(d.not, "i").test(head)) && !!d.multi === !!rng).map(([k]) => k);
  if (keys.length !== 1) {
    return [null, [], `FY ${fy} page ${page} ${pyRepr(title)}: ` + (!keys.length ? "no table definition matches"
      : `several definitions match (${keys.join(", ")})`)];
  }
  const key = keys[0], d = defs[key];
  // values: column by column (the 53 names alone, then 53 values per column) or row by row (name and values)
  const names: string[] = [];
  let cells: string[][] = [], total: string[] | null = null, k: number;
  if (NAMES.has(ls[a])) {
    let i = a;
    while (i < ls.length && NAMES.has(ls[i])) names.push(ls[i++]);
    let toks: string[] = [];
    for (const ln of ls.slice(i)) {
      if (ln.startsWith("U.S.") || ln.startsWith("•") || ln.startsWith("Total ")) {
        if (ln.startsWith("U.S.")) total = pySplit(ln.slice(4));
        break;
      }
      toks = toks.concat(pySplit(ln));
    }
    k = names.length ? Math.floor(toks.length / names.length) : 0;
    if (names.length && toks.length === k * names.length + 1 && /^\d+$/.test(toks[toks.length - 1])) toks = toks.slice(0, -1); // the page number
    if (!names.length || toks.length % names.length) {
      return [key, [], `FY ${fy} page ${page} ${pyRepr(title)}: ${toks.length} values for ${names.length} agencies`];
    }
    cells = names.map((_, r) => Array.from({ length: k }, (_, j) => toks[j * names.length + r]));
  } else {
    for (const ln of ls.slice(a)) {
      const n = agencyLine(ln);
      if (n) {
        names.push(n);
        cells.push(pySplit(ln.slice(n.length)));
      } else if (ln.startsWith("U.S.")) total = pySplit(ln.slice(4));
    }
    k = cells.length ? Math.max(...cells.map((c) => c.length)) : 0;
    for (const c of cells) {
      if (!c.length) c.push(...Array(k).fill("")); // an agency printed without values (a footnote says missing)
      else if (c.length === k - 1 && (d.blank_last || d.multi)) c.push(""); // a ratio left blank when its base is 0
    }
    const widths = [...new Set(cells.map((c) => c.length))].sort((x, y) => x - y);
    if (widths.length !== 1) return [key, [], `FY ${fy} page ${page} ${pyRepr(title)}: rows have ${pyRepr(widths)} values`];
  }
  if (new Set(names).size !== names.length || names.length !== AGENCIES.length) {
    return [key, [], `FY ${fy} page ${page} ${pyRepr(title)}: ${new Set(names).size} distinct agencies, expected ${AGENCIES.length}`];
  }
  let cols: [string, number][];
  if (d.multi) {
    const y0 = parseInt(rng![1], 10), y1 = parseInt(rng![2], 10);
    cols = [];
    for (let y = y0; y <= y1; y++) cols.push([d.multi, y]);
    cols.push([d.multi + "_percent_change", y1]);
    if (cols.length !== k) return [key, [], `FY ${fy} page ${page} ${pyRepr(title)}: ${k} columns, expected ${cols.length} for FY ${y0}-${y1}`];
  } else {
    const headNs = head.replace(WS_RUN, "").toLowerCase();
    const v = (d.variants as [string, string][][]).find((v) => v.length === k && v.every(([, lab]) => headHas(headNs, lab)));
    if (!v) {
      return [key, [], `FY ${fy} page ${page} ${pyRepr(title)}: ${k} value columns match no column list of ` +
        `${key} (endpoints.json activity_tables)`];
    }
    cols = v.map(([meas]) => [meas, fy]);
  }
  const rows: Record<string, unknown>[] = [];
  names.forEach((n, r) => {
    const cs = cells[r];
    for (let j = 0; j < Math.min(cols.length, cs.length); j++) {
      const [meas, dfy] = cols[j], val = cs[j];
      const [numv, flag] = value(val);
      rows.push({ report_fy: fy, table: key, table_number: num, table_title: title, page, state: n, state_abbr: agency(n),
        row_type: "state", measure: meas, data_fy: dfy, value: val, value_num: numv, value_flag: flag });
    }
  });
  let problem: string | null = null;
  if (total && total.length === k) {
    const sums = d.sum;
    const idx: number[] = sums === true ? Array.from({ length: k }, (_, i) => i) : sums || [];
    const off: string[] = [];
    for (const j of idx) {
      if (cols[j][0].endsWith("_percent_change")) continue;
      const [us] = value(total[j]);
      const vals = cells.filter((c) => value(c[j])[0]).map((c) => Number(value(c[j])[0]));
      if (us && vals.length && Math.abs(pySum(vals) - Number(us)) > Math.max(2.0, 0.002 * Math.abs(Number(us)))) {
        off.push(`${cols[j][0]} (${fmt0(pySum(vals))} vs U.S. ${total[j]})`);
      }
    }
    for (let j = 0; j < Math.min(cols.length, total.length); j++) {
      const [meas, dfy] = cols[j], val = total[j];
      const [numv, flag] = value(val);
      rows.push({ report_fy: fy, table: key, table_number: num, table_title: title, page, state: "U.S.", state_abbr: "",
        row_type: "us_total", measure: meas, data_fy: dfy, value: val, value_num: numv, value_flag: flag });
    }
    if (off.length) problem = `check: FY ${fy} ${key}: agency sum differs from the printed U.S. total: ${off.join("; ")}`;
  }
  return [key, rows, problem];
}

export function activityTableRows(pages: string[], fy: number, params: Record<string, any>, eps: any): [Record<string, unknown>[], string[]] {
  const w = params.tables;
  const want = w === null || w === undefined || w === "" || w === "all" ? null : new Set<string>(Array.isArray(w) ? w : [w]);
  const states = params.state !== null && params.state !== undefined && params.state !== "" ? new Set(agenciesOf(params.state)) : null;
  let rows: Record<string, unknown>[] = [];
  const notes: string[] = [], found = new Set<string>(), bad: string[] = [];
  pages.forEach((t, i) => {
    const [key, rs, prob] = parseTablePage(t, i + 1, fy, eps);
    if (want !== null && !want.has(key as string)) return;
    if (key && rs.length) {
      found.add(key);
      rows = rows.concat(rs.filter((r) => states === null || states.has(r.state_abbr as string)));
    }
    if (prob && prob.startsWith("check:")) notes.push(prob.slice(7));
    else if (prob && key) bad.push(prob);
    else if (prob && want === null) notes.push(`not parsed: ${prob} (read it with activity_report)`);
  });
  if (bad.length) {
    notes.push(`FY ${fy}${INCOMPLETE} table(s) dropped because their values did not line up with their ` +
      `columns: ${bad.join(" | ")}. Read those pages with activity_report.`);
  }
  if (want && want.size) {
    for (const k of [...want].filter((x) => !found.has(x)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!bad.some((b) => b.includes(k))) notes.push(`FY ${fy}: table ${k} is not in this year's report`);
    }
  }
  return [rows, notes];
}
