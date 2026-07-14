import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openNomaCloudDatabase, type CloudDocumentRecord } from "../src/cloud-db.js";
import { createNomaCloudServer, type NomaCloudServerOptions } from "../src/cloud-server.js";

interface CloudUserResponse {
  id: string;
  name: string;
  token: string;
}

interface CloudDocumentResponse {
  id: string;
  title: string;
  source: string;
  hash: string;
  diagnostics: unknown[];
  access: {
    role: string;
    via: string;
  };
}

interface CloudShareResponse {
  id: string;
  token: string;
  role: string;
  url: string;
  artifactUrl: string;
}

interface CloudSiteResponse {
  id: string;
  title: string;
  documentIds: string[];
  folders?: string[];
  pageFolders?: Record<string, string>;
  access: {
    role: string;
    via: string;
  };
}

interface CloudDbQueryResponse {
  resource: string;
  rows: Array<Record<string, unknown>>;
}

interface JsonRequestOptions {
  method?: string;
  token?: string;
  share?: string;
  cloudAccess?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  expectedStatus?: number;
}

test("cloud server enforces users, permissions, shares, and editable sites", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-"));
  const dataDir = join(root, "data", "documents");
  const usersDir = join(root, "data", "users");
  const sitesDir = join(root, "data", "sites");
  const dbPath = join(root, "data", "noma-cloud.sqlite");
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");

  const server = createNomaCloudServer({
    dataDir,
    usersDir,
    sitesDir,
    dbPath,
    publicDir,
    maxBodyBytes: 10_000,
    now: () => new Date("2026-06-06T12:00:00.000Z"),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const alice = await json<CloudUserResponse>(`${base}/api/users`, {
      method: "POST",
      body: { name: "Alice Researcher" },
    });
    const bob = await json<CloudUserResponse>(`${base}/api/users`, {
      method: "POST",
      body: { name: "Bob Editor" },
    });
    const charlie = await json<CloudUserResponse>(`${base}/api/users`, {
      method: "POST",
      body: { name: "Charlie Site Editor" },
    });
    const limitTester = await json<CloudUserResponse>(`${base}/api/users`, {
      method: "POST",
      body: { name: "Limit Tester" },
    });

    const status = await json<{ storage: string; database: { queryApi: boolean } }>(`${base}/api/status`, {
      token: alice.token,
    });
    assert.equal(status.storage, "sqlite");
    assert.equal(status.database.queryApi, true);

    const schema = await json<{ resources: Record<string, unknown> }>(`${base}/api/db/schema`, {
      token: alice.token,
    });
    assert.deepEqual(Object.keys(schema.resources).sort(), ["blocks", "documents", "sites", "users"]);

    await json(`${base}/api/documents`, {
      method: "POST",
      body: { source: "# Should Fail\n" },
      expectedStatus: 401,
    });

    await json(`${base}/api/db/query`, {
      method: "POST",
      body: { resource: "documents" },
      expectedStatus: 401,
    });

    await json(`${base}/api/documents`, {
      method: "POST",
      token: limitTester.token,
      body: { source: `# Too Large\n\n${"x".repeat(12_000)}` },
      expectedStatus: 413,
    });

    const afterLimit = await json<CloudDocumentResponse>(`${base}/api/documents`, {
      method: "POST",
      token: limitTester.token,
      body: { source: "# After Limit\n\nA normal request works on the same client after 413." },
    });
    assert.equal(afterLimit.title, "After Limit");

    const created = await json<CloudDocumentResponse>(`${base}/api/documents`, {
      method: "POST",
      token: alice.token,
      body: {
        source: "# Shared Research\n\nThis is a cloud document.",
      },
    });

    assert.equal(created.title, "Shared Research");
    assert.equal(created.hash.length, 64);
    assert.equal(created.diagnostics.length, 0);
    assert.equal(created.access.role, "owner");
    await stat(dbPath);

    const aliceDocumentQuery = await json<CloudDbQueryResponse>(`${base}/api/db/query`, {
      method: "POST",
      token: alice.token,
      body: { resource: "documents", q: "cloud document", includeSource: true },
    });
    assert.equal(aliceDocumentQuery.resource, "documents");
    assert.equal(aliceDocumentQuery.rows.length, 1);
    assert.equal(aliceDocumentQuery.rows[0]?.id, created.id);
    assert.match(String(aliceDocumentQuery.rows[0]?.source), /cloud document/);

    const noSourceQuery = await json<CloudDbQueryResponse>(`${base}/api/db/query`, {
      method: "POST",
      token: alice.token,
      body: { resource: "documents", q: "Shared Research" },
    });
    assert.equal(Object.hasOwn(noSourceQuery.rows[0] ?? {}, "source"), false);

    await json(`${base}/api/documents/${created.id}`, {
      token: bob.token,
      expectedStatus: 403,
    });

    await json(`${base}/api/documents/${created.id}/collaborators`, {
      method: "POST",
      token: alice.token,
      body: { userId: bob.id, role: "editor" },
    });

    const bobLoaded = await json<CloudDocumentResponse>(`${base}/api/documents/${created.id}`, {
      token: bob.token,
    });
    assert.equal(bobLoaded.access.role, "editor");

    const updated = await json<CloudDocumentResponse>(`${base}/api/documents/${created.id}`, {
      method: "PUT",
      token: bob.token,
      body: {
        source: "# Shared Research\n\nUpdated by Bob.",
        expectedHash: bobLoaded.hash,
      },
    });
    assert.equal(updated.source, "# Shared Research\n\nUpdated by Bob.");
    assert.notEqual(updated.hash, created.hash);

    await fetchExpect(`${base}/d/${created.id}`, 401);

    const viewerShare = await json<CloudShareResponse>(`${base}/api/documents/${created.id}/shares`, {
      method: "POST",
      token: alice.token,
      body: { role: "viewer", label: "Reader artifact" },
    });
    assert.equal(viewerShare.role, "viewer");
    assert.match(viewerShare.artifactUrl, new RegExp(`/d/${created.id}\\?share=`));

    const artifact = await fetch(`${base}/d/${created.id}?share=${viewerShare.token}`);
    assert.equal(artifact.status, 200);
    assert.match(await artifact.text(), /Updated by Bob/);

    const editorShare = await json<CloudShareResponse>(`${base}/api/documents/${created.id}/shares`, {
      method: "POST",
      token: alice.token,
      body: { role: "editor", label: "Editor link" },
    });
    assert.match(editorShare.url, new RegExp(`/workbench.html\\?doc=${created.id}&share=`));

    await json(`${base}/api/db/query`, {
      method: "POST",
      share: editorShare.token,
      body: { resource: "documents" },
      expectedStatus: 401,
    });

    const sharedEdit = await json<CloudDocumentResponse>(`${base}/api/documents/${created.id}`, {
      method: "PUT",
      share: editorShare.token,
      body: {
        source: "# Shared Research\n\nUpdated through an editor link.",
        expectedHash: updated.hash,
      },
    });
    assert.equal(sharedEdit.access.via, "share");

    const site = await json<CloudSiteResponse>(`${base}/api/sites`, {
      method: "POST",
      token: alice.token,
      body: {
        title: "Research Space",
        documentIds: [created.id],
        folders: ["Drafts"],
        pageFolders: { [created.id]: "Drafts" },
      },
    });
    assert.equal(site.access.role, "owner");
    assert.deepEqual(site.documentIds, [created.id]);
    assert.deepEqual(site.folders, ["Drafts"]);
    assert.deepEqual(site.pageFolders, { [created.id]: "Drafts" });

    const longSiteTitle = "Research Space " + "Long ".repeat(40);
    const longSite = await json<CloudSiteResponse>(`${base}/api/sites`, {
      method: "POST",
      token: alice.token,
      body: {
        title: longSiteTitle,
        documentIds: [created.id],
      },
    });
    assert.equal(longSite.title.length, 120);
    assert.equal(longSite.slug.length, 80);

    const longUpdatedSite = await json<CloudSiteResponse>(`${base}/api/sites/${longSite.id}`, {
      method: "PUT",
      token: alice.token,
      body: {
        title: "Updated Research Space " + "Slug ".repeat(40),
        documentIds: [created.id],
      },
    });
    assert.equal(longUpdatedSite.slug.length, 80);

    await json(`${base}/api/sites/${site.id}`, {
      method: "PUT",
      token: bob.token,
      body: { title: "Bob Should Not Edit", documentIds: [created.id] },
      expectedStatus: 403,
    });

    await json(`${base}/api/sites/${site.id}/collaborators`, {
      method: "POST",
      token: alice.token,
      body: { userId: bob.id, role: "editor" },
    });

    const editedSite = await json<CloudSiteResponse>(`${base}/api/sites/${site.id}`, {
      method: "PUT",
      token: bob.token,
      body: { title: "Research Space Edited", documentIds: [created.id] },
    });
    assert.equal(editedSite.title, "Research Space Edited");
    assert.equal(editedSite.access.role, "editor");

    await json(`${base}/api/sites/${site.id}/collaborators`, {
      method: "POST",
      token: alice.token,
      body: { userId: charlie.id, role: "editor" },
    });

    const inheritedDocument = await json<CloudDocumentResponse>(`${base}/api/documents/${created.id}`, {
      token: charlie.token,
    });
    assert.equal(inheritedDocument.access.role, "editor");

    const charlieSite = await json<CloudSiteResponse & { documents: CloudDocumentResponse[] }>(
      `${base}/api/sites/${site.id}?include=documents`,
      {
        token: charlie.token,
      },
    );
    assert.equal(charlieSite.access.role, "editor");
    assert.equal(charlieSite.documents.length, 1);
    assert.equal(charlieSite.documents[0]?.source, "# Shared Research\n\nUpdated through an editor link.");

    const charlieDocumentQuery = await json<CloudDbQueryResponse>(`${base}/api/db/query`, {
      method: "POST",
      token: charlie.token,
      body: { resource: "documents", q: "editor link" },
    });
    assert.equal(charlieDocumentQuery.rows.length, 1);
    assert.equal((charlieDocumentQuery.rows[0]?.access as { role?: string } | undefined)?.role, "editor");

    const siteScopedEdit = await json<CloudDocumentResponse>(`${base}/api/sites/${site.id}/documents/${created.id}`, {
      method: "PUT",
      token: charlie.token,
      body: {
        source: "# Shared Research\n\nUpdated through workspace page permissions.",
        expectedHash: sharedEdit.hash,
      },
    });
    assert.equal(siteScopedEdit.access.role, "editor");

    const literaturePage = await json<CloudDocumentResponse>(`${base}/api/sites/${site.id}/documents`, {
      method: "POST",
      token: charlie.token,
      body: {
        title: "Literature Review",
        source: "# Literature Review\n\nBack to [[Shared Research]].",
        folder: "Sources",
      },
    });

    const folderedSite = await json<CloudSiteResponse & { documents: CloudDocumentResponse[] }>(
      `${base}/api/sites/${site.id}?include=documents`,
      { token: charlie.token },
    );
    assert.deepEqual(folderedSite.folders, ["Drafts", "Sources"]);
    assert.deepEqual(folderedSite.pageFolders, { [created.id]: "Drafts", [literaturePage.id]: "Sources" });

    const movedSite = await json<CloudSiteResponse>(`${base}/api/sites/${site.id}`, {
      method: "PUT",
      token: charlie.token,
      body: {
        title: folderedSite.title,
        documentIds: folderedSite.documentIds,
        folders: ["Drafts", "Sources", "Archive"],
        pageFolders: { [created.id]: "Archive", [literaturePage.id]: "Sources", missingdoc: "Ignored" },
      },
    });
    assert.deepEqual(movedSite.folders, ["Drafts", "Sources", "Archive"]);
    assert.deepEqual(movedSite.pageFolders, { [created.id]: "Archive", [literaturePage.id]: "Sources" });

    await json<CloudDocumentResponse>(`${base}/api/sites/${site.id}/documents/${created.id}`, {
      method: "PUT",
      token: charlie.token,
      body: {
        source: "# Shared Research\n\nUpdated through workspace page permissions.\n\nSee [[Literature Review]] and [[Missing Concept]].\n\n```noma\n[[Code Only]]\n```",
        expectedHash: siteScopedEdit.hash,
      },
    });

    const wiki = await json<{
      pages: Array<{ id: string; title: string }>;
      links: Array<{ fromDocumentId: string; target: string; resolvedDocumentId?: string; missing: boolean }>;
      backlinks: Record<string, Array<{ fromDocumentId: string; target: string }>>;
      missing: Array<{ target: string }>;
    }>(`${base}/api/sites/${site.id}/wiki`, {
      token: charlie.token,
    });
    assert.equal(wiki.pages.length, 2);
    assert.ok(wiki.links.some((link) => link.fromDocumentId === created.id && link.target === "Literature Review" && link.resolvedDocumentId === literaturePage.id && !link.missing));
    assert.ok(wiki.links.some((link) => link.fromDocumentId === created.id && link.target === "Missing Concept" && link.missing));
    assert.ok(!wiki.links.some((link) => link.target === "Code Only"));
    assert.ok(wiki.backlinks[created.id]?.some((link) => link.fromDocumentId === literaturePage.id && link.target === "Shared Research"));
    assert.ok(wiki.missing.some((link) => link.target === "Missing Concept"));

    const blockQuery = await json<CloudDbQueryResponse>(`${base}/api/db/query`, {
      method: "POST",
      token: charlie.token,
      body: { resource: "blocks", q: "workspace page permissions", siteId: site.id },
    });
    assert.equal(blockQuery.rows.length, 1);
    assert.equal(blockQuery.rows[0]?.documentId, created.id);
    assert.equal((blockQuery.rows[0]?.access as { role?: string } | undefined)?.role, "editor");

    const siteQuery = await json<CloudDbQueryResponse>(`${base}/api/db/query`, {
      method: "POST",
      token: bob.token,
      body: { resource: "sites", q: "Edited" },
    });
    assert.equal(siteQuery.rows.length, 1);
    assert.equal(siteQuery.rows[0]?.id, site.id);
    assert.deepEqual(siteQuery.rows[0]?.folders, ["Drafts", "Sources", "Archive"]);

    const usersQuery = await json<CloudDbQueryResponse>(`${base}/api/db/query`, {
      method: "POST",
      token: alice.token,
      body: { resource: "users", q: "Charlie" },
    });
    assert.equal(usersQuery.rows[0]?.id, charlie.id);
    assert.equal(Object.hasOwn(usersQuery.rows[0] ?? {}, "tokenHash"), false);

    await json(`${base}/api/db/query`, {
      method: "POST",
      token: alice.token,
      body: { resource: "blocks", limit: 101 },
      expectedStatus: 400,
    });

    const siteShare = await json<CloudShareResponse>(`${base}/api/sites/${site.id}/shares`, {
      method: "POST",
      token: bob.token,
      body: { role: "viewer", label: "Site readers" },
    });

    const renderedSite = await fetch(`${base}/s/${site.id}?share=${siteShare.token}`);
    assert.equal(renderedSite.status, 200);
    const renderedSiteHtml = await renderedSite.text();
    assert.match(renderedSiteHtml, /Research Space Edited/);
    assert.match(renderedSiteHtml, /Updated through workspace page permissions/);

    const aliceDocs = await json<{ documents: Array<{ id: string }> }>(`${base}/api/documents`, {
      token: alice.token,
    });
    const bobDocs = await json<{ documents: Array<{ id: string }> }>(`${base}/api/documents`, {
      token: bob.token,
    });
    assert.deepEqual(new Set(aliceDocs.documents.map((item) => item.id)), new Set([created.id, literaturePage.id]));
    assert.deepEqual(new Set(bobDocs.documents.map((item) => item.id)), new Set([created.id, literaturePage.id]));

    const index = await fetch(base);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Noma/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});

test("cloud server imports legacy JSON records into SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-legacy-"));
  const dataDir = join(root, "data", "documents");
  const usersDir = join(root, "data", "users");
  const sitesDir = join(root, "data", "sites");
  const dbPath = join(root, "data", "noma-cloud.sqlite");
  const publicDir = join(root, "public");
  await mkdir(dataDir, { recursive: true });
  await mkdir(usersDir, { recursive: true });
  await mkdir(sitesDir, { recursive: true });
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");

  const token = "nu_legacy_token";
  const user = {
    version: 1,
    id: "legacyusr1",
    name: "Legacy User",
    tokenHash: sha256Hex(token),
    tokenPreview: "nu_le...token",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
  const document = {
    version: 2,
    id: "legacydoc1",
    title: "Legacy Research",
    source: "# Legacy Research\n\nImported from JSON.",
    hash: sha256Hex("# Legacy Research\n\nImported from JSON."),
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    createdBy: user.id,
    updatedBy: user.id,
    permissions: {
      [user.id]: { role: "owner", addedAt: "2026-06-01T00:00:00.000Z" },
    },
    shareLinks: [],
  };
  const site = {
    version: 1,
    id: "legacysite1",
    title: "Legacy Space",
    slug: "legacy-space",
    documentIds: [document.id],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    createdBy: user.id,
    updatedBy: user.id,
    permissions: {
      [user.id]: { role: "owner", addedAt: "2026-06-01T00:00:00.000Z" },
    },
    shareLinks: [],
  };
  await writeFile(join(usersDir, `${user.id}.json`), `${JSON.stringify(user, null, 2)}\n`, "utf8");
  await writeFile(join(dataDir, `${document.id}.json`), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await writeFile(join(sitesDir, `${site.id}.json`), `${JSON.stringify(site, null, 2)}\n`, "utf8");

  const server = createNomaCloudServer({ dataDir, usersDir, sitesDir, dbPath, publicDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const imported = await json<CloudDbQueryResponse>(`${base}/api/db/query`, {
      method: "POST",
      token,
      body: { resource: "blocks", q: "Imported from JSON" },
    });
    assert.equal(imported.rows.length, 1);
    assert.equal(imported.rows[0]?.documentId, document.id);
    await stat(dbPath);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});

test("cloud app can require a global access token", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-gate-"));
  const dataDir = join(root, "data", "documents");
  const usersDir = join(root, "data", "users");
  const sitesDir = join(root, "data", "sites");
  const dbPath = join(root, "data", "noma-cloud.sqlite");
  const publicDir = join(root, "public");
  await mkdir(join(publicDir, "assets"), { recursive: true });
  await writeFile(join(publicDir, "cloud.html"), "<script src=\"/assets/cloud-app.js\"></script>", "utf8");
  await writeFile(join(publicDir, "login.html"), "<form id=\"loginForm\"></form>", "utf8");
  await writeFile(join(publicDir, "assets", "cloud-app.js"), "window.nomaCloud = true;", "utf8");

  const accessToken = "gate-secret";
  const invitationCode = "invite-secret";
  const server = createNomaCloudServer({ dataDir, usersDir, sitesDir, dbPath, publicDir, accessToken, invitationCode });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const loginPage = await fetch(`${base}/login.html`);
    assert.equal(loginPage.status, 200);
    const blockedShell = await fetch(`${base}/cloud.html?site=abc12345`, { redirect: "manual" });
    assert.equal(blockedShell.status, 302);
    assert.equal(blockedShell.headers.get("location"), "/login.html?next=%2Fcloud.html%3Fsite%3Dabc12345");
    await fetchExpect(`${base}/assets/cloud-app.js`, 401);
    await json(`${base}/api/status`, { expectedStatus: 401 });
    await json(`${base}/api/users`, {
      method: "POST",
      body: { name: "Blocked User" },
      expectedStatus: 401,
    });

    await json(`${base}/api/auth/session`, {
      method: "POST",
      body: { accessToken: "wrong-token" },
      expectedStatus: 401,
    });

    const missingAccessToken = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Missing Access", invitationCode }),
    });
    assert.equal(missingAccessToken.status, 400);
    assert.match(await missingAccessToken.text(), /Cloud access token is required/);

    const gate = await fetch(`${base}/cloud.html?site=abc12345&access=${encodeURIComponent(accessToken)}`, {
      redirect: "manual",
    });
    assert.equal(gate.status, 302);
    assert.equal(gate.headers.get("location"), "/cloud.html?site=abc12345");
    const cookie = gate.headers.get("set-cookie")?.split(";")[0];
    assert.match(cookie ?? "", /^noma_cloud_access=gate-secret$/);

    const shell = await fetch(`${base}/cloud.html`, { headers: { cookie: cookie ?? "" } });
    assert.equal(shell.status, 200);
    const asset = await fetch(`${base}/assets/cloud-app.js`, { headers: { cookie: cookie ?? "" } });
    assert.equal(asset.status, 200);

    const cookieRegistered = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie ?? "" },
      body: JSON.stringify({ name: "Cookie Registered", invitationCode }),
    });
    const cookieRegisteredText = await cookieRegistered.text();
    assert.equal(cookieRegistered.status, 201, cookieRegisteredText);
    const cookieRegisteredPayload = JSON.parse(cookieRegisteredText) as { user?: { name?: string; token?: string } };
    assert.equal(cookieRegisteredPayload.user?.name, "Cookie Registered");
    assert.equal((cookieRegisteredPayload.user?.token?.length ?? 0) > 20, true);

    const status = await json<{ access: string }>(`${base}/api/status`, { cloudAccess: accessToken });
    assert.equal(status.access, "gate-token");

    await json(`${base}/api/users`, {
      method: "POST",
      cloudAccess: accessToken,
      body: { name: "No Invite" },
      expectedStatus: 403,
    });

    await json(`${base}/api/auth/register`, {
      method: "POST",
      body: { accessToken, name: "Bad Invite", invitationCode: "wrong-code" },
      expectedStatus: 403,
    });

    const registered = await json<{ user: CloudUserResponse }>(`${base}/api/auth/register`, {
      method: "POST",
      body: { accessToken, name: "Registered Owner", invitationCode },
    });
    assert.equal(registered.user.name, "Registered Owner");
    assert.equal(registered.user.token.length > 20, true);

    const session = await fetch(`${base}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken, userToken: registered.user.token }),
    });
    assert.equal(session.status, 200);
    assert.match(session.headers.get("set-cookie") ?? "", /^noma_cloud_access=/);
    const sessionPayload = (await session.json()) as { user?: { id?: string } };
    assert.equal(sessionPayload.user?.id, registered.user.id);

    const user = await json<CloudUserResponse>(`${base}/api/users`, {
      method: "POST",
      cloudAccess: accessToken,
      body: { name: "Gate Owner", invitationCode },
    });
    const document = await json<CloudDocumentResponse>(`${base}/api/documents`, {
      method: "POST",
      cloudAccess: accessToken,
      token: user.token,
      body: { source: "# Gated Artifact\n\nVisible through a document share." },
    });
    const share = await json<CloudShareResponse>(`${base}/api/documents/${document.id}/shares`, {
      method: "POST",
      cloudAccess: accessToken,
      token: user.token,
      body: { role: "viewer" },
    });

    await fetchExpect(`${base}/d/${document.id}`, 401);
    const artifact = await fetch(`${base}/d/${document.id}?share=${share.token}`);
    assert.equal(artifact.status, 200);
    assert.match(await artifact.text(), /Gated Artifact/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});

test("document API supports create, read, update, and render lifecycle", async () => {
  const harness = await startCloudServer("noma-cloud-lifecycle-");
  try {
    const owner = await createCloudUser(harness.base, "Lifecycle Owner");
    const created = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: owner.token,
      body: { source: "# Lifecycle Doc\n\nFirst draft body." },
    });
    assert.equal(created.title, "Lifecycle Doc");
    assert.equal(created.access.role, "owner");
    assert.equal(created.access.via, "user");

    const loaded = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${created.id}`, {
      token: owner.token,
    });
    assert.equal(loaded.source, "# Lifecycle Doc\n\nFirst draft body.");
    assert.equal(loaded.hash, created.hash);

    const updated = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${created.id}`, {
      method: "PATCH",
      token: owner.token,
      body: { source: "# Lifecycle Doc\n\nSecond draft body.", expectedHash: created.hash },
    });
    assert.equal(updated.source, "# Lifecycle Doc\n\nSecond draft body.");
    assert.notEqual(updated.hash, created.hash);

    const html = await fetch(`${harness.base}/api/documents/${created.id}/html`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    const htmlText = await html.text();
    assert.match(htmlText, /Second draft body/);
    assert.match(htmlText, /owner access/);

    const jsonArtifact = await fetch(`${harness.base}/api/documents/${created.id}/json`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(jsonArtifact.status, 200);
    const ast = JSON.parse(await jsonArtifact.text()) as { type?: string };
    assert.equal(ast.type, "document");

    const llm = await fetch(`${harness.base}/api/documents/${created.id}/llm`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(llm.status, 200);
    assert.match(llm.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(await llm.text(), /Second draft body/);

    await json(`${harness.base}/api/documents/${created.id}/pdf`, {
      token: owner.token,
      expectedStatus: 404,
    });

    await json(`${harness.base}/api/documents`, {
      method: "POST",
      token: owner.token,
      body: { source: "   " },
      expectedStatus: 400,
    });
    await json(`${harness.base}/api/documents`, {
      method: "POST",
      token: owner.token,
      body: { source: 42 },
      expectedStatus: 400,
    });
  } finally {
    await harness.close();
  }
});

test("document updates require current hashes and retain restorable history", async () => {
  const harness = await startCloudServer("noma-cloud-history-");
  try {
    const owner = await createCloudUser(harness.base, "History Owner");
    const created = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: owner.token,
      body: { title: "History Doc", source: "# History Doc\n\nFirst version." },
    });

    await json(`${harness.base}/api/documents/${created.id}`, {
      method: "PUT",
      token: owner.token,
      body: { source: "# History Doc\n\nMissing precondition." },
      expectedStatus: 428,
    });

    const updated = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${created.id}`, {
      method: "PUT",
      token: owner.token,
      body: { source: "# History Doc\n\nSecond version.", expectedHash: created.hash },
    });

    const stale = await fetch(`${harness.base}/api/documents/${created.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
      body: JSON.stringify({ source: "# History Doc\n\nStale overwrite.", expectedHash: created.hash }),
    });
    assert.equal(stale.status, 409);
    const conflict = (await stale.json()) as { code?: string; currentHash?: string };
    assert.equal(conflict.code, "document_conflict");
    assert.equal(conflict.currentHash, updated.hash);

    const unchanged = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${created.id}`, { token: owner.token });
    assert.equal(unchanged.source, "# History Doc\n\nSecond version.");

    const history = await json<{ revisions: Array<Record<string, unknown>> }>(`${harness.base}/api/documents/${created.id}/revisions`, {
      token: owner.token,
    });
    assert.deepEqual(history.revisions.map((revision) => revision.revision), [2, 1]);
    assert.equal(Object.hasOwn(history.revisions[0] ?? {}, "source"), false);

    const first = await json<{ source: string; revision: number }>(`${harness.base}/api/documents/${created.id}/revisions/1`, {
      token: owner.token,
    });
    assert.equal(first.revision, 1);
    assert.equal(first.source, "# History Doc\n\nFirst version.");

    const restored = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${created.id}/revisions/1/restore`, {
      method: "POST",
      token: owner.token,
      body: { expectedHash: updated.hash },
    });
    assert.equal(restored.source, first.source);

    const restoredHistory = await json<{ revisions: Array<{ revision: number }> }>(`${harness.base}/api/documents/${created.id}/revisions`, {
      token: owner.token,
    });
    assert.deepEqual(restoredHistory.revisions.map((revision) => revision.revision), [3, 2, 1]);

    const site = await json<CloudSiteResponse>(`${harness.base}/api/sites`, {
      method: "POST",
      token: owner.token,
      body: { title: "History Space", documentIds: [created.id] },
    });
    const siteHistory = await json<{ revisions: Array<{ revision: number }> }>(
      `${harness.base}/api/sites/${site.id}/documents/${created.id}/revisions`,
      { token: owner.token },
    );
    assert.deepEqual(siteHistory.revisions.map((revision) => revision.revision), [3, 2, 1]);
  } finally {
    await harness.close();
  }
});

test("production cloud fails closed without access and invitation secrets", () => {
  assert.throws(
    () => createNomaCloudServer({ production: true }),
    /requires NOMA_CLOUD_ACCESS_TOKEN/,
  );
  assert.throws(
    () => createNomaCloudServer({ production: true, accessToken: "production-access" }),
    /requires NOMA_CLOUD_INVITATION_CODE/,
  );
});

test("cloud rate limits registration and returns retry metadata", async () => {
  const harness = await startCloudServer("noma-cloud-rate-limit-", { authRateLimitMaxRequests: 2 });
  try {
    await createCloudUser(harness.base, "Rate One");
    await createCloudUser(harness.base, "Rate Two");
    const limited = await fetch(`${harness.base}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Rate Three" }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("x-ratelimit-limit"), "2");
    assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal(((await limited.json()) as { code?: string }).code, "rate_limit_exceeded");
  } finally {
    await harness.close();
  }
});

