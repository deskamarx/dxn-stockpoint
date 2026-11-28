/**
 * Orders: the live history from the server, plus anything still queued on
 * this device. The detail modal is the whole order workspace — money,
 * fulfilment, returns, courier and the receipt — not just a read-only card.
 */

import { esc, money, num, int, relTime, fmtDateTime, downloadFile } from '../util.js';
import {
  icon, emptyState, openModal, closeModal, toast, statusBadge,
  confirmAction, hydrateIcons,
} from '../ui.js';
import api, { hasBase } from '../api.js';
import * as store from '../store.js';
import { PAYMENT_METHODS, methodLabel, orderBalance, paymentStatusLabel, refundable } from '../payments.js';
import { downloadXlsx } from '../xlsx.js';
import { downloadReceiptPdf, shareReceipt, printOrder, openReceipt } from '../receipt.js';

const filters = { q: '', status: 'ALL' };
const STATUSES = ['ALL', 'CONFIRMED', 'PACKED', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PAID', 'CANCELLED'];
const FULFILMENT = ['CONFIRMED', 'PACKED', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'];

function itemsSummary(order) {
  const items = order.items || [];
  if (!items.length) return '—';
  const first = items[0];
  const rest = items.length - 1;
  return rest > 0 ? `${esc(first.name)} +${rest} more` : esc(first.name);
}

function paymentBadge(order) {
  const balance = orderBalance(order);
  const label = paymentStatusLabel(balance.status);
  const kind = balance.status === 'PAID' ? 'ok' : balance.status === 'PARTIALLY_PAID' ? 'warn' : 'danger';
  return `<span class="badge badge--${kind}" title="${money(balance.paid, store.currency())} collected">${label}</span>`;
}

function tableHtml(rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Order</th><th>Customer</th><th>Items</th>
          <th style="text-align:right">Total</th><th style="text-align:right">Due</th><th style="text-align:right">PV</th>
          <th>Status</th><th>Payment</th><th></th>
        </tr></thead>
        <tbody>${rows.map(orderRow).join('')}</tbody>
      </table>
    </div>
  `;
}

function orderRow(order) {
  const currency = store.currency();
  const itemCount = (order.items || []).reduce((sum, i) => sum + num(i.quantity), 0);
  const balance = orderBalance(order);
  return `
    <tr data-order="${esc(order.id)}" style="cursor:pointer">
      <td>
        <div style="font-weight:800;font-size:12.5px">${esc(order.order_number)}</div>
        <div class="mono" style="color:var(--faint)">${relTime(order.created_at)}</div>
      </td>
      <td>
        <div style="font-weight:700;font-size:12.5px">${esc(order.customer_name)}</div>
        <div class="mono" style="color:var(--faint)">${esc(order.dxn_member_id || order.customer_phone || '—')}</div>
      </td>
      <td style="max-width:200px">
        <div style="font-size:12px">${itemsSummary(order)}</div>
        <div class="mono" style="color:var(--faint)">${int(itemCount)} unit(s)</div>
      </td>
      <td style="text-align:right;font-weight:800;white-space:nowrap">${money(order.total_amount, currency)}</td>
      <td style="text-align:right;white-space:nowrap;${balance.due > 0 ? 'color:var(--danger);font-weight:700' : 'color:var(--faint)'}">
        ${balance.due > 0 ? money(balance.due, currency) : '—'}
      </td>
      <td style="text-align:right" class="mono">${num(order.total_pv).toFixed(0)}</td>
      <td>${statusBadge(order.status)}</td>
      <td>${paymentBadge(order)}</td>
      <td>
        <div class="td-actions">
          <button class="btn btn--sm btn--ghost" type="button" data-open="${esc(order.id)}" aria-label="Open order">
            ${icon('receipt', 14)}
          </button>
        </div>
      </td>
    </tr>
  `;
}

function matches(order) {
  if (order.type === 'RETURN') return false;
  if (filters.status !== 'ALL' && order.status !== filters.status) return false;
  const q = filters.q.trim().toLowerCase();
  if (!q) return true;
  return (
    String(order.order_number || '').toLowerCase().includes(q) ||
    String(order.customer_name || '').toLowerCase().includes(q) ||
    String(order.dxn_member_id || '').toLowerCase().includes(q) ||
    String(order.customer_phone || '').toLowerCase().includes(q)
  );
}

function outboxSection() {
  const items = store.state.outbox;
  if (!items.length) return '';
  const currency = store.currency();
  const labels = { order: 'Sale', payment: 'Payment', return: 'Return', expense: 'Expense' };
  return `
    <div class="card card--pad" style="margin-bottom:18px;border-color:color-mix(in srgb, var(--warning) 35%, transparent);background:var(--warning-soft)">
      <div class="section-head" style="margin-bottom:10px">
        <div>
          <h2 style="font-size:14px">Waiting to sync (${int(items.length)})</h2>
          <p>These records live only on this device until the server accepts them.</p>
        </div>
        <button class="btn btn--sm btn--ghost" type="button" id="retryAll">${icon('refresh', 14)} Retry all</button>
      </div>
      <div class="list">
        ${items.map((item) => {
          const total = item.kind === 'order'
            ? (item.payload.items || []).reduce((sum, i) => sum + num(i.unit_price) * num(i.quantity), 0) - num(item.payload.discount)
            : num(item.payload.amount);
          return `
          <div class="list__row">
            <div class="list__main">
              <div class="list__title">${esc(labels[item.kind] || 'Record')} — ${money(total, currency)}</div>
              <div class="mono" style="color:var(--faint);font-size:11.5px">
                ${esc(item.payload.customer_name || item.payload.order_id || item.payload.category || 'Queued record')}
                · ${relTime(new Date(item.createdAt).toISOString())}
                ${item.attempts ? ` · attempt ${item.attempts}` : ''}
                ${item.error ? ` · <span style="color:var(--danger)">${esc(item.error)}</span>` : ''}
              </div>
            </div>
            <span class="badge badge--${item.status === 'failed' ? 'danger' : 'warn'}">
              ${item.status === 'failed' ? 'Rejected' : 'Queued'}
            </span>
            <button class="btn btn--sm btn--ghost" type="button" data-retry="${esc(item.id)}">Retry</button>
            <button class="btn btn--sm btn--danger" type="button" data-drop="${esc(item.id)}" aria-label="Discard">
              ${icon('trash', 14)}
            </button>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

function bindOutbox(root) {
  root.querySelector('#retryAll')?.addEventListener('click', () => {
    store.retryAll();
    toast('Retrying queued records…');
  });

  root.querySelectorAll('[data-retry]').forEach((button) => {
    button.addEventListener('click', () => {
      store.retryOutboxItem(button.dataset.retry);
      toast('Retrying…');
    });
  });

  root.querySelectorAll('[data-drop]').forEach((button) => {
    button.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: 'Discard this queued record?',
        message: 'It was never confirmed by the server, so it will not appear in any report. Stock and balances will be restored on this device.',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
      store.dropFromOutbox(button.dataset.drop);
      toast('Queued record discarded.');
    });
  });
}

export function renderOrders(root) {
  if (!store.can('orders.view')) {
    root.innerHTML = `
      <div class="card card--pad" style="max-width:520px;margin:40px auto;text-align:center">
        <div style="display:grid;place-items:center;margin-bottom:12px;color:var(--primary)">${icon('receipt', 34)}</div>
        <h2 style="font-family:var(--font-display);font-size:18px;font-weight:700;margin-bottom:6px">Order history is for the shop</h2>
        <p style="font-size:13px;color:var(--muted);margin-bottom:18px">
          Sign in with your staff PIN to review orders, collect payments and print receipts.
        </p>
        <button class="btn btn--primary btn--block" type="button" data-signin>${icon('user', 16)} Sign in with PIN</button>
      </div>
      <div id="ordersOutbox">${outboxSection()}</div>
    `;
    root.querySelector('[data-signin]')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('dxn:login'));
    });
    bindOutbox(root.querySelector('#ordersOutbox') || root);
    return;
  }

  const orders = store.state.orders.filter(matches);
  const role = store.state.role;
  const canExport = store.can('reports.export');

  root.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Orders</h2>
        <p>${int(store.state.orders.filter((o) => o.type !== 'RETURN').length)} order(s) cached · newest first · signed in as ${esc(role)}</p>
      </div>
      <div class="section-head__actions">
        <button class="btn btn--ghost" type="button" id="ordersRefresh">${icon('refresh', 16)} Refresh</button>
        ${canExport ? `<button class="btn btn--ghost" type="button" id="ordersXlsx">${icon('download', 16)} Excel</button>` : ''}
        ${canExport ? `<button class="btn btn--ghost" type="button" id="ordersExport">${icon('download', 16)} CSV</button>` : ''}
      </div>
    </div>

    ${outboxSection()}

    <div class="row mb-3">
      <div class="search-wrap">
        <input class="input input--search" id="orderSearch" type="search" autocomplete="off"
          placeholder="Order no, customer, member ID…" value="${esc(filters.q)}">
      </div>
    </div>
    <div class="chips mb-3" id="orderChips">
      ${STATUSES.map((status) => `
        <button class="chip ${filters.status === status ? 'is-active' : ''}" data-status="${status}" type="button">${status}</button>
      `).join('')}
    </div>

    <div id="ordersList">
      ${orders.length ? tableHtml(orders) : emptyState(
        store.state.orders.length ? 'No orders match' : 'No orders yet',
        store.state.orders.length ? 'Try another status or clear the search.' : 'Sales made on the web or Android land here.',
        'receipt',
      )}
    </div>
  `;

  const search = root.querySelector('#orderSearch');
  const list = root.querySelector('#ordersList');

  const paint = () => {
    const rows = store.state.orders.filter(matches);
    list.innerHTML = rows.length ? tableHtml(rows) : emptyState('No orders match', 'Try another status or clear the search.', 'receipt');
  };

  search.addEventListener('input', () => {
    filters.q = search.value;
    paint();
  });

  root.querySelectorAll('[data-status]').forEach((chip) => {
    chip.addEventListener('click', () => {
      filters.status = chip.dataset.status;
      root.querySelectorAll('[data-status]').forEach((c) => c.classList.toggle('is-active', c === chip));
      paint();
    });
  });

  root.querySelector('#ordersRefresh')?.addEventListener('click', () => {
    if (!hasBase()) {
      toast('Connect the shop server in Settings first.', 'error');
      return;
    }
    store.syncNow();
    toast('Refreshing orders…');
  });

  const exportRows = () => {
    const rows = [['Order', 'Date', 'Customer', 'Member ID', 'Items', 'Total', 'Paid', 'Due', 'Payment status', 'PV', 'Status']];
    for (const order of store.state.orders.filter((o) => o.type !== 'RETURN')) {
      const balance = orderBalance(order);
      rows.push([
        order.order_number,
        order.created_at,
        order.customer_name,
        order.dxn_member_id || '',
        (order.items || []).map((i) => `${i.name} x${i.quantity}`).join(' | '),
        num(order.total_amount).toFixed(2),
        balance.paid.toFixed(2),
        balance.due.toFixed(2),
        paymentStatusLabel(balance.status),
        num(order.total_pv).toFixed(2),
        order.status,
      ]);
    }
    return rows;
  };

  root.querySelector('#ordersExport')?.addEventListener('click', () => {
    const csv = exportRows().map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    downloadFile(`dxn-orders-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
    toast('CSV downloaded.');
  });

  root.querySelector('#ordersXlsx')?.addEventListener('click', () => {
    downloadXlsx(`dxn-orders-${new Date().toISOString().slice(0, 10)}.xlsx`, [
      { name: 'Orders', rows: exportRows(), widths: [16, 22, 22, 16, 42, 12, 12, 12, 14, 9, 16] },
    ]);
    toast('Excel workbook downloaded.', 'ok');
  });

  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-open]');
    const row = event.target.closest('[data-order]');
    const id = button?.dataset.open || row?.dataset.order || '';
    if (!id) return;
    const order = store.state.orders.find((o) => String(o.id) === String(id));
    if (order) openOrder(order);
  });

  bindOutbox(root);
}

/** Reopens the order workspace with the freshest cached row. */
function refreshOrderModal(id, fallback) {
  closeModal();
  const fresh = store.state.orders.find((o) => String(o.id) === String(id)) || fallback;
  setTimeout(() => openOrder(fresh), 240);
}

function paymentSection(order) {
  const currency = store.currency();
  const balance = orderBalance(order);
  const entries = order.payments || [];
  const refunds = order.refunds || [];
  const canPay = store.can('orders.payment');
  return `
    <div class="card card--pad mb-3" style="padding:16px">
      <div class="section-head" style="margin-bottom:8px">
        <div>
          <h2 style="font-size:13px">Money received</h2>
          <p>${money(balance.paid, currency)} collected · ${money(balance.due, currency)} due</p>
        </div>
        <span class="badge badge--${balance.status === 'PAID' ? 'ok' : balance.status === 'PARTIALLY_PAID' ? 'warn' : 'danger'}">${paymentStatusLabel(balance.status)}</span>
      </div>
      ${entries.length ? `
        <div class="list" style="margin-bottom:10px">
          ${entries.map((entry) => `
            <div class="list__row">
              <div class="list__main">
                <div class="list__title">${esc(methodLabel(entry.method))} · ${money(entry.amount, currency)}</div>
                <div class="list__sub mono">${esc(fmtDateTime(entry.paid_at || entry.created_at))}${entry.reference ? ` · ${esc(entry.reference)}` : ''}</div>
              </div>
              <span class="badge badge--ok">Received</span>
            </div>
          `).join('')}
        </div>
      ` : `<p style="font-size:12.5px;color:var(--muted);margin-bottom:10px">No split payments recorded for this sale yet.</p>`}
      ${refunds.length ? `
        <div class="list" style="margin-bottom:10px">
          ${refunds.map((refund) => `
            <div class="list__row">
              <div class="list__main">
                <div class="list__title">Refund · ${money(refund.amount, currency)}</div>
                <div class="list__sub mono">${esc(methodLabel(refund.method))} · ${esc(fmtDateTime(refund.refunded_at || refund.created_at))}</div>
              </div>
              <span class="badge badge--danger">Returned</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
      ${canPay && balance.due > 0 ? `
        <div class="form-2">
          <label class="field"><span>Amount (${esc(currency)})</span>
            <input class="input" id="payAmount" type="number" min="0.01" step="0.01" value="${balance.due.toFixed(2)}"></label>
          <label class="field"><span>Method</span>
            <select class="input" id="payMethod">
              ${PAYMENT_METHODS.filter((m) => !m.credit).map((m) => `<option value="${m.id}">${m.label}</option>`).join('')}
            </select></label>
        </div>
        <div class="form-2 mt-2">
          <label class="field"><span>Reference (optional)</span>
            <input class="input" id="payRef" maxlength="120" placeholder="TrxID / last 4 digits"></label>
          <label class="field"><span>Note (optional)</span>
            <input class="input" id="payNote" maxlength="200" placeholder="e.g. partial collection"></label>
        </div>
        <button class="btn btn--primary btn--block mt-2" type="button" id="payAdd">${icon('wallet', 16)} Record payment</button>
        <p id="payMsg" style="font-size:12px;color:var(--danger);margin-top:6px"></p>
      ` : canPay && balance.due <= 0
        ? `<p style="font-size:12.5px;color:var(--ok)">${icon('check', 14)} Fully collected. No balance remaining.</p>`
        : ''}
    </div>
  `;
}

function returnsSection(order) {
  if (!store.can('orders.return')) return '';
  const currency = store.currency();
  const refundMax = refundable(order);
  const linked = store.state.orders.filter((r) => r.type === 'RETURN' && Number(r.original_order_id) === Number(order.id));
  return `
    <details class="card card--pad mb-3" style="padding:14px">
      <summary style="cursor:pointer;font-size:13px;font-weight:700">Process a return · up to ${money(refundMax, currency)} refundable</summary>
      ${linked.length ? `
        <div class="list mt-2">
          ${linked.map((row) => `
            <div class="list__row">
              <div class="list__main">
                <div class="list__title">${esc(row.order_number)} · ${money(row.total_amount, currency)}</div>
                <div class="list__sub mono">${esc(row.reason || 'Return')} · ${relTime(row.created_at)}</div>
              </div>
              <button class="btn btn--sm btn--ghost" type="button" data-open-return="${esc(row.id)}">View</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="mt-2">
        ${(order.items || []).map((item, index) => `
          <label class="list__row" style="gap:10px;margin-bottom:6px">
            <div class="list__main">
              <div class="list__title">${esc(item.name)}</div>
              <div class="list__sub">Sold ${int(item.quantity)} · ${money(item.line_total, currency)}</div>
            </div>
            <input class="input" style="width:78px" type="number" min="0" max="${int(item.quantity)}" step="1"
              value="0" data-return-qty="${index}" aria-label="Return quantity for ${esc(item.name)}">
          </label>
        `).join('')}
        <div class="form-2 mt-2">
          <label class="field"><span>Reason</span>
            <input class="input" id="returnReason" maxlength="300" placeholder="Damaged / wrong item / customer changed mind"></label>
          <label class="field"><span>Refund method</span>
            <select class="input" id="returnMethod">
              ${PAYMENT_METHODS.filter((m) => !m.credit).map((m) => `<option value="${m.id}">${m.label}</option>`).join('')}
            </select></label>
        </div>
        <button class="btn btn--danger btn--block mt-2" type="button" id="returnAdd">${icon('arrowRight', 16)} Create return</button>
        <p id="returnMsg" style="font-size:12px;color:var(--danger);margin-top:6px"></p>
        <p style="font-size:11.5px;color:var(--faint);margin-top:6px">
          A return creates a linked reversal. The original invoice is never edited and stock goes back to the shelf.
        </p>
      </div>
    </details>
  `;
}

export function openOrder(order) {
  const currency = store.currency();
  const balance = orderBalance(order);
  const rows = (order.items || []).map((item) => `
    <tr>
      <td>${esc(item.name)}</td>
      <td style="text-align:center">${int(item.quantity)}</td>
      <td style="text-align:right">${money(item.unit_price, currency)}</td>
      <td style="text-align:right;font-weight:700">${money(item.line_total, currency)}</td>
    </tr>
  `).join('');
  const canStatus = store.can('orders.status');
  const canCourier = store.can('orders.status') && hasBase();

  openModal({
    title: `Order ${order.order_number}`,
    size: 'wide',
    body: `
      <div class="row mb-3" style="flex-wrap:wrap;gap:6px">
        ${statusBadge(order.status)}
        ${paymentBadge(order)}
        <span class="badge badge--muted">${esc(order.type === 'RETURN' ? 'Return' : 'Sale')}</span>
        <span class="badge badge--muted">${order.is_member ? 'Member price' : 'Retail price'}</span>
        <span style="font-size:12px;color:var(--muted)">${esc(fmtDateTime(order.created_at))}</span>
      </div>

      <div class="card card--pad mb-3" style="padding:16px">
        <div class="list mb-2">
          <div class="list__row"><div class="list__main">
            <div class="list__title">${esc(order.customer_name)}</div>
            <div class="list__sub">${esc(order.customer_phone || 'no phone')} ${order.dxn_member_id ? `· ${esc(order.dxn_member_id)}` : ''}</div>
          </div></div>
        </div>
        <div class="table-wrap">
          <table style="min-width:0">
            <thead><tr><th>Item</th><th style="text-align:center">Qty</th>
              <th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4">No line items stored.</td></tr>'}</tbody>
          </table>
        </div>
        <div class="totals mt-3">
          <div class="totals__row"><span>Subtotal</span><strong>${money(order.subtotal, currency)}</strong></div>
          ${num(order.discount) > 0 ? `<div class="totals__row"><span>Discount</span><strong>-${money(order.discount, currency)}</strong></div>` : ''}
          <div class="totals__row totals__row--grand"><span>Total</span><strong>${money(order.total_amount, currency)}</strong></div>
          <div class="totals__row"><span>Collected</span><strong>${money(balance.paid, currency)}</strong></div>
          <div class="totals__row"><span>Due</span><strong style="${balance.due > 0 ? 'color:var(--danger)' : ''}">${money(balance.due, currency)}</strong></div>
          <div class="totals__row"><span>PV</span><strong>${num(order.total_pv).toFixed(2)}</strong></div>
        </div>
      </div>

      ${order.note ? `<p style="font-size:13px;color:var(--muted);margin-bottom:12px">Note: ${esc(order.note)}</p>` : ''}

      ${paymentSection(order)}
      ${returnsSection(order)}

      ${canStatus ? `
        <p class="eyebrow mb-1">Fulfilment status</p>
        <div class="chips mb-3" id="statusChips">
          ${FULFILMENT.map((status) => `
            <button class="chip ${order.status === status ? 'is-active' : ''}" data-set-status="${status}" type="button">${status}</button>
          `).join('')}
        </div>
      ` : ''}

      ${canCourier ? `
        <div class="card card--pad mb-3" style="padding:16px">
          <div class="section-head" style="margin-bottom:8px">
            <div><h2 style="font-size:13px">SteadFast courier</h2></div>
            ${order.courier_consignment_id
              ? `<span class="badge badge--ok">Shipped</span>`
              : `<span class="badge badge--muted">Not shipped</span>`}
          </div>
          ${order.courier_consignment_id ? `
            <div class="list">
              <div class="list__row">
                <div class="list__main">
                  <div class="list__title">Consignment ${esc(order.courier_consignment_id)}</div>
                  <div class="list__sub">Tracking: <span class="mono">${esc(order.courier_tracking_code || '—')} · ${esc(order.courier_status || 'in_review')}</span></div>
                </div>
                <button class="btn btn--sm btn--ghost" type="button" data-sf-refresh>${icon('refresh', 14)} Refresh</button>
              </div>
            </div>
          ` : `
            <p style="font-size:12.5px;color:var(--muted);margin-bottom:10px">
              Create a SteadFast shipment for this order. Customer phone and an address are required.
            </p>
            <label class="field"><span>Recipient address</span>
              <input class="input" data-sf-address placeholder="House 17, Road 3, Dhanmondi, Dhaka 1209" maxlength="250"></label>
            <div class="form-2">
              <label class="field"><span>COD amount (${esc(currency)})</span>
                <input class="input" data-sf-cod type="number" min="0" step="1" value="${num(order.total_amount)}"></label>
              <label class="field"><span>Item description</span>
                <input class="input" data-sf-desc maxlength="250" placeholder="DXN products"></label>
            </div>
            <button class="btn btn--primary btn--block" type="button" data-sf-ship style="margin-top:10px">
              ${icon('truck', 16)} Ship via SteadFast
            </button>
          `}
          <div data-sf-msg style="margin-top:8px;font-size:12.5px"></div>
        </div>
      ` : ''}

      <details class="mb-3">
        <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:var(--muted)">Order timeline</summary>
        <div id="orderTimeline" style="margin-top:10px;font-size:12.5px;color:var(--muted)">Loading…</div>
      </details>

      <details>
        <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:var(--muted)">Text receipt</summary>
        <pre class="receipt" id="orderTextReceipt" style="margin-top:10px">Loading…</pre>
      </details>
    `,
    footer: `
      <button class="btn btn--ghost" type="button" data-close>Close</button>
      <button class="btn btn--ghost" type="button" data-order-pdf>${icon('download', 16)} PDF</button>
      <button class="btn btn--ghost" type="button" data-order-share>${icon('share', 16)} Share</button>
      <button class="btn btn--ghost" type="button" data-order-print>${icon('print', 16)} Print</button>
      <button class="btn btn--wa" type="button" data-order-wa>${icon('whatsapp', 16)} WhatsApp</button>
    `,
    onMount(panel) {
      hydrateIcons(panel);

      // Receipt text is derived locally so it works with no server at all.
      const textReceipt = panel.querySelector('#orderTextReceipt');
      if (textReceipt) textReceipt.textContent = requireTextReceipt(order);

      // Timeline is server-backed; cached orders still show their creation.
      const timeline = panel.querySelector('#orderTimeline');
      const paintTimeline = (entries) => {
        if (!timeline) return;
        if (!entries.length) {
          timeline.textContent = 'No events recorded yet.';
          return;
        }
        timeline.innerHTML = `<div class="list">${entries.map((entry) => `
          <div class="list__row">
            <div class="list__main">
              <div class="list__title">${esc(entry.label || entry.action || entry.type || 'Event')}</div>
              <div class="list__sub">${esc(entry.detail || entry.note || '')}</div>
            </div>
            <span class="mono" style="font-size:11px;color:var(--faint)">${esc(fmtDateTime(entry.at || entry.created_at))}</span>
          </div>
        `).join('')}</div>`;
      };
      const fallbackTimeline = [
        { label: 'Sale created', detail: `${order.items?.length || 0} line(s)`, at: order.created_at },
        ...(order.updated_at && order.updated_at !== order.created_at ? [{ label: 'Last updated', at: order.updated_at }] : []),
        ...(order.payments || []).map((p) => ({ label: `Payment · ${methodLabel(p.method)}`, detail: money(p.amount, currency), at: p.paid_at })),
        ...(order.refunds || []).map((p) => ({ label: 'Refund', detail: money(p.amount, currency), at: p.refunded_at })),
      ];
      paintTimeline(fallbackTimeline);
      if (hasBase()) {
        api.orderTimeline(order.id).then((result) => {
          if (Array.isArray(result?.timeline) && result.timeline.length) paintTimeline(result.timeline);
        }).catch(() => { /* the local timeline stays visible offline */ });
      }

      panel.querySelectorAll('[data-set-status]').forEach((chip) => {
        chip.addEventListener('click', async () => {
          const status = chip.dataset.setStatus;
          if (status === order.status) return;
          if (!hasBase()) {
            toast('Connect the shop server to change order status.', 'error');
            return;
          }
          chip.disabled = true;
          try {
            const result = await api.setOrderStatus(order.id, status);
            if (result?.order) store.upsertOrders([result.order]);
            toast(`Order marked ${status}.`, 'ok');
            refreshOrderModal(order.id, order);
          } catch (error) {
            toast(error.message || 'Could not change the status.', 'error');
            chip.disabled = false;
          }
        });
      });

      panel.querySelector('#payAdd')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const amount = num(panel.querySelector('#payAmount')?.value, 0);
        const method = panel.querySelector('#payMethod')?.value || 'CASH';
        const reference = panel.querySelector('#payRef')?.value || '';
        const note = panel.querySelector('#payNote')?.value || '';
        const msg = panel.querySelector('#payMsg');
        if (msg) msg.textContent = '';
        if (!(amount > 0)) {
          if (msg) msg.textContent = 'Enter an amount greater than zero.';
          return;
        }
        button.disabled = true;
        try {
          const result = await store.recordPayment(order.id, { amount, method, reference, note });
          if (!result.ok) {
            if (msg) msg.textContent = result.message;
            button.disabled = false;
            return;
          }
          toast(result.queued ? 'Payment saved offline — it will sync soon.' : 'Payment recorded.', 'ok');
          refreshOrderModal(order.id, order);
        } catch (error) {
          if (msg) msg.textContent = error.message;
          button.disabled = false;
        }
      });

      panel.querySelector('#returnAdd')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const items = (order.items || []).map((item, index) => ({
          product_id: item.product_id,
          quantity: num(panel.querySelector(`[data-return-qty="${index}"]`)?.value, 0),
        })).filter((row) => row.quantity > 0);
        const reason = panel.querySelector('#returnReason')?.value || '';
        const refundMethod = panel.querySelector('#returnMethod')?.value || 'CASH';
        const msg = panel.querySelector('#returnMsg');
        if (msg) msg.textContent = '';
        if (!items.length) {
          if (msg) msg.textContent = 'Choose at least one item to return.';
          return;
        }
        const confirmed = await confirmAction({
          title: 'Process this return?',
          message: 'A linked return order will be created, stock restored and the refund capped at the money actually collected.',
          confirmLabel: 'Process return',
          danger: true,
        });
        if (!confirmed) return;
        button.disabled = true;
        try {
          const result = await store.processReturn(order.id, { items, reason, refundMethod });
          if (!result.ok) {
            if (msg) msg.textContent = result.message;
            button.disabled = false;
            return;
          }
          toast(result.queued ? 'Return saved offline — it will sync soon.' : 'Return recorded.', 'ok');
          refreshOrderModal(order.id, order);
        } catch (error) {
          if (msg) msg.textContent = error.message;
          button.disabled = false;
        }
      });

      panel.querySelectorAll('[data-open-return]').forEach((button) => {
        button.addEventListener('click', () => {
          const row = store.state.orders.find((o) => String(o.id) === String(button.dataset.openReturn));
          if (row) refreshOrderModal(row.id, row);
        });
      });

      const sfMsg = panel.querySelector('[data-sf-msg]');
      panel.querySelector('[data-sf-ship]')?.addEventListener('click', async (event) => {
        const btn = event.currentTarget;
        const address = panel.querySelector('[data-sf-address]')?.value.trim() || '';
        const cod = num(panel.querySelector('[data-sf-cod]')?.value, order.total_amount);
        const desc = panel.querySelector('[data-sf-desc]')?.value.trim() || '';
        if (!address) { toast('Recipient address is required.', 'error'); return; }
        if (!hasBase()) { toast('Connect the shop server first.', 'error'); return; }
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Shipping…';
        try {
          const result = await api.shipOrder(order.id, { recipient_address: address, cod_amount: cod, item_description: desc });
          if (result?.order) store.upsertOrders([result.order]);
          toast('Shipment created with SteadFast.', 'ok');
          refreshOrderModal(order.id, order);
        } catch (error) {
          if (sfMsg) sfMsg.innerHTML = `<span style="color:var(--danger)">${esc(error.message || 'Could not create shipment.')}</span>`;
          toast(error.message || 'Could not create shipment.', 'error');
          btn.disabled = false;
          btn.innerHTML = `${icon('truck', 16)} Ship via SteadFast`;
        }
      });

      panel.querySelector('[data-sf-refresh]')?.addEventListener('click', async (event) => {
        const btn = event.currentTarget;
        btn.disabled = true;
        try {
          const result = await api.courierStatus(order.id);
          if (result?.order) store.upsertOrders([result.order]);
          toast(`Status: ${result.courier_status}`, 'ok');
          refreshOrderModal(order.id, order);
        } catch (error) {
          toast(error.message || 'Could not refresh status.', 'error');
          btn.disabled = false;
        }
      });

      panel.querySelector('[data-order-pdf]')?.addEventListener('click', () => {
        downloadReceiptPdf(order);
        toast('PDF downloaded.', 'ok');
      });
      panel.querySelector('[data-order-share]')?.addEventListener('click', async () => {
        const result = await shareReceipt(order);
        if (result.cancelled) return;
        toast(result.via === 'download' ? 'PDF downloaded — share it from your files.' : 'Receipt shared.', 'ok');
      });
      panel.querySelector('[data-order-print]')?.addEventListener('click', () => printOrder(order));
      panel.querySelector('[data-order-wa]')?.addEventListener('click', () => {
        closeModal();
        setTimeout(() => openReceipt(order), 240);
      });
    },
  });
}

/** Local text receipt without importing ui.receiptText (kept for old orders). */
function requireTextReceipt(order) {
  const settings = store.state.settings;
  const lines = [];
  lines.push(String(settings.branch_name || 'Mohammadpur Stock Point').toUpperCase());
  lines.push('-'.repeat(32));
  lines.push(`Order   : ${order.order_number || ''}`);
  lines.push(`Date    : ${fmtDateTime(order.created_at)}`);
  lines.push(`Customer: ${order.customer_name || 'Walk-in customer'}`);
  lines.push('-'.repeat(32));
  for (const item of order.items || []) {
    lines.push(`${String(item.name).slice(0, 22)} x${item.quantity}  ${money(item.line_total, store.currency())}`);
  }
  lines.push('-'.repeat(32));
  lines.push(`TOTAL   : ${money(order.total_amount, store.currency())}`);
  lines.push(`PAID    : ${money(orderBalance(order).paid, store.currency())}`);
  lines.push(`DUE     : ${money(orderBalance(order).due, store.currency())}`);
  if (settings.receipt_footer) lines.push(settings.receipt_footer);
  return lines.join('\n');
}
