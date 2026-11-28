/**
 * Settings: connection, shop profile, staff & roles, security, durable data,
 * audit, conflicts and device care. Every destructive action takes a snapshot
 * first, and every backup can be encrypted before it leaves the device.
 */

import { esc, money, num, int, relTime, downloadFile, digits, fmtDateTime } from '../util.js';
import { icon, toast, confirmAction, openModal, closeModal, hydrateIcons } from '../ui.js';
import api, { ApiError, getBase, setBase, hasBase, getTokenMeta } from '../api.js';
import * as store from '../store.js';
import { ROLES, ROLE_LABELS, PERMISSIONS, addLocalStaff, removeLocalStaff, localStaff } from '../roles.js';
import { encryptBackup, decryptBackup, isEncryptedBackup } from '../crypto.js';

let activeTab = 'server';

const TABS = [
  ['server', 'Server & courier'],
  ['profile', 'Shop profile'],
  ['staff', 'Staff & roles'],
  ['security', 'Security'],
  ['data', 'Data & audit'],
  ['device', 'This device'],
  ['about', 'About'],
];

const canManage = () => store.state.role === ROLES.ADMIN || store.state.role === ROLES.MANAGER;
const canAdmin = () => store.state.role === ROLES.ADMIN;

export function renderSettings(root) {
  root.innerHTML = `
    <div class="section-head">
      <div><h2>Settings</h2>
        <p>The shop's engine room — connection, people, security, data and device care.</p></div>
      <span class="badge badge--${store.state.isAdmin ? 'ok' : 'muted'}">
        ${esc(store.state.role)} · ${store.state.isAdmin ? 'Signed in' : 'Viewer'}
      </span>
    </div>

    <div class="settings-tabs" id="settingsTabs">
      ${TABS.map(([key, label]) => `
        <button class="settings-tab ${activeTab === key ? 'is-active' : ''}" data-tab="${key}" type="button">${label}</button>
      `).join('')}
    </div>

    <div class="settings-panel ${activeTab === 'server' ? 'is-active' : ''}" data-panel="server">
      ${connectionCard()}
      ${courierCard()}
    </div>

    <div class="settings-panel ${activeTab === 'profile' ? 'is-active' : ''}" data-panel="profile">
      ${profileCard()}
    </div>

    <div class="settings-panel ${activeTab === 'staff' ? 'is-active' : ''}" data-panel="staff">
      ${staffCard()}
    </div>

    <div class="settings-panel ${activeTab === 'security' ? 'is-active' : ''}" data-panel="security">
      ${securityCard()}
    </div>

    <div class="settings-panel ${activeTab === 'data' ? 'is-active' : ''}" data-panel="data">
      ${dataCard()}
    </div>

    <div class="settings-panel ${activeTab === 'device' ? 'is-active' : ''}" data-panel="device">
      ${deviceCard()}
    </div>

    <div class="settings-panel ${activeTab === 'about' ? 'is-active' : ''}" data-panel="about">
      ${aboutCard()}
    </div>
  `;

  bind(root);
  loadAsyncPanels(root);
}

// ── Server tab ──────────────────────────────────────────────────────────────

function connectionCard() {
  const { syncState, lastSyncAt, rev, health } = store.state;
  const connected = hasBase();
  const editable = !store.state.isAdmin || store.can('sync.manage');
  const disabled = editable ? '' : 'disabled';
  return `
    <div class="card card--pad" style="margin-bottom:18px" id="connectionCard">
      <div class="section-head" style="margin-bottom:12px">
        <div>
          <h2 style="font-size:15px">Shop server</h2>
          <p>One address powers the web app, every Android shell and the offline sync loop.</p>
        </div>
        <span class="badge badge--${connected ? (syncState === 'online' ? 'ok' : 'warn') : 'danger'}">
          ${connected ? (syncState === 'online' ? 'Connected' : 'Not answering') : 'Not connected'}
        </span>
      </div>

      <label class="field"><span>API base URL</span>
        <input class="input" id="apiBaseInput" type="url" inputmode="url" spellcheck="false" ${disabled}
          placeholder="${esc(getBase() || 'https://shop.example.com')}" value="${esc(getBase())}">
        <small>Defaults to this site's own address. Change it only when the API lives on a different domain.</small>
      </label>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn--ghost" type="button" id="probeBtn">${icon('cloud', 16)} Test connection</button>
        <button class="btn btn--primary" type="button" id="saveBaseBtn" ${disabled}>${icon('check', 16)} Save &amp; sync</button>
        ${canAdmin() ? `<button class="btn btn--ghost" type="button" id="seedBtn">${icon('sparkles', 16)} Seed demo data</button>` : ''}
      </div>

      <div id="probeResult" style="margin-top:14px;font-size:12.5px;color:var(--muted);line-height:1.7">
        ${connected
          ? `Last sync ${lastSyncAt ? relTime(new Date(lastSyncAt).toISOString()) : 'never'} · revision ${int(rev)}${health?.version ? ` · server ${esc(health.version)}` : ''}`
          : 'The catalogue is the built-in demo data until you connect a server. Sales still save on this device.'}
      </div>

      <details class="mt-3">
        <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:var(--muted)">Host your own API (one-time)</summary>
        <ol style="font-size:12.5px;color:var(--muted);line-height:1.8;padding-left:18px;margin-top:8px">
          <li><strong>Easiest:</strong> run <code>npm start</code> in <code>web-src/</code> — a full API serves at
          <code>http://127.0.0.1:4173</code> and connects automatically.</li>
          <li><strong>Multi-device:</strong> upload the <code>api/</code> folder (PHP + MySQL) to any PHP host.</li>
          <li>Copy <code>api/config/config.sample.php</code> to <code>config.php</code> and paste database values.</li>
          <li>Open <code>/api/public/install.php?key=YOUR_INSTALL_KEY</code> to set the shop PIN.</li>
          <li>Paste that address here — the Android app uses the same one.</li>
        </ol>
      </details>
    </div>
  `;
}

