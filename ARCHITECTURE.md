# Architecture and scope (v3.2.1)

This document records the implementation choices that differ from the original
wish list, and exactly what is and is not covered by the shipped build.

## Storage and durability

| Surface | Store | Migration | Rollback |
|---|---|---|---|
| Node server (canonical) | `server/data/db.json`, schema v4 | Ordered additive `migrate()`; no row is deleted | `db.vN.snapshot.json` copied **before** migration; `POST /api/v1/database/rollback` (admin) |
| Browser PWA | IndexedDB v4 mirror of the in-memory state | Versioned object stores in `docs/js/db.js` | `restoreSnapshot()` in Settings; encrypted backup import |
| Native Android | `StockpointDb` SQLite (tables `state`, `outbox`, `snapshots`, `conflicts`, `meta`) | `SQLiteOpenHelper` ordered additive upgrades; legacy `state.json`/`outbox.json` imported and renamed `.migrated` | Snapshot picker in owner Settings → on-device data |

Every migration is rehearsed with `node scripts/rehearse-migration.mjs --data
<copy-of-db.json>`; the script copies the supplied file into a temporary
directory and never touches the original. `--fixture` runs a synthetic v1 shop
when no real export is available. A rehearsal against the actual live export is
still required before shop rollout — see the QA status below.

## Capacitor: decision and deviation

**Requested:** Capacitor as the Android packaging layer.

**Shipped:** the original native Jetpack Compose applications remain the
owner/customer apps; the suite and the two offline shells are hardened WebView
wrappers serving assets from `https://appassets.androidplatform.net` with an
allow-listed origin, SSL checks, download handling and reload controls.

**Why:** the repository already contained mature native Compose apps with their
own navigation, Keystore storage and WorkManager sync. Replacing them with
Capacitor would have discarded working code and required a new signing/
versioning pipeline without improving the offline guarantee. The WebView
shells give the PWA the same local asset origin Capacitor would provide, with
zero npm/native bridge dependencies. The core remains free, offline-capable and
has no mandatory paid service.

**If Capacitor is later required:** add `@capacitor/core`, `@capacitor/cli`
and `@capacitor/android`, point `webDir` at `docs/`, use application IDs
`com.dxn.stockpoint.{owner|client|suite}` only after a version bump (changing
IDs would break upgrades), and port `SecureStore`, `SyncWorker` and the
conflict journal as plugins. Until that work is done, do not claim the APKs are
Capacitor builds — they are not.

## PHP API scope

`api/` (PHP 8 + MySQL) is retained for shared hosting and implements the
original v1 contract: catalogue, customers, orders, courier and basic sync.
The following v3.2.1 endpoints are **Node-only**:

- `POST /api/v1/orders/:id/payments`, `POST /api/v1/orders/:id/returns`
- `GET /api/v1/orders/:id/timeline`, `GET /api/v1/orders/:id/receipt`
- `GET|POST /api/v1/payments`, `/api/v1/returns`, `/api/v1/expenses`
- `GET|POST|PUT|DELETE /api/v1/staff`, `GET /api/v1/audit`
- `GET /api/v1/database/snapshots`, `POST /api/v1/database/rollback`
- `GET /api/v1/config`, `GET /api/v1/sync/status`
- paginated sync (`truncated` / `next_since`) and scoped staff/customer sync

Use `server/index.js` for the full feature set. Nothing in the free core needs
a paid service; bKash/Nagad/card are recorded manually because no merchant
credentials were supplied.

## QA status

Verified in this workspace:

- `npm run check` and `npm test` — 32 tests, including migration/rollback,
  split payments, returns, RBAC, audit attribution, sync scopes and encrypted
  backups.
- `:core:testDebugUnitTest` — JVM contract tests for URL normalisation,
  paginated sync parsing and numeric/boolean `is_active` products.
- All five release APKs pass `lintVitalRelease`, R8 and `apksigner verify`, and
  cold-start on `emulator-5554`.
- `node scripts/rehearse-migration.mjs` — synthetic v1 and copied-export
  rehearsals (15 checks each), including row preservation and rollback.
- `scripts/verify-android-contract.ps1` (83 checks) and
  `scripts/verify-two-client-sync.ps1` (29 checks) — live API contract and
  cross-client sync checks against a local v3.2.1 server.
- Emulator functional QA: online catalog after the `is_active` parser fix,
  offline sale queued in SQLite, outbox replay with a stable `client_uuid`,
  snapshot save/restore, conflict resolution and the owner PIN gate.

Split payments, returns, RBAC/audit and encrypted backup round-trips are
verified through the Node suites and live API/PWA flows; the native Compose
apps intentionally have no split-payment or backup-import UI.

Still required before shop rollout: rehearsal against a copy of the real shop
database, a physical-device pass, and replacing the placeholder
`https://shop.example.com/` API host and the development PIN/admin key.
