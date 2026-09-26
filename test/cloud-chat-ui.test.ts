import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { createNomaCloudServer } from "../src/cloud-server.js";

test("cloud UI chat: threads, agent replies, live updates, and chat → issue/page", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noma-chat-ui-"));
  const server = createNomaCloudServer({ dataDir: join(root, "documents"), publicDir: resolve("site"), ai: { provider: null, maintenanceTickMs: 0 } });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    await rm(root, { recursive: true, force: true });
  });
  const api = async <T = Record<string, string>>(path: string, token: string | undefined, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(origin + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const payload = (await response.json()) as T;
    assert.ok(response.ok, `${path} ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };

  const ada = await api("/api/users", undefined, "POST", { name: "Ada Lovelace" });
  const bob = await api("/api/users", undefined, "POST", { name: "Bob Builder" });
  const site = await api("/api/sites", ada.token, "POST", { title: "Delivery", documentIds: [] });
  await api(`/api/sites/${site.id}/documents`, ada.token, "POST", { source: "# Release plan\n\nShip it.\n" });
  await api(`/api/sites/${site.id}/collaborators`, ada.token, "POST", { userId: bob.id, role: "editor" });
  const project = await api("/api/projects", ada.token, "POST", { siteId: site.id, key: "SHIP", name: "Ship it" });
  const agent = await api("/api/agents", bob.token, "POST", { name: "Test Runner", capabilities: ["chat"] });
  await api(`/api/agents/${agent.id}/access`, bob.token, "POST", { resourceType: "site", resourceId: site.id, role: "viewer" });
  const channel = await api("/api/channels", ada.token, "POST", { siteId: site.id, name: "release-train", topic: "Everything shipping next", projectId: project.id });
  const root1 = await api(`/api/channels/${channel.id}/messages`, bob.token, "POST", { body: "Login fails on Safari after the SSO redirect" });
  await api("/api/gateway/mcp", bob.token, "POST", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "chat_post", arguments: { agentId: agent.id, channelId: channel.id, threadId: root1.id, body: "e2e: 41 passed, 1 failed" } },
  });

  const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/cloud.html`, { waitUntil: "load" });
  await page.locator("#cloudUserToken").fill(ada.token);
  await page.locator("#loginUserButton").click();
  await waitForText(page, "#cloudStatus", "Logged in");
  await page.goto(`${origin}/cloud.html?site=${site.id}`, { waitUntil: "load" });
  await waitForText(page, "#chatLauncherList", "#release-train");
  assert.equal(await page.$eval("#chatDrawer", (element) => element.hasAttribute("hidden")), true, "the drawer starts closed");
  await page.locator("#openChatButton").click();
  await waitForText(page, "#chatMessages", "Login fails on Safari");
  assert.equal(await text(page, "#chatChannelTitle"), "#release-train");
  assert.match(await text(page, "#chatChannelMeta"), /Everything shipping next · Project SHIP/);
  assert.match(await text(page, "#chatAgentChips"), /Test Runner/);

  await page.locator("#chatComposerInput").fill("Release notes <img src=x onerror=alert(1)> at https://example.com/notes");
  await page.keyboard.press("Enter");
  await waitForText(page, "#chatMessages", "Release notes");
  assert.equal(await page.$$eval("#chatMessages img", (images) => images.length), 0, "message bodies render as text");
  assert.deepEqual(await page.$$eval("#chatMessages a", (links) => links.map((link) => link.getAttribute("href"))), ["https://example.com/notes"]);

  await page.evaluate(() => (document.querySelector("#chatMessages .chat-replies") as HTMLButtonElement).click());
  await waitForText(page, "#chatThreadMessages", "41 passed");
  assert.match(await text(page, "#chatThreadMessages"), /Test Runner\s*Agent/);
  await page.locator("#chatThreadInput").fill("I'll take the Safari fix.");
  await page.keyboard.press("Enter");
  await waitForText(page, "#chatThreadMessages", "Safari fix");
  await api(`/api/channels/${channel.id}/messages`, bob.token, "POST", { body: "Pairing after lunch", threadId: root1.id });
  await waitForText(page, "#chatThreadMessages", "Pairing after lunch");
  await waitForText(page, "#chatThreadLabel", "3 replies");

  await clickRootAction(page, "Create a Work issue from this message");
  await waitForText(page, "#chatStatus", "Created SHIP-1");
  await clickRootAction(page, "Save this thread as a .noma page");
  await waitForText(page, "#chatStatus", "Saved thread as");
  await waitForText(page, "#chatThreadMessages", "saved this thread as the page");
  await page.locator("#chatCloseThreadButton").click();
  await waitForText(page, "#chatMessages", "3 replies");

  await page.locator("#chatSearchInput").fill("Safari fix");
  await waitForText(page, "#chatMessages", "Results for");
  await page.locator("#chatSearchInput").fill("");
  await page.locator("#chatNewChannelToggle").click();
  await page.locator("#chatNewNameInput").fill("Incident Review");
  await page.locator("#chatCreateChannelButton").click();
  await waitForText(page, "#chatChannelTitle", "#incident-review");
  await waitForText(page, "#chatChannelList", "#incident-review");

  await page.focus("#chatComposerInput");
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#chatDrawer", (element) => element.hasAttribute("hidden")), true, "Escape closes the drawer");
  assert.deepEqual(pageErrors, []);
});

async function clickRootAction(page: Page, label: string): Promise<void> {
  const selector = `#chatThreadMessages .chat-message[data-root="true"] .chat-actions button[aria-label="${label}"]`;
  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.$eval(selector, (button) => (button as HTMLButtonElement).click());
}

async function text(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (element) => element.textContent ?? "");
}

async function waitForText(page: Page, selector: string, expected: string): Promise<void> {
  await page.waitForFunction((nextSelector, nextExpected) => document.querySelector(nextSelector)?.textContent?.includes(nextExpected), { timeout: 10_000 }, selector, expected);
}
