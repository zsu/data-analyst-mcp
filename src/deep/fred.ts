/**
 * The fred deep pack: FRED, ALFRED (vintages) and GeoFRED (Federal Reserve Bank of St. Louis), ported from
 * sources/fred/fetch.py and fred_api.py.
 *
 * Routes: with a FRED_API_KEY the API (full metadata, source, copyright tag, every vintage kind, GeoFRED, the release
 * calendar and whole releases); without one FRED's own keyless graph downloads (fredgraph.csv / alfredgraph.csv /
 * fredgraph.xlsx: latest and as-of vintages, titles and units, no source or copyright), unless the spec needs a key-only
 * feature (then key_missing with the manual route). A rejected key or an API outage switches to the keyless downloads
 * when the spec needs no key-only feature (the result's route says which was taken, and a note says why). A folder
 * that already holds the same request is reused; when only labels, sources or copyright changed it is rebuilt from
 * data/fred/raw/ without downloading.
 *
 * Lookups (the Python --describe, --search, --vintagedates and --release-dates) go through request_schema search:
 *   "describe GDPC1 GDPPOT"            title, units, frequency, source, release, copyright (keyless: titles and units)
 *   "vintagedates GDPC1"               ALFRED revision dates (key)
 *   "release_dates [ID] [START] [END] [limit N]"   release calendar (key; 20 rows shown)
 *   anything else                      series search by popularity (key; "limit N" anywhere sets the count)
 *
 * Redistribution: policy.json `withhold` names series.csv's `copyright` column; series tagged preapproval_required are
 * withheld from shared files by the report step, and the README names them.
 */
import fs from "node:fs";
import path from "node:path";
import { mode, setupCommand } from "../core/env.js";
import { DataError } from "../core/http.js";
import type { DeepContext, DeepPack, DeepResult, Pack } from "../core/packs.js";
import * as pol from "../core/policy.js";
import { trail } from "../core/context.js";
import { readCsv } from "../core/tabular.js";
import {
  copyrightFromTag, copyrightStatus, findApiKey, FredClient, FredError, type FredKind, GRAPH_MAX, Keyless, KEY_URL, seriesUrl,
} from "./_fred_api.js";
import {
  coreManualItems, csvColumns, dataDir, existingData, fetchApi, fetchKeyless, fingerprint, ingest, keyOnlyNeeds,
  metaFingerprint, normSpec, type NSpec, packageData, type Packaged, releaseDateRows, repackage, seriesCopyrightTag,
} from "./_fred_pack.js";
import { isDigits } from "./_fred_py.js";

function spec(raw: any): NSpec {
  try {
    return normSpec(raw);
  } catch (e: any) {
    if (e instanceof DataError) throw e;
    throw new DataError(`spec: ${e?.message ?? e}`, "spec");
  }
}

/** The per-series FRED citations in series.csv (or "" when the spec has no series: the policy's citation applies). */
function seriesCitations(meta: Record<string, any>[]): string {
  return [...new Set(meta.map((m) => String(m.citation ?? "")).filter(Boolean))].join(" ");
}

function vintageOf(s: NSpec): string {
  return [...new Set(s.series.map((x) => x.vintage.kind + (x.vintage.dates.length ? ":" + x.vintage.dates.join(",") : "")))].join("; ");
}

function result(p: Packaged, s: NSpec, d: string, route: string, extra: string[] = []): DeepResult {
  return {
    data_dir: d,
    tables: p.req.tables.map((t: any) => ({ name: t.name, file: t.file, rows: t.rows, columns: p.columns[t.name] ?? [] })),
    notes: [...extra, ...p.req.notes], problems: p.req.problems, retrieved: p.req.retrieved,
    citation: seriesCitations(p.meta), vintage: vintageOf(s), route, files: [],
  };
}

