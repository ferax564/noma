import { walk, type Diagnostic, type DirectiveNode, type DocumentNode, type Node, type SectionNode } from "../src/ast.js";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderJson } from "../src/renderer-json.js";
import { renderLlm } from "../src/renderer-llm.js";
import { validate } from "../src/validator.js";
import defaultThemeCss from "../themes/default.css";
import agentPlanSource from "../examples/agent-plan.noma";
import techDocSource from "../examples/tech-doc.noma";
import researchThesisSource from "../examples/research-thesis.noma";
import interactiveProjectionSource from "../examples/interactive-projection.noma";
import wordReviewLoopSource from "../examples/word-review-loop.noma";

type OutputMode = "preview" | "json" | "llm";
type RibbonTab = "file" | "format" | "insert" | "layout" | "review" | "find" | "export";
type PreviewEditKind = "section" | "paragraph" | "list_item" | "quote";
type CommandName =
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullets"
  | "numbers"
  | "quote"
  | "codeblock"
  | "insertTable"
  | "insertFigure"
  | "insertCallout"
  | "insertTask"
  | "insertControl"
  | "insertMath"
  | "insertToc"
  | "insertHeader"
  | "insertFooter"
  | "insertPageSetup"
  | "insertPageBreak"
  | "insertComment"
  | "insertChange"
  | "insertFootnote";

interface RenderState {
  doc: DocumentNode | null;
  diagnostics: Diagnostic[];
  html: string;
  previewHtml: string;
  json: string;
  llm: string;
  error?: Error;
}

interface OutlineItem {
  id?: string;
  label: string;
  kind: string;
  line?: number;
  level: number;
}

const examples = [
  { id: "agent-plan", label: "Agent plan", source: agentPlanSource },
  { id: "tech-doc", label: "Tech doc", source: techDocSource },
  { id: "research-thesis", label: "Research thesis", source: researchThesisSource },
  { id: "interactive-projection", label: "Interactive projection", source: interactiveProjectionSource },
  { id: "word-review-loop", label: "Word review loop", source: wordReviewLoopSource },
] as const;

const storageKey = "noma.workbench.source.v1";
const ribbonStorageKey = "noma.workbench.ribbon.v1";
const ribbonTabs = new Set<RibbonTab>(["file", "format", "insert", "layout", "review", "find", "export"]);
const initialSource = localStorage.getItem(storageKey) ?? examples[0].source;

const sourceInput = requireElement<HTMLTextAreaElement>("sourceInput");
const previewFrame = requireElement<HTMLIFrameElement>("previewFrame");
const outputPre = requireElement<HTMLPreElement>("outputPre");
const diagnosticsList = requireElement<HTMLElement>("diagnosticsList");
const outlineList = requireElement<HTMLElement>("outlineList");
const statusText = requireElement<HTMLElement>("statusText");
const exampleSelect = requireElement<HTMLSelectElement>("exampleSelect");
const loadExampleButton = requireElement<HTMLButtonElement>("loadExample");
const newDocumentButton = requireElement<HTMLButtonElement>("newDocument");
const fileInput = requireElement<HTMLInputElement>("fileInput");
const downloadSourceButton = requireElement<HTMLButtonElement>("downloadSource");
const downloadHtmlButton = requireElement<HTMLButtonElement>("downloadHtml");
const downloadJsonButton = requireElement<HTMLButtonElement>("downloadJson");
const copyLlmButton = requireElement<HTMLButtonElement>("copyLlm");
const copyDocxCommandButton = requireElement<HTMLButtonElement>("copyDocxCommand");
const printPreviewButton = requireElement<HTMLButtonElement>("printPreview");
const previewEditToggle = requireElement<HTMLButtonElement>("previewEditToggle");
const renderButton = requireElement<HTMLButtonElement>("renderNow");
const findInput = requireElement<HTMLInputElement>("findInput");
const findPrevButton = requireElement<HTMLButtonElement>("findPrev");
const findNextButton = requireElement<HTMLButtonElement>("findNext");
const findStatus = requireElement<HTMLElement>("findStatus");
const targetButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-target]")];
const commandButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-command]")];
const ribbonTabButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-ribbon-tab]")];
const ribbonPanels = [...document.querySelectorAll<HTMLElement>("[data-ribbon-panel]")];

