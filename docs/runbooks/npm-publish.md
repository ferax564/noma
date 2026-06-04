# npm publish runbook

Manual steps to publish a Noma release to npm. Run after the release tag exists on `origin/main` (e.g. `v0.12.0`) and the GitHub release is live.

## Prerequisites

- `npm` ≥ 10
- npm login as the `ferax564` account (2FA enabled — you'll need your authenticator)
- Clean working tree on the release tag:
  ```bash
  git checkout v0.12.0
  git status   # must be clean
  ```
- All three release gates green locally:
  ```bash
  ./node_modules/typescript/bin/tsc --noEmit
  npm test
  npm run build:site
  npm run smoke:package
  ```

## Publish order

The three workspaces have an implicit dependency chain — publish in this order so dependents resolve against an already-published version:

1. `@ferax564/noma-cli` (root)
2. `@ferax564/noma-mcp-server` (depends on noma-cli)
3. `@ferax564/noma-agent-sdk` (depends on noma-cli + noma-mcp-server)

## Commands

```bash
# 1. CLI (root package)
npm publish --access public --otp <6-digit-code>

# 2. MCP server
npm publish --workspace @ferax564/noma-mcp-server --access public --otp <6-digit-code>

# 3. Agent SDK
npm publish --workspace @ferax564/noma-agent-sdk --access public --otp <6-digit-code>
```

Each command will trigger the workspace's `prepack` / `prepare` script (TypeScript build) before uploading the tarball.

## Verify

```bash
# Confirm registry has the new versions
curl -s https://registry.npmjs.org/@ferax564/noma-cli | jq '.["dist-tags"].latest'
curl -s https://registry.npmjs.org/@ferax564/noma-mcp-server | jq '.["dist-tags"].latest'
curl -s https://registry.npmjs.org/@ferax564/noma-agent-sdk | jq '.["dist-tags"].latest'

# Install into a clean dir
mktemp -d | tee /tmp/noma-verify && cd /tmp/noma-verify
npm init -y >/dev/null
npm install @ferax564/noma-cli@latest @ferax564/noma-mcp-server@latest @ferax564/noma-agent-sdk@latest
npx noma --version
```

Expected: each command prints the new version.

## If a publish fails midway

- `noma-cli` publish failed → fix the issue, retry. Nothing else has shipped.
- `noma-cli` published but `mcp-server` failed → the CLI is live but the matched MCP version is not. Fix and retry the MCP and SDK publishes. Consumers installing only `noma-cli` are unaffected; consumers installing `mcp-server` from npm would get the old version (no regression).
- All three published but one was wrong → use `npm deprecate @ferax564/<pkg>@<bad-version> "see <next-version>"` and immediately publish a patch. Do NOT `npm unpublish` — npm forbids unpublishing versions older than 24h that have any dependents.

## After publish

```bash
# Bump the .npmrc-tracked engines version in CHANGELOG/PLAN if needed
# Close the v0.12.0 GH milestone if one exists
gh issue list --label release --search "v0.12.0" --state open
```
