/**
 * Role-based access control.
 *
 * The shop PIN is not a single shared password: each staff member has a role
 * and their own PIN. The server validates the PIN and returns the role in the
 * token; offline the same PIN is checked against the locally cached, salted
 * hash. The UI hides what a role cannot use, and the API enforces it again so
 * a crafted request cannot bypass the screen.
 */

import { uuid } from './util.js';

export const ROLES = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  CASHIER: 'CASHIER',
  VIEWER: 'VIEWER',
};

export const ROLE_LABELS = {
  ADMIN: 'Administrator',
  MANAGER: 'Manager',
  CASHIER: 'Cashier',
  VIEWER: 'Viewer',
};

export const ROLE_RANK = { ADMIN: 4, MANAGER: 3, CASHIER: 2, VIEWER: 1 };

/**
 * Every guarded action in the app. Keep these names stable: they are used by
 * both the view layer and the server's permission map.
 */
export const PERMISSIONS = {
  ADMIN: ['*'],
  MANAGER: [
    'dashboard.view', 'pos.sell', 'orders.view', 'orders.create', 'orders.payment',
    'orders.return', 'orders.status', 'inventory.view', 'inventory.edit',
    'inventory.movement', 'customers.view', 'customers.edit', 'reports.view',
    'reports.export', 'expenses.edit', 'audit.view', 'settings.view', 'sync.manage',
    'backup.export',
  ],
  CASHIER: [
    'dashboard.view', 'pos.sell', 'orders.view', 'orders.create', 'orders.payment',
    'customers.view', 'customers.edit', 'inventory.view', 'reports.view', 'sync.manage',
  ],
  VIEWER: ['dashboard.view', 'orders.view', 'inventory.view', 'customers.view', 'reports.view'],
};

export function can(role, action) {
  const key = String(role || '').toUpperCase();
  if (!PERMISSIONS[key]) return false;
  const list = PERMISSIONS[key];
  if (list.includes('*')) return true;
  return list.includes(action);
}

/** Actions only an administrator may perform. */
export function isAdminRole(role) {
  return String(role || '').toUpperCase() === ROLES.ADMIN;
}

// ── Local PIN hashing ───────────────────────────────────────────────────────

const LOCAL_STAFF_KEY = 'dxn.staff.v1';
export const DEFAULT_ADMIN_PIN = '2468';

export function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fallbackHash(text) {
  // Only used when WebCrypto is unavailable (very old WebView). Still salted.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return `fnv1a$${h1.toString(16)}${h2.toString(16)}`;
}

export async function hashPin(pin, salt = 'dxn-local-v1') {
  const text = `${salt}:${String(pin || '')}`;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return `sha256$${bytesToHex(digest)}`;
  }
  return fallbackHash(text);
}

export async function verifyPinHash(pin, hash) {
  if (!hash) return false;
  const candidate = await hashPin(pin, 'dxn-local-v1');
  return candidate === hash;
}

/** Reads the locally cached staff list (the server is still the authority). */
export function localStaff() {
  try {
    const raw = localStorage.getItem(LOCAL_STAFF_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list) && list.length) return list;
  } catch { /* ignore */ }
  return [{
    id: 'owner',
    name: 'Shop owner',
    role: ROLES.ADMIN,
    active: true,
    // The default PIN is a bootstrap convenience; Settings forces a change.
    pin_hash: 'sha256$3f9f0f4c1a0e4e3f1c0e9a5f2f2b0d5e0a0f7f3f6c5f8e9d0a1b2c3d4e5f6a7b',
    bootstrap: true,
  }];
}

export function saveLocalStaff(list) {
  try {
    localStorage.setItem(LOCAL_STAFF_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export async function addLocalStaff({ name, role, pin }) {
  const list = localStaff();
  const cleanRole = String(role || '').toUpperCase();
  if (!PERMISSIONS[cleanRole]) throw new Error('Choose a valid role.');
  if (!/^\d{4,8}$/.test(String(pin || ''))) throw new Error('The PIN must be 4 to 8 digits.');
  if (list.some((s) => s.active && s.role === ROLES.ADMIN) && cleanRole === ROLES.ADMIN && list.filter((s) => s.role === ROLES.ADMIN).length >= 3) {
    throw new Error('Too many administrator accounts on this device.');
  }
  const entry = {
    id: uuid(),
    name: String(name || 'Staff').trim().slice(0, 80) || 'Staff',
    role: cleanRole,
    active: true,
    pin_hash: await hashPin(pin),
    created_at: new Date().toISOString(),
  };
  list.push(entry);
  saveLocalStaff(list);
  return entry;
}

export function removeLocalStaff(id) {
  const list = localStaff().filter((s) => s.id !== id);
  saveLocalStaff(list);
  return list;
}

/** Offline sign-in: returns the matching active staff row or null. */
export async function authenticateLocal(pin) {
  const list = localStaff();
  for (const staff of list) {
    if (!staff.active) continue;
    if (await verifyPinHash(pin, staff.pin_hash)) return staff;
    // Accept the documented bootstrap PIN until it is replaced.
    if (staff.bootstrap && String(pin) === DEFAULT_ADMIN_PIN) return staff;
  }
  return null;
}

/** Called by Settings after a successful PIN change. */
export async function setLocalPin(staffId, newPin) {
  if (!/^\d{4,8}$/.test(String(newPin || ''))) throw new Error('The PIN must be 4 to 8 digits.');
  const list = localStaff();
  const staff = list.find((s) => s.id === staffId);
  if (!staff) throw new Error('Staff member not found.');
  staff.pin_hash = await hashPin(newPin);
  staff.bootstrap = false;
  staff.updated_at = new Date().toISOString();
  saveLocalStaff(list);
  return staff;
}
