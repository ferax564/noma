import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { createNomaCloudServer } from "../src/cloud-server.js";

test("cloud UI workspace admin: overview, DLP policy, and audit export for admins only", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noma-admin-ui-"));
  const server = createNomaCloudServer({ dataDir: join(root, "documents"), publicDir: resolve("site"), ai: { provider: null, maintenanceTickMs: 0 }, queueIntervalMs: 0, siem: null });
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
  const ada = await api("/api/users", undefined, "POST", { name: "Ada Admin" });
  const bob = await api("/api/users", undefined, "POST", { name: "Bob Builder" });
  const site = await api("/api/sites", ada.token, "POST", { title: "Delivery", documentIds: [] });
  await api(`/api/sites/${site.id}/collaborators`, ada.token, "POST", { userId: bob.id, role: "editor" });
  await api(`/api/sites/${site.id}/documents`, ada.token, "POST", { source: "# Plan\n" });

  const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const errors: string[] = [];
  const open = async (token: string): Promise<Page> => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/fonts|rsms|ERR_TUNNEL_CONNECTION_FAILED/.test(message.text())) errors.push(message.text());
    });
    await page.goto(`${origin}/cloud.html`, { waitUntil: "load" });
    await page.locator("#cloudUserToken").fill(token);
    await page.locator("#loginUserButton").click();
    await waitForText(page, "#cloudStatus", "Logged in");
    await page.goto(`${origin}/cloud.html?site=${site.id}`, { waitUntil: "load" });
    return page;
  };

  const admin = await open(ada.token);
  await admin.waitForFunction(() => !document.querySelector("#workspaceAdminSection")?.hasAttribute("hidden"), { timeout: 10_000 });
  await admin.$eval("#workspaceAdminDetails", (details) => ((details as HTMLDetailsElement).open = true));
  await waitForText(admin, "#workspaceOverview", "People");
  assert.match(await text(admin, "#workspaceOverview"), /Spaces · pages1 · 1/);
  assert.match(await text(admin, "#siemSummary"), /No SIEM configured/);
  assert.equal(await admin.$eval("#siemShipButton", (button) => (button as HTMLButtonElement).disabled), true);
  await admin.select("#dlpModeSelect", "block");
  await admin.$eval("#dlpSaveButton", (button) => (button as HTMLButtonElement).click());
  await waitForText(admin, "#workspaceAdminStatus", "blocking secrets");
  assert.equal((await api<{ mode: string }>("/api/enterprise/dlp", ada.token)).mode, "block");
  const download = await admin.evaluate(async () => {
    const response = await fetch((document.querySelector("#auditDownloadLink") as HTMLAnchorElement).href, { credentials: "same-origin" });
    return { status: response.status, type: response.headers.get("content-type"), text: await response.text() };
  });
  assert.equal(download.status, 200);
  assert.match(download.text, /"action":"dlp.policy_updated"/);
  if (process.env.NOMA_SCREENSHOT_DIR) {
    await admin.$eval("#workspaceAdminSection", (element) => element.scrollIntoView({ block: "center" }));
    const clip = await admin.$eval("#workspaceAdminSection", (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x - 8, y: Math.max(0, rect.y - 8), width: rect.width + 16, height: rect.height + 16 };
    });
    await admin.screenshot({ path: join(process.env.NOMA_SCREENSHOT_DIR, "workspace-admin.png"), clip, captureBeyondViewport: false });
  }

  const member = await open(bob.token);
  await waitForText(member, "#approvalQueueList", "Nothing is waiting");
  assert.equal(await member.$eval("#workspaceAdminSection", (element) => element.hasAttribute("hidden")), true, "non-admins never see the admin section");
  assert.deepEqual(errors, []);
});

async function text(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (element) => element.textContent ?? "");
}

async function waitForText(page: Page, selector: string, expected: string): Promise<void> {
  try {
    await page.waitForFunction((sel, value) => document.querySelector(sel)?.textContent?.includes(value), { timeout: 10_000 }, selector, expected);
  } catch {
    assert.fail(`${selector} never showed "${expected}"; it shows "${await text(page, selector).catch(() => "<missing>")}"`);
  }
}
