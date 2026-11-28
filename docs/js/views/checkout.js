/**
 * Checkout: a short, deliberate flow — review, pay, confirm.
 *
 * It never calls the network. The sale is written to the outbox atomically and
 * the receipt is shown immediately; sync happens behind the user. The confirm
 * button is locked while saving and the cart carries a stable idempotency key,
 * so a double tap or a dropped connection cannot create two sales.
 */

import { esc, money, int, num, round2, digits } from '../util.js';
import { icon, openModal, closeModal, toast, emptyState, initials } from '../ui.js';
import * as store from '../store.js';
import {
  PAYMENT_METHODS, methodLabel, normalizePayments, paymentStatusLabel, quickAmounts, isCreditMethod,
} from '../payments.js';
import { openReceipt } from '../receipt.js';
import { closeCart } from './cart.js';

function methodChips(selected) {
  return PAYMENT_METHODS.filter((m) => !m.credit).map((m) => `
    <button class="pay-method ${selected === m.id ? 'is-active' : ''}" type="button" data-method="${m.id}">
      ${icon(m.icon, 18)}<span>${m.label}</span>
    </button>`).join('');
}

export function openCheckout() {
  const baseTotals = store.cartTotals();
  if (!baseTotals.lines.length) {
    toast('The cart is empty.', 'error');
    return;
  }
  const draft = {
    step: 1,
    payments: (store.state.sale.payments || []).map((p) => ({ ...p })),
    allowCredit: Boolean(store.state.sale.allow_credit),
    discount: num(store.state.sale.discount),
    note: store.state.sale.note || '',
    method: 'CASH',
    amount: '',
    reference: '',
    busy: false,
  };

  const totals = () => {
    const savedDiscount = store.state.sale.discount;
    store.state.sale.discount = draft.discount;
    const computed = store.cartTotals();
    store.state.sale.discount = savedDiscount;
    const check = normalizePayments(draft.payments, computed.total, {
      allowCredit: draft.allowCredit || Boolean(store.state.sale.customer_id) || Boolean(store.state.sale.dxn_member_id),
    });
    return { ...computed, ...check, total: computed.total };
  };

  const modal = openModal({
    title: 'Checkout',
    size: 'wide',
    body: '<div id="checkoutBody"></div>',
    footer: '<div id="checkoutFoot" class="checkout-foot"></div>',
    onMount(panel) {
      const body = panel.querySelector('#checkoutBody');
      const foot = panel.querySelector('#checkoutFoot');

      const paint = () => {
        const t = totals();
        body.innerHTML = draft.step === 1 ? reviewStep(t) : paymentStep(t, draft);
        foot.innerHTML = draft.step === 1 ? reviewFoot(t) : paymentFoot(t);
        bind(t);
      };

      const bind = (t) => {
        body.querySelectorAll('[data-step]').forEach((btn) => {
          btn.addEventListener('click', () => {
            draft.step = Number(btn.dataset.step);
            paint();
          });
        });

        body.querySelector('[data-pick-customer]')?.addEventListener('click', () => {
          openCustomerPicker((customer) => {
            store.setSaleCustomer(customer);
            paint();
          });
        });
        body.querySelector('[data-walkin]')?.addEventListener('click', () => {
          store.setSaleCustomer(null);
          paint();
        });

        const discountInput = body.querySelector('[data-discount]');
        discountInput?.addEventListener('input', () => {
          draft.discount = Math.max(0, num(discountInput.value));
        });
        discountInput?.addEventListener('change', paint);

        const noteInput = body.querySelector('[data-note]');
        noteInput?.addEventListener('input', () => { draft.note = noteInput.value; });

        body.querySelectorAll('[data-method]').forEach((btn) => {
          btn.addEventListener('click', () => {
            draft.method = btn.dataset.method;
            body.querySelectorAll('[data-method]').forEach((b) => b.classList.toggle('is-active', b === btn));
            const amount = body.querySelector('[data-amount]');
            if (amount) {
              const remaining = round2(t.total - t.paid);
              if (!amount.value || num(amount.value) === 0) amount.value = remaining > 0 ? remaining.toFixed(2) : '';
            }
          });
        });

        body.querySelectorAll('[data-quick]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const amount = body.querySelector('[data-amount]');
            if (amount) amount.value = btn.dataset.quick;
          });
        });

        body.querySelector('[data-add-payment]')?.addEventListener('click', () => {
          const amountEl = body.querySelector('[data-amount]');
          const refEl = body.querySelector('[data-reference]');
          const amount = round2(num(amountEl?.value));
          if (amount <= 0) {
            toast('Enter the amount received.', 'error');
            return;
          }
          draft.payments.push({
            method: draft.method,
            amount,
            reference: (refEl?.value || '').trim(),
          });
          draft.amount = '';
          draft.reference = '';
          paint();
        });

        body.querySelectorAll('[data-remove-payment]').forEach((btn) => {
          btn.addEventListener('click', () => {
            draft.payments.splice(Number(btn.dataset.removePayment), 1);
            paint();
          });
        });

        const credit = body.querySelector('[data-credit]');
        credit?.addEventListener('change', () => {
          draft.allowCredit = credit.checked;
          paint();
        });

        foot.querySelector('[data-next]')?.addEventListener('click', () => {
          draft.step = 2;
          paint();
        });
        foot.querySelector('[data-back]')?.addEventListener('click', () => {
          draft.step = 1;
          paint();
        });
        foot.querySelector('[data-confirm]')?.addEventListener('click', confirmSale);

        foot.querySelector('[data-clear-payments]')?.addEventListener('click', () => {
          draft.payments = [];
          paint();
        });
      };

      const confirmSale = () => {
        if (draft.busy) return;
        const t = totals();
        const paymentCheck = normalizePayments(draft.payments, t.total, {
          allowCredit: draft.allowCredit || Boolean(store.state.sale.customer_id) || Boolean(store.state.sale.dxn_member_id),
        });
        if (!paymentCheck.ok) {
          toast(paymentCheck.message, 'error');
          return;
        }
        if (paymentCheck.due > 0 && !draft.allowCredit && !store.state.sale.customer_id && !store.state.sale.dxn_member_id && !store.state.sale.customer_phone) {
          toast('Add a customer, or tick “Credit sale”, before leaving a balance due.', 'error');
          return;
        }

        draft.busy = true;
        const confirmBtn = foot.querySelector('[data-confirm]');
        if (confirmBtn) {
          confirmBtn.disabled = true;
          confirmBtn.innerHTML = '<span class="spinner"></span> Saving sale…';
        }

        store.updateSale({
          payments: paymentCheck.payments,
          discount: draft.discount,
          note: draft.note,
          allow_credit: draft.allowCredit,
          payment_method: paymentCheck.payments[0]?.method || draft.method,
        });
        const result = store.enqueueOrder();
        draft.busy = false;

        if (!result.ok) {
          toast(result.message, 'error');
          if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = `${icon('check', 17)} Confirm sale`;
          }
          return;
        }

        closeModal();
        closeCart();
        const item = store.state.outbox.find((o) => o.id === result.outboxId);
        toast(result.totals?.due > 0
          ? `Credit sale saved · ${money(result.totals.due, store.currency())} due.`
          : 'Sale saved. Receipt ready.', 'ok');
        if (item) openReceipt(item, { justSaved: true });
      };

      paint();
    },
  });
  return modal;
}

