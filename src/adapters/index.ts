/**
 * The registry of ported pack code, found by file name (no list to edit, so packs can be ported in parallel):
 *   src/adapters/<id>.ts   a standard pack's adapter (default export: Adapter)
 *   src/deep/<id>.ts       a deep pack (default export: DeepPack, see src/core/packs.ts)
 * packs/port.json lists which packs still need theirs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Adapter, DeepPack } from "../core/packs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function finder<T>(dir: string): (id: string) => (() => Promise<T>) | undefined {
  return (id) => {
    if (!/^[a-z0-9-]+$/.test(id)) return undefined;
    for (const ext of [".js", ".ts"]) {
      const file = path.join(dir, id + ext);
      if (fs.existsSync(file)) return async () => (await import(pathToFileURL(file).href)).default as T;
    }
    return undefined;
  };
}

export const findAdapter = finder<Adapter>(HERE);
export const findDeep = finder<DeepPack>(path.join(HERE, "..", "deep"));
