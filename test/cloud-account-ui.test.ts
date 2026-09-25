import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { FakeLlmProvider } from "../src/cloud-llm.js";
import { createNomaCloudServer, type NomaCloudAiOptions } from "../src/cloud-server.js";

interface CloudUser {
  id: string;
  name: string;
  token: string;
}

interface TemplateResponse {
  id: string;
  name: string;
  description: string;
  source: string;
  variables: Array<{ name: string; label: string; required: boolean }>;
}

test("account security manages tokens and sessions; templates are edited and deleted; AI drafting reports unavailability", { timeout: 90_000 }, async (t) => {
  const { origin } = await startServer(t, "noma-cloud-account-ui-", { provider: null });
  const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await openCloudPage(browser, origin);
  const errors = collectErrors(page);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.locator("#cloudUserName").fill("Alice Security");
  await page.locator("#newUserButton").click();
  await waitForText(page, "#cloudStatus", "Created user");

  await page.locator("#copyUserTokenButton").click();
  await waitForText(page, "#securityTokenList", "No personal access tokens");
  await waitForText(page, "#securitySessionList", "this browser");
  assert.deepEqual(await page.$$eval("#securityTokenScopes input[data-scope]", (inputs) => inputs.map((input) => input.getAttribute("data-scope"))), ["read", "write", "admin"]);
  await page.locator("#securityTokenName").fill("Release bot");
  await page.select("#securityTokenExpiry", "30");
  await page.locator("#securityTokenCreateButton").click();
  await page.waitForFunction(() => (document.querySelector<HTMLInputElement>("#securityTokenSecretValue")?.value ?? "").startsWith("noma_pat_"), { timeout: 10_000 });
  const pat = await page.$eval("#securityTokenSecretValue", (input) => (input as HTMLInputElement).value);
  await waitForText(page, "#securityTokenList", "Release bot");
  assert.match(await text(page, "#securityTokenList"), /· read, writecreated .* · expires .* · never used/);
  assert.equal((await text(page, "#securityTokenList")).includes(pat), false, "the list shows only the preview");

  const listed = await requestJson<{ tokens: Array<{ name: string; scopes: string[]; expiresAt?: string }> }>(`${origin}/api/tokens`, pat);
  assert.deepEqual(listed.tokens.map((token) => [token.name, token.scopes]), [["Release bot", ["read", "write"]]]);
  assert.ok(listed.tokens[0]?.expiresAt, "the chosen expiry is sent");

  const laptop = await fetch(`${origin}/api/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "laptop-browser" },
    body: JSON.stringify({ userToken: pat }),
  });
  assert.equal(laptop.status, 200);
  const laptopCookie = laptop.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  assert.equal((await fetch(`${origin}/api/users/me`, { headers: { cookie: laptopCookie } })).status, 200);

  await page.locator("#securityCloseButton").click();
  await page.locator("#copyUserTokenButton").click();
  await waitForText(page, "#securitySessionList", "laptop-browser");
  assert.equal(await page.$$eval("#securitySessionList .collaboration-row", (rows) => rows.length), 2);
  assert.equal(await page.$$eval("#securitySessionList [data-current='true'] button", (buttons) => buttons.length), 0, "the current session cannot be revoked from the list");
  await page.locator("#securityRevokeOthersButton").click();
  await waitForText(page, "#securityStatus", "Signed out 1 other session");
  assert.equal(await page.$$eval("#securitySessionList .collaboration-row", (rows) => rows.length), 1);
  assert.equal((await fetch(`${origin}/api/users/me`, { headers: { cookie: laptopCookie } })).status, 401);

  await page.locator("#securityTokenList [data-token-id] button").click();
  await waitForText(page, "#securityStatus", "Revoked token Release bot");
  await waitForText(page, "#securityTokenList", "No personal access tokens");
  assert.equal((await fetch(`${origin}/api/users/me`, { headers: { authorization: `Bearer ${pat}` } })).status, 401);
  await page.locator("#securityCloseButton").click();

  const admin = await mintToken(page);
  const sites = await requestJson<{ sites: Array<{ id: string }> }>(`${origin}/api/sites`, admin);
  const siteId = sites.sites[0]!.id;
  const spaceTemplate = await requestJson<TemplateResponse>(`${origin}/api/templates`, admin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "site", siteId, name: "Runbook", description: "Service runbook", source: "# {{title}}\n\nOn-call steps.\n" }),
  });
  const workspaceTemplate = await requestJson<TemplateResponse>(`${origin}/api/templates`, admin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "workspace", name: "Retro", source: "# {{title}}\n\nWhat went well.\n" }),
  });

  await page.locator("#templateManageButton").click();
  await waitForText(page, "#templateManageList", "Retro");
  assert.match(await text(page, `#templateManageList [data-template-id="blank"]`), /read-only/);
  assert.equal(await page.$$eval(`#templateManageList [data-template-id="blank"] button`, (buttons) => buttons.length), 0, "built-ins are read-only");
  await clickButton(page, `#templateManageList [data-template-id="${spaceTemplate.id}"]`, "Edit");
  await page.waitForSelector("#templateEditDialog[open]");
  assert.equal(await page.$eval("#templateEditSource", (input) => (input as HTMLTextAreaElement).value), "# {{title}}\n\nOn-call steps.\n");
  await page.$eval("#templateEditName", (input) => ((input as HTMLInputElement).value = ""));
  await page.locator("#templateEditName").fill("Service runbook");
  await page.$eval("#templateEditSource", (input) => ((input as HTMLTextAreaElement).value = "# {{title}}\n\nOwner: {{owner}}\n\nOn-call steps.\n"));
  await page.locator("#templateEditSave").click();
  await waitForText(page, "#templateEditStatus", "undeclared variables: owner");
  await page.locator("#templateEditAddVariable").click();
  await page.locator('#templateEditVariables input[data-field="name"]').fill("owner");
  await page.locator('#templateEditVariables input[data-field="label"]').fill("Service owner");
  await page.locator('#templateEditVariables input[data-field="required"]').click();
  await page.locator("#templateEditSave").click();
  await waitForText(page, "#templateManageStatus", "Saved template “Service runbook”");
  const edited = await requestJson<TemplateResponse>(`${origin}/api/templates/${spaceTemplate.id}`, admin);
  assert.equal(edited.name, "Service runbook");
  assert.match(edited.source, /Owner: \{\{owner\}\}/);
  assert.deepEqual(edited.variables, [{ name: "owner", label: "Service owner", required: true }]);
  assert.ok(await page.$$eval("#pageTemplateSelect option", (options) => options.some((option) => option.textContent?.startsWith("Service runbook"))), "the page template picker refreshes");

  await clickButton(page, `#templateManageList [data-template-id="${workspaceTemplate.id}"]`, "Delete");
  await waitForText(page, "#templateManageStatus", "Deleted template “Retro”");
  assert.equal(await page.$$eval(`#templateManageList [data-template-id="${workspaceTemplate.id}"]`, (rows) => rows.length), 0);
  assert.equal((await fetch(`${origin}/api/templates/${workspaceTemplate.id}`, { headers: { authorization: `Bearer ${admin}` } })).status, 404);
  await page.locator("#templateManageClose").click();

  await page.locator("#aiDraftPageButton").click();
  await waitForText(page, "#aiDraftPageStatus", "AI drafting is unavailable");
  assert.equal(await page.$eval("#aiDraftPageSubmit", (button) => (button as HTMLButtonElement).disabled), true);
  await page.locator("#aiDraftPageCancel").click();
  assert.deepEqual(errors, ["Failed to load resource: the server responded with a status of 400 (Bad Request)"], "only the rejected template save logs a failed request");
});

test("an AI-drafted page is proposed from the space rail and created after another collaborator approves it", { timeout: 90_000 }, async (t) => {
  const provider = new FakeLlmProvider((request) => {
    if (!request.system.includes("Noma task: draft_page")) throw new Error("unexpected AI task");
    return "# Incident escalation\n\nPage the Zurich on-call first, then the incident commander.\n";
  });
  const { origin } = await startServer(t, "noma-cloud-ai-page-ui-", { provider });
  const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());

  const alice = await openCloudPage(browser, origin);
  const aliceErrors = collectErrors(alice);
  await alice.locator("#cloudUserName").fill("Alice Author");
  await alice.locator("#newUserButton").click();
  await waitForText(alice, "#cloudStatus", "Created user");
  const aliceToken = await mintToken(alice);
  const sites = await requestJson<{ sites: Array<{ id: string; documentIds: string[] }> }>(`${origin}/api/sites`, aliceToken);
  const site = sites.sites[0]!;
  const parentId = site.documentIds[0]!;
  const bob = await requestJson<CloudUser>(`${origin}/api/users`, aliceToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Bob Reviewer" }),
  });
  await requestJson(`${origin}/api/sites/${site.id}/collaborators`, aliceToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: bob.id, role: "editor" }),
  });

  await alice.locator("#aiDraftPageButton").click();
  await alice.waitForSelector("#aiDraftPageDialog[open]");
  await alice.locator("#aiDraftPageTitleInput").fill("Incident escalation");
  await alice.locator("#aiDraftPageInstruction").fill("Explain how production incidents are escalated");
  await alice.locator("#aiDraftPageUnderCurrent").click();
  await alice.locator("#aiDraftPageSubmit").click();
  await waitForText(alice, "#aiDraftPageStatus", "awaiting independent review");
  assert.match(await text(alice, "#aiDraftPageResult pre"), /^# Incident escalation/);
  await clickButton(alice, "#aiDraftPageResult", "Show in Agent Review");
  await waitForText(alice, "#aiPageProposalList", "pending · Incident escalation");
  assert.deepEqual(await buttonLabels(alice, "#aiPageProposalList [data-proposal-id]"), ["Withdraw"], "the author cannot approve their own draft");
  const unchanged = await requestJson<{ documentIds: string[] }>(`${origin}/api/sites/${site.id}`, aliceToken);
  assert.deepEqual(unchanged.documentIds, site.documentIds, "no page exists before approval");

  const bobContext = await browser.createBrowserContext();
  const bobPage = await openCloudPage(bobContext, origin);
  const bobErrors = collectErrors(bobPage);
  await bobPage.locator("#cloudUserToken").fill(bob.token);
  await bobPage.locator("#loginUserButton").click();
  await waitForText(bobPage, "#cloudStatus", "Logged in");
  await bobPage.goto(`${origin}/cloud.html?site=${site.id}`, { waitUntil: "networkidle0" });
  await waitForText(bobPage, "#aiPageProposalList", "pending · Incident escalation");
  await clickButton(bobPage, "#aiPageProposalList [data-proposal-id]", "Approve");
  await waitForText(bobPage, "#aiPageProposalList", "approved · Incident escalation");
  await clickButton(bobPage, "#aiPageProposalList [data-proposal-id]", "Create page");
  await waitForText(bobPage, "#aiPageProposalList", "applied · Incident escalation");
  await bobPage.waitForFunction(() => document.querySelector<HTMLInputElement>("#pageTitleInput")?.value === "Incident escalation", { timeout: 10_000 });

  const tree = await requestJson<{ pages: Array<{ id: string; children: Array<{ id: string; title?: string }> }> }>(`${origin}/api/sites/${site.id}/tree`, aliceToken);
  const parent = tree.pages.find((candidate) => candidate.id === parentId);
  assert.equal(parent?.children.length, 1, "the page is created under the page that was open when drafting");
  assert.deepEqual(aliceErrors, []);
  assert.deepEqual(bobErrors, []);
  await bobContext.close();
});

