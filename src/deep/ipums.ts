/**
 * IPUMS microdata extracts (USA/ACS, CPS, NHIS, MEPS, ...): the deep pack (port of the Python skill's
 * sources/ipums/fetch.py and ipums_api.py). Define, submit, wait for, download and package one extract.
 *
 * spec (converted to the IPUMS API v2 body):
 *   {"collection": "usa", "description": "Prime-age employment by nativity",
 *    "samples": ["us2013a", "us2018a", "us2023a"],
 *    "variables": ["AGE", "SEX", "CITIZEN", "EDUCD", "EMPSTAT", "INCWAGE", "PERWT"],
 *    "case_selections": {"AGE": {"min": 25, "max": 54}, "SEX": ["1"]},
 *    "case_select_who": "individuals", "attached_characteristics": {"EDUCD": ["spouse"]},
 *    "data_quality_flags": ["INCWAGE"], "adjust_monetary_values": ["INCWAGE"],
 *    "max_wait_s": 600}          // optional: how long one fetch waits for IPUMS (then fetch again to collect)
 * Output (data/ipums/): ipums_extract.csv (never shared: definition_only), codebook.csv, variables.csv, the DDI
 * .xml, extract_spec.json (the definition, to reproduce), request.json and README.md.
 * A fetch reuses data/ipums/ when it already holds this extract, and collects an extract submitted earlier (its
 * number is saved in extract_spec.json) instead of submitting again; force: true resubmits.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";
import { trail } from "../core/context.js";
import { Client, DataError, type ErrorKind } from "../core/http.js";
import * as keys from "../core/keys.js";
import { dataDir, fingerprint } from "../core/package.js";
import type { DeepContext, DeepPack, DeepResult, Pack } from "../core/packs.js";
import { pyJsonDumps, sleep, urlsplit } from "../core/py.js";
import { writeCsv } from "../core/tabular.js";
import { KEY_ENV, SOURCE, texts } from "./_ipums_bundle.js";
import { parseDdi } from "./_ipums_ddi.js";

export { DOWNLOAD_SCRIPTS, sampleLabel, webSection, writeDownloadScripts, writeManualBundle, writeReproduceBundle } from "./_ipums_bundle.js";
export { parseDdi } from "./_ipums_ddi.js";

const BASE = "https://api.ipums.org";
const VERSION = "2";
const AUTH: keys.Auth = { env: KEY_ENV, home: "ipums", placement: "header", param: "Authorization", prefix: "", required: "required" } as keys.Auth;
const HINTS: Record<number, string> = {
  401: "401 Unauthorized. The key is wrong, or the account is not registered for this collection " +
    "(each collection, e.g. usa.ipums.org or cps.ipums.org, has its own registration and terms of use).",
  403: "403 Forbidden. The account may not have access to this collection or sample.",
  429: "429 Too Many Requests. Rate limited by IPUMS; wait and retry.",
};
const ALL_STATUSES = Array.from({ length: 500 }, (_, i) => i + 100);
export const SELECTABLE = ["usa", "cps", "ipumsi"]; // collections with case selection and monetary adjustment
const DEFAULT_WAIT_S = 600;

const pad = (n: number) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const commas = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** An IpumsError: kind auth / network / http / key_missing, and "other" (failed, canceled, expired, checksum). */
const ipumsError = (msg: string, kind: "auth" | "network" | "http" | "key_missing" | "other" = "other") =>
  new DataError(msg, (kind === "other" ? "unexpected" : kind) as ErrorKind);
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

// --------------------------------------------------------------------------- spec -> API body
function codes(sel: any): string[] {
  if (isObj(sel) && ("min" in sel || "max" in sel)) {
    const lo = Math.trunc(Number(sel.min ?? 0)), hi = Math.trunc(Number(sel.max));
    const width = Math.trunc(Number(sel.width ?? 0));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(width)) {
      throw new TypeError("min and max must be whole numbers");
    }
    const out: string[] = [];
    for (let v = lo; v <= hi; v++) out.push(String(v).padStart(width, "0"));
    return out;
  }
  if (Array.isArray(sel)) return sel.map(String);
  throw new TypeError(`Bad case selection ${JSON.stringify(sel)}: use a list of codes or {'min':..,'max':..}`);
}

