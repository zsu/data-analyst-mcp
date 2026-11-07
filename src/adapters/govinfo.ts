/**
 * GovInfo pack hooks.
 *
 * - search: GovInfo filters by collection, congress, bill type, publisher and date only through field:value terms
 *   INSIDE the query string, so beforeRequest builds the query. User text is escaped: query operators, field syntax
 *   and punctuation are removed from `text`, `phrase` and `title`. `query` is raw syntax, passed unchanged.
 * - text: fetch a package's summary, then its text link (api.govinfo.gov, with key) or the public content link
 *   (www.govinfo.gov, never with key), strip the HTML and return one row.
 * - sections: a public law's USLM XML (113th Congress on), one row per section, with the U.S. Code references split
 *   into amended, cited and classified (margin notes). Sections inside <quotedContent> are amended Code text.
 * - manualItems: api links carry the public DEMO_KEY; text and sections items use keyless www.govinfo.gov links.
 */
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { parseQsl, pyQuote, pyStr, pyUrlencode, urlsplit, urlunsplit } from "../core/py.js";
import { pyJsonClient } from "./_govinfo_json.js";
import { htmlUnescape, pyInt, pyRepr, pySplit, pyStrip, pyTupleRepr, pyWsSub, stripChars, truthy } from "./_govinfo_py.js";
import { El, fromstring, XmlParseError } from "./_govinfo_xml.js";

const HERE = path.join(PACKS_DIR, "govinfo");
const BILL_TYPES = ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"];
const SEARCH_KEYS = ["text", "phrase", "all_words", "any", "title", "query", "collection", "congress", "billtype",
  "publisher", "date_from", "date_to", "sort"];
const SORTS: Record<string, { field: string; sortOrder: string }[]> = {
  relevance: [{ field: "score", sortOrder: "DESC" }],
  newest: [{ field: "publishdate", sortOrder: "DESC" }],
  oldest: [{ field: "publishdate", sortOrder: "ASC" }] };
const OPERATORS = new Set(["and", "or", "not"]);
const DEMO_LIMIT = 8;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Hooks the tests replace (the Python tests patch the module's gr.client_for and _fetch_text). */
export const internals = {
  client: (pack: Pack): Client => gr.clientFor(pack),
  fetchText: (pack: Pack, req: SpecRequest): Promise<Row[]> => fetchText(pack, req),
};

function eps(): any {
  return readJson(HERE, "endpoints.json");
}

/** len() and [:n] of a str (code points, not UTF-16 units). */
const SURR = /[\ud800-\udfff]/;
const pyLen = (s: string) => (SURR.test(s) ? [...s].length : s.length);
const pyCut = (s: string, n: number) => (SURR.test(s) ? [...s].slice(0, n).join("") : s.slice(0, n));

function collections(): Set<string> {
  return new Set(Object.values<any>(eps().catalog).map((c) => c.id).filter((id: string) => id === id.toUpperCase() &&
    /[A-Z]/.test(id) && !id.includes(" ")));
}

/** {collection: [first year, last year]} for collections whose catalog entry names a closed range. */
function coverage(): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const c of Object.values<any>(eps().catalog)) {
    const m = /\((\d{4})-(\d{4})\)/.exec(c.description || "");
    if (m && c.id === c.id.toUpperCase() && /[A-Z]/.test(c.id)) out[c.id] = [Number(m[1]), Number(m[2])];
  }
  return out;
}

function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => pyStrip(pyStr(x))).filter(Boolean);
  return pyStr(v).split(",").map((x) => pyStrip(x)).filter(Boolean);
}

/** A date window wholly outside a closed collection's years returns nothing: say so before fetching. */
function outsideCoverage(name: unknown, p: Record<string, any>): string[] {
  const years = ["start_date", "end_date", "date_from", "date_to"].filter((k) => /^\d{4}/.test(pyStr(truthy(p[k]) ? p[k] : "")))
    .map((k) => Number(pyStr(p[k]).slice(0, 4)));
  if (!years.length) return [];
  const cov = coverage(), out: string[] = [];
  const lo = Math.min(...years), hi = Math.max(...years);
  for (const c of list(truthy(p.collection) ? p.collection : [])) {
    const rng = cov[c.toUpperCase()];
    if (rng && (lo > rng[1] || hi < rng[0])) {
      out.push(`request ${pyRepr(name)}: ${c.toUpperCase()} on GovInfo covers ${rng[0]}-${rng[1]}; nothing is dated ` +
        `${lo}-${hi} (later items are on the agency's own site, which no pack serves)`);
    }
  }
  return out;
}

