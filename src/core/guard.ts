/**
 * The guard on every path a model supplies (ingest files, a for_each table, report.json paths, read_file).
 *
 * The server's own key lookup (keys.ts findKey) reads key files itself and never returns what it reads. A path a
 * model names is different: what is read from it can come back in a result. So such a path is refused when
 *   - it is, or is inside, a place secrets live: the key files findKey reads (keys.json, Claude Code's settings,
 *     <ENV>_FILE, ~/.<home>/api_key), the hosted server's state folder, ~/.ssh, ~/.aws and the like, or a file named
 *     like a secret (.env, *.pem, id_rsa...); symlinks are followed first, so a link cannot point around this;
 *   - (confine) it is outside the session's workspace;
 *   - (contents) the file holds a known key, in any form, or text shaped like a credential.
 * Refusals name the path, never what is in it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mode, PACKS_DIR, workspaceRoot } from "./env.js";
import { configPath, defaultHome, holdsSecret, settingsPath } from "./keys.js";
import { CREDENTIAL_PATTERNS } from "./secret_patterns.js";
import { fail } from "../envelope.js";

const HOME_DIRS = [".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", path.join(".config", "gcloud"),
  path.join(".config", "gh"), ".claude"];
const HOME_FILES = [".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".my.cnf"];
const SECRET_NAME = /^(?:\.env(?:\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|api_key|credentials(?:\.json)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials)$/i;
const SYSTEM_DIRS = process.platform === "win32" ? [] : ["/proc", "/sys", "/dev", "/etc/ssh", "/etc/shadow", "/run/secrets"];

const win = process.platform === "win32";
const norm = (p: string) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Is p the same as, or inside, dir? */
export function inside(p: string, dir: string): boolean {
  const rel = path.relative(norm(dir), norm(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

let PACK_KEY_HOMES: string[] | null = null;
/** ~/.<home> of every pack's key (keys.ts reads ~/.<home>/api_key), from the packs' policy.json. */
function packKeyHomes(): string[] {
  if (PACK_KEY_HOMES) return PACK_KEY_HOMES;
  const out: string[] = [];
  for (const id of fs.existsSync(PACKS_DIR) ? fs.readdirSync(PACKS_DIR) : []) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, id, "policy.json"), "utf8")).auth || {};
      for (const env of [a.env, ...(a.alt_env || [])].filter((x) => typeof x === "string" && x)) {
        out.push(path.join(os.homedir(), `.${env === a.env && a.home ? a.home : defaultHome(env)}`));
      }
    } catch {
      // a pack without a readable policy names no key
    }
  }
  return (PACK_KEY_HOMES = out);
}

/** Every place secrets live on this machine (folders and files). */
export function secretPlaces(): string[] {
  const home = os.homedir();
  const keyFiles = Object.entries(process.env).filter(([k, v]) => k.endsWith("_FILE") && v).map(([, v]) => v as string);
  const state = process.env.DATA_ANALYST_STATE_DIR || (mode() === "remote" ? path.join(workspaceRoot(), "state") : "");
  return [
    path.dirname(configPath()), settingsPath(), path.dirname(settingsPath()),
    ...(state ? [state] : []),
    ...packKeyHomes(), ...keyFiles,
    ...HOME_DIRS.map((d) => path.join(home, d)), ...HOME_FILES.map((f) => path.join(home, f)),
    ...SYSTEM_DIRS,
  ];
}

/** Why a path may not be read for a model, or "" when it may. */
export function secretPlace(p: string): string {
  const r = real(p);
  for (const cand of [path.resolve(p), r]) {
    if (SECRET_NAME.test(path.basename(cand))) return "its name marks a secrets file";
    if (secretPlaces().some((d) => inside(cand, d) || inside(cand, real(d)))) return "it is where API keys or credentials are kept";
  }
  return "";
}

