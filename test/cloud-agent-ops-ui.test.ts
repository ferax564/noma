import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { FakeRunProvider } from "../src/cloud/run-provider.js";
import { createNomaCloudServer } from "../src/cloud-server.js";
import { FakeLlmProvider } from "../src/cloud-llm.js";

test("cloud UI approvals: agent run approval, kill switch, and hosted-agent settings", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noma-agent-ops-ui-"));
  const provider = new FakeRunProvider();
  const server = createNomaCloudServer({
    dataDir: join(root, "documents"),
    publicDir: resolve("site"),
    ai: { provider: new FakeLlmProvider(() => "ok"), maintenanceTickMs: 0 },
    runProvider: provider,
    queueIntervalMs: 0,
  });
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
  await api("/api/enterprise", ada.token, "PUT", { connectorAllowlist: ["github"], modelAllowlist: ["fake-model"] });
  const site = await api("/api/sites", ada.token, "POST", { title: "Delivery", documentIds: [] });
  await api(`/api/sites/${site.id}/collaborators`, ada.token, "POST", { userId: bob.id, role: "editor" });
  const project = await api("/api/projects", ada.token, "POST", { siteId: site.id, key: "SHIP", name: "Shop" });
  await api(`/api/channels`, ada.token, "POST", { siteId: site.id, name: "shop", projectId: project.id });
  await api(`/api/projects/${project.id}/repo`, ada.token, "PUT", { repo: "acme/shop", runsEnabled: true });
  const agent = await api("/api/agents", bob.token, "POST", { name: "Release Bot", capabilities: ["chat", "run"], modelPolicy: { model: "fake-model" } });
  await api(`/api/agents/${agent.id}/access`, bob.token, "POST", { resourceType: "site", resourceId: site.id, role: "viewer" });
  await api("/api/gateway/mcp", bob.token, "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_request", arguments: { agentId: agent.id, projectId: project.id, kind: "deploy", ref: "feature/SHIP-1" } } });
  const own = await api("/api/agents", ada.token, "POST", { name: "Triage Bot", capabilities: ["chat"], modelPolicy: { model: "fake-model" } });
  await api(`/api/agents/${own.id}/access`, ada.token, "POST", { resourceType: "site", resourceId: site.id, role: "viewer" });

  const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept("incident drill"));
  await page.goto(`${origin}/cloud.html`, { waitUntil: "load" });
  await page.locator("#cloudUserToken").fill(ada.token);
  await page.locator("#loginUserButton").click();
  await waitForText(page, "#cloudStatus", "Logged in");
  await page.goto(`${origin}/cloud.html?site=${site.id}`, { waitUntil: "load" });
  await waitForText(page, "#approvalQueueList", "Run · Deploy feature/SHIP-1");
  assert.match(await text(page, "#approvalQueueList"), /asked by Release Bot/);
  assert.equal(await page.$eval("#agentKillSwitch", (element) => element.hasAttribute("hidden")), false, "admins see the kill switch");
  await shot(page, "#approvalsSection", "approvals-pending.png");

  await page.$eval("#approvalQueueList button", (button) => (button as HTMLButtonElement).click());
  await waitForText(page, "#approvalQueueStatus", "Approved — feature/SHIP-1 is running");
  assert.equal(provider.started[0]?.ref, "feature/SHIP-1");
  await waitForText(page, "#approvalQueueList", "Nothing is waiting for you");

  await page.$eval("#agentKillSwitchButton", (button) => (button as HTMLButtonElement).click());
  await waitForText(page, "#agentKillSwitchState", "Agents paused — incident drill");
  await shot(page, "#approvalsSection", "approvals-paused.png");
  await page.$eval("#agentKillSwitchButton", (button) => (button as HTMLButtonElement).click());
  await waitForText(page, "#agentKillSwitchState", "Agents running");

  await page.$eval("#myAgentsDetails", (details) => ((details as HTMLDetailsElement).open = true));
  await waitForText(page, "#myAgentSelect", "Triage Bot");
  await page.$eval("#agentHostedInput", (input) => ((input as HTMLInputElement).checked = true));
  await page.$eval("#agentInstructionsInput", (input) => ((input as HTMLTextAreaElement).value = "Triage new bugs."));
  await page.$eval("#agentHostingSaveButton", (button) => (button as HTMLButtonElement).click());
  await waitForText(page, "#myAgentsStatus", "Hosted");
  await page.$eval("#agentScheduleTitleInput", (input) => ((input as HTMLInputElement).value = "Morning triage"));
  await page.$eval("#agentSchedulePromptInput", (input) => ((input as HTMLTextAreaElement).value = "List new bugs."));
  await page.$eval("#agentScheduleAddButton", (button) => (button as HTMLButtonElement).click());
  await waitForText(page, "#agentScheduleList", "Morning triage → #shop");
  const hosting = await api<{ enabled: boolean; instructions: string }>(`/api/agents/${own.id}/hosting`, ada.token);
  assert.deepEqual([hosting.enabled, hosting.instructions], [true, "Triage new bugs."]);
  await shot(page, "#myAgentsSection", "my-agents.png");
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

async function shot(page: Page, selector: string, name: string): Promise<void> {
  if (!process.env.NOMA_SCREENSHOT_DIR) return;
  await page.$eval(selector, (element) => element.scrollIntoView({ block: "center" }));
  const clip = await page.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x - 8, y: Math.max(0, rect.y - 8), width: rect.width + 16, height: rect.height + 16 };
  });
  await page.screenshot({ path: join(process.env.NOMA_SCREENSHOT_DIR, name), clip, captureBeyondViewport: false });
}
