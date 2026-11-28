/**
 * Sell — the primary POS surface.
 *
 * Built for speed: search or scan at the top, recently/frequently sold one tap
 * away, a dense product grid, and a cart that never leaves the screen on
 * desktop (a bottom sheet on phones). Adding a product updates the cart
 * immediately; the cart panel keeps its own quantity steppers.
 */

import { esc, money, int, num, round2, toDate } from '../util.js';
import { icon, emptyState, openModal, toast, stockBadge, hydrateIcons } from '../ui.js';
import * as store from '../store.js';
import { renderCartPanel, openHeldSales, openCart } from './cart.js';

const filters = { q: '', category: 'ALL', tab: 'all' };
let bound = false;

export function openProductView(product) {
  const currency = store.currency();
  const photo = store.imageFor(product);
  const inCart = store.state.cart.find((l) => Number(l.productId) === Number(product.id));
  return openModal({
    title: product.name,
    body: `
      <div class="product-view">
        <div class="product-view__media">
          ${photo
            ? `<img src="${esc(photo)}" alt="${esc(product.name)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'product__placeholder',innerHTML:'<img src=&quot;icons/logo-mark-96.png&quot; alt=&quot;&quot;><span>DXN product</span>'}))">`
            : `<div class="product__placeholder"><img src="icons/logo-mark-96.png" alt=""><span>DXN product</span></div>`}
        </div>
        <div class="product-view__meta">
          <div>
            <div class="product-view__name">${esc(product.name)}</div>
            <div class="product-view__sku">${esc(product.sku)} · ${esc(product.category || 'General')}</div>
          </div>
          <p class="product-view__desc">${esc(product.description || 'No description recorded for this product yet.')}</p>
          <div class="product-view__prices">
            <div class="product-view__price"><span>Retail</span><strong>${money(product.retail_price, currency)}</strong></div>
            <div class="product-view__price"><span>Member</span><strong>${money(product.member_price, currency)}</strong></div>
            <div class="product-view__price"><span>PV points</span><strong>${num(product.pv_points).toFixed(0)}</strong></div>
          </div>
          <div class="product__stock">${stockBadge(product)}<span style="margin-left:6px">${num(product.stock_qty) > 0 ? `${int(product.stock_qty)} unit(s) on the shelf` : 'Out of stock'}</span></div>
          ${store.state.tier === 'member' ? `<p class="kicker">Member pricing is active in the cart</p>` : ''}
          ${inCart ? `<p class="kicker">${int(inCart.qty)} already in the cart</p>` : ''}
        </div>
      </div>
      <div class="row mt-3" style="align-items:flex-end">
        <label class="field" style="margin-bottom:0;max-width:140px"><span>Quantity</span>
          <input class="input pvQty" type="number" min="1" step="1" value="${inCart ? int(inCart.qty) : 1}"></label>
        <button class="btn btn--primary pvAdd" type="button" ${num(product.stock_qty) <= 0 ? 'disabled' : ''}>
          ${icon('cart', 16)} ${inCart ? 'Update cart' : 'Add to cart'}
        </button>
      </div>
    `,
    footer: `<button class="btn btn--ghost" type="button" data-close>Close</button>`,
    onMount(panel, close) {
      panel.querySelector('.pvAdd')?.addEventListener('click', () => {
        const qty = Math.max(1, Math.round(num(panel.querySelector('.pvQty').value, 1)));
        store.setQty(product.id, qty);
        toast(`${product.name} × ${qty} in the cart.`, 'ok');
        close();
      });
    },
  });
}

function cartQty(productId) {
  return num(store.state.cart.find((line) => Number(line.productId) === Number(productId))?.qty);
}

