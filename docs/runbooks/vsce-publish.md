# VS Code Marketplace publish runbook

Manual steps to publish `noma-language` to the VS Code Marketplace. Listed as pending maintainer step since v0.7 (see PLAN.md §24.9, §24.11, §24.22).

## Prerequisites

- Azure DevOps Personal Access Token (PAT) for `ferax564` publisher
  - Org: `ferax564` (or your Azure DevOps org)
  - Scope: **Marketplace → Manage**
  - Generate at: <https://dev.azure.com/_usersSettings/tokens>
  - Save in a password manager — Azure shows the token exactly once
- `vsce` CLI installed:
  ```bash
  npm install -g @vscode/vsce
  ```
- Publisher `ferax564` must exist on the Marketplace. If not:
  - Visit <https://marketplace.visualstudio.com/manage/publishers> and create it.

## One-time login

```bash
vsce login ferax564
# Paste the PAT when prompted. Stored in ~/.vsce
```

## Publish

```bash
cd tools/vscode-noma
# Re-package to make sure the .vsix matches the current source
npx @vscode/vsce package
# Confirms a fresh noma-language-<version>.vsix is in tools/vscode-noma/
```

Then publish:

```bash
npx @vscode/vsce publish
# OR explicit version
npx @vscode/vsce publish 0.2.1
```

`vsce` will:
1. Read `tools/vscode-noma/package.json` (publisher `ferax564`, version `0.2.1`)
2. Bundle the extension (respecting `.vscodeignore`)
3. Upload to the Marketplace
4. Return a public URL

## Verify

```bash
# Open in a real VS Code install
code --install-extension ferax564.noma-language
```

Marketplace listing should appear within a few minutes at:
<https://marketplace.visualstudio.com/items?itemName=ferax564.noma-language>

## Common errors

| Error | Fix |
|---|---|
| `ERROR Missing publisher name.` | Check `package.json` has `"publisher": "ferax564"` |
| `Access Denied. The token used is not associated with publisher 'ferax564'.` | PAT was issued under wrong org. Regenerate under the org that owns the publisher. |
| `ERROR: A 'repository' field is missing from the manifest file.` | `package.json` already has `repository`. Re-run `vsce package` to refresh `.vsix`. |
| `Make sure to edit the README.md file before you publish your extension.` | Marketplace blocks default boilerplate. The current README is already custom — no action needed. |
| `Icon is missing from the extension manifest.` | Non-blocking warning. Tracked for v0.3.0 (see `package.json` line with `"//icon"` note). |

## After publish

1. Bump `tools/vscode-noma/CHANGELOG.md` with the marketplace-live date.
2. Update `PLAN.md` §24.9 line 4 from "prep ready / ⏳ live publish pending" to "✅ live in Marketplace as of YYYY-MM-DD".
3. Re-check `README.md` install snippet still works: `ext install ferax564.noma-language`.

## Unpublishing

`vsce unpublish ferax564.noma-language@<version>` removes a single version. Use sparingly — installed users will not auto-roll-back. Prefer publishing a patch over unpublishing.
