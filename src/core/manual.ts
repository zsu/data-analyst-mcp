/**
 * Manual-download bundles and ingest, for when this server cannot get the data itself (no key stored here, a
 * host that refuses scripts, a network that blocks it). The user downloads the files on their own computer
 * with one command and uploads them; then `ingest` packages them like a fetch.
 *
 * An item is {name, url, filename, needs_key, method, body, note, optional, also_ext?, alt_filenames?}. A URL that
 * needs a key carries {API_KEY}; the scripts fill it on the user's own computer (from the key variable or a
 * hidden prompt), so the key never reaches this server or the chat. The bundle (<workspace>/manual_download/):
 *   INSTRUCTIONS.md, download_data.sh / download_data.ps1 (curl / Windows PowerShell, no Python),
 *   spec.json (one source) or plan.json (several), manifest.json
 */
import fs from "node:fs";
import path from "node:path";
import { GUIDE_DIR } from "./env.js";
import type { Pack } from "./packs.js";

export function bundleDir(out: string): string {
  return path.join(path.resolve(out), "manual_download");
}

/** A file name the scripts can write on any system (ASCII, no path separators or tabs). */
export function safeName(name: string): string {
  return String(name).replace(/[^A-Za-z0-9._()+ -]/g, "_").trim() || "file";
}

function item(pack: Pack, it: any): any {
  const a = pack.policy.auth;
  const needs = !!it.needs_key;
  const x: any = { source: pack.id, name: it.name, url: it.url, filename: safeName(it.filename), method: it.method || "GET",
    note: it.note || "", needs_key: needs, optional: !!it.optional, key_env: needs ? a.env ?? null : null,
    signup_url: needs ? a.signup_url ?? null : null };
  if (it.body !== undefined && it.body !== null) x.body = it.body;
  if (a.extra) x.extra_env = Object.values(a.extra).sort();
  if (needs && a.placement === "body") Object.assign(x, { body_has_key: true, key_param: a.param });
  if (needs && a.placement === "header") Object.assign(x, { key_header: a.param, key_prefix: a.prefix || "" });
  return x;
}

/** Percent-encode what would break a script line or a Windows PowerShell 5.1 file (non-ASCII, blanks). */
function ascii(s: unknown): string {
  let out = "";
  for (const c of String(s)) {
    const code = c.codePointAt(0)!;
    out += code > 32 && code < 127 ? c : [...Buffer.from(c, "utf8")].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
  }
  return out;
}

/** [values, requests]: the tab-separated blocks the script templates embed. "-" marks an empty field. */
export function scriptRows(items: any[]): [string[], string[]] {
  const values: string[] = [], rows: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const needs = !!it.needs_key && !!it.key_env;
    if (needs && !seen.has(it.key_env)) {
      seen.add(it.key_env);
      values.push([it.key_env, "secret", "free key: " + ascii(it.signup_url || "")].join("\t"));
    }
    const extras = (it.extra_env || []).filter((v: string) => it.url.includes(`{${v}}`));
    for (const v of extras) {
      if (!seen.has(v)) {
        seen.add(v);
        values.push([v, "plain", "the value registered with your key"].join("\t"));
      }
    }
    const place = needs ? (it.body_has_key ? "body" : it.key_header ? "header" : "query") : "none";
    let body = it.body;
    if (body !== undefined && body !== null && place === "body") body = { ...body, [it.key_param]: "{API_KEY}" };
    const fields = [safeName(it.filename), String(it.method || "GET").toUpperCase(), it.optional ? "1" : "0",
      needs ? it.key_env : "", place, needs ? it.key_header || it.key_param || "" : "", place === "header" ? it.key_prefix || "" : "",
      extras.join(","), ascii(it.url),
      body !== undefined && body !== null ? JSON.stringify(body).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) : ""];
    rows.push(fields.map((f) => f.replace(/[\t\r\n]/g, " ") || "-").join("\t"));
  }
  return [values, rows];
}

