/**
 * Parquet with Node built-ins only (no Parquet package is installed): a reader for flat files (the OPM FWD API
 * serves every column as an optional UTF-8 string; compute reads data/<id>/*.parquet inputs with it) and a small
 * writer (the opm pack's filtered tables).
 *
 * Reader: Thrift compact footer, data pages v1 and v2, dictionary pages; encodings PLAIN, PLAIN_DICTIONARY,
 * RLE_DICTIONARY, RLE (booleans), DELTA_BINARY_PACKED, DELTA_LENGTH_BYTE_ARRAY, DELTA_BYTE_ARRAY,
 * BYTE_STREAM_SPLIT; codecs UNCOMPRESSED, SNAPPY, GZIP, BROTLI, ZSTD, LZ4_RAW. Values come back as strings, the
 * way pandas `astype("string")` shows them (ints as digits, floats as Python repr, booleans True/False), and
 * nulls as null.
 * Writer: one data page v1 per column and row group, PLAIN values, RLE definition levels, ZSTD compression.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { pyFloatRepr } from "../core/py.js";

// ---------------------------------------------------------------------- Thrift compact protocol
class TReader {
  constructor(public b: Buffer, public pos = 0) {}
  byte(): number {
    if (this.pos >= this.b.length) throw new Error("truncated Parquet metadata");
    return this.b[this.pos++];
  }
  varint(): number {
    let n = 0, mul = 1;
    for (;;) {
      const x = this.byte();
      n += (x & 0x7f) * mul;
      if (!(x & 0x80)) return n;
      mul *= 128;
    }
  }
  varbig(): bigint {
    let n = 0n, shift = 0n;
    for (;;) {
      const x = this.byte();
      n |= BigInt(x & 0x7f) << shift;
      if (!(x & 0x80)) return n;
      shift += 7n;
    }
  }
  zz32(): number {
    const n = this.varint();
    return n % 2 ? -(n + 1) / 2 : n / 2;
  }
  zz64(): number {
    const n = this.varbig();
    return Number((n >> 1n) ^ -(n & 1n));
  }
  binary(): Buffer {
    const n = this.varint();
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  value(t: number): any {
    switch (t) {
      case 1: return true;
      case 2: return false;
      case 3: return (this.byte() << 24) >> 24;
      case 4: case 5: return this.zz32();
      case 6: return this.zz64();
      case 7: {
        const v = this.b.readDoubleLE(this.pos);
        this.pos += 8;
        return v;
      }
      case 8: return this.binary();
      case 9: case 10: return this.list();
      case 11: return this.map();
      case 12: return this.struct();
      default: throw new Error(`Parquet metadata: unknown Thrift type ${t}`);
    }
  }
  list(): any[] {
    const h = this.byte();
    let n = h >> 4;
    const et = h & 15;
    if (n === 15) n = this.varint();
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = et === 1 || et === 2 ? this.byte() === 1 : this.value(et);
    return out;
  }
  map(): [any, any][] {
    const n = this.varint();
    if (!n) return [];
    const kv = this.byte();
    const out: [any, any][] = [];
    for (let i = 0; i < n; i++) out.push([this.value(kv >> 4), this.value(kv & 15)]);
    return out;
  }
  struct(): Record<number, any> {
    const out: Record<number, any> = {};
    let last = 0;
    for (;;) {
      const h = this.byte();
      if (h === 0) return out;
      const t = h & 15, d = h >> 4;
      const id = d ? last + d : this.zz32();
      last = id;
      out[id] = this.value(t);
    }
  }
}

/** A Thrift compact struct writer (fields in increasing id order). */
class TWriter {
  out: number[] = [];
  private last: number[] = [0];
  private raw(...b: number[]) {
    for (const x of b) this.out.push(x);
  }
  private varint(n: number) {
    while (n >= 0x80) {
      this.out.push((n % 128) | 0x80);
      n = Math.floor(n / 128);
    }
    this.out.push(n);
  }
  private zz(n: number) {
    this.varint(n >= 0 ? n * 2 : -n * 2 - 1);
  }
  private field(id: number, type: number) {
    const top = this.last.length - 1;
    const d = id - this.last[top];
    if (d > 0 && d <= 15) this.raw((d << 4) | type);
    else {
      this.raw(type);
      this.zz(id);
    }
    this.last[top] = id;
  }
  i32(id: number, v: number): this {
    this.field(id, 5);
    this.zz(v);
    return this;
  }
  i64(id: number, v: number): this {
    this.field(id, 6);
    this.zz(v);
    return this;
  }
  bin(id: number, v: string | Buffer): this {
    const b = typeof v === "string" ? Buffer.from(v, "utf8") : v;
    this.field(id, 8);
    this.varint(b.length);
    for (const x of b) this.out.push(x);
    return this;
  }
  struct(id: number, body: (w: TWriter) => void): this {
    this.field(id, 12);
    this.last.push(0);
    body(this);
    this.raw(0);
    this.last.pop();
    return this;
  }
  private listHead(n: number, et: number) {
    if (n < 15) this.raw((n << 4) | et);
    else {
      this.raw(0xf0 | et);
      this.varint(n);
    }
  }
  listI32(id: number, vals: number[]): this {
    this.field(id, 9);
    this.listHead(vals.length, 5);
    for (const v of vals) this.zz(v);
    return this;
  }
  listBin(id: number, vals: string[]): this {
    this.field(id, 9);
    this.listHead(vals.length, 8);
    for (const v of vals) {
      const b = Buffer.from(v, "utf8");
      this.varint(b.length);
      for (const x of b) this.out.push(x);
    }
    return this;
  }
  listStruct(id: number, items: ((w: TWriter) => void)[]): this {
    this.field(id, 9);
    this.listHead(items.length, 12);
    for (const body of items) {
      this.last.push(0);
      body(this);
      this.raw(0);
      this.last.pop();
    }
    return this;
  }
  end(): Buffer {
    this.raw(0);
    return Buffer.from(this.out);
  }
}

