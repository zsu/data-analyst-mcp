/**
 * Bureau of Justice Statistics. NCVS Select records from api.ojp.gov (Socrata-style SODA) and report table packages
 * (zips of CSVs) from bjs.ojp.gov, both read by core; this adapter keeps requests off the site's bot check.
 *
 * Verified 2026-11-07: plain filtered queries ($where, $select of columns, $limit/$offset) answer JSON; any
 * aggregate ($select with sum(), count(*), with or without $group) gets a Cloudflare "Just a moment..." challenge
 * page (HTTP 403, which core reports as "blocked", or 200 HTML) instead. checkSpec refuses aggregates before a
 * request is sent, and checkError names an HTTP 200 challenge page. The challenge is never answered: aggregate the
 * rows with compute.
 */
import type { Adapter, Spec } from "../core/packs.js";
import { pyStr } from "../core/py.js";

const AGGREGATE = /\(|\*/;

function checkSpec(spec: Spec): string[] {
  const bad: string[] = [];
  for (const r of spec.requests || []) {
    if ((r.endpoint ?? "query") !== "query") continue;
    const p = r.params || {};
    if ("$group" in p || "$having" in p || AGGREGATE.test(pyStr(p.$select ?? ""))) {
      bad.push(`request ${JSON.stringify(r.name)}: BJS's API answers aggregate queries (sum, count, $group) with a bot ` +
        "check, not data. Select plain columns (e.g. \"year, newcrime, newoff, newwgt\") with a $where filter and sum the " +
        "weights with compute.");
    }
  }
  return bad;
}

function checkError(status: number, body: Buffer): string | null {
  const head = body.subarray(0, 4096).toString("latin1");
  if (/<title>Just a moment|challenges\.cloudflare\.com|cf-chl/i.test(head)) {
    return `BJS's site answered with a bot-check page (HTTP ${status}) instead of data. Aggregate queries always get ` +
      "it; for a plain query, wait a minute and fetch again with fewer requests, or use manual_bundle to download the " +
      "file in a browser.";
  }
  return null;
}

const adapter: Adapter = { checkSpec, checkError };
export default adapter;
