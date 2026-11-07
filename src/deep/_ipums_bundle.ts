/**
 * IPUMS hand-download and reproduce bundles (port of fetch.py write_manual_bundle, write_reproduce_bundle,
 * web_section, write_download_scripts). The long instruction texts are in packs/ipums/lib/fetch_text.json, copied
 * verbatim from the Python pack.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PACKS_DIR } from "../core/env.js";
import { runLines } from "../core/manual.js";
import { pyJsonDumps } from "../core/py.js";

let T: any = null;
/** The texts and tables of packs/ipums/lib/fetch_text.json. */
export function texts(): any {
  return (T ??= JSON.parse(fs.readFileSync(path.join(PACKS_DIR, "ipums", "lib", "fetch_text.json"), "utf8")));
}

export const SOURCE = "ipums";
export const KEY_ENV = "IPUMS_API_KEY";
export const DOWNLOAD_SCRIPTS = { bash: "download_ipums.sh", powershell: "download_ipums.ps1" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];

/** Best-effort label for a sample ID as the website lists it ("" when unknown; the ID is always shown). */
export function sampleLabel(sample: string): string {
  let m = /^us(\d{4})([a-z])$/.exec(sample);
  if (m) {
    const y = Number(m[1]);
    return ({ a: `${y} ACS, 1-year`, c: `${y - 4}-${y} ACS, 5-year` } as Record<string, string>)[m[2]] ?? "";
  }
  m = /^cps(\d{4})_(\d{2})([sb])$/.exec(sample);
  if (m) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (mo === 3 && m[3] === "s") return `ASEC ${y}`;
    return mo >= 1 && mo <= 12 ? `${MONTHS[mo - 1]} ${y} basic monthly` : "";
  }
  m = /^(ih|mp)(\d{4})$/.exec(sample);
  if (m) return `${m[2]} ${m[1] === "ih" ? "NHIS" : "MEPS"}`;
  return "";
}

function codeList(codes: string[]): string {
  const nums = codes.filter((c) => /^\d+$/.test(c.replace(/^-+/, ""))).map(Number);
  if (nums.length === codes.length && nums.length > 3 && nums.every((n, i) => n === nums[0] + i)) {
    return `codes ${codes[0]} through ${codes[codes.length - 1]}`;
  }
  return (codes.length === 1 ? "code " : "codes ") + codes.join(", ");
}

/** Step-by-step website instructions that rebuild the API body in the IPUMS extract builder. */
export function webSection(collection: string, body: any): string {
  const [site, action] = texts().WEB_SITES[collection] ?? ["https://www.ipums.org", ""];
  const browse = action ? `${site}/${action}/variables/group` : site;
  const mydata = action ? `${site}/${action}/data_requests/download` : site;
  const samples = Object.keys(body.samples).map((s) => `   - \`${s}\`` + (sampleLabel(s) ? ` (${sampleLabel(s)})` : "")).join("\n");
  const variables = Object.keys(body.variables).map((v) => `   - \`${v}\``).join("\n");
  const cases: string[] = [], extra: string[] = [];
  for (const [name, v] of Object.entries<any>(body.variables)) {
    const cs = v.caseSelections;
    if (cs) {
      const level = "detailed" in cs ? "detailed" : "general";
      cases.push(`   - \`${name}\`: ${codeList(cs[level])} (${level} codes)`);
    }
    if (v.attachedCharacteristics?.length) extra.push(`   - \`${name}\`: *Attach characteristics* of ${v.attachedCharacteristics.join(", ")}`);
    if (v.dataQualityFlags) extra.push(`   - \`${name}\`: include its *Data quality flag*`);
    if (v.adjustMonetaryValues) extra.push(`   - \`${name}\`: *Adjust monetary values* for inflation`);
  }
  let caseText = "";
  if (cases.length) {
    const keep = body.caseSelectWho === "households" ? "all members of households with at least one matching person"
      : "only the persons who match";
    caseText = `   **Select cases:** click *Select cases*, check these variables, pick the codes, and keep ${keep}:\n` +
      cases.join("\n") + "\n";
  }
  const extraText = extra.length ? "   **Options** (on the same page):\n" + extra.join("\n") + "\n" : "";
  const ds = body.dataStructure || {};
  const on = (ds.rectangular || {}).on ?? "P";
  const structure = "hierarchical" in ds ? "Hierarchical" : "householdOnly" in ds ? "Household only"
    : ({ P: "Rectangular (person)", I: "Rectangular (injury)", R: "Rectangular (round)", A: "Rectangular (activity)" } as
      Record<string, string>)[on] ?? `Rectangular (${on})`;
  return (texts().WEB_TEMPLATE as string).replaceAll("@STRUCTURE@", structure).replaceAll("@SITE@", site)
    .replaceAll("@BROWSE@", browse).replaceAll("@MYDATA@", mydata).replaceAll("@SAMPLES@", samples)
    .replaceAll("@VARIABLES@", variables).replaceAll("@CASES@", caseText).replaceAll("@OPTIONS_EXTRA@", extraText)
    .replaceAll("@DESCRIPTION@", body.description ?? "");
}

