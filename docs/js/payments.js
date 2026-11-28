/**
 * Payment arithmetic shared by the POS, the order screen and the server
 * contract tests. Nothing here talks to the network or the DOM, so the rules
 * can be unit-tested directly.
 *
 * A sale has one total and any number of payment entries. The rules are:
 *  - paid + due always equals the total (to the paisa)
 *  - change only exists when paid > total, and only for cash-like methods
 *  - an unpaid or partly paid sale is never labelled PAID
 */

import { num, round2 } from './util.js';

export const PAYMENT_METHODS = [
  { id: 'CASH', label: 'Cash', icon: 'wallet', cash: true },
  { id: 'BKASH', label: 'bKash', icon: 'phone', cash: false },
  { id: 'NAGAD', label: 'Nagad', icon: 'phone', cash: false },
  { id: 'BANK TRANSFER', label: 'Bank', icon: 'bank', cash: false },
  { id: 'CARD', label: 'Card', icon: 'card', cash: false },
  { id: 'WALLET', label: 'Wallet', icon: 'wallet', cash: false },
  { id: 'CREDIT', label: 'Credit / due', icon: 'clock', cash: false, credit: true },
];

export const PAYMENT_METHOD_IDS = PAYMENT_METHODS.map((m) => m.id);

export function methodLabel(id) {
  return PAYMENT_METHODS.find((m) => m.id === String(id || '').toUpperCase())?.label || String(id || 'Cash');
}

export function isCreditMethod(id) {
  return PAYMENT_METHODS.some((m) => m.id === String(id || '').toUpperCase() && m.credit);
}

export function paymentStatus(paid, total) {
  const p = round2(num(paid));
  const t = round2(num(total));
  if (t <= 0) return p > 0 ? 'PAID' : 'UNPAID';
  if (p >= t) return 'PAID';
  if (p > 0) return 'PARTIALLY_PAID';
  return 'UNPAID';
}

/** Human status used in badges and reports. */
export function paymentStatusLabel(status) {
  const map = {
    PAID: 'Paid',
    PARTIALLY_PAID: 'Part paid',
    UNPAID: 'Unpaid',
    CREDIT: 'On credit',
    REFUNDED: 'Refunded',
  };
  return map[String(status || '').toUpperCase()] || String(status || 'Unpaid');
}

/**
 * Normalises a list of payment entries against a total.
 * Entries with a zero/negative amount are dropped. Cash overpayment becomes
 * change; non-cash overpayment is clamped (a card cannot hand back cash).
 */
export function normalizePayments(entries, total, { allowCredit = true } = {}) {
  const t = round2(Math.max(0, num(total)));
  const clean = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const amount = round2(Math.max(0, num(entry?.amount)));
    const method = String(entry?.method || 'CASH').toUpperCase();
    if (!amount) continue;
    if (!PAYMENT_METHOD_IDS.includes(method)) continue;
    clean.push({
      method,
      amount,
      reference: String(entry?.reference || '').trim().slice(0, 120),
      note: String(entry?.note || '').trim().slice(0, 200),
      client_uuid: entry?.client_uuid || null,
    });
  }

  let paid = round2(clean.reduce((sum, entry) => sum + entry.amount, 0));
  let change = 0;
  if (paid > t) {
    const over = round2(paid - t);
    const cashIndex = [...clean].map((e, i) => ({ e, i })).reverse()
      .find(({ e }) => e.method === 'CASH');
    if (cashIndex) {
      change = over;
      clean[cashIndex.i].amount = round2(clean[cashIndex.i].amount - over);
      paid = t;
    } else {
      // Non-cash rails cannot give change: clamp the last entry.
      let excess = over;
      for (let i = clean.length - 1; i >= 0 && excess > 0; i -= 1) {
        const cut = Math.min(clean[i].amount, excess);
        clean[i].amount = round2(clean[i].amount - cut);
        excess = round2(excess - cut);
      }
      paid = round2(clean.reduce((sum, entry) => sum + entry.amount, 0));
    }
  }

  const due = round2(Math.max(0, t - paid));
  if (due > 0 && !allowCredit) {
    return {
      ok: false,
      message: `This sale is short by ${due.toFixed(2)}. Add a payment or select a customer for credit.`,
      payments: clean,
      paid,
      due,
      change,
      total: t,
      status: paymentStatus(paid, t),
      credit: false,
    };
  }

  return {
    ok: true,
    payments: clean.filter((entry) => entry.amount > 0),
    paid,
    due,
    change,
    total: t,
    status: paymentStatus(paid, t),
    credit: due > 0,
  };
}

/** Convenience for the one-tap "exact amount" buttons in checkout. */
export function quickAmounts(total) {
  const t = round2(num(total));
  const out = new Set([t]);
  for (const step of [50, 100, 500, 1000]) {
    const rounded = Math.ceil(t / step) * step;
    if (rounded > t) out.add(round2(rounded));
  }
  return [...out].sort((a, b) => a - b).slice(0, 5);
}

/** Amount still owed on an order, tolerating older rows without the fields. */
export function orderBalance(order) {
  const total = round2(num(order?.total_amount));
  const paid = order?.amount_paid !== undefined
    ? round2(num(order.amount_paid))
    : order?.payment_status === 'PAID' || order?.status === 'PAID'
      ? total
      : round2((order?.payments || []).reduce((sum, p) => sum + num(p.amount), 0));
  return {
    total,
    paid,
    due: round2(Math.max(0, total - paid)),
    change: round2(Math.max(0, paid - total)),
    status: order?.payment_status || paymentStatus(paid, total),
  };
}

/** Refund arithmetic for returns: never refund more than was collected. */
export function refundable(order) {
  const balance = orderBalance(order);
  const refunded = round2((order?.refunds || []).reduce((sum, r) => sum + num(r.amount), 0));
  return round2(Math.max(0, balance.paid - refunded));
}