// ---------------------------------------------------------------------- codecs
function snappy(src: Buffer): Buffer {
  let pos = 0, len = 0, mul = 1;
  for (;;) {
    const b = src[pos++];
    len += (b & 0x7f) * mul;
    if (!(b & 0x80)) break;
    mul *= 128;
  }
  const out = Buffer.allocUnsafe(len);
  let o = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const t = tag & 3;
    if (t === 0) {
      let l = tag >> 2;
      if (l >= 60) {
        const nb = l - 59;
        l = 0;
        for (let i = 0; i < nb; i++) l += src[pos + i] * 2 ** (8 * i);
        pos += nb;
      }
      l += 1;
      src.copy(out, o, pos, pos + l);
      pos += l;
      o += l;
      continue;
    }
    let l: number, off: number;
    if (t === 1) {
      l = ((tag >> 2) & 7) + 4;
      off = ((tag >> 5) << 8) | src[pos++];
    } else if (t === 2) {
      l = (tag >> 2) + 1;
      off = src.readUInt16LE(pos);
      pos += 2;
    } else {
      l = (tag >> 2) + 1;
      off = src.readUInt32LE(pos);
      pos += 4;
    }
    if (!off || off > o) throw new Error("corrupt Snappy data");
    for (let i = 0; i < l; i++) out[o + i] = out[o - off + i];
    o += l;
  }
  return out.subarray(0, o);
}

function lz4Raw(src: Buffer, size: number): Buffer {
  const out = Buffer.allocUnsafe(size);
  let pos = 0, o = 0;
  while (pos < src.length) {
    const token = src[pos++];
    let lit = token >> 4;
    if (lit === 15) {
      let b;
      do {
        b = src[pos++];
        lit += b;
      } while (b === 255);
    }
    src.copy(out, o, pos, pos + lit);
    pos += lit;
    o += lit;
    if (pos >= src.length) break;
    const off = src[pos] | (src[pos + 1] << 8);
    pos += 2;
    let ml = token & 15;
    if (ml === 15) {
      let b;
      do {
        b = src[pos++];
        ml += b;
      } while (b === 255);
    }
    ml += 4;
    for (let i = 0; i < ml; i++) out[o + i] = out[o - off + i];
    o += ml;
  }
  return out.subarray(0, o);
}

const CODECS = ["UNCOMPRESSED", "SNAPPY", "GZIP", "LZO", "BROTLI", "LZ4", "ZSTD", "LZ4_RAW"];

