/**
 * PV Planner inside Stockpoint. The Suite taught us the maths; this screen
 * reads the same synced catalogue the POS uses, so stock, prices and PV are
 * always current and the whole flow works offline.
 */

import { esc, int, money, num } from '../util.js';
import { icon, toast, openModal } from '../ui.js';
import { hasBase } from '../api.js';
import * as store from '../store.js';
import { buildPlans, planText } from '../pv.js';

const LEVEL_KEY = 'dxn-pv-levels';
const DEFAULT_LEVELS = [
  { name: 'Level 1', value: 3000 },
  { name: 'Level 2', value: 6000 },
  { name: 'Level 3', value: 10000 },
];

function loadLevels() {
  try {
    const saved = JSON.parse(localStorage.getItem(LEVEL_KEY) || 'null');
    if (Array.isArray(saved) && saved.length) {
      return saved.map((row) => ({ name: String(row.name || row.n || 'Level'), value: num(row.value ?? row.v) }));
    }
  } catch { /* keep defaults */ }
  return DEFAULT_LEVELS.map((row) => ({ ...row }));
}

const config = {
  name: '',
  current: 0,
  target: 6000,
  budget: 20000,
  basis: 'member',
  maxUnits: '',
  categories: null,
  levels: loadLevels(),
};

let lastCandidates = [];
let lastResult = null;
let timer = 0;

function saveLevels() {
  try { localStorage.setItem(LEVEL_KEY, JSON.stringify(config.levels)); } catch { /* storage may be disabled */ }
}

function eligibleProducts() {
  return store.activeProducts().filter((product) => num(product.pv_points) > 0);
}

function categoriesFor(products) {
  return [...new Set(products.map((p) => String(p.category || 'General')))].sort((a, b) => a.localeCompare(b));
}

function selectedCategories(available) {
  if (config.categories === null || !config.categories.length) return available.slice();
  return config.categories.filter((name) => available.includes(name));
}

function statusLine() {
  return hasBase()
    ? `Synced catalogue · revision ${int(store.state.rev)}`
    : 'Local catalogue · works offline';
}

export function renderPv(root) {
  const products = eligibleProducts();
  const available = categoriesFor(products);
  if (config.categories === null) config.categories = available.slice();

  root.innerHTML = `
    <div class="section-head">
      <div>
        <h2>PV Planner</h2>
        <p>Close the gap to the next level with the cheapest, highest-PV or smallest basket that is actually in stock.</p>
      </div>
      <div class="section-head__actions">
        <span class="badge badge--accent">${icon('sparkles', 13)} ${statusLine()}</span>
        <button class="btn btn--ghost" type="button" id="pvRefresh">${icon('refresh', 16)} Refresh stock</button>
      </div>
    </div>

    <div class="pv-layout">
      <section class="card card--pad pv-controls" aria-label="Planner inputs">
        <div class="pv-controls__head">
          <span class="eyebrow">Month-end target</span>
          <h3>Build the right basket</h3>
        </div>

        <label class="field"><span>Member name (optional)</span>
          <input class="input" id="pvName" type="text" autocomplete="off" placeholder="e.g. Rahim Uddin" value="${esc(config.name)}">
        </label>

        <div class="pv-field-row">
          <label class="field"><span>PV earned so far</span>
            <input class="input" id="pvCurrent" type="number" min="0" inputmode="decimal" value="${num(config.current)}"></label>
          <label class="field"><span>Target PV</span>
            <input class="input" id="pvTarget" type="number" min="0" inputmode="decimal" value="${num(config.target)}"></label>
        </div>

        <label class="field"><span>Budget (${esc(store.currency())})</span>
          <input class="input" id="pvBudget" type="number" min="0" inputmode="decimal" value="${num(config.budget)}"></label>

        <div class="field"><span>Price this member pays</span>
          <div class="chips pv-chips" id="pvBasis">
            <button class="chip ${config.basis === 'member' ? 'is-active' : ''}" type="button" data-basis="member">Member DP</button>
            <button class="chip ${config.basis === 'retail' ? 'is-active' : ''}" type="button" data-basis="retail">Retail MRP</button>
          </div>
        </div>

        <label class="field"><span>Most units of one product</span>
          <input class="input" id="pvMaxUnits" type="number" min="1" inputmode="numeric" placeholder="No limit — stock only" value="${esc(config.maxUnits)}">
          <small>Leave empty to use every available unit.</small>
        </label>

        <div class="field"><span>Product groups to include</span>
          <div class="chips pv-chips" id="pvCategories">
            ${available.length ? available.map((name) => `
              <button class="chip ${selectedCategories(available).includes(name) ? 'is-active' : ''}" type="button" data-category="${esc(name)}">${esc(name)}</button>
            `).join('') : '<span class="pv-note">No PV products in the catalogue yet.</span>'}
          </div>
        </div>

        <div class="pv-levels">
          <div class="pv-levels__head"><span>Level targets</span><small>Saved on this device</small></div>
          ${config.levels.map((level, index) => `
            <div class="pv-level-row">
              <input class="input" aria-label="Level ${index + 1} name" data-level-name="${index}" value="${esc(level.name)}">
              <input class="input" type="number" min="0" aria-label="Level ${index + 1} PV" data-level-value="${index}" value="${num(level.value)}">
              <button class="btn btn--sm btn--ghost" type="button" data-level-use="${index}">Use</button>
            </div>
          `).join('')}
        </div>
      </section>

      <section class="pv-results" id="pvResults" aria-live="polite"></section>
    </div>
  `;

  bind(root);
  calculate(root);
}

