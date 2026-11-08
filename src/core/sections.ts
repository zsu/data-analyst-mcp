/**
 * Markdown split on its `## ` headings, so a long playbook or guide file can be served a section at a time.
 * The text before the first `## ` (the `# ` title and its lead paragraph) is the preamble, with an empty title.
 */

export type Section = { title: string; text: string };

export function splitSections(md: string): Section[] {
  const out: Section[] = [{ title: "", text: "" }];
  let fence = false;
  for (const line of md.split(/(?<=\n)/)) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = !fence ? /^## +(.+?)\s*$/.exec(line) : null;
    if (m) out.push({ title: m[1], text: line });
    else out[out.length - 1].text += line;
  }
  return out[0].text.trim() ? out : out.slice(1);
}

/** A title without its numbering and markup: "5. Publication structure (`build_report`...)" -> "publication structure ...". */
function norm(t: string): string {
  return t.toLowerCase().replace(/[`*_"]/g, "").replace(/^\d+[a-z]?\.\s*/, "").trim();
}

/** The section a name means: an exact title, its number ("5"), or the one title it starts or is contained in. */
export function findSection(secs: Section[], name: string): Section | undefined {
  const n = norm(name);
  const titled = secs.filter((s) => s.title);
  return titled.find((s) => norm(s.title) === n)
    ?? (/^\d+[a-z]?\.?$/i.test(name.trim())
      ? titled.find((s) => s.title.trim().toLowerCase().startsWith(name.trim().toLowerCase().replace(/\.?$/, ".")))
      : undefined)
    ?? (() => {
      const hits = titled.filter((s) => norm(s.title).startsWith(n) || norm(s.title).includes(n));
      return hits.length === 1 ? hits[0] : hits.find((s) => norm(s.title).startsWith(n));
    })();
}

/** Every section's title and size, for an outline. */
export function outline(secs: Section[]): { section: string; chars: number }[] {
  return secs.filter((s) => s.title).map((s) => ({ section: s.title, chars: s.text.length }));
}

/** The sections named, in the file's order; the names that match none come back in `unknown`. */
export function pick(secs: Section[], names: string[]): { text: string; unknown: string[] } {
  const want = new Set<Section>();
  const unknown: string[] = [];
  for (const n of names) {
    const s = findSection(secs, n);
    if (s) want.add(s);
    else unknown.push(n);
  }
  return { text: secs.filter((s) => want.has(s)).map((s) => s.text).join("").trimEnd() + "\n", unknown };
}
