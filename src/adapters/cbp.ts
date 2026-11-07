/**
 * U.S. Customs and Border Protection nationwide encounter files. Verified 2026-11-07: the Nationwide Encounters
 * document page (www.cbp.gov/document/stats/nationwide-encounters) links monthly-replaced CSVs under
 * /sites/default/files/<yyyy-mm>/nationwide-encounters-fy..-..-<month>-aor.csv (by area of responsibility) and
 * ...-state.csv (by state). list_files reads that page; encounters reads one file, filtered here.
 */
import * as gr from "../core/generic-rest.js";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest, Tables } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v])
  .map((x) => pyStr(x).trim().toLowerCase()).filter(Boolean);

/** The encounter CSVs linked from the document page, newest first. */
export function filesOnPage(html: string): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const m of html.matchAll(/href="(?:https:\/\/www\.cbp\.gov)?\/sites\/default\/files\/([^"]*?nationwide-encounters[^"]*?)\.csv"/gi)) {
    const file = m[1];
    if (seen.has(file)) continue;
    seen.add(file);
    const by = /-aor$/i.test(file) ? "area of responsibility" : /-state$/i.test(file) ? "state" : "";
    const fy = /fy(\d{2})-fy(\d{2})/i.exec(file);
    out.push({ file, by, fiscal_years: fy ? `FY20${fy[1]}-FY20${fy[2]}` : "", url: `https://www.cbp.gov/sites/default/files/${file}.csv` });
  }
  // newest first: by the last fiscal year covered, then by path
  const key = (r: Row) => `${pyStr(r.fiscal_years).slice(-4)} ${pyStr(r.file).split("/").pop()}`;
  return out.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

async function fetch(spec: Spec, pack: Pack): Promise<[Tables, string[]]> {
  const lists = spec.requests.filter((r) => r.endpoint === "list_files");
  const rest = spec.requests.filter((r) => r.endpoint !== "list_files");
  const tables: Tables = {};
  const notes: string[] = [];
  if (lists.length) {
    const resp = await gr.clientFor(pack).request("GET", pack.endpoints.document_page, null);
    const rows = filesOnPage(resp.text());
    if (!rows.length) throw new DataError("the CBP document page lists no encounter CSV (the page changed?)", "api");
    for (const r of lists) tables[r.name] = rows;
  }
  if (rest.length) {
    const [t, n] = await gr.fetchSpec(pack, { ...spec, requests: rest });
    Object.assign(tables, t);
    notes.push(...n);
  }
  return [tables, notes];
}

const FILTERS: [string, string][] = [["region", "Land Border Region"], ["component", "Component"],
  ["fiscal_year", "Fiscal Year"], ["citizenship", "Citizenship"]];

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  if (req.endpoint !== "encounters") return rows;
  const wants = FILTERS.map(([k, c]) => [c, list(req.params?.[k])] as [string, string[]]).filter(([, v]) => v.length);
  return wants.length ? rows.filter((r) => wants.every(([c, v]) => v.includes(pyStr(r[c] ?? "").trim().toLowerCase()))) : rows;
}

function checkSpec(spec: Spec): string[] {
  return (spec.requests || []).filter((r) => r.endpoint === "encounters" && r.params?.file !== undefined &&
    !/^[\w./-]+$/.test(pyStr(r.params.file)) || (r.endpoint === "encounters" && /\.\./.test(pyStr(r.params?.file ?? ""))))
    .map((r) => `request ${JSON.stringify(r.name)}: file is a path from list_files, e.g. 2026-11/nationwide-encounters-fy24-fy27-oct-aor`);
}

const adapter: Adapter = { fetch, normalize, checkSpec };
export default adapter;
