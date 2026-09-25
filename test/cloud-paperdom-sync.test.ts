import assert from "node:assert/strict";
import test from "node:test";
import type { PaperDOMDocument } from "../src/paperdom-document-model.js";
import { createCloudUser, json, jsonStatus, request, startCloudServer } from "./cloud-wiki-helpers.js";

const DECK = `# Pitch

::deck{id="pitch-deck"}
:::slide{id="s1" title="Why now"}
- Agents write **everywhere**
- Reviews do not scale
:::
::
`;

test("canvas edits come back to Cloud as a proofed patch proposal that needs independent approval", async () => {
  const harness = await startCloudServer("noma-paperdom-sync-");
  const { base } = harness;
  try {
    const alice = await createCloudUser(base, "Alice");
    const bob = await createCloudUser(base, "Bob");
    const viewer = await createCloudUser(base, "Vera");
    const page = await json<{ id: string }>(`${base}/api/documents`, { method: "POST", token: alice.token, body: { title: "Pitch", source: DECK } });
    await json(`${base}/api/documents/${page.id}/collaborators`, { method: "POST", token: alice.token, body: { userId: bob.id, role: "editor" } });
    await json(`${base}/api/documents/${page.id}/collaborators`, { method: "POST", token: alice.token, body: { userId: viewer.id, role: "viewer" } });

    const exported = await request(`${base}/api/documents/${page.id}/export?to=paperdom`, { token: alice.token });
    assert.equal(exported.status, 200);
    const canvas = (await exported.json()) as PaperDOMDocument;
    const body = canvas.pages[0]!.elements.find((element) => element.id === "s1--body")!;
    body.content!.paragraphs![0]!.text = "Agents write nearly everywhere";
    body.content!.text = body.content!.paragraphs!.map((p) => p.text).join("\n");
    canvas.pages[0]!.elements.find((element) => element.id === "s1--title")!.frame.y += 12;

    await jsonStatus(`${base}/api/documents/${page.id}/paperdom-sync`, 403, { method: "POST", token: viewer.token, body: { canvas } });
    await jsonStatus(`${base}/api/documents/${page.id}/paperdom-sync`, 422, { method: "POST", token: alice.token, body: { canvas: { format: "paperdom" } } });

    const sync = await json<{ ops: unknown[]; changes: Array<{ target: string }>; skipped: Array<{ reason: string }> }>(`${base}/api/documents/${page.id}/paperdom-sync`, {
      method: "POST",
      token: alice.token,
      body: { canvas },
    });
    assert.equal(sync.ops.length, 1);
    assert.deepEqual(sync.changes.map((change) => change.target), ["s1"]);
    assert.match(sync.skipped.map((skip) => skip.reason).join(" "), /layout stays in PaperDOM/);

    const proposal = await json<{ id: string; status: string; proof: { status: string; canWrite: boolean } }>(`${base}/api/documents/${page.id}/patch-proposals`, {
      method: "POST",
      token: alice.token,
      body: { summary: "Canvas text edits", ops: sync.ops },
    });
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.proof.status, "pass");
    await json(`${base}/api/documents/${page.id}/patch-proposals/${proposal.id}/review`, { method: "POST", token: bob.token, body: { decision: "approved" } });
    const applied = await json<{ document: { source: string } }>(`${base}/api/documents/${page.id}/patch-proposals/${proposal.id}/apply`, { method: "POST", token: alice.token });
    assert.match(applied.document.source, /- Agents write \*\*nearly everywhere\*\*/);
  } finally {
    await harness.close();
  }
});