function reviewStep(t) {
  const currency = store.currency();
  const sale = store.state.sale;
  const customer = sale.customer_name
    ? `${sale.customer_name}${sale.dxn_member_id ? ` · ${sale.dxn_member_id}` : ''}`
    : 'Walk-in customer';
  return `
    <div class="checkout-steps">
      <span class="checkout-step is-active">1 · Review</span>
      <span class="checkout-step">2 · Payment</span>
      <span class="checkout-step">3 · Receipt</span>
    </div>

    <div class="checkout-customer">
      <div class="checkout-customer__main">
        <span class="eyebrow">Customer</span>
        <strong>${esc(customer)}</strong>
        <span class="checkout-customer__meta">${esc(sale.customer_phone || (sale.dxn_member_id ? 'DXN member' : 'No phone on file'))}</span>
      </div>
      <button class="btn btn--sm btn--ghost" type="button" data-pick-customer>${icon('users', 15)} Change</button>
    </div>

    <div class="checkout-lines">
      ${t.lines.map((line) => `
        <div class="checkout-line">
          <span class="checkout-line__qty">${int(line.qty)}×</span>
          <div class="checkout-line__main">
            <strong>${esc(line.product.name)}</strong>
            <span>${money(line.price, currency)} each${line.discount ? ` · −${money(line.discount, currency)}` : ''}</span>
          </div>
          <strong>${money(line.lineTotal, currency)}</strong>
        </div>`).join('')}
    </div>

    <div class="form-2">
      <label class="field"><span>Order discount (${esc(currency)})</span>
        <input class="input" data-discount type="number" min="0" step="0.01" value="${t.orderDiscount || ''}" placeholder="0.00"></label>
      <label class="field"><span>Note</span>
        <input class="input" data-note value="${esc(store.state.sale.note || '')}" placeholder="Optional" maxlength="200"></label>
    </div>

    <div class="checkout-summary">
      <div><span>Subtotal</span><strong>${money(t.subtotal + t.discount, currency)}</strong></div>
      ${t.discount > 0 ? `<div><span>Discount</span><strong>−${money(t.discount, currency)}</strong></div>` : ''}
      <div class="checkout-summary__grand"><span>Total payable</span><strong>${money(t.total, currency)}</strong></div>
      <div class="checkout-summary__muted"><span>PV</span><strong>${round2(t.pv).toFixed(2)}</strong></div>
    </div>
  `;
}

