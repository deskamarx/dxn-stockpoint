#!/usr/bin/env bash
#
# One-time setup for a fresh Oracle Cloud Always Free Ubuntu VM (ARM or AMD).
# Run on the VM as a sudo-capable user:
#
#   curl -fsSLO https://raw.githubusercontent.com/<you>/<repo>/main/deploy/oracle-bootstrap.sh
#   sudo bash oracle-bootstrap.sh
#
# It installs Docker, adds a swap file on small instances, opens 80/443 in the
# host firewall, and prepares /opt/dxn-stockpoint. The Oracle *security list*
# must also allow TCP 80 and 443 — that is a console setting, documented below.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dxn-stockpoint}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
SSH_PORT="${SSH_PORT:-22}"

log() { printf '\n==> %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git rsync ufw iptables-persistent

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine"
  curl -fsSL https://get.docker.com | sh
fi

systemctl enable --now docker

TARGET_USER="${SUDO_USER:-ubuntu}"
if id "$TARGET_USER" >/dev/null 2>&1; then
  usermod -aG docker "$TARGET_USER" || true
fi

if ! docker compose version >/dev/null 2>&1; then
  log "Installing the Docker Compose plugin"
  apt-get install -y docker-compose-plugin || true
fi

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [[ "$MEM_MB" -lt 2048 && ! -f /swapfile ]]; then
  log "Adding ${SWAP_SIZE} swap (instance has ${MEM_MB} MB RAM)"
  fallocate -l "$SWAP_SIZE" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Opening 80/443 in the host firewall"
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null

# Oracle's Ubuntu images ship with iptables REJECT rules that survive reboots.
if command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
  iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
  netfilter-persistent save >/dev/null 2>&1 || true
fi

log "Preparing ${APP_DIR}"
mkdir -p "$APP_DIR/backups"
if id "$TARGET_USER" >/dev/null 2>&1; then
  chown -R "$TARGET_USER":"$TARGET_USER" "$APP_DIR"
fi

if [[ -n "${REPO_URL:-}" ]]; then
  log "Cloning ${REPO_URL}"
  if [[ ! -d "$APP_DIR/app/.git" ]]; then
    sudo -u "$TARGET_USER" git clone "$REPO_URL" "$APP_DIR/app"
  else
    sudo -u "$TARGET_USER" git -C "$APP_DIR/app" pull --ff-only
  fi
fi

cat <<EOF

Bootstrap complete.

Next steps:
  1. In the Oracle Cloud console, add ingress rules for TCP 80 and 443
     (Networking -> VCN -> Security Lists -> Default Security List).
  2. Point your domain's A record at this VM's public IPv4 address.
  3. From your own computer:
       DXN_HOST=$TARGET_USER@<public-ip> DXN_DOMAIN=shop.example.com \\
         ./deploy/deploy.sh
     (or copy this repository to $APP_DIR/app and run docker compose there)

EOF
