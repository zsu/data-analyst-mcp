/**
 * NHTSA adapter (port of the Python adapter.py): date columns in a sortable form, vPIC (second host) manual links,
 * model variants.
 *
 * Variants (recalls_by_vehicle, complaints_by_vehicle): NHTSA files hybrid, EV and cab-style versions under their
 * own model names, each with its own recalls and complaints, which the plain name does not return. A name that
 * starts with the requested one can also be a different model, so nothing is merged unasked: the fetch lists the
 * make's models for that year (products_models, issueType r or c, one call per make and year) and notes the other
 * names that start with the requested model. With `"variants": true` it also fetches the names whose extra words
 * are only powertrain, body, cab, door or drive qualifiers, keeps each campaign / complaint once, and adds
 * `model_requested`. Recall names sometimes drop a parenthesized cab style, so that form is tried too. A name
 * that matches nothing answers HTTP 400 (Count 0): an empty result for that name, with a note. A 5xx is not a
 * "no record": the name is reported as not answered (the table is marked incomplete), and the fetch fails only
 * when no vehicle lookup answered at all (the source is down).
 *
 * Recalls publish ReportReceivedDate as DD/MM/YYYY, complaints publish dateOfIncident and dateComplaintFiled as
 * MM/DD/YYYY. The published columns are kept; an *_iso column is added.
 */
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const DMY = ["ReportReceivedDate"];
const MDY = ["dateOfIncident", "dateComplaintFiled"];

/** Python repr() of a str. */
function repr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n").replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t") + q;
}
const truthy = (v: unknown) => !(v === null || v === undefined || v === "" || v === 0 || v === false);
const pad = (n: number, w: number) => String(n).padStart(w, "0");

function iso(v: unknown, order: "dmy" | "mdy"): string {
  const parts = (truthy(v) ? pyStr(v) : "").trim().split("/");
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return "";
  const [a, b, y] = parts.map((p) => parseInt(p, 10));
  const [d, m] = order === "dmy" ? [a, b] : [b, a];
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900 && y < 2200)) return "";
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

function normalize(_req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  for (const r of rows) {
    for (const col of DMY) if (col in r) r[col + "_iso"] = iso(r[col], "dmy");
    for (const col of MDY) if (col in r) r[col + "_iso"] = iso(r[col], "mdy");
  }
  return rows;
}

/** Generic links, except that vPIC endpoints have an absolute path on another host. */
function manualItems(spec: Spec, pack: Pack): any[] {
  const items = gr.manualItems(pack, spec);
  const base = String(pack.endpoints?.base_url || "").replace(/\/+$/, "");
  for (const it of items) {
    for (const scheme of ["https://", "http://"]) {
      const bad = `${base}/${scheme}`;
      if (it.url.startsWith(bad)) it.url = scheme + it.url.slice(bad.length);
    }
  }
  return items;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p: Record<string, any> = r.params || {};
    const vin = p.vin;
    if (r.endpoint === "vin_decode" && truthy(vin) && pyStr(vin).length > 17) {
      probs.push(`request ${repr(String(r.name))}: a VIN has at most 17 characters`);
    }
    const y = p.modelYear;
    if (y !== null && y !== undefined && y !== "" && !/^\d+$/.test(pyStr(y))) {
      probs.push(`request ${repr(String(r.name))}: modelYear must be a single year such as 2019 ` +
        "(one request per year for a range)");
    }
  }
  return probs;
}

const VEHICLE: Record<string, [string, string]> = { recalls_by_vehicle: ["r", "NHTSACampaignNumber"],
  complaints_by_vehicle: ["c", "odiNumber"] };

const key = (s: unknown) => (truthy(s) ? pyStr(s) : "").replace(/\s+/g, " ").trim().toUpperCase();

const QUALIFIERS = new Set(["HYBRID", "HEV", "PHEV", "PLUG-IN", "PLUGIN", "EV", "BEV", "ELECTRIC", "DIESEL", "GAS", "FFV",
  "CNG", "SEDAN", "COUPE", "HATCH", "HATCHBACK", "WAGON", "CONVERTIBLE", "VAN", "CAB", "CREW", "SUPER", "REGULAR",
  "DOUBLE", "EXTENDED", "QUAD", "ACCESS", "KING", "LONG", "SHORT", "BED", "AWD", "FWD", "RWD", "2WD", "4WD",
  "4X4", "4X2", "SWB", "LWB"]);
const DOORS = /^\d-?(DR|DOOR)$/;

/** True when the words after the base name only say powertrain, body, cab, door or drive (brackets count as a
 * cab or body style). */
function qualifierOnly(rest: string): boolean {
  const words = rest.replace(/\([^)]*\)/g, " ").replace(/,/g, " ").split(/\s+/).filter(Boolean);
  return !!rest.trim() && words.every((w) => QUALIFIERS.has(w) || DOORS.test(w));
}

/** Listed names that start with the base (next character a space or "("), each once in listed order, split into
 * [qualifier-only variants, other names]. */
export function prefixed(base: string, listed: string[]): [string[], string[]] {
  const b = key(base);
  const seen = new Set([b]);
  const variants: string[] = [], others: string[] = [];
  for (const n of listed) {
    const k = key(n);
    if (seen.has(k) || !(k.startsWith(b) && [" ", "("].includes(k.slice(b.length, b.length + 1)))) continue;
    seen.add(k);
    (qualifierOnly(k.slice(b.length)) ? variants : others).push(n);
  }
  return [variants, others];
}

export function forms(name: string, recalls: boolean): string[] {
  const out = [name];
  const bare = name.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (recalls && bare && key(bare) !== key(name)) out.push(bare);
  return out;
}

