import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";

test("plot renders real polyline when data is inline numbers", () => {
  const doc = parse(
    `::plot{id="p1" type="line" data="10 20 15 30 25" title="X"}\n::\n`,
  );
  const html = renderHtml(doc);
  assert.match(html, /<polyline points=/);
  // 5 data points → 5 circles
  const circles = html.match(/<circle/g) ?? [];
  assert.equal(circles.length, 5);
  assert.match(html, /5 points/);
});

test("plot bar renders rects per data point", () => {
  const doc = parse(
    `::plot{id="p1" type="bar" data="3 5 8 4" xlabels="a,b,c,d" title="Bars"}\n::\n`,
  );
  const html = renderHtml(doc);
  const rects = html.match(/<rect/g) ?? [];
  assert.equal(rects.length, 4);
  assert.match(html, />a</);
  assert.match(html, />d</);
});

test("plot falls back to placeholder for CSV-path data", () => {
  const doc = parse(
    `::plot{id="p1" type="line" data="./data/x.csv" title="X"}\n::\n`,
  );
  const html = renderHtml(doc);
  assert.doesNotMatch(html, /<circle/);
  assert.match(html, /\.\/data\/x\.csv/);
});

test("plot accepts inline data in body", () => {
  const doc = parse(
    `::plot{id="p1" type="line" title="From body"}\n100, 120, 140, 200\n::\n`,
  );
  const html = renderHtml(doc);
  assert.match(html, /<polyline points=/);
});