function decompress(codec: number, data: Buffer, size: number): Buffer {
  switch (codec) {
    case 0: return data;
    case 1: return snappy(data);
    case 2: return zlib.gunzipSync(data);
    case 4: return zlib.brotliDecompressSync(data);
    case 6: return (zlib as any).zstdDecompressSync(data);
    case 7: return lz4Raw(data, size);
    default: throw new Error(`Parquet codec ${CODECS[codec] ?? codec} is not supported here`);
  }
}

// ---------------------------------------------------------------------- level and value decoders
function uvarint(b: Buffer, st: { pos: number }): number {
  let n = 0, mul = 1;
  for (;;) {
    const x = b[st.pos++];
    n += (x & 0x7f) * mul;
    if (!(x & 0x80)) return n;
    mul *= 128;
  }
}

/** Read `count` values of `width` bits, LSB first, starting at byte `pos`. */
function unpack(b: Buffer, pos: number, width: number, count: number, out: number[] | Int32Array, at: number): void {
  if (width === 0) {
    for (let i = 0; i < count; i++) out[at + i] = 0;
    return;
  }
  let bit = pos * 8;
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let k = 0; k < width;) {
      const byte = b[bit >> 3] ?? 0;
      const off = bit & 7;
      const take = Math.min(8 - off, width - k);
      v += ((byte >> off) & ((1 << take) - 1)) * 2 ** k;
      k += take;
      bit += take;
    }
    out[at + i] = v;
  }
}

/** The RLE / bit-packing hybrid encoding (definition levels, dictionary indexes, booleans). */
function rleHybrid(b: Buffer, pos: number, end: number, width: number, count: number): Int32Array {
  const out = new Int32Array(count);
  const st = { pos };
  const bw = (width + 7) >> 3;
  let i = 0;
  while (i < count && st.pos < end) {
    const h = uvarint(b, st);
    if (h & 1) {
      const n = (h >>> 1) * 8;
      const tmp: number[] = new Array(n);
      unpack(b, st.pos, width, n, tmp, 0);
      st.pos += (h >>> 1) * width;
      for (let k = 0; k < n && i < count; k++) out[i++] = tmp[k];
    } else {
      const run = h >>> 1;
      let v = 0;
      for (let k = 0; k < bw; k++) v += b[st.pos + k] * 2 ** (8 * k);
      st.pos += bw;
      for (let k = 0; k < run && i < count; k++) out[i++] = v;
    }
  }
  return out;
}

/** DELTA_BINARY_PACKED: the values and the position after them. */
function deltaBinary(b: Buffer, pos: number): [number[], number] {
  const st = { pos };
  const block = uvarint(b, st), minis = uvarint(b, st), total = uvarint(b, st);
  const zz = (n: number) => (n % 2 ? -(n + 1) / 2 : n / 2);
  const out: number[] = [];
  if (!total) return [out, st.pos];
  let v = zz(uvarint(b, st));
  out.push(v);
  const per = block / minis;
  while (out.length < total) {
    const minDelta = zz(uvarint(b, st));
    const widths = b.subarray(st.pos, st.pos + minis);
    st.pos += minis;
    for (let m = 0; m < minis && out.length < total; m++) {
      const w = widths[m];
      const tmp: number[] = new Array(per);
      unpack(b, st.pos, w, per, tmp, 0);
      st.pos += (per * w) / 8;
      for (let k = 0; k < per && out.length < total; k++) {
        v += minDelta + tmp[k];
        out.push(v);
      }
    }
  }
  return [out, st.pos];
}

type Col = { name: string; type: number; converted?: number; logical?: Record<number, any>; maxDef: number; typeLength?: number };

