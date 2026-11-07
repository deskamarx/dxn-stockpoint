#!/usr/bin/env node
/**
 * Break-glass PIN reset for the owner app, to be run on the server:
 *
 *   docker compose exec api node server/reset-pin.js 987654
 *
 * The old PIN is overwritten; existing sessions expire normally.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from './lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const pin = process.argv[2] || process.env.DXN_NEW_PIN || '';

if (pin.length < 4) {
  console.error('Usage: node server/reset-pin.js <new-pin>   (at least 4 characters)');
  process.exit(1);
}

const db = new Database({
  dataDir: path.join(__dirname, 'data'),
  catalogPath: path.join(ROOT, 'docs', 'products-catalog.json'),
  pin,
  adminKey: process.env.DXN_ADMIN_KEY || '',
});

db.changePin(pin);
console.log('Owner PIN updated.');
