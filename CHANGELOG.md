# Changelog

All notable changes to Noma are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Web workbench:** The static site now ships `workbench.html`, a browser-based `.noma` editing surface with a compact Word-style menu bar and tabbed File, Format, Insert, Layout, Review, Find, and Export ribbon panels plus Typora-style rendered editing for headings, paragraphs, list items, and quotes; live safe HTML preview; diagnostics; outline navigation; AST and LLM output tabs; sample loading; local file opening; selection-aware Markdown formatting; Noma block insertion templates; and HTML/JSON/Noma/LLM export actions. `npm run build:site` builds the client bundle from the existing parser, validator, HTML renderer, JSON renderer, and LLM renderer before copying `site/` to `dist/`.
- **Workbench documentation:** Added a screenshot-backed web workbench guide covering the browser UI, Word-style command map, authoring flow, safe preview posture, export paths, and limitations.
- **First-class PDF render target:** `noma render report.noma --to pdf --out report.pdf` now renders standalone HTML and prints it through Chromium via Puppeteer. PDF flags cover page size, margins, print backgrounds, and appended custom CSS.
- **DOCX render target:** `noma render report.noma --to docx --out report.docx` now writes a Word-compatible OOXML package directly from the AST. The exporter preserves headings, prose, lists, tables, code blocks, semantic directive labels, block-ID bookmarks, wikilinks, and external hyperlinks without adding a runtime dependency.
- **Markdown render target:** `noma render report.noma --to markdown --out report.md` (alias `--to md`) now exports portable Markdown for GitHub, Slack, email, docs imports, and lightweight agent handoffs. The renderer preserves Markdown prose, headings, lists, code, quotes, and pipe tables; converts `[[id]]` wikilinks to `[id](#id)`; emits hidden anchors for IDs and aliases; renders tasks as checklists, figures as images, callouts as GitHub-style admonitions, and directive tables as pipe tables; and wraps Noma-only directives in hidden semantic comments so exported Markdown keeps block context without replacing `.noma` as source of truth. The public API exports `renderMarkdown` and `MarkdownRenderOptions`.
- **DOCX rich hyperlink labels:** Markdown link labels with bold, emphasis, combined bold+italic, inline code, escaped literal brackets, or escaped table pipes now export as styled native Word hyperlink runs instead of literal Markdown punctuation, covering external URLs, `mailto:` links, and internal `#id` links.
- **DOCX nested inline links:** Links and wikilinks wrapped in bold, emphasis, or combined bold+italic now recurse through the DOCX inline renderer, so `**[label](url)**` and `**[[caption-id]]**` become styled native hyperlinks or caption `REF` fields instead of literal Markdown text.
- **Native Word comments:** `::comment` blocks now export to DOCX comments with author/date metadata, a document-side comment marker, a real `word/comments.xml` part, and `word/commentsExtended.xml` resolved-state/thread metadata.
- **First-class comment patching:** `add_comment` patch ops now add targeted `::comment` blocks with stable IDs, author metadata, and source-preserving insertion near the reviewed block.
- **Threaded comment patching:** `add_comment` now accepts optional `reply_to=` so agents and DOCX sync can add source-preserving threaded review replies.
- **First-class comment resolution:** `resolve_comment` patch ops now mark existing `::comment` blocks with `status="resolved"` plus optional resolver metadata without rewriting the comment body, and DOCX exports include that resolution line inside the Word comment.
- **First-class attribute removal:** `remove_attribute` patch ops now remove non-`id` directive attributes source-preservingly, giving agents a clean way to clear stale metadata without replacing a block.
- **First-class note patching:** `add_footnote` and `add_endnote` patch ops now add targeted `::footnote` / `::endnote` blocks with source-preserving insertion near the reviewed block.
- **First-class tracked change patching:** `add_change_request` patch ops now add targeted `::change_request` blocks with explicit insert/delete/replace revision text for DOCX tracked-review handoffs.
- **First-class table-cell patching:** `update_table_cell` patch ops now update one cell in an ID-bearing `::table` directive by zero-based row and numeric column or header label.
- **Code-safe table-cell patching:** table patch serialization now escapes separator pipes outside code spans while preserving pipes inside inline code, so edits like `` `x|y` `` keep their visible code text.
- **First-class table-header patching:** `update_table_header_cell` patch ops now update one header cell in an ID-bearing `::table` directive without rewriting body rows.
- **First-class table-row patching:** `insert_table_row` and `delete_table_row` patch ops now add or remove body rows in ID-bearing `::table` directives without rewriting the full table block.
- **First-class table-column patching:** `insert_table_column` and `delete_table_column` patch ops now add or remove columns in ID-bearing `::table` directives, including header-label deletion.
- **First-class dataset-cell patching:** `update_dataset_cell` patch ops now update one data cell in an ID-bearing `::dataset` directive, preserving source bytes around inline YAML row arrays, simple CSV/TSV bodies, and simple pretty-printed JSON row or record arrays.
- **First-class dataset-row patching:** `insert_dataset_row` and `delete_dataset_row` patch ops now add or remove data rows in ID-bearing `::dataset` directives, preserving source bytes around inline YAML row arrays, simple CSV/TSV bodies, and simple pretty-printed JSON row or record arrays.
- **First-class dataset-column patching:** `insert_dataset_column` and `delete_dataset_column` patch ops now add or remove data columns in ID-bearing `::dataset` directives, preserving source bytes around inline YAML row arrays, simple CSV/TSV bodies, and simple pretty-printed JSON row or record arrays.
- **Quoted CSV/TSV dataset cells:** delimited datasets now parse and serialize single-line double-quoted cells with doubled quotes, so plots, validation, patch ops, and DOCX review sync can preserve cells such as `"North, America"` instead of skipping delimiter-bearing Word edits.
- **First-class block moves:** `move_block` patch ops now relocate existing directive blocks to a new parent while preserving the block body/attributes and normalizing directive fence depth when the destination requires it.
- **DOCX page setup:** `::page_setup` now controls DOCX page size, orientation, and margins, with an HTML `@page` fallback for browser printing.
- **DOCX section breaks:** Additional `::page_setup` blocks now emit native Word section breaks and update subsequent DOCX table, dataset, grid, and columns widths from the active section geometry.
- **Native Word headers and footers:** `::header` / `::footer` now export to DOCX header/footer parts with rich inline text and part-local hyperlink relationships, and `::footer{page_numbers total_pages}` emits Word `PAGE` / `NUMPAGES` fields.
- **Generated tables of contents:** `::toc` now renders a linked heading table of contents in HTML/PDF and DOCX output, with `depth=` / `levels=` support.
- **DOCX TOC page references:** Word exports now add `PAGEREF` page-number fields to `::toc` entries and include `word/settings.xml` field-update metadata when a DOCX contains generated fields.
- **DOCX caption lists:** `::toc{of="figures|tables|plots"}` now renders linked figure/table/plot lists in HTML/PDF and DOCX, with Word page-reference fields in DOCX output.
- **Native Word review revisions:** `::change_request{action="insert|delete|replace" ...}` now exports insertions/deletions/replacements as DOCX tracked-change runs, with an HTML/PDF `<ins>` / `<del>` fallback.
- **Targeted DOCX change requests:** targeted `::change_request` blocks now mark the reviewed block with a native Word comment range and render the tracked revision block beside that target when it resolves.
- **DOCX review-view settings:** Word exports that contain native comments or valid `::change_request` tracked revisions now write `word/settings.xml` revision-view metadata so comments and insert/delete revisions open as review markup.
- **DOCX malformed change-request fallbacks:** malformed `::change_request` blocks now stay at source position with visible action/target/revision metadata, without creating native Word review parts.
- **Native Word footnotes:** `::footnote` blocks now export to DOCX footnotes with a real `word/footnotes.xml` part, preserve inline formatting/wikilinks/hyperlinks with part-local relationships, and keep a styled note fallback in HTML/PDF.
- **Targeted DOCX footnotes:** `::footnote{for|parent|target|block|ref="..."}` now anchors the native Word superscript reference to the referenced block when it resolves, while unresolved targets still render at source position.
- **Native Word endnotes:** `::endnote` blocks now export to DOCX endnotes with a real `word/endnotes.xml` part, support the same target-anchored reference attributes as footnotes, preserve rich inline note bodies, and keep an HTML/PDF fallback.
- **Generated bibliographies:** `::bibliography` now collects `::citation` blocks into a references section in HTML/PDF and DOCX output.
- **Native DOCX figures:** `::figure` blocks with PNG/JPEG/GIF/SVG `src=` assets now embed the image into DOCX output. CLI renders inline local files before calling the pure renderer; data URI figures are supported directly.
- **Static DOCX plots:** resolvable `::plot` blocks now export to DOCX as embedded SVG chart media instead of only a textual placeholder, including inline numeric data and dataset-backed plots.
- **DOCX figure and plot captions:** embedded figures and resolved plots now use the Word caption style, place captions after the media, keep block bookmarks attached to the visible caption, and include `SEQ Figure` / `SEQ Plot` numbering fields.
- **DOCX caption cross-references:** `[[id]]` wikilinks to captioned figures, tables, plots, and computed plots now export as Word `REF` fields, so caption references update alongside the generated `SEQ` caption numbers.
- **Native DOCX layouts:** `::grid` and `::columns` blocks now export as fixed-width Word tables, preserving multi-column artifact structure in Word handoffs instead of flattening layout blocks into labels.
- **Readable DOCX web layouts:** `::hero`, `::tabs`, and `::accordion` now flatten into their contents in DOCX instead of emitting raw layout labels, `:::tab{title=...}` renders as a titled Word panel, and `::sidebar` renders as a framed Word aside.
- **DOCX state-change deltas:** `::state_change` blocks now render their target, attribute, old value, new value, reason, and timestamp as a readable Word delta instead of a generic directive label.
- **DOCX math handoff:** `::math` blocks now export as Office Math containers with Cambria Math styling, preserving the linear math source for Word review instead of treating equations as code blocks.
- **DOCX inline math:** prose and table-cell math written as `$...$`, `$$...$$`, `\(...\)`, or `\[...\]` now exports as Office Math instead of literal delimiter text.
- **DOCX dataset tables:** resolvable `::dataset` blocks now export as native Word tables with inferred headers and row-count metadata instead of raw YAML/CSV text.
- **DOCX metric handoffs:** `::metric` blocks now export as Word-readable KPI blocks with label, value/unit, status, trend, change, target, source, and as-of metadata instead of generic directive labels.
- **DOCX technical documentation blocks:** `::api`, `::endpoint`, `::parameter`, `::example`, `::query`, `::instruction`, and `::changelog` now export as structured Word handoff panels with visible metadata and monospace example/query bodies.
- **HTML technical documentation blocks:** `::api`, `::endpoint`, `::parameter`, `::example`, `::query`, `::instruction`, and `::changelog` now render as structured HTML/PDF panels with visible metadata links and monospace example/query bodies instead of generic directive boxes.
- **HTML data and computation blocks:** `::metric`, `::code`, `::code_cell`, and `::output` now render as structured HTML/PDF panels with visible metadata, anchor links, KPI values, and monospace code/output bodies instead of generic directive boxes.
- **DOCX computation handoffs:** `::code_cell` and `::output` now export as technical Word blocks with monospace source/output text, execution metadata, output-to-cell links, and block bookmarks instead of generic directive labels.
- **DOCX action items:** `::agent_task` and `::todo` now export as native Word checkbox content controls with scope/owner/due metadata.
- **Control variants:** `::control{type="select" options="1=Base,1.2=Upside"}` now renders as a real HTML select and a native Word dropdown list, while `type="toggle"` renders as an HTML checkbox and a native Word checkbox control. Toggle defaults also feed computed formulas as `1` / `0`.
- **Native DOCX date controls:** `::control{type="date" default="YYYY-MM-DD"}` now exports as a native Word date-picker content control with `w:fullDate`, date format, locale, and the stable `noma-control:<id>` tag.
- **DOCX control fields:** `::control` defaults now export as native editable Word content controls with stable `noma-control:<id>` tags, while preserving type/default/range metadata.
- **DOCX content-control locks:** `::control{lock="control|content|all"}` and the `locked` flag now export native Word `w:lock` metadata for text, dropdown, date, and checkbox content controls, with validator coverage for unsupported lock modes.
- **DOCX control data binding:** ID-bearing `::control` blocks now export a `urn:noma:controls` custom XML part and native Word `w:dataBinding` metadata, giving form handoffs a structured value layer behind the visible content controls.
- **DOCX control data extraction:** `noma docx-data <file.docx>` and `extractDocxControlData(buffer)` now read the `urn:noma:controls` custom XML value layer back out as JSON, giving form handoffs a `.noma -> .docx -> data` return path.
- **DOCX control data sync:** `noma docx-sync <file.noma> <file.docx>` and `syncControlDefaultsFromDocx(source, buffer)` now source-preservingly update matching `::control default=` attributes from bound DOCX values, closing the basic `.noma -> .docx -> .noma` form loop; controls without an explicit `type=` now keep numeric-looking returned Word values as text, matching render-time control semantics.
- **DOCX sync reports:** `noma docx-sync` and `noma docx-review-sync` now accept `--report <file.json>` to write applied changes plus unmatched/skipped return-path items, including revision-bearing tables skipped from direct table-body sync, without duplicating the patched source.
- **DOCX task checkbox data extraction:** `noma docx-data <file.docx>` and `extractDocxControlData(buffer)` now also read native `::agent_task` / `::todo` checkbox state from DOCX content controls.
- **DOCX visible control fallback extraction:** `noma docx-data <file.docx>` and `extractDocxControlData(buffer)` now read visible `noma-control:<id>` content-control values when the custom XML data part is stale or missing, covering text, date, dropdown/combobox, and checkbox/toggle controls; Word `w:cr` carriage-return and `w:br` manual-break runs are preserved as line breaks, Word `w:noBreakHyphen` runs are normalized to `-`, Word `w:softHyphen` runs are preserved as U+00AD soft hyphen characters, Word `w:tab` and `w:ptab` runs are preserved as tabs, Unicode `w:sym` glyphs are preserved, and those empty run-token elements are accepted whether Word serializes them as self-closing or paired empty elements. Text control leading/trailing spaces are preserved from visible Word values instead of being trimmed before `docx-sync` writes `default=` back to source. Deleted and moved-from tracked ranges inside visible fields, including range-marker `w:moveFromRangeStart` / `w:moveFromRangeEnd` spans, are ignored so old field values and old line breaks/tabs do not return as current form data, moved-to ranges remain current text, implicit checked elements without a `val` count as checked, and metadata-stripped generated text/symbol checkbox glyphs recover toggle/task state when the tag or original control type identifies the field as a checkbox.
- **DOCX header/footer form return path:** `noma docx-data` and `noma docx-sync` now also read visible `noma-control:<id>` fields and `noma-task:<id>` checkboxes from native Word header/footer parts, so form chrome edits can return to source.
- **DOCX task checkbox sync:** `noma docx-sync <file.noma> <file.docx>` and `syncControlDefaultsFromDocx(source, buffer)` now source-preservingly apply edited Word task checkboxes back to matching `done` / `status` attributes.
- **DOCX review data extraction:** `noma docx-review-data <file.docx>` and `extractDocxReviewData(buffer)` now read native Word comments, resolved state, threaded reply links, tracked insert/delete/replace revisions, tracked moves, footnotes, endnotes, bookmarked headings, and bookmarked tables from DOCX packages as JSON, reconstructing lightweight Markdown for bold/emphasis/code/internal-wikilink/external-link comment and note bodies. Adjacent same-style Word runs now coalesce before Markdown rendering, so Word-split formatting returns as `**Bold**` or `*emphasis*` instead of fragmented markup, including inside internal and external hyperlink labels. Literal `[` and `]` characters inside returned external hyperlink labels are escaped so bracketed Word labels remain valid Noma Markdown, formatted or custom internal `#id` hyperlink labels return as `[label](#id)` when the visible anchor text or a verified Noma-generated bookmark identifies the target, generated complex or `fldSimple` Word `REF` fields for Noma caption cross-references return as `[[id]]`, and returned external hyperlink targets percent-encode whitespace and parentheses so Word relationship URLs remain valid inline link targets. Current comment, note, heading, and table bodies preserve Word `w:cr` carriage-return and `w:br` manual-break runs as line breaks, normalize Word `w:noBreakHyphen` runs to `-`, preserve Word `w:softHyphen` runs as U+00AD soft hyphen characters, preserve Word `w:tab` and `w:ptab` runs as tabs, preserve Unicode `w:sym` glyphs, preserve leading/trailing spaces in comment, note, and table-cell text, keep nested native table rows inside their parent table cell instead of promoting them to outer rows, accept those empty run-token elements whether Word serializes them as self-closing or paired empty elements, ignore deleted and moved-from tracked ranges, including range-marker `w:moveFromRangeStart` / `w:moveFromRangeEnd` spans, and keep moved-to ranges as current text while tracked-revision extraction preserves deleted or moved-from text and run tokens as old values and moved-to runs as new values. Adjacent same-ID tracked revision fragments are merged before insert/delete/replace grouping, so one formatted Word edit split across multiple `w:ins` / `w:del` wrappers returns as one rich revision instead of duplicate change requests. Multiple adjacent delete/insert pairs in the same paragraph now group into separate replacements, while delete/insert runs separated by current text remain independent revisions. Explicit native `done=false` comment state now wins over a stale generated `Status: resolved` paragraph, so reopened Word comments extract as unresolved; if a comments-extended entry omits native `done`, the generated status paragraph remains the resolution fallback.
- **DOCX field-code hyperlink return path:** Word `HYPERLINK` fields, whether serialized as complex fields or `fldSimple`, now return as Noma Markdown links with preserved result-run formatting during `docx-review-data` and `docx-review-sync`.
- **DOCX rich caption and label return path:** Accepted Word edits to caption titles plus metric, control, action, and block-title label paragraphs now preserve reviewer-authored bold/emphasis Markdown on return, including mixed bold spans in button and export-button action labels, while ignoring generated whole-label Word styling, generated button hyperlinks, and generated export-target links as presentation-only. DOCX rendering emits editable label Markdown, generated contents and caption-list entry labels, source-authored metadata values, metric values, generated dataset/plot/export metadata, bibliography entry text, task status text, and state-change `from` / `to` values as native Word runs on the next handoff instead of showing literal `**` / `*` punctuation or erasing unchanged rich labels.
- **DOCX tracked review-text safeguards:** `docx-review-data` now marks comment and footnote/endnote bodies that contain Word tracked revisions, and `docx-review-sync` reports those review bodies as skipped instead of accepting the current text as a plain source edit.
- **DOCX framed directive body anchors:** Word comments, footnote/endnote references, and tracked revisions on later framed paragraphs inside a rendered directive body now inherit the directive bookmark, so review items on paragraph two or three of a claim/risk/card no longer come back unanchored.
- **DOCX header/footer review return path:** `noma docx-review-data` and `noma docx-review-sync` now scan native Word header/footer parts for comment and tracked-revision anchors, and source patch insertion preserves nested directive fence depth for returned comments, notes, and change requests.
- **DOCX table-cell review anchors:** Word comment ranges or point references, footnote/endnote references, and tracked revisions made inside a bookmarked native table now inherit the table's Noma bookmark, so table-cell review notes and change requests can return to the source `::table` or inline `::dataset` block without accepting tracked revisions as direct table-body edits.
- **DOCX layout child review anchors:** Word comments, footnote/endnote references, and tracked revisions inside `::grid` / `::columns` layout cells now use nested child block bookmarks instead of the outer layout bookmark, so review items on a rendered card/claim cell sync back to that child block.
- **DOCX layout cell anchor isolation:** `::grid` / `::columns` review anchor inheritance now resets at each generated Word layout cell, so review items in an unbookmarked sibling cell fall back to the outer layout block instead of leaking to the previous cell's card/claim bookmark.
- **DOCX restyled table review sync:** bookmarked Word tables still return accepted edits to source after a reviewer changes the native table style away from Noma's generated `TableGrid` style.
- **DOCX rich table-cell review sync:** accepted Word edits to table header/body cells with bold, emphasis, inline code, internal wikilinks, or external hyperlinks now return as Noma Markdown while generated header styling stays presentation-only.
- **DOCX nested layout table sync:** accepted Word edits to `::table` blocks rendered inside `::grid` / `::columns` layout cells now return to the nested source table instead of being hidden by the outer layout table.
- **DOCX nested layout table review anchors:** Word comments, notes, and tracked revisions inside nested `::table` blocks rendered in layout cells now anchor to the nested table instead of coming back unanchored or targeting the surrounding card/grid.
- **DOCX nested layout dataset sync:** accepted Word edits, comments, notes, and tracked revisions inside nested `::dataset` blocks rendered in layout cells now return to the nested dataset instead of targeting the surrounding card/grid.
- **DOCX dataset table sync:** `noma docx-review-sync <file.noma> <file.docx>` and `syncReviewCommentsFromDocx(source, buffer)` now update inline `::dataset` bodies from edited native Word tables when the dataset table can be matched and represented in the source format.
- **Granular DOCX dataset sync:** simple Word cell edits to inline YAML/CSV/TSV/JSON dataset tables now use `update_dataset_cell`, simple row insert/delete edits use `insert_dataset_row` / `delete_dataset_row`, and simple column insert/delete edits use `insert_dataset_column` / `delete_dataset_column`, preserving comments, schema text, and unrelated source rows instead of replacing the full dataset body. Returned dataset cells with multiline or nested native Word table content are reported as skipped instead of being flattened into a lossy source edit.
- **Granular DOCX table sync:** accepted Word edits to matching source `::table` blocks now use `update_table_header_cell`, `update_table_cell`, `insert_table_row`, `delete_table_row`, `insert_table_column`, or `delete_table_column` when the edit shape is simple and unambiguous, preserving Markdown/link markup in unchanged cells instead of rewriting the whole table body; returned code cells with literal pipes keep the pipe inside the code span. Returned table cells with multiline or nested native Word table content are reported as skipped instead of being flattened into a lossy source edit.
- **DOCX heading edit sync:** accepted edits to bookmarked Word headings now return through source-preserving `update_heading` patches, keeping explicit heading IDs stable while updating the visible title.
- **DOCX rich heading edit sync:** accepted Word heading edits with bold, emphasis, inline code, internal wikilinks, or external hyperlinks now return through `update_heading` as lightweight Noma Markdown instead of flattened plain text.
- **DOCX caption edit sync:** accepted Word edits to table, figure, plot, and computed-plot caption paragraphs now return to the source block's caption field, including computed-plot `label=` / `title=` / `name=` attrs and body `label:` / `title:` fields, or add `title=` when no explicit computed-plot caption field exists, instead of being ignored.
- **DOCX metric label edit sync:** accepted Word edits to `Metric:` and `Computed metric:` label paragraphs now return to source `label=` / `title=` / `name=` attrs or computed-metric body `label:` / `title:` fields, adding `label=` only when the displayed label came from the fallback block ID.
- **DOCX control label edit sync:** accepted Word edits to `Control:` label paragraphs now return to source `Label=` / `label=` attrs, adding `label=` when the displayed label came from the default Word control fallback while keeping visible content-control values on the separate form-data sync path.
- **DOCX action label edit sync:** accepted Word edits to `::button` and `::export_button` action labels now return to source `Label=` / `label=` attrs or body `Label:` fields, adding `label=` when the visible Word label came from the default action fallback.
- **DOCX block title edit sync:** accepted Word edits to titled directive heading lines now return to source `title=`, `caption=`, or `name=` fields for blocks whose DOCX title has an unambiguous source field, including cards, callouts, sidebars, tabs, memory blocks, datasets, bibliographies, technical blocks, and custom fallback directives.
- **DOCX custom fallback metadata sync:** accepted Word edits to readable attribute summaries in custom fallback headings now update, add, or remove matching directive attrs, including whole-summary deletion and comma-bearing attr values, instead of being misread as `title=` text.
- **DOCX block body edit sync:** accepted Word edits to prose-like body-only directive content now return through source-preserving `replace_body` patches for claims, cards, callouts, memory blocks, tasks, and other supported semantic blocks, while unchanged source soft wraps do not create noisy rewrites.
- **DOCX technical prose body edit sync:** accepted Word edits to body-only technical prose directives now return through `replace_body` for `::api`, `::endpoint`, `::parameter`, `::instruction`, `::changelog`, and non-language-backed `::query` / `::example` blocks.
- **DOCX code body edit sync:** accepted Word edits to monospace directive bodies now return through source-preserving `replace_body` patches for `::code`, `::code_cell`, `::output`, and language-backed `::query` / `::example` blocks, preserving code line breaks instead of dropping those edits.
- **DOCX custom fallback body sync:** unknown and namespaced directives now export as framed Word fallback panels, and accepted Word edits to their body-only content return through `replace_body` while preserving readable custom labels and attribute metadata.
- **DOCX metric value edit sync:** accepted Word edits to `::metric` value paragraphs now return to source `value=` / `current=` / `amount=` attrs or body-backed metric values, preserving unit metadata when the edited value still carries the rendered unit and removing `unit=` when the reviewer deletes it from the visible value.
- **DOCX metric metadata edit sync:** accepted Word edits to `::metric` metadata fields now update, add, or remove source `status=`, `trend=`, `change=` / `delta=`, `target=`, `source=`, and `as_of=` / `asOf=` / `date=` attrs.
- **DOCX block metadata edit sync:** accepted Word edits to exported metadata lines for `::citation`, technical API/reference blocks, `::code_cell`, `::output`, `::computed_metric`, `::computed_plot`, `::control`, `::memory`, `::risk`, `::decision`, `::adr`, `::open_question`, evidence/counterevidence, assumption/hypothesis/result/limitation, `::review`, `::provenance`, `::confidence`, `::agent_task`, and `::todo` now update, add, or remove matching source attrs or computed body metadata fields while preserving existing alias spellings such as `due_at=`, `decided_at=`, `author=`, `href=`, `baseUrl=`, `url=`, `location=`, `runtime=`, `count=`, `cell=`, `range=`, `suffix=`, `min=`, `max=`, `step=`, `lastSeen=`, `validUntil=`, and `supersededBy=`, including multi-line citation `source=`, `accessed=`, URL, DOI metadata, and values containing Word's visible ` · ` metadata separator or field-like text such as `Q1: Finance`, even when Word serializes that value separator as its own run.
- **DOCX review sync:** `noma docx-review-sync <file.noma> <file.docx>` and `syncReviewCommentsFromDocx(source, buffer)` now map native Word comment/revision/note/table anchors back to Noma bookmarks, add new anchored review comments and notes to source, update or resolve existing source comments from Word state, update existing source-position note bodies, update matching `::table` bodies from edited Word tables, and import tracked revisions plus wrapper or range-marker tracked moves as `::change_request` blocks. Alias and canonical targets now compare as the same source reference during review sync, so Word's canonical bookmark return does not rewrite unchanged alias-authored wikilinks, internal links with escaped labels, table/dataset cell links, or target attributes; target-only comment markup removals also match source links whose visible labels contain escaped brackets. DOCX review extraction preserves intentional spaces inside hyperlink labels, and review sync treats Word-escaped backslashes in returned hyperlink labels plus Word-returned literal pipes for source `\|` escapes as the same visible text, avoiding noisy rewrites of unchanged `[ label ](...)`, `[C:\label](...)`, and `A\|B` source links/cells.
- **DOCX form protection:** `::doc_protection{edit="forms"}` now writes native Word document-protection settings for fillable form handoffs. It defaults to forms mode and enforcement on, without adding password protection.
- **DOCX action controls:** `::button` now exports as a Word hyperlink when `href=` is present, while `::export_button` exports as an explicit export action with target and format metadata.
- **DOCX semantic metadata:** reasoning blocks now keep key attributes visible in Word metadata lines: evidence targets/sources, counterevidence, risk owner/severity/status, decision owner/status/date, open-question ownership/due dates, and common assumption/hypothesis/result/limitation metadata.
- **HTML semantic metadata:** reasoning blocks now keep evidence target/source/url/DOI/accessed links, risk owner/severity/status, decision owner/status/date, open-question ownership/due dates, and assumption/hypothesis/result/limitation metadata visible in HTML/PDF panels instead of dropping them from the artifact view.
- **DOCX collaboration metadata:** `::review`, `::provenance`, and `::confidence` now export as Word-readable review metadata blocks with target/source bookmark links and status, reviewer, provenance, value, basis, and timestamp metadata instead of generic directive labels.
- **Native DOCX resolved comments:** resolved `::comment` blocks now add a `word/commentsExtended.xml` part with Office comment `done` state, so Word-compatible handoffs carry both the visible resolution line and native resolved-comment metadata.
- **Native DOCX comment replies:** `::comment{reply_to="..."}` now exports as a threaded Word comment reply through `commentsExtended` `paraIdParent` metadata, while `parent=` / `for=` / `target=` remain block anchors. Replies whose thread parent is missing, deleted, or withdrawn are not exported as orphan standalone Word comments and do not force review-view settings.
- **DOCX threaded reply sync:** `noma docx-review-sync <file.noma> <file.docx>` now imports Word threaded replies as source `::comment{reply_to="..."}` blocks and resolves matching existing replies when Word marks them done.
- **DOCX existing comment body sync:** `noma docx-review-sync <file.noma> <file.docx>` now imports edited native Word comment bodies back into existing source `::comment` blocks with `replace_body`, while preserving unchanged Markdown-formatted source comments.
- **DOCX rich review body sync:** accepted Word comment and note bodies without tracked revisions, with bold, emphasis, inline code, internal wikilinks, or external hyperlinks now return as Noma Markdown instead of flattened plain text.
- **DOCX rich change-request export:** source `::change_request` tracked insert/delete/replace text with bold, emphasis, inline code, internal wikilinks, or external hyperlinks now exports as rich native Word revision runs instead of flattened plain text.
- **DOCX rich tracked-revision sync:** Word tracked insert/delete/replace revisions and tracked moves with bold, emphasis, inline code, internal wikilinks, or external hyperlinks now return as Noma Markdown in `::change_request` `from=` / `to=` text instead of flattened plain text.
- **DOCX review Markdown stability:** review sync now treats equivalent lightweight Markdown spellings such as `_emphasis_` and `*emphasis*` as unchanged in comments, threaded replies, notes, change requests, and table cells, avoiding noisy source rewrites when Word returns normalized inline markup.
- **DOCX review markup removal sync:** when a reviewer removes Word formatting or hyperlinks from comments, notes, change requests, or table cells, the source now updates to plain text instead of silently preserving the old Markdown/link markup.
- **DOCX edited reply sync:** edited Word reply bodies now update existing source `::comment{reply_to="..."}` blocks when the thread parent plus visible text, metadata, or an unambiguous sibling identifies the source reply.
- **DOCX comment edit/deletion sync:** targeted Word comments now update existing same-target source comments when the source bookmark, visible body, or metadata identifies them; source-bookmarked replies count as returned thread state when marking missing sibling replies deleted; resolved Word comments refresh existing source resolution metadata; reopened Word comments clear stale source resolution metadata; metadata-conflicting comments and replies return as distinct Word comments instead of overwriting source siblings, even when the visible text is identical; deleted/withdrawn source comments and replies are ignored when matching returned Word comments and replies, even if an older DOCX still carries their source bookmark; ambiguous same-target comments and replies are skipped without deleting source siblings; deleted Word comments, including previously resolved source comments, return as source `status="deleted"` when at least one sibling comment on the same target or reply thread remains in the reviewed DOCX, and deleted/withdrawn source comments plus orphaned replies no longer export as native Word comments.
- **DOCX note edit/deletion sync:** targeted Word footnote/endnote edits now update the existing source note when the source note, exact or visible body, or an unambiguous same-target note can be matched, including target-only note markup removals among same-target siblings; deleted/withdrawn source notes are ignored when matching returned notes, even if an older DOCX still carries their source bookmark; missing sibling targeted notes return as `status="deleted"`, and deleted/withdrawn notes no longer export as native Word notes.
- **DOCX same-anchor review sync:** same-target comments and notes that share one Word anchor now fall back to body/metadata matching instead of trusting the first source bookmark on that anchor, preventing no-op DOCX returns from overwriting one sibling and deleting another. Generated empty `Comment` / `Footnote` / `Endnote` fallback labels are ignored during sync so empty source review blocks stay empty unless a reviewer adds real text.
- **DOCX tracked change request sync:** edited Word revisions now update existing source `::change_request` blocks when the source request, exact revision, metadata, or an unambiguous Noma-generated same-target request can be matched; metadata-conflicting target-only revisions return as distinct change requests instead of overwriting source siblings, even when the action and revision text are identical; target-anchored tracked revisions count as returned review state when marking missing sibling requests deleted; deleted/withdrawn source requests are ignored when matching returned revisions, even if an older DOCX still carries their source bookmark; missing sibling requests return as `status="deleted"`, while deleted/withdrawn and malformed fallback requests no longer export as native tracked revisions and are not treated as missing native siblings.
- **Rich DOCX comment bodies:** native Word comments now preserve inline bold/emphasis/code, internal wikilinks, and external hyperlinks inside `comments.xml` with a part-local relationships file when needed.
- **HTML collaboration metadata:** `::comment`, `::review`, `::provenance`, and `::confidence` now render as structured HTML/PDF review panels with target/source links and visible resolution, reviewer, provenance, and confidence metadata instead of generic directive boxes.
- **DOCX callout labels:** `::abstract`, `::callout{tone=...}`, `::note`, `::warning`, and `::tip` now export with natural Word labels and tone-specific shading instead of lowercase generic directive labels or `Callout (tone)` labels.
- **DOCX card panels:** `::card` blocks now export as framed Word panels with natural labels, variant shading, and visible icon/variant metadata instead of leaking titleless `card (...)` directive labels.
- **DOCX memory profile panels:** `::memory` and `::memory_index` blocks now export as typed Word panels with memory metadata, wikilinked index entries, and block bookmarks instead of raw fallback directive labels.
- **HTML memory profile panels:** `::memory` and `::memory_index` now render as structured HTML/PDF memory panels with typed labels, wikilinked index entries, source/supersession links, and visible freshness metadata instead of generic directive boxes.
- **DOCX addressable code snippets:** `::code{id=... lang=...}` blocks now export as labeled monospace Word code blocks with bookmarks instead of generic directive paragraphs.
- **Readable DOCX custom directives:** unknown or namespaced directives now use human-readable fallback labels such as `Finance position` and `Custom directive`, with readable attribute summaries instead of raw directive identifiers.
- **Readable HTML custom directives:** unknown or namespaced directives now render as labeled HTML/PDF fallback panels with human-readable directive names and visible attribute metadata instead of anonymous generic wrappers.
- **Computed formula validation foundation:** added a safe numeric formula parser/evaluator for `::computed_metric` and `::computed_plot`, with validator rules for missing formulas, parse errors, unknown dependencies, numeric control defaults/ranges, and over-deep computed chains. `computed_metric` and `computed_plot` are now accepted by the technical and research profiles as the static foundation for the §23.9 interactive artifact runtime.
- **Computed LLM defaults:** `noma render --to llm` now emits computed formulas plus default scalar results for `::computed_metric` and short default series for simple-domain `::computed_plot`, evaluated from `::control default=` values without including any browser runtime.
- **Interactive computed HTML artifacts:** standalone HTML now renders `::control` blocks as live inputs and recalculates `::computed_metric` plus simple-domain `::computed_plot` blocks in the browser using the same safe formula AST as validation and LLM defaults. `formula:` / `domain:` body lines are accepted alongside attributes for more readable source.
- **DOCX computed artifacts:** `::computed_metric` and simple-domain `::computed_plot` blocks now export as static Word handoffs evaluated from `::control default=` values, including visible formula/domain metadata and embedded SVG chart media for computed plots.
- **State-change diff presence tracking:** `noma diff` / `diffDocs` now emit `::state_change` blocks for attribute additions and removals as well as value changes, using `from="(absent)"` or `to="(absent)"` for presence changes.
- **Figure validation noverify:** `::figure{noverify}` now suppresses `figure-missing-alt`, matching the per-block validator opt-out promised by the docs.
- **DOCX document metadata:** Word exports now carry frontmatter `title`, `author`, `description`, `tags` / `keywords`, `profile`, and `status` into `docProps/core.xml` so Word and Google Docs handoff files retain meaningful package properties.
- **DOCX table captions:** `::table{title=...}` / `caption=...` now exports a visible Word table label with a `SEQ Table` numbering field and the block bookmark attached instead of silently dropping the table label metadata.
- **DOCX page-aware table widths:** Word table columns now derive from the active `::page_setup` width and margins for pipe tables, `::table`, datasets, and `::grid` / `::columns` layout tables instead of using the default text width everywhere.
- **DOCX visual-spec fallbacks:** `::diagram` and `::plotly` now export as explicit Word-readable source fallbacks instead of generic verbatim directive labels, preserving Mermaid/Graphviz/Draw.io/Plotly source for review.
- **`::pagebreak` directive:** `::pagebreak` now renders as a real page break in DOCX and as a print page break in HTML/PDF output. It is accepted by the built-in `minimal`, `technical`, and `research` profiles.
- **Strict computed artifacts:** `noma render --strict` now disables controls, keeps computed metric/plot default values visible, emits a single disabled-interactivity badge, and omits the generated computed inline runtime so strict HTML is free of script tags from Noma itself.
- **Plot x-axis label controls:** `::plot` now accepts `xlabel_angle=`, `xlabel_wrap=`, `xlabel_abbrev=`, and `compact` for dense report/dashboard charts.
- **Markdown/HTML pain research memo:** `docs/research-markdown-html-pains.noma` captures external research from X, Reddit, Hacker News, official Markdown docs, GitHub issues, and Stack Overflow to sharpen Noma's source/artifact/agent wedge.