test("document routes return 404 for unknown ids and 400 for malformed ids", async () => {
  const harness = await startCloudServer("noma-cloud-missing-");
  try {
    const user = await createCloudUser(harness.base, "Missing Doc Reader");
    const unknownId = "aaaaaaaaaaaaaaaaaa";

    await json(`${harness.base}/api/documents/${unknownId}`, { token: user.token, expectedStatus: 404 });
    await json(`${harness.base}/api/documents/${unknownId}`, {
      method: "PUT",
      token: user.token,
      body: { source: "# Nope" },
      expectedStatus: 404,
    });
    await json(`${harness.base}/api/documents/${unknownId}/html`, { token: user.token, expectedStatus: 404 });
    await json(`${harness.base}/api/documents/nope`, { token: user.token, expectedStatus: 400 });
    await fetchExpect(`${harness.base}/d/${unknownId}`, 404);
    await fetchExpect(`${harness.base}/d/nope`, 400);
    await fetchExpect(`${harness.base}/s/${unknownId}`, 404);
  } finally {
    await harness.close();
  }
});

test("document updates enforce viewer, editor, and owner permission tiers", async () => {
  const harness = await startCloudServer("noma-cloud-tiers-");
  try {
    const owner = await createCloudUser(harness.base, "Tier Owner");
    const viewer = await createCloudUser(harness.base, "Tier Viewer");
    const editor = await createCloudUser(harness.base, "Tier Editor");
    const stranger = await createCloudUser(harness.base, "Tier Stranger");

    const created = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: owner.token,
      body: { source: "# Tiered Doc\n\nOriginal content." },
    });

    await json(`${harness.base}/api/documents/${created.id}`, {
      method: "PUT",
      body: { source: "# Tiered Doc\n\nAnonymous edit." },
      expectedStatus: 401,
    });
    await json(`${harness.base}/api/documents/${created.id}`, {
      method: "PUT",
      token: stranger.token,
      body: { source: "# Tiered Doc\n\nStranger edit." },
      expectedStatus: 403,
    });

    await json(`${harness.base}/api/documents/${created.id}/collaborators`, {
      method: "POST",
      token: owner.token,
      body: { userId: viewer.id, role: "viewer" },
    });
    await json(`${harness.base}/api/documents/${created.id}/collaborators`, {
      method: "POST",
      token: owner.token,
      body: { userId: editor.id, role: "editor" },
    });

    const viewerLoaded = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${created.id}`, {
      token: viewer.token,
    });
    assert.equal(viewerLoaded.access.role, "viewer");
    await json(`${harness.base}/api/documents/${created.id}`, {
      method: "PUT",
      token: viewer.token,
      body: { source: "# Tiered Doc\n\nViewer edit." },
      expectedStatus: 403,
    });
    await json(`${harness.base}/api/documents/${created.id}/shares`, {
      method: "POST",
      token: viewer.token,
      body: { role: "viewer" },
      expectedStatus: 403,
    });
    await json(`${harness.base}/api/documents/${created.id}/collaborators`, {
      token: viewer.token,
      expectedStatus: 403,
    });

    const editorUpdated = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${created.id}`, {
      method: "PUT",
      token: editor.token,
      body: { source: "# Tiered Doc\n\nEditor edit.", expectedHash: created.hash },
    });
    assert.equal(editorUpdated.source, "# Tiered Doc\n\nEditor edit.");
    await json(`${harness.base}/api/documents/${created.id}/collaborators`, {
      method: "POST",
      token: editor.token,
      body: { userId: stranger.id, role: "viewer" },
      expectedStatus: 403,
    });

    await json(`${harness.base}/api/documents/${created.id}/collaborators`, {
      method: "POST",
      token: owner.token,
      body: { userId: viewer.id, role: "owner" },
      expectedStatus: 400,
    });
    await json(`${harness.base}/api/documents/${created.id}/collaborators`, {
      method: "POST",
      token: owner.token,
      body: { userId: "aaaaaaaaaaaaaaaaaa", role: "viewer" },
      expectedStatus: 404,
    });

    const collaborators = await json<{ collaborators: Array<{ userId: string; role: string }> }>(
      `${harness.base}/api/documents/${created.id}/collaborators`,
      { token: owner.token },
    );
    assert.deepEqual(
      collaborators.collaborators.map((item) => [item.userId, item.role]).sort(),
      [
        [editor.id, "editor"],
        [owner.id, "owner"],
        [viewer.id, "viewer"],
      ].sort(),
    );
  } finally {
    await harness.close();
  }
});

