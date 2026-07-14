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
  z.object({
    op: z.literal("add_comment"),
    id: z.string(),
    target: z.string(),
    content: z.string(),
    author: z.string().optional(),
    initials: z.string().optional(),
    date: z.string().optional(),
    reply_to: z.string().optional(),
  }),
  z.object({
    op: z.literal("resolve_comment"),
    id: z.string(),
    resolved_by: z.string().optional(),
    resolved_at: z.string().optional(),
  }),
  z.object({
    op: z.literal("add_footnote"),
    id: z.string(),
    target: z.string(),
    content: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    op: z.literal("add_endnote"),
    id: z.string(),
    target: z.string(),
    content: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    op: z.literal("add_change_request"),
    id: z.string(),
    target: z.string(),
    action: z.enum(["insert", "delete", "replace"]),
    from: z.string().optional(),
    to: z.string().optional(),
    text: z.string().optional(),
    content: z.string().optional(),
    author: z.string().optional(),
    date: z.string().optional(),
  }),
  z.object({
    op: z.literal("update_table_cell"),
    id: z.string(),
    row: z.number().int().nonnegative(),
    column: z.union([z.number().int().nonnegative(), z.string()]),
    value: z.string(),
  }),
  z.object({
    op: z.literal("update_table_header_cell"),
    id: z.string(),
    column: z.union([z.number().int().nonnegative(), z.string()]),
    value: z.string(),
  }),
  z.object({
    op: z.literal("insert_table_row"),
    id: z.string(),
    row: z.number().int().nonnegative(),
    cells: z.array(z.string()),
  }),
  z.object({
    op: z.literal("delete_table_row"),
    id: z.string(),
    row: z.number().int().nonnegative(),
  }),
  z.object({
    op: z.literal("insert_table_column"),
    id: z.string(),
    column: z.number().int().nonnegative(),
    header: z.string().optional(),
    cells: z.array(z.string()),
  }),
  z.object({
    op: z.literal("delete_table_column"),
    id: z.string(),
    column: z.union([z.number().int().nonnegative(), z.string()]),
  }),
  z.object({
    op: z.literal("update_dataset_cell"),
    id: z.string(),
    row: z.number().int().nonnegative(),
    column: z.union([z.number().int().nonnegative(), z.string()]),
    value: z.string(),
  }),
  z.object({
    op: z.literal("insert_dataset_row"),
    id: z.string(),
    row: z.number().int().nonnegative(),
    cells: z.array(z.string()),
  }),
  z.object({
    op: z.literal("delete_dataset_row"),
    id: z.string(),
    row: z.number().int().nonnegative(),
  }),
  z.object({
    op: z.literal("insert_dataset_column"),
    id: z.string(),
    column: z.number().int().nonnegative(),
    header: z.string(),
    cells: z.array(z.string()),
  }),
  z.object({
    op: z.literal("delete_dataset_column"),
    id: z.string(),
    column: z.union([z.number().int().nonnegative(), z.string()]),
  }),
  z.object({
    op: z.literal("move_block"),
    id: z.string(),
    parent: z.string(),
    position: z.number().int().nonnegative().optional(),
  }),
  z.object({ op: z.literal("add_block"), parent: z.string(), content: z.string(), position: z.number().int().nonnegative().optional() }),
  z.object({ op: z.literal("delete_block"), id: z.string() }),
  z.object({
    op: z.literal("update_attribute"),
    id: z.string(),
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({
    op: z.literal("remove_attribute"),
    id: z.string(),
    key: z.string(),
  }),
  z.object({ op: z.literal("rename_id"), from: z.string(), to: z.string() }),
]);

const server = new McpServer({
  name: "@ferax564/noma-mcp-server",
  version: "0.17.0",
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
    base_hash: z.string().regex(/^[0-9a-fA-F]{8,64}$/).optional().describe("Block-level precondition: sha256 (full or >=8-char prefix) of the target block's source slice as returned by read_doc. The patch is refused with sha_mismatch if the block changed since it was read."),
    parent_op_id: z.string().uuid().optional().describe("Previous op_id for causation chains"),
  },
  async ({ file, op, reason, expected_sha, actor, base_sha256, base_hash, parent_op_id }) => {
    const fullOp = (base_hash ? { ...op, baseHash: base_hash } : op) as PatchOp;
    const result = patchBlock({ file, op: fullOp, reason, expected_sha, actor, base_sha256, parent_op_id });
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
