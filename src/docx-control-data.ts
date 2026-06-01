import { inflateRawSync } from "node:zlib";

export interface DocxControlDataEntry {
  id: string;
  type?: string;
  label?: string;
  value: string;
}

export interface DocxTaskDataEntry {
  id: string;
  checked: boolean;
}

export interface DocxControlData {
  controls: DocxControlDataEntry[];
  tasks: DocxTaskDataEntry[];
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function extractDocxControlData(buffer: Buffer): DocxControlData {
  const controls: DocxControlDataEntry[] = [];
  const entries = readDocxZipEntries(buffer);
  for (const [name, data] of entries) {
    if (!isCustomXmlDataPart(name)) continue;
    const xml = data.toString("utf8");
    if (!xml.includes("urn:noma:controls")) continue;
    controls.push(...parseControlDataXml(xml));
  }
  const storyXmlParts = wordControlStoryXmlParts(entries);
  const visibleControls = storyXmlParts.flatMap(parseVisibleControlXml);
  const tasks = storyXmlParts.flatMap(parseTaskControlXml);
  return {
    controls: mergeVisibleControlValues(controls, visibleControls),
    tasks: mergeTaskControlValues(tasks),
  };
}

export function readDocxZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  for (const entry of readCentralDirectory(buffer)) {
    const data = readZipEntryData(buffer, entry);
    entries.set(entry.name, data);
  }
  return entries;
}

function readCentralDirectory(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === undefined) throw new Error("DOCX ZIP end-of-central-directory not found");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error("DOCX ZIP central directory is invalid");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buffer.length) throw new Error("DOCX ZIP central directory entry is truncated");
    const name = buffer.subarray(nameStart, nameEnd).toString("utf8");
    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset = nameEnd + extraLen + commentLen;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number | undefined {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset;
  }
  return undefined;
}

function readZipEntryData(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIG) {
    throw new Error(`DOCX ZIP local header is invalid for ${entry.name}`);
  }
  const nameLen = buffer.readUInt16LE(offset + 26);
  const extraLen = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new Error(`DOCX ZIP entry is truncated: ${entry.name}`);
  const data = buffer.subarray(dataStart, dataEnd);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`DOCX ZIP entry uses unsupported compression method ${entry.method}: ${entry.name}`);
}

function isCustomXmlDataPart(name: string): boolean {
  return /^customXml\/item\d+\.xml$/i.test(name);
}

function wordControlStoryXmlParts(entries: Map<string, Buffer>): string[] {
  const names = [
    ...sortedWordPartNames(entries, /^word\/header\d+\.xml$/i),
    ...sortedWordPartNames(entries, /^word\/footer\d+\.xml$/i),
    "word/document.xml",
  ];
  return names.flatMap((name) => {
    const data = entries.get(name);
    return data ? [data.toString("utf8")] : [];
  });
}

function sortedWordPartNames(entries: Map<string, Buffer>, pattern: RegExp): string[] {
  return [...entries.keys()]
    .filter((name) => pattern.test(name))
    .sort((a, b) => wordPartNumber(a) - wordPartNumber(b) || a.localeCompare(b));
}

function wordPartNumber(name: string): number {
  return Number(/(\d+)\.xml$/i.exec(name)?.[1] ?? 0);
}

function parseControlDataXml(xml: string): DocxControlDataEntry[] {
  const controls: DocxControlDataEntry[] = [];
  const controlRe = /<([\w.-]+:)?control\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?control>/g;
  for (const match of xml.matchAll(controlRe)) {
    const attrs = parseXmlAttrs(match[2] ?? "");
    const id = attrs.id;
    if (!id) continue;
    const label = elementText(match[3] ?? "", "label");
    const value = elementText(match[3] ?? "", "value") ?? "";
    controls.push({
      id,
      ...(attrs.type ? { type: attrs.type } : {}),
      ...(label !== undefined ? { label } : {}),
      value,
    });
  }
  return controls;
}

function parseVisibleControlXml(xml: string): DocxControlDataEntry[] {
  const controls: DocxControlDataEntry[] = [];
  const sdtRe = /<([\w.-]+:)?sdt\b[\s\S]*?<\/(?:[\w.-]+:)?sdt>/g;
  for (const match of xml.matchAll(sdtRe)) {
    const block = match[0] ?? "";
    const tag = firstElementAttrs(block, "tag")?.val;
    if (!tag?.startsWith("noma-control:")) continue;
    const id = tag.slice("noma-control:".length);
    if (!id) continue;
    const parsed = parseVisibleControlBlock(id, block);
    if (parsed) controls.push(parsed);
  }
  return controls;
}