function bind(root) {
  if (root.dataset.pvBound === '1') return;
  root.dataset.pvBound = '1';

  root.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id === 'pvName') config.name = target.value;
    else if (target.id === 'pvCurrent') config.current = num(target.value);
    else if (target.id === 'pvTarget') config.target = num(target.value);
    else if (target.id === 'pvBudget') config.budget = num(target.value);
    else if (target.id === 'pvMaxUnits') config.maxUnits = target.value;
    else if (target.dataset.levelName != null) config.levels[Number(target.dataset.levelName)].name = target.value;
    else if (target.dataset.levelValue != null) {
      config.levels[Number(target.dataset.levelValue)].value = num(target.value);
      saveLevels();
    } else return;
    schedule(root);
  });

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.id === 'pvRefresh') {
      if (hasBase()) {
        store.syncNow({ quiet: true });
        toast('Refreshing the catalogue…');
      } else {
        toast('Already using the offline catalogue.', 'info');
      }
      return;
    }
    if (button.dataset.basis) {
      config.basis = button.dataset.basis === 'retail' ? 'retail' : 'member';
      root.querySelectorAll('[data-basis]').forEach((chip) => chip.classList.toggle('is-active', chip === button));
      calculate(root);
      return;
    }
    if (button.dataset.category) {
      const available = categoriesFor(eligibleProducts());
      const selected = selectedCategories(available);
      const name = button.dataset.category;
      if (selected.length === available.length) config.categories = available.filter((item) => item !== name);
      else if (selected.includes(name)) config.categories = selected.filter((item) => item !== name);
      else config.categories = [...selected, name];
      root.querySelectorAll('[data-category]').forEach((chip) => {
        chip.classList.toggle('is-active', selectedCategories(available).includes(chip.dataset.category));
      });
      calculate(root);
      return;
    }
    if (button.dataset.levelUse != null) {
      const level = config.levels[Number(button.dataset.levelUse)];
      if (!level) return;
      config.target = num(level.value);
      const input = root.querySelector('#pvTarget');
      if (input) input.value = String(config.target);
      calculate(root);
      return;
    }
    if (button.dataset.pvAdd != null) {
      confirmAdd(root, Number(button.dataset.pvAdd));
      return;
    }
    if (button.dataset.pvCopy != null) {
      const candidate = lastResult?.plans[Number(button.dataset.pvCopy)];
      if (!candidate) return;
      const text = planText(candidate, config.name, store.currency());
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(
          () => toast('PV plan copied.', 'ok'),
          () => toast('Copy is not available here.', 'error'),
        );
      } else {
        toast('Copy is not available here.', 'error');
      }
    }
  });
}

function schedule(root) {
  clearTimeout(timer);
  timer = setTimeout(() => calculate(root), 120);
}

function calculate(root) {
  const out = root.querySelector('#pvResults');
  if (!out) return;
  const products = eligibleProducts();
  const result = buildPlans(products, {
    current: config.current,
    target: config.target,
    budget: config.budget,
    basis: config.basis,
    categories: selectedCategories(categoriesFor(products)),
    maxUnits: config.maxUnits === '' ? Infinity : num(config.maxUnits),
  });
  lastResult = result;
  lastCandidates = result.plans;
  out.innerHTML = resultHtml(result, products.length);
}