/** User text reduced to plain words: no field syntax, operators, quotes, wildcards or brackets. */
export function words(text: unknown): string[] {
  const t = pyStr(text).replace(/[()[\]{}:"'\\^~*?!/<>=|&+]/g, " ");
  const out: string[] = [];
  for (let w of pySplit(t)) {
    w = stripChars(w, "-,;.");
    if (w && !OPERATORS.has(w.toLowerCase())) out.push(w);
  }
  return out;
}

function date(v: unknown): string {
  const s = pyStrip(pyStr(v));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new DataError(`govinfo: dates must be YYYY-MM-DD, got ${pyRepr(s)}`, "bad_request");
  return s;
}

/** `any`: a list of words or phrases (or one string separated by ;), any of which may match. */
function alternatives(v: unknown): string[] {
  return Array.isArray(v) ? v.map(pyStr) : pyStr(v).split(";");
}

/** The GovInfo query string for search parameters (filters first, then the escaped text). */
export function buildQuery(p: Record<string, any>): string {
  const terms: string[] = [];
  const colls = list(truthy(p.collection) ? p.collection : []).map((c) => c.toUpperCase());
  if (colls.length) terms.push(colls.length === 1 ? `collection:${colls[0]}` : "(" + colls.map((c) => `collection:${c}`).join(" OR ") + ")");
  if (truthy(p.congress)) terms.push(`congress:${pyInt(p.congress)}`);
  if (truthy(p.billtype)) terms.push(`billtype:${pyStr(p.billtype).toLowerCase()}`);
  if (truthy(p.publisher)) terms.push('publisher:"' + words(p.publisher).join(" ") + '"');
  if (truthy(p.date_from) || truthy(p.date_to)) {
    terms.push(`publishdate:range(${truthy(p.date_from) ? date(p.date_from) : ""},${truthy(p.date_to) ? date(p.date_to) : ""})`);
  }
  if (truthy(p.text)) terms.push("(" + words(p.text).join(" ") + ")");
  if (truthy(p.phrase)) {
    const w = words(p.phrase);
    // one word is searched unquoted: quotes match only that exact form, and fewer documents
    terms.push(w.length > 1 ? '("' + w.join(" ") + '")' : "(" + w.join(" ") + ")");
  }
  if (truthy(p.all_words)) terms.push("(" + words(p.all_words).join(" ") + ")");
  if (truthy(p.title)) {
    const w = words(p.title);
    terms.push(w.length > 1 ? 'title:"' + w.join(" ") + '"' : `title:${w[0]}`);
  }
  if (truthy(p.any)) {
    const alts = alternatives(p.any).map(words).filter((w) => w.length);
    terms.push("(" + alts.map((w) => (w.length > 1 ? '"' + w.join(" ") + '"' : w[0])).join(" OR ") + ")");
  }
  if (truthy(p.query)) terms.push("(" + pyStr(p.query) + ")");
  return terms.join(" AND ");
}

const PHRASE_GAP_MIN = 20;   // documents: a smaller gap is within what word order and adjacency alone explain

/** One count request for the same search with all the words (pageSize 1): a note when the quoted result is under
 * half of it and at least PHRASE_GAP_MIN documents short. */
export async function phraseCountNote(pack: Pack, req: SpecRequest, got: number): Promise<string | null> {
  const p = req.params || {};
  if (words(truthy(p.phrase) ? p.phrase : "").length < 2) return null;
  const alt = { ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== "phrase")), all_words: p.phrase };
  let total: number;
  try {
    const [ep, params] = gr.resolve(pack, { ...req, params: alt });
    const [pth, query, body0] = gr.split(ep, adapter.beforeRequest!(req, ep, params) as Record<string, unknown>);
    const body = { ...(body0 || {}), pageSize: 1 };
    const data = (await internals.client(pack).request("POST", pth, Object.keys(query).length ? query : null, { jsonBody: body })).json();
    total = pyInt(truthy(data?.count) ? data.count : 0);
  } catch (e) {
    if (e instanceof DataError || e instanceof TypeError || e instanceof SyntaxError) return null;
    throw e;
  }
  if (got * 2 > total || total - got < PHRASE_GAP_MIN) return null;
  const fmt = (n: number) => n.toLocaleString("en-US");
  return `${req.name}: the quoted search returned ${fmt(got)} documents, under half of the ${fmt(total)} containing all ` +
    `the words of '${words(p.phrase).join(" ")}', so it may be missing documents that hold the phrase ` +
    "(GovInfo's quoted search can skip them): use all_words for the complete candidate list (an upper bound: " +
    "the words may stand apart) and confirm the phrase in the text where the count matters. A full-text " +
    "phrase search is not a title search: for 'X in the title' search the title field (param title).";
}

