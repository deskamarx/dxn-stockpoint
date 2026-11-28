/**
 * Receipts: preview, print, PDF, WhatsApp and the Android share sheet.
 *
 * The same receipt object is used for a just-saved sale (still in the outbox)
 * and for a historic order, so the customer always gets an identical document.
 */

import { esc, money, int, num, round2, digits } from './util.js';
import { icon, openModal, toast, receiptText, orderMessage, waLink, printReceipt } from './ui.js';
import * as store from './store.js';
import { orderBalance, methodLabel } from './payments.js';
import { receiptPdf, downloadPdf, pdfBlob } from './pdf.js';

/** Converts an outbox payload or server order into one receipt shape. */
export function normalizeReceipt(source) {
  const currency = store.currency();
  const payload = source?.payload || source || {};
  const items = (payload.items || []).map((item) => {
    const product = store.productById(item.product_id);
    const qty = num(item.quantity);
    const unit = num(item.unit_price);
    return {
      name: item.name || product?.name || `Product ${item.product_id}`,
      sku: item.sku || item.product_sku || product?.sku || '',
      quantity: qty,
      unit_price: unit,
      line_total: num(item.line_total ?? unit * qty),
    };
  });
  const subtotal = num(payload.subtotal ?? items.reduce((sum, i) => sum + i.line_total, 0));
  const discount = num(payload.discount);
  const total = num(payload.total_amount ?? Math.max(0, subtotal - discount));
  const payments = Array.isArray(payload.payments) ? payload.payments : [];
  const paid = payload.amount_paid !== undefined
    ? num(payload.amount_paid)
    : payments.reduce((sum, p) => sum + num(p.amount), 0);
  return {
    id: payload.id || null,
    order_number: payload.order_number || (source?.orderNumber || 'PENDING'),
    created_at: payload.created_at || new Date(source?.createdAt || Date.now()).toISOString(),
    customer_name: payload.customer_name || 'Walk-in customer',
    customer_phone: payload.customer_phone || '',
    dxn_member_id: payload.dxn_member_id || '',
    is_member: Boolean(payload.is_member),
    subtotal,
    discount,
    total_amount: total,
    total_pv: num(payload.total_pv ?? items.reduce((sum, i) => sum + num(i.unit_pv) * i.quantity, 0)),
    amount_paid: paid,
    due_amount: num(payload.due_amount ?? Math.max(0, total - paid)),
    change_amount: num(payload.change_amount ?? Math.max(0, paid - total)),
    payment_status: payload.payment_status || (paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID'),
    payment_method: payload.payment_method || payments[0]?.method || 'CASH',
    payments,
    note: payload.note || '',
    status: payload.status || 'CONFIRMED',
    currency,
    items,
  };
}

export function receiptHtml(order) {
  const settings = store.state.settings;
  const currency = order.currency || store.currency();
  const rows = order.items.map((item) => `
    <tr>
      <td>${esc(item.name)}${item.sku ? `<div class="rcpt-sku">${esc(item.sku)}</div>` : ''}</td>
      <td class="num">${int(item.quantity)}</td>
      <td class="num">${money(item.unit_price, currency)}</td>
      <td class="num">${money(item.line_total, currency)}</td>
    </tr>`).join('');
  const paidRows = order.payments.length
    ? order.payments.map((p) => `<div class="rcpt-line"><span>${esc(methodLabel(p.method))}${p.reference ? ` · ${esc(p.reference)}` : ''}</span><strong>${money(p.amount, currency)}</strong></div>`).join('')
    : `<div class="rcpt-line"><span>${esc(methodLabel(order.payment_method))}</span><strong>${money(order.amount_paid, currency)}</strong></div>`;
  return `
    <div class="rcpt">
      <div class="rcpt-head">
        <div>
          <div class="rcpt-brand">${esc(settings.branch_name || 'Mohammadpur Stock Point')}</div>
          <div class="rcpt-muted">${esc(settings.business_address || '')}</div>
          <div class="rcpt-muted">${esc(settings.business_phone || '')}</div>
        </div>
        <div class="rcpt-invoice">
          <div class="rcpt-label">Invoice</div>
          <div class="rcpt-number">${esc(order.order_number)}</div>
          <div class="rcpt-muted">${esc(new Date(order.created_at).toLocaleString())}</div>
        </div>
      </div>
      <div class="rcpt-customer">
        <span>${esc(order.customer_name)}</span>
        ${order.customer_phone ? `<span>${esc(order.customer_phone)}</span>` : ''}
        ${order.dxn_member_id ? `<span class="badge badge--info">${esc(order.dxn_member_id)}</span>` : ''}
      </div>
      <table class="rcpt-table">
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="rcpt-totals">
        <div class="rcpt-line"><span>Subtotal</span><strong>${money(order.subtotal, currency)}</strong></div>
        ${order.discount > 0 ? `<div class="rcpt-line"><span>Discount</span><strong>-${money(order.discount, currency)}</strong></div>` : ''}
        <div class="rcpt-line rcpt-line--grand"><span>Total</span><strong>${money(order.total_amount, currency)}</strong></div>
        ${paidRows}
        ${order.due_amount > 0 ? `<div class="rcpt-line rcpt-line--due"><span>Due</span><strong>${money(order.due_amount, currency)}</strong></div>` : ''}
        ${order.change_amount > 0 ? `<div class="rcpt-line"><span>Change</span><strong>${money(order.change_amount, currency)}</strong></div>` : ''}
        <div class="rcpt-line rcpt-muted"><span>PV</span><strong>${round2(order.total_pv).toFixed(2)}</strong></div>
      </div>
      ${order.note ? `<p class="rcpt-note">Note: ${esc(order.note)}</p>` : ''}
      <p class="rcpt-foot">${esc(settings.receipt_footer || 'Thank you for your purchase.')}</p>
    </div>
  `;
}

const PRINT_CSS = `
  *{box-sizing:border-box}body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;padding:10px;color:#111}
  .rcpt{max-width:360px;margin:0 auto;font-size:12px}
  .rcpt-head{display:flex;justify-content:space-between;gap:12px;border-bottom:1px dashed #999;padding-bottom:8px;margin-bottom:8px}
  .rcpt-brand{font-weight:800;font-size:15px}.rcpt-muted{color:#555;font-size:10.5px}
  .rcpt-invoice{text-align:right}.rcpt-label{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#777}
  .rcpt-number{font-weight:800;font-size:13px}
  .rcpt-customer{display:flex;gap:8px;flex-wrap:wrap;padding:6px 0;border-bottom:1px dashed #ccc;font-size:11px}
  .rcpt-table{width:100%;border-collapse:collapse;margin:8px 0}
  .rcpt-table th{text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:#666;border-bottom:1px solid #ddd;padding:4px 2px}
  .rcpt-table td{padding:5px 2px;border-bottom:1px dotted #eee;vertical-align:top}
  .rcpt-table .num{text-align:right;white-space:nowrap}
  .rcpt-sku{color:#888;font-size:9px}
  .rcpt-line{display:flex;justify-content:space-between;gap:12px;padding:2px 0}
  .rcpt-line--grand{font-size:15px;font-weight:800;border-top:1px solid #333;margin-top:4px;padding-top:5px}
  .rcpt-line--due{color:#b91c1c;font-weight:800}
  .rcpt-totals{margin-top:6px}
  .rcpt-note{font-size:10px;color:#555;margin:8px 0 0}
  .rcpt-foot{text-align:center;font-size:10.5px;color:#555;margin-top:12px;border-top:1px dashed #ccc;padding-top:8px}
  @media print{body{padding:0}.rcpt{max-width:none}}
`;

export function printOrder(order) {
  printReceipt(`<style>${PRINT_CSS}</style>${receiptHtml(order)}`);
}

export function downloadReceiptPdf(order) {
  const bytes = receiptPdf(order, store.state.settings);
  const name = `${order.order_number || 'receipt'}.pdf`.replace(/[^\w.-]+/g, '-');
  downloadPdf(name, bytes);
  return { bytes, name };
}

/** Android WebView bridge first, then the Web Share API, then download. */
export async function shareReceipt(order) {
  const bytes = receiptPdf(order, store.state.settings);
  const name = `${order.order_number || 'receipt'}.pdf`.replace(/[^\w.-]+/g, '-');
  const bridge = typeof window !== 'undefined' ? window.DxnNative : null;
  if (bridge?.sharePdf) {
    try {
      bridge.sharePdf(base64(bytes), name, `Receipt ${order.order_number}`);
      return { ok: true, via: 'android' };
    } catch { /* fall through */ }
  }
  if (typeof navigator !== 'undefined' && navigator.canShare) {
    try {
      const file = new File([pdfBlob(bytes)], name, { type: 'application/pdf' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Receipt ${order.order_number}`, text: orderMessage(order, store.state.settings) });
        return { ok: true, via: 'share' };
      }
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, cancelled: true };
    }
  }
  downloadPdf(name, bytes);
  return { ok: true, via: 'download' };
}

function base64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Full receipt modal used after checkout and from Orders. */
export function openReceipt(source, { justSaved = false } = {}) {
  const order = normalizeReceipt(source);
  const currency = order.currency;
  const balance = orderBalance(order);
  openModal({
    title: justSaved ? 'Sale saved' : `Invoice ${order.order_number}`,
    size: 'wide',
    body: `
      <div class="receipt-preview">${receiptHtml(order)}</div>
      ${justSaved ? `<p class="receipt-hint">${store.state.outbox.some((o) => o.id === source?.id)
        ? 'Saved on this device. It will sync automatically when the connection returns.'
        : 'Saved and synced.'}</p>` : ''}
      <div class="receipt-actions">
        <button class="btn btn--ghost" type="button" data-receipt-print>${icon('print', 16)} Print</button>
        <button class="btn btn--ghost" type="button" data-receipt-pdf>${icon('download', 16)} PDF</button>
        <button class="btn btn--ghost" type="button" data-receipt-share>${icon('share', 16)} Share</button>
        <button class="btn btn--wa" type="button" data-receipt-wa>${icon('whatsapp', 16)} WhatsApp</button>
      </div>
      ${balance.due > 0 ? `<p class="receipt-hint" style="color:var(--danger)">${money(balance.due, currency)} still due on this invoice.</p>` : ''}
    `,
    footer: `<button class="btn btn--primary" type="button" data-close>${justSaved ? 'New sale' : 'Close'}</button>`,
    onMount(panel, close) {
      panel.querySelector('[data-receipt-print]')?.addEventListener('click', () => printOrder(order));
      panel.querySelector('[data-receipt-pdf]')?.addEventListener('click', () => {
        downloadReceiptPdf(order);
        toast('PDF downloaded.', 'ok');
      });
      panel.querySelector('[data-receipt-share]')?.addEventListener('click', async () => {
        const result = await shareReceipt(order);
        if (result.cancelled) return;
        toast(result.via === 'download' ? 'PDF downloaded — share it from your files.' : 'Receipt shared.', 'ok');
      });
      panel.querySelector('[data-receipt-wa]')?.addEventListener('click', () => {
        const phone = digits(order.customer_phone) || store.state.settings.whatsapp_number;
        window.open(waLink(phone, orderMessage(order, store.state.settings)), '_blank', 'noopener');
      });
    },
  });
}

/** Plain text receipt for clipboard / old printers. */
export function orderText(order) {
  return receiptText(normalizeReceipt(order), store.state.settings);
}

