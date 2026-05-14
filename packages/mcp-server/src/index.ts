#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readDoc } from "./tools/read-doc.js";
import { listIds } from "./tools/list-ids.js";
import { validateDoc } from "./tools/validate-doc.js";
import { patchBlock } from "./tools/patch-block.js";
import type { PatchOp } from "@ferax564/noma-cli";

const PatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace_block"), id: z.string(), content: z.string() }),
  z.object({ op: z.literal("replace_body"), id: z.string(), content: z.string() }),
  z.object({ op: z.literal("update_heading"), id: z.string(), title: z.string() }),
  z.object({ op: z.literal("add_block"), parent: z.string(), content: z.string(), position: z.number().int().nonnegative().optional() }),
  z.object({ op: z.literal("delete_block"), id: z.string() }),
  z.object({
    op: z.literal("update_attribute"),
    id: z.string(),
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({ op: z.literal("rename_id"), from: z.string(), to: z.string() }),
]);

const server = new McpServer({
  name: "@ferax564/noma-mcp-server",
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
  { file: z.string().describe("Absolute path to the .noma file") },
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
    actor: z.object({
      kind: z.enum(["human", "agent", "tool"]),
      name: z.string(),
      model: z.string().optional(),
      version: z.string().optional(),
    }).optional().describe("Caller identity recorded in transcript"),
    base_sha256: z.string().length(64).optional().describe("SHA-256 of doc state the agent prepared against; mismatch surfaces base_sha_drift warning"),
    parent_op_id: z.string().uuid().optional().describe("Previous op_id for causation chains"),
  },
  async ({ file, op, reason, expected_sha, actor, base_sha256, parent_op_id }) => {
    const result = patchBlock({ file, op: op as PatchOp, reason, expected_sha, actor, base_sha256, parent_op_id });
    if (!result.ok) {
      const { system, ...body } = result;
      if (system) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
