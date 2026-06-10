#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch as fsWatch } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parse } from "./parser.js";
import { renderHtml } from "./renderer-html.js";
import { renderLlm } from "./renderer-llm.js";
import { renderJson } from "./renderer-json.js";
import { renderNoma } from "./renderer-noma.js";
import { renderMarkdown } from "./renderer-markdown.js";
import { renderDocx } from "./renderer-docx.js";
import { extractDocxControlData } from "./docx-control-data.js";
import { syncControlDefaultsFromDocx } from "./docx-control-sync.js";
import { extractDocxReviewData } from "./docx-review-data.js";
import { syncReviewCommentsFromDocx } from "./docx-review-sync.js";
import { patchSource, type PatchOp } from "./patch.js";
import { loadBook, loadBookChapters, isBookManifestPath } from "./book.js";
import { inlineDatasetSources, inlineFigureSources } from "./loader.js";
import { renderSite } from "./renderer-site.js";
import { validate, formatDiagnostics } from "./validator.js";
import { formatSource } from "./fmt.js";
import { verifyFixtureDir } from "./verify.js";
import { diffDocs } from "./diff.js";
import { collectIdRegistry } from "./ids.js";
import { writePdfFromHtml, type PdfMarginOptions } from "./pdf.js";
import { createAgentSafetyProof, renderProofHtml, renderProofMarkdownSummary } from "./proof.js";
import { convertMarkdownToNoma } from "./ingest-markdown.js";
import type { RenderLlmOptions } from "./renderer-llm.js";
import type { DocumentNode } from "./ast.js";
import type { ValidateOptions } from "./validator.js";

