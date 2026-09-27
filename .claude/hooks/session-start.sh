#!/bin/bash
# Prepares a Claude Code on the web session so tests, lint, and the site build run:
# npm dependencies, a Python venv for the agent SDK (system pip cannot install into the
# Debian-managed Python), and Puppeteer pointed at the preinstalled Chromium (the
# sandbox cannot download Puppeteer's own Chrome, and browser tests hang without it).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

chromium=""
for candidate in /opt/pw-browsers/chromium "$(command -v chromium 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then chromium="$candidate"; break; fi
done

export PUPPETEER_SKIP_DOWNLOAD=1
npm install --no-audit --no-fund

venv="$CLAUDE_PROJECT_DIR/.venv"
[ -x "$venv/bin/python" ] || python3 -m venv "$venv"
"$venv/bin/python" -m pip install --quiet --disable-pip-version-check -e 'packages/agent-sdk-py[test]'

{
  echo "export PATH=\"$venv/bin:\$PATH\""
  echo "export PUPPETEER_SKIP_DOWNLOAD=1"
  if [ -n "$chromium" ]; then echo "export PUPPETEER_EXECUTABLE_PATH=\"$chromium\""; fi
} >> "$CLAUDE_ENV_FILE"