/** The one command per system that runs the download script: from Downloads (a hand-download bundle), or from
 * the folder that holds the script (here: reproduce/DOWNLOAD.md). */
export function runBlock(here = false): string {
  let c: { bash: string; powershell: string }, lead: string, tail: string;
  if (here) {
    c = { bash: `bash ${DOWNLOAD_SCRIPTS.bash}`, powershell: `powershell -NoProfile -ExecutionPolicy Bypass -File .\\${DOWNLOAD_SCRIPTS.powershell}` };
    lead = "Open a terminal in this folder and run the command for your system:";
    tail = "Downloaded only the script (for example from the report page)? Run it where you saved it, e.g. " +
      `\`${runLines("download_ipums").bash}\`.`;
  } else {
    c = runLines("download_ipums");
    lead = "Save `download_ipums.sh` (macOS, Linux) or `download_ipums.ps1` (Windows) in your Downloads " +
      "folder, then copy and paste the command for your system into a terminal:";
    tail = "If you saved the script in another folder, put that folder in the command instead of Downloads.";
  }
  return `${lead}\n\n**macOS, Linux, Git Bash, WSL** (needs only curl):\n\n\`\`\`bash\n${c.bash}\n\`\`\`\n\n` +
    `**Windows PowerShell:**\n\n\`\`\`powershell\n${c.powershell}\n\`\`\`\n\n${tail} On Windows you can also ` +
    "right-click the `.ps1` file and choose *Run with PowerShell*. The script asks for your API key with " +
    "hidden input (or uses `IPUMS_API_KEY` when it is set).\n";
}

/** json.dumps(body, indent=2): ASCII only, safe in a heredoc and in PowerShell 5.1. */
function pyIndent(v: unknown, ind = ""): string {
  const next = ind + "  ";
  if (Array.isArray(v)) return v.length ? "[\n" + v.map((x) => next + pyIndent(x, next)).join(",\n") + "\n" + ind + "]" : "[]";
  if (v && typeof v === "object") {
    const e = Object.entries(v);
    return e.length ? "{\n" + e.map(([k, x]) => `${next}${pyJsonDumps(k)}: ${pyIndent(x, next)}`).join(",\n") + "\n" + ind + "}" : "{}";
  }
  return pyJsonDumps(v);
}
export const pyJsonIndent = (v: unknown) => pyIndent(v);

/** download_ipums.sh and download_ipums.ps1 with the extract definition built in. */
export function writeDownloadScripts(d: string, collection: string, body: any, number: number | null = null): Record<string, string> {
  const spec = pyIndent(body);
  // names the script's saved-number file, so a file left by another extract in the same folder is ignored
  const specId = createHash("sha256").update(pyJsonDumps(body, true)).digest("hex").slice(0, 10);
  const src = path.join(PACKS_DIR, "ipums", "assets");
  const out: Record<string, string> = {};
  for (const [kind, name] of Object.entries(DOWNLOAD_SCRIPTS)) {
    if (!fs.existsSync(path.join(src, name))) return {};
    let text = fs.readFileSync(path.join(src, name), "utf8").replace(/\r\n/g, "\n");
    text = text.replaceAll("@COLLECTION_UPPER@", collection.toUpperCase()).replaceAll("@COLLECTION@", collection)
      .replaceAll("@NUMBER@", number ? String(number) : "").replaceAll("@SPEC_ID@", specId)
      .replaceAll("@SPEC_JSON@", spec); // last, so the spec text is never rewritten
    // bash needs LF line ends even when written on Windows; PowerShell takes either
    if (kind === "powershell") text = text.replace(/\n/g, "\r\n");
    const p = path.join(d, name);
    fs.writeFileSync(p, text, { encoding: "utf8", mode: kind === "bash" ? 0o755 : 0o644 });
    out[kind] = p;
  }
  return out;
}

