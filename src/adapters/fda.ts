/**
 * openFDA adapter (api.fda.gov).
 *
 * - Datasets live at /<category>/<noun>.json (drug/event, device/recall, ...). The spec names one with
 *   "dataset" (catalog alias such as drug_event, or the path "drug/event"); beforeRequest splits it into the
 *   two path parts, so URLs keep a plain slash.
 * - openFDA answers a search that matches nothing with HTTP 404 {"error": {"code": "NOT_FOUND", "message":
 *   "No matches found!"}}; fetch() turns that into a clear "no records match" error, or an empty table when
 *   the request sets "allow_empty": true. Other 404 answers carry their own message ("Nothing to count"); fetch()
 *   reads 404 bodies and reports openFDA's message for those.
 * - Paging: limit <= 1000 and skip <= 25,000, so a search returns at most 26,000 records. Count requests return
 *   at most 1,000 terms; without a key, count limit=1000 answers HTTP 403 on some datasets while limit=999 works,
 *   so fetch() sends keyless counts with limit at most 999. A term count as long as the limit is reported as cut.
 * - Errors inside a body ({"error": {...}}) are reported with openFDA's code and message.
 */
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import * as gr from "../core/generic-rest.js";
import { Client, DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { readJson } from "../core/policy.js";
import { pyStr } from "../core/py.js";
import { pyInt, pyRepr, stripChars } from "./_govinfo_py.js";

const HERE = path.join(PACKS_DIR, "fda");
const MAX_SKIP = 25000;
const COUNT_MAX = 1000;                 // count terms with a key
const COUNT_MAX_KEYLESS = 999;          // without a key, limit=1000 is refused (HTTP 403) on drug/event and device/event
const NO_MATCH = "No matches found";

function catalog(): Record<string, any> {
  return readJson(HERE, "endpoints.json")?.catalog || {};
}

function paths(): Set<string> {
  return new Set(Object.values(catalog()).map((c: any) => c.id));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The limit a count request is sent with: the spec's (default 1000), at most 999 without a key. */
export function countLimit(req: SpecRequest, keyed: boolean): number {
  let lim: number;
  try {
    const v = (req.params || {}).limit;
    lim = pyInt(v === undefined ? COUNT_MAX : v);
  } catch {
    lim = COUNT_MAX;
  }
  return keyed ? lim : Math.min(lim, COUNT_MAX_KEYLESS);
}

/** The core client raises a bare "not found" on HTTP 404 and drops openFDA's message; this wrapper asks it to hand
 * 404 bodies to checkError, so the error carries openFDA's own code and message. */
function read404(client: Client): Client {
  const w = Object.create(client) as Client;
  w.request = async (method, p, params, o = {}) => {
    const r = await client.request(method, p, params, { ...o, allow404: o.allow404 ?? true });
    if (r.status === 404) throw new DataError(`fda: not found (HTTP 404) ${r.url.split("?")[0]}`, "not_found", 404);
    return r;
  };
  return w;
}

const adapter: Adapter = {
  checkError(_status, body) {
    if (body.subarray(0, 1).toString("latin1") === "{" && body.subarray(0, 300).includes('"error"')) {
      let err: any;
      try {
        err = JSON.parse(body.toString("utf8")).error || {};
      } catch {
        return null;
      }
      if (err && typeof err === "object" && err.message) return `${pyStr(err.code ?? "FDA_ERROR")}: ${pyStr(err.message)}`;
    }
    return null;
  },

  beforeRequest(_req, _ep, params) {
    const p: Record<string, unknown> = { ...params };
    let ds = stripChars(pyStr(p.dataset || ""), "/");
    delete p.dataset;
    if (ds.endsWith(".json")) ds = ds.slice(0, -5);
    const cat = catalog();
    if (ds in cat) ds = cat[ds].id;
    if (ds.includes("/")) {
      const i = ds.indexOf("/");
      [p.category, p.noun] = [ds.slice(0, i), ds.slice(i + 1)];
    }
    const s = p.search;
    if (typeof s === "string") {                  // the "+AND+" style also works: make it plain spaces
      p.search = s.split("+AND+").join(" AND ").split("+OR+").join(" OR ").split("+NOT+").join(" NOT ");
    }
    return p;
  },

  checkSpec(spec) {
    const probs: string[] = [];
    const cat = catalog(), known = paths();
    for (const r of spec.requests || []) {
      const name = pyRepr(r.name);
      const prm = r.params || {};
      let ds = stripChars(pyStr(("dataset" in prm ? prm.dataset : r.dataset) || ""), "/");
      if (ds.endsWith(".json")) ds = ds.slice(0, -5);
      if (!ds) probs.push(`request ${name}: parameter 'dataset' is required (alias such as drug_event, or drug/event)`);
      else if (!(ds in cat) && !known.has(ds)) {
        probs.push(`request ${name}: dataset ${pyRepr(ds)} is not an openFDA dataset (aliases: ${Object.keys(cat).sort(cmp).join(", ")})`);
      }
      if (r.endpoint === "count") {
        try {
          if (pyInt("limit" in prm ? prm.limit : 1000) > 1000) probs.push(`request ${name}: count limit cannot exceed 1000`);
        } catch {
          probs.push(`request ${name}: limit must be a number`);
        }
      }
      if (r.endpoint === "search" && pyInt(prm.skip || 0) > MAX_SKIP) {
        probs.push(`request ${name}: skip cannot exceed ${MAX_SKIP} (openFDA limit); narrow the search, ` +
          "e.g. by date range, and make several requests");
      }
    }
    return probs;
  },

  async fetch(spec: Spec, pack: Pack, _route: string): Promise<[Tables, string[]]> {
    const client = gr.clientFor(pack);
    const keyed = !!client.key;
    const wrapped = read404(client);
    const tables: Tables = {};
    let notes: string[] = [];
    for (let r of spec.requests) {
      let sent: number | null = null;
      if (r.endpoint === "count") {
        sent = countLimit(r, keyed);
        r = { ...r, params: { ...(r.params || {}), limit: sent } };
      }
      let t: Tables, n: string[];
      try {
        [t, n] = await gr.fetchSpec(pack, { ...spec, requests: [r] }, wrapped);
      } catch (e) {
        if (!(e instanceof DataError)) throw e;
        const msg = e.message;
        if (e.status === 404 && !msg.includes(NO_MATCH) && e.kind !== "not_found") {
          const hint = r.endpoint === "count" && msg.includes("Nothing to count")
            ? " The field cannot be counted in this dataset: check its name, and try it without (or with) .exact." : "";
          const i = msg.indexOf("fda: ");
          throw new DataError(`request ${pyRepr(r.name)}: openFDA answered HTTP 404: ${i < 0 ? msg : msg.slice(i + 5)}.${hint}`,
            "bad_request");
        }
        if (e.kind === "not_found" || e.status === 404) {
          if (r.allow_empty) {
            tables[r.name] = [];
            notes.push(`${r.name}: openFDA found no matching records (empty table kept: allow_empty).`);
            continue;
          }
          throw new DataError(`request ${pyRepr(r.name)}: openFDA found no records matching the search (HTTP 404 ` +
            "'No matches found'). Check field names and values; .exact fields need the whole term " +
            "exactly as stored (drug names are upper-case).", "bad_request");
        }
        throw e;
      }
      const rows = (t[r.name] || []) as Row[];
      if (sent !== null && sent >= COUNT_MAX_KEYLESS && rows.length >= sent && "term" in rows[0]) {
        notes.push(`${r.name}: stopped at ${rows.length.toLocaleString("en-US")} terms (openFDA's count limit` +
          (keyed ? "" : "; 999 without a key") + "); the least frequent terms are cut off. " +
          "Narrow the search to rank within a subset.");
      }
      Object.assign(tables, t);
      notes = notes.concat(n);
    }
    return [tables, notes];
  },

  manualItems(spec, pack) {
    // the links are opened without a key, so count links ask for at most 999 terms
    const reqs = (spec.requests || []).map((r) =>
      r.endpoint === "count" ? { ...r, params: { ...(r.params || {}), limit: countLimit(r, false) } } : r);
    const items = gr.manualItems(pack, { ...spec, requests: reqs });   // core applies beforeRequest to the links
    for (const it of items) {
      it.note = ((it.note ? it.note.replace(/\.+$/, "") + ". " : "") + "Without a key openFDA allows 1,000 requests a day per IP; whole " +
        "datasets are at https://open.fda.gov/data/downloads/ (zipped JSON).").trim();
    }
    return items;
  },
};

export default adapter;
