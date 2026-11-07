# Mohammadpur Stock Point v3.1.2 🛒

An offline-first point of sale for a DXN distributor stockpoint — **one API,
two dedicated Android apps and a web PWA that stay in sync**: an owner app for
the counter and a customer app for browsing, ordering and tracking. Sell with
no internet, sync the moment you have it.

| | |
|---|---|
| 🌐 Web app | served by the same deployment at `https://<your-domain>/` |
| 📱 Android | `dxn-owner-*.apk` and `dxn-client-*.apk` in GitHub Releases |
| 🖥️ Repo | https://github.com/deskamarx/dxn-stockpoint |
| 🔒 Privacy | docs/privacy.html on any deployment |

```
        ┌────────────────────────────┐
        │  Node shop server          │   single source of truth
        │  server/index.js           │   revision counter on every row
        │  api/ (PHP, legacy opt.)   │
        └─────────────┬──────────────┘
                      │  GET /api/v1/sync?since=<rev>
        ┌─────────────┴──────────────┬──────────────────┐
        │                            │                  │
┌───────▼─────────┐        ┌─────────▼────────┐  ┌──────▼──────────┐
│  Web (PWA)      │        │  Owner app       │  │  Customer app   │
│  docs/          │        │  com.dxn.stockpoint        │  com.dxn.stockpoint.client
│  localStorage   │        │  POS + admin     │  │  shop + account │
└─────────────────┘        └──────────────────┘  └─────────────────┘
```

- **One write path.** A sale made on the phone appears on the shop laptop within
  seconds — both clients read the same revision feed.
- **Every row carries `rev`.** Clients store the highest revision they have seen
  and ask only for what changed — cheap on mobile data.
- **Orders are idempotent.** Each sale carries a `client_uuid`; replaying a
  queued order after a dropped connection can never double-book a sale.
- **Stock is enforced on the server.** Two cashiers selling the last unit
  produce one sale and one clear `409 insufficient_stock` — unless the request
  explicitly passes `allow_oversell: 1` (stock then goes negative, a backorder).
- **Nothing is lost offline.** Sales queue in an outbox that survives a refresh
  and retries automatically when the connection returns.

## Quick start (local, everything included)

Requires Node 18+ (no npm packages, no build step).

```bash
npm start          # API + web app on http://127.0.0.1:4173, opens the browser
```

The web app auto-detects a same-origin API — no configuration screen needed on
first run. Sign in with the shop PIN **2468** to unlock orders, history and
admin tools.

Other commands:

| Command | What it does |
|---|---|
| `npm run serve` | Start the server without opening a browser |
| `npm run dev` | Start with auto-reload on server file changes |
| `npm run reset` | Wipe local data (server/data/db.json) and reseed |
| `npm run demo` | Start with demo demo catalogue reseed |
| `npm test` | 13 API contract tests against a live in-process server |
| `npm run check` | Static checks: import graph, sw.js precache, manifest references |

Data lives in `server/data/db.json` (gitignored). The optional admin key —
for machine-to-machine auth via `X-Api-Key` — defaults to
`local-dev-admin-key-change-me`; change it in `server/index.js` or the
`DXN_ADMIN_KEY` environment variable before exposing the server.

## Repository layout

| Path | What it is |
|---|---|
| `server/` | Zero-dependency Node HTTP server: the full API + PWA file host + JSON persistence (`server/lib/db.js` is a mini DB engine with revision tracking) |
| `api/` | PHP 8 + MySQL flavour of the same API — optional legacy deployment |
| `docs/` | The web app (ES modules, no build step) + PWA manifest & service worker |
| `android/DXNStockpoint/core` | Shared Android library: API client, models, repository, cache, reusable UI |
| `android/DXNStockpoint/owner-app` | Owner app (`com.dxn.stockpoint`) — POS, stock, orders, admin |
| `android/DXNStockpoint/client-app` | Customer app (`com.dxn.stockpoint.client`) — shop, cart, account, tracking |
| `deploy/` | Always-free Oracle Cloud + Docker + Caddy production stack |
| `tests/` | `api.test.mjs` — the contract the web and Android clients depend on |
| `scripts/` | Static checks, Android contract verifiers, legacy helpers |
| `.github/workflows/` | Server tests + both Android apps, artefact and release publishing |

> `backend/` is the retired v1 Node/SQLite server, kept for reference only.

## The web app (docs/)

A installable PWA built from plain ES modules and one stylesheet — no framework,
no build step, fully functional offline from the service-worker cache.

| Screen | What you can do |
|---|---|
| **Shop / storefront** | Customer-facing catalogue, cart, checkout — works as viewer or signed-in customer |
| **My account** | Customer sign-in/sign-up, profile, order history, live order tracking |
| **Track order** | Public tracking by order number + phone (packaging → dispatch → delivery) |
| **Dashboard** | Today's sales, month-to-date, 7-day revenue chart, low-stock watch, recent orders, quick actions |
| **Point of sale** | Product grid with category chips, SKU/Enter fast-add, retail ↔ member pricing, sticky cart panel, hold/resume sales |
| **Orders** | History with status chips, receipt modal, status changes, SteadFast shipping, CSV export, queued-sale recovery *(admin for history)* |
| **Inventory** | Stock levels, movements ledger, product create/edit/archive, CSV export *(admin write)* |
| **Customers** | Auto-built directory with order counts, spend and PV, WhatsApp deep links *(admin)* |
| **Reports** | Revenue by range (7/30/90/all), bestsellers, payment mix, CSV export *(admin)* |
| **Settings** | Server + SteadFast credentials, shop profile (5 tabs), PIN management, device backup/reset, about |

