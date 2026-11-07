/**
 * Congress.gov pack hooks, plus roll-call votes from the House Clerk and Senate XML files.
 *
 * - beforeRequest: "congress": "current" becomes the current Congress number (a Congress starts at noon on
 *   January 3 of an odd year); title_contains is removed (applied in normalize); a "+" in sort becomes a space
 *   (Congress.gov silently ignores an encoded "+").
 * - normalize: title_contains filter (the phrase as given, each word matching at a word start, any case; a list
 *   matches any of its phrases); text_plain added to CRS summaries (HTML stripped).
 * - fetch: roll_call, senate_votes and bill_votes read the official XML (clerk.house.gov 1990 on, www.senate.gov
 *   1989 on; no key). roll_call for the House falls back to the Congress.gov house-vote API (115th Congress on)
 *   when the Clerk file cannot be read. Every other endpoint goes through generic-rest.
 * - manualItems / parseUpload: XML links for the vote endpoints; DEMO_KEY on Congress.gov links.
 * - The Python refused_hosts probe (senate.gov refusing scripts) is refusedHostsProbe here: the Adapter's
 *   refusedHosts hook is synchronous and cannot probe, so fetch adds the same guidance to a blocked Senate request.
 */
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { parsePyJson, pyStr, urlsplit } from "../core/py.js";
import { pyJsonClient } from "./_govinfo_json.js";
import { htmlUnescape, pyInt, pyRepr, pySplit, pyStrip, truthy } from "./_govinfo_py.js";
import { El, fromstring, XmlParseError } from "./_govinfo_xml.js";

const HERE = path.join(PACKS_DIR, "congress");
const CLERK = "https://clerk.house.gov";
const SENATE = "https://www.senate.gov";
const CUSTOM = ["roll_call", "senate_votes", "bill_votes"];
const DEMO_LIMIT = 8;
const PARTY: Record<string, string> = { republican: "R", democratic: "D", democrat: "D", independent: "I" };
const CLIENTS = new Map<string, Client>();
const HOUSE_API_FIRST = 115;   // Congress.gov house-vote data start with the 115th Congress (2017)

/** Hooks the tests replace (the Python tests patch the module's gr.fetch and _client). */
export const internals = {
  fetchSpec: gr.fetchSpec as (pack: Pack, spec: Spec, client?: Client) => Promise<[Tables, string[]]>,
  client: (base: string, name: string): Client => {
    if (!CLIENTS.has(base)) CLIENTS.set(base, new Client(base, { name, rps: 2, burst: 4 }));
    return CLIENTS.get(base)!;
  },
};

// ---------------------------------------------------------------------- congress numbers
/** The Congress whose term includes a date (January 3 since 1935, March 4 before). today: [year, month, day]. */
export function currentCongress(today?: [number, number, number]): number {
  const d = today ?? (() => {
    const t = new Date();
    return [t.getFullYear(), t.getMonth() + 1, t.getDate()] as [number, number, number];
  })();
  const [y, m, day] = d;
  let n = Math.floor((y - 1789) / 2) + 1;
  const start: [number, number] = y >= 1935 ? [1, 3] : [3, 4];
  if (y % 2 === 1 && (m < start[0] || (m === start[0] && day < start[1])) && n > 1) n -= 1;
  return n;
}

export function congressYears(n: number): [number, number] {
  const start = 1789 + 2 * (n - 1);
  return [start, start + 1];
}

/** Calendar year of a regular session (session 1 = the odd year, session 2 = the even year). */
export function sessionYear(congress: unknown, session: unknown): number {
  return congressYears(pyInt(congress))[0] + pyInt(session) - 1;
}

export function ordinal(n0: unknown): string {
  const n = pyInt(n0);
  const suf = n % 100 >= 10 && n % 100 <= 20 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[((n % 10) + 10) % 10] ?? "th";
  return `${n}${suf}`;
}

