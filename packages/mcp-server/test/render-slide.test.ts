import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderSlide } from "../src/tools/render-slide.js";

const dir = mkdtempSync(join(tmpdir(), "noma-render-slide-"));
const file = join(dir, "deck.noma");
writeFileSync(
  file,
  `::deck{id="d"}\n:::slide{id="intro" layout="title"}\n# Hello <script>alert(1)</script>\n:::\n:::slide{id="two" title="Second"}\n- one\n:::\n::\n`,
  "utf8",
);

describe("renderSlide", () => {
  it("returns the slide SVG by block ID with escaped text", async () => {
    const result = await renderSlide({ file, slide: "intro" });
    assert.equal(result.id, "intro");
    assert.equal(result.width, 1280);
    assert.match(result.svg, /^<svg /);
    assert.ok(!result.svg.includes("<script>"));
    assert.equal(result.png, undefined);
  });

  it("rejects unknown slide IDs and lists the real ones", async () => {
    await assert.rejects(renderSlide({ file, slide: "nope" }), /intro, two/);
  });
});
