/**
 * REST surface shared by the web app, the Android client and anything else that
 * speaks the Stockpoint v1 contract.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError, bool, clean, int, money, nowIso, safeEqual } from './util.js';
import { createCourier } from './courier.js';
import { clientIp, corsHeaders, requestId as newRequestId, securityHeaders } from './security.js';

const MAX_BODY = 2 * 1024 * 1024;

/** Rank order used by every staff-only route. Customers stay at zero. */
const ROLE_RANK = { VIEWER: 1, CASHIER: 2, MANAGER: 3, ADMIN: 4 };
const ROLE_LABELS = {
  1: 'viewers', 2: 'cashiers', 3: 'managers', 4: 'administrators',
};

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function ok(res, payload = {}, status = 200) {
  send(res, status, { success: true, ...payload });
}

function fail(res, error) {
  const status = error instanceof ApiError ? error.status : 500;
  const code = error instanceof ApiError ? error.code : 'server_error';
  const message = error instanceof ApiError ? error.message : 'The shop server hit an unexpected error.';
  if (!(error instanceof ApiError)) console.error(error);
  send(res, status, {
    success: false,
    message,
    error: { code, message, details: error?.details ?? null },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        chunks.length = 0;
        finish(reject, new ApiError('Request body is too large', 413, 'payload_too_large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (!chunks.length) {
        finish(resolve, {});
        return;
      }
      try {
        finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(reject, new ApiError('Request body must be valid JSON', 400, 'invalid_json'));
      }
    });
    req.on('error', (error) => finish(reject, error));
  });
}

