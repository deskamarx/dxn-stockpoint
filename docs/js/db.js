/**
 * Durable on-device database.
 *
 * The browser's IndexedDB is the store of record on the web build (and inside
 * the Android WebView shells). It gives us transactional writes, indexes and
 * hundreds of megabytes of quota instead of the 5 MB localStorage ceiling.
 *
 * localStorage is still written as a synchronous mirror so the very first
 * paint after a cold start is instant, but it is no longer the source of truth.
 *
 * Schema changes are applied through ordered, versioned migrations. Every
 * migration that can lose information takes a snapshot first, and the admin
 * screen can roll back to the last good snapshot. That is the browser
 * equivalent of a versioned SQLite migration + rollback.
 */

export const DB_NAME = 'dxn-stockpoint';
export const DB_VERSION = 4;
export const SNAPSHOT_LIMIT = 4;

/** Object stores created in each schema version. */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'core catalogue, orders, outbox',
    stores: [
      ['products', { keyPath: 'id' }],
      ['orders', { keyPath: 'id' }],
      ['customers', { keyPath: 'id' }],
      ['outbox', { keyPath: 'id' }],
      ['meta', { keyPath: 'key' }],
    ],
  },
  {
    version: 2,
    name: 'held sales, audit trail and stock movements',
    stores: [
      ['held', { keyPath: 'id' }],
      ['audit', { keyPath: 'id', autoIncrement: true }],
      ['movements', { keyPath: 'id', autoIncrement: true }],
    ],
    indexes: [
      ['orders', 'created_at', 'by_created', { unique: false }],
      ['orders', 'client_uuid', 'by_client_uuid', { unique: false }],
      ['audit', 'at', 'by_at', { unique: false }],
      ['movements', 'product_id', 'by_product', { unique: false }],
    ],
  },
  {
    version: 3,
    name: 'split payments, staff roles and conflict journal',
    stores: [
      ['payments', { keyPath: 'id' }],
      ['staff', { keyPath: 'id' }],
      ['conflicts', { keyPath: 'id', autoIncrement: true }],
      ['snapshots', { keyPath: 'id' }],
    ],
    indexes: [
      ['payments', 'order_id', 'by_order', { unique: false }],
      ['payments', 'client_uuid', 'by_client_uuid', { unique: false }],
    ],
  },
  {
    version: 4,
    name: 'expenses and cash reconciliation',
    stores: [
      ['expenses', { keyPath: 'id' }],
    ],
    indexes: [
      ['expenses', 'spent_at', 'by_date', { unique: false }],
    ],
  },
];

/** Pure planner used by the migration tests and the upgrade banner. */
export function planMigrations(fromVersion, toVersion = DB_VERSION) {
  return MIGRATIONS.filter((m) => m.version > Number(fromVersion || 0) && m.version <= Number(toVersion));
}

export const DB_STORES = MIGRATIONS.flatMap((m) => m.stores.map(([name]) => name));

let dbPromise = null;
let dbState = { available: false, version: 0, error: '', migrated: [], openedAt: 0 };

export function dbInfo() {
  return { ...dbState };
}

function idbAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function applySchema(db, tx, migration) {
  for (const [name, options] of migration.stores || []) {
    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
  }
  for (const [storeName, keyPath, indexName, options] of migration.indexes || []) {
    const store = tx.objectStore(storeName);
    if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath, options);
  }
}

/**
 * Opens (and upgrades) the database. Safe to call from every module: the
 * promise is cached and the upgrade only runs once per page load.
 */
export function openDB() {
  if (dbPromise) return dbPromise;
  if (!idbAvailable()) {
    dbState = { ...dbState, available: false, error: 'IndexedDB is not available in this browser.' };
    return Promise.reject(new Error(dbState.error));
  }

  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      dbState = { ...dbState, available: false, error: error.message };
      reject(error);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      const from = Number(event.oldVersion || 0);
      for (const migration of planMigrations(from, DB_VERSION)) {
        applySchema(db, tx, migration);
        dbState.migrated.push({ version: migration.version, name: migration.name, at: Date.now() });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      dbState = {
        available: true,
        version: db.version,
        error: '',
        migrated: dbState.migrated,
        openedAt: Date.now(),
      };
      // Persist the migration journal so the admin screen can prove what ran.
      if (dbState.migrated.length) {
        writeMeta('lastMigration', { at: Date.now(), from: 'auto', applied: dbState.migrated }).catch(() => {});
      }
      resolve(db);
    };

    request.onerror = () => {
      dbState = { ...dbState, available: false, error: request.error?.message || 'Could not open IndexedDB.' };
      reject(request.error || new Error(dbState.error));
    };

    request.onblocked = () => {
      dbState = { ...dbState, error: 'Another tab is holding an older database open. Close it and reload.' };
    };
  });

  return dbPromise;
}

