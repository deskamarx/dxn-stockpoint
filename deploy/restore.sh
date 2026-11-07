#!/usr/bin/env bash
#
# Restore a database backup into the running Docker volume.
#
#   sudo ./restore.sh /opt/dxn-stockpoint/backups/dxn-db-20260101T020000Z.tar.gz
#
# The API container is stopped for the restore and started again afterwards.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dxn-stockpoint}"
ARCHIVE="${1:-}"

if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Usage: $0 /path/to/dxn-db-*.tar.gz" >&2
  exit 1
fi

if [[ -f "$ARCHIVE.sha256" ]]; then
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
fi

VOLUME="$(docker volume ls -q --filter label=com.docker.compose.volume=dxn-data | head -n 1)"
if [[ -z "$VOLUME" ]]; then
  echo "Could not find the dxn-data Docker volume. Start the stack once first." >&2
  exit 1
fi

echo "Restoring $ARCHIVE into volume $VOLUME"
cd "$APP_DIR/app/deploy"
docker compose stop api
docker run --rm \
  -v "$VOLUME":/data \
  -v "$(cd "$(dirname "$ARCHIVE")" && pwd)":/backup:ro \
  alpine:3 sh -c "rm -rf /data/* && tar xzf '/backup/$(basename "$ARCHIVE")' -C /data"
docker compose start api

echo "Restore complete. Verifying health…"
for attempt in $(seq 1 15); do
  if docker compose exec -T api wget -qO- http://127.0.0.1:4173/api/v1/health >/dev/null 2>&1; then
    echo "API is healthy."
    exit 0
  fi
  sleep 2
done

echo "API did not report healthy; check: docker compose logs --tail=80 api" >&2
exit 1
