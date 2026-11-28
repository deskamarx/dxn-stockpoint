/**
 * PV planner maths, shared by the Stockpoint PV screen and its tests.
 *
 * Prices are handled in integer paisa and PV in tenths, so the knapsack
 * grids stay deterministic even when catalogue prices have decimals.
 * Everything runs locally against the synced catalogue — no API, no account.
 */

import { num, round2 } from './util.js';

export const PV_SCALE = 10;
export const MAX_GRID = 60000;
export const MAX_GAP = 60000;

export function gcd(a, b) {
  let x = Math.abs(Math.round(num(a)));
  let y = Math.abs(Math.round(num(b)));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

/** Money -> integer paisa. Never loses fractional currency to float drift. */
const paisa = (value) => Math.max(0, Math.round(num(value) * 100));
/** PV points -> integer tenths. */
const pvUnits = (value) => Math.max(0, Math.round(num(value) * PV_SCALE));

/**
 * Turns catalogue products into binary-quantity bundles for 0/1 knapsacks.
 * A product with 13 units becomes 1, 2, 4 and 6-unit bundles, which lets the
 * planner choose any quantity up to the available stock without an unbounded
 * loop.
 */
export function buildBundles(products, { basis = 'member', categories = null, maxUnits = Infinity } = {}) {
  const cap = Math.max(1, Math.floor(num(maxUnits, Infinity)) || Infinity);
  const allowed = categories && categories.length
    ? new Set(categories.map((name) => String(name)))
    : null;
  const bundles = [];
  for (const product of products || []) {
    const category = String(product.category || 'General');
    if (allowed && !allowed.has(category)) continue;
    const price = basis === 'retail' ? num(product.retail_price) : num(product.member_price || product.retail_price);
    const cost = paisa(price);
    const pv = pvUnits(product.pv_points);
    const max = Math.min(Math.max(0, Math.floor(num(product.stock_qty))), cap);
    if (!(cost > 0 && pv > 0 && max > 0)) continue;
    let remaining = max;
    let size = 1;
    while (remaining > 0) {
      const qty = Math.min(size, remaining);
      bundles.push({
        id: product.id,
        name: product.name || product.sku || 'Product',
        category,
        qty,
        cost: cost * qty,
        pv: pv * qty,
        unitCost: cost,
        unitPv: pv,
      });
      remaining -= qty;
      size *= 2;
    }
  }
  return bundles;
}

/** Minimum spend that still reaches the PV gap. */
export function cheapestCover(bundles, gap) {
  if (!bundles.length || gap <= 0) return [];
  const width = gap + 1;
  const dp = new Float64Array(width).fill(Infinity);
  const take = new Uint8Array(bundles.length * width);
  dp[0] = 0;
  for (let k = 0; k < bundles.length; k += 1) {
    const item = bundles[k];
    for (let v = gap; v >= 1; v -= 1) {
      const need = Math.max(0, v - item.pv);
      const candidate = dp[need] + item.cost;
      if (candidate < dp[v]) {
        dp[v] = candidate;
        take[k * width + v] = 1;
      }
    }
  }
  if (!Number.isFinite(dp[gap])) return [];
  const picked = new Map();
  let cursor = gap;
  for (let k = bundles.length - 1; k >= 0; k -= 1) {
    if (!take[k * width + cursor]) continue;
    const item = bundles[k];
    picked.set(item.id, (picked.get(item.id) || 0) + item.qty);
    cursor = Math.max(0, cursor - item.pv);
  }
  return linesFromBundles(bundles, picked);
}

/** Fewest units, then cheapest, for the required PV gap. */
export function fewestItemsCover(bundles, gap) {
  if (!bundles.length || gap <= 0) return [];
  const width = gap + 1;
  const dp = new Float64Array(width).fill(Infinity);
  const take = new Uint8Array(bundles.length * width);
  dp[0] = 0;
  for (let k = 0; k < bundles.length; k += 1) {
    const item = bundles[k];
    const key = item.qty * 1e9 + item.cost;
    for (let v = gap; v >= 1; v -= 1) {
      const need = Math.max(0, v - item.pv);
      const candidate = dp[need] + key;
      if (candidate < dp[v]) {
        dp[v] = candidate;
        take[k * width + v] = 1;
      }
    }
  }
  if (!Number.isFinite(dp[gap])) return [];
  const picked = new Map();
  let cursor = gap;
  for (let k = bundles.length - 1; k >= 0; k -= 1) {
    if (!take[k * width + cursor]) continue;
    const item = bundles[k];
    picked.set(item.id, (picked.get(item.id) || 0) + item.qty);
    cursor = Math.max(0, cursor - item.pv);
  }
  return linesFromBundles(bundles, picked);
}

/** Largest PV that fits the budget. The grid is capped so a huge budget stays fast. */
export function mostPvForBudget(bundles, budget) {
  if (!bundles.length || budget <= 0) return [];
  const divisor = bundles.reduce((value, item) => gcd(value, item.cost), 0) || 1;
  const grid = Math.min(MAX_GRID, Math.floor(paisa(budget) / divisor));
  if (grid <= 0) return [];
  const dp = new Float64Array(grid + 1);
  const take = new Uint8Array(bundles.length * (grid + 1));
  for (let k = 0; k < bundles.length; k += 1) {
    const item = bundles[k];
    const weight = Math.round(item.cost / divisor);
    if (weight <= 0 || weight > grid) continue;
    for (let c = grid; c >= weight; c -= 1) {
      const candidate = dp[c - weight] + item.pv;
      if (candidate > dp[c]) {
        dp[c] = candidate;
        take[k * (grid + 1) + c] = 1;
      }
    }
  }
  let cursor = grid;
  const picked = new Map();
  for (let k = bundles.length - 1; k >= 0; k -= 1) {
    if (!take[k * (grid + 1) + cursor]) continue;
    const item = bundles[k];
    picked.set(item.id, (picked.get(item.id) || 0) + item.qty);
    cursor -= Math.round(item.cost / divisor);
    if (cursor < 0) cursor = 0;
  }
  return linesFromBundles(bundles, picked);
}

function linesFromBundles(bundles, picked) {
  const meta = new Map();
  for (const item of bundles) {
    if (!meta.has(item.id)) meta.set(item.id, item);
  }
  return [...picked.entries()].map(([id, qty]) => {
    const item = meta.get(id) || {};
    const unitCost = round2((item.unitCost || 0) / 100);
    return {
      id,
      name: item.name || 'Product',
      category: item.category || 'General',
      qty,
      unitCost,
      cost: round2(unitCost * qty),
      pv: round2((item.unitPv || 0) * qty / PV_SCALE),
    };
  }).filter((line) => line.qty > 0 && line.pv > 0).sort((a, b) => b.pv - a.pv || a.name.localeCompare(b.name));
}

function totals(lines) {
  return {
    cost: round2(lines.reduce((sum, line) => sum + num(line.cost), 0)),
    pv: round2(lines.reduce((sum, line) => sum + num(line.pv), 0)),
    units: lines.reduce((sum, line) => sum + Math.max(0, Math.floor(num(line.qty))), 0),
  };
}

function plan(title, description, lines, key) {
  return { key, title, description, lines, ...totals(lines) };
}

/**
 * Builds the three planner routes used in the UI. `current` and `target` are
 * PV points; `budget` is money in the shop currency.
 */
export function buildPlans(products, {
  current = 0,
  target = 0,
  budget = 0,
  basis = 'member',
  categories = null,
  maxUnits = Infinity,
} = {}) {
  const gap = Math.max(0, pvUnits(target) - pvUnits(current));
  const result = { gap: gap / PV_SCALE, reach: 0, plans: [], state: 'ok' };
  if (gap <= 0 || num(target) <= 0) {
    result.state = 'reached';
    return result;
  }
  if (gap > MAX_GAP * PV_SCALE) {
    result.state = 'too-large';
    return result;
  }
  const bundles = buildBundles(products, { basis, categories, maxUnits });
  result.reach = bundles.reduce((sum, item) => sum + item.pv, 0) / PV_SCALE;
  if (!bundles.length) {
    result.state = 'empty';
    return result;
  }
  if (result.reach < result.gap) {
    result.state = 'short';
    return result;
  }

  // Keep all three routes even when two algorithms pick the same basket: the
  // explanation differs, and the Suite planner has always shown all three.
  const add = (candidate) => {
    if (candidate.lines.length) result.plans.push(candidate);
  };

  add(plan('Lowest spend', 'Cheapest mix that still clears the gap.', cheapestCover(bundles, gap), 'cheapest'));
  if (num(budget) > 0) {
    add(plan('Most PV for the budget', 'Spend up to the budget and earn the most PV.', mostPvForBudget(bundles, budget), 'maxpv'));
  }
  add(plan('Fewest items', 'Fewest units to carry, then cheapest.', fewestItemsCover(bundles, gap), 'fewest'));
  return result;
}

export function planText(planResult, name = '', currency = '৳') {
  const title = planResult?.title || 'PV plan';
  const lines = Array.isArray(planResult?.lines) ? planResult.lines : [];
  const money = (value) => `${currency}${num(value).toFixed(2)}`;
  return [
    `PV plan${name ? ` for ${name}` : ''} — ${title}`,
    ...lines.map((line) => `• ${line.name} × ${line.qty} (${line.pv} PV, ${money(line.cost)})`),
    `Total: ${money(planResult.cost)} · ${planResult.pv} PV · ${planResult.units} items`,
  ].join('\n');
}
