/**
 * Short forms of long lists for tool results and messages: a model reads every character of a result, so a wide
 * table's column list is collapsed (numbered runs such as PWGTP1..PWGTP80 become one entry) and capped, and an
 * unknown-name message lists the nearest names instead of all of them.
 */

/** Collapse runs of the same stem with consecutive numbers: [A, W1, W2, W3, B] -> [A, "W1-3", B] (runs of 3 or more). */
export function collapseRuns(names: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < names.length) {
    const m = /^(.*?)(\d+)$/.exec(names[i]);
    if (m) {
      const [, stem, first] = m;
      let j = i + 1;
      let n = Number(first);
      while (j < names.length) {
        const k = /^(.*?)(\d+)$/.exec(names[j]);
        if (!k || k[1] !== stem || Number(k[2]) !== n + 1 || k[2].length > 1 && k[2].startsWith("0")) break;
        n += 1;
        j += 1;
      }
      if (j - i >= 3 && !first.startsWith("0")) {
        out.push(`${stem}${first}-${n}`);
        i = j;
        continue;
      }
    }
    out.push(names[i]);
    i += 1;
  }
  return out;
}

/** A column list for a result: as is up to `max` names; past that, runs collapsed and at most `max` entries. */
export function columnList(names: string[], max = 40): string[] {
  if (names.length <= max) return names;
  const c = collapseRuns(names);
  return c.length <= max ? c : [...c.slice(0, max), `+${c.length - max} more (${names.length} columns in all)`];
}

/** Levenshtein distance, case-insensitive, capped early for long names. */
function distance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** The `n` names closest to `want` (substring matches first, then edit distance). */
export function nearest(want: string, names: string[], n = 5): string[] {
  const w = want.toLowerCase();
  return names
    .map((name, i) => {
      const l = name.toLowerCase();
      const sub = l.includes(w) || w.includes(l) ? 0 : 1;
      return { name, i, score: sub * 1000 + distance(w, l) };
    })
    .sort((x, y) => x.score - y.score || x.i - y.i)
    .slice(0, n)
    .map((x) => x.name);
}

/** "the columns are [...]" when there are few, else the nearest names to each missing one and the count. */
export function namesHint(missing: string[], names: string[], what = "columns", repr: (v: unknown) => string = JSON.stringify,
  max = 25): string {
  if (names.length <= max) return `the ${what} are ${repr(names)}`;
  const near: string[] = [];
  for (const m of missing) for (const x of nearest(m, names)) if (!near.includes(x)) near.push(x);
  return `the nearest ${what} are ${repr(near.slice(0, 8))} (${names.length} ${what} in all: ${repr(columnList(names, 12))})`;
}

/** The names that belong to a numbered run of at least `min` (replicate weights such as PWGTP1..PWGTP80). */
export function inLongRun(names: string[], min = 10): Set<string> {
  const out = new Set<string>();
  const stems = new Map<string, string[]>();
  for (const n of names) {
    const m = /^(.*?)(\d+)$/.exec(n);
    if (m) stems.set(m[1], [...(stems.get(m[1]) || []), n]);
  }
  for (const group of stems.values()) if (group.length >= min) for (const n of group) out.add(n);
  return out;
}
