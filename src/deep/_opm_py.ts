/** Python behaviors the opm pack's messages depend on: repr() of simple values and difflib.get_close_matches. */
import { pyFloatRepr } from "../core/py.js";

/** repr() of a str, number, bool, None or a list of them. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.entries(v as object).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  return String(v);
}

/** difflib.SequenceMatcher(None, a, b).ratio() (no junk; strings shorter than 200, so no autojunk). */
export function ratio(a: string, b: string): number {
  const b2j = new Map<string, number[]>();
  [...b].forEach((c, j) => (b2j.get(c) ?? b2j.set(c, []).get(c)!).push(j));
  const longest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let [bi, bj, bs] = [alo, blo, 0];
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const nj = new Map<number, number>();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        nj.set(j, k);
        if (k > bs) [bi, bj, bs] = [i - k + 1, j - k + 1, k];
      }
      j2len = nj;
    }
    return [bi, bj, bs];
  };
  let matches = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) continue;
    matches += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  const t = a.length + b.length;
  return t ? (2 * matches) / t : 1;
}

/** difflib.get_close_matches(word, possibilities, n, cutoff): best first, ties by the larger string. */
export function closeMatches(word: string, possibilities: string[], n = 3, cutoff = 0.6): string[] {
  const scored: [number, string][] = [];
  for (const x of possibilities) {
    const r = ratio(x, word);
    if (r >= cutoff) scored.push([r, x]);
  }
  scored.sort((p, q) => (q[0] - p[0]) || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
  return scored.slice(0, n).map(([, x]) => x);
}
