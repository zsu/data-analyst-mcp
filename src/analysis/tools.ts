/** The analysis tools. server.ts registers every entry of TOOLS. */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fail } from "../envelope.js";
import type { Session } from "../session.js";
import type { ToolDef } from "../toolkit.js";
import { columnList } from "../core/compact.js";
import { cite, CiteError } from "./cite.js";
import { compute, ComputeError } from "./compute.js";
import { FactError, registerFacts } from "./facts.js";
import { summarize } from "./handoff.js";
import { awaitRerun, RerunPending } from "./rerun_job.js";
import { writeTable, WriteTableError } from "./write_table.js";


const COMPUTE_FIX = "Fix the step the message names (verbs and functions: guide(\"compute\")) " +
  "and call compute again.";

export function computeTool(s: Session, a: any) {
  let r;
  try {
    r = compute(s.workspace, a);
  } catch (e) {
    if (e instanceof ComputeError) throw fail("invalid_request", e.message, COMPUTE_FIX);
    throw e;
  }
  return {
    status: "ok", summary: { file: r.rel, rows: r.rows, columns: columnList(r.columns), packs: r.packs, preview: r.preview,
      ...(r.preview_note ? { preview_note: r.preview_note } : {}) },
    files: [r.file], notes: r.notes,
    next: "Register each number you will cite with facts (table: this file, where: the row's key values, column), " +
      "so the answer and report quote it and the rerun gate reproduces it.",
  };
}

export function factsTool(s: Session, a: any) {
  try {
    const r = registerFacts(s.workspace, a);
    // each fact as the answer must print it (the audit matches the text exactly)
    let saved: Record<string, any> = {};
    try {
      saved = JSON.parse(fs.readFileSync(path.join(s.workspace, "facts.json"), "utf8"));
    } catch { /* none yet */ }
    // compact: each fact's value and the text the model quotes, and only value/text/pack for the ones just added (the
    // rest of each record is its own input echoed back)
    const facts = (r.names as string[]).map((n) => ({ name: n, value: saved[n]?.value ?? null, text: saved[n]?.text ?? null }));
    const added = Object.fromEntries(Object.entries(r.added).map(([n, rec]: [string, any]) =>
      [n, { value: rec?.value ?? null, text: rec?.text ?? null, ...(rec && "pack" in rec ? { pack: rec.pack } : {}) }]));
    return { status: "ok", summary: { added }, facts, files: [r.file], notes: r.notes,
      next: "Quote each fact's text in the answer exactly (or {{name}} / {{name|fmt}} in report.json)." };
  } catch (e) {
    if (e instanceof FactError) {
      throw fail("invalid_request", e.message, "Fix the facts the message names; nothing was saved. Each table fact is " +
        "one cell of a saved CSV (where must match exactly one row by the CSV's own text).", { problems: (e as any).problems });
    }
    throw e;
  }
}

export async function rerunTool(s: Session) {
  let r;
  try {
    r = await awaitRerun(s.workspace);
  } catch (e) {
    if (!(e instanceof RerunPending)) throw e;
    throw fail("in_progress", e.message, "Call rerun again in about 30 seconds: it waits on this same replay (it does not " +
      "start another) and answers at once when it is done. Do not change the workspace meanwhile.", { retry_after_s: 30 });
  }
  const bad = [...Object.entries(r.exhibits).filter(([, v]) => !v.same).map(([k]) => k),
    ...Object.entries(r.facts).filter(([, v]) => !v.same).map(([k]) => `fact ${k}`)];
  return { status: "ok", summary: { reproduced: !bad.length, not_reproduced: bad, ...r },
    notes: bad.length ? ["Not reproduced: remake those exhibits with compute (and register their facts again)."] : [] };
}

export async function citeTool(s: Session, a: any) {
  try {
    const r = await cite(s.workspace, a);
    return { status: "ok", summary: r, files: [path.join(s.workspace, r.file)], next: r.next };
  } catch (e) {
    if (e instanceof CiteError) {
      const refused = e.message.startsWith("refused");
      const local = /^(id |cite needs|text is empty|not a valid URL)/.test(e.message);
      throw fail(refused || local ? "invalid_request" : "agency_unavailable", e.message, refused
        ? "Cite the page's public URL; this server opens no private or local addresses."
        : local ? "Fix the argument the message names and call cite again."
        : "Open the page with your own fetch tool and call cite again with text: the text it returned; never mark a " +
          "reference opened that you could not open.", e.url ? { url: e.url } : {});
    }
    throw e;
  }
}

