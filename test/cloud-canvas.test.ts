import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCloudUser, json, request, startCloudServer } from "./cloud-wiki-helpers.js";

const BOARD = readFileSync(new URL("../examples/canvas/agent-loop.paperdom.json", import.meta.url), "utf8");

async function upload(base: string, documentId: string, token: string, body: string, filename: string): Promise<{ id: string; reference: string }> {
  const response = await fetch(`${base}/api/documents/${documentId}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-filename": encodeURIComponent(filename) },
    body,
  });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: string; reference: string };
}

test("a page draws a canvas stored in its own attachment, in every Cloud view and export; decks export as .pptx", async () => {
  const harness = await startCloudServer("noma-canvas-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada");
    const page = await json<{ id: string; hash: string }>(`${base}/api/documents`, { method: "POST", token: ada.token, body: { title: "Board", source: "# Board\n" } });
    const other = await json<{ id: string }>(`${base}/api/documents`, { method: "POST", token: ada.token, body: { title: "Other", source: "# Other\n" } });
    const attachment = await upload(base, page.id, ada.token, BOARD, "agent-loop.json");
    await upload(base, other.id, ada.token, BOARD.replace("Agent proposes ops", "Foreign canvas"), "foreign.json");

    const source = `# Board\n\n::canvas{id="flow" src="${attachment.reference}" page="flow" caption="Flow"}\n::\n\n::canvas{id="by-name" src="att:agent-loop.json" page="metrics"}\n::\n\n::canvas{id="foreign" src="att:foreign.json"}\n::\n`;
    await json(`${base}/api/documents/${page.id}`, { method: "PUT", token: ada.token, body: { title: "Board", source, expectedHash: page.hash } });
    const loaded = await json<{ diagnostics: Array<{ code: string }> }>(`${base}/api/documents/${page.id}`, { token: ada.token });
    assert.deepEqual(loaded.diagnostics.filter((d) => d.code.startsWith("canvas-")), []);

    const html = await (await request(`${base}/d/${page.id}`, { token: ada.token })).text();
    assert.match(html, /<figure class="noma-canvas" id="flow" data-pages="1">/);
    assert.match(html, /Agent proposes ops/);
    assert.match(html, /<figure class="noma-canvas" id="by-name"[^>]*>.*Approved agent proposals/s, "att: resolves by filename too");
    assert.match(html, /canvas not available: att:foreign\.json/, "another page's attachment never resolves");
    assert.doesNotMatch(html, /Foreign canvas/);

    const present = await (await request(`${base}/d/${page.id}/present`, { token: ada.token })).text();
    assert.match(present, /Agent proposes ops/);
    const exported = await (await request(`${base}/api/documents/${page.id}/export?to=html`, { token: ada.token })).text();
    assert.match(exported, /Agent proposes ops/);
    const markdown = await (await request(`${base}/api/documents/${page.id}/export?to=markdown`, { token: ada.token })).text();
    assert.match(markdown, /- Agent proposes ops/);
    const noma = await (await request(`${base}/api/documents/${page.id}/export?to=noma`, { token: ada.token })).text();
    assert.equal(noma, source, "the .noma export keeps the reference, not the inlined JSON");

    const deck = await json<{ id: string }>(`${base}/api/documents`, { method: "POST", token: ada.token, body: { title: "Deck", source: "# Deck\n\n::deck{id=\"d\"}\n:::slide{id=\"s\" title=\"Hello\"}\n- Point\n\n::::notes\nSay it.\n::::\n:::\n::\n" } });
    const pptx = await request(`${base}/api/documents/${deck.id}/export?to=pptx`, { token: ada.token });
    assert.equal(pptx.status, 200);
    assert.equal(pptx.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    assert.match(pptx.headers.get("content-disposition") ?? "", /deck\.pptx/i);
    const fidelity = JSON.parse(pptx.headers.get("x-noma-fidelity") ?? "{}") as { slides: number; supported: string[] };
    assert.equal(fidelity.slides, 1);
    assert.ok(fidelity.supported.includes("speaker notes"));
    const bytes = Buffer.from(await pptx.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK");

    const space = await json<{ id: string }>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Space", documentIds: [page.id] } });
    const site = await (await request(`${base}/s/${space.id}`, { token: ada.token })).text();
    assert.match(site, /Agent proposes ops/);
  } finally {
    await harness.close();
  }
});
