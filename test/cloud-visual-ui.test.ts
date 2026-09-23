import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { createNomaCloudServer } from "../src/cloud-server.js";

interface BrowserSession {
  id: string;
  name: string;
  token: string;
}

interface CloudDocument {
  id: string;
  source: string;
  hash: string;
}

async function isolateFonts(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith("https://rsms.me/")) void request.respond({ status: 200, contentType: "text/css", body: "" });
    else void request.continue();
  });
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function waitForText(page: Page, selector: string, expected: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    (nextSelector, nextExpected) => document.querySelector(nextSelector)?.textContent?.includes(nextExpected),
    { timeout },
    selector,
    expected,
  );
}

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  const body = await response.text();
  assert.equal(response.ok, true, `${response.status} ${body}`);
  return JSON.parse(body) as T;
}

async function typeAtEndOf(page: Page, selector: string, text: string): Promise<void> {
  await page.evaluate((target) => {
    const element = document.querySelector<HTMLElement>(target);
    if (!element) throw new Error(`missing ${target}`);
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    (element.closest(".ProseMirror") as HTMLElement | null)?.focus();
  }, selector);
  await page.keyboard.type(text, { delay: 5 });
}

test("two browsers co-edit one page in Visual mode and see each other's edits and presence", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-visual-ui-"));
  const server = createNomaCloudServer({
    dataDir: join(root, "documents"),
    publicDir: resolve("site"),
    rateLimitMaxRequests: 10_000,
    collab: { checkpointIntervalMs: 60_000 },
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    await rm(root, { recursive: true, force: true });
  });

  const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());

  const alice = await browser.newPage();
  await isolateFonts(alice);
  const aliceErrors = collectErrors(alice);
  await alice.goto(`${origin}/cloud.html`, { waitUntil: "networkidle0" });
  await alice.locator("#cloudUserName").fill("Alice Visual");
  await alice.locator("#newUserButton").click();
  await waitForText(alice, "#cloudStatus", "Created user");
  assert.equal(await alice.$eval("#visualViewButton", (button) => button.getAttribute("aria-pressed")), "true", "Visual is the default mode for new users");
  await waitForText(alice, "#visualLiveBadge", "live");
  const documentId = new URL(alice.url()).searchParams.get("doc");
  assert.ok(documentId);
  const aliceSession = await sessionToken(alice);

  const bob = await requestJson<BrowserSession>(`${origin}/api/users`, aliceSession.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Bob Remote" }),
  });
  await requestJson(`${origin}/api/documents/${documentId}/collaborators`, aliceSession.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: bob.id, role: "editor" }),
  });

  const bobContext = await browser.createBrowserContext();
  const bobPage = await bobContext.newPage();
  await isolateFonts(bobPage);
  const bobErrors = collectErrors(bobPage);
  await bobPage.goto(`${origin}/cloud.html`, { waitUntil: "networkidle0" });
  await bobPage.locator("#cloudUserToken").fill(bob.token);
  await bobPage.locator("#loginUserButton").click();
  await waitForText(bobPage, "#cloudStatus", "Logged in");
  await bobPage.evaluate(() => localStorage.removeItem("noma.cloud.activeSite.v1"));
  await bobPage.goto(`${origin}/cloud.html?doc=${documentId}`, { waitUntil: "networkidle0" });
  await waitForText(bobPage, "#visualLiveBadge", "live");

  await alice.waitForFunction(() => document.querySelectorAll("#visualPresence .visual-avatar").length === 2, { timeout: 10_000 });
  await bobPage.waitForFunction(() => document.querySelectorAll("#visualPresence .visual-avatar").length === 2, { timeout: 10_000 });
  const bobSees = await bobPage.$$eval("#visualPresence .visual-avatar", (avatars) => avatars.map((avatar) => avatar.getAttribute("title") ?? ""));
  assert.ok(bobSees.some((title) => title.startsWith("Alice Visual")), `Bob sees ${bobSees.join(", ")}`);

  await typeAtEndOf(alice, ".visual-editor-surface > p:last-of-type", " Typed live by Alice.");
  await waitForText(bobPage, ".visual-editor-surface", "Typed live by Alice.");
  await bobPage.waitForFunction(() => Array.from(document.querySelectorAll(".ProseMirror-yjs-cursor")).some((cursor) => cursor.textContent?.includes("Alice Visual")), { timeout: 10_000 });

  await typeAtEndOf(bobPage, ".visual-editor-surface > h1", " (co-edited)");
  await waitForText(alice, ".visual-editor-surface h1", "(co-edited)");

  await alice.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("#sourceInput")?.value ?? "").includes("Typed live by Alice.") && (document.querySelector<HTMLTextAreaElement>("#sourceInput")?.value ?? "").includes("(co-edited)"), { timeout: 10_000 });
  const aliceSource = await alice.$eval("#sourceInput", (input) => (input as HTMLTextAreaElement).value);
  assert.match(aliceSource, /^# .*\(co-edited\)/m);

  await alice.locator("#sourceViewButton").click();
  assert.equal(await alice.$eval("#sourceInput", (input) => (input as HTMLTextAreaElement).value), aliceSource, "Source mode shows the exact derived source");
  await waitForText(alice, "#visualLiveBadge", "");
  await bobPage.waitForFunction(() => document.querySelectorAll("#visualPresence .visual-avatar").length === 1, { timeout: 10_000 });

  await bobPage.close();
  await bobContext.close();
  await until(async () => {
    const stored = await requestJson<CloudDocument>(`${origin}/api/documents/${documentId}`, aliceSession.token);
    return stored.source.includes("Typed live by Alice.") && stored.source.includes("(co-edited)");
  }, "checkpoint on last disconnect");

  const stored = await requestJson<CloudDocument>(`${origin}/api/documents/${documentId}`, aliceSession.token);
  assert.equal(stored.source, aliceSource, "the checkpointed revision is exactly the source the editor showed");
  assert.deepEqual(aliceErrors, []);
  assert.deepEqual(bobErrors, []);
});