export function billPackageId(p: Record<string, any>): string {
  if (truthy(p.packageId)) return pyStrip(pyStr(p.packageId));
  const miss = ["congress", "billtype", "number"].filter((k) => !truthy(p[k]));
  if (miss.length) {
    throw new DataError(`govinfo text: give packageId (e.g. CRPT-118hrpt730, PLAW-118publ31), or congress, billtype ` +
      `and number for a bill; missing ${pyRepr(miss)} (params given: ${pyRepr(Object.keys(p).sort(cmp))})`, "bad_request");
  }
  return `BILLS-${pyInt(p.congress)}${pyStr(p.billtype).toLowerCase()}${pyInt(p.number)}${pyStr(truthy(p.version) ? p.version : "enr").toLowerCase()}`;
}

function htmlToText(raw: string): string {
  let t = raw.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  t = t.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/h\d>/gi, "\n");
  t = htmlUnescape(t.replace(/<[^>]+>/g, ""));
  t = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");     // NULs in Daily Digest renditions (2025)
  t = t.replace(/[ \t]+\n/g, "\n");
  return pyStrip(t.replace(/\n{3,}/g, "\n\n"));
}
export { htmlToText };

const MAX_GRANULES = 25;     // a package whose text is only at granule level (CRPT, CHRG): read at most this many
// GPO's text rendition of a document it did not convert holds a cover page and this marker
const PDF_ONLY = /\[\s*TEXT\s+NOT\s+AVAILABLE\b[^\]]{0,60}\]/i;
const COVER_CHARS = 5000;
const THIN_PER_PAGE = 100;

/** full; pdf_only; partial_pdf; near_empty. */
export function textStatus(text: string, pages0: unknown): string {
  let pages: number;
  try {
    pages = pyInt(pages0);
  } catch {
    pages = 0;
  }
  const n = pyLen(text);
  if (PDF_ONLY.test(text)) return n < COVER_CHARS || (pages && n < 3 * THIN_PER_PAGE * pages) ? "pdf_only" : "partial_pdf";
  return pages >= 5 && n < THIN_PER_PAGE * pages ? "near_empty" : "full";
}

/** GovInfo's public (keyless) PDF of a package or granule. */
export function pdfUrl(pid: string, gid = ""): string {
  return `https://www.govinfo.gov/content/pkg/${pid}/pdf/${gid || pid}.pdf`;
}

export function textRow(pid: string, summary: any, text: string, link: string, maxChars: unknown, committees = "", gid = ""): Row {
  const full = pyLen(text);
  const status = textStatus(text, summary.pages ?? "");
  if (truthy(maxChars)) text = pyCut(text, pyInt(maxChars));
  return { package_id: pid, title: summary.title ?? "", collection: summary.collectionCode ?? "",
    date_issued: summary.dateIssued ?? "", pages: summary.pages ?? "", committees, text_url: link, characters: full,
    truncated: truthy(maxChars) && full > pyInt(maxChars), text_status: status, pdf_url: pdfUrl(pid, gid), text };
}