/** What is wrong with the spec before anything is sent (fix_spec). */
export function specProblems(spec: any): string[] {
  if (!isObj(spec)) return ["spec.json must be a JSON object"];
  const bad: string[] = [];
  if (typeof spec.collection !== "string" || !spec.collection) bad.push('"collection" is required (usa, cps, ipumsi, atus, nhis, meps, ...)');
  for (const k of ["samples", "variables"]) if (!Array.isArray(spec[k]) || !spec[k].length) bad.push(`"${k}" must be a non-empty list`);
  for (const [name, sel] of Object.entries<any>(spec.case_selections || {})) {
    if (isObj(sel) && "detailed" in sel) continue;
    try {
      codes(sel);
    } catch (e: any) {
      bad.push(`case_selections.${name}: ${e.message}`);
    }
  }
  if (![undefined, null, "individuals", "households"].includes(spec.case_select_who)) {
    bad.push('"case_select_who" must be "individuals" or "households"');
  }
  const c = spec.collection;
  if (typeof c === "string" && c && !SELECTABLE.includes(c)) { // IPUMS would refuse the extract with HTTP 400
    const only = `is available only for ${SELECTABLE.join(", ")}`;
    if ((spec.case_selections && Object.keys(spec.case_selections).length) || spec.case_select_who) {
      bad.push(`"case_selections" ${only}: remove it (and "case_select_who"), keep the selection variables ` +
        `in "variables", and select the group in analysis on the whole ${c} file with a domain mask ` +
        "(share_z / mean_z): dropping rows first loses design information for standard errors");
    }
    if (spec.adjust_monetary_values?.length) {
      bad.push(`"adjust_monetary_values" ${only}: remove it; there is no CPI99 for ${c}, so deflate in ` +
        "analysis with the BLS CPI-U annual average (cite the series) and state the dollar year");
    }
  }
  const lim = typeof c === "string" ? texts().API_LIMITS[c] : null;
  if (lim) {
    for (const k of lim.unsupported) {
      const v = spec[k];
      if (v && !(Array.isArray(v) && !v.length) && !(isObj(v) && !Object.keys(v).length)) bad.push(`"${k}" is not supported by the IPUMS API for ${c}: remove it`);
    }
    const ds = spec.data_structure || {};
    const on = isObj(ds) ? (ds.rectangular || {}).on : null;
    if (on && !lim.rect_on.includes(on)) {
      bad.push(`"data_structure" rectangular on '${on}' is not available for ${c} ` +
        `(use ${lim.rect_on.map((x: string) => `'${x}'`).join(" or ")}, or {"hierarchical": {}})`);
    }
  }
  if (spec.max_wait_s !== undefined && !(Number(spec.max_wait_s) > 0)) bad.push('"max_wait_s" must be a number of seconds');
  return bad;
}

export function buildBody(spec: any): any {
  const variables: Record<string, any> = {};
  const names: string[] = spec.variables.map((v: string) => String(v).toUpperCase());
  const up = (o: any) => Object.fromEntries(Object.entries<any>(o || {}).map(([k, v]) => [k.toUpperCase(), v]));
  const cs = up(spec.case_selections), ac = up(spec.attached_characteristics);
  const dq = spec.data_quality_flags || [];
  const adj = new Set((spec.adjust_monetary_values || []).map((v: string) => String(v).toUpperCase()));
  for (const extra of [...Object.keys(cs), ...Object.keys(ac)]) if (!names.includes(extra)) names.push(extra); // must be in the extract
  for (const name of names) {
    const v: Record<string, any> = {};
    if (name in cs) {
      const sel = cs[name];
      v.caseSelections = isObj(sel) && "detailed" in sel ? { detailed: sel.detailed.map(String) } : { general: codes(sel) };
    }
    if (name in ac) v.attachedCharacteristics = ac[name];
    if (dq === true || (Array.isArray(dq) && dq.map((d: string) => String(d).toUpperCase()).includes(name))) v.dataQualityFlags = true;
    if (adj.has(name)) v.adjustMonetaryValues = true;
    variables[name] = v;
  }
  const body: any = { description: String(spec.description ?? "extract via data-analyst").slice(0, 250),
    dataStructure: spec.data_structure || { rectangular: { on: "P" } }, dataFormat: spec.data_format ?? "csv",
    samples: Object.fromEntries(spec.samples.map((s: string) => [s, {}])), variables };
  if (spec.case_select_who) body.caseSelectWho = spec.case_select_who;
  return body;
}

/** Rough persons per sample, for a size warning before submitting. */
export function approxRows(samples: string[]): number {
  const R = texts().APPROX_ROWS;
  let n = 0;
  for (const s of samples) {
    if (s.startsWith("us")) n += s.endsWith("c") ? R.usa_acs5 : R.usa_acs1;
    else if (s.startsWith("cps") && s.endsWith("_03s")) n += R.cps_asec;
    else if (s.startsWith("cps")) n += R.cps_monthly;
    else if (/^ih\d{4}$/.test(s)) n += Number(s.slice(2)) >= 2019 ? R.nhis : R.nhis_pre2019;
    else if (/^mp\d{4}$/.test(s)) n += R.meps;
    else n += 500_000;
  }
  return n;
}

/** Hash of the API request body: two specs that would produce the same extract hash the same. */
export const specFingerprint = (body: any) => sha(pyJsonDumps(body, true)).slice(0, 16);

// --------------------------------------------------------------------------- API client
export class IpumsClient {
  http: Client;
  key: string;
  constructor(apiKey?: string | null, timeout = 120) {
    const [k] = apiKey ? [apiKey] : keys.findAuthKey(AUTH);
    if (!k) {
      throw ipumsError(`No IPUMS API key found. Looked in: ${keys.keyLocations(KEY_ENV, "ipums").join("; ")}. Get a key at ` +
        "https://account.ipums.org/api_keys, then store it with the setup command; it is read at once (no restart needed).",
      "key_missing");
    }
    keys.remember(k);
    this.key = k;
    this.http = new Client(BASE, { name: "IPUMS", auth: AUTH, key: k, rps: 1.5, burst: 5, retries: 4, timeout,
      deadline: 900, headers: { "Content-Type": "application/json" } });
  }
  toString(): string {
    return "IpumsClient(key=[REDACTED])";
  }
  toJSON(): string {
    return this.toString();
  }

