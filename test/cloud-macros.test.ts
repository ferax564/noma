import assert from "node:assert/strict";
import test from "node:test";
import { createCloudUser, json, jsonStatus, request, startCloudServer } from "./cloud-wiki-helpers.js";

interface DocumentResponse {
  id: string;
  title: string;
  hash: string;
  source: string;
  diagnostics: Array<{ code: string; severity: string }>;
}

interface SiteResponse {
  id: string;
  documentIds: string[];
}

test("wiki macros resolve includes, excerpts, children, issues, and page properties with permission checks", async () => {
  const cloud = await startCloudServer("noma-cloud-macros-");
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const bob = await createCloudUser(cloud.base, "Bob");
    const site = await json<SiteResponse>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Engineering", documentIds: [] } });
    const page = async (title: string, source: string, parentId?: string): Promise<DocumentResponse> =>
      json<DocumentResponse>(`${cloud.base}/api/sites/${site.id}/documents`, {
        method: "POST",
        token: alice.token,
        body: { title, source, ...(parentId ? { parentId } : {}) },
      });

    const handbook = await page(
      "Handbook",
      `# Handbook

::excerpt{id="summary"}
How the **engineering** team works.
::

::note{id="policy"}
Every change needs a reviewer.
::
`,
    );
    await json(`${cloud.base}/api/projects`, { method: "POST", token: alice.token, body: { siteId: site.id, key: "ENG", name: "Engineering" } });
    await json(`${cloud.base}/api/projects/ENG/issues`, {
      method: "POST",
      token: alice.token,
      body: { summary: "Ship the wiki", status: "in_progress", assigneeId: alice.id },
    });
    await json(`${cloud.base}/api/projects/ENG/issues`, { method: "POST", token: alice.token, body: { summary: "Write docs", status: "todo" } });

    const secret = await json<DocumentResponse>(`${cloud.base}/api/documents`, {
      method: "POST",
      token: bob.token,
      body: { title: "Secret plan", source: "# Secret plan\n\n::note{id=\"hidden\"}\nBob only.\n::\n" },
    });

    const overview = await page(
      "Overview",
      `# Overview

::include{page="Handbook" block="policy"}
::

::include{page="Handbook" excerpt}
::

::include{page="${secret.id}"}
::

::include{page="Secret plan"}
::

::include{page="Handbook" block="nope"}
::

::issue{key="ENG-1"}
::

::issues{project="ENG" status="todo"}
::

::children{sort="title"}
::
`,
      handbook.id,
    );
    await page("Zeta child", "# Zeta child\n\n::excerpt\nLast alphabetically.\n::\n", overview.id);
    await page("Alpha child", "# Alpha child\n", overview.id);

    const html = await (await request(`${cloud.base}/api/documents/${overview.id}/html`, { token: alice.token })).text();
    assert.match(html, /Every change needs a reviewer\./);
    assert.match(html, new RegExp(`data-include-document="${handbook.id}" data-include-block="policy"`));
    assert.match(html, /How the <strong>engineering<\/strong> team works\./);
    assert.match(html, /data-macro="include" data-status="forbidden"/);
    assert.doesNotMatch(html, /Bob only/);
    assert.match(html, /data-macro="include" data-status="missing"[^>]*>Page "Secret plan" not found\.</);
    assert.match(html, /Block "nope" of "Handbook" not found\. "Handbook" has no block "nope"\./);
    assert.match(html, /data-issue-key="ENG-1"[\s\S]*Ship the wiki[\s\S]*in progress[\s\S]*Alice/);
    assert.match(html, /<table class="noma-table noma-issues">[\s\S]*ENG-2[\s\S]*Write docs/);
    assert.doesNotMatch(html.match(/<table class="noma-table noma-issues">[\s\S]*?<\/table>/)?.[0] ?? "", /Ship the wiki/);
    const children = html.match(/<nav class="noma-children"[\s\S]*?<\/nav>/)?.[0] ?? "";
    assert.ok(children.indexOf("Alpha child") < children.indexOf("Zeta child"), children);
    assert.match(children, /Last alphabetically\./);
    assert.match(children, /href="\/cloud\.html\?doc=/);

    const llm = await (await request(`${cloud.base}/api/documents/${overview.id}/llm`, { token: alice.token })).text();
    assert.match(llm, new RegExp(`<!-- included from ${handbook.id}:policy@${handbook.hash.slice(0, 12)} -->`));
    assert.match(llm, /Every change needs a reviewer\./);
    assert.match(llm, /ENG-1: Ship the wiki · in progress · Alice/);

    const artifact = await (await request(`${cloud.base}/d/${overview.id}`, { token: alice.token })).text();
    assert.match(artifact, /Every change needs a reviewer\./);

    const tree = await json<{ pages: Array<{ id: string; summary?: string; children: Array<{ title: string }> }> }>(`${cloud.base}/api/sites/${site.id}/tree`, {
      token: alice.token,
    });
    assert.equal(tree.pages[0]?.id, handbook.id);
    assert.equal(tree.pages[0]?.summary, "How the engineering team works.");

    const search = await json<{ results: Array<{ documentId: string; summary?: string }> }>(`${cloud.base}/api/search?q=reviewer`, { token: alice.token });
    assert.equal(search.results.find((result) => result.documentId === handbook.id)?.summary, "How the engineering team works.");

    const resolved = await json<{ results: Array<{ status: string; nodes?: unknown[]; title?: string }> }>(`${cloud.base}/api/macros/resolve`, {
      method: "POST",
      token: alice.token,
      body: {
        documentId: overview.id,
        requests: [
          { kind: "include", page: "Handbook", block: "policy", fromDocumentId: overview.id },
          { kind: "include", page: secret.id },
          { kind: "children", documentId: overview.id, sort: "title" },
          { kind: "issue", key: "ENG-1" },
          { kind: "include", page: "Handbook", fromDocumentId: secret.id },
        ],
      },
    });
    assert.equal(resolved.results[0]?.status, "ok");
    assert.equal(resolved.results[0]?.title, "Handbook");
    assert.equal(resolved.results[1]?.status, "forbidden");
    assert.equal(resolved.results[2]?.status, "ok");
    assert.equal(resolved.results[3]?.status, "ok");
    assert.equal(resolved.results[4]?.status, "forbidden");

    await jsonStatus(`${cloud.base}/api/macros/resolve`, 403, { method: "POST", token: bob.token, body: { documentId: overview.id, requests: [] } });
    const bobView = await json<{ results: Array<{ status: string }> }>(`${cloud.base}/api/macros/resolve`, {
      method: "POST",
      token: bob.token,
      body: { requests: [{ kind: "include", page: handbook.id }, { kind: "issue", key: "ENG-1" }, { kind: "issues", project: "ENG" }] },
    });
    assert.deepEqual(bobView.results.map((result) => result.status), ["forbidden", "forbidden", "forbidden"]);
    await jsonStatus(`${cloud.base}/api/macros/resolve`, 400, { method: "POST", token: alice.token, body: { requests: [{ kind: "nope" }] } });
    await jsonStatus(`${cloud.base}/api/macros/resolve`, 401, { method: "POST", body: { requests: [] } });
  } finally {
    await cloud.close();
  }
});