function bearer(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requestAuth(req, url, db) {
  const token = bearer(req) || clean(req.headers['x-api-key'], 200) || clean(url.searchParams.get('api_key'), 200);
  if (!token) {
    return { isAdmin: false, isStaff: false, isCustomer: false, role: '', rank: 0, customerId: null, token: '' };
  }
  if (db.isAdminKey(token)) {
    return {
      isAdmin: true, isStaff: true, isCustomer: false, role: 'ADMIN', rank: 4,
      customerId: null, token, viaKey: true,
    };
  }
  const session = db.verifyToken(token);
  if (!session) {
    return { isAdmin: false, isStaff: false, isCustomer: false, role: '', rank: 0, token, viaKey: false };
  }
  if (String(session.role).toLowerCase() === 'customer') {
    return {
      isAdmin: false, isStaff: false, isCustomer: true, role: 'CUSTOMER', rank: 0,
      customerId: int(session.customer_id), token, viaKey: false,
    };
  }
  const role = String(session.role || 'CASHIER').toUpperCase();
  const rank = ROLE_RANK[role] || 0;
  return {
    isAdmin: rank >= 4, isStaff: rank >= 1, isCustomer: false, role, rank,
    staffId: int(session.staff_id), customerId: null, token, viaKey: false,
  };
}

/** 401 means no staff identity; 403 means a real identity with too few rights. */
function requireRank(auth, minimum, action = 'do that') {
  const rank = Math.max(int(auth?.rank, 0), auth?.isAdmin ? 4 : 0);
  if (!rank) throw new ApiError('Sign in with your shop PIN or staff PIN to do that', 401, 'unauthorized');
  if (rank < minimum) {
    throw new ApiError(
      `Your role cannot ${action}. Ask the owner for ${ROLE_LABELS[minimum] || 'a higher role'} access.`,
      403,
      'forbidden',
    );
  }
}

function requireAdmin(auth) {
  requireRank(auth, 4, 'change shop security settings');
}

/** Who to blame in the audit log for a request made with these credentials. */
function auditActor(auth, db) {
  if (auth.viaKey) return { actor: 'api-key', role: 'ADMIN' };
  if (auth.staffId) {
    const staff = db.listStaff().find((row) => int(row.id) === int(auth.staffId));
    if (staff) return { actor: staff.name, role: staff.role };
  }
  if (auth.isCustomer) return { actor: `customer:${auth.customerId}`, role: 'CUSTOMER' };
  if (auth.role) return { actor: auth.role, role: auth.role };
  return { actor: 'system', role: 'SYSTEM' };
}

function receiptText(db, order) {
  const settings = db.publicSettings();
  const currency = settings.currency || 'BDT';
  const sep = '-'.repeat(32);
  const lines = [];
  lines.push(String(settings.branch_name || 'Mohammadpur Stock Point').toUpperCase());
  if (settings.business_address) lines.push(String(settings.business_address));
  if (settings.business_phone) lines.push(`Tel: ${settings.business_phone}`);
  lines.push(sep);
  lines.push(`Order   : ${order.order_number}`);
  lines.push(`Date    : ${order.created_at}`);
  lines.push(`Customer: ${order.customer_name}`);
  if (order.dxn_member_id) lines.push(`Member  : ${order.dxn_member_id}`);
  lines.push(`Payment : ${order.payment_method}`);
  lines.push(sep);
  for (const item of order.items || []) {
    lines.push(`${String(item.name).slice(0, 22).padEnd(22)} x${item.quantity}`);
    lines.push(`  @ ${Number(item.unit_price).toFixed(2)} = ${Number(item.line_total).toFixed(2)}`);
  }
  lines.push(sep);
  if (money(order.discount) > 0) {
    lines.push(`Subtotal: ${Number(order.subtotal).toFixed(2)}`);
    lines.push(`Discount: -${Number(order.discount).toFixed(2)}`);
  }
  lines.push(`TOTAL   : ${Number(order.total_amount).toFixed(2)} ${currency}`);
  lines.push(`PV      : ${Number(order.total_pv).toFixed(2)}`);
  lines.push(sep);
  if (settings.receipt_footer) lines.push(String(settings.receipt_footer));
  return lines.join('\n');
}

export function createApi({ db, options = {} }) {
  const allowedOrigins = options.allowedOrigins || [];
  const limiter = options.rateLimiter || null;
  const trustProxy = options.trustProxy === true;
  const courier = createCourier(db);
  const auditStore = new AsyncLocalStorage();
  db.setAuditContextProvider(() => auditStore.getStore() || null);
  const loginAttempts = new Map();
  const LOGIN_LIMIT = 10;
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;

  function loginRate(ip) {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
      loginAttempts.set(ip, { count: 0, firstAt: now });
      return { ok: true };
    }
    if (entry.count >= LOGIN_LIMIT) {
      const retryAfter = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - entry.firstAt)) / 1000));
      return { ok: false, retryAfter };
    }
    return { ok: true };
  }

  return async function handleApi(req, res, url) {
    res.setHeader('X-Request-Id', newRequestId(req));
    const cors = corsHeaders(req, allowedOrigins);
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    for (const [name, value] of Object.entries(securityHeaders(req))) res.setHeader(name, value);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const path = url.pathname.replace(/\/+$/, '') || '/api/v1';

    return auditStore.run({ actor: 'system', role: 'SYSTEM' }, async () => {
    try {
      const origin = req.headers.origin;
      if (origin && !cors['Access-Control-Allow-Origin'] && req.method !== 'GET' && req.method !== 'HEAD') {
        throw new ApiError('This origin is not allowed to call the shop API', 403, 'origin_not_allowed');
      }

      const ip = clientIp(req, trustProxy);
      if (limiter && path !== '/api/v1/courier/webhook') {
        const rate = limiter.consume(ip);
        if (!rate.ok) {
          res.setHeader('Retry-After', String(rate.retryAfter));
          throw new ApiError(
            `Too many requests. Try again in ${rate.retryAfter} seconds.`,
            429,
            'rate_limited',
          );
        }
      }

      const auth = requestAuth(req, url, db);
      db.setAuditContext(auditActor(auth, db));
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

      // ── Service ───────────────────────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/health') {
        ok(res, db.health());
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/config') {
        ok(res, db.config());
        return;
      }
      if (req.method === 'GET' && path === '/api/v1') {
        ok(res, {
          name: 'Mohammadpur Stock Point API',
          version: '3.2.0',
          endpoints: [
            '/health', '/config', '/products', '/orders', '/payments', '/returns',
            '/expenses', '/staff', '/audit', '/sync', '/dashboard', '/reports/sales',
          ],
        });
        return;
      }

      // ── Auth ──────────────────────────────────────────────────────────────
      if (req.method === 'POST' && path === '/api/v1/auth/login') {
        const rate = loginRate(ip);
        if (!rate.ok) {
          res.setHeader('Retry-After', String(rate.retryAfter));
          throw new ApiError(`Too many login attempts. Try again in ${rate.retryAfter} seconds.`, 429, 'rate_limited');
        }
        const pin = clean(body.pin, 32);
        try {
          const result = db.login(pin);
          loginAttempts.delete(ip);
          ok(res, result);
        } catch (error) {
          const entry = loginAttempts.get(ip);
          if (entry) entry.count += 1;
          throw error;
        }
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/auth/me') {
        if (auth.isCustomer) {
          const info = db.customerAccountByToken(auth.token);
          ok(res, { role: 'customer', scope: 'customer', customer: info ? info.customer : null });
          return;
        }
        requireRank(auth, 1, 'view shop data');
        ok(res, {
          role: auth.role,
          scope: auth.rank >= 4 ? 'admin' : (auth.isStaff ? 'staff' : 'public'),
          staff_id: auth.staffId || 0,
        });
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/auth/pin') {
        requireAdmin(auth);
        db.changePin(clean(body.new_pin, 32));
        ok(res, { message: 'PIN updated. Existing sessions stay valid until they expire.' });
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/auth/logout') {
        db.logout(auth.token);
        ok(res, { message: 'Signed out' });
        return;
      }

      // ── Customer accounts (ecommerce) ────────────────────────────────────
      if (req.method === 'POST' && path === '/api/v1/auth/register') {
        const result = db.registerCustomerAccount({
          phone: body.phone,
          password: body.password,
          name: body.name,
          email: body.email,
        });
        ok(res, result, 201);
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/auth/customer/login') {
        const result = db.loginCustomer(body.phone, body.password);
        ok(res, result);
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/my/profile') {
        if (!auth.isCustomer) throw new ApiError('Sign in with a customer account', 401, 'unauthorized');
        ok(res, { profile: db.myProfile(auth.token) });
        return;
      }
      if ((req.method === 'PUT' || req.method === 'PATCH') && path === '/api/v1/my/profile') {
        if (!auth.isCustomer) throw new ApiError('Sign in with a customer account', 401, 'unauthorized');
        const profile = db.updateMyProfile(auth.token, body);
        ok(res, { profile });
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/my/orders') {
        if (!auth.isCustomer) throw new ApiError('Sign in with a customer account', 401, 'unauthorized');
        ok(res, { orders: db.myOrders(auth.token) });
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/my/track') {
        const orderNumber = clean(url.searchParams.get('order_number'), 40);
        const phone = clean(url.searchParams.get('phone'), 40);
        if (!orderNumber || !phone) throw new ApiError('order_number and phone are required', 422, 'validation_error');
        const order = db.trackOrder(orderNumber, phone);
        ok(res, { order });
        return;
      }

      // ── Catalogue ─────────────────────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/products') {
        const includeInactive = url.searchParams.get('include_inactive') === '1' && auth.isStaff;
        const products = db.products(includeInactive);
        ok(res, {
          products,
          categories: [...new Set(products.map((product) => product.category))],
          count: products.length,
        });
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/products') {
        requireRank(auth, 3, 'add products');
        const product = db.createProduct(body);
        ok(res, { message: 'Product created', product }, 201);
        return;
      }

      const productMatch = path.match(/^\/api\/v1\/products\/(\d+)$/);
      if (productMatch) {
        const id = int(productMatch[1]);
        if (req.method === 'GET') {
          const product = db.product(id);
          if (!product) throw new ApiError('Product not found', 404, 'not_found');
          ok(res, { product });
          return;
        }
        requireRank(auth, 3, 'edit products');
        if (req.method === 'PUT' || req.method === 'PATCH') {
          const product = db.updateProduct(id, body);
          ok(res, { message: 'Product updated', product });
          return;
        }
        if (req.method === 'DELETE') {
          db.archiveProduct(id);
          ok(res, { message: 'Product archived' });
          return;
        }
      }

      const restoreMatch = path.match(/^\/api\/v1\/products\/(\d+)\/restore$/);
      if (restoreMatch && req.method === 'POST') {
        requireRank(auth, 3, 'restore products');
        const product = db.restoreProduct(int(restoreMatch[1]));
        ok(res, { message: 'Product restored', product });
        return;
      }

      // ── Stock ─────────────────────────────────────────────────────────────
      if (req.method === 'POST' && path === '/api/v1/stock/update') {
        requireRank(auth, 3, 'set stock levels');
        const productId = int(body.productId ?? body.product_id);
        const newQuantity = int(body.newQuantity ?? body.new_quantity, -1);
        if (productId <= 0 || newQuantity < 0) {
          throw new ApiError('productId and a non-negative newQuantity are required', 422, 'validation_error');
        }
        const product = db.product(productId);
        if (!product) throw new ApiError('Product not found', 404, 'not_found');
        const delta = newQuantity - product.stock_qty;
        const after = db.applyStockDelta(productId, delta, clean(body.reason || 'stock_take', 64));
        db.audit('stock_set', 'product', productId, `${product.stock_qty} -> ${newQuantity}`);
        db.save();
        ok(res, { message: 'Stock updated', product: db.product(productId), stock_qty: after });
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/stock/adjust') {
        requireRank(auth, 3, 'adjust stock');
        const productId = int(body.productId ?? body.product_id);
        const delta = int(body.delta ?? body.change);
        if (productId <= 0 || delta === 0) {
          throw new ApiError('productId and a non-zero delta are required', 422, 'validation_error');
        }
        const after = db.applyStockDelta(productId, delta, clean(body.reason || 'adjustment', 64));
        db.audit('stock_adjust', 'product', productId, String(delta));
        db.save();
        ok(res, { message: 'Stock adjusted', product: db.product(productId), stock_qty: after });
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/stock/movements') {
        requireRank(auth, 1, 'view stock movements');
        ok(res, { movements: db.movements(url.searchParams.get('limit') || 100) });
        return;
      }

      // ── Orders ────────────────────────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/orders') {
        requireRank(auth, 1, 'view orders');
        const orders = db.orders({
          limit: url.searchParams.get('limit') || 100,
          status: clean(url.searchParams.get('status'), 24),
          type: clean(url.searchParams.get('type'), 16).toUpperCase(),
          q: clean(url.searchParams.get('q'), 120),
          from: clean(url.searchParams.get('from'), 12),
          to: clean(url.searchParams.get('to'), 12),
        });
        ok(res, { orders, count: orders.length });
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/orders') {
        // Customers may order when enabled, but only staff may force oversell.
        const privileged = auth.rank >= 1;
        const payload = { ...body, allow_oversell: privileged && bool(body.allow_oversell) === 1 };
        const result = db.createOrder(payload, { isStaff: privileged, customerId: auth.customerId });
        ok(res, { order: result.order, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
        return;
      }

      const orderMatch = path.match(/^\/api\/v1\/orders\/(\d+)$/);
      if (orderMatch && req.method === 'GET') {
        requireRank(auth, 1, 'view orders');
        const order = db.order(int(orderMatch[1]));
        if (!order) throw new ApiError('Order not found', 404, 'not_found');
        ok(res, { order });
        return;
      }

      const statusMatch = path.match(/^\/api\/v1\/orders\/(\d+)\/status$/);
      if (statusMatch && req.method === 'POST') {
        requireRank(auth, 2, 'change order status');
        const order = db.updateOrderStatus(int(statusMatch[1]), body.status);
        ok(res, { message: 'Order status updated', order });
        return;
      }

      const markPaidMatch = path.match(/^\/api\/v1\/orders\/(\d+)\/mark-paid$/);
      if (markPaidMatch && req.method === 'POST') {
        requireRank(auth, 2, 'confirm payments');
        const order = db.markPaid(int(markPaidMatch[1]));
        ok(res, { message: 'Payment confirmed', order });
        return;
      }

      const paymentMatch = path.match(/^\/api\/v1\/orders\/(\d+)\/payments$/);
      if (paymentMatch && req.method === 'POST') {
        requireRank(auth, 2, 'record payments');
        const result = db.recordPayment(int(paymentMatch[1]), body);
        ok(res, { ...result, message: result.duplicate ? 'Payment already recorded' : 'Payment recorded' });
        return;
      }

      const returnMatch = path.match(/^\/api\/v1\/orders\/(\d+)\/returns$/);
      if (returnMatch && req.method === 'POST') {
        requireRank(auth, 2, 'process returns');
        const result = db.createReturn(int(returnMatch[1]), body);
        ok(res, { ...result, message: result.duplicate ? 'Return already recorded' : 'Return recorded' });
        return;
      }

      const timelineMatch = path.match(/^\/api\/v1\/orders\/(\d+)\/timeline$/);
      if (timelineMatch && req.method === 'GET') {
        requireRank(auth, 1, 'view order history');
        ok(res, { timeline: db.orderTimeline(int(timelineMatch[1])) });
        return;
      }

      const receiptMatch = path.match(/^\/api\/v1\/orders\/(\d+)\/receipt$/);
      if (receiptMatch && req.method === 'GET') {
        requireRank(auth, 1, 'print receipts');
        const order = db.order(int(receiptMatch[1]));
        if (!order) throw new ApiError('Order not found', 404, 'not_found');
        ok(res, { receipt: receiptText(db, order), order });
        return;
      }

      // ── Money movement ledgers ───────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/payments') {
        requireRank(auth, 1, 'view payments');
        ok(res, db.paymentLedger(clean(url.searchParams.get('from'), 12), clean(url.searchParams.get('to'), 12)));
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/returns') {
        requireRank(auth, 1, 'view returns');
        ok(res, { returns: db.orders({ limit: 500, type: 'RETURN' }) });
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/expenses') {
        requireRank(auth, 1, 'view expenses');
        ok(res, { expenses: db.listExpenses(url.searchParams.get('limit') || 300) });
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/expenses') {
        requireRank(auth, 2, 'record expenses');
        const result = db.createExpense(body);
        ok(res, { ...result, message: result.duplicate ? 'Expense already recorded' : 'Expense recorded' });
        return;
      }

      // ── Customers ─────────────────────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/customers') {
        requireRank(auth, 1, 'view customers');
        const customers = db.customers(clean(url.searchParams.get('q'), 120));
        ok(res, { customers, count: customers.length });
        return;
      }
      const customerMatch = path.match(/^\/api\/v1\/customers\/(\d+)$/);
      if (customerMatch && req.method === 'GET') {
        requireRank(auth, 1, 'view customers');
        const customer = db.customer(int(customerMatch[1]));
        if (!customer) throw new ApiError('Customer not found', 404, 'not_found');
        const orders = db.orders({ limit: 500 }).filter((order) => int(order.customer_id) === customer.id);
        ok(res, { customer, orders });
        return;
      }

      // ── Reports ───────────────────────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/dashboard') {
        requireRank(auth, 1, 'view the dashboard');
        ok(res, { data: db.dashboard() });
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/reports/sales') {
        requireRank(auth, 1, 'view reports');
        ok(res, db.salesReport(
          clean(url.searchParams.get('from'), 12),
          clean(url.searchParams.get('to'), 12),
        ));
        return;
      }

      // ── Settings ──────────────────────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/settings') {
        if (auth.rank < 3) {
          ok(res, { settings: db.publicSettings(), scope: 'public' });
          return;
        }
        ok(res, {
          settings: { ...db.settings(), ...db.publicSettings() },
          public: db.publicSettings(),
          scope: auth.rank >= 4 ? 'admin' : 'manager',
          rev: db.currentRev(),
        });
        return;
      }
      if ((req.method === 'PUT' || req.method === 'PATCH') && path === '/api/v1/settings') {
        requireRank(auth, 3, 'change shop settings');
        const result = db.saveSettings(body);
        ok(res, { message: 'Settings saved', ...result });
        return;
      }

      // ── Staff, audit & versioned rollback ────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/staff') {
        requireRank(auth, 1, 'view staff');
        ok(res, { staff: db.listStaff() });
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/staff') {
        requireAdmin(auth);
        const staff = db.createStaff(body);
        ok(res, { message: 'Staff member added', staff }, 201);
        return;
      }
      const staffMatch = path.match(/^\/api\/v1\/staff\/(\d+)$/);
      if (staffMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
        requireAdmin(auth);
        const staff = db.updateStaff(int(staffMatch[1]), body);
        ok(res, { message: 'Staff member updated', staff });
        return;
      }
      if (staffMatch && req.method === 'DELETE') {
        requireAdmin(auth);
        db.deleteStaff(int(staffMatch[1]));
        ok(res, { message: 'Staff member removed' });
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/audit') {
        requireRank(auth, 1, 'view the audit log');
        ok(res, { entries: db.auditLog(url.searchParams.get('limit') || 200) });
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/database/snapshots') {
        requireAdmin(auth);
        ok(res, { snapshots: db.snapshots() });
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/database/rollback') {
        requireAdmin(auth);
        const result = db.rollback(body.snapshot);
        ok(res, { message: `Restored ${result.snapshot}`, ...result });
        return;
      }

      // ── Sync ──────────────────────────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/sync') {
        const since = Math.max(0, int(url.searchParams.get('since')));
        ok(res, db.sync(since, { isAdmin: auth.rank >= 4, isStaff: auth.rank >= 1 }));
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/sync/status') {
        ok(res, {
          server_rev: db.currentRev(),
          server_time: nowIso(),
          scope: auth.rank >= 4 ? 'admin' : (auth.rank >= 1 ? 'staff' : 'public'),
        });
        return;
      }

      // ── Courier ───────────────────────────────────────────────────────────
      if (path === '/api/v1/courier/settings') {
        if (req.method === 'GET') {
          requireRank(auth, 3, 'view courier settings');
          ok(res, { settings: courier.settings() });
          return;
        }
        if (req.method === 'PUT' || req.method === 'PATCH') {
          requireAdmin(auth);
          courier.saveSettings(body);
          ok(res, { message: 'SteadFast settings saved', configured: courier.settings().configured });
          return;
        }
      }
      if (req.method === 'GET' && path === '/api/v1/courier/balance') {
        requireRank(auth, 1, 'view courier balance');
        ok(res, { balance: await courier.balance() });
        return;
      }
      if (req.method === 'GET' && path === '/api/v1/courier/returns') {
        requireRank(auth, 1, 'view courier returns');
        ok(res, { returns: await courier.returns() });
        return;
      }
      if (req.method === 'POST' && path === '/api/v1/courier/webhook') {
        const supplied = bearer(req) || clean(url.searchParams.get('token'), 200);
        const expected = courier.webhookToken();
        if (expected !== '' && !safeEqual(expected, supplied)) {
          throw new ApiError('Unauthorized', 401, 'unauthorized');
        }
        const consignmentId = int(body.consignment_id);
        const invoice = clean(body.invoice, 80);
        const row = (consignmentId > 0
          ? db.data.orders.find((order) => int(order.courier_consignment_id) === consignmentId)
          : null)
          || (invoice
            ? db.data.orders.find((order) => order.order_number === invoice.replace(/^DXN-/, ''))
            : null);

        if (row && String(body.notification_type || '') === 'delivery_status') {
          const sfStatus = String(body.status || '').toLowerCase();
          if (sfStatus) row.courier_status = sfStatus;
          row.updated_at = nowIso();
          row.rev = db.nextRev();
          db.save();
          db.audit('courier_webhook', 'order', String(row.id), sfStatus);
          const mapped = courier.mapOrderStatus(sfStatus);
          if (mapped && mapped !== row.status) {
            try {
              db.updateOrderStatus(row.id, mapped);
            } catch (error) {
              db.audit('courier_webhook_skipped', 'order', String(row.id), error.message);
            }
          }
        }
        ok(res, { status: 'success', message: 'Webhook received successfully.' });
        return;
      }

      const shipMatch = path.match(/^\/api\/v1\/courier\/ship\/(\d+)$/);
      if (shipMatch && req.method === 'POST') {
        requireRank(auth, 2, 'ship orders');
        const id = int(shipMatch[1]);
        const order = db.order(id);
        const row = db.orderRow(id);
        if (!order || !row) throw new ApiError('Order not found', 404, 'not_found');
        if (row.courier_consignment_id) {
          throw new ApiError(
            `This order already has a consignment (${row.courier_tracking_code || row.courier_consignment_id})`,
            409,
            'already_shipped',
          );
        }
        const phone = clean(order.customer_phone, 40);
        const address = clean(body.recipient_address, 250);
        if (!phone) throw new ApiError('Customer phone is required to ship', 422, 'validation_error');
        if (!address) throw new ApiError('Recipient address is required', 422, 'validation_error');

        const codAmount = body.cod_amount !== undefined && Number.isFinite(Number(body.cod_amount))
          ? money(body.cod_amount)
          : money(order.total_amount);
        const payload = {
          invoice: `DXN-${order.order_number}`,
          recipient_name: clean(order.customer_name, 100) || 'Customer',
          recipient_phone: phone,
          recipient_address: address,
          cod_amount: codAmount,
        };
        const note = clean(body.note ?? order.note, 500);
        if (note) payload.note = note;
        const description = clean(body.item_description, 250);
        if (description) payload.item_description = description;
        if (body.delivery_type !== undefined) payload.delivery_type = int(body.delivery_type);

        const result = await courier.createOrder(payload);
        const consignment = result.consignment || result;
        if (!consignment?.consignment_id) {
          throw new ApiError('SteadFast did not return a consignment', 502, 'courier_error');
        }

        row.courier_provider = 'steadfast';
        row.courier_consignment_id = int(consignment.consignment_id);
        row.courier_tracking_code = clean(consignment.tracking_code, 80) || null;
        row.courier_status = clean(consignment.status, 40) || 'in_review';
        row.courier_cod_amount = codAmount;
        row.courier_created_at = nowIso();
        row.updated_at = nowIso();
        row.rev = db.nextRev();
        db.save();
        db.audit('courier_shipment_created', 'order', String(id), `consignment ${row.courier_consignment_id}`);

        ok(res, {
          message: 'Shipment created with SteadFast',
          order: db.order(id),
          consignment,
        });
        return;
      }

      const courierStatusMatch = path.match(/^\/api\/v1\/courier\/status\/(\d+)$/);
      if (courierStatusMatch && req.method === 'GET') {
        requireRank(auth, 2, 'refresh shipments');
        const id = int(courierStatusMatch[1]);
        const row = db.orderRow(id);
        if (!row) throw new ApiError('Order not found', 404, 'not_found');
        if (!row.courier_consignment_id) throw new ApiError('No consignment for this order', 404, 'no_consignment');

        const result = await courier.statusByCid(row.courier_consignment_id);
        const sfStatus = clean(result.delivery_status ?? result.status, 40) || row.courier_status || '';
        row.courier_status = sfStatus;
        row.updated_at = nowIso();
        row.rev = db.nextRev();
        db.save();

        const mapped = courier.mapOrderStatus(sfStatus);
        if (mapped && mapped !== row.status) {
          try {
            db.updateOrderStatus(id, mapped);
            db.audit('courier_status_synced', 'order', String(id), `${row.status} -> ${mapped}`);
          } catch (error) {
            db.audit('courier_status_skipped', 'order', String(id), error.message);
          }
        }
        ok(res, { order: db.order(id), courier_status: sfStatus, mapped_status: mapped });
        return;
      }

      const courierReturnMatch = path.match(/^\/api\/v1\/courier\/return\/(\d+)$/);
      if (courierReturnMatch && req.method === 'POST') {
        requireRank(auth, 2, 'request courier returns');
        const id = int(courierReturnMatch[1]);
        const order = db.order(id);
        if (!order) throw new ApiError('Order not found', 404, 'not_found');
        if (!order.courier_consignment_id) throw new ApiError('No consignment for this order', 404, 'no_consignment');

        const payload = { consignment_id: int(order.courier_consignment_id) };
        const reason = clean(body.reason, 250);
        if (reason) payload.reason = reason;
        const result = await courier.createReturn(payload);
        db.audit('courier_return_requested', 'order', String(id), reason);
        ok(res, { message: 'Return request created', result });
        return;
      }

      if (path.startsWith('/api/v1/courier/') && req.method === 'POST') {
        throw new ApiError(`No route for ${req.method} ${path}`, 404, 'not_found');
      }

      // ── Local demo helpers ────────────────────────────────────────────────
      if (req.method === 'POST' && path === '/api/v1/demo/seed') {
        requireAdmin(auth);
        const result = db.seedDemoOrders();
        ok(res, { message: 'Demo sales created', ...result });
        return;
      }

      throw new ApiError(`No route for ${req.method} ${path}`, 404, 'not_found');
    } catch (error) {
      fail(res, error);
    }
    });
  };
}
