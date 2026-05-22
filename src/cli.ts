#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parse } from "./parser.js";
import { renderHtml } from "./renderer-html.js";
import { renderLlm } from "./renderer-llm.js";
import { renderJson } from "./renderer-json.js";
import { renderNoma } from "./renderer-noma.js";
import { patchSource, type PatchOp } from "./patch.js";
import { loadBook, loadBookChapters, isBookManifestPath } from "./book.js";
import { inlineDatasetSources } from "./loader.js";
import { renderSite } from "./renderer-site.js";
import { validate, formatDiagnostics } from "./validator.js";
import { formatSource } from "./fmt.js";
import { verifyFixtureDir } from "./verify.js";
import { diffDocs } from "./diff.js";
import { collectIdRegistry } from "./ids.js";
import { writePdfFromHtml, type PdfMarginOptions } from "./pdf.js";
import type { DocumentNode } from "./ast.js";

const HELP = `noma — readable document format for humans and agents

Usage:
  noma parse <file.noma|book.yml>            Print the AST as JSON
  noma render <file.noma|book.yml> [opts]    Render to a target format
  noma check <file.noma|book.yml>            Validate the document
  noma export <file.noma|book.yml> [opts]    Alias for render --to json
  noma patch <file.noma> [opts]              Apply block-level patch ops
  noma init [dir]                            Create a starter .noma document
  noma ids <file.noma|book.yml>              Print canonical ID and alias registry
  noma schema <name>                         Print bundled JSON Schema
  noma fmt   <file.noma> [--inplace|--out p] Re-align pipe tables in source
  noma verify <fixture-dir>                  Run conformance suite against fixtures
  noma diff <before.noma> <after.noma> --at <date>  Emit ::state_change for attribute drift
  noma --help                                Show this help
  noma --version                             Print the CLI version

Render options:
  --to <html|llm|json|noma|site|pdf> Target format (default: html). 'site' renders
                            a book manifest as a multi-page HTML site.
  --out <path>              Write to file (or directory for --to site)
  --no-standalone           HTML: emit body fragment without <html> wrapper
  --title <text>            Override document title
  --theme <name>            HTML theme: default | dark (default: default)
  --css <path>              Append custom CSS to standalone HTML/site/PDF output
  --no-unsafe               HTML: block ::html / ::svg / ::script escape hatches
  --strict                  HTML: block escape hatches and external CDN assets
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
  --ignore-rule <name>      Suppress a validator rule (repeatable)

Patch options:
  --op <json>               One inline patch op (JSON object)
  --ops <file.json>         File containing one op, an array of ops, or
                            { "ops": [...], "prevalidate": true,
                              "postvalidate": true }
  --inplace                 Write the result back to <file.noma>
  --out <path>              Write to file instead of stdout

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
  noma render examples/thesis.noma --to llm
  noma check examples/thesis.noma
  noma patch examples/thesis.noma --op '{"op":"update_attribute","id":"asml-euv-moat","key":"confidence","value":0.9}' --inplace
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
  inplace: boolean;
  theme: string;
  customCss?: string;
  allowEscapeHatches: boolean;
  externalAssets: boolean;
  pdfPageSize: string;
  pdfMargin?: string;
  pdfMarginTop?: string;
  pdfMarginRight?: string;
  pdfMarginBottom?: string;
  pdfMarginLeft?: string;
  pdfPrintBackground: boolean;
  staleDays?: number;
  ignoreRules: string[];
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
    externalAssets: true,
    ignoreRules: [],
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
    } else if (a === "--strict") {
      args.allowEscapeHatches = false;
      args.externalAssets = false;
      i++;
    } else if (a === "--stale-days") {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) args.staleDays = v;
      i++;
    } else if (a === "--ignore-rule") {
      const v = argv[++i];
      if (v) args.ignoreRules.push(v);
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
    } else if (a === "--inplace") {
      args.inplace = true;
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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
    const { manifest, chapters } = loadBookChapters(filePath);
    const allowEscapeHatches = args.allowEscapeHatches && manifest.trusted_publishing !== true;
    renderSite(manifest, chapters, args.out, {
      themeCss,
      title: args.title,
      allowEscapeHatches,
      externalAssets: args.externalAssets,
      ...(args.math ? { math: args.math } : {}),
    });
    process.stderr.write(`✓ wrote ${chapters.length + 1} pages to ${args.out}\n`);
    return;
  }

  const manifestForTrust = isBookManifestPath(filePath)
    ? (yaml.load(readFileSync(filePath, "utf8")) as Record<string, unknown> | null)
    : null;
  const allowEscapeHatches =
    args.allowEscapeHatches && manifestForTrust?.trusted_publishing !== true;

  const doc = isBookManifestPath(filePath)
    ? loadBook(filePath)
    : parse(readFileSync(filePath, "utf8"), { filename: filePath });
  inlineDatasetSources(doc);

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
            allowEscapeHatches,
            externalAssets: args.externalAssets,
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
            allowEscapeHatches,
            externalAssets: args.externalAssets,
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
        case "llm": {
          const llmOpts: {
            excludeStale?: { now: Date; days: number };
            select?: string[];
            exclude?: string[];
            budget?: number;
          } = {};
          if (args.excludeStaleDays !== undefined) {
            const now = args.now ? new Date(args.now) : new Date();
            if (Number.isNaN(now.getTime())) {
              process.stderr.write(`error: --now value is not a valid date\n`);
              process.exit(2);
            }
            llmOpts.excludeStale = { now, days: args.excludeStaleDays };
          }
          if (args.llmSelect.length > 0) llmOpts.select = args.llmSelect;
          if (args.llmExclude.length > 0) llmOpts.exclude = args.llmExclude;
          if (args.llmBudget !== undefined) llmOpts.budget = args.llmBudget;
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
        default:
          process.stderr.write(`error: unknown target "${to}"\n`);
          process.exit(2);
      }
      return;
    }
    case "check": {
      const diagnostics = validate(doc, {
        ...(args.staleDays !== undefined ? { staleCitationDays: args.staleDays } : {}),
        ...(args.ignoreRules.length > 0 ? { ignoreRules: args.ignoreRules } : {}),
      });
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
