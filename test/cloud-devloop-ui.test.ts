import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { FakeRunProvider } from "../src/cloud/run-provider.js";
import { createNomaCloudServer } from "../src/cloud-server.js";

test("cloud UI Work → Code & runs: repo setup, pull requests, and runs from the panel", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noma-devloop-ui-"));
  const provider = new FakeRunProvider();
  const server = createNomaCloudServer({ dataDir: join(root, "documents"), publicDir: resolve("site"), ai: { provider: null, maintenanceTickMs: 0 }, runProvider: provider, queueIntervalMs: 0 });
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
  const site = await api("/api/sites", ada.token, "POST", { title: "Delivery", documentIds: [] });
  const project = await api("/api/projects", ada.token, "POST", { siteId: site.id, key: "SHIP", name: "Ship it" });
  await api(`/api/projects/${project.id}/issues`, ada.token, "POST", { summary: "Checkout flow" });
  const repo = await api<{ webhookSecret: string }>(`/api/projects/${project.id}/repo`, ada.token, "PUT", { repo: "acme/shop", runsEnabled: true });
  const payload = JSON.stringify({
    action: "opened",
    repository: { full_name: "acme/shop" },
    pull_request: { number: 7, title: "SHIP-1 checkout", html_url: "https://github.com/acme/shop/pull/7", head: { ref: "feature/SHIP-1", sha: "abc" }, user: { login: "octocat" } },
  });
  const hook = await fetch(`${origin}/api/hooks/github/${project.id}`, {
    method: "POST",
    headers: { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", repo.webhookSecret).update(payload).digest("hex")}` },
    body: payload,
  });
  assert.equal(hook.status, 202);

  const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/cloud.html`, { waitUntil: "load" });
  await page.locator("#cloudUserToken").fill(ada.token);
  await page.locator("#loginUserButton").click();
  await waitForText(page, "#cloudStatus", "Logged in");
  await page.goto(`${origin}/cloud.html?site=${site.id}`, { waitUntil: "load" });
  await waitForText(page, "#devLoopRepo", "acme/shop");
  assert.match(await text(page, "#devLoopEnv"), /runs on fake/);
  assert.match(await text(page, "#devHookInfo"), new RegExp(`/api/hooks/github/${project.id}`));
  assert.match(await text(page, "#devHookInfo"), new RegExp(repo.webhookSecret));
  assert.match(await text(page, "#devPullList"), /#7 SHIP-1 checkout/);

  await page.$eval("#devRunRefInput", (input) => {
    (input as HTMLInputElement).value = "feature/SHIP-1";
  });
  await page.$eval("#devRunButton", (button) => (button as HTMLButtonElement).click());
  await waitForText(page, "#devRunList", "Deploy feature/SHIP-1");
  assert.equal(provider.started.at(-1)?.ref, "feature/SHIP-1");
  provider.finish("ship-feature-ship-1", { status: "success" });
  await page.$eval("#refreshWorkButton", (button) => (button as HTMLButtonElement).click());
  await waitForText(page, "#devRunList", "Open preview");
  await page.$eval("#devLoopSection", (section) => section.scrollIntoView({ block: "center" }));
  if (process.env.NOMA_SCREENSHOT_DIR) {
    const box = await page.$eval("#devLoopSection", (section) => {
      const rect = section.getBoundingClientRect();
      return { x: rect.x - 8, y: rect.y - 8, width: rect.width + 16, height: rect.height + 16 };
    });
    await page.screenshot({ path: join(process.env.NOMA_SCREENSHOT_DIR, "devloop-panel.png"), clip: box, captureBeyondViewport: false });
  }
  assert.deepEqual(pageErrors, []);
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