### Changed

- **Report print defaults:** the default and dark themes now avoid breaking plots, diagrams, datasets, and tables across pages, style disabled computed-control badges, and use denser print table spacing for committee-style PDFs.
- **Trusted-publishing hardening:** `trusted_publishing: true` book manifests now apply the same strict static HTML posture as `--strict` for manifest-driven HTML/site/PDF renders: escape hatches are blocked, CDN runtimes are omitted, and computed controls render disabled static defaults without the generated inline runtime.
- **Control validation scope:** `control-missing-default` and `control-out-of-range-default` now apply only to numeric controls (`slider`, `range`, `number`, `checkbox`, and `toggle`), so text/date/form-select controls can be used as document fields without spurious numeric formula warnings.
- **Richer DOCX handoffs:** Word exports now style common semantic blocks (`summary`, `abstract`, `claim`, `evidence`, `counterevidence`, `risk`, `decision`, `open_question`, `callout`, `note`, `warning`, `tip`, `review`, `provenance`, `confidence`, `change_request`, `citation`, and `state_change`) as shaded review blocks, preserve key semantic metadata as readable Word lines, preserve frontmatter as Word package metadata, preserve `agent_task` / `todo` as native checkbox action items, preserve `::control` as native content-control fields, preserve `::button` / `::export_button` as readable action/export blocks, preserve `state_change` old/new deltas, preserve datasets, field-numbered table captions, field-numbered figure/plot captions, caption cross-reference fields, page-aware table/layout widths, metric KPI blocks, computed metric/plot handoffs, technical API/reference blocks, addressable code snippets, and code-cell/output computation blocks, preserve `grid` / `columns` layout as Word tables, preserve `::card` as framed Word panels, preserve `::memory` / `::memory_index` as typed memory panels, flatten web-first `hero` / `tabs` / `accordion` containers into readable content with titled tab panels, preserve browser-hydrated diagram/Plotly specs as source fallbacks, preserve math blocks and inline math as Office Math, preserve readable labels for custom directives, preserve section-level page setup, rich native headers/footers with page numbers, generate linked tables of contents with page-reference fields, preserve explicit page breaks, export native Word comments with rich body content plus resolved-state/thread metadata, target-anchored review revisions, and rich footnotes/endnotes, generate bibliographies, embed figure images and static plot charts, and emit clickable URL/DOI lines for citation blocks instead of only a raw attribute label.
- **Targeted DOCX comments:** `::comment{parent="..."}` / `for=` / `target=` now anchor native Word comments to the referenced block when it exists instead of rendering a duplicate standalone marker.
- **Broader source-preserving patch ops:** the CLI schema surface, MCP server, Agent SDK types, Python SDK models, and capability descriptors now accept `add_comment`, `resolve_comment`, `remove_attribute`, `add_footnote`, `add_endnote`, `add_change_request`, `update_table_cell`, `update_table_header_cell`, `insert_table_row`, `delete_table_row`, `insert_table_column`, `delete_table_column`, `update_dataset_cell`, `insert_dataset_row`, `delete_dataset_row`, `insert_dataset_column`, `delete_dataset_column`, and `move_block` alongside the existing patch operations.
- **DOCX reopened comment sync:** `noma docx-review-sync` now removes stale `status="resolved"`, `resolved_by=`, and `resolved_at=` metadata from matched source comments when Word returns explicit native unresolved state.
- **Positioning wedge:** README, homepage, comparison guide, and getting-started docs now frame Noma as durable readable source that renders rich HTML/PDF artifacts and supports agent-safe block patches, rather than as a generic Markdown replacement.

