import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendTranscript } from "../src/transcript.js";
import type { TranscriptLine } from "../src/transcript.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noma-transcript-"));
});

describe("appendTranscript", () => {
  it("creates the file on first append", () => {
    const path = join(dir, "test.noma.patches");
    const line: TranscriptLine = {
      v: 1,
      ts: "2026-05-10T12:00:00Z",
      agent: "test",
      op: { op: "delete_block", id: "foo" },
      reason: "",
      pre_validation: "ok",
      post_validation: "ok",
      pre_sha: "aaaaaaaa",
      post_sha: "bbbbbbbb",
    };
    appendTranscript(path, line);
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.v, 1);
    assert.equal(parsed.agent, "test");
    assert.equal(parsed.pre_sha, "aaaaaaaa");
  });

  it("appends a second line without overwriting", () => {
    const path = join(dir, "test.noma.patches");
    const line: TranscriptLine = {
      v: 1, ts: "2026-05-10T12:00:00Z", agent: "a", reason: "",
      op: { op: "delete_block", id: "x" },
      pre_validation: "ok", post_validation: "ok",
      pre_sha: "11111111", post_sha: "22222222",
    };
    appendTranscript(path, line);
    appendTranscript(path, { ...line, pre_sha: "33333333", post_sha: "44444444" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]!).pre_sha, "33333333");
  });
});
