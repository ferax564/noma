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
  title: string;
  source: string;
  hash: string;
}

test("cloud UI supports account sessions, history restore, and conflict-safe drafts", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-ui-"));
  const server = createNomaCloudServer({
    dataDir: join(root, "documents"),
    publicDir: resolve("site"),
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    await rm(root, { recursive: true, force: true });
  });

  const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.goto(`${origin}/cloud.html`, { waitUntil: "networkidle0" });

  await page.locator("#cloudUserName").fill("Browser QA");
  await page.locator("#newUserButton").click();
  await waitForText(page, "#cloudStatus", "Created user");
  assert.deepEqual(await auditAccessibility(page), { ambiguousControls: [], duplicateIds: [], unnamedControls: [] });
  assert.match(await text(page, "#siteList"), /Research Workspace/);
  assert.match(await text(page, "#historyList"), /Version 1 · current/);
  assert.ok((await page.$$eval("#pageTemplateSelect option", (options) => options.length)) >= 6);
  assert.equal(await page.$eval('link[rel="manifest"]', (link) => link.getAttribute("href")), "manifest.webmanifest");
  assert.equal(await page.evaluate(async () => Boolean(await navigator.serviceWorker.ready)), true);

  await appendSource(page, "\n\n## Browser History {id=\"browser-history\"}\nSaved as version two.\n");
  await page.locator("#savePageButton").click();
  await waitForText(page, "#cloudStatus", "Saved page");
  assert.match(await text(page, "#historyList"), /Version 2 · current/);

  await page.locator("#globalSearchInput").fill("Browser History");
  await page.locator("#searchButton").click();
  await waitForText(page, "#searchResults", "Browser History");
  assert.match(await text(page, "#searchResults"), /current|review due|stale/);
  await page.locator("#askNomaInput").fill("What was saved in Browser History as version two?");
  await page.locator("#askNomaButton").click();
  await waitForText(page, "#askNomaResult", "Saved as version two");
  assert.match(await text(page, "#askNomaStatus"), /confidence · \d+ exact citation/);
  assert.match(await text(page, "#askNomaResult"), /browser-history/);
  await page.locator("#favoritePageButton").click();
  await waitForText(page, "#favoriteList", "Research Paper Draft");
  assert.equal(await page.$eval("#favoritePageButton", (button) => button.getAttribute("aria-pressed")), "true");

  const session = await page.evaluate((storageKey) => {
    const stored = localStorage.getItem(storageKey);
    if (!stored) throw new Error("Cloud user session was not stored");
    return JSON.parse(stored) as BrowserSession;
  }, "noma.cloud.user.v1");
  const documentId = new URL(page.url()).searchParams.get("doc");
  assert.ok(documentId);
  await requestJson(`${origin}/api/agents`, session.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Browser knowledge curator", modelPolicy: { model: "local-deterministic", zeroRetention: true, maxTokensPerRun: 4_000 }, capabilities: ["read_doc", "list_ids", "validate_doc", "patch_block"], budgetUsd: 3 }),
  });
  await page.locator("#refreshKnowledgeButton").click();
  await waitForText(page, "#agentDirectoryList", "Browser knowledge curator");
  assert.match(await text(page, "#agentDirectoryList"), /zero retention/);
  const reviewer = await requestJson<BrowserSession>(`${origin}/api/users`, session.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Browser Reviewer" }),
  });
  await page.locator("#inviteUserIdInput").fill(reviewer.id);
  await page.locator("#inviteUserButton").click();
  await waitForText(page, "#shareStatus", `Invited ${reviewer.id}`);

  await page.locator("#commentBlockIdInput").fill("browser-history");
  await page.locator("#commentBodyInput").fill("Browser comment on a stable block");
  await page.locator("#addCommentButton").click();
  await waitForText(page, "#commentList", "Browser comment on a stable block");
  await waitForText(page, "#activityList", "comment created");

  await page.locator("#groupNameInput").fill("Browser Review Council");
  await page.locator("#createGroupButton").click();
  await waitForText(page, "#groupStatus", "Created Browser Review Council");
  await page.locator("#inviteGroupButton").click();
  await waitForText(page, "#shareStatus", "Invited Browser Review Council");

  await page.locator("#projectKeyInput").fill("BQA");
  await page.locator("#projectNameInput").fill("Browser Delivery");
  await page.locator("#createProjectButton").click();
  await waitForText(page, "#workStatus", "Created BQA");
  await page.locator("#sprintNameInput").fill("Browser Sprint");
  await page.locator("#createSprintButton").click();
  await waitForText(page, "#workStatus", "Created Browser Sprint");
  await page.locator("#startSprintButton").click();
  await waitForText(page, "#workStatus", "Sprint started");

  await page.select("#issueTypeSelect", "epic");
  await page.locator("#issueSummaryInput").fill("Browser delivery foundation");
  await page.locator("#createIssueButton").click();
  await waitForText(page, "#workBoard", "BQA-1 · Browser delivery foundation");
  await page.select("#issueTypeSelect", "story");
  const sprintOption = await page.$eval("#issueSprintSelect", (select) =>
    Array.from((select as HTMLSelectElement).options).find((option) => option.textContent?.includes("Browser Sprint"))?.value,
  );
  assert.ok(sprintOption);
  await page.select("#issueSprintSelect", sprintOption);
  await page.locator("#issueSummaryInput").fill("Browser managed issue");
  await page.locator("#issueAssigneeInput").fill(reviewer.id);
  await page.locator("#issueLabelsInput").fill("browser, qa");
  await page.locator("#createIssueButton").click();
  await waitForText(page, "#workBoard", "BQA-2 · Browser managed issue");
  await page.locator("#issueCommentInput").fill("Tracked in the integrated work panel");
  await page.locator("#addIssueCommentButton").click();
  await waitForText(page, "#issueDetailList", "Tracked in the integrated work panel");
  await page.locator("#issueLinkTargetInput").fill("BQA-1");
  await page.locator("#addIssueLinkButton").click();
  await waitForText(page, "#issueDetailList", "relates BQA-1");
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("#workBoard .work-issue-row"));
    const row = rows.find((candidate) => candidate.textContent?.includes("BQA-2"));
    const next = row?.querySelector<HTMLButtonElement>(".work-issue-actions button:last-child");
    if (!next) throw new Error("Issue transition button not found");
    next.click();
  });
  await waitForText(page, "#workBoard", "To do · 1");

  await page.locator("#proposePatchButton").click();
  await waitForText(page, "#agentStatus", "Proof pass; proposal awaits review on BQA-2");
  await page.locator("#refreshKnowledgeButton").click();
  await waitForText(page, "#agentChangeInboxList", "awaiting review");
  const patchProposals = await requestJson<{ proposals: Array<{ id: string; issueId?: string; status: string }> }>(
    `${origin}/api/documents/${documentId}/patch-proposals`,
    reviewer.token,
  );
  assert.match(await text(page, "#selectedIssueSummary"), /^BQA-2/);
  assert.ok(patchProposals.proposals[0]?.issueId);
  assert.equal(patchProposals.proposals[0]?.status, "pending");
  await requestJson(`${origin}/api/documents/${documentId}/patch-proposals/${patchProposals.proposals[0]?.id}/review`, reviewer.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approved" }),
  });
  await page.locator("#refreshPatchProposalsButton").click();
  await waitForText(page, "#patchProposalList", "approved · Browser QA");
  await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>("#patchProposalList .collaboration-row");
    const apply = Array.from(row?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((button) => button.textContent === "Apply");
    if (!apply) throw new Error("Approved patch apply button not found");
    apply.click();
  });
  await waitForText(page, "#agentStatus", "Applied reviewed patch");
  assert.match(await value(page, "#sourceInput"), /# Updated paper title/);

  await page.locator("#approvalReviewerInput").fill(reviewer.id);
  await page.locator("#approvalNoteInput").fill("Browser approval request");
  await page.locator("#requestApprovalButton").click();
  await waitForText(page, "#approvalList", "Browser Reviewer · pending");
  const approvals = await requestJson<{ approvals: Array<{ id: string }> }>(
    `${origin}/api/documents/${documentId}/approvals`,
    reviewer.token,
  );
  assert.ok(approvals.approvals[0]);
  await requestJson(`${origin}/api/documents/${documentId}/approvals/${approvals.approvals[0].id}`, reviewer.token, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "approved" }),
  });
  await page.locator("#refreshApprovalsButton").click();
  await waitForText(page, "#approvalList", "Browser Reviewer · approved");

  await requestJson(`${origin}/api/documents/${documentId}/comments`, reviewer.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: `Please check this @{${session.id}}` }),
  });
  await page.locator("#refreshNotificationsButton").click();
  await waitForText(page, "#notificationList", "Mentioned in Updated paper title");
  await page.locator("#completeSprintButton").click();
  await waitForText(page, "#workStatus", "unfinished work returned to backlog");
  await waitForText(page, "#workBoard", "Backlog · 2");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("#historyList .history-row"));
    const row = rows.find((candidate) => candidate.textContent?.includes("Version 1"));
    const restore = row?.querySelector<HTMLButtonElement>("button");
    if (!restore) throw new Error("Version 1 restore button not found");
    restore.click();
  });
  await waitForText(page, "#cloudStatus", "Restored version 1");
  assert.doesNotMatch(await value(page, "#sourceInput"), /Browser History/);
  assert.match(await text(page, "#historyList"), /Version 4 · current/);

  await page.locator("#logoutUserButton").click();
  await waitForText(page, "#cloudStatus", "Signed out");
  await page.locator("#cloudUserToken").fill(session.token);
  await page.locator("#loginUserButton").click();
  await waitForText(page, "#cloudStatus", "Logged in");
  assert.equal(await value(page, "#cloudUserName"), "Browser QA");
  assert.deepEqual(browserErrors, []);

  await appendSource(page, "\n\n## Local Draft {id=\"local-draft\"}\nKeep this unsaved text.\n");
  assert.equal(await page.evaluate((key, id) => {
    const drafts = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, { source?: string }>;
    return drafts[id]?.source?.includes("Keep this unsaved text.") ?? false;
  }, "noma.cloud.offlineDrafts.v1", documentId), true);
  const current = await requestJson<CloudDocument>(`${origin}/api/documents/${documentId}`, session.token);
  await requestJson<CloudDocument>(`${origin}/api/documents/${documentId}`, session.token, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: current.title,
      source: `${current.source}\n\n## External Edit {id=\"external-edit\"}\nSaved from another client.\n`,
      expectedHash: current.hash,
    }),
  });
  await page.locator("#savePageButton").click();
  await waitForText(page, "#cloudStatus", "This page changed elsewhere");
  assert.match(await value(page, "#sourceInput"), /Local Draft/);
  assert.doesNotMatch(await value(page, "#sourceInput"), /External Edit/);
  assert.equal(await text(page, "#dirtyBadge"), "unsaved");
  await page.locator("#mergeDraftButton").click();
  await waitForText(page, "#draftRecoveryStatus", "merge conflict");
  assert.match(await value(page, "#sourceInput"), /NOMA MERGE CONFLICT: CURRENT/);
  assert.match(await value(page, "#sourceInput"), /External Edit/);
  assert.match(await value(page, "#sourceInput"), /Local Draft/);
  assert.equal(browserErrors.length, 1);
  assert.match(browserErrors[0] ?? "", /409 \(Conflict\)/);
});

