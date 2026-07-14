# npm publish runbook

Manual fallback for publishing a Noma release to npm. The preferred path is
the guarded `.github/workflows/release.yml` tag workflow described in
`docs/runbooks/cloud-launch.md`.

## Prerequisites

- `npm` ≥ 10
- npm login as the `ferax564` account (2FA enabled — you'll need your authenticator)
- Clean working tree on the release tag:
  ```bash
  git checkout v0.17.0
  git status   # must be clean
  ```
- The complete release gate green locally:
  ```bash
  python3 -m pip install -e 'packages/agent-sdk-py[test]'
  npx puppeteer browsers install chrome
  npm run test:full
  npm audit --audit-level=high
  ```

## Publish order

The npm packages have an implicit dependency chain. Publish in this order so
dependents resolve against an already-published version:

1. `@ferax564/noma-cli` (root)
2. `@ferax564/noma-mcp-server` (depends on noma-cli)
3. `@ferax564/noma-lsp` (depends on noma-cli)
4. `@ferax564/noma-agent-sdk` (independent 0.x version; depends on noma-cli + noma-mcp-server)

## Commands

```bash
# 1. CLI (root package)
npm publish --access public --otp <6-digit-code>

# 2. MCP server
npm publish --workspace @ferax564/noma-mcp-server --access public --otp <6-digit-code>

# 3. LSP server
npm publish --workspace @ferax564/noma-lsp --access public --otp <6-digit-code>

# 4. Agent SDK
npm publish --workspace @ferax564/noma-agent-sdk --access public --otp <6-digit-code>
```

Each command will trigger the workspace's `prepack` / `prepare` script (TypeScript build) before uploading the tarball.

## Verify

```bash
# Confirm registry has the new versions
curl -s https://registry.npmjs.org/@ferax564/noma-cli | jq '.["dist-tags"].latest'
curl -s https://registry.npmjs.org/@ferax564/noma-mcp-server | jq '.["dist-tags"].latest'
curl -s https://registry.npmjs.org/@ferax564/noma-lsp | jq '.["dist-tags"].latest'
curl -s https://registry.npmjs.org/@ferax564/noma-agent-sdk | jq '.["dist-tags"].latest'

# Install into a clean dir
mktemp -d | tee /tmp/noma-verify && cd /tmp/noma-verify
npm init -y >/dev/null
npm install @ferax564/noma-cli@latest @ferax564/noma-mcp-server@latest @ferax564/noma-lsp@latest @ferax564/noma-agent-sdk@latest
npx noma --version
```

Expected: each command prints the new version.

## If a publish fails midway

- `noma-cli` publish failed → fix the issue, retry. Nothing else has shipped.
- `noma-cli` published but a dependent failed → fix the issue and resume in publish order. Already-published packages remain installable.
- A published package was wrong → use `npm deprecate @ferax564/<pkg>@<bad-version> "see <next-version>"` and immediately publish a patch. Do NOT `npm unpublish` — npm forbids unpublishing versions older than 24h that have any dependents.

## After publish

```bash
# Bump the .npmrc-tracked engines version in CHANGELOG/PLAN if needed
# Close the release milestone if one exists
gh issue list --label release --search "v0.17.0" --state open
```
