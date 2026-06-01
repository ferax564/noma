import type { AttrValue, DirectiveNode } from "./ast.js";
import { isDirective, walk } from "./ast.js";
import {
  type DocxControlData,
  type DocxControlDataEntry,
  type DocxTaskDataEntry,
  extractDocxControlData,
} from "./docx-control-data.js";
import { parse } from "./parser.js";
import { patchSource, type PatchOp } from "./patch.js";

export interface DocxControlSyncChange {
  id: string;
  value: string;
  defaultValue: AttrValue;
}

export interface DocxTaskSyncChange {
  id: string;
  checked: boolean;
  attrs: Record<string, AttrValue>;
}

export interface DocxControlSyncResult {
  source: string;
  changes: DocxControlSyncChange[];
  unmatched: DocxControlDataEntry[];
  taskChanges: DocxTaskSyncChange[];
  unmatchedTasks: DocxTaskDataEntry[];
}

export function syncControlDefaultsFromDocx(source: string, buffer: Buffer): DocxControlSyncResult {
  return syncControlDefaultsFromData(source, extractDocxControlData(buffer));
}

export function syncControlDefaultsFromData(source: string, data: DocxControlData): DocxControlSyncResult {
  const doc = parse(source);
  const valuesById = new Map<string, DocxControlDataEntry>();
  for (const control of data.controls) valuesById.set(control.id, control);
  const taskValuesById = new Map<string, DocxTaskDataEntry>();
  for (const task of data.tasks) taskValuesById.set(task.id, task);

  const matched = new Set<string>();
  const matchedTasks = new Set<string>();
  const ops: PatchOp[] = [];
  const changes: DocxControlSyncChange[] = [];
  const taskChanges: DocxTaskSyncChange[] = [];

  for (const node of walk(doc)) {
    if (!isControlDirective(node) || !node.id) continue;
    const entry = valuesById.get(node.id);
    if (!entry) continue;
    matched.add(node.id);
    const defaultValue = defaultAttrValue(node, entry.value);
    if (sameAttrValue(node.attrs.default, defaultValue)) continue;
    ops.push({ op: "update_attribute", id: node.id, key: "default", value: defaultValue });
    changes.push({ id: node.id, value: entry.value, defaultValue });
  }

  for (const node of walk(doc)) {
    if (!isTaskDirective(node) || !node.id) continue;
    const entry = taskValuesById.get(node.id);
    if (!entry) continue;
    matchedTasks.add(node.id);
    const attrs = taskUpdateAttrs(node, entry.checked);
    const updates = Object.entries(attrs);
    if (updates.length === 0) continue;
    for (const [key, value] of updates) {
      ops.push({ op: "update_attribute", id: node.id, key, value });
    }
    taskChanges.push({ id: node.id, checked: entry.checked, attrs });
  }

  return {
    source: ops.length > 0 ? patchSource(source, ops) : source,
    changes,
    unmatched: data.controls.filter((control) => !matched.has(control.id)),
    taskChanges,
    unmatchedTasks: data.tasks.filter((task) => !matchedTasks.has(task.id)),
  };
}

function isControlDirective(node: unknown): node is DirectiveNode {
  return Boolean(node && typeof node === "object" && isDirective(node as DirectiveNode) && (node as DirectiveNode).name === "control");
}

function isTaskDirective(node: unknown): node is DirectiveNode {
  return Boolean(
    node &&
      typeof node === "object" &&
      isDirective(node as DirectiveNode) &&
      ((node as DirectiveNode).name === "agent_task" || (node as DirectiveNode).name === "todo"),
  );
}

function defaultAttrValue(node: DirectiveNode, value: string): AttrValue {
  const clean = value.replace(/\r?\n/g, " ");
  const type = typeof node.attrs.type === "string" ? node.attrs.type.toLowerCase() : "text";
  if (type === "checkbox" || type === "toggle") {
    const normalized = clean.trim().toLowerCase();
    if (["1", "true", "yes", "on", "checked"].includes(normalized)) return "true";
    if (["0", "false", "no", "off", "unchecked"].includes(normalized)) return "false";
    return clean;
  }
  if (type === "number" || type === "slider" || type === "range") {
    const n = Number(clean);
    if (clean.trim() !== "" && Number.isFinite(n)) return n;
  }
  return clean;
}

function taskUpdateAttrs(node: DirectiveNode, checked: boolean): Record<string, AttrValue> {
  const updates: Record<string, AttrValue> = {};
  const status = attrText(node, "status")?.toLowerCase();
  const done = boolAttr(node, "done");
  const isDone = done || isDoneStatus(status);

  if (checked === isDone) return updates;

  if (checked) {
    if (node.attrs.status !== undefined) {
      updates.status = "done";
    } else {
      updates.done = true;
    }
    return updates;
  }

  if (done) updates.done = false;
  if (isDoneStatus(status)) updates.status = "open";
  return updates;
}

function attrText(node: DirectiveNode, key: string): string | undefined {
  const value = node.attrs[key];
  return value === undefined ? undefined : String(value);
}

function boolAttr(node: DirectiveNode, key: string): boolean {
  const value = node.attrs[key];
  return value === true || value === "true" || value === "yes";
}

function isDoneStatus(status: string | undefined): boolean {
  return status === "done" || status === "complete" || status === "completed";
}

function sameAttrValue(current: AttrValue | undefined, next: AttrValue): boolean {
  if (current === undefined) return false;
  if (typeof current === typeof next) return current === next;
  return String(current) === String(next);
}
