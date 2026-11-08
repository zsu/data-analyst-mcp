/**
 * compute's replicate_se step: standard errors and margins of error from replicate weights or replicate estimates.
 *
 *   SE = sqrt(c * sum over r of (theta_r - theta)^2), MOE = z * SE
 *
 * theta is the full-sample estimate, theta_r the estimate with replicate r, and c the method's factor over R replicates:
 * sdr 4/R (successive difference replication: Census's ACS PUMS 4/80 and CPS ASEC 4/160), fay 1/(R (1 - rho)^2),
 * jk1 (R - 1)/R, brr 1/R, custom (scale given). There is no default method: a wrong factor would give a wrong SE
 * with no sign of it.
 *
 * Two forms:
 *   microdata  {estimates: {name: aggregate expr using the weight}, weight, replicates, method, also?, confidence?},
 *              with groupby: each estimate is evaluated with the full weight and again with every replicate weight
 *              in its place, per group (the groups and their order are rollup's); out: keys, then name, name_se,
 *              name_moe per estimate, then the also columns (aggregates with no standard error, such as count()).
 *   estimates  {estimate: column, replicates, method, as?, confidence?}: a row per estimate with its published
 *              replicate estimates beside it (Census variance replicate tables); adds <as>_se and <as>_moe to each row.
 * replicates: a list of columns or a range "PWGTP1:PWGTP80".
 */
import { ComputeError, groupRows, need, strList } from "./compute.js";
import { compile, evaluate, inspect, substituteColumn, type Node } from "./expr.js";
import { pyRepr } from "./pyfmt.js";
import { newRow, type Row, type Table, type Value } from "./table.js";

const METHODS = ["sdr", "fay", "jk1", "brr", "custom"];
const Z: Record<string, number> = { "90": 1.645, "95": 1.96, "99": 2.576 };
const MICRO_KEYS = ["estimates", "weight", "replicates", "method", "rho", "scale", "also", "confidence"];
const ROW_KEYS = ["estimate", "replicates", "method", "rho", "scale", "as", "confidence"];

/** The replicate columns: a list of names, or "PREFIX<a>:PREFIX<b>" for PREFIX<a> ... PREFIX<b>. */
export function replicateColumns(v: unknown): string[] {
  let cols: string[];
  if (typeof v === "string" && v.includes(":")) {
    const m = /^(.*?)(\d+):(.*?)(\d+)$/.exec(v.trim());
    if (!m || m[1] !== m[3] || !m[1]) {
      throw new ComputeError(`replicates ${pyRepr(v)}: a range is "PREFIX1:PREFIX80" (the same prefix, then the first and last numbers)`);
    }
    const a = Number(m[2]), b = Number(m[4]);
    if (a > b) throw new ComputeError(`replicates ${pyRepr(v)}: the first number is larger than the last`);
    if (b - a > 9999) throw new ComputeError(`replicates ${pyRepr(v)}: more than 10,000 replicates`);
    cols = Array.from({ length: b - a + 1 }, (_, i) => `${m[1]}${a + i}`);
  } else {
    cols = strList(v, "replicates");
  }
  if (new Set(cols).size !== cols.length) throw new ComputeError("replicates: a column is named twice");
  if (cols.length < 2) throw new ComputeError('replicates: at least two replicate columns (a list, or a range like "PWGTP1:PWGTP80")');
  return cols;
}

type Method = { c: number; text: string; name: string };