## [0.11.1] — 2026-05-16

### Added

- **Two new validator rules.** `claim-invalid-confidence` warns when a `::claim` block declares a `confidence=` attribute that is not a number in `[0, 1]` (rejects strings like `"high"` and out-of-range numerics). `citation-missing-source` warns when a `::citation` block has no `url=`, `source=`, or `doi=` attribute. Both rules are filterable via `--ignore-rule` and per-block `noverify`.

### Changed

- **Lockstep version bumps.** `@ferax564/noma-cli` → `0.11.1`, `@ferax564/noma-mcp-server` → `0.11.1`, and `@ferax564/noma-agent-sdk` → `0.1.1`. The agent SDK stays on its 0.x experimental trail until v1.1 RFC graduation, but its declared dependencies on `noma-cli` and `noma-mcp-server` now pin to `0.11.1` so `npm install @ferax564/noma-agent-sdk` resolves a consistent v0.11.x toolchain.
- **Website and package polish:** landing page now has explicit install, workflow, toolchain, and extended example sections covering the CLI, VS Code extension, MCP server, Agent SDK, GitHub Action, book rendering, stale-memo trace, memory trace, and templates.
- **Package trust metadata:** workspace package manifests now declare repository, homepage, and issue URLs for future npm publishes.

### Fixed

