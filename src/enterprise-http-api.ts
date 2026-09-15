import type { IncomingMessage, ServerResponse } from "node:http";
import { EnterpriseError, type ActorContext } from "./enterprise-contracts.js";
import type { CrdtOp } from "./enterprise-crdt.js";
import type { EnterpriseWorkspace } from "./enterprise-workspace.js";
import { paperCanvasMarkup, paperCanvasStyles } from "./enterprise-paperdom.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendBytes(res: ServerResponse, mime: string, bytes: Buffer): void {
  res.writeHead(200, { "content-type": mime, "content-length": bytes.length });
  res.end(bytes);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export async function dispatchEnterpriseApi(
  ws: EnterpriseWorkspace,
  actor: ActorContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/v1/workspace") {
    send(res, 200, ws.workspaceShell(actor));
    return true;
  }
  if (method === "GET" && path === "/v1/search") {
    send(res, 200, { hits: ws.search(actor, url.searchParams.get("q") ?? "") });
    return true;
  }
  if (method === "GET" && path === "/v1/notifications") {
    send(res, 200, { notifications: ws.notifications(actor) });
    return true;
  }
  const notifyRead = path.match(/^\/v1\/notifications\/([^/]+)\/read$/);
  if (notifyRead && method === "POST") {
    ws.markNotificationRead(actor, decodeURIComponent(notifyRead[1]!));
    send(res, 200, { ok: true });
    return true;
  }
  if (method === "GET" && path === "/v1/admin") {
    send(res, 200, ws.listAdminDirectory(actor));
    return true;
  }
  if (method === "POST" && path === "/v1/spaces") {
    const body = await readJson(req);
    const id = ws.createSpace(actor, String(body.name ?? "Space"), (body.classification as "internal") ?? "internal", {
      homePage: body.homePage !== false,
    });
    send(res, 200, { id });
    return true;
  }
  if (method === "POST" && path === "/v1/projects") {
    const body = await readJson(req);
    const id = ws.createProject(actor, {
      key: String(body.key ?? ""),
      name: String(body.name ?? ""),
      spaceId: body.spaceId ? String(body.spaceId) : undefined,
    });
    send(res, 200, { id });
    return true;
  }
  if (method === "POST" && path === "/v1/grants") {
    const body = await readJson(req);
    const id = ws.grant(actor, {
      principalId: String(body.principalId ?? ""),
      resourceKind: body.resourceKind as "space",
      resourceId: String(body.resourceId ?? ""),
      role: body.role as "viewer",
    });
    send(res, 200, { id });
    return true;
  }

  const importMatch = path.match(/^\/v1\/spaces\/([^/]+)\/import\/confluence$/);
  if (importMatch && method === "POST") {
    const body = await readJson(req);
    const result = ws.importConfluenceStorage(actor, decodeURIComponent(importMatch[1]!), String(body.xml ?? ""), String(body.title ?? "Imported page"));
    send(res, 200, result);
    return true;
  }

  if (method === "POST" && path === "/v1/documents") {
    const body = await readJson(req);
    const title = String(body.title ?? "Untitled");
    const id = ws.createDocument(actor, {
      spaceId: String(body.spaceId ?? ""),
      title,
      parentId: body.parentId ? String(body.parentId) : undefined,
      source: String(body.source ?? `# ${title}\n\nStart writing.\n`),
    });
    send(res, 200, { id });
    return true;
  }

  if (method === "POST" && path === "/v1/assets") {
    const body = await readJson(req);
    const bytes = Buffer.from(String(body.contentBase64 ?? ""), "base64");
    const id = ws.uploadAsset(actor, {
      bytes,
      mime: String(body.mime ?? "application/octet-stream"),
      provenance: { filename: String(body.filename ?? "asset") },
    });
    send(res, 200, { id });
    return true;
  }

  if (method === "POST" && path === "/v1/artifacts") {
    const body = await readJson(req);
    const id = ws.createArtifact(actor, { spaceId: String(body.spaceId ?? ""), title: String(body.title ?? "Untitled board") });
    send(res, 200, { id });
    return true;
  }

  const spacePerm = path.match(/^\/v1\/spaces\/([^/]+)\/permissions$/);
  if (spacePerm && method === "GET") {
    send(res, 200, { grants: ws.listResourceGrants(actor, "space", decodeURIComponent(spacePerm[1]!)) });
    return true;
  }
  if (spacePerm && method === "POST") {
    const body = await readJson(req);
    send(
      res,
      200,
      {
        id: ws.grant(actor, {
          principalId: String(body.principalId ?? ""),
          resourceKind: "space",
          resourceId: decodeURIComponent(spacePerm[1]!),
          role: body.role as "viewer",
        }),
      },
    );
    return true;
  }

  const artifactElement = path.match(/^\/v1\/artifacts\/([^/]+)\/elements\/([^/]+)$/);
  if (artifactElement && method === "PATCH") {
    const body = await readJson(req);
    send(
      res,
      200,
      ws.updateArtifactElement(actor, decodeURIComponent(artifactElement[1]!), decodeURIComponent(artifactElement[2]!), {
        geometry: body.geometry as { x?: number; y?: number; width?: number; height?: number } | undefined,
        text: body.text ? String(body.text) : undefined,
        altText: body.altText ? String(body.altText) : undefined,
        zIndex: typeof body.zIndex === "number" ? body.zIndex : undefined,
      }),
    );
    return true;
  }
  if (artifactElement && method === "DELETE") {
    send(res, 200, ws.deleteArtifactElement(actor, decodeURIComponent(artifactElement[1]!), decodeURIComponent(artifactElement[2]!)));
    return true;
  }

  const artifactMatch = path.match(/^\/v1\/artifacts\/([^/]+)(?:\/(elements))?$/);
  if (artifactMatch && method === "GET" && !artifactMatch[2]) {
    const artifactId = decodeURIComponent(artifactMatch[1]!);
    const read = ws.readArtifact(actor, artifactId, "draft");
    send(res, 200, {
      ...read,
      html: `<style>${paperCanvasStyles()}</style>${paperCanvasMarkup(read.document)}`,
    });
    return true;
  }
  if (artifactMatch && artifactMatch[2] === "elements" && method === "POST") {
    const body = await readJson(req);
    send(
      res,
      200,
      ws.insertArtifactElement(actor, decodeURIComponent(artifactMatch[1]!), {
        type: (body.type as "shape") ?? "shape",
        text: body.text ? String(body.text) : undefined,
        altText: body.altText ? String(body.altText) : undefined,
        imageAssetId: body.imageAssetId ? String(body.imageAssetId) : undefined,
        videoAssetId: body.videoAssetId ? String(body.videoAssetId) : undefined,
        href: body.href ? String(body.href) : undefined,
        fromId: body.fromId ? String(body.fromId) : undefined,
        toId: body.toId ? String(body.toId) : undefined,
        geometry: body.geometry as { x?: number; y?: number; width?: number; height?: number } | undefined,
      }),
    );
    return true;
  }

  const assetMatch = path.match(/^\/v1\/assets\/([^/]+)$/);
  if (assetMatch && method === "GET") {
    const asset = ws.inspectAsset(actor, decodeURIComponent(assetMatch[1]!));
    sendBytes(res, asset.mime, asset.bytes);
    return true;
  }

  const docMatch = path.match(/^\/v1\/documents\/([^/]+)(?:\/(crdt|updates|publish|comments|assets|revisions|permissions|links|media))?(?:\/([^/]+))?(?:\/(restore))?$/);
  if (docMatch) {
    const documentId = decodeURIComponent(docMatch[1]!);
    const action = docMatch[2];
    const extra = docMatch[3] ? decodeURIComponent(docMatch[3]) : undefined;
    if (method === "GET" && !action) {
      send(res, 200, ws.readDocument(actor, documentId));
      return true;
    }
    if (method === "PATCH" && !action) {
      const body = await readJson(req);
      if (typeof body.title === "string") ws.renameDocument(actor, documentId, body.title);
      if (body.parentId !== undefined) ws.moveDocument(actor, documentId, body.parentId === null ? null : String(body.parentId));
      send(res, 200, { ok: true });
      return true;
    }
    if (action === "updates" && method === "GET") {
      send(res, 200, ws.reconnectDraft(actor, documentId, Number(url.searchParams.get("since") ?? "0")));
      return true;
    }
    if (action === "crdt" && method === "POST") {
      const body = (await readJson(req)) as {
        clientId: string;
        clientSeq: number;
        lastAckedSeq?: number;
        ops: CrdtOp[];
      };
      send(res, 200, ws.persistCollaborativeUpdate(actor, { documentId, ...body }));
      return true;
    }
    if (action === "publish" && method === "POST") {
      send(res, 200, ws.publishDocument(actor, documentId));
      return true;
    }
    if (action === "comments" && method === "GET") {
      send(res, 200, { comments: ws.listDocumentComments(actor, documentId) });
      return true;
    }
    if (action === "comments" && method === "POST") {
      const body = await readJson(req);
      send(res, 200, ws.addDocumentComment(actor, documentId, String(body.body ?? ""), body.quote ? String(body.quote) : undefined));
      return true;
    }
    if (action === "assets" && method === "GET") {
      send(res, 200, { assets: ws.listDocumentAssets(actor, documentId) });
      return true;
    }
    if (action === "assets" && method === "POST") {
      const body = await readJson(req);
      const bytes = Buffer.from(String(body.contentBase64 ?? ""), "base64");
      send(
        res,
        200,
        ws.attachDocumentAsset(actor, documentId, {
          bytes,
          mime: String(body.mime ?? "application/octet-stream"),
          filename: String(body.filename ?? "attachment"),
        }),
      );
      return true;
    }
    if (action === "revisions" && method === "GET" && !extra) {
      send(res, 200, { revisions: ws.listDocumentRevisions(actor, documentId) });
      return true;
    }
    if (action === "revisions" && extra && docMatch[4] === "restore" && method === "POST") {
      send(res, 200, ws.restoreDocumentRevision(actor, documentId, Number(extra)));
      return true;
    }
    if (action === "permissions" && method === "GET") {
      send(res, 200, { grants: ws.listResourceGrants(actor, "document", documentId) });
      return true;
    }
    if (action === "permissions" && method === "POST") {
      const body = await readJson(req);
      send(
        res,
        200,
        {
          id: ws.grant(actor, {
            principalId: String(body.principalId ?? ""),
            resourceKind: "document",
            resourceId: documentId,
            role: body.role as "viewer",
          }),
        },
      );
      return true;
    }
    if (action === "links" && method === "GET") {
      send(res, 200, { links: ws.listExternalLinks(actor, "document", documentId) });
      return true;
    }
    if (action === "links" && method === "POST") {
      const body = await readJson(req);
      send(
        res,
        200,
        {
          id: ws.addExternalLink(actor, {
            fromKind: "document",
            fromId: documentId,
            provider: (body.provider as "github") ?? "url",
            url: body.url ? String(body.url) : undefined,
            issueId: body.issueId ? String(body.issueId) : undefined,
            documentId: body.documentId ? String(body.documentId) : undefined,
            label: body.label ? String(body.label) : undefined,
          }),
        },
      );
      return true;
    }
    if (action === "media" && method === "POST") {
      const body = await readJson(req);
      const bytes = Buffer.from(String(body.contentBase64 ?? ""), "base64");
      const filename = String(body.filename ?? "media");
      const kind = body.kind === "video" ? "video" : "image";
      const attached = ws.attachDocumentAsset(actor, documentId, {
        bytes,
        mime: String(body.mime ?? (kind === "video" ? "video/mp4" : "image/png")),
        filename,
      });
      send(res, 200, {
        ...attached,
        ...ws.embedDocumentMedia(actor, documentId, { kind, assetId: attached.assetId, filename }),
      });
      return true;
    }
  }

  const projectIssues = path.match(/^\/v1\/projects\/([^/]+)\/issues$/);
  if (projectIssues && method === "GET") {
    const jql = url.searchParams.get("jql") ?? "";
    send(res, 200, { issues: ws.queryIssues(actor, decodeURIComponent(projectIssues[1]!), jql || { type: "and", clauses: [] }) });
    return true;
  }
  if (projectIssues && method === "POST") {
    const body = await readJson(req);
    send(
      res,
      200,
      ws.createIssue(actor, {
        projectId: decodeURIComponent(projectIssues[1]!),
        typeKey: String(body.typeKey ?? "task"),
        summary: String(body.summary ?? ""),
        description: body.description ? String(body.description) : undefined,
        parentId: body.parentId ? String(body.parentId) : undefined,
        assigneeId: body.assigneeId ? String(body.assigneeId) : undefined,
      }),
    );
    return true;
  }
  const projectRank = path.match(/^\/v1\/projects\/([^/]+)\/rank$/);
  if (projectRank && method === "POST") {
    const body = await readJson(req);
    ws.rankIssues(actor, decodeURIComponent(projectRank[1]!), (body.orderedIds as string[]) ?? []);
    send(res, 200, { ok: true });
    return true;
  }
  const projectBoards = path.match(/^\/v1\/projects\/([^/]+)\/boards$/);
  if (projectBoards && method === "GET") {
    send(res, 200, { boards: ws.listBoards(actor, decodeURIComponent(projectBoards[1]!)) });
    return true;
  }
  if (projectBoards && method === "POST") {
    const body = await readJson(req);
    const id = ws.createBoard(actor, {
      projectId: decodeURIComponent(projectBoards[1]!),
      name: String(body.name ?? "Board"),
      kind: body.kind === "scrum" ? "scrum" : "kanban",
    });
    send(res, 200, { id });
    return true;
  }

  const boardSprints = path.match(/^\/v1\/boards\/([^/]+)\/sprints$/);
  if (boardSprints && method === "GET") {
    send(res, 200, { sprints: ws.listSprints(actor, decodeURIComponent(boardSprints[1]!)) });
    return true;
  }
  if (boardSprints && method === "POST") {
    const body = await readJson(req);
    const id = ws.createSprint(actor, decodeURIComponent(boardSprints[1]!), String(body.name ?? "Sprint"), body.goal ? String(body.goal) : undefined);
    send(res, 200, { id });
    return true;
  }
  const sprintAction = path.match(/^\/v1\/sprints\/([^/]+)\/(start|close)$/);
  if (sprintAction && method === "POST") {
    const sprintId = decodeURIComponent(sprintAction[1]!);
    if (sprintAction[2] === "start") ws.startSprint(actor, sprintId);
    else {
      const body = await readJson(req);
      ws.closeSprint(actor, sprintId, body.carry === false ? false : true);
    }
    send(res, 200, { ok: true });
    return true;
  }

  const issueMatch = path.match(/^\/v1\/issues\/([^/]+)(?:\/(transition|comments|worklog|sprint|links|watch))?$/);
  if (issueMatch) {
    const issueId = decodeURIComponent(issueMatch[1]!);
    const action = issueMatch[2];
    if (method === "GET" && !action) {
      send(res, 200, ws.readIssue(actor, issueId));
      return true;
    }
    if (method === "PATCH" && !action) {
      const body = await readJson(req);
      ws.updateIssue(actor, issueId, {
        summary: typeof body.summary === "string" ? body.summary : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        assigneeId: body.assigneeId === undefined ? undefined : body.assigneeId === null ? null : String(body.assigneeId),
        parentId: body.parentId === undefined ? undefined : body.parentId === null ? null : String(body.parentId),
        priority: typeof body.priority === "string" ? body.priority : undefined,
        dueAt: body.dueAt === undefined ? undefined : body.dueAt === null || body.dueAt === "" ? null : String(body.dueAt),
        labels: Array.isArray(body.labels)
          ? body.labels.map(String)
          : typeof body.labels === "string"
            ? body.labels.split(",").map((item: string) => item.trim()).filter(Boolean)
            : undefined,
        estimate: body.estimate === undefined ? undefined : body.estimate === null || body.estimate === "" ? null : Number(body.estimate),
        flagged: typeof body.flagged === "boolean" ? body.flagged : undefined,
      });
      send(res, 200, { ok: true });
      return true;
    }
    if (action === "transition" && method === "POST") {
      const body = await readJson(req);
      ws.transitionIssue(actor, issueId, String(body.to ?? ""), body.fields as Record<string, unknown> | undefined);
      send(res, 200, { ok: true });
      return true;
    }
    if (action === "comments" && method === "GET") {
      send(res, 200, { comments: ws.listIssueComments(actor, issueId) });
      return true;
    }
    if (action === "comments" && method === "POST") {
      const body = await readJson(req);
      send(res, 200, { id: ws.addIssueComment(actor, issueId, String(body.body ?? "")) });
      return true;
    }
    if (action === "worklog" && method === "POST") {
      const body = await readJson(req);
      send(
        res,
        200,
        {
          id: ws.logWork(actor, {
            issueId,
            durationSeconds: Number(body.durationSeconds ?? 0),
            note: body.note ? String(body.note) : undefined,
          }),
        },
      );
      return true;
    }
    if (action === "sprint" && method === "POST") {
      const body = await readJson(req);
      ws.setIssueSprint(actor, issueId, body.sprintId === null || body.sprintId === undefined ? null : String(body.sprintId));
      send(res, 200, { ok: true });
      return true;
    }
    if (action === "links" && method === "GET") {
      send(res, 200, { links: ws.listExternalLinks(actor, "issue", issueId) });
      return true;
    }
    if (action === "links" && method === "POST") {
      const body = await readJson(req);
      send(
        res,
        200,
        {
          id: ws.addExternalLink(actor, {
            fromKind: "issue",
            fromId: issueId,
            provider: (body.provider as "github") ?? "url",
            url: body.url ? String(body.url) : undefined,
            issueId: body.issueId ? String(body.issueId) : undefined,
            documentId: body.documentId ? String(body.documentId) : undefined,
            label: body.label ? String(body.label) : undefined,
          }),
        },
      );
      return true;
    }
    if (action === "watch" && method === "POST") {
      send(res, 200, ws.watchIssue(actor, issueId));
      return true;
    }
    if (action === "watch" && method === "DELETE") {
      send(res, 200, ws.unwatchIssue(actor, issueId));
      return true;
    }
  }

  return false;
}

export { send };