test("rendered HTML and LLM output never include escape-hatch bodies", async () => {
  const harness = await startCloudServer("noma-cloud-escape-");
  try {
    const owner = await createCloudUser(harness.base, "Escape Owner");
    const source = [
      "# Escape Hatch Doc",
      "",
      "Safe paragraph content.",
      "",
      '::script{id="s1"}',
      "alert(1)",
      "::",
      "",
      '::html{id="h1"}',
      "<script>alert(2)</script>",
      "::",
      "",
    ].join("\n");
    const created = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: owner.token,
      body: { source },
    });

    const artifact = await fetch(`${harness.base}/d/${created.id}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(artifact.status, 200);
    const artifactHtml = await artifact.text();
    assert.match(artifactHtml, /Safe paragraph content/);
    assert.match(artifactHtml, /escape hatch disabled/);
    assert.doesNotMatch(artifactHtml, /alert\(1\)/);
    assert.doesNotMatch(artifactHtml, /alert\(2\)/);
    assert.doesNotMatch(artifactHtml, /<script>alert/);

    const apiHtml = await fetch(`${harness.base}/api/documents/${created.id}/html`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(apiHtml.status, 200);
    assert.match(apiHtml.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(apiHtml.headers.get("referrer-policy"), "no-referrer");
    assert.equal(apiHtml.headers.get("x-content-type-options"), "nosniff");
    assert.equal(apiHtml.headers.get("x-frame-options"), "DENY");
    const apiHtmlText = await apiHtml.text();
    assert.doesNotMatch(apiHtmlText, /alert\(1\)/);
    assert.doesNotMatch(apiHtmlText, /<script>alert/);

    const llm = await fetch(`${harness.base}/api/documents/${created.id}/llm`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(llm.status, 200);
    assert.doesNotMatch(await llm.text(), /alert\(1\)/);

    const site = await json<CloudSiteResponse>(`${harness.base}/api/sites`, {
      method: "POST",
      token: owner.token,
      body: { title: "Escape Site", documentIds: [created.id] },
    });
    const renderedSite = await fetch(`${harness.base}/s/${site.id}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    });
    assert.equal(renderedSite.status, 200);
    const renderedSiteHtml = await renderedSite.text();
    assert.match(renderedSiteHtml, /Safe paragraph content/);
    assert.doesNotMatch(renderedSiteHtml, /alert\(1\)/);
    assert.doesNotMatch(renderedSiteHtml, /<script>alert/);
  } finally {
    await harness.close();
  }
});

