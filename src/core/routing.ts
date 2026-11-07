/**
 * Cross-referencing hints: the rows of guide/references/routing.md (Question | Primary | Cross-check / context |
 * Note) that name a source, so source_brief can say which agencies a question usually pairs it with.
 */
import fs from "node:fs";
import path from "node:path";
import { GUIDE_DIR } from "./env.js";
import { allPackIds } from "./packs.js";

export type Pairing = { question: string; primary: string[]; cross_check: string[]; context: string; note: string };

let rows: Pairing[] | null = null;

/** Source ids named in a cell, in order (words that are not pack ids, like "cbo publications", are context). */
function ids(cell: string, known: Set<string>): string[] {
  return [...new Set((cell.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || []).filter((w) => known.has(w)))];
}

export function routingRows(): Pairing[] {
  if (rows) return rows;
  const file = path.join(GUIDE_DIR, "references", "routing.md");
  const known = new Set(allPackIds());
  rows = [];
  if (!fs.existsSync(file)) return rows;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || cells[0].toLowerCase() === "question") continue;
    const primary = ids(cells[1], known);
    if (!primary.length) continue;
    rows.push({ question: cells[0], primary, cross_check: ids(cells[2], known), context: cells[2], note: cells[3] || "" });
  }
  return rows;
}

/** The routing rows that name this source, as primary or as a cross-check. */
export function pairingsFor(source: string): Pairing[] {
  return routingRows().filter((r) => r.primary.includes(source) || r.cross_check.includes(source));
}