function eps(): any {
  return readJson(HERE, "endpoints.json").endpoints;
}

// ---------------------------------------------------------------------- titles
function stripHtml(s: unknown): string {
  let t = pyStr(truthy(s) ? s : "").replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n");
  t = htmlUnescape(t.replace(/<[^>]+>/g, ""));
  return pyStrip(t.replace(/\n\s*\n+/g, "\n").replace(/[ \t]+/g, " "));
}

const W = "[\\p{L}\\p{N}_]";
const esc = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** title_contains -> a test on a title, or null. Each phrase matches as given: its words in that order, each at the
 * START of a word, any case, any spacing or punctuation between words. A list matches any of its phrases. */
export function titleMatcher(value: unknown): ((title: unknown) => boolean) | null {
  const phrases = Array.isArray(value) ? value : [value];
  const pats = phrases.filter((p) => pySplit(pyStr(truthy(p) ? p : "")).length)
    .map((p) => `(?<!${W})` + pySplit(pyStr(p)).map(esc).join(`${W}*[^\\p{L}\\p{N}_]+`));
  if (!pats.length) return null;
  const rx = new RegExp(pats.join("|"), "iu");
  return (title) => rx.test(pyStr(truthy(title) ? title : ""));
}

/** For a multi-word title_contains that kept nothing: the words must stand together and in that order. */
export function phraseOrderHint(req: SpecRequest): string | null {
  const v = (req.params || {}).title_contains;
  const multi = (Array.isArray(v) ? v : [v]).filter((p) => pySplit(pyStr(truthy(p) ? p : "")).length > 1).map((p) => pyStr(p));
  if (!multi.length) return null;
  return `title_contains needs each phrase's words adjacent and in that order (${multi.map(pyRepr).join(", ")}); ` +
    "to match them in another order or apart, list each form as its own phrase (a list matches any of " +
    "them), or filter on one distinctive word and check the titles in the CSV.";
}

const TITLE_ROUTE: Record<string, string> = { bills: "BILLS", bills_congress: "BILLS", laws: "PLAW", laws_congress: "PLAW" };

/** title_contains on a bill or law list reads Congress.gov's display title only: say so, with the title search. */
export function displayTitleNote(req: SpecRequest): string | null {
  const p = req.params || {};
  const v = p.title_contains;
  const phrases = (Array.isArray(v) ? v : [v]).filter((x) => pyStrip(pyStr(truthy(x) ? x : ""))).map((x) => pyStrip(pyStr(x)));
  const coll = TITLE_ROUTE[req.endpoint || ""];
  if (!phrases.length || !coll) return null;
  const c = p.congress;
  const cong = /^\d+$/.test(pyStr(truthy(c) ? c : "")) ? `"congress": ${pyStr(c)}` : '"congress": <the Congress number>';
  const search = phrases.slice(0, 3).map((x) => `{"collection": "${coll}", ${cong}, "title": "${x}"}`).join("; ");
  return `${req._group || req.name}: title_contains matched the list's display title only, not official or short titles, so ` +
    "bills whose official title alone holds the phrase are missing here. For 'in the title' answers, search " +
    `titles at GovInfo: source govinfo, endpoint search, params ${search}; strip the version suffix from ` +
    "packageId (BILLS-<congress><type><number><version>) to get each bill, deduplicate, then confirm each " +
    "with this pack's bill_titles (for_each on congress, billType, billNumber) and say which title the " +
    "count uses.";
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  const match = titleMatcher((req.params || {}).title_contains);
  if (match) rows = rows.filter((r) => match(r.title));
  if (req.endpoint === "bill_summaries" || req.endpoint === "summaries") rows = rows.map((r) => ({ ...r, text_plain: stripHtml(r.text) }));
  return rows;
}

