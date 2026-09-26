import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer";
import { createNomaCloudServer } from "../src/cloud-server.js";
import { createZip } from "../src/zip.js";

test("cloud UI imports a Slack export into the space and Jira issues into a project", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noma-switch-ui-"));
  const server = createNomaCloudServer({ dataDir: join(root, "documents"), publicDir: resolve("site"), ai: { provider: null, maintenanceTickMs: 0 }, queueIntervalMs: 0, slack: null });
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
  const site = await api("/api/sites", ada.token, "POST", { title: "Delivery", documentIds: [] });
  await api("/api/projects", ada.token, "POST", { siteId: site.id, key: "SHOP", name: "Shop" });

  const slackZip = join(root, "slack.zip");
  await writeFile(
    slackZip,
    createZip([
      { path: "users.json", data: JSON.stringify([{ id: "U1", name: "sam", profile: { real_name: "Sam Slack" } }]) },
      { path: "channels.json", data: JSON.stringify([{ id: "C1", name: "launch" }]) },
      { path: "launch/2026-01-01.json", data: JSON.stringify([{ type: "message", user: "U1", text: "We ship Friday", ts: "1767225600.000100" }]) },
    ]),
  );
  const jiraJson = join(root, "jira.json");
  await writeFile(jiraJson, JSON.stringify({ issues: [{ key: "OLD-1", fields: { summary: "Imported from Jira", issuetype: { name: "Task" }, status: { name: "To Do" } } }] }));

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
  await waitForText(page, "#workProjectSelect", "Shop");

  await ((await page.$("#slackImportInput")) as ElementHandle<HTMLInputElement>).uploadFile(slackZip);
  await waitForText(page, "#chatStatus", "Imported 1 messages (0 in threads) into 1 channels");
  await waitForText(page, "#chatLauncherList", "#launch");

  await ((await page.$("#jiraImportInput")) as ElementHandle<HTMLInputElement>).uploadFile(jiraJson);
  await waitForText(page, "#workStatus", "Imported 1 issues");
  await waitForText(page, "#workBoard", "Imported from Jira");
  assert.deepEqual(pageErrors, []);
});

async function waitForText(page: Page, selector: string, expected: string): Promise<void> {
  try {
    await page.waitForFunction((sel, value) => document.querySelector(sel)?.textContent?.includes(value), { timeout: 10_000 }, selector, expected);
  } catch {
    const actual = await page.$eval(selector, (element) => element.textContent ?? "").catch(() => "<missing>");
    assert.fail(`${selector} never showed "${expected}"; it shows "${actual}"`);
  }
}
