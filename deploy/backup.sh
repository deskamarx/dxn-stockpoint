#!/usr/bin/env bash
#
# Back up the shop database (Docker volume) to /opt/dxn-stockpoint/backups.
# Runs daily from the dxn-backup systemd timer. Optional off-site copy:
#
#   DXN_BACKUP_REMOTE=r2:dxn-backups ./backup.sh
#
# requires rclone to be configured for that remote.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dxn-stockpoint}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/dxn-db-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

VOLUME="$(docker volume ls -q --filter label=com.docker.compose.volume=dxn-data | head -n 1)"
if [[ -z "$VOLUME" ]]; then
  echo "Could not find the dxn-data Docker volume. Start the stack once first." >&2
  exit 1
fi

docker run --rm \
  -v "$VOLUME":/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine:3 sh -c "tar czf '/backup/$(basename "$ARCHIVE")' -C /data ."

sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
echo "Backup written: $ARCHIVE"

if [[ -n "${DXN_BACKUP_REMOTE:-}" ]] && command -v rclone >/dev/null 2>&1; then
  rclone copy "$ARCHIVE" "$DXN_BACKUP_REMOTE" --checksum
  rclone copy "$ARCHIVE.sha256" "$DXN_BACKUP_REMOTE" --checksum
  echo "Off-site copy sent to $DXN_BACKUP_REMOTE"
fi

find "$BACKUP_DIR" -name 'dxn-db-*.tar.gz*' -mtime "+$KEEP_DAYS" -delete
echo "Removed backups older than $KEEP_DAYS days."
