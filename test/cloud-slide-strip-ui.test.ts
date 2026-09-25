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

const DECK = `# Pitch

::deck{id="pitch-deck" title="Pitch"}
:::slide{id="intro" layout="title" title="Hello"}
Subtitle
:::

:::slide{id="problem" title="Problem"}
- Pages go stale

::::notes
Pause here.
::::
:::

:::slide{id="plan" title="Plan"}
- Ship it
:::
::
`;

const slideOrder = (source: string): string[] => [...source.matchAll(/:::slide\{id="([^"]+)"/g)].map((m) => m[1]!);

test("the slide strip shows, reveals, reorders, hides, and adds slides as source edits", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-slide-strip-"));
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
  await page.setViewport({ width: 1400, height: 900 });
  await isolateFonts(page);
  await page.goto(`${origin}/cloud.html`, { waitUntil: "networkidle0" });
  await page.locator("#cloudUserName").fill("Deck author");
  await page.locator("#newUserButton").click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("doc"), { timeout: 10_000 });
  await page.click("#splitViewButton");

  assert.equal(await page.$eval("#slideStrip", (el) => (el as HTMLElement).hidden), true, "no strip for a page without a deck");
  assert.equal(await page.$eval("#slideStripToggleButton", (el) => (el as HTMLElement).hidden), false);

  const source = await page.$("#sourceInput");
  await source!.evaluate((el, value) => {
    const input = el as HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, DECK);
  await page.waitForFunction(() => document.querySelectorAll("#slideStripList .slide-thumb").length === 3, { timeout: 10_000 });
  assert.equal(await page.$eval("#slideStripSummary", (el) => el.textContent), "3 slides");
  assert.deepEqual(await page.$$eval(".slide-thumb", (items) => items.map((item) => (item as HTMLElement).dataset.slideId)), ["intro", "problem", "plan"]);
  assert.ok(await page.$(".slide-thumb[data-slide-id='problem'] .slide-thumb-badge"), "slides with notes are marked");
  assert.ok(await page.$(".slide-thumb[data-slide-id='intro'] .slide-thumb-frame svg foreignObject"), "thumbnails are drawn from the canvas model");

  await page.click(".slide-thumb[data-slide-id='plan'] .slide-thumb-open");
  const cursorLine = await page.$eval("#sourceInput", (el) => {
    const input = el as HTMLTextAreaElement;
    return input.value.slice(0, input.selectionStart).split("\n").length;
  });
  assert.equal(cursorLine, DECK.split("\n").findIndex((line) => line.includes('id="plan"')) + 1, "clicking a slide moves the source cursor to it");
  assert.equal(await page.$eval(".slide-thumb[data-slide-id='plan']", (el) => el.getAttribute("aria-current")), "true");

  await page.focus(".slide-thumb[data-slide-id='intro'] .slide-thumb-open");
  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Alt");
  await page.waitForFunction(() => document.querySelector(".slide-thumb")?.getAttribute("data-slide-id") === "problem", { timeout: 5_000 });
  let value = await page.$eval("#sourceInput", (el) => (el as HTMLTextAreaElement).value);
  assert.deepEqual(slideOrder(value), ["problem", "intro", "plan"], "Alt+Right moves a slide with move_block");
  assert.equal(await page.$eval("#dirtyBadge", (el) => el.textContent), "unsaved");

  await page.hover(".slide-thumb[data-slide-id='plan']");
  await page.click(".slide-thumb[data-slide-id='plan'] .slide-thumb-hide");
  await page.waitForSelector(".slide-thumb[data-slide-id='plan'][data-hidden='true']", { timeout: 5_000 });
  value = await page.$eval("#sourceInput", (el) => (el as HTMLTextAreaElement).value);
  assert.match(value, /:::slide\{id="plan" title="Plan" hidden\}/);
  assert.equal(await page.$eval("#slideStripSummary", (el) => el.textContent), "3 slides · 1 hidden");

  await page.click("#slideStripAddButton");
  await page.waitForFunction(() => document.querySelectorAll("#slideStripList .slide-thumb").length === 4, { timeout: 5_000 });
  value = await page.$eval("#sourceInput", (el) => (el as HTMLTextAreaElement).value);
  assert.match(value, /:::slide\{id="slide-4" title="New slide"\}\n- First point\n:::\n::/, "a new slide is added inside the deck at the right fence depth");

  await page.screenshot({ path: join(root, "strip.png") });
  await page.click("#slideStripToggleButton");
  assert.equal(await page.$eval("#slideStrip", (el) => (el as HTMLElement).hidden), true, "the toggle hides the strip");
  assert.equal(await page.$eval("#slideStripToggleButton", (el) => el.getAttribute("aria-pressed")), "false");
});