export function scriptPaths(bundle: string): Record<string, string> | null {
  const out = Object.fromEntries(Object.entries(DOWNLOAD_SCRIPTS).map(([k, n]) => [k, path.join(bundle, n)])
    .filter(([, p]) => fs.existsSync(p)));
  return Object.keys(out).length ? out : null;
}

/**
 * The request body, the download scripts and INSTRUCTIONS.md (website and API steps) in
 * <out>/manual_download/ipums/. Needs no network and no key. With no key the website comes first.
 */
export function writeManualBundle(collection: string, body: any, out: string, reason: string, number: number | null = null,
  hasKey?: boolean): string {
  const t = texts();
  hasKey ??= reason !== "key_missing";
  const d = path.join(path.resolve(out), "manual_download", SOURCE);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "extract_spec.json"), pyIndent(body) + "\n");
  const note = number ? `\nAn extract was already submitted: number ${number}. The script uses it and does not ` +
    `submit a new one. With curl, skip step 1 and use ${number} in place of \`<NUMBER>\`.\n` : "";
  writeDownloadScripts(d, collection, body, number);
  const sections = [webSection(collection, body), (t.API_TEMPLATE as string).replaceAll("@NUMBER_NOTE@", note).replaceAll("@RUN@", runBlock())];
  if (hasKey) sections.reverse(); // a key exists: curl is the shorter way
  const options = sections.map((s, i) => s.replaceAll("@LETTER@", "AB"[i])).join("") + t.UPLOAD_TEMPLATE;
  const text = (t.MANUAL_HEAD as string).replaceAll("@OPTIONS@", options).replaceAll("@REASON@", t.REASON_TEXT[reason] ?? reason)
    .replaceAll("@COLLECTION_UPPER@", collection.toUpperCase()).replaceAll("@COLLECTION@", collection);
  fs.writeFileSync(path.join(d, "INSTRUCTIONS.md"), text);
  const item = (name: string, filename: string, note2: string) => ({ source: SOURCE, name, filename, needs_key: true,
    key_env: KEY_ENV, signup_url: "https://account.ipums.org/api_keys", note: note2 });
  fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ reason: t.REASON_TEXT[reason] ?? reason, source: SOURCE,
    collection, extract_number: number, request_body: "extract_spec.json", scripts: Object.values(DOWNLOAD_SCRIPTS),
    items: [item("data", `${collection}_NNNNN.csv.gz`, "the data file IPUMS names (website: no key needed)"),
      item("ddi", `${collection}_NNNNN.xml`, "the DDI codebook")] }, null, 2));
  return d;
}

/**
 * The files a reader needs to request this extract again: extract_spec.json (the request body), the download
 * scripts with the same definition built in (always a fresh submission) and DOWNLOAD.md. No microdata, no key.
 */
export function writeReproduceBundle(collection: string, body: any, d: string): string {
  const t = texts();
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "extract_spec.json"), pyIndent(body) + "\n");
  for (const f of fs.readdirSync(d)) if (f.startsWith("extract_number_")) fs.rmSync(path.join(d, f));
  writeDownloadScripts(d, collection, body);
  const sections = [(t.API_TEMPLATE as string).replaceAll("@NUMBER_NOTE@", "").replaceAll("@RUN@", runBlock(true)),
    webSection(collection, body)];
  const text = (t.REPRODUCE_HEAD + sections.map((s, i) => s.replaceAll("@LETTER@", "AB"[i])).join("") + t.REPRODUCE_TAIL)
    .replaceAll("@COLLECTION_UPPER@", collection.toUpperCase()).replaceAll("@COLLECTION@", collection);
  fs.writeFileSync(path.join(d, "DOWNLOAD.md"), text);
  return d;
}
