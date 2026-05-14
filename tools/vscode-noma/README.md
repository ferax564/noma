# Noma for VS Code

Syntax highlighting and language configuration for the [Noma](https://ferax564.github.io/noma/) document format (`.noma`).

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

Marketplace publishing is a maintainer follow-up. Until the live listing is verified, install from a local `.vsix`:

```bash
cd tools/vscode-noma
npx vsce package
code --install-extension noma-language-0.2.0.vsix
```

After marketplace publish, the install command will be:

```
ext install ferax564.noma-language
```

## Companion CLI

The [`@ferax564/noma-cli`](https://github.com/ferax564/noma) package provides `noma parse|render|check|patch|diff|verify` on the same `.noma` sources this extension highlights.

## License

MIT — see [LICENSE](https://github.com/ferax564/noma/blob/main/LICENSE).