async function auditAccessibility(page: Page): Promise<{
  ambiguousControls: string[];
  duplicateIds: string[];
  unnamedControls: string[];
}> {
  return page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll<HTMLElement>("[id]")).map((element) => element.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    const controls = Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea"));
    const ambiguousControls = controls
      .filter((control) => control.tagName === "BUTTON" && /^[+←→]$/.test(control.textContent?.trim() ?? "") && !control.getAttribute("aria-label"))
      .map((control) => control.id || control.outerHTML.slice(0, 80));
    const unnamedControls = controls
      .filter((control) => {
        if (control.hidden || control.getAttribute("type") === "hidden" || control.getAttribute("aria-hidden") === "true") return false;
        const labels = control.id ? document.querySelectorAll(`label[for="${CSS.escape(control.id)}"]`).length : 0;
        const text = control.tagName === "BUTTON" ? control.textContent?.trim() : "";
        return !control.closest("label") && labels === 0 && !control.getAttribute("aria-label") &&
          !control.getAttribute("aria-labelledby") && !control.getAttribute("title") && !text;
      })
      .map((control) => control.id || control.outerHTML.slice(0, 80));
    return { ambiguousControls, duplicateIds: [...new Set(duplicateIds)], unnamedControls };
  });
}

async function appendSource(page: Page, suffix: string): Promise<void> {
  await page.$eval(
    "#sourceInput",
    (element, nextSuffix) => {
      const input = element as HTMLTextAreaElement;
      input.value += nextSuffix;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    suffix,
  );
}

async function waitForText(page: Page, selector: string, expected: string): Promise<void> {
  await page.waitForFunction(
    (nextSelector, nextExpected) => document.querySelector(nextSelector)?.textContent?.includes(nextExpected),
    { timeout: 10_000 },
    selector,
    expected,
  );
}

async function text(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (element) => element.textContent?.trim() ?? "");
}

async function value(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (element) => (element as HTMLInputElement | HTMLTextAreaElement).value);
}

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  const body = await response.text();
  assert.equal(response.ok, true, `${response.status} ${body}`);
  return JSON.parse(body) as T;
}
