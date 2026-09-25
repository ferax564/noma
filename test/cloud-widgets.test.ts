import assert from "node:assert/strict";
import test from "node:test";
import puppeteer from "puppeteer";
import { createCloudUser, json, request, startCloudServer } from "./cloud-wiki-helpers.js";

interface CloudDocumentResponse {
  id: string;
}

const WIDGET_SOURCE = `# Widget page

::html{id="calc" height=120 title="Calculator"}
<p id="out">static</p>
<script>
document.getElementById("out").textContent = "ran:" + String(self.origin) + ":" + (function () { try { return document.cookie === "" ? "nocookie" : "cookie"; } catch (e) { return "nocookie"; } })();
</script>
::

::html
<p>no id</p>
::
`;

async function createPage(base: string, token: string, source: string): Promise<CloudDocumentResponse> {
  return json<CloudDocumentResponse>(`${base}/api/documents`, { method: "POST", token, body: { title: "Widget page", source } });
}

function widgetUrl(html: string): string {
  const match = /<iframe class="noma-widget" data-kind="html" id="calc" src="([^"]+)" sandbox="allow-scripts"/.exec(html);
  assert.ok(match, "page renders the widget as a sandboxed iframe");
  return match[1]!.replace(/&amp;/g, "&");
}

test("Cloud serves ::html blocks as signed, CSP-sandboxed widgets", async () => {
  const harness = await startCloudServer("noma-widgets-");
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const mallory = await createCloudUser(harness.base, "Mallory");
    const page = await createPage(harness.base, alice.token, WIDGET_SOURCE);

    const pageResponse = await request(`${harness.base}/d/${page.id}`, { token: alice.token });
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get("content-security-policy") ?? "", /frame-src 'self'/);
    const html = await pageResponse.text();
    const src = widgetUrl(html);
    assert.match(src, new RegExp(`^/api/documents/${page.id}/widgets/calc\\?exp=\\d+&p=u\\.${alice.id}&sig=`));
    assert.match(html, /style="width: 100%; height: 120px; border: 0;"/);
    assert.match(html, /\[add an id to this ::html block to run it as a sandboxed widget\]/);
    assert.doesNotMatch(html, /<script>\s*document\.getElementById/);

    const widget = await request(`${harness.base}${src}`);
    assert.equal(widget.status, 200);
    const csp = widget.headers.get("content-security-policy") ?? "";
    assert.match(csp, /sandbox allow-scripts/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /default-src 'none'/);
    assert.equal(widget.headers.get("x-frame-options"), null);
    assert.match(await widget.text(), /<p id="out">static<\/p>/);

    assert.equal((await request(`${harness.base}${src.replace(/sig=[^&]+/, "sig=" + "A".repeat(43))}`)).status, 403);
    assert.equal((await request(`${harness.base}/api/documents/${page.id}/widgets/calc`)).status, 401);
    assert.equal((await request(`${harness.base}/api/documents/${page.id}/widgets/calc`, { token: mallory.token })).status, 403);
    assert.equal((await request(`${harness.base}/api/documents/${page.id}/widgets/calc`, { token: alice.token })).status, 200);
    assert.equal((await request(`${harness.base}/api/documents/${page.id}/widgets/missing`, { token: alice.token })).status, 404);
  } finally {
    await harness.close();
  }
});

test("a widget's script runs in an opaque origin without cookies inside the published page", async () => {
  const harness = await startCloudServer("noma-widgets-browser-");
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const page = await createPage(harness.base, alice.token, WIDGET_SOURCE);
    const tab = await browser.newPage();
    await tab.setExtraHTTPHeaders({ authorization: `Bearer ${alice.token}` });
    await tab.goto(`${harness.base}/d/${page.id}`, { waitUntil: "networkidle0" });
    const frameHandle = await tab.waitForSelector("iframe.noma-widget");
    const frame = await frameHandle!.contentFrame();
    assert.ok(frame);
    await frame.waitForFunction(() => document.getElementById("out")?.textContent?.startsWith("ran:"), { timeout: 5000 });
    const text = await frame.$eval("#out", (el) => el.textContent);
    assert.equal(text, "ran:null:nocookie");
  } finally {
    await browser.close();
    await harness.close();
  }
});
