#!/usr/bin/env bash
#
# Deploy the shop to the always-free VM from your own computer.
#
#   cp deploy/.env.example deploy/.env      # then edit the values
#   DXN_HOST=ubuntu@203.0.113.10 DXN_DOMAIN=shop.example.com ./deploy/deploy.sh
#
# Requirements: ssh access to the VM, deploy/.env filled in. rsync is used when
# available; otherwise the files are streamed over ssh with tar.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${DXN_ENV_FILE:-$SCRIPT_DIR/.env}"
REMOTE_DIR="${DXN_REMOTE_DIR:-/opt/dxn-stockpoint}"
HOST="${DXN_HOST:-}"
DOMAIN="${DXN_DOMAIN:-}"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -n "$HOST" ]] || die "Set DXN_HOST=user@server-ip"
[[ -n "$DOMAIN" ]] || die "Set DXN_DOMAIN=shop.example.com"
[[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE — copy deploy/.env.example and fill it in"
grep -q '^DXN_DOMAIN=' "$ENV_FILE" || die "$ENV_FILE must define DXN_DOMAIN"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST")
SCP=(scp -q -o BatchMode=yes -o ConnectTimeout=15)

echo "==> Preparing $REMOTE_DIR on $HOST"
"${SSH[@]}" "mkdir -p '$REMOTE_DIR/app' '$REMOTE_DIR/backups'"

echo "==> Uploading server, web app and deployment files"
if command -v rsync >/dev/null 2>&1; then
  rsync -az --delete \
    --exclude '.env' \
    --exclude 'backups' \
    --exclude 'server/data' \
    --exclude 'node_modules' \
    "$ROOT/Dockerfile" "$HOST:$REMOTE_DIR/app/"
  rsync -az --delete "$ROOT/server" "$HOST:$REMOTE_DIR/app/"
  rsync -az --delete "$ROOT/docs" "$HOST:$REMOTE_DIR/app/"
  rsync -az --delete --exclude '.env' "$ROOT/deploy" "$HOST:$REMOTE_DIR/app/"
else
  tar -C "$ROOT" -czf - Dockerfile server docs deploy \
    --exclude 'deploy/.env' --exclude 'server/data' \
    | "${SSH[@]}" "tar -C '$REMOTE_DIR/app' -xzf -"
fi

echo "==> Uploading secrets (deploy/.env)"
"${SCP[@]}" "$ENV_FILE" "$HOST:$REMOTE_DIR/app/deploy/.env"
"${SSH[@]}" "chmod 600 '$REMOTE_DIR/app/deploy/.env'"

echo "==> Building and starting containers"
"${SSH[@]}" "cd '$REMOTE_DIR/app/deploy' && docker compose pull caddy && docker compose up -d --build --remove-orphans"

echo "==> Installing the daily backup timer"
"${SSH[@]}" "chmod +x '$REMOTE_DIR/app/deploy/'*.sh && sudo -n cp '$REMOTE_DIR/app/deploy/systemd/'*.service '$REMOTE_DIR/app/deploy/systemd/'*.timer /etc/systemd/system/ && sudo -n systemctl daemon-reload && sudo -n systemctl enable --now dxn-backup.timer" \
  || echo "WARNING: could not install the backup timer (sudo unavailable). Run deploy/systemd setup manually." >&2

echo "==> Waiting for https://$DOMAIN/api/v1/health"
ok=0
for attempt in $(seq 1 30); do
  if "${SSH[@]}" "curl -fsS --max-time 10 'https://$DOMAIN/api/v1/health'" >/tmp/dxn-health.json 2>/dev/null; then
    ok=1
    break
  fi
  sleep 4
done

if [[ "$ok" -eq 1 ]]; then
  echo "==> Healthy:"
  cat /tmp/dxn-health.json
  echo
  echo "Deploy complete: https://$DOMAIN"
else
  echo "WARNING: health check did not pass yet. Check DNS, the Oracle security list and logs:" >&2
  echo "  ssh $HOST 'cd $REMOTE_DIR/app/deploy && docker compose logs --tail=80'" >&2
  exit 1
fi