const HELP = `noma — readable document format for humans and agents

Usage:
  noma parse <file.noma|book.yml>            Print the AST as JSON
  noma render <file.noma|book.yml> [opts]    Render to a target format
  noma check <file.noma|book.yml>            Validate the document
  noma export <file.noma|book.yml> [opts]    Alias for render --to json
  noma patch <file.noma> [opts]              Apply block-level patch ops
  noma proof <file.noma> [opts]              Render an agent safety proof for patch ops
  noma agent review <file.noma> [opts]       Alias for proof
  noma ingest <file.md> [opts]               Convert Markdown to Noma-compatible source
  noma init [dir]                            Create a starter .noma document
  noma ids <file.noma|book.yml>              Print canonical ID and alias registry
  noma prove <file.noma> [opts]              Alias for proof
  noma schema <name>                         Print bundled JSON Schema
  noma docx-data <file.docx>                 Extract DOCX control/task state as JSON
  noma docx-sync <file.noma> <file.docx>     Update ::control defaults and task state
  noma docx-review-data <file.docx>          Extract Word review data as JSON
  noma docx-review-sync <file.noma> <file.docx> Sync Word review data from DOCX
  noma fmt   <file.noma> [--inplace|--out p] Re-align pipe tables in source
  noma verify <fixture-dir>                  Run conformance suite against fixtures
  noma diff <before.noma> <after.noma> --at <date>  Emit ::state_change for attribute add/change/remove
  noma --help                                Show this help
  noma --version                             Print the CLI version

Render options:
  --to <html|llm|json|noma|markdown|md|site|pdf|docx>
                            Target format (default: html). 'site' renders
                            a book manifest as a multi-page HTML site.
  --out <path>              Write to file (or directory for --to site)
  --no-standalone           HTML: emit body fragment without <html> wrapper
  --title <text>            Override document title
  --theme <name>            HTML theme: default | dark (default: default)
  --css <path>              Append custom CSS to standalone HTML/site/PDF output
  --no-unsafe               HTML: block ::html / ::svg / ::script escape hatches
  --strict                  HTML: block escape hatches, external CDN assets,
                            and generated interactive runtime
  --allow-external-paths    Permit dataset/figure src and book chapters that
                            resolve outside the document's own directory
  --watch                   Re-run the command when the document's directory
                            changes (render/check/export live loop)
  --fix                     check: apply the validator's mechanical fixes
                            (diagnostic "fix" patch ops) to the source file
  --math <katex|none>       Math rendering: enable KaTeX assets in standalone HTML
                            (default: auto-detect from doc / book manifest)
  --page-size <name>        PDF: page size passed to Chromium (default: A4)
  --margin <length>         PDF: set all margins (default: 20mm/18mm/20mm/18mm)
  --margin-top <length>     PDF: override top margin
  --margin-right <length>   PDF: override right margin
  --margin-bottom <length>  PDF: override bottom margin
  --margin-left <length>    PDF: override left margin
  --no-print-background     PDF: omit CSS backgrounds when printing
  --ignore-rule <name>      Suppress a validator rule (repeatable)
  --exclude-stale-days <n>  LLM: omit ::memory blocks whose last_seen is older
                            than <n> days from --now (or system clock).
  --select <a,b>            LLM: include only node types or directive names
  --exclude <a,b>           LLM: omit node types or directive names
  --budget <chars>          LLM: trim output to a maximum character count
  --now <ISO>               LLM: fix the clock used by --exclude-stale-days
                            (default: system clock). Useful for tests.

Check options:
  --stale-days <n>          Override the citation staleness window (days)
  --profile <name>          Apply a validator profile without editing frontmatter
                            (repeatable; e.g. technical-docs, research-memo,
                            adr, spec, agent-memory)
  --ignore-rule <name>      Suppress a validator rule (repeatable)

Patch options:
  --op <json>               One inline patch op (JSON object)
  --ops <file.json>         File containing one op, an array of ops, or
                            { "ops": [...], "prevalidate": true,
                              "postvalidate": true }
  --inplace                 Write the result back to <file.noma>
  --out <path>              Write to file instead of stdout

Proof options:
  --op/--ops                Patch operation(s) to simulate. Same shape as patch.
  --to <html|json|markdown|md>
                            Proof output target (default: html)
  --inplace                 Apply the simulated patch only if the proof passes
  --select/--exclude/--budget
                            Scope the LLM context shown in the proof

Ingest options:
  --add-stable-ids          Add explicit IDs to Markdown headings (default)
  --no-stable-ids           Preserve Markdown headings without explicit IDs

DOCX sync options:
  --report <path>           Write a JSON report for docx-sync or
                            docx-review-sync changes/skips

Diff options:
  --at <YYYY-MM-DD>         Required. Timestamp written as at="..." on each delta.
                            Required so output is deterministic.
  --reason <text>           Embed reason="..." on every emitted state_change
  --out <path>              Write to file instead of stdout

Examples:
  noma parse examples/thesis.noma
  noma schema patch-op
  noma render examples/thesis.noma --to html --out dist/thesis.html
  noma render examples/thesis.noma --to pdf --out dist/thesis.pdf
  noma render examples/thesis.noma --to docx --out dist/thesis.docx
  noma render examples/thesis.noma --to markdown --out dist/thesis.md
  noma docx-data dist/thesis.docx
  noma docx-sync examples/thesis.noma dist/thesis.docx --out synced.noma
  noma docx-review-data dist/thesis.docx
  noma docx-review-sync examples/thesis.noma dist/thesis.docx --out reviewed.noma
  noma render examples/thesis.noma --to llm
  noma check examples/thesis.noma
  noma patch examples/thesis.noma --op '{"op":"update_attribute","id":"asml-euv-moat","key":"confidence","value":0.9}' --inplace
  noma proof examples/thesis.noma --op '{"op":"update_attribute","id":"asml-euv-moat","key":"confidence","value":0.9}' --out dist/proof.html
  noma ingest docs/README.md --out docs/README.noma
  noma diff before.noma after.noma --at 2026-05-12 --reason "Q1 refresh"
`;