function reviewFoot(t) {
  return `
    <div class="checkout-foot__total"><span>${int(t.units)} item(s)</span><strong>${money(t.total, store.currency())}</strong></div>
    <button class="btn btn--primary" type="button" data-next>Continue to payment ${icon('arrowRight', 16)}</button>
  `;
}

function paymentStep(t, draft) {
  const currency = store.currency();
  const remaining = round2(t.total - t.paid);
  const sale = store.state.sale;
  const canCredit = Boolean(sale.customer_id || sale.dxn_member_id || sale.customer_phone);
  return `
    <div class="checkout-steps">
      <span class="checkout-step is-done">1 · Review</span>
      <span class="checkout-step is-active">2 · Payment</span>
      <span class="checkout-step">3 · Receipt</span>
    </div>

    <div class="pay-total">
      <span>Amount due</span>
      <strong>${money(t.total, currency)}</strong>
      <span class="pay-total__status badge badge--${t.status === 'PAID' ? 'ok' : t.status === 'PARTIALLY_PAID' ? 'warn' : 'muted'}">${paymentStatusLabel(t.status)}</span>
    </div>

    ${t.payments.length ? `
      <div class="pay-list">
        ${t.payments.map((p, i) => `
          <div class="pay-row">
            <span class="badge badge--info">${esc(methodLabel(p.method))}</span>
            <div class="pay-row__main">
              <strong>${money(p.amount, currency)}</strong>
              ${p.reference ? `<span>${esc(p.reference)}</span>` : ''}
            </div>
            <button class="btn btn--sm btn--ghost" type="button" data-remove-payment="${i}" aria-label="Remove payment">${icon('close', 14)}</button>
          </div>`).join('')}
      </div>` : ''}

    <div class="pay-methods">${methodChips('CASH')}</div>

    <div class="pay-entry">
      <label class="field" style="margin-bottom:0"><span>Amount received</span>
        <input class="input pay-amount" data-amount type="number" min="0" step="0.01"
          inputmode="decimal" placeholder="${remaining > 0 ? remaining.toFixed(2) : '0.00'}"
          value="${draft.amount !== '' ? esc(draft.amount) : draftValue(remaining)}"></label>
      <label class="field" style="margin-bottom:0"><span>Reference / last 4 digits</span>
        <input class="input" data-reference placeholder="Optional" maxlength="60"></label>
      <button class="btn btn--soft pay-add" type="button" data-add-payment>${icon('plus', 15)} Add</button>
    </div>

    <div class="chips pay-quick">
      ${quickAmounts(remaining > 0 ? remaining : t.total).map((amount) => `
        <button class="chip" type="button" data-quick="${amount}">${money(amount, currency)}</button>`).join('')}
    </div>

    <div class="checkout-summary">
      <div><span>Total</span><strong>${money(t.total, currency)}</strong></div>
      <div><span>Received</span><strong>${money(t.paid, currency)}</strong></div>
      ${t.due > 0 ? `<div class="checkout-summary__due"><span>Due</span><strong>${money(t.due, currency)}</strong></div>` : ''}
      ${t.change > 0 ? `<div><span>Change</span><strong>${money(t.change, currency)}</strong></div>` : ''}
      <div class="checkout-summary__grand"><span>${t.due > 0 ? 'Balance' : 'Settled'}</span><strong>${money(t.due > 0 ? t.due : t.total, currency)}</strong></div>
    </div>

    ${t.due > 0 ? `
      <label class="pay-credit ${canCredit ? '' : 'is-disabled'}">
        <input type="checkbox" data-credit ${draft.allowCredit ? 'checked' : ''} ${canCredit ? '' : 'disabled'}>
        <span>
          <strong>Credit sale — carry ${money(t.due, currency)} as due</strong>
          <small>${canCredit ? 'The balance is added to this customer’s ledger.' : 'Select a customer or enter a phone / DXN member ID first.'}</small>
        </span>
      </label>` : ''}
  `;
}

function draftValue(remaining) {
  return remaining > 0 ? remaining.toFixed(2) : '';
}

function paymentFoot(t) {
  return `
    <button class="btn btn--ghost" type="button" data-back>${icon('arrowLeft', 16)} Back</button>
    <div class="checkout-foot__total"><span>${t.due > 0 ? 'Due' : 'Paid'}</span><strong>${money(t.due > 0 ? t.due : t.paid, store.currency())}</strong></div>
    <button class="btn btn--primary" type="button" data-confirm>${icon('check', 17)} Confirm sale</button>
  `;
}