function courierCard() {
  const disabled = canManage() ? '' : 'disabled';
  const webhookUrl = `${getBase() || location.origin}/api/v1/courier/webhook`;
  return `
    <div class="card card--pad" id="courierCard">
      <div class="section-head" style="margin-bottom:12px">
        <div><h2 style="font-size:15px">SteadFast courier</h2>
          <p>Ship orders through SteadFast. Credentials are stored on the shop server, never in this browser.</p></div>
        <span class="badge badge--muted" id="sfStatusBadge">Not configured</span>
      </div>

      <div class="form-2">
        <label class="field" style="grid-column:1/-1"><span>Base URL</span>
          <input class="input" id="sfBase" value="https://portal.packzy.com/api/v1" ${disabled} spellcheck="false"></label>
        <label class="field"><span>API Key</span>
          <input class="input" id="sfApiKey" ${disabled} spellcheck="false" placeholder="jsyjsj…"></label>
        <label class="field"><span>Secret Key</span>
          <input class="input" id="sfSecret" type="password" ${disabled} spellcheck="false"></label>
        <label class="field" style="grid-column:1/-1"><span>Webhook token (optional)</span>
          <input class="input" id="sfWebhook" ${disabled} spellcheck="false" placeholder="leave blank to reuse the API key"></label>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
        <button class="btn btn--primary" type="button" id="sfSaveBtn" ${disabled}>${icon('check', 16)} Save credentials</button>
        <button class="btn btn--ghost" type="button" id="sfBalanceBtn" ${disabled}>${icon('wallet', 16)} Check balance</button>
      </div>

      <div id="sfBalanceResult" style="margin-top:10px;font-size:12.5px;color:var(--muted)"></div>

      <details class="mt-3">
        <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:var(--muted)">Webhook setup</summary>
        <p style="font-size:12.5px;color:var(--muted);line-height:1.7;margin-top:8px">
          In your SteadFast merchant panel set the callback URL to<br>
          <code style="word-break:break-all">${esc(webhookUrl)}</code><br>
          and the bearer token to your API key. SteadFast will then push delivery status updates
          to this shop automatically.
        </p>
      </details>
    </div>
  `;
}

// ── Profile tab ─────────────────────────────────────────────────────────────

function profileCard() {
  const settings = store.state.settings;
  const disabled = canManage() ? '' : 'disabled';
  return `
    <div class="card card--pad">
      <div class="section-head" style="margin-bottom:12px">
        <div><h2 style="font-size:15px">Shop profile</h2><p>Printed on receipts and sent with WhatsApp orders.</p></div>
        ${canManage() ? '' : '<span class="badge badge--muted">Manager sign-in to edit</span>'}
      </div>

      <div class="form-2">
        <label class="field" style="grid-column:1/-1"><span>Stockpoint name</span>
          <input class="input" id="setBranch" value="${esc(settings.branch_name || '')}" ${disabled} maxlength="120"></label>

        <label class="field"><span>WhatsApp number</span>
          <input class="input" id="setWa" inputmode="tel" value="${esc(settings.whatsapp_number || '')}" ${disabled}
            placeholder="8801987851131"></label>

        <label class="field"><span>Currency code</span>
          <input class="input" id="setCurrency" value="${esc(settings.currency || 'BDT')}" ${disabled} maxlength="8"></label>

        <label class="field"><span>Business phone</span>
          <input class="input" id="setPhone" value="${esc(settings.business_phone || '')}" ${disabled} maxlength="40"></label>

        <label class="field"><span>Low stock alert at</span>
          <input class="input" id="setThreshold" type="number" min="0" step="1"
            value="${esc(settings.low_stock_threshold ?? 5)}" ${disabled}></label>

        <label class="field" style="grid-column:1/-1"><span>Business address</span>
          <input class="input" id="setAddress" value="${esc(settings.business_address || '')}" ${disabled} maxlength="200"></label>

        <label class="field" style="grid-column:1/-1"><span>Receipt footer</span>
          <textarea class="textarea" id="setFooter" ${disabled} maxlength="300">${esc(settings.receipt_footer || '')}</textarea></label>
      </div>

      <label style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <span class="switch">
          <input type="checkbox" id="setPublicOrders" ${Number(settings.allow_public_orders ?? 1) ? 'checked' : ''} ${disabled}>
          <span class="switch__track"></span>
        </span>
        <span style="font-size:13px"><strong>Accept orders without a PIN</strong>
          <small style="display:block;color:var(--muted);font-size:11.5px">Turn off to make the catalogue read-only for customers.</small></span>
      </label>

      <button class="btn btn--primary" type="button" id="saveProfileBtn" ${disabled}>
        ${icon('check', 16)} Save shop profile
      </button>
    </div>
  `;
}

// ── Staff & roles ───────────────────────────────────────────────────────────

