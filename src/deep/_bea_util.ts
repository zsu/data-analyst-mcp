/**
 * Python-compatible helpers the bea pack needs beyond core (csv.reader, float(), str(), html.unescape and the
 * utf-8-sig / latin-1 decoding of BEA's bulk files), so the CSVs match the Python skill's byte for byte.
 */
import { pyFloatRepr } from "../core/py.js";

/** csv.reader on a whole text (default dialect, strict off): a blank line is [], quotes only open a field. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let state: "rec" | "start" | "field" | "quoted" | "quote" = "rec";
  const endRecord = () => {
    rows.push(row);
    row = [];
    field = "";
    state = "rec";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const nl = c === "\n" || c === "\r";
    if (nl && c === "\r" && text[i + 1] === "\n" && state !== "quoted") i++;
    if (state === "rec") {
      if (nl) {
        rows.push([]);
        continue;
      }
      state = "start";
    }
    switch (state) {
      case "start":
        if (nl) {
          row.push("");
          endRecord();
        } else if (c === '"') {
          field = "";
          state = "quoted";
        } else if (c === ",") row.push("");
        else {
          field = c;
          state = "field";
        }
        break;
      case "field":
        if (nl) {
          row.push(field);
          endRecord();
        } else if (c === ",") {
          row.push(field);
          field = "";
          state = "start";
        } else field += c;
        break;
      case "quoted":
        if (c === '"') state = "quote";
        else field += c;
        break;
      case "quote":
        if (c === '"') {
          field += '"';
          state = "quoted";
        } else if (c === ",") {
          row.push(field);
          field = "";
          state = "start";
        } else if (nl) {
          row.push(field);
          endRecord();
        } else {
          field += c;
          state = "field";
        }
        break;
    }
  }
  if (state !== "rec") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Python float(s) for a stripped string: null when Python would raise ValueError. */
export function pyFloat(s: string): number | null {
  const t = s.trim();
  const sp = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (sp) return sp[2].toLowerCase() === "nan" ? NaN : sp[1] === "-" ? -Infinity : Infinity;
  const d = "\\d(?:_?\\d)*";
  if (!new RegExp(`^[+-]?(?:(?:${d})?\\.${d}|${d}\\.?)(?:[eE][+-]?${d})?$`).test(t)) return null;
  return Number(t.replace(/_/g, ""));
}

/** Python str() of a JSON value (spec fields): None, True/False, ints, float repr, lists as repr. */
export function pyS(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(v) : pyFloatRepr(v);
  const repr = (x: unknown): string => (typeof x === "string" ? `'${x.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` : pyS(x));
  if (Array.isArray(v)) return "[" + v.map(repr).join(", ") + "]";
  return "{" + Object.entries(v as object).map(([k, x]) => `${repr(k)}: ${repr(x)}`).join(", ") + "}";
}

/** Truthiness as Python sees a JSON value. */
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return !!v;
}

/** bytes.decode("utf-8-sig"), else latin-1 (read_text_member). */
export function decodeSigLatin1(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b).replace(/^﻿/, "");
  } catch {
    return Buffer.from(b).toString("latin1");
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘",
  rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", copy: "©", reg: "®", deg: "°",
  sect: "§", para: "¶", middot: "·", bull: "•", frac12: "½", frac14: "¼", frac34: "¾",
  times: "×", divide: "÷", plusmn: "±", cent: "¢", pound: "£", euro: "€", trade: "™",
};

/** html.unescape for the entities BEA's footnote pages use (named, decimal and hex). */
export function htmlUnescape(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Python sorted() on strings (code point order). */
export const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
