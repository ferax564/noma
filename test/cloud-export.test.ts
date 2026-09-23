import assert from "node:assert/strict";
import test from "node:test";
import yaml from "js-yaml";
import { readZip } from "../src/zip.js";
import { createCloudUser, json, jsonStatus, request, startCloudServer } from "./cloud-wiki-helpers.js";

interface DocumentResponse {
  id: string;
  title: string;
  source: string;
}

test("document export renders noma, markdown, html, docx, and pdf (or a clear 501)", async () => {
  const cloud = await startCloudServer("noma-cloud-export-");
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const bob = await createCloudUser(cloud.base, "Bob");
    const site = await json<{ id: string }>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Docs", documentIds: [] } });
    const create = (title: string, source: string, parentId?: string): Promise<DocumentResponse> =>
      json<DocumentResponse>(`${cloud.base}/api/sites/${site.id}/documents`, {
        method: "POST",
        token: alice.token,
        body: { title, source, ...(parentId ? { parentId } : {}) },
      });
    const shared = await create("Shared", "# Shared\n\n::note{id=\"rule\"}\nShared rule text.\n::\n");
    const page = await create(
      "Release notes",
      "# Release notes\n\nIntro paragraph.\n\n::include{page=\"Shared\" block=\"rule\"}\n::\n\n::children\n::\n\n::html\n<script>alert(1)</script>\n::\n",
    );
    await create("Child page", "# Child page\n\nChild body.\n", page.id);
    const url = (to: string): string => `${cloud.base}/api/documents/${page.id}/export?to=${to}`;

    const noma = await request(url("noma"), { token: alice.token });
    assert.equal(noma.status, 200);
    assert.equal(await noma.text(), page.source);
    assert.match(noma.headers.get("content-disposition") ?? "", /attachment; filename="release-notes\.noma"/);

    const markdown = await (await request(url("markdown"), { token: alice.token })).text();
    assert.match(markdown, /Shared rule text\./);
    assert.match(markdown, /- Child page/);

    const html = await request(url("html"), { token: alice.token });
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html.headers.get("content-security-policy") ?? "", /sandbox/);
    const htmlText = await html.text();
    assert.match(htmlText, /Shared rule text\./);
    assert.match(htmlText, /raw HTML escape hatch disabled/);
    assert.doesNotMatch(htmlText, /<script>alert/);

    const docx = await request(url("docx"), { token: alice.token });
    assert.equal(docx.status, 200);
    const entries = readZip(new Uint8Array(await docx.arrayBuffer()));
    const documentXml = entries.find((entry) => entry.path === "word/document.xml")?.data.toString("utf8") ?? "";
    assert.match(documentXml, /Shared rule text\./);
    assert.match(documentXml, /Child page/);

    const pdf = await request(url("pdf"), { token: alice.token });
    if (pdf.status === 200) {
      assert.equal(pdf.headers.get("content-type"), "application/pdf");
      assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString("latin1"), "%PDF-");
    } else {
      assert.equal(pdf.status, 501, await pdf.text());
    }

    await jsonStatus(url("rtf"), 400, { token: alice.token });
    await jsonStatus(url("markdown"), 403, { token: bob.token });
    await jsonStatus(url("markdown"), 401);
    const sharedMarkdown = await (await request(`${cloud.base}/api/documents/${shared.id}/export?to=markdown`, { token: alice.token })).text();
    assert.match(sharedMarkdown, /Shared rule text\./);
  } finally {
    await cloud.close();
  }
});

test("space export bundles .noma sources with a manifest, or a static HTML site", async () => {
  const cloud = await startCloudServer("noma-cloud-site-export-");
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const bob = await createCloudUser(cloud.base, "Bob");
    const site = await json<{ id: string }>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Team Space", documentIds: [] } });
    const create = (title: string, source: string, parentId?: string): Promise<DocumentResponse> =>
      json<DocumentResponse>(`${cloud.base}/api/sites/${site.id}/documents`, {
        method: "POST",
        token: alice.token,
        body: { title, source, ...(parentId ? { parentId } : {}) },
      });
    const home = await create("Home", "# Home\n\n::children\n::\n");
    const guide = await create("Guide", "# Guide\n\nGuide body.\n", home.id);
    const duplicate = await create("Guide", "# Guide\n\nSecond guide.\n");
    const trashed = await create("Old", "# Old\n");
    await json(`${cloud.base}/api/documents/${guide.id}/labels`, { method: "POST", token: alice.token, body: { label: "how-to" } });
    await json(`${cloud.base}/api/trash/document/${trashed.id}`, { method: "POST", token: alice.token });

    const nomaZip = await request(`${cloud.base}/api/sites/${site.id}/export?to=noma-zip`, { token: alice.token });
    assert.equal(nomaZip.status, 200);
    assert.equal(nomaZip.headers.get("content-type"), "application/zip");
    const entries = new Map(readZip(new Uint8Array(await nomaZip.arrayBuffer())).map((entry) => [entry.path, entry.data.toString("utf8")]));
    const manifest = JSON.parse(entries.get("manifest.json") ?? "{}") as {
      site: { title: string };
      pages: Array<{ id: string; path: string; parentId?: string; labels: string[] }>;
    };
    assert.equal(manifest.site.title, "Team Space");
    assert.deepEqual(manifest.pages.map((page) => page.path), ["pages/home.noma", "pages/guide.noma", "pages/guide-2.noma"]);
    assert.equal(manifest.pages.find((page) => page.id === guide.id)?.parentId, home.id);
    assert.deepEqual(manifest.pages.find((page) => page.id === guide.id)?.labels, ["how-to"]);
    assert.equal(entries.get("pages/guide-2.noma"), duplicate.source);
    assert.ok(![...entries.keys()].some((path) => path.includes("old")));
    const book = yaml.load(entries.get("book.noma.yml") ?? "") as { chapters: string[] };
    assert.equal(book.chapters.length, 3);

    const siteZip = await request(`${cloud.base}/api/sites/${site.id}/export?to=site-zip`, { token: alice.token });
    const siteEntries = new Map(readZip(new Uint8Array(await siteZip.arrayBuffer())).map((entry) => [entry.path, entry.data.toString("utf8")]));
    assert.match(siteEntries.get("index.html") ?? "", /<a href="pages\/home\.html">Home<\/a><ul><li><a href="pages\/guide\.html">Guide<\/a>/);
    assert.match(siteEntries.get("pages/home.html") ?? "", /<a href="guide\.html">Guide<\/a>/);
    assert.match(siteEntries.get("pages/guide.html") ?? "", /Guide body\./);

    await jsonStatus(`${cloud.base}/api/sites/${site.id}/export?to=pdf`, 400, { token: alice.token });
    await jsonStatus(`${cloud.base}/api/sites/${site.id}/export?to=noma-zip`, 403, { token: bob.token });
  } finally {
    await cloud.close();
  }
});
