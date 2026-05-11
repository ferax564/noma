#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readDoc } from "./tools/read-doc.js";
import { listIds } from "./tools/list-ids.js";
import { validateDoc } from "./tools/validate-doc.js";
import { patchBlock } from "./tools/patch-block.js";
import type { PatchOp } from "@noma/cli";

const PatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace_block"), id: z.string(), content: z.string() }),
  z.object({ op: z.literal("add_block"), parent: z.string(), content: z.string(), position: z.number().int().optional() }),
  z.object({ op: z.literal("delete_block"), id: z.string() }),
  z.object({ op: z.literal("update_attribute"), id: z.string(), key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ op: z.literal("rename_id"), from: z.string(), to: z.string() }),
]);

const server = new McpServer({
  name: "@noma/mcp-server",
  version: "0.1.0",
});

server.tool(
  "read_doc",
  "Parse a .noma file and return a shallow summary of all blocks with their IDs, types, and patchability.",
  { file: z.string().describe("Absolute path to the .noma file") },
  async ({ file }) => {
    try {
      const blocks = readDoc(file);
      return { content: [{ type: "text", text: JSON.stringify({ blocks }) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  },
);

server.tool(
  "list_ids",
  "Return all canonical block IDs and alias map for a .noma file.",
  { file: z.string() },
  async ({ file }) => {
    try {
      const result = listIds(file);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  },
);

server.tool(
  "validate_doc",
  "Run the Noma validator on a .noma file. Profile is read from the document frontmatter.",
  { file: z.string() },
  async ({ file }) => {
    try {
      const result = validateDoc(file);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  },
);

server.tool(
  "patch_block",
  "Apply a block-level patch op to a .noma file. Uses byte-preserving patchSource(). Appends to .noma.patches transcript.",
  {
    file: z.string().describe("Absolute path to the .noma file"),
    op: PatchOpSchema.describe("Patch operation to apply"),
    reason: z.string().optional().describe("Agent-provided justification stored in transcript"),
    expected_sha: z.string().length(8).optional().describe("SHA-256[:8] of file before patch — prevents lost updates"),
  },
  async ({ file, op, reason, expected_sha }) => {
    const result = patchBlock({ file, op: op as PatchOp, reason, expected_sha });
    if (!result.ok) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
