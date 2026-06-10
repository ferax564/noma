# `@ferax564/noma-lsp`

Language server for `.noma` documents, over stdio.

The server wraps the `@ferax564/noma-cli` parser and validator so any LSP
client gets live feedback on Noma documents without shelling out to the CLI.

## Install

```bash
npm install @ferax564/noma-lsp
```

## Features

- **Diagnostics** — parse + validate on open and on change. Frontmatter-declared
  validation profiles apply automatically; ranges span the offending block.
- **Document symbols** — sections and ID-bearing directives as an outline tree.
- **Go to definition** — `[[wikilinks]]` and `for=` / `target=` attribute
  values jump to the defining block. Aliases resolve to their canonical ID.
- **Completion** — inside `[[` wikilinks, all canonical IDs and aliases.

## Client configuration

The binary speaks LSP over stdio:

```bash
npx -y @ferax564/noma-lsp
```

The `noma-language` VS Code extension (v0.3.0+) starts the server
automatically for `.noma` files; the `noma.lsp.path` setting overrides the
launch command. For other editors, register `noma-lsp` as a stdio language
server for the `noma` language / `.noma` extension.

## Library use

The handler logic is exported separately from the stdio bootstrap:

```ts
import { computeDiagnostics, computeDocumentSymbols } from "@ferax564/noma-lsp";

const diagnostics = computeDiagnostics(source, "doc.noma");
```

`computeDefinition` and `computeCompletions` take LSP (0-based) positions and
return plain LSP-shaped data, so they are easy to embed in other tooling.