async function startServer(t: test.TestContext, prefix: string, ai: NomaCloudAiOptions): Promise<{ origin: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const server = createNomaCloudServer({
    dataDir: join(root, "documents"),
    publicDir: resolve("site"),
    rateLimitMaxRequests: 10_000,
    ai: { maintenanceTickMs: 0, ...ai },
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(async () => {
    await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    await rm(root, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function openCloudPage(owner: { newPage: () => Promise<Page> }, origin: string): Promise<Page> {
  const page = await owner.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith("https://rsms.me/")) void request.respond({ status: 200, contentType: "text/css", body: "" });
    else void request.continue();
  });
  await page.evaluateOnNewDocument(() => localStorage.setItem("noma.cloud.panelsOpen.v1", "true"));
  await page.goto(`${origin}/cloud.html`, { waitUntil: "networkidle0" });
  return page;
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
  try {
    await page.waitForFunction(
      (nextSelector, nextExpected) => document.querySelector(nextSelector)?.textContent?.includes(nextExpected),
      { timeout },
      selector,
      expected,
    );
  } catch (error) {
    throw new Error(`Timed out waiting for "${expected}" in ${selector}; found "${await text(page, selector).catch(() => "<missing>")}"`, { cause: error });
  }
}

async function text(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (element) => element.textContent ?? "");
}

async function buttonLabels(page: Page, selector: string): Promise<string[]> {
  return page.$$eval(`${selector} button`, (buttons) => buttons.map((button) => button.textContent ?? ""));
}

async function clickButton(page: Page, container: string, label: string): Promise<void> {
  const clicked = await page.$$eval(
    `${container} button`,
    (buttons, nextLabel) => {
      const button = buttons.find((candidate) => candidate.textContent === nextLabel) as HTMLButtonElement | undefined;
      button?.click();
      return Boolean(button);
    },
    label,
  );
  assert.ok(clicked, `no "${label}" button in ${container}`);
}

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  const body = await response.text();
  assert.equal(response.ok, true, `${response.status} ${body}`);
  return JSON.parse(body) as T;
}

/** Mints a full-scope personal access token through the page's cookie session for direct API calls. */
async function mintToken(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const csrf = /(?:^|;\s*)noma_csrf=([^;]+)/.exec(document.cookie)?.[1];
    if (!csrf) throw new Error("Cloud session CSRF cookie was not set");
    const created = await fetch("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-noma-csrf": decodeURIComponent(csrf) },
      body: JSON.stringify({ name: "UI test", scopes: ["read", "write", "admin"] }),
    });
    if (!created.ok) throw new Error(`Could not create a personal access token: ${created.status}`);
    return ((await created.json()) as { token: string }).token;
  });
}
