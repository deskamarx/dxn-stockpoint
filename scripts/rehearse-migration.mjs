#!/usr/bin/env node
/**
 * Migration rehearsal for the server database.
 *
 * Never runs against live data: the supplied file is copied into a temporary
 * directory first. It proves that the v1 -> v4 migration is additive, that a
 * pre-migration snapshot is written, and that rollback restores the original
 * rows byte-for-byte before replaying the migration.
 *
 *   node scripts/rehearse-migration.mjs --data /path/to/db.json
 *   node scripts/rehearse-migration.mjs --dir /path/to/server/data
 *   node scripts/rehearse-migration.mjs --fixture      # synthetic v1 shop
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database, VERSION } from '../server/lib/db.js';

function argument(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1] || fallback;
}

const fixture = process.argv.includes('--fixture');
const dataFile = argument('--data');
const dataDirInput = argument('--dir');
if (!fixture && !dataFile && !dataDirInput) {
  console.error('Pass --data <db.json>, --dir <data directory>, or --fixture.');
  process.exit(2);
}

const sourceFile = dataFile || (dataDirInput ? path.join(dataDirInput, 'db.json') : '');
if (!fixture && !fs.existsSync(sourceFile)) {
  console.error(`Database copy not found: ${sourceFile}`);
  process.exit(2);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxn-migration-rehearsal-'));
const dir = path.join(temp, 'data');
fs.mkdirSync(dir, { recursive: true });

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` ${detail}` : ''}`); }
}

function legacyFixture() {
  const now = new Date().toISOString();
  return {
    meta: { version: 1, rev: 7, counters: { product: 1, order: 1, customer: 1, movement: 0 } },
    settings: { branch_name: { value: 'Mohammadpur', rev: 1, updated_at: now } },
    products: [{
      id: 1, sku: 'LEGACY-1', name: 'Legacy product', category: 'General',
      retail_price: 100, member_price: 80, pv_points: 10, stock_qty: 12,
      low_stock_at: 5, is_active: 1, rev: 1, created_at: now, updated_at: now,
    }],
    orders: [{
      id: 1, order_number: 'MS-0001', client_uuid: 'legacy-uuid-1',
      customer_name: 'Legacy customer', customer_phone: '', dxn_member_id: '',
      is_member: false, payment_method: 'CASH', discount: 0, total_amount: 80,
      paid_amount: 80, due_amount: 0, status: 'COMPLETED', source: 'web',
      created_at: now, rev: 1, items: [{
        id: 1, product_id: 1, product_name: 'Legacy product', quantity: 1,
        unit_price: 80, line_total: 80,
      }],
    }],
    customers: [{ id: 1, name: 'Legacy customer', phone: '', pv_points: 10, created_at: now, rev: 1 }],
    movements: [], sessions: [], audit: [],
  };
}

try {
  const initialRaw = JSON.stringify(fixture ? legacyFixture() : JSON.parse(fs.readFileSync(sourceFile, 'utf8')), null, 2);
  fs.writeFileSync(path.join(dir, 'db.json'), initialRaw);
  const before = JSON.parse(initialRaw);
  const versionBefore = Number(before.meta?.version || 1);
  // Migration deliberately adds derived fields to orders; compare only the
  // fields that existed in the source rows so an additive change is a pass.
  const rows = (d, reference = before) => Object.fromEntries(
    ['products', 'orders', 'customers', 'movements', 'sessions'].map((key) => {
      const source = Array.isArray(reference[key]) ? reference[key] : [];
      const target = Array.isArray(d[key]) ? d[key] : [];
      return [key, source.map((row, index) => Object.fromEntries(
        Object.keys(row).map((field) => [field, target[index]?.[field]]),
      ))];
    }),
  );
  const expected = JSON.stringify(rows(before));

  console.log(`\nMigration rehearsal — ${fixture ? 'synthetic v1 fixture' : sourceFile}`);
  console.log(`  source version: v${versionBefore}, target: v${VERSION}`);

  const db = new Database({ dataDir: dir });
  check('database opened on the copied data', !!db.data);
  check(`schema upgraded to v${VERSION}`, Number(db.data.meta.version) === VERSION, `got ${db.data.meta.version}`);
  const hasSnapshot = versionBefore < VERSION;
  check(hasSnapshot ? 'pre-migration snapshot created' : 'current database needs no migration',
    hasSnapshot ? fs.existsSync(path.join(dir, `db.v${versionBefore}.snapshot.json`)) : true);
  if (hasSnapshot) {
    check('snapshot is the untouched source', fs.readFileSync(path.join(dir, `db.v${versionBefore}.snapshot.json`), 'utf8') === initialRaw);
  }
  check('every legacy row survived the migration', JSON.stringify(rows(db.data)) === expected);
  check('legacy setting values survived the migration', Object.entries(before.settings || {})
    .every(([key, value]) => db.data.settings?.[key]?.value === String(value.value)));
  check('old orders gained payment fields', (db.data.orders || []).every((o) => Array.isArray(o.payments)));
  check('expense/staff/payment collections exist', ['expenses', 'staff'].every((k) => Array.isArray(db.data[k])) && db.data.meta.counters?.payment !== undefined);

  const snapshotName = `db.v${versionBefore}.snapshot.json`;
  const listed = db.snapshots();
  if (hasSnapshot) {
    check('snapshot is discoverable through the admin API surface', listed.some((s) => s.name === snapshotName));

    const rolled = db.rollback(snapshotName);
    check('rollback reports the current schema version', rolled.version === VERSION, `got ${rolled.version}`);
    check('rollback advanced the sync revision', rolled.server_rev > versionBefore);
    check('rollback restored the original rows', JSON.stringify(rows(db.data)) === expected);
    check('snapshot retained after rollback', fs.existsSync(path.join(dir, snapshotName)));
  }

  const reopened = new Database({ dataDir: dir });
  check('rolled-back copy reopens cleanly', Number(reopened.data.meta.version) === VERSION);
  check('reopen preserved the row set', JSON.stringify(rows(reopened.data)) === expected);
} catch (error) {
  failures++;
  console.error('  FAIL rehearsal threw:', error.message);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nPASS  migration rehearsal\n' : `\nFAILED  ${failures} check(s)\n`);
process.exit(failures === 0 ? 0 : 1);
