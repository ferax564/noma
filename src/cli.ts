#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./parser.js";
import { renderHtml } from "./renderer-html.js";
import { renderLlm } from "./renderer-llm.js";
import { renderJson } from "./renderer-json.js";
import { validate, formatDiagnostics } from "./validator.js";

const HELP = `noma — readable document format for humans and agents

Usage:
  noma parse <file.noma>                     Print the AST as JSON
  noma render <file.noma> [opts]             Render to a target format
  noma check <file.noma>                     Validate the document
  noma export <file.noma> [opts]             Alias for render --to json
  noma --help                                Show this help

Render options:
  --to <html|llm|json>      Target format (default: html)
  --out <path>              Write to file instead of stdout
  --no-standalone           HTML: emit body fragment without <html> wrapper
  --title <text>            Override document title

Examples:
  noma parse examples/thesis.noma
  noma render examples/thesis.noma --to html --out dist/thesis.html
  noma render examples/thesis.noma --to llm
  noma check examples/thesis.noma
`;

interface CliArgs {
  command: string;
  file?: string;
  to: string;
  out?: string;
  standalone: boolean;
  title?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: argv[0] ?? "",
    to: "html",
    standalone: true,
    help: false,
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
    } else if (!a.startsWith("--") && !args.file) {
      args.file = a;
      i++;
    } else {
      i++;
    }
  }
  return args;
}

function loadTheme(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "themes", "default.css"),
    resolve(here, "..", "..", "themes", "default.css"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, "utf8");
  }
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

  if (!args.file) {
    process.stderr.write(`error: missing input file\n\n${HELP}`);
    process.exit(2);
  }

  const filePath = resolve(args.file);
  const source = readFileSync(filePath, "utf8");
  const doc = parse(source, { filename: filePath });

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
          const themeCss = loadTheme();
          const html = renderHtml(doc, {
            standalone: args.standalone,
            title: args.title,
            themeCss,
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
        default:
          process.stderr.write(`error: unknown target "${to}"\n`);
          process.exit(2);
      }
      return;
    }
    case "check": {
      const diagnostics = validate(doc);
      const formatted = formatDiagnostics(diagnostics, args.file);
      process.stdout.write(formatted + "\n");
      const hasError = diagnostics.some((d) => d.severity === "error");
      process.exit(hasError ? 1 : 0);
    }
    default:
      process.stderr.write(`error: unknown command "${cmd}"\n\n${HELP}`);
      process.exit(2);
  }
}

main();