/** A note naming the rows whose text is not the document's text: a term count over them is unread, not zero. */
function textNotes(name: string, rows: Row[]): string[] {
  const out: string[] = [];
  const bad = rows.filter((r) => r.text_status === "pdf_only" || r.text_status === "near_empty");
  const part = rows.filter((r) => r.text_status === "partial_pdf");
  const ids = (rs: Row[]) => rs.slice(0, 10).map((r) => pyStr(truthy(r.granule_id) ? r.granule_id : r.package_id)).join(", ") +
    (rs.length > 10 ? ` and ${rs.length - 10} more` : "");
  if (bad.length) {
    out.push(`${name}${gr.INCOMPLETE} ${bad.length} of ${rows.length} rows have no usable text (${ids(bad)}): GovInfo's ` +
      "text rendition is GPO's 'TEXT NOT AVAILABLE, REFER TO PDF' placeholder or far too short for the " +
      "page count (text_status pdf_only / near_empty). They were not searched: read each one's pdf_url, " +
      "and count them as unread, never as 0 matches or as full text.");
  }
  if (part.length) {
    out.push(`${name}: ${part.length} of ${rows.length} rows have parts only in the PDF (${ids(part)}; text_status ` +
      "partial_pdf): GPO left a 'TEXT NOT AVAILABLE' placeholder inside the text, so a term may be " +
      "missing from the text but present in the pdf_url.");
  }
  return out;
}

/** [body, the link shown without a key] of a GovInfo link. */
async function getRaw(api: Client, link: string): Promise<[string, string]> {
  const u = urlsplit(link);
  const host = u.netloc.replace(/^.*@/, "").replace(/:\d*$/, "").toLowerCase();
  if (u.scheme !== "https" || !["api.govinfo.gov", "www.govinfo.gov"].includes(host)) {
    throw new DataError(`govinfo: not fetching a non-GovInfo link ${u.scheme}://${host || "None"}`, "api");
  }
  const q: Record<string, string> = {};
  for (const [k, v] of parseQsl(u.query)) if (k.toLowerCase() !== "api_key" && v !== "") q[k] = v;
  let raw: string;
  if (host === "api.govinfo.gov") raw = (await api.get(u.path, q)).text();
  else {                                           // the key is only ever sent to api.govinfo.gov
    const www = new Client("https://www.govinfo.gov", { name: "govinfo-content", rps: 2, burst: 4 });
    raw = (await www.get(u.path, q)).text();
  }
  return [raw, urlunsplit({ ...u, query: pyUrlencode(q) })];
}

async function linkText(api: Client, link: string): Promise<[string, string]> {
  const [raw, shown] = await getRaw(api, link);
  return [htmlToText(raw), shown];
}

/** Texts, links and committees of a package whose text renditions are per granule. */
async function granuleTexts(api: Client, pid: string): Promise<[string[], string[], string[]]> {
  const got = await api.getJson(`/packages/${pyQuote(pid)}/granules`, { offsetMark: "*", pageSize: "100" });
  const grans: any[] = got.granules || [];
  if (grans.length > MAX_GRANULES) {
    const n = truthy(got.count) ? pyStr(got.count) : `over ${grans.length}`;
    throw new DataError(`govinfo: package ${pid} has ${n} granules and no package-level text: list them (endpoint ` +
      "granules), then ask endpoint text for the ones you need with packageId and granuleId " +
      "(for_each over the granules table)", "bad_request");
  }
  const texts: string[] = [], links: string[] = [], committees: string[] = [];
  for (const g of grans) {
    const gs = await api.getJson(`/packages/${pyQuote(pid)}/granules/${pyQuote(pyStr(g.granuleId))}/summary`);
    committees.push(...(gs.committees || []).filter((c: any) => truthy(c.committeeName)).map((c: any) => c.committeeName ?? ""));
    const d = gs.download || {};
    const link = d.txtLink || d.htmlLink;
    if (link) {
      const [tx, shown] = await linkText(api, link);
      texts.push(tx);
      links.push(shown);
    }
  }
  return [texts, links, [...new Set(committees)]];
}