test("visual mode inserts blocks from the slash menu and markdown shortcuts without a live connection", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-visual-local-"));
  const server = createNomaCloudServer({ dataDir: join(root, "documents"), publicDir: resolve("site"), rateLimitMaxRequests: 10_000 });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    await rm(root, { recursive: true, force: true });
  });
  const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await isolateFonts(page);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().includes("/api/collab/")) void request.abort();
  });
  const errors = collectErrors(page);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, "WebSocket", { value: undefined, configurable: true });
  });
  await page.goto(`${origin}/cloud.html`, { waitUntil: "networkidle0" });
  await page.locator("#cloudUserName").fill("Solo Visual");
  await page.locator("#newUserButton").click();
  await waitForText(page, "#cloudStatus", "Created user");
  await waitForText(page, "#visualLiveBadge", "local");

  await typeAtEndOf(page, ".visual-editor-surface > p:last-of-type", "");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/deci");
  await page.waitForSelector(".visual-slash-menu [data-slash-id='decision']");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Adopt the visual editor.");
  await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("#sourceInput")?.value ?? "").includes("::decision{id=\"decision-1\" status=\"proposed\"}\nAdopt the visual editor.\n::"), { timeout: 10_000 });

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## Shortcut heading");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[] first task");
  await page.waitForFunction(() => {
    const source = document.querySelector<HTMLTextAreaElement>("#sourceInput")?.value ?? "";
    return source.includes("## Shortcut heading") && source.includes("- [ ] first task");
  }, { timeout: 10_000 });
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/html", "<h2>Pasted Section</h2><p>Hello <b>world</b> and <a href=\"javascript:alert(1)\">bad link</a></p><script>window.pwned = true</script><ul><li>one</li><li>two</li></ul>");
    data.setData("text/plain", "Pasted Section");
    document.querySelector(".visual-editor-surface")?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>("#sourceInput")?.value ?? "").includes("- two"), { timeout: 10_000 });
  const pasted = await page.$eval("#sourceInput", (input) => (input as HTMLTextAreaElement).value);
  assert.match(pasted, /## Pasted Section \{id="pasted-section"\}\n\nHello \*\*world\*\* and \[bad link\]\(#\)\n\n- one\n- two/);
  assert.equal(await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned), undefined);
  assert.equal(await page.$eval("#dirtyBadge", (badge) => badge.textContent), "unsaved");
  const saveModifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(saveModifier);
  await page.keyboard.press("s");
  await page.keyboard.up(saveModifier);
  await waitForText(page, "#cloudStatus", "Saved page");
  const documentId = new URL(page.url()).searchParams.get("doc");
  const session = await sessionToken(page);
  const stored = await requestJson<CloudDocument>(`${origin}/api/documents/${documentId}`, session.token);
  assert.match(stored.source, /::decision\{id="decision-1" status="proposed"\}\nAdopt the visual editor\.\n::/);
  assert.match(stored.source, /## Shortcut heading\n\n- \{#task-[a-z0-9]{8}\} \[ \] first task/, "saving gives the new checkbox task a stable ID");
  assert.deepEqual(errors, []);
});

async function until(predicate: () => Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

/** Mints a personal access token through the page's cookie session so the test can call the API directly. */
async function sessionToken(page: Page): Promise<BrowserSession> {
  return page.evaluate(async () => {
    const csrf = /(?:^|;\s*)noma_csrf=([^;]+)/.exec(document.cookie)?.[1];
    if (!csrf) throw new Error("Cloud session CSRF cookie was not set");
    const me = (await (await fetch("/api/users/me")).json()) as { id: string; name: string };
    const created = await fetch("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-noma-csrf": decodeURIComponent(csrf) },
      body: JSON.stringify({ name: "Visual UI test", scopes: ["read", "write"] }),
    });
    if (!created.ok) throw new Error(`Could not create a personal access token: ${created.status}`);
    const pat = (await created.json()) as { token: string };
    return { id: me.id, name: me.name, token: pat.token };
  });
}
