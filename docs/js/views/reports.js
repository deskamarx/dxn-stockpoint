/**
 * Reports: sales analytics, payment ledger, expenses, P&L and cash
 * reconciliation, computed from the synced on-device database. Every export
 * is generated locally — PDF, XLSX and CSV work with no network at all.
 */

import { esc, money, int, num, round2, compact, downloadFile, toDate, fmtDateTime } from '../util.js';
import { icon, emptyState, toast } from '../ui.js';
import api, { hasBase } from '../api.js';
import * as store from '../store.js';
import { methodLabel, paymentStatusLabel, orderBalance } from '../payments.js';
import { buildPdf, downloadPdf } from '../pdf.js';
import { downloadXlsx } from '../xlsx.js';

let rangeDays = 7;

const RANGES = [
  ['7d', 7, '7 days'],
  ['30d', 30, '30 days'],
  ['90d', 90, '90 days'],
  ['all', -1, 'All time'],
];

export function renderReports(root) {
  if (!store.can('reports.view')) {
    root.innerHTML = `
      <div class="card card--pad" style="max-width:520px;margin:40px auto;text-align:center">
        <div style="display:grid;place-items:center;margin-bottom:12px;color:var(--primary)">${icon('chart', 34)}</div>
        <h2 style="font-family:var(--font-display);font-size:18px;font-weight:700;margin-bottom:6px">Reports are for the shop</h2>
        <p style="font-size:13px;color:var(--muted);margin-bottom:18px">
          Sign in with a staff PIN to view revenue, payments, expenses and margins.
        </p>
        <button class="btn btn--primary btn--block" type="button" data-signin>${icon('user', 16)} Sign in with PIN</button>
      </div>
    `;
    root.querySelector('[data-signin]')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('dxn:login'));
    });
    return;
  }

  const canExport = store.can('reports.export');
  const canExpense = store.can('expenses.edit');

  root.innerHTML = `
    <div class="section-head">
      <div>
        <h2>Reports</h2>
        <p>Computed on this device from the synced order and expense history.</p>
      </div>
      <div class="section-head__actions">
        <button class="btn btn--ghost" type="button" id="repRefresh">${icon('refresh', 16)} Refresh</button>
        ${canExport ? `
          <button class="btn btn--ghost" type="button" id="repPdf">${icon('download', 16)} PDF</button>
          <button class="btn btn--ghost" type="button" id="repXlsx">${icon('download', 16)} Excel</button>
          <button class="btn btn--ghost" type="button" id="repExport">${icon('download', 16)} CSV</button>
        ` : ''}
      </div>
    </div>

    <div class="chips mb-3" id="repRanges">
      ${RANGES.map(([key, days, label]) => `
        <button class="chip ${rangeDays === days ? 'is-active' : ''}" data-range="${days}" type="button">${label}</button>
      `).join('')}
    </div>

    <div id="repBody"></div>
  `;

  const body = root.querySelector('#repBody');
  const paint = () => { body.innerHTML = bodyHtml(); bindExpenses(body); };
  paint();

  root.querySelectorAll('[data-range]').forEach((chip) => {
    chip.addEventListener('click', () => {
      rangeDays = Number(chip.dataset.range);
      root.querySelectorAll('[data-range]').forEach((c) => c.classList.toggle('is-active', c === chip));
      paint();
    });
  });

  root.querySelector('#repRefresh')?.addEventListener('click', () => {
    if (!hasBase()) {
      toast('Connect the shop server in Settings, or use the local data already on this device.', 'warn');
      return;
    }
    store.syncNow({ quiet: true });
    toast('Refreshing reports…');
  });

  root.querySelector('#repExport')?.addEventListener('click', () => exportCsv());
  root.querySelector('#repXlsx')?.addEventListener('click', () => exportXlsx());
  root.querySelector('#repPdf')?.addEventListener('click', () => exportPdf());
}

function inRange(value) {
  if (rangeDays < 0) return true;
  const date = toDate(value);
  if (!date) return false;
  return (Date.now() - date.getTime()) <= rangeDays * 86400000;
}

function selectedOrders() {
  return store.state.orders.filter((o) => {
    if (o.type === 'RETURN' || o.status === 'CANCELLED') return false;
    return inRange(o.created_at);
  });
}

function selectedExpenses() {
  return store.state.expenses.filter((e) => inRange(e.spent_at || e.created_at));
}

