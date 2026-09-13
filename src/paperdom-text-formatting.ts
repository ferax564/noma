// @ts-nocheck — vendored PaperDOM kernel; host policy lives in enterprise-paperdom-host.ts
// Vendored from https://github.com/ferax564/paperDOM/blob/a12198cdad8c7487242834941a34ed5adf5d4d74/app/text-formatting.ts (MIT). Do not edit to add Noma host policy.
export type ListMode = "bullet" | "number";
import type { Paragraph } from "./paperdom-document-model.js";

const bulletMarker = /^(?:[•▪◦-])\s+/;
const numberMarker = /^\d+[.)]\s+/;

const splitLine = (line: string) => {
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const body = line.slice(indent.length);
  return { indent, body, content: body.replace(bulletMarker, "").replace(numberMarker, "") };
};

export function listModeForText(text: string): ListMode | "none" | "mixed" {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim().length > 0);
  if (!lines.length) return "none";
  if (lines.every((line) => bulletMarker.test(splitLine(line).body))) return "bullet";
  if (lines.every((line) => numberMarker.test(splitLine(line).body))) return "number";
  return lines.some((line) => bulletMarker.test(splitLine(line).body) || numberMarker.test(splitLine(line).body)) ? "mixed" : "none";
}

export function toggleListStyle(text: string, mode: ListMode): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const removeMarkers = listModeForText(normalized) === mode;
  let itemNumber = 0;

  return normalized.split("\n").map((line) => {
    if (!line.trim()) return line;
    const { indent, content } = splitLine(line);
    if (removeMarkers) return `${indent}${content}`;
    itemNumber += 1;
    return `${indent}${mode === "bullet" ? "•" : `${itemNumber}.`} ${content}`;
  }).join("\n");
}

/** Structured paragraphs replace literal "• " markers. content.text stays canonical. */
export function listModeForParagraphs(paragraphs?: Paragraph[]): ListMode | "none" | "mixed" {
  const kinds = (paragraphs ?? []).filter((p) => p.text.trim()).map((p) => p.kind ?? "plain");
  if (!kinds.length) return "none";
  if (kinds.every((k) => k === "bullet")) return "bullet";
  if (kinds.every((k) => k === "number")) return "number";
  return kinds.some((k) => k !== "plain") ? "mixed" : "none";
}

export function toggleListParagraphs(text: string, current: Paragraph[] | undefined, mode: ListMode): Paragraph[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const nextKind = listModeForParagraphs(current) === mode ? "plain" : mode;
  return normalized.split("\n").map((line, index) => ({
    text: line,
    kind: line.trim() ? nextKind : "plain",
    level: current?.[index]?.level ?? 0,
  }));
}

/** Keep content.text and content.paragraphs consistent after a text edit, preserving kinds and levels per line. */
export function resyncParagraphs(current: Paragraph[] | undefined, text: string): Paragraph[] {
  if (!current) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.map((line, index) => ({
    text: line,
    kind: current[index]?.kind ?? "plain",
    level: current[index]?.level ?? 0,
  }));
}
