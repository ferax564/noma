import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  access: { role: string; via: string };
}

interface SiteResponse {
  id: string;
  documentIds: string[];
  pageParents: Record<string, string>;
  pageFolders: Record<string, string>;
}

interface TreeNode {
  id: string;
  title: string;
  restrictions?: { view: boolean; edit: boolean; inheritedView: boolean };
  children: TreeNode[];
}

interface RestrictionsResponse {
  documentId: string;
  view: { users: Array<{ id: string; name: string }>; groups: Array<{ id: string; name: string }> };
  edit: { users: Array<{ id: string; name: string }>; groups: Array<{ id: string; name: string }> };
  inherited: Array<{ documentId: string; title?: string }>;
  restricted: { view: boolean; edit: boolean };
  canManage: boolean;
}

interface JsonRequestOptions {
  method?: string;
  token?: string;
  share?: string;
  body?: Record<string, unknown>;
  expectedStatus?: number;
}

interface Harness {
  base: string;
  close: () => Promise<void>;
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("view restrictions hide a page and its descendants from every read channel", async () => {
  const harness = await startCloudServer("noma-restrictions-view-");
  const { base } = harness;
  try {
    const admin = await createCloudUser(base, "Admin");
    const alice = await createCloudUser(base, "Alice");
    const bob = await createCloudUser(base, "Bob");
    const carol = await createCloudUser(base, "Carol");
    const erin = await createCloudUser(base, "Erin");
    const dave = await createCloudUser(base, "Dave");

    const site = await json<SiteResponse>(`${base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Operations", documentIds: [] } });
    for (const [user, role] of [[bob, "editor"], [carol, "viewer"], [erin, "viewer"], [admin, "viewer"]] as const) {
      await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: alice.token, body: { userId: user.id, role } });
    }
    const group = await json<{ id: string }>(`${base}/api/groups`, { method: "POST", token: erin.token, body: { name: "Payroll Team" } });

    const payroll = await createSitePage(base, site.id, bob.token, "Payroll", "The flamingo salary ledger lives here.");
    const child = await createSitePage(base, site.id, alice.token, "Payroll Child", "The pelican bonus table.", payroll.id);
    const open = await createSitePage(base, site.id, alice.token, "Open Page", "The heron roadmap is public.");
    const attachment = await uploadAttachment(base, payroll.id, bob.token);

    await json(`${base}/api/sites/${site.id}/watch`, { method: "PUT", token: alice.token });
    await json(`${base}/api/documents/${payroll.id}/watch`, { method: "PUT", token: carol.token });
    await json(`${base}/api/documents/${payroll.id}/labels`, { method: "POST", token: bob.token, body: { label: "secret-label" } });
    await json(`${base}/api/navigation/favorites`, { method: "PUT", token: alice.token, body: { resourceType: "document", resourceId: payroll.id } });
    await json(`${base}/api/navigation/recent`, { method: "POST", token: alice.token, body: { resourceType: "document", resourceId: payroll.id } });
    const docShare = await json<{ token: string }>(`${base}/api/documents/${payroll.id}/shares`, { method: "POST", token: bob.token, body: { role: "viewer" } });
    const siteShare = await json<{ token: string }>(`${base}/api/sites/${site.id}/shares`, { method: "POST", token: alice.token, body: { role: "viewer" } });
    const agent = await json<{ id: string }>(`${base}/api/agents`, {
      method: "POST",
      token: alice.token,
      body: { name: "Space reader", capabilities: ["read_doc", "list_ids"] },
    });
    await json(`${base}/api/agents/${agent.id}/access`, { method: "POST", token: alice.token, body: { resourceType: "site", resourceId: site.id, role: "viewer" } });
    const aliceSignedUrl = (await json<{ attachments: Array<{ url: string }> }>(`${base}/api/documents/${payroll.id}/attachments`, { token: alice.token })).attachments[0]!.url;
    await editPage(base, payroll.id, bob.token, "The flamingo salary ledger lives here. Updated before the lock.");
    assert.ok((await notifications(base, alice.token)).some((item) => item.resourceId === payroll.id), "alice watched the space before the lock");

    const restricted = await json<RestrictionsResponse>(`${base}/api/documents/${payroll.id}/restrictions`, {
      method: "PUT",
      token: alice.token,
      body: { view: { users: [carol.id], groups: [group.id] } },
    });
    assert.deepEqual(restricted.view.users, [{ id: carol.id, name: "Carol" }]);
    assert.deepEqual(restricted.view.groups, [{ id: group.id, name: "Payroll Team" }]);
    assert.equal(restricted.canManage, true);
    assert.deepEqual(restricted.restricted, { view: true, edit: false });

    const hiddenIds = [payroll.id, child.id];
    const canSee = async (token: string, id: string) => (await fetch(`${base}/api/documents/${id}`, { headers: { authorization: `Bearer ${token}` } })).status === 200;
    for (const user of [carol, erin, bob, admin]) {
      assert.equal(await canSee(user.token, payroll.id), true, `${user.name} is listed, owns the page, or is an admin`);
      assert.equal(await canSee(user.token, child.id), true, `${user.name} passes the inherited restriction`);
    }
    for (const id of hiddenIds) {
      await json(`${base}/api/documents/${id}`, { token: alice.token, expectedStatus: 403 });
      await json(`${base}/api/sites/${site.id}/documents/${id}`, { token: alice.token, expectedStatus: 404 });
      await json(`${base}/api/sites/${site.id}/documents/${id}/revisions`, { token: alice.token, expectedStatus: 404 });
      await json(`${base}/api/sites/${site.id}/documents/${id}/comments`, { token: alice.token, expectedStatus: 404 });
      await json(`${base}/api/documents/${id}/html`, { token: alice.token, expectedStatus: 403 });
      assert.equal((await fetch(`${base}/d/${id}`, { headers: { authorization: `Bearer ${alice.token}` } })).status, 403);
      await json(`${base}/api/documents/${id}/attachments`, { token: alice.token, expectedStatus: 403 });
    }
    await json(`${base}/api/sites/${site.id}/documents/${child.id}/breadcrumbs`, { token: alice.token, expectedStatus: 404 });
    assert.equal(await canSee(alice.token, open.id), true);

    const aliceDocs = await json<{ documents: Array<{ id: string }> }>(`${base}/api/documents`, { token: alice.token });
    assert.deepEqual(aliceDocs.documents.map((doc) => doc.id).filter((id) => hiddenIds.includes(id)), []);
    assert.ok(aliceDocs.documents.some((doc) => doc.id === open.id));

    for (const word of ["flamingo", "pelican"]) {
      const hits = await json<{ results: Array<{ documentId: string }> }>(`${base}/api/search?q=${word}`, { token: alice.token });
      assert.equal(hits.results.length, 0, `search leaks ${word}`);
    }
    const carolHits = await json<{ results: Array<{ documentId: string }> }>(`${base}/api/search?q=flamingo`, { token: carol.token });
    assert.ok(carolHits.results.some((hit) => hit.documentId === payroll.id));
    assert.equal((await json<{ results: unknown[] }>(`${base}/api/search?q=payroll-chart`, { token: alice.token })).results.length, 0, "attachment names stay hidden");

    const siteView = await json<SiteResponse & { documents: Array<{ id: string }> }>(`${base}/api/sites/${site.id}?include=documents`, { token: alice.token });
    assert.deepEqual(siteView.documentIds, [open.id]);
    assert.deepEqual(siteView.pageParents, {});
    assert.deepEqual(siteView.documents.map((doc) => doc.id), [open.id]);
    const siteDocs = await json<{ documents: Array<{ id: string }> }>(`${base}/api/sites/${site.id}/documents`, { token: alice.token });
    assert.deepEqual(siteDocs.documents.map((doc) => doc.id), [open.id]);
    const siteList = await json<{ sites: SiteResponse[] }>(`${base}/api/sites`, { token: alice.token });
    assert.deepEqual(siteList.sites.find((item) => item.id === site.id)?.documentIds, [open.id]);
    const tree = await json<{ pages: TreeNode[] }>(`${base}/api/sites/${site.id}/tree`, { token: alice.token });
    assert.deepEqual(flatten(tree.pages).map((node) => node.id), [open.id]);
    const wiki = await json<{ pages: Array<{ id: string }>; links: unknown[] }>(`${base}/api/sites/${site.id}/wiki`, { token: alice.token });
    assert.deepEqual(wiki.pages.map((page) => page.id), [open.id]);

    const carolTree = await json<{ pages: TreeNode[] }>(`${base}/api/sites/${site.id}/tree`, { token: carol.token });
    const carolNodes = flatten(carolTree.pages);
    assert.deepEqual(carolNodes.find((node) => node.id === payroll.id)?.restrictions, { view: true, edit: false, inheritedView: false });
    assert.deepEqual(carolNodes.find((node) => node.id === child.id)?.restrictions, { view: false, edit: false, inheritedView: true });
    const breadcrumbs = await json<{ breadcrumbs: Array<{ id: string }> }>(`${base}/api/sites/${site.id}/documents/${child.id}/breadcrumbs`, { token: carol.token });
    assert.deepEqual(breadcrumbs.breadcrumbs.map((crumb) => crumb.id), [site.id, payroll.id, child.id]);

    const published = await (await fetch(`${base}/s/${site.id}`, { headers: { authorization: `Bearer ${alice.token}` } })).text();
    assert.doesNotMatch(published, /flamingo|pelican|Payroll/);
    assert.match(published, /heron/);
    const sharedSite = await (await fetch(`${base}/s/${site.id}?share=${siteShare.token}`)).text();
    assert.doesNotMatch(sharedSite, /flamingo|pelican|Payroll/);
    assert.match(sharedSite, /heron/);
    assert.match(await (await fetch(`${base}/s/${site.id}`, { headers: { authorization: `Bearer ${carol.token}` } })).text(), /flamingo/);
    await json(`${base}/api/sites/${site.id}/documents/${payroll.id}`, { share: siteShare.token, expectedStatus: 404 });
    assert.deepEqual((await json<SiteResponse>(`${base}/api/sites/${site.id}`, { share: siteShare.token })).documentIds, [open.id]);
    await json(`${base}/api/documents/${payroll.id}`, { share: docShare.token, expectedStatus: 403 });
    assert.equal((await fetch(`${base}/d/${payroll.id}?share=${docShare.token}`)).status, 403, "a page share link cannot bypass restrictions");

    const labels = await json<{ labels: Array<{ label: string }> }>(`${base}/api/labels`, { token: alice.token });
    assert.equal(labels.labels.some((item) => item.label === "secret-label"), false);
    assert.deepEqual((await json<{ documents: unknown[] }>(`${base}/api/labels/secret-label`, { token: alice.token })).documents, []);
    assert.equal((await json<{ documents: unknown[] }>(`${base}/api/labels/secret-label`, { token: carol.token })).documents.length, 1);

    const knowledge = await json<{ results: Array<{ documentId: string }> }>(`${base}/api/knowledge/search?q=flamingo`, { token: alice.token });
    assert.equal(knowledge.results.some((hit) => hiddenIds.includes(hit.documentId)), false);
    const ask = await json<{ citations: Array<{ documentId: string }> }>(`${base}/api/ask`, { method: "POST", token: alice.token, body: { query: "flamingo salary ledger" } });
    assert.equal(ask.citations.some((citation) => hiddenIds.includes(citation.documentId)), false);
    const llm = await (await fetch(`${base}/api/knowledge/llm`, { headers: { authorization: `Bearer ${alice.token}` } })).text();
    assert.doesNotMatch(llm, /flamingo|pelican/);
    const agentLlm = await (await fetch(`${base}/api/knowledge/llm?agent=${agent.id}`, { headers: { authorization: `Bearer ${alice.token}` } })).text();
    assert.doesNotMatch(agentLlm, /flamingo|pelican/);
    assert.match(agentLlm, /heron/);
    await json(`${base}/api/gateway/list-ids`, { method: "POST", token: alice.token, body: { agentId: agent.id, documentId: payroll.id }, expectedStatus: 403 });

    for (const resource of ["documents", "blocks"]) {
      const rows = await json<{ rows: Array<Record<string, unknown>> }>(`${base}/api/db/query`, { method: "POST", token: alice.token, body: { resource, q: "flamingo" } });
      assert.equal(rows.rows.length, 0, `db query ${resource} leaks`);
    }
    const siteRows = await json<{ rows: Array<{ id: string; documentIds: string[] }> }>(`${base}/api/db/query`, { method: "POST", token: alice.token, body: { resource: "sites" } });
    assert.deepEqual(siteRows.rows.find((row) => row.id === site.id)?.documentIds, [open.id]);

    const navigation = await json<{ recents: Array<{ resourceId: string }>; favorites: Array<{ resourceId: string }> }>(`${base}/api/navigation`, { token: alice.token });
    assert.equal(navigation.recents.some((item) => item.resourceId === payroll.id), false);
    assert.equal(navigation.favorites.some((item) => item.resourceId === payroll.id), false);
    await json(`${base}/api/navigation/favorites`, { method: "PUT", token: alice.token, body: { resourceType: "document", resourceId: payroll.id }, expectedStatus: 403 });

    assert.equal((await notifications(base, alice.token)).some((item) => item.resourceId === payroll.id), false, "old notifications about hidden pages are withheld");
    await editPage(base, payroll.id, bob.token, "The flamingo salary ledger lives here. Updated after the lock.");
    await json(`${base}/api/documents/${payroll.id}/comments`, { method: "POST", token: carol.token, body: { body: `Ping @{${alice.id}} about the ledger` } });
    assert.equal((await notifications(base, alice.token)).some((item) => item.resourceId === payroll.id), false);
    assert.ok((await notifications(base, carol.token)).some((item) => item.resourceId === payroll.id && item.type === "page_updated"));

    const activity = await json<{ events: Array<{ resourceId: string }> }>(`${base}/api/activity?site=${site.id}`, { token: alice.token });
    assert.equal(activity.events.some((event) => hiddenIds.includes(event.resourceId)), false);

    assert.equal((await fetch(`${base}/api/attachments/${attachment.id}`, { headers: { authorization: `Bearer ${alice.token}` } })).status, 403);
    assert.equal((await fetch(`${base}${aliceSignedUrl}`)).status, 403, "signed URLs minted before the lock stop working");
    assert.equal((await fetch(`${base}/api/attachments/${attachment.id}`, { headers: { authorization: `Bearer ${carol.token}` } })).status, 200);
    assert.equal((await fetch(`${base}/api/attachments/${attachment.id}`, { headers: { "x-noma-share-token": siteShare.token } })).status, 403);

    await json(`${base}/api/trash/document/${child.id}`, { method: "POST", token: bob.token });
    assert.equal((await json<{ items: Array<{ resourceId: string }> }>(`${base}/api/trash`, { token: alice.token })).items.some((item) => item.resourceId === child.id), false);
    assert.ok((await json<{ items: Array<{ resourceId: string }> }>(`${base}/api/trash`, { token: bob.token })).items.some((item) => item.resourceId === child.id));
    await json(`${base}/api/trash/document/${child.id}/restore`, { method: "POST", token: bob.token });

    await json(`${base}/api/sites/${site.id}/documents`, {
      method: "POST",
      token: alice.token,
      body: { title: "Probe", source: "# Probe\n", parentId: payroll.id },
      expectedStatus: 400,
    });
    await json(`${base}/api/sites/${site.id}/documents/${open.id}/parent`, { method: "PUT", token: alice.token, body: { parentId: payroll.id }, expectedStatus: 400 });
    const reordered = await json<SiteResponse>(`${base}/api/sites/${site.id}`, {
      method: "PUT",
      token: alice.token,
      body: { documentIds: [open.id], pageParents: {} },
    });
    assert.deepEqual(reordered.documentIds, [open.id]);
    const adminSite = await json<SiteResponse>(`${base}/api/sites/${site.id}`, { token: admin.token });
    assert.deepEqual([...adminSite.documentIds].sort(), [open.id, payroll.id, child.id].sort(), "a space update cannot drop pages the editor cannot see");
    assert.equal(adminSite.pageParents[child.id], payroll.id);

    const aliceView = await json<RestrictionsResponse>(`${base}/api/documents/${payroll.id}/restrictions`, { token: alice.token });
    assert.equal(aliceView.canManage, true, "space owners can always manage restrictions");
    const carolView = await json<RestrictionsResponse>(`${base}/api/documents/${payroll.id}/restrictions`, { token: carol.token });
    assert.equal(carolView.canManage, false);
    const childView = await json<RestrictionsResponse>(`${base}/api/documents/${child.id}/restrictions`, { token: carol.token });
    assert.deepEqual(childView.inherited, [{ documentId: payroll.id, title: "Payroll" }]);
    await json(`${base}/api/documents/${payroll.id}/restrictions`, { token: dave.token, expectedStatus: 403 });
    await json(`${base}/api/documents/${payroll.id}/restrictions`, { method: "PUT", token: carol.token, body: { view: { users: [carol.id] } }, expectedStatus: 403 });
    await json(`${base}/api/documents/${payroll.id}/restrictions`, { method: "PUT", token: alice.token, body: { view: { users: ["unknown-user-1"] } }, expectedStatus: 400 });
    await json(`${base}/api/documents/${payroll.id}/restrictions`, { method: "PUT", token: alice.token, body: { view: { users: "nope" } }, expectedStatus: 400 });

    await json(`${base}/api/documents/${payroll.id}/restrictions`, { method: "PUT", token: alice.token, body: {} });
    assert.equal(await canSee(alice.token, payroll.id), true);
    assert.equal(await canSee(alice.token, child.id), true);
    assert.ok((await json<{ results: unknown[] }>(`${base}/api/search?q=flamingo`, { token: alice.token })).results.length > 0);

    await assertListingsMatchDirectAccess(base, [admin, alice, bob, carol, erin, dave], [payroll.id, child.id, open.id]);
  } finally {
    await harness.close();
  }
});

test("edit restrictions cap everyone else at viewer, including agents", async () => {
  const harness = await startCloudServer("noma-restrictions-edit-");
  const { base } = harness;
  try {
    await createCloudUser(base, "Admin");
    const alice = await createCloudUser(base, "Alice");
    const bob = await createCloudUser(base, "Bob");
    const site = await json<SiteResponse>(`${base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Engineering", documentIds: [] } });
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: alice.token, body: { userId: bob.id, role: "editor" } });
    const page = await createSitePage(base, site.id, alice.token, "Runbook", "Restart the kestrel service.");
    const agent = await json<{ id: string }>(`${base}/api/agents`, {
      method: "POST",
      token: bob.token,
      body: { name: "Bob's helper", capabilities: ["read_doc", "list_ids", "patch_block"] },
    });
    await json(`${base}/api/agents/${agent.id}/access`, { method: "POST", token: bob.token, body: { resourceType: "site", resourceId: site.id, role: "editor" } });

    await json(`${base}/api/documents/${page.id}/restrictions`, { method: "PUT", token: bob.token, body: { edit: { users: [bob.id] } }, expectedStatus: 403 });
    await json(`${base}/api/documents/${page.id}/restrictions`, { method: "PUT", token: alice.token, body: { edit: { users: [alice.id] } } });

    const bobView = await json<CloudDocumentResponse>(`${base}/api/documents/${page.id}`, { token: bob.token });
    assert.equal(bobView.access.role, "viewer");
    await json(`${base}/api/documents/${page.id}`, { method: "PUT", token: bob.token, body: { source: "# Runbook\n\nChanged.\n", expectedHash: bobView.hash }, expectedStatus: 403 });
    await json(`${base}/api/sites/${site.id}/documents/${page.id}`, { method: "PUT", token: bob.token, body: { source: "# Runbook\n\nChanged.\n", expectedHash: bobView.hash }, expectedStatus: 403 });
    const upload = await fetch(`${base}/api/documents/${page.id}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${bob.token}`, "content-type": "image/png", "x-filename": "x.png" },
      body: PNG,
    });
    assert.equal(upload.status, 403);
    await json(`${base}/api/documents/${page.id}/labels`, { method: "POST", token: bob.token, body: { label: "nope" }, expectedStatus: 403 });
    const listed = await json<{ documents: Array<{ id: string; currentRole: string }> }>(`${base}/api/documents`, { token: bob.token });
    assert.equal(listed.documents.find((doc) => doc.id === page.id)?.currentRole, "viewer");
    await json(`${base}/api/gateway/mcp`, {
      method: "POST",
      token: bob.token,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "proposal", arguments: { agentId: agent.id, documentId: page.id, ops: [{ op: "replace_body", id: "runbook", content: "Hacked" }] } },
      },
      expectedStatus: 403,
    });
    const tree = await json<{ pages: TreeNode[] }>(`${base}/api/sites/${site.id}/tree`, { token: bob.token });
    assert.deepEqual(tree.pages[0]?.restrictions, { view: false, edit: true, inheritedView: false });

    const aliceView = await json<CloudDocumentResponse>(`${base}/api/documents/${page.id}`, { token: alice.token });
    assert.equal(aliceView.access.role, "owner");
    await editPage(base, page.id, alice.token, "Restart the kestrel service twice.");

    await json(`${base}/api/documents/${page.id}/restrictions`, { method: "PUT", token: alice.token, body: { edit: { users: [bob.id] } } });
    assert.equal((await json<CloudDocumentResponse>(`${base}/api/documents/${page.id}`, { token: bob.token })).access.role, "editor");
    await editPage(base, page.id, bob.token, "Bob may edit again.");
  } finally {
    await harness.close();
  }
});