function plainValues(col: Col, b: Buffer, pos: number, count: number): [any[], number] {
  const out = new Array(count);
  switch (col.type) {
    case 0: // BOOLEAN, bit-packed
      for (let i = 0; i < count; i++) out[i] = ((b[pos + (i >> 3)] >> (i & 7)) & 1) === 1;
      return [out, pos + Math.ceil(count / 8)];
    case 1:
      for (let i = 0; i < count; i++) out[i] = b.readInt32LE(pos + 4 * i);
      return [out, pos + 4 * count];
    case 2:
      for (let i = 0; i < count; i++) out[i] = b.readBigInt64LE(pos + 8 * i);
      return [out, pos + 8 * count];
    case 4:
      for (let i = 0; i < count; i++) out[i] = b.readFloatLE(pos + 4 * i);
      return [out, pos + 4 * count];
    case 5:
      for (let i = 0; i < count; i++) out[i] = b.readDoubleLE(pos + 8 * i);
      return [out, pos + 8 * count];
    case 6:
      for (let i = 0; i < count; i++) {
        const n = b.readUInt32LE(pos);
        out[i] = b.subarray(pos + 4, pos + 4 + n);
        pos += 4 + n;
      }
      return [out, pos];
    case 7: {
      const n = col.typeLength || 0;
      for (let i = 0; i < count; i++) out[i] = b.subarray(pos + n * i, pos + n * (i + 1));
      return [out, pos + n * count];
    }
    default:
      throw new Error(`Parquet column ${col.name}: physical type ${col.type} is not supported here`);
  }
}

function byteStreamSplit(col: Col, b: Buffer, pos: number, count: number): any[] {
  const w = col.type === 1 || col.type === 4 ? 4 : col.type === 7 ? col.typeLength || 0 : 8;
  const raw = Buffer.allocUnsafe(w * count);
  for (let k = 0; k < w; k++) for (let i = 0; i < count; i++) raw[i * w + k] = b[pos + k * count + i];
  return plainValues(col, raw, 0, count)[0];
}

function decodeValues(col: Col, enc: number, b: Buffer, pos: number, end: number, count: number, dict: any[] | null): any[] {
  switch (enc) {
    case 0: return plainValues(col, b, pos, count)[0];
    case 2: case 8: {
      if (!dict) throw new Error(`Parquet column ${col.name}: dictionary page missing`);
      const width = b[pos];
      const idx = rleHybrid(b, pos + 1, end, width, count);
      const out = new Array(count);
      for (let i = 0; i < count; i++) out[i] = dict[idx[i]];
      return out;
    }
    case 3: { // RLE booleans: 4-byte length, then the hybrid encoding at width 1
      const idx = rleHybrid(b, pos + 4, end, 1, count);
      return Array.from(idx, (x) => x === 1);
    }
    case 5: {
      const [vals] = deltaBinary(b, pos);
      return col.type === 2 ? vals.map((v) => BigInt(v)) : vals;
    }
    case 6: {
      const [lens, p] = deltaBinary(b, pos);
      const out = new Array(count);
      let q = p;
      for (let i = 0; i < count; i++) {
        out[i] = b.subarray(q, q + lens[i]);
        q += lens[i];
      }
      return out;
    }
    case 7: {
      const [pre, p1] = deltaBinary(b, pos);
      const [lens, p2] = deltaBinary(b, p1);
      const out = new Array(count);
      let q = p2;
      let prev = Buffer.alloc(0);
      for (let i = 0; i < count; i++) {
        const v = Buffer.concat([prev.subarray(0, pre[i]), b.subarray(q, q + lens[i])]);
        q += lens[i];
        out[i] = v;
        prev = v;
      }
      return out;
    }
    case 9: return byteStreamSplit(col, b, pos, count);
    default: throw new Error(`Parquet column ${col.name}: encoding ${enc} is not supported here`);
  }
}

/** A raw value as pandas astype("string") shows it. */
function show(col: Col, v: any): string {
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return col.type === 4 || col.type === 5 ? pyFloatRepr(v) : String(v);
  return String(v);
}

// ---------------------------------------------------------------------- reader
export class ParquetFile {
  private buf: Buffer;
  private meta: Record<number, any>;
  cols: Col[] = [];
  numRows: number;

  /** `buf`: the file's bytes when the caller has read them already. */
  constructor(public path: string, buf?: Buffer) {
    this.buf = buf ?? fs.readFileSync(path);
    const n = this.buf.length;
    if (n < 12 || this.buf.toString("latin1", 0, 4) !== "PAR1" || this.buf.toString("latin1", n - 4) !== "PAR1") {
      throw new Error(`${path} is not a Parquet file`);
    }
    const len = this.buf.readUInt32LE(n - 8);
    this.meta = new TReader(this.buf, n - 8 - len).struct();
    const schema: Record<number, any>[] = this.meta[2] || [];
    for (const el of schema.slice(1)) {
      if (el[5]) throw new Error(`${path}: nested Parquet columns are not supported here`);
      if (el[3] === 2) throw new Error(`${path}: repeated Parquet columns are not supported here`);
      this.cols.push({ name: el[4].toString("utf8"), type: el[1], converted: el[6], logical: el[10], maxDef: el[3] === 1 ? 1 : 0,
        typeLength: el[2] });
    }
    this.numRows = Number(this.meta[3] || 0);
  }