Extras: global search palette (`Ctrl+K`), `F2` jumps to the POS,
`Ctrl+Shift+D` toggles dark mode, light/dark theme follows the system, first-run
onboarding tour, and a cart drawer that works from any screen.

Keyboard & pixel: the shell caches every module in `sw.js`, so the POS opens on
a plane. Selling queues in the outbox on-device and syncs later.

## Using the API

`GET /api/v1/health` · `/config` · `/products` · `/products/{id}` · `/stock/movements`
`POST /api/v1/auth/login` · `/products` · `/stock/update` · `/stock/adjust` · `/orders`
`PUT /api/v1/products/{id}` · `/settings` · `PATCH` same
`POST /api/v1/orders/{id}/status` · `GET` `/orders` · `/orders/{id}` · `/orders/{id}/receipt`
`GET /api/v1/dashboard` · `/reports/sales` · `/settings` · `/sync` · `/sync/status`
`POST/GET /api/v1/courier/*` (SteadFast settings, shipment, status, webhook)

Auth is either `X-Api-Key: <admin_key>` (machines) or
`Authorization: Bearer <token>` from `POST /auth/login` with the shop PIN.
Orders, customers, reports, dashboard and settings writes are admin-only;
the product list is public for the in-store sign.

Run the contract tests any time:

```bash
npm test
```

## Master suite

Open `docs/suite.html` (or the deployed `…/suite.html`) for the unified
**DXN Suite** shell — one rail combining four workspaces:

- **Stockpoint** — the live POS from the real app, synced to the shop server
- **Flow** — the real Orders screen: status changes, SteadFast shipments,
  receipts and live tracking
- **Intelligence** — the real Dashboard and Reports: sales, stock watch,
  bestsellers, payment mix and customer analytics
- **PV Planner** — month-end target optimizer reading products, prices, PV and
  stock live from the API; its plans are handed to the real POS cart

Flow and Intelligence embed the same live app (`./index.html#/orders`,
`#/dashboard`) rather than mock screens, so every workspace reads the same
revision feed. The PV Planner falls back to a bundled catalogue only when the
API is unreachable.

## Android apps

Both apps live in one Gradle project and share `:core`.

| App | Package | Use it for |
|---|---|---|
| Owner | `com.dxn.stockpoint` | Counter sales, stock takes, order status, customer desk, admin panel |
| Customer | `com.dxn.stockpoint.client` | Catalogue, cart, DXN member pricing, account, order history, tracking |

```bash
cd android/DXNStockpoint
./scripts/new-client-keystore.sh            # once: creates the customer signing key
./scripts/build-apps.sh --release --api-url https://shop.example.com/
./scripts/build-apps.sh --release --api-url https://shop.example.com/ --aab
./scripts/build-apps.sh --debug --client-only
./scripts/bump-version.sh 3.2.0             # versionCode + versionName
```

Release builds refuse the `shop.example.com` placeholder unless
`--allow-placeholder` is passed, so an APK cannot ship pointed at a domain that
does not exist. `DXN_API_URL` works as an alternative to `--api-url`.

PowerShell equivalents (`build-apps.ps1`, `new-client-keystore.ps1`,
`bump-version.ps1`) are included for Windows.

- Release builds are minified (R8) with resource shrinking, HTTPS-only network
  security, backups disabled and no cleartext traffic.
- Signing credentials come from `DXN_*` environment variables or the gitignored
  `.tooling/*.env` files. Each app has its own key; the owner package id is
  unchanged so existing installations upgrade in place.
- Point the build at the production API with
  `--api-url https://shop.example.com/`, or set `dxn.apiBaseUrl` in
  `gradle.properties`.
- Icons, labels and the launcher are separate per app.

## Deploy for real (permanently free)

Full walkthrough in [deploy/README.md](deploy/README.md). The short version:

1. **Oracle Cloud Always Free VM** (ARM Ampere, 1–4 OCPU / 6–24 GB) running
   Ubuntu. Bootstrap installs Docker, swap and the firewall:
   `sudo bash deploy/oracle-bootstrap.sh`.
2. **Deploy from your computer** after pointing DNS at the VM:
   `DXN_HOST=ubuntu@<ip> DXN_DOMAIN=shop.example.com ./deploy/deploy.sh`.
   Caddy obtains and renews the HTTPS certificate automatically.
3. **Backups** run daily through a systemd timer into
   `/opt/dxn-stockpoint/backups`, with optional free Cloudflare R2 off-site
   copies. `restore.sh` puts a backup back.
4. **Local LAN** still works with `npm start` or `start-lan.cmd`; the web app
   now defaults to its own origin, so no API URL is needed.
5. **PHP** (`api/`) remains available for shared hosting but is no longer the
   recommended production path.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sync pill says *Offline* | Open Settings → *Test connection*; wrong origin or server not running |
| Orders missing after a sale | Check the green queued-sale card on Orders — retry or discard after a stock fix |
| Wrong prices at the till | Toggle *Member pricing* on the POS screen; per-order `is_member` is respected server-side too |
| PIN not accepted | Confirm the server was installed with that PIN; change it from Settings → Access |

## Licence

Private project for DXN stockpoint operations.
