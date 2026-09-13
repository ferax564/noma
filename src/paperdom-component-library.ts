// @ts-nocheck — vendored PaperDOM kernel; host policy lives in enterprise-paperdom-host.ts
// Vendored from https://github.com/ferax564/paperDOM/blob/a12198cdad8c7487242834941a34ed5adf5d4d74/app/component-library.ts (MIT). Do not edit to add Noma host policy.
import {replaceRunText} from './paperdom-advanced-model.js';
import type { CanvasElement, CanvasPage, ElementStyle, Frame } from './paperdom-document-model.js';

export type Theme = { accent: string; surface: string; ink: string; muted: string; fontFamily: string };
export const defaultTheme: Theme = { accent: '#6d5dfc', surface: '#f4f3ff', ink: '#172033', muted: '#64748b', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' };
export const themes: Record<string, Theme> = {
  Violet: defaultTheme,
  Ocean: { ...defaultTheme, accent: '#087e8b', surface: '#e9f7f8', ink: '#12313b', muted: '#527078' },
  Ember: { ...defaultTheme, accent: '#c65027', surface: '#fff3eb', ink: '#38251e', muted: '#806457' },
};
export type ComponentInstance = { definitionId: string; props: Record<string, string>; overrides?: Record<string, Partial<ElementStyle>> };
export type ComponentDefinition = {
  id: string; version: string; name: string; category: string; description: string;
  size: { width: number; height: number };
  properties: Record<string, { label: string; default: string }>;
  elements: CanvasElement[];
  bindings: { elementId: string; property: string; field: 'text' | 'src' | 'alt' }[];
  tokens: { elementId: string; field: 'fill' | 'stroke' | 'color' | 'fontFamily'; token: keyof Theme }[];
};
export type SlideTemplate = { id: string; name: string; description: string; page: CanvasPage };
export type ComponentLibrary = { format: 'paperdom-library'; version: '1.0'; name: string; components: ComponentDefinition[]; templates: SlideTemplate[] };
export const baseStyle: ElementStyle = { fill: 'transparent', stroke: 'transparent', strokeWidth: 0, radius: 0, opacity: 1, color: '#172033', fontSize: 20, fontWeight: 500, textAlign: 'left', fontFamily: defaultTheme.fontFamily, fontStyle: 'normal', underline: false, strike: false, lineHeight: 1.25, letterSpacing: 0, verticalAlign: 'middle', padding: 0 };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const safeKey = (v: string) => /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
type ElementValidator = (element: unknown, ids: Set<string>, path: string) => string | null;

/** A declarative format: no scripts, templates, eval, or nested component recursion. */
export function validateLibrary(value: unknown, validate: ElementValidator): string | null {
  if (!record(value) || value.format !== 'paperdom-library' || value.version !== '1.0' || typeof value.name !== 'string' || !Array.isArray(value.components) || !Array.isArray(value.templates)) return 'Invalid component library header';
  if (value.components.length > 200 || value.templates.length > 100) return 'Library exceeds 200 components or 100 templates';
  const ids = new Set<string>();
  for (const c of value.components) {
    if (!record(c) || typeof c.id !== 'string' || !safeKey(c.id) || ids.has(c.id) || typeof c.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(c.version)) return 'Component IDs must be unique and versions must be semver';
    ids.add(c.id);
    if (typeof c.name !== 'string' || typeof c.description !== 'string' || typeof c.category !== 'string' || !record(c.size) || !positive(c.size.width) || !positive(c.size.height) || !record(c.properties) || !Array.isArray(c.elements) || !Array.isArray(c.bindings) || !Array.isArray(c.tokens) || c.elements.length > 200) return `Invalid component ${c.id}`;
    for (const [key, prop] of Object.entries(c.properties)) if (!safeKey(key) || !record(prop) || typeof prop.label !== 'string' || typeof prop.default !== 'string') return `Invalid property ${key}`;
    const nodeIds = new Set<string>();
    for (const e of c.elements) {
      if (!record(e) || typeof e.id !== 'string' || nodeIds.has(e.id) || (typeof e.type !== 'string' || !['text','shape','ellipse','image','line','connector','plugin','table','chart','audio','video'].includes(e.type))) return `Invalid primitive in ${c.id}`;
      nodeIds.add(e.id);
    }
    for (const e of c.elements) { const error = validate(e, nodeIds, `component ${c.id}`); if (error) return error; }
    for (const b of c.bindings) if (!record(b) || !nodeIds.has(b.elementId as string) || typeof b.property !== 'string' || !Object.hasOwn(c.properties, b.property) || (typeof b.field !== 'string' || !['text','src','alt'].includes(b.field))) return `Invalid binding in ${c.id}`;
    for (const t of c.tokens) if (!record(t) || !nodeIds.has(t.elementId as string) || (typeof t.field !== 'string' || !['fill','stroke','color','fontFamily'].includes(t.field)) || typeof t.token !== 'string' || !Object.hasOwn(defaultTheme, t.token) || (t.field === 'fontFamily') !== (t.token === 'fontFamily')) return `Invalid theme token in ${c.id}`;
    // Validate bound defaults too, including image URLs.
    const def = c as unknown as ComponentDefinition;
    const error = validateInstance(makeInstance(def, 'validation'), value as unknown as ComponentLibrary, defaultTheme, validate);
    if (error) return error;
  }
  const templateIds = new Set<string>();
  for (const t of value.templates) {
    if (!record(t) || typeof t.id !== 'string' || !safeKey(t.id) || templateIds.has(t.id) || typeof t.name !== 'string' || typeof t.description !== 'string' || !record(t.page)) return 'Invalid template';
    templateIds.add(t.id);
    const p = t.page;
    if (typeof p.id !== 'string' || typeof p.name !== 'string' || (p.notes !== undefined && typeof p.notes !== 'string') || (p.hidden !== undefined && typeof p.hidden !== 'boolean') || (p.transition !== undefined && !['none','fade','slide'].includes(String(p.transition))) || (p.advanceSeconds !== undefined && (typeof p.advanceSeconds !== 'number' || !Number.isFinite(p.advanceSeconds) || p.advanceSeconds<0 || p.advanceSeconds>3600)) || !record(p.size) || !positive(p.size.width) || !positive(p.size.height) || !record(p.background) || typeof p.background.color !== 'string' || /\b(?:url|image-set)\s*\(/i.test(p.background.color) || !Array.isArray(p.elements) || p.elements.length > 500) return `Invalid template page ${t.id}`;
    const elements = p.elements as CanvasElement[];
    const nodeIds = new Set(elements.map(e => record(e) && typeof e.id === 'string' ? e.id : ''));
    if (nodeIds.has('') || nodeIds.size !== elements.length) return 'Template element IDs must be unique';
    for (const e of elements) {
      const error = validate(e, nodeIds, `template ${t.id}`) || validateInstance(e, value as unknown as ComponentLibrary, defaultTheme, validate);
      if (error) return error;
    }
  }
  return null;
}

export function validateTheme(value: unknown): string | null {
  if (!record(value) || Object.keys(value).length !== Object.keys(defaultTheme).length) return 'Theme must define accent, surface, ink, muted and fontFamily';
  for (const key of Object.keys(defaultTheme)) if (typeof value[key] !== 'string' || !value[key] || /\b(?:url|image-set)\s*\(/i.test(value[key] as string)) return `Invalid theme ${key}`;
  return null;
}

export function validateInstance(element: CanvasElement, library: ComponentLibrary | undefined, theme: Theme, validate: ElementValidator): string | null {
  if (element.type !== 'component') return element.component === undefined ? null : 'Only component elements may have a component instance';
  const instance = element.component;
  if (!record(instance) || typeof instance.definitionId !== 'string' || !record(instance.props)) return 'Invalid component instance';
  const definition = library?.components.find(c => c.id === instance.definitionId);
  if (!definition) return `Missing component definition ${instance.definitionId}`;
  for (const [key, value] of Object.entries(instance.props)) if (!Object.hasOwn(definition.properties, key) || typeof value !== 'string') return `Unknown or invalid component property ${key}`;
  if (instance.overrides !== undefined) {
    if (!record(instance.overrides)) return 'Invalid component overrides';
    for (const [id, style] of Object.entries(instance.overrides)) if (!definition.elements.some(e => e.id === id) || !record(style) || Object.keys(style).some(key => !Object.hasOwn(baseStyle, key) && key !== 'lineStyle')) return `Invalid style override ${id}`;
  }
  const children = resolveComponent(element, library!, theme);
  const ids = new Set(children.map(e => e.id));
  for (const child of children) { const error = validate(child, ids, `instance ${element.id}`); if (error) return error; }
  return null;
}

/** Layout scales with the instance frame; typography scales uniformly by its smaller axis. */
export function resolveComponent(element: CanvasElement, library: ComponentLibrary, theme = defaultTheme): CanvasElement[] {
  const instance = element.component;
  const definition = library.components.find(c => c.id === instance?.definitionId);
  if (!definition || !instance) return [];
  const sx = element.frame.w / definition.size.width, sy = element.frame.h / definition.size.height, scale = Math.min(sx, sy);
  const props = Object.fromEntries(Object.entries(definition.properties).map(([key, p]) => [key, instance.props[key] ?? p.default]));
  return definition.elements.map(raw => {
    const child = structuredClone(raw);
    for (const token of definition.tokens.filter(t => t.elementId === child.id)) child.style[token.field] = theme[token.token];
    Object.assign(child.style, instance.overrides?.[child.id]);
    for (const binding of definition.bindings.filter(b => b.elementId === child.id)) {child.content = { ...child.content, [binding.field]: props[binding.property] };if(binding.field==='text'&&child.runs)child.runs=replaceRunText(child.runs,props[binding.property]);}
    child.frame = { ...child.frame, x: child.frame.x * sx, y: child.frame.y * sy, w: child.frame.w * sx, h: child.frame.h * sy };
    for (const key of ['fontSize','padding','radius','strokeWidth','letterSpacing'] as const) child.style[key] *= scale;
    if(child.runs)for(const run of child.runs)if(run.style?.fontSize)run.style.fontSize*=scale;
    for (const endpoint of [child.from, child.to]) if (endpoint && !endpoint.elementId) { if (endpoint.x !== undefined) endpoint.x *= sx; if (endpoint.y !== undefined) endpoint.y *= sy; }
    return child;
  });
}

export function makeInstance(definition: ComponentDefinition, id: string, frame: Partial<Frame> = {}, props: Record<string,string> = {}): CanvasElement {
  return { id, type: 'component', name: definition.name, frame: { x: 80, y: 160, w: definition.size.width, h: definition.size.height, rotation: 0, ...frame }, z: 10, style: { ...baseStyle }, component: { definitionId: definition.id, props: { ...props } } };
}
export function instantiateTemplate(template: SlideTemplate, id: string): CanvasPage {
  const page = structuredClone(template.page);
  const ids = new Map(page.elements.map((e, index) => [e.id, `${id}_node_${index}`]));
  page.id = id;
  if(page.animations)page.animations=page.animations.map((cue,i)=>({...cue,id:`${id}_cue_${i}`,elementId:ids.get(cue.elementId)!}));
  for (const e of page.elements) { e.id = ids.get(e.id)!; for (const endpoint of [e.from,e.to]) if (endpoint?.elementId) endpoint.elementId = ids.get(endpoint.elementId)!; }
  return page;
}
export function selectionToComponent(elements: CanvasElement[], id: string, name: string): ComponentDefinition {
  if (!elements.length || elements.some(e => e.type === 'component')) throw new Error('Select primitive objects to save as a component.');
  const selectedIds = new Set(elements.map(e => e.id));
  if (elements.some(e => [e.from,e.to].some(p => p?.elementId && !selectedIds.has(p.elementId)))) throw new Error('Include both ends of each connector in your selection.');
  // Rotated bounds and connectors require an explicit frame: keep the first authoring workflow predictable.
  if (elements.some(e => e.frame.rotation !== 0 || ['line','connector'].includes(e.type))) throw new Error('Save unrotated text, shapes, images, or cards. Lines and connectors can be added in library JSON.');
  const x = Math.min(...elements.map(e => e.frame.x)), y = Math.min(...elements.map(e => e.frame.y));
  const width = Math.max(...elements.map(e => e.frame.x + e.frame.w)) - x, height = Math.max(...elements.map(e => e.frame.y + e.frame.h)) - y;
  const result: ComponentDefinition = { id, version: '1.0.0', name, description: 'Saved from your selection', category: 'Your components', size: {width,height}, properties: {}, elements: structuredClone(elements), bindings: [], tokens: [] };
  result.elements.forEach((e,index) => { e.frame.x -= x; e.frame.y -= y; if (typeof e.content?.text === 'string') { const key = `text${index+1}`; result.properties[key] = { label: e.name || key, default: e.content.text }; result.bindings.push({ elementId:e.id, property:key, field:'text' }); } });
  return result;
}