function analyse() {
  const orders = selectedOrders();
  const currency = store.currency();
  const revenue = orders.reduce((sum, o) => sum + num(o.total_amount), 0);
  const pv = orders.reduce((sum, o) => sum + num(o.total_pv), 0);
  const due = orders.reduce((sum, o) => sum + orderBalance(o).due, 0);
  const collected = orders.reduce((sum, o) => sum + orderBalance(o).paid, 0);

  const productMap = new Map();
  const methodMap = new Map();
  let cost = 0;
  let costKnown = false;
  let refunds = 0;

  for (const order of orders) {
    for (const item of order.items || []) {
      const key = item.product_sku || item.product_id || item.name;
      const row = productMap.get(key) || { name: item.name, sku: item.product_sku || '', qty: 0, revenue: 0, pv: 0, cost: 0 };
      row.qty += num(item.quantity);
      row.revenue += num(item.line_total ?? num(item.unit_price) * num(item.quantity));
      row.pv += num(item.unit_pv || 0) * num(item.quantity);
      const unitCost = item.cost_price ?? store.productById(item.product_id)?.cost_price;
      if (unitCost !== undefined && unitCost !== null) {
        costKnown = true;
        row.cost += num(unitCost) * num(item.quantity);
        cost += num(unitCost) * num(item.quantity);
      }
      productMap.set(key, row);
    }
    for (const entry of order.payments || []) {
      const key = methodLabel(entry.method);
      methodMap.set(key, num(methodMap.get(key) || 0) + num(entry.amount));
    }
    for (const entry of order.refunds || []) refunds += Math.abs(num(entry.amount));
  }

  const topProducts = [...productMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8);
  const payments = [...methodMap.entries()].sort((a, b) => b[1] - a[1]);
  const expenses = selectedExpenses();
  const expenseTotal = expenses.reduce((sum, e) => sum + num(e.amount), 0);
  const buckets = rangeDays > 0 ? buildDayBuckets(orders, rangeDays) : buildMonthBuckets(orders);
  const maxRevenue = Math.max(...buckets.map((b) => b.revenue), 1);

  return {
    currency, orders, revenue, pv, due, collected, refunds,
    cost, costKnown, gross: costKnown ? round2(revenue - cost) : null,
    expenses, expenseTotal, net: costKnown ? round2(revenue - cost - expenseTotal) : null,
    topProducts, payments, buckets, maxRevenue,
    avg: orders.length ? revenue / orders.length : 0,
    units: orders.reduce((sum, o) => sum + (o.items || []).reduce((s, i) => s + num(i.quantity), 0), 0),
  };
}

