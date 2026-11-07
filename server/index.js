#!/usr/bin/env node
/**
 * Mohammadpur Stock Point — local shop server.
 *
 *   node server/index.js                 start on http://127.0.0.1:4173
 *   node server/index.js --open          start and open the browser
 *   node server/index.js --port 8080     choose a port
 *   node server/index.js --reset         recreate the database
 *   node server/index.js --demo          seed friendly demo sales
 *
 * The same process serves the PWA from docs/ and the JSON API from /api/v1.
 * No npm install, no database server, no cloud account.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Database } from './lib/db.js';
import { createApi } from './lib/api.js';
import { clientIp, RateLimiter } from './lib/security.js';
import { mimeFor } from './lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const DATA = path.join(__dirname, 'data');
const CATALOG = path.join(DOCS, 'products-catalog.json');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

const hasFlag = (name) => process.argv.includes(name);

const PRODUCTION = hasFlag('--production') || process.env.NODE_ENV === 'production';
const PORT = Number(argument('--port', process.env.PORT || 4173));
const HOST = argument('--host', process.env.HOST || (PRODUCTION ? '0.0.0.0' : '127.0.0.1'));
const PIN = argument('--pin', process.env.DXN_PIN || '2468');
const ADMIN_KEY = process.env.DXN_ADMIN_KEY || 'local-dev-admin-key-change-me';
const OPEN = hasFlag('--open');
const DEMO = hasFlag('--demo');
const RESET = hasFlag('--reset');

const CORS_ORIGINS = String(process.env.DXN_CORS_ORIGINS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const TRUST_PROXY = process.env.DXN_TRUST_PROXY
  ? process.env.DXN_TRUST_PROXY === '1'
  : PRODUCTION;
const RATE_LIMIT = Math.max(30, Number(process.env.DXN_RATE_LIMIT) || 300);
const LOG_JSON = process.env.DXN_LOG_FORMAT === 'json' || (PRODUCTION && process.env.DXN_LOG_FORMAT !== 'text');

if (RESET) {
  fs.rmSync(path.join(DATA, 'db.json'), { force: true });
}

const db = new Database({
  dataDir: DATA,
  catalogPath: CATALOG,
  pin: PIN,
  adminKey: ADMIN_KEY,
});

if (PRODUCTION) {
  if (PIN === '2468') {
    console.error('Refusing to start in production mode with the default PIN 2468. Set DXN_PIN.');
    process.exit(1);
  }
  if (ADMIN_KEY === 'local-dev-admin-key-change-me') {
    console.error('Refusing to start in production mode with the default admin key. Set DXN_ADMIN_KEY.');
    process.exit(1);
  }
  if (ADMIN_KEY.length < 24) {
    console.warn('WARNING: DXN_ADMIN_KEY is shorter than 24 characters. Use a long random value.');
  }
  if (!TRUST_PROXY) {
    console.warn('WARNING: DXN_TRUST_PROXY is off. Per-IP rate limits will see the reverse proxy address.');
  }
  if (CORS_ORIGINS.includes('*')) {
    console.warn('WARNING: DXN_CORS_ORIGINS=* allows every website to call the API. Prefer an explicit list.');
  }
}

if (DEMO && db.data.orders.length === 0) {
  const result = db.seedDemoOrders();
  console.log(`Seeded ${result.created} demo sales.`);
}

const rateLimiter = new RateLimiter({ limit: RATE_LIMIT, windowMs: 60 * 1000 });
const handleApi = createApi({
  db,
  options: {
    allowedOrigins: CORS_ORIGINS,
    rateLimiter,
    trustProxy: TRUST_PROXY,
  },
});

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '');
  // '/' resolves to the docs folder itself; serveStatic appends index.html.
  const target = path.resolve(DOCS, relative || '.');
  if (target !== DOCS && !target.startsWith(DOCS + path.sep)) return null;
  return target;
}

function serveStatic(req, res, pathname) {
  let filePath = resolveStatic(pathname);
  if (!filePath) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  if (pathname === '/' || pathname.endsWith('/')) {
    filePath = path.join(filePath, 'index.html');
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // A client-side route such as /orders should still boot the app.
    if (!path.extname(filePath)) {
      filePath = path.join(DOCS, 'index.html');
      try {
        stat = fs.statSync(filePath);
      } catch {
        sendText(res, 404, 'Not found');
        return;
      }
    } else {
      sendText(res, 404, 'Not found');
      return;
    }
  }

  if (stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    try {
      stat = fs.statSync(filePath);
    } catch {
      sendText(res, 404, 'Not found');
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }

  const headers = {
    'Content-Type': mimeFor(filePath),
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' || ext === '.webmanifest'
      ? 'no-cache'
      : 'public, max-age=3600',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };

  if (String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' || req.socket.encrypted) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  if (ext === '.html') {
    headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  res.on('finish', () => {
    if (!url.pathname.startsWith('/api/')) return;
    const ms = Date.now() - started;
    const requestId = res.getHeader('X-Request-Id') || '-';
    const ip = clientIp(req, TRUST_PROXY);
    if (LOG_JSON) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : 'info',
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms,
        ip,
        request_id: requestId,
      }));
    } else {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${ms}ms ${requestId}`);
    }
  });

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((error) => {
      console.error(error);
      if (!res.headersSent) sendText(res, 500, 'Server error');
      else res.end();
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  serveStatic(req, res, url.pathname);
});

function openBrowser(target) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Opening a browser is a convenience, never a requirement.
  }
}

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  const url = `http://${displayHost}:${PORT}`;
  const products = db.data.products.length;
  const orders = db.data.orders.length;

  console.log('');
  console.log('  Mohammadpur Stock Point');
  console.log('  -----------------------------------------------');
  console.log(`  Shop app     ${url}`);
  console.log(`  API health   ${url}/api/v1/health`);
  console.log(`  Mode         ${PRODUCTION ? 'production (secure)' : 'development'}`);
  if (!PRODUCTION) {
    console.log(`  Admin PIN    ${PIN}`);
  }
  console.log(`  Data file    ${path.join(DATA, 'db.json')}`);
  console.log(`  Catalogue    ${products} products · ${orders} orders`);
  console.log(`  Rate limit   ${RATE_LIMIT} requests/min/IP`);
  console.log(`  CORS         ${CORS_ORIGINS.length ? CORS_ORIGINS.join(', ') : 'same-origin only'}`);
  console.log('  -----------------------------------------------');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  if (OPEN) openBrowser(url);
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\nStopping Stockpoint (${signal})…`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  server.close(() => {
    try {
      db.save();
    } catch (error) {
      console.error('Could not flush the database on shutdown:', error);
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});