/** The result for a folder that already holds this request (nothing downloaded). */
function reused(s: NSpec, d: string): DeepResult {
  const req = JSON.parse(fs.readFileSync(path.join(d, "request.json"), "utf8"));
  const tables = (req.tables || []).filter((t: any) => fs.existsSync(path.join(d, t.file)))
    .map((t: any) => ({ name: t.name, file: t.file, rows: t.rows, columns: csvColumns(path.join(d, t.file)) }));
  let cite = "";
  const sp = path.join(d, "series.csv");
  if (fs.existsSync(sp)) {
    cite = seriesCitations(readCsv(fs.readFileSync(sp, "utf8")) as any[]);
  }
  return { data_dir: d, tables, notes: [`Reusing data/fred/ (retrieved ${pol.localStamp(req.retrieved)} by the ${req.route} ` +
    "route); fetch with force: true to download again.", ...(req.notes || [])], problems: [], retrieved: req.retrieved,
    citation: cite, vintage: vintageOf(s), route: "reuse_existing", files: [] };
}

async function fetch(ctx: DeepContext): Promise<DeepResult> {
  const s = spec(ctx.spec);
  const out = ctx.workspace;
  const d = dataDir(out);
  const ex = existingData(out, fingerprint(s));
  if (ex && ex.csv_exists && ex.matches && !ex.problems.length && !ctx.force) {
    if (ex.meta_fingerprint !== metaFingerprint(s)) {
      const p = repackage(ctx.pack, s, out);
      return result(p, s, d, "reuse_existing", ["Labels, sources or copyright changed: data/fred/ was rebuilt from " +
        "data/fred/raw/ without downloading."]);
    }
    return reused(s, d);
  }
  const n0 = trail().length;
  const [key] = findApiKey();
  const needs = keyOnlyNeeds(s);
  const keyless: [string, string] = ["api_keyless", "FRED graph downloads (fredgraph.csv / alfredgraph.csv, no key)"];
  let parts, route: string, acquired: string;
  const extra: string[] = [];
  if (key) {
    try {
      parts = await fetchApi(s, new FredClient(key));
      [route, acquired] = ["api", "FRED API download"];
    } catch (e) {
      if (!(e instanceof FredError && FALLBACK.has(e.fk)) || needs.length) throw e;
      const why = e.message.split("\n")[0].slice(0, 300);
      extra.push(e.fk === "auth"
        ? `FRED rejected the stored key (${why}; check or renew it at ${KEY_URL}); this request needs nothing only the ` +
          "API provides, so it was downloaded without the key (keyless graph downloads). Tell the user about the key " +
          "problem in one line."
        : `The FRED API did not answer (${why}); this request needs nothing only the API provides, so it was downloaded ` +
          "without the key (keyless graph downloads).");
      parts = await fetchKeyless(s, new Keyless()).catch((k) => {
        if (!(k instanceof DataError)) throw k;
        throw new FredError(`${e.message}; the keyless graph downloads failed too: ${k.message}`, e.fk);
      });
      [route, acquired] = keyless;
    }
  } else {
    if (needs.length) throw new FredError("fred: this request needs a FRED_API_KEY key for: " + needs.join("; "), "key_missing");
    parts = await fetchKeyless(s, new Keyless());
    [route, acquired] = keyless;
  }
  const p = packageData(ctx.pack, parts, s, out, route, acquired, null, n0);
  if (route === "api_keyless") {
    extra.push((key ? "No working FRED API key" : "No FRED API key") + ": the keyless graph downloads were used (no " +
      "source, notes or copyright status per series; read each series page before sharing)." +
      (key ? "" : ` A free key (${KEY_URL}) adds them.`));
  }
  return result(p, s, d, route, extra);
}

/** API failures the keyless graph downloads can stand in for: a rejected key (key_rejected) or an API outage
 * (agency_unavailable). A request that needs a key-only feature still fails. */
const FALLBACK = new Set<FredKind>(["auth", "network", "rate", "unavailable", "http"]);

async function ingestFiles(ctx: DeepContext & { files: string[] }): Promise<DeepResult> {
  const s = spec(ctx.spec);
  if (!ctx.files.length) throw new DataError("ingest needs the uploaded files or a folder", "spec");
  const p = ingest(ctx.pack, ctx.files, s, ctx.workspace);
  return result(p, s, dataDir(ctx.workspace), "manual_download", ["Files downloaded by the user and uploaded, then " +
    "packaged: say so in the methods; the FRED API notice applies only to files that came from the API."]);
}

