/**
 * Cart: the sticky POS panel and the topbar drawer share one renderer.
 *
 * Checkout never talks to the network directly — the sale goes to the outbox,
 * which survives a refresh and retries until the server confirms it.
 */

import { esc, money, round2, digits, int, num } from '../util.js';
import { icon, emptyState, openModal, toast, waLink } from '../ui.js';
import * as store from '../store.js';
import { methodLabel } from '../payments.js';
import { openCheckout, openCustomerPicker } from './checkout.js';
import { openReceipt } from '../receipt.js';

// ── Rendering ───────────────────────────────────────────────────────────────

function lineRow(line) {
  const currency = store.currency();
  const atMax = line.qty >= line.available;
  const photo = store.imageFor(line.product);
  return `
    <div class="cart-row" data-line="${line.productId}">
      ${photo ? `<img class="cart-row__thumb" src="${esc(photo)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
      <div class="cart-row__main">
        <div class="cart-row__name">${esc(line.product.name)}</div>
        <div class="cart-row__meta">${money(line.price, currency)} each · ${line.linePv ? `${round2(line.linePv).toFixed(0)} PV` : 'no PV'}</div>
        ${line.discount ? `<button class="cart-row__discount" type="button" data-line-discount="${line.productId}">Discount −${money(line.discount, currency)}</button>` : ''}
      </div>
      <div class="stepper">
        <button type="button" data-dec="${line.productId}" aria-label="Decrease">${icon('minus', 14)}</button>
        <span>${int(line.qty)}</span>
        <button type="button" data-inc="${line.productId}" aria-label="Increase" ${atMax ? 'disabled' : ''}>${icon('plus', 14)}</button>
      </div>
      <div class="cart-row__end">
        <div class="cart-row__total">${money(line.lineTotal, currency)}</div>
        <div class="cart-row__tools">
          <button type="button" data-line-discount="${line.productId}" aria-label="Discount this line">${icon('tag', 13)}</button>
          <button type="button" data-remove="${line.productId}" aria-label="Remove">${icon('trash', 13)}</button>
        </div>
      </div>
    </div>
  `;
}

function customerCard() {
  const sale = store.state.sale;
  const named = Boolean(sale.customer_name);
  return `
    <button class="cart-customer" type="button" data-pick-customer>
      <span class="cart-customer__icon">${icon('user', 18)}</span>
      <span class="cart-customer__main">
        <strong>${esc(named ? sale.customer_name : 'Walk-in customer')}</strong>
        <small>${esc(sale.dxn_member_id || sale.customer_phone || 'Tap to choose a customer or DXN member')}</small>
      </span>
      ${icon('chevronRight', 16)}
    </button>
  `;
}

function bodyMarkup(totals) {
  const currency = store.currency();
  return `
    ${totals.lines.map(lineRow).join('')}
    ${customerCard()}
    <div class="cart-totals">
      <div class="cart-totals__row"><span>${int(totals.units)} item(s)</span><strong>${money(totals.subtotal + totals.discount, currency)}</strong></div>
      ${totals.discount > 0 ? `<div class="cart-totals__row cart-totals__row--discount"><span>Discount</span><strong>−${money(totals.discount, currency)}</strong></div>` : ''}
      <div class="cart-totals__row cart-totals__row--grand"><span>Total</span><strong>${money(totals.total, currency)}</strong></div>
      ${totals.paid > 0 ? `<div class="cart-totals__row"><span>Received</span><strong>${money(totals.paid, currency)}</strong></div>` : ''}
      ${totals.due > 0 ? `<div class="cart-totals__row cart-totals__row--due"><span>Due</span><strong>${money(totals.due, currency)}</strong></div>` : ''}
      ${totals.change > 0 ? `<div class="cart-totals__row"><span>Change</span><strong>${money(totals.change, currency)}</strong></div>` : ''}
      <div class="cart-totals__row cart-totals__row--pv"><span>PV points</span><strong>${round2(totals.pv).toFixed(2)}</strong></div>
    </div>
    ${totals.payments.length ? `<div class="cart-payments">${totals.payments.map((p) => `<span class="badge badge--info">${esc(methodLabel(p.method))} ${money(p.amount, currency)}</span>`).join('')}</div>` : ''}
    <div class="cart-tier">
      <span>Price tier</span>
      <div class="segmented">
        <button type="button" class="${store.state.tier === 'retail' ? 'is-active' : ''}" data-tier="retail">Retail</button>
        <button type="button" class="${store.state.tier === 'member' ? 'is-active' : ''}" data-tier="member">Member</button>
      </div>
    </div>
  `;
}

function footMarkup(totals) {
  const currency = store.currency();
  return `
    <button class="btn btn--primary btn--block cart-charge" type="button" data-checkout>
      ${icon('check', 17)} Charge ${money(totals.total, currency)}
    </button>
    <div class="cart-foot-tools">
      <button class="btn btn--ghost" type="button" data-hold>${icon('clock', 16)} Hold</button>
      <button class="btn btn--ghost" type="button" data-held>${icon('list', 16)} Held${store.state.held.length ? ` (${store.state.held.length})` : ''}</button>
      <button class="btn btn--ghost" type="button" data-quote>${icon('whatsapp', 16)} Quote</button>
      <button class="btn btn--ghost" type="button" data-clear>${icon('trash', 16)} Clear</button>
    </div>
  `;
}

/** Fills one cart body+foot pair (used by the drawer and the POS panel). */
export function renderCartInto(body, foot) {
  if (!body || !foot) return;
  const totals = store.cartTotals();

  if (!totals.lines.length) {
    body.innerHTML = emptyState('The cart is empty', 'Tap any product to start a sale. Search or scan a SKU above.', 'cart');
    foot.innerHTML = `
      <button class="btn btn--ghost btn--block" type="button" data-close-cart>Keep browsing</button>
      ${store.state.held.length
        ? `<button class="btn btn--soft btn--block" type="button" data-held>${icon('clock', 16)} Resume a held sale (${store.state.held.length})</button>`
        : ''}
    `;
    foot.querySelector('[data-held]')?.addEventListener('click', openHeldSales);
    foot.querySelector('[data-close-cart]')?.addEventListener('click', () => closeCart());
    return;
  }

  body.innerHTML = bodyMarkup(totals);
  foot.innerHTML = footMarkup(totals);
  bindBody(body);
  bindFoot(foot);
}

export function renderCartDrawer() {
  renderCartInto(document.getElementById('cartBody'), document.getElementById('cartFoot'));
}

/** Renders the sticky cart panel used by the POS screen. */
export function renderCartPanel(host) {
  if (!host) return;
  host.innerHTML = `
    <div class="cart-panel" data-cart-panel>
      <div class="cart-panel__head">
        <div>
          <span class="eyebrow">Current sale · ${store.state.tier === 'member' ? 'member' : 'retail'} price</span>
          <h3>Your cart</h3>
        </div>
        <span class="badge badge--muted">${int(store.cartCount())} unit(s)</span>
      </div>
      <div class="cart-panel__body" data-cart-body></div>
      <div class="cart-panel__foot" data-cart-foot></div>
    </div>
  `;
  renderCartInto(host.querySelector('[data-cart-body]'), host.querySelector('[data-cart-foot]'));
}

// ── Binding ─────────────────────────────────────────────────────────────────

function bindBody(body) {
  body.querySelectorAll('[data-inc]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.inc);
      const result = store.addToCart(id, 1);
      if (!result.ok) toast(result.message, 'error');
    });
  });

  body.querySelectorAll('[data-dec]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.dec);
      const line = store.state.cart.find((l) => Number(l.productId) === id);
      if (line) store.setQty(id, line.qty - 1);
    });
  });

  body.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', () => store.removeFromCart(Number(button.dataset.remove)));
  });

  body.querySelectorAll('[data-line-discount]').forEach((button) => {
    button.addEventListener('click', () => openLineDiscount(Number(button.dataset.lineDiscount)));
  });

  body.querySelector('[data-pick-customer]')?.addEventListener('click', () => {
    openCustomerPicker((customer) => {
      store.setSaleCustomer(customer);
      toast(customer ? `${customer.name} selected.` : 'Walk-in customer.');
    });
  });

  body.querySelectorAll('[data-tier]').forEach((button) => {
    button.addEventListener('click', () => {
      store.setTier(button.dataset.tier);
      toast(button.dataset.tier === 'member' ? 'Member pricing active.' : 'Retail pricing active.');
    });
  });
}

function bindFoot(foot) {
  foot.querySelector('[data-checkout]')?.addEventListener('click', () => openCheckout());
  foot.querySelector('[data-clear]')?.addEventListener('click', () => {
    store.clearCart();
    toast('Cart cleared.');
  });
  foot.querySelector('[data-hold]')?.addEventListener('click', () => openHoldPrompt());
  foot.querySelector('[data-held]')?.addEventListener('click', () => openHeldSales());
  foot.querySelector('[data-quote]')?.addEventListener('click', () => {
    const totals = store.cartTotals();
    if (!totals.lines.length) return;
    const currency = store.currency();
    const lines = [
      `*${store.state.settings.branch_name || 'Mohammadpur Stock Point'}* — quotation`,
      '',
      ...totals.lines.map((l) => `• ${l.product.name} × ${int(l.qty)} — ${money(l.lineTotal, currency)}`),
      '',
      `*Total: ${money(totals.total, currency)}*`,
      `PV: ${round2(totals.pv).toFixed(2)}`,
    ];
    window.open(waLink(store.state.settings.whatsapp_number, lines.join('\n')), '_blank', 'noopener');
  });
}

function openLineDiscount(productId) {
  const line = store.cartLines().find((l) => Number(l.productId) === Number(productId));
  if (!line) return;
  const currency = store.currency();
  openModal({
    title: `Discount · ${line.product.name}`,
    body: `
      <p style="font-size:13px;color:var(--muted);margin-bottom:12px">
        Line value <strong>${money(line.lineGross, currency)}</strong>. The discount is capped at the line value.
      </p>
      <div class="row">
        <label class="field" style="margin-bottom:0"><span>Discount (${esc(currency)})</span>
          <input class="input" id="lineDiscountInput" type="number" min="0" step="0.01" max="${line.lineGross}" value="${line.discount || ''}" placeholder="0.00"></label>
        <label class="field" style="margin-bottom:0"><span>Quick</span>
          <select class="select" id="lineDiscountPct">
            <option value="">Choose…</option>
            <option value="5">5%</option><option value="10">10%</option><option value="15">15%</option><option value="20">20%</option>
          </select></label>
      </div>
    `,
    footer: `
      <button class="btn btn--ghost" type="button" data-clear-discount>Remove discount</button>
      <button class="btn btn--primary" type="button" data-save-discount>Apply</button>
    `,
    onMount(panel, close) {
      const input = panel.querySelector('#lineDiscountInput');
      panel.querySelector('#lineDiscountPct').addEventListener('change', (event) => {
        const pct = num(event.target.value);
        if (pct > 0) input.value = (line.lineGross * pct / 100).toFixed(2);
      });
      panel.querySelector('[data-clear-discount]').addEventListener('click', () => {
        store.setLineDiscount(productId, 0);
        close();
      });
      panel.querySelector('[data-save-discount]').addEventListener('click', () => {
        store.setLineDiscount(productId, num(input.value));
        close();
        toast('Line discount applied.', 'ok');
      });
    },
  });
}

// ── Hold / resume ───────────────────────────────────────────────────────────

function openHoldPrompt() {
  if (!store.state.cart.length) {
    toast('The cart is empty.', 'error');
    return;
  }
  const totals = store.cartTotals();
  openModal({
    title: 'Hold this sale',
    body: `
      <p style="font-size:13.5px;color:var(--muted);line-height:1.65">
        Park ${int(totals.units)} item(s) worth <strong>${money(totals.total, store.currency())}</strong> and free the
        till for the next customer. You can resume it any time from <strong>Held sales</strong>.
      </p>
      <label class="field mt-2" style="margin-bottom:0"><span>Name this held sale (optional)</span>
        <input class="input" data-hold-label placeholder="e.g. Rahim — couple packs" maxlength="60"></label>
    `,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-hold-go>${icon('clock', 16)} Hold sale</button>
    `,
    onMount(panel, close) {
      panel.querySelector('[data-hold-go]')?.addEventListener('click', () => {
        const label = panel.querySelector('[data-hold-label]')?.value || '';
        const result = store.holdSale(label);
        if (!result.ok) {
          toast(result.message, 'error');
          return;
        }
        close();
        toast('Sale parked — the cart is free again.', 'ok');
      });
    },
  });
}

