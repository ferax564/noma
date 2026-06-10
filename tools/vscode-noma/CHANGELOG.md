# Changelog

## 0.3.0 — 2026-06-10

- Language-server client: starts `@ferax564/noma-lsp` over stdio for `.noma` files — diagnostics, document symbols, alias-aware go-to-definition for wikilinks and `for=`/`target=` attributes, wikilink ID completion.
- New `noma.lsp.path` setting overrides the server launch command (default `npx -y @ferax564/noma-lsp`).
- Minimum VS Code version raised to 1.82 (required by `vscode-languageclient` 9).

## 0.2.1 — 2026-05-15

- README now points at the live Marketplace install path.

## 0.2.0 — 2026-05-12

- First marketplace release prep — metadata, README rewrite, `.vscodeignore`, extension-local CHANGELOG.
- No grammar changes from 0.1.0.

## 0.1.0 — 2026-05-10

- Initial grammar bundled in-repo (ships with v0.5.1 of the Noma CLI).
- Highlights directives, headings with attribute suffixes, wikilinks, math, pipe tables, escape-hatch warnings, embedded YAML/JSON/LaTeX/Mermaid/DOT.