let outputMode: OutputMode = "preview";
let activeRibbonTab: RibbonTab = initialRibbonTab();
let previewEditMode = false;
let renderTimer: number | undefined;
let state: RenderState = emptyState();

sourceInput.value = initialSource;
populateExamples();
renderRibbonTabs();
bindEvents();
renderCurrent();

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function populateExamples(): void {
  for (const example of examples) {
    const option = document.createElement("option");
    option.value = example.id;
    option.textContent = example.label;
    exampleSelect.append(option);
  }
}

function bindEvents(): void {
  sourceInput.addEventListener("input", () => {
    localStorage.setItem(storageKey, sourceInput.value);
    scheduleRender();
  });

  renderButton.addEventListener("click", () => renderCurrent());

  newDocumentButton.addEventListener("click", () => {
    setSource(starterDocument(), "Untitled Document");
  });

  loadExampleButton.addEventListener("click", () => {
    const example = examples.find((item) => item.id === exampleSelect.value) ?? examples[0];
    setSource(example.source, example.label);
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    setSource(await file.text(), file.name);
    fileInput.value = "";
  });

  for (const button of targetButtons) {
    button.addEventListener("click", () => {
      const next = button.dataset.target;
      if (next === "preview" || next === "json" || next === "llm") {
        outputMode = next;
        renderOutput();
      }
    });
  }

  for (const button of ribbonTabButtons) {
    button.addEventListener("click", () => {
      const tab = button.dataset.ribbonTab;
      if (isRibbonTab(tab)) setRibbonTab(tab);
    });
    button.addEventListener("keydown", (event) => handleRibbonTabKeydown(event, button));
  }

  downloadSourceButton.addEventListener("click", () => {
    downloadText("document.noma", sourceInput.value, "text/plain");
  });

  downloadHtmlButton.addEventListener("click", () => {
    if (state.error) return;
    downloadText("document.html", state.html, "text/html");
  });

  downloadJsonButton.addEventListener("click", () => {
    if (state.error) return;
    downloadText("document.json", state.json, "application/json");
  });

  copyLlmButton.addEventListener("click", async () => {
    if (state.error) return;
    await copyText(state.llm, "Copied LLM context");
  });

  copyDocxCommandButton.addEventListener("click", async () => {
    await copyText("npm run noma -- render document.noma --to docx --out document.docx", "Copied DOCX command");
  });

  printPreviewButton.addEventListener("click", () => {
    printPreview();
  });

  previewEditToggle.addEventListener("click", () => {
    previewEditMode = !previewEditMode;
    if (previewEditMode && outputMode !== "preview") outputMode = "preview";
    renderOutput();
    showTransientStatus(previewEditMode ? "Rendered editing on" : "Rendered editing off");
  });

  previewFrame.addEventListener("load", () => installPreviewEditing());

  for (const button of commandButtons) {
    button.addEventListener("click", () => {
      const command = button.dataset.command;
      if (isCommandName(command)) runCommand(command);
    });
  }

  findInput.addEventListener("input", () => updateFindStatus());
  findNextButton.addEventListener("click", () => findInSource(1));
  findPrevButton.addEventListener("click", () => findInSource(-1));

  sourceInput.addEventListener("keydown", (event) => {
    if (!event.metaKey && !event.ctrlKey) return;
    const key = event.key.toLowerCase();
    if (key === "b") {
      event.preventDefault();
      runCommand("bold");
    } else if (key === "i") {
      event.preventDefault();
      runCommand("italic");
    } else if (key === "k") {
      event.preventDefault();
      runCommand("link");
    } else if (key === "s") {
      event.preventDefault();
      downloadText("document.noma", sourceInput.value, "text/plain");
    } else if (key === "p") {
      event.preventDefault();
      printPreview();
    } else if (key === "f") {
      event.preventDefault();
      setRibbonTab("find");
      window.requestAnimationFrame(() => {
        findInput.focus();
        findInput.select();
      });
    }
  });
}