function run(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeName, mode);
    } catch (error) {
      reject(error);
      return;
    }
    const store = Array.isArray(storeName) ? null : tx.objectStore(storeName);
    let result;
    try {
      result = fn(store, tx);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result && result.__request ? result.__request.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  }));
}

function requestValue(request) {
  return { __request: request };
}

export async function dbGetAll(storeName) {
  try {
    return await run(storeName, 'readonly', (store) => requestValue(store.getAll()));
  } catch {
    return [];
  }
}

export async function dbGet(storeName, key) {
  try {
    return await run(storeName, 'readonly', (store) => requestValue(store.get(key)));
  } catch {
    return null;
  }
}

export async function dbPut(storeName, value) {
  return run(storeName, 'readwrite', (store) => { store.put(value); return value; });
}

export async function dbPutMany(storeName, values) {
  if (!Array.isArray(values) || !values.length) return 0;
  return run(storeName, 'readwrite', (store) => {
    for (const value of values) store.put(value);
    return values.length;
  });
}

export async function dbDelete(storeName, key) {
  return run(storeName, 'readwrite', (store) => { store.delete(key); return true; });
}

export async function dbClear(storeName) {
  return run(storeName, 'readwrite', (store) => { store.clear(); return true; });
}

export async function writeMeta(key, value) {
  return dbPut('meta', { key, value, at: Date.now() });
}

export async function readMeta(key) {
  const row = await dbGet('meta', key);
  return row ? row.value : null;
}

/**
 * Everything needed to rebuild the shop on another device. Deliberately
 * excludes the auth token; the admin PIN hash is excluded by the caller.
 */
export async function exportDatabase() {
  const data = {};
  for (const store of DB_STORES) {
    if (store === 'snapshots') continue;
    data[store] = await dbGetAll(store);
  }
  return {
    format: 'dxn-stockpoint-backup',
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
}

/** Replaces the local database. Callers must confirm before invoking. */
export async function importDatabase(backup, { keepSnapshots = true } = {}) {
  if (!backup || backup.format !== 'dxn-stockpoint-backup' || !backup.data) {
    throw new Error('This file is not a Stockpoint backup.');
  }
  const version = Math.min(DB_VERSION, Math.max(1, Number(backup.version) || 1));
  await openDB();
  const snapshots = keepSnapshots ? await dbGetAll('snapshots') : [];
  for (const store of DB_STORES) {
    if (store === 'snapshots') continue;
    await dbClear(store);
    const rows = Array.isArray(backup.data[store]) ? backup.data[store] : [];
    // Backup rows are migrated forward with the same rules as a live device,
    // so an older backup never downgrades the schema of the restored data.
    const migrated = upgradeRows(store, rows, version);
    if (migrated.length) await dbPutMany(store, migrated);
  }
  if (keepSnapshots && snapshots.length) {
    await dbClear('snapshots');
    await dbPutMany('snapshots', snapshots);
  }
  return true;
}

function upgradeRows(store, rows, from) {
  let result = rows.map((row) => ({ ...row }));
  for (let version = from + 1; version <= DB_VERSION; version += 1) {
    if (store === 'orders') result = result.map((row) => normalizeBackupOrder(row));
    if (store === 'products') result = result.map((row) => ({ rev: 0, updated_at: '', ...row, stock_qty: Number(row.stock_qty) || 0 }));
    if (store === 'outbox') result = result.map((row) => ({
      attempts: 0, status: 'pending', error: '', createdAt: Date.now(), ...row,
    }));
    if (store === 'expenses') result = result.map((row) => ({ client_uuid: row.client_uuid || `import-${row.id}`, ...row }));
  }
  return result;
}

function normalizeBackupOrder(row) {
  const payments = Array.isArray(row.payments) ? row.payments : [];
  const refunds = Array.isArray(row.refunds) ? row.refunds : [];
  const items = Array.isArray(row.items) ? row.items : [];
  const total = Number(row.total_amount) || items.reduce((sum, item) => sum + (Number(item.line_total) || 0), 0);
  const paid = payments.reduce((sum, p) => sum + Math.max(0, Number(p.amount) || 0), 0);
  const refunded = refunds.reduce((sum, r) => sum + Math.abs(Number(r.amount) || 0), 0);
  return {
    ...row,
    items,
    payments,
    refunds,
    total_amount: total,
    amount_paid: paid,
    refunded_amount: refunded,
    due_amount: Math.max(0, Math.round((total - paid) * 100) / 100),
    payment_status: paid >= total && total > 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'DUE',
    rev: Number(row.rev) || 0,
    updated_at: row.updated_at || row.created_at || '',
  };
}

/** Takes a restorable snapshot before a risky operation. */
export async function takeSnapshot(label = 'manual') {
  const payload = await exportDatabase();
  const row = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    at: Date.now(),
    version: DB_VERSION,
    counts: Object.fromEntries(Object.entries(payload.data).map(([k, v]) => [k, v.length])),
    payload,
  };
  await dbPut('snapshots', row);
  const all = await dbGetAll('snapshots');
  const stale = all.sort((a, b) => b.at - a.at).slice(SNAPSHOT_LIMIT);
  for (const item of stale) await dbDelete('snapshots', item.id);
  return row;
}

