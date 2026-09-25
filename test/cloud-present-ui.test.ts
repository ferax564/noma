import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import puppeteer, { type Page } from "puppeteer";
import { createNomaCloudServer } from "../src/cloud-server.js";

async function isolateFonts(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith("https://rsms.me/")) void request.respond({ status: 200, contentType: "text/css", body: "" });
    else void request.continue();
  });
}

test("the page header's Present button opens the saved page as a presentation", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-present-ui-"));
  const server = createNomaCloudServer({ dataDir: join(root, "documents"), publicDir: resolve("site"), rateLimitMaxRequests: 10_000 });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    await rm(root, { recursive: true, force: true });
  });
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());

  const page = await browser.newPage();
  await isolateFonts(page);
  await page.goto(`${origin}/cloud.html`, { waitUntil: "networkidle0" });
  assert.equal(await page.$eval("#presentPageButton", (button) => (button as HTMLButtonElement).disabled), true, "disabled until a page is open");
  await page.locator("#cloudUserName").fill("Presenter");
  await page.locator("#newUserButton").click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("doc") && !(document.getElementById("presentPageButton") as HTMLButtonElement).disabled, { timeout: 10_000 });
  const documentId = new URL(page.url()).searchParams.get("doc");
  assert.ok(documentId);

  const opened = browser.waitForTarget((target) => target.url().includes(`/d/${documentId}/present`), { timeout: 10_000 });
  await page.click("#presentPageButton");
  const presenter = await (await opened).page();
  assert.ok(presenter);
  await presenter.waitForSelector(".noma-presenter[data-ready] .noma-slide-current", { timeout: 10_000 });
  const counter = await presenter.$eval(".noma-presenter-counter", (el) => el.textContent ?? "");
  assert.match(counter, /^1 \/ \d+$/);
  assert.equal(await presenter.$eval(".noma-presenter-exit", (el) => el.getAttribute("href")), `/cloud.html?doc=${documentId}`);
});
