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

test("plot resolves data from a linked dataset", () => {
  const src = `::dataset{id="ds1"}
schema:
  vertical: string
  growth: number
rows:
  - [a, 3.4]
  - [b, 2.9]
  - [c, 4.1]
::

::plot{id="p1" type="bar" dataset="ds1" column="growth" xcolumn="vertical" title="X"}
::
`;
  const doc = parse(src);
  const html = renderHtml(doc);
  const rects = html.match(/<rect/g) ?? [];
  assert.equal(rects.length, 3);
  assert.match(html, />a</);
  assert.match(html, />c</);
  assert.match(html, /3 points/);
});

test("plot resolves quoted CSV dataset cells", () => {
  const src = `::dataset{id="ds1" format="csv"}
vertical,"gross,margin"
"North, America",3.4
EMEA,2.9
::

::plot{id="p1" type="bar" dataset="ds1" column="gross,margin" xcolumn="vertical" title="X"}
::
`;
  const html = renderHtml(parse(src));
  const rects = html.match(/<rect/g) ?? [];
  assert.equal(rects.length, 2);
  assert.match(html, />North, America</);
  assert.match(html, /2 points/);
});

test("plot xlabels accept space or comma", () => {
  const docComma = parse(
    `::plot{id="p1" type="bar" data="1,2,3" xlabels="a,b,c" title="X"}\n::\n`,
  );
  const docSpace = parse(
    `::plot{id="p2" type="bar" data="1 2 3" xlabels="a b c" title="X"}\n::\n`,
  );
  const h1 = renderHtml(docComma);
  const h2 = renderHtml(docSpace);
  for (const lbl of ["a", "b", "c"]) {
    assert.match(h1, new RegExp(`>${lbl}<`));
    assert.match(h2, new RegExp(`>${lbl}<`));
  }
});

test("plot x-axis label controls rotate, wrap, abbreviate, and compact", () => {
  const doc = parse(
    `::plot{id="p1" type="bar" data="1,2" xlabels="crypto_long_short_carry,seasonality_eq_bond_reversion" xlabel_angle=45 xlabel_wrap=8 xlabel_abbrev=14 compact title="Strategies"}\n::\n`,
  );
  const html = renderHtml(doc);
  assert.match(html, /data-compact="true"/);
  assert.match(html, /rotate\(-45\)/);
  assert.match(html, /<title>crypto_long_short_carry<\/title>/);
  assert.match(html, /<tspan/);
});