export function openHeldSales() {
  const held = store.state.held;
  const currency = store.currency();
  openModal({
    title: `Held sales (${held.length})`,
    body: held.length ? `
      <div class="list">
        ${held.map((item) => `
          <div class="list__row">
            <div class="list__main">
              <div class="list__title">${esc(item.label)}</div>
              <div class="list__sub">
                ${int((item.cart || []).reduce((sum, l) => sum + l.qty, 0))} item(s) ·
                ${money(item.totals?.total ?? 0, currency)} ·
                ${new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
            <button class="btn btn--sm btn--primary" type="button" data-resume="${esc(item.id)}">Resume</button>
            <button class="btn btn--sm btn--ghost" type="button" data-drop-held="${esc(item.id)}" aria-label="Discard">
              ${icon('trash', 14)}
            </button>
          </div>
        `).join('')}
      </div>
    ` : emptyState('Nothing parked', 'Use Hold in the cart to park a sale mid-transaction.', 'clock'),
    footer: `<button class="btn btn--ghost" type="button" data-close>Close</button>`,
    onMount(panel, close) {
      panel.querySelectorAll('[data-resume]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const result = store.resumeHeld(btn.dataset.resume);
          if (!result.ok) {
            toast(result.message, 'error');
            return;
          }
          close();
          toast('Sale restored to the cart.', 'ok');
        });
      });
      panel.querySelectorAll('[data-drop-held]').forEach((btn) => {
        btn.addEventListener('click', () => {
          store.deleteHeld(btn.dataset.dropHeld);
          toast('Held sale discarded.');
          close();
          setTimeout(openHeldSales, 60);
        });
      });
    },
  });
}

/** Kept for callers that still open a slip from the outbox. */
export function openSaleSlip(item) {
  if (!item) return;
  openReceipt(item, { justSaved: true });
}

// ── Drawer plumbing ─────────────────────────────────────────────────────────

export function openCart() {
  const drawer = document.getElementById('cartDrawer');
  const overlay = document.getElementById('overlay');
  if (!drawer) return;
  renderCartDrawer();
  drawer.classList.add('is-open');
  drawer.setAttribute('aria-hidden', 'false');
  if (overlay) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('is-open'));
  }
  document.body.style.overflow = 'hidden';
}

export function closeCart() {
  const drawer = document.getElementById('cartDrawer');
  const overlay = document.getElementById('overlay');
  if (!drawer) return;
  drawer.classList.remove('is-open');
  drawer.setAttribute('aria-hidden', 'true');
  if (overlay && !drawer.classList.contains('is-open')) {
    overlay.classList.remove('is-open');
    setTimeout(() => { overlay.hidden = true; }, 220);
  }
  document.body.style.overflow = '';
}

export function isCartOpen() {
  return document.getElementById('cartDrawer')?.classList.contains('is-open') || false;
}