// ---------------------------------------------------------------------- XML votes
async function xml(url: string): Promise<El> {
  const u = urlsplit(url);
  const base = `${u.scheme}://${u.netloc}`;
  if (base !== CLERK && base !== SENATE) throw new DataError(`congress: not fetching vote XML from ${base}`, "api");
  const c = internals.client(base, base === CLERK ? "house-clerk" : "senate-lis");
  let body: Buffer;
  try {
    body = (await c.get(u.path)).body;
  } catch (e) {
    if (e instanceof DataError && e.kind === "blocked" && base === SENATE) {
      throw new DataError(`${e.message}. Senate vote XML cannot be fetched from here; House votes can (bill_votes with ` +
        '"chamber": "house"), and source.md (Access) gives the Congressional Record route for Senate roll calls', "blocked", e.status);
    }
    throw e;
  }
  try {
    return fromstring(body);
  } catch (e) {
    if (!(e instanceof XmlParseError)) throw e;
    throw new DataError(`congress: ${u.path} is not valid XML (${e.message}); the site may be blocking automated requests`, "api");
  }
}

export function houseUrl(year: unknown, roll: unknown): string {
  return `${CLERK}/evs/${pyInt(year)}/roll${String(pyInt(roll)).padStart(3, "0")}.xml`;
}

export function senateUrl(congress: unknown, session: unknown, roll: unknown): string {
  const c = pyInt(congress), s = pyInt(session);
  return `${SENATE}/legislative/LIS/roll_call_votes/vote${c}${s}/vote_${c}_${s}_${String(pyInt(roll)).padStart(5, "0")}.xml`;
}

export function senateMenuUrl(congress: unknown, session: unknown): string {
  return `${SENATE}/legislative/LIS/roll_call_lists/vote_menu_${pyInt(congress)}_${pyInt(session)}.xml`;
}

/** Python's refused_hosts: when the spec needs Senate vote XML, try senate.gov once; a refusal is returned as the
 * error a fetch would raise (a route check can run it before the fetch). */
export async function refusedHostsProbe(spec: Spec): Promise<string> {
  const senate = (r: SpecRequest) => {
    const p = r.params || {}, ep = r.endpoint;
    const ch = pyStr(p.chamber || "").toLowerCase();
    return ep === "senate_votes" || (ep === "roll_call" && ch === "senate") || (ep === "bill_votes" && ch !== "house");
  };
  if (!(spec.requests || []).some((r) => r && typeof r === "object" && senate(r))) return "";
  try {
    await internals.client(SENATE, "senate-lis").get(urlsplit(senateMenuUrl(119, 1)).path);
  } catch (e) {
    if (e instanceof DataError && e.kind === "blocked") {
      return `${e.message}. Senate vote XML cannot be fetched from here; House votes can (bill_votes with ` +
        '"chamber": "house"), and source.md (Access) gives the Congressional Record route for Senate roll calls';
    }
  }
  return "";
}