function scheduleRender(): void {
  if (renderTimer !== undefined) window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderTimer = undefined;
    renderCurrent();
  }, 220);
}

function isCommandName(value: string | undefined): value is CommandName {
  return typeof value === "string" && commandNames.has(value as CommandName);
}

function initialRibbonTab(): RibbonTab {
  const storedTab = localStorage.getItem(ribbonStorageKey);
  return isRibbonTab(storedTab) ? storedTab : "file";
}

function isRibbonTab(value: string | undefined | null): value is RibbonTab {
  return typeof value === "string" && ribbonTabs.has(value as RibbonTab);
}

function setRibbonTab(tab: RibbonTab): void {
  activeRibbonTab = tab;
  localStorage.setItem(ribbonStorageKey, tab);
  renderRibbonTabs();
}

function renderRibbonTabs(): void {
  for (const button of ribbonTabButtons) {
    const selected = button.dataset.ribbonTab === activeRibbonTab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }

  for (const panel of ribbonPanels) {
    panel.hidden = panel.dataset.ribbonPanel !== activeRibbonTab;
  }
}

function handleRibbonTabKeydown(event: KeyboardEvent, button: HTMLButtonElement): void {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;

  const currentIndex = ribbonTabButtons.indexOf(button);
  if (currentIndex === -1) return;

  event.preventDefault();
  const offset = event.key === "ArrowRight" ? 1 : -1;
  const nextIndex = (currentIndex + offset + ribbonTabButtons.length) % ribbonTabButtons.length;
  const nextButton = ribbonTabButtons[nextIndex];
  const nextTab = nextButton?.dataset.ribbonTab;
  if (!nextButton || !isRibbonTab(nextTab)) return;

  setRibbonTab(nextTab);
  nextButton.focus();
}

const commandNames = new Set<CommandName>([
  "bold",
  "italic",
  "code",
  "link",
  "heading1",
  "heading2",
  "heading3",
  "bullets",
  "numbers",
  "quote",
  "codeblock",
  "insertTable",
  "insertFigure",
  "insertCallout",
  "insertTask",
  "insertControl",
  "insertMath",
  "insertToc",
  "insertHeader",
  "insertFooter",
  "insertPageSetup",
  "insertPageBreak",
  "insertComment",
  "insertChange",
  "insertFootnote",
]);

function runCommand(command: CommandName): void {
  switch (command) {
    case "bold":
      wrapSelection("**", "**", "bold text");
      break;
    case "italic":
      wrapSelection("*", "*", "emphasis");
      break;
    case "code":
      wrapSelection("`", "`", "code");
      break;
    case "link":
      insertLink();
      break;
    case "heading1":
      setHeading(1);
      break;
    case "heading2":
      setHeading(2);
      break;
    case "heading3":
      setHeading(3);
      break;
    case "bullets":
      prefixSelectedLines((line) => `- ${stripListMarker(line)}`);
      break;
    case "numbers":
      prefixSelectedLines((line, index) => `${index + 1}. ${stripListMarker(line)}`);
      break;
    case "quote":
      prefixSelectedLines((line) => `> ${line.replace(/^>\s?/, "")}`);
      break;
    case "codeblock":
      wrapBlock("```\n", "\n```", "code");
      break;
    case "insertTable":
      insertTemplate("| Column | Status |\n|---|---|\n| Item | Draft |", "Item");
      break;
    case "insertFigure":
      insertTemplate(`::figure{id="${nextId("figure")}" alt="Describe image" caption="{{cursor}}Figure caption"}\nAdd image description or source details.\n::`, "Figure caption");
      break;
    case "insertCallout":
      insertTemplate(`::callout{id="${nextId("callout")}" title="Note"}\n{{cursor}}Add note text.\n::`, "Add note text.");
      break;
    case "insertTask":
      insertTemplate(`::todo{id="${nextId("todo")}" status="open" owner="" due=""}\n{{cursor}}Task description.\n::`, "Task description.");
      break;
    case "insertControl":
      insertTemplate(`::control{id="${nextId("control")}" type="text" label="Field" default="{{cursor}}Value"}\n::`, "Value");
      break;
    case "insertMath":
      insertTemplate(`::math{id="${nextId("math")}"}\n{{cursor}}E = mc^2\n::`, "E = mc^2");
      break;
    case "insertToc":
      insertTemplate(`::toc{id="${nextId("toc")}" depth=3}\n::`);
      break;
    case "insertHeader":
      insertTemplate(`::header{id="${nextId("header")}"}\n{{cursor}}Document header\n::`, "Document header");
      break;
    case "insertFooter":
      insertTemplate(`::footer{id="${nextId("footer")}" page_numbers total_pages}\n{{cursor}}Document footer\n::`, "Document footer");
      break;
    case "insertPageSetup":
      insertTemplate('::page_setup{size="A4" margin="18mm"}\n::');
      break;
    case "insertPageBreak":
      insertTemplate(`::pagebreak{id="${nextId("pagebreak")}"}\n::`);
      break;
    case "insertComment":
      insertTemplate(`::comment{id="${nextId("comment")}" parent="" author=""}\n{{cursor}}Review note.\n::`, "Review note.");
      break;
    case "insertChange":
      insertTemplate(`::change_request{id="${nextId("change")}" action="replace" from="{{cursor}}old text" to="new text"}\n::`, "old text");
      break;
    case "insertFootnote":
      insertTemplate(`::footnote{id="${nextId("footnote")}"}\n{{cursor}}Footnote text.\n::`, "Footnote text.");
      break;
  }
}

