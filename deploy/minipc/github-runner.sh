#!/usr/bin/env bash
# Register the minipc as a self-hosted GitHub Actions runner for one PRIVATE repository.
#
#   sudo deploy/minipc/github-runner.sh <owner/repo> <registration-token> [count]
#
# Get the token from the repository: Settings → Actions → Runners → New self-hosted
# runner (it is shown in the ./config.sh line and is valid for one hour). `count`
# registers that many runners for the repo (default 1) so matrix jobs run in parallel.
#
# Only for private repositories: on a public repository, a pull request from a fork
# would run its code on this machine. The script refuses public repos it can check.
#
# Each runner lives in /srv/gh-runner/<repo>-<n>, runs as the `gh-runner` user (in the
# docker group, which is root-equivalent: private repos only) under systemd, and has
# the labels self-hosted, linux, x64, minipc. Re-running is safe; registered runners
# are left alone.
set -euo pipefail

repo="${1:-}"
token="${2:-}"
count="${3:-1}"
if [[ ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || [[ -z "$token" ]] || [[ ! "$count" =~ ^[1-9]$ ]]; then
  sed -n '2,15p' "$0" >&2
  exit 2
fi
[[ "$(id -u)" == 0 ]] || { echo "error: run with sudo" >&2; exit 1; }

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# Anonymous lookup: 200 means GitHub shows the repo to anyone, so `.private` must be
# true (read with tostring: jq's `//` would turn `false` into the fallback); 404 means
# it is not visible anonymously, i.e. private. Anything else stops the script.
repo_json="$(mktemp)"
status="$(curl -sS -o "$repo_json" -w '%{http_code}' "https://api.github.com/repos/$repo" 2>/dev/null || echo 000)"
private="$(jq -r '.private | tostring' "$repo_json" 2>/dev/null || echo unknown)"
rm -f "$repo_json"
case "$status:$private" in
  200:true | 404:*) ;;
  200:false)
    echo "error: $repo is public; a self-hosted runner would run fork pull requests on this machine" >&2
    exit 1 ;;
  *)
    if [[ "${RUNNER_ALLOW_UNVERIFIED:-}" != "1" ]]; then
      echo "error: could not confirm $repo is private (GitHub API answered $status); retry, or set RUNNER_ALLOW_UNVERIFIED=1 if you are sure" >&2
      exit 1
    fi ;;
esac

say "host packages (build tools, jq, gh, Playwright browser libraries)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl jq git build-essential unzip zip ca-certificates gnupg nodejs npm >/dev/null
if ! command -v gh >/dev/null; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq && apt-get install -y -qq gh >/dev/null
fi
# Workflows skip `playwright install --with-deps` on self-hosted runners (it needs sudo),
# so the browser system libraries are installed here once.
npx -y playwright@1 install-deps chromium >/dev/null

say "runner user"
id gh-runner >/dev/null 2>&1 || useradd --system --create-home --home-dir /srv/gh-runner --shell /bin/bash gh-runner
getent group docker >/dev/null && usermod -aG docker gh-runner

release_path="latest"
[[ -n "${RUNNER_VERSION:-}" ]] && release_path="tags/v${RUNNER_VERSION#v}"
release_json="$(curl -fsSL "https://api.github.com/repos/actions/runner/releases/$release_path")"
version="$(jq -r '.tag_name' <<<"$release_json" | sed 's/^v//')"
sha="$(jq -r '.body' <<<"$release_json" | sed -n 's/.*<!-- BEGIN SHA linux-x64 -->\([0-9a-f]\{64\}\)<!-- END SHA linux-x64 -->.*/\1/p' | head -1)"
[[ -n "$sha" ]] || { echo "error: no linux-x64 SHA-256 in the v$version release notes; set RUNNER_VERSION to a release that has one" >&2; exit 1; }
tarball="/srv/gh-runner/actions-runner-linux-x64-$version.tar.gz"
if [[ ! -f "$tarball" ]]; then
  say "downloading actions/runner v$version"
  curl -fsSL -o "$tarball.partial" "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-x64-$version.tar.gz"
  echo "$sha  $tarball.partial" | sha256sum -c --quiet
  mv "$tarball.partial" "$tarball"
  chown gh-runner: "$tarball"
fi

slug="${repo//\//-}"
for n in $(seq 1 "$count"); do
  dir="/srv/gh-runner/$slug-$n"
  name="minipc-$slug-$n"
  if [[ -f "$dir/.runner" ]]; then
    say "$name already registered"
    continue
  fi
  say "registering $name"
  install -d -o gh-runner -g gh-runner "$dir"
  sudo -u gh-runner tar -xzf "$tarball" -C "$dir"
  "$dir/bin/installdependencies.sh" >/dev/null
  sudo -u gh-runner "$dir/config.sh" --unattended --replace \
    --url "https://github.com/$repo" --token "$token" \
    --name "$name" --labels minipc --work _work
  (cd "$dir" && ./svc.sh install gh-runner >/dev/null && ./svc.sh start >/dev/null)
done

say "done — runners for $repo:"
systemctl list-units --type=service --no-legend "actions.runner.$slug*" | awk '{print "  " $1 "  " $4}'