export function handoffTool(s: Session) {
  const r = summarize(s.workspace);
  // the previews are in text (Markdown); the summary keeps the facts about each file, not the previews again
  const sources = r.sources.map((x: any) => ({ ...x, files: (x.files || []).map(({ preview: _p, ...f }: any) => f) }));
  return { status: "ok", summary: { sources, unpackaged: r.unpackaged }, text: r.text, action: r.action };
}

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
// described once, in the facts description (these fields repeat in add and derived)
const flags = {
  fmt: z.string().optional().describe("A format code (see the description)"),
  label: z.string().optional(),
  pack: z.union([z.string(), z.array(z.string())]).nullable().optional().describe("Source pack(s); [] for none"),
  headline: z.boolean().optional().describe("A number the answer leads with (needs a benchmark.csv row)"),
  preliminary: z.boolean().optional().describe("An early estimate the agency will revise"),
  vintage: z.string().nullable().optional().describe("The vintage, when not the latest"),
  projection: z.boolean().optional().describe("A projection, not data"),
  se: z.number().nullable().optional().describe("Standard error"),
};

export const TOOLS: ToolDef[] = [
  {
    name: "compute",
    title: "Compute an exhibit",
    description: "Run declarative steps over full workspace tables (data/<id>/<table>.csv or .parquet, earlier exhibits, " +
      "published/*.csv) and save exhibits/<name>.csv with its lineage, so the rerun gate can replay it. Call it for every " +
      "table the answer or report draws numbers from; never compute cited numbers by hand.\n" +
      "Steps, one verb each: filter, derive, select, rename, groupby with rollup (or with derive/filter for per-group " +
      "windows and shares), join, pivot_wider, pivot_longer, orderby, slice, dedupe, concat, as, from; helpers " +
      "fiscal_year, to_fiscal, state_codes, deflate, align_check (before joining two sources); replicate_se (survey " +
      "standard errors and MOEs from replicate weights, e.g. ACS PUMS PWGTP1:PWGTP80 with sdr). Example: " +
      '[{"filter": "AGEP >= 16"}, {"derive": {"fed": "COW == 5 ? 1 : 0"}}, {"groupby": ["fed"], "rollup": ' +
      '{"n": "sum(PWGTP)"}}].\n' +
      "Expressions: column names (col(\"a b\") for odd ones), numbers, \"text\", + - * / % **, comparisons, && || !, " +
      "c ? a : b, and the listed functions, aggregates and windows. guide(\"compute\") has every verb's arguments, " +
      "the function list and the replicate_se methods. For a big file, name the columns: {alias: {path, columns}}. " +
      "Returns the columns, row count, a short preview and the file.",
    inputSchema: {
      inputs: z.record(z.string(), z.union([z.string(), z.object({ path: z.string(), columns: z.array(z.string()).optional() })]))
        .describe('{alias: "data/<id>/<table>.csv" | "data/<id>/<table>.parquet" | "exhibits/<x>.csv" | "published/<x>.csv" | ' +
          "{path, columns: [the columns to read]}}"),
      steps: z.array(z.record(z.string(), z.any())).describe("The steps, in order (see the description)"),
      save_as: z.string().describe("exhibits/<name>.csv"),
      from: z.string().optional().describe("The input alias the steps start from (default: the first)"),
      packs: z.array(z.string()).optional().describe("Source packs of the result (default: inferred from the inputs)"),
      preview: z.number().optional().describe("Rows to show (default 20, at most 50)"),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    handler: computeTool,
  },
  {
    name: "facts",
    title: "Register facts",
    description: "Register every number the answer or report cites in facts.json. A table fact " +
      "(add) is one cell of a saved CSV: table (exhibits/<x>.csv, data/<id>/<t>.csv or published/<x>.csv), where (the row's " +
      "key values, matched to the CSV's own text) and column; its value is read from the cell. A derived fact (derived) has " +
      "a derivation: written as an expression over fact names (\"deaths_2024 / deaths_2020 - 1\") it is computed here, so " +
      "leave value out; a prose derivation needs value. Refuses empty cells and NaN, an ambiguous pack, unknown formats and " +
      "units slips (a share given to pct100, millions given to usd_b ...); nothing is saved when any fact is refused. " +
      "Returns each fact with its text (the value as the answer prints it: quote it exactly) and notes (rounding ties). " +
      "fmt codes: raw, num:0, pct:1 (share 0-1), pct100:1 (already percent), pp:1, pp100:1, bp:0, dollars:0, thousands:-3, " +
      "millions:1, billions:1, usd_b:1 (value in dollars), usd_b_scaled:1 (already billions), ratio:2, index:1, year; " +
      "prefixes signed:, abs:, from_millions: ...; suffix :abs. pack is inferred from data/<id>/ or the exhibit's lineage.",
    inputSchema: {
      add: z.array(z.object({ name: z.string(), table: z.string(), where: z.record(z.string(), scalar), column: z.string(), ...flags }))
        .optional().describe("Table facts"),
      derived: z.array(z.object({ name: z.string(), derivation: z.string(), value: z.union([z.number(), z.string()]).nullable().optional(),
        ...flags })).optional().describe("Derived facts (after the table facts of this call)"),
      remove: z.array(z.string()).optional().describe("Fact names to drop"),
      pack: z.union([z.string(), z.array(z.string())]).optional().describe("Default source pack(s) for this call's facts"),
    },
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    handler: factsTool,
  },
  {
    name: "rerun",
    title: "Rerun the analysis",
    description: "Replay every exhibit's recorded compute steps from its inputs and recompute every fact, without writing " +
      "anything. Returns, per exhibit, whether the replay gives the same CSV, and per fact the stored and rerun values; " +
      "reproduced is true only when everything matches. The audits run the same check with rerun: true.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: rerunTool,
  },
  {
    name: "cite",
    title: "Snapshot a cited page",
    description: "Save a page a method record cites into references/<id>.* and record it in references/opened.json, so " +
      "\"opened\": true on that reference is backed by a snapshot the audit checks (and the quote is looked up in it). Pass " +
      "text: the text your own fetch tool returned for the page; without text the server downloads it. Returns the record " +
      "and the decisions.json reference entry to write.",
    inputSchema: {
      url: z.string().describe("The page's http(s) URL (the url in references)"),
      id: z.string().describe("The reference id ([@id]): letters, digits, _ and -"),
      text: z.string().optional().describe("The page text your fetch tool returned"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
    handler: citeTool,
  },
  {
    name: "handoff",
    title: "Data hand-off",
    description: "What each source delivered, read back from the workspace's provenance files: per source the route and " +
      "retrieval date, the files with row counts, every caveat note and problem, and a short preview of each table " +
      "(none for microdata), plus figures read from agency pages (published/). Returns text (ready-to-send Markdown: the " +
      "per-source part of a data hand-off) and the same as structured data.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: handoffTool,
  },
];

TOOLS.push({
  name: "write_table",
  title: "Write a method table",
  description: "Write one of the tables the audits require that are not computed from fetched data: " +
    "exhibits/benchmark.csv (measure, period, computed, published, source, url, accessed, match, note: each headline " +
    "against the agency's published figure; \"not checked\" when none exists), exhibits/sensitivity.csv (parameter, " +
    "base, alternative, headline_base, headline_alt, conclusion_changes: yes/no; the headlines are registered facts), or " +
    "published/<name>.csv (a figure only an agency page publishes, as the page shows it, with source_url and accessed " +
    "YYYY-MM-DD on every row). Data exhibits come from compute instead.",
  inputSchema: {
    path: z.string().describe("exhibits/benchmark.csv, exhibits/sensitivity.csv or published/<name>.csv"),
    columns: z.array(z.string()).min(1),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  handler: (s: Session, a: { path: string; columns: string[]; rows: (string | number | null)[][] }) => {
    try {
      return writeTable(s.workspace, a);
    } catch (e) {
      if (e instanceof WriteTableError) {
        throw fail("invalid_request", e.message, "Fix the path, columns or rows as the message says, then call write_table again.");
      }
      throw e;
    }
  },
});
