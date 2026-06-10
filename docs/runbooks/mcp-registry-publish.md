# MCP registry publish runbook

Lists `io.github.ferax564/noma` (the `@ferax564/noma-mcp-server` npm package)
on the official MCP registry so Claude Code, Claude Desktop, and other MCP
clients can discover it.

## Prerequisites

- `@ferax564/noma-mcp-server` published to npm **with the `mcpName` field**
  (`io.github.ferax564/noma`) in its `package.json` — the registry verifies
  npm ownership through that field. Shipped in 0.15.0+.
- `packages/mcp-server/server.json` versions match the npm release.
- `mcp-publisher` CLI:
  ```bash
  brew install mcp-publisher
  ```

## Publish

```bash
cd packages/mcp-server
mcp-publisher login github     # device flow — authorizes io.github.ferax564/* names
mcp-publisher publish          # reads server.json
```

## Verify

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.ferax564/noma" | head -40
```

## On each release

`server.json` carries the release version twice (top-level `version` and
`packages[0].version`). `npm run release -- bump` does not yet know about this
file — bump both fields manually, then re-run `mcp-publisher publish` after
the npm release is live.

## Aggregators (optional, after the official registry)

- **Smithery** (smithery.ai): sign in with GitHub, "Add server", point at the
  repo. Smithery indexes the official registry too, so this may auto-appear.
- **mcp.so**: submit via the "Submit" form with the GitHub URL.
