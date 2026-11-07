/**
 * CDC WONDER query results, uploaded as WONDER exports them. Manual only.
 *
 * wonder.cdc.gov answers this client's requests (the API controller and the help pages) with HTTP 403 (verified
 * 2026-11-07), so refusedHosts sends every request to manual_bundle. The WONDER API would also need each query
 * to accept the data use restrictions; on the web site the user reads and accepts them, which is the user's
 * decision to make.
 *
 * parseUpload reads the export (Export button, tab-delimited .txt). The layout was not checked against a real
 * export here, so the reader is defensive:
 * - the header is the first line; the rows run to the line "---", after which WONDER writes its notes (kept in
 *   raw/, not in the table);
 * - "Suppressed", "Unreliable" and "Not Applicable" stay as text;
 * - a file without a header line fails with a clear message.
 */
import fs from "node:fs";
import path from "node:path";
import { DataError } from "../core/http.js";
import type { Adapter, Pack, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";
import { columnsOf, decodeText, tsvRecords, withColumns } from "../core/tabular.js";

const HOME = "https://wonder.cdc.gov/";
const REFUSED = "wonder.cdc.gov answers this client with HTTP 403 (verified 2026-11-07), and its API needs each " +
  "query to accept CDC WONDER's data use restrictions, which is the user's own decision: use manual_bundle. The " +
  "user runs the query on the WONDER site (accepting the restrictions there), exports the result as a " +
  "tab-delimited .txt and uploads it; then ingest";

const refusedHosts = (_spec: Spec): string => REFUSED;

function checkSpec(spec: Spec): string[] {
  return (spec.requests || []).filter((r) => !pyStr(r.params?.database ?? "").trim())
    .map((r) => `request ${JSON.stringify(r.name)}: name the WONDER database the query ran on (database)`);
}

function manualItems(spec: Spec, _pack: Pack): any[] {
  return (spec.requests || []).map((r) => {
    const db = pyStr(r.params?.database ?? ""), q = pyStr(r.params?.query ?? "");
    return { name: `${r.name}#1`, request: r.name, url: HOME, filename: `${r.name}.txt`, also_ext: [".txt", ".tsv"],
      needs_key: false, method: "GET", body: null,
      note: `open in a web browser, choose ${db || "the database"}, read and accept its data use restrictions, ` +
        (q ? `set the query (${q}), ` : "set Group By and the filters, ") +
        "click Send, then Export and save the tab-delimited .txt. Upload it as saved." };
  });
}

/** The table part of a WONDER export (the lines before "---"). */
export function exportRows(text: string): Row[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const end = lines.findIndex((l) => l.replace(/"/g, "").trim() === "---");
  const table = (end >= 0 ? lines.slice(0, end) : lines).join("\n");
  return tsvRecords({ header_row: 1 }, table);
}

function parseUpload(_pack: Pack, req: SpecRequest, files: string[]): Row[] {
  const rows: Row[] = [];
  const order: string[] = [];
  for (const f of [...files].sort()) {
    const got = exportRows(decodeText(fs.readFileSync(f)));
    const cols = columnsOf(got) || (got[0] ? Object.keys(got[0]) : []);
    if (!got.length || cols.length < 2 || /<html/i.test(cols.join(" "))) {
      throw new DataError(`${path.basename(f)}: not a WONDER export (no tab-delimited header line). On the results ` +
        "page click Export and save the .txt file.", "bad_request");
    }
    for (const c of cols) if (!order.includes(c)) order.push(c);
    rows.push(...got);
  }
  const out = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? "" : v])));
  return withColumns(out, order);
}

const adapter: Adapter = { refusedHosts, checkSpec, manualItems, parseUpload };
export default adapter;
