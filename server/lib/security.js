/**
 * Transport-level protection for the Node API: CORS, security headers,
 * per-IP rate limiting and proxy-aware client addresses.
 *
 * Everything here is dependency-free so the server still runs with a bare
 * Node.js install. TLS itself is terminated in front of the app (Caddy).
 */

import crypto from 'node:crypto';

export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim();
      if (first) return first.slice(0, 64);
    }
  }
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

export function requestId(req) {
  const supplied = String(req.headers['x-request-id'] || '');
  if (/^[A-Za-z0-9._-]{8,64}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

/** A small fixed-window limiter. Memory-only: a restart clears the counters. */
export class RateLimiter {
  constructor({ limit, windowMs, maxKeys = 20000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  consume(key) {
    const now = Date.now();
    if (this.hits.size > this.maxKeys) this.prune(now);
    let entry = this.hits.get(key);
    if (!entry || now - entry.firstAt >= this.windowMs) {
      entry = { count: 0, firstAt: now };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count <= this.limit) return { ok: true, remaining: this.limit - entry.count };
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((this.windowMs - (now - entry.firstAt)) / 1000)),
    };
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.hits) {
      if (now - entry.firstAt >= this.windowMs) this.hits.delete(key);
    }
  }
}

function originHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}

function matches(origin, pattern) {
  if (pattern === '*') return true;
  if (pattern === origin) return true;
  // Allow "https://*.example.com" style wildcards without pulling a library.
  if (pattern.includes('*')) {
    const [scheme, host] = pattern.split('://');
    const target = originHost(origin);
    if (!target || !host) return false;
    const prefix = `${scheme}://`;
    if (!origin.startsWith(prefix)) return false;
    const suffix = host.replace(/^\*\./, '');
    return target === suffix || target.endsWith(`.${suffix}`);
  }
  return false;
}

/**
 * Returns the CORS headers for this request. Same-origin requests and requests
 * without an Origin header (Android, curl, server-to-server) are always fine.
 */
export function corsHeaders(req, allowedOrigins = []) {
  const origin = req.headers.origin;
  if (!origin) return {};
  const sameOrigin = originHost(origin) && originHost(origin) === String(req.headers.host || '');
  if (!sameOrigin && !allowedOrigins.some((pattern) => matches(origin, pattern))) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Request-Id',
    'Access-Control-Expose-Headers': 'X-Request-Id, Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function securityHeaders(req) {
  const https = req.socket?.encrypted === true
    || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  };
  if (https) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}
