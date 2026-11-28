/**
 * API smoke tests: boots the zero-dependency server in-process on an ephemeral
 * port and exercises the contract the web app and the Android app depend on.
 *
 * Run: npm test  (or: node --test tests/api.test.mjs)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { Database } from '../server/lib/db.js';
import { createApi } from '../server/lib/api.js';

/** Boots a fresh server instance on a random port with an empty data dir. */
async function bootServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpoint-test-'));
  const db = new Database({ dataDir, pin: '2468', adminKey: 'test-admin-key' });
  const handle = createApi({ db });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    handle(req, res, url).catch((error) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { message: error.message, code: 'internal' } }));
    });
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();

  const call = async (method, target, { body, token, adminKey } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${target}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(adminKey ? { 'X-Api-Key': adminKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, body: payload };
  };

  return { db, server, call, dataDir, port };
}

let ctx;
test.before(async () => {
  ctx = await bootServer();
});
test.after(async () => {
  ctx.server.close();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

let adminToken = '';

test('health: version, products and revision', async () => {
  const { status, body } = await ctx.call('GET', '/api/v1/health');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.status, 'ok');
  assert.ok(body.database.counts.products > 0);
  assert.ok(body.server_rev >= 0);
});

test('login: correct PIN issues a token, wrong PIN is rejected', async () => {
  const good = await ctx.call('POST', '/api/v1/auth/login', { body: { pin: '2468' } });
  assert.equal(good.status, 200);
  assert.ok(good.body.token);
  adminToken = good.body.token;

  const bad = await ctx.call('POST', '/api/v1/auth/login', { body: { pin: '0000' } });
  assert.equal(bad.status, 401);
});

test('products: public list without auth', async () => {
  const { status, body } = await ctx.call('GET', '/api/v1/products');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.products));
  const product = body.products[0];
  for (const field of ['id', 'sku', 'name', 'retail_price', 'member_price', 'stock_qty', 'rev']) {
    assert.ok(field in product, `missing field ${field}`);
  }
});

test('order create: totals, stock decrement and MSP order number', async () => {
  const list = await ctx.call('GET', '/api/v1/products');
  const product = list.body.products.find((p) => p.stock_qty >= 10);
  assert.ok(product, 'seed should include a stocked product');

  const before = product.stock_qty;
  const uuid = `test-order-${crypto.randomUUID()}`;
  const { status, body } = await ctx.call('POST', '/api/v1/orders', {
    body: {
      client_uuid: uuid,
      customer_name: 'Test Customer',
      customer_phone: '01911111111',
      payment_method: 'CASH',
      items: [{ product_id: product.id, quantity: 2, unit_price: product.retail_price, unit_pv: product.pv_points }],
      source: 'test',
    },
  });

  assert.equal(status, 201);
  assert.equal(body.success, true);
  const order = body.order;
  assert.ok(/^MSP-\d{6}-\d{4}$/.test(order.order_number), `unexpected order_number ${order.order_number}`);
  assert.ok(Math.abs(order.total_amount - product.retail_price * 2) < 0.01);
  assert.ok(order.items[0].line_total > 0);

  const after = await ctx.call('GET', `/api/v1/products/${product.id}`);
  assert.equal(after.body.product.stock_qty, before - 2, 'stock should decrement by the quantity sold');
});

test('orders idempotency: same client_uuid returns the same order', async () => {
  const list = await ctx.call('GET', '/api/v1/products');
  const product = list.body.products[0];
  const uuid = `dup-${crypto.randomUUID()}`;
  const payload = {
    client_uuid: uuid,
    customer_name: 'Dup Test',
    items: [{ product_id: product.id, quantity: 1, unit_price: product.retail_price, unit_pv: product.pv_points }],
  };

  const first = await ctx.call('POST', '/api/v1/orders', { body: payload });
  assert.equal(first.status, 201);
  const beforeCount = (await ctx.call('GET', '/api/v1/orders', { token: adminToken })).body.orders.length;

  const second = await ctx.call('POST', '/api/v1/orders', { body: payload });
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.order.id, first.body.order.id);

  const afterCount = (await ctx.call('GET', '/api/v1/orders', { token: adminToken })).body.orders.length;
  assert.equal(afterCount, beforeCount, 'no extra order row should be created');
});

