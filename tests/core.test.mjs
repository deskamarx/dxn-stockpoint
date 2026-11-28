/**
 * Pure client-logic tests. These modules are shared by the PWA and the Android
 * WebView shells, so the rules are verified without a browser or a network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYMENT_METHOD_IDS, isCreditMethod, methodLabel, normalizePayments,
  orderBalance, paymentStatus, paymentStatusLabel, quickAmounts, refundable,
} from '../docs/js/payments.js';
import {
  ROLES, ROLE_RANK, can, addLocalStaff, authenticateLocal, hashPin, setLocalPin, verifyPinHash,
} from '../docs/js/roles.js';
import { encryptBackup, decryptBackup, isEncryptedBackup } from '../docs/js/crypto.js';
import { DB_STORES, DB_VERSION, MIGRATIONS, planMigrations } from '../docs/js/db.js';
import { buildPdf } from '../docs/js/pdf.js';
import { buildXlsx } from '../docs/js/xlsx.js';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear(),
};

test('payment methods: labels, credit detection and a stable ID list', () => {
  assert.equal(PAYMENT_METHOD_IDS.length, 7);
  assert.equal(methodLabel('bkash'), 'bKash');
  assert.equal(methodLabel('BANK TRANSFER'), 'Bank');
  assert.equal(isCreditMethod('CREDIT'), true);
  assert.equal(isCreditMethod('CASH'), false);
  assert.equal(paymentStatus(0, 100), 'UNPAID');
  assert.equal(paymentStatus(40, 100), 'PARTIALLY_PAID');
  assert.equal(paymentStatus(100, 100), 'PAID');
  assert.equal(paymentStatusLabel('PARTIALLY_PAID'), 'Part paid');
});

test('normalizePayments: cash change is real money and non-cash overpay is clamped', () => {
  const cash = normalizePayments([
    { method: 'CASH', amount: 120 },
    { method: 'BKASH', amount: 30 },
  ], 100);
  assert.equal(cash.ok, true);
  assert.equal(cash.paid, 100);
  assert.equal(cash.change, 50, 'the last cash entry absorbs the change');
  assert.equal(cash.due, 0);
  assert.equal(cash.status, 'PAID');
  assert.equal(cash.payments.find((row) => row.method === 'BKASH').amount, 30);
  assert.equal(cash.payments.find((row) => row.method === 'CASH').amount, 70);

  const card = normalizePayments([{ method: 'CARD', amount: 180 }], 100);
  assert.equal(card.paid, 100);
  assert.equal(card.change, 0, 'a card cannot hand back cash');
  assert.equal(card.due, 0);

  const blank = normalizePayments([
    { method: 'CASH', amount: 0 },
    { method: 'CASH', amount: -4 },
    { method: 'NOT_A_METHOD', amount: 5 },
    { method: 'WALLET', amount: 10 },
  ], 100);
  assert.equal(blank.payments.length, 1);
  assert.equal(blank.paid, 10);
  assert.equal(blank.status, 'PARTIALLY_PAID');
});

test('normalizePayments: credit needs a named customer when gated', () => {
  const blocked = normalizePayments([{ method: 'CASH', amount: 40 }], 100, { allowCredit: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.due, 60);
  assert.match(blocked.message, /short by 60\.00/);

  const allowed = normalizePayments([], 100, { allowCredit: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.credit, true);
  assert.deepEqual(quickAmounts(100), [100, 500, 1000]);
});

test('orderBalance and refundable tolerate legacy orders', () => {
  const legacy = { total_amount: 500, status: 'PAID' };
  assert.deepEqual(orderBalance(legacy), {
    total: 500, paid: 500, due: 0, change: 0, status: 'PAID',
  });

  const split = {
    total_amount: 500,
    amount_paid: 200,
    payment_status: 'PARTIALLY_PAID',
    payments: [{ amount: 100 }, { amount: 100 }],
    refunds: [{ amount: 50 }, { amount: 25 }],
  };
  assert.equal(orderBalance(split).due, 300);
  assert.equal(refundable(split), 125, 'refunds never exceed money actually collected');
});

test('roles: rank ordering and permission gating', () => {
  assert.equal(ROLE_RANK.ADMIN, 4);
  assert.equal(ROLE_RANK.CUSTOMER, undefined);
  assert.equal(can(ROLES.ADMIN, 'anything'), true);
  assert.equal(can(ROLES.MANAGER, 'settings.view'), true);
  assert.equal(can(ROLES.CASHIER, 'orders.payment'), true);
  assert.equal(can(ROLES.CASHIER, 'backup.export'), false);
  assert.equal(can(ROLES.VIEWER, 'pos.sell'), false);
  assert.equal(can('', 'dashboard.view'), false);
});

test('offline PINs: salted hashes, individual staff and the bootstrap fallback', async () => {
  memory.clear();
  const hash = await hashPin('1357');
  assert.match(hash, /^sha256\$[0-9a-f]{64}$/);
  assert.equal(await verifyPinHash('1357', hash), true);
  assert.equal(await verifyPinHash('9753', hash), false);

  const staff = await addLocalStaff({ name: 'Counter two', role: ROLES.CASHIER, pin: '9753' });
  assert.equal(staff.role, 'CASHIER');
  assert.ok(!('pin' in staff));
  assert.equal((await authenticateLocal('9753'))?.name, 'Counter two');

  // A fresh device keeps the documented bootstrap PIN until the owner changes it.
  assert.equal((await authenticateLocal('2468'))?.role, ROLES.ADMIN);
  assert.equal(await authenticateLocal('0000'), null, 'the bootstrap fallback only accepts the documented PIN');

  await setLocalPin('owner', '4826');
  assert.equal((await authenticateLocal('4826'))?.role, ROLES.ADMIN);
  assert.equal(await authenticateLocal('2468'), null, 'the bootstrap PIN stops working after it is replaced');
  assert.equal(await authenticateLocal('0000'), null);
});

test('encrypted backup: AES-GCM round trip and wrong-passphrase rejection', async () => {
  const payload = { version: 4, orders: [{ id: 1, customer_name: 'Secrets' }] };
  const envelope = await encryptBackup(payload, 'shop-passphrase-2026');
  assert.equal(isEncryptedBackup(JSON.stringify(envelope)), true);
  assert.equal(envelope.algorithm, 'AES-256-GCM');
  assert.match(envelope.kdf, /PBKDF2-SHA256-210000/);
  assert.ok(!JSON.stringify(envelope).includes('Secrets'), 'ciphertext must not leak customer names');

  const restored = await decryptBackup(JSON.stringify(envelope), 'shop-passphrase-2026');
  assert.deepEqual(restored, payload);
  await assert.rejects(
    () => decryptBackup(envelope, 'wrong-passphrase'),
    /Wrong passphrase|damaged/,
  );
  await assert.rejects(() => encryptBackup(payload, 'short'), /at least 8 characters/);
});

test('IndexedDB schema: migrations are ordered, additive and complete', () => {
  assert.equal(DB_VERSION, 4);
  assert.deepEqual(planMigrations(1).map((row) => row.version), [2, 3, 4]);
  assert.deepEqual(planMigrations(3).map((row) => row.version), [4]);
  assert.deepEqual(planMigrations(4), []);
  assert.equal(MIGRATIONS[0].version, 1);
  assert.equal(new Set(DB_STORES).size, DB_STORES.length, 'object store names must be unique');
  for (const store of ['products', 'orders', 'outbox', 'payments', 'expenses', 'conflicts', 'snapshots', 'audit']) {
    assert.ok(DB_STORES.includes(store), `${store} must exist in the durable schema`);
  }
});

test('offline documents: PDF and XLSX writers produce real file signatures', () => {
  const pdf = buildPdf({ title: 'Test receipt', lines: [{ text: 'Total 100.00' }] });
  assert.equal(new TextDecoder().decode(pdf.slice(0, 5)), '%PDF-');
  assert.ok(pdf.length > 400);

  const xlsx = buildXlsx([{ name: 'Summary', rows: [['Metric', 'Value'], ['Revenue', 100]] }]);
  assert.equal(xlsx[0], 0x50);
  assert.equal(xlsx[1], 0x4b, 'XLSX is a ZIP container');
  assert.ok(xlsx.length > 500);
});
