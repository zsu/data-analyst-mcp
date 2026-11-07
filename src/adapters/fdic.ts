/**
 * FDIC BankFind adapter.
 *
 * - Each record arrives as {"data": {...fields...}, "score": n, "highlight": {...}}; normalize() unwraps it so columns
 *   are the FDIC field names (CERT, NAME, ASSET, ...), not "data.CERT".
 * - Dates come in three shapes: FAILDATE "7/17/2026" (M/D/YYYY), institutions REPDTE "06/30/2026", financials REPDTE
 *   "20260630", history EFFDATE "2010-03-20T00:00:00". The published column is kept and an <col>_iso column
 *   (YYYY-MM-DD) is added.
 * - Manual links ask for format=csv so a browser saves a spreadsheet; the core upload reader reads either form.
 * - checkError: FDIC answers a bad parameter with HTTP 400 {"errors": [{"detail": ...}]}; the detail is surfaced by
 *   the client already, so only an "errors" list inside HTTP 200 is caught here.
 */
import * as gr from "../core/generic-rest.js";
import type { Adapter, Pack, Row, Spec, SpecRequest } from "../core/packs.js";
import { parseQsl, pyStr, pyUrlencode, urlsplit, urlunsplit } from "../core/py.js";

const DATE_COLS = ["FAILDATE", "REPDTE", "EFFDATE", "ESTYMD", "ENDEFYMD", "PROCDATE", "RUNDATE", "DATEUPDT", "RISDATE"];

function repr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v !== "string") return pyStr(v);
  return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function iso(v: unknown): string {
  const s = pyStr(v || "").trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3].padStart(4, "0")}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4}-\d{2}-\d{2})(T.*)?$/.exec(s);
  return m ? m[1] : "";
}

function checkError(_status: number, body: Buffer): string | null {
  if (body.subarray(0, 1).toString("latin1") === "{" && body.subarray(0, 200).includes('"errors"')) {
    try {
      const errs: any[] = JSON.parse(body.toString("utf8")).errors || [];
      return errs.map((e) => pyStr(e?.detail || e?.title || e)).join("; ") || null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalize(_req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  return rows.map((r) => {
    const n: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === "score" || k.startsWith("highlight.")) continue;
      n[k.startsWith("data.") ? k.slice(5) : k] = v;
    }
    for (const c of DATE_COLS) if (c in n && n[c] !== "" && n[c] !== null && n[c] !== undefined) n[`${c}_iso`] = iso(n[c]);
    return n;
  });
}

function manualItems(spec: Spec, pack: Pack): any[] {
  const items = gr.manualItems(pack, spec);
  for (const it of items) {
    const parts = urlsplit(it.url);
    const q: [string, string][] = [...parseQsl(parts.query), ["format", "csv"]];
    it.url = urlunsplit({ ...parts, query: pyUrlencode(q) });
    it.filename = String(it.filename).replace(/\.json$/, ".csv");
  }
  return items;
}

function checkSpec(spec: Spec): string[] {
  const probs: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    if (!p.fields && ["financials", "institutions", "demographics"].includes(r.endpoint || "")) {
      probs.push(`request ${repr(r.name ?? null)}: set params.fields (e.g. 'CERT,NAME,REPDTE,ASSET,DEP'); ` +
        "without it every row carries hundreds of columns");
    }
  }
  return probs;
}

function search(query: string, pack: Pack, limit = 20): any[] {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1);
  const hits: [number, any][] = [];
  for (const [f, d] of Object.entries<any>(pack.endpoints?.fields || {})) {
    const text = `${f} ${pyStr(d)}`.toLowerCase();
    const s = words.reduce((n, w) => n + text.split(w).length - 1, 0);
    if (s) hits.push([s, { field: f, description: d }]);
  }
  const out = [...gr.searchCatalog(pack, query, limit), ...hits.sort((a, b) => b[0] - a[0]).map(([, h]) => h)];
  return out.slice(0, limit);
}

const adapter: Adapter = { checkError, normalize, manualItems, checkSpec, search };
export default adapter;
