import assert from "node:assert/strict";
import test from "node:test";
import { createCloudUser, json, jsonStatus, request, startCloudServer } from "./cloud-wiki-helpers.js";

const KIT = `# Marketing kit

Internal pricing notes: never discount Enterprise below list.

::component{name="pricing_card" props="plan,price" slots="features"}
:::card{title="{{plan}}" class="elevated"}
**{{price}}**

{{slot:features}}
:::
::

::component{name="calculator" props="label"}
:::html{id="calc" height=90}
<p id="out">{{label}}</p>
:::
::
`;

const PAGE = `# Pricing

::pricing_card{id="plan-team" plan="Team" price="$8" class="tone-accent"}
:::slot{name="features"}
- Unlimited spaces
:::
::

::calculator{id="roi" label="ROI"}
::
`;

interface PageResponse {
  id: string;
  componentKit: string;
  diagnostics: Array<{ code: string; severity: string }>;
}

test("a space's kit page provides components to every page in the space", async () => {
  const harness = await startCloudServer("noma-components-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada");
    const bob = await createCloudUser(base, "Bob");
    const kit = await json<PageResponse>(`${base}/api/documents`, { method: "POST", token: ada.token, body: { title: "Kit", source: KIT } });
    const page = await json<PageResponse>(`${base}/api/documents`, { method: "POST", token: ada.token, body: { title: "Pricing", source: PAGE } });
    const outsider = await json<PageResponse>(`${base}/api/documents`, { method: "POST", token: ada.token, body: { title: "Elsewhere", source: "# Elsewhere\n" } });
    const space = await json<{ id: string; kitDocumentId: string | null }>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Marketing", documentIds: [kit.id, page.id] } });
    assert.equal(space.kitDocumentId, null);

    await jsonStatus(`${base}/api/sites/${space.id}`, 400, { method: "PUT", token: ada.token, body: { title: "Marketing", documentIds: [kit.id, page.id], kitDocumentId: outsider.id } });
    await json(`${base}/api/sites/${space.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    await jsonStatus(`${base}/api/sites/${space.id}`, 403, { method: "PUT", token: bob.token, body: { title: "Marketing", documentIds: [kit.id, page.id], kitDocumentId: kit.id } });
    const updated = await json<{ kitDocumentId: string }>(`${base}/api/sites/${space.id}`, { method: "PUT", token: ada.token, body: { title: "Marketing", documentIds: [kit.id, page.id], kitDocumentId: kit.id } });
    assert.equal(updated.kitDocumentId, kit.id);

    const reloaded = await json<PageResponse>(`${base}/api/documents/${page.id}`, { token: ada.token });
    assert.match(reloaded.componentKit, /::component\{name="pricing_card" props="plan,price" slots="features"\}/);
    assert.doesNotMatch(reloaded.componentKit, /Internal pricing notes/, "only definitions leave the kit page");
    assert.deepEqual(reloaded.diagnostics.filter((d) => d.code.startsWith("component-")), []);

    const html = await (await request(`${base}/d/${page.id}`, { token: ada.token })).text();
    assert.match(html, /<article class="noma-card n-elevated n-tone-accent" id="plan-team">/);
    assert.match(html, /Unlimited spaces/);
    const widgetSrc = /<iframe class="noma-widget" data-kind="html" id="roi" src="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    assert.ok(widgetSrc, "a widget inside a component renders as a sandboxed frame");
    const widget = await request(`${base}${widgetSrc}`);
    assert.equal(widget.status, 200);
    assert.match(await widget.text(), /<p id="out">ROI<\/p>/);

    const markdown = await (await request(`${base}/api/documents/${page.id}/export?to=markdown`, { token: ada.token })).text();
    assert.match(markdown, /Team/);
    assert.doesNotMatch(markdown, /\{\{plan\}\}/);
    const presenter = await (await request(`${base}/d/${page.id}/present`, { token: ada.token })).text();
    assert.match(presenter, /id="plan-team"/);
    const site = await (await request(`${base}/s/${space.id}`, { token: ada.token })).text();
    assert.match(site, /id="plan-team"/);

    await json(`${base}/api/documents/${page.id}`, { method: "PUT", token: ada.token, body: { title: "Pricing", source: `${PAGE}\n::pricing_card{id="broken" plan="Pro"}\n::\n`, expectedHash: (await json<{ hash: string }>(`${base}/api/documents/${page.id}`, { token: ada.token })).hash } });
    const broken = await json<PageResponse>(`${base}/api/documents/${page.id}`, { token: ada.token });
    assert.ok(broken.diagnostics.some((d) => d.code === "component-missing-prop" && d.severity === "error"));
  } finally {
    await harness.close();
  }
});

test("a viewer who cannot open the kit page still gets its components, and nothing else", async () => {
  const harness = await startCloudServer("noma-components-restricted-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada");
    const carol = await createCloudUser(base, "Carol");
    const kit = await json<PageResponse>(`${base}/api/documents`, { method: "POST", token: ada.token, body: { title: "Kit", source: KIT } });
    const page = await json<PageResponse>(`${base}/api/documents`, { method: "POST", token: ada.token, body: { title: "Pricing", source: PAGE } });
    const space = await json<{ id: string }>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Marketing", documentIds: [kit.id, page.id], kitDocumentId: kit.id } });
    assert.ok(space.id);
    await json(`${base}/api/documents/${page.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: carol.id, role: "viewer" } });

    assert.equal((await request(`${base}/api/documents/${kit.id}`, { token: carol.token })).status, 403);
    const seen = await json<PageResponse>(`${base}/api/documents/${page.id}`, { token: carol.token });
    assert.match(seen.componentKit, /pricing_card/);
    assert.doesNotMatch(seen.componentKit, /Internal pricing notes/);
    const html = await (await request(`${base}/d/${page.id}`, { token: carol.token })).text();
    assert.match(html, /id="plan-team"/);
    assert.doesNotMatch(html, /Internal pricing notes/);
  } finally {
    await harness.close();
  }
});