function parseVisibleControlBlock(id: string, block: string): DocxControlDataEntry | undefined {
  const alias = firstElementAttrs(block, "alias")?.val;
  const label = alias?.replace(/^Control:\s*/i, "").trim();
  const checkbox = checkedElementValue(block);
  if (checkbox !== undefined) {
    return {
      id,
      type: "toggle",
      ...(label ? { label } : {}),
      value: checkbox ? "true" : "false",
    };
  }
  const dateAttrs = firstElementAttrs(block, "date");
  if (dateAttrs) {
    return {
      id,
      type: "date",
      ...(label ? { label } : {}),
      value: dateValue(dateAttrs.fullDate) ?? contentControlText(block),
    };
  }
  const selectList = elementXml(block, "dropDownList") ?? elementXml(block, "comboBox");
  if (selectList !== undefined) {
    return {
      id,
      type: "select",
      ...(label ? { label } : {}),
      value: selectValue(selectList, contentControlText(block)),
    };
  }
  return {
    id,
    type: "text",
    ...(label ? { label } : {}),
    value: contentControlText(block),
  };
}

function mergeVisibleControlValues(
  controls: DocxControlDataEntry[],
  visibleControls: DocxControlDataEntry[],
): DocxControlDataEntry[] {
  if (visibleControls.length === 0) return controls;
  const merged = new Map<string, DocxControlDataEntry>();
  for (const control of controls) merged.set(control.id, control);
  for (const visible of visibleControls) {
    const existing = merged.get(visible.id);
    const value = visibleControlValue(existing, visible);
    merged.set(visible.id, {
      ...visible,
      ...existing,
      value,
      ...(existing?.type ?? visible.type ? { type: existing?.type ?? visible.type } : {}),
      ...(existing?.label ?? visible.label ? { label: existing?.label ?? visible.label } : {}),
    });
  }
  return [...merged.values()];
}

function visibleControlValue(existing: DocxControlDataEntry | undefined, visible: DocxControlDataEntry): string {
  const type = existing?.type?.toLowerCase();
  if (type === "checkbox" || type === "toggle") {
    const checked = checkedTextValue(visible.value);
    if (checked !== undefined) return checked ? "true" : "false";
  }
  return visible.value;
}

function parseTaskControlXml(xml: string): DocxTaskDataEntry[] {
  const tasks: DocxTaskDataEntry[] = [];
  const sdtRe = /<([\w.-]+:)?sdt\b[\s\S]*?<\/(?:[\w.-]+:)?sdt>/g;
  for (const match of xml.matchAll(sdtRe)) {
    const block = match[0] ?? "";
    const tag = firstElementAttrs(block, "tag")?.val;
    if (!tag?.startsWith("noma-task:")) continue;
    const id = tag.slice("noma-task:".length);
    if (!id) continue;
    const checked = checkedElementValue(block) ?? checkedTextValue(contentControlText(block));
    if (checked === undefined) continue;
    tasks.push({ id, checked });
  }
  return tasks;
}

function mergeTaskControlValues(tasks: DocxTaskDataEntry[]): DocxTaskDataEntry[] {
  const merged = new Map<string, DocxTaskDataEntry>();
  for (const task of tasks) merged.set(task.id, task);
  return [...merged.values()];
}

export function parseXmlAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
  for (const match of source.matchAll(attrRe)) {
    const name = match[1];
    const value = match[3];
    if (!name || value === undefined) continue;
    attrs[name.includes(":") ? name.split(":").pop()! : name] = decodeXml(value);
  }
  return attrs;
}

function firstElementAttrs(xml: string, localName: string): Record<string, string> | undefined {
  const re = new RegExp(`<([\\w.-]+:)?${localName}\\b([^>]*)\\/?>`);
  const match = re.exec(xml);
  return match ? parseXmlAttrs(match[2] ?? "") : undefined;
}

function dateValue(fullDate: string | undefined): string | undefined {
  if (!fullDate) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(fullDate.trim());
  return match?.[1];
}

function selectValue(selectXml: string, displayed: string): string {
  const items = Array.from(selectXml.matchAll(/<([\w.-]+:)?listItem\b([^>]*)\/?>/g)).map((match) =>
    parseXmlAttrs(match[2] ?? ""),
  );
  const displayedTrimmed = displayed.trim();
  const match = items.find(
    (item) =>
      item.displayText === displayed ||
      item.value === displayed ||
      item.displayText === displayedTrimmed ||
      item.value === displayedTrimmed,
  );
  return match?.value ?? displayed;
}

