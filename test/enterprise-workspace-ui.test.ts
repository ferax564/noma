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
  assert.match(await page.$eval("#editor", (element) => element.textContent ?? ""), /Claim|hosted workspace/);
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
  assert.deepEqual(await auditAccessibility(page), { ambiguousControls: [], duplicateIds: [], unnamedControls: [] });

  await page.locator("#mode-visuals").click();
  await page.waitForFunction(() => (window as unknown as { nomaWorkspace: { mode: () => string } }).nomaWorkspace.mode() === "visuals");
  await page.waitForSelector(".pd-el");
  await page.waitForSelector(".pd-el-arrow");
  assert.match(await text(page, "#visual-title"), /Atlas architecture/);
  assert.match(await text(page, "#visual-stage"), /Atlas architecture/);
  assert.match(await text(page, "#visual-outline"), /Atlas architecture/);

  await page.locator("#mode-work").click();
  await page.waitForSelector(".ew-card");
  assert.match(await text(page, "#work-board"), /ATLAS-/);
  await page.waitForSelector("#board-filters");
  const moved = await page.evaluate(async () => {
    const api = window as unknown as { nomaWorkspace: { applyBoardDrop: (drop: { issueId: string; beforeId: string; statusId: string }) => Promise<void> } };
    const card = document.querySelector<HTMLElement>('.ew-card[data-type="task"]') ?? document.querySelector<HTMLElement>(".ew-card");
    const issueId = card?.dataset.issue ?? "";
    await api.nomaWorkspace.applyBoardDrop({ issueId, beforeId: "", statusId: "in_review" });
    return document.querySelector(`[data-status="in_review"] [data-issue="${issueId}"]`) !== null;
  });
  assert.equal(moved, true);
  await page.locator(".ew-card").click();
  await page.waitForSelector("#advance-issue");
  const before = await text(page, ".ew-meta");
  await page.locator("#advance-issue").click();
  await page.waitForFunction((previous) => {
    const current = document.querySelector(".ew-meta")?.textContent ?? "";
    return current.length > 0 && current !== previous;
  }, undefined, before);

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
