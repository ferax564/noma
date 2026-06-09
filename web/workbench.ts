import { walk, type Diagnostic, type DirectiveNode, type DocumentNode, type Node, type SectionNode } from "../src/ast.js";
import { splitDelimitedRow, splitPipeRow } from "../src/inline.js";
import { parse } from "../src/parser.js";
import { patchSource, type PatchOp } from "../src/patch.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderJson } from "../src/renderer-json.js";
import { renderLlm } from "../src/renderer-llm.js";
import { renderMarkdown } from "../src/renderer-markdown.js";
import { validate } from "../src/validator.js";
import defaultThemeCss from "../themes/default.css";
import yaml from "js-yaml";
import agentPlanSource from "../examples/agent-plan.noma";
import techDocSource from "../examples/tech-doc.noma";
import researchThesisSource from "../examples/research-thesis.noma";
import interactiveProjectionSource from "../examples/interactive-projection.noma";
import wordReviewLoopSource from "../examples/word-review-loop.noma";

type OutputMode = "preview" | "json" | "llm" | "proof";
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
  markdown: string;
  error?: Error;
}

interface OutlineItem {
  id?: string;
  label: string;
  kind: string;
  line?: number;
  level: number;
}

type EditableDataKind = "table" | "dataset";
type WorkbenchProofStatus = "pass" | "warn" | "fail";

interface EditableDataBlock {
  id: string;
  kind: EditableDataKind;
  label: string;
  format?: string;
  hasHeader: boolean;
  columns: string[];
  rows: string[][];
  line?: number;
}

interface EditedDataGrid {
  columns: string[];
  rows: string[][];
}

interface WorkbenchProof {
  status: WorkbenchProofStatus;
  canWrite: boolean;
  patchResult: "applied" | "noop" | "rejected";
  ops: PatchOp[];
  preHash: string;
  postHash: string;
  preDiagnostics: Diagnostic[];
  postDiagnostics: Diagnostic[];
  beforeBytes: number;
  afterBytes: number;
  beforeLines: number;
  afterLines: number;
  unchangedLines: number;
  preservedPercent: number;
  postSource: string;
  html: string;
  error?: string;
}

interface SharedProofPayload {
  status: WorkbenchProofStatus;
  canWrite: boolean;
  ops: PatchOp[];
  preHash: string;
  postHash: string;
  diagnostics: string;
  preservedPercent: number;
}

interface SharedDraftPayload {
  source: string;
  title?: string;
  hash?: string;
  createdAt?: string;
}

interface CloudDocumentResponse {
  id: string;
  title: string;
  source: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
  diagnostics: Diagnostic[];
  access?: { role?: CloudRole; via?: string };
}

type CloudRole = "viewer" | "editor" | "owner";

interface CloudUserSession {
  id: string;
  name: string;
  token: string;
  tokenPreview?: string;
}

interface CloudUserResponse extends CloudUserSession {
  createdAt: string;
  updatedAt: string;
}

interface CloudShareResponse {
  id: string;
  role: Exclude<CloudRole, "owner">;
  token: string;
  url: string;
  artifactUrl: string;
}

