import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DocumentNode, TableNode } from "./ast.js";
import { sha256Hex } from "./hash.js";
import { parse } from "./parser.js";
import { renderNoma } from "./renderer-noma.js";
import {
  assignPersistentIdentities,
  defaultIdentityFactory,
  findNodeByAnyId,
  insertTableRowWithIdentities,
  updateTableCellById,
} from "./stable-identity.js";
import { editorToNoma, incompatibleEditorIsReadonly, nomaToEditor, type EditorDocument } from "./enterprise-adapter.js";
import {
  EnterpriseError,
  type ActorContext,
  type ChangesetOperation,
  type ChangesetRecord,
  type Classification,
  type ConnectorMode,
  type CutoverStage,
  type ExternalLinkProvider,
  type FieldType,
  type GrantRole,
  type ImportDisposition,
  type IssueHierarchyType,
  type OidcAdapter,
  type PrincipalKind,
  type QueryAst,
  type RelationType,
  type ResourceKind,
  type ScimUserInput,
  type StatusCategory,
} from "./enterprise-contracts.js";
import {
  fetchConfluencePage,
  fetchJiraIssuePayload,
  type AtlassianAuth,
  type AtlassianHttp,
} from "./enterprise-atlassian.js";
import {
  assertSafeImportUrl,
  nextCutoverStage,
  parseConfluenceStorage,
  parseJiraIssue,
  reconcileInventory,
} from "./enterprise-connectors.js";
import { applyCrdtOps, crdtOpsConflict, type CrdtOp } from "./enterprise-crdt.js";
import { evaluateRagFixture, summarizeRagEvals, type RagEvalFixture } from "./enterprise-knowledge.js";
import { buildRecipePlan } from "./enterprise-recipes.js";
import { cumulativeFlowFromEvents, cycleTimeFromEvents, throughputFromEvents } from "./enterprise-reports.js";
import {
  applyVisualCommands,
  createPaperDocument,
  exportFidelityReport,
  paperHash,
  semanticOutline,
  type PaperDocument,
  type PaperElement,
  type PaperGeometry,
  type VisualCommand,
} from "./enterprise-paperdom.js";
import { EnterpriseStore } from "./enterprise-store.js";

const CLASSIFICATION_RANK: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const ROLE_RANK: Record<GrantRole, number> = {
  viewer: 1,
  agent: 2,
  reviewer: 3,
  editor: 4,
  owner: 5,
};

const DEFAULT_STATUSES: Array<{ id: string; name: string; category: StatusCategory }> = [
  { id: "backlog", name: "Backlog", category: "todo" },
  { id: "todo", name: "To do", category: "todo" },
  { id: "in_progress", name: "In progress", category: "in_progress" },
  { id: "in_review", name: "In review", category: "in_progress" },
  { id: "done", name: "Done", category: "done" },
  { id: "cancelled", name: "Cancelled", category: "done" },
];

export interface WorkspaceOptions {
  dbPath?: string;
  postgresUrl?: string;
  now?: () => string;
  id?: () => string;
  oidc?: OidcAdapter;
}

interface SessionRow {
  id: string;
  principal_id: string;
  tenant_id: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface PrincipalRow {
  id: string;
  tenant_id: string;
  kind: PrincipalKind;
  name: string;
  email: string | null;
  external_id: string | null;
  active: number;
  classification: Classification;
  capabilities_json: string | null;
}

interface GrantRow {
  role: GrantRole;
  resource_kind: string;
  resource_id: string;
}

interface WorkflowDefinition {
  version: number;
  statuses: Array<{ id: string; name: string; category: StatusCategory }>;
  transitions: Array<{
    id: string;
    from: string;
    to: string;
    requiredFields?: string[];
    requireDecision?: boolean;
    actors?: PrincipalKind[];
  }>;
}

export class EnterpriseWorkspace {
  readonly store: EnterpriseStore;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly oidc?: OidcAdapter;
  private identityFactory = defaultIdentityFactory();

