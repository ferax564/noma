// Forked from ferax564/paperDOM@a12198c app/document-model.ts (MIT). Maintained in this repository; see src/paperdom-pin.ts.
import { MAX_PPTX_SOURCE_BYTES, type PowerPointSource } from './paperdom-pptx-source.js';
import {safeLink,safeMedia,replaceRunText,type TextRun,type AnimationCue,type MediaData} from './paperdom-advanced-model.js';
import { copyElements, endpointPoint, translateElement, type TableData, type ChartData } from './paperdom-presentation-tools.js';
import { resyncParagraphs } from './paperdom-text-formatting.js';
import { SHAPE_GEOMETRIES, type ShapeGeometry } from './paperdom-geometry-shapes.js';
import { randomId } from './paperdom-ids.js';
import { validateLibrary, validateTheme, validateInstance, defaultTheme, type ComponentLibrary, type ComponentInstance, type Theme } from './paperdom-component-library.js';
export type Kind = "text" | "shape" | "ellipse" | "connector" | "line" | "image" | "plugin" | "component" | "table" | "chart" | "audio" | "video";
export type Anchor = "top" | "right" | "bottom" | "left";
export type Endpoint = { elementId?: string; anchor?: Anchor; x?: number; y?: number };
export type Frame = { x: number; y: number; w: number; h: number; rotation: number };

export type FillGradient = { from: string; to: string; angle: number };
export type DropShadow = { color: string; blur: number; offsetX: number; offsetY: number };
export type FocalPoint = { x: number; y: number };
/** Structured paragraphs replace literal "• " text markers. content.text stays canonical. */
export type Paragraph = { text: string; kind?: "bullet" | "number" | "plain"; level?: number };

export type ElementStyle = {
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
  opacity: number;
  color: string;
  fontSize: number;
  fontWeight: number;
  textAlign: "left" | "center" | "right";
  fontFamily: string;
  fontStyle: "normal" | "italic";
  underline: boolean;
  strike: boolean;
  lineHeight: number;
  letterSpacing: number;
  verticalAlign: "top" | "middle" | "bottom";
  padding: number;
  lineStyle?: "solid" | "dashed";
  fillGradient?: FillGradient;
  shadow?: DropShadow;
  fit?: "cover" | "contain";
  focal?: FocalPoint;
  autoFit?: "none" | "grow" | "shrink";
};

export type ElementContent = {
  text?: string;
  src?: string;
  alt?: string;
  label?: string;
  value?: string;
  trend?: string;
  accent?: string;
  paragraphs?: Paragraph[];
};

export type CanvasElement = {
  id: string;
  type: Kind;
  name: string;
  frame: Frame;
  z: number;
  style: ElementStyle;
  locked?: boolean;
  hidden?: boolean;
  geometry?: ShapeGeometry;
  from?: Endpoint;
  to?: Endpoint;
  content?: ElementContent;
  component?: ComponentInstance;
  table?: TableData;
  chart?: ChartData;
  groupId?: string;
  aspectLocked?: boolean;
  runs?: TextRun[];
  media?: MediaData;
};

export type SlideComment = {
  id: string;
  author: string;
  text: string;
  elementId?: string;
  createdAt: string;
  resolved?: boolean;
};

export type CanvasPage = {
  id: string;
  name: string;
  notes?: string;
  hidden?: boolean;
  transition?: "none" | "fade" | "slide";
  advanceSeconds?: number;
  masterId?: string;
  inheritBackground?: boolean;
  animations?: AnimationCue[];
  comments?: SlideComment[];
  size: { width: number; height: number };
  background: { color: string };
  elements: CanvasElement[];
};

export type PaperDOMDocument = {
  format: "paperdom" | "canvasdoc";
  version: "0.1";
  id: string;
  title: string;
  revision: number;
  pages: CanvasPage[];
  plugins: { id: string; version: string }[];
  powerPointSource?: PowerPointSource;
  masters?: CanvasPage[];
  library?: ComponentLibrary;
  theme?: Theme;
  metadata: { createdAt: string; updatedAt: string };
};

export type AlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

export type AgentOperation =
  | { op: "patchDocument"; patch: { title?: string } }
  | {op:"setMasters";masters:CanvasPage[]}
  | { op: "setLibrary"; library: ComponentLibrary }
  | { op: "setTheme"; theme: Theme }
  | { op: "createPage"; page: CanvasPage; index?: number }
  | { op: "duplicatePage"; pageId: string; id?: string; name?: string; index?: number }
  | { op: "patchPage"; pageId: string; patch: Partial<Pick<CanvasPage,"name"|"notes"|"background"|"size"|"hidden"|"transition"|"advanceSeconds"|"masterId"|"animations"|"inheritBackground"|"comments">> }
  | { op: "deletePage"; pageId: string }
  | { op: "reorderPages"; pageIds: string[] }
  | { op: "createElement"; pageId?: string; element: CanvasElement }
  | { op: "duplicateElements"; pageId?: string; ids: string[]; offset?: number; idPrefix?: string }
  | { op: "moveElements"; pageId?: string; toPageId: string; ids: string[] }
  | { op: "patchElement"; pageId?: string; elementId: string; patch: CanvasElementPatch }
  | { op: "deleteElements"; pageId?: string; ids: string[] }
  | { op: "replaceText"; pageId?: string; elementId: string; text: string }
  | { op: "alignElements"; pageId?: string; ids?: string[]; mode: AlignMode; relative?: "selection" | "page" }
  | { op: "distributeElements"; pageId?: string; ids: string[]; axis: "x" | "y" }
  | { op: "reorderElements"; pageId?: string; order: string[] }
  | { op: "styleAll"; pageId?: string; scope?: "page" | "document"; match?: { type?: Kind; groupId?: string; hidden?: boolean; locked?: boolean }; patch: Pick<CanvasElementPatch, "style" | "hidden" | "locked" | "name"> }
  | { op: "replaceTextAll"; find: string; replace?: string; caseSensitive?: boolean; pageId?: string; scope?: "page" | "document"; includeTables?: boolean; includeComponents?: boolean }
  | { op: "zOrderElements"; pageId?: string; ids: string[]; to: "front" | "back" | "forward" | "backward" };

export type AgentTransactionPayload = {
  expectedRevision?: number;
  description?: string;
  actor?: { id: string; name: string; type: "human" | "agent" };
  operations: AgentOperation[];
};

export type CanvasElementPatch = Omit<Partial<CanvasElement>, "id" | "frame" | "style" | "content"> & {
  frame?: Partial<Frame>;
  style?: Partial<ElementStyle>;
  content?: Partial<ElementContent>;
};

export type AgentTransactionResult =
  | {
      ok: true;
      document: PaperDOMDocument;
      previousRevision: number;
      revision: number;
      changedElementIds: string[];
    }
  | {
      ok: false;
      error: "revision_conflict" | "invalid_transaction" | "invalid_operation" | "invalid_document";
      revision: number;
      message: string;
      operationIndex?: number;
    };

export type DocumentParseResult =
  | { ok: true; document: PaperDOMDocument }
  | { ok: false; error: string };

export const LAST_DOCUMENT_STORAGE_KEY = "paperdom:last-document-id";

