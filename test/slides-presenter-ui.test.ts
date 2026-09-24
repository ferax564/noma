import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import puppeteer from "puppeteer";
import { parse } from "../src/parser.js";
import { renderSlidesHtml } from "../src/renderer-html.js";

const DECK = `::deck{id="d"}
:::slide{id="one" title="One"}
::::card{id="only-slides" class="slides-only"}
Shown in slides
::::

::::card{id="not-slides" class="hide-in-slides"}
Hidden in slides
::::
:::

:::slide{id="secret" title="Secret" hidden}
Backstage
:::

:::slide{id="three" title="Three"}
Last
:::
::
`;

test("the presenter honours hidden slides and slide-only tokens, in overview and print too", { timeout: 60_000 }, async (t) => {
  const file = join(mkdtempSync(join(tmpdir(), "noma-presenter-")), "deck.html");
  writeFileSync(file, renderSlidesHtml(parse(DECK), { themeCss: readFileSync("themes/default.css", "utf8") }));
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(pathToFileURL(file).href);
  const visible = (selector: string) => page.$eval(selector, (el) => getComputedStyle(el).display !== "none");

  assert.equal(await visible("#only-slides"), true, "slides-only content shows in the presenter");
  assert.equal(await visible("#not-slides"), false, "hide-in-slides content is hidden in the presenter");
  assert.equal(await page.$eval(".noma-presenter-counter", (el) => el.textContent), "1 / 2");

  await page.keyboard.press("o");
  assert.equal(await visible("#three"), true);
  assert.equal(await visible("#secret"), false, "hidden slides stay out of the overview");

  await page.emulateMediaType("print");
  assert.equal(await visible("#three"), true);
  assert.equal(await visible("#secret"), false, "hidden slides stay out of print");
});