test('oversell: rejected without the flag, allowed with it', async () => {
  const list = await ctx.call('GET', '/api/v1/products');
  const product = list.body.products.find((p) => p.stock_qty > 0 && p.stock_qty < 100);
  assert.ok(product);

  const rejected = await ctx.call('POST', '/api/v1/orders', {
    body: {
      client_uuid: `over-${crypto.randomUUID()}`,
      customer_name: 'Oversell Reject',
      items: [{ product_id: product.id, quantity: product.stock_qty + 999, unit_price: product.retail_price, unit_pv: product.pv_points }],
    },
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.success, false);
  assert.equal(rejected.body.error.code, 'insufficient_stock');

  const allowed = await ctx.call('POST', '/api/v1/orders', {
    token: adminToken,
    body: {
      client_uuid: `over-ok-${crypto.randomUUID()}`,
      customer_name: 'Oversell Allow',
      allow_oversell: 1,
      items: [{ product_id: product.id, quantity: product.stock_qty + 999, unit_price: product.retail_price, unit_pv: product.pv_points }],
    },
  });
  assert.equal(allowed.status, 201);

  const after = await ctx.call('GET', `/api/v1/products/${product.id}`);
  assert.equal(after.body.product.stock_qty, product.stock_qty - (product.stock_qty + 999), 'stock may go negative when oversell is granted');
});

test('sync: admin pushes products, orders, settings and server_rev', async () => {
  const anonymous = await ctx.call('GET', '/api/v1/sync?since=0');
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.body.scope, 'public');
  assert.ok(Array.isArray(anonymous.body.products));

  const { status, body } = await ctx.call('GET', '/api/v1/sync?since=0', { token: adminToken });
  assert.equal(status, 200);
  assert.equal(body.scope, 'admin');
  assert.ok(Array.isArray(body.products));
  assert.ok(Array.isArray(body.orders));
  assert.ok(body.settings?.branch_name);
  assert.ok(body.server_rev >= 0);
  assert.ok(typeof body.truncated === 'boolean');
});

test('dashboard: admin-only endpoint', async () => {
  const anonymous = await ctx.call('GET', '/api/v1/dashboard');
  assert.equal(anonymous.status, 401);

  const withToken = await ctx.call('GET', '/api/v1/dashboard', { token: adminToken });
  assert.equal(withToken.status, 200);
  assert.ok(withToken.body.data);
});

test('sales report: admin-only with day buckets', async () => {
  const anonymous = await ctx.call('GET', '/api/v1/reports/sales');
  assert.equal(anonymous.status, 401);

  const report = await ctx.call('GET', '/api/v1/reports/sales', { token: adminToken });
  assert.equal(report.status, 200);
  assert.ok(Array.isArray(report.body.days));
  assert.ok(report.body.totals);
});