/**
 * Customer picker with DXN member lookup and inline creation. New customers
 * created offline are kept locally and pushed on the next successful order.
 */
export function openCustomerPicker(onPick) {
  openModal({
    title: 'Choose customer',
    size: 'wide',
    body: `
      <div class="search-wrap mb-2">
        <input class="input input--search" id="custSearch" type="search" autocomplete="off"
          placeholder="Name, phone or DXN member ID…">
      </div>
      <div class="row mb-2">
        <button class="btn btn--sm btn--ghost" type="button" data-walkin>${icon('user', 15)} Walk-in customer</button>
        <button class="btn btn--sm btn--primary" type="button" data-new-customer>${icon('userPlus', 15)} New customer</button>
      </div>
      <div id="custList"></div>
    `,
    footer: `<button class="btn btn--ghost" type="button" data-close>Cancel</button>`,
    onMount(panel, close) {
      const search = panel.querySelector('#custSearch');
      const list = panel.querySelector('#custList');

      const paint = () => {
        const q = search.value.trim().toLowerCase();
        const customers = store.state.customers
          .filter((c) => !q || `${c.name} ${c.phone || ''} ${c.dxn_member_id || ''}`.toLowerCase().includes(q))
          .slice(0, 40);
        list.innerHTML = customers.length ? `<div class="list">${customers.map((c) => `
          <button class="list__row list__row--button" type="button" data-customer="${esc(String(c.id))}">
            <span class="customer-avatar">${initials(c.name)}</span>
            <div class="list__main">
              <div class="list__title">${esc(c.name)} ${c.dxn_member_id ? `<span class="badge badge--info">${esc(c.dxn_member_id)}</span>` : ''}</div>
              <div class="list__sub">${esc(c.phone || 'No phone')} · ${int(c.orders_count || 0)} order(s)${num(c.outstanding) > 0 ? ` · <span style="color:var(--danger)">${money(c.outstanding, store.currency())} due</span>` : ''}</div>
            </div>
            ${icon('arrowRight', 15)}
          </button>`).join('')}</div>`
          : emptyState('No matching customer', 'Add a new customer or continue as a walk-in.', 'users');

        list.querySelectorAll('[data-customer]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const customer = store.state.customers.find((c) => String(c.id) === btn.dataset.customer);
            if (!customer) return;
            onPick(customer);
            close();
          });
        });
      };

      search.addEventListener('input', paint);
      panel.querySelector('[data-walkin]').addEventListener('click', () => {
        onPick(null);
        close();
      });
      panel.querySelector('[data-new-customer]').addEventListener('click', () => {
        openNewCustomer((customer) => {
          onPick(customer);
          close();
        });
      });
      paint();
      setTimeout(() => search.focus(), 50);
    },
  });
}

function openNewCustomer(onCreated) {
  openModal({
    title: 'New customer',
    body: `
      <label class="field"><span>Full name *</span>
        <input class="input" data-name maxlength="120" placeholder="Customer name"></label>
      <div class="form-2">
        <label class="field"><span>Phone</span>
          <input class="input" data-phone inputmode="tel" maxlength="20" placeholder="01XXXXXXXXX"></label>
        <label class="field"><span>DXN member ID</span>
          <input class="input" data-member maxlength="30" placeholder="Optional"></label>
      </div>
      <label class="field" style="margin-bottom:0"><span>Address / note</span>
        <input class="input" data-address maxlength="200" placeholder="Optional"></label>
    `,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Cancel</button>
      <button class="btn btn--primary" type="button" data-save>${icon('check', 16)} Save customer</button>
    `,
    onMount(panel, close) {
      panel.querySelector('[data-save]').addEventListener('click', async () => {
        const name = panel.querySelector('[data-name]').value.trim();
        if (!name) { toast('Enter the customer name.', 'error'); return; }
        const phone = panel.querySelector('[data-phone]').value.trim();
        const member = panel.querySelector('[data-member]').value.trim().toUpperCase();
        if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) { toast('Check the phone number.', 'error'); return; }
        const customer = {
          id: `local-${Date.now()}`,
          name,
          phone,
          dxn_member_id: member,
          address: panel.querySelector('[data-address]').value.trim(),
          is_member: member ? 1 : 0,
          created_at: new Date().toISOString(),
          local: true,
        };
        store.state.customers = [customer, ...store.state.customers];
        store.persistCache();
        await store.audit('customer.created', 'customer', customer.id, name);
        store.notify();
        toast('Customer added.', 'ok');
        close();
        onCreated(customer);
      });
    },
  });
}
