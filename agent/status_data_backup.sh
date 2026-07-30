#!/usr/bin/env bash
# Creates consistent SQLite backups plus the JSON state files, retains 14 days,
# and only records the heartbeat after the archive is complete.
set -euo pipefail

APP_DIR="${STATUS_APP_DIR:-/home/ubuntu/apps/sky-status-dashboard}"
ENV_FILE="${STATUS_ENV_FILE:-${APP_DIR}/.env}"
BACKUP_ROOT="${STATUS_BACKUP_ROOT:-/home/ubuntu/backups/status-skyhong}"
CONTAINER="${STATUS_CONTAINER:-sky-status-dashboard-status-dashboard-1}"
ENDPOINT="${STATUS_ENDPOINT:-https://status.skyhong.tw}"
RETENTION_DAYS="${STATUS_BACKUP_RETENTION_DAYS:-14}"

if [ -z "${HEARTBEAT_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
  HEARTBEAT_TOKEN=$(grep -E '^HEARTBEAT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
fi
: "${HEARTBEAT_TOKEN:?HEARTBEAT_TOKEN required}"

mkdir -p "$BACKUP_ROOT"
work_dir=$(mktemp -d)
cleanup() {
  docker exec "$CONTAINER" rm -f /tmp/status-usage-backup.sqlite /tmp/status-uptime-backup.sqlite >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

docker exec "$CONTAINER" node -e '
  const { DatabaseSync, backup } = require("node:sqlite");
  (async () => {
    for (const [source, destination] of [
      ["/data/usage.sqlite", "/tmp/status-usage-backup.sqlite"],
      ["/data/uptime.sqlite", "/tmp/status-uptime-backup.sqlite"],
    ]) {
      const db = new DatabaseSync(source, { readOnly: true });
      await backup(db, destination);
      db.close();
    }
  })().catch((error) => { console.error(error); process.exit(1); });
'
docker cp "$CONTAINER:/tmp/status-usage-backup.sqlite" "$work_dir/usage.sqlite" >/dev/null
docker cp "$CONTAINER:/tmp/status-uptime-backup.sqlite" "$work_dir/uptime.sqlite" >/dev/null

for state_file in agents.json alerts.json alert-delivery.json history.json incidents.json heartbeats.json; do
  if docker exec "$CONTAINER" test -f "/data/$state_file"; then
    docker cp "$CONTAINER:/data/$state_file" "$work_dir/$state_file" >/dev/null
  fi
done

stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive_tmp="$BACKUP_ROOT/.status-$stamp.tar.gz.tmp"
archive="$BACKUP_ROOT/status-$stamp.tar.gz"
tar -C "$work_dir" -czf "$archive_tmp" .
mv "$archive_tmp" "$archive"
find "$BACKUP_ROOT" -type f -name 'status-*.tar.gz' -mtime "+$RETENTION_DAYS" -delete

curl -fsS -X POST "${ENDPOINT%/}/api/heartbeat/status-data-backup" \
  -H "Authorization: Bearer $HEARTBEAT_TOKEN" >/dev/null

echo "status backup complete: $archive"
