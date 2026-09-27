#!/usr/bin/env bash
# Install or update Noma Cloud on this host. Idempotent: safe to re-run after `git pull`.
#   deploy/minipc/install.sh              build, (re)start, wait for /healthz
#   deploy/minipc/install.sh --tailscale  also publish HTTPS on the tailnet with `tailscale serve`
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
tailscale=0
for arg in "$@"; do
  case "$arg" in
    --tailscale) tailscale=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "error: unknown argument $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }

command -v docker >/dev/null || { echo "error: docker is not installed" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "error: the docker compose plugin is missing" >&2; exit 1; }

# The minipc has had two Docker engines (apt and snap) racing for /var/run/docker.sock.
# Refuse to start a second copy in whichever engine currently owns the socket.
root_dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
case "$root_dir" in
  */snap/*) engine="snap" ;;
  "") echo "error: cannot reach the Docker daemon" >&2; exit 1 ;;
  *) engine="apt" ;;
esac
if pgrep -f '/snap/docker/.*/dockerd' >/dev/null 2>&1 && pgrep -f '^/usr/bin/dockerd' >/dev/null 2>&1; then
  warn "two Docker engines are running; the docker CLI talks to the $engine one ($root_dir)."
  if [[ "${NOMA_DOCKER_ENGINE:-apt}" != "$engine" ]]; then
    echo "error: expected the ${NOMA_DOCKER_ENGINE:-apt} engine. Restart it (sudo systemctl restart docker.socket docker.service)" >&2
    echo "       or set NOMA_DOCKER_ENGINE=$engine if Noma should live there." >&2
    exit 1
  fi
fi

umask 077
mkdir -p "$here/secrets"
[[ -f "$here/.env" ]] || { cp "$here/.env.example" "$here/.env"; say "created deploy/minipc/.env"; }
[[ -f "$here/projects.conf" ]] || { umask 022; cp "$here/projects.conf.example" "$here/projects.conf"; umask 077; }
for secret in access-token invitation-code; do
  if [[ ! -s "$here/secrets/$secret" ]]; then
    openssl rand -hex 24 > "$here/secrets/$secret"
    say "generated secrets/$secret"
  fi
done

set -a
# shellcheck disable=SC1091
source "$here/.env"
set +a
port="${NOMA_PUBLISH_PORT:-8140}"
ts_port="${NOMA_TAILSCALE_HTTPS_PORT:-8444}"

say "building and starting noma-cloud from $(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || echo 'working tree')"
docker compose -f "$here/compose.yaml" up -d --build

say "waiting for http://127.0.0.1:$port/healthz"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then break; fi
  sleep 2
done
if ! curl -fsS "http://127.0.0.1:$port/healthz"; then
  echo >&2
  echo "error: noma-cloud did not become healthy; recent logs:" >&2
  docker compose -f "$here/compose.yaml" logs --tail 60 noma-cloud >&2
  exit 1
fi
echo

url="http://127.0.0.1:$port"
if [[ "$tailscale" == 1 ]]; then
  command -v tailscale >/dev/null || { echo "error: tailscale is not installed" >&2; exit 1; }
  sudo tailscale serve --bg --https="$ts_port" "http://127.0.0.1:$port"
  dns="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
  [[ -n "$dns" ]] && url="https://$dns:$ts_port"
fi

cat <<NEXT

Noma Cloud is up.
  Open:        $url/cloud.html?access=\$(cat deploy/minipc/secrets/access-token)
  Invitation:  deploy/minipc/secrets/invitation-code
  Logs:        docker compose -f deploy/minipc/compose.yaml logs -f noma-cloud

First run only (see deploy/minipc/README.md, "First run"):
  1. Register the owner with the invitation code.
  2. Put the owner id (GET /api/users/me) in NOMA_CLOUD_ADMIN_USER_IDS in .env and re-run this script.
  3. Create a read+write personal access token and save it to deploy/minipc/secrets/sync-token.
  4. deploy/minipc/sync.sh   # one space per project in projects.conf
NEXT