// --------------------------------------------------------------------------- lookups (request_schema search)
async function describe(ids: string[]): Promise<any[]> {
  const [key] = findApiKey();
  const out: any[] = [];
  if (key) {
    const c = new FredClient(key);
    for (const sid0 of ids) {
      const sid = sid0.toUpperCase();
      try {
        const m = await c.series(sid);
        const rel = await c.releaseOf(sid);
        const src = rel.id !== null && rel.id !== undefined ? await c.releaseSources(rel.id) : [];
        out.push({ series_id: sid, title: m.title ?? null, units: m.units ?? null, frequency: m.frequency ?? null,
          seasonal_adjustment: m.seasonal_adjustment ?? null, observation_start: m.observation_start ?? null,
          observation_end: m.observation_end ?? null, last_updated: m.last_updated ?? null, release: rel.name ?? null,
          source: src.map((z: any) => z.name ?? "").join("; "),
          copyright: copyrightFromTag(await seriesCopyrightTag(c, sid)) || copyrightStatus(m.notes, true),
          notes: [...String(m.notes || "")].slice(0, 400).join(""), url: seriesUrl(sid) });
      } catch (e: any) {
        if (!(e instanceof FredError)) throw e;
        out.push({ series_id: sid, error: e.message });
      }
    }
    return out;
  }
  const k = new Keyless();
  const meta = new Map<string, any>();
  const up = ids.map((x) => x.toUpperCase());
  for (let i = 0; i < up.length; i += GRAPH_MAX) for (const [sid, m] of (await k.metadata(up.slice(i, i + GRAPH_MAX)))[0]) meta.set(sid, m);
  for (const sid0 of ids) {
    const sid = sid0.toUpperCase();
    out.push({ series_id: sid, ...(meta.get(sid) || { error: "not found on FRED" }), source: "(needs a key, or read the series page)",
      copyright: "unknown", url: seriesUrl(sid), metadata_source: "fredgraph.xlsx (keyless)" });
  }
  return out;
}

function needsKey(what: string): any[] {
  const q = encodeURIComponent(what).replace(/%20/g, "+");
  return [{ status: "needs_key", message: "Search, vintage dates and the release calendar need a FRED API key. Without one, " +
    `search on the website: https://fred.stlouisfed.org/searchresults/?st=${q} (calendar: ` +
    "https://fred.stlouisfed.org/releases/calendar), and confirm each ID with request_schema search \"describe <IDs>\".",
    ...(mode() === "local" ? { run_command: setupCommand("fred") } : {}) }];
}

async function search(query: string, _pack: Pack): Promise<any[]> {
  let words = query.trim().split(/\s+/).filter(Boolean);
  let limit: number | null = null;
  const li = words.findIndex((w) => /^limit(=\d+)?$/i.test(w));
  if (li >= 0) {
    const n = words[li].includes("=") ? words[li].split("=")[1] : words[li + 1];
    if (n && isDigits(n)) {
      limit = Number(n);
      words.splice(li, words[li].includes("=") ? 1 : 2);
    }
  }
  const head = (words[0] || "").toLowerCase().replace(/:$/, "");
  if (head === "describe") {
    const ids = words.slice(1).flatMap((w) => w.split(",")).filter(Boolean);
    if (!ids.length) throw new DataError('describe needs series IDs, e.g. "describe GDPC1 GDPPOT"', "spec");
    return describe(ids);
  }
  const [key] = findApiKey();
  if (head === "vintagedates") {
    const sid = (words[1] || "").toUpperCase();
    if (!sid) throw new DataError('vintagedates needs a series ID, e.g. "vintagedates GDPC1"', "spec");
    if (!key) return needsKey(sid);
    const v = await new FredClient(key).vintagedates(sid);
    return [{ series_id: sid, n: v.length, first: v.slice(0, 5), last: v.slice(-5), all: v }];
  }
  if (head === "release_dates" || head === "release-dates") {
    const rest = words.slice(1);
    const id = rest.find((w) => !/^\d{4}-\d{2}-\d{2}$/.test(w));
    if (id !== undefined && !isDigits(id)) {
      throw new DataError(`release_dates takes a release ID (21 is H.6, 53 is GDP), not ${JSON.stringify(id)}; a series' ` +
        `vintages are "vintagedates ${id}"`, "spec");
    }
    const dates = rest.filter((w) => /^\d{4}-\d{2}-\d{2}$/.test(w));
    if (!key) return needsKey("release calendar");
    const rid = id ? Number(id) : null;
    const j = await new FredClient(key).releaseDates(rid, dates[0] ?? null, dates[1] ?? null, Math.min(limit ?? 100, 1000));
    const rows = releaseDateRows(j);
    return [{ release_id: rid, count: j.count ?? null, shown: Math.min(rows.length, 20), release_dates: rows.slice(0, 20),
      note: "Capped at 20 rows; put \"release_dates\" in the spec for the full list as a CSV. Common releases: 10 CPI, " +
        "50 Employment Situation, 53 GDP, 18 H.15 interest rates." }];
  }
  const text = words.join(" ");
  if (!key) return needsKey(text);
  const res = await new FredClient(key).search(text, Math.min(limit ?? 15, 100));
  return res.map((r) => Object.fromEntries(["id", "title", "units_short", "frequency_short", "seasonal_adjustment_short",
    "observation_start", "observation_end", "popularity"].map((k) => [k, r[k] ?? null])));
}

