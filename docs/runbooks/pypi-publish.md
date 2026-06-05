# PyPI publish runbook

Manual steps to publish the Python starter binding after the npm release is live.
The current in-tree package is `ferax564-noma-agent-sdk` v0.1.1 and remains
experimental until the v0.2.0 workflow layer lands.

## Prerequisites

- Python 3.10+
- PyPI account with rights to `ferax564-noma-agent-sdk`
- Node.js 20+ and the matching npm packages published
- Clean working tree on the release tag:
  ```bash
  git checkout v0.13.0
  git status
  ```

## Verify locally

```bash
npm run build -w @ferax564/noma-mcp-server
python -m venv /tmp/noma-py-verify
. /tmp/noma-py-verify/bin/activate
python -m pip install --upgrade pip build twine
python -m pip install -e 'packages/agent-sdk-py/[test]'
python -m pytest packages/agent-sdk-py/tests
```

## Build and check

```bash
rm -rf packages/agent-sdk-py/dist
python -m build packages/agent-sdk-py
python -m twine check packages/agent-sdk-py/dist/*
```

## Publish

```bash
python -m twine upload packages/agent-sdk-py/dist/*
```

## Verify install

```bash
mktemp -d | tee /tmp/noma-py-install
python -m venv /tmp/noma-py-install/venv
. /tmp/noma-py-install/venv/bin/activate
python -m pip install ferax564-noma-agent-sdk==0.1.1
python - <<'PY'
import noma_agent_sdk
print(noma_agent_sdk.__version__)
PY
```

Expected output: `0.1.1`.
