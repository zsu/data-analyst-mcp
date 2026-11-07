/**
 * Senate lobbying (LDA.gov) pack hooks.
 *
 * - checkSpec: the Filings and Contribution Reports endpoints refuse to page without at least one filter.
 * - beforeRequest: issue_code is not an API filter; it is removed here and applied to the downloaded activities in
 *   normalize. Filter names that /clients/ and /registrants/ silently ignore (state, client_id, registrant_id) are
 *   sent under the names those endpoints filter on (ALIASES).
 * - normalize: filing_activities -> one row per lobbying activity; contributions -> one row per contribution item;
 *   filings get is_amendment / is_termination flags derived from filing_type (values unchanged). First, every list
 *   is cut to one row per filing (filing_uuid) or record (id): a filter on what a filing holds makes the API return
 *   the filing once per matching item. fetch notes how many repeats were dropped.
 */
import * as gr from "../core/generic-rest.js";
import type { Client } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { parsePyJson, pyStr } from "../core/py.js";
import { pyJsonClient } from "./_govinfo_json.js";
import { pyRepr, truthy } from "./_govinfo_py.js";

const PAGED_FILTERED = ["/filings/", "/contributions/"];
const NOT_FILTERS = new Set(["page_size", "ordering", "issue_code"]);

// filter names the list endpoints ignore without an error, mapped to the real ones
const ALIASES: Record<string, Record<string, string>> = { "/clients/": { state: "client_state", client_id: "id" },
  "/registrants/": { registrant_id: "id" } };

function load(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (!truthy(v)) return [];
  try {
    const x = parsePyJson(String(v));
    return x as any;
  } catch {
    return [];
  }
}

function flags(row: Row): Row {
  const ft = pyStr(row.filing_type ?? "");
  row.is_amendment = ft === "RA" || (ft.length > 1 && "A@".includes(ft[1]));
  row.is_termination = ft.includes("T") || ft.includes("@");
  return row;
}

function names(lobbyists: any[] | null | undefined): string {
  const out: string[] = [];
  for (const l of lobbyists || []) {
    const p = (l || {}).lobbyist || {};
    const name = [p.first_name, p.middle_name, p.last_name].filter((x) => truthy(x)).map(pyStr).join(" ");
    out.push(name || pyStr((l || {}).lobbyist_full_display_name || ""));
  }
  return out.filter(Boolean).join("; ");
}

const BASE = ["filing_uuid", "filing_type", "filing_type_display", "filing_year", "filing_period", "dt_posted",
  "registrant.id", "registrant.name", "client.id", "client.name", "client.client_id", "income", "expenses", "filing_document_url"];

// filters on what a filing holds: the API joins to those items and returns the filing once per match
const NESTED = new Set(["filing_specific_lobbying_issues", "lobbyist_name", "lobbyist_covered_position", "foreign_entity_name",
  "foreign_entity_country", "affiliated_organization_name", "lobbyist_conviction_disclosure_indicator",
  "foreign_entity_listed_indicator", "contribution_contributor", "contribution_payee", "contribution_honoree",
  "contribution_type", "contribution_amount_min", "contribution_amount_max", "contribution_date_after",
  "contribution_date_before", "lobbyist_id"]);
const UNIQUE: Record<string, string> = { "/filings/": "filing_uuid", "/contributions/": "filing_uuid", "/registrants/": "id",
  "/clients/": "id", "/lobbyists/": "id" };
// request (or for_each group) -> [rows the API sent, distinct records, key, nested filters]
const REPEATS = new Map<string, [number, number, string, string[]]>();

/** The rows with each filing (or registrant, client, lobbyist) once, in the API's order. */
function onePerRecord(req: SpecRequest, ep: any, rows: Row[]): Row[] {
  const col = UNIQUE[ep.path ?? ""];
  if (!col || !rows.length || rows.some((r) => !(col in r))) return rows;
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of rows) {
    const k = JSON.stringify([typeof r[col], r[col]]);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  if (out.length < rows.length) {
    const key = req._group || req.name || "";
    if (!REPEATS.has(key)) REPEATS.set(key, [0, 0, col, []]);
    const got = REPEATS.get(key)!;
    got[0] += rows.length;
    got[1] += out.length;
    got[3].push(...Object.keys(req.params || {}).filter((k) => NESTED.has(k) && !got[3].includes(k)));
  }
  return out;
}