/** <stem>.sh and <stem>.ps1 with every item built in. */
export function writeScripts(d: string, items: any[], stem = "download_data"): { bash: string; powershell: string } {
  fs.mkdirSync(d, { recursive: true });
  const [values, rows] = scriptRows(items);
  const out: any = {};
  for (const [kind, ext] of [["bash", ".sh"], ["powershell", ".ps1"]] as const) {
    let text = fs.readFileSync(path.join(GUIDE_DIR, "assets", "download_data" + ext), "ascii");
    text = text.replaceAll("@STEM@", stem).replaceAll("@VALUES@", values.join("\n")).replaceAll("@ITEMS@", rows.join("\n"));
    text = text.replace(/\r\n/g, "\n");
    if (kind === "powershell") text = text.replace(/\n/g, "\r\n");
    const p = path.join(d, stem + ext);
    fs.writeFileSync(p, text, { encoding: "ascii", mode: kind === "bash" ? 0o755 : 0o644 });
    out[kind] = p;
  }
  return out;
}

export function runLines(stem: string, folder = ""): { bash: string; powershell: string } {
  if (folder) {
    const f = folder.replace(/^[/\\]+|[/\\]+$/g, "").replaceAll("\\", "/");
    return { bash: `bash ${f}/${stem}.sh`,
      powershell: `powershell -NoProfile -ExecutionPolicy Bypass -File ".\\${f.replaceAll("/", "\\")}\\${stem}.ps1"` };
  }
  return { bash: `bash ~/Downloads/${stem}.sh`,
    powershell: `powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\\Downloads\\${stem}.ps1"` };
}

export function runSection(stem: string, keys: [string, string][] = [], folder = "", specName = ""): string[] {
  const c = runLines(stem, folder);
  let lead: string, tail: string;
  if (folder) {
    lead = `From the folder that holds \`${folder}/\`, copy and paste the command for your system:`;
    const d = runLines(stem);
    tail = `If you downloaded only the script, run it where you saved it instead: \`${d.bash}\` or \`${d.powershell}\`.`;
  } else {
    lead = `Save \`${stem}.sh\` (macOS, Linux) or \`${stem}.ps1\` (Windows) in your Downloads folder, then copy and paste the ` +
      "command for your system into a terminal:";
    tail = "If you saved the script in another folder, put that folder in the command instead of Downloads.";
  }
  const lines = [lead, "", "macOS, Linux, Git Bash or WSL (needs only curl):", "", "```bash", c.bash, "```", "",
    "Windows PowerShell:", "", "```powershell", c.powershell, "```", "", tail, ""];
  const ref = specName ? ` (\`${specName}\` holds the same request, for reference)` : "";
  lines.push(`The requests are built into the script${ref}. It saves every file next to itself and prints their full paths ` +
    "when it finishes.", "");
  if (keys.length) {
    lines.push("It needs your own free API key: the script asks for it with hidden input (or uses the environment variable " +
      "when it is set in that terminal), and the key goes only to the source. Never paste a key into the chat.", "");
    lines.push(...keys.map(([env, url]) => `- \`${env}\`: get one at ${url}`), "");
  }
  return lines;
}

function writeSpec(d: string, specs?: Record<string, any>): string | null {
  const ids = Object.keys(specs || {});
  if (!ids.length) return null;
  const [name, data] = ids.length === 1 ? ["spec.json", specs![ids[0]]]
    : ["plan.json", { sources: ids.map((k) => ({ source: k, spec: specs![k] })) }];
  fs.writeFileSync(path.join(d, name), JSON.stringify(data, null, 2) + "\n");
  return name;
}

export type Bundle = { dir: string; instructions: string; scripts: { bash: string; powershell: string }; spec: string | null;
  commands: { bash: string; powershell: string }; items: any[] };

