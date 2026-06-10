import { parse, validate, collectIdRegistry, walk } from "@ferax564/noma-cli";
import type { DocumentNode, Node, Diagnostic as NomaDiagnostic } from "@ferax564/noma-cli";
import { DiagnosticSeverity, SymbolKind, CompletionItemKind } from "vscode-languageserver";
import type {
  CompletionItem,
  Diagnostic,
  DocumentSymbol,
  Position,
  Range,
} from "vscode-languageserver";

const SEVERITY: Record<NomaDiagnostic["severity"], DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
};

const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;
const REFERENCE_ATTR_RE = /\b(?:for|target)="([^"\n]*)"/g;
const OPEN_WIKILINK_PREFIX_RE = /\[\[([\w\-./:]*)$/;

function parseDocument(source: string, filename?: string): DocumentNode {
  return parse(source, filename ? { filename } : {});
}

function lineEndCharacter(lines: string[], zeroBasedLine: number): number {
  return lines[zeroBasedLine]?.length ?? 0;
}

function diagnosticRange(d: NomaDiagnostic, lines: string[]): Range {
  const startLine = d.pos ? d.pos.line - 1 : 0;
  const startCharacter = d.pos ? d.pos.column - 1 : 0;
  const endLine = d.endLine !== undefined ? Math.max(d.endLine - 1, startLine) : startLine;
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: lineEndCharacter(lines, endLine) },
  };
}

export function computeDiagnostics(source: string, filename?: string): Diagnostic[] {
  const doc = parseDocument(source, filename);
  const lines = source.split("\n");
  return validate(doc).map(d => ({
    range: diagnosticRange(d, lines),
    severity: SEVERITY[d.severity],
    code: d.code,
    source: "noma",
    message: d.message,
  }));
}

function nodeRange(node: Node, lines: string[]): Range | undefined {
  if (!node.pos) return undefined;
  const startLine = node.pos.line - 1;
  const endLine = node.endLine !== undefined ? Math.max(node.endLine - 1, startLine) : startLine;
  return {
    start: { line: startLine, character: node.pos.column - 1 },
    end: { line: endLine, character: lineEndCharacter(lines, endLine) },
  };
}

function firstLineRange(range: Range, lines: string[]): Range {
  return {
    start: range.start,
    end: { line: range.start.line, character: lineEndCharacter(lines, range.start.line) },
  };
}

function symbolsFor(nodes: Node[], lines: string[]): DocumentSymbol[] {
  const out: DocumentSymbol[] = [];
  for (const node of nodes) {
    if (node.type === "section") {
      const range = nodeRange(node, lines);
      const children = symbolsFor(node.children, lines);
      if (!range) {
        out.push(...children);
        continue;
      }
      out.push({
        name: node.title || node.id || "section",
        ...(node.id ? { detail: `#${node.id}` } : {}),
        kind: SymbolKind.String,
        range,
        selectionRange: firstLineRange(range, lines),
        children,
      });
    } else if (node.type === "directive") {
      const children = symbolsFor(node.children, lines);
      const range = node.id ? nodeRange(node, lines) : undefined;
      if (!node.id || !range) {
        out.push(...children);
        continue;
      }
      out.push({
        name: `::${node.name}`,
        detail: `#${node.id}`,
        kind: SymbolKind.Object,
        range,
        selectionRange: firstLineRange(range, lines),
        children,
      });
    }
  }
  return out;
}

export function computeDocumentSymbols(source: string, filename?: string): DocumentSymbol[] {
  const doc = parseDocument(source, filename);
  return symbolsFor(doc.children, source.split("\n"));
}

export function referenceTargetAt(lineText: string, character: number): string | undefined {
  for (const match of lineText.matchAll(WIKILINK_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (character < start || character > end) continue;
    const inner = match[1] ?? "";
    const pipe = inner.indexOf("|");
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    return target || undefined;
  }
  for (const match of lineText.matchAll(REFERENCE_ATTR_RE)) {
    const value = match[1] ?? "";
    const valueStart = match.index + match[0].indexOf('"') + 1;
    const valueEnd = valueStart + value.length;
    if (character < valueStart || character > valueEnd) continue;
    return value.trim() || undefined;
  }
  return undefined;
}

export interface DefinitionResult {
  id: string;
  range: Range;
}

export function computeDefinition(
  source: string,
  position: Position,
  filename?: string,
): DefinitionResult | undefined {
  const lines = source.split("\n");
  const target = referenceTargetAt(lines[position.line] ?? "", position.character);
  if (!target) return undefined;
  const doc = parseDocument(source, filename);
  const registry = collectIdRegistry(doc);
  const canonical = registry.ids.includes(target) ? target : registry.aliases[target];
  if (!canonical) return undefined;
  for (const node of walk(doc)) {
    if (node.id !== canonical) continue;
    const range = nodeRange(node, lines);
    if (range) return { id: canonical, range };
  }
  return undefined;
}

export function computeCompletions(
  source: string,
  position: Position,
  filename?: string,
): CompletionItem[] {
  const lines = source.split("\n");
  const before = (lines[position.line] ?? "").slice(0, position.character);
  if (!OPEN_WIKILINK_PREFIX_RE.test(before)) return [];
  const registry = collectIdRegistry(parseDocument(source, filename));
  const items: CompletionItem[] = registry.ids.map(id => ({
    label: id,
    kind: CompletionItemKind.Reference,
  }));
  for (const [alias, canonical] of Object.entries(registry.aliases)) {
    items.push({
      label: alias,
      kind: CompletionItemKind.Reference,
      detail: `alias of ${canonical}`,
    });
  }
  return items;
}