- **MCP server runtime metadata:** `@ferax564/noma-mcp-server` now reports `0.11.1` to MCP clients instead of the stale `0.1.0` server version string that v0.11.0 left in place.
- **VS Code extension README:** the extension docs now point at the live Marketplace install path; the in-tree `noma-language` package is bumped to `0.2.1`, ready for the maintainer to run `vsce publish` against the Marketplace.

## [0.11.0] — 2026-05-15

### Added

- **Adoption docs and homepage refresh:** the landing page now points at case studies, a comparison guide, an agent editing guide, and starter templates. New Noma-authored docs cover the agent-refreshable research memo workflow, Noma-vs-Markdown/MDX/HTML tradeoffs, safe agent patch loops, and copyable document templates under `examples/templates/`.

### Changed

- **npm publish readiness:** package manifests now declare public scoped publish metadata, the MCP server exposes typed ESM exports, and the CLI package no longer includes generated site artifacts or PDFs through a broad `dist/` files entry. Regression coverage now locks those package-shape expectations.
- **Registry-safe workspace packages:** the MCP server and Agent SDK now depend on concrete public package versions instead of local `file:` specs and self-build during pack/publish, so their published tarballs install correctly in clean consumer projects.
- **Packed CLI smoke gate:** `npm run smoke:package` now installs the packed CLI into a clean temp project and exercises version, init, check, HTML/LLM render, IDs, patch transactions, API import, strict rendering, and package artifact shape. CI runs it on every push.
- **Formal local contracts:** `noma schema <name>` now prints bundled JSON Schemas for patch ops, patch transactions, AST JSON, transcript records, and capability sidecars. The CLI package includes `schemas/`, package smoke exercises schema output, and `test/schema.test.ts` validates the schemas against reference examples.
- **Broader source-preserving patch ops:** `replace_body` and `update_heading` are now accepted by the core patcher, CLI schema surface, MCP server, and Agent SDK types. `update_heading` preserves stable section IDs by pinning the old slug when needed, and `rename_id` now also retargets `parent=` reference attributes.
- **Compatibility and namespace groundwork:** new `docs/compatibility.noma` defines stability classes, deprecation rules, schema compatibility, and out-of-scope publishing surfaces. The parser and VS Code grammar now accept namespaced directive names such as `::finance::position{...}` for future community packs.