test("document share links are role scoped and validated", async () => {
  const harness = await startCloudServer("noma-cloud-share-roles-");
  try {
    const owner = await createCloudUser(harness.base, "Share Owner");
    const created = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: owner.token,
      body: { source: "# Share Scoped\n\nReadable through links." },
    });

    await json(`${harness.base}/api/documents/${created.id}/shares`, {
      method: "POST",
      token: owner.token,
      body: { role: "owner" },
      expectedStatus: 400,
    });
    await json(`${harness.base}/api/documents/aaaaaaaaaaaaaaaaaa/shares`, {
      method: "POST",
      token: owner.token,
      body: { role: "viewer" },
      expectedStatus: 404,
    });

    const viewerShare = await json<CloudShareResponse>(`${harness.base}/api/documents/${created.id}/shares`, {
      method: "POST",
      token: owner.token,
      body: { role: "viewer", label: "Read only" },
    });

    const viaShare = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${created.id}`, {
      share: viewerShare.token,
    });
    assert.equal(Object.hasOwn(viaShare, "permissions"), false);
    assert.equal(Object.hasOwn(viaShare, "shareLinks"), false);
    assert.equal(viaShare.access.role, "viewer");
    assert.equal(viaShare.access.via, "share");

    const artifact = await fetch(`${harness.base}/d/${created.id}?share=${viewerShare.token}`);
    assert.equal(artifact.status, 200);
    assert.match(await artifact.text(), /Readable through links/);

    await json(`${harness.base}/api/documents/${created.id}`, {
      method: "PUT",
      share: viewerShare.token,
      body: { source: "# Share Scoped\n\nViewer link edit." },
      expectedStatus: 403,
    });

    const wrongToken = await fetch(`${harness.base}/d/${created.id}?share=ns_not_a_real_token`);
    assert.equal(wrongToken.status, 403);

    const shares = await json<{ shares: Array<Record<string, unknown>> }>(
      `${harness.base}/api/documents/${created.id}/shares`,
      { token: owner.token },
    );
    assert.equal(shares.shares.length, 1);
    assert.equal(Object.hasOwn(shares.shares[0] ?? {}, "tokenHash"), false);
    assert.equal(typeof shares.shares[0]?.tokenPreview, "string");
    await json(`${harness.base}/api/documents/${created.id}/shares/${viewerShare.id}`, {
      method: "DELETE",
      token: owner.token,
    });
    const revokedArtifact = await fetch(`${harness.base}/d/${created.id}?share=${viewerShare.token}`);
    assert.equal(revokedArtifact.status, 403);
  } finally {
    await harness.close();
  }
});

test("db query endpoint rejects malformed input", async () => {
  const harness = await startCloudServer("noma-cloud-db-input-");
  try {
    const user = await createCloudUser(harness.base, "Query Validator");

    await json(`${harness.base}/api/db/query`, {
      method: "POST",
      token: user.token,
      body: {},
      expectedStatus: 400,
    });
    await json(`${harness.base}/api/db/query`, {
      method: "POST",
      token: user.token,
      body: { resource: "everything" },
      expectedStatus: 400,
    });
    await json(`${harness.base}/api/db/query`, {
      method: "POST",
      token: user.token,
      body: { resource: "documents", limit: "10" },
      expectedStatus: 400,
    });
    await json(`${harness.base}/api/db/query`, {
      method: "POST",
      token: user.token,
      body: { resource: "documents", limit: 0 },
      expectedStatus: 400,
    });
    await json(`${harness.base}/api/db/query`, {
      method: "POST",
      token: user.token,
      body: { resource: "documents", offset: 10_001 },
      expectedStatus: 400,
    });
    await json(`${harness.base}/api/db/query`, {
      method: "POST",
      token: user.token,
      body: { resource: "documents", offset: 1.5 },
      expectedStatus: 400,
    });
    await json(`${harness.base}/api/db/query`, {
      method: "POST",
      token: user.token,
      body: { resource: "blocks", documentId: "x!" },
      expectedStatus: 400,
    });
    await json(`${harness.base}/api/db/query`, {
      token: user.token,
      expectedStatus: 404,
    });

    const invalidJson = await fetch(`${harness.base}/api/db/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(invalidJson.status, 400);
    const arrayBody = await fetch(`${harness.base}/api/db/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "content-type": "application/json" },
      body: JSON.stringify([{ resource: "documents" }]),
    });
    assert.equal(arrayBody.status, 400);
  } finally {
    await harness.close();
  }
});

test("db query results are permission scoped and bounded", async () => {
  const harness = await startCloudServer("noma-cloud-db-scope-");
  try {
    const alice = await createCloudUser(harness.base, "Scope Alice");
    const bob = await createCloudUser(harness.base, "Scope Bob");

    const aliceIds: string[] = [];
    for (const title of ["Alpha One", "Alpha Two", "Alpha Three"]) {
      const doc = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
        method: "POST",
        token: alice.token,
        body: { source: `# ${title}\n\nAlpha secret phrase.` },
      });
      aliceIds.push(doc.id);
    }
    const bobDoc = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: bob.token,
      body: { source: "# Bravo Doc\n\nBravo only content." },
    });

    const bobDocuments = await json<CloudDbQueryResponse>(`${harness.base}/api/db/query`, {
      method: "POST",
      token: bob.token,
      body: { resource: "documents" },
    });
    assert.deepEqual(bobDocuments.rows.map((row) => row.id), [bobDoc.id]);

    const bobBlocks = await json<CloudDbQueryResponse>(`${harness.base}/api/db/query`, {
      method: "POST",
      token: bob.token,
      body: { resource: "blocks", q: "Alpha secret phrase" },
    });
    assert.equal(bobBlocks.rows.length, 0);

    const pageOne = await json<CloudDbQueryResponse>(`${harness.base}/api/db/query`, {
      method: "POST",
      token: alice.token,
      body: { resource: "documents", limit: 2 },
    });
    const pageTwo = await json<CloudDbQueryResponse>(`${harness.base}/api/db/query`, {
      method: "POST",
      token: alice.token,
      body: { resource: "documents", limit: 2, offset: 2 },
    });
    assert.equal(pageOne.rows.length, 2);
    assert.equal(pageTwo.rows.length, 1);
    assert.deepEqual(
      [...pageOne.rows, ...pageTwo.rows].map((row) => String(row.id)).sort(),
      [...aliceIds].sort(),
    );
  } finally {
    await harness.close();
  }
});

test("site endpoints enforce membership and document edit access", async () => {
  const harness = await startCloudServer("noma-cloud-site-access-");
  try {
    const alice = await createCloudUser(harness.base, "Site Alice");
    const bob = await createCloudUser(harness.base, "Site Bob");

    const doc = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: alice.token,
      body: { source: "# Site Page\n\nSite scoped content." },
    });

    await json(`${harness.base}/api/sites`, {
      method: "POST",
      token: bob.token,
      body: { title: "Bob Steals Pages", documentIds: [doc.id] },
      expectedStatus: 403,
    });

    const site = await json<CloudSiteResponse>(`${harness.base}/api/sites`, {
      method: "POST",
      token: alice.token,
      body: { title: "Members Only", documentIds: [doc.id] },
    });

    await json(`${harness.base}/api/sites/${site.id}`, { token: bob.token, expectedStatus: 403 });
    await fetchExpect(`${harness.base}/s/${site.id}`, 401);

    const share = await json<CloudShareResponse>(`${harness.base}/api/sites/${site.id}/shares`, {
      method: "POST",
      token: alice.token,
      body: { role: "viewer", label: "Site readers" },
    });

    const rendered = await fetch(`${harness.base}/s/${site.id}?share=${share.token}`);
    assert.equal(rendered.status, 200);
    const renderedHtml = await rendered.text();
    assert.match(renderedHtml, /Site scoped content/);
    assert.match(renderedHtml, /viewer access/);

    await json(`${harness.base}/api/sites/${site.id}`, {
      method: "PUT",
      share: share.token,
      body: { title: "Viewer Rename", documentIds: [doc.id] },
      expectedStatus: 403,
    });
    await json(`${harness.base}/api/sites/${site.id}/documents`, {
      method: "POST",
      share: share.token,
      body: { source: "# Viewer Page\n\nShould fail." },
      expectedStatus: 403,
    });

    const wiki = await json<{ pages: Array<{ id: string }> }>(`${harness.base}/api/sites/${site.id}/wiki`, {
      share: share.token,
    });
    assert.deepEqual(wiki.pages.map((page) => page.id), [doc.id]);
  } finally {
    await harness.close();
  }
});

