import { AGENT_RECIPES, EnterpriseError, type AgentRecipeName, type ChangesetOperation } from "./enterprise-contracts.js";

export interface RecipeContext {
  documentId?: string;
  artifactId?: string;
  issueId?: string;
  projectId?: string;
  tableId?: string;
  cellId?: string;
  blockId?: string;
  conclusion?: string;
  targetRevisions?: Record<string, number>;
  sourceHash?: string;
}

export interface RecipePlan {
  recipe: AgentRecipeName;
  intent: string;
  operations: ChangesetOperation[];
}

export function buildRecipePlan(recipe: string, payload: Record<string, unknown>): RecipePlan {
  if (!(AGENT_RECIPES as readonly string[]).includes(recipe)) {
    throw new EnterpriseError("invalid", `unknown recipe ${recipe}`);
  }
  const ctx = payload as RecipeContext;
  const operations: ChangesetOperation[] = [];
  if (recipe === "stale-source-refresh" && ctx.documentId && ctx.tableId && ctx.cellId) {
    operations.push({
      resource: { kind: "document", id: ctx.documentId, blockId: ctx.cellId },
      op: "update_table_cell",
      payload: { tableId: ctx.tableId, cellId: ctx.cellId, value: String(payload.value ?? "refreshed") },
    });
  } else if (recipe === "changed-test-impact" && ctx.documentId && ctx.blockId) {
    operations.push({
      resource: { kind: "document", id: ctx.documentId, blockId: ctx.blockId },
      op: "replace_paragraph",
      payload: { blockId: ctx.blockId, content: String(ctx.conclusion ?? "Impact review required after source change.") },
    });
  } else if (recipe === "issue-to-runbook" && ctx.documentId && ctx.issueId) {
    operations.push({
      resource: { kind: "document", id: ctx.documentId },
      op: "replace_paragraph",
      payload: {
        blockId: ctx.blockId ?? "runbook",
        content: `Runbook generated from ${ctx.issueId}.`,
      },
    });
  } else if (recipe === "meeting-notes-to-decisions" && ctx.documentId && ctx.blockId) {
    operations.push({
      resource: { kind: "document", id: ctx.documentId, blockId: ctx.blockId },
      op: "replace_paragraph",
      payload: { blockId: ctx.blockId, content: String(payload.decision ?? "Decision captured from meeting notes.") },
    });
  } else if (recipe === "release-note-preparation" && ctx.documentId && ctx.blockId) {
    operations.push({
      resource: { kind: "document", id: ctx.documentId, blockId: ctx.blockId },
      op: "replace_paragraph",
      payload: { blockId: ctx.blockId, content: String(payload.notes ?? "Release notes drafted from closed issues.") },
    });
  } else if (recipe === "orphaned-requirement-review" && ctx.projectId && ctx.documentId) {
    operations.push({
      resource: { kind: "issue", id: ctx.issueId ?? "new" },
      op: "create_issue",
      payload: {
        projectId: ctx.projectId,
        typeKey: "task",
        summary: "Review orphaned requirement",
        documentId: ctx.documentId,
        requirementBlockId: ctx.blockId,
      },
    });
  } else {
    throw new EnterpriseError("invalid", "recipe payload is missing required targets");
  }
  return { recipe: recipe as AgentRecipeName, intent: `recipe:${recipe}`, operations };
}
