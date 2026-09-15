import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { listenEnterpriseHttp } from "../src/enterprise-http.js";
import { enterpriseWorkspaceHtml, seedEnterpriseProductFixture } from "../src/enterprise-shell.js";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

async function bundleWorkspace(): Promise<{ script: string; css: string }> {
  const result = await build({
    entryPoints: ["web/enterprise-workspace.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no workspace bundle");
  return { script: file.text, css: await readFile("web/enterprise-workspace.css", "utf8") };
}

test("enterprise workspace UI covers Docs, Visuals, and Work", { timeout: 60_000 }, async (t) => {
  resetIdentitySequence(0);
  const oidc = createTestOidc({ alice: { sub: "alice", email: "alice@example.com", name: "Alice" } });
  const ws = new EnterpriseWorkspace({ oidc });
  const tenantId = ws.provisionTenant("Atlas").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice Chen", active: true });
  const session = ws.loginOidc(tenantId, "alice");
  ws.bootstrapGrant(tenantId, session.actor.principalId, "tenant", tenantId, "owner");
  const fixture = seedEnterpriseProductFixture(ws, session.actor);
  const assets = await bundleWorkspace();
  const server = await listenEnterpriseHttp({
    workspace: ws,
    workspaceHtml: enterpriseWorkspaceHtml({ css: assets.css, tenantId, demoUser: "alice" }),
    assets: {
      "enterprise-workspace.js": { body: assets.script, type: "text/javascript; charset=utf-8" },
      "enterprise-workspace.css": { body: assets.css, type: "text/css; charset=utf-8" },
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const browsers: Browser[] = [];
  t.after(async () => {
    await Promise.all(browsers.map((browser) => browser.close()));
    await server.close();
    ws.close();
  });

  const unauth = await fetch(`${origin}/`);
  assert.equal(unauth.status, 200);
  assert.match(await unauth.text(), /Docs, Visuals, Work/);

  const shell = await fetch(`${origin}/v1/workspace`, {
    headers: { authorization: `Bearer ${session.token}` },
  }).then((res) => res.json()) as { documents: unknown[]; artifacts: unknown[]; issues: unknown[] };
  assert.ok(shell.documents.length >= 1);
  assert.ok(shell.artifacts.length >= 1);
  assert.ok(shell.issues.length >= 5);
  assert.ok((shell.issues as Array<{ reporterId?: string | null }>).every((issue) => Boolean(issue.reporterId)));

  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  browsers.push(browser);
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto(`${origin}/?token=${encodeURIComponent(session.token)}&documentId=${encodeURIComponent(fixture.documentId)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => (window as unknown as { nomaWorkspace?: { ready: () => boolean } }).nomaWorkspace?.ready(), {
    timeout: 20_000,
  });
  await page.waitForSelector("#editor .ProseMirror");
  await page.waitForFunction(
    () => ((window as unknown as { nomaWorkspace: { text: () => string } }).nomaWorkspace.text() ?? "").length > 12,
    { timeout: 20_000 },
  );
  assert.doesNotMatch(await page.$eval("#editor", (element) => element.textContent ?? ""), /\{#/);
  assert.match(await page.$eval("#editor", (element) => element.innerHTML), /ew-panel/);
  assert.match(await page.$eval("#editor", (element) => element.textContent ?? ""), /Claim|hosted workspace/);
  await page.waitForSelector("#doc-presence");
  await page.click("#editor .ProseMirror");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.waitForSelector(".ew-slash:not([hidden])");
  assert.match(await page.$eval(".ew-slash", (element) => element.textContent ?? ""), /Info panel|Table|Action items/);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".ew-slash[hidden]");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("@");
  await page.waitForSelector(".ew-mention-suggest:not([hidden])");
  assert.match(await page.$eval(".ew-mention-suggest", (element) => element.textContent ?? ""), /Alice/);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".ew-mention-suggest[hidden]");
  await page.waitForSelector("#doc-count");
  await page.waitForFunction(() => {
    const text = document.querySelector("#doc-count")?.textContent ?? "";
    const match = /^(\d+) words/.exec(text);
    return Boolean(match && Number(match[1]) > 0);
  });
  await page.click("#editor .ProseMirror");
  const selected = await page.evaluate(() =>
    Boolean((window as unknown as { nomaWorkspace?: { selectAll?: () => boolean } }).nomaWorkspace?.selectAll?.()),
  );
  assert.equal(selected, true);
  await page.waitForSelector(".ew-bubble:not([hidden])");
  await page.keyboard.press("Escape");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Control");
  await page.waitForSelector("#command-palette:not([hidden])");
  await page.locator("#command-input").fill("strategy");
  await page.waitForFunction(() => document.querySelectorAll("#command-list [data-id]").length > 0);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#command-palette[hidden]");
  assert.match(await text(page, "#doc-title"), /Q3 strategy memo/);
  assert.match(await text(page, "#rail-list"), /Q3 strategy memo/);
  assert.match(await text(page, "#rail-list"), /Risks and open questions/);
  await page.waitForSelector("#doc-media img");
  await page.waitForSelector("#inspector .ew-link");
  assert.match(await text(page, "#inspector"), /github/i);
  await page.waitForSelector("#page-toc");
  await page.waitForFunction(() => (document.querySelector("#page-toc")?.textContent ?? "").includes("Why this surface"), {
    timeout: 20_000,
  });
  await page.waitForSelector("#doc-cover:not([hidden]) img");
  await page.waitForSelector("#page-find-open");
  const found = await page.evaluate(() =>
    (window as unknown as { nomaWorkspace: { findInPage: (query: string) => number } }).nomaWorkspace.findInPage("surface"),
  );
  assert.ok(found > 0);
  await page.waitForSelector("#page-find:not([hidden])");
  assert.match(await text(page, "#page-find-count"), /1 of /);
  await page.locator("#page-find-close").click();
  await page.waitForSelector("#page-find[hidden]");
  assert.deepEqual(await auditAccessibility(page), { ambiguousControls: [], duplicateIds: [], unnamedControls: [] });

  await page.locator("#mode-visuals").click();
  await page.waitForFunction(() => (window as unknown as { nomaWorkspace: { mode: () => string } }).nomaWorkspace.mode() === "visuals");
  await page.waitForSelector(".pd-el");
  await page.waitForSelector(".pd-el-arrow");
  await page.waitForSelector("#tool-sticky");
  await page.waitForSelector("#tool-connect");
  await page.waitForSelector("#tool-comment");
  await page.waitForSelector("#sticky-pink");
  await page.waitForSelector("#canvas-undo");
  await page.waitForSelector("#canvas-delete");
  await page.waitForSelector(".pd-el-sticky");
  await page.waitForSelector(".pd-el-comment");
  await page.waitForSelector(".pd-resize");
  assert.match(await text(page, "#visual-title"), /Atlas architecture/);
  assert.match(await text(page, "#visual-stage"), /Atlas architecture/);
  assert.match(await text(page, "#visual-stage"), /Call this out in review/);
  assert.match(await text(page, "#visual-outline"), /Atlas architecture/);
  const movedFrame = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>(".pd-el:not(.pd-el-arrow)");
    if (!card) return false;
    const from = card.getBoundingClientRect();
    const start = Number.parseFloat(card.style.left) || 0;
    card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: from.left + 8, clientY: from.top + 8, pointerId: 2, button: 0, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: from.left + 72, clientY: from.top + 28, pointerId: 2, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: from.left + 72, clientY: from.top + 28, pointerId: 2, button: 0 }));
    return (Number.parseFloat(card.style.left) || 0) > start;
  });
  assert.equal(movedFrame, true);

  await page.locator("#mode-work").click();
  await page.waitForSelector(".ew-card");
  await page.waitForSelector("#board-search");
  await page.waitForSelector("#type-filters");
  await page.waitForSelector("#swimlane-epic");
  await page.waitForSelector("#view-list");
  assert.match(await text(page, "#work-board"), /ATLAS-/);
  assert.match(await text(page, "#work-board"), /2026-09-22/);
  assert.match(await text(page, "#work-board"), /urgent|canvas/);
  await page.waitForSelector("#board-filters");
  await page.waitForSelector("#filter-unassigned");
  await page.waitForSelector("#filter-overdue");
  await page.waitForSelector("#filter-flagged");
  await page.locator("#filter-overdue").click();
  assert.match(await text(page, "#work-board"), /Ship the product shell/);
  await page.locator("#filter-flagged").click();
  assert.match(await text(page, "#work-board"), /Search must not leak/);
  await page.locator("#filter-all").click();
  const movedByPointer = await page.evaluate(async () => {
    const card = document.querySelector<HTMLElement>('.ew-card[data-type="story"]');
    const dest = document.querySelector<HTMLElement>('[data-status="in_progress"] .ew-column-list');
    if (!card || !dest) return false;
    const issueId = card.dataset.issue ?? "";
    const from = card.getBoundingClientRect();
    const to = dest.getBoundingClientRect();
    card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: from.left + 8, clientY: from.top + 8, pointerId: 1, button: 0, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: from.left + 20, clientY: from.top + 24, pointerId: 1, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: to.left + 28, clientY: to.top + 56, pointerId: 1, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: to.left + 28, clientY: to.top + 56, pointerId: 1, button: 0 }));
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    return Boolean(document.querySelector(`[data-status="in_progress"] [data-issue="${issueId}"]`));
  });
  assert.equal(movedByPointer, true);
  await page.locator(".ew-card").click();
  await page.waitForSelector("#advance-issue");
  await page.waitForSelector(".ew-select-btn");
  const before = await text(page, ".ew-issue-kicker");
  await page.locator("#advance-issue").click();
  await page.waitForFunction((previous) => {
    const current = document.querySelector(".ew-issue-kicker")?.textContent ?? "";
    return current.length > 0 && current !== previous;
  }, undefined, before);
  await page.waitForSelector("#issue-due");
  await page.waitForSelector("#issue-labels");
  await page.waitForSelector("#issue-parent");
  await page.waitForSelector("#issue-reporter");
  await page.waitForSelector("#issue-flag");
  await page.waitForSelector("#issue-children");
  await page.waitForSelector("#issue-relates");
  assert.match(await text(page, "#issue-reporter"), /Alice|Reported by/);
  await page.locator("#swimlane-epic").click();
  await page.waitForSelector(".ew-swimlane");
  assert.match(await text(page, "#work-board"), /Ship the product shell/);
  await page.locator("#view-list").click();
  await page.waitForSelector(".ew-issue-table");
  assert.match(await text(page, "#work-board"), /ATLAS-3/);
  await page.waitForSelector("#advance-issue");
  assert.deepEqual(await auditAccessibility(page), { ambiguousControls: [], duplicateIds: [], unnamedControls: [] });

  await page.locator("#workspace-search").fill("strategy");
  await page.waitForSelector("#search-results .ew-hit");
  assert.match(await text(page, "#search-results"), /Q3 strategy memo/);
  const searchTitles = await page.$$eval("#search-results .ew-hit strong", (nodes) => nodes.map((node) => node.textContent ?? ""));
  assert.equal(new Set(searchTitles).size, searchTitles.length);

  await page.locator("#mode-docs").click();
  await page.waitForSelector("#editor .ProseMirror");
  await page.waitForFunction(
    () => {
      const status = document.querySelector("#collab-status")?.textContent ?? "";
      return status === "ready" || status.startsWith("acks");
    },
    { timeout: 20_000 },
  );
  await page.click("#editor .ProseMirror");
  await page.keyboard.type(" product-shell");
  await page.waitForFunction(
    () => ((window as unknown as { nomaWorkspace: { text: () => string } }).nomaWorkspace.text() ?? "").includes("product-shell"),
    { timeout: 15_000 },
  );
  assert.deepEqual(browserErrors, []);
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
        if (control.hidden || control.closest("[hidden]") || control.getAttribute("type") === "hidden" || control.getAttribute("aria-hidden") === "true") return false;
        const labels = control.id ? document.querySelectorAll(`label[for="${CSS.escape(control.id)}"]`).length : 0;
        const text = control.tagName === "BUTTON" ? control.textContent?.trim() : "";
        return !control.closest("label") && labels === 0 && !control.getAttribute("aria-label") &&
          !control.getAttribute("aria-labelledby") && !control.getAttribute("title") && !text;
      })
      .map((control) => control.id || control.outerHTML.slice(0, 80));
    return { ambiguousControls, duplicateIds: [...new Set(duplicateIds)], unnamedControls };
  });
}

async function text(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (element) => element.textContent?.trim() ?? "");
}