  /** One cheap metadata call: {reachable, auth_ok, kind, detail}; never throws. */
  async ping(collection = "usa"): Promise<{ reachable: boolean; auth_ok: boolean | null; kind: string; detail: string }> {
    try {
      await this.request("GET", "/metadata/samples", { collection, pageSize: 1 }, undefined, 1);
      return { reachable: true, auth_ok: true, kind: "ok", detail: "" };
    } catch (e: any) {
      const reachable = e.kind !== "network";
      return { reachable, auth_ok: reachable ? false : null, kind: e.kind === "unexpected" ? "other" : e.kind,
        detail: String(e.message).split("\n")[0].slice(0, 300) };
    }
  }

  async request(method: string, p: string, params: Record<string, unknown> = {}, body?: unknown, retries = 4): Promise<any> {
    const q = { ...params };
    if (!("version" in q)) q.version = VERSION;
    this.http.retries = retries;
    let r;
    try {
      r = await this.http.request(method, p, q, { jsonBody: body, okStatuses: ALL_STATUSES });
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      const kind = e.kind === "network" ? "network" : e.kind === "auth" || e.kind === "key_missing" ? "auth" : "http";
      throw ipumsError(`${method} ${p} ${kind === "network" ? "network error" : "failed"}: ${e.message}`, kind);
    }
    if (r.status >= 200 && r.status < 300) return r.body.toString("utf8").trim() ? r.json() : {};
    const detail = r.body.subarray(0, 2000).toString("utf8");
    throw ipumsError(`${method} ${p} failed: HTTP ${r.status}. ${HINTS[r.status] ?? ""}\n${detail}`,
      r.status === 401 || r.status === 403 ? "auth" : "http");
  }