type State = { models: Map<string, string[]>; err5xx?: DataError; answered?: boolean };

async function models(c: Client, pack: Pack, p: Record<string, unknown>, issue: string, state: State): Promise<string[]> {
  const k = JSON.stringify([key(p.make), pyStr(p.modelYear), issue]);
  if (!state.models.has(k)) {
    const mep = pack.endpoints.endpoints.products_models;
    let listed: Row[];
    try {
      // without max the API sends only its first page of about 20 names, cut before many models and their
      // variants: ask for all
      [listed] = await gr.fetchRequest(c, mep, { modelYear: p.modelYear, make: p.make, issueType: issue, ...(mep.defaults || {}) });
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      listed = []; // the list only suggests names: never fail a fetch for it
    }
    state.models.set(k, listed.map((x) => ("model" in x ? (x.model as string) : "")));
  }
  return state.models.get(k)!;
}

async function vehicle(c: Client, pack: Pack, r: SpecRequest, ep: any, params: Record<string, unknown>, notes: string[],
  state: State): Promise<Row[]> {
  const [issue, idcol] = VEHICLE[r.endpoint!];
  const p = Object.fromEntries(Object.entries(params).filter(([k]) => k !== "variants"));
  const [variants, others] = prefixed(p.model as string, await models(c, pack, p, issue, state));
  const want = ["true", "1", "yes", "on"].includes(pyStr("variants" in params ? params.variants : "").trim().toLowerCase());
  const names = [p.model as string, ...(want ? variants : [])];
  let rows: Row[] = [];
  const seen = new Set<unknown>();
  const matched: string[] = [], unmatched: string[] = [], failed: string[] = [];
  for (const n of names) {
    let got: Row[] | null = null, err: number | null = null;
    for (const form of forms(n, issue === "r")) {
      try {
        [got] = await gr.fetchRequest(c, ep, { ...p, model: form }, r.max_rows);
        break;
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        const st = e.status;
        if (e.kind === "http" && [500, 502, 503, 504].includes(st ?? 0)) err = st!;
        else if (!(e.kind === "bad_request" && st === 400)) throw e;
      }
    }
    if (got === null) {
      (err ? failed : unmatched).push(err ? `${n} (HTTP ${err})` : n);
      if (err) state.err5xx = new DataError(`nhtsa: HTTP ${err} after retries for every vehicle lookup`, "http", err);
      continue;
    }
    state.answered = true;
    const fresh = got.filter((x) => !(truthy(x[idcol]) && seen.has(x[idcol])));
    for (const x of got) if (truthy(x[idcol])) seen.add(x[idcol]);
    for (const x of fresh) x.model_requested = n;
    rows = rows.concat(fresh);
    matched.push(`${n} (${fresh.length})`);
  }
  const label = `${pyStr(p.make)} ${pyStr(p.model)} ${pyStr(p.modelYear)}`;
  const what = issue === "r" ? "campaign" : "complaint";
  if (names.length > 1 && matched.length) {
    notes.push(`${r.name}: ${label} with its powertrain/body variants (variants: true); rows per name, each ` +
      `${what} once: ${matched.join(", ")}` + (unmatched.length ? `; no record under: ${unmatched.join(", ")}` : ""));
  }
  if (failed.length) {
    notes.push(`${r.name}${gr.INCOMPLETE} NHTSA gave no answer for ${failed.join(", ")} after retries (a 5xx ` +
      "can be an outage or, for 502, a name with no record): those rows are missing. Fetch again " +
      "(--force) later.");
  } else if (!matched.length) {
    notes.push(`${r.name}: no vehicle matched ${label} (HTTP 400, Count 0): the name is spelled differently ` +
      "there or that model year has no records. Kept as an empty table; list the names with " +
      `products_models (issueType ${issue}) and fetch again.`);
  }
  const rest = [...others, ...(want ? [] : variants)];
  if (rest.length) {
    notes.push(`${r.name}: NHTSA also lists ${rest.join(", ")} for ${pyStr(p.make)} ${pyStr(p.modelYear)}: separate ` +
      `model names with their own ${what}s, not included. Add a request for each one the question ` +
      "covers" + (want || !variants.length ? "" : ' (or "variants": true for the powertrain/body versions)') + ".");
  }
  return normalize(r, ep, rows);
}

/** The fetch with a given client (the tests pass a fake one). */
export async function fetchWith(c: Client, spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const tables: Tables = {};
  let notes: string[] = [];
  const rest: SpecRequest[] = [];
  const state: State = { models: new Map() };
  for (const r of spec.requests) {
    if (!(r.endpoint && r.endpoint in VEHICLE)) {
      rest.push(r);
      continue;
    }
    const [ep, params, probs] = gr.resolve(pack, r);
    if (probs.length) throw new DataError(probs.join("; "), "bad_request");
    tables[r.name] = await vehicle(c, pack, r, ep, params, notes, state);
  }
  if (state.err5xx && !state.answered) throw state.err5xx; // nothing answered: the source is down, not a name
  if (rest.length) {
    const [t, n] = await gr.fetchSpec(pack, { ...spec, requests: rest }, c);
    Object.assign(tables, t);
    notes = notes.concat(n);
  }
  const out: Tables = {};
  for (const r of spec.requests) if (r.name in tables) out[r.name] = tables[r.name];
  return [out, notes];
}

/** Vehicle lookups run here (variants, a non-matching name is a note); every other request goes through the
 * generic fetch, so its paging and empty-result rules apply. */
async function fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
  return fetchWith(gr.clientFor(pack), spec, pack);
}

const adapter: Adapter = { normalize, manualItems, checkSpec, fetch, fetchWith, prefixed, forms };
export default adapter;
