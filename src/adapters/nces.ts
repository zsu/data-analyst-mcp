/**
 * National Center for Education Statistics: Digest of Education Statistics tables (Excel) and IPEDS complete data
 * files (zipped CSV), read by core (published-table reader, $zip with "prefer" for the revised _rv file).
 * Verified 2026-11-07: nces.ed.gov serves both to scripts; Digest files are
 * /programs/digest/d<yy>/tables/xls/tabn<table>.xlsx (not every table is in every edition: a missing one is 404).
 * This adapter checks the spec and filters IPEDS rows by UNITID or state.
 */
import type { Adapter, Row, Spec, SpecRequest } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v])
  .map((x) => pyStr(x).trim().toUpperCase()).filter(Boolean);

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    const p = r.params || {};
    const tag = `request ${JSON.stringify(r.name)}`;
    if (r.endpoint === "digest_table") {
      if (p.edition !== undefined && !/^\d{2}$/.test(pyStr(p.edition))) bad.push(`${tag}: edition is two digits, e.g. 25`);
      if (p.table !== undefined && !/^\d{3}\.\d{2,3}$/.test(pyStr(p.table))) bad.push(`${tag}: table looks like 203.10`);
    }
    if ((r.endpoint === "ipeds" || r.endpoint === "ipeds_dictionary") && p.file !== undefined && !/^[A-Za-z0-9_]+$/.test(pyStr(p.file))) {
      bad.push(`${tag}: file is an IPEDS file name such as HD2023 or C2023_A`);
    }
  }
  return bad;
}

function normalize(req: SpecRequest, _ep: any, rows: Row[]): Row[] {
  if (req.endpoint !== "ipeds") return rows;
  const ids = list(req.params?.unitid), states = list(req.params?.state);
  if (!ids.length && !states.length) return rows;
  return rows.filter((r) => (!ids.length || ids.includes(pyStr(r.UNITID ?? "").trim())) &&
    (!states.length || states.includes(pyStr(r.STABBR ?? "").trim().toUpperCase())));
}

const adapter: Adapter = { checkSpec, normalize };
export default adapter;
