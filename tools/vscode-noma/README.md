# Noma for VS Code

Syntax highlighting, language configuration, and language-server support for the [Noma](https://ferax564.github.io/noma/) document format (`.noma`).

## Language server

Opening a `.noma` file starts the [`@ferax564/noma-lsp`](https://www.npmjs.com/package/@ferax564/noma-lsp) server (via `npx -y @ferax564/noma-lsp` by default), which provides:

- **Diagnostics** from the Noma validator, live on every edit. Frontmatter-declared profiles apply automatically.
- **Outline / document symbols** for sections and ID-bearing directives.
- **Go to definition** on `[[wikilinks]]` and `for=` / `target=` attribute values, alias-aware.
- **Completion** of block IDs and aliases inside `[[` wikilinks.

Set `noma.lsp.path` to launch the server differently, e.g. a globally installed binary:

```json
{ "noma.lsp.path": "noma-lsp" }
```

The default `npx` launch needs Node.js >= 20 on your `PATH`.

## Features

- Directive blocks (`::name{...}` and namespaced `::pack::name{...}` / `::`) with attribute highlighting for the patch-protocol-aware attrs (`id=`, `for=`, `parent=`, `block=`, `dataset=`, `column=`, `src=`, `href=`, `aliases=`).
- Headings with optional `{id="..." aliases="a,b"}` suffix.
- Wikilinks `[[block-id]]`.
- Math: `$..$`, `$$..$$`, `\(..\)`, `\[..\]`, and `::math` (embedded LaTeX).
- Pipe tables, list items, block quotes, fenced code.
- Embedded language scopes:
  - YAML frontmatter
  - JSON inside `::plotly`
  - LaTeX inside `::math`
  - Mermaid inside `::diagram{kind="mermaid"}`
  - DOT inside `::diagram{kind="graphviz"}`
- Escape-hatch directives (`::html`, `::svg`, `::script`) marked with `invalid.illegal.*` scopes so themes can warn on them.
- Folding markers track directive opener/closer pairs.

## Install

Install from the VS Code Marketplace:

```text
ext install ferax564.noma-language
```

Or install from a local `.vsix` while developing the extension:

```bash
cd tools/vscode-noma
npx vsce package
code --install-extension noma-language-0.3.0.vsix
```

Marketplace listing:

<https://marketplace.visualstudio.com/items?itemName=ferax564.noma-language>

## Companion CLI

The [`@ferax564/noma-cli`](https://github.com/ferax564/noma) package provides `noma parse|render|check|patch|diff|verify` on the same `.noma` sources this extension highlights.

## License

MIT — see [LICENSE](https://github.com/ferax564/noma/blob/main/LICENSE).