// --------------------------------------------------------------------------- request index and schemas
const LOOKUPS = {
  describe: 'request_schema search "describe GDPC1 GDPPOT": title, units, frequency, seasonal adjustment, source, release, copyright (keyless: titles and units only)',
  search: 'request_schema search "potential gdp [limit 15]": series by popularity (needs a key; without one the result links FRED\'s site search)',
  vintagedates: 'request_schema search "vintagedates GDPC1": the ALFRED dates a series was revised (needs a key)',
  release_dates: 'request_schema search "release_dates 50 2026-10-01 2026-12-31 [limit 5]": the release calendar, 20 rows shown (needs a key)',
};

const COMMON = {
  description: "what this fetch is for (README title)",
  start: "YYYY-MM-DD, global or per series", end: "YYYY-MM-DD or null (latest), global or per series",
  packaging_only: "per series: label, source (the agency, for the citation), copyright (public_domain | citation_required | " +
    "preapproval_required) with copyright_basis (what was read where); they do not change the download",
};

const SCHEMAS: Record<string, any> = {
  series: {
    summary: "Observations of FRED series (latest data) plus series.csv (title, units, frequency, source, release, copyright, citation)",
    needs_key: false,
    fields: { series: 'list of IDs or {"id", "label", ...per-series options}', ...COMMON,
      recessions: "true adds USREC (NBER recession indicator, monthly) for notes and chart shading",
      units: "FRED transformation: lin (default), chg, ch1, pch, pc1, pca, cch, cca, log (prefer your own computation)",
      frequency: "FRED-side conversion: d, w, bw, m, q, sa, a (with aggregation_method avg | sum | eop; it averages whatever exists)" },
    example: { description: "Output gap since 2007", series: [{ id: "GDPC1", label: "Real GDP" },
      { id: "GDPPOT", label: "Real potential GDP" }], start: "2007-01-01", recessions: true },
    output: "data/fred/fred_observations.csv (series_id, label, variant, vintage, date, value, realtime_start, realtime_end); " +
      "data/fred/series.csv (one row per series variant: n_missing, n_future = projections, fiscal_year, copyright, citation)",
  },
  vintage: {
    summary: "ALFRED vintages: as published on dates (as_of, keyless too), first_release or all (full revision history, key)",
    needs_key: "first_release and all only",
    fields: { vintage: '"latest" | {"as_of": ["YYYY-MM-DD", ...]} | "first_release" | "all", global or per series' },
    example: { description: "Real GDP 2020 Q2: first release vs. two later vintages", series: [
      { id: "GDPC1", start: "2020-04-01", end: "2020-04-01", vintage: "first_release" },
      { id: "GDPC1", start: "2020-04-01", end: "2020-07-01", vintage: { as_of: ["2020-08-27", "2021-07-29"] } }] },
    notes: ["an as-of vintage ends where that vintage's data ended (later dates are absent, not missing)",
      "units in series.csv are FRED's label today; compare growth rates across vintages, not levels"],
  },
  regional: {
    summary: "GeoFRED cross-section of a series group (states, counties, MSAs) on one date; needs a key",
    needs_key: true,
    fields: { regional: '[{"series_id": "CAUR" (any member) or "series_group", "region_type", "date", "start_date", "season", ' +
      '"units", "frequency", "aggregation_method", "transformation", "label"}]' },
    example: { description: "State unemployment rates, January 2025", regional: [{ series_id: "CAUR", region_type: "state",
      date: "2025-01-01", label: "State unemployment rates" }] },
    output: "data/fred/regional.csv (group, label, title, date, region, code, series_id, value, units, season, frequency)",
  },
  release_dates: {
    summary: "FRED's release calendar (scheduled dates included); needs a key",
    needs_key: true,
    fields: { release_dates: '{"release_id": 50, "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "limit": 10000} or a release ID; ' +
      "no release_id = every release between start and end (default the next 14 days)" },
    example: { description: "Employment Situation dates, 2026 Q4", release_dates: { release_id: 50, start: "2026-10-01",
      end: "2026-12-31" } },
    output: "data/fred/release_dates.csv (release_id, release_name, date)",
  },
  release_observations: {
    summary: "Every series of one release with its observations (FRED API v2, cursor-paged); needs a key",
    needs_key: true,
    fields: { release_observations: '[{"release_id": 53, "limit": 10000 (observations per page, 1-500000), "max_pages": 5 ' +
      '(1-50), "series": [IDs to keep], "label"}]' },
    example: { description: "GDP release, two pages", release_observations: [{ release_id: 53, limit: 10000, max_pages: 2 }] },
    output: "data/fred/release_series.csv (copyright tag per series) and release_observations.csv; the notes say when " +
      "max_pages stopped before the end",
  },
  lookups: {
    summary: "Series metadata, search, vintage dates and the release calendar, through request_schema search (no spec needed)",
    needs_key: "search, vintagedates and release_dates",
    search_forms: LOOKUPS,
  },
};

