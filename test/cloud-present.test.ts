import assert from "node:assert/strict";
import test from "node:test";
import puppeteer from "puppeteer";
import { createCloudUser, json, request, startCloudServer } from "./cloud-wiki-helpers.js";

const HANDBOOK = `# Handbook

Welcome to the team.

## Setup

- Install Node
- Clone the repo

## Deploy

::html{id="status-widget" height=80}
<p id="w">widget</p>
::

## Support

Ask in #help.
`;

test("Cloud presents any page at /d/:id/present, including through share links", async () => {
  const harness = await startCloudServer("noma-present-");
  const { base } = harness;
  try {
    const alice = await createCloudUser(base, "Alice");
    const mallory = await createCloudUser(base, "Mallory");
    const page = await json<{ id: string }>(`${base}/api/documents`, { method: "POST", token: alice.token, body: { title: "Handbook", source: HANDBOOK } });

    const response = await request(`${base}/d/${page.id}/present`, { token: alice.token });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);
    const html = await response.text();
    assert.match(html, /<title>Handbook<\/title>/);
    assert.match(html, /data-from-sections="true"/);
    for (const id of ["handbook", "setup", "deploy", "support"]) assert.match(html, new RegExp(`class="noma-slide[^"]*" id="${id}"`));
    assert.match(html, /<span class="noma-presenter-counter" aria-live="polite">1 \/ 4<\/span>/);
    assert.match(html, new RegExp(`<a class="noma-presenter-exit" href="/cloud.html\\?doc=${page.id}">Exit</a>`));
    assert.match(html, /<iframe class="noma-widget" data-kind="html" id="status-widget" src="\/api\/documents\/[^"]+\/widgets\/status-widget\?exp=/);
    assert.match(html, /\.noma-presenter-stage/, "theme CSS is inlined");

    const page2 = await request(`${base}/d/${page.id}`, { token: alice.token });
    assert.match(await page2.text(), new RegExp(`<a href="/d/${page.id}/present">Present</a>`));

    assert.equal((await request(`${base}/d/${page.id}/present`)).status, 401);
    assert.equal((await request(`${base}/d/${page.id}/present`, { token: mallory.token })).status, 403);
    assert.equal((await request(`${base}/d/missing-page/present`, { token: alice.token })).status, 404);

    const share = await json<{ token: string }>(`${base}/api/documents/${page.id}/shares`, { method: "POST", token: alice.token, body: { role: "viewer" } });
    const shared = await request(`${base}/d/${page.id}/present?share=${encodeURIComponent(share.token)}`);
    assert.equal(shared.status, 200);
    assert.match(await shared.text(), new RegExp(`href="/d/${page.id}\\?share=${encodeURIComponent(share.token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">Exit</a>`));
    const sharedPage = await request(`${base}/d/${page.id}?share=${encodeURIComponent(share.token)}`);
    assert.match(await sharedPage.text(), /\/present\?share=/);
  } finally {
    await harness.close();
  }
});

test("the Cloud presenter navigates slides under the sandboxed page CSP", async () => {
  const harness = await startCloudServer("noma-present-browser-");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const page = await json<{ id: string }>(`${harness.base}/api/documents`, { method: "POST", token: alice.token, body: { title: "Handbook", source: HANDBOOK } });
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on("pageerror", (error) => errors.push(String(error)));
    await tab.setExtraHTTPHeaders({ authorization: `Bearer ${alice.token}` });
    await tab.goto(`${harness.base}/d/${page.id}/present#setup`, { waitUntil: "networkidle0" });
    const state = () => tab.evaluate(() => [document.querySelector(".noma-slide-current")?.id, document.querySelector(".noma-presenter-counter")?.textContent]);
    assert.deepEqual(await state(), ["setup", "2 / 4"]);
    await tab.keyboard.press("ArrowRight");
    assert.deepEqual(await state(), ["deploy", "3 / 4"]);
    await tab.click('[data-noma-present="prev"]');
    assert.deepEqual(await state(), ["setup", "2 / 4"]);
    await tab.keyboard.press("End");
    assert.deepEqual(await state(), ["support", "4 / 4"]);
    assert.equal(await tab.$eval('[data-noma-present="next"]', (el) => (el as HTMLButtonElement).disabled), true);
    await tab.keyboard.press("o");
    assert.equal(await tab.$eval(".noma-presenter", (el) => el.hasAttribute("data-overview")), true);
    await tab.click("#handbook");
    assert.deepEqual(await state(), ["handbook", "1 / 4"]);
    assert.equal(await tab.$eval(".noma-presenter", (el) => el.hasAttribute("data-overview")), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await harness.close();
  }
});
