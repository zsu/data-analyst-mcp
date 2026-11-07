/**
 * A small XML reader with xml.etree.ElementTree's shape (used by the govinfo and congress adapters; core has no
 * XML parser): tag ("{uri}local" for namespaced names), attrib, children, text and tail; comments, processing
 * instructions and the DOCTYPE are dropped (text around them joins, as with ET.fromstring); CDATA is text.
 * find / findall take ElementPath's plain child paths ("a/b", "{ns}tag").
 */
export class XmlParseError extends Error {}

export class El {
  tag: string;
  attrib: Record<string, string>;
  children: El[] = [];
  text: string | null = null;
  tail: string | null = null;
  constructor(tag: string, attrib: Record<string, string>) {
    this.tag = tag;
    this.attrib = attrib;
  }
  get(name: string, dflt = ""): string {
    return name in this.attrib ? this.attrib[name] : dflt;
  }
  findall(path: string): El[] {
    let cur: El[] = [this];
    for (const step of steps(path)) {
      const next: El[] = [];
      for (const e of cur) for (const c of e.children) if (step === "*" || c.tag === step) next.push(c);
      cur = next;
    }
    return cur;
  }
  find(path: string): El | null {
    return this.findall(path)[0] ?? null;
  }
  *itertext(): Generator<string> {
    if (this.text) yield this.text;
    for (const c of this.children) {
      yield* c.itertext();
      if (c.tail) yield c.tail;
    }
  }
}

function steps(path: string): string[] {
  return (path.match(/\{[^}]*\}[^/]*|[^/]+/g) || []).filter((s) => s !== ".");
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const NAME = /^[^\s/>=]+/;

function decode(s: string, where: number): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (m, g: string) => {
    if (g[0] === "#") return String.fromCodePoint(g[1] === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (g in named) return named[g];
    throw new XmlParseError(`undefined entity ${m}: offset ${where}`);
  });
}

/** ET.fromstring. */
export function fromstring(src: string | Uint8Array): El {
  let s = typeof src === "string" ? src : Buffer.from(src).toString("utf8");
  s = s.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const stack: El[] = [];
  const nsStack: Record<string, string>[] = [{ xml: XML_NS }];
  let root: El | null = null;
  let buf = "";
  let last: El | null = null;          // the element whose text (open) or tail (closed) gets the buffered data
  let lastIsOpen = false;
  const flush = () => {
    if (!buf) return;
    if (last) {
      if (lastIsOpen) last.text = (last.text ?? "") + buf;
      else last.tail = (last.tail ?? "") + buf;
    }
    buf = "";
  };
  const qname = (name: string, ns: Record<string, string>, attr: boolean): string => {
    const i = name.indexOf(":");
    if (i < 0) return attr || !ns[""] ? name : `{${ns[""]}}${name}`;
    const pre = name.slice(0, i), local = name.slice(i + 1);
    if (!(pre in ns)) throw new XmlParseError(`unbound prefix: ${name}`);
    return `{${ns[pre]}}${local}`;
  };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      if (stack.length) throw new XmlParseError("no element found");
      if (s.slice(i).trim()) throw new XmlParseError("junk after document element");
      break;
    }
    if (lt > i) {
      const t = s.slice(i, lt);
      if (stack.length) buf += decode(t, i);
      else if (t.trim()) throw new XmlParseError(`syntax error: offset ${i}`);
    }
    if (s.startsWith("<!--", lt)) {
      const e = s.indexOf("-->", lt + 4);
      if (e < 0) throw new XmlParseError("unclosed comment");
      i = e + 3;
    } else if (s.startsWith("<![CDATA[", lt)) {
      const e = s.indexOf("]]>", lt + 9);
      if (e < 0) throw new XmlParseError("unclosed CDATA section");
      if (stack.length) buf += s.slice(lt + 9, e);
      i = e + 3;
    } else if (s.startsWith("<?", lt)) {
      const e = s.indexOf("?>", lt + 2);
      if (e < 0) throw new XmlParseError("unclosed processing instruction");
      i = e + 2;
    } else if (s.startsWith("<!", lt)) {
      let j = lt + 2, depth = 0;
      for (; j < n; j++) {
        if (s[j] === "[") depth++;
        else if (s[j] === "]") depth--;
        else if (s[j] === ">" && depth <= 0) break;
      }
      i = j + 1;
    } else if (s[lt + 1] === "/") {
      const e = s.indexOf(">", lt);
      if (e < 0) throw new XmlParseError("unclosed end tag");
      const raw = s.slice(lt + 2, e).trim();
      const top = stack.pop();
      const ns = nsStack.pop()!;
      if (!top || qname(raw, ns, false) !== top.tag) throw new XmlParseError(`mismatched tag: offset ${lt}`);
      flush();
      last = top;
      lastIsOpen = false;
      i = e + 1;
    } else {
      let j = lt + 1;
      const m = NAME.exec(s.slice(j, j + 400));
      if (!m) throw new XmlParseError(`not well-formed (invalid token): offset ${lt}`);
      const name = m[0];
      j += name.length;
      const raw: [string, string][] = [];
      let selfClose = false;
      for (;;) {
        while (j < n && /\s/.test(s[j])) j++;
        if (s[j] === ">") {
          j++;
          break;
        }
        if (s[j] === "/" && s[j + 1] === ">") {
          selfClose = true;
          j += 2;
          break;
        }
        const am = NAME.exec(s.slice(j, j + 400));
        if (!am) throw new XmlParseError(`not well-formed (invalid token): offset ${j}`);
        j += am[0].length;
        while (/\s/.test(s[j])) j++;
        if (s[j] !== "=") throw new XmlParseError(`not well-formed (invalid token): offset ${j}`);
        j++;
        while (/\s/.test(s[j])) j++;
        const q = s[j];
        if (q !== '"' && q !== "'") throw new XmlParseError(`not well-formed (invalid token): offset ${j}`);
        const e = s.indexOf(q, j + 1);
        if (e < 0) throw new XmlParseError("unclosed attribute");
        raw.push([am[0], decode(s.slice(j + 1, e).replace(/[\t\n]/g, " "), j)]);
        j = e + 1;
      }
      const ns = { ...nsStack[nsStack.length - 1] };
      for (const [k, v] of raw) {
        if (k === "xmlns") ns[""] = v;
        else if (k.startsWith("xmlns:")) ns[k.slice(6)] = v;
      }
      const attrib: Record<string, string> = {};
      for (const [k, v] of raw) if (k !== "xmlns" && !k.startsWith("xmlns:")) attrib[qname(k, ns, true)] = v;
      const el = new El(qname(name, ns, false), attrib);
      flush();
      if (stack.length) stack[stack.length - 1].children.push(el);
      else if (root) throw new XmlParseError("junk after document element");
      else root = el;
      last = el;
      lastIsOpen = true;
      if (selfClose) {
        last = el;
        lastIsOpen = false;
      } else {
        stack.push(el);
        nsStack.push(ns);
      }
      i = j;
    }
  }
  if (stack.length || !root) throw new XmlParseError("no element found");
  return root;
}