function schema(names: string[]): any[] {
  return names.map((n) => ({ name: n, ...SCHEMAS[n], lookups: LOOKUPS,
    routes: "with FRED_API_KEY: the API (source, notes, copyright tag); without: FRED's keyless graph downloads (latest and " +
      "as-of vintages only; copyright unknown), unless a key-only feature is asked (then key_missing). A rejected key or an API " +
      "outage falls back to the keyless downloads when nothing key-only is asked" }));
}

/** Which operations a spec uses (never throws: the gate calls it before the spec is checked). */
function uses(raw: any): string[] {
  const out: string[] = [];
  if (!raw || typeof raw !== "object") return out;
  const list = Array.isArray(raw.series) ? raw.series : [];
  const gv = raw.vintage;
  const isLatest = (v: unknown) => v === undefined || v === null || v === "" || v === "latest";
  if (list.length || raw.recessions) out.push("series");
  if ((list.length || raw.recessions) && (!isLatest(gv) || list.some((x: any) => x && typeof x === "object" && "vintage" in x &&
    !isLatest(x.vintage)))) out.push("vintage");
  if (Array.isArray(raw.regional) && raw.regional.length) out.push("regional");
  if (raw.release_dates) out.push("release_dates");
  if (Array.isArray(raw.release_observations) && raw.release_observations.length) out.push("release_observations");
  return out;
}

function checkSpec(raw: any): string[] {
  try {
    normSpec(raw);
    return [];
  } catch (e: any) {
    return [String(e?.message ?? e)];
  }
}

const pack: DeepPack = {
  operations: Object.entries(SCHEMAS).map(([name, s]) => ({ name, summary: s.summary })),
  schema,
  uses,
  specExample: SCHEMAS.series.example,
  search,
  checkSpec,
  fetch,
  ingest: ingestFiles,
  manualItems: (raw: any) => coreManualItems(spec(raw)),
};

export default pack;