function setSource(source: string, label?: string): void {
  sourceInput.value = source;
  localStorage.setItem(storageKey, sourceInput.value);
  sourceInput.focus();
  sourceInput.setSelectionRange(0, 0);
  renderCurrent();
  if (label) showTransientStatus(`Loaded ${label}`);
}

function starterDocument(): string {
  return `---\ntitle: Untitled Noma Document\nprofile: technical\n---\n\n# Untitled Document\n\nStart writing here.\n`;
}

function wrapSelection(prefix: string, suffix: string, placeholder: string): void {
  const selection = sourceSelection();
  const body = selection.text || placeholder;
  const inserted = `${prefix}${body}${suffix}`;
  replaceRange(selection.start, selection.end, inserted, selection.start + prefix.length, selection.start + prefix.length + body.length);
}

function wrapBlock(prefix: string, suffix: string, placeholder: string): void {
  const selection = sourceSelection();
  const body = selection.text || placeholder;
  const inserted = `${prefix}${body}${suffix}`;
  replaceRange(selection.start, selection.end, inserted, selection.start + prefix.length, selection.start + prefix.length + body.length);
}

function insertLink(): void {
  const selection = sourceSelection();
  const label = selection.text || "link text";
  const inserted = `[${label}](https://example.com)`;
  replaceRange(selection.start, selection.end, inserted, selection.start + 1, selection.start + 1 + label.length);
}

function setHeading(level: 1 | 2 | 3): void {
  const source = sourceInput.value;
  const bounds = currentLineBounds();
  const line = source.slice(bounds.start, bounds.end);
  const clean = line.replace(/^#{1,6}\s+/, "").trim() || "Heading";
  const next = `${"#".repeat(level)} ${clean}`;
  replaceRange(bounds.start, bounds.end, next, bounds.start + level + 1, bounds.start + next.length);
}

function prefixSelectedLines(transform: (line: string, index: number) => string): void {
  const source = sourceInput.value;
  const selection = sourceSelection();
  const start = source.lastIndexOf("\n", Math.max(0, selection.start - 1)) + 1;
  const nextBreak = source.indexOf("\n", selection.end);
  const end = nextBreak === -1 ? source.length : nextBreak;
  const lines = source.slice(start, end).split("\n");
  const transformed = lines.map((line, index) => transform(line, index)).join("\n");
  replaceRange(start, end, transformed, start, start + transformed.length);
}

function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "");
}

