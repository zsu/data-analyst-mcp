/**
 * Dev check while porting: run the same specs through the Python skill's fetch.py and this server's fetch,
 * both on the recorded fixtures, and compare every CSV byte for byte (and row counts in request.json).
 *
 *   npx tsx scripts/parity.ts [ids...]      (DATA_ANALYST_REPO or ../data-analyst; python on PATH)
 *
 * Specs: test/parity/<id>.json, {"<case>": spec, ...}. Exit 1 on any difference.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(process.env.DATA_ANALYST_REPO ?? path.join(here, "..", "data-analyst"));
const fetchPy = path.join(repo, "plugins", "data-analyst", "skills", "data-analyst", "scripts", "fetch.py");
const specDir = path.join(here, "test", "parity");
const ids = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(specDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

const home = fs.mkdtempSync(path.join(os.tmpdir(), "parity-home-"));
for (const k of Object.keys(process.env)) if (k.endsWith("_API_KEY")) delete process.env[k];
Object.assign(process.env, { HOME: home, USERPROFILE: home, DATA_ANALYST_CONFIG_DIR: path.join(home, "cfg"),
  CLAUDE_CONFIG_DIR: path.join(home, "claude") });

const T = await import("../src/tools.js");
const { Session } = await import("../src/session.js");

let bad = 0;
for (const id of ids) {
  const cases = JSON.parse(fs.readFileSync(path.join(specDir, `${id}.json`), "utf8"));
  const fixtures = path.join(here, "test", "packs", id, "fixtures");
  process.env.DATA_ANALYST_FIXTURES = fixtures;
  // a fake key for keyed sources (URLs drop keys, so the fixtures match), for both implementations. A pack whose
  // fixtures were recorded keyless, where a key changes the request (BLS API v2, openFDA's page size), sets
  // "_parity": {"keys": false} in its cases file.
  const opts = cases._parity || {};
  delete cases._parity;
  const auth = (await (await import("../src/core/packs.js")).load(id)).policy.auth;
  for (const n of [auth.env, ...(auth.alt_env || []), ...Object.values(auth.extra || {})].filter(Boolean) as string[]) {
    if (opts.keys !== false) process.env[n] = n.includes("EMAIL") ? "test@example.com" : "x".repeat(40);
    else delete process.env[n];
  }
  for (const [name, spec] of Object.entries<any>(cases)) {
    const pyOut = fs.mkdtempSync(path.join(os.tmpdir(), `parity-py-${id}-`));
    const specFile = path.join(pyOut, "spec.json");
    fs.writeFileSync(specFile, JSON.stringify(spec));
    const py = spawnSync("python", ["-I", fetchPy, "--source", id, specFile, "--out", pyOut],
      { env: { ...process.env, DATA_ANALYST_FIXTURES: fixtures }, encoding: "utf8" });
    const s = new Session(undefined, fs.mkdtempSync(path.join(os.tmpdir(), `parity-ts-${id}-`)));
    // the gate is tested elsewhere: satisfy it directly
    s.briefed.add(id);
    s.sawSchema(id, T.usedRequests(await (await import("../src/core/packs.js")).load(id), spec));
    s.recordDecisions({ questions: (await T.sourceBrief(s, { source: id }) as any).questions_to_ask.map((q: any) =>
      ({ id: q.id, how: "not_asked", reason_code: "settled_by_request", request: "parity" })) });
    let tsErr = "";
    try {
      await T.fetchData(s, { source: id, spec });
    } catch (e: any) {
      tsErr = JSON.stringify(e.failure ?? String(e)).slice(0, 300);
    }
    const pyDir = path.join(pyOut, "data", id), tsDir = path.join(s.workspace, "data", id);
    const csvs = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".csv")).sort() : []);
    const diffs: string[] = [];
    if (py.status !== 0) diffs.push(`python exit ${py.status}: ${py.stdout.slice(0, 300)}`);
    if (tsErr) diffs.push(`ts error: ${tsErr}`);
    for (const f of new Set([...csvs(pyDir), ...csvs(tsDir)])) {
      const a = fs.existsSync(path.join(pyDir, f)) ? fs.readFileSync(path.join(pyDir, f)) : null;
      const b = fs.existsSync(path.join(tsDir, f)) ? fs.readFileSync(path.join(tsDir, f)) : null;
      if (!a || !b) diffs.push(`${f}: only in ${a ? "python" : "ts"}`);
      else if (!a.equals(b)) {
        const la = a.toString("utf8").split("\r\n"), lb = b.toString("utf8").split("\r\n");
        const i = la.findIndex((l, j) => l !== lb[j]);
        diffs.push(`${f}: line ${i + 1} differs\n      py: ${la[i]?.slice(0, 200)}\n      ts: ${lb[i]?.slice(0, 200)}`);
      }
    }
    console.log(`${diffs.length ? "DIFF" : "SAME"} ${id}/${name}` + (diffs.length ? "\n  " + diffs.join("\n  ") : ""));
    if (diffs.length) bad++;
  }
}
process.exit(bad ? 1 : 0);