function productCard(product) {
  const currency = store.currency();
  const tier = store.state.tier;
  const out = num(product.stock_qty) <= 0;
  const level = store.stockLevel(product);
  const photo = store.imageFor(product);
  const mainPrice = tier === 'member' ? product.member_price : product.retail_price;
  const altPrice = tier === 'member' ? product.retail_price : product.member_price;
  const qty = cartQty(product.id);
  return `
    <article class="product ${out ? 'is-out' : ''} ${qty ? 'is-in-cart' : ''}" data-id="${product.id}">
      <button class="product__media" type="button" data-quickview="${product.id}" aria-label="View ${esc(product.name)}">
        ${photo
          ? `<img class="product__img" src="${esc(photo)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
          : `<div class="product__placeholder"><img src="icons/logo-mark-96.png" alt=""><span>DXN product</span></div>`}
        <span class="product__cat">${esc(product.category || 'General')}</span>
        ${qty ? `<span class="product__incart">${int(qty)} in cart</span>` : ''}
        ${out ? `<span class="product__out">Out</span>` : ''}
      </button>
      <div class="product__body">
        <div class="product__name">${esc(product.name)}</div>
        <div class="product__sku">${esc(product.sku)}</div>
        <div class="product__stock"><span class="stock-dot ${level === 'ok' ? '' : level}"></span>
          ${out ? 'Out of stock' : level === 'low' ? `Only ${int(product.stock_qty)} left` : `${int(product.stock_qty)} in stock`}
        </div>
        <div class="product__foot">
          <div class="price">${money(mainPrice, currency)}${tier === 'retail' && num(altPrice) ? `<small>member ${money(altPrice, currency)}</small>` : ''}</div>
          ${qty ? `
            <div class="stepper stepper--sm">
              <button type="button" data-dec="${product.id}" aria-label="Remove one">${icon('minus', 13)}</button>
              <span>${int(qty)}</span>
              <button type="button" data-inc="${product.id}" aria-label="Add one" ${qty >= num(product.stock_qty) ? 'disabled' : ''}>${icon('plus', 13)}</button>
            </div>` : `
            <button class="btn btn--sm btn--primary product__add" type="button" data-add="${product.id}" ${out ? 'disabled' : ''}>
              ${icon('plus', 15)} Add
            </button>`}
        </div>
      </div>
    </article>
  `;
}

function quickCard(product) {
  const photo = store.imageFor(product);
  return `
    <button class="quick-product" type="button" data-add="${product.id}" ${num(product.stock_qty) <= 0 ? 'disabled' : ''}>
      <span class="quick-product__media">${photo ? `<img src="${esc(photo)}" alt="" loading="lazy">` : icon('box', 18)}</span>
      <span class="quick-product__main">
        <strong>${esc(product.name)}</strong>
        <small>${money(store.unitPrice(product), store.currency())}</small>
      </span>
      ${icon('plus', 14)}
    </button>
  `;
}

function matches(product) {
  if (filters.category !== 'ALL' && product.category !== filters.category) return false;
  const q = filters.q.trim().toLowerCase();
  if (!q) return true;
  return `${product.name} ${product.sku} ${product.category} ${product.description || ''}`.toLowerCase().includes(q);
}

function todayStats() {
  const today = new Date().toISOString().slice(0, 10);
  const orders = store.state.orders.filter((o) => String(o.created_at || '').slice(0, 10) === today && o.status !== 'CANCELLED');
  const revenue = orders.reduce((sum, o) => sum + num(o.total_amount), 0);
  return { count: orders.length, revenue };
}

export function renderPos(root) {
  const products = store.activeProducts();
  const categories = store.categories();
  const heldCount = store.state.held.length;
  const stats = todayStats();
  const recent = store.recentProducts(6);
  const frequent = store.frequentProducts(6);

  root.innerHTML = `
    <section class="sell">
      <div class="sell__main">
        <div class="sell__head">
          <div>
            <h2>Sell</h2>
            <p><span id="posCount">${int(products.length)}</span> products · ${int(stats.count)} sale(s) today · ${money(stats.revenue, store.currency())}</p>
          </div>
          <div class="sell__head-actions">
            <div class="segmented" id="posTier">
              <button type="button" class="${store.state.tier === 'retail' ? 'is-active' : ''}" data-tier="retail">Retail</button>
              <button type="button" class="${store.state.tier === 'member' ? 'is-active' : ''}" data-tier="member">Member</button>
            </div>
            <button class="btn btn--ghost btn--sm" type="button" data-held>${icon('clock', 15)} Held${heldCount ? ` (${heldCount})` : ''}</button>
          </div>
        </div>

        <div class="sell__search">
          <div class="search-wrap">
            <input class="input input--search" id="posSearch" type="search" autocomplete="off" enterkeyhint="go"
              placeholder="Search name, SKU or scan a barcode…">
          </div>
          <button class="btn btn--ghost sell__scan" type="button" id="posScan" title="Focus the scanner input">${icon('scan', 17)}</button>
          <button class="btn btn--ghost sell__scan" type="button" id="posClear" title="Clear search">${icon('close', 17)}</button>
        </div>

        ${(recent.length || frequent.length) ? `
          <div class="sell__quick" id="posQuick">
            ${recent.length ? `<div class="sell__quick-group"><span class="eyebrow">Recent</span><div class="quick-row">${recent.map(quickCard).join('')}</div></div>` : ''}
            ${frequent.length ? `<div class="sell__quick-group"><span class="eyebrow">Frequent</span><div class="quick-row">${frequent.map(quickCard).join('')}</div></div>` : ''}
          </div>` : ''}

        <div class="chips sell__cats" id="posCats">
          <button class="chip ${filters.category === 'ALL' ? 'is-active' : ''}" data-cat="ALL" type="button">All</button>
          ${categories.map((c) => `<button class="chip ${filters.category === c ? 'is-active' : ''}" data-cat="${esc(c)}" type="button">${esc(c)}</button>`).join('')}
        </div>

        ${products.length ? `<div class="product-grid" id="posGrid"></div>`
          : emptyState('No active products', 'Add products from Inventory to start selling.', 'box')}
      </div>

      <aside class="sell__cart" data-cart-panel></aside>
    </section>

    <button class="sell-mobilebar" type="button" id="posMobileCart">
      <span class="sell-mobilebar__count">${icon('cart', 18)} ${int(store.cartCount())}</span>
      <span class="sell-mobilebar__total">${money(store.cartTotals().total, store.currency())}</span>
      <span class="sell-mobilebar__go">View cart ${icon('chevronRight', 15)}</span>
    </button>
  `;

  renderCartPanel(root.querySelector('[data-cart-panel]'));

  const grid = root.querySelector('#posGrid');
  const quick = root.querySelector('#posQuick');
  const countEl = root.querySelector('#posCount');
  const mobileBar = root.querySelector('#posMobileCart');
  const search = root.querySelector('#posSearch');

  const paint = () => {
    const list = products.filter(matches);
    if (countEl) countEl.textContent = String(list.length);
    if (!grid) return;
    grid.innerHTML = list.length
      ? list.map(productCard).join('')
      : emptyState('Nothing matches', 'Try a different search term or category.', 'search');
    if (mobileBar) {
      const count = store.cartCount();
      mobileBar.classList.toggle('is-visible', count > 0);
      const total = mobileBar.querySelector('.sell-mobilebar__total');
      if (total) total.textContent = money(store.cartTotals().total, store.currency());
      const badge = mobileBar.querySelector('.sell-mobilebar__count');
      if (badge) badge.innerHTML = `${icon('cart', 18)} ${int(count)}`;
    }
  };

  paint();

  // Delegated add/stepper/quick-view handling survives every repaint.
  const onClick = (event) => {
    const target = event.target.closest('[data-add], [data-inc], [data-dec], [data-quickview]');
    if (!target) return;
    const id = Number(target.dataset.add || target.dataset.inc || target.dataset.dec || target.dataset.quickview);
    const product = store.productById(id);
    if (!product) return;
    if (target.dataset.quickview) {
      openProductView(product);
      return;
    }
    if (target.dataset.dec) {
      const line = store.state.cart.find((l) => Number(l.productId) === id);
      if (line) store.setQty(id, line.qty - 1);
      return;
    }
    const result = store.addToCart(id, 1);
    if (!result.ok) toast(result.message, 'error');
    else if (target.dataset.add) toast(`${product.name} added.`, 'ok');
  };
  grid?.addEventListener('click', onClick);
  quick?.addEventListener('click', onClick);

  // barcode / bulk-entry: exact SKU or unique name match jumps into the cart
  search?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const q = filters.q.trim().toLowerCase();
    if (!q) return;
    const exact = products.find((p) => String(p.sku).toLowerCase() === q);
    const byName = products.find((p) => String(p.name).toLowerCase() === q);
    const partial = products.filter(matches);
    const hit = exact || byName || (partial.length === 1 ? partial[0] : null);
    if (!hit) {
      toast('No exact product match. Keep typing or tap a result.', 'error');
      return;
    }
    if (num(hit.stock_qty) <= 0) {
      toast(`${hit.name} is out of stock.`, 'error');
      return;
    }
    const result = store.addToCart(hit.id, 1);
    if (!result.ok) {
      toast(result.message, 'error');
      return;
    }
    search.value = '';
    filters.q = '';
    paint();
    toast(`${hit.name} added to the cart.`, 'ok');
    search.focus();
  });

  search?.addEventListener('input', () => {
    filters.q = search.value;
    paint();
  });

  root.querySelector('#posScan')?.addEventListener('click', () => {
    search?.focus();
    search?.select();
  });
  root.querySelector('#posClear')?.addEventListener('click', () => {
    if (search) search.value = '';
    filters.q = '';
    paint();
    search?.focus();
  });

  root.querySelectorAll('[data-cat]').forEach((chip) => {
    chip.addEventListener('click', () => {
      filters.category = chip.dataset.cat;
      root.querySelectorAll('[data-cat]').forEach((c) => c.classList.toggle('is-active', c === chip));
      paint();
    });
  });

  root.querySelectorAll('#posTier [data-tier]').forEach((chip) => {
    chip.addEventListener('click', () => {
      store.setTier(chip.dataset.tier);
      root.querySelectorAll('#posTier [data-tier]').forEach((c) => c.classList.toggle('is-active', c === chip));
      toast(chip.dataset.tier === 'member' ? 'Member pricing active.' : 'Retail pricing active.');
    });
  });

  root.querySelectorAll('.sell__head-actions [data-held]').forEach((btn) => {
    btn.addEventListener('click', openHeldSales);
  });

  mobileBar?.addEventListener('click', () => openCart());
}

// Quick-view deep link from the global search palette.
window.addEventListener('dxn:open-product', (event) => {
  const id = Number(event.detail);
  const product = store.productById(id);
  if (product) openProductView(product);
});
