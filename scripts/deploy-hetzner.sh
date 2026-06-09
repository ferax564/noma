#!/usr/bin/env bash
set -euo pipefail

target="${HETZNER_TARGET:-${DEPLOY_TARGET:-hetzner}}"
remote_root="${HETZNER_PATH:-${DEPLOY_PATH:-/var/www/noma}}"
build_cmd="${NOMA_BUILD_CMD:-npm run build:site}"
skip_build="${NOMA_SKIP_BUILD:-0}"
provision="${HETZNER_PROVISION:-0}"
domain="${HETZNER_DOMAIN:-_}"
health_url="${HETZNER_URL:-}"

quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

if [[ "$target" == "" ]]; then
  echo "error: HETZNER_TARGET or DEPLOY_TARGET is required" >&2
  exit 2
fi

if [[ "$remote_root" != /* ]]; then
  echo "error: HETZNER_PATH must be an absolute remote path" >&2
  exit 2
fi

if [[ ! "$domain" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "error: HETZNER_DOMAIN may only contain letters, digits, dots, underscores, and hyphens" >&2
  exit 2
fi

if [[ "$skip_build" != "1" ]]; then
  eval "$build_cmd"
fi

if [[ ! -d dist ]]; then
  echo "error: dist/ does not exist; run npm run build:site first" >&2
  exit 2
fi

release="$(date -u +%Y%m%d%H%M%S)"
remote_root="${remote_root%/}"
remote_release="$remote_root/releases/$release"
remote_current="$remote_root/current"

echo "deploying dist/ to $target:$remote_release"
ssh "$target" "mkdir -p $(quote "$remote_release")"
rsync -az --delete --exclude ".DS_Store" dist/ "$target:$remote_release/"

ssh "$target" "ln -sfn $(quote "$remote_release") $(quote "$remote_current") && find $(quote "$remote_root/releases") -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +6 | xargs -r rm -rf"

if [[ "$provision" == "1" ]]; then
  echo "provisioning nginx for $domain -> $remote_current"
  ssh "$target" "if ! command -v nginx >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx; fi"
  tmp_conf="$(mktemp)"
  cat > "$tmp_conf" <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $domain;

  root $remote_current;
  index index.html;

  location / {
    try_files \$uri \$uri/ /index.html;
  }

  location ~* \\.(?:css|js|mjs|json|png|jpg|jpeg|gif|svg|ico|pdf|docx|txt)$ {
    try_files \$uri =404;
    access_log off;
    expires 1h;
    add_header Cache-Control "public";
  }
}
EOF
  scp "$tmp_conf" "$target:/tmp/noma-nginx.conf"
  rm -f "$tmp_conf"
  ssh "$target" "mv /tmp/noma-nginx.conf /etc/nginx/sites-available/noma && ln -sfn /etc/nginx/sites-available/noma /etc/nginx/sites-enabled/noma && nginx -t && systemctl enable --now nginx && systemctl reload nginx"
fi

if [[ "$health_url" != "" ]]; then
  echo "checking $health_url"
  curl -fsSIL "$health_url" >/dev/null
fi

echo "deployed $release to $target:$remote_current"