export async function listSnapshots() {
  const rows = await dbGetAll('snapshots');
  return rows
    .sort((a, b) => b.at - a.at)
    .map(({ id, label, at, counts, version }) => ({ id, label, at, counts, version }));
}

export async function restoreSnapshot(id) {
  const row = await dbGet('snapshots', id);
  if (!row) throw new Error('That snapshot is no longer available.');
  await importDatabase(row.payload);
  return row;
}

export async function clearDatabase() {
  await openDB();
  for (const store of DB_STORES) {
    if (store === 'snapshots') continue;
    await dbClear(store);
  }
}

/**
 * Imports the v2 localStorage cache exactly once. This is the controlled
 * migration from the pre-IndexedDB build: the old keys stay in place until the
 * import has committed, so a failed migration can be retried without loss.
 */
export async function migrateLegacyLocalStorage(keys) {
  const already = await readMeta('legacyMigratedAt');
  if (already) return { migrated: false, reason: 'already-migrated' };

  const read = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };

  const cache = read(keys.cache, null) || {};
  const outbox = read(keys.outbox, []) || [];
  const held = read(keys.held, []) || [];
  const products = Array.isArray(cache.products) ? cache.products : [];
  const orders = Array.isArray(cache.orders) ? cache.orders : [];
  const customers = Array.isArray(cache.customers) ? cache.customers : [];

  if (!products.length && !orders.length && !outbox.length && !held.length) {
    await writeMeta('legacyMigratedAt', Date.now());
    return { migrated: false, reason: 'nothing-to-migrate' };
  }

  await takeSnapshot('before-legacy-import');
  if (products.length) await dbPutMany('products', products);
  if (orders.length) await dbPutMany('orders', orders);
  if (customers.length) await dbPutMany('customers', customers);
  if (outbox.length) await dbPutMany('outbox', outbox);
  if (held.length) await dbPutMany('held', held);
  await writeMeta('legacyMigratedAt', Date.now());
  await writeMeta('legacyCounts', {
    products: products.length,
    orders: orders.length,
    customers: customers.length,
    outbox: outbox.length,
    held: held.length,
  });
  return { migrated: true, counts: { products: products.length, orders: orders.length, customers: customers.length, outbox: outbox.length, held: held.length } };
}

/**
 * Audit trail. Written to IndexedDB (durable) and mirrored to a bounded
 * localStorage array so the newest entries are readable before the async DB
 * opens. Entries are append-only from the UI's point of view.
 */
const AUDIT_MIRROR = 'dxn.audit.v1';
const AUDIT_MIRROR_LIMIT = 200;

export async function appendAudit(entry) {
  const row = {
    at: new Date().toISOString(),
    actor: entry.actor || 'system',
    role: entry.role || 'SYSTEM',
    action: entry.action || 'unknown',
    entity: entry.entity || '',
    entity_id: entry.entity_id ?? null,
    detail: entry.detail || '',
    device: entry.device || (typeof navigator !== 'undefined' ? navigator.platform : ''),
  };
  try {
    await dbPut('audit', row);
  } catch { /* the mirror below still records it */ }
  try {
    const raw = localStorage.getItem(AUDIT_MIRROR);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(row);
    localStorage.setItem(AUDIT_MIRROR, JSON.stringify(list.slice(0, AUDIT_MIRROR_LIMIT)));
  } catch { /* quota/private mode */ }
  return row;
}

export function readAuditMirror(limit = 100) {
  try {
    const raw = localStorage.getItem(AUDIT_MIRROR);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(0, limit) : [];
  } catch {
    return [];
  }
}

export async function listAudit(limit = 300) {
  const rows = await dbGetAll('audit');
  return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

/** Convenience: true when the durable database is healthy. */
export async function healthCheck() {
  try {
    await openDB();
    const meta = await readMeta('health');
    await writeMeta('health', { at: Date.now(), ok: true });
    return { ok: true, version: dbState.version, previous: meta, migrated: dbState.migrated };
  } catch (error) {
    return { ok: false, error: error.message, version: dbState.version };
  }
}