  columns(): string[] {
    return this.cols.map((c) => c.name);
  }

  /** One table per row group: {column: values}, only the named columns (all when omitted). */
  *rowGroups(names?: string[] | null): Generator<{ rows: number; data: Record<string, (string | null)[]> }> {
    const want = new Set(names ?? this.columns());
    for (const rg of (this.meta[4] || []) as Record<number, any>[]) {
      const rows = Number(rg[3]);
      const data: Record<string, (string | null)[]> = {};
      for (const cc of rg[1] as Record<number, any>[]) {
        const md = cc[3];
        const name = (md[3] as Buffer[]).map((x) => x.toString("utf8")).join(".");
        if (!want.has(name)) continue;
        const col = this.cols.find((c) => c.name === name)!;
        data[name] = this.readChunk(col, md, rows);
      }
      yield { rows, data };
    }
  }

  private readChunk(col: Col, md: Record<number, any>, rows: number): (string | null)[] {
    const codec = md[4] as number;
    const dpo = Number(md[9]);
    const dict0 = md[11] !== undefined ? Number(md[11]) : 0;
    let pos = dict0 > 0 && dict0 < dpo ? dict0 : dpo;
    const end = pos + Number(md[7]);
    const total = Number(md[5]);
    const out: (string | null)[] = new Array(rows);
    let dict: any[] | null = null;
    let got = 0;
    while (got < total && pos < end) {
      const r = new TReader(this.buf, pos);
      const h = r.struct();
      pos = r.pos;
      const csize = h[3] as number, usize = h[2] as number;
      const page = this.buf.subarray(pos, pos + csize);
      pos += csize;
      if (h[1] === 2) { // dictionary page
        const dh = h[7];
        const b = decompress(codec, page, usize);
        dict = plainValues(col, b, 0, dh[1])[0].map((v) => show(col, v));
        continue;
      }
      let defs: Int32Array | null = null;
      let b: Buffer, vpos: number, n: number, enc: number;
      if (h[1] === 0) {
        const dh = h[5];
        n = dh[1];
        enc = dh[2];
        b = decompress(codec, page, usize);
        vpos = 0;
        if (col.maxDef > 0) {
          const l = b.readUInt32LE(0);
          defs = rleHybrid(b, 4, 4 + l, 1, n);
          vpos = 4 + l;
        }
      } else if (h[1] === 3) {
        const dh = h[8];
        n = dh[1];
        enc = dh[4];
        const dl = dh[5] || 0, rl = dh[6] || 0;
        if (col.maxDef > 0) defs = rleHybrid(page, rl, rl + dl, 1, n);
        const rest = page.subarray(rl + dl);
        b = dh[7] === false || codec === 0 ? rest : decompress(codec, rest, usize - rl - dl);
        vpos = 0;
      } else continue;
      let present = n;
      if (defs) {
        present = 0;
        for (let i = 0; i < n; i++) if (defs[i] === col.maxDef) present++;
      }
      const vals = decodeValues(col, enc, b, vpos, b.length, present, enc === 2 || enc === 8 ? dict : null);
      const isDict = enc === 2 || enc === 8;
      let k = 0;
      for (let i = 0; i < n; i++) {
        if (defs && defs[i] !== col.maxDef) out[got + i] = null;
        else {
          const v = vals[k++];
          out[got + i] = isDict ? v : show(col, v);
        }
      }
      got += n;
    }
    for (let i = got; i < rows; i++) out[i] = null;
    // pandas turns an integer column with nulls into floats ("12.0"): so does this, per row group
    if ((col.type === 1 || col.type === 2) && out.some((v) => v === null)) {
      for (let i = 0; i < rows; i++) if (out[i] !== null) out[i] = pyFloatRepr(Number(out[i]));
    }
    return out;
  }
}