function resultHtml(result, productCount) {
  const currency = store.currency();
  const target = num(config.target);
  const current = num(config.current);
  const progress = target > 0 ? Math.min(100, Math.max(0, current / target * 100)) : 0;
  const who = config.name.trim();
  const headline = result.gap <= 0
    ? 'Target reached — nothing more to buy.'
    : `${who ? `${esc(who)} needs` : 'You need'} ${int(result.gap)} more PV`;
  let html = `
    <div class="pv-hero card card--pad">
      <span class="eyebrow">Your position</span>
      <h3>${headline}</h3>
      <p>${int(current)} of ${int(target)} PV · ${productCount} PV products in stock</p>
      <div class="pv-progress" role="progressbar" aria-valuenow="${Math.round(progress)}" aria-valuemin="0" aria-valuemax="100">
        <i style="width:${progress}%"></i>
      </div>
    </div>
  `;

  if (!productCount) {
    return html + empty('No PV products yet', 'Add products with PV points, or sync the catalogue, before building a plan.');
  }
  if (result.state === 'reached') return html + empty('You are already there', 'Lower the target or add PV earned since your last order.');
  if (result.state === 'too-large') {
    return html + empty('Gap is too large for one basket', 'Split the target across two months, or lower it to 60,000 PV.');
  }
  if (result.state === 'empty') {
    return html + empty('Nothing matches these filters', 'Turn on more product groups or clear the unit limit.');
  }
  if (result.state === 'short') {
    return html + `
      <div class="card card--pad pv-message">
        <span class="badge badge--warn">${icon('alert', 13)} Stock shortfall</span>
        <h3>Stock cannot cover this gap</h3>
        <p>Everything available right now adds up to <strong>${int(result.reach)} PV</strong>. Restock, widen the product groups, or lower the target.</p>
      </div>`;
  }

  html += `<div class="pv-plans">${result.plans.map((plan, index) => {
    const reached = plan.pv >= result.gap - 0.05;
    const over = plan.cost > num(config.budget);
    const badge = over
      ? ['danger', `Over budget by ${money(plan.cost - num(config.budget), currency)}`]
      : reached
        ? ['ok', plan.pv - result.gap > 0.05 ? `Reaches target · +${int(plan.pv - result.gap)} PV` : 'Reaches target']
        : ['warn', `Short by ${int(result.gap - plan.pv)} PV`];
    return `
      <article class="card card--pad pv-plan">
        <div class="pv-plan__head">
          <div><h3>${esc(plan.title)}</h3><p>${esc(plan.description)}</p></div>
          <span class="badge badge--${badge[0]}">${esc(badge[1])}</span>
        </div>
        <div class="pv-plan__lines">
          ${plan.lines.map((line) => `
            <div class="pv-line">
              <span>${esc(line.name)}<small>${line.qty} × ${money(line.unitCost, currency)}</small></span>
              <strong>${int(line.pv)} PV</strong>
            </div>
          `).join('')}
        </div>
        <div class="pv-plan__sum">
          <div><span>Spend</span><strong>${money(plan.cost, currency)}</strong></div>
          <div><span>PV</span><strong>${int(plan.pv)}</strong></div>
          <div><span>Units</span><strong>${int(plan.units)}</strong></div>
        </div>
        <div class="pv-plan__actions">
          <button class="btn btn--primary btn--sm" type="button" data-pv-add="${index}">${icon('cart', 15)} Add to cart</button>
          <button class="btn btn--ghost btn--sm" type="button" data-pv-copy="${index}">${icon('copy', 15)} Copy</button>
        </div>
      </article>`;
  }).join('')}</div>`;
  return html;
}

function empty(title, message) {
  return `<div class="empty"><div class="empty__icon">${icon('sparkles', 44)}</div><h3>${esc(title)}</h3><p>${esc(message)}</p></div>`;
}

function confirmAdd(root, index) {
  const plan = lastCandidates[index];
  if (!plan) return;
  const currency = store.currency();
  openModal({
    title: 'Add this PV plan to the cart?',
    body: `
      <p style="font-size:13px;color:var(--muted)">This replaces the current cart so the plan can be checked out as one sale.</p>
      <div class="list" style="margin-top:12px">
        ${plan.lines.map((line) => `
          <div class="list__row">
            <div class="list__main"><div class="list__title">${esc(line.name)} × ${line.qty}</div>
              <div class="list__sub">${int(line.pv)} PV · ${money(line.cost, currency)}</div></div>
          </div>`).join('')}
        <div class="list__row"><div class="list__main"><div class="list__title">Total</div></div>
          <span class="badge badge--accent">${money(plan.cost, currency)}</span></div>
      </div>
    `,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-pv-confirm="${index}">${icon('cart', 16)} Replace cart</button>
    `,
    onMount(panel, close) {
      panel.querySelector('[data-pv-confirm]')?.addEventListener('click', () => {
        close();
        store.clearCart();
        store.setTier(config.basis);
        let added = 0;
        const problems = [];
        plan.lines.forEach((line) => {
          const result = store.addToCart(line.id, line.qty);
          if (result.ok) added += 1;
          else problems.push(result.message);
        });
        if (config.name.trim()) store.updateSale({ customer_name: config.name.trim() });
        if (added) {
          toast(`PV plan added — ${added} line${added === 1 ? '' : 's'} in the cart.`, 'ok');
          location.hash = '#/pos';
        } else {
          toast(problems[0] || 'The catalogue is still loading.', 'error');
        }
      });
    },
  });
}