test("cloud navigation supports templates, Markdown import, full-text search, favorites, recents, and trash restore", async () => {
  const harness = await startCloudServer("noma-cloud-navigation-");
  try {
    const alice = await createCloudUser(harness.base, "Navigation Alice");
    const bob = await createCloudUser(harness.base, "Navigation Bob");
    const templates = await json<{ templates: Array<{ id: string; source: string }>; count: number }>(`${harness.base}/api/templates`, {
      token: alice.token,
    });
    assert.ok(templates.count >= 6);
    assert.ok(templates.templates.some((template) => template.id === "technical-spec"));

    const seed = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: alice.token,
      body: { title: "Navigation Home", templateId: "project-overview" },
    });
    assert.match(seed.source, /# Navigation Home \{id="navigation-home"\}/);

    const site = await json<CloudSiteResponse>(`${harness.base}/api/sites`, {
      method: "POST",
      token: alice.token,
      body: { title: "Navigation Space", documentIds: [seed.id] },
    });
    const imported = await json<CloudDocumentResponse>(`${harness.base}/api/sites/${site.id}/documents`, {
      method: "POST",
      token: alice.token,
      body: {
        title: "Imported Notes",
        format: "markdown",
        source: "# Imported Notes\n\n## Quantum Zeppelin\n\nA uniquely searchable phrase for navigation testing.\n",
      },
    });
    assert.match(imported.source, /## Quantum Zeppelin \{id="quantum-zeppelin"\}/);

    const technical = await json<CloudDocumentResponse>(`${harness.base}/api/sites/${site.id}/documents`, {
      method: "POST",
      token: alice.token,
      body: { title: "Service Contract", templateId: "technical-spec", folder: "Specs" },
    });
    assert.match(technical.source, /profile: technical-docs/);

    const search = await json<{ results: Array<{ documentId: string; excerpt: string; access: { role: string } }> }>(
      `${harness.base}/api/search?q=${encodeURIComponent("quantum zeppelin")}&site=${site.id}`,
      { token: alice.token },
    );
    assert.ok(search.results.some((result) => result.documentId === imported.id));
    assert.ok(search.results.every((result) => result.access.role === "owner"));
    const bobSearch = await json<{ results: unknown[] }>(`${harness.base}/api/search?q=quantum`, { token: bob.token });
    assert.equal(bobSearch.results.length, 0);
    const punctuationSearch = await json<{ results: unknown[] }>(
      `${harness.base}/api/search?q=${encodeURIComponent('"quantum" OR zeppelin:')}`,
      { token: alice.token },
    );
    assert.ok(punctuationSearch.results.length > 0);

    await json(`${harness.base}/api/sites/${site.id}`, { token: alice.token });
    await json(`${harness.base}/api/sites/${site.id}/documents/${imported.id}`, { token: alice.token });
    await json(`${harness.base}/api/navigation/favorites`, {
      method: "PUT",
      token: alice.token,
      body: { resourceType: "document", resourceId: imported.id },
    });
    const navigation = await json<{
      recents: Array<{ resourceType: string; resourceId: string }>;
      favorites: Array<{ resourceType: string; resourceId: string }>;
    }>(`${harness.base}/api/navigation`, { token: alice.token });
    assert.ok(navigation.recents.some((item) => item.resourceType === "site" && item.resourceId === site.id));
    assert.ok(navigation.recents.some((item) => item.resourceType === "document" && item.resourceId === imported.id));
    assert.deepEqual(navigation.favorites.map((item) => item.resourceId), [imported.id]);

    await json(`${harness.base}/api/navigation/favorites`, {
      method: "PUT",
      token: bob.token,
      body: { resourceType: "document", resourceId: imported.id },
      expectedStatus: 403,
    });

    await json(`${harness.base}/api/trash/document/${imported.id}`, { method: "POST", token: alice.token });
    await json(`${harness.base}/api/documents/${imported.id}`, { token: alice.token, expectedStatus: 410 });
    const trashedSearch = await json<{ results: unknown[] }>(`${harness.base}/api/search?q=quantum`, { token: alice.token });
    assert.equal(trashedSearch.results.length, 0);
    const trash = await json<{ items: Array<{ resourceType: string; resourceId: string; trashedBy: string }> }>(
      `${harness.base}/api/trash`,
      { token: alice.token },
    );
    assert.ok(trash.items.some((item) => item.resourceType === "document" && item.resourceId === imported.id && item.trashedBy === alice.id));
    const siteWithoutTrashedPage = await json<CloudSiteResponse & { documents: CloudDocumentResponse[] }>(
      `${harness.base}/api/sites/${site.id}?include=documents`,
      { token: alice.token },
    );
    assert.equal(siteWithoutTrashedPage.documentIds.includes(imported.id), true);
    assert.equal(siteWithoutTrashedPage.documents.some((document) => document.id === imported.id), false);

    await json(`${harness.base}/api/trash/document/${imported.id}/restore`, { method: "POST", token: alice.token });
    const restored = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${imported.id}`, { token: alice.token });
    assert.match(restored.source, /Quantum Zeppelin/);

    await json(`${harness.base}/api/trash/site/${site.id}`, { method: "POST", token: alice.token });
    await json(`${harness.base}/api/sites/${site.id}`, { token: alice.token, expectedStatus: 410 });
    const listedSites = await json<{ sites: Array<{ id: string }> }>(`${harness.base}/api/sites`, { token: alice.token });
    assert.equal(listedSites.sites.some((listed) => listed.id === site.id), false);
    await json(`${harness.base}/api/trash/site/${site.id}/restore`, { method: "POST", token: alice.token });
    const restoredSite = await json<CloudSiteResponse>(`${harness.base}/api/sites/${site.id}`, { token: alice.token });
    assert.equal(restoredSite.id, site.id);
  } finally {
    await harness.close();
  }
});

test("cloud collaboration supports comments, mentions, notifications, approvals, activity, and groups", async () => {
  const harness = await startCloudServer("noma-cloud-collaboration-");
  try {
    const alice = await createCloudUser(harness.base, "Collaboration Alice");
    const bob = await createCloudUser(harness.base, "Collaboration Bob");
    const carol = await createCloudUser(harness.base, "Collaboration Carol");
    const document = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: alice.token,
      body: { source: '# Collaboration brief {id="collaboration-brief"}\n\nReview this proposal.\n' },
    });
    await json(`${harness.base}/api/documents/${document.id}/collaborators`, {
      method: "POST",
      token: alice.token,
      body: { userId: bob.id, role: "editor" },
    });
    await json(`${harness.base}/api/documents/${document.id}/collaborators`, {
      method: "POST",
      token: alice.token,
      body: { userId: carol.id, role: "viewer" },
    });
    await json(`${harness.base}/api/documents/${document.id}`, { token: carol.token });
    await json(`${harness.base}/api/documents/${document.id}/collaborators/${carol.id}`, {
      method: "DELETE",
      token: alice.token,
    });
    await json(`${harness.base}/api/documents/${document.id}`, { token: carol.token, expectedStatus: 403 });

    await json(`${harness.base}/api/documents/${document.id}/comments`, {
      method: "POST",
      token: bob.token,
      body: { body: "Invalid block", blockId: "missing-block" },
      expectedStatus: 400,
    });
    const comment = await json<{
      id: string;
      body: string;
      blockId: string;
      createdBy: string;
      resolvedAt?: string;
    }>(`${harness.base}/api/documents/${document.id}/comments`, {
      method: "POST",
      token: bob.token,
      body: {
        body: `Please review this detail @{${alice.id}}`,
        blockId: "collaboration-brief",
        line: 1,
      },
    });
    assert.equal(comment.createdBy, bob.id);
    assert.equal(comment.blockId, "collaboration-brief");

    const comments = await json<{ comments: Array<{ id: string; createdByName: string }> }>(
      `${harness.base}/api/documents/${document.id}/comments`,
      { token: alice.token },
    );
    assert.equal(comments.comments[0]?.id, comment.id);
    assert.equal(comments.comments[0]?.createdByName, "Collaboration Bob");
    const resolved = await json<{ resolvedAt?: string }>(`${harness.base}/api/documents/${document.id}/comments/${comment.id}/resolve`, {
      method: "POST",
      token: alice.token,
    });
    assert.ok(resolved.resolvedAt);
    const reopened = await json<{ resolvedAt?: string }>(`${harness.base}/api/documents/${document.id}/comments/${comment.id}/resolve`, {
      method: "POST",
      token: alice.token,
    });
    assert.equal(reopened.resolvedAt, undefined);

    const aliceNotifications = await json<{
      unread: number;
      notifications: Array<{ id: string; type: string; resourceId?: string; readAt?: string }>;
    }>(`${harness.base}/api/notifications`, { token: alice.token });
    assert.ok(aliceNotifications.unread >= 1);
    assert.ok(
      aliceNotifications.notifications.some(
        (notification) => notification.type === "mention" && notification.resourceId === document.id,
      ),
    );
    const mention = aliceNotifications.notifications.find((notification) => notification.type === "mention");
    assert.ok(mention);
    await json(`${harness.base}/api/notifications/${mention.id}/read`, { method: "POST", token: alice.token });
    const afterRead = await json<{ notifications: Array<{ id: string; readAt?: string }> }>(`${harness.base}/api/notifications`, {
      token: alice.token,
    });
    assert.ok(afterRead.notifications.find((notification) => notification.id === mention.id)?.readAt);
    await json(`${harness.base}/api/notifications/read-all`, { method: "POST", token: alice.token });

    const staleApproval = await json<{ id: string; documentHash: string; status: string }>(
      `${harness.base}/api/documents/${document.id}/approvals`,
      { method: "POST", token: alice.token, body: { reviewerId: bob.id, note: "Review version one" } },
    );
    assert.equal(staleApproval.documentHash, document.hash);
    await json(`${harness.base}/api/documents/${document.id}/approvals`, {
      method: "POST",
      token: alice.token,
      body: { reviewerId: bob.id },
      expectedStatus: 409,
    });
    const updated = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${document.id}`, {
      method: "PUT",
      token: alice.token,
      body: {
        source: '# Collaboration brief {id="collaboration-brief"}\n\nReview this revised proposal.\n',
        expectedHash: document.hash,
      },
    });
    await json(`${harness.base}/api/documents/${document.id}/approvals/${staleApproval.id}`, {
      method: "PATCH",
      token: bob.token,
      body: { status: "approved" },
      expectedStatus: 409,
    });
    await json(`${harness.base}/api/documents/${document.id}/approvals/${staleApproval.id}`, {
      method: "PATCH",
      token: alice.token,
      body: { status: "cancelled" },
    });
    const currentApproval = await json<{ id: string; documentHash: string }>(
      `${harness.base}/api/documents/${document.id}/approvals`,
      { method: "POST", token: alice.token, body: { reviewerId: bob.id } },
    );
    assert.equal(currentApproval.documentHash, updated.hash);
    const approved = await json<{ status: string }>(`${harness.base}/api/documents/${document.id}/approvals/${currentApproval.id}`, {
      method: "PATCH",
      token: bob.token,
      body: { status: "approved", note: "Ready to publish" },
    });
    assert.equal(approved.status, "approved");
    const approvals = await json<{ approvals: Array<{ id: string; status: string; reviewerName: string }> }>(
      `${harness.base}/api/documents/${document.id}/approvals`,
      { token: alice.token },
    );
    assert.equal(approvals.approvals.find((item) => item.id === currentApproval.id)?.reviewerName, "Collaboration Bob");

    const group = await json<{
      id: string;
      name: string;
      members: Array<{ userId: string; role: string }>;
    }>(`${harness.base}/api/groups`, {
      method: "POST",
      token: alice.token,
      body: { name: "Review Council" },
    });
    assert.equal(group.members[0]?.role, "manager");
    const groupWithBob = await json<{ members: Array<{ userId: string; role: string }> }>(
      `${harness.base}/api/groups/${group.id}/members`,
      { method: "POST", token: alice.token, body: { userId: bob.id, role: "member" } },
    );
    assert.ok(groupWithBob.members.some((member) => member.userId === bob.id && member.role === "member"));
    await json(`${harness.base}/api/groups/${group.id}/members`, {
      method: "POST",
      token: bob.token,
      body: { userId: carol.id },
      expectedStatus: 403,
    });
    await json(`${harness.base}/api/groups/${group.id}/members/${alice.id}`, {
      method: "DELETE",
      token: alice.token,
      expectedStatus: 409,
    });
    await json(`${harness.base}/api/groups/${group.id}/members`, {
      method: "POST",
      token: alice.token,
      body: { userId: carol.id, role: "member" },
    });
    const groupPermissions = await json<{
      groups: Array<{ groupId: string; groupName: string; role: string }>;
    }>(`${harness.base}/api/documents/${document.id}/group-collaborators`, {
      method: "POST",
      token: alice.token,
      body: { groupId: group.id, role: "viewer" },
    });
    assert.deepEqual(groupPermissions.groups, [
      { groupId: group.id, groupName: "Review Council", role: "viewer", addedAt: "2026-06-06T12:00:00.000Z" },
    ]);
    const carolViaGroup = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${document.id}`, {
      token: carol.token,
    });
    assert.equal(carolViaGroup.access.role, "viewer");
    assert.equal(carolViaGroup.access.via, "group");
    await json(`${harness.base}/api/documents/${document.id}`, {
      method: "PUT",
      token: carol.token,
      body: { source: "# Forbidden", expectedHash: carolViaGroup.hash },
      expectedStatus: 403,
    });
    const carolSearch = await json<{ results: Array<{ documentId: string }> }>(
      `${harness.base}/api/search?q=collaboration`,
      { token: carol.token },
    );
    assert.ok(carolSearch.results.some((result) => result.documentId === document.id));
    await json(`${harness.base}/api/documents/${document.id}/group-collaborators/${group.id}`, {
      method: "DELETE",
      token: alice.token,
    });
    await json(`${harness.base}/api/documents/${document.id}`, { token: carol.token, expectedStatus: 403 });
    const bobGroups = await json<{ groups: Array<{ id: string }> }>(`${harness.base}/api/groups`, { token: bob.token });
    assert.ok(bobGroups.groups.some((item) => item.id === group.id));
    const carolGroups = await json<{ groups: Array<{ id: string }> }>(`${harness.base}/api/groups`, { token: carol.token });
    assert.ok(carolGroups.groups.some((item) => item.id === group.id));

    const activity = await json<{ events: Array<{ action: string; actorId: string }> }>(
      `${harness.base}/api/activity?document=${document.id}`,
      { token: alice.token },
    );
    const actions = new Set(activity.events.map((event) => event.action));
    assert.ok(actions.has("document.created"));
    assert.ok(actions.has("document.updated"));
    assert.ok(actions.has("comment.created"));
    assert.ok(actions.has("comment.resolved"));
    assert.ok(actions.has("approval.requested"));
    assert.ok(actions.has("approval.approved"));
    const bobActivity = await json<{ events: Array<{ action: string }> }>(
      `${harness.base}/api/activity?document=${document.id}`,
      { token: bob.token },
    );
    assert.ok(bobActivity.events.some((event) => event.action === "approval.approved"));
    const carolActivity = await json<{ events: unknown[] }>(`${harness.base}/api/activity`, { token: carol.token });
    assert.equal(carolActivity.events.length, 0);
  } finally {
    await harness.close();
  }
});

test("cloud work management supports projects, workflows, boards, backlog, sprints, filters, links, and issue history", async () => {
  const harness = await startCloudServer("noma-cloud-work-");
  try {
    const alice = await createCloudUser(harness.base, "Work Alice");
    const bob = await createCloudUser(harness.base, "Work Bob");
    const carol = await createCloudUser(harness.base, "Work Carol");
    const page = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: alice.token,
      body: { source: '# Delivery plan {id="delivery-plan"}\n' },
    });
    const site = await json<CloudSiteResponse>(`${harness.base}/api/sites`, {
      method: "POST",
      token: alice.token,
      body: { title: "Delivery Space", documentIds: [page.id] },
    });
    await json(`${harness.base}/api/sites/${site.id}/collaborators`, {
      method: "POST",
      token: alice.token,
      body: { userId: bob.id, role: "editor" },
    });

    const project = await json<{ id: string; key: string; name: string; siteId: string; access: { role: string } }>(
      `${harness.base}/api/projects`,
      {
        method: "POST",
        token: alice.token,
        body: { siteId: site.id, key: "NOM", name: "Noma Delivery", description: "Integrated documentation and work." },
      },
    );
    assert.equal(project.key, "NOM");
    assert.equal(project.access.role, "owner");
    await json(`${harness.base}/api/projects`, {
      method: "POST",
      token: alice.token,
      body: { siteId: site.id, key: "nom", name: "Duplicate" },
      expectedStatus: 409,
    });
    const bobProjects = await json<{ projects: Array<{ id: string; access: { role: string } }> }>(`${harness.base}/api/projects`, {
      token: bob.token,
    });
    assert.equal(bobProjects.projects[0]?.id, project.id);
    assert.equal(bobProjects.projects[0]?.access.role, "editor");
    const carolProjects = await json<{ projects: unknown[] }>(`${harness.base}/api/projects`, { token: carol.token });
    assert.equal(carolProjects.projects.length, 0);
    await json(`${harness.base}/api/projects/${project.id}`, { token: carol.token, expectedStatus: 403 });

    const sprint = await json<{ id: string; status: string }>(`${harness.base}/api/projects/${project.id}/sprints`, {
      method: "POST",
      token: alice.token,
      body: { name: "Sprint 1", goal: "Ship collaboration" },
    });
    assert.equal(sprint.status, "planned");
    const activeSprint = await json<{ id: string; status: string; startAt: string }>(
      `${harness.base}/api/projects/${project.id}/sprints/${sprint.id}`,
      { method: "PATCH", token: alice.token, body: { status: "active" } },
    );
    assert.equal(activeSprint.status, "active");
    assert.ok(activeSprint.startAt);
    await json(`${harness.base}/api/projects/${project.id}/sprints`, {
      method: "POST",
      token: alice.token,
      body: { name: "Parallel sprint", status: "active" },
      expectedStatus: 409,
    });

    const epic = await json<{ id: string; key: string; type: string }>(`${harness.base}/api/projects/${project.id}/issues`, {
      method: "POST",
      token: alice.token,
      body: { summary: "Collaboration platform", type: "epic", priority: "highest" },
    });
    assert.equal(epic.key, "NOM-1");
    const story = await json<{
      id: string;
      key: string;
      status: string;
      labels: string[];
      assigneeName: string;
      sprintId: string;
      parentId: string;
    }>(`${harness.base}/api/projects/${project.id}/issues`, {
      method: "POST",
      token: alice.token,
      body: {
        summary: "Review pages in context",
        type: "story",
        priority: "high",
        assigneeId: bob.id,
        sprintId: sprint.id,
        parentId: epic.id,
        labels: ["Cloud UX", "agents"],
        estimate: 5,
        dueDate: "2026-07-31",
      },
    });
    assert.equal(story.key, "NOM-2");
    assert.equal(story.assigneeName, "Work Bob");
    assert.deepEqual(story.labels, ["cloud-ux", "agents"]);
    const carryOver = await json<{ id: string }>(`${harness.base}/api/projects/${project.id}/issues`, {
      method: "POST",
      token: bob.token,
      body: { summary: "Unfinished task", status: "todo", sprintId: sprint.id, assigneeId: bob.id },
    });

    const filtered = await json<{ issues: Array<{ id: string }> }>(
      `${harness.base}/api/projects/${project.id}/issues?label=agents&assignee=${bob.id}&priority=high`,
      { token: alice.token },
    );
    assert.deepEqual(filtered.issues.map((issue) => issue.id), [story.id]);
    const board = await json<{ columns: Record<string, Array<{ id: string }>>; activeSprint: { id: string } }>(
      `${harness.base}/api/projects/${project.id}/board`,
      { token: bob.token },
    );
    assert.ok(board.columns.backlog?.some((issue) => issue.id === story.id));
    assert.equal(board.activeSprint.id, sprint.id);
    const backlog = await json<{ issues: Array<{ id: string }> }>(`${harness.base}/api/projects/${project.id}/backlog`, {
      token: alice.token,
    });
    assert.ok(backlog.issues.some((issue) => issue.id === epic.id));
    assert.equal(backlog.issues.some((issue) => issue.id === story.id), false);

    await json(`${harness.base}/api/projects/${project.id}/issues/${story.id}`, {
      method: "PATCH",
      token: bob.token,
      body: { status: "in_review" },
      expectedStatus: 409,
    });
    for (const status of ["todo", "in_progress", "in_review", "done"]) {
      const moved = await json<{ status: string }>(`${harness.base}/api/projects/${project.id}/issues/${story.id}`, {
        method: "PATCH",
        token: bob.token,
        body: { status },
      });
      assert.equal(moved.status, status);
    }
    const issueComment = await json<{ body: string; createdByName: string }>(
      `${harness.base}/api/projects/${project.id}/issues/${story.id}/comments`,
      { method: "POST", token: bob.token, body: { body: "Ready for the release review." } },
    );
    assert.equal(issueComment.createdByName, "Work Bob");
    const link = await json<{ targetIssueKey: string; type: string }>(
      `${harness.base}/api/projects/${project.id}/issues/${story.id}/links`,
      { method: "POST", token: alice.token, body: { targetIssueId: epic.id, type: "relates" } },
    );
    assert.equal(link.targetIssueKey, "NOM-1");
    const issueDetail = await json<{
      comments: Array<{ body: string }>;
      links: Array<{ targetIssueKey: string }>;
      events: Array<{ action: string; detail: Record<string, unknown> }>;
    }>(`${harness.base}/api/projects/${project.id}/issues/${story.id}`, { token: alice.token });
    assert.equal(issueDetail.comments[0]?.body, "Ready for the release review.");
    assert.equal(issueDetail.links[0]?.targetIssueKey, "NOM-1");
    assert.ok(issueDetail.events.some((event) => event.action === "issue.created"));
    assert.ok(issueDetail.events.some((event) => event.action === "issue.updated" && Object.hasOwn(event.detail, "status")));
    assert.ok(issueDetail.events.some((event) => event.action === "comment.created"));

    await json(`${harness.base}/api/documents/${page.id}/patch-proposals`, {
      method: "POST",
      token: alice.token,
      body: { ops: [{ op: "update_heading", id: "missing-heading", title: "No target" }], issueId: story.id },
      expectedStatus: 422,
    });
    const proposal = await json<{
      id: string;
      issueId: string;
      status: string;
      proof: { status: string; canWrite: boolean; preHash: { sha256: string }; postHash: { sha256: string } };
    }>(`${harness.base}/api/documents/${page.id}/patch-proposals`, {
      method: "POST",
      token: alice.token,
      body: {
        summary: "Agent updates the delivery title",
        issueId: story.id,
        ops: [{ op: "update_heading", id: "delivery-plan", title: "Delivery plan v2" }],
      },
    });
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.issueId, story.id);
    assert.equal(proposal.proof.status, "pass");
    assert.equal(proposal.proof.canWrite, true);
    assert.notEqual(proposal.proof.preHash.sha256, proposal.proof.postHash.sha256);
    await json(`${harness.base}/api/documents/${page.id}/patch-proposals/${proposal.id}/review`, {
      method: "POST",
      token: alice.token,
      body: { decision: "approved" },
      expectedStatus: 409,
    });
    const approvedProposal = await json<{ status: string; reviewedBy: string }>(
      `${harness.base}/api/documents/${page.id}/patch-proposals/${proposal.id}/review`,
      { method: "POST", token: bob.token, body: { decision: "approved" } },
    );
    assert.equal(approvedProposal.status, "approved");
    assert.equal(approvedProposal.reviewedBy, bob.id);
    const applied = await json<{ proposal: { status: string; appliedHash: string }; document: CloudDocumentResponse }>(
      `${harness.base}/api/documents/${page.id}/patch-proposals/${proposal.id}/apply`,
      { method: "POST", token: alice.token },
    );
    assert.equal(applied.proposal.status, "applied");
    assert.equal(applied.proposal.appliedHash, applied.document.hash);
    assert.match(applied.document.source, /# Delivery plan v2/);
    const proposalList = await json<{ proposals: Array<{ id: string; status: string }> }>(
      `${harness.base}/api/documents/${page.id}/patch-proposals`,
      { token: bob.token },
    );
    assert.equal(proposalList.proposals.find((item) => item.id === proposal.id)?.status, "applied");
    const issueAfterPatch = await json<{ events: Array<{ action: string }> }>(
      `${harness.base}/api/projects/${project.id}/issues/${story.id}`,
      { token: alice.token },
    );
    assert.ok(issueAfterPatch.events.some((event) => event.action === "patch.proposed"));
    assert.ok(issueAfterPatch.events.some((event) => event.action === "patch.approved"));
    assert.ok(issueAfterPatch.events.some((event) => event.action === "patch.applied"));

    const staleProposal = await json<{ id: string }>(`${harness.base}/api/documents/${page.id}/patch-proposals`, {
      method: "POST",
      token: alice.token,
      body: { ops: [{ op: "update_heading", id: "delivery-plan", title: "Delivery plan v3" }] },
    });
    await json(`${harness.base}/api/documents/${page.id}`, {
      method: "PUT",
      token: alice.token,
      body: { source: "# Delivery plan v2\n\nHuman edit after the proposal.\n", expectedHash: applied.document.hash },
    });
    await json(`${harness.base}/api/documents/${page.id}/patch-proposals/${staleProposal.id}/review`, {
      method: "POST",
      token: bob.token,
      body: { decision: "approved" },
      expectedStatus: 409,
    });

    const closed = await json<{ status: string }>(`${harness.base}/api/projects/${project.id}/sprints/${sprint.id}`, {
      method: "PATCH",
      token: alice.token,
      body: { status: "closed" },
    });
    assert.equal(closed.status, "closed");
    const carried = await json<{ status: string; sprintId?: string }>(
      `${harness.base}/api/projects/${project.id}/issues/${carryOver.id}`,
      { token: alice.token },
    );
    assert.equal(carried.status, "backlog");
    assert.equal(carried.sprintId, undefined);
    const completed = await json<{ status: string; sprintId?: string }>(
      `${harness.base}/api/projects/${project.id}/issues/${story.id}`,
      { token: alice.token },
    );
    assert.equal(completed.status, "done");
    assert.equal(completed.sprintId, sprint.id);
  } finally {
    await harness.close();
  }
});

test("cloud agent-human platform exposes trustworthy RAG, governed agents, connected knowledge, continuity, and enterprise controls", async () => {
  const harness = await startCloudServer("noma-cloud-platform-api-");
  try {
    const alice = await createCloudUser(harness.base, "Alice Platform Owner");
    const source = `# Production handbook

::decision{id="deployment-region" status="open" owner="alice"}
Production services run in Zurich with a fifteen-minute recovery target.
::

See [[Missing escalation policy]].
`;
    const page = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: alice.token,
      body: { title: "Production handbook", source },
    });
    const site = await json<CloudSiteResponse>(`${harness.base}/api/sites`, {
      method: "POST",
      token: alice.token,
      body: { title: "Operations", documentIds: [page.id] },
    });

    const trust = await json<{ blockId: string; verifiedBy: string }>(`${harness.base}/api/knowledge/trust/${page.id}/deployment-region`, {
      method: "PUT",
      token: alice.token,
      body: {
        ownerId: alice.id,
        verifiedBy: alice.id,
        verifiedAt: "2026-06-01T00:00:00.000Z",
        reviewBy: "2027-01-01T00:00:00.000Z",
        canonicalFor: ["production deployment region"],
        sourceOf: ["https://ops.example/deployment"],
      },
    });
    assert.equal(trust.blockId, "deployment-region");
    assert.equal(trust.verifiedBy, alice.id);

    const hybrid = await json<{ mode: string; results: Array<{ documentId: string; blockId: string; exactSource: string; versionHash: string; accessDecision: { principalId: string } }> }>(
      `${harness.base}/api/knowledge/search?q=${encodeURIComponent("production Zurich recovery")}&site=${site.id}`,
      { token: alice.token },
    );
    assert.equal(hybrid.mode, "hybrid");
    assert.ok(hybrid.results.some((result) => result.documentId === page.id && result.blockId === "deployment-region" && result.versionHash === page.hash));
    assert.ok(hybrid.results.every((result) => result.accessDecision.principalId === alice.id));
    assert.ok(hybrid.results.some((result) => /Zurich/.test(result.exactSource)));

    const answer = await json<{ state: string; answer: string; citations: Array<{ documentId: string; blockId: string; versionHash: string }> }>(`${harness.base}/api/ask`, {
      method: "POST",
      token: alice.token,
      body: { query: "Where do production services run and what is the recovery target?", siteId: site.id },
    });
    assert.equal(answer.state, "answered");
    assert.match(answer.answer, /Zurich/);
    assert.ok(answer.citations.some((citation) => citation.documentId === page.id && citation.blockId === "deployment-region" && citation.versionHash === page.hash));

    const refusal = await json<{ state: string; citations: unknown[] }>(`${harness.base}/api/ask`, {
      method: "POST",
      token: alice.token,
      body: { query: "What food is served on Neptune?", siteId: site.id },
    });
    assert.equal(refusal.state, "insufficient_evidence");
    assert.deepEqual(refusal.citations, []);

    const evaluation = await json<{ passed: boolean; results: Array<{ permissionLeakage: number; citationCoverage: number; abstentionCorrect: boolean }> }>(`${harness.base}/api/knowledge/evaluations?site=${site.id}`, {
      method: "POST",
      token: alice.token,
      body: {
        fixtures: [
          { id: "deployment", query: "Where do production services run?", requiredSources: [{ documentId: page.id, blockId: "deployment-region" }], expectAbstention: false, maxLatencyMs: 5_000, maxCostUsd: 0.01 },
          { id: "unknown", query: "What is the Neptune cafeteria menu?", expectAbstention: true, maxLatencyMs: 5_000, maxCostUsd: 0.01 },
        ],
      },
    });
    assert.equal(evaluation.passed, true, JSON.stringify(evaluation));
    assert.ok(evaluation.results.every((result) => result.permissionLeakage === 0 && result.citationCoverage === 1 && result.abstentionCorrect));

    const health = await json<{ items: Array<{ kind: string }> }>(`${harness.base}/api/knowledge/health?site=${site.id}`, { token: alice.token });
    assert.ok(health.items.some((item) => item.kind === "broken_link"));
    const wiki = await json<{ missingConcepts: Array<{ target: string }>; canonicalConcepts: Array<{ concept: string }> }>(`${harness.base}/api/knowledge/wiki?site=${site.id}`, { token: alice.token });
    assert.ok(wiki.missingConcepts.some((item) => item.target === "Missing escalation policy"));
    assert.ok(wiki.canonicalConcepts.some((item) => item.concept === "production deployment region"));
    const reindex = await json<{ indexed: number; documentCount: number }>(`${harness.base}/api/knowledge/reindex?site=${site.id}`, { method: "POST", token: alice.token, body: {} });
    assert.ok(reindex.indexed > 0);
    assert.equal(reindex.documentCount, 1);

    const proposal = await json<{ id: string }>(`${harness.base}/api/documents/${page.id}/patch-proposals`, {
      method: "POST",
      token: alice.token,
      body: { summary: "Accept the deployment region", ops: [{ op: "update_attribute", id: "deployment-region", key: "status", value: "accepted" }] },
    });
    const inbox = await json<{ changes: Array<{ id: string; plan: string[]; sources: unknown[]; requestedCapabilities: string[]; affectedIds: string[]; applyStatus: string; validation: { canWrite: boolean } }> }>(`${harness.base}/api/agent-inbox?site=${site.id}`, { token: alice.token });
    const change = inbox.changes.find((item) => item.id === proposal.id);
    assert.ok(change);
    assert.ok(change.plan.length > 0);
    assert.ok(change.sources.length > 0);
    assert.ok(change.requestedCapabilities.includes("patch_block"));
    assert.deepEqual(change.affectedIds, ["deployment-region"]);
    assert.equal(change.applyStatus, "awaiting_review");
    assert.equal(change.validation.canWrite, true);

    const agent = await json<{ id: string; budgetUsd: number }>(`${harness.base}/api/agents`, {
      method: "POST",
      token: alice.token,
      body: { name: "Operations curator", modelPolicy: { model: "local-deterministic", zeroRetention: true, maxTokensPerRun: 4_000 }, capabilities: ["read_doc", "list_ids", "validate_doc", "patch_block"], budgetUsd: 2 },
    });
    await json(`${harness.base}/api/agents/${agent.id}/access`, {
      method: "POST",
      token: alice.token,
      body: { resourceType: "document", resourceId: page.id, role: "editor" },
    });
    await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: alice.token,
      body: { title: "Human-only notes", source: "# Human-only notes\n\nThe blue phoenix launch code is strictly human-only.\n" },
    });
    const ids = await json<{ versionHash: string; ids: Array<{ id: string }> }>(`${harness.base}/api/gateway/list-ids`, {
      method: "POST",
      token: alice.token,
      body: { agentId: agent.id, documentId: page.id },
    });
    assert.equal(ids.versionHash, page.hash);
    assert.ok(ids.ids.some((item) => item.id === "deployment-region"));
    const agentAsk = await json<{ citations: Array<{ accessDecision: { principalId: string; via: string } }> }>(`${harness.base}/api/ask`, {
      method: "POST",
      token: alice.token,
      body: { query: "Where do production services run?", agentId: agent.id },
    });
    assert.ok(agentAsk.citations.every((citation) => citation.accessDecision.principalId === agent.id && citation.accessDecision.via === "agent"));
    const scopedRefusal = await json<{ state: string; citations: unknown[] }>(`${harness.base}/api/ask`, {
      method: "POST",
      token: alice.token,
      body: { query: "What is the blue phoenix launch code?", agentId: agent.id },
    });
    assert.equal(scopedRefusal.state, "insufficient_evidence");
    assert.deepEqual(scopedRefusal.citations, []);
    const scopedLlm = await fetch(`${harness.base}/api/knowledge/llm?agent=${agent.id}`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(scopedLlm.status, 200);
    const scopedContext = await scopedLlm.text();
    assert.match(scopedContext, /Production services run in Zurich/);
    assert.doesNotMatch(scopedContext, /blue phoenix/);
    const run = await json<{ id: string; status: string }>(`${harness.base}/api/agents/${agent.id}/runs`, {
      method: "POST",
      token: alice.token,
      body: { trigger: "manual", documentId: page.id, requestedCapabilities: ["read_doc"] },
    });
    const completedRun = await json<{ status: string; costUsd: number }>(`${harness.base}/api/agents/${agent.id}/runs/${run.id}/complete`, {
      method: "POST",
      token: alice.token,
      body: { status: "completed", costUsd: 0.2, output: { proposalId: proposal.id } },
    });
    assert.equal(completedRun.status, "completed");
    assert.equal(completedRun.costUsd, 0.2);

    const connector = await json<{ id: string; kind: string }>(`${harness.base}/api/connectors`, {
      method: "POST",
      token: alice.token,
      body: { kind: "github", name: "Operations repository", siteId: site.id, configuration: { repository: "acme/ops" } },
    });
    const connectorSource = await json<{ upstreamPermissions: unknown[]; tombstonedAt: string; sourceUrl: string }>(`${harness.base}/api/connectors/${connector.id}/sources`, {
      method: "POST",
      token: alice.token,
      body: { externalId: "issue-42", documentId: page.id, upstreamPermissions: [{ principal: "team:ops", role: "read" }], upstreamModifiedAt: "2026-06-06T11:00:00.000Z", sourceUrl: "https://github.example/acme/ops/issues/42", contentHash: "deadbeef", lineage: ["github:issue-41"], tombstone: true },
    });
    assert.equal(connectorSource.upstreamPermissions.length, 1);
    assert.ok(connectorSource.tombstonedAt);
    assert.match(connectorSource.sourceUrl, /^https:/);

    const recipes = await json<{ recipes: Array<{ id: string; purpose: string }> }>(`${harness.base}/api/recipes`, { token: alice.token });
    assert.ok(recipes.recipes.some((item) => item.purpose === "meeting_to_decision"));
    const recipeRun = await json<{ mutationPolicy: string; plan: string[] }>(`${harness.base}/api/recipes/meeting-to-decision/runs`, {
      method: "POST",
      token: alice.token,
      body: { triggerMode: "webhook", input: { meetingId: "meeting-1" } },
    });
    assert.equal(recipeRun.mutationPolicy, "proof_proposal_only");
    assert.ok(recipeRun.plan.length > 0);
    const gateway = await json<{ protocol: string; transports: string[]; capabilities: Array<{ operation: string }> }>(`${harness.base}/api/gateway`, { token: alice.token });
    assert.equal(gateway.protocol, "noma-agent-gateway-v1");
    assert.ok(gateway.transports.includes("mcp"));
    assert.ok(gateway.capabilities.some((item) => item.operation === "apply"));
    const mcpTools = await json<{ jsonrpc: string; result: { tools: Array<{ name: string }> } }>(`${harness.base}/api/gateway/mcp`, {
      method: "POST",
      token: alice.token,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    assert.equal(mcpTools.jsonrpc, "2.0");
    assert.ok(mcpTools.result.tools.some((tool) => tool.name === "cited_answer"));
    const mcpSearch = await json<{ result: { structuredContent: { results: Array<{ documentId: string; accessDecision: { principalId: string } }> } } }>(`${harness.base}/api/gateway/mcp`, {
      method: "POST",
      token: alice.token,
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { agentId: agent.id, query: "production Zurich" } } },
    });
    assert.ok(mcpSearch.result.structuredContent.results.some((result) => result.documentId === page.id && result.accessDecision.principalId === agent.id));
    const mcpProof = await json<{ result: { structuredContent: { proposed: boolean; proof: { canWrite: boolean; agentId: string } } } }>(`${harness.base}/api/gateway/mcp`, {
      method: "POST",
      token: alice.token,
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "proof", arguments: { agentId: agent.id, documentId: page.id, ops: [{ op: "update_attribute", id: "deployment-region", key: "status", value: "accepted" }] } } },
    });
    assert.equal(mcpProof.result.structuredContent.proposed, false);
    assert.equal(mcpProof.result.structuredContent.proof.canWrite, true);
    assert.equal(mcpProof.result.structuredContent.proof.agentId, agent.id);
    const collections = await json<{ collections: Array<{ id: string; items: Array<{ blockId: string }> }> }>(`${harness.base}/api/collections?site=${site.id}`, { token: alice.token });
    assert.ok(collections.collections.find((item) => item.id === "open_decisions")?.items.some((item) => item.blockId === "deployment-region"));
    assert.ok(collections.collections.find((item) => item.id === "pending_agent_changes")?.items.length);

    await json(`${harness.base}/api/analytics`, { method: "POST", token: alice.token, body: { type: "citation_opened", documentId: page.id, query: "production region" } });
    const analytics = await json<{ counts: { citation_opened: number }; scope: { accessibleDocumentIds: string[] } }>(`${harness.base}/api/analytics`, { token: alice.token });
    assert.equal(analytics.counts.citation_opened, 1);
    assert.ok(analytics.scope.accessibleDocumentIds.includes(page.id));

    const backup = await json<NomaBackupBundleResponse>(`${harness.base}/api/backup/export`, {
      method: "POST",
      token: alice.token,
      body: { siteId: site.id, git: { repository: "acme/knowledge", branch: "noma-backup", pullRequestReview: true } },
    });
    assert.equal(backup.manifest.format, "noma-cloud-backup-v1");
    assert.equal(backup.files[0]?.source, source);
    assert.equal(backup.digest.length, 64);
    const importPlan = await json<{ applied: boolean; plan: { unchanged: string[]; pullRequestReview: boolean } }>(`${harness.base}/api/backup/import`, { method: "POST", token: alice.token, body: { siteId: site.id, bundle: backup } });
    assert.equal(importPlan.applied, false);
    assert.deepEqual(importPlan.plan.unchanged, [page.id]);
    assert.equal(importPlan.plan.pullRequestReview, true);

    const draft = await json<{ id: string }>(`${harness.base}/api/offline/drafts`, {
      method: "POST",
      token: alice.token,
      body: { documentId: page.id, baseHash: page.hash, baseSource: page.source, source: page.source.replace("status=\"open\"", "status=\"accepted\"") },
    });
    const mergedDraft = await json<{ state: string; expectedHash: string; conflicts: unknown[] }>(`${harness.base}/api/offline/drafts/${draft.id}/merge`, { method: "POST", token: alice.token, body: {} });
    assert.equal(mergedDraft.state, "clean");
    assert.equal(mergedDraft.expectedHash, page.hash);
    assert.deepEqual(mergedDraft.conflicts, []);

    const realtime = await json<{ operation: { sequence: number; proofStatus: string; affectedIds: string[] }; document: CloudDocumentResponse }>(`${harness.base}/api/realtime/documents/${page.id}/operations`, {
      method: "POST",
      token: alice.token,
      body: { expectedHash: page.hash, ops: [{ op: "update_attribute", id: "deployment-region", key: "status", value: "accepted" }] },
    });
    assert.equal(realtime.operation.sequence, 1);
    assert.equal(realtime.operation.proofStatus, "pass");
    assert.deepEqual(realtime.operation.affectedIds, ["deployment-region"]);
    assert.notEqual(realtime.document.hash, page.hash);
    const realtimeFeed = await json<{ operations: Array<{ sequence: number }>; currentHash: string }>(`${harness.base}/api/realtime/documents/${page.id}/operations?after=0`, { token: alice.token });
    assert.deepEqual(realtimeFeed.operations.map((item) => item.sequence), [1]);
    assert.equal(realtimeFeed.currentHash, realtime.document.hash);

    const enterprise = await json<{ sso: { provider: string; enforced: boolean }; scim: { enabled: boolean }; dataResidency: string; requireZeroRetentionModels: boolean }>(`${harness.base}/api/enterprise`, {
      method: "PUT",
      token: alice.token,
      body: {
        sso: { enabled: true, provider: "oidc", issuer: "https://id.example", enforced: true },
        scim: { enabled: true, baseUrl: "https://noma.example/scim/v2" },
        retentionDays: 365,
        legalHoldEnabled: true,
        dataResidency: "ch-zurich",
        connectorAllowlist: ["github", "filesystem"],
        modelAllowlist: ["secure-model"],
        requireZeroRetentionModels: true,
        auditExportEnabled: true,
      },
    });
    assert.equal(enterprise.sso.provider, "oidc");
    assert.equal(enterprise.sso.enforced, true);
    assert.equal(enterprise.scim.enabled, true);
    assert.equal(enterprise.dataResidency, "ch-zurich");
    assert.equal(enterprise.requireZeroRetentionModels, true);
    await json(`${harness.base}/api/connectors`, { method: "POST", token: alice.token, body: { kind: "slack", name: "Denied Slack", siteId: site.id, configuration: {} }, expectedStatus: 409 });
    const scim = await json<{ externalId: string; active: boolean }>(`${harness.base}/api/enterprise/scim`, { method: "POST", token: alice.token, body: { id: "scim-user-1", externalId: "00u1", userId: alice.id, userName: "Alice", active: true, groups: ["operations"] } });
    assert.equal(scim.externalId, "00u1");
    assert.equal(scim.active, true);
    const hold = await json<{ resourceId: string }>(`${harness.base}/api/enterprise/legal-holds`, { method: "POST", token: alice.token, body: { resourceType: "document", resourceId: page.id, reason: "Regulatory review" } });
    assert.equal(hold.resourceId, page.id);
    const audit = await json<{ format: string; dataResidency: string; digest: string; events: Array<{ action: string }> }>(`${harness.base}/api/enterprise/audit`, { token: alice.token });
    assert.equal(audit.format, "noma-cloud-audit-v1");
    assert.equal(audit.dataResidency, "ch-zurich");
    assert.equal(audit.digest.length, 64);
    assert.ok(audit.events.some((event) => event.action === "enterprise.policy_updated"));
    const retention = await json<{ deleted: number; protectedByLegalHold: number }>(`${harness.base}/api/enterprise/retention`, { method: "POST", token: alice.token, body: {} });
    assert.ok(retention.deleted >= 0);
    await json(`${harness.base}/api/auth/session`, { method: "POST", body: { userToken: alice.token }, expectedStatus: 403 });
    const ssoResponse = await fetch(`${harness.base}/api/auth/sso`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-noma-sso-trust-secret": "test-sso-secret" },
      body: JSON.stringify({ externalId: "00u1" }),
    });
    const ssoBody = await ssoResponse.text();
    assert.equal(ssoResponse.status, 200, ssoBody);
    const ssoSession = JSON.parse(ssoBody) as { provider: string; user: { id: string; token: string } };
    assert.equal(ssoSession.provider, "oidc");
    assert.equal(ssoSession.user.id, alice.id);
    assert.match(ssoSession.user.token, /^noma_/);
  } finally {
    await harness.close();
  }
});

test("cloud launch boundaries isolate connectors and recipes, validate agent runs, and reject tampered backups", async () => {
  const harness = await startCloudServer("noma-cloud-launch-boundaries-");
  try {
    const alice = await createCloudUser(harness.base, "Alice Launch Owner");
    const bob = await createCloudUser(harness.base, "Bob Launch Viewer");
    const mallory = await createCloudUser(harness.base, "Mallory Other Workspace");
    const page = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      token: alice.token,
      body: { title: "Launch runbook", source: "# Launch runbook\n\n::decision{id=\"launch\" status=\"open\"}\nStage before production.\n::\n" },
    });
    const site = await json<CloudSiteResponse>(`${harness.base}/api/sites`, {
      method: "POST",
      token: alice.token,
      body: { title: "Launch", documentIds: [page.id] },
    });
    await json(`${harness.base}/api/sites/${site.id}/collaborators`, {
      method: "POST",
      token: alice.token,
      body: { userId: bob.id, role: "viewer" },
    });

    const connector = await json<{ id: string; configurationKeys: string[]; configuration?: unknown }>(`${harness.base}/api/connectors`, {
      method: "POST",
      token: alice.token,
      body: { kind: "github", name: "Launch repository", siteId: site.id, configuration: { repository: "acme/launch", token: "do-not-return" } },
    });
    assert.deepEqual(connector.configurationKeys, ["repository", "token"]);
    assert.equal(Object.hasOwn(connector, "configuration"), false);
    const bobConnectors = await json<{ connectors: Array<{ id: string; configuration?: unknown }> }>(`${harness.base}/api/connectors`, { token: bob.token });
    assert.ok(bobConnectors.connectors.some((item) => item.id === connector.id));
    assert.ok(bobConnectors.connectors.every((item) => !Object.hasOwn(item, "configuration")));
    await json(`${harness.base}/api/connectors/${connector.id}/sources`, {
      method: "POST",
      token: bob.token,
      body: { externalId: "issue-1", documentId: page.id, upstreamPermissions: [], upstreamModifiedAt: "2026-07-14T00:00:00.000Z", sourceUrl: "https://example.com/issue-1", contentHash: "one" },
      expectedStatus: 403,
    });

    const readAgent = await json<{ id: string }>(`${harness.base}/api/agents`, {
      method: "POST",
      token: alice.token,
      body: { name: "Read agent", capabilities: ["read_doc"], budgetUsd: 1 },
    });
    await json(`${harness.base}/api/agents/${readAgent.id}/runs`, {
      method: "POST",
      token: alice.token,
      body: { requestedCapabilities: ["patch_block"] },
      expectedStatus: 409,
    });
    const otherAgent = await json<{ id: string }>(`${harness.base}/api/agents`, {
      method: "POST",
      token: alice.token,
      body: { name: "Other agent", capabilities: ["read_doc"], budgetUsd: 1 },
    });
    const otherRun = await json<{ id: string }>(`${harness.base}/api/agents/${otherAgent.id}/runs`, {
      method: "POST",
      token: alice.token,
      body: { requestedCapabilities: ["read_doc"] },
    });
    await json(`${harness.base}/api/agents/${readAgent.id}/runs/${otherRun.id}/complete`, {
      method: "POST",
      token: alice.token,
      body: { status: "completed", costUsd: 0 },
      expectedStatus: 404,
    });

    const webhookSecret = "launch-hook-secret";
    const recipe = await json<{ id: string; trigger: { webhookSecretConfigured: boolean; webhookSecretHash?: string } }>(`${harness.base}/api/recipes`, {
      method: "POST",
      token: alice.token,
      body: {
        name: "Launch review",
        siteId: site.id,
        trigger: { modes: ["webhook"], webhookSecretHash: sha256Hex(webhookSecret) },
        capabilitySet: ["read_doc"],
        steps: ["Review launch evidence", "Draft a proposal"],
      },
    });
    assert.equal(recipe.trigger.webhookSecretConfigured, true);
    assert.equal(Object.hasOwn(recipe.trigger, "webhookSecretHash"), false);
    const bobRecipes = await json<{ recipes: Array<{ id: string }> }>(`${harness.base}/api/recipes`, { token: bob.token });
    assert.ok(bobRecipes.recipes.some((item) => item.id === recipe.id));
    const malloryRecipes = await json<{ recipes: Array<{ id: string }> }>(`${harness.base}/api/recipes`, { token: mallory.token });
    assert.ok(!malloryRecipes.recipes.some((item) => item.id === recipe.id));
    await json(`${harness.base}/api/recipes/${recipe.id}/runs`, {
      method: "POST",
      token: bob.token,
      body: { triggerMode: "webhook", input: {} },
      expectedStatus: 403,
    });
    await json(`${harness.base}/api/gateway/webhooks/${recipe.id}`, {
      method: "POST",
      token: alice.token,
      headers: { "x-noma-recipe-webhook-secret": "wrong" },
      body: { release: "candidate" },
      expectedStatus: 401,
    });
    const webhookRun = await json<{ mutationPolicy: string }>(`${harness.base}/api/gateway/webhooks/${recipe.id}`, {
      method: "POST",
      token: alice.token,
      headers: { "x-noma-recipe-webhook-secret": webhookSecret },
      body: { release: "candidate" },
    });
    assert.equal(webhookRun.mutationPolicy, "proof_proposal_only");

    const backup = await json<NomaBackupBundleResponse>(`${harness.base}/api/backup/export`, {
      method: "POST",
      token: alice.token,
      body: { siteId: site.id },
    });
    const tampered = structuredClone(backup);
    tampered.files[0]!.source += "\nTampered after export.\n";
    await json(`${harness.base}/api/backup/import`, {
      method: "POST",
      token: alice.token,
      body: { siteId: site.id, bundle: tampered },
      expectedStatus: 400,
    });
  } finally {
    await harness.close();
  }
});

test("cloud database compare-and-swap rejects a second writer with a stale hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-cas-"));
  const store = openNomaCloudDatabase({
    dataDir: join(root, "documents"),
    usersDir: join(root, "users"),
    sitesDir: join(root, "sites"),
    dbPath: join(root, "noma-cloud.sqlite"),
  });
  try {
    const now = "2026-07-14T00:00:00.000Z";
    const source = "# Concurrent document\n\nBase.\n";
    const base: CloudDocumentRecord = {
      version: 2,
      id: "document_launch_cas",
      title: "Concurrent document",
      source,
      hash: sha256Hex(source),
      createdAt: now,
      updatedAt: now,
      createdBy: "user_launch_owner",
      updatedBy: "user_launch_owner",
      permissions: { user_launch_owner: { role: "owner", addedAt: now } },
      shareLinks: [],
    };
    assert.equal(store.writeDocument(base), true);
    const firstSource = source.replace("Base.", "First writer.");
    const secondSource = source.replace("Base.", "Second writer.");
    const first = { ...base, source: firstSource, hash: sha256Hex(firstSource), updatedAt: "2026-07-14T00:01:00.000Z" };
    const second = { ...base, source: secondSource, hash: sha256Hex(secondSource), updatedAt: "2026-07-14T00:02:00.000Z" };
    assert.equal(store.writeDocument(first, base.hash), true);
    assert.equal(store.writeDocument(second, base.hash), false);
    assert.equal(store.readDocument(base.id)?.hash, first.hash);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface NomaBackupBundleResponse {
  manifest: { format: string; exportedAt: string; files: unknown[]; git?: { pullRequestReview: boolean } };
  files: Array<{ documentId: string; source: string; hash: string }>;
  digest: string;
}

interface CloudTestHarness {
  base: string;
  close(): Promise<void>;
}

async function startCloudServer(
  prefix: string,
  options: Pick<NomaCloudServerOptions, "rateLimitWindowMs" | "rateLimitMaxRequests" | "authRateLimitMaxRequests"> = {},
): Promise<CloudTestHarness> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    maxBodyBytes: 100_000,
    ssoTrustedHeaderSecret: "test-sso-secret",
    now: () => new Date("2026-06-06T12:00:00.000Z"),
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createCloudUser(base: string, name: string): Promise<CloudUserResponse> {
  return json<CloudUserResponse>(`${base}/api/users`, { method: "POST", body: { name } });
}

async function json<T = { error?: string }>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.share) headers.set("x-noma-share-token", options.share);
  if (options.cloudAccess) headers.set("x-noma-cloud-access-token", options.cloudAccess);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (options.expectedStatus !== undefined) {
    assert.equal(response.status, options.expectedStatus, await response.text());
    return {} as T;
  }
  if (!response.ok) {
    assert.fail(`${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function fetchExpect(url: string, status: number): Promise<void> {
  const response = await fetch(url);
  assert.equal(response.status, status, await response.text());
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
