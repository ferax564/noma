import type { Classification } from "./enterprise-contracts.js";

export interface RagEvalFixture {
  id: string;
  question: string;
  expectedSourceIds: string[];
  unanswerable?: boolean;
  restrictedSourceIds?: string[];
}

export interface RagHit {
  resourceId: string;
  citation?: { resource: string; blockId?: string | null; version?: string };
}

export interface RagEvalResult {
  fixtureId: string;
  recall: number;
  citationCorrect: boolean;
  leaked: boolean;
  abstained: boolean;
  unanswerableHonored: boolean;
}

export function evaluateRagFixture(
  fixture: RagEvalFixture,
  hits: RagHit[],
  actorCanRead: (resourceId: string) => boolean,
): RagEvalResult {
  const visible = hits.filter((hit) => actorCanRead(hit.resourceId));
  const leaked = hits.some((hit) => (fixture.restrictedSourceIds ?? []).includes(hit.resourceId) || !actorCanRead(hit.resourceId));
  const found = fixture.expectedSourceIds.filter((id) => visible.some((hit) => hit.resourceId === id));
  const recall = fixture.expectedSourceIds.length === 0 ? 1 : found.length / fixture.expectedSourceIds.length;
  const abstained = visible.length === 0;
  const citationCorrect = visible.every((hit) => hit.citation?.resource === hit.resourceId);
  return {
    fixtureId: fixture.id,
    recall,
    citationCorrect,
    leaked,
    abstained,
    unanswerableHonored: fixture.unanswerable ? abstained || recall === 0 : true,
  };
}

export function summarizeRagEvals(results: RagEvalResult[]): {
  meanRecall: number;
  citationAccuracy: number;
  leakageRate: number;
  abstentionAccuracy: number;
} {
  const n = results.length || 1;
  return {
    meanRecall: results.reduce((sum, row) => sum + row.recall, 0) / n,
    citationAccuracy: results.filter((row) => row.citationCorrect).length / n,
    leakageRate: results.filter((row) => row.leaked).length / n,
    abstentionAccuracy: results.filter((row) => row.unanswerableHonored).length / n,
  };
}

export interface KnowledgeRecord {
  id: string;
  reviewDueAt?: string;
  sourceHash?: string;
  currentHash?: string;
  classification?: Classification;
}

export function staleReviewItems(now: string, records: KnowledgeRecord[]): KnowledgeRecord[] {
  return records.filter((record) => record.reviewDueAt !== undefined && record.reviewDueAt <= now);
}

export function changedSourceItems(records: KnowledgeRecord[]): KnowledgeRecord[] {
  return records.filter((record) => record.sourceHash && record.currentHash && record.sourceHash !== record.currentHash);
}