## [0.10.2] — 2026-05-14

### Fixed

- **npm package identity:** the public package names now use the `@ferax564` npm scope (`@ferax564/noma-cli`, `@ferax564/noma-mcp-server`, `@ferax564/noma-agent-sdk`). The `@noma/*` scope belongs to another project, so install docs, workspace metadata, imports, and Action override examples no longer point at it.

## [0.10.1] — 2026-05-14

### Fixed

- **GitHub Action install hardening:** the action now installs the CLI from the action checkout by default instead of `@noma/cli@latest`, avoiding registry-version drift while preserving explicit `cli-package` / `cli-version` overrides.

## [0.10.0] — 2026-05-14

### Added

- **CLI install polish:** `noma --version` / `noma -v` now prints the package version, `noma init [dir]` writes a renderable starter document, and `noma render --strict` blocks raw HTML/SVG/script escape hatches while omitting external CDN runtimes for math, diagrams, and Plotly.
- **`renderHtml(..., { externalAssets: false })`** for callers that need CDN-free standalone HTML while keeping source placeholders visible.
- **Scoped LLM context export:** `noma render --to llm` now supports `--select`, `--exclude`, and `--budget` to emit only the node types or directive names an agent needs.
- **`noma ids <file.noma|book.yml>`** prints a JSON canonical ID, alias, and record registry for agent discovery, including book-scoped IDs when run against a manifest.
- **Patch transactions:** `noma patch --ops` now accepts `{ "ops": [...], "prevalidate": true, "postvalidate": true }` payloads and refuses to write invalid post-states.
- **Reusable GitHub Action:** `uses: ferax564/noma@main` installs `@ferax564/noma-cli`, optionally validates, renders HTML/LLM/JSON/Noma/site artifacts, and uploads the output.

### Fixed

- **MCP SDK advisory coverage.** `@modelcontextprotocol/sdk` is bumped to `1.29.0` in the MCP server and Agent SDK workspaces to pick up upstream security fixes.
- **HTML section IDs are emitted once.** Headed sections now keep the canonical `id` on `<section>` only instead of duplicating it on both `<section>` and the heading element.
- **Source-preserving `add_block` validation.** `patchSource()` now rejects invalid `add_block` fragments before inserting them, matching the AST patch path and `replace_block` behavior.

## [0.9.0] — 2026-05-13

### Added

- **`@ferax564/noma-agent-sdk` v0.1.0 — reference Agent SDK (experimental).** TypeScript-only, stdio-only via `@ferax564/noma-mcp-server`. Public surface: `NomaTools` (1:1 wrapper over `read_doc`, `list_ids`, `validate_doc`, `patch_block`) and `NomaWorkflow` (composes tools into `safePatch` with per-file absolute-path mutex + clamped retry, `applyOps` with client-side parent-chain transcripts, `replayTranscript`, `readCapabilities`, `checkCapability` with advisory denials including the Annex A `ids.rename` global gate). `CapabilityDescriptor` parses Annex A v1 sidecars (`<file>.capabilities.yml`) and validates against the §A.3 schema. Errors split into a `NomaSystemError` hierarchy (thrown) for system faults — including book-manifest `unsupported_op` — and `{ ok: false, code }` bodies for user-recoverable §3.5 patch errors (`target_missing`, `parent_missing`, `id_conflict`, `invalid_content`, `id_attribute_protected`, `sha_mismatch`). Five-tier test pyramid: unit, tools-vs-real-server, workflow, demo replay (`agent-stale-memo` + `agent-memory` ported to the SDK), and conformance (drives `examples/conformance/patch/*`). Graduation metrics aggregator captures the three numbers gating Annex A+B promotion in v1.1 (7/7 single-call codes, every Annex A.3 descriptor field, full conformance corpus). Marked **experimental** — API freezes at v1.0 in lockstep with RFC v1.1 graduation.

## [0.8.0] — 2026-05-12

### Added

- **Memory profile — `::memory` and `::memory_index` directives for agent memory stores.** A new `memory` validator profile narrows the allowed directive surface to two blocks and enforces six rules: canonical `id=`, `type` ∈ {`user`, `feedback`, `project`, `reference`}, `confidence` ∈ `[0, 1]` (rejects boolean and empty-string coercion), strict ISO `last_seen` that round-trips through `Date.UTC` (rejects impossible calendars like Feb 31), and `[[wikilink]]` targets that must resolve to a `::memory` directive (by `id` or `aliasIds`).
- **Stale-aware LLM recall.** `noma render --to llm --exclude-stale-days <n>` (with optional `--now <iso>` for tests) drops `::memory` blocks whose `last_seen` is older than the window, plus `::memory_index` body lines whose wikilinks resolve only to excluded memories (no dangling refs in the LLM context). Type-aware filter: durable `user` and `feedback` rules are pinned by default unless they carry `expired=true`; only `project` and `reference` memories age out of the recall window.
- **Runnable agent-memory demo.** `examples/agent-memory/` (`npm run demo:agent-memory`) converts six real Claude Code Markdown memories into a single `.noma` file, applies four surgical patch ops, re-validates, and renders both full and stale-excluded LLM recalls. 90.7% of bytes survive the patch; the 30-day recall four months later shrinks from 9033B to 4551B while keeping every durable rule.