function insertTemplate(rawTemplate: string, selectionHint?: string): void {
  const selection = sourceSelection();
  const marker = "{{cursor}}";
  const markerIndex = rawTemplate.indexOf(marker);
  const template = rawTemplate.replace(marker, "");
  const before = sourceInput.value.slice(0, selection.start);
  const after = sourceInput.value.slice(selection.end);
  const prefix = before.length > 0 && !before.endsWith("\n\n") ? "\n\n" : "";
  const suffix = after.length > 0 && !after.startsWith("\n\n") ? "\n\n" : "";
  const inserted = `${prefix}${template}${suffix}`;
  const cursorStart = selection.start + prefix.length + (markerIndex >= 0 ? markerIndex : template.length);
  const cursorEnd = selectionHint
    ? cursorStart + selectionHint.length
    : cursorStart;
  replaceRange(selection.start, selection.end, inserted, cursorStart, cursorEnd);
}

function nextId(prefix: string): string {
  const source = sourceInput.value;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${prefix}-${i}`;
    if (!source.includes(`id="${candidate}"`) && !source.includes(`id=${candidate}`)) return candidate;
  }
  return `${prefix}-${Date.now()}`;
}

function sourceSelection(): { start: number; end: number; text: string } {
  const start = sourceInput.selectionStart;
  const end = sourceInput.selectionEnd;
  return { start, end, text: sourceInput.value.slice(start, end) };
}

function currentLineBounds(): { start: number; end: number } {
  const source = sourceInput.value;
  const cursor = sourceInput.selectionStart;
  const start = source.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const nextBreak = source.indexOf("\n", cursor);
  return { start, end: nextBreak === -1 ? source.length : nextBreak };
}

function replaceRange(start: number, end: number, inserted: string, selectStart: number, selectEnd: number): void {
  const source = sourceInput.value;
  sourceInput.value = `${source.slice(0, start)}${inserted}${source.slice(end)}`;
  localStorage.setItem(storageKey, sourceInput.value);
  sourceInput.focus();
  sourceInput.setSelectionRange(selectStart, selectEnd);
  renderCurrent();
}

function renderCurrent(): void {
  const source = sourceInput.value;
  try {
    const doc = parse(source, { filename: "workbench.noma" });
    const diagnostics = validate(doc);
    const themeCss = `${defaultThemeCss}\nbody { background: #ffffff; }`;
    const htmlOptions = {
      standalone: true,
      themeCss,
      allowEscapeHatches: false,
      externalAssets: false,
      interactive: false,
    } as const;
    state = {
      doc,
      diagnostics,
      html: renderHtml(doc, htmlOptions),
      previewHtml: renderHtml(doc, { ...htmlOptions, sourcePositions: true }),
      json: renderJson(doc),
      llm: renderLlm(doc),
    };
  } catch (error) {
    state = {
      ...emptyState(),
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  renderStatus();
  renderDiagnostics();
  renderOutline();
  renderOutput();
  updateFindStatus();
}

function renderStatus(): void {
  if (state.error) {
    statusText.textContent = state.error.message;
    statusText.dataset.state = "error";
    return;
  }

  const errors = state.diagnostics.filter((item) => item.severity === "error").length;
  const warnings = state.diagnostics.filter((item) => item.severity === "warning").length;
  const ids = state.doc ? countIds(state.doc) : 0;
  statusText.textContent = `${errors} errors / ${warnings} warnings / ${ids} IDs`;
  statusText.dataset.state = errors > 0 ? "error" : warnings > 0 ? "warning" : "ok";
}

function renderDiagnostics(): void {
  diagnosticsList.replaceChildren();

  if (state.error) {
    diagnosticsList.append(diagnosticRow("error", "render", state.error.message));
    return;
  }

  if (state.diagnostics.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No diagnostics";
    diagnosticsList.append(empty);
    return;
  }

  for (const item of state.diagnostics) {
    const row = diagnosticRow(item.severity, item.code, item.message, item.pos?.line);
    diagnosticsList.append(row);
  }
}

function diagnosticRow(severity: string, code: string, message: string, line?: number): HTMLElement {
  const row = document.createElement(line ? "button" : "div");
  row.className = `diagnostic diagnostic-${severity}`;
  if (line && row instanceof HTMLButtonElement) {
    row.type = "button";
    row.addEventListener("click", () => jumpToLine(line));
  }

  const meta = document.createElement("span");
  meta.className = "diagnostic-meta";
  meta.textContent = line ? `${severity} / ${code} / line ${line}` : `${severity} / ${code}`;

  const body = document.createElement("span");
  body.className = "diagnostic-body";
  body.textContent = message;

  row.append(meta, body);
  return row;
}

function renderOutline(): void {
  outlineList.replaceChildren();

  if (!state.doc) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No outline";
    outlineList.append(empty);
    return;
  }

  const items = collectOutline(state.doc);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No headings or IDs";
    outlineList.append(empty);
    return;
  }

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "outline-item";
    button.style.setProperty("--depth", String(Math.max(0, item.level - 1)));
    if (item.line) button.addEventListener("click", () => jumpToLine(item.line!));

    const label = document.createElement("span");
    label.className = "outline-label";
    label.textContent = item.label;

    const meta = document.createElement("span");
    meta.className = "outline-meta";
    meta.textContent = item.id ? `${item.kind} / ${item.id}` : item.kind;

    button.append(label, meta);
    outlineList.append(button);
  }
}

