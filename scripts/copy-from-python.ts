/**
 * One-time import of the pack data from the Python data-analyst repo (this project is a fork: after the import
 * it owns these files, and nothing syncs them back).
 *
 *   npx tsx scripts/copy-from-python.ts [path-to-data-analyst-repo]   (default: $DATA_ANALYST_REPO or ../data-analyst)
 *
 * Copies, per pack: policy.json, endpoints.json, source.md, docs/**, assets/** (never *.py: code is ported by hand,
 * pack by pack) into packs/<id>/; its fixtures into test/packs/<id>/fixtures/; SKILL.md, references/*.md and the
 * skill's assets/ into guide/. Existing files are overwritten; files that exist only here are left alone.
 * Packs listed in an existing packs/<id>/.ported marker are skipped unless --all is given.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const all = args.includes("--all");
const repo = path.resolve(args.find((a) => !a.startsWith("--")) ?? process.env.DATA_ANALYST_REPO ?? "../data-analyst");
const skill = path.join(repo, "plugins", "data-analyst", "skills", "data-analyst");
const here = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

if (!fs.existsSync(path.join(skill, "SKILL.md"))) {
  console.error(`not a data-analyst checkout: ${repo}`);
  process.exit(2);
}

function copyTree(src: string, dst: string, keep: (rel: string) => boolean, rel = ""): number {
  let n = 0;
  if (!fs.existsSync(src)) return 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name === "__pycache__") continue;
    if (e.isDirectory()) n += copyTree(path.join(src, e.name), path.join(dst, e.name), keep, r);
    else if (keep(r)) {
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
      n++;
    }
  }
  return n;
}

const PACK_FILES = new Set(["policy.json", "endpoints.json", "source.md"]);
const keepPack = (rel: string) =>
  PACK_FILES.has(rel) || ((rel.startsWith("docs/") || rel.startsWith("assets/")) && !rel.endsWith(".py"));

let packs = 0, files = 0, fixtures = 0;
// which packs need code beyond endpoints.json (an adapter or a deep pack's own CLI): until that code is ported
// to src/adapters/ or src/deep/, the server reports the pack as not yet available instead of guessing
const portPath = path.join(here, "packs", "port.json");
const port: Record<string, { python: string[] }> = fs.existsSync(portPath) ? JSON.parse(fs.readFileSync(portPath, "utf8")) : {};
for (const id of fs.readdirSync(path.join(skill, "sources")).sort()) {
  const src = path.join(skill, "sources", id);
  if (!fs.existsSync(path.join(src, "policy.json"))) continue;
  const py = ["adapter.py", "fetch.py"].filter((f) => fs.existsSync(path.join(src, f)));
  if (py.length) port[id] = { python: py };
  const dst = path.join(here, "packs", id);
  if (!all && fs.existsSync(path.join(dst, ".ported"))) continue;
  files += copyTree(src, dst, keepPack);
  fixtures += copyTree(path.join(repo, "tests", "sources", id, "fixtures"),
    path.join(here, "test", "packs", id, "fixtures"), () => true);
  packs++;
}

fs.writeFileSync(portPath, JSON.stringify(port, null, 1) + "\n");

const guide = path.join(here, "guide");
files += copyTree(skill, guide, (rel) => rel === "SKILL.md");
files += copyTree(path.join(skill, "references"), path.join(guide, "references"), (rel) => rel.endsWith(".md"));
files += copyTree(path.join(skill, "assets"), path.join(guide, "assets"), () => true);
files += copyTree(path.join(skill, "scripts", "core", "assets"), path.join(guide, "assets"), () => true);

console.log(JSON.stringify({ repo, packs, files, fixtures }));