async function fetchText(pack: Pack, req: SpecRequest): Promise<Row[]> {
  const p = req.params || {};
  const pid = billPackageId(p);
  const api = gr.clientFor(pack);
  if (truthy(p.granuleId)) {                       // one granule: a Record article, a CFR part, a report part
    const gid = pyStr(p.granuleId);
    const gs = await api.getJson(`/packages/${pyQuote(pid)}/granules/${pyQuote(gid)}/summary`);
    const d = gs.download || {};
    const link = d.txtLink || d.htmlLink || "";
    if (!link) throw new DataError(`govinfo: granule ${gid} has no text rendition (PDF only); see its pdfLink`, "bad_request");
    const [text, shown] = await linkText(api, link);
    const row = textRow(pid, gs, text, shown, p.max_chars,
      (gs.committees || []).filter((c: any) => truthy(c.committeeName)).map((c: any) => c.committeeName ?? "").join("; "), gid);
    return [{ granule_id: gid, granule_class: gs.granuleClass ?? "", ...row }];
  }
  let summary: any;
  try {
    summary = await api.getJson(`/packages/${pyQuote(pid)}/summary`);
  } catch (e) {
    if (e instanceof DataError && e.kind === "not_found") {
      throw new DataError(`govinfo: package ${pid} not found (check the version code: ih, rh, eh, es, enr, ...)`, "bad_request");
    }
    throw e;
  }
  const d = summary.download || {};
  const link = d.txtLink || d.htmlLink || summary.txtLink || "";
  if (link) {
    const [text, shown] = await linkText(api, link);
    return [textRow(pid, summary, text, shown, p.max_chars)];
  }
  const [texts, links, committees] = await granuleTexts(api, pid);
  if (!texts.length) throw new DataError(`govinfo: package ${pid} has no text rendition (PDF only); see its pdfLink`, "bad_request");
  const shown = links[0] + (links.length > 1 ? ` (+${links.length - 1} granules)` : "");
  return [textRow(pid, summary, texts.join("\n\n"), shown, p.max_chars, committees.join("; "))];
}

// ---------------------------------------------------------------------- USLM sections
const USLM_NS = "{http://schemas.gpo.gov/xml/uslm}";
const CONTAINERS = ["division", "title", "subtitle", "part", "subpart", "chapter", "subchapter"];
const BLOCKS = ["chapeau", "content", "continuation", "p"];   // where "Section X of title Y is amended" sits
const SPACED = [...BLOCKS, "heading", "subsection", "paragraph", "subparagraph", "clause", "subclause", "item"];
const NO_USLM = "GovInfo has USLM XML for public laws from the 113th Congress (2013) on, not for bills, Statutes at " +
  "Large granules or most private laws; check the id, or use endpoint text";

const local = (tag: string) => tag.slice(tag.lastIndexOf("}") + 1);

/** el and its descendants, not entering amended (quoted) text or margin notes. */
function* walk(el: El, skip: string[] = ["quotedContent", "sidenote"]): Generator<El> {
  yield el;
  for (const c of el.children) if (!skip.includes(local(c.tag))) yield* walk(c, skip);
}

/** Text of an element without its margin notes, whitespace and soft hyphens normalised. */
function plain(el: El): string {
  const parts: string[] = [];
  const go = (e: El) => {
    parts.push(e.text || "");
    for (const c of e.children) {
      if (local(c.tag) !== "sidenote") {
        go(c);
        if (SPACED.includes(local(c.tag))) parts.push(" ");   // "HEADING.(a)" -> "HEADING. (a)"
      }
      parts.push(c.tail || "");
    }
  };
  go(el);
  return pyStrip(pyWsSub(parts.join("").split("\u00ad").join(""), " "));
}

/** /us/usc/t31/s1120/a/2 -> 31 U.S.C. 1120(a)(2); /us/usc/t31/ch11 -> 31 U.S.C. ch. 11. */
export function uscCite(href: string): string {
  const m = /^\/us\/usc\/t([\p{L}\p{N}_]+)\/(s|ch)([^/]+)((?:\/[^/]+)*)$/u.exec(href);
  if (!m) return href;
  if (m[2] === "ch") return `${m[1]} U.S.C. ch. ${m[3]}`;
  return `${m[1]} U.S.C. ${m[3]}` + m[4].split("/").filter(Boolean).map((x) => `(${x})`).join("");
}

function childText(el: El, name: string): string {
  const c = el.find(USLM_NS + name);
  return c ? plain(c) : "";
}

const AMEND_WORDS = /\b(?:is|are)\s+(?:hereby\s+)?(?:further\s+)?amended\b|\bby\s+(?:striking|inserting|adding|redesignating)\b/;

function usc(refs: Iterable<El>): string[] {
  const out: string[] = [];
  for (const r of refs) if (local(r.tag) === "ref" && r.get("href").startsWith("/us/usc/")) out.push(r.get("href"));
  return out;
}