/** groups: [[pack, items], ...]; specs: {pack id: spec}. One bundle for every source. */
export function writeBundle(out: string, groups: [Pack, any[]][], reason: string, specs?: Record<string, any>): Bundle {
  const d = bundleDir(out);
  fs.mkdirSync(d, { recursive: true });
  const items = groups.flatMap(([p, its]) => its.map((it) => item(p, it)));
  fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ reason, items }, null, 2));
  const scripts = writeScripts(d, items);
  const specName = writeSpec(d, specs);
  const keyed = [...new Map(items.filter((i) => i.needs_key).map((i) => [i.key_env, [i.key_env, i.signup_url] as [string, string]])).values()].sort();
  const lines = ["# Download the data on your own computer", "", `The assistant cannot download these files itself (${reason}).`,
    "Get them with one command on your own computer, then upload every downloaded file to the chat (or zip the folder " +
    "and upload the zip).", "", "## Option A: one command (recommended)", "",
    ...runSection("download_data", keyed, "", specName || ""),
    "## Option B: open each link in a browser", "",
    "Save each file under the name shown. Links that need a key are marked; replace `{API_KEY}` with yours in the browser only.", ""];
  for (const i of items) {
    let mark = i.needs_key ? " (needs key)" : "";
    const how = i.method === "GET" ? "" : ` (a ${i.method} request: use Option A)`;
    if (i.optional) mark += " (optional)";
    lines.push(`- **${i.filename}** [${i.source}]${mark}${how}: ${i.url}` + (i.note ? `  \n  ${i.note}` : ""));
  }
  lines.push("", "## Upload", "", "Upload every downloaded file (do not rename or edit them). The assistant then reads them and continues.");
  const instructions = path.join(d, "INSTRUCTIONS.md");
  fs.writeFileSync(instructions, lines.join("\n") + "\n");
  return { dir: d, instructions, scripts, spec: specName ? path.join(d, specName) : null, commands: runLines("download_data"), items };
}

/** The given files, and every file inside the given folders. */
export function candidateFiles(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    if (!fs.existsSync(p)) return;
    if (fs.statSync(p).isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    else out.push(p);
  };
  paths.forEach(walk);
  return out;
}

/**
 * Map each expected item to an uploaded file: exact filename, then the same name with a browser suffix
 * ("file (1).csv") or another readable extension, then a unique file with the same extension... then the item's
 * alt_filenames. Returns [found {item name: path}, missing filenames].
 */
export function matchUploads(paths: string[], items: any[]): [Record<string, string>, string[]] {
  const files = candidateFiles(paths);
  const byName = new Map(files.map((f) => [path.basename(f).toLowerCase(), f]));
  const found: Record<string, string> = {};
  let missing: string[] = [];
  const look = (filename: string, also: string[] = []) => {
    const want = safeName(filename).toLowerCase();
    const ext = path.extname(want), stem = want.slice(0, want.length - ext.length);
    const exts = [ext, ...also.map((e) => e.toLowerCase())];
    return byName.get(want) ?? [...byName].find(([n]) => n.startsWith(stem) && exts.some((e) => n.endsWith(e)))?.[1];
  };
  for (const it of items) {
    const hit = look(it.filename, it.also_ext || []) ?? (it.alt_filenames || []).map((a: string) => look(a)).find(Boolean);
    if (hit) found[it.name] = hit;
    else if (!it.optional) missing.push(it.filename + (it.alt_filenames?.length ? ` (or ${it.alt_filenames.join(" / ")})` : ""));
  }
  if (missing.length && items.length === 1 && files.length === 1) {
    found[items[0].name] = files[0];
    missing = [];
  }
  return [found, missing];
}

export function copyIn(found: Record<string, string>, dest: string): Record<string, string> {
  fs.mkdirSync(dest, { recursive: true });
  const res: Record<string, string> = {};
  for (const [name, src] of Object.entries(found)) {
    const tgt = path.join(dest, path.basename(src));
    if (path.resolve(src) !== path.resolve(tgt)) fs.copyFileSync(src, tgt);
    res[name] = tgt;
  }
  return res;
}
