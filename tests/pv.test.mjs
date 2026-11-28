/**
 * PV planner maths. These tests use brute force on small catalogues so a
 * knapsack regression cannot silently recommend a more expensive basket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_GRID, PV_SCALE, buildBundles, buildPlans, planText,
} from '../docs/js/pv.js';

const CATALOGUE = [
  { id: 1, sku: 'A', name: 'Soap', category: 'Personal Care', retail_price: 100, member_price: 80, pv_points: 10, stock_qty: 3 },
  { id: 2, sku: 'B', name: 'Coffee', category: 'Coffee & Tea', retail_price: 150, member_price: 120, pv_points: 25, stock_qty: 2 },
  { id: 3, sku: 'C', name: 'Tea', category: 'Coffee & Tea', retail_price: 60, member_price: 50, pv_points: 5, stock_qty: 4 },
];

/** Exhaustive optimum over the same binary bundles the planner uses. */
function bruteForce(bundles, gap, budget = Infinity) {
  let bestCover = null;
  let bestFewest = null;
  let bestPv = { pv: 0, cost: 0 };
  const total = 1 << bundles.length;
  for (let mask = 0; mask < total; mask += 1) {
    let cost = 0;
    let pv = 0;
    let units = 0;
    for (let k = 0; k < bundles.length; k += 1) {
      if (!(mask & (1 << k))) continue;
      cost += bundles[k].cost;
      pv += bundles[k].pv;
      units += bundles[k].qty;
    }
    if (cost <= budget && pv > bestPv.pv) bestPv = { pv, cost };
    if (pv >= gap) {
      const cover = { cost, pv, units };
      if (!bestCover || cost < bestCover.cost) bestCover = cover;
      const fewest = { cost, pv, units };
      if (!bestFewest || units < bestFewest.units
        || (units === bestFewest.units && cost < bestFewest.cost)) bestFewest = fewest;
    }
  }
  return { cover: bestCover, fewest: bestFewest, pv: bestPv };
}

test('buildBundles: binary quantities respect stock, category, cap and price basis', () => {
  const bundles = buildBundles(CATALOGUE, { basis: 'member' });
  assert.deepEqual(bundles.filter((item) => item.id === 1).map((item) => item.qty), [1, 2]);
  assert.deepEqual(bundles.filter((item) => item.id === 3).map((item) => item.qty), [1, 2, 1]);
  assert.equal(bundles.find((item) => item.id === 2).cost, 12000);
  assert.equal(bundles.find((item) => item.id === 2).pv, 25 * PV_SCALE);

  const retail = buildBundles(CATALOGUE, { basis: 'retail' });
  assert.equal(retail.find((item) => item.id === 2).cost, 15000);

  const capped = buildBundles(CATALOGUE, { categories: ['Coffee & Tea'], maxUnits: 1 });
  assert.deepEqual([...new Set(capped.map((item) => item.id))].sort(), [2, 3]);
  assert.ok(capped.every((item) => item.qty === 1));

  const skipped = buildBundles([
    { id: 9, name: 'No price', category: 'General', retail_price: 0, member_price: 0, pv_points: 10, stock_qty: 5 },
    { id: 10, name: 'No PV', category: 'General', retail_price: 10, member_price: 10, pv_points: 0, stock_qty: 5 },
  ]);
  assert.equal(skipped.length, 0);
});

test('buildPlans: cheapest, fewest and budget plans match exhaustive optima', () => {
  const bundles = buildBundles(CATALOGUE, { basis: 'member' });
  const gap = 30 * PV_SCALE;
  const budget = 240;
  const expected = bruteForce(bundles, gap, Math.round(budget * 100));
  const result = buildPlans(CATALOGUE, { target: 30, budget, basis: 'member' });

  assert.equal(result.state, 'ok');
  assert.equal(result.gap, 30);
  assert.ok(result.plans.length >= 2);

  const cheapest = result.plans.find((plan) => plan.key === 'cheapest');
  const fewest = result.plans.find((plan) => plan.key === 'fewest');
  const maxPv = result.plans.find((plan) => plan.key === 'maxpv');

  assert.ok(cheapest.pv >= gap / PV_SCALE);
  assert.equal(Math.round(cheapest.cost * 100), expected.cover.cost);
  assert.equal(cheapest.units, expected.cover.units);

  assert.ok(fewest.pv >= gap / PV_SCALE);
  assert.equal(fewest.units, expected.fewest.units);
  assert.equal(Math.round(fewest.cost * 100), expected.fewest.cost);

  assert.ok(maxPv);
  assert.ok(maxPv.cost <= budget + 0.001);
  assert.equal(Math.round(maxPv.pv * PV_SCALE), expected.pv.pv);
});

test('buildPlans: filters and unit caps change the baskets that can be chosen', () => {
  const result = buildPlans(CATALOGUE, {
    target: 30,
    budget: 500,
    basis: 'retail',
    categories: ['Personal Care'],
    maxUnits: 1,
  });
  assert.equal(result.state, 'short', 'one soap only reaches 10 PV');
  assert.equal(result.reach, 10);
  assert.equal(result.plans.length, 0);
});

test('buildPlans: explicit empty, short, reached and oversized states', () => {
  assert.equal(buildPlans(CATALOGUE, { target: 0 }).state, 'reached');
  assert.equal(buildPlans(CATALOGUE, { current: 100, target: 30 }).state, 'reached');
  assert.equal(buildPlans([], { target: 30 }).state, 'empty');
  assert.equal(buildPlans(CATALOGUE, { target: 10000 }).state, 'short');
  assert.equal(buildPlans(CATALOGUE, { target: MAX_GRID + 1 }).state, 'too-large');
});

test('buildPlans: decimal prices and PV stay exact', () => {
  const products = [{
    id: 1, name: 'Precision', category: 'General', retail_price: 99.99,
    member_price: 88.88, pv_points: 12.3, stock_qty: 2,
  }];
  const result = buildPlans(products, { target: 24.6, budget: 200, basis: 'member' });
  assert.equal(result.state, 'ok');
  const cheapest = result.plans.find((plan) => plan.key === 'cheapest');
  assert.equal(cheapest.cost, 177.76);
  assert.equal(cheapest.pv, 24.6);
  assert.equal(cheapest.units, 2);
});

test('planText: produces a readable, currency-aware shareable plan', () => {
  const result = buildPlans(CATALOGUE, { target: 10, budget: 100, basis: 'member' });
  const text = planText(result.plans[0], 'Rahim', 'BDT ');
  assert.match(text, /PV plan for Rahim/);
  assert.match(text, /Total: BDT /);
  assert.match(text, /PV · \d+ items/);
});
