/**
 * The IPUMS DDI codebook (XML), read with a small XML parser (no XML package is installed): elements with local
 * names (namespace prefixes and URIs dropped, as the Python code strips "{ns}"), attributes, text, entities,
 * CDATA; comments, processing instructions and the DOCTYPE are skipped. Port of fetch.py parse_ddi.
 */
import fs from "node:fs";

export type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[] };

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? all;
  });
}
const local = (n: string) => n.slice(n.indexOf(":") + 1);

export function parseXml(text: string): El {
  const root: El = { tag: "#document", attrs: {}, kids: [] };
  const stack: El[] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      stack[stack.length - 1].kids.push(decode(text.slice(i)));
      break;
    }
    if (lt > i) stack[stack.length - 1].kids.push(decode(text.slice(i, lt)));
    if (text.startsWith("<!--", lt)) {
      const e = text.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const e = text.indexOf("]]>", lt + 9);
      stack[stack.length - 1].kids.push(text.slice(lt + 9, e < 0 ? n : e));
      i = e < 0 ? n : e + 3;
    } else if (text.startsWith("<?", lt)) {
      const e = text.indexOf("?>", lt + 2);
      i = e < 0 ? n : e + 2;
    } else if (text.startsWith("<!", lt)) {
      let depth = 0, j = lt;
      for (; j < n; j++) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") depth--;
        else if (text[j] === ">" && depth <= 0) break;
      }
      i = j + 1;
    } else if (text[lt + 1] === "/") {
      const e = text.indexOf(">", lt);
      const name = local(text.slice(lt + 2, e).trim());
      while (stack.length > 1) {
        const top = stack.pop()!;
        if (top.tag === name) break;
      }
      i = e + 1;
    } else {
      // a start tag: find its end outside quoted attribute values
      let j = lt + 1, q = "";
      for (; j < n; j++) {
        const c = text[j];
        if (q) {
          if (c === q) q = "";
        } else if (c === '"' || c === "'") q = c;
        else if (c === ">") break;
      }
      let body = text.slice(lt + 1, j);
      const selfClose = body.endsWith("/");
      if (selfClose) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      const el: El = { tag: local(m ? m[1] : ""), attrs: {}, kids: [] };
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = re.exec(body.slice(m ? m[1].length : 0)))) {
        const name = a[1];
        if (name === "xmlns" || name.startsWith("xmlns:")) continue;
        el.attrs[name.includes(":") ? local(name) : name] = decode(a[3] ?? a[4] ?? "");
      }
      stack[stack.length - 1].kids.push(el);
      if (!selfClose) stack.push(el);
      i = j + 1;
    }
  }
  const top = root.kids.find((k): k is El => typeof k !== "string");
  if (!top) throw new Error("not an XML document");
  return top;
}

/** Every element in document order (ElementTree iter()). */
export function* iter(el: El): Generator<El> {
  yield el;
  for (const k of el.kids) if (typeof k !== "string") yield* iter(k);
}

function itertext(el: El): string {
  return el.kids.map((k) => (typeof k === "string" ? k : itertext(k))).join("");
}

const child = (el: El | null | undefined, name: string): El | null =>
  (el?.kids.find((k): k is El => typeof k !== "string" && k.tag === name) as El | undefined) ?? null;
const text = (el: El | null) => (el ? itertext(el).split(/\s+/).filter(Boolean).join(" ") : "");

// "99999999 = N.I.U. (Not in Universe)." in a continuous variable's coding notes (INCBUS, INCFARM ...): the DDI has
// no category rows for these, so without this the code survives clean_missing and adds $100M to a sum.
const SPECIAL_CODE = /(?<![\d.])(\d{2,}(?:\.\d+)?)\s*=\s*((?:N\.?\s?I\.?\s?U\.?|N\/A|Not in universe|Missing|Not applicable|Unknown)[^.;=\d]{0,30})/gi;

export type VarRow = { variable: string; label: string; type: string; start: string; width: string; decimals: string };
export type CodeRow = { variable: string; variable_label: string; value: string; value_label: string };

const intText = (v: string) => BigInt(v).toString();

export function parseDdi(file: string): [VarRow[], CodeRow[], string] {
  const root = parseXml(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  const vars: VarRow[] = [], codes: CodeRow[] = [];
  let citation = "", series = "", doi = "";
  for (const el of iter(root)) {
    const t = el.tag;
    if (t === "biblCit" && !citation) citation = text(el);
    if (t === "serName" && !series) series = text(el);
    if (t === "serInfo" && !doi) doi = text(el).replace("DOI:", "").trim();
    if (t !== "var") continue;
    const name = el.attrs.name ?? el.attrs.ID ?? "";
    const label = text(child(el, "labl"));
    const loc = child(el, "location"), fmt = child(el, "varFormat");
    vars.push({ variable: name, label, type: fmt ? fmt.attrs.type ?? "" : "", start: loc ? loc.attrs.StartPos ?? "" : "",
      width: loc ? loc.attrs.width ?? "" : "", decimals: el.attrs.dcml ?? "" });
    const n0 = codes.length;
    for (const cat of el.kids) {
      if (typeof cat === "string" || cat.tag !== "catgry") continue;
      let val = text(child(cat, "catValu"));
      if (/^\d+$/.test(val)) val = intText(val); // '073' -> '73' so it matches the numeric CSV value
      codes.push({ variable: name, variable_label: label, value: val, value_label: text(child(cat, "labl")) });
    }
    if (codes.length === n0) { // continuous: special codes are only stated in the description
      const notes = text(child(el, "codInstr")) + " " + text(child(el, "txt"));
      for (const m of notes.matchAll(SPECIAL_CODE)) {
        const [val, lab] = [m[1], m[2]];
        codes.push({ variable: name, variable_label: label, value: val.includes(".") ? val : intText(val),
          value_label: `${lab.trim()} (stated in the variable description)` });
      }
    }
  }
  if (!citation && series && doi) {
    citation = `${series} [dataset], DOI ${doi} (https://doi.org/${doi}). Minneapolis, MN: IPUMS. ` +
      "Full author list: see the collection's citation page.";
  }
  return [vars, codes, citation];
}