test("include cycles and trashed targets render placeholders instead of recursing", async () => {
  const cloud = await startCloudServer("noma-cloud-macro-cycles-");
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const site = await json<SiteResponse>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Loops", documentIds: [] } });
    const create = (title: string, source: string): Promise<DocumentResponse> =>
      json<DocumentResponse>(`${cloud.base}/api/sites/${site.id}/documents`, { method: "POST", token: alice.token, body: { title, source } });
    const first = await create("First", "# First\n\nFirst body.\n\n::include{page=\"Second\"}\n::\n");
    await create("Second", "# Second\n\nSecond body.\n\n::include{page=\"First\"}\n::\n");
    const self = await create("Selfie", "# Selfie\n\n::note{id=\"loop\"}\nLoop start\n\n:::include{block=\"loop\"}\n:::\n::\n");

    const html = await (await request(`${cloud.base}/api/documents/${first.id}/html`, { token: alice.token })).text();
    assert.match(html, /Second body\./);
    assert.match(html, /data-status="cycle"/);
    assert.equal(html.match(/Second body\./g)?.length, 1);

    const selfHtml = await (await request(`${cloud.base}/api/documents/${self.id}/html`, { token: alice.token })).text();
    assert.equal(selfHtml.match(/Loop start/g)?.length, 2);
    assert.match(selfHtml, /data-status="cycle"/);

    const second = (await json<{ documents: DocumentResponse[] }>(`${cloud.base}/api/sites/${site.id}/documents`, { token: alice.token })).documents.find(
      (document) => document.title === "Second",
    )!;
    await json(`${cloud.base}/api/trash/document/${second.id}`, { method: "POST", token: alice.token });
    const afterTrash = await (await request(`${cloud.base}/api/documents/${first.id}/html`, { token: alice.token })).text();
    assert.match(afterTrash, /data-macro="include" data-status="missing"/);
  } finally {
    await cloud.close();
  }
});

test("page properties report lists labeled pages in the same space", async () => {
  const cloud = await startCloudServer("noma-cloud-macro-properties-");
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const site = await json<SiteResponse>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Decisions", documentIds: [] } });
    const create = (title: string, source: string): Promise<DocumentResponse> =>
      json<DocumentResponse>(`${cloud.base}/api/sites/${site.id}/documents`, { method: "POST", token: alice.token, body: { title, source } });
    const adr = await create("ADR 1", "# ADR 1\n\n::page-properties\n| Owner | Alice |\n| Status | Accepted |\n::\n");
    await json(`${cloud.base}/api/documents/${adr.id}/labels`, { method: "POST", token: alice.token, body: { label: "adr" } });
    const report = await create("ADR index", "# ADR index\n\n::page-properties-report{label=\"adr\"}\n::\n");
    const html = await (await request(`${cloud.base}/api/documents/${report.id}/html`, { token: alice.token })).text();
    assert.match(html, /<table class="noma-table noma-page-properties-report">[\s\S]*<th>Owner<\/th><th>Status<\/th>[\s\S]*ADR 1[\s\S]*Alice[\s\S]*Accepted/);
  } finally {
    await cloud.close();
  }
});