interface CloudSiteResponse {
  id: string;
  title: string;
  slug: string;
  documentIds: string[];
  updatedAt: string;
  access?: { role?: CloudRole; via?: string };
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
const cloudUserStorageKey = "noma.cloud.user.v1";
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const ribbonTabs = new Set<RibbonTab>(["file", "format", "insert", "layout", "review", "find", "export"]);
const sharedDraft = readSharedDraftHash();
const initialCloudDocumentId = readCloudDocumentId();
const initialCloudShareToken = readCloudShareToken();
const initialSource = sharedDraft?.source ?? localStorage.getItem(storageKey) ?? examples[0].source;

const sourceInput = requireElement<HTMLTextAreaElement>("sourceInput");
const previewFrame = requireElement<HTMLIFrameElement>("previewFrame");
const outputPre = requireElement<HTMLPreElement>("outputPre");
const diagnosticsList = requireElement<HTMLElement>("diagnosticsList");
const diagnosticsSummary = requireElement<HTMLElement>("diagnosticsSummary");
const outlineList = requireElement<HTMLElement>("outlineList");
const statusText = requireElement<HTMLElement>("statusText");
const exampleSelect = requireElement<HTMLSelectElement>("exampleSelect");
const loadExampleButton = requireElement<HTMLButtonElement>("loadExample");
const newDocumentButton = requireElement<HTMLButtonElement>("newDocument");
const fileInput = requireElement<HTMLInputElement>("fileInput");
const markdownFileInput = requireElement<HTMLInputElement>("markdownFileInput");
const pasteMarkdownButton = requireElement<HTMLButtonElement>("pasteMarkdown");
const downloadSourceButton = requireElement<HTMLButtonElement>("downloadSource");
const downloadHtmlButton = requireElement<HTMLButtonElement>("downloadHtml");
const downloadJsonButton = requireElement<HTMLButtonElement>("downloadJson");
const copyMarkdownButton = requireElement<HTMLButtonElement>("copyMarkdown");
const copyLlmButton = requireElement<HTMLButtonElement>("copyLlm");
const copyDocxCommandButton = requireElement<HTMLButtonElement>("copyDocxCommand");
const copyDraftLinkButton = requireElement<HTMLButtonElement>("copyDraftLink");
const copyReviewPacketButton = requireElement<HTMLButtonElement>("copyReviewPacket");
const copyDraftLinkPanelButton = requireElement<HTMLButtonElement>("copyDraftLinkPanel");
const copyReviewPacketPanelButton = requireElement<HTMLButtonElement>("copyReviewPacketPanel");
const collabStatus = requireElement<HTMLElement>("collabStatus");
const cloudStatus = requireElement<HTMLElement>("cloudStatus");
const cloudUserNameInput = requireElement<HTMLInputElement>("cloudUserName");
const createCloudUserButton = requireElement<HTMLButtonElement>("createCloudUser");
const copyUserTokenButton = requireElement<HTMLButtonElement>("copyUserToken");
const cloudShareRoleSelect = requireElement<HTMLSelectElement>("cloudShareRole");
const saveCloudDocumentButton = requireElement<HTMLButtonElement>("saveCloudDocument");
const copyCloudLinkButton = requireElement<HTMLButtonElement>("copyCloudLink");
const openCloudArtifactButton = requireElement<HTMLButtonElement>("openCloudArtifact");
const saveCloudSiteButton = requireElement<HTMLButtonElement>("saveCloudSite");
const copyCloudSiteLinkButton = requireElement<HTMLButtonElement>("copyCloudSiteLink");
const openCloudSiteButton = requireElement<HTMLButtonElement>("openCloudSite");
const printPreviewButton = requireElement<HTMLButtonElement>("printPreview");
const previewEditToggle = requireElement<HTMLButtonElement>("previewEditToggle");
const renderButton = requireElement<HTMLButtonElement>("renderNow");
const proofOpsInput = requireElement<HTMLTextAreaElement>("proofOpsInput");
const generateProofButton = requireElement<HTMLButtonElement>("generateProof");
const applyProofButton = requireElement<HTMLButtonElement>("applyProof");
const copyProofLinkButton = requireElement<HTMLButtonElement>("copyProofLink");
const proofStatus = requireElement<HTMLElement>("proofStatus");
const dataBlockSelect = requireElement<HTMLSelectElement>("dataBlockSelect");
const dataEditor = requireElement<HTMLElement>("dataEditor");
const addDataRowButton = requireElement<HTMLButtonElement>("addDataRow");
const addDataColumnButton = requireElement<HTMLButtonElement>("addDataColumn");
const applyDataChangesButton = requireElement<HTMLButtonElement>("applyDataChanges");
const dataEditorStatus = requireElement<HTMLElement>("dataEditorStatus");
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
let lastProof: WorkbenchProof | null = null;
let lastProofApplied = false;
let activeDataBlockId: string | undefined;
let sharedProof = readSharedProofHash();
let cloudAvailable = false;
let cloudLoading = false;
let cloudUser = readCloudUser();
let cloudShareToken = initialCloudShareToken;
let cloudDocumentId = initialCloudDocumentId;
let cloudDocumentHash: string | undefined;
let cloudDocumentRole: CloudRole | undefined;
let cloudSiteId: string | undefined;
let cloudSiteShareToken: string | undefined;

sourceInput.value = initialSource;
cloudUserNameInput.value = cloudUser?.name ?? "Noma collaborator";
if (sharedDraft) localStorage.setItem(storageKey, sharedDraft.source);
populateExamples();
renderRibbonTabs();
bindEvents();
if (sharedProof) {
  outputMode = "proof";
  activeRibbonTab = "review";
  renderRibbonTabs();
}
renderCurrent();
void initializeCloud();
if (sharedDraft) showTransientStatus("Loaded shared draft");

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
    lastProof = null;
    lastProofApplied = false;
    updateProofControls();
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
    await loadSourceFile(file);
    fileInput.value = "";
  });

  markdownFileInput.addEventListener("change", async () => {
    const file = markdownFileInput.files?.[0];
    if (!file) return;
    await loadMarkdownFile(file);
    markdownFileInput.value = "";
  });

  pasteMarkdownButton.addEventListener("click", () => {
    void pasteMarkdownFromClipboard();
  });

  for (const button of targetButtons) {
    button.addEventListener("click", () => {
      const next = button.dataset.target;
      if (next === "preview" || next === "json" || next === "llm" || next === "proof") {
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

  copyMarkdownButton.addEventListener("click", async () => {
    if (state.error) return;
    await copyText(state.markdown, "Copied Markdown");
  });

  copyLlmButton.addEventListener("click", async () => {
    if (state.error) return;
    await copyText(state.llm, "Copied LLM context");
  });

  copyDocxCommandButton.addEventListener("click", async () => {
    await copyText("npm run noma -- render document.noma --to docx --out document.docx", "Copied DOCX command");
  });

  copyDraftLinkButton.addEventListener("click", () => {
    void copyDraftLink();
  });

  copyReviewPacketButton.addEventListener("click", () => {
    void copyReviewPacket();
  });

  copyDraftLinkPanelButton.addEventListener("click", () => {
    void copyDraftLink();
  });

  copyReviewPacketPanelButton.addEventListener("click", () => {
    void copyReviewPacket();
  });

  createCloudUserButton.addEventListener("click", () => {
    void createCloudUser();
  });

  copyUserTokenButton.addEventListener("click", () => {
    void copyCloudUserToken();
  });

  saveCloudDocumentButton.addEventListener("click", () => {
    void saveCloudDocument();
  });

  copyCloudLinkButton.addEventListener("click", () => {
    void copyCloudLink();
  });

  openCloudArtifactButton.addEventListener("click", () => {
    void openCloudArtifact();
  });

  saveCloudSiteButton.addEventListener("click", () => {
    void saveCloudSite();
  });

  copyCloudSiteLinkButton.addEventListener("click", () => {
    void copyCloudSiteLink();
  });

  openCloudSiteButton.addEventListener("click", () => {
    void openCloudSite();
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

  generateProofButton.addEventListener("click", () => {
    void generateProofFromInput();
  });

  applyProofButton.addEventListener("click", () => applyLastProof());

  copyProofLinkButton.addEventListener("click", () => {
    void copyProofLink();
  });

  dataBlockSelect.addEventListener("change", () => {
    activeDataBlockId = dataBlockSelect.value || undefined;
    renderDataEditorForActiveBlock();
  });

  addDataRowButton.addEventListener("click", () => addDataGridRow());
  addDataColumnButton.addEventListener("click", () => addDataGridColumn());
  applyDataChangesButton.addEventListener("click", () => {
    void applyDataGridChanges();
  });

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

async function loadSourceFile(file: File): Promise<void> {
  const source = await file.text();
  if (isMarkdownFile(file)) {
    setSource(markdownSourceFromText(source), `Markdown ${file.name}`);
    return;
  }
  setSource(source, file.name);
}

async function loadMarkdownFile(file: File): Promise<void> {
  const source = await file.text();
  setSource(markdownSourceFromText(source), `Markdown ${file.name}`);
}

async function pasteMarkdownFromClipboard(): Promise<void> {
  if (!navigator.clipboard?.readText) {
    showTransientStatus("Clipboard read unavailable", "warning");
    sourceInput.focus();
    return;
  }

  try {
    const source = await navigator.clipboard.readText();
    if (!source.trim()) {
      showTransientStatus("Clipboard is empty", "warning");
      sourceInput.focus();
      return;
    }
    setSource(markdownSourceFromText(source), "Markdown paste");
  } catch {
    showTransientStatus("Clipboard read blocked by browser", "warning");
    sourceInput.focus();
  }
}

function isMarkdownFile(file: File): boolean {
  return /\.(?:md|markdown|mdown|mkdn)$/i.test(file.name) || /^text\/(?:markdown|x-markdown)$/i.test(file.type);
}

function markdownSourceFromText(source: string): string {
  return source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function setSource(
  source: string,
  label?: string,
  options: { cloudDocumentId?: string; cloudDocumentHash?: string } = {},
): void {
  if (options.cloudDocumentId) {
    cloudDocumentId = options.cloudDocumentId;
    cloudDocumentHash = options.cloudDocumentHash;
    updateCloudDocumentUrl(cloudDocumentId, cloudShareToken);
  } else {
    clearCloudDocumentBinding();
    clearCloudSiteBinding();
  }
  sourceInput.value = source;
  localStorage.setItem(storageKey, sourceInput.value);
  lastProof = null;
  lastProofApplied = false;
  sharedProof = null;
  updateProofControls();
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
  lastProof = null;
  lastProofApplied = false;
  updateProofControls();
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
      markdown: renderMarkdown(doc),
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
  renderDataInspector();
  renderCollaboration();
  updateProofControls();
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
  diagnosticsSummary.dataset.state = "ok";

  if (state.error) {
    diagnosticsSummary.textContent = "Render failed";
    diagnosticsSummary.dataset.state = "error";
    diagnosticsList.append(diagnosticRow("error", "render", state.error.message));
    return;
  }

  const errors = state.diagnostics.filter((item) => item.severity === "error").length;
  const warnings = state.diagnostics.filter((item) => item.severity === "warning").length;
  const infos = state.diagnostics.filter((item) => item.severity === "info").length;
  diagnosticsSummary.textContent = `${errors} errors / ${warnings} warnings / ${infos} info`;
  diagnosticsSummary.dataset.state = errors > 0 ? "error" : warnings > 0 ? "warning" : "ok";

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

function renderCollaboration(): void {
  const source = sourceInput.value;
  const bytes = utf8Bytes(source);
  const lines = sourceLineCount(source);
  const ids = state.doc ? countIds(state.doc) : 0;
  const errors = state.diagnostics.filter((item) => item.severity === "error").length;
  const warnings = state.diagnostics.filter((item) => item.severity === "warning").length;
  collabStatus.dataset.state = errors > 0 ? "error" : warnings > 0 ? "warning" : "ok";
  collabStatus.textContent = `${lines} lines / ${formatBytes(bytes)} / ${ids} IDs / ${errors} errors / ${warnings} warnings`;
  renderCloudStatus();
  void sha256Hex(source).then((hash) => {
    if (sourceInput.value !== source) return;
    collabStatus.textContent = `${shortHash(hash)} / ${lines} lines / ${formatBytes(bytes)} / ${ids} IDs / ${errors} errors / ${warnings} warnings`;
    renderCloudStatus(hash);
  });
}

async function initializeCloud(): Promise<void> {
  if (window.location.protocol === "file:") {
    cloudAvailable = false;
    renderCloudStatus();
    return;
  }

  cloudLoading = true;
  renderCloudStatus();
  try {
    await fetchCloudJson<{ ok: boolean }>("/api/status");
    cloudAvailable = true;
    if (!cloudUser && !cloudShareToken) await createCloudUser({ silent: true });
    if (cloudDocumentId) {
      await loadCloudDocument(cloudDocumentId);
    } else {
      renderCloudStatus();
    }
  } catch {
    cloudAvailable = false;
    cloudDocumentHash = undefined;
    renderCloudStatus();
  } finally {
    cloudLoading = false;
    renderCloudStatus();
  }
}

async function loadCloudDocument(id: string): Promise<void> {
  cloudLoading = true;
  renderCloudStatus();
  try {
    const record = await fetchCloudJson<CloudDocumentResponse>(`/api/documents/${encodeURIComponent(id)}`);
    cloudDocumentRole = record.access?.role;
    setSource(record.source, record.title, {
      cloudDocumentId: record.id,
      cloudDocumentHash: record.hash,
    });
    showTransientStatus(`Loaded cloud document ${shortHash(record.hash)}`);
  } catch (error) {
    cloudDocumentHash = undefined;
    cloudStatus.dataset.state = "error";
    cloudStatus.textContent = error instanceof Error ? error.message : "Could not load cloud document";
  } finally {
    cloudLoading = false;
    renderCloudStatus();
  }
}

async function saveCloudDocument(): Promise<void> {
  if (!cloudAvailable || state.error) return;
  cloudLoading = true;
  renderCloudStatus();
  try {
    if (!cloudUser && !cloudShareToken) await createCloudUser({ silent: true });
    const source = sourceInput.value;
    const body = JSON.stringify({
      title: sourceTitle(source),
      source,
    });
    const record = await fetchCloudJson<CloudDocumentResponse>(
      cloudDocumentId ? `/api/documents/${encodeURIComponent(cloudDocumentId)}` : "/api/documents",
      {
        method: cloudDocumentId ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body,
      },
    );
    cloudDocumentId = record.id;
    cloudDocumentHash = record.hash;
    cloudDocumentRole = record.access?.role;
    updateCloudDocumentUrl(record.id, cloudShareToken);
    renderCloudStatus(record.hash);
    showTransientStatus(`Saved cloud document ${shortHash(record.hash)}`);
  } catch (error) {
    cloudStatus.dataset.state = "error";
    cloudStatus.textContent = error instanceof Error ? error.message : "Cloud save failed";
  } finally {
    cloudLoading = false;
    renderCloudStatus();
  }
}

async function copyCloudLink(): Promise<void> {
  await ensureCloudDocumentSaved();
  if (!cloudDocumentId) return;
  const share = await createDocumentShare(selectedCloudShareRole(), "Workbench link");
  await copyText(cloudDocumentUrl(cloudDocumentId, share.token), `Copied ${share.role} cloud link`);
}

async function openCloudArtifact(): Promise<void> {
  await ensureCloudDocumentSaved();
  if (!cloudDocumentId) return;
  const share = await createDocumentShare("viewer", "Artifact link");
  window.open(cloudArtifactUrl(cloudDocumentId, share.token), "_blank", "noopener");
}

async function saveCloudSite(): Promise<void> {
  if (!cloudAvailable || state.error) return;
  await ensureCloudDocumentSaved();
  if (!cloudDocumentId) return;
  cloudLoading = true;
  renderCloudStatus();
  try {
    const payload = JSON.stringify({
      title: `${sourceTitle(sourceInput.value)} Space`,
      documentIds: [cloudDocumentId],
    });
    const record = await fetchCloudJson<CloudSiteResponse>(
      cloudSiteId ? `/api/sites/${encodeURIComponent(cloudSiteId)}` : "/api/sites",
      {
        method: cloudSiteId ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      },
    );
    cloudSiteId = record.id;
    renderCloudStatus();
    showTransientStatus(`Saved cloud site ${record.slug}`);
  } catch (error) {
    cloudStatus.dataset.state = "error";
    cloudStatus.textContent = error instanceof Error ? error.message : "Cloud site save failed";
  } finally {
    cloudLoading = false;
    renderCloudStatus();
  }
}

async function copyCloudSiteLink(): Promise<void> {
  await ensureCloudSiteSaved();
  if (!cloudSiteId) return;
  const share = await createSiteShare("viewer", "Site link");
  cloudSiteShareToken = share.token;
  await copyText(cloudSiteUrl(cloudSiteId, share.token), "Copied site link");
}

async function openCloudSite(): Promise<void> {
  await ensureCloudSiteSaved();
  if (!cloudSiteId) return;
  const share = cloudSiteShareToken ? undefined : await createSiteShare("viewer", "Site preview");
  if (share) cloudSiteShareToken = share.token;
  window.open(cloudSiteUrl(cloudSiteId, cloudSiteShareToken), "_blank", "noopener");
}

function renderCloudStatus(currentHash?: string): void {
  const canEditCloudDocument = !cloudDocumentId || cloudDocumentRole === undefined || roleRank(cloudDocumentRole) >= roleRank("editor");
  createCloudUserButton.disabled = !cloudAvailable || cloudLoading;
  copyUserTokenButton.disabled = !cloudAvailable || cloudLoading || !cloudUser;
  saveCloudDocumentButton.disabled = !cloudAvailable || cloudLoading || Boolean(state.error) || !canEditCloudDocument;
  copyCloudLinkButton.disabled = !cloudAvailable || cloudLoading || !cloudDocumentId;
  openCloudArtifactButton.disabled = !cloudAvailable || cloudLoading || !cloudDocumentId;
  saveCloudSiteButton.disabled = !cloudAvailable || cloudLoading || Boolean(state.error) || !canEditCloudDocument;
  copyCloudSiteLinkButton.disabled = !cloudAvailable || cloudLoading || !cloudSiteId;
  openCloudSiteButton.disabled = !cloudAvailable || cloudLoading || !cloudSiteId;

  if (cloudLoading) {
    cloudStatus.dataset.state = "warning";
    cloudStatus.textContent = "Cloud workspace syncing.";
    return;
  }

  if (!cloudAvailable) {
    cloudStatus.dataset.state = "warning";
    cloudStatus.textContent = "Cloud save is unavailable on this static build.";
    return;
  }

  const userText = cloudUser ? `${cloudUser.name} (${cloudUser.tokenPreview ?? shortHash(cloudUser.id)})` : "shared-link user";

  if (state.error) {
    cloudStatus.dataset.state = "error";
    cloudStatus.textContent = `${userText}. Fix the render error before saving to cloud.`;
    return;
  }

  if (!cloudDocumentId) {
    cloudStatus.dataset.state = "ok";
    cloudStatus.textContent = `${userText}. Save once to create a permissioned cloud document.`;
    return;
  }

  const dirty = currentHash !== undefined && cloudDocumentHash !== undefined && currentHash !== cloudDocumentHash;
  cloudStatus.dataset.state = dirty ? "warning" : "ok";
  const role = cloudDocumentRole ? `${cloudDocumentRole} access` : "cloud access";
  const site = cloudSiteId ? ` / site ${cloudSiteId}` : "";
  cloudStatus.textContent = dirty
    ? `${userText}. Cloud doc ${cloudDocumentId} has unsaved changes (${role})${site}.`
    : `${userText}. Cloud doc ${cloudDocumentId} saved (${role})${site}.`;
}

async function createCloudUser(options: { silent?: boolean } = {}): Promise<void> {
  if (!cloudAvailable) return;
  cloudLoading = true;
  renderCloudStatus();
  try {
    const user = await fetchCloudJson<CloudUserResponse>("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: cloudUserNameInput.value || "Noma collaborator" }),
    });
    cloudUser = {
      id: user.id,
      name: user.name,
      token: user.token,
      tokenPreview: user.tokenPreview,
    };
    localStorage.setItem(cloudUserStorageKey, JSON.stringify(cloudUser));
    cloudUserNameInput.value = cloudUser.name;
    if (!options.silent) showTransientStatus(`Using cloud user ${cloudUser.name}`);
  } catch (error) {
    cloudStatus.dataset.state = "error";
    cloudStatus.textContent = error instanceof Error ? error.message : "Could not create cloud user";
  } finally {
    cloudLoading = false;
    renderCloudStatus();
  }
}

async function copyCloudUserToken(): Promise<void> {
  if (!cloudUser) return;
  await copyText(cloudUser.token, "Copied cloud user token");
}

async function ensureCloudDocumentSaved(): Promise<void> {
  if (!cloudDocumentId || cloudDocumentHash === undefined) await saveCloudDocument();
}

async function ensureCloudSiteSaved(): Promise<void> {
  await ensureCloudDocumentSaved();
  if (!cloudSiteId) await saveCloudSite();
}

async function createDocumentShare(role: Exclude<CloudRole, "owner">, label: string): Promise<CloudShareResponse> {
  if (!cloudDocumentId) throw new Error("Cloud document is not saved");
  return fetchCloudJson<CloudShareResponse>(`/api/documents/${encodeURIComponent(cloudDocumentId)}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, label }),
  });
}

async function createSiteShare(role: Exclude<CloudRole, "owner">, label: string): Promise<CloudShareResponse> {
  if (!cloudSiteId) throw new Error("Cloud site is not saved");
  return fetchCloudJson<CloudShareResponse>(`/api/sites/${encodeURIComponent(cloudSiteId)}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, label }),
  });
}

function selectedCloudShareRole(): Exclude<CloudRole, "owner"> {
  return cloudShareRoleSelect.value === "viewer" ? "viewer" : "editor";
}

function roleRank(role: CloudRole): number {
  return role === "owner" ? 3 : role === "editor" ? 2 : 1;
}

async function fetchCloudJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (cloudUser) headers.set("authorization", `Bearer ${cloudUser.token}`);
  if (cloudShareToken) headers.set("x-noma-share-token", cloudShareToken);
  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    const text = await response.text();
    try {
      const payload = JSON.parse(text) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      if (text) message = text;
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function sourceTitle(source: string): string {
  return source.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+\{[^}]*\}\s*$/, "").trim() || "Untitled document";
}

function readCloudDocumentId(): string | undefined {
  const id = new URLSearchParams(window.location.search).get("doc");
  return id && /^[A-Za-z0-9_-]{8,80}$/.test(id) ? id : undefined;
}

function readCloudShareToken(): string | undefined {
  const token = new URLSearchParams(window.location.search).get("share");
  return token && /^ns_[A-Za-z0-9_-]{16,}$/.test(token) ? token : undefined;
}

function readCloudUser(): CloudUserSession | undefined {
  const stored = localStorage.getItem(cloudUserStorageKey);
  if (!stored) return undefined;
  try {
    const parsed = JSON.parse(stored) as Partial<CloudUserSession>;
    if (typeof parsed.id === "string" && typeof parsed.name === "string" && typeof parsed.token === "string") {
      return {
        id: parsed.id,
        name: parsed.name,
        token: parsed.token,
        tokenPreview: typeof parsed.tokenPreview === "string" ? parsed.tokenPreview : undefined,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function clearCloudDocumentBinding(): void {
  if (!cloudDocumentId && !cloudDocumentHash && !cloudDocumentRole && !cloudShareToken) return;
  cloudDocumentId = undefined;
  cloudDocumentHash = undefined;
  cloudDocumentRole = undefined;
  cloudShareToken = undefined;
  updateCloudDocumentUrl(undefined, undefined);
}

function clearCloudSiteBinding(): void {
  cloudSiteId = undefined;
  cloudSiteShareToken = undefined;
}

function updateCloudDocumentUrl(id: string | undefined, share: string | undefined): void {
  if (window.location.protocol === "file:") return;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("doc", id);
  else url.searchParams.delete("doc");
  if (share) url.searchParams.set("share", share);
  else url.searchParams.delete("share");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function cloudDocumentUrl(id: string, share?: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set("doc", id);
  if (share) url.searchParams.set("share", share);
  else url.searchParams.delete("share");
  url.hash = "";
  return url.toString();
}

function cloudArtifactUrl(id: string, share?: string): string {
  const url = new URL(`/d/${encodeURIComponent(id)}`, window.location.href);
  if (share) url.searchParams.set("share", share);
  return url.toString();
}

function cloudSiteUrl(id: string, share?: string): string {
  const url = new URL(`/s/${encodeURIComponent(id)}`, window.location.href);
  if (share) url.searchParams.set("share", share);
  return url.toString();
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

function renderDataInspector(): void {
  const blocks = state.doc ? collectEditableDataBlocks(state.doc) : [];
  dataBlockSelect.replaceChildren();

  for (const block of blocks) {
    const option = document.createElement("option");
    option.value = block.id;
    option.textContent = `${block.kind} / ${block.id}`;
    dataBlockSelect.append(option);
  }

  if (blocks.length === 0) {
    activeDataBlockId = undefined;
    dataBlockSelect.disabled = true;
    addDataRowButton.disabled = true;
    addDataColumnButton.disabled = true;
    applyDataChangesButton.disabled = true;
    dataEditor.replaceChildren();
    dataEditorStatus.textContent = "No ID-bearing ::table or ::dataset blocks found.";
    return;
  }

  const hasActive = activeDataBlockId ? blocks.some((block) => block.id === activeDataBlockId) : false;
  activeDataBlockId = hasActive ? activeDataBlockId : blocks[0]!.id;
  dataBlockSelect.value = activeDataBlockId ?? "";
  dataBlockSelect.disabled = false;
  addDataRowButton.disabled = false;
  addDataColumnButton.disabled = false;
  applyDataChangesButton.disabled = false;
  renderDataEditorForActiveBlock();
}

function renderDataEditorForActiveBlock(): void {
  const block = currentEditableDataBlock();
  dataEditor.replaceChildren();

  if (!block) {
    dataEditorStatus.textContent = "Choose a table or dataset block with an ID.";
    return;
  }

  const table = document.createElement("table");
  table.className = "data-grid";
  table.dataset.kind = block.kind;
  table.dataset.blockId = block.id;

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (let index = 0; index < block.columns.length; index++) {
    headerRow.append(dataHeaderCell(block, block.columns[index] ?? `Column ${index + 1}`, index, true));
  }
  thead.append(headerRow);

  const tbody = document.createElement("tbody");
  for (const row of block.rows) {
    tbody.append(dataBodyRow(block.columns.length, row));
  }

  table.append(thead, tbody);
  dataEditor.append(table);

  const format = block.format ? ` / ${block.format}` : "";
  dataEditorStatus.textContent = `${block.label}${format}: ${block.rows.length} rows, ${block.columns.length} columns.`;
}

function collectEditableDataBlocks(doc: DocumentNode): EditableDataBlock[] {
  const blocks: EditableDataBlock[] = [];
  for (const node of walk(doc)) {
    if (node.type !== "directive" || !node.id) continue;
    const block = editableDataBlockFromDirective(node);
    if (block) blocks.push(block);
  }
  return blocks;
}

function editableDataBlockFromDirective(node: DirectiveNode): EditableDataBlock | null {
  try {
    if (node.name === "table") return tableDirectiveDataBlock(node);
    if (node.name === "dataset") return datasetDirectiveDataBlock(node);
  } catch {
    return null;
  }
  return null;
}

function tableDirectiveDataBlock(node: DirectiveNode): EditableDataBlock | null {
  const lines = (node.body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || !node.id) return null;

  const parsed = lines.map(splitPipeRow);
  const width = Math.max(1, ...parsed.map((row) => row.length));
  const hasHeader = node.attrs.header === true || node.attrs.header === "true";
  const columns = hasHeader
    ? padCells(parsed[0] ?? [], width)
    : Array.from({ length: width }, (_value, index) => `Column ${index + 1}`);
  const rows = (hasHeader ? parsed.slice(1) : parsed).map((row) => padCells(row, width));

  return {
    id: node.id,
    kind: "table",
    label: directiveLabel(node),
    hasHeader,
    columns,
    rows,
    line: node.pos?.line,
  };
}

function datasetDirectiveDataBlock(node: DirectiveNode): EditableDataBlock | null {
  if (!node.id) return null;
  const format = datasetFormat(node);
  const parsed = parseDatasetBodyForEditor(node, format);
  if (!parsed) return null;
  const width = Math.max(1, parsed.columns.length, ...parsed.rows.map((row) => row.length));
  return {
    id: node.id,
    kind: "dataset",
    label: directiveLabel(node),
    format,
    hasHeader: true,
    columns: padCells(parsed.columns, width),
    rows: parsed.rows.map((row) => padCells(row, width)),
    line: node.pos?.line,
  };
}

function parseDatasetBodyForEditor(node: DirectiveNode, format: string): EditedDataGrid | null {
  const body = (node.body ?? "").replace(/\r\n?/g, "\n");
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const lines = body.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) return null;
    return {
      columns: splitDelimitedRow(lines[0]!, delimiter),
      rows: lines.slice(1).map((line) => splitDelimitedRow(line, delimiter)),
    };
  }

  if (format === "json") {
    const parsed = JSON.parse(body) as unknown;
    return jsonDatasetForEditor(node, parsed);
  }

  if (format === "yaml") {
    const parsed = yaml.load(body);
    return yamlDatasetForEditor(node, parsed);
  }

  return null;
}

function jsonDatasetForEditor(node: DirectiveNode, parsed: unknown): EditedDataGrid | null {
  if (Array.isArray(parsed)) {
    if (parsed.length > 0 && isRecord(parsed[0])) {
      const columns = Object.keys(parsed[0]);
      return {
        columns,
        rows: parsed.filter(isRecord).map((row) => columns.map((column) => scalarText(row[column]))),
      };
    }
    const rows = parsed.filter(Array.isArray).map((row) => row.map(scalarText));
    return { columns: columnsAttr(node, rows), rows };
  }

  const record = isRecord(parsed) ? parsed : null;
  if (!record || !Array.isArray(record.rows)) return null;
  const rows = record.rows.filter(Array.isArray).map((row) => row.map(scalarText));
  const columns = Array.isArray(record.columns)
    ? record.columns.map(String)
    : columnsAttr(node, rows);
  return { columns, rows };
}

function yamlDatasetForEditor(node: DirectiveNode, parsed: unknown): EditedDataGrid | null {
  const record = isRecord(parsed) ? parsed : null;
  if (!record || !Array.isArray(record.rows)) return null;
  const rows = record.rows.filter(Array.isArray).map((row) => row.map(scalarText));
  const schema = isRecord(record.schema) ? record.schema : null;
  const columns = schema ? Object.keys(schema) : columnsAttr(node, rows);
  return { columns, rows };
}

function columnsAttr(node: DirectiveNode, rows: string[][]): string[] {
  const value = node.attrs.columns;
  if (typeof value === "string" && value.trim()) return value.split(/[,\s]+/).filter(Boolean);
  const width = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: width }, (_value, index) => `Column ${index + 1}`);
}

function datasetFormat(node: DirectiveNode): string {
  const format = node.attrs.format;
  return typeof format === "string" && format.trim() ? format.trim().toLowerCase() : "yaml";
}

function currentEditableDataBlock(): EditableDataBlock | null {
  if (!state.doc || !activeDataBlockId) return null;
  return collectEditableDataBlocks(state.doc).find((block) => block.id === activeDataBlockId) ?? null;
}

function dataHeaderCell(block: EditableDataBlock, value: string, index: number, existing: boolean): HTMLTableCellElement {
  const cell = document.createElement("th");
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.dataset.dataHeader = String(index);
  input.readOnly = existing && (block.kind === "dataset" || !block.hasHeader);
  input.title = input.readOnly ? "Existing dataset and inferred table column names are source-derived" : "Column name";
  cell.append(input);
  return cell;
}

function dataBodyRow(columnCount: number, row: string[] = []): HTMLTableRowElement {
  const tr = document.createElement("tr");
  for (let index = 0; index < columnCount; index++) {
    const cell = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.value = row[index] ?? "";
    input.dataset.dataCell = String(index);
    cell.append(input);
    tr.append(cell);
  }
  return tr;
}

function addDataGridRow(): void {
  const block = currentEditableDataBlock();
  const table = dataEditor.querySelector<HTMLTableElement>("table.data-grid");
  const tbody = table?.tBodies[0];
  const columnCount = dataGridColumnCount();
  if (!block || !tbody || columnCount === 0) {
    showTransientStatus("No editable data grid", "warning");
    return;
  }
  tbody.append(dataBodyRow(columnCount));
  dataEditorStatus.textContent = `Added a row to ${block.id}. Apply to write it.`;
}

function addDataGridColumn(): void {
  const block = currentEditableDataBlock();
  const table = dataEditor.querySelector<HTMLTableElement>("table.data-grid");
  const headerRow = table?.tHead?.rows[0];
  if (!block || !table || !headerRow) {
    showTransientStatus("No editable data grid", "warning");
    return;
  }

  const index = headerRow.cells.length;
  const nextColumn = block.kind === "dataset" ? `column_${index + 1}` : `Column ${index + 1}`;
  headerRow.append(dataHeaderCell(block, nextColumn, index, false));
  for (const row of [...(table.tBodies[0]?.rows ?? [])]) {
    const cell = document.createElement("td");
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.dataCell = String(index);
    cell.append(input);
    row.append(cell);
  }
  dataEditorStatus.textContent = `Added a column to ${block.id}. Apply to write it.`;
}

async function applyDataGridChanges(): Promise<void> {
  const block = currentEditableDataBlock();
  const edited = readDataGrid();
  if (!block || !edited) {
    showTransientStatus("No editable data grid", "warning");
    return;
  }

  let ops: PatchOp[];
  try {
    ops = dataGridPatchOps(block, edited);
  } catch (error) {
    dataEditorStatus.textContent = error instanceof Error ? error.message : String(error);
    showTransientStatus("Data edit cannot be applied", "error");
    return;
  }

  if (ops.length === 0) {
    dataEditorStatus.textContent = "No data changes to apply.";
    showTransientStatus("No data changes", "warning");
    return;
  }

  proofOpsInput.value = JSON.stringify(ops, null, 2);
  const proof = await generateProofForOps(ops);
  if (proof.canWrite) {
    applyLastProof();
    dataEditorStatus.textContent = `Applied ${ops.length} proofed data patch${ops.length === 1 ? "" : "es"}.`;
  } else {
    dataEditorStatus.textContent = "Data changes produced a failing proof.";
  }
}

function readDataGrid(): EditedDataGrid | null {
  const table = dataEditor.querySelector<HTMLTableElement>("table.data-grid");
  if (!table) return null;
  const columns = [...table.querySelectorAll<HTMLInputElement>("thead input[data-data-header]")]
    .map((input, index) => input.value.trim() || `Column ${index + 1}`);
  const rows = [...table.querySelectorAll<HTMLTableRowElement>("tbody tr")].map((row) =>
    [...row.querySelectorAll<HTMLInputElement>("input[data-data-cell]")].map((input) => input.value),
  );
  return { columns, rows };
}

function dataGridPatchOps(block: EditableDataBlock, edited: EditedDataGrid): PatchOp[] {
  if (edited.columns.length < block.columns.length || edited.rows.length < block.rows.length) {
    throw new Error("Use source patches for row or column deletion; the grid applies additions and cell edits.");
  }

  const ops: PatchOp[] = [];
  const commonColumns = Math.min(block.columns.length, edited.columns.length);
  const commonRows = Math.min(block.rows.length, edited.rows.length);

  if (block.kind === "table" && block.hasHeader) {
    for (let column = 0; column < commonColumns; column++) {
      const next = edited.columns[column] ?? "";
      if (next !== (block.columns[column] ?? "")) {
        ops.push({ op: "update_table_header_cell", id: block.id, column, value: next });
      }
    }
  }

  for (let row = 0; row < commonRows; row++) {
    for (let column = 0; column < commonColumns; column++) {
      const next = edited.rows[row]?.[column] ?? "";
      if (next === (block.rows[row]?.[column] ?? "")) continue;
      ops.push(block.kind === "table"
        ? { op: "update_table_cell", id: block.id, row, column, value: next }
        : { op: "update_dataset_cell", id: block.id, row, column, value: next });
    }
  }

  for (let column = block.columns.length; column < edited.columns.length; column++) {
    const header = edited.columns[column]?.trim() || `column_${column + 1}`;
    const cells = block.rows.map((_row, row) => edited.rows[row]?.[column] ?? "");
    if (block.kind === "table") {
      ops.push(block.hasHeader
        ? { op: "insert_table_column", id: block.id, column, header, cells }
        : { op: "insert_table_column", id: block.id, column, cells });
    } else {
      ops.push({ op: "insert_dataset_column", id: block.id, column, header, cells });
    }
  }

  for (let row = block.rows.length; row < edited.rows.length; row++) {
    const cells = padCells(edited.rows[row] ?? [], edited.columns.length);
    ops.push(block.kind === "table"
      ? { op: "insert_table_row", id: block.id, row, cells }
      : { op: "insert_dataset_row", id: block.id, row, cells });
  }

  return ops;
}

function dataGridColumnCount(): number {
  return dataEditor.querySelectorAll("thead input[data-data-header]").length;
}

function padCells(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_value, index) => row[index] ?? "");
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderOutput(): void {
  for (const button of targetButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.target === outputMode));
  }
  previewEditToggle.setAttribute("aria-pressed", String(previewEditMode));

  previewFrame.hidden = outputMode !== "preview" && outputMode !== "proof";
  previewFrame.dataset.editing = String(previewEditMode && outputMode === "preview" && !state.error);
  outputPre.hidden = outputMode === "preview" || outputMode === "proof";

  if (outputMode === "preview") {
    previewFrame.srcdoc = state.error
      ? errorDocument(state.error.message)
      : state.previewHtml;
    return;
  }

  if (outputMode === "proof") {
    previewFrame.srcdoc = lastProof?.html ?? proofPlaceholderDocument(sharedProof);
    return;
  }

  outputPre.textContent = outputMode === "json" ? state.json : state.llm;
}

async function generateProofFromInput(): Promise<void> {
  let ops: PatchOp[];
  try {
    ops = parsePatchOpsInput();
  } catch (error) {
    proofStatus.textContent = error instanceof Error ? error.message : String(error);
    proofStatus.dataset.state = "error";
    outputMode = "proof";
    renderOutput();
    return;
  }

  await generateProofForOps(ops);
}

async function generateProofForOps(ops: PatchOp[]): Promise<WorkbenchProof> {
  proofStatus.textContent = "Simulating patch...";
  proofStatus.dataset.state = "warning";
  lastProofApplied = false;

  const proof = await createWorkbenchProof(ops);
  lastProof = proof;
  sharedProof = null;
  outputMode = "proof";
  updateProofControls();
  renderOutput();

  if (proof.canWrite) {
    proofStatus.textContent = proof.status === "pass"
      ? "Proof passed. Apply is enabled."
      : "Proof passed with warnings. Review before applying.";
    proofStatus.dataset.state = proof.status === "pass" ? "ok" : "warning";
  } else {
    proofStatus.textContent = proof.error ?? "Proof failed. Apply is disabled.";
    proofStatus.dataset.state = "error";
  }
  return proof;
}

async function createWorkbenchProof(ops: PatchOp[]): Promise<WorkbenchProof> {
  const source = sourceInput.value;
  const preHash = await sha256Hex(source);
  const beforeBytes = utf8Bytes(source);
  const beforeLines = sourceLineCount(source);
  const preDoc = safeParse(source);
  const preDiagnostics = preDoc.doc ? validate(preDoc.doc) : [parseDiagnostic(preDoc.error ?? "Unable to parse source")];

  let postSource = source;
  let patchResult: WorkbenchProof["patchResult"] = "rejected";
  let error: string | undefined;

  try {
    postSource = patchSource(source, ops);
    patchResult = postSource === source ? "noop" : "applied";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const postHash = await sha256Hex(postSource);
  const postDoc = safeParse(postSource);
  const postDiagnostics = postDoc.doc ? validate(postDoc.doc) : [parseDiagnostic(postDoc.error ?? "Unable to parse patched source")];
  const metrics = measureSourcePreservation(source, postSource);
  const hasPostErrors = postDiagnostics.some((item) => item.severity === "error");
  const hasWarnings = [...preDiagnostics, ...postDiagnostics].some((item) => item.severity === "warning");
  const canWrite = patchResult !== "rejected" && !hasPostErrors;
  const status: WorkbenchProofStatus = !canWrite ? "fail" : hasWarnings ? "warn" : "pass";
  const html = renderWorkbenchProofHtml({
    status,
    canWrite,
    patchResult,
    ops,
    preHash,
    postHash,
    preDiagnostics,
    postDiagnostics,
    beforeBytes,
    afterBytes: utf8Bytes(postSource),
    beforeLines,
    afterLines: sourceLineCount(postSource),
    unchangedLines: metrics.unchangedLines,
    preservedPercent: metrics.preservedPercent,
    postSource,
    ...(error ? { error } : {}),
  }, postDoc.doc);

  return {
    status,
    canWrite,
    patchResult,
    ops,
    preHash,
    postHash,
    preDiagnostics,
    postDiagnostics,
    beforeBytes,
    afterBytes: utf8Bytes(postSource),
    beforeLines,
    afterLines: sourceLineCount(postSource),
    unchangedLines: metrics.unchangedLines,
    preservedPercent: metrics.preservedPercent,
    postSource,
    html,
    ...(error ? { error } : {}),
  };
}

function parsePatchOpsInput(): PatchOp[] {
  const raw = proofOpsInput.value.trim();
  if (!raw) throw new Error("Enter one patch op or an array of patch ops.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Patch ops JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizePatchOps(parsed);
}

function normalizePatchOps(parsed: unknown): PatchOp[] {
  const ops = Array.isArray(parsed) ? parsed : [parsed];
  if (ops.length === 0) throw new Error("Patch ops array is empty.");
  for (const op of ops) {
    if (!op || typeof op !== "object" || typeof (op as { op?: unknown }).op !== "string") {
      throw new Error("Every patch op must be an object with an op string.");
    }
  }
  return ops as PatchOp[];
}

function applyLastProof(): void {
  if (!lastProof || !lastProof.canWrite || lastProofApplied) {
    showTransientStatus("No unapplied passing proof", "warning");
    return;
  }

  sourceInput.value = lastProof.postSource;
  localStorage.setItem(storageKey, sourceInput.value);
  lastProofApplied = true;
  renderCurrent();
  updateProofControls();
  proofStatus.textContent = "Proof applied to the browser draft.";
  proofStatus.dataset.state = "ok";
  showTransientStatus("Applied proven patch");
}

async function copyProofLink(): Promise<void> {
  if (!lastProof) {
    showTransientStatus("Generate a proof first", "warning");
    return;
  }
  const payload: SharedProofPayload = {
    status: lastProof.status,
    canWrite: lastProof.canWrite,
    ops: lastProof.ops,
    preHash: lastProof.preHash,
    postHash: lastProof.postHash,
    diagnostics: `${lastProof.postDiagnostics.filter((item) => item.severity === "error").length} errors / ${lastProof.postDiagnostics.filter((item) => item.severity === "warning").length} warnings`,
    preservedPercent: lastProof.preservedPercent,
  };
  const url = new URL(window.location.href);
  url.hash = new URLSearchParams({ "noma-proof": encodeBase64Url(JSON.stringify(payload)) }).toString();
  await copyText(url.toString(), "Copied proof link");
}

async function copyDraftLink(): Promise<void> {
  const source = sourceInput.value;
  const hash = await sha256Hex(source);
  const url = await draftLinkForSource(source, hash);
  await copyText(url, url.length > 120000 ? "Copied large draft link" : "Copied draft link");
}

async function copyReviewPacket(): Promise<void> {
  const source = sourceInput.value;
  const hash = await sha256Hex(source);
  const errors = state.diagnostics.filter((item) => item.severity === "error");
  const warnings = state.diagnostics.filter((item) => item.severity === "warning");
  const info = state.diagnostics.filter((item) => item.severity === "info");
  const ids = state.doc ? collectIdSummary(state.doc) : [];
  const packet = [
    `# Noma Review Packet`,
    ``,
    `Document: ${documentTitle()}`,
    `Hash: ${hash}`,
    `Size: ${sourceLineCount(source)} lines / ${formatBytes(utf8Bytes(source))}`,
    `Diagnostics: ${errors.length} errors / ${warnings.length} warnings / ${info.length} info`,
    ``,
    `## Shared Draft`,
    await draftLinkForSource(source, hash),
    ``,
    `## Priority Diagnostics`,
    diagnosticsMarkdown(state.diagnostics),
    ``,
    `## Addressable IDs`,
    ids.length ? ids.map((item) => `- ${item}`).join("\n") : `No IDs found.`,
    ``,
    `## LLM Context`,
    "```text",
    state.llm || "No LLM context available.",
    "```",
  ].join("\n");
  await copyText(packet, "Copied review packet");
}

async function draftLinkForSource(source: string, hash = ""): Promise<string> {
  const sourceHash = hash || await sha256Hex(source);
  const payload: SharedDraftPayload = {
    source,
    title: documentTitle(),
    hash: sourceHash,
    createdAt: new Date().toISOString(),
  };
  const url = new URL(window.location.href);
  url.hash = new URLSearchParams({ "noma-source": encodeBase64Url(JSON.stringify(payload)) }).toString();
  return url.toString();
}

function documentTitle(): string {
  if (!state.doc) return "Untitled Noma Document";
  const metaTitle = state.doc.meta.title;
  if (typeof metaTitle === "string" && metaTitle.trim()) return metaTitle.trim();
  const root = state.doc.children.find((node): node is SectionNode => node.type === "section" && node.level === 1);
  return root?.title || "Untitled Noma Document";
}

function collectIdSummary(doc: DocumentNode): string[] {
  const out: string[] = [];
  for (const item of collectOutline(doc)) {
    if (!item.id) continue;
    const line = item.line ? ` line ${item.line}` : "";
    out.push(`${item.id} (${item.kind}${line})`);
    if (out.length >= 80) {
      out.push("...");
      break;
    }
  }
  return out;
}

function diagnosticsMarkdown(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "No diagnostics.";
  return diagnostics
    .slice(0, 24)
    .map((item) => {
      const line = item.pos?.line ? ` line ${item.pos.line}` : "";
      return `- ${item.severity} / ${item.code}${line}: ${item.message}`;
    })
    .join("\n") + (diagnostics.length > 24 ? "\n- ..." : "");
}

function updateProofControls(): void {
  applyProofButton.disabled = !lastProof?.canWrite || lastProofApplied;
  copyProofLinkButton.disabled = !lastProof;

  if (!lastProof) {
    if (sharedProof) {
      proofStatus.textContent = `Shared proof: ${sharedProof.status}, ${sharedProof.diagnostics}, ${sharedProof.preservedPercent}% preserved.`;
      proofStatus.dataset.state = sharedProof.status === "fail" ? "error" : sharedProof.status === "warn" ? "warning" : "ok";
    } else {
      proofStatus.textContent = "Patch ops are simulated before they can write.";
      delete proofStatus.dataset.state;
    }
    return;
  }

  proofStatus.dataset.state = lastProof.status === "fail" ? "error" : lastProof.status === "warn" ? "warning" : "ok";
}

function renderWorkbenchProofHtml(proof: Omit<WorkbenchProof, "html">, postDoc: DocumentNode | null): string {
  const postPreviewHtml = postDoc
    ? renderHtml(postDoc, {
        standalone: true,
        themeCss: `${defaultThemeCss}\nbody { background: #ffffff; }`,
        allowEscapeHatches: false,
        externalAssets: false,
        interactive: false,
      })
    : "";
  const postErrors = proof.postDiagnostics.filter((item) => item.severity === "error").length;
  const postWarnings = proof.postDiagnostics.filter((item) => item.severity === "warning").length;
  const opRows = proof.ops.map((op, index) =>
    `<tr><td>${index + 1}</td><td><code>${escapeHtml(op.op)}</code></td><td><pre>${escapeHtml(JSON.stringify(op, null, 2))}</pre></td></tr>`,
  ).join("");
  const preview = postPreviewHtml
    ? `<iframe class="proof-artifact" title="Post-patch artifact preview" sandbox srcdoc="${escapeAttr(postPreviewHtml)}"></iframe>`
    : `<p class="muted">Artifact preview is unavailable because the patch was rejected or the patched source could not parse.</p>`;

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Noma Workbench Proof</title>
<style>${proofReportCss()}</style>
<main>
  <section class="hero">
    <span class="badge status-${proof.status}">${proof.status.toUpperCase()}</span>
    <h1>Agent Safety Proof</h1>
    <p>${escapeHtml(proofStatusMessage(proof))}</p>
    ${proof.error ? `<p class="error-text">${escapeHtml(proof.error)}</p>` : ""}
    <div class="metrics">
      <div><strong>${escapeHtml(proof.patchResult)}</strong><span>Patch result</span></div>
      <div><strong>${postErrors}</strong><span>Post errors</span></div>
      <div><strong>${postWarnings}</strong><span>Post warnings</span></div>
      <div><strong>${proof.preservedPercent}%</strong><span>Line preservation</span></div>
    </div>
  </section>
  <section class="grid">
    <article>
      <h2>Hashes</h2>
      <dl>
        <dt>Before</dt><dd><code>${proof.preHash}</code></dd>
        <dt>After</dt><dd><code>${proof.postHash}</code></dd>
      </dl>
    </article>
    <article>
      <h2>Source Metrics</h2>
      <dl>
        <dt>Bytes</dt><dd>${proof.beforeBytes} -> ${proof.afterBytes}</dd>
        <dt>Lines</dt><dd>${proof.beforeLines} -> ${proof.afterLines}</dd>
        <dt>Unchanged lines</dt><dd>${proof.unchangedLines}</dd>
      </dl>
    </article>
  </section>
  <section>
    <h2>Patch Ops</h2>
    <table><thead><tr><th>#</th><th>Op</th><th>Payload</th></tr></thead><tbody>${opRows}</tbody></table>
  </section>
  <section class="grid">
    <article>
      <h2>Pre-validation</h2>
      ${diagnosticsHtml(proof.preDiagnostics)}
    </article>
    <article>
      <h2>Post-validation</h2>
      ${diagnosticsHtml(proof.postDiagnostics)}
    </article>
  </section>
  <section>
    <h2>Post-patch Artifact</h2>
    ${preview}
  </section>
</main>
</html>`;
}

function proofPlaceholderDocument(payload: SharedProofPayload | null): string {
  if (payload) {
    return `<!doctype html><html lang="en"><meta charset="utf-8" /><style>${proofReportCss()}</style><main>
      <section class="hero">
        <span class="badge status-${payload.status}">${payload.status.toUpperCase()}</span>
        <h1>Shared Proof Summary</h1>
        <p>This link carries proof metadata without embedding the source document.</p>
        <div class="metrics">
          <div><strong>${escapeHtml(String(payload.canWrite))}</strong><span>Can write</span></div>
          <div><strong>${escapeHtml(payload.diagnostics)}</strong><span>Post diagnostics</span></div>
          <div><strong>${payload.preservedPercent}%</strong><span>Line preservation</span></div>
          <div><strong>${payload.ops.length}</strong><span>Ops</span></div>
        </div>
      </section>
      <section><h2>Hashes</h2><dl><dt>Before</dt><dd><code>${escapeHtml(payload.preHash)}</code></dd><dt>After</dt><dd><code>${escapeHtml(payload.postHash)}</code></dd></dl></section>
    </main></html>`;
  }

  return `<!doctype html><html lang="en"><meta charset="utf-8" /><style>${proofReportCss()}</style><main>
    <section class="hero">
      <span class="badge status-warn">READY</span>
      <h1>Generate a Proof</h1>
      <p>Paste patch ops in the Agent Proof panel, then run Prove. Noma simulates the change, validates the post-document, and enables Apply only when the write is safe.</p>
    </section>
  </main></html>`;
}

function proofStatusMessage(proof: WorkbenchProof): string {
  if (proof.status === "fail") return "Patch simulation did not produce a writable post-document.";
  if (proof.status === "warn") return "Patch simulation produced a writable post-document with warnings to review.";
  return "Patch simulation produced a writable post-document with no validation errors.";
}

function diagnosticsHtml(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return `<p class="muted">No diagnostics.</p>`;
  return `<ul class="diagnostic-report">${diagnostics.map((item) => {
    const where = item.pos ? ` line ${item.pos.line}` : "";
    return `<li class="${item.severity}"><strong>${escapeHtml(item.severity)}</strong> <code>${escapeHtml(item.code)}</code>${where}: ${escapeHtml(item.message)}</li>`;
  }).join("")}</ul>`;
}

function proofReportCss(): string {
  return `
    :root { --bg: #f4f6f5; --panel: #fff; --ink: #17201d; --muted: #63706b; --rule: #d8dfdc; --ok: #2f7048; --warn: #906327; --bad: #a33a32; --accent: #275d67; --mono: "SF Mono", Menlo, Consolas, monospace; --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); line-height: 1.48; }
    main { max-width: 1220px; margin: 0 auto; padding: 24px; display: grid; gap: 14px; }
    section, article { background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 18px; min-width: 0; }
    .hero { display: grid; gap: 10px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: clamp(2rem, 4vw, 3rem); line-height: 1.04; letter-spacing: 0; }
    h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    code, pre { font-family: var(--mono); }
    code { background: #eef2f0; border-radius: 4px; padding: 0.08rem 0.25rem; overflow-wrap: anywhere; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th, td { border-bottom: 1px solid var(--rule); padding: 9px; text-align: left; vertical-align: top; }
    dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 14px; margin: 0; }
    dt { color: var(--muted); }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding: 0; border: 0; background: transparent; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .metrics div { border: 1px solid var(--rule); border-radius: 7px; padding: 12px; background: #fbfcfb; }
    .metrics strong, .metrics span { display: block; min-width: 0; overflow-wrap: anywhere; }
    .metrics span, .muted { color: var(--muted); }
    .badge { width: max-content; border: 1px solid currentColor; border-radius: 999px; padding: 5px 9px; font-weight: 800; font-size: .78rem; }
    .status-pass, .ok { color: var(--ok); }
    .status-warn, .warning, .info { color: var(--warn); }
    .status-fail, .error, .error-text { color: var(--bad); }
    .diagnostic-report { margin: 0; padding-left: 18px; }
    .proof-artifact { width: 100%; height: 520px; border: 1px solid var(--rule); border-radius: 7px; background: #fff; }
    @media (max-width: 760px) { main { padding: 12px; } .grid, .metrics { grid-template-columns: 1fr; } }
  `;
}

function safeParse(source: string): { doc: DocumentNode; error?: never } | { doc: null; error: string } {
  try {
    return { doc: parse(source, { filename: "workbench.noma" }) };
  } catch (error) {
    return { doc: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function parseDiagnostic(message: string): Diagnostic {
  return { severity: "error", code: "parse", message };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = utf8Encode(value);
  if (globalThis.crypto?.subtle && typeof Uint8Array !== "undefined") {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return fallbackHash(value);
}

function fallbackHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Array.from({ length: 8 }, () => (hash >>> 0).toString(16).padStart(8, "0")).join("");
}

function utf8Bytes(value: string): number {
  return utf8Encode(value).length;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function sourceLineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

function measureSourcePreservation(before: string, after: string): { unchangedLines: number; preservedPercent: number } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let unchangedLines = 0;
  for (let i = 0; i < Math.min(beforeLines.length, afterLines.length); i++) {
    if (beforeLines[i] === afterLines[i]) unchangedLines++;
  }
  const preservedPercent = beforeLines.length === 0 ? 100 : Math.round((unchangedLines / beforeLines.length) * 100);
  return { unchangedLines, preservedPercent };
}

function encodeBase64Url(value: string): string {
  const bytes = utf8Encode(value);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    out += base64Alphabet[(triplet >> 18) & 63];
    out += base64Alphabet[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? base64Alphabet[(triplet >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? base64Alphabet[triplet & 63] : "=";
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    const value = base64Alphabet.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return utf8Decode(bytes);
}

function utf8Encode(value: string): number[] {
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

function utf8Decode(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++] ?? 0;
    if (first < 0x80) {
      out += String.fromCodePoint(first);
    } else if (first < 0xe0) {
      const second = bytes[i++] ?? 0;
      out += String.fromCodePoint(((first & 0x1f) << 6) | (second & 0x3f));
    } else if (first < 0xf0) {
      const second = bytes[i++] ?? 0;
      const third = bytes[i++] ?? 0;
      out += String.fromCodePoint(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f));
    } else {
      const second = bytes[i++] ?? 0;
      const third = bytes[i++] ?? 0;
      const fourth = bytes[i++] ?? 0;
      out += String.fromCodePoint(((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f));
    }
  }
  return out;
}

function readSharedProofHash(): SharedProofPayload | null {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  if (!hash) return null;
  const encoded = new URLSearchParams(hash).get("noma-proof");
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(encoded)) as SharedProofPayload;
    if (parsed.status !== "pass" && parsed.status !== "warn" && parsed.status !== "fail") return null;
    return parsed;
  } catch {
    return null;
  }
}

function readSharedDraftHash(): SharedDraftPayload | null {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  if (!hash) return null;
  const encoded = new URLSearchParams(hash).get("noma-source");
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(decodeBase64Url(encoded)) as SharedDraftPayload;
    if (!parsed || typeof parsed.source !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
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
  lastProof = null;
  lastProofApplied = false;
  updateProofControls();
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
    markdown: "",
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

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
