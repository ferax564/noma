import { test } from "node:test";
import assert from "node:assert/strict";
import { StdioMcpClient } from "../src/transport.js";
import { NomaSpawnError } from "../src/errors.js";

test("StdioMcpClient.spawn resolves the bundled mcp-server binary and returns a client", async () => {
  const client = await StdioMcpClient.spawn();
  try {
    const tools = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    assert.ok(names.has("read_doc"));
    assert.ok(names.has("list_ids"));
    assert.ok(names.has("validate_doc"));
    assert.ok(names.has("patch_block"));
  } finally {
    await client.close();
  }
});

test("StdioMcpClient.spawn rejects an unresolvable server binary", async () => {
  await assert.rejects(
    () => StdioMcpClient.spawn({ mcpServerBin: "/no/such/file", stderr: "pipe" }),
    NomaSpawnError,
  );
});