test('stock movement: stock update is admin-only and logs', async () => {
  const anonymous = await ctx.call('POST', '/api/v1/stock/update', { body: { productId: 1, newQuantity: 5, reason: 'stock_take' } });
  assert.equal(anonymous.status, 401);

  const updated = await ctx.call('POST', '/api/v1/stock/update', {
    token: adminToken,
    body: { productId: 1, newQuantity: 77, reason: 'stock_take' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.product.stock_qty, 77);

  const movements = await ctx.call('GET', '/api/v1/stock/movements?limit=5', { token: adminToken });
  assert.equal(movements.status, 200);
  assert.ok(movements.body.movements.length > 0);
  assert.equal(movements.body.movements[0].reason, 'stock_take');
});

test('products write: admin-only create with validation', async () => {
  const anonymous = await ctx.call('POST', '/api/v1/products', { body: { sku: 'X', name: 'X' } });
  assert.equal(anonymous.status, 401);

  const missingName = await ctx.call('POST', '/api/v1/products', { token: adminToken, body: { sku: 'SKU-ONLY-NO-NAME' } });
  assert.equal(missingName.status, 422);

  const created = await ctx.call('POST', '/api/v1/products', {
    token: adminToken,
    body: {
      sku: 'DXN-TEST-PRODUCT',
      name: 'Test Product',
      category: 'Test',
      retail_price: 100,
      member_price: 80,
      pv_points: 10,
      stock_qty: 5,
    },
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.product.id > 0);
});

test('unknown API route: JSON error envelope', async () => {
  const { status, body } = await ctx.call('GET', '/api/v1/does-not-exist');
  assert.equal(status, 404);
  assert.equal(body.success, false);
  assert.ok(body.error.code);
});

test('settings save: strips the admin hash from the response', async () => {
  const { status, body } = await ctx.call('PUT', '/api/v1/settings', {
    token: adminToken,
    body: { branch_name: 'Test Stockpoint' },
  });
  assert.equal(status, 200);
  assert.equal(body.settings.branch_name, 'Test Stockpoint');
  assert.ok(!('admin_pin_hash' in body.settings));
});

const round2 = (value) => Math.round(Number(value) * 100) / 100;

async function stockedProduct(minimum = 12) {
  const list = await ctx.call('GET', '/api/v1/products');
  const product = list.body.products.find((row) => row.stock_qty >= minimum && row.id !== 1);
  assert.ok(product, `seed should contain a product with at least ${minimum} units`);
  return product;
}

test('split payments: partial collection is idempotent, capped and auditable', async () => {
  const product = await stockedProduct();
  const total = round2(product.retail_price * 2);
  const uuid = `pay-order-${crypto.randomUUID()}`;
  const created = await ctx.call('POST', '/api/v1/orders', {
    body: {
      client_uuid: uuid,
      customer_name: 'Split Payment Customer',
      customer_phone: '01922222222',
      payment_method: 'CREDIT',
      items: [{ product_id: product.id, quantity: 2, unit_price: product.retail_price, unit_pv: product.pv_points }],
      source: 'test',
    },
  });
  assert.equal(created.status, 201);
  const orderId = created.body.order.id;
  assert.equal(created.body.order.payment_status, 'UNPAID');
  assert.equal(round2(created.body.order.due_amount), total);

  const firstUuid = `pay-1-${crypto.randomUUID()}`;
  const first = await ctx.call('POST', `/api/v1/orders/${orderId}/payments`, {
    token: adminToken,
    body: { client_uuid: firstUuid, amount: round2(total / 2), method: 'BKASH', reference: 'TRX-1' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.order.payment_status, 'PARTIALLY_PAID');

  const duplicate = await ctx.call('POST', `/api/v1/orders/${orderId}/payments`, {
    token: adminToken,
    body: { client_uuid: firstUuid, amount: round2(total / 2), method: 'BKASH', reference: 'TRX-1' },
  });
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.payment.id, first.body.payment.id);
  assert.equal(round2(duplicate.body.order.amount_paid), round2(total / 2), 'a retry must not double-count');

  const rest = round2(total - round2(total / 2));
  const second = await ctx.call('POST', `/api/v1/orders/${orderId}/payments`, {
    token: adminToken,
    body: { amount: rest, method: 'CASH' },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.order.payment_status, 'PAID');
  assert.equal(second.body.order.status, 'PAID');
  assert.equal(round2(second.body.order.due_amount), 0);

  const over = await ctx.call('POST', `/api/v1/orders/${orderId}/payments`, {
    token: adminToken,
    body: { amount: 1, method: 'CASH' },
  });
  assert.equal(over.status, 422);
  assert.equal(over.body.error.code, 'overpayment');

  const timeline = await ctx.call('GET', `/api/v1/orders/${orderId}/timeline`, { token: adminToken });
  assert.equal(timeline.status, 200);
  assert.equal(timeline.body.timeline.filter((row) => row.kind === 'payment').length, 2);

  const ledger = await ctx.call('GET', '/api/v1/payments', { token: adminToken });
  assert.equal(ledger.status, 200);
  assert.ok(ledger.body.by_method.BKASH >= round2(total / 2));
  assert.ok(ledger.body.by_method.CASH >= rest);
});

test('returns: linked reversal restores stock and caps the refund at money collected', async () => {
  const product = await stockedProduct();
  const unit = round2(product.retail_price);
  const created = await ctx.call('POST', '/api/v1/orders', {
    body: {
      client_uuid: `return-order-${crypto.randomUUID()}`,
      customer_name: 'Return Customer',
      customer_phone: '01933333333',
      payment_method: 'CREDIT',
      items: [{ product_id: product.id, quantity: 3, unit_price: unit, unit_pv: product.pv_points }],
      source: 'test',
    },
  });
  assert.equal(created.status, 201);
  const orderId = created.body.order.id;

  const partial = await ctx.call('POST', `/api/v1/orders/${orderId}/payments`, {
    token: adminToken,
    body: { amount: unit, method: 'CASH' },
  });
  assert.equal(partial.status, 200);

  const beforeStock = (await ctx.call('GET', `/api/v1/products/${product.id}`)).body.product.stock_qty;
  const returnUuid = `return-${crypto.randomUUID()}`;
  const returned = await ctx.call('POST', `/api/v1/orders/${orderId}/returns`, {
    token: adminToken,
    body: {
      client_uuid: returnUuid,
      items: [{ product_id: product.id, quantity: 2 }],
      reason: 'Damaged in transit',
      refund_method: 'BKASH',
      source: 'test',
    },
  });
  assert.equal(returned.status, 200);
  const returnOrder = returned.body.order;
  assert.equal(returnOrder.type, 'RETURN');
  assert.equal(Number(returnOrder.original_order_id), Number(orderId));
  assert.equal(Number(returnOrder.items[0].quantity), -2);
  assert.equal(round2(returnOrder.total_amount), -unit, 'refund is capped by the single collected unit');
  assert.equal(round2(returned.body.original.refunded_amount), unit);

  const afterStock = (await ctx.call('GET', `/api/v1/products/${product.id}`)).body.product.stock_qty;
  assert.equal(afterStock, beforeStock + 2, 'restoring stock must not resurrect the unsold unit');

  const duplicate = await ctx.call('POST', `/api/v1/orders/${orderId}/returns`, {
    token: adminToken,
    body: { client_uuid: returnUuid, items: [{ product_id: product.id, quantity: 2 }] },
  });
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.order.id, returnOrder.id);

  const overReturn = await ctx.call('POST', `/api/v1/orders/${orderId}/returns`, {
    token: adminToken,
    body: { items: [{ product_id: product.id, quantity: 2 }] },
  });
  assert.equal(overReturn.status, 422);
  assert.equal(overReturn.body.error.code, 'invalid_quantity');

  const returns = await ctx.call('GET', '/api/v1/returns', { token: adminToken });
  assert.ok(returns.body.returns.some((row) => row.id === returnOrder.id));
});

test('expenses: staff-only writes, idempotent retries and ledger visibility', async () => {
  const anonymous = await ctx.call('GET', '/api/v1/expenses');
  assert.equal(anonymous.status, 401);

  const uuid = `expense-${crypto.randomUUID()}`;
  const payload = { client_uuid: uuid, category: 'Transport', amount: 120.5, note: 'Delivered returns' };
  const created = await ctx.call('POST', '/api/v1/expenses', { token: adminToken, body: payload });
  assert.equal(created.status, 200);
  assert.equal(created.body.duplicate, false);

  const duplicate = await ctx.call('POST', '/api/v1/expenses', { token: adminToken, body: payload });
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.expense.id, created.body.expense.id);

  const list = await ctx.call('GET', '/api/v1/expenses', { token: adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.body.expenses.filter((row) => row.client_uuid === uuid).length, 1);
});

let cashierToken = '';
let viewerToken = '';

test('staff and RBAC: individual PINs, role gates and staff changes', async () => {
  const anonymous = await ctx.call('GET', '/api/v1/staff');
  assert.equal(anonymous.status, 401);

  const cashier = await ctx.call('POST', '/api/v1/staff', {
    token: adminToken,
    body: { name: 'Cashier One', role: 'CASHIER', pin: '1357' },
  });
  assert.equal(cashier.status, 201);
  const cashierId = cashier.body.staff.id;
  assert.ok(!('pin_hash' in cashier.body.staff) && !('salt' in cashier.body.staff));

  const viewer = await ctx.call('POST', '/api/v1/staff', {
    token: adminToken,
    body: { name: 'Viewer One', role: 'VIEWER', pin: '24680' },
  });
  assert.equal(viewer.status, 201);
  const viewerId = viewer.body.staff.id;

  const cashierLogin = await ctx.call('POST', '/api/v1/auth/login', { body: { pin: '1357' } });
  assert.equal(cashierLogin.status, 200);
  assert.equal(cashierLogin.body.role, 'CASHIER');
  cashierToken = cashierLogin.body.token;

  const viewerLogin = await ctx.call('POST', '/api/v1/auth/login', { body: { pin: '24680' } });
  assert.equal(viewerLogin.status, 200);
  assert.equal(viewerLogin.body.role, 'VIEWER');
  viewerToken = viewerLogin.body.token;

  assert.equal((await ctx.call('GET', '/api/v1/staff', { token: cashierToken })).status, 200);
  assert.equal((await ctx.call('POST', '/api/v1/staff', {
    token: cashierToken,
    body: { name: 'Nope', role: 'ADMIN', pin: '1111' },
  })).status, 403);
  assert.equal((await ctx.call('GET', '/api/v1/database/snapshots', { token: cashierToken })).status, 403);
  assert.equal((await ctx.call('POST', '/api/v1/expenses', {
    token: cashierToken,
    body: { category: 'Supplies', amount: 25 },
  })).status, 200);

  assert.equal((await ctx.call('GET', '/api/v1/orders', { token: viewerToken })).status, 200);
  assert.equal((await ctx.call('POST', '/api/v1/expenses', {
    token: viewerToken,
    body: { category: 'Supplies', amount: 25 },
  })).status, 403);
  assert.equal((await ctx.call('GET', '/api/v1/audit', { token: viewerToken })).status, 200);

  const changed = await ctx.call('PUT', `/api/v1/staff/${cashierId}`, {
    token: adminToken,
    body: { role: 'MANAGER' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.staff.role, 'MANAGER');

  const deleted = await ctx.call('DELETE', `/api/v1/staff/${viewerId}`, { token: adminToken });
  assert.equal(deleted.status, 200);
  assert.equal((await ctx.call('POST', '/api/v1/auth/login', { body: { pin: '24680' } })).status, 401);
});

test('audit: writes carry the acting staff member and their role', async () => {
  const { status, body } = await ctx.call('GET', '/api/v1/audit?limit=200', { token: adminToken });
  assert.equal(status, 200);
  const actions = new Set(body.entries.map((row) => row.action));
  for (const expected of ['signed_in', 'payment_recorded', 'return_created', 'expense_created', 'staff_created', 'staff_deleted']) {
    assert.ok(actions.has(expected), `audit log is missing ${expected}`);
  }
  const cashierExpense = body.entries.find((row) => row.action === 'expense_created' && row.actor === 'Cashier One');
  assert.ok(cashierExpense, 'the cashier expense must be attributed to the cashier');
  assert.equal(cashierExpense.role, 'CASHIER');
});

test('sync scope: staff receive money and audit data, customers do not', async () => {
  const admin = await ctx.call('GET', '/api/v1/sync?since=0', { token: adminToken });
  assert.equal(admin.body.scope, 'admin');
  assert.ok(Array.isArray(admin.body.expenses));
  assert.ok(Array.isArray(admin.body.staff));
  assert.ok(Array.isArray(admin.body.audit));
  assert.ok(admin.body.expenses.length > 0);

  const cashier = await ctx.call('GET', '/api/v1/sync?since=0', { token: cashierToken });
  assert.equal(cashier.status, 200);
  assert.equal(cashier.body.scope, 'staff');
  assert.ok(cashier.body.orders.length > 0);
  assert.equal(cashier.body.staff.length, 0, 'staff lists are administrator-only');

  const publicSync = await ctx.call('GET', '/api/v1/sync?since=0');
  assert.equal(publicSync.body.scope, 'public');
  assert.equal(publicSync.body.orders.length, 0);
  assert.equal(publicSync.body.expenses.length, 0);
});

test('snapshots and rollback routes are administrator-only and validate input', async () => {
  assert.equal((await ctx.call('GET', '/api/v1/database/snapshots')).status, 401);
  assert.equal((await ctx.call('GET', '/api/v1/database/snapshots', { token: cashierToken })).status, 403);
  const list = await ctx.call('GET', '/api/v1/database/snapshots', { token: adminToken });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.snapshots));

  const invalid = await ctx.call('POST', '/api/v1/database/rollback', {
    token: adminToken,
    body: { snapshot: '../../db.json' },
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'invalid_snapshot');
});

test('logout: the server invalidates the session immediately', async () => {
  const login = await ctx.call('POST', '/api/v1/auth/login', { body: { pin: '1357' } });
  assert.equal(login.status, 200);
  const token = login.body.token;
  assert.equal((await ctx.call('GET', '/api/v1/orders', { token })).status, 200);
  assert.equal((await ctx.call('POST', '/api/v1/auth/logout', { token })).status, 200);
  assert.equal((await ctx.call('GET', '/api/v1/orders', { token })).status, 401);
});

test('demo seed: administrator-only additive helper', async () => {
  assert.equal((await ctx.call('POST', '/api/v1/demo/seed', { token: cashierToken })).status, 403);
  const before = (await ctx.call('GET', '/api/v1/health')).body.database.counts.orders;
  const seeded = await ctx.call('POST', '/api/v1/demo/seed', { token: adminToken });
  assert.equal(seeded.status, 200);
  const after = (await ctx.call('GET', '/api/v1/health')).body.database.counts.orders;
  assert.ok(after >= before, 'demo seed must never delete existing orders');
});

test('versioned migration: a v1 database is snapshotted, upgraded and reversible', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockpoint-migration-'));
  try {
    const seedDb = new Database({ dataDir, pin: '2468', adminKey: 'test-admin-key' });
    const legacy = JSON.parse(JSON.stringify(seedDb.data));
    legacy.meta.version = 1;
    legacy.meta.rev = 3;
    legacy.orders = [{
      id: 1,
      client_uuid: 'legacy-order-1',
      order_number: 'MSP-000000-0001',
      type: 'SALE',
      customer_name: 'Legacy Customer',
      total_amount: 500,
      subtotal: 500,
      items: [],
      created_at: new Date().toISOString(),
      status: 'CONFIRMED',
    }];
    delete legacy.expenses;
    delete legacy.staff;
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(legacy, null, 2));

    const migrated = new Database({ dataDir, pin: '2468', adminKey: 'test-admin-key' });
    assert.equal(migrated.data.meta.version, 4);
    assert.equal(migrated.data.orders.length, 1, 'the legacy order must survive the migration');
    assert.deepEqual(migrated.data.expenses, []);
    assert.deepEqual(migrated.data.staff, []);
    assert.ok(migrated.data.orders[0].payments, 'legacy orders gain a payment ledger');
    assert.ok(migrated.snapshots().some((row) => row.name === 'db.v1.snapshot.json'));

    const rollback = migrated.rollback('db.v1.snapshot.json');
    assert.equal(rollback.snapshot, 'db.v1.snapshot.json');
    assert.equal(rollback.version, 4, 'rollback replays the additive migration before serving');
    assert.equal(migrated.data.orders.length, 1, 'rollback must not delete the legacy order');
    assert.ok(migrated.snapshots().some((row) => row.name === 'db.v1.snapshot.json'), 'snapshots are immutable');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