const DEFAULT_FONT = "Inter, ui-sans-serif, system-ui, sans-serif";
const DEFAULT_STYLE: ElementStyle = {
  fill: "#ffffff",
  stroke: "#cbd5e1",
  strokeWidth: 2,
  radius: 18,
  opacity: 1,
  color: "#111827",
  fontSize: 20,
  fontWeight: 500,
  textAlign: "center",
  fontFamily: DEFAULT_FONT,
  fontStyle: "normal",
  underline: false,
  strike: false,
  lineHeight: 1.28,
  letterSpacing: 0,
  verticalAlign: "middle",
  padding: 14,
};
const KINDS = new Set<Kind>(["text", "shape", "ellipse", "connector", "line", "image", "plugin", "component", "table", "chart", "audio", "video"]);
const ANCHORS = new Set<Anchor>(["top", "right", "bottom", "left"]);
const TEXT_ALIGNS = new Set(["left", "center", "right"]);
const VERTICAL_ALIGNS = new Set(["top", "middle", "bottom"]);
const FONT_STYLES = new Set(["normal", "italic"]);
const LINE_STYLES = new Set(["solid", "dashed"]);
const CONTENT_KEYS = ["text", "src", "alt", "label", "value", "trend", "accent"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const safeIdentifier = (value: string): boolean =>
  /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

/** Elements created without a style inherit the document theme, not fixed defaults. */
function themeElementStyle(document: PaperDOMDocument): ElementStyle {
  const theme = document.theme;
  return theme ? { ...DEFAULT_STYLE, color: theme.ink, fontFamily: theme.fontFamily } : { ...DEFAULT_STYLE };
}

/** Map old-theme token values onto the new theme across pages, masters, runs, and backgrounds. */
export function applyThemeTokens(document: PaperDOMDocument, from: Theme, to: Theme): PaperDOMDocument {
  if (from === to) return document;
  const pairs = (Object.keys(from) as (keyof Theme)[]).map((token) => [from[token], to[token]] as const);
  const map = (value: string): string => {
    for (const [source, target] of pairs) if (source !== "" && value === source) return target;
    return value;
  };
  const mapStyle = (style: ElementStyle): ElementStyle => ({
    ...style,
    fill: map(style.fill),
    stroke: map(style.stroke),
    color: map(style.color),
    fontFamily: map(style.fontFamily),
    fillGradient: style.fillGradient ? { ...style.fillGradient, from: map(style.fillGradient.from), to: map(style.fillGradient.to) } : undefined,
    shadow: style.shadow ? { ...style.shadow, color: map(style.shadow.color) } : undefined,
  });
  const mapRuns = (runs: TextRun[]): TextRun[] => runs.map((run) => ({
    ...run,
    style: run.style ? {
      ...run.style,
      ...(run.style.color === undefined ? {} : { color: map(run.style.color) }),
      ...(run.style.fontFamily === undefined ? {} : { fontFamily: map(run.style.fontFamily) }),
    } : run.style,
  }));
  const mapPage = (page: CanvasPage): CanvasPage => ({
    ...page,
    background: { ...page.background, color: map(page.background.color) },
    elements: page.elements.map((element) => ({
      ...element,
      style: mapStyle(element.style),
      runs: element.runs ? mapRuns(element.runs) : element.runs,
    })),
  });
  return { ...document, pages: document.pages.map(mapPage), masters: document.masters?.map(mapPage) };
}

function normalizeCandidate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const pages = Array.isArray(value.pages)
    ? value.pages.map((rawPage) => {
        if (!isRecord(rawPage)) return rawPage;
        const size = isRecord(rawPage.size) ? rawPage.size : {};
        const background = isRecord(rawPage.background) ? rawPage.background : {};
        const elements = Array.isArray(rawPage.elements)
          ? rawPage.elements.map((rawElement) => {
              if (!isRecord(rawElement)) return rawElement;
              const frame = isRecord(rawElement.frame) ? rawElement.frame : {};
              const style = isRecord(rawElement.style) ? rawElement.style : {};
              return {
                ...rawElement,
                frame: { rotation: 0, ...frame },
                style: { ...DEFAULT_STYLE, ...style },
              };
            })
          : rawPage.elements;
        return {
          ...rawPage,
          size: { width: 1280, height: 720, ...size },
          background: { color: "#ffffff", ...background },
          elements,
        };
      })
    : value.pages;

  return {
    ...value,
    format: value.format === "canvasdoc" ? "paperdom" : value.format,
    id: value.id === "doc_canvasdoc_demo" ? "doc_paperdom_demo" : value.id,
    plugins: value.plugins ?? [],
    pages,
  };
}

function validateEndpoint(endpoint: unknown, elementIds: Set<string>, path: string): string | null {
  if (!isRecord(endpoint)) return `${path} must be an object`;
  if (endpoint.elementId !== undefined) {
    if (!isNonEmptyString(endpoint.elementId)) return `${path}.elementId must be a non-empty string`;
    if (!elementIds.has(endpoint.elementId)) return `${path}.elementId references a missing element`;
    if (!ANCHORS.has(endpoint.anchor as Anchor)) return `${path}.anchor is invalid`;
    return null;
  }
  if (!isFiniteNumber(endpoint.x) || !isFiniteNumber(endpoint.y)) return `${path} needs finite x and y coordinates`;
  return null;
}