interface CliArgs {
  command: string;
  file?: string;
  fileB?: string;
  diffReason?: string;
  diffAt?: string;
  to: string;
  out?: string;
  standalone: boolean;
  title?: string;
  help: boolean;
  op?: string;
  opsFile?: string;
  report?: string;
  inplace: boolean;
  theme: string;
  customCss?: string;
  allowEscapeHatches: boolean;
  allowExternalPaths: boolean;
  fix: boolean;
  externalAssets: boolean;
  interactive: boolean;
  pdfPageSize: string;
  pdfMargin?: string;
  pdfMarginTop?: string;
  pdfMarginRight?: string;
  pdfMarginBottom?: string;
  pdfMarginLeft?: string;
  pdfPrintBackground: boolean;
  staleDays?: number;
  ignoreRules: string[];
  profiles: string[];
  addStableIds: boolean;
  math?: "katex" | "none";
  excludeStaleDays?: number;
  llmSelect: string[];
  llmExclude: string[];
  llmBudget?: number;
  now?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: argv[0] ?? "",
    to: "html",
    standalone: true,
    help: false,
    inplace: false,
    theme: "default",
    pdfPageSize: "A4",
    pdfPrintBackground: true,
    allowEscapeHatches: true,
    allowExternalPaths: false,
    fix: false,
    externalAssets: true,
    interactive: true,
    ignoreRules: [],
    profiles: [],
    addStableIds: true,
    llmSelect: [],
    llmExclude: [],
  };
  let i = 1;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      args.help = true;
      i++;
    } else if (a === "--to") {
      args.to = argv[++i] ?? "html";
      i++;
    } else if (a === "--out" || a === "-o") {
      args.out = argv[++i];
      i++;
    } else if (a === "--no-standalone") {
      args.standalone = false;
      i++;
    } else if (a === "--standalone") {
      args.standalone = true;
      i++;
    } else if (a === "--title") {
      args.title = argv[++i];
      i++;
    } else if (a === "--theme") {
      args.theme = argv[++i] ?? "default";
      i++;
    } else if (a === "--css") {
      args.customCss = argv[++i];
      i++;
    } else if (a === "--no-unsafe") {
      args.allowEscapeHatches = false;
      i++;
    } else if (a === "--allow-external-paths") {
      args.allowExternalPaths = true;
      i++;
    } else if (a === "--fix") {
      args.fix = true;
      i++;
    } else if (a === "--strict") {
      args.allowEscapeHatches = false;
      args.externalAssets = false;
      args.interactive = false;
      i++;
    } else if (a === "--stale-days") {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) args.staleDays = v;
      i++;
    } else if (a === "--ignore-rule") {
      const v = argv[++i];
      if (v) args.ignoreRules.push(v);
      i++;
    } else if (a === "--profile") {
      const v = argv[++i];
      if (v) args.profiles.push(v);
      i++;
    } else if (a === "--math") {
      const v = argv[++i];
      args.math = v === "none" ? "none" : "katex";
      i++;
    } else if (a === "--page-size") {
      args.pdfPageSize = argv[++i] ?? "A4";
      i++;
    } else if (a === "--margin") {
      args.pdfMargin = argv[++i];
      i++;
    } else if (a === "--margin-top") {
      args.pdfMarginTop = argv[++i];
      i++;
    } else if (a === "--margin-right") {
      args.pdfMarginRight = argv[++i];
      i++;
    } else if (a === "--margin-bottom") {
      args.pdfMarginBottom = argv[++i];
      i++;
    } else if (a === "--margin-left") {
      args.pdfMarginLeft = argv[++i];
      i++;
    } else if (a === "--print-background") {
      args.pdfPrintBackground = true;
      i++;
    } else if (a === "--no-print-background") {
      args.pdfPrintBackground = false;
      i++;
    } else if (a === "--exclude-stale-days") {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) args.excludeStaleDays = v;
      i++;
    } else if (a === "--select") {
      const v = argv[++i];
      if (v) args.llmSelect.push(v);
      i++;
    } else if (a === "--exclude") {
      const v = argv[++i];
      if (v) args.llmExclude.push(v);
      i++;
    } else if (a === "--budget") {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) args.llmBudget = v;
      i++;
    } else if (a === "--now") {
      args.now = argv[++i];
      i++;
    } else if (a === "--op") {
      args.op = argv[++i];
      i++;
    } else if (a === "--ops") {
      args.opsFile = argv[++i];
      i++;
    } else if (a === "--report") {
      args.report = argv[++i];
      i++;
    } else if (a === "--inplace") {
      args.inplace = true;
      i++;
    } else if (a === "--add-stable-ids") {
      args.addStableIds = true;
      i++;
    } else if (a === "--no-stable-ids") {
      args.addStableIds = false;
      i++;
    } else if (a === "--reason") {
      args.diffReason = argv[++i];
      i++;
    } else if (a === "--at") {
      args.diffAt = argv[++i];
      i++;
    } else if (!a.startsWith("--") && !args.file) {
      args.file = a;
      i++;
    } else if (!a.startsWith("--") && !args.fileB) {
      args.fileB = a;
      i++;
    } else {
      i++;
    }
  }
  return args;
}

function loadTheme(name = "default"): string {
  const safe = /^[a-z0-9-]+$/.test(name) ? name : "default";
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "themes", `${safe}.css`),
    resolve(here, "..", "..", "themes", `${safe}.css`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, "utf8");
  }
  if (safe !== "default") return loadTheme("default");
  return "";
}

