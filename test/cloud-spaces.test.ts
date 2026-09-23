import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openNomaCloudDatabase } from "../src/cloud-db.js";
import { type CloudDocumentResponse, createCloudUser, json, request, savePage, startCloudServer } from "./cloud-wiki-harness.js";

interface SpaceResponse {
  id: string;
  title: string;
  key: string | null;
  description: string;
  icon: string;
  homeDocumentId: string | null;
  archived: boolean;
  archivedAt: string | null;
  documentIds: string[];
}

test("spaces carry unique keys, description, icon, home page, and archive to read-only", async () => {
  const harness = await startCloudServer("noma-spaces-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const eve = await createCloudUser(base, "Eve Outsider");

    const handbook = await json<SpaceResponse>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Engineering Handbook", documentIds: [] } });
    assert.equal(handbook.key, "EH");
    const second = await json<SpaceResponse>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Engineering Handbook", documentIds: [] } });
    assert.equal(second.key, "EH2");
    const eng = await json<SpaceResponse>(`${base}/api/sites`, {
      method: "POST",
      token: ada.token,
      body: { title: "Engineering", key: "eng", description: "How we build", icon: "🛠️", documentIds: [] },
    });
    assert.deepEqual([eng.key, eng.description, eng.icon, eng.archived], ["ENG", "How we build", "🛠️", false]);
    await json(`${base}/api/sites`, { method: "POST", token: bob.token, body: { title: "Other", key: "ENG", documentIds: [] }, expectedStatus: 409 });
    await json(`${base}/api/sites`, { method: "POST", token: bob.token, body: { title: "Other", key: "1A", documentIds: [] }, expectedStatus: 400 });
    await json(`${base}/api/sites`, { method: "POST", token: bob.token, body: { title: "Other", key: "TOOLONGKEY1", documentIds: [] }, expectedStatus: 400 });
    await json(`${base}/api/sites`, { method: "POST", token: bob.token, body: { title: "Other", icon: "<b>", documentIds: [] }, expectedStatus: 400 });

    await json(`${base}/api/sites/${eng.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    const home = await json<CloudDocumentResponse>(`${base}/api/sites/${eng.id}/documents`, { method: "POST", token: ada.token, body: { source: "# Welcome\n\nStart here.\n" } });
    const guide = await json<CloudDocumentResponse>(`${base}/api/sites/${eng.id}/documents`, { method: "POST", token: ada.token, body: { source: "# Deploy Guide\n\nShip it carefully.\n" } });
    const outside = await json<CloudDocumentResponse>(`${base}/api/documents`, { method: "POST", token: ada.token, body: { source: "# Loose\n\nNot in a space.\n" } });

    await json(`${base}/api/sites/${eng.id}`, { method: "PUT", token: bob.token, body: { homeDocumentId: outside.id }, expectedStatus: 400 });
    const configured = await json<SpaceResponse>(`${base}/api/sites/${eng.id}`, { method: "PUT", token: bob.token, body: { homeDocumentId: guide.id, description: "Build and ship" } });
    assert.equal(configured.homeDocumentId, guide.id);
    assert.equal(configured.description, "Build and ship");
    await json(`${base}/api/sites/${eng.id}`, { method: "PUT", token: bob.token, body: { key: "BUILD" }, expectedStatus: 403 });
    await json(`${base}/api/sites/${eng.id}`, { method: "PUT", token: ada.token, body: { key: "EH" }, expectedStatus: 409 });
    const rekeyed = await json<SpaceResponse>(`${base}/api/sites/${eng.id}`, { method: "PUT", token: ada.token, body: { key: "build" } });
    assert.equal(rekeyed.key, "BUILD");
    const cleared = await json<SpaceResponse>(`${base}/api/sites/${eng.id}`, { method: "PUT", token: ada.token, body: { icon: null } });
    assert.equal(cleared.icon, "");

    const published = await request<string>(`${base}/s/${eng.id}`, { token: ada.token });
    assert.equal(published.status, 200);
    const firstArticle = /<article class="site-doc" id="([^"]+)"( data-home="true")?/.exec(published.body);
    assert.equal(firstArticle?.[1], guide.id, "the home page renders first at the space root");
    assert.equal(firstArticle?.[2], ' data-home="true"');
    assert.match(published.body, /Build and ship/);
    assert.match(published.body, /BUILD/);

    await json(`${base}/api/sites/${eng.id}/archive`, { method: "POST", token: bob.token, expectedStatus: 403 });
    const archived = await json<SpaceResponse>(`${base}/api/sites/${eng.id}/archive`, { method: "POST", token: ada.token });
    assert.equal(archived.archived, true);
    await json(`${base}/api/sites/${eng.id}/archive`, { method: "POST", token: ada.token, expectedStatus: 409 });

    const listed = async (params = "") => (await json<{ sites: SpaceResponse[] }>(`${base}/api/sites${params}`, { token: ada.token })).sites.map((site) => site.key).sort();
    assert.deepEqual(await listed(), ["EH", "EH2"]);
    assert.deepEqual(await listed("?archived=include"), ["BUILD", "EH", "EH2"]);
    assert.deepEqual(await listed("?archived=only"), ["BUILD"]);
    await json(`${base}/api/sites?archived=maybe`, { token: ada.token, expectedStatus: 400 });

    const archivedWrite = async (url: string, method: string, body?: Record<string, unknown>) => {
      const response = await request<{ code?: string }>(url, { method, token: ada.token, ...(body ? { body } : {}) });
      assert.equal(response.status, 409, `${method} ${url}`);
      assert.equal(response.body.code, "space_archived");
    };
    await archivedWrite(`${base}/api/documents/${guide.id}`, "PUT", { source: "# Deploy Guide\n\nChanged.\n", expectedHash: guide.hash });
    await archivedWrite(`${base}/api/sites/${eng.id}/documents/${guide.id}`, "PUT", { source: "# Deploy Guide\n\nChanged.\n", expectedHash: guide.hash });
    await archivedWrite(`${base}/api/sites/${eng.id}/documents`, "POST", { source: "# New\n\nPage.\n" });
    await archivedWrite(`${base}/api/sites/${eng.id}`, "PUT", { title: "Renamed" });
    await archivedWrite(`${base}/api/documents/${guide.id}/comments`, "POST", { body: "hello" });
    await archivedWrite(`${base}/api/documents/${guide.id}/labels`, "POST", { label: "how-to" });
    await archivedWrite(`${base}/api/trash/document/${guide.id}`, "POST");
    await json(`${base}/api/documents/${guide.id}`, { method: "PUT", token: eve.token, body: { source: "# x\n", expectedHash: guide.hash }, expectedStatus: 403 });
    await json(`${base}/api/documents/${guide.id}`, { token: bob.token });
    await json(`${base}/api/documents/${guide.id}/comments`, { token: bob.token });
    await json(`${base}/api/sites/${eng.id}/watch`, { method: "PUT", token: bob.token });

    const search = async (q: string) => (await json<{ results: Array<{ documentId: string }> }>(`${base}/api/search?q=${encodeURIComponent(q)}`, { token: ada.token })).results.map((result) => result.documentId).filter((id, index, all) => all.indexOf(id) === index);
    assert.deepEqual(await search("deploy"), []);
    assert.deepEqual(await search("deploy archived:include"), [guide.id]);
    assert.deepEqual(await search("deploy space:BUILD"), [guide.id]);
    const knowledge = await json<{ results: Array<{ documentId: string }> }>(`${base}/api/knowledge/search?q=deploy`, { token: ada.token });
    assert.ok(!knowledge.results.some((result) => result.documentId === guide.id), "archived pages are hidden from knowledge search by default");

    await json(`${base}/api/sites/${eng.id}/unarchive`, { method: "POST", token: bob.token, expectedStatus: 403 });
    const restored = await json<SpaceResponse>(`${base}/api/sites/${eng.id}/unarchive`, { method: "POST", token: ada.token });
    assert.equal(restored.archived, false);
    const saved = await savePage(base, bob.token, guide, "# Deploy Guide\n\nShip it carefully, again.\n");
    assert.match(saved.source, /again/);
    assert.deepEqual(await search("deploy"), [guide.id]);
    assert.ok(home.id);
  } finally {
    await harness.close();
  }
});

test("older databases gain the space and comment columns on open", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-spaces-migrate-"));
  const options = { dbPath: join(root, "db.sqlite"), dataDir: join(root, "documents"), usersDir: join(root, "users"), sitesDir: join(root, "sites") };
  try {
    openNomaCloudDatabase(options).close();
    const raw = new Database(options.dbPath);
    raw.exec("DROP INDEX idx_sites_space_key; DROP INDEX idx_sites_archived; ALTER TABLE sites DROP COLUMN space_key; ALTER TABLE sites DROP COLUMN archived_at; ALTER TABLE comments DROP COLUMN anchor_json; ALTER TABLE comments DROP COLUMN edited_at;");
    raw.close();
    const store = openNomaCloudDatabase(options);
    store.close();
    const check = new Database(options.dbPath);
    const siteColumns = (check.prepare("PRAGMA table_info(sites)").all() as Array<{ name: string }>).map((column) => column.name);
    const commentColumns = (check.prepare("PRAGMA table_info(comments)").all() as Array<{ name: string }>).map((column) => column.name);
    check.close();
    assert.ok(siteColumns.includes("space_key") && siteColumns.includes("archived_at"));
    assert.ok(commentColumns.includes("anchor_json") && commentColumns.includes("edited_at"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