/**
 * confine: only inside the workspace. contents (checkFiles, default true): refuse files that hold a credential; off for
 * a source whose own responses echo the user's key (policy auth.echoes_key: BEA, BLS), whose downloaded files then
 * hold it by nature: those are redacted on the way out instead.
 */
export type GuardOptions = { workspace: string; confine?: boolean; what?: string; contents?: boolean };

/** The path, resolved; throws invalid_request when it is a secrets place or (confine) outside the workspace. */
export function checkReadable(p: string, o: GuardOptions): string {
  const abs = path.resolve(o.workspace, p);
  const what = o.what || "this tool";
  if (o.confine && !(inside(abs, o.workspace) && inside(real(abs), real(o.workspace)))) {
    throw fail("invalid_request", `${what} reads only files inside this session's workspace: ${p}`,
      "Give a path relative to the workspace (a file a fetch, ingest or compute wrote there).");
  }
  const why = secretPlace(abs);
  if (why) {
    throw fail("invalid_request", `${what} will not read ${p}: ${why}`,
      "Never point a tool at key or credential files. Give the path of the downloaded data file itself.");
  }
  return abs;
}

/** Does the file look like it holds a secret (a known key in any form, or text shaped like a credential)? */
export function holdsCredential(buf: Buffer): boolean {
  if (holdsSecret(buf)) return true;
  const text = buf.subarray(0, 1 << 22).toString("latin1");
  if (holdsSecret(text)) return true;
  return CREDENTIAL_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/** Is p inside the workspace, also after symlinks are followed, and not a secrets place? */
export function workspaceFile(p: string, workspace: string): boolean {
  const abs = path.resolve(workspace, p);
  return inside(abs, workspace) && inside(real(abs), real(workspace)) && !secretPlace(abs);
}

/** The paths a report.json names (facts, exhibit data, data files, replication files, provenance, recessions)
 *  that are outside its folder or in a secrets place. */
export function reportPathProblems(base: string, R: any): string[] {
  const list: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v) list.push(v);
  };
  add(R?.facts);
  for (const e of Array.isArray(R?.exhibits) ? R.exhibits : []) {
    add(e?.data);
    add(e?.chart?.recessions);
  }
  for (const d of Array.isArray(R?.data_files) ? R.data_files : []) add(d?.path);
  for (const f of Array.isArray(R?.replication?.files) ? R.replication.files : []) add(f);
  for (const f of Array.isArray(R?.replication?.extra) ? R.replication.extra : []) add(f);
  const pv = R?.provenance;
  if (typeof pv === "string") add(pv);
  else if (pv && typeof pv === "object") Object.values(pv).forEach(add);
  return [...new Set(list.filter((p) => !workspaceFile(p, base)))];
}

/** checkReadable for every path and every file under a folder; then (contents) the contents check on each file. */
export function checkFiles(paths: string[], o: GuardOptions): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    checkReadable(abs, o);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) for (const n of fs.readdirSync(abs)) walk(path.join(abs, n));
    else if (st.isFile()) out.push(abs);
  };
  for (const p of paths) walk(path.resolve(o.workspace, p));
  if (o.contents !== false) checkContents(out, o.what);
  return out;
}

/** Refuse when any of these files holds an API key or credential (named by file, never by contents). */
export function checkContents(files: string[], what = "this tool"): void {
  for (const f of files) {
    if (fs.existsSync(f) && fs.statSync(f).isFile() && holdsCredential(fs.readFileSync(f))) {
      throw fail("invalid_request", `${what} will not read ${path.basename(f)}: it holds an API key or credential`,
        "Remove the key from the file (or give the data file itself, not a file with keys in it), then call again.");
    }
  }
}

/** Text with credential-shaped runs (CREDENTIAL_PATTERNS) replaced: [text, changed]. */
export function maskCredentials(text: string): [string, boolean] {
  let out = text;
  for (const re of CREDENTIAL_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED]");
  }
  return [out, out !== text];
}