// ---------------------------------------------------------------------- writer
export type WriteColumn = { name: string; kind: "string" | "int64" | "double"; values: (string | number | null)[] };

function rleLevels(defs: Uint8Array): Buffer {
  const parts: number[] = [];
  const push = (n: number) => {
    while (n >= 0x80) {
      parts.push((n % 128) | 0x80);
      n = Math.floor(n / 128);
    }
    parts.push(n);
  };
  let i = 0;
  while (i < defs.length) {
    let j = i;
    while (j < defs.length && defs[j] === defs[i]) j++;
    push((j - i) * 2);
    parts.push(defs[i]);
    i = j;
  }
  const body = Buffer.from(parts);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
}

const ROW_GROUP = 1_000_000;

/** Write a flat table of optional columns (strings as UTF-8, int64, double), ZSTD-compressed. */
export function writeParquet(file: string, cols: WriteColumn[], rows: number, createdBy: string): void {
  const fd = fs.openSync(file, "w");
  let off = 0;
  const put = (b: Buffer) => {
    fs.writeSync(fd, b);
    off += b.length;
  };
  const zstd = (zlib as any).zstdCompressSync as ((b: Buffer) => Buffer) | undefined;
  const codec = zstd ? 6 : 2;
  const compress = (b: Buffer) => (zstd ? zstd(b) : zlib.gzipSync(b));
  try {
    put(Buffer.from("PAR1", "latin1"));
    const groups: ((w: TWriter) => void)[] = [];
    for (let start = 0; start < Math.max(rows, 1) && (start < rows || rows === 0); start += ROW_GROUP) {
      const n = Math.min(ROW_GROUP, rows - start);
      const chunks: ((w: TWriter) => void)[] = [];
      let groupBytes = 0;
      for (const c of cols) {
        const defs = new Uint8Array(n);
        const vals: Buffer[] = [];
        for (let i = 0; i < n; i++) {
          const v = c.values[start + i];
          if (v === null || v === undefined || v === "" && c.kind !== "string") continue;
          defs[i] = 1;
          if (c.kind === "string") {
            const s = Buffer.from(String(v), "utf8");
            const l = Buffer.alloc(4);
            l.writeUInt32LE(s.length);
            vals.push(l, s);
          } else if (c.kind === "int64") {
            const x = Buffer.alloc(8);
            x.writeBigInt64LE(BigInt(Math.trunc(Number(v))));
            vals.push(x);
          } else {
            const x = Buffer.alloc(8);
            x.writeDoubleLE(Number(v));
            vals.push(x);
          }
        }
        const raw = Buffer.concat([rleLevels(defs), ...vals]);
        const comp = compress(raw);
        const header = new TWriter().i32(1, 0).i32(2, raw.length).i32(3, comp.length)
          .struct(5, (w) => w.i32(1, n).i32(2, 0).i32(3, 3).i32(4, 3)).end();
        const pageOffset = off;
        put(header);
        put(comp);
        const usize = header.length + raw.length, csize = header.length + comp.length;
        groupBytes += usize;
        const type = c.kind === "string" ? 6 : c.kind === "int64" ? 2 : 5;
        chunks.push((w) => w.i64(2, pageOffset).struct(3, (m) => m.i32(1, type).listI32(2, [0, 3]).listBin(3, [c.name])
          .i32(4, codec).i64(5, n).i64(6, usize).i64(7, csize).i64(9, pageOffset)));
      }
      groups.push((w) => w.listStruct(1, chunks).i64(2, groupBytes).i64(3, n));
      if (rows === 0) break;
    }
    const schema: ((w: TWriter) => void)[] = [(w) => w.bin(4, "schema").i32(5, cols.length)];
    for (const c of cols) {
      schema.push((w) => {
        w.i32(1, c.kind === "string" ? 6 : c.kind === "int64" ? 2 : 5).i32(3, 1).bin(4, c.name);
        if (c.kind === "string") w.i32(6, 0).struct(10, (l) => l.struct(1, () => undefined));
      });
    }
    const meta = new TWriter().i32(1, 1).listStruct(2, schema).i64(3, rows).listStruct(4, groups).bin(6, createdBy).end();
    put(meta);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(meta.length);
    put(len);
    put(Buffer.from("PAR1", "latin1"));
  } finally {
    fs.closeSync(fd);
  }
}