const uniq = (xs: string[]) => [...new Set(xs)];

function sectionRow(pid: string, sec: El, pth: string[], maxChars: unknown): Row {
  const cited = uniq(usc(walk(sec)));
  let amended: string[] = [];
  for (const b of walk(sec)) {
    // GPO marks most actions <amendingAction>, but not every one ("as amended by this Act, is further amended")
    if (BLOCKS.includes(local(b.tag)) && ([...walk(b)].some((x) => local(x.tag) === "amendingAction") || AMEND_WORDS.test(plain(b)))) {
      amended = amended.concat(usc(walk(b)));
    }
  }
  amended = uniq(amended);
  const classified = uniq(usc(walk(sec, ["quotedContent"]))).filter((h) => !cited.includes(h));
  const num = sec.find(USLM_NS + "num");
  const text = plain(sec);
  return { package_id: pid, identifier: sec.get("identifier"),
    num: num ? ("value" in num.attrib ? num.attrib.value : plain(num)) : "", heading: childText(sec, "heading"),
    within: pth.join(" > "),
    usc_amended: amended.map(uscCite).join("; "),
    usc_cited: cited.filter((h) => !amended.includes(h)).map(uscCite).join("; "),
    usc_classified: classified.map(uscCite).join("; "),
    amending_actions: [...walk(sec)].filter((x) => local(x.tag) === "amendingAction").length,
    characters: pyLen(text), text: truthy(maxChars) ? pyCut(text, pyInt(maxChars)) : text };
}

/** One row per section of a USLM law (a law without sections gives one row for its body). */
export function uslmSections(pid: string, raw: string, maxChars?: unknown): Row[] {
  let root: El;
  try {
    root = fromstring(raw);
  } catch (e) {
    if (e instanceof XmlParseError) throw new DataError(`govinfo: ${pid} USLM is not well-formed XML (${e.message})`, "api");
    throw e;
  }
  const main = root.find(USLM_NS + "main");
  if (!main) throw new DataError(`govinfo: ${pid} has no <main> in its USLM; use endpoint text`, "api");
  const rows: Row[] = [];
  const go = (el: El, pth: string[]) => {
    for (const c of el.children) {
      const name = local(c.tag);
      if (name === "section") rows.push(sectionRow(pid, c, pth, maxChars));
      else if (CONTAINERS.includes(name)) go(c, [...pth, [childText(c, "num"), childText(c, "heading")].filter(Boolean).join(" ")]);
      else if (name !== "quotedContent" && name !== "sidenote") go(c, pth);
    }
  };
  go(main, []);
  if (!rows.length) {
    rows.push(sectionRow(pid, main, [], maxChars));
    rows[0].identifier = rows[0].identifier || pid;
  }
  return rows;
}

async function fetchSections(pack: Pack, req: SpecRequest): Promise<Row[]> {
  const p = req.params || {};
  const pid = pyStrip(pyStr(truthy(p.packageId) ? p.packageId : ""));
  const api = gr.clientFor(pack);
  let raw: string;
  try {
    [raw] = await getRaw(api, `https://api.govinfo.gov/packages/${pyQuote(pid)}/uslm`);
  } catch (e) {
    if (e instanceof DataError && (e.kind === "not_found" || e.kind === "bad_request")) {   // a missing rendition: HTTP 400
      throw new DataError(`govinfo: no USLM XML for ${pid}. ${NO_USLM}`, "bad_request");
    }
    throw e;
  }
  return uslmSections(pid, raw, p.max_chars);
}

/** Python's _calls: API calls a spec makes (the DEMO_KEY allows about 10 an hour). */
export function calls(spec: Spec): number {
  const E = eps().endpoints;
  let n = 0;
  for (const r of spec.requests || []) {
    const ep = E[r.endpoint || ""] || {};
    const size = pyInt((ep.paging || {}).size || 1000);
    const text = r.endpoint === "text";
    n += text ? (truthy((r.params || {}).granuleId) ? 2 : 4) : r.endpoint === "sections" ? 1
      : Math.max(1, Math.ceil(pyInt(r.max_rows || size) / size));
    if (r.endpoint === "search" && words(truthy((r.params || {}).phrase) ? r.params!.phrase : "").length > 1) n += 1;
  }
  return n;
}

