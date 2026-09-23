import assert from "node:assert/strict";
import test from "node:test";
import { parseSearchQuery } from "../src/cloud/search-query.js";
import { createCloudUser, createSpace, json, savePage, startCloudServer } from "./cloud-wiki-harness.js";

interface SearchResult {
  documentId: string;
  documentTitle: string;
  blockId?: string;
  nodeType?: string;
  directiveName?: string;
  contentType?: string;
  exactSource?: string;
}

interface SearchResponse {
  mode?: string;
  results: SearchResult[];
  query?: unknown;
  filters?: { labels: string[]; authors: string[]; phrases: string[] };
}

test("search query parser splits words, phrases and key:value filters", () => {
  const parsed = parseSearchQuery('deploy label:How-To author:@ada space:ENG type:claim "exact phrase" after:2026-01-01 before:2026-07-01T00:00:00Z foo:bar');
  assert.deepEqual(parsed.words, ["deploy", "foo:bar"]);
  assert.deepEqual(parsed.phrases, ["exact phrase"]);
  assert.deepEqual(parsed.labels, ["how-to"]);
  assert.deepEqual(parsed.authors, ["ada"]);
  assert.deepEqual(parsed.spaces, ["ENG"]);
  assert.deepEqual(parsed.types, ["claim"]);
  assert.equal(parsed.updatedAfter, "2026-01-01T00:00:00.000Z");
  assert.equal(parsed.updatedBefore, "2026-07-01T00:00:00.000Z");
  assert.throws(() => parseSearchQuery("after:not-a-date"), /updatedAfter must be an ISO date/);
});

test("search filters narrow /api/search and /api/knowledge/search by label, author, space, date, type and phrase", async () => {
  const harness = await startCloudServer("noma-search-filters-");
  const { base, clock } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const eve = await createCloudUser(base, "Eve Outsider");

    const eng = await createSpace(base, ada.token, "Engineering", [
      "# Deploy Runbook\n\nDeploy the service with the blue green rollout.\n",
      '# Deploy Decisions\n\n::claim{id="deploy-claim"}\nDeploy windows stay on Tuesdays.\n::\n',
    ]);
    const ops = await createSpace(base, ada.token, "Operations", ["# Ops Deploy Notes\n\nDeploy checklists for the green team.\n"]);
    await json(`${base}/api/sites/${eng.site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });

    clock.advance(24 * 60 * 60 * 1000);
    const [runbook, decisions] = eng.pages as [typeof eng.pages[0], typeof eng.pages[0]];
    await savePage(base, bob.token, runbook, "# Deploy Runbook\n\nDeploy the service with the blue green rollout. Rolled back twice.\n");
    await json(`${base}/api/documents/${runbook.id}/labels`, { method: "POST", token: ada.token, body: { label: "how-to" } });

    const search = (params: string, token = ada.token) => json<SearchResponse>(`${base}/api/search?${params}`, { token });
    const titles = (response: SearchResponse) => [...new Set(response.results.map((result) => result.documentTitle))].sort();

    assert.deepEqual(titles(await search("q=deploy")), ["Deploy Decisions", "Deploy Runbook", "Ops Deploy Notes"]);
    assert.deepEqual(titles(await search("q=deploy+label:how-to")), ["Deploy Runbook"]);
    assert.deepEqual(titles(await search("q=deploy&label=how-to")), ["Deploy Runbook"]);
    assert.deepEqual(titles(await search("q=deploy+author:@bob")), ["Deploy Runbook"]);
    assert.deepEqual(titles(await search(`q=deploy+author:me`)), ["Deploy Decisions", "Deploy Runbook", "Ops Deploy Notes"]);
    assert.deepEqual(titles(await search("q=deploy+author:nobody")), []);
    assert.deepEqual(titles(await search("q=deploy+space:Operations")), ["Ops Deploy Notes"]);
    assert.deepEqual(titles(await search(`q=deploy&space=${eng.site.id}`)), ["Deploy Decisions", "Deploy Runbook"]);
    assert.deepEqual(titles(await search("q=deploy&updatedAfter=2026-06-07")), ["Deploy Runbook"]);
    assert.deepEqual(titles(await search("q=deploy&updatedBefore=2026-06-07")), ["Deploy Decisions", "Ops Deploy Notes"]);
    const claims = await search("q=deploy+type:claim");
    assert.deepEqual(claims.results.map((result) => result.blockId), ["deploy-claim"]);
    const pages = await search("q=deploy+type:page");
    assert.equal(pages.results.length, 3);
    assert.ok(pages.results.every((result) => result.nodeType === "page"));
    assert.deepEqual(titles(await search('q="blue+green+rollout"')), ["Deploy Runbook"]);
    assert.deepEqual(titles(await search('q="green+blue"')), []);

    const filterOnly = await search("q=label:how-to");
    assert.deepEqual(titles(filterOnly), ["Deploy Runbook"]);
    assert.equal(filterOnly.results[0]?.nodeType, "page");

    assert.deepEqual(titles(await search("q=deploy+space:Operations", bob.token)), []);
    assert.deepEqual(titles(await search("q=label:how-to", eve.token)), []);
    assert.deepEqual(titles(await search("q=deploy", eve.token)), []);

    await json(`${base}/api/search?q=${encodeURIComponent("type:\"bad type!\"")}`, { token: ada.token, expectedStatus: 400 });
    await json(`${base}/api/search?q=deploy&updatedAfter=yesterday`, { token: ada.token, expectedStatus: 400 });

    const knowledge = (params: string, token = ada.token) => json<SearchResponse>(`${base}/api/knowledge/search?${params}`, { token });
    assert.deepEqual(titles(await knowledge("q=deploy+label:how-to")), ["Deploy Runbook"]);
    assert.deepEqual(titles(await knowledge("q=deploy+author:bob")), ["Deploy Runbook"]);
    assert.deepEqual(titles(await knowledge("q=deploy+space:Operations")), ["Ops Deploy Notes"]);
    const knowledgeClaims = await knowledge("q=deploy+windows+type:claim");
    assert.ok(knowledgeClaims.results.length > 0);
    assert.ok(knowledgeClaims.results.every((result) => result.contentType === "claim"));
    const knowledgePages = await knowledge("q=deploy+type:page");
    assert.equal(new Set(knowledgePages.results.map((result) => result.documentId)).size, knowledgePages.results.length);
    const phrase = await knowledge('q="rolled+back+twice"');
    assert.deepEqual(titles(phrase), ["Deploy Runbook"]);
    const knowledgeFilterOnly = await knowledge("q=label:how-to");
    assert.equal(knowledgeFilterOnly.mode, "filter");
    assert.deepEqual(titles(knowledgeFilterOnly), ["Deploy Runbook"]);
    assert.deepEqual(knowledgeFilterOnly.filters?.labels, ["how-to"]);
    assert.deepEqual(titles(await knowledge("q=label:how-to", eve.token)), []);
    assert.deepEqual(titles(await knowledge("q=deploy", bob.token)), ["Deploy Decisions", "Deploy Runbook"]);

    await json(`${base}/api/trash/document/${decisions.id}`, { method: "POST", token: ada.token });
    assert.deepEqual(titles(await search("q=deploy+type:claim")), []);
    assert.ok(ops.site.id);
  } finally {
    await harness.close();
  }
});