function loadThemeCss(args: CliArgs): string {
  const themeCss = loadTheme(args.theme);
  if (!args.customCss) return themeCss;
  const customPath = resolve(args.customCss);
  if (!existsSync(customPath)) {
    throw new Error(`custom CSS not found: ${customPath}`);
  }
  return `${themeCss}\n\n${readFileSync(customPath, "utf8")}`;
}

function pdfMarginFromArgs(args: CliArgs): PdfMarginOptions {
  const base = args.pdfMargin;
  return {
    top: args.pdfMarginTop ?? base ?? "20mm",
    right: args.pdfMarginRight ?? base ?? "18mm",
    bottom: args.pdfMarginBottom ?? base ?? "20mm",
    left: args.pdfMarginLeft ?? base ?? "18mm",
  };
}

interface RenderSafetyOptions {
  allowEscapeHatches: boolean;
  externalAssets: boolean;
  interactive: boolean;
}

function renderSafetyFromArgs(args: CliArgs, trustedPublishing: boolean): RenderSafetyOptions {
  return {
    allowEscapeHatches: args.allowEscapeHatches && !trustedPublishing,
    externalAssets: args.externalAssets && !trustedPublishing,
    interactive: args.interactive && !trustedPublishing,
  };
}

function loadSchema(name: string): string {
  const safe = name.replace(/\.schema\.json$/i, "");
  const filenames: Record<string, string> = {
    ast: "ast.schema.json",
    capability: "capability.schema.json",
    "patch-op": "patch-op.schema.json",
    "patch-transaction": "patch-transaction.schema.json",
    transcript: "transcript.schema.json",
  };
  const filename = filenames[safe];
  if (!filename) {
    const names = Object.keys(filenames).sort().join(", ");
    throw new Error(`unknown schema "${name}" (expected one of: ${names})`);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "schemas", filename),
    resolve(here, "..", "..", "schemas", filename),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, "utf8");
  }
  throw new Error(`schema file not found: ${filename}`);
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packagePath = resolve(here, "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function output(content: string, out?: string): void {
  if (!out) {
    process.stdout.write(content + (content.endsWith("\n") ? "" : "\n"));
    return;
  }
  const dir = dirname(out);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(out, content, "utf8");
  process.stderr.write(`✓ wrote ${out}\n`);
}

function outputBinary(content: Buffer, out?: string): void {
  if (!out) {
    process.stdout.write(content);
    return;
  }
  const dir = dirname(out);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(out, content);
  process.stderr.write(`✓ wrote ${out}\n`);
}

function outputSyncReport<T extends { source: string }>(result: T, reportPath?: string): void {
  if (!reportPath) return;
  const { source: _source, ...report } = result;
  output(JSON.stringify(report, null, 2), reportPath);
}

function starterSource(): string {
  return `---
title: Agent-Safe Spec
---

# Agent-Safe Spec

::summary
A small Noma starter document with stable block IDs for agent-safe edits.
::

::claim{id="core-claim" confidence=0.8}
Noma documents stay readable for humans while giving agents precise blocks to patch.
::

::evidence{for="core-claim" source="starter"}
This claim can be updated with \`noma patch\` without rewriting the whole file.
::

::risk{id="first-risk" severity="medium" owner="you"}
Replace this with the first risk your spec needs to track.
::
`;
}

interface PatchTransaction {
  ops: PatchOp[];
  prevalidate: boolean;
  postvalidate: boolean;
}

function patchTransactionFromArgs(args: CliArgs): PatchTransaction {
  const ops: PatchOp[] = [];
  let prevalidate = false;
  let postvalidate = false;
  if (args.op) {
    ops.push(JSON.parse(args.op) as PatchOp);
  }
  if (args.opsFile) {
    const raw = JSON.parse(readFileSync(resolve(args.opsFile), "utf8")) as unknown;
    if (isPatchTransactionPayload(raw)) {
      ops.push(...raw.ops);
      prevalidate = raw.prevalidate === true;
      postvalidate = raw.postvalidate === true;
    } else if (Array.isArray(raw)) {
      ops.push(...(raw as PatchOp[]));
    } else {
      ops.push(raw as PatchOp);
    }
  }
  return { ops, prevalidate, postvalidate };
}

function isPatchTransactionPayload(
  value: unknown,
): value is { ops: PatchOp[]; prevalidate?: unknown; postvalidate?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ops" in value &&
    Array.isArray((value as { ops?: unknown }).ops)
  );
}

