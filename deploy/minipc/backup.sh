#!/usr/bin/env bash
# Online backup of the noma-data volume: a consistent SQLite snapshot (better-sqlite3's
# backup API, safe while the server writes) plus documents, users, sites and blobs.
# Writes $NOMA_BACKUP_DIR/noma-<UTC timestamp>.tar.gz and keeps the newest $NOMA_BACKUP_KEEP.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="${NOMA_BACKUP_DIR:-$HOME/backups/noma}"
keep="${NOMA_BACKUP_KEEP:-14}"
mkdir -p "$dir"
out="$dir/noma-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"

docker compose -f "$here/compose.yaml" exec -T noma-cloud sh -ec '
  rm -rf /tmp/noma-backup && mkdir -p /tmp/noma-backup
  node -e "
    const Database = require(\"better-sqlite3\");
    const db = new Database(process.env.NOMA_CLOUD_DB || \"/data/noma/noma-cloud.sqlite\", { readonly: true });
    db.backup(\"/tmp/noma-backup/noma-cloud.sqlite\").then(() => db.close(), (error) => { console.error(error); process.exit(1); });
  "
  tar -czf - -C /data/noma \
    --exclude=./noma-cloud.sqlite --exclude=./noma-cloud.sqlite-wal --exclude=./noma-cloud.sqlite-shm . \
    -C /tmp/noma-backup noma-cloud.sqlite
  rm -rf /tmp/noma-backup
' > "$out.partial"
mv "$out.partial" "$out"
echo "wrote $out ($(du -h "$out" | cut -f1))"

ls -1t "$dir"/noma-*.tar.gz | tail -n +"$((keep + 1))" | xargs -r rm -f