function renderOutput(): void {
  for (const button of targetButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.target === outputMode));
  }
  previewEditToggle.setAttribute("aria-pressed", String(previewEditMode));

  previewFrame.hidden = outputMode !== "preview";
  previewFrame.dataset.editing = String(previewEditMode && outputMode === "preview" && !state.error);
  outputPre.hidden = outputMode === "preview";

  if (outputMode === "preview") {
    previewFrame.srcdoc = state.error
      ? errorDocument(state.error.message)
      : state.previewHtml;
    return;
  }

  outputPre.textContent = outputMode === "json" ? state.json : state.llm;
}

function installPreviewEditing(): void {
  if (!previewEditMode || outputMode !== "preview" || state.error) return;

  const previewDoc = previewFrame.contentDocument;
  if (!previewDoc) return;

  const style = previewDoc.createElement("style");
  style.textContent = previewEditCss();
  previewDoc.head.append(style);

  const editableNodes = [...previewDoc.querySelectorAll<HTMLElement>("[data-noma-editable]")];
  for (const element of editableNodes) {
    const kind = element.dataset.nomaEditable;
    if (!isPreviewEditKind(kind)) continue;

    element.contentEditable = "true";
    element.spellcheck = true;
    element.dataset.nomaOriginalText = editableText(element);
    element.title = "Edit rendered text; blur to sync source";
    element.addEventListener("focus", () => {
      element.dataset.nomaEditing = "true";
    });
    element.addEventListener("blur", () => {
      delete element.dataset.nomaEditing;
      commitPreviewEdit(element);
    });
    element.addEventListener("keydown", (event) => handlePreviewEditKeydown(event, element));
    element.addEventListener("paste", (event) => pastePlainText(event, element));
  }
}

function previewEditCss(): string {
  return `
[data-noma-editable][contenteditable="true"] {
  cursor: text;
  outline: 1px dashed rgba(39, 93, 103, 0.38);
  outline-offset: 4px;
  border-radius: 2px;
}
[data-noma-editable][contenteditable="true"]:hover {
  outline-color: rgba(39, 93, 103, 0.62);
}
[data-noma-editable][data-noma-editing="true"] {
  background: rgba(232, 246, 239, 0.72);
  outline: 2px solid #275d67;
}
`;
}

function handlePreviewEditKeydown(event: KeyboardEvent, element: HTMLElement): void {
  const kind = element.dataset.nomaEditable;
  const key = event.key.toLowerCase();

  if (key === "escape") {
    event.preventDefault();
    element.textContent = element.dataset.nomaOriginalText ?? "";
    element.blur();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && key === "s") {
    event.preventDefault();
    element.blur();
    downloadText("document.noma", sourceInput.value, "text/plain");
    return;
  }

  if (key === "enter" && !event.shiftKey && (kind === "section" || kind === "list_item")) {
    event.preventDefault();
    element.blur();
  }
}