function repeatNotes(): string[] {
  const out: string[] = [];
  const fmt = (n: number) => n.toLocaleString("en-US");
  for (const [name, [sent, kept, col, filters]] of REPEATS) {
    const why = filters.length ? ` (here: ${filters.join(", ")})` : "";
    const unit = col === "filing_uuid" ? "filings" : "records";
    out.push(`${name}: the LDA API sent ${fmt(sent)} rows for ${fmt(kept)} distinct ${unit}: a filter on what a filing ` +
      `holds${why} returns a filing once per matching activity, lobbyist or item. The ${fmt(sent - kept)} ` +
      `repeats were dropped (one row per ${col} before any per-activity or per-item rows), so counts and ` +
      "income/expense sums are per filing. The API's own count (and max_rows) counts the repeats too.");
  }
  return out;
}

const pick = (o: any, k: string) => (o && k in o ? o[k] : "");

const adapter: Adapter = {
  checkSpec(spec) {
    const probs: string[] = [];
    for (const r of spec.requests || []) {
      if (["filings", "filing_activities", "contributions"].includes(r.endpoint || "")) {
        if (!Object.entries(r.params || {}).some(([k, v]) => !NOT_FILTERS.has(k) && v !== null && v !== undefined && v !== "")) {
          probs.push(`request ${pyRepr(r.name ?? null)}: LDA needs at least one filter (filing_year, registrant_name, ` +
            "client_name, ...) to page past the first 25 results");
        }
      }
    }
    return probs;
  },

  beforeRequest(_req, ep, params) {
    const out: Record<string, unknown> = Object.fromEntries(Object.entries(params).filter(([k]) => k !== "issue_code"));
    for (const [old, neu] of Object.entries(ALIASES[ep.path ?? ""] || {})) {
      if (old in out) {
        const v = out[old];
        delete out[old];
        if (!(neu in out)) out[neu] = v;
      }
    }
    return out;
  },

  /** generic-rest, with the repeat notes; `client` replaces the pack's client (tests). */
  async fetch(spec: Spec, pack: Pack, _route: string, client?: Client): Promise<[Tables, string[]]> {
    REPEATS.clear();
    const [tables, notes] = await gr.fetchSpec(pack, spec, client ?? pyJsonClient(gr.clientFor(pack), pack));
    notes.push(...repeatNotes());
    REPEATS.clear();
    return [tables, notes];
  },

  normalize(req, ep, rows0) {
    const rows = onePerRecord(req, ep, rows0);
    const p = String(ep.path ?? "");
    if (!PAGED_FILTERED.includes(p) && !p.startsWith("/filings/{")) return rows;
    const name = req.endpoint;
    if (name === "filing_activities") {
      const want = pyStr((req.params || {}).issue_code || "").toUpperCase();
      const out: Row[] = [];
      for (const r of rows) {
        const base = flags(Object.fromEntries(BASE.map((k) => [k, pick(r, k)])));
        for (const a of load(r.lobbying_activities)) {
          const code = pyStr(a.general_issue_code || "").toUpperCase();
          if (want && code !== want) continue;
          const ents = a.government_entities || [];
          out.push({ ...base, general_issue_code: code, general_issue_code_display: pick(a, "general_issue_code_display"),
            description: pick(a, "description"), foreign_entity_issues: pick(a, "foreign_entity_issues"),
            lobbyist_count: (a.lobbyists || []).length, lobbyists: names(a.lobbyists),
            government_entities: ents.map((e: any) => pyStr(pick(e || {}, "name"))).join("; ") });
        }
      }
      return out;
    }
    if (name === "contributions") {
      const out: Row[] = [];
      const cols = ["filing_uuid", "filing_type", "filing_year", "filing_period", "filer_type", "dt_posted", "registrant.id",
        "registrant.name", "lobbyist.id", "lobbyist.first_name", "lobbyist.last_name", "no_contributions", "filing_document_url"];
      for (const r of rows) {
        const base = Object.fromEntries(cols.map((k) => [k, pick(r, k)]));
        const items = load(r.contribution_items);
        if (!items.length) {
          out.push({ ...base, contribution_type: "", contributor_name: "", payee_name: "", honoree_name: "", amount: "", date: "" });
        }
        for (const it of items) {
          out.push({ ...base, ...Object.fromEntries(["contribution_type", "contributor_name", "payee_name", "honoree_name",
            "amount", "date"].map((k) => [k, pick(it, k)])) });
        }
      }
      return out;
    }
    if (name === "filings") return rows.map((r) => flags({ ...r }));
    return rows;
  },
};

export default adapter;