### Changed

- **`@ferax564/noma-mcp-server` bumped to v0.8.0** to restore lockstep with `@ferax564/noma-cli` (the workspace package was inadvertently left at v0.6.0 across the v0.7.0 and v0.7.1 releases; no code changes to the MCP server itself in this bump).

### Fixed

- **Nav chapter links, home link, and cross-chapter wikilinks from nested-slug pages.** When a chapter has a level-1 section with an explicit `id` containing `/` (e.g., `# Title {id="part/intro"}`), the page is written into `part/intro.html` — but nav links emitted `href="flat.html"`, the home link emitted `href="index.html"`, and cross-chapter wikilinks emitted `href="other.html#x"`, all of which the browser resolved against the subdirectory and produced broken `part/flat.html`-style requests. The site renderer now applies the same depth-aware `../` prefix machinery that fixed the stylesheet href in v0.7.1, to every internal link generated by `--to site`. Closes the residual issue called out in the v0.7.1 release notes. Regression coverage in `test/renderer-site-assets.test.ts`.

## [0.7.1] — 2026-05-12

### Fixed

- **`--to site` linked the wrong theme path from nested chapter pages.** When a level-1 section uses an explicit `id` containing `/` (e.g., `# Title {id="part/intro"}`), the chapter was written to `part/intro.html` but the stylesheet link still pointed at the root-relative `_assets/theme.css` — which the browser resolved against the subdirectory, producing a broken `part/_assets/theme.css` request and an unstyled page. The site renderer now computes a depth-aware `href` per chapter (e.g., `../_assets/theme.css` for a 1-deep slug). Regression caught by Codex review of v0.7.0; the existing demo book uses plain filename slugs and was unaffected. Note: nav links and cross-chapter wikilinks from nested-slug pages have a pre-existing equivalent issue, tracked separately for v0.8.

## [0.7.0] — 2026-05-12

### Added

- **`noma diff <before.noma> <after.noma> --at <date>`** — emits a flat list of `::state_change` blocks for scalar attribute drift on directives identified by `id` and present in both snapshots. Flags: `--at YYYY-MM-DD` (required, for deterministic output), `--reason "..."`, `--out <path>`. v0.7 scope is attribute-value changes only; attribute add/delete, block add/delete/rename, and prose/heading changes are tracked for v0.7.1. Closes the last item from the v0.3 state_change story.
- **`book.yml` `trusted_publishing: true`** — manifest-level flag that implies `--no-unsafe` for every render driven by the manifest (single-page or `--to site`). The manifest is the final word: no CLI flag re-enables escape hatches once the manifest forbids them.
- **`stylesheetHref` option on `renderHtml`** — when set, the standalone HTML head emits `<link rel="stylesheet" href="...">` instead of `<style>...</style>`. Used by the site renderer; the single-page path is unchanged.
- **`tools/vscode-noma` v0.2.0 — marketplace publish prep.** Metadata, `.vscodeignore`, `CHANGELOG.md`, README rewrite, LICENSE bundled into the extension folder. Live marketplace publish is a follow-up step the maintainer runs; verify the live listing at https://marketplace.visualstudio.com/items?itemName=ferax564.noma-language after publish.
- **`diffDocs(before, after, options)`** programmatic export from `@ferax564/noma-cli`.

### Changed

- **`--to site` deduplicates theme CSS.** Chapter and index pages now `<link rel="stylesheet" href="_assets/theme.css" />` instead of inlining the full theme body. Output size on a 30-chapter book drops by ~15 KB per page. Output for `renderHtml` (single-page) is unchanged unless the caller opts in via `stylesheetHref`.

## [0.6.0] — 2026-05-11

### Added
- **Noma Agent Protocol v1.0 RFC** — single canonical spec for block identity, patch operations, validation, transcript records, and source spans. Provisional annexes for capability descriptors (sidecar) and MCP-over-stdio binding. (`docs/spec-agent-protocol-v1.noma`)
- **`noma verify` CLI** — conformance harness running ID, diagnostic, roundtrip, span, and patch-application checks against a fixture directory. Exit codes: 0 all-pass, 1 any-fail, 2 missing dir.
- **14-fixture conformance corpus** under `examples/conformance/` exercising every locked decision in the RFC: 6 valid, 6 patch, 2 invalid fixtures.
- **Explicit `FrontmatterNode` AST variant** with `raw`, `data`, `pos`, and `endLine` fields. Document node now carries `pos` and `endLine` spanning the entire source.
- **`PatchError.code` field** — machine-readable taxonomy (`target_missing`, `id_conflict`, `id_attribute_protected`, `parent_missing`, `invalid_content`, `sha_mismatch`, `pre_validation_blocked`, `op_list_aborted`, `unsupported_op`).
- **Validator `duplicate-id` test coverage** — explicit collisions emit error diagnostic; slug-derived collisions auto-suffix `-2`, `-3` (no diagnostic).
- `@ferax564/noma-mcp-server` (Phase 0): MCP server for block-level agent editing via stdio transport.
  Four tools: `read_doc`, `list_ids`, `validate_doc`, `patch_block`. Byte-preserving
  `patchSource()` write path. Append-only `.noma.patches` JSONL transcript with
  `pre_sha`/`post_sha` and `expected_sha` concurrency guard.

### Changed
- **Transcript schema** rewritten to v1.0 protocol shape (`packages/mcp-server/src/transcript.ts`): drops `v: 1` literal, adds `protocol_version`, `op_id` (UUID), `tool_version`, `doc_uri`, full `pre_sha256`/`post_sha256` (8-char `pre_sha`/`post_sha` now display-only), structured `actor` object, `patch_result` enum (`applied | rejected | noop`), structured `TranscriptDiagnostic[]` with `phase`, optional `base_sha256` with drift detection (`base_sha_drift` warning).
- **Phase 0 transcripts (`v: 1` format) are legacy-only** and not retroactively v1.0 compatible.
- **`docs/agent-protocol.noma`** superseded by the v1.0 RFC. Carries `superseded-by:` frontmatter pointer.
- **`docs/spec.noma`** version field bumped to `0.6.0`; cross-references the new RFC for normative agent-protocol content.

### Fixed
- Parser: `::` lines inside fenced code blocks no longer trigger directive recognition (PLAN.md §24.9). Fixed in `parseDirective` close-marker scan.

## [0.5.1] — 2026-05-10