function staffCard() {
  if (!store.can('settings.view')) {
    return signInCard('Staff & roles', 'Staff accounts, individual PINs and the permission matrix are manager-only.');
  }
  const isAdmin = canAdmin();
  return `
    <div class="card card--pad" style="margin-bottom:18px">
      <div class="section-head" style="margin-bottom:12px">
        <div><h2 style="font-size:15px">Staff accounts</h2>
          <p>Each person has their own PIN. Roles are enforced on the device and again on the server.</p></div>
        <span class="badge badge--info">${int((store.state.remoteStaff.length || store.state.staff.length))} account(s)</span>
      </div>

      <div id="staffList"><div class="mono" style="color:var(--faint);font-size:12px">Loading staff…</div></div>

      ${isAdmin ? `
        <div class="form-2 mt-3">
          <label class="field"><span>Name</span><input class="input" id="staffName" maxlength="80" placeholder="e.g. Rahim"></label>
          <label class="field"><span>Role</span>
            <select class="input" id="staffRole">
              ${Object.values(ROLES).map((role) => `<option value="${role}">${ROLE_LABELS[role]}</option>`).join('')}
            </select></label>
          <label class="field" style="grid-column:1/-1"><span>New PIN (4–8 digits)</span>
            <input class="input" id="staffPin" type="password" inputmode="numeric" minlength="4" maxlength="8" placeholder="••••"></label>
        </div>
        <button class="btn btn--primary mt-2" type="button" id="staffAdd">${icon('userPlus', 16)} Add staff member</button>
      ` : `<p class="mt-2" style="font-size:12px;color:var(--muted)">Only an administrator can add or remove staff.</p>`}
    </div>

    <div class="card card--pad">
      <div class="section-head" style="margin-bottom:10px">
        <div><h2 style="font-size:15px">Permission matrix</h2><p>What each role can do in this app.</p></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Role</th><th>Rank</th><th>Permissions</th></tr></thead>
          <tbody>
            ${Object.values(ROLES).map((role) => `
              <tr>
                <td><strong>${ROLE_LABELS[role]}</strong></td>
                <td class="mono">${role === ROLES.ADMIN ? 4 : role === ROLES.MANAGER ? 3 : role === ROLES.CASHIER ? 2 : 1}</td>
                <td style="font-size:11.5px;color:var(--muted)">${esc(PERMISSIONS[role].join(', '))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ── Security ────────────────────────────────────────────────────────────────

function securityCard() {
  const meta = getTokenMeta();
  return `
    <div class="card card--pad">
      <div class="section-head" style="margin-bottom:12px">
        <div><h2 style="font-size:15px">Security</h2>
          <p>${store.state.isAdmin
            ? `Signed in as ${esc(store.state.role)}${meta?.expires_at ? ` until ${esc(new Date(meta.expires_at).toLocaleString())}` : ''}.`
            : 'Anyone can browse; a staff PIN unlocks the till and admin tools.'}</p></div>
        <span class="badge badge--${store.state.isAdmin ? 'ok' : 'muted'}">${store.state.isAdmin ? 'Unlocked' : 'Viewer'}</span>
      </div>

      ${store.state.isAdmin ? `
        <div class="form-2">
          <label class="field"><span>New PIN for this account</span>
            <input class="input" id="newPin" type="password" inputmode="numeric" minlength="4" maxlength="8" placeholder="4–8 digits"></label>
          <label class="field"><span>Repeat PIN</span>
            <input class="input" id="newPin2" type="password" inputmode="numeric" minlength="4" maxlength="8" placeholder="Repeat"></label>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn--primary" type="button" id="changePinBtn">${icon('check', 16)} Change PIN</button>
          <button class="btn btn--danger" type="button" id="signOutBtn">${icon('logout', 16)} Sign out</button>
        </div>
      ` : `
        <button class="btn btn--primary" type="button" id="signInBtn">${icon('user', 16)} Sign in with staff PIN</button>
      `}

      <div class="list mt-3">
        <div class="list__row"><div class="list__main">
          <div class="list__title">Offline PIN fallback</div>
          <div class="list__sub">A salted hash on this device unlocks the till when the server is unreachable.</div>
        </div><span class="badge badge--ok">Ready</span></div>
        <div class="list__row"><div class="list__main">
          <div class="list__title">Server token</div>
          <div class="list__sub">Stored for this session and cleared on sign-out.</div>
        </div><span class="badge badge--${getTokenMeta() ? 'ok' : 'muted'}">${getTokenMeta() ? 'Issued' : 'None'}</span></div>
      </div>
    </div>
  `;
}

// ── Data, audit & rollback ───────────────────── snapshots ──────────────────

function dataCard() {
  const canBackup = store.can('backup.export');
  return `
    <div class="card card--pad" style="margin-bottom:18px">
      <div class="section-head" style="margin-bottom:12px">
        <div><h2 style="font-size:15px">Durable database</h2>
          <p>IndexedDB is the store of record. Schema changes are versioned; every risky action is snapshotted.</p></div>
        <span class="badge badge--info" id="dbVersionBadge">Checking…</span>
      </div>
      <div id="dbStatus" class="mono" style="font-size:12px;color:var(--muted);line-height:1.8"></div>
      <details class="mt-3">
        <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:var(--muted)">Local snapshots</summary>
        <div id="localSnapshots" class="mt-2"></div>
        <button class="btn btn--sm btn--ghost mt-2" type="button" id="snapshotBtn" ${canBackup ? '' : 'disabled'}>
          ${icon('database', 14)} Take snapshot now
        </button>
      </details>
    </div>

    <div class="card card--pad" style="margin-bottom:18px">
      <div class="section-head" style="margin-bottom:12px">
        <div><h2 style="font-size:15px">Backup &amp; restore</h2>
          <p>Export the entire on-device database. Encrypt it before it leaves this shop.</p></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn--ghost" type="button" id="backupBtn" ${canBackup ? '' : 'disabled'}>
          ${icon('download', 16)} Plain JSON
        </button>
        <button class="btn btn--primary" type="button" id="encryptedBackupBtn" ${canBackup ? '' : 'disabled'}>
          ${icon('lock', 16)} Encrypted backup
        </button>
        <label class="btn btn--ghost" style="margin:0">
          ${icon('upload', 16)} Import backup
          <input type="file" id="backupFile" accept=".json,.dxnbak,application/json" hidden ${canBackup ? '' : 'disabled'}>
        </label>
      </div>
      <p style="font-size:11.5px;color:var(--faint);margin-top:8px">
        Encrypted files use AES-256-GCM with PBKDF2-SHA256 (210,000 iterations). The passphrase never leaves this device.
      </p>
    </div>

    <div class="card card--pad" style="margin-bottom:18px">
      <div class="section-head" style="margin-bottom:12px">
        <div><h2 style="font-size:15px">Sync conflicts</h2>
          <p>Two devices edited the same record. Choose which copy wins; the choice is audited.</p></div>
        <span class="badge badge--${store.state.conflicts.filter((c) => !c.resolved).length ? 'warn' : 'ok'}" id="conflictBadge">
          ${int(store.state.conflicts.filter((c) => !c.resolved).length)} open
        </span>
      </div>
      <div id="conflictList"></div>
    </div>

    <div class="card card--pad" style="margin-bottom:18px">
      <div class="section-head" style="margin-bottom:12px">
        <div><h2 style="font-size:15px">Audit log</h2>
          <p>Who did what, on this device and on the server.</p></div>
        <button class="btn btn--sm btn--ghost" type="button" id="auditRefresh" ${store.can('audit.view') ? '' : 'disabled'}>
          ${icon('refresh', 14)} Refresh
        </button>
      </div>
      <div id="auditList"></div>
    </div>

    ${canAdmin() ? `
      <div class="card card--pad" style="border-color:color-mix(in srgb, var(--danger) 35%, transparent)">
        <div class="section-head" style="margin-bottom:12px">
          <div><h2 style="font-size:15px">Server database snapshots</h2>
            <p>Pre-migration snapshots kept on the server. Rollback restores one atomically.</p></div>
        </div>
        <div id="serverSnapshots" class="mb-3"></div>
        <button class="btn btn--danger" type="button" id="resetBtn">${icon('trash', 16)} Reset this device</button>
      </div>
    ` : `
      <div class="card card--pad">
        <button class="btn btn--danger" type="button" id="resetBtn">${icon('trash', 16)} Reset this device</button>
      </div>
    `}
  `;
}

// ── Device & about ──────────────────────────────────────────────────────────

function deviceCard() {
  const { outbox, orders, products, rev, held } = store.state;
  return `
    <div class="card card--pad">
      <div class="section-head" style="margin-bottom:12px">
        <div><h2 style="font-size:15px">This device</h2><p>Offline cache, queued records and app installation.</p></div>
      </div>

      <div class="list" style="margin-bottom:14px">
        <div class="list__row">
          <div class="list__main"><div class="list__title">Cached data</div>
            <div class="list__sub">${int(products.length)} products · ${int(orders.length)} orders · revision ${int(rev)}</div></div>
          <button class="btn btn--sm btn--ghost" type="button" id="syncNowBtn">${icon('refresh', 14)} Sync now</button>
        </div>
        <div class="list__row">
          <div class="list__main"><div class="list__title">Queued records</div>
            <div class="list__sub">${outbox.length ? `${int(outbox.length)} waiting for the server` : 'Everything is pushed'}</div></div>
          ${outbox.length ? '<button class="btn btn--sm btn--ghost" type="button" id="retryQueueBtn">Retry</button>' : ''}
        </div>
        <div class="list__row">
          <div class="list__main"><div class="list__title">Held sales</div>
            <div class="list__sub">${held.length ? `${int(held.length)} parked mid-transaction` : 'Nothing parked'}</div></div>
        </div>
        <div class="list__row">
          <div class="list__main"><div class="list__title">Install as an app</div>
            <div class="list__sub">Adds an icon and works offline like a native app</div></div>
          <button class="btn btn--sm btn--ghost" type="button" id="installBtn">Install</button>
        </div>
      </div>
    </div>
  `;
}

function aboutCard() {
  return `
    <div class="card card--pad">
      <div class="section-head" style="margin-bottom:12px">
        <div><h2 style="font-size:15px">About Stockpoint</h2>
          <p>Mohammadpur Stock Point — one codebase, four offline-first clients.</p></div>
      </div>
      <div class="list">
        <div class="list__row"><div class="list__main">
          <div class="list__title">Web app</div>
          <div class="list__sub">Static PWA — host on GitHub Pages or any static server</div></div></div>
        <div class="list__row"><div class="list__main">
          <div class="list__title">Android apps</div>
          <div class="list__sub">Owner, customer, suite and standalone Stockpoint shells — signed releases</div></div></div>
        <div class="list__row"><div class="list__main">
          <div class="list__title">Local server</div>
          <div class="list__sub">Zero-dependency Node API included in <code>web-src/server/</code></div></div></div>
        <div class="list__row"><div class="list__main">
          <div class="list__title">Privacy</div>
          <div class="list__sub">What is stored, where it goes, how to delete it</div></div>
          <a class="btn btn--sm btn--ghost" href="privacy.html" target="_blank" rel="noopener">Read</a></div>
      </div>
    </div>
  `;
}

function signInCard(title, text) {
  return `
    <div class="card card--pad" style="max-width:560px;margin:20px auto;text-align:center">
      <div style="display:grid;place-items:center;margin-bottom:10px;color:var(--primary)">${icon('lock', 34)}</div>
      <h2 style="font-size:17px;font-weight:800;margin-bottom:6px">${esc(title)}</h2>
      <p style="font-size:13px;color:var(--muted);margin-bottom:16px">${esc(text)}</p>
      <button class="btn btn--primary btn--block" type="button" data-signin>${icon('user', 16)} Sign in with staff PIN</button>
    </div>
  `;
}

// ── Async panels ────────────────────────────────────────────────────────────

async function loadAsyncPanels(root) {
  root.querySelector('[data-signin]')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('dxn:login'));
  });

  await Promise.allSettled([
    loadDatabase(root),
    loadStaff(root),
    loadConflicts(root),
    loadAudit(root),
    loadServerSnapshots(root),
    loadCourier(root),
  ]);
}