const adapter: Adapter = {
  checkSpec(spec) {
    const probs: string[] = [];
    const known = collections();
    for (const r of spec.requests || []) {
      const p = r.params || {}, ep = r.endpoint;
      const n = pyRepr(r.name ?? null);
      if (ep === "search") {
        if (!["text", "phrase", "all_words", "any", "title", "query", "collection", "publisher"].some((k) => truthy(p[k]))) {
          probs.push(`request ${n}: search needs text, phrase, all_words, any, title, query, collection or publisher`);
        }
        if (p.any !== null && p.any !== undefined && !alternatives(p.any).some((x) => words(x).length)) {
          probs.push(`request ${n}: any needs a list of words or phrases`);
        }
        if (/\bdateissued\s*:/i.test(pyStr(truthy(p.query) ? p.query : ""))) {
          probs.push(`request ${n}: GovInfo answers HTTP 500 to dateIssued: inside query (verified ` +
            "2026-10-28): use date_from / date_to, which the pack sends as publishdate:range(...)");
        }
        if (["text", "phrase", "title"].some((k) => truthy(p[k]) && !words(p[k]).length)) {
          probs.push(`request ${n}: text/phrase/title has no searchable words`);
        }
        if (["text", "phrase", "all_words", "any", "title", "query"].map((k) => pyStr(truthy(p[k]) ? p[k] : "")).join(" ").includes("*")) {
          probs.push(`request ${n}: GovInfo search answers a wildcard (*) with HTTP 500: list the word ` +
            "forms instead (title:tariff OR title:tariffs)");
        }
        const bad = list(truthy(p.collection) ? p.collection : []).filter((c) => !known.has(c.toUpperCase()));
        if (bad.length) probs.push(`request ${n}: unknown collection ${pyRepr(bad)} (search the catalog with request_schema)`);
        if (truthy(p.billtype) && !BILL_TYPES.includes(pyStr(p.billtype).toLowerCase())) {
          probs.push(`request ${n}: billtype must be one of ${pyTupleRepr(BILL_TYPES)}`);
        }
        if (truthy(p.sort) && !(typeof p.sort === "string" && p.sort in SORTS)) {
          probs.push(`request ${n}: sort must be one of ${pyRepr(Object.keys(SORTS).sort(cmp))}`);
        }
        for (const k of ["date_from", "date_to"]) {
          if (truthy(p[k]) && !/^\d{4}-\d{2}-\d{2}$/.test(pyStr(p[k]))) probs.push(`request ${n}: ${k} must be YYYY-MM-DD`);
        }
      } else if (ep === "text") {
        if (!truthy(p.packageId) && !["congress", "billtype", "number"].every((k) => truthy(p[k]))) {
          probs.push(`request ${n}: text needs packageId, or congress + billtype + number`);
        } else if (!truthy(p.packageId) && !BILL_TYPES.includes(pyStr(p.billtype).toLowerCase())) {
          probs.push(`request ${n}: billtype must be one of ${pyTupleRepr(BILL_TYPES)}`);
        }
      } else if (ep === "sections") {
        if (!/^PLAW-\d+(publ|pvtl)\d+$/.test(pyStr(truthy(p.packageId) ? p.packageId : ""))) {
          probs.push(`request ${n}: sections needs a PLAW packageId (e.g. PLAW-117publ169). ${NO_USLM}`);
        }
      }
      probs.push(...outsideCoverage(r.name ?? null, p));
    }
    return probs;
  },

  beforeRequest(_req, ep, params) {
    if (String(ep.path ?? "").startsWith("/published")) {
      // GovInfo's end date is exclusive: the spec's end_date is inclusive, so ask for the next day
      const end = pyStr(truthy(params.end_date) ? params.end_date : "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        const [y, m, d] = end.split("-").map(Number);
        const dt = new Date(Date.UTC(2000, m - 1, d));
        dt.setUTCFullYear(y);
        if (dt.getUTCMonth() !== m - 1) throw new RangeError(`day is out of range for month: ${end}`);
        dt.setUTCDate(dt.getUTCDate() + 1);
        const nxt = `${String(dt.getUTCFullYear()).padStart(4, "0")}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
        params = { ...params, end_date: nxt };
      }
      return params;
    }
    if (ep.path !== "/search") return params;
    const out: Record<string, unknown> = Object.fromEntries(Object.entries(params).filter(([k]) => !SEARCH_KEYS.includes(k)));
    out.query = buildQuery(params);
    out.sorts = SORTS[truthy(params.sort) ? pyStr(params.sort) : "relevance"];
    return out;
  },

  async fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
    const tables: Tables = {};
    let notes: string[] = [];
    const texts = new Map<string, Row[]>();
    for (const r of spec.requests) {
      if (r.endpoint === "text") {
        const rows = await internals.fetchText(pack, r);
        tables[r.name] = rows;
        const g = r._group || r.name;                    // for_each: one note
        texts.set(g, [...(texts.get(g) || []), ...rows]);
      } else if (r.endpoint === "sections") {
        tables[r.name] = await fetchSections(pack, r);
      } else {
        const rec = (eps().endpoints[r.endpoint || ""] || {}).records ?? "";
        const [t, n] = await gr.fetchSpec(pack, { requests: [r] }, pyJsonClient(gr.clientFor(pack), pack, rec));
        Object.assign(tables, t);
        notes = notes.concat(n);
        const capped = n.some((x) => x.startsWith(`${r.name}: stopped at`));
        if (r.endpoint === "search" && !capped) {
          const got = t[r.name];
          const note = await phraseCountNote(pack, r, Array.isArray(got) ? got.length : 0);
          if (note) notes.push(note);
        }
      }
    }
    for (const [name, rows] of texts) notes = notes.concat(textNotes(name, rows));
    return [tables, notes];
  },

  keyOnlyNeeds(spec) {
    const n = calls(spec);
    return n > DEMO_LIMIT ? [`about ${n} API calls (the keyless DEMO_KEY allows about 10 an hour on GovInfo)`] : [];
  },

  manualItems(spec, pack) {
    const items: any[] = [];
    for (let r of spec.requests || []) {
      if (r.endpoint === "text") {
        let pid: string;
        try {
          pid = billPackageId(r.params || {});
        } catch {
          continue;
        }
        items.push({ name: `${r.name}#1`, request: r.name, filename: `${r.name}.htm`,
          url: `https://www.govinfo.gov/content/pkg/${pid}/html/${pid}.htm`, needs_key: false, method: "GET", body: null,
          note: "public text page, no key; if it is missing, open https://www.govinfo.gov/app/details/" + pid });
        continue;
      }
      if (r.endpoint === "sections") {
        const pid = pyStr(truthy((r.params || {}).packageId) ? r.params!.packageId : "");
        items.push({ name: `${r.name}#1`, request: r.name, filename: `${r.name}.xml`,
          url: `https://www.govinfo.gov/content/pkg/${pid}/uslm/${pid}.xml`, needs_key: false, method: "GET", body: null,
          note: "public USLM XML, no key" });
        continue;
      }
      let ep: any = {};
      if (r.endpoint === "search") {
        const [e, params] = gr.resolve(pack, r);
        ep = e;
        r = { ...r, params: { ...(adapter.beforeRequest!(r, ep, params) as Record<string, unknown>) } };
      }
      for (const it of gr.manualItems(pack, { requests: [r] })) {
        if (it.body !== null && it.body !== undefined && r.endpoint === "search") it.body = { ...(ep.body || {}), ...it.body, pageSize: 100 };
        it.url += (it.url.includes("?") ? "&" : "?") + "api_key=DEMO_KEY";
        it.note = (it.note ? it.note + "; " : "") +
          "DEMO_KEY is api.data.gov's public demo key (about 10 requests an hour); replace it with your own key for more";
        items.push(it);
      }
    }
    return items;
  },

  parseUpload(pack, req, files) {
    const read = (f: string) => {
      const b = fs.readFileSync(f);
      return (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b).toString("utf8");
    };
    if (req.endpoint === "sections") {
      const p = req.params || {};
      return files.flatMap((f) => uslmSections(pyStr(truthy(p.packageId) ? p.packageId : ""), read(f), p.max_chars));
    }
    if (req.endpoint !== "text") return gr.parseUpload(pack, req, files);
    return files.map((f) => textRow(billPackageId(req.params || {}), {}, htmlToText(read(f)), path.basename(f), (req.params || {}).max_chars));
  },
};

export default adapter;