  constructor(options: WorkspaceOptions = {}) {
    this.store = new EnterpriseStore(
      options.postgresUrl ? { postgresUrl: options.postgresUrl } : options.dbPath ?? ":memory:",
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? (() => randomUUID());
    this.oidc = options.oidc;
  }

  close(): void {
    this.store.close();
  }

  // --- identity / org -------------------------------------------------------

  provisionTenant(name: string): { tenantId: string } {
    const tenantId = this.id();
    this.store.db.prepare("INSERT INTO tenants(id, name, created_at) VALUES (?, ?, ?)").run(tenantId, name, this.now());
    this.store.db
      .prepare("INSERT INTO policy(tenant_id, kill_switch, policy_version, budget_json) VALUES (?, 0, 1, ?)")
      .run(tenantId, JSON.stringify({ workspace: 100, user: 20, agent: 50, run: 10 }));
    return { tenantId };
  }

  createPrincipal(
    tenantId: string,
    input: { kind: PrincipalKind; name: string; email?: string; classification?: Classification; capabilities?: string[] },
  ): string {
    const id = this.id();
    this.store.db
      .prepare(
        `INSERT INTO principals(id, tenant_id, kind, name, email, active, classification, capabilities_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        input.kind,
        input.name,
        input.email ?? null,
        input.classification ?? "internal",
        input.capabilities ? JSON.stringify(input.capabilities) : null,
        this.now(),
        this.now(),
      );
    return id;
  }

  loginOidc(tenantId: string, idToken: string): { actor: ActorContext; token: string } {
    if (!this.oidc) throw new EnterpriseError("invalid", "OIDC adapter is not configured");
    const claims = this.oidc.verify(idToken);
    let principal = this.store.db
      .prepare("SELECT * FROM principals WHERE tenant_id = ? AND (external_id = ? OR email = ?) AND kind = 'user'")
      .get(tenantId, claims.sub, claims.email) as PrincipalRow | undefined;
    if (!principal) {
      const id = this.createPrincipal(tenantId, { kind: "user", name: claims.name, email: claims.email });
      this.store.db.prepare("UPDATE principals SET external_id = ? WHERE id = ?").run(claims.sub, id);
      principal = this.store.db.prepare("SELECT * FROM principals WHERE id = ?").get(id) as PrincipalRow;
    }
    if (!principal.active) throw new EnterpriseError("forbidden", "principal is deactivated");
    return this.createSession(principal);
  }

  scimUpsert(tenantId: string, input: ScimUserInput): string {
    const existing = this.store.db
      .prepare("SELECT * FROM principals WHERE tenant_id = ? AND external_id = ?")
      .get(tenantId, input.externalId) as PrincipalRow | undefined;
    if (existing) {
      this.store.db
        .prepare("UPDATE principals SET name = ?, active = ?, updated_at = ? WHERE id = ?")
        .run(input.userName, input.active ? 1 : 0, this.now(), existing.id);
      if (!input.active) this.revokePrincipalSessions(existing.id);
      return existing.id;
    }
    const id = this.createPrincipal(tenantId, { kind: "user", name: input.userName });
    this.store.db.prepare("UPDATE principals SET external_id = ?, active = ? WHERE id = ?").run(input.externalId, input.active ? 1 : 0, id);
    return id;
  }

  scimDeprovision(tenantId: string, externalId: string): void {
    const row = this.store.db
      .prepare("SELECT * FROM principals WHERE tenant_id = ? AND external_id = ?")
      .get(tenantId, externalId) as PrincipalRow | undefined;
    if (!row) return;
    this.store.db.prepare("UPDATE principals SET active = 0, updated_at = ? WHERE id = ?").run(this.now(), row.id);
    this.revokePrincipalSessions(row.id);
  }

  createSession(principal: Pick<PrincipalRow, "id" | "tenant_id" | "kind">): { actor: ActorContext; token: string } {
    const sessionId = this.id();
    const token = randomBytes(24).toString("hex");
    const tokenHash = sha256Hex(token);
    const issued = this.now();
    const expires = new Date(Date.parse(issued) + 8 * 3600_000).toISOString();
    this.store.db
      .prepare(
        `INSERT INTO sessions(id, principal_id, tenant_id, issued_at, expires_at, token_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, principal.id, principal.tenant_id, issued, expires, tokenHash);
    return {
      token,
      actor: { tenantId: principal.tenant_id, principalId: principal.id, sessionId, kind: principal.kind },
    };
  }

  authenticate(token: string): ActorContext {
    const tokenHash = sha256Hex(token);
    const session = this.store.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as SessionRow | undefined;
    if (!session) throw new EnterpriseError("unauthorized", "unknown session");
    if (session.revoked_at) throw new EnterpriseError("unauthorized", "session revoked");
    if (session.expires_at <= this.now()) throw new EnterpriseError("unauthorized", "session expired");
    const principal = this.principal(session.principal_id);
    if (!principal.active) throw new EnterpriseError("unauthorized", "principal deactivated");
    return {
      tenantId: session.tenant_id,
      principalId: session.principal_id,
      sessionId: session.id,
      kind: principal.kind,
    };
  }

  revokeSession(sessionId: string): void {
    this.store.db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(this.now(), sessionId);
  }

  revokePrincipalSessions(principalId: string): void {
    this.store.db.prepare("UPDATE sessions SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL").run(this.now(), principalId);
  }

  grant(actor: ActorContext, input: { principalId: string; resourceKind: ResourceKind; resourceId: string; role: GrantRole }): string {
    this.requireRole(actor, input.resourceKind, input.resourceId, "owner");
    const id = this.id();
    this.store.db
      .prepare(
        `INSERT INTO grants(id, tenant_id, principal_id, resource_kind, resource_id, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, actor.tenantId, input.principalId, input.resourceKind, input.resourceId, input.role, this.now());
    this.audit(actor, "grant", input.resourceKind, input.resourceId, input);
    return id;
  }

  bootstrapGrant(tenantId: string, principalId: string, resourceKind: ResourceKind, resourceId: string, role: GrantRole): void {
    this.store.db
      .prepare(
        `INSERT INTO grants(id, tenant_id, principal_id, resource_kind, resource_id, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.id(), tenantId, principalId, resourceKind, resourceId, role, this.now());
  }

  revokeGrant(actor: ActorContext, grantId: string): void {
    const grant = this.store.db.prepare("SELECT * FROM grants WHERE id = ? AND tenant_id = ?").get(grantId, actor.tenantId) as
      | (GrantRow & { id: string; resource_kind: ResourceKind; resource_id: string })
      | undefined;
    if (!grant) throw new EnterpriseError("not_found", "grant not found");
    this.requireRole(actor, grant.resource_kind, grant.resource_id, "owner");
    this.store.db.prepare("DELETE FROM grants WHERE id = ?").run(grantId);
    this.audit(actor, "revoke_grant", grant.resource_kind, grant.resource_id, { grantId });
  }

  createSpace(actor: ActorContext, name: string, classification: Classification = "internal", options: { homePage?: boolean } = {}): string {
    const id = this.id();
    this.store.db
      .prepare("INSERT INTO spaces(id, tenant_id, name, classification, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, actor.tenantId, name, classification, this.now());
    this.bootstrapGrant(actor.tenantId, actor.principalId, "space", id, "owner");
    if (options.homePage) {
      this.createDocument(actor, {
        spaceId: id,
        title: "Home",
        source: `# ${name}\n\nThis workspace is ready for pages, media, comments, and links to work and GitHub.\n`,
      });
    }
    return id;
  }

  createProject(actor: ActorContext, input: { key: string; name: string; spaceId?: string }): string {
    const id = this.id();
    this.store.db
      .prepare("INSERT INTO projects(id, tenant_id, key, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, actor.tenantId, input.key.toUpperCase(), input.name, this.now());
    this.bootstrapGrant(actor.tenantId, actor.principalId, "project", id, "owner");
    if (input.spaceId) this.linkProjectSpace(actor, id, input.spaceId);
    this.ensureDefaultWorkConfig(actor, id);
    return id;
  }

  linkProjectSpace(actor: ActorContext, projectId: string, spaceId: string): void {
    this.requireRole(actor, "project", projectId, "editor");
    this.requireRole(actor, "space", spaceId, "editor");
    this.store.db.prepare("INSERT OR IGNORE INTO project_spaces(project_id, space_id) VALUES (?, ?)").run(projectId, spaceId);
  }

  setKillSwitch(tenantId: string, enabled: boolean): void {
    this.store.db.prepare("UPDATE policy SET kill_switch = ? WHERE tenant_id = ?").run(enabled ? 1 : 0, tenantId);
  }

  // --- documents ------------------------------------------------------------

  createDocument(actor: ActorContext, input: { spaceId: string; title: string; source: string; classification?: Classification; parentId?: string }): string {
    this.requireRole(actor, "space", input.spaceId, "editor");
    if (input.parentId) this.assertDocumentParent(actor.tenantId, input.spaceId, input.parentId);
    const parsed = assignPersistentIdentities(parse(input.source), { factory: this.identityFactory });
    const source = renderNoma(parsed);
    const id = this.id();
    const hash = sha256Hex(source);
    const editor = nomaToEditor(parsed);
    const rank = this.nextDocumentRank(input.spaceId, input.parentId ?? null);
    this.store.db
      .prepare(
        `INSERT INTO documents(id, tenant_id, space_id, title, lifecycle, classification, owner_id, parent_id, rank, draft_revision, draft_source, draft_hash, crdt_json, update_log_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, 0, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(
        id,
        actor.tenantId,
        input.spaceId,
        input.title,
        input.classification ?? "internal",
        actor.principalId,
        input.parentId ?? null,
        rank,
        source,
        hash,
        JSON.stringify(editor),
        this.now(),
        this.now(),
      );
    this.bootstrapGrant(actor.tenantId, actor.principalId, "document", id, "owner");
    this.audit(actor, "document.create", "document", id, { title: input.title, parentId: input.parentId ?? null });
    return id;
  }

  saveDraft(actor: ActorContext, input: { documentId: string; editor: EditorDocument; expectedHash: string }): { hash: string; revision: number } {
    const doc = this.documentRow(input.documentId, actor.tenantId);
    this.requireRole(actor, "document", input.documentId, "editor");
    if (incompatibleEditorIsReadonly(input.editor.attrs.schemaVersion)) {
      throw new EnterpriseError("policy", "incompatible editor schema is read-only");
    }
    if (doc.draft_hash !== input.expectedHash) {
      throw new EnterpriseError("stale_revision", "live draft has changed", { expected: input.expectedHash, actual: doc.draft_hash });
    }
    const noma = editorToNoma(input.editor);
    assignPersistentIdentities(noma, { factory: this.identityFactory });
    const source = renderNoma(noma);
    const hash = sha256Hex(source);
    const log = JSON.parse(doc.update_log_json) as unknown[];
    log.push({ at: this.now(), actorId: actor.principalId, hash });
    const draftRevision = doc.draft_revision + 1;
    this.store.db
      .prepare(
        `UPDATE documents SET draft_source = ?, draft_hash = ?, draft_revision = ?, crdt_json = ?, update_log_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(source, hash, draftRevision, JSON.stringify(input.editor), JSON.stringify(log), this.now(), input.documentId);
    this.audit(actor, "document.draft", "document", input.documentId, { hash, draftRevision });
    return { hash, revision: draftRevision };
  }

  persistCollaborativeUpdate(
    actor: ActorContext,
    input: {
      documentId: string;
      clientId: string;
      clientSeq: number;
      ops: CrdtOp[];
      lastAckedSeq?: number;
      simulateLostAck?: boolean;
    },
  ): { seq: number; hash: string; replayed: boolean } {
    const doc = this.documentRow(input.documentId, actor.tenantId);
    this.requireRole(actor, "document", input.documentId, "editor");
    const existing = this.store.db
      .prepare("SELECT seq, hash FROM crdt_updates WHERE document_id = ? AND client_id = ? AND client_seq = ?")
      .get(input.documentId, input.clientId, input.clientSeq) as { seq: number; hash: string } | undefined;
    if (existing) return { seq: existing.seq, hash: existing.hash, replayed: true };
    const unseen = this.store.db
      .prepare("SELECT ops_json FROM crdt_updates WHERE document_id = ? AND seq > ? ORDER BY seq")
      .all(input.documentId, input.lastAckedSeq ?? 0) as Array<{ ops_json: string }>;
    const unseenOps = unseen.flatMap((row) => JSON.parse(row.ops_json) as CrdtOp[]);
    if (crdtOpsConflict(unseenOps, input.ops)) {
      throw new EnterpriseError("conflict", "overlapping collaborative ops require explicit resolution");
    }
    const source = applyCrdtOps(doc.draft_source, input.ops);
    const hash = sha256Hex(source);
    const maxSeq = this.store.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM crdt_updates WHERE document_id = ?").get(input.documentId) as {
      n: number;
    };
    const seq = maxSeq.n + 1;
    const persist = this.store.db.transaction(() => {
      this.store.db
        .prepare(
          `INSERT INTO crdt_updates(id, document_id, seq, client_id, client_seq, actor_id, ops_json, hash, persisted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(this.id(), input.documentId, seq, input.clientId, input.clientSeq, actor.principalId, JSON.stringify(input.ops), hash, this.now());
      const editor = nomaToEditor(assignPersistentIdentities(parse(source), { factory: this.identityFactory }));
      this.store.db
        .prepare(
          `UPDATE documents SET draft_source = ?, draft_hash = ?, draft_revision = draft_revision + 1, crdt_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(source, hash, JSON.stringify(editor), this.now(), input.documentId);
    });
    persist();
    if (input.simulateLostAck) throw new EnterpriseError("invalid", "simulated lost ack");
    return { seq, hash, replayed: false };
  }

  reconnectDraft(actor: ActorContext, documentId: string, lastAckedSeq: number): Array<{ seq: number; ops: CrdtOp[]; hash: string }> {
    this.requireRole(actor, "document", documentId, "viewer");
    const rows = this.store.db
      .prepare("SELECT seq, ops_json, hash FROM crdt_updates WHERE document_id = ? AND seq > ? ORDER BY seq")
      .all(documentId, lastAckedSeq) as Array<{ seq: number; ops_json: string; hash: string }>;
    return rows.map((row) => ({ seq: row.seq, ops: JSON.parse(row.ops_json) as CrdtOp[], hash: row.hash }));
  }

  publishDocument(actor: ActorContext, documentId: string): { revision: number; hash: string } {
    this.requireRole(actor, "document", documentId, "editor");
    const doc = this.documentRow(documentId, actor.tenantId);
    const revision = (doc.published_revision ?? 0) + 1;
    this.store.db
      .prepare(
        `INSERT INTO document_revisions(document_id, revision, source, hash, title, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(documentId, revision, doc.draft_source, doc.draft_hash, doc.title, actor.principalId, this.now());
    this.store.db
      .prepare("UPDATE documents SET published_revision = ?, lifecycle = 'published', updated_at = ? WHERE id = ?")
      .run(revision, this.now(), documentId);
    this.indexDocument(actor.tenantId, documentId, doc.title, doc.draft_source, doc.draft_hash, revision, doc.classification);
    this.enqueueOutbox(actor.tenantId, "search_index", { documentId, revision });
    this.audit(actor, "document.publish", "document", documentId, { revision, hash: doc.draft_hash });
    return { revision, hash: doc.draft_hash };
  }

  readDocument(actor: ActorContext, documentId: string): {
    id: string;
    title: string;
    source: string;
    hash: string;
    publishedRevision: number | null;
    draftRevision: number;
    classification: Classification;
  } {
    const doc = this.documentRow(documentId, actor.tenantId);
    this.requireRole(actor, "document", documentId, "viewer");
    return {
      id: doc.id,
      title: doc.title,
      source: doc.draft_source,
      hash: doc.draft_hash,
      publishedRevision: doc.published_revision,
      draftRevision: doc.draft_revision,
      classification: doc.classification,
    };
  }

  renameDocument(actor: ActorContext, documentId: string, title: string): void {
    this.documentRow(documentId, actor.tenantId);
    this.requireRole(actor, "document", documentId, "editor");
    this.store.db.prepare("UPDATE documents SET title = ?, updated_at = ? WHERE id = ?").run(title, this.now(), documentId);
    this.audit(actor, "document.rename", "document", documentId, { title });
  }

  moveDocument(actor: ActorContext, documentId: string, parentId: string | null): void {
    const doc = this.documentRow(documentId, actor.tenantId);
    this.requireRole(actor, "document", documentId, "editor");
    if (parentId === documentId) throw new EnterpriseError("invalid", "a page cannot be its own parent");
    if (parentId) {
      this.assertDocumentParent(actor.tenantId, doc.space_id, parentId);
      let cursor: string | null = parentId;
      while (cursor) {
        if (cursor === documentId) throw new EnterpriseError("invalid", "page tree cycle");
        cursor =
          (this.store.db.prepare("SELECT parent_id FROM documents WHERE id = ?").get(cursor) as { parent_id: string | null } | undefined)
            ?.parent_id ?? null;
      }
    }
    const rank = this.nextDocumentRank(doc.space_id, parentId);
    this.store.db
      .prepare("UPDATE documents SET parent_id = ?, rank = ?, updated_at = ? WHERE id = ?")
      .run(parentId, rank, this.now(), documentId);
    this.audit(actor, "document.move", "document", documentId, { parentId });
  }

  listDocumentRevisions(actor: ActorContext, documentId: string): Array<{
    revision: number;
    hash: string;
    title: string;
    createdBy: string;
    createdAt: string;
  }> {
    this.requireRole(actor, "document", documentId, "viewer");
    return this.store.db
      .prepare(
        "SELECT revision, hash, title, created_by AS createdBy, created_at AS createdAt FROM document_revisions WHERE document_id = ? ORDER BY revision DESC",
      )
      .all(documentId) as Array<{ revision: number; hash: string; title: string; createdBy: string; createdAt: string }>;
  }

  restoreDocumentRevision(actor: ActorContext, documentId: string, revision: number): { hash: string } {
    this.requireRole(actor, "document", documentId, "editor");
    const row = this.store.db
      .prepare("SELECT source, hash, title FROM document_revisions WHERE document_id = ? AND revision = ?")
      .get(documentId, revision) as { source: string; hash: string; title: string } | undefined;
    if (!row) throw new EnterpriseError("not_found", "revision not found");
    const editor = nomaToEditor(assignPersistentIdentities(parse(row.source), { factory: this.identityFactory }));
    this.store.db
      .prepare(
        "UPDATE documents SET draft_source = ?, draft_hash = ?, title = ?, draft_revision = draft_revision + 1, crdt_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(row.source, row.hash, row.title, JSON.stringify(editor), this.now(), documentId);
    this.audit(actor, "document.restore", "document", documentId, { revision, hash: row.hash });
    return { hash: row.hash };
  }

  addDocumentComment(actor: ActorContext, documentId: string, body: string, quote?: string): { id: string; mentions: string[] } {
    this.requireRole(actor, "document", documentId, "viewer");
    const mentions = this.resolveMentions(actor.tenantId, body);
    const id = this.id();
    this.store.db
      .prepare(
        "INSERT INTO document_comments(id, document_id, body, quote, mentions_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, documentId, body, quote?.trim() || null, JSON.stringify(mentions), actor.principalId, this.now());
    const doc = this.documentRow(documentId, actor.tenantId);
    this.notify(actor.tenantId, doc.owner_id ?? actor.principalId, "New comment", body.slice(0, 180), "document", documentId);
    for (const mention of mentions) {
      if (mention !== actor.principalId) {
        this.notify(actor.tenantId, mention, "You were mentioned", body.slice(0, 180), "document", documentId);
      }
    }
    return { id, mentions };
  }

  listDocumentComments(actor: ActorContext, documentId: string): Array<Record<string, unknown>> {
    this.requireRole(actor, "document", documentId, "viewer");
    return this.store.db
      .prepare(
        `SELECT c.id, c.body, c.quote, c.mentions_json AS mentionsJson, c.created_by AS createdBy, c.created_at AS createdAt, p.name AS authorName
         FROM document_comments c JOIN principals p ON p.id = c.created_by
         WHERE c.document_id = ? ORDER BY c.created_at`,
      )
      .all(documentId) as Array<Record<string, unknown>>;
  }

  attachDocumentAsset(
    actor: ActorContext,
    documentId: string,
    input: { bytes: Buffer; mime: string; filename: string },
  ): { assetId: string; linkId: string } {
    this.requireRole(actor, "document", documentId, "editor");
    const assetId = this.uploadAsset(actor, { bytes: input.bytes, mime: input.mime, provenance: { filename: input.filename, documentId } });
    const linkId = this.id();
    this.store.db
      .prepare(
        "INSERT INTO document_assets(id, document_id, asset_id, filename, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(linkId, documentId, assetId, input.filename, actor.principalId, this.now());
    return { assetId, linkId };
  }

  listDocumentAssets(actor: ActorContext, documentId: string): Array<{ id: string; assetId: string; filename: string; createdAt: string; mime: string }> {
    this.requireRole(actor, "document", documentId, "viewer");
    return this.store.db
      .prepare(
        `SELECT da.id, da.asset_id AS assetId, da.filename, da.created_at AS createdAt, a.mime
         FROM document_assets da JOIN assets a ON a.id = da.asset_id
         WHERE da.document_id = ? ORDER BY da.created_at`,
      )
      .all(documentId) as Array<{ id: string; assetId: string; filename: string; createdAt: string; mime: string }>;
  }

  embedDocumentMedia(
    actor: ActorContext,
    documentId: string,
    input: { kind: "image" | "video"; assetId: string; filename: string },
  ): { hash: string } {
    this.requireRole(actor, "document", documentId, "editor");
    const doc = this.documentRow(documentId, actor.tenantId);
    const filename = input.filename.replace(/["\n\r]/g, "");
    const src = `/v1/assets/${input.assetId}`;
    const snippet =
      input.kind === "video"
        ? `\n::video{src="${src}" title="${filename}"}\n::\n`
        : `\n::figure{src="${src}" alt="${filename}"}\n::\n`;
    const source = `${doc.draft_source.trimEnd()}\n${snippet}`;
    const hash = sha256Hex(source);
    this.store.db
      .prepare("UPDATE documents SET draft_source = ?, draft_hash = ?, draft_revision = draft_revision + 1, updated_at = ? WHERE id = ?")
      .run(source, hash, this.now(), documentId);
    this.audit(actor, "document.media", "document", documentId, { kind: input.kind, assetId: input.assetId });
    return { hash };
  }

  listResourceGrants(actor: ActorContext, kind: ResourceKind, id: string): Array<{ id: string; principalId: string; role: GrantRole; name: string }> {
    this.requireRole(actor, kind, id, "viewer");
    return this.store.db
      .prepare(
        `SELECT g.id, g.principal_id AS principalId, g.role, p.name FROM grants g JOIN principals p ON p.id = g.principal_id
         WHERE g.tenant_id = ? AND g.resource_kind = ? AND g.resource_id = ? ORDER BY g.created_at`,
      )
      .all(actor.tenantId, kind, id) as Array<{ id: string; principalId: string; role: GrantRole; name: string }>;
  }

  addExternalLink(
    actor: ActorContext,
    input: {
      fromKind: ResourceKind;
      fromId: string;
      provider: ExternalLinkProvider;
      url?: string;
      issueId?: string;
      documentId?: string;
      label?: string;
    },
  ): string {
    this.requireRole(actor, input.fromKind, input.fromId, "editor");
    const url = input.url ?? null;
    let targetKind: ResourceKind | null = null;
    let targetId: string | null = null;
    let label = input.label ?? "";
    if (input.provider === "github") {
      if (!url) throw new EnterpriseError("invalid", "GitHub link requires a url");
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== "https:" || (host !== "github.com" && host !== "www.github.com")) {
        throw new EnterpriseError("invalid", "GitHub links must be https://github.com/...");
      }
      label = label || parsed.pathname.replace(/^\//, "");
    } else if (input.provider === "issue") {
      if (!input.issueId) throw new EnterpriseError("invalid", "issue link requires issueId");
      const issue = this.issueRow(input.issueId, actor.tenantId);
      this.requireRole(actor, "project", issue.project_id, "viewer");
      targetKind = "issue";
      targetId = input.issueId;
      const row = this.store.db.prepare("SELECT key, summary FROM issues WHERE id = ?").get(input.issueId) as { key: string; summary: string };
      label = label || `${row.key} ${row.summary}`;
      this.putReference(actor, {
        from: { kind: input.fromKind, id: input.fromId },
        to: { kind: "issue", id: input.issueId },
        relation: "illustrates",
      });
    } else if (input.provider === "document") {
      if (!input.documentId) throw new EnterpriseError("invalid", "document link requires documentId");
      this.requireRole(actor, "document", input.documentId, "viewer");
      targetKind = "document";
      targetId = input.documentId;
      label = label || this.documentRow(input.documentId, actor.tenantId).title;
    } else {
      if (!url) throw new EnterpriseError("invalid", "url link requires a url");
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new EnterpriseError("invalid", "link scheme is not allowed");
      label = label || parsed.hostname;
    }
    const id = this.id();
    this.store.db
      .prepare(
        `INSERT INTO external_links(id, tenant_id, from_kind, from_id, provider, url, label, target_kind, target_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, actor.tenantId, input.fromKind, input.fromId, input.provider, url, label, targetKind, targetId, actor.principalId, this.now());
    return id;
  }

  listExternalLinks(actor: ActorContext, fromKind: ResourceKind, fromId: string): Array<Record<string, unknown>> {
    this.requireRole(actor, fromKind, fromId, "viewer");
    return this.store.db
      .prepare(
        "SELECT id, provider, url, label, target_kind AS targetKind, target_id AS targetId, created_at AS createdAt FROM external_links WHERE tenant_id = ? AND from_kind = ? AND from_id = ? ORDER BY created_at",
      )
      .all(actor.tenantId, fromKind, fromId) as Array<Record<string, unknown>>;
  }

  inspectAsset(actor: ActorContext, assetId: string): { bytes: Buffer; mime: string } {
    this.requireRole(actor, "asset", assetId, "viewer");
    const row = this.store.db.prepare("SELECT bytes, mime, scan_state FROM assets WHERE id = ? AND tenant_id = ?").get(assetId, actor.tenantId) as
      | { bytes: Buffer; mime: string; scan_state: string }
      | undefined;
    if (!row) throw new EnterpriseError("not_found", "asset not found");
    if (row.scan_state !== "clean") throw new EnterpriseError("forbidden", "asset is quarantined");
    return { bytes: row.bytes, mime: row.mime };
  }

  insertArtifactElement(
    actor: ActorContext,
    artifactId: string,
    input: {
      type: PaperElement["type"];
      text?: string;
      altText?: string;
      imageAssetId?: string;
      videoAssetId?: string;
      href?: string;
      fromId?: string;
      toId?: string;
      geometry?: { x?: number; y?: number; width?: number; height?: number };
    },
  ): { id: string; revision: number } {
    const read = this.readArtifact(actor, artifactId, "draft");
    const id = this.id();
    let geometry = {
      x: input.geometry?.x ?? 48,
      y: input.geometry?.y ?? 48 + read.document.elements.length * 24,
      width: input.geometry?.width ?? (input.type === "arrow" ? 800 : 280),
      height: input.geometry?.height ?? (input.type === "arrow" ? 220 : 140),
    };
    if (input.type === "arrow" && input.fromId && input.toId) {
      const from = read.document.elements.find((item) => item.id === input.fromId);
      const to = read.document.elements.find((item) => item.id === input.toId);
      if (from && to) {
        geometry = {
          x: 0,
          y: 0,
          width: Math.max(960, from.geometry.x + from.geometry.width, to.geometry.x + to.geometry.width) + 24,
          height: Math.max(540, from.geometry.y + from.geometry.height, to.geometry.y + to.geometry.height) + 24,
        };
      }
    }
    const element: PaperElement = {
      id,
      type: input.type,
      geometry,
      zIndex: input.type === "arrow" ? 8 : 5,
      text: input.text,
      altText: input.altText ?? input.text ?? input.type,
      imageAssetId: input.imageAssetId,
      videoAssetId: input.videoAssetId,
      href: input.href,
      fromId: input.fromId,
      toId: input.toId,
    };
    const applied = this.applyArtifactCommands(actor, artifactId, [{ op: "insert_element", element }], read.document.revision);
    return { id, revision: applied.revision };
  }

  updateArtifactElement(
    actor: ActorContext,
    artifactId: string,
    elementId: string,
    patch: { geometry?: Partial<PaperGeometry>; text?: string; altText?: string; zIndex?: number },
  ): { revision: number; hash: string } {
    const read = this.readArtifact(actor, artifactId, "draft");
    const current = read.document.elements.find((element) => element.id === elementId);
    if (!current) throw new EnterpriseError("not_found", "element not found");
    return this.applyArtifactCommands(
      actor,
      artifactId,
      [
        {
          op: "update_element",
          elementId,
          patch: {
            text: patch.text,
            altText: patch.altText,
            zIndex: patch.zIndex,
            geometry: patch.geometry ? { ...current.geometry, ...patch.geometry } : undefined,
          },
        },
      ],
      read.document.revision,
    );
  }

  deleteArtifactElement(actor: ActorContext, artifactId: string, elementId: string): { revision: number; hash: string } {
    const read = this.readArtifact(actor, artifactId, "draft");
    if (!read.document.elements.some((element) => element.id === elementId)) throw new EnterpriseError("not_found", "element not found");
    return this.applyArtifactCommands(actor, artifactId, [{ op: "delete_element", elementId }], read.document.revision);
  }

  markNotificationRead(actor: ActorContext, notificationId: string): void {
    this.store.db
      .prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ?")
      .run(this.now(), notificationId, actor.tenantId, actor.principalId);
  }

  listAdminDirectory(actor: ActorContext): {
    principals: Array<Record<string, unknown>>;
    spaces: Array<Record<string, unknown>>;
    projects: Array<Record<string, unknown>>;
    grants: Array<Record<string, unknown>>;
  } {
    this.requireRole(actor, "tenant", actor.tenantId, "owner");
    return {
      principals: this.store.db
        .prepare("SELECT id, name, kind, email, active FROM principals WHERE tenant_id = ? ORDER BY name")
        .all(actor.tenantId) as Array<Record<string, unknown>>,
      spaces: this.store.db
        .prepare("SELECT id, name, classification FROM spaces WHERE tenant_id = ? ORDER BY name")
        .all(actor.tenantId) as Array<Record<string, unknown>>,
      projects: this.store.db
        .prepare("SELECT id, key, name FROM projects WHERE tenant_id = ? ORDER BY key")
        .all(actor.tenantId) as Array<Record<string, unknown>>,
      grants: this.store.db
        .prepare(
          "SELECT id, principal_id AS principalId, resource_kind AS resourceKind, resource_id AS resourceId, role FROM grants WHERE tenant_id = ? ORDER BY created_at",
        )
        .all(actor.tenantId) as Array<Record<string, unknown>>,
    };
  }

  workspaceShell(actor: ActorContext): {
    actor: ActorContext & { name: string };
    spaces: Array<{ id: string; name: string; classification: Classification }>;
    documents: Array<{
      id: string;
      spaceId: string;
      title: string;
      lifecycle: string;
      classification: Classification;
      updatedAt: string;
      hash: string;
      parentId: string | null;
      rank: string;
    }>;
    artifacts: Array<{
      id: string;
      spaceId: string;
      title: string;
      draftRevision: number;
      publishedRevision: number | null;
    }>;
    projects: Array<{
      id: string;
      key: string;
      name: string;
      statuses: Array<{ id: string; name: string; category: StatusCategory }>;
    }>;
    issues: Array<{
      id: string;
      projectId: string;
      key: string;
      summary: string;
      description: string | null;
      statusId: string;
      typeKey: string;
      estimate: number | null;
      assigneeId: string | null;
      parentId: string | null;
      reporterId: string | null;
      rank: string;
      sprintId: string | null;
      priority: string;
      dueAt: string | null;
      labels: string[];
      flagged: boolean;
      watching: boolean;
    }>;
    principals: Array<{ id: string; name: string; kind: PrincipalKind; email: string | null }>;
    boards: Array<{ id: string; projectId: string; name: string; kind: string }>;
    sprints: Array<{ id: string; boardId: string; name: string; goal: string | null; state: string }>;
    grants: Array<{ id: string; principalId: string; resourceKind: string; resourceId: string; role: GrantRole }>;
    issueTypes: Array<{ projectId: string; key: string; name: string; hierarchy: string }>;
    notifications: Array<Record<string, unknown>>;
  } {
    this.assertSession(actor);
    const principal = this.principal(actor.principalId);
    const spaces = (
      this.store.db
        .prepare("SELECT id, name, classification FROM spaces WHERE tenant_id = ? ORDER BY name")
        .all(actor.tenantId) as Array<{ id: string; name: string; classification: Classification }>
    ).filter((row) => this.hasRole(actor, "space", row.id, "viewer"));
    const documents = (
      this.store.db
        .prepare(
          "SELECT id, space_id AS spaceId, title, lifecycle, classification, updated_at AS updatedAt, draft_hash AS hash, parent_id AS parentId, rank FROM documents WHERE tenant_id = ? ORDER BY rank, title",
        )
        .all(actor.tenantId) as Array<{
        id: string;
        spaceId: string;
        title: string;
        lifecycle: string;
        classification: Classification;
        updatedAt: string;
        hash: string;
        parentId: string | null;
        rank: string;
      }>
    ).filter((row) => this.hasRole(actor, "document", row.id, "viewer"));
    const artifacts = (
      this.store.db
        .prepare(
          "SELECT id, space_id AS spaceId, title, draft_revision AS draftRevision, published_revision AS publishedRevision FROM artifacts WHERE tenant_id = ? ORDER BY updated_at DESC",
        )
        .all(actor.tenantId) as Array<{
        id: string;
        spaceId: string;
        title: string;
        draftRevision: number;
        publishedRevision: number | null;
      }>
    ).filter((row) => this.hasRole(actor, "artifact", row.id, "viewer"));
    const projects = (
      this.store.db
        .prepare("SELECT id, key, name FROM projects WHERE tenant_id = ? ORDER BY key")
        .all(actor.tenantId) as Array<{ id: string; key: string; name: string }>
    )
      .filter((row) => this.hasRole(actor, "project", row.id, "viewer"))
      .map((row) => ({ ...row, statuses: this.activeWorkflow(row.id).statuses }));
    const watchingIds = new Set(
      (
        this.store.db
          .prepare("SELECT issue_id AS issueId FROM issue_watchers WHERE tenant_id = ? AND principal_id = ?")
          .all(actor.tenantId, actor.principalId) as Array<{ issueId: string }>
      ).map((row) => row.issueId),
    );
    const issues = (
      this.store.db
        .prepare(
          `SELECT i.id, i.project_id AS projectId, i.key, i.summary, i.description, i.status_id AS statusId, t.key AS typeKey, i.estimate, i.assignee_id AS assigneeId, i.reporter_id AS reporterId, i.security_level_id AS securityLevelId, i.parent_id AS parentId, i.rank, i.sprint_id AS sprintId, i.priority, i.due_at AS dueAt, i.labels_json AS labelsJson, i.flagged
           FROM issues i JOIN issue_types t ON t.id = i.type_id
           WHERE i.tenant_id = ? ORDER BY i.rank`,
        )
        .all(actor.tenantId) as Array<{
        id: string;
        projectId: string;
        key: string;
        summary: string;
        description: string | null;
        statusId: string;
        typeKey: string;
        estimate: number | null;
        assigneeId: string | null;
        reporterId: string | null;
        securityLevelId: string | null;
        parentId: string | null;
        rank: string;
        sprintId: string | null;
        priority: string;
        dueAt: string | null;
        labelsJson: string;
        flagged: number | null;
      }>
    )
      .filter((row) =>
        this.canSeeIssue(actor, {
          project_id: row.projectId,
          security_level_id: row.securityLevelId,
          reporter_id: row.reporterId,
          assignee_id: row.assigneeId,
        }),
      )
      .map((row) => ({
        id: row.id,
        projectId: row.projectId,
        key: row.key,
        summary: row.summary,
        description: row.description,
        statusId: row.statusId,
        typeKey: row.typeKey,
        estimate: row.estimate,
        assigneeId: row.assigneeId,
        parentId: row.parentId,
        reporterId: row.reporterId,
        rank: row.rank,
        sprintId: row.sprintId,
        priority: row.priority,
        dueAt: row.dueAt,
        flagged: row.flagged === 1,
        watching: watchingIds.has(row.id),
        labels: (() => {
          try {
            const parsed = JSON.parse(row.labelsJson || "[]") as unknown;
            return Array.isArray(parsed) ? parsed.map(String) : [];
          } catch {
            return [];
          }
        })(),
      }));
    const principals = this.store.db
      .prepare("SELECT id, name, kind, email FROM principals WHERE tenant_id = ? AND active = 1 ORDER BY name")
      .all(actor.tenantId) as Array<{ id: string; name: string; kind: PrincipalKind; email: string | null }>;
    const boards = (
      this.store.db
        .prepare("SELECT id, project_id AS projectId, name, kind FROM boards WHERE tenant_id = ? ORDER BY name")
        .all(actor.tenantId) as Array<{ id: string; projectId: string; name: string; kind: string }>
    ).filter((row) => this.hasRole(actor, "project", row.projectId, "viewer"));
    const sprints = this.store.db
      .prepare(
        `SELECT s.id, s.board_id AS boardId, s.name, s.goal, s.state FROM sprints s JOIN boards b ON b.id = s.board_id WHERE s.tenant_id = ? ORDER BY s.created_at`,
      )
      .all(actor.tenantId) as Array<{ id: string; boardId: string; name: string; goal: string | null; state: string }>;
    const grants = this.hasRole(actor, "tenant", actor.tenantId, "owner")
      ? (this.store.db
          .prepare("SELECT id, principal_id AS principalId, resource_kind AS resourceKind, resource_id AS resourceId, role FROM grants WHERE tenant_id = ? ORDER BY created_at")
          .all(actor.tenantId) as Array<{
          id: string;
          principalId: string;
          resourceKind: string;
          resourceId: string;
          role: GrantRole;
        }>)
      : [];
    const issueTypes = (
      this.store.db
        .prepare("SELECT project_id AS projectId, key, name, hierarchy FROM issue_types WHERE tenant_id = ? ORDER BY key")
        .all(actor.tenantId) as Array<{ projectId: string; key: string; name: string; hierarchy: string }>
    ).filter((row) => this.hasRole(actor, "project", row.projectId, "viewer"));
    return {
      actor: { ...actor, name: principal.name },
      spaces,
      documents,
      artifacts,
      projects,
      issues,
      principals,
      boards,
      sprints,
      grants,
      issueTypes,
      notifications: this.notifications(actor),
    };
  }

  sourceReplace(actor: ActorContext, input: { documentId: string; source: string; expectedHash: string }): string {
    const doc = this.documentRow(input.documentId, actor.tenantId);
    this.requireRole(actor, "document", input.documentId, "editor");
    if (doc.draft_hash !== input.expectedHash) {
      throw new EnterpriseError("conflict", "source replacement conflicts with live draft");
    }
    return this.draftChangeset(actor, {
      intent: "source replacement",
      idempotencyKey: `src-${input.documentId}-${this.id()}`,
      operations: [
        {
          resource: { kind: "document", id: input.documentId },
          op: "replace_source",
          payload: { source: input.source },
        },
      ],
      targetRevisions: { [input.documentId]: doc.draft_revision },
    });
  }

  // --- visuals / assets -----------------------------------------------------

  createArtifact(actor: ActorContext, input: { spaceId: string; title: string; classification?: Classification }): string {
    this.requireRole(actor, "space", input.spaceId, "editor");
    const id = this.id();
    const paper = createPaperDocument(id, input.title);
    this.store.db
      .prepare(
        `INSERT INTO artifacts(id, tenant_id, space_id, title, classification, owner_id, draft_revision, draft_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        actor.tenantId,
        input.spaceId,
        input.title,
        input.classification ?? "internal",
        actor.principalId,
        JSON.stringify(paper),
        this.now(),
        this.now(),
      );
    this.bootstrapGrant(actor.tenantId, actor.principalId, "artifact", id, "owner");
    return id;
  }

  applyArtifactCommands(
    actor: ActorContext,
    artifactId: string,
    commands: VisualCommand[],
    expectedRevision: number,
  ): { revision: number; hash: string } {
    this.requireRole(actor, "artifact", artifactId, "editor");
    const row = this.artifactRow(artifactId, actor.tenantId);
    const current = JSON.parse(row.draft_json) as PaperDocument;
    const stripped = commands.map(({ actor: _ignored, ...rest }) => rest);
    const result = applyVisualCommands(current, stripped, { actorId: actor.principalId, expectedRevision });
    this.store.db
      .prepare("UPDATE artifacts SET draft_json = ?, draft_revision = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(result.document), result.document.revision, this.now(), artifactId);
    this.audit(actor, "artifact.command", "artifact", artifactId, { revision: result.document.revision, hash: result.hash });
    return { revision: result.document.revision, hash: result.hash };
  }

  publishArtifact(actor: ActorContext, artifactId: string): { revision: number; hash: string } {
    this.requireRole(actor, "artifact", artifactId, "editor");
    const row = this.artifactRow(artifactId, actor.tenantId);
    const paper = JSON.parse(row.draft_json) as PaperDocument;
    const revision = (row.published_revision ?? 0) + 1;
    const hash = paperHash(paper);
    this.store.db
      .prepare(
        `INSERT INTO artifact_revisions(artifact_id, revision, document_json, hash, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(artifactId, revision, JSON.stringify(paper), hash, actor.principalId, this.now());
    this.store.db.prepare("UPDATE artifacts SET published_revision = ?, updated_at = ? WHERE id = ?").run(revision, this.now(), artifactId);
    return { revision, hash };
  }

  readArtifact(
    actor: ActorContext,
    artifactId: string,
    pin: "draft" | "published" | number = "draft",
  ): { document: PaperDocument; outline: ReturnType<typeof semanticOutline>; updateCandidate: boolean } {
    this.requireRole(actor, "artifact", artifactId, "viewer");
    const row = this.artifactRow(artifactId, actor.tenantId);
    let document: PaperDocument;
    if (pin === "draft") document = JSON.parse(row.draft_json) as PaperDocument;
    else if (pin === "published") {
      if (!row.published_revision) throw new EnterpriseError("not_found", "no published revision");
      document = this.artifactRevision(artifactId, row.published_revision);
    } else document = this.artifactRevision(artifactId, pin);
    const updateCandidate =
      typeof pin === "number" && row.draft_revision > pin
        ? true
        : pin === "published" && row.published_revision !== null && row.draft_revision > row.published_revision;
    return { document, outline: semanticOutline(document), updateCandidate };
  }

  uploadAsset(
    actor: ActorContext,
    input: { bytes: Buffer; mime: string; classification?: Classification; provenance?: Record<string, unknown> },
  ): string {
    this.denyHostileAsset(input.mime, input.bytes);
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    const id = this.id();
    const scanState = input.mime === "image/svg+xml" && input.bytes.includes(Buffer.from("<script")) ? "quarantined" : "clean";
    this.store.db
      .prepare(
        `INSERT INTO assets(id, tenant_id, hash, mime, size, owner_id, classification, scan_state, provenance_json, bytes, sanitized_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        actor.tenantId,
        hash,
        input.mime,
        input.bytes.length,
        actor.principalId,
        input.classification ?? "internal",
        scanState,
        JSON.stringify(input.provenance ?? { source: "upload" }),
        input.bytes,
        scanState === "clean" ? input.bytes : null,
        this.now(),
      );
    this.bootstrapGrant(actor.tenantId, actor.principalId, "asset", id, "owner");
    this.audit(actor, "asset.upload", "asset", id, { hash, mime: input.mime, scanState });
    return id;
  }

  readAsset(actor: ActorContext, assetId: string, kind: "original" | "thumbnail" = "original"): Buffer {
    this.requireRole(actor, "asset", assetId, "viewer");
    const row = this.store.db.prepare("SELECT * FROM assets WHERE id = ? AND tenant_id = ?").get(assetId, actor.tenantId) as
      | { bytes: Buffer; sanitized_bytes: Buffer | null; scan_state: string }
      | undefined;
    if (!row) throw new EnterpriseError("not_found", "asset not found");
    if (row.scan_state !== "clean") throw new EnterpriseError("forbidden", "asset is quarantined");
    return kind === "thumbnail" ? (row.sanitized_bytes ?? row.bytes) : row.bytes;
  }

  // --- work -----------------------------------------------------------------

  defineIssueType(actor: ActorContext, projectId: string, input: { key: string; name: string; hierarchy: IssueHierarchyType }): string {
    this.requireRole(actor, "project", projectId, "owner");
    const id = this.id();
    this.store.db
      .prepare("INSERT INTO issue_types(id, tenant_id, project_id, key, name, hierarchy) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, actor.tenantId, projectId, input.key, input.name, input.hierarchy);
    return id;
  }

  activateWorkflow(actor: ActorContext, projectId: string, definition: WorkflowDefinition): string {
    this.requireRole(actor, "project", projectId, "owner");
    const occupied = this.store.db
      .prepare("SELECT DISTINCT status_id FROM issues WHERE project_id = ?")
      .all(projectId) as Array<{ status_id: string }>;
    const nextIds = new Set(definition.statuses.map((status) => status.id));
    const missing = occupied.filter((row) => !nextIds.has(row.status_id));
    if (missing.length > 0) {
      throw new EnterpriseError("invalid", "workflow activation would drop occupied statuses", {
        statuses: missing.map((row) => row.status_id),
        affected: occupied.length,
      });
    }
    const version = definition.version;
    const id = this.id();
    this.store.db.prepare("UPDATE workflows SET activated = 0 WHERE project_id = ?").run(projectId);
    this.store.db
      .prepare("INSERT INTO workflows(id, tenant_id, project_id, version, activated, definition_json) VALUES (?, ?, ?, ?, 1, ?)")
      .run(id, actor.tenantId, projectId, version, JSON.stringify(definition));
    return id;
  }

  createIssue(
    actor: ActorContext,
    input: {
      projectId: string;
      typeKey: string;
      summary: string;
      description?: string;
      parentId?: string;
      assigneeId?: string;
      accountableId?: string;
      labels?: string[];
      estimate?: number;
      securityLevelId?: string;
    },
  ): { id: string; key: string } {
    this.requireRole(actor, "project", input.projectId, "editor");
    const type = this.store.db
      .prepare("SELECT * FROM issue_types WHERE project_id = ? AND key = ?")
      .get(input.projectId, input.typeKey) as { id: string; hierarchy: IssueHierarchyType } | undefined;
    if (!type) throw new EnterpriseError("invalid", `unknown issue type ${input.typeKey}`);
    if (input.parentId) this.assertHierarchy(input.parentId, type.hierarchy);
    if (input.assigneeId && actor.kind === "agent" && !input.accountableId) {
      throw new EnterpriseError("invalid", "agent-assigned work requires an accountable human");
    }
    const project = this.store.db.prepare("SELECT key FROM projects WHERE id = ?").get(input.projectId) as { key: string };
    const seq =
      (
        this.store.db.prepare("SELECT COUNT(*) AS n FROM issues WHERE project_id = ?").get(input.projectId) as { n: number }
      ).n + 1;
    const key = `${project.key}-${seq}`;
    const id = this.id();
    const rank = `n:${String(seq * 1000).padStart(8, "0")}`;
    this.store.db
      .prepare(
        `INSERT INTO issues(id, tenant_id, project_id, key, type_id, summary, description, status_id, reporter_id, assignee_id, accountable_id, parent_id, rank, estimate, security_level_id, labels_json, components_json, versions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)`,
      )
      .run(
        id,
        actor.tenantId,
        input.projectId,
        key,
        type.id,
        input.summary,
        input.description ?? null,
        actor.principalId,
        input.assigneeId ?? null,
        input.accountableId ?? (actor.kind === "user" ? actor.principalId : null),
        input.parentId ?? null,
        rank,
        input.estimate ?? null,
        input.securityLevelId ?? null,
        JSON.stringify(input.labels ?? []),
        this.now(),
        this.now(),
      );
    this.issueEvent(id, actor.principalId, "created", { key, summary: input.summary });
    this.audit(actor, "issue.create", "issue", id, { key });
    return { id, key };
  }

  transitionIssue(actor: ActorContext, issueId: string, to: string, fields?: Record<string, unknown>): void {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "editor");
    const workflow = this.activeWorkflow(issue.project_id);
    const transition = workflow.transitions.find((item) => item.from === issue.status_id && item.to === to);
    if (!transition) throw new EnterpriseError("invalid", `no transition from ${issue.status_id} to ${to}`);
    if (transition.actors && !transition.actors.includes(actor.kind)) {
      throw new EnterpriseError("forbidden", "actor cannot perform this transition");
    }
    for (const field of transition.requiredFields ?? []) {
      if (fields?.[field] === undefined) throw new EnterpriseError("invalid", `missing required field ${field}`);
    }
    if (transition.requireDecision && fields?.decisionId === undefined) {
      throw new EnterpriseError("invalid", "sensitive transition requires an approved decision");
    }
    const resolution = to === "cancelled" ? "cancelled" : to === "done" ? "completed" : issue.resolution;
    this.store.db
      .prepare("UPDATE issues SET status_id = ?, resolution = ?, updated_at = ? WHERE id = ?")
      .run(to, resolution, this.now(), issueId);
    this.issueEvent(issueId, actor.principalId, "transitioned", { from: issue.status_id, to, resolution });
  }

  rankIssues(actor: ActorContext, projectId: string, orderedIds: string[]): void {
    this.requireRole(actor, "project", projectId, "editor");
    const tx = this.store.db.transaction(() => {
      orderedIds.forEach((id, index) => {
        this.store.db
          .prepare("UPDATE issues SET rank = ?, updated_at = ? WHERE id = ? AND project_id = ?")
          .run(`n:${String((index + 1) * 1000).padStart(8, "0")}`, this.now(), id, projectId);
      });
    });
    tx();
  }

  createBoard(actor: ActorContext, input: { projectId: string; name: string; kind: "kanban" | "scrum"; query?: QueryAst }): string {
    this.requireRole(actor, "project", input.projectId, "editor");
    const id = this.id();
    this.store.db
      .prepare("INSERT INTO boards(id, tenant_id, project_id, name, kind, query_json, columns_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        actor.tenantId,
        input.projectId,
        input.name,
        input.kind,
        JSON.stringify(input.query ?? { type: "and", clauses: [] }),
        JSON.stringify(DEFAULT_STATUSES.map((status) => ({ statusId: status.id, wip: status.category === "in_progress" ? 5 : null }))),
      );
    return id;
  }

  createSprint(actor: ActorContext, boardId: string, name: string, goal?: string): string {
    const board = this.store.db.prepare("SELECT * FROM boards WHERE id = ?").get(boardId) as { project_id: string; tenant_id: string };
    this.requireRole(actor, "project", board.project_id, "editor");
    const id = this.id();
    this.store.db
      .prepare("INSERT INTO sprints(id, tenant_id, board_id, name, goal, state, created_at) VALUES (?, ?, ?, ?, ?, 'planned', ?)")
      .run(id, actor.tenantId, boardId, name, goal ?? null, this.now());
    return id;
  }

  startSprint(actor: ActorContext, sprintId: string): void {
    const sprint = this.store.db.prepare("SELECT * FROM sprints WHERE id = ?").get(sprintId) as { board_id: string; tenant_id: string };
    const board = this.store.db.prepare("SELECT project_id FROM boards WHERE id = ?").get(sprint.board_id) as { project_id: string };
    this.requireRole(actor, "project", board.project_id, "editor");
    const active = this.store.db
      .prepare("SELECT id FROM sprints WHERE board_id = ? AND state = 'active'")
      .get(sprint.board_id) as { id: string } | undefined;
    if (active) throw new EnterpriseError("invalid", "board already has an active sprint");
    this.store.db
      .prepare("UPDATE sprints SET state = 'active', start_at = ? WHERE id = ?")
      .run(this.now(), sprintId);
  }

  closeSprint(actor: ActorContext, sprintId: string, carry = true): string[] {
    const sprint = this.store.db.prepare("SELECT * FROM sprints WHERE id = ?").get(sprintId) as { board_id: string };
    const board = this.store.db.prepare("SELECT project_id FROM boards WHERE id = ?").get(sprint.board_id) as { project_id: string };
    this.requireRole(actor, "project", board.project_id, "editor");
    const unfinished = this.store.db
      .prepare("SELECT id FROM issues WHERE sprint_id = ? AND status_id NOT IN ('done', 'cancelled')")
      .all(sprintId) as Array<{ id: string }>;
    this.store.db.prepare("UPDATE sprints SET state = 'closed', end_at = ? WHERE id = ?").run(this.now(), sprintId);
    if (carry) {
      for (const issue of unfinished) {
        this.store.db.prepare("UPDATE issues SET sprint_id = NULL, updated_at = ? WHERE id = ?").run(this.now(), issue.id);
        this.issueEvent(issue.id, actor.principalId, "sprint_carryover", { from: sprintId });
      }
    }
    return unfinished.map((issue) => issue.id);
  }

  logWork(actor: ActorContext, input: { issueId: string; durationSeconds: number; visibility?: string; note?: string }): string {
    const issue = this.issueRow(input.issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "editor");
    const id = this.id();
    this.store.db
      .prepare(
        `INSERT INTO worklogs(id, issue_id, author_id, duration_seconds, visibility, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.issueId, actor.principalId, input.durationSeconds, input.visibility ?? "internal", input.note ?? null, this.now());
    this.issueEvent(input.issueId, actor.principalId, "worklogged", { durationSeconds: input.durationSeconds });
    return id;
  }

  listWorklogs(actor: ActorContext, issueId: string): Array<Record<string, unknown>> {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "viewer");
    return this.store.db
      .prepare(
        `SELECT w.id, w.duration_seconds AS durationSeconds, w.note, w.created_at AS createdAt, p.name AS authorName
         FROM worklogs w JOIN principals p ON p.id = w.author_id WHERE w.issue_id = ? ORDER BY w.created_at`,
      )
      .all(issueId) as Array<Record<string, unknown>>;
  }

  updateIssue(
    actor: ActorContext,
    issueId: string,
    patch: { summary?: string; description?: string; assigneeId?: string | null; parentId?: string | null; labels?: string[]; priority?: string; dueAt?: string | null; estimate?: number | null; flagged?: boolean },
  ): void {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "editor");
    if (patch.parentId) {
      const type = this.store.db.prepare("SELECT hierarchy FROM issue_types WHERE id = (SELECT type_id FROM issues WHERE id = ?)").get(issueId) as {
        hierarchy: IssueHierarchyType;
      };
      this.assertHierarchy(patch.parentId, type.hierarchy);
    }
    if (patch.priority && !["lowest", "low", "medium", "high", "highest"].includes(patch.priority)) {
      throw new EnterpriseError("invalid", "unknown priority");
    }
    this.store.db
      .prepare(
        `UPDATE issues SET summary = COALESCE(?, summary), description = COALESCE(?, description), assignee_id = CASE WHEN ? = 1 THEN ? ELSE assignee_id END,
         parent_id = CASE WHEN ? = 1 THEN ? ELSE parent_id END, labels_json = COALESCE(?, labels_json), priority = COALESCE(?, priority),
         due_at = CASE WHEN ? = 1 THEN ? ELSE due_at END, estimate = CASE WHEN ? = 1 THEN ? ELSE estimate END,
         flagged = CASE WHEN ? = 1 THEN ? ELSE flagged END, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.summary ?? null,
        patch.description ?? null,
        patch.assigneeId === undefined ? 0 : 1,
        patch.assigneeId ?? null,
        patch.parentId === undefined ? 0 : 1,
        patch.parentId ?? null,
        patch.labels ? JSON.stringify(patch.labels) : null,
        patch.priority ?? null,
        patch.dueAt === undefined ? 0 : 1,
        patch.dueAt ?? null,
        patch.estimate === undefined ? 0 : 1,
        patch.estimate ?? null,
        patch.flagged === undefined ? 0 : 1,
        patch.flagged ? 1 : 0,
        this.now(),
        issueId,
      );
    this.issueEvent(issueId, actor.principalId, "updated", patch as Record<string, unknown>);
  }

  addIssueComment(actor: ActorContext, issueId: string, body: string): string {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "viewer");
    const id = this.id();
    this.store.db
      .prepare("INSERT INTO issue_comments(id, issue_id, body, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, issueId, body, actor.principalId, this.now());
    const mentions = this.resolveMentions(actor.tenantId, body);
    for (const mention of mentions) {
      this.notify(actor.tenantId, mention, "Mentioned on an issue", body.slice(0, 180), "issue", issueId);
    }
    const watchers = this.store.db
      .prepare("SELECT principal_id AS principalId FROM issue_watchers WHERE issue_id = ?")
      .all(issueId) as Array<{ principalId: string }>;
    for (const watcher of watchers) {
      if (watcher.principalId === actor.principalId || mentions.includes(watcher.principalId)) continue;
      this.notify(actor.tenantId, watcher.principalId, "Watched issue updated", body.slice(0, 180), "issue", issueId);
    }
    this.issueEvent(issueId, actor.principalId, "commented", { id });
    return id;
  }

  listIssueComments(actor: ActorContext, issueId: string): Array<Record<string, unknown>> {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "viewer");
    return this.store.db
      .prepare(
        `SELECT c.id, c.body, c.created_by AS createdBy, c.created_at AS createdAt, p.name AS authorName
         FROM issue_comments c JOIN principals p ON p.id = c.created_by WHERE c.issue_id = ? ORDER BY c.created_at`,
      )
      .all(issueId) as Array<Record<string, unknown>>;
  }

  readIssue(actor: ActorContext, issueId: string): Record<string, unknown> {
    const issue = this.store.db.prepare("SELECT * FROM issues WHERE id = ? AND tenant_id = ?").get(issueId, actor.tenantId) as
      | Record<string, unknown>
      | undefined;
    if (!issue || !this.canSeeIssue(actor, issue)) throw new EnterpriseError("not_found", "issue not found");
    const type = this.store.db.prepare("SELECT key, name, hierarchy FROM issue_types WHERE id = ?").get(issue.type_id as string) as {
      key: string;
      name: string;
      hierarchy: string;
    };
    const watchers = this.listIssueWatchers(actor, issueId);
    return {
      ...issue,
      typeKey: type.key,
      typeName: type.name,
      hierarchy: type.hierarchy,
      comments: this.listIssueComments(actor, issueId),
      worklogs: this.listWorklogs(actor, issueId),
      transitions: this.listIssueTransitions(actor, issueId),
      events: this.listIssueEvents(actor, issueId),
      watchers,
      watching: watchers.some((watcher) => watcher.id === actor.principalId),
    };
  }

  listIssueWatchers(actor: ActorContext, issueId: string): Array<{ id: string; name: string }> {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "viewer");
    return this.store.db
      .prepare(
        `SELECT p.id, p.name FROM issue_watchers w JOIN principals p ON p.id = w.principal_id
         WHERE w.issue_id = ? ORDER BY p.name`,
      )
      .all(issueId) as Array<{ id: string; name: string }>;
  }

  watchIssue(actor: ActorContext, issueId: string): { watching: true } {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "viewer");
    this.store.db
      .prepare("INSERT OR IGNORE INTO issue_watchers(issue_id, principal_id, tenant_id, created_at) VALUES (?, ?, ?, ?)")
      .run(issueId, actor.principalId, actor.tenantId, this.now());
    this.issueEvent(issueId, actor.principalId, "watched", {});
    return { watching: true };
  }

  unwatchIssue(actor: ActorContext, issueId: string): { watching: false } {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "viewer");
    this.store.db.prepare("DELETE FROM issue_watchers WHERE issue_id = ? AND principal_id = ?").run(issueId, actor.principalId);
    this.issueEvent(issueId, actor.principalId, "unwatched", {});
    return { watching: false };
  }

  listIssueEvents(actor: ActorContext, issueId: string): Array<{ action: string; detail: unknown; createdAt: string; actorName: string }> {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "viewer");
    const rows = this.store.db
      .prepare(
        `SELECT e.action, e.detail_json AS detailJson, e.created_at AS createdAt, p.name AS actorName
         FROM issue_events e JOIN principals p ON p.id = e.actor_id
         WHERE e.issue_id = ? ORDER BY e.created_at DESC LIMIT 24`,
      )
      .all(issueId) as Array<{ action: string; detailJson: string; createdAt: string; actorName: string }>;
    return rows.map((row) => ({
      action: row.action,
      detail: JSON.parse(row.detailJson) as unknown,
      createdAt: row.createdAt,
      actorName: row.actorName,
    }));
  }

  listIssueTransitions(actor: ActorContext, issueId: string): Array<{ id: string; from: string; to: string; requiredFields: string[] }> {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "viewer");
    const workflow = this.activeWorkflow(issue.project_id);
    return workflow.transitions
      .filter((item) => item.from === issue.status_id)
      .map((item) => ({ id: item.id, from: item.from, to: item.to, requiredFields: item.requiredFields ?? [] }));
  }

  listBoards(actor: ActorContext, projectId: string): Array<Record<string, unknown>> {
    this.requireRole(actor, "project", projectId, "viewer");
    return this.store.db
      .prepare("SELECT id, name, kind FROM boards WHERE project_id = ?")
      .all(projectId) as Array<Record<string, unknown>>;
  }

  listSprints(actor: ActorContext, boardId: string): Array<Record<string, unknown>> {
    const board = this.store.db.prepare("SELECT project_id FROM boards WHERE id = ?").get(boardId) as { project_id: string } | undefined;
    if (!board) throw new EnterpriseError("not_found", "board not found");
    this.requireRole(actor, "project", board.project_id, "viewer");
    return this.store.db
      .prepare("SELECT id, name, goal, state, start_at AS startAt, end_at AS endAt FROM sprints WHERE board_id = ? ORDER BY created_at")
      .all(boardId) as Array<Record<string, unknown>>;
  }

  setIssueSprint(actor: ActorContext, issueId: string, sprintId: string | null): void {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "editor");
    if (sprintId) {
      const sprint = this.store.db.prepare("SELECT board_id FROM sprints WHERE id = ?").get(sprintId) as { board_id: string } | undefined;
      if (!sprint) throw new EnterpriseError("not_found", "sprint not found");
    }
    this.store.db.prepare("UPDATE issues SET sprint_id = ?, updated_at = ? WHERE id = ?").run(sprintId, this.now(), issueId);
    this.issueEvent(issueId, actor.principalId, "sprint_set", { sprintId });
  }

  defineCustomField(actor: ActorContext, projectId: string, input: { key: string; fieldType: FieldType; options?: string[] }): string {
    this.requireRole(actor, "project", projectId, "owner");
    const id = this.id();
    this.store.db
      .prepare("INSERT INTO custom_fields(id, tenant_id, project_id, key, field_type, options_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, actor.tenantId, projectId, input.key, input.fieldType, input.options ? JSON.stringify(input.options) : null);
    return id;
  }

  setFieldValue(actor: ActorContext, issueId: string, fieldKey: string, value: unknown): void {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "editor");
    const field = this.store.db
      .prepare("SELECT * FROM custom_fields WHERE project_id = ? AND key = ?")
      .get(issue.project_id, fieldKey) as { id: string; field_type: FieldType; schema_version: number; options_json: string | null } | undefined;
    if (!field) throw new EnterpriseError("invalid", "unknown field");
    this.validateFieldValue(field.field_type, value, field.options_json ? (JSON.parse(field.options_json) as string[]) : undefined);
    this.store.db
      .prepare(
        `INSERT INTO field_values(issue_id, field_id, schema_version, value_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(issue_id, field_id, schema_version) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(issueId, field.id, field.schema_version, JSON.stringify(value));
  }

  queryIssues(actor: ActorContext, projectId: string, ast: QueryAst | string): Array<Record<string, unknown>> {
    this.requireRole(actor, "project", projectId, "viewer");
    const parsed = typeof ast === "string" ? this.parseJqlSubset(ast, actor.principalId) : ast;
    const issues = this.store.db.prepare("SELECT * FROM issues WHERE project_id = ? ORDER BY rank").all(projectId) as Array<
      Record<string, unknown>
    >;
    return issues.filter((issue) => this.canSeeIssue(actor, issue) && this.matchQuery(issue, parsed));
  }

  compileQuery(jql: string, currentUserId: string): QueryAst {
    return this.parseJqlSubset(jql, currentUserId);
  }

  burndown(actor: ActorContext, sprintId: string): Array<{ at: string; remaining: number }> {
    const sprint = this.store.db.prepare("SELECT * FROM sprints WHERE id = ?").get(sprintId) as { board_id: string; start_at: string | null } | undefined;
    if (!sprint) throw new EnterpriseError("not_found", "sprint not found");
    const board = this.store.db.prepare("SELECT project_id FROM boards WHERE id = ?").get(sprint.board_id) as { project_id: string } | undefined;
    if (!board) throw new EnterpriseError("not_found", "board not found");
    this.requireRole(actor, "project", board.project_id, "viewer");
    const events = this.store.db
      .prepare(
        `SELECT e.created_at AS at, e.action, e.detail_json, i.estimate
         FROM issue_events e JOIN issues i ON i.id = e.issue_id
         WHERE i.sprint_id = ? ORDER BY e.created_at`,
      )
      .all(sprintId) as Array<{ at: string; action: string; detail_json: string; estimate: number | null }>;
    let remaining = 0;
    const points: Array<{ at: string; remaining: number }> = [];
    for (const event of events) {
      if (event.action === "created") remaining += event.estimate ?? 1;
      if (event.action === "transitioned") {
        const detail = JSON.parse(event.detail_json) as { to?: string };
        if (detail.to === "done" || detail.to === "cancelled") remaining -= event.estimate ?? 1;
      }
      points.push({ at: event.at, remaining: Math.max(0, remaining) });
    }
    return points;
  }

  addAutomation(
    actor: ActorContext,
    input: { projectId: string; event: string; condition: QueryAst; action: { type: string; payload: Record<string, unknown> } },
  ): string {
    this.requireRole(actor, "project", input.projectId, "owner");
    const id = this.id();
    this.store.db
      .prepare("INSERT INTO automations(id, tenant_id, project_id, event, condition_json, action_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, actor.tenantId, input.projectId, input.event, JSON.stringify(input.condition), JSON.stringify(input.action));
    return id;
  }

  dryRunAutomation(actor: ActorContext, automationId: string, issueId: string): { wouldApply: boolean; action: unknown } {
    const automation = this.store.db.prepare("SELECT * FROM automations WHERE id = ?").get(automationId) as {
      project_id: string;
      condition_json: string;
      action_json: string;
    };
    this.requireRole(actor, "project", automation.project_id, "editor");
    const issue = this.issueRow(issueId, actor.tenantId);
    const wouldApply = this.matchQuery(issue, JSON.parse(automation.condition_json) as QueryAst);
    return { wouldApply, action: JSON.parse(automation.action_json) };
  }

  // --- knowledge ------------------------------------------------------------

  putReference(
    actor: ActorContext,
    input: {
      from: { kind: ResourceKind; id: string; blockId?: string };
      to: { kind: ResourceKind; id: string; blockId?: string; revision?: number };
      relation: RelationType;
      authoritative?: boolean;
    },
  ): string {
    this.requireRole(actor, input.from.kind, input.from.id, "editor");
    if (!this.hasRole(actor, input.to.kind, input.to.id, "viewer")) {
      throw new EnterpriseError("forbidden", "cannot assert a relation to an invisible resource");
    }
    const id = this.id();
    this.store.db
      .prepare(
        `INSERT INTO references_edge(id, tenant_id, from_kind, from_id, from_block, to_kind, to_id, to_block, to_revision, relation, asserted_by, authoritative, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        actor.tenantId,
        input.from.kind,
        input.from.id,
        input.from.blockId ?? null,
        input.to.kind,
        input.to.id,
        input.to.blockId ?? null,
        input.to.revision ?? null,
        input.relation,
        actor.principalId,
        input.authoritative ? 1 : 0,
        this.now(),
      );
    return id;
  }

  dependents(actor: ActorContext, resourceId: string): Array<Record<string, unknown>> {
    const rows = this.store.db
      .prepare("SELECT * FROM references_edge WHERE tenant_id = ? AND (from_id = ? OR to_id = ?)")
      .all(actor.tenantId, resourceId, resourceId) as Array<{
      from_kind: ResourceKind;
      from_id: string;
      to_kind: ResourceKind;
      to_id: string;
      relation: string;
      from_block: string | null;
      to_block: string | null;
    }>;
    return rows.filter(
      (row) => this.hasRole(actor, row.from_kind, row.from_id, "viewer") && this.hasRole(actor, row.to_kind, row.to_id, "viewer"),
    );
  }

  search(actor: ActorContext, query: string): Array<Record<string, unknown>> {
    const rows = this.store.db
      .prepare("SELECT * FROM search_index WHERE tenant_id = ?")
      .all(actor.tenantId) as Array<{
      resource_kind: ResourceKind;
      resource_id: string;
      block_id: string | null;
      title: string;
      body: string;
      hash: string;
      revision: number | null;
      classification: Classification;
    }>;
    const needle = query.toLowerCase();
    return rows
      .filter((row) => this.hasRole(actor, row.resource_kind, row.resource_id, "viewer"))
      .filter((row) => row.title.toLowerCase().includes(needle) || row.body.toLowerCase().includes(needle))
      .map((row) => ({
        resourceKind: row.resource_kind,
        resourceId: row.resource_id,
        blockId: row.block_id,
        title: row.title,
        excerpt: row.body.slice(0, 180),
        hash: row.hash,
        revision: row.revision,
        citation: { resource: row.resource_id, blockId: row.block_id, version: row.hash },
      }));
  }

  // --- changesets / jobs ----------------------------------------------------

  draftChangeset(
    actor: ActorContext,
    input: {
      intent: string;
      operations: ChangesetOperation[];
      targetRevisions: Record<string, number>;
      sourceDependencies?: ChangesetRecord["sourceDependencies"];
      idempotencyKey: string;
      reviewerIds?: string[];
    },
  ): string {
    const existing = this.store.db
      .prepare("SELECT id FROM changesets WHERE tenant_id = ? AND idempotency_key = ?")
      .get(actor.tenantId, input.idempotencyKey) as { id: string } | undefined;
    if (existing) return existing.id;
    const record: ChangesetRecord = {
      id: this.id(),
      tenantId: actor.tenantId,
      actorId: actor.principalId,
      actorKind: actor.kind,
      intent: input.intent,
      status: "draft",
      targetRevisions: input.targetRevisions,
      sourceDependencies: input.sourceDependencies ?? [],
      operations: input.operations,
      validation: { ok: false, errors: [] },
      diffs: {},
      risk: actor.kind === "agent" ? "medium" : "low",
      reviewerIds: input.reviewerIds ?? [],
      idempotencyKey: input.idempotencyKey,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.putChangeset(record);
    return record.id;
  }

  validateChangeset(actor: ActorContext, changesetId: string): ChangesetRecord {
    const record = this.changeset(changesetId, actor.tenantId);
    const errors: string[] = [];
    for (const op of record.operations) {
      if (!this.hasRole(actor, op.resource.kind, op.resource.id, "viewer")) errors.push(`inaccessible ${op.resource.id}`);
      this.assertUntrustedPayload(op.payload);
    }
    record.validation = { ok: errors.length === 0, errors };
    record.status = errors.length === 0 ? "validated" : "draft";
    record.diffs = this.computeDiffs(record);
    record.updatedAt = this.now();
    this.putChangeset(record);
    return record;
  }

  proposeChangeset(actor: ActorContext, changesetId: string, reviewerIds: string[]): ChangesetRecord {
    const record = this.validateChangeset(actor, changesetId);
    if (!record.validation.ok) throw new EnterpriseError("invalid", "changeset is not valid");
    record.status = "proposed";
    record.reviewerIds = reviewerIds;
    record.updatedAt = this.now();
    this.putChangeset(record);
    for (const reviewer of reviewerIds) {
      this.notify(actor.tenantId, reviewer, "Review requested", record.intent, "changeset", record.id);
    }
    this.enqueueOutbox(actor.tenantId, "notification", { changesetId: record.id });
    return record;
  }

  approveChangeset(actor: ActorContext, changesetId: string, patch?: { issueOwnerOverride?: string }): ChangesetRecord {
    const record = this.changeset(changesetId, actor.tenantId);
    if (record.status !== "proposed" && record.status !== "validated") {
      throw new EnterpriseError("invalid", `cannot approve from ${record.status}`);
    }
    if (actor.principalId === record.actorId) throw new EnterpriseError("self_approval", "agents and authors cannot approve their own work");
    if (actor.kind === "agent") throw new EnterpriseError("self_approval", "agents cannot approve");
    for (const op of record.operations) {
      this.requireRole(actor, op.resource.kind, op.resource.id, "reviewer");
    }
    record.status = "approved";
    if (patch?.issueOwnerOverride) record.issueOwnerOverride = patch.issueOwnerOverride;
    record.updatedAt = this.now();
    this.putChangeset(record);
    this.audit(actor, "changeset.approve", "changeset", record.id, { issueOwnerOverride: record.issueOwnerOverride });
    return record;
  }

  applyChangeset(actor: ActorContext, changesetId: string): ChangesetRecord {
    const record = this.changeset(changesetId, actor.tenantId);
    if (record.status !== "approved") throw new EnterpriseError("invalid", "apply requires approval");
    this.assertLiveHeads(record);
    this.assertSourceDependencies(record);
    if (this.killSwitch(actor.tenantId) && record.actorKind === "agent") {
      throw new EnterpriseError("killed", "agent kill switch is enabled");
    }
    try {
      const apply = this.store.db.transaction(() => {
        for (const op of record.operations) this.applyOperation(actor, record, op);
        record.status = "applied";
        record.result = { appliedAt: this.now() };
        record.updatedAt = this.now();
        this.putChangeset(record);
        this.audit(actor, "changeset.apply", "changeset", record.id, { ops: record.operations.length });
        this.enqueueOutbox(actor.tenantId, "search_index", { changesetId: record.id });
        this.enqueueOutbox(actor.tenantId, "notification", { changesetId: record.id, kind: "applied" });
      });
      apply();
    } catch (error) {
      record.status = "failed";
      record.result = { error: error instanceof Error ? error.message : String(error) };
      record.updatedAt = this.now();
      this.putChangeset(record);
      throw error;
    }
    return record;
  }

  runRecipe(actor: ActorContext, recipe: string, payload: Record<string, unknown>): { jobId: string; changesetId?: string } {
    if (this.killSwitch(actor.tenantId)) throw new EnterpriseError("killed", "agent kill switch is enabled");
    const jobId = this.id();
    this.store.db
      .prepare(
        `INSERT INTO jobs(id, tenant_id, recipe, status, actor_id, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(jobId, actor.tenantId, recipe, actor.principalId, JSON.stringify(payload), this.now(), this.now());
    const plan = this.materializeRecipe(actor, recipe, payload);
    this.store.db.prepare("UPDATE jobs SET status = 'succeeded', updated_at = ?, cost_actual = 0 WHERE id = ?").run(this.now(), jobId);
    return { jobId, changesetId: plan };
  }

  drainOutbox(tenantId: string): number {
    const rows = this.store.db.prepare("SELECT * FROM outbox WHERE tenant_id = ? AND processed_at IS NULL").all(tenantId) as Array<{
      id: string;
      kind: string;
      payload_json: string;
    }>;
    for (const row of rows) {
      if (row.kind === "search_index") {
        const payload = JSON.parse(row.payload_json) as { documentId?: string };
        if (payload.documentId) {
          const doc = this.documentRow(payload.documentId, tenantId);
          this.indexDocument(tenantId, doc.id, doc.title, doc.draft_source, doc.draft_hash, doc.published_revision ?? 0, doc.classification);
        }
      }
      this.store.db.prepare("UPDATE outbox SET processed_at = ? WHERE id = ?").run(this.now(), row.id);
    }
    return rows.length;
  }

  // --- connectors / recovery ------------------------------------------------

  inventoryImport(
    actor: ActorContext,
    kind: "confluence" | "jira",
    objects: Array<{ sourceId: string; readable: boolean; type: string; payload: Record<string, unknown> }>,
  ): { connectorId: string; report: Array<{ sourceId: string; disposition: ImportDisposition }> } {
    const connectorId = this.id();
    this.store.db
      .prepare("INSERT INTO connectors(id, tenant_id, kind, mode, created_at) VALUES (?, ?, ?, 'noma_native', ?)")
      .run(connectorId, actor.tenantId, kind, this.now());
    const report: Array<{ sourceId: string; disposition: ImportDisposition }> = [];
    for (const object of objects) {
      const disposition: ImportDisposition = !object.readable
        ? "inaccessible"
        : object.type === "unsupported"
          ? "unsupported"
          : object.payload.unmappedPermission
            ? "quarantined"
            : "imported";
      this.store.db
        .prepare("INSERT INTO import_objects(id, connector_id, source_id, disposition, report_json) VALUES (?, ?, ?, ?, ?)")
        .run(this.id(), connectorId, object.sourceId, disposition, JSON.stringify(object.payload));
      report.push({ sourceId: object.sourceId, disposition });
    }
    return { connectorId, report };
  }

  applyImport(actor: ActorContext, connectorId: string, spaceId: string, mode: ConnectorMode): string[] {
    this.requireRole(actor, "space", spaceId, "owner");
    this.store.db.prepare("UPDATE connectors SET mode = ? WHERE id = ?").run(mode, connectorId);
    const rows = this.store.db
      .prepare("SELECT * FROM import_objects WHERE connector_id = ? AND disposition = 'imported'")
      .all(connectorId) as Array<{ id: string; source_id: string; report_json: string }>;
    const created: string[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.report_json) as { title?: string; source?: string; summary?: string; projectId?: string };
      if (payload.source) {
        const docId = this.createDocument(actor, { spaceId, title: payload.title ?? row.source_id, source: payload.source });
        this.store.db.prepare("UPDATE import_objects SET noma_id = ? WHERE id = ?").run(docId, row.id);
        created.push(docId);
      } else if (payload.summary && payload.projectId) {
        const issue = this.createIssue(actor, { projectId: payload.projectId, typeKey: "task", summary: payload.summary });
        this.store.db.prepare("UPDATE import_objects SET noma_id = ? WHERE id = ?").run(issue.id, row.id);
        created.push(issue.id);
      }
    }
    return created;
  }

  placeLegalHold(actor: ActorContext, input: { resourceKind: ResourceKind; resourceId: string; reason: string }): string {
    this.requireRole(actor, input.resourceKind, input.resourceId, "owner");
    const id = this.id();
    this.store.db
      .prepare(
        `INSERT INTO legal_holds(id, tenant_id, resource_kind, resource_id, reason, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, actor.tenantId, input.resourceKind, input.resourceId, input.reason, actor.principalId, this.now());
    this.audit(actor, "legal_hold", input.resourceKind, input.resourceId, { reason: input.reason });
    return id;
  }

  isOnLegalHold(tenantId: string, resourceId: string): boolean {
    const row = this.store.db
      .prepare("SELECT id FROM legal_holds WHERE tenant_id = ? AND resource_id = ? AND released_at IS NULL")
      .get(tenantId, resourceId);
    return row !== undefined;
  }

  backup(tenantId: string): { digest: string; bundle: Record<string, unknown> } {
    const tenantTables = [
      "principals",
      "spaces",
      "projects",
      "grants",
      "documents",
      "artifacts",
      "issues",
      "changesets",
      "audit_events",
      "references_edge",
      "search_index",
      "policy",
      "notifications",
      "connectors",
    ];
    const data: Record<string, unknown> = {
      tenants: this.store.db.prepare("SELECT * FROM tenants WHERE id = ?").all(tenantId),
    };
    for (const table of tenantTables) {
      data[table] = this.store.db.prepare(`SELECT * FROM ${table} WHERE tenant_id = ?`).all(tenantId);
    }
    const documentIds = (data.documents as Array<{ id: string }>).map((row) => row.id);
    const artifactIds = (data.artifacts as Array<{ id: string }>).map((row) => row.id);
    const issueIds = (data.issues as Array<{ id: string }>).map((row) => row.id);
    data.document_revisions = documentIds.flatMap((id) =>
      this.store.db.prepare("SELECT * FROM document_revisions WHERE document_id = ?").all(id),
    );
    data.artifact_revisions = artifactIds.flatMap((id) =>
      this.store.db.prepare("SELECT * FROM artifact_revisions WHERE artifact_id = ?").all(id),
    );
    data.issue_events = issueIds.flatMap((id) => this.store.db.prepare("SELECT * FROM issue_events WHERE issue_id = ?").all(id));
    data.issue_comments = issueIds.flatMap((id) => this.store.db.prepare("SELECT * FROM issue_comments WHERE issue_id = ?").all(id));
    data.worklogs = issueIds.flatMap((id) => this.store.db.prepare("SELECT * FROM worklogs WHERE issue_id = ?").all(id));
    data.document_comments = documentIds.flatMap((id) => this.store.db.prepare("SELECT * FROM document_comments WHERE document_id = ?").all(id));
    data.document_assets = documentIds.flatMap((id) => this.store.db.prepare("SELECT * FROM document_assets WHERE document_id = ?").all(id));
    data.project_spaces = this.store.db
      .prepare("SELECT ps.* FROM project_spaces ps JOIN projects p ON p.id = ps.project_id WHERE p.tenant_id = ?")
      .all(tenantId);
    const bundle = { format: "noma-enterprise-backup-v1", exportedAt: this.now(), tenantId, data };
    return { digest: sha256Hex(JSON.stringify(bundle)), bundle };
  }

  restore(bundle: Record<string, unknown>, digest: string): void {
    if (sha256Hex(JSON.stringify(bundle)) !== digest) throw new EnterpriseError("invalid", "backup digest mismatch");
    const data = bundle.data as Record<string, Array<Record<string, unknown>>>;
    const insert = this.store.db.transaction(() => {
      for (const [table, rows] of Object.entries(data)) {
        for (const row of rows ?? []) {
          const keys = Object.keys(row);
          if (keys.length === 0) continue;
          const placeholders = keys.map(() => "?").join(", ");
          this.store.db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`).run(...keys.map((key) => row[key]));
        }
      }
    });
    insert();
  }

  exportAudit(actor: ActorContext): { events: unknown[]; digest: string } {
    this.requireRole(actor, "tenant" as ResourceKind, actor.tenantId, "owner");
    const events = this.store.db.prepare("SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY created_at").all(actor.tenantId);
    return { events, digest: sha256Hex(JSON.stringify(events)) };
  }

  notifications(actor: ActorContext): Array<Record<string, unknown>> {
    return this.store.db
      .prepare("SELECT * FROM notifications WHERE tenant_id = ? AND user_id = ? ORDER BY created_at")
      .all(actor.tenantId, actor.principalId) as Array<Record<string, unknown>>;
  }

  artifactExportReport(actor: ActorContext, artifactId: string, target: "pptx" | "svg" | "png") {
    const { document } = this.readArtifact(actor, artifactId, "draft");
    return exportFidelityReport(document, target);
  }

  throughput(actor: ActorContext, projectId: string) {
    this.requireRole(actor, "project", projectId, "viewer");
    const events = this.projectIssueEvents(projectId);
    return throughputFromEvents(events);
  }

  cycleTime(actor: ActorContext, projectId: string) {
    this.requireRole(actor, "project", projectId, "viewer");
    return cycleTimeFromEvents(this.projectIssueEvents(projectId));
  }

  cumulativeFlow(actor: ActorContext, projectId: string) {
    this.requireRole(actor, "project", projectId, "viewer");
    return cumulativeFlowFromEvents(this.projectIssueEvents(projectId));
  }

  projectReports(actor: ActorContext, projectId: string) {
    this.requireRole(actor, "project", projectId, "viewer");
    const events = this.projectIssueEvents(projectId);
    const issues = this.store.db.prepare("SELECT id, key, summary FROM issues WHERE project_id = ? AND tenant_id = ?").all(projectId, actor.tenantId) as Array<{
      id: string;
      key: string;
      summary: string;
    }>;
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    return {
      throughput: throughputFromEvents(events),
      cycleTime: cycleTimeFromEvents(events).map((row) => ({
        ...row,
        key: byId.get(row.issueId)?.key ?? row.issueId,
        summary: byId.get(row.issueId)?.summary ?? "",
      })),
      cumulativeFlow: cumulativeFlowFromEvents(events),
    };
  }

  bulkEditPreview(
    actor: ActorContext,
    issueIds: string[],
    mutation: { status?: string; assigneeId?: string; labels?: string[] },
  ): { wouldChange: Array<{ id: string; before: Record<string, unknown>; after: Record<string, unknown> }>; blocked: string[] } {
    const wouldChange: Array<{ id: string; before: Record<string, unknown>; after: Record<string, unknown> }> = [];
    const blocked: string[] = [];
    for (const id of issueIds) {
      const issue = this.store.db.prepare("SELECT * FROM issues WHERE id = ? AND tenant_id = ?").get(id, actor.tenantId) as
        | Record<string, unknown>
        | undefined;
      if (!issue || !this.canSeeIssue(actor, issue)) {
        blocked.push(id);
        continue;
      }
      this.requireRole(actor, "project", String(issue.project_id), "editor");
      const after = { ...issue };
      if (mutation.status) after.status_id = mutation.status;
      if (mutation.assigneeId) after.assignee_id = mutation.assigneeId;
      if (mutation.labels) after.labels_json = JSON.stringify(mutation.labels);
      wouldChange.push({ id, before: issue, after });
    }
    return { wouldChange, blocked };
  }

  defineIssueSecurityLevel(actor: ActorContext, projectId: string, name: string): string {
    this.requireRole(actor, "project", projectId, "owner");
    const id = this.id();
    this.store.db
      .prepare("INSERT INTO issue_security_levels(id, tenant_id, project_id, name) VALUES (?, ?, ?, ?)")
      .run(id, actor.tenantId, projectId, name);
    return id;
  }

  grantIssueSecurity(actor: ActorContext, levelId: string, principalId: string): void {
    const level = this.store.db.prepare("SELECT project_id FROM issue_security_levels WHERE id = ?").get(levelId) as { project_id: string } | undefined;
    if (!level) throw new EnterpriseError("not_found", "security level not found");
    this.requireRole(actor, "project", level.project_id, "owner");
    this.store.db.prepare("INSERT OR IGNORE INTO issue_security_grants(level_id, principal_id) VALUES (?, ?)").run(levelId, principalId);
  }

  setIssueSecurity(actor: ActorContext, issueId: string, levelId: string): void {
    const issue = this.issueRow(issueId, actor.tenantId);
    this.requireRole(actor, "project", issue.project_id, "owner");
    this.store.db.prepare("UPDATE issues SET security_level_id = ?, updated_at = ? WHERE id = ?").run(levelId, this.now(), issueId);
  }

  importConfluenceStorage(actor: ActorContext, spaceId: string, xml: string, title: string): { documentId: string; lossReport: unknown[] } {
    this.requireRole(actor, "space", spaceId, "editor");
    const mapped = parseConfluenceStorage(xml, title);
    const documentId = this.createDocument(actor, { spaceId, title: mapped.title, source: mapped.source });
    return { documentId, lossReport: mapped.lossReport };
  }

  async importLiveConfluencePage(
    actor: ActorContext,
    spaceId: string,
    auth: AtlassianAuth,
    pageId: string,
    http?: AtlassianHttp,
  ): Promise<{ documentId: string; lossReport: unknown[] }> {
    this.requireRole(actor, "space", spaceId, "editor");
    const mapped = await fetchConfluencePage(auth, pageId, http);
    const documentId = this.createDocument(actor, { spaceId, title: mapped.title, source: mapped.source });
    return { documentId, lossReport: mapped.lossReport };
  }

  async importLiveJiraIssue(
    actor: ActorContext,
    projectId: string,
    auth: AtlassianAuth,
    key: string,
    http?: AtlassianHttp,
  ): Promise<{ id: string; key: string }> {
    return this.importJiraIssue(actor, projectId, await fetchJiraIssuePayload(auth, key, http));
  }

  importJiraIssue(actor: ActorContext, projectId: string, payload: Record<string, unknown>): { id: string; key: string } {
    this.requireRole(actor, "project", projectId, "editor");
    const mapped = parseJiraIssue(payload);
    const created = this.createIssue(actor, {
      projectId,
      typeKey: mapped.typeKey,
      summary: mapped.summary,
      labels: mapped.labels,
    });
    for (const comment of mapped.comments) {
      this.store.db
        .prepare("INSERT INTO issue_comments(id, issue_id, body, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(this.id(), created.id, comment, actor.principalId, mapped.createdAt ?? this.now());
    }
    for (const log of mapped.worklogs) {
      this.logWork(actor, { issueId: created.id, durationSeconds: log.durationSeconds, note: `imported from ${log.author}` });
    }
    return created;
  }

  assertImporterUrl(url: string): void {
    assertSafeImportUrl(url);
  }

  startCutover(
    actor: ActorContext,
    connectorId: string,
    inventoried: Array<{ sourceId: string }>,
    report: Array<{ sourceId: string; disposition: ImportDisposition }>,
  ): string {
    this.requireRole(actor, "tenant" as ResourceKind, actor.tenantId, "owner");
    const reconciliation = reconcileInventory(inventoried, report);
    if (!reconciliation.complete) throw new EnterpriseError("invalid", "inventory is incomplete", { missing: reconciliation.missing });
    const id = this.id();
    this.store.db
      .prepare("INSERT INTO cutover_runs(id, tenant_id, connector_id, stage, report_json, updated_at) VALUES (?, ?, ?, 'inventory', ?, ?)")
      .run(id, actor.tenantId, connectorId, JSON.stringify({ inventoried, report }), this.now());
    return id;
  }

  advanceCutover(actor: ActorContext, runId: string): CutoverStage {
    this.requireRole(actor, "tenant" as ResourceKind, actor.tenantId, "owner");
    const row = this.store.db.prepare("SELECT * FROM cutover_runs WHERE id = ? AND tenant_id = ?").get(runId, actor.tenantId) as
      | { stage: CutoverStage }
      | undefined;
    if (!row) throw new EnterpriseError("not_found", "cutover run not found");
    const stage = nextCutoverStage(row.stage);
    this.store.db.prepare("UPDATE cutover_runs SET stage = ?, updated_at = ? WHERE id = ?").run(stage, this.now(), runId);
    return stage;
  }

  cutoverStage(runId: string): CutoverStage {
    const row = this.store.db.prepare("SELECT stage FROM cutover_runs WHERE id = ?").get(runId) as { stage: CutoverStage } | undefined;
    if (!row) throw new EnterpriseError("not_found", "cutover run not found");
    return row.stage;
  }

  evaluateRetrieval(actor: ActorContext, fixtures: RagEvalFixture[]) {
    const results = fixtures.map((fixture) => {
      const hits = this.search(actor, fixture.question).map((hit) => ({
        resourceId: String(hit.resourceId),
        citation: hit.citation as { resource: string; blockId?: string | null; version?: string } | undefined,
      }));
      const scored = evaluateRagFixture(fixture, hits, (resourceId) => {
        try {
          return this.hasRole(actor, "document", resourceId, "viewer");
        } catch {
          return false;
        }
      });
      this.store.db
        .prepare("INSERT INTO rag_evals(id, tenant_id, fixture_id, result_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(this.id(), actor.tenantId, fixture.id, JSON.stringify(scored), this.now());
      return scored;
    });
    return summarizeRagEvals(results);
  }

  recordKnowledgeHealth(
    actor: ActorContext,
    input: { kind: "stale_review" | "changed_source" | "contradiction_candidate"; resourceId: string; blockId?: string; detail: Record<string, unknown> },
  ): string {
    this.requireRole(actor, "document", input.resourceId, "editor");
    const id = this.id();
    this.store.db
      .prepare(
        `INSERT INTO knowledge_health(id, tenant_id, kind, resource_id, block_id, detail_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, actor.tenantId, input.kind, input.resourceId, input.blockId ?? null, JSON.stringify(input.detail), this.now());
    return id;
  }

  knowledgeQueue(actor: ActorContext): Array<Record<string, unknown>> {
    return this.store.db
      .prepare("SELECT * FROM knowledge_health WHERE tenant_id = ? ORDER BY created_at")
      .all(actor.tenantId)
      .filter((row) => {
        const record = row as { resource_id: string };
        return this.hasRole(actor, "document", record.resource_id, "viewer");
      }) as Array<Record<string, unknown>>;
  }

  updateIdentifiedTableCell(actor: ActorContext, documentId: string, tableId: string, cellId: string, value: string): string {
    this.requireRole(actor, "document", documentId, "editor");
    const doc = this.documentRow(documentId, actor.tenantId);
    const parsed = parse(doc.draft_source);
    const table = findNodeByAnyId(parsed, tableId);
    if (!table || table.type !== "table") throw new EnterpriseError("not_found", "table not found");
    updateTableCellById(table, { cellId }, value);
    const source = renderNoma(parsed);
    const editor = nomaToEditor(parsed);
    const hash = sha256Hex(source);
    this.store.db
      .prepare("UPDATE documents SET draft_source = ?, draft_hash = ?, draft_revision = draft_revision + 1, crdt_json = ?, updated_at = ? WHERE id = ?")
      .run(source, hash, JSON.stringify(editor), this.now(), documentId);
    return hash;
  }

  insertIdentifiedTableRow(actor: ActorContext, documentId: string, tableId: string, at: number, cells: string[]): string {
    this.requireRole(actor, "document", documentId, "editor");
    const doc = this.documentRow(documentId, actor.tenantId);
    const parsed = parse(doc.draft_source);
    const table = findNodeByAnyId(parsed, tableId) as TableNode | undefined;
    if (!table || table.type !== "table") throw new EnterpriseError("not_found", "table not found");
    const rowId = insertTableRowWithIdentities(table, at, cells, this.identityFactory);
    const source = renderNoma(parsed);
    this.store.db
      .prepare("UPDATE documents SET draft_source = ?, draft_hash = ?, draft_revision = draft_revision + 1, crdt_json = ?, updated_at = ? WHERE id = ?")
      .run(source, sha256Hex(source), JSON.stringify(nomaToEditor(parsed)), this.now(), documentId);
    return rowId;
  }

  // --- internals ------------------------------------------------------------

  private ensureDefaultWorkConfig(actor: ActorContext, projectId: string): void {
    const types: Array<{ key: string; name: string; hierarchy: IssueHierarchyType }> = [
      { key: "epic", name: "Epic", hierarchy: "epic" },
      { key: "story", name: "Story", hierarchy: "story" },
      { key: "task", name: "Task", hierarchy: "task" },
      { key: "bug", name: "Bug", hierarchy: "bug" },
      { key: "subtask", name: "Subtask", hierarchy: "subtask" },
    ];
    for (const type of types) this.defineIssueType(actor, projectId, type);
    this.activateWorkflow(actor, projectId, {
      version: 1,
      statuses: DEFAULT_STATUSES,
      transitions: [
        { id: "start", from: "backlog", to: "todo" },
        { id: "unstart", from: "todo", to: "backlog" },
        { id: "begin", from: "todo", to: "in_progress" },
        { id: "pause", from: "in_progress", to: "todo" },
        { id: "review", from: "in_progress", to: "in_review" },
        { id: "unreview", from: "in_review", to: "in_progress" },
        { id: "complete", from: "in_review", to: "done", requiredFields: ["resolution"] },
        { id: "cancel", from: "in_progress", to: "cancelled", requireDecision: true },
        { id: "reopen", from: "done", to: "todo" },
      ],
    });
    this.createBoard(actor, { projectId, name: "Board", kind: "kanban" });
  }

  private assertHierarchy(parentId: string, child: IssueHierarchyType): void {
    const parent = this.store.db.prepare("SELECT type_id, parent_id FROM issues WHERE id = ?").get(parentId) as
      | { type_id: string; parent_id: string | null }
      | undefined;
    if (!parent) throw new EnterpriseError("invalid", "parent issue not found");
    const parentType = this.store.db.prepare("SELECT hierarchy FROM issue_types WHERE id = ?").get(parent.type_id) as {
      hierarchy: IssueHierarchyType;
    };
    const allowed: Record<IssueHierarchyType, IssueHierarchyType[]> = {
      epic: [],
      story: ["epic"],
      task: ["story", "epic"],
      bug: ["story", "epic"],
      subtask: ["task", "bug", "story"],
    };
    if (!allowed[child].includes(parentType.hierarchy)) {
      throw new EnterpriseError("invalid", `invalid hierarchy ${parentType.hierarchy} → ${child}`);
    }
    const seen = new Set<string>([parentId]);
    let cursor = parent.parent_id;
    while (cursor) {
      if (seen.has(cursor)) throw new EnterpriseError("invalid", "issue hierarchy cycle");
      seen.add(cursor);
      cursor = (this.store.db.prepare("SELECT parent_id FROM issues WHERE id = ?").get(cursor) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
  }

  private applyOperation(actor: ActorContext, changeset: ChangesetRecord, op: ChangesetOperation): void {
    if (op.op === "update_table_cell") {
      const tableId = String(op.payload.tableId ?? "");
      const cellId = String(op.payload.cellId ?? "");
      const value = String(op.payload.value ?? "");
      this.updateIdentifiedTableCell(actor, op.resource.id, tableId, cellId, value);
      return;
    }
    if (op.op === "replace_paragraph") {
      const doc = this.documentRow(op.resource.id, actor.tenantId);
      const parsed = parse(doc.draft_source);
      const node = findNodeByAnyId(parsed, String(op.payload.blockId ?? op.resource.blockId ?? ""));
      if (!node || node.type !== "paragraph") throw new EnterpriseError("not_found", "paragraph not found");
      node.content = String(op.payload.content ?? "");
      const source = renderNoma(parsed);
      this.store.db
        .prepare("UPDATE documents SET draft_source = ?, draft_hash = ?, draft_revision = draft_revision + 1, crdt_json = ?, updated_at = ? WHERE id = ?")
        .run(source, sha256Hex(source), JSON.stringify(nomaToEditor(parsed)), this.now(), op.resource.id);
      return;
    }
    if (op.op === "update_chart") {
      const artifactId = op.resource.id;
      const commands: VisualCommand[] = [
        {
          op: "update_chart",
          elementId: String(op.payload.elementId ?? ""),
          chart: op.payload.chart as { datasetId: string; datasetRevision: number; values: number[]; labels: string[]; units?: string },
        },
      ];
      const artifact = this.artifactRow(artifactId, actor.tenantId);
      this.applyArtifactCommands(actor, artifactId, commands, artifact.draft_revision);
      return;
    }
    if (op.op === "create_issue") {
      const created = this.createIssue(actor, {
        projectId: String(op.payload.projectId ?? ""),
        typeKey: String(op.payload.typeKey ?? "task"),
        summary: String(op.payload.summary ?? ""),
        assigneeId: changeset.issueOwnerOverride ?? (typeof op.payload.assigneeId === "string" ? op.payload.assigneeId : undefined),
        accountableId: typeof op.payload.accountableId === "string" ? op.payload.accountableId : actor.principalId,
      });
      if (typeof op.payload.requirementBlockId === "string") {
        this.putReference(actor, {
          from: { kind: "document", id: String(op.payload.documentId ?? ""), blockId: op.payload.requirementBlockId },
          to: { kind: "issue", id: created.id },
          relation: "implements",
          authoritative: true,
        });
      }
      return;
    }
    if (op.op === "replace_source") {
      const source = String(op.payload.source ?? "");
      const parsed = assignPersistentIdentities(parse(source), { factory: this.identityFactory });
      const rendered = renderNoma(parsed);
      this.store.db
        .prepare("UPDATE documents SET draft_source = ?, draft_hash = ?, draft_revision = draft_revision + 1, crdt_json = ?, updated_at = ? WHERE id = ?")
        .run(rendered, sha256Hex(rendered), JSON.stringify(nomaToEditor(parsed)), this.now(), op.resource.id);
      return;
    }
    throw new EnterpriseError("invalid", `unsupported operation ${op.op}`);
  }

  private computeDiffs(record: ChangesetRecord): { text?: string; visual?: string } {
    const text = record.operations
      .filter((op) => op.op === "update_table_cell" || op.op === "replace_paragraph")
      .map((op) => `${op.op}:${JSON.stringify(op.payload)}`)
      .join("\n");
    const visual = record.operations
      .filter((op) => op.op === "update_chart")
      .map((op) => `${op.op}:${String(op.payload.elementId ?? "")}`)
      .join("\n");
    return { text, visual };
  }

  private assertLiveHeads(record: ChangesetRecord): void {
    for (const [resourceId, revision] of Object.entries(record.targetRevisions)) {
      const doc = this.store.db.prepare("SELECT draft_revision FROM documents WHERE id = ?").get(resourceId) as
        | { draft_revision: number }
        | undefined;
      if (doc && doc.draft_revision !== revision) {
        throw new EnterpriseError("stale_revision", "live draft changed since approval", { resourceId, expected: revision, actual: doc.draft_revision });
      }
      const artifact = this.store.db.prepare("SELECT draft_revision FROM artifacts WHERE id = ?").get(resourceId) as
        | { draft_revision: number }
        | undefined;
      if (artifact && artifact.draft_revision !== revision) {
        throw new EnterpriseError("stale_revision", "artifact changed since approval", { resourceId, expected: revision, actual: artifact.draft_revision });
      }
    }
  }

  private assertSourceDependencies(record: ChangesetRecord): void {
    for (const dep of record.sourceDependencies) {
      if (dep.resource.kind === "document") {
        const doc = this.documentRow(dep.resource.id, record.tenantId);
        if (doc.draft_hash !== dep.hash && (doc.published_revision === null || this.revisionHash(dep.resource.id, dep.resource.revision ?? 0) !== dep.hash)) {
          throw new EnterpriseError("stale_revision", "source dependency changed", { id: dep.resource.id });
        }
      }
    }
  }

  private revisionHash(documentId: string, revision: number): string | undefined {
    const row = this.store.db
      .prepare("SELECT hash FROM document_revisions WHERE document_id = ? AND revision = ?")
      .get(documentId, revision) as { hash: string } | undefined;
    return row?.hash;
  }

  private materializeRecipe(actor: ActorContext, recipe: string, payload: Record<string, unknown>): string {
    const plan = buildRecipePlan(recipe, payload);
    const targetRevisions: Record<string, number> = {};
    for (const op of plan.operations) {
      if (op.resource.kind === "document" && op.resource.id !== "new") {
        targetRevisions[op.resource.id] = this.documentRow(op.resource.id, actor.tenantId).draft_revision;
      }
    }
    return this.draftChangeset(actor, {
      intent: plan.intent,
      operations: plan.operations,
      targetRevisions,
      idempotencyKey: `recipe:${recipe}:${this.id()}`,
    });
  }

  private assertUntrustedPayload(payload: Record<string, unknown>): void {
    const banned = ["grant", "approve", "kill_switch", "capabilities", "destinationAllowlist"];
    const encoded = JSON.stringify(payload).toLowerCase();
    for (const key of banned) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        throw new EnterpriseError("policy", "untrusted content attempted a privileged field", { key });
      }
    }
    if (encoded.includes("ignore previous instructions")) {
      throw new EnterpriseError("policy", "prompt-injection markers are not executable");
    }
  }

  private parseJqlSubset(jql: string, currentUserId: string): QueryAst {
    const clauses: QueryAst[] = [];
    const parts = jql.split(/\s+AND\s+/i);
    for (const part of parts) {
      const match = part.trim().match(/^(\w+)\s*=\s*(.+)$/);
      if (!match) throw new EnterpriseError("invalid", `unsupported JQL fragment: ${part}`);
      const field = match[1]!;
      let value = match[2]!.trim().replace(/^"|"$/g, "");
      if (value === "currentUser()") value = currentUserId;
      if (field === "status") clauses.push({ type: "eq", field: "status_id", value });
      else if (field === "assignee") clauses.push({ type: "eq", field: "assignee_id", value });
      else if (field === "issuetype" || field === "type") clauses.push({ type: "eq", field: "type_id", value });
      else if (field === "priority") clauses.push({ type: "eq", field: "priority", value });
      else if (field === "duedate" || field === "due") clauses.push({ type: "eq", field: "due_at", value });
      else throw new EnterpriseError("invalid", `unsupported JQL field ${field}`, { field, reported: true });
    }
    return { type: "and", clauses };
  }

  private matchQuery(issue: Record<string, unknown>, ast: QueryAst): boolean {
    if (ast.type === "and") return (ast.clauses ?? []).every((clause) => this.matchQuery(issue, clause));
    if (ast.type === "or") return (ast.clauses ?? []).some((clause) => this.matchQuery(issue, clause));
    const actual = issue[ast.field ?? ""];
    if (ast.type === "eq") return String(actual ?? "") === String(ast.value ?? "");
    if (ast.type === "neq") return String(actual ?? "") !== String(ast.value ?? "");
    if (ast.type === "contains") return String(actual ?? "").includes(String(ast.value ?? ""));
    if (ast.type === "in") return Array.isArray(ast.value) && ast.value.map(String).includes(String(actual ?? ""));
    return false;
  }

  private validateFieldValue(type: FieldType, value: unknown, options?: string[]): void {
    if (type === "text" && typeof value !== "string") throw new EnterpriseError("invalid", "text field");
    if (type === "number" && typeof value !== "number") throw new EnterpriseError("invalid", "number field");
    if (type === "boolean" && typeof value !== "boolean") throw new EnterpriseError("invalid", "boolean field");
    if (type === "select" && (typeof value !== "string" || (options && !options.includes(value)))) {
      throw new EnterpriseError("invalid", "select field");
    }
    if (type === "multi_select" && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
      throw new EnterpriseError("invalid", "multi-select field");
    }
  }

  private denyHostileAsset(mime: string, bytes: Buffer): void {
    if (bytes.length > 25_000_000) throw new EnterpriseError("invalid", "asset too large");
    if (mime === "text/html") throw new EnterpriseError("invalid", "html assets are not accepted");
    if (bytes.includes(Buffer.from("<?php"))) throw new EnterpriseError("invalid", "asset failed malware scan");
  }

  private indexDocument(
    tenantId: string,
    documentId: string,
    title: string,
    source: string,
    hash: string,
    revision: number,
    classification: Classification,
  ): void {
    this.store.db.prepare("DELETE FROM search_index WHERE resource_id = ?").run(documentId);
    const parsed: DocumentNode = parse(source);
    const visit = (node: DocumentNode["children"][number]): void => {
      const body =
        node.type === "paragraph" || node.type === "quote"
          ? node.content
          : node.type === "section"
            ? node.title
            : node.type === "directive"
              ? `${node.name} ${node.body ?? ""}`
              : node.type === "table"
                ? [...node.header, ...node.rows.flat()].join(" ")
                : "";
      if (body) {
        this.store.db
          .prepare(
            `INSERT INTO search_index(id, tenant_id, resource_kind, resource_id, block_id, revision, hash, classification, title, body)
             VALUES (?, ?, 'document', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(this.id(), tenantId, documentId, node.id ?? null, revision, hash, classification, title, body);
      }
      if (node.type === "section" || node.type === "directive") node.children.forEach(visit);
    };
    parsed.children.forEach(visit);
  }

  private enqueueOutbox(tenantId: string, kind: string, payload: Record<string, unknown>): void {
    this.store.db
      .prepare("INSERT INTO outbox(id, tenant_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(this.id(), tenantId, kind, JSON.stringify(payload), this.now());
  }

  private notify(tenantId: string, userId: string, title: string, body: string, kind?: string, id?: string): void {
    this.store.db
      .prepare(
        `INSERT INTO notifications(id, tenant_id, user_id, title, body, resource_kind, resource_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.id(), tenantId, userId, title, body, kind ?? null, id ?? null, this.now());
  }

  private nextDocumentRank(spaceId: string, parentId: string | null): string {
    const row = (
      parentId
        ? this.store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE space_id = ? AND parent_id = ?").get(spaceId, parentId)
        : this.store.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE space_id = ? AND parent_id IS NULL").get(spaceId)
    ) as { n: number };
    return `n:${String((Number(row.n) + 1) * 1000).padStart(8, "0")}`;
  }

  private assertDocumentParent(tenantId: string, spaceId: string, parentId: string): void {
    const parent = this.store.db.prepare("SELECT space_id, tenant_id FROM documents WHERE id = ?").get(parentId) as
      | { space_id: string; tenant_id: string }
      | undefined;
    if (!parent || parent.tenant_id !== tenantId || parent.space_id !== spaceId) {
      throw new EnterpriseError("invalid", "parent page is not in this space");
    }
  }

  private resolveMentions(tenantId: string, body: string): string[] {
    const tokens = new Set<string>();
    for (const match of body.matchAll(/@\{([^}]+)\}/g)) tokens.add(match[1]!.trim().toLowerCase());
    for (const match of body.matchAll(/@([A-Za-z0-9._-]+)/g)) tokens.add(match[1]!.toLowerCase());
    if (tokens.size === 0) return [];
    const principals = this.store.db
      .prepare("SELECT id, name, email, external_id FROM principals WHERE tenant_id = ? AND active = 1")
      .all(tenantId) as Array<{ id: string; name: string; email: string | null; external_id: string | null }>;
    const ids: string[] = [];
    for (const token of tokens) {
      const row = principals.find((principal) => {
        const first = principal.name.split(/\s+/)[0]?.toLowerCase();
        return (
          principal.id.toLowerCase() === token ||
          (principal.external_id ?? "").toLowerCase() === token ||
          (principal.email ?? "").toLowerCase() === token ||
          principal.name.toLowerCase() === token ||
          first === token
        );
      });
      if (row) ids.push(row.id);
    }
    return [...new Set(ids)];
  }

  private audit(actor: ActorContext, action: string, kind: string, id: string, detail: Record<string, unknown>): void {
    const prev = this.store.db
      .prepare("SELECT hash FROM audit_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(actor.tenantId) as { hash: string } | undefined;
    const createdAt = this.now();
    const payload = { actor: actor.principalId, action, kind, id, detail, createdAt, prev: prev?.hash ?? "genesis" };
    const hash = sha256Hex(JSON.stringify(payload));
    this.store.db
      .prepare(
        `INSERT INTO audit_events(id, tenant_id, actor_id, action, resource_kind, resource_id, detail_json, created_at, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.id(), actor.tenantId, actor.principalId, action, kind, id, JSON.stringify(detail), createdAt, prev?.hash ?? null, hash);
  }

  private putChangeset(record: ChangesetRecord): void {
    const json = JSON.stringify(record);
    this.store.db
      .prepare(
        `INSERT INTO changesets(id, tenant_id, record_json, status, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(record.id, record.tenantId, json, record.status, record.idempotencyKey, record.createdAt, record.updatedAt);
  }

  changeset(id: string, tenantId: string): ChangesetRecord {
    const row = this.store.db.prepare("SELECT record_json FROM changesets WHERE id = ? AND tenant_id = ?").get(id, tenantId) as
      | { record_json: string }
      | undefined;
    if (!row) throw new EnterpriseError("not_found", "changeset not found");
    return JSON.parse(row.record_json) as ChangesetRecord;
  }

  private killSwitch(tenantId: string): boolean {
    const row = this.store.db.prepare("SELECT kill_switch FROM policy WHERE tenant_id = ?").get(tenantId) as { kill_switch: number } | undefined;
    return row?.kill_switch === 1;
  }

  private principal(id: string): PrincipalRow {
    const row = this.store.db.prepare("SELECT * FROM principals WHERE id = ?").get(id) as PrincipalRow | undefined;
    if (!row) throw new EnterpriseError("not_found", "principal not found");
    return row;
  }

  private documentRow(id: string, tenantId: string): {
    id: string;
    title: string;
    draft_source: string;
    draft_hash: string;
    draft_revision: number;
    published_revision: number | null;
    classification: Classification;
    update_log_json: string;
    space_id: string;
    owner_id: string;
    parent_id: string | null;
  } {
    const row = this.store.db.prepare("SELECT * FROM documents WHERE id = ? AND tenant_id = ?").get(id, tenantId) as
      | {
          id: string;
          title: string;
          draft_source: string;
          draft_hash: string;
          draft_revision: number;
          published_revision: number | null;
          classification: Classification;
          update_log_json: string;
          space_id: string;
          owner_id: string;
          parent_id: string | null;
        }
      | undefined;
    if (!row) throw new EnterpriseError("not_found", "document not found");
    return row;
  }

  private artifactRow(id: string, tenantId: string): {
    draft_json: string;
    draft_revision: number;
    published_revision: number | null;
  } {
    const row = this.store.db.prepare("SELECT * FROM artifacts WHERE id = ? AND tenant_id = ?").get(id, tenantId) as
      | { draft_json: string; draft_revision: number; published_revision: number | null }
      | undefined;
    if (!row) throw new EnterpriseError("not_found", "artifact not found");
    return row;
  }

  private artifactRevision(id: string, revision: number): PaperDocument {
    const row = this.store.db
      .prepare("SELECT document_json FROM artifact_revisions WHERE artifact_id = ? AND revision = ?")
      .get(id, revision) as { document_json: string } | undefined;
    if (!row) throw new EnterpriseError("not_found", "artifact revision not found");
    return JSON.parse(row.document_json) as PaperDocument;
  }

  private issueRow(id: string, tenantId: string): {
    id: string;
    project_id: string;
    status_id: string;
    resolution: string | null;
    assignee_id: string | null;
    summary: string;
  } {
    const row = this.store.db.prepare("SELECT * FROM issues WHERE id = ? AND tenant_id = ?").get(id, tenantId) as
      | {
          id: string;
          project_id: string;
          status_id: string;
          resolution: string | null;
          assignee_id: string | null;
          summary: string;
        }
      | undefined;
    if (!row) throw new EnterpriseError("not_found", "issue not found");
    return row;
  }

  private activeWorkflow(projectId: string): WorkflowDefinition {
    const row = this.store.db.prepare("SELECT definition_json FROM workflows WHERE project_id = ? AND activated = 1").get(projectId) as
      | { definition_json: string }
      | undefined;
    if (!row) throw new EnterpriseError("invalid", "no active workflow");
    return JSON.parse(row.definition_json) as WorkflowDefinition;
  }

  private projectIssueEvents(projectId: string) {
    return this.store.db
      .prepare(
        `SELECT e.issue_id, e.action, e.created_at, e.detail_json, i.estimate, i.status_id
         FROM issue_events e JOIN issues i ON i.id = e.issue_id
         WHERE i.project_id = ? ORDER BY e.created_at`,
      )
      .all(projectId) as Array<{ issue_id: string; action: string; created_at: string; detail_json: string; estimate: number | null; status_id: string }>;
  }

  private canSeeIssue(actor: ActorContext, issue: Record<string, unknown>): boolean {
    if (!this.hasRole(actor, "project", String(issue.project_id), "viewer")) return false;
    const levelId = issue.security_level_id;
    if (!levelId) return true;
    if (issue.reporter_id === actor.principalId || issue.assignee_id === actor.principalId) return true;
    if (this.hasRole(actor, "project", String(issue.project_id), "owner")) return true;
    const grant = this.store.db
      .prepare("SELECT principal_id FROM issue_security_grants WHERE level_id = ? AND principal_id = ?")
      .get(levelId, actor.principalId);
    return grant !== undefined;
  }

  private issueEvent(issueId: string, actorId: string, action: string, detail: Record<string, unknown>): void {
    this.store.db
      .prepare("INSERT INTO issue_events(id, issue_id, actor_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.id(), issueId, actorId, action, JSON.stringify(detail), this.now());
  }

  private assertSession(actor: ActorContext): void {
    const session = this.store.db.prepare("SELECT revoked_at, expires_at FROM sessions WHERE id = ?").get(actor.sessionId) as
      | { revoked_at: string | null; expires_at: string }
      | undefined;
    if (!session || session.revoked_at || session.expires_at <= this.now()) {
      throw new EnterpriseError("unauthorized", "session is not active");
    }
  }

  private requireRole(actor: ActorContext, kind: ResourceKind, id: string, min: GrantRole): void {
    if (!this.hasRole(actor, kind, id, min)) {
      throw new EnterpriseError("forbidden", `missing ${min} on ${kind}:${id}`);
    }
  }

  hasRole(actor: ActorContext, kind: ResourceKind, id: string, min: GrantRole): boolean {
    this.assertSession(actor);
    if (kind === "tenant" && id === actor.tenantId) {
      const owner = this.store.db
        .prepare("SELECT role FROM grants WHERE tenant_id = ? AND principal_id = ? AND resource_kind = 'tenant' AND resource_id = ?")
        .get(actor.tenantId, actor.principalId, id) as { role: GrantRole } | undefined;
      if (owner && ROLE_RANK[owner.role] >= ROLE_RANK[min]) return true;
    }
    const grant = this.effectiveGrant(actor, kind, id);
    return grant !== undefined && ROLE_RANK[grant] >= ROLE_RANK[min];
  }

  private effectiveGrant(actor: ActorContext, kind: ResourceKind, id: string): GrantRole | undefined {
    const direct = this.store.db
      .prepare("SELECT role FROM grants WHERE tenant_id = ? AND principal_id = ? AND resource_kind = ? AND resource_id = ?")
      .get(actor.tenantId, actor.principalId, kind, id) as { role: GrantRole } | undefined;
    if (direct) return direct.role;
    if (kind === "asset") {
      const linked = this.store.db
        .prepare("SELECT document_id FROM document_assets WHERE asset_id = ?")
        .all(id) as Array<{ document_id: string }>;
      for (const row of linked) {
        const inherited = this.effectiveGrant(actor, "document", row.document_id);
        if (inherited) return inherited;
      }
    }
    if (kind === "document") {
      const doc = this.store.db.prepare("SELECT space_id FROM documents WHERE id = ?").get(id) as { space_id: string } | undefined;
      if (doc) return this.effectiveGrant(actor, "space", doc.space_id);
    }
    if (kind === "artifact") {
      const art = this.store.db.prepare("SELECT space_id FROM artifacts WHERE id = ?").get(id) as { space_id: string } | undefined;
      if (art) return this.effectiveGrant(actor, "space", art.space_id);
    }
    if (kind === "issue") {
      const issue = this.store.db.prepare("SELECT project_id FROM issues WHERE id = ?").get(id) as { project_id: string } | undefined;
      if (issue) return this.effectiveGrant(actor, "project", issue.project_id);
    }
    return undefined;
  }

  maxClassification(classes: Classification[]): Classification {
    return classes.reduce((max, item) => (CLASSIFICATION_RANK[item] > CLASSIFICATION_RANK[max] ? item : max), "public" as Classification);
  }
}

export function createTestOidc(users: Record<string, { sub: string; email: string; name: string; groups?: string[] }>): OidcAdapter {
  return {
    verify(idToken: string) {
      const claims = users[idToken];
      if (!claims) throw new EnterpriseError("unauthorized", "invalid oidc token");
      return claims;
    },
  };
}
