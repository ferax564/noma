# Noma — VS Code language support

Syntax highlighting for the [Noma](https://ferax564.github.io/noma/) document
format (`.noma`).

## What it does

- Highlights frontmatter (embedded YAML), directive blocks (`::name{...}` /
  `::`), headings with optional `{id="..." aliases="..."}` attribute blocks,
  attribute lists, wikilinks `[[block-id]]`, fenced code, tables, lists,
  block quotes.
- Math: `$inline$`, `$$display$$`, `\(...\)`, and `::math` blocks.
- Embedded language scopes for `::plotly` (JSON), `::diagram{kind="mermaid"}`
  (Mermaid), `::diagram{kind="graphviz"}` (DOT), `::math` (LaTeX), and the
  YAML frontmatter.
- Marks `::html` / `::svg` / `::script` escape hatches with an `invalid`
  scope so themes can warn on them.
- Special highlight for `id=`, `for=`, `parent=`, `block=`, `target=`,
  `dataset=`, `column=`, `xcolumn=`, `src=`, `href=` attributes — the patch
  protocol cares about these.
- Folding markers on directive opener / closer pairs.

## Install (development)

This extension is not yet published to the marketplace. To use it locally:

```bash
cd tools/vscode-noma
# Symlink into VS Code's extensions directory:
ln -s "$PWD" ~/.vscode/extensions/noma-language-0.1.0
```

Reload VS Code. `.noma` files now highlight.

To package an installable `.vsix`:

```bash
npm i -g @vscode/vsce
cd tools/vscode-noma
vsce package
code --install-extension noma-language-0.1.0.vsix
```

## Scope inventory

The grammar emits these top-level scopes (themes can target them):

| Scope                                       | What it covers                          |
| ------------------------------------------- | --------------------------------------- |
| `entity.name.directive.noma`                | The directive name itself (`claim`, `evidence`, ...) |
| `keyword.control.directive.noma`            | Same, for theme convenience             |
| `punctuation.definition.directive.begin/end.noma` | The leading/trailing colons       |
| `entity.name.section.noma`                  | Heading text                            |
| `meta.attributes.noma`                      | The `{...}` attribute block             |
| `entity.other.attribute-name.id.noma`       | `id=` and `aliases=`                    |
| `entity.other.attribute-name.reference.noma` | `for=`, `parent=`, `block=`, etc.      |
| `constant.other.reference.noma`             | The reference target string             |
| `meta.link.wikilink.noma`                   | `[[...]]` references                    |
| `markup.math.{inline,block}.noma`           | Math content                            |
| `meta.embedded.block.frontmatter`           | YAML frontmatter (gets YAML highlighting) |
| `meta.embedded.block.{math,plotly,diagram.*}` | Body of typed directive blocks         |
| `invalid.illegal.escape-hatch.noma`         | `::html` / `::svg` / `::script` blocks  |

## Limitations

- Inline parsers (`**bold**`, `*em*`, `` `code` ``, `[link](url)`) only run
  inside paragraphs, headings, list items, and blockquotes — they do not
  recurse into directive bodies. The parser does, but the grammar leaves
  directive bodies plain so the embedded-language injection can take over
  for typed directives like `::plotly` and `::diagram`.
- The `::table` directive and pipe tables share a single table-row pattern.
  Per-cell alignment from the separator row is not surfaced as a scope —
  themes that want to differentiate would need an inline pattern over the
  `:---` separators.
- Folding works on directive opener/closer pairs but does not match colon
  count, so an inner `:::card` close will fold the outer `::grid` if the
  outer closer is missing. The Noma parser would error on that source
  anyway.

## See also

- [`docs/spec.noma`](../../docs/spec.noma) — block syntax reference.
- [`docs/agent-protocol.noma`](../../docs/agent-protocol.noma) — patch ops
  the highlighter scopes target.