  /** [{name: "us2023a", description: "2023 ACS"}, ...]. */
  async listSamples(collection: string): Promise<{ name: string; description: string }[]> {
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const r = await this.request("GET", "/metadata/samples", { collection, pageNumber: page, pageSize: 500 });
      out.push(...(r.data || []));
      if (!r.links?.nextPage || !r.data?.length) return out;
    }
  }

  async submit(collection: string, definition: any): Promise<number> {
    const r = await this.request("POST", "/extracts", { collection }, definition, 1);
    return Math.trunc(Number(r.number));
  }

  info(collection: string, number: number): Promise<any> {
    return this.request("GET", `/extracts/${number}`, { collection });
  }

  /** Poll until completed (10 s, then up to 60 s apart). Throws on failed, canceled, expired or timeout. */
  async wait(collection: string, number: number, maxWaitS: number): Promise<any> {
    const start = Date.now();
    let delay = 10;
    for (;;) {
      const info = await this.info(collection, number);
      const status = info.status;
      if (status === "completed") {
        if (info.downloadLinks && Object.keys(info.downloadLinks).length) return info;
        // an expired extract stays "completed" but loses its links: waiting will not bring them back
        throw ipumsError(`Extract ${collection}#${number} is complete but its files have expired (IPUMS deletes them about ` +
          "72 hours after they are built). Submit it again: call fetch with the same spec and force: true.");
      }
      if (status === "failed" || status === "canceled") {
        const errs = info.errors || info.errorMessages || "";
        throw ipumsError(`Extract ${collection}#${number} ${status}. ${typeof errs === "string" ? errs : JSON.stringify(errs)}`);
      }
      if ((Date.now() - start) / 1000 > maxWaitS) {
        throw new DataError(`Timed out after ${maxWaitS}s waiting for extract ${collection}#${number} (last status ${status}). ` +
          "IPUMS is still building it: call fetch again with the same spec later; it collects this extract (its number is " +
          "saved in data/ipums/extract_spec.json) instead of submitting a new one.", "http");
      }
      await sleep(delay * 1000);
      delay = Math.min(60, delay + 10);
    }
  }

  /** One extract file to dest (atomic), checking the SHA-256 IPUMS reports. Streamed when live. */
  async download(url: string, dest: string, sha256?: string): Promise<string> {
    const tmp = dest + ".part";
    let digest: string;
    if (process.env.DATA_ANALYST_FIXTURES || keys.restricted()) {
      let r;
      try {
        r = await this.http.request("GET", url, null, { okStatuses: [200] });
      } catch (e: any) {
        const kind = e?.kind === "network" ? "network" : e?.kind === "auth" || e?.kind === "key_missing" ? "auth" : "http";
        throw ipumsError(`Download failed for ${url}: ${e?.message || e}`, kind);
      }
      fs.writeFileSync(tmp, r.body);
      digest = sha(r.body);
    } else digest = await this.stream(url, tmp);
    if (sha256 && digest !== sha256) {
      fs.rmSync(tmp, { force: true });
      throw ipumsError(`Checksum mismatch for ${url}`);
    }
    fs.renameSync(tmp, dest);
    return dest;
  }

  /** Stream a download to disk; the key goes only to the IPUMS host (never past a redirect to another host). */
  private async stream(url: string, tmp: string): Promise<string> {
    const host = urlsplit(url).netloc.toLowerCase();
    let cur = url;
    let resp: globalThis.Response | null = null;
    try {
      for (let hop = 0; hop < 10; hop++) {
        const same = urlsplit(cur).netloc.toLowerCase() === host && cur.startsWith("https://");
        resp = await globalThis.fetch(cur, { headers: { "User-Agent": this.http.ua, ...(same ? { Authorization: this.key } : {}) },
          redirect: "manual", signal: AbortSignal.timeout(this.http.timeout * 1000 * 30) });
        const loc = resp.headers.get("location");
        if (![301, 302, 303, 307, 308].includes(resp.status) || !loc) break;
        await resp.arrayBuffer().catch(() => undefined);
        cur = new URL(loc, cur).toString();
      }
    } catch (e: any) {
      throw ipumsError(`Download failed for ${keys.redact(url)}: ${keys.redact(e?.cause?.code || e?.message || e)}`, "network");
    }
    if (!resp || resp.status !== 200 || !resp.body) {
      throw ipumsError(`Download failed for ${keys.redact(url)}: HTTP ${resp?.status}`,
        resp && (resp.status === 401 || resp.status === 403) ? "auth" : "http");
    }
    const h = createHash("sha256");
    const fd = fs.openSync(tmp, "w");
    let n = 0;
    try {
      for await (const chunk of resp.body as any as AsyncIterable<Uint8Array>) {
        h.update(chunk);
        fs.writeSync(fd, chunk);
        n += chunk.length;
      }
    } finally {
      fs.closeSync(fd);
    }
    const digest = h.digest("hex");
    trail().push({ method: "GET", url: keys.redact(url), status: 200, bytes: n, sha256: digest, cached: false,
      fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00") });
    return digest;
  }
}

/** Key check for setup: one cheap authenticated metadata call. [true, detail] when IPUMS accepts the key; a
 * rejected key throws a DataError of kind "auth", an unreachable host kind "network". */
export async function verify(key: string): Promise<[boolean | null, string]> {
  const c = new Client(BASE, { name: "IPUMS", auth: AUTH, key, retries: 1, timeout: 30, deadline: 60 });
  const r = await c.get("/metadata/samples", { collection: "usa", version: "2", pageSize: 1 });
  const data = r.body.toString("utf8").trim() ? r.json() : {};
  if (isObj(data) && data.data !== undefined && data.data !== null) {
    return [true, "IPUMS accepted the key (metadata call answered). Register for each collection you use (usa, cps, ...)."];
  }
  return [null, "IPUMS answered, but not with the expected metadata; the key could not be confirmed."];
}

// --------------------------------------------------------------------------- package
type Ctx = { pack: Pack; out: string };

/** Lines of a file (plain or gzip, by content) as raw text, each with its line end. */
async function* fileLines(p: string): AsyncGenerator<string> {
  const fd = fs.openSync(p, "r");
  const magic = Buffer.alloc(2);
  fs.readSync(fd, magic, 0, 2, 0);
  fs.closeSync(fd);
  const s = fs.createReadStream(p, { highWaterMark: 1 << 20 });
  const src = magic[0] === 0x1f && magic[1] === 0x8b ? s.pipe(zlib.createGunzip()) : s;
  const dec = new StringDecoder("utf8");
  let rest = "";
  for await (const c of src) {
    const parts = (rest + dec.write(c as Buffer)).split(/(?<=\n)/);
    rest = parts.pop() || "";
    yield* parts;
  }
  rest += dec.end();
  if (rest) yield rest;
}

function csvHeaderCells(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  const s = line.replace(/\r?\n$/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') (cur += '"', i++);
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") (out.push(cur), (cur = ""));
    else cur += c;
  }
  out.push(cur);
  return out;
}

function writeRequestJson(d: string, spec: any, body: any, number: unknown, route: string, acquired: string, files: any[],
  problems: string[] = []): string {
  const retrieved = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const req = { source: SOURCE, spec, fingerprint: fingerprint(spec), route, acquired, retrieved, vintage: "",
    extract: `${spec.collection ?? ""}:${number}`,
    requests: trail().filter((s) => s.url.includes("/extracts") || s.url.includes("/downloads/")),
    tables: files, problems, notes: [texts().TERMS_LINE], policy: { redistribution: "definition_only", cache: "run_only" },
    api_body_sha256: sha(pyJsonDumps(body, true)) };
  fs.writeFileSync(path.join(d, "request.json"), JSON.stringify(req, null, 2));
  return retrieved;
}

/** Turn a data file (.csv or .csv.gz) and its DDI into the data/ipums/ package. */
export async function packageFiles(c: Ctx, collection: string, number: number | string, dataPath: string,
  ddiPath: string | null, spec: any, body: any, o: { client?: IpumsClient; removeSource?: boolean; acquired?: string;
    route?: string; notes?: string[] } = {}): Promise<DeepResult> {
  const t = texts();
  const route = o.route ?? "api", acquired = o.acquired ?? "IPUMS API download";
  const d = dataDir(c.out, SOURCE);
  fs.mkdirSync(d, { recursive: true });
  // Decompress the data to a plain CSV (what most tools expect) and count rows.
  const csvPath = path.join(d, "ipums_extract.csv");
  const tmpPath = csvPath + ".part";
  let nrows = 0;
  let columns: string[] = [];
  const fd = fs.openSync(tmpPath, "w");
  try {
    let buf: string[] = [];
    for await (const line of fileLines(dataPath)) {
      if (!columns.length && nrows === 0 && !buf.length && columns.length === 0 && line !== undefined && !(columns as any).done) {
        columns = csvHeaderCells(line).map((x) => x.trim().toUpperCase());
        (columns as any).done = true;
        fs.writeSync(fd, columns.join(",") + "\n");
        continue;
      }
      buf.push(line);
      nrows++;
      if (buf.length >= 10000) {
        fs.writeSync(fd, buf.join(""));
        buf = [];
      }
    }
    if (buf.length) fs.writeSync(fd, buf.join(""));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, csvPath);
  if (o.removeSource && path.resolve(dataPath) !== path.resolve(csvPath)) fs.rmSync(dataPath, { force: true });

  if (ddiPath && path.resolve(path.dirname(ddiPath)) !== path.resolve(d)) fs.copyFileSync(ddiPath, path.join(d, path.basename(ddiPath)));
  if (ddiPath) { // an earlier extract's DDI no longer describes ipums_extract.csv
    const keep = path.basename(ddiPath);
    for (const old of fs.readdirSync(d)) {
      if (old.toLowerCase().endsWith(".xml") && old !== keep) fs.renameSync(path.join(d, old), path.join(d, old + ".superseded"));
    }
  }
  const [varRows, codeRows, ddiCite] = ddiPath ? parseDdi(ddiPath) : [[], [], ""];
  fs.writeFileSync(path.join(d, "variables.csv"), writeCsv(varRows, ["variable", "label", "type", "start", "width", "decimals"]));
  fs.writeFileSync(path.join(d, "codebook.csv"), writeCsv(codeRows, ["variable", "variable_label", "value", "value_label"]));

  let sampleDesc: Record<string, string> = {};
  try {
    if (o.client) sampleDesc = Object.fromEntries((await o.client.listSamples(collection)).map((s) => [s.name, s.description]));
  } catch {
    sampleDesc = {};
  }
  fs.writeFileSync(path.join(d, "extract_spec.json"), JSON.stringify({ collection, extract_number: number, downloaded: today(),
    acquired, rows: nrows, spec, api_body: body }, null, 2));

  const labels = Object.fromEntries(varRows.map((r) => [r.variable, r.label]));
  const hints: Record<string, string> = t.WEIGHT_HINTS[collection] ??
    Object.assign({}, ...Object.values<Record<string, string>>(t.WEIGHT_HINTS));
  const weights = columns.filter((x) => x in hints);
  const citation = ddiCite || t.CITATIONS[collection] || "Cite IPUMS per https://www.ipums.org/about/citation";
  const unit = JSON.stringify(body.dataStructure || {}).includes("householdOnly") ? "households" : "persons";
  const caseLines = Object.entries<any>(body.variables).filter(([, v]) => "caseSelections" in v)
    .map(([k, v]) => `- \`${k}\` in ${pyDictRepr(v.caseSelections)}`);
  const lines = [
    `# IPUMS extract ${collection.toUpperCase()} #${number}`, "",
    `- Description: ${body.description ?? ""}`,
    `- Downloaded: ${today()} (${acquired})`,
    `- Rows (${unit}): ${commas(nrows)}`,
    "- File: `ipums_extract.csv` (comma-separated, header = IPUMS mnemonics, raw IPUMS codes)",
    "- Value labels: `codebook.csv`; variable labels/types: `variables.csv`; full DDI: the `.xml`", "",
    "## Samples", ...Object.keys(body.samples).map((s) => `- \`${s}\`: ${sampleDesc[s] ?? ""}`), "",
    "## Variables", ...columns.map((x) => `- \`${x}\`: ${labels[x] ?? ""}`), "",
    "## Case selections", ...(caseLines.length ? caseLines : ["- none (full sample)"]), "",
    "## Weights", ...(weights.length ? weights.map((w) => `- \`${w}\`: ${hints[w]}`)
      : ["- No weight variable in extract. Estimates will NOT be population-representative."]), "",
    "## Reading the data", "```python", "import pandas as pd", "df = pd.read_csv('ipums_extract.csv')",
    "cb = pd.read_csv('codebook.csv', dtype={'value': str})", "```",
    `Watch for IPUMS missing/top codes (${t.MISSING_HINT[collection] ?? t.MISSING_HINT.usa}). Check \`codebook.csv\` before computing means.`,
    "", "## Citation", citation, "",
    `Suggested source line: "Analyst calculations using data from ${t.SOURCE_LINE[collection] ?? "IPUMS"}." ` +
    '(or "<Organization>, using data from ..." when the product names an organization)', "",
    "## Use and redistribution", "", `Rule: **definition_only**. ${t.TERMS_LINE}`];
  fs.writeFileSync(path.join(d, "README.md"), lines.join("\n") + "\n");

  const tables = [{ name: "ipums_extract", file: "ipums_extract.csv", rows: nrows, columns, sha256: fileSha(csvPath) },
    { name: "codebook", file: "codebook.csv", rows: codeRows.length, columns: ["variable", "variable_label", "value", "value_label"] },
    { name: "variables", file: "variables.csv", rows: varRows.length, columns: ["variable", "label", "type", "start", "width", "decimals"] }];
  const retrieved = writeRequestJson(d, spec, body, number, route, acquired,
    tables.map((x) => (x.name === "ipums_extract" ? x : { name: x.name, file: x.file, rows: x.rows })));
  return { data_dir: d, tables: tables.map(({ name, file, rows, columns: cols }) => ({ name, file, rows, columns: cols })),
    notes: [...(o.notes || []), `Extract ${collection}:${number}. ${t.TERMS_LINE}`], problems: [], retrieved, citation,
    vintage: "", route, files: [path.join(d, "extract_spec.json"), ...(ddiPath ? [path.join(d, path.basename(ddiPath))] : [])] };
}

/** str() of a small dict of lists, as the README shows case selections ({'general': ['25', ...]}). */
function pyDictRepr(v: any): string {
  const r = (x: any): string => Array.isArray(x) ? "[" + x.map(r).join(", ") + "]"
    : isObj(x) ? "{" + Object.entries(x).map(([k, y]) => `'${k}': ${r(y)}`).join(", ") + "}"
    : typeof x === "string" ? `'${x}'` : x === true ? "True" : x === false ? "False" : String(x);
  return r(v);
}

function fileSha(p: string): string {
  const h = createHash("sha256");
  const fd = fs.openSync(p, "r");
  const b = Buffer.alloc(1 << 20);
  try {
    for (let n; (n = fs.readSync(fd, b, 0, b.length, null));) h.update(b.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

async function packageInfo(c: Ctx, client: IpumsClient, collection: string, info: any, spec: any, body: any): Promise<DeepResult> {
  const d = dataDir(c.out, SOURCE);
  fs.mkdirSync(d, { recursive: true });
  const links = info.downloadLinks;
  const get = async (k: string) => {
    const link = links[k];
    if (!link) return null;
    const dest = path.join(d, String(link.url).split("/").pop()!);
    return client.download(link.url, dest, link.sha256);
  };
  const dataPath = await get("data");
  const ddiPath = await get("ddiCodebook");
  await get("codebookPreview");
  if (!dataPath) throw ipumsError(`Extract ${collection}#${info.number} has no data file link`);
  return packageFiles(c, collection, info.number, dataPath, ddiPath, spec, body, { client, removeSource: true, route: "api" });
}

/** What data/ipums/ already holds for this body, or null when there is nothing. */
function existingData(out: string, body: any) {
  const d = dataDir(out, SOURCE);
  const specFile = path.join(d, "extract_spec.json"), csvPath = path.join(d, "ipums_extract.csv");
  if (!fs.existsSync(specFile)) return null;
  let saved: any;
  try {
    saved = JSON.parse(fs.readFileSync(specFile, "utf8"));
  } catch {
    return null;
  }
  const savedBody = saved.api_body || {};
  return { path: csvPath, csv_exists: fs.existsSync(csvPath), extract_number: saved.extract_number, status: saved.status ?? "downloaded",
    downloaded: saved.downloaded, rows: saved.rows,
    spec_matches: !!body && Object.keys(savedBody).length > 0 && specFingerprint(savedBody) === specFingerprint(body) };
}

function reuse(c: Ctx, spec: any, ex: NonNullable<ReturnType<typeof existingData>>): DeepResult {
  const d = dataDir(c.out, SOURCE);
  let req: any = {};
  try {
    req = JSON.parse(fs.readFileSync(path.join(d, "request.json"), "utf8"));
  } catch {
    /* optional */
  }
  const tables = (req.tables || []).filter((x: any) => fs.existsSync(path.join(d, x.file))).map((x: any) => ({ name: x.name,
    file: x.file, rows: x.rows ?? 0, columns: x.columns ?? (x.name === "codebook" ? ["variable", "variable_label", "value", "value_label"]
      : x.name === "variables" ? ["variable", "label", "type", "start", "width", "decimals"] : []) }));
  const readme = fs.existsSync(path.join(d, "README.md")) ? fs.readFileSync(path.join(d, "README.md"), "utf8") : "";
  const m = /## Citation\n([^\n]+)/.exec(readme);
  return { data_dir: d, tables, problems: [], retrieved: req.retrieved || "", vintage: "", route: "reuse_existing",
    citation: m ? m[1] : texts().CITATIONS[spec.collection] ?? "",
    notes: [`The data for this extract are already in ${ex.path} (IPUMS extract ${spec.collection}#${ex.extract_number}, ` +
      `downloaded ${ex.downloaded}). Use force: true to resubmit.`, texts().TERMS_LINE],
    files: [path.join(d, "extract_spec.json"), ...fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith(".xml")).map((f) => path.join(d, f))] };
}

const BLOCKING = ["key_missing", "auth", "network"];

async function fetch(ctx: DeepContext): Promise<DeepResult> {
  const spec = ctx.spec;
  const probs = specProblems(spec);
  if (probs.length) throw new DataError("The request has problems: " + probs.join("; "), "spec");
  const c: Ctx = { pack: ctx.pack, out: ctx.workspace };
  const collection: string = spec.collection;
  const body = buildBody(spec);
  const maxWait = Number(spec.max_wait_s) || DEFAULT_WAIT_S;
  // Cheapest routes first: the data are already here, or the extract is already queued at IPUMS.
  const ex = existingData(c.out, body);
  if (ex && ex.csv_exists && ex.spec_matches && !ctx.force) return reuse(c, spec, ex);
  const client = new IpumsClient();
  if (ex && ex.spec_matches && ex.extract_number && !ex.csv_exists && !ctx.force) {
    const number = Math.trunc(Number(ex.extract_number));
    try {
      const info = await client.wait(collection, number, maxWait);
      return await packageInfo(c, client, collection, info, spec, body);
    } catch (e: any) {
      if (!(e instanceof DataError) || BLOCKING.includes(e.kind) || e.message.includes("Timed out") || e.message.includes("Checksum mismatch")) throw e;
      // cannot resume (expired, failed): submit again below
    }
  }
  const number = await client.submit(collection, body);
  const d = dataDir(c.out, SOURCE);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "extract_spec.json"), JSON.stringify({ collection, extract_number: number, spec, api_body: body,
    status: "submitted" }, null, 2));
  const info = await client.wait(collection, number, maxWait);
  return packageInfo(c, client, collection, info, spec, body);
}

// --------------------------------------------------------------------------- ingest a hand-downloaded extract
/** The data file and the DDI codebook among uploaded files and folders. */
export function findUploads(paths: string[]): [string, string | null] {
  const files: string[] = [];
  const walk = (p: string) => {
    if (fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    else files.push(p);
  };
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new DataError(`Not found: ${p}`, "not_found");
    walk(p);
  }
  const skip = new Set(["codebook.csv", "variables.csv"]);
  let data = files.filter((f) => /\.csv(\.gz)?$/i.test(f) && !skip.has(path.basename(f).toLowerCase()));
  const named = data.filter((f) => /^[a-z]+_\d+\.csv(\.gz)?$/i.test(path.basename(f)));
  // ipums_extract.csv is this pack's own output name: use it only when nothing else was uploaded
  const other = data.filter((f) => path.basename(f).toLowerCase() !== "ipums_extract.csv");
  data = named.length ? named : other.length ? other : data;
  if (data.length !== 1) {
    throw new DataError("Expected exactly one IPUMS data file (.csv or .csv.gz); found " + (data.length ? data.join(", ") : "none") +
      ". Pass the data file and the .xml codebook to ingest.", "not_found");
  }
  const stem = path.basename(data[0]).replace(/\.csv(\.gz)?$/i, "").toLowerCase();
  const xml = files.filter((f) => f.toLowerCase().endsWith(".xml"));
  const same = xml.filter((f) => path.basename(f, path.extname(f)).toLowerCase() === stem);
  const pick = same.length ? same : xml;
  if (pick.length > 1) throw new DataError("More than one .xml file found; pass only the IPUMS codebook: " + pick.join(", "), "spec");
  return [data[0], pick[0] ?? null];
}

async function ingest(ctx: DeepContext & { files: string[] }): Promise<DeepResult> {
  const spec = ctx.spec;
  const probs = specProblems(spec);
  if (probs.length) throw new DataError("The request has problems: " + probs.join("; "), "spec");
  const collection: string = spec.collection;
  const body = buildBody(spec);
  if (!ctx.files.length) throw new DataError("ingest needs the data file and the .xml codebook (or their folder)", "spec");
  const [dataPath, ddiPath] = findUploads(ctx.files);
  const m = /_(\d+)\.csv/i.exec(path.basename(dataPath));
  const number: number | string = m ? Number(m[1]) : "manual";
  const notes: string[] = [];
  if (m && !path.basename(dataPath).toLowerCase().startsWith(collection.toLowerCase() + "_")) {
    notes.push(`${path.basename(dataPath)} does not look like a ${collection} extract`);
  }
  if (!ddiPath) {
    notes.push("no .xml codebook found; codebook.csv and variables.csv are empty. Ask the user to upload the DDI file too.");
  }
  const r = await packageFiles({ pack: ctx.pack, out: ctx.workspace }, collection, number, dataPath, ddiPath, spec, body,
    { acquired: "downloaded by hand by the user (IPUMS website, download script or curl) and uploaded", route: "manual_download", notes });
  const cols = r.tables[0].columns;
  const missing = Object.keys(body.variables).filter((v) => !cols.includes(v));
  if (missing.length) {
    r.notes.push("requested variables not in the uploaded file: " + missing.join(", ") +
      ". The file may belong to a different extract; check the extract definition.");
  }
  return r;
}

// --------------------------------------------------------------------------- schema, search
const COLLECTIONS: Record<string, string> = {
  usa: "IPUMS USA: ACS (from 2000) and decennial census microdata. Samples like us2023a (1-year ACS), us2023c (5-year).",
  cps: "IPUMS CPS: Current Population Survey, basic monthly (cps2025_01b) and ASEC (cps2023_03s, income of the prior year).",
  nhis: "IPUMS NHIS: National Health Interview Survey (ih2024). No case selection, no data quality flags.",
  meps: "IPUMS MEPS: Medical Expenditure Panel Survey (mp2022). No case selection, no attached characteristics.",
  ipumsi: "IPUMS International: census microdata of many countries.",
  atus: "IPUMS ATUS: American Time Use Survey. No case selection.",
};

async function schema(names: string[], _pack: Pack): Promise<any[]> {
  const t = texts();
  const out: any[] = [];
  for (const n of names) {
    const lim = t.API_LIMITS[n];
    const item: any = { name: n, summary: COLLECTIONS[n] ?? `IPUMS collection ${n}`,
      spec: { collection: n, description: "text (up to 250 characters)", samples: "list of sample IDs (below)",
        variables: "list of IPUMS variable names (uppercase mnemonics); see docs/variables.md",
        case_selections: SELECTABLE.includes(n) ? '{"VAR": ["code", ...]} or {"VAR": {"min": 25, "max": 54}} or {"VAR": {"detailed": [...]}}'
          : "not available for this collection",
        case_select_who: SELECTABLE.includes(n) ? '"individuals" (default) or "households"' : "not available",
        attached_characteristics: '{"VAR": ["spouse", "mother", "father", "head"]}', data_quality_flags: '["VAR", ...] or true',
        adjust_monetary_values: SELECTABLE.includes(n) ? '["INCWAGE", ...] (CPI-adjusted)' : "not available",
        data_structure: '{"rectangular": {"on": "P"}} (default) or {"hierarchical": {}}',
        max_wait_s: `optional: seconds one fetch waits for IPUMS to build the extract (default ${DEFAULT_WAIT_S}); then fetch again to collect it` },
      unsupported: lim?.unsupported ?? [], rectangular_on: lim?.rect_on ?? ["P"], weights: t.WEIGHT_HINTS[n] ?? {},
      missing_codes: t.MISSING_HINT[n] ?? "", key: "IPUMS_API_KEY (the website builds the same extract with a free account and no key)" };
    try {
      item.samples = (await new IpumsClient().listSamples(n)).map((s) => ({ name: s.name, description: s.description }));
    } catch (e: any) {
      item.samples = { error: `the sample list could not be read now (${String(e?.message || e).split("\n")[0].slice(0, 200)}); ` +
        "IPUMS lists them on each collection's website (Select Samples)" };
    }
    out.push(item);
  }
  return out;
}

/** --list-samples: "<collection> <words>" finds sample IDs by ID or description. */
async function search(query: string, _pack: Pack): Promise<any[]> {
  const words = query.trim().split(/\s+/);
  const known = [...Object.keys(COLLECTIONS)];
  const coll = known.includes(words[0]?.toLowerCase()) ? words.shift()!.toLowerCase() : "usa";
  const m = words.join(" ").toLowerCase();
  let all: { name: string; description: string }[];
  try {
    all = await new IpumsClient().listSamples(coll);
  } catch (e: any) {
    const why = String(e?.message || e).split("\n")[0].slice(0, 300);
    return [{ collection: coll, error: `the sample list could not be read (${why})` }];
  }
  return all.filter((s) => s.name.toLowerCase().includes(m) || s.description.toLowerCase().includes(m))
    .map((s) => ({ collection: coll, name: s.name, description: s.description }));
}

const pack: DeepPack = {
  operations: Object.entries(COLLECTIONS).map(([name, summary]) => ({ name, summary })),
  schema,
  // a collection request_schema does not list (e.g. a newer IPUMS collection) needs no schema read first
  uses: (spec) => (isObj(spec) && typeof spec.collection === "string" && spec.collection in COLLECTIONS ? [spec.collection] : []),
  specExample: { collection: "usa", description: "Prime-age employment by nativity", samples: ["us2013a", "us2018a", "us2023a"],
    variables: ["AGE", "SEX", "CITIZEN", "EDUCD", "EMPSTAT", "INCWAGE", "PERWT"],
    case_selections: { AGE: { min: 25, max: 54 } } },
  search,
  checkSpec: (spec) => specProblems(spec),
  fetch,
  ingest,
};
export default pack;