function contentControlText(block: string): string {
  return paragraphText(elementXml(block, "sdtContent") ?? block);
}

function paragraphText(xml: string): string {
  let text = "";
  const currentXml = stripNonCurrentTrackedRanges(xml);
  const tokenRe = /<([\w.-]+:)?(tab|ptab|br|cr|noBreakHyphen|softHyphen|sym)\b([^>]*?)(?:\/>|>\s*<\/(?:[\w.-]+:)?\2>)|<([\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/g;
  for (const match of currentXml.matchAll(tokenRe)) {
    const emptyName = match[2];
    if (emptyName === "tab" || emptyName === "ptab") {
      text += "\t";
    } else if (emptyName === "br" || emptyName === "cr") {
      text += "\n";
    } else if (emptyName === "noBreakHyphen") {
      text += "-";
    } else if (emptyName === "softHyphen") {
      text += "\u00ad";
    } else if (emptyName === "sym") {
      text += symbolText(match[3] ?? "");
    } else if (match[5] !== undefined) {
      text += decodeXml(match[5]);
    }
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
}

function stripNonCurrentTrackedRanges(xml: string): string {
  const withoutWrappedRanges = xml.replace(/<([\w.-]+:)?(del|moveFrom)\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?\2>/g, "");
  return stripMarkedRanges(withoutWrappedRanges, "moveFromRangeStart", "moveFromRangeEnd");
}

interface MarkedRange {
  start: number;
  endEnd: number;
}

function stripMarkedRanges(xml: string, startName: string, endName: string): string {
  const ranges = markedRanges(xml, startName, endName);
  if (ranges.length === 0) return xml;
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    out += xml.slice(cursor, range.start);
    cursor = range.endEnd;
  }
  return out + xml.slice(cursor);
}

function markedRanges(xml: string, startName: string, endName: string): MarkedRange[] {
  const ranges: MarkedRange[] = [];
  const startRe = new RegExp(`<([\\w.-]+:)?${startName}\\b([^>]*)\\/?>`, "g");
  let startMatch: RegExpExecArray | null;
  while ((startMatch = startRe.exec(xml)) !== null) {
    const attrs = parseXmlAttrs(startMatch[2] ?? "");
    if (!attrs.id) continue;
    const end = findMarkedRangeEnd(xml, endName, attrs.id, startRe.lastIndex);
    if (!end) continue;
    ranges.push({ start: startMatch.index, endEnd: end.endEnd });
    startRe.lastIndex = end.endEnd;
  }
  return ranges;
}

function findMarkedRangeEnd(
  xml: string,
  endName: string,
  id: string,
  fromIndex: number,
): { endEnd: number } | undefined {
  const endRe = new RegExp(`<([\\w.-]+:)?${endName}\\b([^>]*)\\/?>`, "g");
  endRe.lastIndex = fromIndex;
  let endMatch: RegExpExecArray | null;
  while ((endMatch = endRe.exec(xml)) !== null) {
    const attrs = parseXmlAttrs(endMatch[2] ?? "");
    if (attrs.id === id) return { endEnd: endMatch.index + endMatch[0].length };
  }
  return undefined;
}

function symbolText(attrsSource: string): string {
  const char = parseXmlAttrs(attrsSource).char;
  if (!char || !/^[0-9a-f]+$/i.test(char)) return "";
  const codePoint = Number.parseInt(char, 16);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
  return String.fromCodePoint(codePoint);
}

function checkedAttrValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "checked"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "unchecked"].includes(normalized)) return false;
  return undefined;
}

function checkedElementValue(xml: string): boolean | undefined {
  const attrs = firstElementAttrs(xml, "checked");
  if (!attrs) return undefined;
  if (attrs.val !== undefined) return checkedAttrValue(attrs.val);
  return true;
}

function checkedTextValue(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "checked", "x", "[x]", "\u2611", "\u2612", "\u2713", "\u2714"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "unchecked", "[ ]", "\u2610", "\u25a1"].includes(normalized)) return false;
  return undefined;
}

function elementXml(xml: string, localName: string): string | undefined {
  const re = new RegExp(`<([\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}>`);
  return re.exec(xml)?.[2];
}

function elementText(xml: string, localName: string): string | undefined {
  const re = new RegExp(`<([\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}>`);
  const match = re.exec(xml);
  return match ? decodeXml(match[2] ?? "") : undefined;
}

export function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/g, "&");
}
