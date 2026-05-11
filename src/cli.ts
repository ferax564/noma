#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const HELP = `noma — readable document format for humans and agents

Usage:
  noma parse <file.noma|book.yml>            Print the AST as JSON
  noma render <file.noma|book.yml> [opts]    Render to a target format
  noma check <file.noma|book.yml>            Validate the document
  noma export <file.noma|book.yml> [opts]    Alias for render --to json
  noma patch <file.noma> [opts]              Apply block-level patch ops
  noma fmt   <file.noma> [--inplace|--out p] Re-align pipe tables in source
  noma verify <fixture-dir>                  Run conformance suite against fixtures
  noma --help                                Show this help

Render options:
  --to <html|llm|json|noma|site> Target format (default: html). 'site' renders
                            a book manifest as a multi-page HTML site.
  --out <path>              Write to file (or directory for --to site)
  --no-standalone           HTML: emit body fragment without <html> wrapper
  --title <text>            Override document title
  --theme <name>            HTML theme: default | dark (default: default)
  --no-unsafe               HTML: block ::html / ::svg / ::script escape hatches
  --math <katex|none>       Math rendering: enable KaTeX assets in standalone HTML
                            (default: auto-detect from doc / book manifest)
  --ignore-rule <name>      Suppress a validator rule (repeatable)

Check options:
  --stale-days <n>          Override the citation staleness window (days)
  --ignore-rule <name>      Suppress a validator rule (repeatable)

Patch options:
  --op <json>               One inline patch op (JSON object)
  --ops <file.json>         File containing one op or an array of ops
  --inplace                 Write the result back to <file.noma>
  --out <path>              Write to file instead of stdout

Examples:
  noma parse examples/thesis.noma
  noma render examples/thesis.noma --to html --out dist/thesis.html
  noma render examples/thesis.noma --to llm
  noma check examples/thesis.noma
  noma patch examples/thesis.noma --op '{"op":"update_attribute","id":"asml-euv-moat","key":"confidence","value":0.9}' --inplace
`;

interface CliArgs {
  command: string;
  file?: string;
  to: string;
  out?: string;
  standalone: boolean;
  title?: string;
  help: boolean;
  op?: string;
  opsFile?: string;
  inplace: boolean;
  theme: string;
  allowEscapeHatches: boolean;
  staleDays?: number;
  ignoreRules: string[];
  math?: "katex" | "none";
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: argv[0] ?? "",
    to: "html",
    standalone: true,
    help: false,
    inplace: false,
    theme: "default",
    allowEscapeHatches: true,
    ignoreRules: [],
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
    } else if (a === "--no-unsafe") {
      args.allowEscapeHatches = false;
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
    } else if (a === "--op") {
      args.op = argv[++i];
      i++;
    } else if (a === "--ops") {
      args.opsFile = argv[++i];
      i++;
    } else if (a === "--inplace") {
      args.inplace = true;
      i++;
    } else if (!a.startsWith("--") && !args.file) {
      args.file = a;
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

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }

  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const cmd = args.command;
  if (cmd === "init") {
    process.stdout.write(
      "Run `npx degit ferax564/noma/templates/starter my-doc` to scaffold a new Noma project.\n",
    );
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
    const themeCss = loadTheme(args.theme);
    const { manifest, chapters } = loadBookChapters(filePath);
    renderSite(manifest, chapters, args.out, {
      themeCss,
      title: args.title,
      allowEscapeHatches: args.allowEscapeHatches,
      ...(args.math ? { math: args.math } : {}),
    });
    process.stderr.write(`✓ wrote ${chapters.length + 1} pages to ${args.out}\n`);
    return;
  }

  const doc = isBookManifestPath(filePath)
    ? loadBook(filePath)
    : parse(readFileSync(filePath, "utf8"), { filename: filePath });
  inlineDatasetSources(doc);

  switch (cmd) {
    case "parse": {
      output(renderJson(doc, { pretty: true }), args.out);
      return;
    }
    case "export":
    case "render": {
      const to = cmd === "export" ? "json" : args.to;
      switch (to) {
        case "html": {
          const themeCss = loadTheme(args.theme);
          const html = renderHtml(doc, {
            standalone: args.standalone,
            title: args.title,
            themeCss,
            allowEscapeHatches: args.allowEscapeHatches,
            ...(args.math ? { math: args.math } : {}),
          });
          output(html, args.out);
          return;
        }
        case "llm": {
          output(renderLlm(doc), args.out);
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
      const ops: PatchOp[] = [];
      if (args.op) {
        ops.push(JSON.parse(args.op) as PatchOp);
      }
      if (args.opsFile) {
        const raw = JSON.parse(readFileSync(resolve(args.opsFile), "utf8"));
        if (Array.isArray(raw)) ops.push(...(raw as PatchOp[]));
        else ops.push(raw as PatchOp);
      }
      if (ops.length === 0) {
        process.stderr.write(`error: noma patch needs --op or --ops\n`);
        process.exit(2);
      }
      if (isBookManifestPath(filePath)) {
        process.stderr.write(`error: noma patch operates on .noma source files, not book manifests\n`);
        process.exit(2);
      }
      const printed = patchSource(readFileSync(filePath, "utf8"), ops);
      const target = args.inplace ? filePath : args.out;
      output(printed, target);
      return;
    }
    default:
      process.stderr.write(`error: unknown command "${cmd}"\n\n${HELP}`);
      process.exit(2);
  }
}

main();