/** The method's factor c for R replicates, and how the note writes it. */
export function methodFactor(o: Record<string, any>, R: number): Method {
  const m = o.method;
  if (m === undefined || m === null) {
    throw new ComputeError(`name the method (${METHODS.join(", ")}): the pack's notes say which one its replicate ` +
      "weights take (ACS PUMS and CPS ASEC: sdr)");
  }
  if (typeof m !== "string" || !METHODS.includes(m)) throw new ComputeError(`method is one of ${METHODS.join(", ")}, not ${pyRepr(m)}`);
  if (m !== "fay" && o.rho !== undefined) throw new ComputeError("rho goes with method fay only");
  if (m !== "custom" && o.scale !== undefined) throw new ComputeError('scale goes with method "custom" only');
  switch (m) {
    case "sdr":
      return { c: 4 / R, text: `4/${R}`, name: "sdr, successive difference replication" };
    case "jk1":
      return { c: (R - 1) / R, text: `${R - 1}/${R}`, name: "jk1, delete-one jackknife" };
    case "brr":
      return { c: 1 / R, text: `1/${R}`, name: "brr, balanced repeated replication" };
    case "fay": {
      const rho = o.rho;
      if (typeof rho !== "number" || !(rho >= 0 && rho < 1)) throw new ComputeError("method fay needs rho, a number from 0 up to (not including) 1");
      return { c: 1 / (R * (1 - rho) ** 2), text: `1/(${R} * (1 - ${rho})^2)`, name: `fay, Fay's BRR with rho ${rho}` };
    }
    default: {
      const c = o.scale;
      if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) throw new ComputeError('method "custom" needs scale, the positive factor c in SE = sqrt(c * sum of squared differences)');
      return { c, text: String(c), name: "custom factor" };
    }
  }
}

function zOf(o: Record<string, any>): [number, string] {
  const k = o.confidence === undefined ? "90" : String(o.confidence);
  if (!Z[k]) throw new ComputeError(`confidence is 90 (Census's margins), 95 or 99, not ${pyRepr(o.confidence)}`);
  return [Z[k], k];
}