function t(el: El | null, p: string, dflt = ""): string {
  const x = el ? el.find(p) : null;
  return x ? pySplit([...x.itertext()].join("")).join(" ") : dflt;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const D = "(3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])";

/** datetime.strptime(s, fmt).date().isoformat() for "%d-%b-%Y" and "%B %d, %Y" ("" when no format matches). */
function isoDate(s0: string, fmts: string[]): string {
  const s = pySplit(s0).join(" ");
  for (const f of fmts) {
    let m: RegExpExecArray | null = null, y = 0, mo = 0, d = 0;
    if (f === "%d-%b-%Y") {
      m = new RegExp(`^${D}-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(\\d{4})$`, "i").exec(s);
      if (m) [d, mo, y] = [Number(m[1]), MONTHS.findIndex((x) => x.startsWith(m![2].toLowerCase())) + 1, Number(m[3])];
    } else if (f === "%B %d, %Y") {
      m = new RegExp(`^(${MONTHS.join("|")})\\s+${D},\\s+(\\d{4})$`, "i").exec(s);
      if (m) [mo, d, y] = [MONTHS.indexOf(m[1].toLowerCase()) + 1, Number(m[2]), Number(m[3])];
    }
    if (!m) continue;
    const dt = new Date(Date.UTC(2000, mo - 1, d));
    dt.setUTCFullYear(y);
    if (y < 1 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) continue;
    return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return "";
}

function position(v: string): string {
  const k = pyStrip(v).toLowerCase();
  return ({ yea: "yea", aye: "yea", nay: "nay", no: "nay", present: "present", "not voting": "not_voting" } as Record<string, string>)[k] ?? "other";
}

export function parseHouse(root: El, url: string): [Row, Row[]] {
  const m = root.find("vote-metadata");
  const sess = t(m, "session").replace(/\D/g, "");
  const dateRaw = t(m, "action-date");
  const vote: Row = { chamber: "house", congress: t(m, "congress"), session: sess, roll: t(m, "rollcall-num"),
    date: isoDate(dateRaw, ["%d-%b-%Y"]), date_published: dateRaw, question: t(m, "vote-question"),
    vote_type: t(m, "vote-type"), result: t(m, "vote-result"), legislation: t(m, "legis-num"), description: t(m, "vote-desc") };
  const tv = m ? m.find("vote-totals/totals-by-vote") : null;
  Object.assign(vote, { yea: t(tv, "yea-total"), nay: t(tv, "nay-total"), present: t(tv, "present-total"),
    not_voting: t(tv, "not-voting-total") });
  for (const tp of m ? m.findall("vote-totals/totals-by-party") : []) {
    const p = PARTY[t(tp, "party").toLowerCase()] ?? (t(tp, "party").slice(0, 1).toUpperCase() || "?");
    for (const [k, tag] of [["yea", "yea-total"], ["nay", "nay-total"], ["present", "present-total"], ["not_voting", "not-voting-total"]]) {
      vote[`${k}_${p}`] = t(tp, tag);
    }
  }
  vote.source_url = url;
  const members: Row[] = [];
  for (const rv of root.findall("vote-data/recorded-vote")) {
    const leg = rv.find("legislator");
    const a = leg ? leg.attrib : {};
    const cast = t(rv, "vote");
    members.push({ chamber: "house", congress: vote.congress, session: sess, roll: vote.roll, date: vote.date,
      member_id: a["name-id"] ?? "", name: a["unaccented-name"] || t(rv, "legislator"), party: a.party ?? "",
      state: a.state ?? "", vote: cast, position: position(cast), vote_source: "clerk.house.gov" });
  }
  return [vote, members];
}

export function parseSenate(root: El, url: string): [Row, Row[]] {
  const dateRaw = t(root, "vote_date");
  const parts = dateRaw.split(",");
  const d = isoDate(parts.length >= 2 ? parts[0] + "," + parts[1] : dateRaw, ["%B %d, %Y"]);
  const vote: Row = { chamber: "senate", congress: t(root, "congress"), session: t(root, "session"),
    roll: String(pyInt(t(root, "vote_number") || 0)), date: d, date_published: dateRaw,
    question: t(root, "vote_question_text") || t(root, "question"), vote_type: t(root, "majority_requirement"),
    result: t(root, "vote_result"), legislation: t(root, "document/document_name"),
    description: t(root, "vote_title") || t(root, "vote_document_text"),
    yea: t(root, "count/yeas"), nay: t(root, "count/nays"), present: t(root, "count/present"),
    not_voting: t(root, "count/absent"), tie_breaker: t(root, "tie_breaker/by_whom") };
  const members: Row[] = [];
  for (const mm of root.findall("members/member")) {
    const cast = t(mm, "vote_cast");
    members.push({ chamber: "senate", congress: vote.congress, session: vote.session, roll: vote.roll, date: d,
      member_id: t(mm, "lis_member_id"), name: pyStrip(`${t(mm, "first_name")} ${t(mm, "last_name")}`), party: t(mm, "party"),
      state: t(mm, "state"), vote: cast, position: position(cast), vote_source: "senate.gov" });
  }
  const parties = [...new Set(members.map((x) => String(x.party)))];
  const tally = new Map<string, [string, string, number]>();
  for (const pos of ["yea", "nay", "present", "not_voting"]) for (const p of parties) tally.set(JSON.stringify([pos, p]), [pos, p, 0]);
  for (const x of members) {
    const k = JSON.stringify([x.position, x.party]);
    const cur = tally.get(k) ?? [String(x.position), String(x.party), 0];
    cur[2]++;
    tally.set(k, cur);
  }
  const sorted = [...tally.values()].sort((a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [pos, party, n] of sorted) vote[`${pos}_${party}`] = n;
  for (const pos of ["present", "not_voting"]) {     // the XML leaves <present/> and <absent/> empty when the count is 0
    if (members.length && vote[pos] === "") vote[pos] = String(members.filter((x) => x.position === pos).length);
  }
  vote.source_url = url;
  return [vote, members];
}

export function parseVoteXml(root: El, url: string): [Row, Row[]] {
  if (root.tag === "rollcall-vote") return parseHouse(root, url);
  if (root.tag === "roll_call_vote") return parseSenate(root, url);
  throw new DataError(`congress: ${url} is not a roll-call vote file`, "api");
}

export function parseSenateMenu(root: El, _url: string): Row[] {
  const year = t(root, "congress_year");
  const rows: Row[] = [];
  for (const v of root.findall("votes/vote")) {
    // an en bloc vote nests issue, question and result under <en_bloc><matter>
    const matters = v.findall("en_bloc/matter");
    const pick = (tag: string) => t(v, tag) || [...new Set(matters.map((m) => t(m, tag)).filter(Boolean))].join("; ");
    rows.push({ chamber: "senate", congress: t(root, "congress"), session: t(root, "session"),
      roll: String(pyInt(t(v, "vote_number") || 0)), date: isoDate(`${t(v, "vote_date")}-${year}`, ["%d-%b-%Y"]),
      issue: pick("issue"), question: pick("question"), result: pick("result"), en_bloc: matters.length ? String(matters.length) : "",
      yea: t(v, "vote_tally/yeas"), nay: t(v, "vote_tally/nays"), title: t(v, "title"),
      source_url: senateUrl(t(root, "congress"), t(root, "session"), t(v, "vote_number") || 0) });
  }
  return rows;
}

async function houseApiMembers(pack: Pack, congress: number, session: number, roll: unknown): Promise<Row[]> {
  const data = await gr.clientFor(pack).getJson(`/house-vote/${congress}/${session}/${pyInt(roll)}/members`, { format: "json" });
  const v = data.houseRollCallVoteMemberVotes || {};
  return (v.results || []).map((m: any) => {
    const cast = pyStr(m.voteCast ?? "");
    return { chamber: "house", congress: String(congress), session: String(session), roll: pyStr(roll),
      date: pyStr(v.startDate ?? "").slice(0, 10), member_id: m.bioguideID ?? "",
      name: pyStrip(`${pyStr(m.firstName ?? "")} ${pyStr(m.lastName ?? "")}`), party: m.voteParty ?? "",
      state: m.voteState ?? "", vote: cast, position: position(cast), vote_source: "api.congress.gov" };
  });
}

const yes = (v: unknown) => ["true", "1", "yes"].includes(pyStr(v ?? "").toLowerCase());

async function rollCall(pack: Pack, p: Record<string, any>): Promise<[Row[], string[]]> {
  const ch = pyStr(p.chamber).toLowerCase();
  // summary=true: one row for the vote itself (question, result, type, totals) instead of one per member
  const part = yes(p.summary) ? 0 : 1;
  if (ch === "senate") {
    const url = senateUrl(p.congress, p.session, p.roll);
    const got = parseSenate(await xml(url), url);
    return [part ? got[1] : [got[0]], []];
  }
  const year = pyInt(truthy(p.year) ? p.year : sessionYear(pyInt(p.congress), pyInt(p.session)));
  const url = houseUrl(year, p.roll);
  try {
    const got = parseHouse(await xml(url), url);
    return [part ? got[1] : [got[0]], []];
  } catch (e) {
    if (!(e instanceof DataError) || !part) throw e;
    const congress = pyInt(truthy(p.congress) ? p.congress : currentCongress([year, 6, 1]));
    const session = pyInt(truthy(p.session) ? p.session : year % 2 ? 1 : 2);
    if (congress < HOUSE_API_FIRST) throw e;
    const rows = await houseApiMembers(pack, congress, session, p.roll);
    return [rows, [`House Clerk file unavailable (${e.message}); member votes came from the Congress.gov house-vote API`]];
  }
}

async function billVotes(pack: Pack, req: SpecRequest): Promise<Row[]> {
  const p: Record<string, any> = { ...(req.params || {}) };
  if (pyStr(p.congress ?? "").toLowerCase() === "current") p.congress = currentCongress();
  const ep = eps().bill_actions;
  const params: Record<string, unknown> = { ...(ep.defaults || {}) };
  for (const k of ["congress", "billType", "billNumber"]) {
    if (!(k in p)) throw new DataError(`request ${pyRepr(req.name)}: bill_votes needs ${k}`, "bad_request");
    params[k] = p[k];
  }
  const [actions] = await gr.fetchRequest(pyJsonClient(gr.clientFor(pack), pack, ep.records), ep, params, 5000);
  const want = pyStr(p.chamber || "").toLowerCase();
  const seen = new Set<string>();
  const votes: [any, Row][] = [];
  for (const a of actions) {
    const rv = a.recordedVotes;
    for (const v of typeof rv === "string" && rv.startsWith("[") ? (parsePyJson(rv) as any[]) : []) {
      const url = pyStr(v.url || "");
      const ch = pyStr(v.chamber ?? "").toLowerCase();
      if (!url || seen.has(url) || (want && ch !== want)) continue;
      seen.add(url);
      votes.push([v, a]);
    }
  }
  votes.sort((x, y) => {
    const [dx, dy] = [pyStr(x[0].date ?? ""), pyStr(y[0].date ?? "")];
    if (dx !== dy) return dx < dy ? -1 : 1;
    return Number(x[0].rollNumber ?? 0) - Number(y[0].rollNumber ?? 0);
  });
  let rows: Row[] = [];
  const members = yes(p.members);
  for (const [v, a] of votes) {
    const [vote, mem] = parseVoteXml(await xml(v.url), v.url);
    const ctx = { bill: `${pyStr(p.congress)} ${pyStr(p.billType).toUpperCase()} ${pyStr(p.billNumber)}`,
      action_date: a.actionDate ?? "", action_text: a.text ?? "" };
    if (members) rows = rows.concat(mem.map((m) => ({ ...ctx, ...m })));
    else rows.push({ ...ctx, ...vote });
  }
  let keys: string[] = [];
  for (const r of rows) keys = keys.concat(Object.keys(r).filter((k) => !keys.includes(k)));
  const party = keys.filter((k) => /^(yea|nay|present|not_voting|other)_.+$/s.test(k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  keys = [...keys.filter((k) => !party.includes(k) && k !== "source_url"), ...party, ...(keys.includes("source_url") ? ["source_url"] : [])];
  return rows.map((r) => Object.fromEntries(keys.map((k) => [k, k in r ? r[k] : ""])));
}

// ---------------------------------------------------------------------- keys, manual route
function calls(spec: Spec): number {
  const e = eps();
  let n = 0;
  for (const r of spec.requests || []) {
    if (r.endpoint === "roll_call" || r.endpoint === "senate_votes") continue;   // official XML: no key, no quota
    const pg = (e[r.endpoint || ""] || {}).paging || {};
    const size = pyInt(pg.size || 250);
    n += pg.type === "offset" ? Math.max(1, Math.ceil(pyInt(r.max_rows || size) / size)) : 1;
  }
  return n;
}

const adapter: Adapter = {
  normalize,

  checkSpec(spec) {
    const probs: string[] = [];
    for (const r of spec.requests || []) {
      const p = r.params || {}, n = pyRepr(r.name ?? null);
      if (r.endpoint === "roll_call") {
        const ch = pyStr(p.chamber ?? "").toLowerCase();
        if (ch === "senate" && !(truthy(p.congress) && truthy(p.session))) probs.push(`request ${n}: a Senate roll_call needs congress and session`);
        if (ch === "house" && !(truthy(p.year) || (truthy(p.congress) && truthy(p.session)))) {
          probs.push(`request ${n}: a House roll_call needs year, or congress and session`);
        }
      }
      const c = p.congress;
      if (!(c === null || c === undefined || c === "" || c === "current") && !/^\d+$/.test(pyStr(c))) {
        probs.push(`request ${n}: congress must be a number or 'current'`);
      }
    }
    return probs;
  },

  beforeRequest(_req, _ep, params) {
    const out: Record<string, unknown> = { ...params };
    if (pyStr(out.congress ?? "").toLowerCase() === "current") out.congress = currentCongress();
    delete out.title_contains;
    // Congress.gov reads "introducedDate+asc" with a literal "+" (a space); sent encoded as %2B the sort is ignored
    if (typeof out.sort === "string") out.sort = pySplit(out.sort.split("+").join(" ")).join(" ");
    return out;
  },

  async fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
    const tables: Tables = {};
    let notes: string[] = [];
    const E = eps();
    for (const r of spec.requests) {
      const name = r.endpoint;
      if (!CUSTOM.includes(name || "")) {
        const hint = phraseOrderHint(r);
        let tt: Tables, n: string[];
        try {
          const client = pyJsonClient(gr.clientFor(pack), pack, (E[name || ""] || {}).records ?? "");
          [tt, n] = await internals.fetchSpec(pack, { requests: [r] }, client);
        } catch (e) {
          if (e instanceof DataError && hint && e.message.includes("returned no rows")) {
            throw new DataError(`${e.message} ${hint}`, e.kind);
          }
          throw e;
        }
        Object.assign(tables, tt);
        const got = tt[r.name];
        notes = notes.concat(n, hint && !(Array.isArray(got) ? got.length : got) ? [`${r.name}: no titles matched. ${hint}`] : []);
        const titleNote = displayTitleNote(r);
        if (titleNote && !notes.includes(titleNote)) notes.push(titleNote);   // for_each: once
        continue;
      }
      const p = r.params || {};
      let rows: Row[];
      if (name === "roll_call") {
        const [got, n] = await rollCall(pack, p);
        rows = got;
        notes = notes.concat(n);
      } else if (name === "senate_votes") {
        const url = senateMenuUrl(p.congress, p.session);
        rows = parseSenateMenu(await xml(url), url);
      } else rows = await billVotes(pack, r);
      if (!rows.length && !r.allow_empty) {
        throw new DataError(`request ${pyRepr(r.name)} returned no rows (no recorded votes, or a wrong roll number)`, "bad_request");
      }
      tables[r.name] = rows;
    }
    return [tables, notes];
  },

  keyOnlyNeeds(spec) {
    const n = calls(spec);
    return n > DEMO_LIMIT ? [`about ${n} Congress.gov API calls (the keyless DEMO_KEY allows only about 10 an hour)`] : [];
  },

  manualItems(spec, pack) {
    const items: any[] = [];
    for (const r of spec.requests || []) {
      const p = r.params || {}, name = r.name;
      try {
        if (r.endpoint === "roll_call") {
          const url = pyStr(p.chamber ?? "None").toLowerCase() === "senate" ? senateUrl(p.congress, p.session, p.roll)
            : houseUrl(truthy(p.year) ? p.year : sessionYear(pyInt(p.congress), pyInt(p.session)), p.roll);
          items.push({ name: `${name}#1`, request: name, url, filename: `${name}.xml`, needs_key: false, method: "GET", body: null,
            note: "official roll-call XML, no key" });
          continue;
        }
        if (r.endpoint === "senate_votes") {
          items.push({ name: `${name}#1`, request: name, url: senateMenuUrl(p.congress, p.session), filename: `${name}.xml`,
            needs_key: false, method: "GET", body: null, note: "Senate vote list XML, no key" });
          continue;
        }
      } catch {
        continue;
      }
      let rr: SpecRequest = r;
      if (r.endpoint === "bill_votes") {
        rr = { ...r, endpoint: "bill_actions", params: Object.fromEntries(Object.entries(p).filter(([k]) => ["congress", "billType", "billNumber"].includes(k))) };
      }
      if (pyStr((rr.params || {}).congress ?? "").toLowerCase() === "current") rr = { ...rr, params: { ...rr.params, congress: currentCongress() } };
      rr = { ...rr, params: Object.fromEntries(Object.entries(rr.params || {}).filter(([k]) => k !== "title_contains")) };
      for (const it of gr.manualItems(pack, { requests: [rr] })) {
        if (!it.url.includes("api_key=")) it.url += (it.url.includes("?") ? "&" : "?") + "api_key=DEMO_KEY";
        let note = "DEMO_KEY is api.data.gov's public demo key (about 10 requests an hour); replace it with your own key";
        if (r.endpoint === "bill_votes") {
          note = "the bill's actions; each recordedVotes entry links a vote XML file (clerk.house.gov or " +
            "senate.gov) to save as well, from a web browser if a script is refused; " + note;
        }
        it.note = (it.note ? it.note + "; " : "") + note;
        items.push(it);
      }
    }
    return items;
  },

  parseUpload(pack, req, files) {
    const ep = req.endpoint;
    const readXml = (f: string) => {
      try {
        return fromstring(fs.readFileSync(f));
      } catch (e) {
        if (e instanceof XmlParseError) throw new DataError(`congress: ${path.basename(f)} is not valid XML (${e.message})`, "api");
        throw e;
      }
    };
    if (ep === "roll_call" || ep === "senate_votes") {
      let rows: Row[] = [];
      for (const f of files) {
        const root = readXml(f);
        const summary = yes((req.params || {}).summary);
        rows = rows.concat(ep === "senate_votes" ? parseSenateMenu(root, path.basename(f))
          : summary ? [parseVoteXml(root, path.basename(f))[0]] : parseVoteXml(root, path.basename(f))[1]);
      }
      return rows;
    }
    if (ep === "bill_votes") {
      const rows: Row[] = [];
      for (const f of files) {
        if (f.toLowerCase().endsWith(".xml")) {
          rows.push(parseVoteXml(readXml(f), path.basename(f))[0]);
          continue;
        }
        const data: any = parsePyJson(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
        for (const a of data.actions || []) {
          for (const v of a.recordedVotes || []) {
            rows.push({ action_date: a.actionDate ?? "", chamber: pyStr(v.chamber ?? "").toLowerCase(), congress: v.congress ?? "",
              session: v.sessionNumber ?? "", roll: v.rollNumber ?? "", date: pyStr(v.date ?? "").slice(0, 10),
              source_url: v.url ?? "", action_text: a.text ?? "" });
          }
        }
      }
      const seen = new Set<unknown>();
      const out: Row[] = [];
      for (const r of rows) {                        // actions repeat each vote: keep one row per vote
        const k = truthy(r.source_url) ? r.source_url : r;
        if (!seen.has(k)) {
          seen.add(k);
          out.push(r);
        }
      }
      return out;
    }
    return gr.parseUpload(pack, req, files);
  },
};

export default adapter;