function bodyHtml() {
  const a = analyse();
  const c = a.currency;
  return `
    <div class="stat-grid mb-4">
      <div class="stat-card">
        <div class="stat-card__label">Revenue</div>
        <div class="stat-card__value stat-card--primary">${money(a.revenue, c)}</div>
        <div class="stat-card__hint">${int(a.orders.length)} order(s) in range</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">Collected</div>
        <div class="stat-card__value">${money(a.collected, c)}</div>
        <div class="stat-card__hint">${money(a.due, c)} still due</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">PV generated</div>
        <div class="stat-card__value stat-card--accent">${round2(a.pv).toFixed(0)}</div>
        <div class="stat-card__hint">Members earn PV on every sale</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">Expenses</div>
        <div class="stat-card__value">${money(a.expenseTotal, c)}</div>
        <div class="stat-card__hint">${int(a.expenses.length)} entry(ies)</div>
      </div>
    </div>

    <div class="card chart-card mb-4">
      <div class="section-head" style="margin-bottom:6px">
        <div><h2 style="font-size:16px">Revenue over time</h2><p>Hover a bar for the exact total.</p></div>
      </div>
      ${a.orders.length ? `
        <div class="chart" style="height:150px">
          ${a.buckets.map((bucket) => {
            const heightPct = Math.round((bucket.revenue / a.maxRevenue) * 100);
            return `
              <div class="chart__col">
                <div class="chart__val">${bucket.revenue > 0 ? compact(bucket.revenue) : ''}</div>
                <div class="chart__bar" data-tip="${bucket.label}: ${money(bucket.revenue, c)}"
                  style="height:${Math.max(2, heightPct)}%"></div>
                <div class="chart__day">${bucket.short}</div>
              </div>
            `;
          }).join('')}
        </div>` : emptyState('No sales in this range', 'Change the range above, or sell something first.', 'chart')}
    </div>

    <div class="split mb-4">
      <div class="card card--pad">
        <div class="section-head" style="margin-bottom:10px">
          <div><h2 style="font-size:16px">Bestsellers</h2><p>Ranked by revenue.</p></div>
        </div>
        ${a.topProducts.length ? `
          <div class="table-wrap">
            <table style="min-width:0">
              <thead><tr><th>Product</th><th style="text-align:right">Qty</th>
                <th style="text-align:right">Revenue</th><th style="text-align:right">PV</th></tr></thead>
              <tbody>
                ${a.topProducts.map((p) => `
                  <tr>
                    <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</td>
                    <td style="text-align:right">${int(p.qty)}</td>
                    <td style="text-align:right;font-weight:700">${money(p.revenue, c)}</td>
                    <td style="text-align:right" class="mono">${num(p.pv).toFixed(0)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>` : emptyState('No product sales yet', 'Bestsellers fill in as orders come in.', 'trendUp')}
      </div>

      <div class="card card--pad">
        <div class="section-head" style="margin-bottom:10px">
          <div><h2 style="font-size:16px">Payment mix</h2><p>Money actually received, by method.</p></div>
        </div>
        ${a.payments.length ? `
          <div class="list">
            ${a.payments.map(([method, amount]) => `
              <div class="list__row">
                <span class="badge badge--info">${esc(method)}</span>
                <div class="list__main"><div class="list__title">${money(amount, c)}</div></div>
                <span class="mono" style="color:var(--muted);font-size:12px">
                  ${a.collected > 0 ? Math.round((amount / a.collected) * 100) : 0}%
                </span>
              </div>
            `).join('')}
          </div>` : emptyState('Nothing to show', 'Payments break down once sales exist in the range.', 'wallet')}
      </div>
    </div>

    <div class="split mb-4">
      <div class="card card--pad">
        <div class="section-head" style="margin-bottom:10px">
          <div><h2 style="font-size:16px">Profit &amp; loss</h2><p>Gross margin and operating costs.</p></div>
        </div>
        <div class="totals">
          <div class="totals__row"><span>Sales revenue</span><strong>${money(a.revenue, c)}</strong></div>
          <div class="totals__row"><span>Cost of goods</span><strong>${a.costKnown ? `-${money(a.cost, c)}` : 'Cost not recorded'}</strong></div>
          <div class="totals__row"><span>Gross profit</span><strong>${a.gross === null ? '—' : money(a.gross, c)}</strong></div>
          <div class="totals__row"><span>Operating expenses</span><strong>-${money(a.expenseTotal, c)}</strong></div>
          <div class="totals__row totals__row--grand"><span>Net result</span><strong>${a.net === null ? '—' : money(a.net, c)}</strong></div>
        </div>
        ${a.costKnown ? '' : `<p style="font-size:11.5px;color:var(--faint);margin-top:8px">
          Add a <code>cost_price</code> to products to unlock margin reporting. Revenue and expenses still reconcile.
        </p>`}
      </div>

      <div class="card card--pad">
        <div class="section-head" style="margin-bottom:10px">
          <div><h2 style="font-size:16px">Cash reconciliation</h2><p>Expected movement, not a bank statement.</p></div>
        </div>
        <div class="totals">
          <div class="totals__row"><span>Cash &amp; card collected</span><strong>${money(a.collected, c)}</strong></div>
          <div class="totals__row"><span>Refunds paid out</span><strong>-${money(a.refunds, c)}</strong></div>
          <div class="totals__row"><span>Expenses paid out</span><strong>-${money(a.expenseTotal, c)}</strong></div>
          <div class="totals__row totals__row--grand"><span>Net cash movement</span>
            <strong style="color:${a.collected - a.refunds - a.expenseTotal < 0 ? 'var(--danger)' : 'var(--ok)'}">
              ${money(a.collected - a.refunds - a.expenseTotal, c)}
            </strong>
          </div>
          <div class="totals__row"><span>Outstanding receivables</span><strong>${money(a.due, c)}</strong></div>
        </div>
      </div>
    </div>

    ${expenseSection(a)}
  `;
}

function expenseSection(a) {
  const canExpense = store.can('expenses.edit');
  return `
    <div class="card card--pad">
      <div class="section-head" style="margin-bottom:10px">
        <div><h2 style="font-size:16px">Expenses</h2><p>Rent, transport, supplies and other out-of-pocket costs.</p></div>
      </div>
      ${canExpense ? `
        <div class="form-2 mb-3">
          <label class="field"><span>Category</span>
            <input class="input" id="expCategory" maxlength="60" placeholder="Transport" list="expenseCategories">
            <datalist id="expenseCategories">
              ${['Rent', 'Transport', 'Supplies', 'Utilities', 'Marketing', 'Salary', 'Other'].map((x) => `<option value="${x}"></option>`).join('')}
            </datalist>
          </label>
          <label class="field"><span>Amount (${esc(a.currency)})</span>
            <input class="input" id="expAmount" type="number" min="0.01" step="0.01" placeholder="0.00"></label>
        </div>
        <label class="field mb-2"><span>Note (optional)</span>
          <input class="input" id="expNote" maxlength="300" placeholder="What was this for?"></label>
        <button class="btn btn--primary btn--block mb-3" type="button" id="expAdd">${icon('plus', 16)} Add expense</button>
      ` : ''}
      ${a.expenses.length ? `
        <div class="table-wrap">
          <table style="min-width:0">
            <thead><tr><th>Date</th><th>Category</th><th>Note</th><th style="text-align:right">Amount</th></tr></thead>
            <tbody>
              ${a.expenses.slice(0, 100).map((e) => `
                <tr>
                  <td class="mono" style="font-size:11.5px">${esc(fmtDateTime(e.spent_at || e.created_at))}</td>
                  <td>${esc(e.category)}</td>
                  <td style="color:var(--muted);max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(e.note || '—')}</td>
                  <td style="text-align:right;font-weight:700">${money(e.amount, a.currency)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : emptyState('No expenses yet', 'Record an out-of-pocket cost to include it in the P&L.', 'wallet')}
    </div>
  `;
}

function bindExpenses(root) {
  root.querySelector('#expAdd')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const category = root.querySelector('#expCategory')?.value || '';
    const amount = num(root.querySelector('#expAmount')?.value, 0);
    const note = root.querySelector('#expNote')?.value || '';
    if (!(amount > 0)) { toast('Enter an amount greater than zero.', 'error'); return; }
    button.disabled = true;
    const result = await store.addExpense({ category, amount, note });
    button.disabled = false;
    if (!result.ok) { toast(result.message, 'error'); return; }
    toast(result.queued ? 'Expense saved offline — it will sync soon.' : 'Expense recorded.', 'ok');
    // Repaint this view without a full route change.
    const host = root.parentElement;
    if (host) renderReports(host);
  });
}

function reportSheets() {
  const a = analyse();
  const summary = [
    ['Metric', 'Value'],
    ['Range', rangeDays < 0 ? 'All time' : `${rangeDays} days`],
    ['Orders', a.orders.length],
    ['Revenue', round2(a.revenue)],
    ['Collected', round2(a.collected)],
    ['Outstanding', round2(a.due)],
    ['Refunds', round2(a.refunds)],
    ['Expenses', round2(a.expenseTotal)],
    ['Gross profit', a.gross === null ? 'cost not recorded' : a.gross],
    ['Net result', a.net === null ? 'cost not recorded' : a.net],
    ['PV', round2(a.pv)],
    ['Units', a.units],
    ['Generated at', new Date().toISOString()],
  ];
  return [
    { name: 'Summary', rows: summary, widths: [24, 26] },
    {
      name: 'Bestsellers',
      rows: [['Product', 'Units', 'Revenue', 'PV'], ...a.topProducts.map((p) => [p.name, p.qty, round2(p.revenue), round2(p.pv)])],
      widths: [38, 12, 16, 12],
    },
    {
      name: 'Payments',
      rows: [['Method', 'Amount'], ...a.payments.map(([method, amount]) => [method, round2(amount)])],
      widths: [24, 16],
    },
    {
      name: 'Expenses',
      rows: [['Date', 'Category', 'Note', 'Amount'], ...a.expenses.map((e) => [e.spent_at || e.created_at, e.category, e.note || '', round2(e.amount)])],
      widths: [24, 20, 40, 16],
    },
    {
      name: 'Daily revenue',
      rows: [['Period', 'Revenue'], ...a.buckets.map((b) => [b.label, round2(b.revenue)])],
      widths: [28, 16],
    },
  ];
}

function exportCsv() {
  const a = analyse();
  const rows = [
    ['TYPE', 'DATE', 'REFERENCE', 'CUSTOMER', 'DESCRIPTION', 'AMOUNT', 'METHOD/STATUS'],
    ...a.orders.map((o) => [
      'SALE', o.created_at, o.order_number, o.customer_name,
      (o.items || []).map((i) => `${i.name} x${i.quantity}`).join(' | '),
      round2(orderBalance(o).paid), paymentStatusLabel(orderBalance(o).status),
    ]),
    ...a.expenses.map((e) => ['EXPENSE', e.spent_at || e.created_at, '', '', `${e.category} ${e.note || ''}`.trim(), round2(e.amount), 'OUT']),
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadFile(`dxn-report-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
  toast('CSV downloaded.', 'ok');
}

function exportXlsx() {
  downloadXlsx(`dxn-report-${new Date().toISOString().slice(0, 10)}.xlsx`, reportSheets());
  toast('Excel workbook downloaded.', 'ok');
}

function exportPdf() {
  const a = analyse();
  const lines = [
    { text: 'Stockpoint report', bold: true, size: 17 },
    { text: `${store.state.settings.branch_name || 'Mohammadpur Stock Point'} · ${rangeDays < 0 ? 'All time' : `Last ${rangeDays} days`}`, size: 10 },
    { text: `Generated ${new Date().toLocaleString()}`, size: 9, gap: 10 },
    { rule: true },
    { text: 'Summary', bold: true, size: 12, gap: 7 },
    { text: `Orders: ${a.orders.length}`, size: 11 },
    { text: `Revenue: ${money(a.revenue, a.currency)}`, size: 11 },
    { text: `Collected: ${money(a.collected, a.currency)}`, size: 11 },
    { text: `Outstanding: ${money(a.due, a.currency)}`, size: 11 },
    { text: `Refunds: ${money(a.refunds, a.currency)}`, size: 11 },
    { text: `Expenses: ${money(a.expenseTotal, a.currency)}`, size: 11 },
    { text: `Gross profit: ${a.gross === null ? 'cost not recorded' : money(a.gross, a.currency)}`, size: 11 },
    { text: `Net result: ${a.net === null ? 'cost not recorded' : money(a.net, a.currency)}`, size: 11, gap: 12 },
    { text: 'Payment mix', bold: true, size: 12, gap: 7 },
    ...(a.payments.length
      ? a.payments.map(([method, amount]) => ({ text: `${method}: ${money(amount, a.currency)}`, size: 10, gap: 3 }))
      : [{ text: 'No payments in this range.', size: 10 }]),
    { text: ' ', gap: 8 },
    { text: 'Bestsellers', bold: true, size: 12, gap: 7 },
    ...(a.topProducts.length
      ? a.topProducts.map((p) => ({
        text: `${p.name} — ${p.qty} units · ${money(p.revenue, a.currency)}`, size: 10, gap: 3,
      }))
      : [{ text: 'No product sales in this range.', size: 10 }]),
    { text: ' ', gap: 8 },
    { text: 'Expenses', bold: true, size: 12, gap: 7 },
    ...(a.expenses.length
      ? a.expenses.map((e) => ({
        text: `${fmtDateTime(e.spent_at || e.created_at)}  ${e.category}  ${money(e.amount, a.currency)}`, size: 10, gap: 3,
      }))
      : [{ text: 'No expenses in this range.', size: 10 }]),
  ];
  const bytes = buildPdf({
    title: 'Stockpoint report',
    subtitle: `${store.state.settings.branch_name || 'Mohammadpur Stock Point'} · dependency-free offline PDF`,
    lines,
    footer: 'Mohammadpur Stock Point · confidential',
  });
  downloadPdf(`dxn-report-${new Date().toISOString().slice(0, 10)}.pdf`, bytes);
  toast('PDF downloaded.', 'ok');
}

function buildDayBuckets(orders, days) {
  const now = new Date();
  const bucketCount = Math.min(days, 8);
  const size = days / bucketCount;
  const buckets = [];
  for (let i = bucketCount - 1; i >= 0; i -= 1) {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - Math.round((bucketCount - 1 - i) * size));
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - Math.round(size) + 1);
    const startKey = isoWeekless(start);
    const endKey = isoWeekless(end);
    const mine = orders.filter((o) => {
      const key = String(o.created_at || '').slice(0, 10);
      return key >= startKey && key <= endKey;
    });
    buckets.push({
      label: startKey === endKey ? startKey : `${fmtShort(startKey)}–${fmtShort(endKey)}`,
      short: end.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      revenue: mine.reduce((sum, o) => sum + num(o.total_amount), 0),
    });
  }
  return buckets;
}

function buildMonthBuckets(orders) {
  const monthMap = new Map();
  for (const order of orders) {
    const key = String(order.created_at || '').slice(0, 7);
    if (!key) continue;
    monthMap.set(key, num(monthMap.get(key) || 0) + num(order.total_amount));
  }
  const keys = [...monthMap.keys()].sort();
  const recent = keys.slice(-12);
  const parse = (key) => new Date(`${key}-02T00:00:00Z`);
  return recent.map((key) => {
    const date = parse(key);
    return {
      label: date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      short: date.toLocaleDateString(undefined, { month: 'short' }),
      revenue: monthMap.get(key),
    };
  });
}

function isoWeekless(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function fmtShort(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