function pastePlainText(event: ClipboardEvent, element: HTMLElement): void {
  const text = event.clipboardData?.getData("text/plain");
  if (text === undefined) return;
  event.preventDefault();
  element.ownerDocument.execCommand("insertText", false, text);
}

function commitPreviewEdit(element: HTMLElement): void {
  const originalText = element.dataset.nomaOriginalText ?? "";
  const nextText = editableText(element);
  if (nextText === originalText) return;

  const kind = element.dataset.nomaEditable;
  const line = positiveInt(element.dataset.nomaLine);
  const endLine = positiveInt(element.dataset.nomaEndLine) ?? line;
  if (!isPreviewEditKind(kind) || line === undefined) {
    showTransientStatus("Rendered edit cannot sync", "warning");
    return;
  }

  const replacement = previewSourceReplacement(kind, line, endLine, nextText);
  if (replacement === null) {
    showTransientStatus("Rendered edit cannot sync", "warning");
    return;
  }

  replaceSourceLines(line, endLine, replacement);
  showTransientStatus("Synced rendered edit");
}

function editableText(element: HTMLElement): string {
  return (element.innerText || element.textContent || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/g, "");
}

function previewSourceReplacement(
  kind: PreviewEditKind,
  line: number,
  endLine: number,
  text: string,
): string | null {
  const lines = sourceInput.value.split("\n");
  const currentLine = lines[line - 1];
  if (currentLine === undefined) return null;

  switch (kind) {
    case "section": {
      const match = /^(#{1,6}\s+)(.*?)(\s+\{[^}]+\})?\s*$/.exec(currentLine);
      if (!match) return null;
      const prefix = match[1] ?? "";
      const attrs = match[3] ?? "";
      return `${prefix}${normalizeInlineText(text) || "Untitled"}${attrs}`;
    }
    case "paragraph":
      return normalizeBlockText(text);
    case "list_item": {
      const match = /^(\s*(?:[-*]|\d+\.)\s+)(.*)$/.exec(currentLine);
      if (!match) return null;
      const prefix = match[1] ?? "";
      return `${prefix}${normalizeInlineText(text)}`;
    }
    case "quote": {
      const body = normalizeBlockText(text);
      const quoteLines = body ? body.split("\n") : [""];
      return quoteLines.map((quoteLine) => `> ${quoteLine}`).join("\n");
    }
  }
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeBlockText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function replaceSourceLines(startLine: number, endLine: number, replacement: string): void {
  if (renderTimer !== undefined) {
    window.clearTimeout(renderTimer);
    renderTimer = undefined;
  }

  const lines = sourceInput.value.split("\n");
  const startIndex = startLine - 1;
  const endIndex = Math.max(startIndex, Math.min(lines.length - 1, endLine - 1));
  lines.splice(startIndex, endIndex - startIndex + 1, ...replacement.split("\n"));
  sourceInput.value = lines.join("\n");
  localStorage.setItem(storageKey, sourceInput.value);
  renderCurrent();
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isPreviewEditKind(value: string | undefined): value is PreviewEditKind {
  return value === "section" || value === "paragraph" || value === "list_item" || value === "quote";
}

function collectOutline(doc: DocumentNode): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const node of walk(doc)) {
    if (node.type === "document" || node.type === "frontmatter") continue;
    if (node.type === "section") {
      out.push(sectionOutline(node));
      continue;
    }
    if (node.type === "directive" && node.id) out.push(directiveOutline(node));
  }
  return out;
}

function sectionOutline(node: SectionNode): OutlineItem {
  return {
    id: node.id,
    label: node.title,
    kind: `h${node.level}`,
    line: node.pos?.line,
    level: node.level,
  };
}

function directiveOutline(node: DirectiveNode): OutlineItem {
  return {
    id: node.id,
    label: directiveLabel(node),
    kind: `::${node.name}`,
    line: node.pos?.line,
    level: 2,
  };
}

function directiveLabel(node: DirectiveNode): string {
  const title = textAttr(node, "title") ?? textAttr(node, "label") ?? textAttr(node, "name");
  return title || node.id || node.name;
}

function textAttr(node: DirectiveNode, key: string): string | undefined {
  const value = node.attrs[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function countIds(doc: DocumentNode): number {
  let count = 0;
  for (const node of walk(doc) as Iterable<Node>) {
    if (node.id) count++;
  }
  return count;
}

function jumpToLine(line: number): void {
  const lines = sourceInput.value.split("\n");
  const clamped = Math.max(1, Math.min(line, lines.length));
  let start = 0;
  for (let i = 0; i < clamped - 1; i++) start += lines[i].length + 1;
  const end = start + lines[clamped - 1].length;
  sourceInput.focus();
  sourceInput.setSelectionRange(start, end);
}

function findInSource(direction: 1 | -1): void {
  const matches = findMatches();
  if (matches.length === 0) {
    updateFindStatus();
    return;
  }
  const cursor = direction === 1 ? sourceInput.selectionEnd : sourceInput.selectionStart;
  const index = direction === 1
    ? nextMatchIndex(matches, cursor)
    : previousMatchIndex(matches, cursor);
  const match = matches[index]!;
  sourceInput.focus();
  sourceInput.setSelectionRange(match.start, match.end);
  findStatus.textContent = `${index + 1}/${matches.length}`;
}

function updateFindStatus(): void {
  const matches = findMatches();
  if (matches.length === 0) {
    findStatus.textContent = "0/0";
    return;
  }
  const active = matches.findIndex((match) => match.start === sourceInput.selectionStart && match.end === sourceInput.selectionEnd);
  findStatus.textContent = active >= 0 ? `${active + 1}/${matches.length}` : `0/${matches.length}`;
}

function findMatches(): Array<{ start: number; end: number }> {
  const query = findInput.value;
  if (!query) return [];
  const source = sourceInput.value.toLowerCase();
  const needle = query.toLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let index = source.indexOf(needle);
  while (index !== -1) {
    matches.push({ start: index, end: index + needle.length });
    index = source.indexOf(needle, index + Math.max(1, needle.length));
  }
  return matches;
}

function nextMatchIndex(matches: Array<{ start: number; end: number }>, cursor: number): number {
  const next = matches.findIndex((match) => match.start >= cursor);
  return next === -1 ? 0 : next;
}

function previousMatchIndex(matches: Array<{ start: number; end: number }>, cursor: number): number {
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i]!.end <= cursor) return i;
  }
  return matches.length - 1;
}