function num(v: Value, what: string): number | null {
  if (v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  throw new ComputeError(`${what} is ${pyRepr(v)}, not a number${typeof v === "string" ? ": convert it with number() in a derive step first" : ""}`);
}

/** sqrt(c * sum (theta_r - theta)^2), or null when theta or any theta_r is missing. */
function se(theta: number | null, reps: (number | null)[], c: number): number | null {
  if (theta === null || reps.some((x) => x === null)) return null;
  let s = 0;
  for (const x of reps) s += (x! - theta) ** 2;
  const out = Math.sqrt(c * s);
  return Number.isFinite(out) ? out : null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function replicateSe(t: Table, spec: unknown, by: string[]): { table: Table; notes: string[] } {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new ComputeError("{estimates: {name: expr}, weight, replicates, method} for microdata, or " +
      "{estimate: column, replicates, method} for a table of replicate estimates");
  }
  const o = spec as Record<string, any>;
  const micro = o.estimates !== undefined || o.weight !== undefined;
  if (micro && o.estimate !== undefined) throw new ComputeError("give estimates with weight (microdata) or estimate (a column of estimates), not both");
  const allowed = micro ? MICRO_KEYS : ROW_KEYS;
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ComputeError(`unknown key(s) ${pyRepr(extra)}; allowed in this form: ${pyRepr(allowed)}`);
  const reps = replicateColumns(o.replicates);
  need(t, reps, "replicate_se replicates");
  const m = methodFactor(o, reps.length);
  const [z, conf] = zOf(o);
  const range = `${reps[0]}-${reps[reps.length - 1]}`;
  const how = `SE = sqrt(${m.text} * sum over r of (estimate_r - estimate)^2) over ${reps.length} replicates ${range} (${m.name}); ` +
    `MOE = ${z} * SE (${conf} percent)`;
  return micro ? fromMicrodata(t, o, by, reps, m, z, how) : fromEstimates(t, o, by, reps, m, z, how);
}

function fromMicrodata(t: Table, o: Record<string, any>, by: string[], reps: string[], m: Method, z: number, how: string) {
  const weight = o.weight;
  if (typeof weight !== "string" || !weight) throw new ComputeError("weight names the full-sample weight column (PWGTP, MARSUPWT, PERWT ...)");
  need(t, [weight], "replicate_se weight");
  if (reps.includes(weight)) throw new ComputeError(`the weight ${weight} is also listed as a replicate`);
  if (by.includes(weight) || reps.some((r) => by.includes(r))) throw new ComputeError("a weight cannot be a groupby key");
  if (!o.estimates || typeof o.estimates !== "object" || Array.isArray(o.estimates) || !Object.keys(o.estimates).length) {
    throw new ComputeError('estimates is {name: "aggregate expression using the weight"}, e.g. ' +
      '{"rate": "sum(PWGTP * (HICOV == 2)) / sum(PWGTP)"}');
  }
  const ests = Object.entries(o.estimates as Record<string, unknown>).map(([name, src]) => {
    const node = compile(src, t.cols, { what: "replicate_se", win: false });
    const info = inspect(node);
    if (!info.cols.includes(weight)) {
      throw new ComputeError(`estimate ${name} does not use the weight ${weight}, so replicates cannot change it ` +
        "and it has no replicate standard error: weight it, or put it in also");
    }
    if (!info.agg) throw new ComputeError(`estimate ${name} is not an aggregate (sum, mean, weighted_mean ...) over the rows`);
    return { name, node, reps: reps.map((r) => substituteColumn(node, weight, r)) };
  });
  const also = o.also === undefined ? [] : (() => {
    if (!o.also || typeof o.also !== "object" || Array.isArray(o.also)) throw new ComputeError('also is {name: "aggregate expression"}, e.g. {"n": "count()"}');
    return Object.entries(o.also as Record<string, unknown>).map(([name, src]) => ({ name, node: compile(src, t.cols, { what: "replicate_se also", win: false }) }));
  })();
  const outCols = [...by, ...ests.flatMap((e) => [e.name, `${e.name}_se`, `${e.name}_moe`]), ...also.map((a) => a.name)];
  const dup = outCols.filter((c, i) => outCols.indexOf(c) !== i);
  if (dup.length) throw new ComputeError(`${pyRepr([...new Set(dup)])} would name two columns: rename the estimate`);
  const keys = new Set(by);
  const rows: Row[] = [];
  let missing = 0;
  const run = (node: Node, g: Row[], what: string) => num(evaluate(node, { i: 0, group: g, keys, cache: new Map() }), what);
  for (const g of groupRows(t, by, true)) {
    if (!g.length && by.length) continue;
    const r = newRow();
    for (const k of by) r[k] = g[0][k];
    for (const e of ests) {
      const theta = run(e.node, g, `estimate ${e.name}`);
      const thetas = e.reps.map((n, i) => run(n, g, `estimate ${e.name} with ${reps[i]}`));
      const s = se(theta, thetas, m.c);
      if (theta !== null && s === null) missing++;
      r[e.name] = theta;
      r[`${e.name}_se`] = s;
      r[`${e.name}_moe`] = s === null ? null : z * s;
    }
    const cache = new Map<Node, unknown>();
    for (const a of also) r[a.name] = evaluate(a.node, { i: 0, group: g, keys, cache });
    rows.push(r);
  }
  const notes = [`replicate_se: ${how}; weight ${weight}`];
  if (missing) notes.push(`replicate_se: ${plural(missing, "estimate")} with a missing replicate estimate (a gap): no SE given`);
  return { table: { cols: outCols, rows }, notes };
}

function fromEstimates(t: Table, o: Record<string, any>, by: string[], reps: string[], m: Method, z: number, how: string) {
  if (by.length) throw new ComputeError("groupby goes with the microdata form (estimates with weight); a table of " +
    "replicate estimates gets an SE on every row");
  const est = o.estimate;
  if (typeof est !== "string" || !est) throw new ComputeError("estimate names the column of full-sample estimates");
  need(t, [est], "replicate_se estimate");
  if (reps.includes(est)) throw new ComputeError(`the estimate ${est} is also listed as a replicate`);
  const base = o.as === undefined ? est : o.as;
  if (typeof base !== "string" || !base) throw new ComputeError("as names the new columns (<as>_se, <as>_moe)");
  const seCol = `${base}_se`, moeCol = `${base}_moe`;
  const clash = [seCol, moeCol].filter((c) => t.cols.includes(c));
  if (clash.length) throw new ComputeError(`${pyRepr(clash)} are already columns: give as a new name`);
  let missing = 0;
  const rows = t.rows.map((row, i) => {
    const theta = num(row[est], `row ${i + 1}: ${est}`);
    const s = se(theta, reps.map((r) => num(row[r], `row ${i + 1}: ${r}`)), m.c);
    if (s === null) missing++;
    const out = Object.assign(newRow(), row);
    out[seCol] = s;
    out[moeCol] = s === null ? null : z * s;
    return out;
  });
  const notes = [`replicate_se: ${how}; estimates in ${est}`];
  if (missing) notes.push(`replicate_se: ${plural(missing, "row")} with a missing estimate or replicate (a gap): no SE given`);
  return { table: { cols: [...t.cols, seCol, moeCol], rows }, notes };
}