Closes the two items deferred from the executive-read review (#5 and #6).
Theme: shipping the developer-experience artifacts that turn `.noma` from a
working format into one that's pleasant to author and demo.

### Added

- **VS Code language extension** (`tools/vscode-noma/`). TextMate grammar
  (`source.noma`) plus `language-configuration.json`. Highlights directive
  blocks (`::name{...}` / `::`), headings with `{id=... aliases=...}`
  attributes, wikilinks `[[block-id]]`, math (`$..$`, `$$..$$`, `\(..\)`,
  `::math`), pipe tables, list items, block quotes, fenced code, and the
  attribute grammar. Embedded language scopes hand off to YAML for
  frontmatter, JSON for `::plotly` bodies, LaTeX for `::math` bodies,
  Mermaid for `::diagram{kind="mermaid"}`, and DOT for
  `::diagram{kind="graphviz"}`. Escape-hatch directives (`::html`,
  `::svg`, `::script`) emit `invalid.illegal.*` scopes so themes can
  warn on them. Folding markers track directive opener/closer pairs.
  Special highlight for the attributes that the patch protocol cares
  about (`id=`, `for=`, `parent=`, `block=`, `target=`, `dataset=`,
  `column=`, `xcolumn=`, `src=`, `href=`, `aliases=`). Closes review
  fix #5. Install locally with `vsce package` → `code
  --install-extension`. Not yet on the marketplace.
- **Killer demo: agent updates a stale research memo without rewriting
  the file** (`examples/agent-stale-memo/`). The memo declares
  `stale_citation_days: 60` in frontmatter and ships two citations
  whose `accessed=` dates are outside the window. Five patch
  operations (`update_attribute` on the two `accessed=` dates, one on
  `confidence=`, one on `severity=`, plus an `add_block` for a fresh
  `::evidence`) refresh the memo end-to-end. The runner script at
  `scripts/agent-stale-memo.ts` validates before (surfaces the
  stale-citation warnings), applies the patches via `patchSource`,
  validates after (clean), and writes a narrated walkthrough at
  `dist/examples/agent-stale-memo/trace.html`. ~89% of source lines
  survive byte-for-byte: the only changed lines are the edited
  attribute lines plus the inserted evidence block. New npm script
  `demo:stale-memo`; wired into `build:site` so the trace ships with
  the site build. Closes review fix #6.

## [0.5.0] — 2026-05-10

Closes the executive-read review fixes (#1–#4) plus issues #10, #11, #12.
Theme: tightening the human-and-agent collaboration contract — patches that
truly preserve unrelated bytes, roundtrip-safe stable IDs, and richer
artifacts (interactive diagrams, plotly, external datasets) without breaking
the AST.

### Added

- **`patchSource(source, ops)` — source-preserving patch** (review fix #1).
  `noma patch` no longer round-trips the whole file through `renderNoma`. The
  parser now records `endLine` per node; `patchSource` rewrites only the
  targeted line range. Frontmatter quoting, sibling blocks, blank-line
  padding, and attribute order on unchanged lines all survive byte-for-byte.
  AST-level `patch(doc, op)` stays for callers that already work in AST space.
- **`::diagram{kind="mermaid|graphviz|drawio"}` directive** (issue #10).
  Body holds the source verbatim. The HTML renderer auto-injects the matching
  CDN runtime only when the document actually uses that kind, so plain pages
  stay CDN-free. Mermaid renders to inline SVG, Graphviz uses
  `@viz-js/viz`, drawio uses the diagrams.net `viewer-static` script. LLM
  export keeps the body unmodified (markdown stripping would mangle DOT or
  Mermaid syntax).
- **`::plotly` directive** (issue #11). Body is a JSON spec
  (`{ data, layout, config }`). HTML emits a container Plotly hydrates; LLM
  keeps the JSON intact. PDF capture works because Puppeteer waits for
  network idle.
- **`::dataset{src="data.csv"}` external sources** (issue #12). New
  `src/loader.ts` inlines the file into `body` after parse, inferring format
  (`csv`, `tsv`, `json`, `yaml`) from extension or content. CLI calls the
  loader for both single files and book chapters (per-chapter directory
  resolution). Renderers stay pure.
- **Programmatic API surface** (review fix #4). `@ferax564/noma-cli` now exposes
  `main`/`types`/`exports` so `import { parse, patchSource, renderHtml }
  from "@ferax564/noma-cli"` works in any Node 20+ project.

### Changed

- **`renderNoma` emits explicit heading attributes** (review fix #2). Sections
  with non-slug `id=` or any `aliases` now print as
  `## Title {id="..." aliases="a,b"}`. Without this, the parse → render → parse
  cycle dropped stable IDs that agents rely on.
- **Wikilink grammar accepts `/`, `.`, `:` in IDs** (review fix #3). Book-scoped
  IDs (`chapter/risks`), dotted metric IDs (`metric.r10`), and namespaced IDs
  (`ns:scoped`) now resolve. Fixed uniformly in `inline.ts`, `patch.ts`,
  `validator.ts`.
- **`prepare` script no longer swallows build failures.** The `|| true`
  fallback is gone — broken builds now fail loud instead of silently shipping
  a stale `dist/`.
- **CommonMark soft line breaks.** A single newline inside a paragraph now
  renders as a space; hard breaks need two trailing spaces or a trailing
  backslash. Brings rendering in line with every other Markdown processor.
- **Bar plot edge padding.** Bars no longer run past the data-area edge.

### Fixed

- The "unrelated 95% of the file is byte-identical" promise from
  `docs/agent-protocol.noma` is now actually true (was: drifted frontmatter
  YAML formatting, dropped heading attributes).

### Validator

New rules: `diagram-missing-kind`, `diagram-missing-source`,
`plotly-missing-spec`, `plotly-invalid-json`, `dataset-src-missing`. The
`technical` and `research` profiles now include `diagram` and `plotly`.

### Documentation

- `docs/spec.noma` bumped to v0.5 with new sections for diagrams, plotly,
  external datasets, and source-preserving patch.
- `docs/agent-protocol.noma` bumped to v0.5; clarifies that `noma patch`
  preserves bytes outside the targeted span.
- README clarifies `@ferax564/noma-cli` is the published name (was `@ferax564/noma-parser`,
  never published under that name).

### Known follow-ups

The review also flagged a "killer demo" (agent updates a stale research
memo without rewriting the file) and a VS Code TextMate grammar — both
deferred to follow-up issues to keep this PR focused.

## [0.4.1] — 2026-05-10

Closes issue #9 — polishes the `--to site` index page so it stops embarrassing
books with rich `::summary` blocks.

### Fixed

- **Card descriptions parse inline markdown** (issue #9). The auto-generated
  `index.html` from `--to site` was emitting literal `**bold**`, `` `code` ``,
  and `[[wikilink]]` text in chapter card descriptions. Descriptions now run
  through the same inline parser as the rest of the document: `**bold**` →
  `<strong>`, `` `code` `` → `<code>`, `*em*` → `<em>`, `[label](url)` → `<a>`.
  Wikilinks resolve to the owning chapter (`other.html#id`) when known, or fall
  back to bare label text — no more literal `[[...]]`. Description truncation
  now honours sentence boundaries instead of character count.
- **Index page emits `nav.noma-site-nav`** (issue #9). The auto-generated index
  no longer skips the shared chapter nav. Post-processing layers that target
  `nav.noma-site-nav` no longer need an index special-case. The home crumb is
  marked `noma-nav-current` on the index itself.

## [0.4.0] — 2026-05-10

Closes every open GitHub issue (#2 through #8) raised after the v0.3.0 ship.
Theme: making books a first-class output, fixing every authoring papercut from
the 30-chapter strategy reference dogfood.

### Added

- **`--to site` multi-page renderer** (issue #3). `noma render <book.yml> --to site --out <dir>`
  emits one `<chapter-slug>.html` per chapter plus an `index.html` table of contents.
  Cross-chapter `[[block-id]]` wikilinks rewrite to `<other-chapter>.html#block-id`;
  same-page references stay as `#block-id`. Each page gets a top nav listing every
  chapter and a back-link to the index. Single-page `--to html` keeps working
  unchanged. Theme CSS is currently inlined per page; the shared `_assets/theme.css`
  layout the issue mentions is queued for a follow-up — functional today, just larger
  output for big books.
- **Math rendering** (issue #2). New `::math{display="block|inline"}` directive plus
  `$..$`, `$$..$$`, `\(..\)`, `\[..\]` inline delimiters. The HTML renderer auto-injects
  KaTeX from CDN when math is detected (via `::math`, `$$..$$`, or `meta.math`).
  Force-enable with `--math=katex`; force-disable with `--math=none`. The LLM renderer
  passes the LaTeX source through untouched. `math` is included in every profile.
- **Scoped heading IDs in book mode** (issue #4). Every level ≥ 2 heading now has its
  slug path-prefixed by its chapter root: `## Risks` inside `# Risk Premia 3` becomes
  `risk-premia-3/risks`. The original slug is registered as an alias on the same
  section so existing `[[risks]]` links still resolve to the first occurrence.
  Eliminates the `duplicate-id` errors books used to flood validators with.
- **Heading attribute syntax** (`## Title {id="..." aliases="a,b"}`). Lets authors
  pin a stable wikilink target without restructuring the heading title.
- **Chapter aliases** (issue #5). Two extra resolution paths now land on the chapter
  root section: the chapter filename slug, and a frontmatter `aliases:` list. Wikilinks
  resolve against `{explicit id, auto-slug, frontmatter aliases, filename slug}` in
  that priority order.
- **Composable profiles** (issue #6). Frontmatter `profiles: [research, technical]`
  opts in to the union of multiple profiles. The legacy `profile: <single>` form keeps
  working unchanged. `::table` and `::math` now ship in every profile (they were the
  most common out-of-profile false positives).
- **`--ignore-rule <name>` flag** (issue #7) on `noma check` and `noma render`.
  Repeatable; drops matching diagnostics for that invocation. Unknown rule names
  produce an `info` note. Useful when chapter-by-chapter validation hits expected
  cross-book wikilink failures.
- **`prepare` script + `dist/` in published files** (issue #8). `npm i -g
  github:ferax564/noma` now builds `dist/` automatically before symlinking the bin,
  fixing the dangling-symlink failure on direct-from-GitHub installs.

### Changed

- **`research`, `technical`, `minimal` profiles** all include `math` and `table`
  from this version forward.
- **Default theme** picks up styles for the multi-page site nav, alias anchors,
  and centered display math.

### Fixed

- Book validator no longer floods with `duplicate-id` errors on common subsection
  titles (`## Risks`, `## Citations`, `## Cross-references`, `## Premise`) repeated
  across chapters.
- `npm i -g github:ferax564/noma` no longer leaves a dangling symlink.

## [0.3.0] — 2026-05-10

Response to issue #1 — eight friction points and two design questions raised
by the first real-world authoring pass on a non-trivial weekly recap.

### Added

- **`::table` directive** for tables where pipe-syntax is awkward
  (single-character markers next to long-prose cells). Body is plain pipe
  rows with no separator-row requirement; alignment declared via
  `align="l,c,r,-"`; `header` flag promotes the first row to `<th>`.
- **`noma fmt <file>`** subcommand re-aligns existing GitHub-style pipe
  tables to a single column width and leaves everything else byte-identical
  (skips fenced code blocks). `--inplace` rewrites in place. All
  `examples/` and `docs/` files dogfooded with `noma fmt --inplace`.
- **`::plot{dataset="<id>" column="<name>" xcolumn="<name>"}`** linkage —
  plots can pull their series out of a sibling `::dataset` instead of
  duplicating the numbers inline. Validator emits `plot-unknown-dataset`
  / `plot-unknown-column` errors when references don't resolve.
  `examples/research-thesis.noma` now uses the linked form.
- **`::state_change{block, attribute, from, to, reason, at}`** directive
  for weekly/quarterly recap docs — records typed deltas against another
  block. HTML renders as a strike-through → bold delta; LLM keeps the
  structured fields. Validator: `block=` must point to an existing id;
  both `from=` and `to=` are required. Included in the `research` profile.
- **Profile frontmatter field** (`profile: research | technical | minimal`)
  — opt-in contract about which directives the document guarantees to use.
  Validator warns on out-of-profile directives so downstream tools can
  narrow safely. Pure metadata; no AST change.
- **`stale_citation_days` frontmatter override** + per-citation
  `stale_after_days=N` attribute. Precedence: CLI `--stale-days` >
  per-citation `stale_after_days` > frontmatter `stale_citation_days` >
  default 365.
- **`noma check --stale-days <n>`** CLI flag (was previously documented but
  not actually wired).
- **Wikilink validation** — `[[id]]` references inside paragraphs, quotes,
  list items, headings, table cells, and directive bodies are now tracked
  by the validator and surface `broken-reference` errors when the target
  doesn't exist. Resolves across all chapters when a book manifest is
  loaded. Wikilinks inside `` `code spans` `` are intentionally ignored.
- **`plot-mixed-delimiters` warning** — flagged when `data="…"` and
  `xlabels="…"` use different separators (commas vs. spaces) in the same
  plot. Both forms remain accepted; commas are canonical. Existing demos
  normalized to commas.
- **Spec doc** (`docs/spec.noma`) — explicit attribute-grammar note that
  attribute values are plain text (inline markup like `**bold**` or
  `[[id]]` does not render inside attrs); section on dataset linkage,
  delimiter rule, profiles, citation-staleness precedence, `::table`
  directive, and `noma fmt`.
- **Agent-protocol doc** — choose-your-op decision tree and rules of thumb
  to keep two agents from picking different ops on the same edit.
- **Direction doc** — core directives vs. community packs stance with a
  proposed namespacing convention (`pack::name`) and pack contract
  (renderer plug-in, validator plug-in, no reserved attrs, profile
  compatibility).

### Fixed

- **Pipe-table cell splitter respects backticks and `\|` escapes.** Both
  the parser and `noma fmt` now share a single `splitPipeRow` util that
  treats `|` inside `` `code spans` `` as cell content rather than a
  column separator. Fixes a latent bug where `` `key=true|false` `` rows
  were silently truncated to two cells.



## [0.2.0] — 2026-05-09

Six §23 / §8 items shipped, taking Noma from "renderable plain text" to
"block-level agent-editable document operating system".

### Added

- **AST source printer** (`src/renderer-noma.ts`) — AST → `.noma`
  serializer. Roundtrip-safe (`parse → renderNoma → parse` preserves the
  AST modulo positions). Foundation for `noma patch`. Also exposed as
  `noma render --to noma`. New roundtrip test covers every `.noma` file
  in `examples/` and `docs/`.

- **Escape hatches** (PLAN.md §23.14) — three new directives:
  `::html`, `::svg`, `::script{runtime="browser"}`. The HTML renderer
  emits raw markup by default (artifact mode); the LLM renderer
  always strips the body and replaces it with a placeholder so agent
  context stays predictable. Validator warns on every untrusted use;
  add the `trusted` flag attribute to silence per-block, or pass
  `--no-unsafe` (`allowEscapeHatches: false`) to the CLI / API to
  block all three entirely for trusted-publishing contexts. The
  blocked render emits a `noma-blocked-escape` aside with a clear
  reason.

- **Book manifests + multi-file rendering** (PLAN.md §8) — YAML
  manifest (`*.yml` / `*.yaml`) lists chapters relative to its
  directory; the loader concatenates them into a single
  `DocumentNode` so every existing renderer (HTML, LLM, JSON, PDF)
  works on books with no per-target wiring. CLI auto-detects manifest
  extension: `noma render book.noma.yml --to html`. Public API:
  `loadBook`, `isBookManifestPath`, `listChapters`. Demo book under
  `examples/book/` (3 chapters: *Why Noma exists*, *The block model*,
  *Edits agents can trust*). Built site renders it to
  `dist/examples/book.html` and `dist/examples/book.llm.txt`.

- **Real `::plot` rendering** — inline-data line and bar charts as
  self-contained SVG. Pass a numeric series via `data="10 20 15 30"`
  (space- or comma-separated), optional `xlabels="a,b,c,d"`, optional
  `width=` / `height=`. Line charts gain a soft area fill, point
  markers, faint gridlines, and min/max axis labels; bar charts get
  per-value rects. Zero JS, zero chart-library deps. CSV-path values
  (`data="./file.csv"`) keep the placeholder so existing files don't
  regress; CSV evaluation arrives later. Demos updated:
  `examples/thesis.noma` shows ASML revenue (line);
  `examples/research-thesis.noma` shows the vertical-AI funding bar
  chart and ARR-growth line, both with real numbers.

- **Theme variants** (PLAN.md §23.13) — `{variant="..."}` lands as
  `data-variant="..."` on cards, callouts, and research blocks
  (`claim`, `evidence`, `risk`, `decision`, `adr`, etc.). The bundled
  themes recognise `important`, `subtle`, `success`, `danger`, and
  `info`; custom values pass through unchanged. Replaces inline
  styling — source stays readable, theme decides how variants render.

- **Dark theme** (`themes/dark.css`) — first alternate theme. CLI flag
  `noma render --theme dark` (default: `default`). Build site renders
  `research-thesis` in both themes side by side
  (`dist/examples/research-thesis-dark.html`).

- **Validator hardening** (PLAN.md §23.12) — five new default rules:
  `claim-without-evidence` (promoted from optional), `risk-without-owner`,
  `decision-without-status` (covers `decision` and `adr`),
  `agent-task-without-scope`, and `stale-citation` (default 365 days,
  configurable via `staleCitationDays`). All emit warnings; per-block
  opt-out is the `noverify` flag attribute. Existing demos updated to
  carry owners and evidence (or `noverify` for rhetorical claims).

- **`noma patch`** — block-level edits without rewriting the file. Five
  ops shipped:
  - `replace_block{id, content}`
  - `add_block{parent, content, position?}`
  - `delete_block{id}`
  - `update_attribute{id, key, value}`
  - `rename_id{from, to}` — also rewrites `for=`, `parent=`, and
    `[[wikilink]]` references across the document.

  CLI: `noma patch <file> --op '<json>' [--inplace | --out path]` or
  `--ops <file.json>` for batches. Public API: `patch`, `patchAll`,
  `findById`, `PatchError` from `@ferax564/noma-cli`. This closes PLAN.md §23.11
  and turns the agent-protocol doc from spec into shipped code.

- **Three new demo artifacts** under `examples/`, exercising the full block
  surface end-to-end:
  - `agent-plan.noma` — Q3 roadmap decision (options, decision matrix,
    claims/evidence/risks, agent tasks, copy-as-prompt buttons).
  - `tech-doc.noma` — CLI reference page (tabs, callouts, code blocks,
    architecture diagram, cross-links).
  - `research-thesis.noma` — vertical-AI investment thesis (claims with
    confidence scores, counterevidence, datasets, plots, quarterly review
    tasks).
- **`docs/direction.noma`** — canonical statement of what Noma is, the
  three-layer model (source / artifact / agent), and the central design
  test every feature must pass. Mirrors PLAN.md §23.
- **`examples/index.noma`** — Noma-rendered gallery (kept around as
  `dist/_index-noma.html`; the live site uses the hand-crafted
  `site/index.html` instead).
- **GitHub-style Markdown tables** — new `TableNode` AST variant.
  Pipe-row + separator detection, per-column alignment via `:---` /
  `:---:` / `---:`, inline markdown preserved inside cells. HTML emits
  `<table class="noma-table">` with per-cell `text-align`; LLM keeps
  the pipe format aligned to column widths.
- **`::export_button`** directive — renders as a real `<button>` with
  format-aware coloring (`prompt` blue, `markdown` green, `json` grey).
  Powers the "Copy as prompt", "Copy summary", "Copy AST" actions in
  the agent-plan and research-thesis demos.
- **`::control`** directive — renders a labeled input. First step
  toward the interactive-artifact blocks described in PLAN.md §23.9.
- **`::open_question` / `::assumption` styling** — distinct accent colors
  in the default theme so they read as their own block class.
- **PDF exports for all three demos** via Puppeteer
  (`dist/examples/{agent-plan,tech-doc,research-thesis}.pdf`,
  A4 with print backgrounds). New script: `scripts/render-demo-pdfs.ts`.
- **Hand-crafted HTML landing page** at `site/index.html` —
  sticky nav, gradient hero with side-by-side `.noma`/artifact preview,
  three-layer model cards, demo gallery with custom SVG thumbnails,
  vs-Markdown and vs-HTML comparison tables, central design-test panel.
  This is intentionally not a `.noma` file: marketing layout is the kind
  of artifact where bespoke HTML is the right escape hatch.
- **`npm run build:site`** orchestrator — renders examples + docs,
  copies `site/` over `dist/`, generates demo PDFs.
- **`npm run render:docs`** — renders all `docs/*.noma` to HTML + LLM.
- **JSON renders for all demos** — `render:examples` now emits `.json`
  alongside `.html` and `.llm.txt`.
- **GitHub Pages deployment** via `.github/workflows/pages.yml`. Every
  push to `main` runs `npx tsc --noEmit && npm test && npm run build:site`
  and publishes `dist/` to <https://ferax564.github.io/noma/>. Chrome is
  installed in CI (`npx puppeteer browsers install chrome`) so PDFs
  build on the runner.
- **PLAN.md §23** — revised final direction (three-layer model, central
  design test, artifact-first rendering, refined comparison tables,
  updated MVP scope and four-week plan).
- **PLAN.md §24** — "Shipped" tracker that lists what crossed from plan
  to reality.
- **Parser test** for tables (alignment markers, inline markdown in cells,
  HTML and LLM round-trip).

### Changed

- **Default theme** — added styles for `<table class="noma-table">`,
  `.noma-export-button` (with format-keyed colors), `.noma-control`,
  and the `decision`/`open_question`/`assumption` research-block
  variants. Hover state added on table rows.
- **`render:examples`** script now also renders LLM and JSON for the
  three new demos, not just HTML.
- **Top-nav alignment** on the landing page — every link sits in a fixed
  inline-flex 32px box so the GitHub pill aligns with the plain text
  links instead of dropping below them.

### Fixed

- **Markdown tables previously rendered as `<p>` with `<br>`** between
  rows. Tables in `docs/spec.noma`, the new demos, and the comparison
  pages now render as real HTML tables. (Surfaced when shipping the
  refined direction docs.)

## [0.1.0] — 2026-05-09

Initial public release.

### Added

- `@ferax564/noma-parser` — hand-written, no parser-combinator dependency.
- Typed AST in `src/ast.ts` — discriminated union, exhaustively
  switched everywhere.
- HTML renderer with default CSS theme and print stylesheet.
- LLM renderer — deterministic plain-text output for context windows.
- JSON renderer — full AST export.
- Validator — duplicate IDs, broken references, plots without data,
  figures without alt text.
- CLI — `noma parse | render | check | export`.
- Three working examples: investment thesis, landing page, mini-book
  chapter.
- Four docs (written in Noma): spec, getting started, agent patch
  protocol, architecture.
- Puppeteer-based PDF script (`scripts/render-pdf.ts`).