function validatePatchSource(source: string, filename: string): string {
  const doc = parse(source, { filename });
  inlineDatasetSources(doc);
  const diagnostics = validate(doc);
  const errors = diagnostics.filter((d) => d.severity === "error");
  return errors.length > 0 ? formatDiagnostics(errors, filename) : "";
}

function llmOptionsFromArgs(args: CliArgs, defaultBudget?: number): RenderLlmOptions {
  const llmOpts: RenderLlmOptions = {};
  if (args.excludeStaleDays !== undefined) {
    const now = args.now ? new Date(args.now) : new Date();
    if (Number.isNaN(now.getTime())) {
      throw new Error("--now value is not a valid date");
    }
    llmOpts.excludeStale = { now, days: args.excludeStaleDays };
  }
  if (args.llmSelect.length > 0) llmOpts.select = args.llmSelect;
  if (args.llmExclude.length > 0) llmOpts.exclude = args.llmExclude;
  llmOpts.budget = args.llmBudget ?? defaultBudget;
  return llmOpts;
}

function proofJson(proof: ReturnType<typeof createAgentSafetyProof>): string {
  const { postSource: _postSource, artifactPreviewHtml: _artifactPreviewHtml, ...body } = proof;
  return JSON.stringify(body, null, 2);
}

function validateOptionsFromArgs(args: CliArgs): ValidateOptions {
  return {
    ...(args.staleDays !== undefined ? { staleCitationDays: args.staleDays } : {}),
    ...(args.ignoreRules.length > 0 ? { ignoreRules: args.ignoreRules } : {}),
    ...(args.profiles.length > 0 ? { profiles: args.profiles } : {}),
  };
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const argv =
    rawArgv[0] === "agent" && rawArgv[1] === "review"
      ? ["proof", ...rawArgv.slice(2)]
      : rawArgv;
  if (!argv.includes("--watch")) return run(argv);
  const stripped = argv.filter((a) => a !== "--watch");
  const args = parseArgs(stripped);
  if (!args.file) {
    process.stderr.write(`error: --watch requires an input file\n`);
    process.exit(2);
  }
  await runWatch(stripped, args);
}

class CliExit extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

const WATCH_SOURCE_RE = /\.(noma|ya?ml|csv|tsv|md)$/i;

async function runWatch(argv: string[], args: CliArgs): Promise<void> {
  const input = resolve(args.file!);
  const watchDir = dirname(input);
  const outPath = args.out ? resolve(args.out) : undefined;
  const realExit = process.exit.bind(process);

  const runOnce = async (): Promise<void> => {
    const started = Date.now();
    process.exit = ((code?: number) => {
      throw new CliExit(typeof code === "number" ? code : 0);
    }) as typeof process.exit;
    try {
      await run(argv);
      process.stderr.write(`✓ ${new Date().toLocaleTimeString()} — ok (${Date.now() - started}ms)\n`);
    } catch (error) {
      if (error instanceof CliExit) {
        if (error.code !== 0) {
          process.stderr.write(`✗ ${new Date().toLocaleTimeString()} — exit ${error.code}; watching for fixes\n`);
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`✗ ${new Date().toLocaleTimeString()} — ${message}; watching for fixes\n`);
      }
    } finally {
      process.exit = realExit;
    }
  };

  await runOnce();
  let timer: ReturnType<typeof setTimeout> | undefined;
  fsWatch(watchDir, { recursive: true }, (_event, name) => {
    if (!name || !WATCH_SOURCE_RE.test(name)) return;
    if (outPath && resolve(watchDir, name) === outPath) return;
    clearTimeout(timer);
    timer = setTimeout(() => void runOnce(), 150);
  });
  process.stderr.write(`watching ${watchDir} for changes — Ctrl-C to stop\n`);
  await new Promise(() => {});
}

