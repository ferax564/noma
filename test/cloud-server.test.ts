import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNomaCloudServer } from "../src/cloud-server.js";

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

    await json(`${base}/api/documents/${created.id}`, {
      token: charlie.token,
      expectedStatus: 403,
    });

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
    assert.deepEqual(aliceDocs.documents.map((item) => item.id), [created.id]);
    assert.deepEqual(bobDocs.documents.map((item) => item.id), [created.id]);

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

async function json<T = { error?: string }>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
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