function printPreview(): void {
  if (outputMode !== "preview") {
    outputMode = "preview";
    renderOutput();
  }
  try {
    const win = previewFrame.contentWindow;
    if (!win) {
      showTransientStatus("Preview unavailable", "warning");
      return;
    }
    win.focus();
    win.print();
    showTransientStatus("Print dialog requested");
  } catch {
    showTransientStatus("Preview print blocked by browser", "warning");
  }
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text: string, message: string): Promise<void> {
  if (!navigator.clipboard) {
    statusText.textContent = "Clipboard API unavailable";
    statusText.dataset.state = "warning";
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showTransientStatus(message);
  } catch {
    showTransientStatus("Clipboard write blocked by browser", "warning");
  }
}

function showTransientStatus(message: string, stateName: "ok" | "warning" | "error" = "ok"): void {
  const previous = statusText.textContent ?? "";
  const previousState = statusText.dataset.state;
  statusText.textContent = message;
  statusText.dataset.state = stateName;
  window.setTimeout(() => {
    statusText.textContent = previous;
    if (previousState) statusText.dataset.state = previousState;
  }, 1300);
}

function emptyState(): RenderState {
  return {
    doc: null,
    diagnostics: [],
    html: "",
    previewHtml: "",
    json: "",
    llm: "",
  };
}

function errorDocument(message: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<style>
body { margin: 0; font: 15px system-ui, sans-serif; color: #2f1b18; background: #fff8f6; }
main { padding: 24px; }
pre { white-space: pre-wrap; }
</style>
<main><h1>Render error</h1><pre>${escapeHtml(message)}</pre></main>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
