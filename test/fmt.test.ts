import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSource } from "../src/fmt.js";

test("fmt re-aligns a misaligned pipe table", () => {
  const src = `before
| Name | Status | Notes |
| :--- | :----: | ----: |
| a | ✓ | short |
| really-long-name | — | a much longer note |
after
`;
  const out = formatSource(src);
  const lines = out.split("\n");
  const widths = new Set(
    lines
      .filter((l) => l.startsWith("|"))
      .map((l) => l.length),
  );
  assert.equal(widths.size, 1, `all table lines should match width: ${[...widths].join(", ")}`);
  assert.match(out, /^before$/m);
  assert.match(out, /^after$/m);
});

test("fmt leaves non-table content byte-identical", () => {
  const src = `# heading\n\ntext **bold** \`code\`\n\n- one\n- two\n`;
  assert.equal(formatSource(src), src);
});

test("fmt does not touch tables inside fenced code blocks", () => {
  const src = "```\n| a | b |\n| - | - |\n| 1 | 2 |\n```\n";
  assert.equal(formatSource(src), src);
});

test("fmt preserves pipes inside backtick code spans", () => {
  const src = `| Form              | Type      | Example           |
| :---------------- | :-------- | :---------------- |
| \`key="text"\`    | string    | \`id="x"\`        |
| \`key=true\\|false\` | boolean | \`pinned=true\`   |
`;
  const out = formatSource(src);
  assert.match(out, /`key=true\\\|false`/);
  assert.match(out, /`pinned=true`/);
  const lines = out.split("\n").filter((l) => l.startsWith("|"));
  for (const line of lines) {
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .match(/`[^`]*`|[^|]+/g);
    assert.ok(cells && cells.length >= 3, `row should keep 3 cells: ${line}`);
  }
});

test("fmt preserves alignment markers", () => {
  const src = `| a | b | c |
| :- | :-: | -: |
| left | center | right |
`;
  const out = formatSource(src);
  assert.match(out, /\|\s*:-+\s*\|\s*:-+:\s*\|\s*-+:\s*\|/);
});
