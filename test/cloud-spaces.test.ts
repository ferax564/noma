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

interface AnalyticsResponse {
  totalViews: number;
  uniqueViewers: number;
  anonymousViews: number;
  viewsByDay: Array<{ date: string; views: number; uniqueViewers: number }>;
  viewers?: Array<{ userId: string; name: string; views: number }>;
  viewersVisible: boolean;
}

test("page views are deduplicated per viewer, anonymous for share links, and roll up into popular pages", async () => {
  const harness = await startCloudServer("noma-analytics-");
  const { base, clock } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const carl = await createCloudUser(base, "Carl Sagan");
    const eve = await createCloudUser(base, "Eve Outsider");
    const space = await json<SpaceResponse>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Docs", documentIds: [] } });
    await json(`${base}/api/sites/${space.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    await json(`${base}/api/sites/${space.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: carl.id, role: "viewer" } });
    const guide = await json<CloudDocumentResponse>(`${base}/api/sites/${space.id}/documents`, { method: "POST", token: ada.token, body: { source: "# Guide\n\nRead me.\n" } });
    const faq = await json<CloudDocumentResponse>(`${base}/api/sites/${space.id}/documents`, { method: "POST", token: ada.token, body: { source: "# FAQ\n\nQuestions.\n" } });
    const share = await json<{ token: string }>(`${base}/api/documents/${guide.id}/shares`, { method: "POST", token: ada.token, body: { role: "viewer" } });

    const view = async (token: string | undefined, id = guide.id, shareToken?: string) =>
      json<{ recorded: boolean; views: number }>(`${base}/api/documents/${id}/views`, { method: "POST", ...(token ? { token } : {}), ...(shareToken ? { share: shareToken } : {}) });
    assert.equal((await view(bob.token)).recorded, true);
    assert.equal((await view(bob.token)).recorded, false, "a second view within 30 minutes is not counted");
    clock.advance(31 * 60 * 1000);
    assert.equal((await view(bob.token)).recorded, true);
    assert.equal((await json<{ recorded: boolean }>(`${base}/api/sites/${space.id}/documents/${guide.id}/views`, { method: "POST", token: carl.token })).recorded, true);
    assert.equal((await view(undefined, guide.id, share.token)).recorded, true);
    assert.equal((await view(undefined, guide.id, share.token)).recorded, false);
    await json(`${base}/api/documents/${guide.id}/views`, { method: "POST", token: eve.token, expectedStatus: 403 });
    clock.advance(2 * 24 * 60 * 60 * 1000);
    const rendered = await request<string>(`${base}/d/${guide.id}`, { token: ada.token });
    assert.equal(rendered.status, 200);
    await view(bob.token, faq.id);

    const viewerStats = await json<AnalyticsResponse>(`${base}/api/documents/${guide.id}/analytics`, { token: carl.token });
    assert.equal(viewerStats.totalViews, 5);
    assert.equal(viewerStats.uniqueViewers, 3);
    assert.equal(viewerStats.anonymousViews, 1);
    assert.equal(viewerStats.viewers, undefined, "viewers are hidden from page viewers");
    assert.equal(viewerStats.viewersVisible, false);
    assert.deepEqual(viewerStats.viewsByDay.map((day) => [day.date, day.views]), [["2026-06-06", 4], ["2026-06-08", 1]]);
    const shareStats = await json<AnalyticsResponse>(`${base}/api/documents/${guide.id}/analytics`, { share: share.token });
    assert.equal(shareStats.viewers, undefined);

    const ownerStats = await json<AnalyticsResponse>(`${base}/api/documents/${guide.id}/analytics`, { token: ada.token });
    assert.deepEqual(ownerStats.viewers?.map((viewer) => [viewer.name, viewer.views]).sort(), [["Ada Lovelace", 1], ["Bob Builder", 2], ["Carl Sagan", 1]]);
    const editorStats = await json<AnalyticsResponse>(`${base}/api/sites/${space.id}/documents/${guide.id}/analytics?days=1`, { token: bob.token });
    assert.equal(editorStats.totalViews, 1, "days narrows the window");
    assert.equal(editorStats.viewersVisible, true);
    await json(`${base}/api/documents/${guide.id}/analytics?days=0`, { token: ada.token, expectedStatus: 400 });
    await json(`${base}/api/documents/${guide.id}/analytics`, { token: eve.token, expectedStatus: 403 });

    const popular = await json<{ pages: Array<{ documentId: string; views: number }> }>(`${base}/api/sites/${space.id}/popular`, { token: carl.token });
    assert.deepEqual(popular.pages.map((page) => [page.documentId, page.views]), [[guide.id, 5], [faq.id, 1]]);
    await json(`${base}/api/sites/${space.id}/popular`, { token: eve.token, expectedStatus: 403 });
    await json(`${base}/api/trash/document/${faq.id}`, { method: "POST", token: ada.token });
    const afterTrash = await json<{ pages: Array<{ documentId: string }> }>(`${base}/api/sites/${space.id}/popular`, { token: carl.token });
    assert.deepEqual(afterTrash.pages.map((page) => page.documentId), [guide.id]);
  } finally {
    await harness.close();
  }
});

interface TreeNode {
  id: string;
  title: string;
  children: TreeNode[];
}

test("page moves honour sibling positions, including appending past the end", async () => {
  const harness = await startCloudServer("noma-tree-order-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const space = await json<SpaceResponse>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Tree", documentIds: [] } });
    const pages: Record<string, string> = {};
    for (const title of ["A", "B", "C", "D"]) {
      pages[title] = (await json<CloudDocumentResponse>(`${base}/api/sites/${space.id}/documents`, { method: "POST", token: ada.token, body: { source: `# ${title}\n\nPage ${title}.\n` } })).id;
    }
    const move = (title: string, parent: string | null, position: number) =>
      json(`${base}/api/sites/${space.id}/documents/${pages[title]}/parent`, { method: "PUT", token: ada.token, body: { parentId: parent ? pages[parent] : null, position } });
    const shape = async () => {
      const tree = await json<{ pages: TreeNode[] }>(`${base}/api/sites/${space.id}/tree`, { token: ada.token });
      const render = (nodes: TreeNode[]): string => nodes.map((node) => (node.children.length ? `${node.title}(${render(node.children)})` : node.title)).join(",");
      return render(tree.pages);
    };
    await move("A", null, 99);
    assert.equal(await shape(), "B,C,D,A");
    await move("D", null, 0);
    assert.equal(await shape(), "D,B,C,A");
    await move("C", "B", 0);
    assert.equal(await shape(), "D,B(C),A");
    await move("A", "B", 0);
    assert.equal(await shape(), "D,B(A,C)");
    await move("C", "B", 0);
    assert.equal(await shape(), "D,B(C,A)");
    await move("A", null, 2);
    assert.equal(await shape(), "D,B(C),A");
    await move("D", "C", 5);
    assert.equal(await shape(), "B(C(D)),A");
    await move("B", null, 1);
    assert.equal(await shape(), "A,B(C(D))");
    await json(`${base}/api/sites/${space.id}/documents/${pages.B}/parent`, { method: "PUT", token: ada.token, body: { parentId: pages.D, position: 0 }, expectedStatus: 400 });
    await json(`${base}/api/sites/${space.id}/documents/${pages.B}/parent`, { method: "PUT", token: ada.token, body: { parentId: null, position: -1 }, expectedStatus: 400 });
  } finally {
    await harness.close();
  }
});
