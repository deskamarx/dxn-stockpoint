/**
 * SteadFast Courier client (Bangladesh).
 *
 * Credentials are stored in the shop settings so every deployment talks to its
 * own courier account. Nothing is read from environment variables or the repo.
 */

import { ApiError, clean } from './util.js';

const DEFAULT_BASE = 'https://portal.packzy.com/api/v1';
const REQUEST_TIMEOUT_MS = 20000;

export function createCourier(db) {
  const apiKey = () => String(db.setting('steadfast_api_key', '') || '');
  const secretKey = () => String(db.setting('steadfast_secret_key', '') || '');
  const baseUrl = () => String(db.setting('steadfast_base_url', DEFAULT_BASE) || DEFAULT_BASE).replace(/\/+$/, '');
  const webhookToken = () => String(db.setting('steadfast_webhook_token', '') || '') || apiKey();

  function configured() {
    return apiKey() !== '' && secretKey() !== '';
  }

  async function request(method, path, payload = null) {
    if (!configured()) {
      throw new ApiError('SteadFast is not configured. Add API credentials in Settings.', 422, 'courier_not_configured');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: {
          'Api-Key': apiKey(),
          'Secret-Key': secretKey(),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: payload === null ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new ApiError('SteadFast took too long to answer', 504, 'courier_timeout');
      }
      throw new ApiError('Could not reach SteadFast', 502, 'courier_error');
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 500) };
    }

    if (!response.ok) {
      const detail = body?.message || body?.error || `HTTP ${response.status}`;
      throw new ApiError(`SteadFast: ${clean(detail, 240)}`, 502, 'courier_error');
    }
    return body ?? {};
  }

  return {
    settings() {
      const secret = secretKey();
      return {
        base_url: baseUrl(),
        api_key: apiKey(),
        secret_key: secret ? `••••${secret.slice(-4)}` : '',
        webhook_token: webhookToken(),
        configured: configured(),
      };
    },

    saveSettings(payload) {
      const fields = {
        base_url: 'steadfast_base_url',
        api_key: 'steadfast_api_key',
        secret_key: 'steadfast_secret_key',
        webhook_token: 'steadfast_webhook_token',
      };
      const updated = [];
      for (const [input, setting] of Object.entries(fields)) {
        if (!(input in payload)) continue;
        const value = clean(payload[input], 500);
        if (value === '') continue;
        // The masked secret from GET /courier/settings must never be saved back.
        if (input === 'secret_key' && value.startsWith('••••')) continue;
        db.putSetting(setting, value);
        updated.push(input);
      }
      if (updated.length === 0) {
        throw new ApiError('No settings were supplied', 422, 'validation_error');
      }
      db.audit('courier_settings_updated', 'settings', null, updated.join(','));
      db.save();
      return updated;
    },

    balance: () => request('GET', '/get_balance'),
    createOrder: (payload) => request('POST', '/create_order', payload),
    statusByCid: (id) => request('GET', `/status_by_cid/${encodeURIComponent(id)}`),
    createReturn: (payload) => request('POST', '/create_return_request', payload),
    returns: () => request('GET', '/get_return_requests'),
    webhookToken,

    /** Map a SteadFast status string onto a Stockpoint order status. */
    mapOrderStatus(status) {
      const value = String(status || '').toLowerCase().trim();
      if (['delivered', 'delivered_approval_pending', 'partial_delivered', 'partial_delivered_approval_pending'].includes(value)) {
        return 'DELIVERED';
      }
      if (['cancelled', 'cancelled_approval_pending'].includes(value)) return 'CANCELLED';
      return null;
    },
  };
}