test("restrictions survive purge cleanup and admin allowlists", async () => {
  const harness = await startCloudServer("noma-restrictions-admin-");
  const { base } = harness;
  try {
    const first = await createCloudUser(base, "First");
    const alice = await createCloudUser(base, "Alice");
    const site = await json<SiteResponse>(`${base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Private", documentIds: [] } });
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: alice.token, body: { userId: first.id, role: "viewer" } });
    const page = await createSitePage(base, site.id, alice.token, "Locked", "Only alice sees the osprey.");
    await json(`${base}/api/documents/${page.id}/restrictions`, { method: "PUT", token: alice.token, body: { view: { users: [alice.id] } } });
    const adminView = await json<CloudDocumentResponse>(`${base}/api/documents/${page.id}`, { token: first.token });
    assert.equal(adminView.access.role, "viewer", "workspace admins bypass restrictions but not grants");
    const adminRestrictions = await json<RestrictionsResponse>(`${base}/api/documents/${page.id}/restrictions`, { token: first.token });
    assert.equal(adminRestrictions.canManage, true);

    await json(`${base}/api/trash/document/${page.id}`, { method: "POST", token: alice.token });
    await json(`${base}/api/trash/document/${page.id}`, { method: "DELETE", token: alice.token });
    const replacement = await createSitePage(base, site.id, alice.token, "Fresh", "Visible to the space.");
    assert.equal((await json<CloudDocumentResponse>(`${base}/api/documents/${replacement.id}`, { token: first.token })).access.role, "viewer");
  } finally {
    await harness.close();
  }
});

async function assertListingsMatchDirectAccess(base: string, users: CloudUserResponse[], documentIds: string[]): Promise<void> {
  for (const user of users) {
    const listed = new Set((await json<{ documents: Array<{ id: string }> }>(`${base}/api/documents`, { token: user.token })).documents.map((doc) => doc.id));
    for (const id of documentIds) {
      const direct = (await fetch(`${base}/api/documents/${id}`, { headers: { authorization: `Bearer ${user.token}` } })).status === 200;
      assert.equal(listed.has(id), direct, `${user.name}: SQL listing and direct access disagree on ${id}`);
    }
  }
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

async function notifications(base: string, token: string): Promise<Array<{ resourceId?: string; type: string }>> {
  return (await json<{ notifications: Array<{ resourceId?: string; type: string }> }>(`${base}/api/notifications`, { token })).notifications;
}

async function createSitePage(base: string, siteId: string, token: string, title: string, body: string, parentId?: string): Promise<CloudDocumentResponse> {
  return json<CloudDocumentResponse>(`${base}/api/sites/${siteId}/documents`, {
    method: "POST",
    token,
    body: { title, source: `# ${title}\n\n${body}\n`, ...(parentId ? { parentId } : {}) },
  });
}

async function editPage(base: string, id: string, token: string, body: string): Promise<void> {
  const current = await json<CloudDocumentResponse>(`${base}/api/documents/${id}`, { token });
  const title = current.title;
  await json(`${base}/api/documents/${id}`, { method: "PUT", token, body: { source: `# ${title}\n\n${body}\n`, expectedHash: current.hash } });
}

async function uploadAttachment(base: string, documentId: string, token: string): Promise<{ id: string }> {
  const response = await fetch(`${base}/api/documents/${documentId}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "image/png", "x-filename": "payroll-chart.png" },
    body: PNG,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as { id: string };
}

async function startCloudServer(prefix: string): Promise<Harness> {
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
    rateLimitMaxRequests: 10_000,
    now: () => new Date("2026-06-06T12:00:00.000Z"),
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
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.share) headers.set("x-noma-share-token", options.share);
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
  if (!response.ok) assert.fail(`${response.status} ${url} ${await response.text()}`);
  return response.json() as Promise<T>;
}
