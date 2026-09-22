import assert from "node:assert/strict";
import test from "node:test";
import { safeHref } from "../src/inline.js";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";

test("safeHref keeps web, mail, relative, and fragment links", () => {
  for (const href of ["https://example.com/a?b=1", "http://x.test", "mailto:a@b.c", "tel:+1", "/docs/a", "../b.html", "#section", "page.html"]) {
    assert.equal(safeHref(href), href);
  }
});

test("safeHref neutralises script-capable schemes, including obfuscated ones", () => {
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "vbscript:x", "data:text/html,<b>"]) {
    assert.equal(safeHref(href), "#", href);
  }
});

test("rendered HTML never emits javascript: hrefs from links, buttons, or datasets", () => {
  const doc = parse(
    [
      "# Links",
      "",
      "[click](javascript:alert(1)) and [ok](https://example.com)",
      "",
      '::button{href="javascript:alert(2)"}',
      "Go",
      "::",
      "",
      '::dataset{id="d" src="javascript:alert(3)"}',
      "::",
      "",
    ].join("\n"),
  );
  const html = renderHtml(doc);
  assert.doesNotMatch(html, /href="\s*javascript:/i);
  assert.match(html, /href="https:\/\/example\.com"/);
});
