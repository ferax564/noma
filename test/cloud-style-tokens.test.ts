import assert from "node:assert/strict";
import test from "node:test";
import { createCloudUser, json, jsonStatus, request, startCloudServer } from "./cloud-wiki-helpers.js";

interface SpaceResponse {
  id: string;
  styleTokens: Record<string, string[]>;
}

interface PageResponse {
  id: string;
  styleTokens: Record<string, string[]>;
  diagnostics: Array<{ code: string }>;
}

test("spaces define style-token aliases that pages in the space render and validate with", async () => {
  const harness = await startCloudServer("noma-style-tokens-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada");
    const bob = await createCloudUser(base, "Bob");
    const page = await json<PageResponse>(`${base}/api/documents`, {
      method: "POST",
      token: ada.token,
      body: { title: "Brand", source: `# Brand\n\n::card{id="c" class="brand-callout span-2"}\nHello\n::\n` },
    });
    assert.ok(page.diagnostics.some((d) => d.code === "unknown-style-token"), "alias is unknown before a space defines it");

    const space = await json<SpaceResponse>(`${base}/api/sites`, {
      method: "POST",
      token: ada.token,
      body: { title: "Marketing", documentIds: [page.id], styleTokens: { "brand-callout": "tone-accent filled roomy" } },
    });
    assert.deepEqual(space.styleTokens, { "brand-callout": ["tone-accent", "filled", "roomy"] });

    const bad = await jsonStatus<{ error: string; details?: { code?: string } }>(`${base}/api/sites/${space.id}`, 400, {
      method: "PUT",
      token: ada.token,
      body: { title: "Marketing", documentIds: [page.id], styleTokens: { "tone-accent": "filled", "evil-css": "color:red" } },
    });
    assert.match(bad.error, /shadows a core style token/);
    assert.match(bad.error, /unknown core token/);

    await json(`${base}/api/sites/${space.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    await jsonStatus(`${base}/api/sites/${space.id}`, 403, {
      method: "PUT",
      token: bob.token,
      body: { title: "Marketing", documentIds: [page.id], styleTokens: {} },
    });

    const reloaded = await json<PageResponse>(`${base}/api/documents/${page.id}`, { token: ada.token });
    assert.deepEqual(reloaded.styleTokens, { "brand-callout": ["tone-accent", "filled", "roomy"] });
    assert.ok(!reloaded.diagnostics.some((d) => d.code === "unknown-style-token"));

    const html = await (await request(`${base}/d/${page.id}`, { token: ada.token })).text();
    assert.match(html, /<article class="noma-card n-tone-accent n-filled n-roomy n-span-2" id="c"/);

    const cleared = await json<SpaceResponse>(`${base}/api/sites/${space.id}`, {
      method: "PUT",
      token: ada.token,
      body: { title: "Marketing", documentIds: [page.id], styleTokens: {} },
    });
    assert.deepEqual(cleared.styleTokens, {});
  } finally {
    await harness.close();
  }
});
