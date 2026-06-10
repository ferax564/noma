#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Diagnostic } from "vscode-languageserver/node.js";
import {
  computeCompletions,
  computeDefinition,
  computeDiagnostics,
  computeDocumentSymbols,
} from "./lib.js";

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    documentSymbolProvider: true,
    definitionProvider: true,
    completionProvider: { triggerCharacters: ["["] },
  },
}));

function filenameFor(uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function publishDiagnostics(document: TextDocument): void {
  let diagnostics: Diagnostic[];
  try {
    diagnostics = computeDiagnostics(document.getText(), filenameFor(document.uri));
  } catch (e) {
    connection.console.error(`noma-lsp diagnostics failed for ${document.uri}: ${String(e)}`);
    diagnostics = [];
  }
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

documents.onDidOpen(event => publishDiagnostics(event.document));
documents.onDidChangeContent(event => publishDiagnostics(event.document));
documents.onDidClose(event => connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] }));

connection.onDocumentSymbol(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  try {
    return computeDocumentSymbols(document.getText(), filenameFor(document.uri));
  } catch {
    return [];
  }
});

connection.onDefinition(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;
  try {
    const result = computeDefinition(document.getText(), params.position, filenameFor(document.uri));
    return result ? { uri: document.uri, range: result.range } : null;
  } catch {
    return null;
  }
});

connection.onCompletion(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  try {
    return computeCompletions(document.getText(), params.position, filenameFor(document.uri));
  } catch {
    return [];
  }
});

documents.listen(connection);
connection.listen();
