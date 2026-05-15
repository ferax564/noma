# `@ferax564/noma-mcp-server`

MCP server for block-level editing of `.noma` documents.

The server exposes the same stable document operations as the CLI over stdio so
agents can inspect, validate, and patch Noma files without rewriting whole
documents.

## Install

```bash
npm install @ferax564/noma-mcp-server
```

## Tools

- `read_doc` parses a `.noma` file and returns shallow block summaries.
- `list_ids` returns canonical IDs and alias mappings.
- `validate_doc` runs the Noma validator.
- `patch_block` applies one source-preserving patch operation and appends a
  transcript record.

## MCP host configuration

Use the published binary as a stdio command:

```json
{
  "mcpServers": {
    "noma": {
      "command": "npx",
      "args": ["-y", "@ferax564/noma-mcp-server"]
    }
  }
}
```

For TypeScript workflows that want a small client wrapper, install
`@ferax564/noma-agent-sdk`.