function validateElement(element: unknown, elementIds: Set<string>, path: string): string | null {
  if (!isRecord(element)) return `${path} must be an object`;
  if (!isNonEmptyString(element.id)) return `${path}.id must be a non-empty string`;
  if (!KINDS.has(element.type as Kind)) return `${path}.type is invalid`;
  if (typeof element.name !== "string") return `${path}.name must be a string`;
  if (!isFiniteNumber(element.z)) return `${path}.z must be finite`;
  if (element.locked !== undefined && typeof element.locked !== "boolean") return `${path}.locked must be boolean`;
  if (element.hidden !== undefined && typeof element.hidden !== "boolean") return `${path}.hidden must be boolean`;
  if (element.geometry !== undefined && (element.type !== "shape" || typeof element.geometry !== "string" || !(element.geometry in SHAPE_GEOMETRIES))) return `${path}.geometry must name a preset geometry on a shape element`;

  if (element.groupId !== undefined && !isNonEmptyString(element.groupId)) return `${path}.groupId must be a nonempty string`;
  if (element.aspectLocked !== undefined && typeof element.aspectLocked !== 'boolean') return `${path}.aspectLocked must be boolean`;
  if (element.type === 'table') {
    const t=element.table;
    if (!isRecord(t)||typeof t.header!=='boolean'||!Array.isArray(t.rows)||!t.rows.length||t.rows.length>50) return `${path}.table requires 1–50 rows`;
    const width=Array.isArray(t.rows[0])?t.rows[0].length:0;
    if(!width||width>20||t.rows.some(row=>!Array.isArray(row)||row.length!==width||row.some(cell=>typeof cell!=='string')))return `${path}.table requires rectangular string cells (1–20 columns)`;
  }
  if(element.type==='chart') {
    const c=element.chart;
    if(!isRecord(c)||(c.kind!=='bar'&&c.kind!=='line')||typeof c.title!=='string'||!Array.isArray(c.labels)||!Array.isArray(c.values)||!c.labels.length||c.labels.length>50||c.values.length!==c.labels.length||c.labels.some(v=>typeof v!=='string')||c.values.some(v=>!isFiniteNumber(v)))return `${path}.chart requires matching labels and finite numeric values`;
    if(c.series!==undefined){
      if(!Array.isArray(c.series)||c.series.length>10)return `${path}.chart.series must contain at most 10 series`;
      for(const s of c.series){
        if(!isRecord(s)||typeof s.name!=='string'||!Array.isArray(s.values)||s.values.length!==c.labels.length||s.values.some(v=>!isFiniteNumber(v)))return `${path}.chart.series requires a name and one finite value per label`;
      }
    }
    if(c.colors!==undefined&&(!Array.isArray(c.colors)||c.colors.length>10||c.colors.some(v=>typeof v!=='string'||/\b(?:url|image-set)\s*\(/i.test(v))))return `${path}.chart.colors must be color strings`;
  }
  if(element.runs!==undefined){
    if(!Array.isArray(element.runs)||element.runs.length>10000)return `${path}.runs must be an array of at most 10000 runs`;
    for(const r of element.runs){if(!isRecord(r)||typeof r.text!=='string'||(r.link!==undefined&&(typeof r.link!=='string'||(r.link!==''&&!safeLink(r.link)))))return `${path}.runs contains invalid text or hyperlink`;
      if(r.style!==undefined){if(!isRecord(r.style))return `${path}.runs.style is invalid`;for(const [k,v]of Object.entries(r.style)){if(!['fontFamily','fontSize','fontWeight','fontStyle','underline','strike','color'].includes(k))return `${path}.runs.style field is invalid`;if(['fontSize','fontWeight'].includes(k)&&(!isFiniteNumber(v)||v<=0||v>1000))return `${path}.runs.style size is invalid`;if(['underline','strike'].includes(k)&&typeof v!=='boolean')return `${path}.runs.style flag is invalid`;if(k==='fontStyle'&&!['normal','italic'].includes(String(v)))return `${path}.runs.style font is invalid`;if(['color','fontFamily'].includes(k)&&(typeof v!=='string'||/\b(?:url|image-set)\s*\(/i.test(v)))return `${path}.runs.style paint is invalid`;}}
    }
    if(element.runs.map(r=>(r as TextRun).text).join('')!==(isRecord(element.content)?element.content.text:''))return `${path}.runs must match content.text`;
  }
  if(element.type==='audio'||element.type==='video'){
    const m=element.media;if(!isRecord(m)||typeof m.src!=='string'||!safeMedia(m.src)||!['autoplay','loop','muted'].every(k=>typeof m[k]==='boolean')||!isFiniteNumber(m.start)||m.start<0||(m.end!==undefined&&(!isFiniteNumber(m.end)||m.end<=m.start)))return `${path}.media is invalid`;
    if(m.poster!==undefined&&(typeof m.poster!=='string'||!/^https:\/\/|^data:image\/(png|jpeg|webp);base64,|^\/api\/assets\//i.test(m.poster)))return `${path}.media.poster is invalid`;
    if(m.captions!==undefined&&(typeof m.captions!=='string'||!/^https:\/\/|^data:text\/vtt|^\/api\/assets\//i.test(m.captions)))return `${path}.media.captions is invalid`;
  }
  if (!isRecord(element.frame)) return `${path}.frame must be an object`;
  const frame = element.frame;
  for (const key of ["x", "y", "w", "h", "rotation"] as const) {
    if (!isFiniteNumber(frame[key])) return `${path}.frame.${key} must be finite`;
  }
  const frameWidth = frame.w as number;
  const frameHeight = frame.h as number;
  if (frameWidth < 0 || frameHeight < 0) return `${path}.frame dimensions cannot be negative`;
  if (element.type !== "line" && element.type !== "connector" && (frameWidth === 0 || frameHeight === 0)) {
    return `${path}.frame dimensions must be positive`;
  }

  if (!isRecord(element.style)) return `${path}.style must be an object`;
  const style = element.style;
  for (const key of ["fill", "stroke", "color", "fontFamily"] as const) {
    if (typeof style[key] !== "string") return `${path}.style.${key} must be a string`;
  }
  for (const key of ["fill", "stroke", "color"] as const) {
    if (/\b(?:url|image-set)\s*\(/i.test(style[key] as string)) return `${path}.style.${key} cannot load an external resource`;
  }
  for (const key of ["strokeWidth", "radius", "opacity", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "padding"] as const) {
    if (!isFiniteNumber(style[key])) return `${path}.style.${key} must be finite`;
  }
  const strokeWidth = style.strokeWidth as number;
  const radius = style.radius as number;
  const opacity = style.opacity as number;
  const fontSize = style.fontSize as number;
  const lineHeight = style.lineHeight as number;
  const padding = style.padding as number;
  if (strokeWidth < 0 || radius < 0 || fontSize <= 0 || lineHeight <= 0 || padding < 0) {
    return `${path}.style contains an out-of-range size`;
  }
  if (opacity < 0 || opacity > 1) return `${path}.style.opacity must be between 0 and 1`;
  if (!TEXT_ALIGNS.has(style.textAlign as string)) return `${path}.style.textAlign is invalid`;
  if (!VERTICAL_ALIGNS.has(style.verticalAlign as string)) return `${path}.style.verticalAlign is invalid`;
  if (!FONT_STYLES.has(style.fontStyle as string)) return `${path}.style.fontStyle is invalid`;
  if (typeof style.underline !== "boolean" || typeof style.strike !== "boolean") {
    return `${path}.style underline and strike values must be boolean`;
  }
  if (style.lineStyle !== undefined && !LINE_STYLES.has(style.lineStyle as string)) {
    return `${path}.style.lineStyle is invalid`;
  }
  const gradient = style.fillGradient;
  if (gradient !== undefined) {
    if (!isRecord(gradient) || typeof gradient.from !== "string" || typeof gradient.to !== "string" ||
      /\b(?:url|image-set)\s*\(/i.test(gradient.from) || /\b(?:url|image-set)\s*\(/i.test(gradient.to) ||
      !isFiniteNumber(gradient.angle)) return `${path}.style.fillGradient requires from/to colors and a finite angle`;
  }
  const shadow = style.shadow;
  if (shadow !== undefined) {
    if (!isRecord(shadow) || typeof shadow.color !== "string" || /\b(?:url|image-set)\s*\(/i.test(shadow.color) ||
      !isFiniteNumber(shadow.blur) || shadow.blur < 0 || !isFiniteNumber(shadow.offsetX) || !isFiniteNumber(shadow.offsetY)) {
      return `${path}.style.shadow requires a color, non-negative blur, and finite offsets`;
    }
  }
  if (style.fit !== undefined && style.fit !== "cover" && style.fit !== "contain") return `${path}.style.fit is invalid`;
  if (style.focal !== undefined && (!isRecord(style.focal) || !isFiniteNumber(style.focal.x) || !isFiniteNumber(style.focal.y) ||
    style.focal.x < 0 || style.focal.x > 1 || style.focal.y < 0 || style.focal.y > 1)) {
    return `${path}.style.focal must contain x and y between 0 and 1`;
  }
  if (style.autoFit !== undefined && style.autoFit !== "none" && style.autoFit !== "grow" && style.autoFit !== "shrink") {
    return `${path}.style.autoFit is invalid`;
  }

  if (element.content !== undefined) {
    if (!isRecord(element.content)) return `${path}.content must be an object`;
    for (const key of CONTENT_KEYS) {
      if (element.content[key] !== undefined && typeof element.content[key] !== "string") {
        return `${path}.content.${key} must be a string`;
      }
    }
    if (element.content.paragraphs !== undefined) {
      const paragraphs = element.content.paragraphs;
      if (!Array.isArray(paragraphs) || paragraphs.length > 200) return `${path}.content.paragraphs must contain at most 200 paragraphs`;
      for (const raw of paragraphs) {
        const paragraph = raw as Paragraph;
        if (!isRecord(raw) || typeof paragraph.text !== "string" || paragraph.text.includes("\n")) {
          return `${path}.content.paragraphs requires one single-line text per paragraph`;
        }
        if (paragraph.kind !== undefined && !["bullet", "number", "plain"].includes(paragraph.kind)) {
          return `${path}.content.paragraphs.kind is invalid`;
        }
        if (paragraph.level !== undefined && (!Number.isInteger(paragraph.level) || paragraph.level < 0 || paragraph.level > 4)) {
          return `${path}.content.paragraphs.level must be an integer from 0 to 4`;
        }
      }
      if (paragraphs.map((p) => (p as Paragraph).text).join("\n") !== (element.content.text ?? "")) {
        return `${path}.content.paragraphs must match content.text`;
      }
    }
    const source = element.content.src;
    if (element.type === "image" && typeof source === "string" && /^\s*(?:javascript|vbscript):/i.test(source)) {
      return `${path}.content.src uses an unsafe URL scheme`;
    }
  }

  if (element.type === "line" || element.type === "connector") {
    const fromError = validateEndpoint(element.from, elementIds, `${path}.from`);
    if (fromError) return fromError;
    const toError = validateEndpoint(element.to, elementIds, `${path}.to`);
    if (toError) return toError;
  }
  return null;
}

function validationError(value: unknown): string | null {
  if (!isRecord(value)) return "Document must be an object";
  if (value.format !== "paperdom") return "format must be paperdom";
  if (value.version !== "0.1") return "version must be 0.1";
  if (!isNonEmptyString(value.id)) return "id must be a non-empty string";
  if (typeof value.title !== "string") return "title must be a string";
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return "revision must be a non-negative integer";
  if (value.powerPointSource !== undefined) {
    const source = value.powerPointSource;
    if (!isRecord(source) || typeof source.base64 !== 'string' || source.base64.length > Math.ceil(MAX_PPTX_SOURCE_BYTES / 3) * 4 || (source.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.base64)) || !source.base64 || !/^[a-f0-9]{64}$/.test(String(source.sha256)) || !/^[a-f0-9]{64}$/.test(String(source.modelSha256))) return 'Invalid retained PowerPoint source';
  }
  if (!isRecord(value.metadata) || !isNonEmptyString(value.metadata.createdAt) || !isNonEmptyString(value.metadata.updatedAt)) {
    return "metadata must contain createdAt and updatedAt strings";
  }
  if (!Array.isArray(value.plugins)) return "plugins must be an array";
  const pluginIds = new Set<string>();
  for (let index = 0; index < value.plugins.length; index += 1) {
    const plugin = value.plugins[index];
    if (!isRecord(plugin) || !isNonEmptyString(plugin.id) || !isNonEmptyString(plugin.version)) {
      return `plugins[${index}] must contain id and version strings`;
    }
    if (pluginIds.has(plugin.id)) return `plugins[${index}].id is duplicated`;
    pluginIds.add(plugin.id);
    // Declarative manifest: optional name/description plus typed field labels. No executable plugin surface.
    for (const key of ["name", "description"]) if (plugin[key] !== undefined && typeof plugin[key] !== "string") return `plugins[${index}].${key} must be a string`;
    if (plugin.fields !== undefined) {
      if (!Array.isArray(plugin.fields) || plugin.fields.length > 20) return `plugins[${index}].fields must contain at most 20 fields`;
      for (const field of plugin.fields) {
        if (!isRecord(field) || !isNonEmptyString(field.key) || !safeIdentifier(field.key) || typeof field.label !== "string") {
          return `plugins[${index}].fields contains an invalid field`;
        }
        if (field.type !== undefined && field.type !== "text" && field.type !== "color") return `plugins[${index}].fields.type is invalid`;
      }
    }
  }
  if (!Array.isArray(value.pages) || value.pages.length === 0) return "pages must be a non-empty array";

  if (value.library !== undefined) { const error = validateLibrary(value.library, validateElement); if (error) return error; }
  if (value.theme !== undefined) { const error = validateTheme(value.theme); if (error) return error; }
  if(value.masters!==undefined){if(!Array.isArray(value.masters)||value.masters.length>100)return "masters must contain at most 100 pages";
    if(value.masters.length){const error=validationError({...value,masters:undefined,pages:value.masters});if(error)return `masters: ${error}`;if(value.masters.some(m=>isRecord(m)&&m.masterId!==undefined))return "Masters cannot inherit other masters";}}
  const pageIds = new Set<string>();
  const documentElementIds = new Set<string>();
  for (let pageIndex = 0; pageIndex < value.pages.length; pageIndex += 1) {
    const page = value.pages[pageIndex];
    const path = `pages[${pageIndex}]`;
    if (!isRecord(page)) return `${path} must be an object`;
    if (!isNonEmptyString(page.id)) return `${path}.id must be a non-empty string`;
    if (pageIds.has(page.id)) return `${path}.id is duplicated`;
    pageIds.add(page.id);
    if (typeof page.name !== "string") return `${path}.name must be a string`;
    if (page.hidden !== undefined && typeof page.hidden !== 'boolean') return `${path}.hidden must be boolean`;
    if (page.transition !== undefined && !['none','fade','slide'].includes(page.transition as string)) return `${path}.transition is invalid`;
    if (page.advanceSeconds !== undefined && (!isFiniteNumber(page.advanceSeconds)||page.advanceSeconds<0||page.advanceSeconds>3600)) return `${path}.advanceSeconds must be 0–3600`;
    if(page.inheritBackground!==undefined&&typeof page.inheritBackground!=="boolean")return `${path}.inheritBackground must be boolean`;
    if(page.comments!==undefined){
      if(!Array.isArray(page.comments)||page.comments.length>200)return `${path}.comments must contain at most 200 comments`;
      const commentIds=new Set<string>();
      for(const comment of page.comments){
        if(!isRecord(comment)||!isNonEmptyString(comment.id)||commentIds.has(comment.id)||typeof comment.author!=="string"||typeof comment.text!=="string"||(comment.resolved!==undefined&&typeof comment.resolved!=="boolean")||!isNonEmptyString(comment.createdAt))return `${path}.comments contains an invalid comment`;
        commentIds.add(comment.id);
        if(comment.elementId!==undefined&&(!isNonEmptyString(comment.elementId)||!Array.isArray(page.elements)||!page.elements.some(e=>isRecord(e)&&e.id===comment.elementId)))return `${path}.comments.elementId must reference an element on the page`;
      }
    }
    if(page.masterId!==undefined&&(!isNonEmptyString(page.masterId)||!Array.isArray(value.masters)||!value.masters.some(m=>isRecord(m)&&m.id===page.masterId)))return `${path}.masterId is invalid`;
    if(page.animations!==undefined){if(!Array.isArray(page.animations)||page.animations.length>200)return `${path}.animations is invalid`;const ids=new Set();for(const c of page.animations){if(!isRecord(c)||!isNonEmptyString(c.id)||ids.has(c.id)||!Array.isArray(page.elements)||!page.elements.some(e=>isRecord(e)&&e.id===c.elementId)||!['appear','fade-in','fade-out','fly-in','zoom','spin','pulse','move'].includes(String(c.effect))||!['click','with-previous','after-previous'].includes(String(c.trigger))||!isFiniteNumber(c.duration)||c.duration<0||c.duration>60||!isFiniteNumber(c.delay)||c.delay<0||c.delay>3600||['dx','dy'].some(k=>c[k]!==undefined&&!isFiniteNumber(c[k])))return `${path}.animations contains an invalid cue`;ids.add(c.id);}}
    if (page.notes !== undefined && typeof page.notes !== "string") return `${path}.notes must be a string`;
    if (!isRecord(page.size) || !isFiniteNumber(page.size.width) || !isFiniteNumber(page.size.height) || page.size.width <= 0 || page.size.height <= 0) {
      return `${path}.size must contain positive finite dimensions`;
    }
    if (!isRecord(page.background) || typeof page.background.color !== "string") return `${path}.background.color must be a string`;
    if (/\b(?:url|image-set)\s*\(/i.test(page.background.color)) return `${path}.background.color cannot load an external resource`;
    if (!Array.isArray(page.elements)) return `${path}.elements must be an array`;

    const elementIds = new Set<string>();
    for (let elementIndex = 0; elementIndex < page.elements.length; elementIndex += 1) {
      const element = page.elements[elementIndex];
      if (!isRecord(element) || !isNonEmptyString(element.id)) return `${path}.elements[${elementIndex}].id must be a non-empty string`;
      if (elementIds.has(element.id) || documentElementIds.has(element.id)) return `${path}.elements[${elementIndex}].id is duplicated`;
      elementIds.add(element.id);
      documentElementIds.add(element.id);
    }
    for (let elementIndex = 0; elementIndex < page.elements.length; elementIndex += 1) {
      const error = validateElement(page.elements[elementIndex], elementIds, `${path}.elements[${elementIndex}]`);
      if (error) return error;
      const instanceError = validateInstance(page.elements[elementIndex] as CanvasElement, value.library as ComponentLibrary | undefined, (value.theme as Theme | undefined) ?? defaultTheme, validateElement);
      if (instanceError) return instanceError;
    }
  }
  if(value.pages.every(p=>isRecord(p)&&p.hidden===true))return "Keep at least one slide visible";
  return null;
}

export function parsePaperDOMDocument(value: unknown): DocumentParseResult {
  const normalized = normalizeCandidate(value);
  const error = validationError(normalized);
  if (error) return { ok: false, error };
  return { ok: true, document: normalized as PaperDOMDocument };
}

/**
 * Versioned entry point for third-party readers. Accepts every released
 * document version and upgrades it to the current one. New versions append a
 * migration step here before validation learns about them.
 */
export const DOCUMENT_VERSIONS = ["0.1"] as const;
export const CURRENT_DOCUMENT_VERSION = "0.1";
export type DocumentMigrationResult =
  | { ok: true; document: PaperDOMDocument; migratedFrom?: string }
  | { ok: false; error: string };

export function migrateDocument(value: unknown): DocumentMigrationResult {
  if (!isRecord(value)) return { ok: false, error: "Document must be an object" };
  const from = value.version;
  if (from !== undefined && !(DOCUMENT_VERSIONS as readonly string[]).includes(String(from))) {
    return { ok: false, error: `Unsupported document version: ${String(from)}. Supported versions: ${DOCUMENT_VERSIONS.join(", ")}` };
  }
  const result = parsePaperDOMDocument(value);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, document: result.document, ...(from !== undefined && from !== CURRENT_DOCUMENT_VERSION ? { migratedFrom: String(from) } : {}) };
}

export function isPaperDOMDocument(value: unknown): value is PaperDOMDocument {
  return validationError(value) === null;
}

export function documentStorageKey(documentId: string): string {
  return `paperdom:${documentId}`;
}

export function documentRestoreKeys(lastDocumentId?: string | null): string[] {
  return [...new Set([
    lastDocumentId ? documentStorageKey(lastDocumentId) : null,
    "paperdom:doc_paperdom_demo",
    "canvasdoc:doc_canvasdoc_demo",
  ].filter((key): key is string => Boolean(key)))];
}

type TransactionErrorCode = "revision_conflict" | "invalid_transaction" | "invalid_operation" | "invalid_document";

function transactionError(
  document: PaperDOMDocument,
  error: TransactionErrorCode,
  message: string,
  operationIndex?: number,
): AgentTransactionResult {
  return { ok: false, error, revision: document.revision, message, ...(operationIndex === undefined ? {} : { operationIndex }) };
}

export function applyDocumentTransaction(
  document: PaperDOMDocument,
  payload: unknown,
  defaultPageId: string,
  now = new Date().toISOString(),
): AgentTransactionResult {
  if (!isRecord(payload)) return transactionError(document, "invalid_transaction", "Transaction payload must be an object");
  if (payload.expectedRevision !== undefined && !Number.isSafeInteger(payload.expectedRevision)) {
    return transactionError(document, "invalid_transaction", "expectedRevision must be an integer");
  }
  if (payload.expectedRevision !== undefined && payload.expectedRevision !== document.revision) {
    return transactionError(document, "revision_conflict", `Expected revision ${String(payload.expectedRevision)}, current revision is ${document.revision}`);
  }
  if (!Array.isArray(payload.operations) || payload.operations.length === 0) {
    return transactionError(document, "invalid_transaction", "operations must be a non-empty array");
  }
  if (payload.description !== undefined && typeof payload.description !== "string") {
    return transactionError(document, "invalid_transaction", "description must be a string");
  }
  if (payload.actor !== undefined && (!isRecord(payload.actor) || !isNonEmptyString(payload.actor.id) ||
    !isNonEmptyString(payload.actor.name) || (payload.actor.type !== "human" && payload.actor.type !== "agent"))) {
    return transactionError(document, "invalid_transaction", "actor requires id, name, and human or agent type");
  }

  const operations = payload.operations as unknown[];
  const next: PaperDOMDocument = structuredClone(document);
  const changed = new Set<string>();
  const supportedOperations = new Set(["patchDocument", "createElement", "patchElement", "deleteElements", "replaceText", "createPage", "duplicatePage", "patchPage", "deletePage", "reorderPages", "setLibrary", "setTheme", "setMasters", "duplicateElements", "moveElements", "alignElements", "distributeElements", "reorderElements", "styleAll", "replaceTextAll", "zOrderElements"]);

  for (let index = 0; index < operations.length; index += 1) {
    const candidateOperation = operations[index];
    if (!isRecord(candidateOperation) || typeof candidateOperation.op !== "string" || !supportedOperations.has(candidateOperation.op)) {
      return transactionError(document, "invalid_operation", "Unsupported operation", index);
    }
    const operation: Record<string, unknown> = candidateOperation;
    if (operation.op === "patchDocument") {
      if (!isRecord(operation.patch) || Object.keys(operation.patch).some((key) => key !== "title") ||
        (operation.patch.title !== undefined && typeof operation.patch.title !== "string")) {
        return transactionError(document, "invalid_operation", "patchDocument supports title only", index);
      }
      if (operation.patch.title !== undefined) next.title = operation.patch.title;
      continue;
    }
    if(operation.op==="setMasters"){next.masters=structuredClone(operation.masters) as CanvasPage[];continue;}
    if (operation.op === "setLibrary") {
      const error = validateLibrary(operation.library, validateElement);
      if (error) return transactionError(document, "invalid_operation", error, index);
      next.library = structuredClone(operation.library) as ComponentLibrary;
      continue;
    }
    if (operation.op === "setTheme") {
      const error = validateTheme(operation.theme);
      if (error) return transactionError(document, "invalid_operation", error, index);
      const theme = structuredClone(operation.theme) as Theme;
      const mapped = applyThemeTokens(next, next.theme ?? defaultTheme, theme);
      Object.assign(next, mapped);
      next.theme = theme;
      for (const page of next.pages) for (const element of page.elements) changed.add(element.id);
      continue;
    }
    if (operation.op === "createPage") {
      if (!isRecord(operation.page) || !isNonEmptyString(operation.page.id) || !Array.isArray(operation.page.elements) ||
        operation.page.elements.some((element) => !isRecord(element) || !isNonEmptyString(element.id))) {
        return transactionError(document, "invalid_operation", "createPage requires a page with an id and elements", index);
      }
      if (next.pages.some((page) => page.id === (operation.page as CanvasPage).id)) {
        return transactionError(document, "invalid_operation", "Page id already exists", index);
      }
      const position = operation.index === undefined ? next.pages.length : operation.index;
      if (!Number.isInteger(position) || (position as number) < 0 || (position as number) > next.pages.length) {
        return transactionError(document, "invalid_operation", "Page index is out of range", index);
      }
      const created = structuredClone(operation.page) as CanvasPage;
      next.pages.splice(position as number, 0, created);
      created.elements.forEach((element) => changed.add(element.id));
      continue;
    }
    if (operation.op === "reorderPages") {
      const ids = operation.pageIds;
      if (!Array.isArray(ids) || ids.length !== next.pages.length || new Set(ids).size !== ids.length ||
        ids.some((id) => !next.pages.some((page) => page.id === id))) {
        return transactionError(document, "invalid_operation", "pageIds must contain each page id exactly once", index);
      }
      next.pages = ids.map((id) => next.pages.find((page) => page.id === id)!);
      continue;
    }
    const pageId = operation.pageId === undefined ? defaultPageId : operation.pageId;
    if (!isNonEmptyString(pageId)) return transactionError(document, "invalid_operation", "pageId must be a non-empty string", index);
    const page = next.pages.find((candidate) => candidate.id === pageId);
    if (!page) return transactionError(document, "invalid_operation", `Page ${pageId} was not found`, index);

    if (operation.op === "deletePage") {
      if (next.pages.length === 1) return transactionError(document, "invalid_operation", "Cannot delete the last page", index);
      page.elements.forEach((element) => changed.add(element.id));
      next.pages = next.pages.filter((candidate) => candidate.id !== pageId);
      continue;
    }
    if (operation.op === "duplicatePage") {
      if (operation.id !== undefined && !isNonEmptyString(operation.id)) {
        return transactionError(document, "invalid_operation", "duplicatePage id must be a non-empty string", index);
      }
      if (operation.name !== undefined && typeof operation.name !== "string") {
        return transactionError(document, "invalid_operation", "duplicatePage name must be a string", index);
      }
      const newId = (operation.id as string | undefined) ?? randomId("page");
      if (next.pages.some((candidate) => candidate.id === newId)) {
        return transactionError(document, "invalid_operation", `Page id ${newId} already exists`, index);
      }
      const sourceIndex = next.pages.indexOf(page);
      const position = operation.index === undefined ? sourceIndex + 1 : operation.index;
      if (!Number.isInteger(position) || (position as number) < 0 || (position as number) > next.pages.length) {
        return transactionError(document, "invalid_operation", "Page index is out of range", index);
      }
      const copy = structuredClone(page);
      const idMap = new Map(copy.elements.map((element) => [element.id, randomId(element.type)]));
      copy.elements.forEach((element) => {
        element.id = idMap.get(element.id)!;
        for (const side of ["from", "to"] as const) {
          if (element[side]?.elementId) element[side] = { ...element[side], elementId: idMap.get(element[side]!.elementId!) ?? element[side]!.elementId };
        }
      });
      const groupMap = new Map([...new Set(copy.elements.filter((element) => element.groupId).map((element) => element.groupId!))].map((groupId) => [groupId, randomId("group")]));
      copy.elements.forEach((element) => { if (element.groupId) element.groupId = groupMap.get(element.groupId); });
      copy.animations = copy.animations?.map((cue) => ({ ...cue, id: randomId("anim"), elementId: idMap.get(cue.elementId) ?? cue.elementId }));
      copy.id = newId;
      copy.name = (operation.name as string | undefined) ?? `${page.name} copy`;
      next.pages.splice(position as number, 0, copy);
      copy.elements.forEach((element) => changed.add(element.id));
      continue;
    }
    if (operation.op === "patchPage") {
      if (!isRecord(operation.patch) || Object.keys(operation.patch).some((key) => !["name", "notes", "background", "size", "hidden", "transition", "advanceSeconds", "masterId", "animations", "inheritBackground", "comments"].includes(key))) {
        return transactionError(document, "invalid_operation", "patchPage supports name, notes, background, size, hidden, transition, advanceSeconds, masterId, animations, inheritBackground, and comments", index);
      }
      Object.assign(page, structuredClone(operation.patch));
      continue;
    }

    if (operation.op === "createElement") {
      if (!isRecord(operation.element)) return transactionError(document, "invalid_operation", "createElement requires element", index);
      const element = structuredClone(operation.element) as CanvasElement;
      if (!isNonEmptyString(element.id)) return transactionError(document, "invalid_operation", "Created element needs an id", index);
      if (next.pages.some((candidate) => candidate.elements.some((item) => item.id === element.id))) {
        return transactionError(document, "invalid_operation", `Element id ${element.id} already exists`, index);
      }
      // Omitted style fields inherit the document theme rather than fixed defaults.
      if (!isRecord(operation.element.style)) element.style = themeElementStyle(next);
      else if (Object.keys(operation.element.style).some((key) => !Object.hasOwn(DEFAULT_STYLE, key))) {
        return transactionError(document, "invalid_operation", `Unknown style field on ${element.id}`, index);
      }
      page.elements.push(element);
      changed.add(element.id);
      continue;
    }

    if (operation.op === "duplicateElements") {
      if (!Array.isArray(operation.ids) || !operation.ids.length || operation.ids.some((id) => !isNonEmptyString(id))) {
        return transactionError(document, "invalid_operation", "duplicateElements requires a non-empty string id array", index);
      }
      if (operation.offset !== undefined && !isFiniteNumber(operation.offset)) {
        return transactionError(document, "invalid_operation", "duplicateElements offset must be finite", index);
      }
      if (operation.idPrefix !== undefined && !isNonEmptyString(operation.idPrefix)) {
        return transactionError(document, "invalid_operation", "duplicateElements idPrefix must be a non-empty string", index);
      }
      const missing = (operation.ids as string[]).filter((id) => !page.elements.some((item) => item.id === id));
      if (missing.length) return transactionError(document, "invalid_operation", `Elements not found: ${missing.join(", ")}`, index);
      const prefix = (operation.idPrefix as string | undefined) ?? randomId("copy");
      const copies = copyElements(page, operation.ids as string[], prefix, isFiniteNumber(operation.offset) ? (operation.offset as number) : 20);
      if (copies.some((copy) => next.pages.some((candidate) => candidate.elements.some((item) => item.id === copy.id)))) {
        return transactionError(document, "invalid_operation", "Duplicate element id collision", index);
      }
      page.elements.push(...copies);
      copies.forEach((copy) => changed.add(copy.id));
      continue;
    }

    if (operation.op === "moveElements") {
      if (!isNonEmptyString(operation.toPageId)) {
        return transactionError(document, "invalid_operation", "moveElements requires toPageId", index);
      }
      if (!Array.isArray(operation.ids) || !operation.ids.length || operation.ids.some((id) => !isNonEmptyString(id))) {
        return transactionError(document, "invalid_operation", "moveElements requires a non-empty string id array", index);
      }
      const target = next.pages.find((candidate) => candidate.id === operation.toPageId);
      if (!target) return transactionError(document, "invalid_operation", `Page ${operation.toPageId} was not found`, index);
      const moving = new Set(operation.ids as string[]);
      const missing = [...moving].filter((id) => !page.elements.some((item) => item.id === id));
      if (missing.length) return transactionError(document, "invalid_operation", `Elements not found: ${missing.join(", ")}`, index);
      const moved = page.elements.filter((item) => moving.has(item.id));
      const samePage = target === page;
      if (!samePage) {
        const snap = structuredClone(page.elements);
        for (const element of moved) {
          for (const side of ["from", "to"] as const) {
            const endpoint = element[side];
            if (endpoint?.elementId && !moving.has(endpoint.elementId)) {
              element[side] = { ...endpointPoint(endpoint, snap) };
            }
          }
        }
        for (const element of page.elements) {
          if (moving.has(element.id)) continue;
          for (const side of ["from", "to"] as const) {
            const endpoint = element[side];
            if (endpoint?.elementId && moving.has(endpoint.elementId)) {
              element[side] = { ...endpointPoint(endpoint, snap) };
              changed.add(element.id);
            }
          }
        }
      }
      page.elements = page.elements.filter((item) => !moving.has(item.id));
      target.elements.push(...moved);
      if (!samePage) {
        const carried = page.animations?.filter((cue) => moving.has(cue.elementId)) ?? [];
        if (carried.length) {
          page.animations = page.animations!.filter((cue) => !moving.has(cue.elementId));
          target.animations = [...(target.animations ?? []), ...carried];
        }
      }
      moved.forEach((element) => changed.add(element.id));
      continue;
    }

    if (operation.op === "alignElements") {
      const mode = operation.mode;
      if (!["left", "centerX", "right", "top", "centerY", "bottom"].includes(mode as string)) {
        return transactionError(document, "invalid_operation", "alignElements requires mode left, centerX, right, top, centerY, or bottom", index);
      }
      if (operation.relative !== undefined && operation.relative !== "selection" && operation.relative !== "page") {
        return transactionError(document, "invalid_operation", "alignElements relative must be selection or page", index);
      }
      const targetIds = operation.ids === undefined ? page.elements.filter((e) => !e.locked && !e.hidden).map((e) => e.id) : operation.ids;
      if (!Array.isArray(targetIds) || !targetIds.length || targetIds.some((id) => !isNonEmptyString(id))) {
        return transactionError(document, "invalid_operation", "alignElements requires a non-empty id array", index);
      }
      const targets = page.elements.filter((item) => targetIds.includes(item.id) && !item.locked && !item.hidden);
      if (targets.length < 2) return transactionError(document, "invalid_operation", "alignElements needs at least two movable elements", index);
      const relative = (operation.relative as string | undefined) ?? "selection";
      const bounds = relative === "page"
        ? { left: 0, right: page.size.width, top: 0, bottom: page.size.height }
        : {
          left: Math.min(...targets.map((e) => e.frame.x)),
          right: Math.max(...targets.map((e) => e.frame.x + e.frame.w)),
          top: Math.min(...targets.map((e) => e.frame.y)),
          bottom: Math.max(...targets.map((e) => e.frame.y + e.frame.h)),
        };
      for (const element of targets) {
        const { x, y, w, h } = element.frame;
        const dx = mode === "left" ? bounds.left - x : mode === "centerX" ? (bounds.left + bounds.right) / 2 - (x + w / 2) : mode === "right" ? bounds.right - (x + w) : 0;
        const dy = mode === "top" ? bounds.top - y : mode === "centerY" ? (bounds.top + bounds.bottom) / 2 - (y + h / 2) : mode === "bottom" ? bounds.bottom - (y + h) : 0;
        if (dx || dy) page.elements[page.elements.indexOf(element)] = translateElement(element, dx, dy);
        changed.add(element.id);
      }
      continue;
    }

    if (operation.op === "distributeElements") {
      if (operation.axis !== "x" && operation.axis !== "y") {
        return transactionError(document, "invalid_operation", "distributeElements requires axis x or y", index);
      }
      if (!Array.isArray(operation.ids) || operation.ids.length < 3 || operation.ids.some((id) => !isNonEmptyString(id))) {
        return transactionError(document, "invalid_operation", "distributeElements requires at least three element ids", index);
      }
      const distributeIds = operation.ids as string[];
      const ordered = page.elements.filter((item) => distributeIds.includes(item.id) && !item.locked && !item.hidden)
        .sort((a, b) => operation.axis === "x" ? a.frame.x - b.frame.x : a.frame.y - b.frame.y);
      if (ordered.length < 3) return transactionError(document, "invalid_operation", "distributeElements needs at least three movable elements", index);
      const first = ordered[0]!;
      const last = ordered[ordered.length - 1]!;
      const gap = operation.axis === "x"
        ? (last.frame.x + last.frame.w - first.frame.x - ordered.reduce((sum, e) => sum + e.frame.w, 0)) / (ordered.length - 1)
        : (last.frame.y + last.frame.h - first.frame.y - ordered.reduce((sum, e) => sum + e.frame.h, 0)) / (ordered.length - 1);
      let cursor = operation.axis === "x" ? first.frame.x : first.frame.y;
      const positions = new Map<string, number>();
      for (const element of ordered) {
        positions.set(element.id, cursor);
        cursor += (operation.axis === "x" ? element.frame.w : element.frame.h) + gap;
      }
      for (const element of ordered) {
        const position = positions.get(element.id)!;
        const dx = operation.axis === "x" ? position - element.frame.x : 0;
        const dy = operation.axis === "y" ? position - element.frame.y : 0;
        if (dx || dy) page.elements[page.elements.indexOf(element)] = translateElement(element, dx, dy);
        changed.add(element.id);
      }
      continue;
    }

    if (operation.op === "reorderElements") {
      if (!Array.isArray(operation.order) || operation.order.length !== page.elements.length ||
        new Set(operation.order).size !== operation.order.length ||
        operation.order.some((id) => !page.elements.some((item) => item.id === id))) {
        return transactionError(document, "invalid_operation", "order must contain each element id on the page exactly once", index);
      }
      page.elements = (operation.order as string[]).map((id) => page.elements.find((item) => item.id === id)!);
      page.elements.forEach((element) => changed.add(element.id));
      continue;
    }

    if (operation.op === "styleAll") {
      if (!isRecord(operation.patch) || Object.keys(operation.patch).some((key) => !["style", "hidden", "locked", "name"].includes(key))) {
        return transactionError(document, "invalid_operation", "styleAll patch supports style, hidden, locked, and name", index);
      }
      const patch = operation.patch as Pick<CanvasElementPatch, "style" | "hidden" | "locked" | "name">;
      if (operation.scope !== undefined && operation.scope !== "page" && operation.scope !== "document") {
        return transactionError(document, "invalid_operation", "styleAll scope must be page or document", index);
      }
      const match = (operation.match ?? {}) as Record<string, unknown>;
      if (match.type !== undefined && !KINDS.has(match.type as Kind)) return transactionError(document, "invalid_operation", "styleAll match.type is invalid", index);
      const pages = (operation.scope ?? "page") === "document" ? next.pages : [page];
      for (const target of pages) {
        for (const element of target.elements) {
          if (match.type !== undefined && element.type !== match.type) continue;
          if (match.groupId !== undefined && element.groupId !== match.groupId) continue;
          if (match.hidden !== undefined && Boolean(element.hidden) !== match.hidden) continue;
          if (match.locked !== undefined && Boolean(element.locked) !== match.locked) continue;
          const stylePatch = patch.style;
          target.elements[target.elements.indexOf(element)] = {
            ...element,
            ...(stylePatch ? { style: { ...element.style, ...structuredClone(stylePatch) } } : {}),
            ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}),
            ...(patch.locked !== undefined ? { locked: patch.locked } : {}),
            ...(patch.name !== undefined ? { name: patch.name } : {}),
          };
          changed.add(element.id);
        }
      }
      continue;
    }

    if (operation.op === "replaceTextAll") {
      if (typeof operation.find !== "string" || !operation.find.length) {
        return transactionError(document, "invalid_operation", "replaceTextAll requires a find string", index);
      }
      if (operation.replace !== undefined && typeof operation.replace !== "string") {
        return transactionError(document, "invalid_operation", "replaceTextAll replace must be a string", index);
      }
      if (operation.scope !== undefined && operation.scope !== "page" && operation.scope !== "document") {
        return transactionError(document, "invalid_operation", "replaceTextAll scope must be page or document", index);
      }
      const replacement = operation.replace ?? "";
      const sensitive = Boolean(operation.caseSensitive);
      const find = sensitive ? operation.find : operation.find.toLowerCase();
      const replaceIn = (value: string): string | null => {
        const haystack = sensitive ? value : value.toLowerCase();
        if (!haystack.includes(find)) return null;
        if (!sensitive) {
          // Replace case-insensitively while preserving the original casing boundaries.
          let result = "";
          let cursor = 0;
          const lowered = value.toLowerCase();
          while (cursor <= lowered.length - find.length) {
            const at = lowered.indexOf(find, cursor);
            if (at < 0) break;
            result += value.slice(cursor, at) + replacement;
            cursor = at + find.length;
          }
          return result + value.slice(cursor);
        }
        return value.split(find).join(replacement);
      };
      const pages = (operation.scope ?? "page") === "document" ? next.pages : [page];
      for (const target of pages) {
        for (const element of target.elements) {
          let touched = false;
          const nextContent = { ...element.content };
          if (typeof nextContent.text === "string") {
            const replaced = replaceIn(nextContent.text);
            if (replaced !== null) {
              nextContent.text = replaced;
              if (element.runs) element.runs = replaceRunText(element.runs, replaced);
              touched = true;
            }
          }
          if (nextContent.paragraphs) {
            let changedParagraphs = false;
            nextContent.paragraphs = nextContent.paragraphs.map((paragraph) => {
              const replaced = replaceIn(paragraph.text);
              if (replaced === null) return paragraph;
              changedParagraphs = true;
              return { ...paragraph, text: replaced };
            });
            if (changedParagraphs) touched = true;
          }
          if (operation.includeTables !== false && element.table) {
            const rows = element.table.rows.map((row) => row.map((cell) => {
              const replaced = replaceIn(cell);
              return replaced === null ? cell : (touched = true, replaced);
            }));
            element.table = { ...element.table, rows };
          }
          if (operation.includeComponents !== false && element.component) {
            const props = { ...element.component.props };
            for (const key of Object.keys(props)) {
              const replaced = replaceIn(props[key] ?? "");
              if (replaced !== null) { props[key] = replaced; touched = true; }
            }
            element.component = { ...element.component, props };
          }
          if (touched) {
            element.content = nextContent;
            changed.add(element.id);
          }
        }
      }
      continue;
    }

    if (operation.op === "zOrderElements") {
      if (!["front", "back", "forward", "backward"].includes(operation.to as string)) {
        return transactionError(document, "invalid_operation", "zOrderElements to must be front, back, forward, or backward", index);
      }
      if (!Array.isArray(operation.ids) || !operation.ids.length || operation.ids.some((id) => !isNonEmptyString(id))) {
        return transactionError(document, "invalid_operation", "zOrderElements requires a non-empty id array", index);
      }
      const zOrderIds = operation.ids as string[];
      const requested = page.elements.filter((item) => zOrderIds.includes(item.id) && !item.locked);
      if (requested.length !== zOrderIds.length) {
        return transactionError(document, "invalid_operation", "zOrderElements ids must be unlocked elements on the page", index);
      }
      if (operation.to === "front" || operation.to === "back") {
        const zs = page.elements.filter((item) => !zOrderIds.includes(item.id)).map((item) => item.z);
        const base = operation.to === "front" ? Math.max(0, ...zs) : Math.min(0, ...zs);
        const ordered = [...requested].sort((a, b) => a.z - b.z);
        ordered.forEach((item, order) => {
          page.elements[page.elements.indexOf(item)] = { ...item, z: operation.to === "front" ? base + order + 1 : base - (ordered.length - order) };
          changed.add(item.id);
        });
      } else {
        const forward = operation.to === "forward";
        const sorted = [...page.elements].sort((a, b) => a.z - b.z);
        const indexOrder = forward ? sorted : [...sorted].reverse();
        for (const item of indexOrder) {
          if (!zOrderIds.includes(item.id)) continue;
          const neighbour = indexOrder[indexOrder.indexOf(item) + (forward ? 1 : -1)];
          if (!neighbour || zOrderIds.includes(neighbour.id)) continue;
          const originalZ = item.z;
          page.elements[page.elements.indexOf(item)] = { ...item, z: neighbour.z };
          page.elements[page.elements.indexOf(neighbour)] = { ...neighbour, z: originalZ };
          changed.add(item.id);
        }
      }
      continue;
    }

    if (operation.op === "patchElement") {
      if (!isNonEmptyString(operation.elementId) || !isRecord(operation.patch)) {
        return transactionError(document, "invalid_operation", "patchElement requires elementId and patch", index);
      }
      const elementIndex = page.elements.findIndex((item) => item.id === operation.elementId);
      if (elementIndex < 0) return transactionError(document, "invalid_operation", `Element ${operation.elementId} was not found`, index);
      const current = page.elements[elementIndex]!;
      const patch = operation.patch as CanvasElementPatch;
      if (patch.style && Object.keys(patch.style).some((key) => !Object.hasOwn(DEFAULT_STYLE, key))) {
        return transactionError(document, "invalid_operation", `Unknown style field in patch for ${operation.elementId}`, index);
      }
      const patched: CanvasElement = {
        ...current,
        ...(patch as Partial<CanvasElement>),
        id: current.id,
        frame: patch.frame ? { ...current.frame, ...patch.frame } : current.frame,
        style: patch.style ? { ...current.style, ...patch.style } : current.style,
        content: patch.content ? { ...current.content, ...patch.content } : current.content,
      } as CanvasElement;
      page.elements[elementIndex] = patched;
      // Text edits keep structured paragraphs aligned per line unless the patch supplies them explicitly.
      if (patch.content?.text !== undefined && patch.content.paragraphs === undefined && current.content?.paragraphs) {
        patched.content = { ...patched.content, paragraphs: resyncParagraphs(current.content.paragraphs, patch.content.text) };
      }
      if(current.runs&&patch.content?.text!==undefined&&patch.runs===undefined)patched.runs=replaceRunText(current.runs,patch.content.text);
      changed.add(current.id);
      continue;
    }

    if (operation.op === "deleteElements") {
      if (!Array.isArray(operation.ids) || operation.ids.some((id) => !isNonEmptyString(id))) {
        return transactionError(document, "invalid_operation", "deleteElements requires a string id array", index);
      }
      const requested = new Set(operation.ids as string[]);
      const present = page.elements.filter((item) => requested.has(item.id));
      const presentIds = new Set(present.map((item) => item.id));
      const missingIds = [...requested].filter((id) => !presentIds.has(id));
      if (missingIds.length) return transactionError(document, "invalid_operation", `Elements not found: ${missingIds.join(", ")}`, index);
      const removedIds = new Set(present.map((item) => item.id));
      page.elements = page.elements.filter((item) => {
        const danglingConnector = Boolean(
          (item.from?.elementId && removedIds.has(item.from.elementId)) ||
          (item.to?.elementId && removedIds.has(item.to.elementId)),
        );
        if (removedIds.has(item.id) || danglingConnector) {
          changed.add(item.id);
          return false;
        }
        return true;
      });
      page.animations=page.animations?.filter(c=>page.elements.some(e=>e.id===c.elementId));
      continue;
    }

    if (!isNonEmptyString(operation.elementId) || typeof operation.text !== "string") {
      return transactionError(document, "invalid_operation", "replaceText requires elementId and text", index);
    }
    const element = page.elements.find((item) => item.id === operation.elementId);
    if (!element) return transactionError(document, "invalid_operation", `Element ${operation.elementId} was not found`, index);
    if (!["text", "shape", "ellipse"].includes(element.type)) {
      return transactionError(document, "invalid_operation", "replaceText only supports text-bearing elements", index);
    }
    if(element.runs)element.runs=replaceRunText(element.runs,operation.text);
    if(element.content?.paragraphs)element.content={...element.content,paragraphs:resyncParagraphs(element.content.paragraphs,operation.text)};
    element.content = { ...element.content, text: operation.text };
    element.name = operation.text.trim().slice(0, 28) || "Text box";
    changed.add(element.id);
  }

  next.revision = document.revision + 1;
  next.metadata.updatedAt = now;
  const parsed = parsePaperDOMDocument(next);
  if (!parsed.ok) return transactionError(document, "invalid_document", parsed.error);
  return {
    ok: true,
    document: parsed.document,
    previousRevision: document.revision,
    revision: parsed.document.revision,
    changedElementIds: [...changed],
  };
}