async function run(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }

  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const cmd = args.command;
  if (cmd === "init") {
    const targetDir = resolve(args.file ?? "noma-starter");
    const targetFile = resolve(targetDir, "demo.noma");
    if (existsSync(targetFile)) {
      process.stderr.write(`error: ${targetFile} already exists\n`);
      process.exit(2);
    }
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetFile, starterSource(), "utf8");
    process.stderr.write(`✓ wrote ${targetFile}\n`);
    process.stdout.write(`Next: noma render ${targetFile} --to html --out ${resolve(targetDir, "demo.html")}\n`);
    return;
  }

  if (cmd === "verify") {
    const dir = args.file;
    if (!dir) { console.error("noma verify: <fixture-dir> required"); process.exit(2); }
    const resolvedDir = resolve(dir);
    if (!existsSync(resolvedDir)) {
      console.error(`noma verify: ${dir} does not exist`);
      process.exit(2);
    }
    const report = verifyFixtureDir(resolvedDir);
    for (const f of report.fixtures) {
      const tag = f.status === "pass" ? "PASS" : f.status === "fail" ? "FAIL" : "SKIP";
      console.log(`${tag}  ${f.name}${f.error ? `  — ${f.error}` : ""}`);
    }
    console.log(`\n${report.fixtures.length} fixtures, ${report.fixtures.filter((f) => f.status === "pass").length} passed`);
    process.exit(report.ok ? 0 : 1);
  }

  if (cmd === "schema") {
    if (!args.file) {
      process.stderr.write("noma schema: <ast|capability|patch-op|patch-transaction|transcript> required\n");
      process.exit(2);
    }
    try {
      output(loadSchema(args.file), args.out);
    } catch (error) {
      process.stderr.write(`error: ${(error as Error).message}\n`);
      process.exit(2);
    }
    return;
  }

  if (cmd === "ingest") {
    if (!args.file) {
      process.stderr.write("noma ingest: <file.md> required\n");
      process.exit(2);
    }
    const source = readFileSync(resolve(args.file), "utf8");
    output(convertMarkdownToNoma(source, { addStableIds: args.addStableIds }), args.out);
    return;
  }

  if (cmd === "docx-data") {
    if (!args.file) {
      process.stderr.write("noma docx-data: <file.docx> required\n");
      process.exit(2);
    }
    const data = extractDocxControlData(readFileSync(resolve(args.file)));
    output(JSON.stringify(data, null, 2), args.out);
    return;
  }

  if (cmd === "docx-sync") {
    if (!args.file || !args.fileB) {
      process.stderr.write("noma docx-sync: <file.noma> <file.docx> required\n");
      process.exit(2);
    }
    const filePath = resolve(args.file);
    if (isBookManifestPath(filePath)) {
      process.stderr.write(`error: noma docx-sync operates on .noma source files, not book manifests\n`);
      process.exit(2);
    }
    const result = syncControlDefaultsFromDocx(
      readFileSync(filePath, "utf8"),
      readFileSync(resolve(args.fileB)),
    );
    output(result.source, args.inplace ? filePath : args.out);
    outputSyncReport(result, args.report);
    return;
  }

  if (cmd === "docx-review-data") {
    if (!args.file) {
      process.stderr.write("noma docx-review-data: <file.docx> required\n");
      process.exit(2);
    }
    const data = extractDocxReviewData(readFileSync(resolve(args.file)));
    output(JSON.stringify(data, null, 2), args.out);
    return;
  }

  if (cmd === "docx-review-sync") {
    if (!args.file || !args.fileB) {
      process.stderr.write("noma docx-review-sync: <file.noma> <file.docx> required\n");
      process.exit(2);
    }
    const filePath = resolve(args.file);
    if (isBookManifestPath(filePath)) {
      process.stderr.write(`error: noma docx-review-sync operates on .noma source files, not book manifests\n`);
      process.exit(2);
    }
    const result = syncReviewCommentsFromDocx(
      readFileSync(filePath, "utf8"),
      readFileSync(resolve(args.fileB)),
    );
    output(result.source, args.inplace ? filePath : args.out);
    outputSyncReport(result, args.report);
    return;
  }

  if (cmd === "diff") {
    if (!args.file || !args.fileB) {
      process.stderr.write("noma diff: <before.noma> <after.noma> required\n");
      process.exit(2);
    }
    if (!args.diffAt) {
      process.stderr.write("noma diff: --at <YYYY-MM-DD> is required (output must be deterministic)\n");
      process.exit(2);
    }
    const a = parse(readFileSync(resolve(args.file), "utf8"), { filename: args.file });
    const b = parse(readFileSync(resolve(args.fileB), "utf8"), { filename: args.fileB });
    const deltas = diffDocs(a, b, {
      at: args.diffAt,
      ...(args.diffReason !== undefined ? { reason: args.diffReason } : {}),
    });
    if (deltas.length === 0) {
      return;
    }
    const deltaDoc: DocumentNode = { type: "document", meta: {}, children: deltas };
    output(renderNoma(deltaDoc), args.out);
    return;
  }

  if (!args.file) {
    process.stderr.write(`error: missing input file\n\n${HELP}`);
    process.exit(2);
  }

  const filePath = resolve(args.file);
  if (cmd === "fmt") {
    if (isBookManifestPath(filePath)) {
      process.stderr.write(`error: noma fmt operates on .noma source files, not book manifests\n`);
      process.exit(2);
    }
    const formatted = formatSource(readFileSync(filePath, "utf8"));
    const target = args.inplace ? filePath : args.out;
    output(formatted, target);
    return;
  }

  if (cmd === "prove" || cmd === "proof") {
    if (isBookManifestPath(filePath)) {
      process.stderr.write(`error: noma ${cmd} operates on .noma source files, not book manifests\n`);
      process.exit(2);
    }
    const tx = patchTransactionFromArgs(args);
    if (tx.ops.length === 0) {
      process.stderr.write(`error: noma ${cmd} needs --op or --ops\n`);
      process.exit(2);
    }
    let llmOptions: RenderLlmOptions;
    try {
      llmOptions = llmOptionsFromArgs(args, 12000);
    } catch (error) {
      process.stderr.write(`error: ${(error as Error).message}\n`);
      process.exit(2);
    }
    const themeCss = loadThemeCss(args);
    const proofSafety = renderSafetyFromArgs(args, false);
    const proof = createAgentSafetyProof({
      filePath,
      source: readFileSync(filePath, "utf8"),
      ops: tx.ops,
      prevalidate: tx.prevalidate,
      postvalidate: tx.postvalidate,
      validateOptions: validateOptionsFromArgs(args),
      llmOptions,
      artifactOptions: {
        title: args.title,
        themeCss,
        ...proofSafety,
        ...(args.math ? { math: args.math } : {}),
      },
    });
    if (args.to === "json") {
      output(proofJson(proof), args.out);
    } else if (args.to === "html") {
      output(renderProofHtml(proof), args.out);
    } else if (args.to === "markdown" || args.to === "md") {
      output(renderProofMarkdownSummary(proof), args.out);
    } else {
      process.stderr.write(`error: noma ${cmd} supports --to html, --to json, or --to markdown\n`);
      process.exit(2);
    }
    if (args.inplace) {
      if (!proof.canWrite) {
        process.stderr.write(`error: proof failed; source not written\n`);
        process.exit(1);
      }
      writeFileSync(filePath, proof.postSource, "utf8");
      process.stderr.write(`✓ wrote ${filePath}\n`);
    }
    process.exit(proof.status === "fail" ? 1 : 0);
  }

  if ((cmd === "render" || cmd === "export") && args.to === "site") {
    if (!isBookManifestPath(filePath)) {
      process.stderr.write(`error: --to site requires a book manifest (.yml)\n`);
      process.exit(2);
    }
    if (!args.out) {
      process.stderr.write(`error: --to site requires --out <directory>\n`);
      process.exit(2);
    }
    const themeCss = loadThemeCss(args);
    const { manifest, chapters } = loadBookChapters(filePath, {
      allowExternalPaths: args.allowExternalPaths,
    });
    const safety = renderSafetyFromArgs(args, manifest.trusted_publishing === true);
    renderSite(manifest, chapters, args.out, {
      themeCss,
      title: args.title,
      ...safety,
      ...(args.math ? { math: args.math } : {}),
    });
    process.stderr.write(`✓ wrote ${chapters.length + 1} pages to ${args.out}\n`);
    return;
  }

  const manifestForTrust = isBookManifestPath(filePath)
    ? (yaml.load(readFileSync(filePath, "utf8")) as Record<string, unknown> | null)
    : null;
  const safety = renderSafetyFromArgs(args, manifestForTrust?.trusted_publishing === true);

  const doc = isBookManifestPath(filePath)
    ? loadBook(filePath, { allowExternalPaths: args.allowExternalPaths })
    : parse(readFileSync(filePath, "utf8"), { filename: filePath });
  inlineDatasetSources(doc, undefined, { allowExternalPaths: args.allowExternalPaths });

  switch (cmd) {
    case "parse": {
      output(renderJson(doc, { pretty: true }), args.out);
      return;
    }
    case "ids": {
      output(JSON.stringify(collectIdRegistry(doc), null, 2), args.out);
      return;
    }
    case "export":
    case "render": {
      const to = cmd === "export" ? "json" : args.to;
      switch (to) {
        case "html": {
          const themeCss = loadThemeCss(args);
          const html = renderHtml(doc, {
            standalone: args.standalone,
            title: args.title,
            themeCss,
            ...safety,
            ...(args.math ? { math: args.math } : {}),
          });
          output(html, args.out);
          return;
        }
        case "pdf": {
          if (!args.out) {
            process.stderr.write(`error: --to pdf requires --out <file.pdf>\n`);
            process.exit(2);
          }
          const themeCss = loadThemeCss(args);
          const html = renderHtml(doc, {
            standalone: true,
            title: args.title,
            themeCss,
            ...safety,
            ...(args.math ? { math: args.math } : {}),
          });
          await writePdfFromHtml(html, args.out, {
            pageSize: args.pdfPageSize,
            margin: pdfMarginFromArgs(args),
            printBackground: args.pdfPrintBackground,
          });
          process.stderr.write(`✓ wrote ${args.out}\n`);
          return;
        }
        case "docx": {
          if (!args.out) {
            process.stderr.write(`error: --to docx requires --out <file.docx>\n`);
            process.exit(2);
          }
          inlineFigureSources(doc, undefined, {
            allowExternalPaths: args.allowExternalPaths,
          });
          outputBinary(renderDocx(doc, { title: args.title }), args.out);
          return;
        }
        case "llm": {
          let llmOpts: RenderLlmOptions;
          try {
            llmOpts = llmOptionsFromArgs(args);
          } catch (error) {
            process.stderr.write(`error: ${(error as Error).message}\n`);
            process.exit(2);
          }
          output(renderLlm(doc, llmOpts), args.out);
          return;
        }
        case "json": {
          output(renderJson(doc, { pretty: true }), args.out);
          return;
        }
        case "noma": {
          output(renderNoma(doc), args.out);
          return;
        }
        case "markdown":
        case "md": {
          output(renderMarkdown(doc), args.out);
          return;
        }
        default:
          process.stderr.write(`error: unknown target "${to}"\n`);
          process.exit(2);
      }
      return;
    }
    case "check": {
      const diagnostics = validate(doc, validateOptionsFromArgs(args));
      if (args.fix) {
        if (isBookManifestPath(filePath)) {
          process.stderr.write(`error: --fix operates on .noma source files, not book manifests\n`);
          process.exit(2);
        }
        const fixes = diagnostics.filter((d) => d.fix).map((d) => d.fix as unknown as PatchOp);
        if (fixes.length === 0) {
          process.stdout.write(formatDiagnostics(diagnostics, args.file) + "\n");
          process.stderr.write(`no mechanical fixes available\n`);
          process.exit(diagnostics.some((d) => d.severity === "error") ? 1 : 0);
        }
        const before = readFileSync(filePath, "utf8");
        const fixed = patchSource(before, fixes);
        writeFileSync(filePath, fixed, "utf8");
        const after = validate(parse(fixed, { filename: filePath }), validateOptionsFromArgs(args));
        process.stdout.write(formatDiagnostics(after, args.file) + "\n");
        process.stderr.write(`✓ applied ${fixes.length} fix${fixes.length === 1 ? "" : "es"} to ${args.file}\n`);
        process.exit(after.some((d) => d.severity === "error") ? 1 : 0);
      }
      const formatted = formatDiagnostics(diagnostics, args.file);
      process.stdout.write(formatted + "\n");
      const hasError = diagnostics.some((d) => d.severity === "error");
      process.exit(hasError ? 1 : 0);
    }
    case "patch": {
      const tx = patchTransactionFromArgs(args);
      if (tx.ops.length === 0) {
        process.stderr.write(`error: noma patch needs --op or --ops\n`);
        process.exit(2);
      }
      if (isBookManifestPath(filePath)) {
        process.stderr.write(`error: noma patch operates on .noma source files, not book manifests\n`);
        process.exit(2);
      }
      const before = readFileSync(filePath, "utf8");
      if (tx.prevalidate) {
        const preErrors = validatePatchSource(before, filePath);
        if (preErrors) {
          process.stderr.write(`error: pre-validation failed\n${preErrors}\n`);
          process.exit(1);
        }
      }
      const printed = patchSource(before, tx.ops);
      if (tx.postvalidate) {
        const postErrors = validatePatchSource(printed, filePath);
        if (postErrors) {
          process.stderr.write(`error: post-validation failed\n${postErrors}\n`);
          process.exit(1);
        }
      }
      const target = args.inplace ? filePath : args.out;
      output(printed, target);
      return;
    }
    default:
      process.stderr.write(`error: unknown command "${cmd}"\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});