async function loadDatabase(root) {
  const status = await store.databaseStatus().catch(() => null);
  if (!status) return;
  const badge = root.querySelector('#dbVersionBadge');
  if (badge) {
    badge.textContent = status.ready ? `v${status.version} · ready` : `v${status.version} · ${status.error || 'not ready'}`;
    badge.className = `badge badge--${status.ready ? 'ok' : 'warn'}`;
  }
  const target = root.querySelector('#dbStatus');
  if (target) {
    target.innerHTML = `
      <div>${status.available ? 'IndexedDB available' : 'IndexedDB unavailable — localStorage mirror only'}</div>
      <div>Migrations applied: ${status.migrated?.length ? esc(status.migrated.map((m) => m.name || m.version).join(', ')) : 'none pending'}</div>
      <div>Snapshots kept: ${int(status.snapshots?.length || 0)} · audit rows: ${int(store.state.audit.length)}</div>
    `;
  }
  paintSnapshots(root, status.snapshots || []);
}

function paintSnapshots(root, snapshots) {
  const target = root.querySelector('#localSnapshots');
  if (!target) return;
  target.innerHTML = snapshots.length ? `
    <div class="list">
      ${snapshots.map((snap) => `
        <div class="list__row">
          <div class="list__main">
            <div class="list__title">${esc(snap.label)} · ${esc(relTime(new Date(snap.at).toISOString()))}</div>
            <div class="list__sub mono">v${snap.version} · ${int(snap.counts?.orders || 0)} orders · ${int(snap.counts?.products || 0)} products</div>
          </div>
          <button class="btn btn--sm btn--ghost" type="button" data-rollback="${esc(snap.id)}" ${canAdmin() ? '' : 'disabled'}>Restore</button>
        </div>
      `).join('')}
    </div>
  ` : `<p style="font-size:12.5px;color:var(--muted)">No local snapshots yet. One is taken automatically before a reset or restore.</p>`;

  target.querySelectorAll('[data-rollback]').forEach((button) => {
    button.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: 'Restore this snapshot?',
        message: 'Current on-device data will be replaced. A fresh snapshot is taken first, so you can come back.',
        confirmLabel: 'Restore snapshot',
        danger: true,
      });
      if (!ok) return;
      try {
        await store.rollbackDatabase(button.dataset.rollback);
        toast('Snapshot restored.', 'ok');
        renderSettings(root);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
}

async function loadStaff(root) {
  const target = root.querySelector('#staffList');
  if (!target) return;
  let rows = store.state.remoteStaff;
  let remote = false;
  if (hasBase() && store.can('settings.view')) {
    try {
      const result = await api.staff();
      rows = result?.staff || rows;
      store.state.remoteStaff = rows;
      remote = true;
    } catch { /* fall back to the local staff list */ }
  }
  if (!rows.length) rows = store.state.staff;
  target.innerHTML = rows.length ? `
    <div class="list">
      ${rows.map((person) => `
        <div class="list__row">
          <div class="list__main">
            <div class="list__title">${esc(person.name)} ${person.bootstrap ? '<span class="badge badge--warn">default PIN</span>' : ''}</div>
            <div class="list__sub">${esc(ROLE_LABELS[person.role] || person.role)} · ${person.active === 0 || person.active === false ? 'Inactive' : 'Active'} · id ${esc(person.id)}</div>
          </div>
          ${canAdmin() ? `
            <select class="input" style="width:auto;max-width:130px" data-staff-role="${esc(person.id)}" ${remote ? '' : 'disabled'}>
              ${Object.values(ROLES).map((role) => `<option value="${role}" ${person.role === role ? 'selected' : ''}>${role}</option>`).join('')}
            </select>
            <button class="btn btn--sm btn--ghost" type="button" data-staff-pin="${esc(person.id)}" title="Set a new PIN">${icon('lock', 14)}</button>
            <button class="btn btn--sm btn--danger" type="button" data-staff-del="${esc(person.id)}" title="Remove">${icon('trash', 14)}</button>
          ` : ''}
        </div>
      `).join('')}
    </div>
  ` : emptyStaff();

  target.querySelectorAll('[data-staff-role]').forEach((select) => {
    select.addEventListener('change', async () => {
      const id = select.value === '' ? '' : select.dataset.staffRole;
      const role = select.value;
      try {
        const updated = await api.updateStaff(id, { role });
        store.state.remoteStaff = (store.state.remoteStaff || []).map((s) => (String(s.id) === String(id) ? updated.staff : s));
        toast('Role updated.', 'ok');
      } catch (error) {
        toast(error.message, 'error');
        loadStaff(root);
      }
    });
  });

  target.querySelectorAll('[data-staff-pin]').forEach((button) => {
    button.addEventListener('click', async () => {
      const pin = await confirmAction({
        title: 'Set a new PIN',
        message: 'Enter a new 4–8 digit PIN for this staff member.',
        confirmLabel: 'Set PIN',
        input: { label: 'New PIN', type: 'password', inputmode: 'numeric' },
      });
      if (!pin) return;
      if (!/^\d{4,8}$/.test(pin)) { toast('Use 4 to 8 digits.', 'error'); return; }
      const id = button.dataset.staffPin;
      try {
        if (remote) {
          await api.updateStaff(id, { pin });
        } else if (String(id) === 'owner') {
          await store.changeLocalPin(id, pin);
          store.state.staff = localStaff();
        } else {
          toast('Connect the server to change another person’s PIN.', 'error');
          return;
        }
        toast('PIN updated.', 'ok');
        loadStaff(root);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  target.querySelectorAll('[data-staff-del]').forEach((button) => {
    button.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: 'Remove this staff member?',
        message: 'Their PIN stops working immediately. Past actions stay in the audit log.',
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) return;
      const id = button.dataset.staffDel;
      try {
        if (remote) await api.deleteStaff(id);
        else removeLocalStaff(id);
        store.state.staff = localStaff();
        await loadStaff(root);
        toast('Staff member removed.', 'ok');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
}

function emptyStaff() {
  return `<p style="font-size:12.5px;color:var(--muted)">No staff accounts recorded on this device.</p>`;
}

function paintConflicts(root) {
  const target = root.querySelector('#conflictList');
  if (!target) return;
  const open = store.state.conflicts.filter((c) => !c.resolved);
  const all = store.state.conflicts;
  if (!all.length) {
    target.innerHTML = `<p style="font-size:12.5px;color:var(--muted)">No conflicts recorded. Every device agrees.</p>`;
    return;
  }
  target.innerHTML = `
    <div class="list">
      ${all.map((row) => `
        <div class="list__row">
          <div class="list__main">
            <div class="list__title">${esc(row.entity)} · ${esc(row.id_value || row.id)} ${row.resolved ? `<span class="badge badge--ok">${esc(row.choice || 'resolved')}</span>` : '<span class="badge badge--warn">Open</span>'}</div>
            <div class="list__sub mono" style="font-size:11px">
              device rev ${int(row.localRev)} vs server rev ${int(row.incomingRev)} · ${esc(relTime(row.at))}
            </div>
          </div>
          ${row.resolved ? '' : `
            <button class="btn btn--sm btn--ghost" type="button" data-resolve="${esc(row.key)}" data-choice="server">Keep server</button>
            <button class="btn btn--sm btn--primary" type="button" data-resolve="${esc(row.key)}" data-choice="device">Keep device</button>
          `}
        </div>
      `).join('')}
    </div>
    ${open.length ? '<p style="font-size:11.5px;color:var(--faint);margin-top:8px">Device copies are kept on-screen until you choose. Money ledgers are unioned so no payment is ever dropped.</p>' : ''}
  `;
  target.querySelectorAll('[data-resolve]').forEach((button) => {
    button.addEventListener('click', async () => {
      await store.resolveConflict(button.dataset.resolve, button.dataset.choice);
      toast(`Conflict resolved: kept ${button.dataset.choice} copy.`, 'ok');
      paintConflicts(root);
    });
  });
}

function paintAudit(root, entries) {
  const target = root.querySelector('#auditList');
  if (!target) return;
  if (!entries.length) {
    target.innerHTML = `<p style="font-size:12.5px;color:var(--muted)">No audit entries yet.</p>`;
    return;
  }
  target.innerHTML = `
    <div class="table-wrap" style="max-height:320px;overflow:auto">
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
        <tbody>
          ${entries.slice(0, 200).map((row) => `
            <tr>
              <td class="mono" style="font-size:11px;white-space:nowrap">${esc(fmtDateTime(row.at || row.created_at))}</td>
              <td style="font-size:12px">${esc(row.actor || 'system')}<div class="mono" style="color:var(--faint);font-size:10px">${esc(row.role || '')}</div></td>
              <td style="font-size:12px;font-weight:700">${esc(row.action)}</td>
              <td style="font-size:11.5px;color:var(--muted)">${esc(row.detail || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function loadConflicts(root) {
  paintConflicts(root);
}

async function loadAudit(root) {
  let rows = [...store.state.audit];
  if (hasBase() && store.can('audit.view')) {
    try {
      const result = await api.audit(200);
      const remote = (result?.entries || []).map((row) => ({ ...row, at: row.created_at || row.at }));
      rows = [...remote, ...rows].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    } catch { /* local audit remains visible */ }
  }
  paintAudit(root, rows);
}

async function loadServerSnapshots(root) {
  const target = root.querySelector('#serverSnapshots');
  if (!target || !canAdmin() || !hasBase()) return;
  try {
    const result = await api.snapshots();
    const rows = result?.snapshots || [];
    target.innerHTML = rows.length ? `
      <div class="list">
        ${rows.map((snap) => `
          <div class="list__row">
            <div class="list__main">
              <div class="list__title mono">${esc(snap.name)}</div>
              <div class="list__sub">v${snap.version} · ${int(snap.orders)} orders · ${int(snap.size / 1024)} KB · ${esc(fmtDateTime(snap.created_at))}</div>
            </div>
            <button class="btn btn--sm btn--danger" type="button" data-server-rollback="${esc(snap.name)}">Rollback</button>
          </div>
        `).join('')}
      </div>
    ` : `<p style="font-size:12.5px;color:var(--muted)">No pre-migration snapshots on the server yet.</p>`;
    target.querySelectorAll('[data-server-rollback]').forEach((button) => {
      button.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'Roll the server back?',
          message: `The live database will be replaced with ${button.dataset.serverRollback}. Take a backup first if you are unsure.`,
          confirmLabel: 'Roll back server',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.rollback(button.dataset.serverRollback);
          await store.syncNow({ quiet: true });
          toast('Server rolled back and devices refreshed.', 'ok');
          loadServerSnapshots(root);
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    });
  } catch (error) {
    target.innerHTML = `<p style="font-size:12.5px;color:var(--danger)">${esc(error.message)}</p>`;
  }
}

async function loadCourier(root) {
  const sfBadge = root.querySelector('#sfStatusBadge');
  if (!sfBadge || !hasBase() || !canManage()) return;
  try {
    const res = await api.courierSettings();
    const sf = res?.settings || {};
    const base = root.querySelector('#sfBase');
    const key = root.querySelector('#sfApiKey');
    const hook = root.querySelector('#sfWebhook');
    if (base) base.value = sf.base_url || 'https://portal.packzy.com/api/v1';
    if (key) key.value = sf.api_key || '';
    if (hook) hook.value = sf.webhook_token || '';
    if (sf.configured) {
      sfBadge.textContent = 'Configured';
      sfBadge.className = 'badge badge--ok';
    }
  } catch { /* leave the defaults in place */ }
}

// ── Bindings ────────────────────────────────────────────────────────────────

function bind(root) {
  hydrateIcons(root);

  root.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      root.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('is-active', t === tab));
      root.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.classList.toggle('is-active', panel.dataset.panel === activeTab);
      });
    });
  });

  const baseInput = root.querySelector('#apiBaseInput');

  root.querySelector('#probeBtn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const target = root.querySelector('#probeResult');
    button.disabled = true;
    const label = button.innerHTML;
    button.innerHTML = '<span class="spinner"></span> Testing…';
    try {
      const { base, health } = await api.probe(baseInput.value);
      const counts = health?.database?.counts || {};
      target.innerHTML = `
        <div style="color:var(--success);font-weight:700">Reachable: ${esc(base)}</div>
        <div>Version ${esc(health?.version || '?')} · driver ${esc(health?.driver || '?')} · status ${esc(health?.status || '?')}</div>
        <div>${int(counts.products || 0)} products · ${int(counts.orders || 0)} orders · revision ${int(health?.server_rev || 0)}</div>
        ${health?.installed === false ? '<div style="color:var(--warning)">Tables are not installed yet — open install.php on the server.</div>' : ''}
      `;
    } catch (error) {
      target.innerHTML = `<div style="color:var(--danger);font-weight:700">${esc(error.message)}</div>`;
    } finally {
      button.disabled = false;
      button.innerHTML = label;
    }
  });

  root.querySelector('#saveBaseBtn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const value = baseInput.value.trim();
    if (!value) { toast('Enter the API address first.', 'error'); return; }
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Connecting…';
    setBase(value);
    baseInput.value = getBase();
    try {
      await api.probe(getBase());
      await store.syncNow();
      toast('Connected — your catalogue is syncing.', 'ok');
      location.reload();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
      button.innerHTML = `${icon('check', 16)} Save &amp; sync`;
    }
  });

  root.querySelector('#seedBtn')?.addEventListener('click', async (event) => {
    const ok = await confirmAction({
      title: 'Seed demo data?',
      message: 'Adds sample products and orders to the connected server for testing. Nothing is deleted.',
      confirmLabel: 'Seed demo data',
    });
    if (!ok) return;
    event.currentTarget.disabled = true;
    try {
      await api.demoSeed();
      await store.syncNow({ quiet: true });
      toast('Demo data added.', 'ok');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  root.querySelector('#signInBtn')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('dxn:login'));
  });

  root.querySelector('#signOutBtn')?.addEventListener('click', async () => {
    await api.logout();
    store.setAdmin(false);
    toast('Signed out.');
    renderSettings(root);
  });

  root.querySelector('#changePinBtn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const pin = root.querySelector('#newPin').value.trim();
    const pin2 = root.querySelector('#newPin2').value.trim();
    if (!/^\d{4,8}$/.test(pin)) { toast('Use 4 to 8 digits.', 'error'); return; }
    if (pin !== pin2) { toast('The PINs do not match.', 'error'); return; }
    button.disabled = true;
    try {
      if (hasBase()) await api.changePin(pin);
      // Keep the offline fallback in step with the server PIN.
      const staff = store.state.staff.find((s) => s.bootstrap || s.role === store.state.role);
      if (staff) await store.changeLocalPin(staff.id, pin);
      root.querySelector('#newPin').value = '';
      root.querySelector('#newPin2').value = '';
      toast('PIN changed. New sign-ins use the new PIN.', 'ok');
    } catch (error) {
      toast(error.message || 'Could not change the PIN.', 'error');
    } finally {
      button.disabled = false;
    }
  });

  root.querySelector('#saveProfileBtn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const patch = {
      branch_name: root.querySelector('#setBranch').value.trim() || 'Mohammadpur Stock Point',
      whatsapp_number: digits(root.querySelector('#setWa').value),
      currency: (root.querySelector('#setCurrency').value || 'BDT').trim().toUpperCase().slice(0, 8),
      business_phone: root.querySelector('#setPhone').value.trim(),
      low_stock_threshold: Math.max(0, Math.round(num(root.querySelector('#setThreshold').value, 5))),
      business_address: root.querySelector('#setAddress').value.trim(),
      receipt_footer: root.querySelector('#setFooter').value.trim(),
      allow_public_orders: root.querySelector('#setPublicOrders').checked,
    };

    button.disabled = true;
    const label = button.innerHTML;
    button.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      if (hasBase()) {
        const result = await api.saveSettings(patch);
        const { admin_pin_hash, ...safe } = result?.settings || {};
        store.state.settings = { ...store.state.settings, ...safe, ...(result?.public || {}) };
      } else {
        store.state.settings = { ...store.state.settings, ...patch };
      }
      store.persistCache();
      store.notify();
      toast('Shop profile saved.', 'ok');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not save the profile.', 'error');
    } finally {
      button.disabled = false;
      button.innerHTML = label;
    }
  });

  root.querySelector('#staffAdd')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const name = root.querySelector('#staffName').value.trim();
    const role = root.querySelector('#staffRole').value;
    const pin = root.querySelector('#staffPin').value.trim();
    if (!name) { toast('Enter a staff name.', 'error'); return; }
    if (!/^\d{4,8}$/.test(pin)) { toast('Use a 4 to 8 digit PIN.', 'error'); return; }
    button.disabled = true;
    try {
      if (hasBase()) {
        await api.createStaff({ name, role, pin });
        const result = await api.staff();
        store.state.remoteStaff = result?.staff || [];
      } else {
        store.state.staff = [...store.state.staff, await addLocalStaff({ name, role, pin })];
      }
      root.querySelector('#staffName').value = '';
      root.querySelector('#staffPin').value = '';
      await loadStaff(root);
      toast('Staff member added.', 'ok');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  const sfBadge = root.querySelector('#sfStatusBadge');
  root.querySelector('#sfSaveBtn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Saving…';
    const body = {
      base_url: root.querySelector('#sfBase').value.trim(),
      api_key: root.querySelector('#sfApiKey').value.trim(),
      webhook_token: root.querySelector('#sfWebhook').value.trim(),
    };
    const secret = root.querySelector('#sfSecret').value.trim();
    if (secret) body.secret_key = secret;
    try {
      if (!hasBase()) throw new Error('Connect the shop server first.');
      await api.saveCourierSettings(body);
      toast('SteadFast credentials saved.', 'ok');
      sfBadge.textContent = 'Configured';
      sfBadge.className = 'badge badge--ok';
      root.querySelector('#sfSecret').value = '';
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not save SteadFast settings.', 'error');
    } finally {
      button.disabled = false;
      button.innerHTML = `${icon('check', 16)} Save credentials`;
    }
  });

  root.querySelector('#sfBalanceBtn')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const target = root.querySelector('#sfBalanceResult');
    button.disabled = true;
    try {
      if (!hasBase()) throw new Error('Connect the shop server first.');
      const res = await api.courierBalance();
      const bal = res?.balance?.current_balance;
      target.innerHTML = `<span style="color:var(--success);font-weight:700">Current balance: ${money(bal ?? 0)} BDT</span>`;
    } catch (error) {
      target.innerHTML = `<span style="color:var(--danger)">${esc(error.message || 'Could not fetch balance.')}</span>`;
    } finally {
      button.disabled = false;
    }
  });

  root.querySelector('#snapshotBtn')?.addEventListener('click', async () => {
    await store.snapshotDatabase('manual');
    toast('Snapshot taken.', 'ok');
    loadDatabase(root);
  });

  root.querySelector('#auditRefresh')?.addEventListener('click', async () => loadAudit(root));

  root.querySelector('#backupBtn')?.addEventListener('click', async () => {
    try {
      const payload = await store.backupDatabase();
      downloadFile(`dxn-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
      toast('Full database exported.', 'ok');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  root.querySelector('#encryptedBackupBtn')?.addEventListener('click', async (event) => {
    const passphrase = await confirmAction({
      title: 'Encrypt this backup',
      message: 'Choose a passphrase of at least 8 characters. You will need it to restore this file. It never leaves this device.',
      confirmLabel: 'Encrypt & download',
      input: { label: 'Backup passphrase', type: 'password' },
    });
    if (!passphrase) return;
    if (String(passphrase).length < 8) { toast('Use at least 8 characters.', 'error'); return; }
    event.currentTarget.disabled = true;
    try {
      const payload = await store.backupDatabase();
      const envelope = await encryptBackup(payload, passphrase);
      downloadFile(`dxn-backup-${new Date().toISOString().slice(0, 10)}.dxnbak`,
        JSON.stringify(envelope, null, 2), 'application/json');
      toast('Encrypted backup downloaded.', 'ok');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  root.querySelector('#backupFile')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    let text;
    try { text = await file.text(); } catch { toast('Could not read that file.', 'error'); return; }
    let payload;
    try {
      if (isEncryptedBackup(text)) {
        const passphrase = await confirmAction({
          title: 'Unlock this backup',
          message: 'Enter the passphrase used when the backup was created.',
          confirmLabel: 'Decrypt & restore',
          input: { label: 'Backup passphrase', type: 'password' },
        });
        if (!passphrase) return;
        payload = await decryptBackup(text, passphrase);
      } else {
        payload = JSON.parse(text);
      }
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    const ok = await confirmAction({
      title: 'Restore this backup?',
      message: 'All current on-device data will be replaced. A snapshot is taken first so you can roll back.',
      confirmLabel: 'Restore backup',
      danger: true,
    });
    if (!ok) return;
    try {
      await store.restoreDatabase(payload);
      toast('Backup restored.', 'ok');
      renderSettings(root);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      event.target.value = '';
    }
  });

  root.querySelector('#syncNowBtn')?.addEventListener('click', () => {
    if (!hasBase()) { toast('Connect the shop server first.', 'error'); return; }
    store.syncNow();
    toast('Syncing…');
  });

  root.querySelector('#retryQueueBtn')?.addEventListener('click', () => {
    store.retryAll();
    toast('Retrying queued records…');
  });

  root.querySelector('#installBtn')?.addEventListener('click', async () => {
    const prompt = window.__dxnInstallPrompt;
    if (!prompt) {
      openModal({
        title: 'Install on this device',
        body: `<p style="font-size:13.5px;line-height:1.7;color:var(--muted)">
          This browser has not offered an install prompt yet. On Android Chrome open the menu and choose
          <strong>Add to Home screen</strong>. On desktop Chrome use the install icon in the address bar.
          The signed Android APKs are also on the GitHub releases page.</p>`,
        footer: '<button class="btn btn--primary" type="button" data-close>Got it</button>',
      });
      return;
    }
    prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice?.outcome === 'accepted') toast('Installing…', 'ok');
    window.__dxnInstallPrompt = null;
  });

  root.querySelector('#resetBtn')?.addEventListener('click', async () => {
    const queued = store.state.outbox.length;
    const ok = await confirmAction({
      title: 'Reset this device?',
      message: `This clears the on-device catalogue, orders, audit and ${queued ? `${queued} unsent record(s)` : 'queued records'}. A snapshot is taken first, and the shop server is untouched.`,
      confirmLabel: 'Reset now',
      danger: true,
    });
    if (!ok) return;
    await store.resetDatabase();
    toast('Device reset. A snapshot is available in Data & audit.', 'ok');
    renderSettings(root);
  });
}
