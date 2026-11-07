# Production deployment — Oracle Cloud Always Free

This stack runs the whole shop for **$0/month**: the Node API, the web app and
the JSON database on an Oracle Cloud Always Free VM, with automatic HTTPS from
Caddy. No managed database, no paid host, no app-store account required for
side-loading the Android apps.

```
Internet ──► Caddy (80/443, auto TLS) ──► Node API (4173, private)
                                            ├── /api/v1/*      JSON API
                                            ├── /             web app (docs/)
                                            └── /app/server/data/db.json (Docker volume)
```

## What you need

- An Oracle Cloud account (Always Free).
- A domain name. Cloudflare's free DNS works well; Cloudflare is optional.
- SSH access to the VM.
- Docker is installed by the bootstrap script. Nothing else is required.

## 1. Create the VM

Oracle Console → **Compute → Instances → Create instance**.

| Setting | Recommended |
|---|---|
| Image | Canonical Ubuntu 24.04 (or 22.04) |
| Shape | `VM.Standard.A1.Flex` (ARM, Ampere) — 1–4 OCPU, 6–24 GB |
| Boot volume | 50–100 GB (Always Free includes 200 GB total) |
| Networking | Assign a public IPv4 address |

If A1 capacity is unavailable, `VM.Standard.E2.1.Micro` (AMD, 1 GB) also works
for a single shop; the bootstrap script adds swap automatically.

## 2. Open the ports (two places)

1. **Oracle security list**: Networking → VCN → Security Lists → Default →
   Add ingress rules for TCP **80** and TCP **443** from `0.0.0.0/0`.
2. **Host firewall**: handled by `oracle-bootstrap.sh` (UFW + Oracle's iptables
   rules + persistence).

SSH (22) is already open in a new instance.

## 3. Point DNS at the VM

Create an **A record** for e.g. `shop.example.com` pointing at the instance's
public IPv4 address. If you use Cloudflare, set the proxy status to **DNS only**
(grey cloud) for the first certificate issue; you can enable the orange cloud
afterwards.

Verify from your computer:

```bash
dig +short shop.example.com
```

## 4. Bootstrap the VM (once)

Copy `deploy/oracle-bootstrap.sh` to the VM (or clone the repo there) and run:

```bash
sudo bash oracle-bootstrap.sh
```

This installs Docker + Compose, adds swap on small instances, opens 80/443, and
creates `/opt/dxn-stockpoint`.

## 5. Configure and deploy from your computer

```bash
cp deploy/.env.example deploy/.env
# edit deploy/.env: DXN_DOMAIN, DXN_PIN, DXN_ADMIN_KEY
openssl rand -hex 32          # use this for DXN_ADMIN_KEY

DXN_HOST=ubuntu@203.0.113.10 DXN_DOMAIN=shop.example.com ./deploy/deploy.sh
```

The deploy script uploads the server, web app and compose files, uploads
`deploy/.env` with mode `600`, builds the image, starts the stack, installs the
daily backup timer, and waits for `https://<domain>/api/v1/health`.

First boot on a small VM takes a few minutes (image build + certificate).

## 6. Build the Android apps against the live API

```bash
cd android/DXNStockpoint
./scripts/build-apps.sh --release --api-url https://shop.example.com/
```

Artifacts land in `dist/android/`. The owner app keeps the package id
`com.dxn.stockpoint` so existing installs upgrade in place; the customer app is
`com.dxn.stockpoint.client`.

## Operations

| Task | Command (on the VM) |
|---|---|
| Status | `cd /opt/dxn-stockpoint/app/deploy && docker compose ps` |
| Logs | `docker compose logs -f --tail=100 api` |
| Restart | `docker compose restart api` |
| Update | re-run `./deploy/deploy.sh` from your computer |
| Manual backup | `sudo /opt/dxn-stockpoint/app/deploy/backup.sh` |
| Restore | `sudo /opt/dxn-stockpoint/app/deploy/restore.sh <archive>` |
| Backup timer | `systemctl list-timers dxn-backup.timer` |

Backups are written to `/opt/dxn-stockpoint/backups`, kept for 14 days and
checksummed. For an off-site copy, install `rclone`, configure a free
Cloudflare R2 bucket (10 GB free) and run:

```bash
DXN_BACKUP_REMOTE=r2:dxn-backups backup.sh
```

## Security notes

- Change the PIN and admin key before the first deploy. The server refuses to
  start in production with the development defaults.
- `DXN_ADMIN_KEY` must stay secret; it is the break-glass admin credential used
  by CI and scripts.
- The API only accepts browser requests from the same origin plus anything in
  `DXN_CORS_ORIGINS`. Android requests carry no `Origin` header and are
  unaffected.
- Per-IP rate limiting defaults to 300 requests/minute, with a stricter limit
  on PIN login. Tune with `DXN_RATE_LIMIT`.
- `deploy/.env` is gitignored. Never bake secrets into the image.
- The container runs as an unprivileged user with a read-only root filesystem;
  only the data volume is writable.

## Troubleshooting

**Certificate not issued** — DNS must resolve to the VM before Caddy starts.
Check `docker compose logs caddy`. Confirm ports 80/443 are open in both the
Oracle security list and the host firewall.

**API unhealthy** — `docker compose logs --tail=100 api`. The usual cause is a
missing `DXN_PIN` or `DXN_ADMIN_KEY` in `deploy/.env`.

**Data looks empty after a redeploy** — data lives in the named volume
`dxn-stockpoint_dxn-data`, not in the image. Check
`docker volume ls --filter label=com.docker.compose.volume=dxn-data`.

**Locked out of admin** — reset the PIN on the VM without touching shop data:

```bash
cd /opt/dxn-stockpoint/app/deploy
docker compose exec api node server/reset-pin.js 987654
```

Existing sessions stay valid until they expire. Restoring a backup taken before
the change is the alternative.
