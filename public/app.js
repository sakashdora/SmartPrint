import { paymentsPage, printersPage, securityPage, trackingPage, accountPage } from './workspaces.js';
import { watchUpdates, stopUpdates } from './live.js';
import { renderCustomer } from './customer.js';
import { downloadQrPoster } from './qr-poster.js';
import { downloadPdf } from './viewer.js';
import { icon, brand } from './ui.js';
import { ownerDashboard, adminDashboard } from './dashboards.js';
const app = document.querySelector('#app');
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const money = n => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(n / 100);
const time = value => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const statusLabels = { awaiting_payment: 'Awaiting payment', queued: 'Ready', awaiting_confirmation: 'Check output', needs_review: 'Needs review', payment_review: 'Payment review', bw: 'B&W', upi: 'UPI', cash: 'Cash', pending: 'Pending Approval', active: 'Approved & Active', suspended: 'Suspended' };
const badge = value => `<span class="badge ${escape(value)}">${escape(statusLabels[value] || value.replaceAll('_', ' '))}</span>`;
let health, me, receipt, transactionOffset = 0, queueFilter = 'all', shopFilter = 'all';
try { receipt = JSON.parse(sessionStorage.getItem('receipt') || 'null'); } catch { sessionStorage.removeItem('receipt'); }
let noticeTimer;
function notify(message) { document.querySelector('#notice').textContent = message; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => document.querySelector('#notice').textContent = '', 6500); }
async function api(path, { method = 'GET', body, token, binary, snapshot, headers = {} } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) {
    let errorMsg = 'Request failed.';
    let errorDetails = {};
    try {
      errorDetails = await response.json();
      errorMsg = errorDetails.error || errorDetails.message || errorMsg;
    } catch {}
    throw Object.assign(new Error(errorMsg), { status: response.status, details: errorDetails });
  }
  return snapshot ? { rows: await response.json(), until: response.headers.get('X-Snapshot-At') } : binary ? response.blob() : response.json();
}

function environmentLabel() {
  return health?.mode === 'production' ? '' : `<div class="demo">${health?.demo ? 'Local demo · Sample accounts and data' : 'Development · Connected database'}</div>`;
}

function header() {
  return `<header class="topbar">
    ${brand()}
    <nav class="toplinks" aria-label="Main navigation">
      <a href="#track" class="toplink-item">${icon('user')} <span>Track order</span></a>
      <a href="${me ? (me.role === 'admin' ? '#admin' : '#owner') : '#login'}" class="toplink-item">${icon('wallet')} <span>Workspace</span></a>
      ${me
        ? `<button class="link-button toplink-item" id="logout">${icon('logout')} <span>Sign out</span></button>`
        : `<a href="#login" class="toplink-item">${icon('logout')} <span>Sign in</span></a>`
      }
    </nav>
  </header>${environmentLabel()}`;
}
function mount(content, { workspacePage = false } = {}) { stopUpdates(); app.innerHTML = (workspacePage ? '' : header()) + content; document.querySelector('#logout')?.addEventListener('click', event => busy(event.currentTarget, async () => { await api('/api/auth/logout', { method: 'POST' }); me = null; location.hash = 'print'; await route(); })); }
async function busy(button, action) { button.disabled = true; try { await action(); } catch (error) { notify(error.message); } finally { button.disabled = false; } }
async function customer() { return renderCustomer({ api, mount, money, escape, health, notify, onOrder: result => { receipt = result; sessionStorage.setItem('receipt', JSON.stringify(result)); location.hash = 'track'; } }); }
async function tracking() { return trackingPage({ api, mount, money, escape, receipt, notify, refresh: route }); }
function workspace(content, active, admin = false) {
  const links = admin ? [['admin', 'Overview', 'home'], ['shops', 'Shops', 'shop'], ['audit', 'Audit log', 'clock'], ['account', 'Account', 'user']] : [['owner', 'Overview', 'home'], ['queue', 'Print queue', 'file'], ['transactions', 'Transactions', 'list'], ['payments', 'UPI payments', 'wallet'], ['printers', 'Printers', 'printer'], ['settings', 'Prices & QR', 'tag'], ['account', 'Account', 'user']];
  const title = links.find(link => link[0] === active)?.[1] || 'Overview';
  mount(`<div class="workspace"><aside class="sidebar"><div class="sidebar-brand">${brand()}<button id="nav-toggle" class="icon-button" aria-label="Toggle workspace navigation" aria-controls="workspace-nav" aria-expanded="false">${icon('menu')}</button></div><div class="workspace-nav" id="workspace-nav"><small class="nav-caption">${admin ? 'PLATFORM ADMIN' : 'SHOP WORKSPACE'}</small><nav aria-label="Workspace navigation">${links.map(([route, label, glyph]) => `<a href="#${route}" class="nav-link ${active === route ? 'active' : ''}" ${active === route ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></a>`).join('')}</nav><div class="sidebar-account"><span class="avatar">${admin ? 'AD' : 'SO'}</span><div><strong>${admin ? 'Administrator' : 'Shop owner'}</strong><a href="#account">Account settings</a></div><button class="icon-button" id="logout" aria-label="Sign out">${icon('logout')}</button></div>${environmentLabel()}</div></aside><main class="workmain"><div class="workspace-toolbar"><span>${admin ? 'Platform' : 'Workspace'} <span class="breadcrumb-divider">/</span> <strong>${title}</strong></span><span class="toolbar-date">${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span></div><div class="workspace-content">${content}</div></main></div>`, { workspacePage: true });
  const toggle = document.querySelector('#nav-toggle');
  toggle.onclick = () => { const open = toggle.getAttribute('aria-expanded') !== 'true'; toggle.setAttribute('aria-expanded', String(open)); document.querySelector('.sidebar').classList.toggle('is-open', open); };
  document.querySelector('.sidebar').onkeydown = event => { if (event.key === 'Escape') { toggle.setAttribute('aria-expanded', 'false'); document.querySelector('.sidebar').classList.remove('is-open'); toggle.focus(); } };
}

// Device heartbeats are strictly reported by the Windows Print Agent, not the web browser.

const directPrintedOrders = new Set();
async function triggerDirectPrint(id) {
  if (directPrintedOrders.has(id)) return;
  directPrintedOrders.add(id);
  try {
    await api(`/api/owner/orders/${id}/start`, { method: 'POST' }).catch(() => {});
    const blob = await downloadPdf(`/api/owner/orders/${id}/document`);
    const url = URL.createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.src = url;
    document.body.appendChild(iframe);
    iframe.onload = () => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch {
        window.open(url, '_blank');
      }
      setTimeout(() => { iframe.remove(); URL.revokeObjectURL(url); }, 60000);
    };
    notify('🖨️ Opening print dialog... Please confirm output.');
  } catch (err) {
    directPrintedOrders.delete(id);
    notify(err.message);
  }
}

async function owner(view) {
  if (!me) { location.hash = 'login'; return; } if (me.role === 'admin') { location.hash = 'admin'; return; }
  if (view === 'payments') return paymentsPage({ api, workspace, escape, notify });
  if (view === 'printers') return printersPage({ api, workspace, escape, notify });
  const load = () => Promise.all([api('/api/owner/shop'), api('/api/owner/orders'), api(`/api/owner/transactions?limit=100&offset=${transactionOffset}`), api('/api/owner/summary'), api('/api/owner/devices')]);
  const snapshot = await load(), [store, orders, transactions, summary, devices] = snapshot;
  const head = title => `<div class="workhead"><div><div class="heading-context">${escape(store.name)} ${badge(store.status)}</div><h1>${title}</h1><p class="muted">${view === 'owner' ? 'Keep the queue moving and every payment accounted for.' : view === 'queue' ? 'Review payments, follow progress and confirm printed pages.' : 'Manage your shop with clear, up-to-date records.'}</p></div><div class="actions"><button class="icon-button" id="reload" aria-label="Refresh workspace">${icon('refresh')}</button><button type="button" class="secondary" id="remote-print-btn">📤 Remote Print</button>${view !== 'settings' ? `<a class="primary" href="#settings">${icon('qr')} View shop QR</a>` : ''}</div></div>`;
  let content;
  if (view === 'settings') {
    const qr = await api('/api/owner/qr');
    content = `${head('Prices and shop QR')}<div class="grid"><section class="panel"><h2>Your print prices</h2><p class="muted">Per printed side. Two-up reduces sides; duplex reduces paper. Existing orders keep their quoted price.</p><form id="prices"><div class="fields"><label class="field">Black & white (₹)<input name="bw" type="number" min="0.01" max="1000" step="0.01" value="${store.bw / 100}" required></label><label class="field">Full colour (₹)<input name="color" type="number" min="0.01" max="1000" step="0.01" value="${store.color / 100}" required></label></div><button class="primary">Save prices</button><span class="muted"> Version ${store.version}</span></form><h2 class="spaced">Printer connection</h2><div class="notice-inline">Printers are managed from the Printers tab. Browser Direct printing and background spoolers print automatically.</div></section><section class="panel shop-qr-standee-card"><div class="qr-standee-header"><div class="qr-standee-badge">${icon('qr')} OFFICIAL COUNTER QR</div><h2 class="qr-standee-title">${escape(store.name)}</h2><p class="qr-standee-sub">Scan to print documents directly from your phone</p></div><div class="qr-code-frame"><div class="qr-corner top-left"></div><div class="qr-corner top-right"></div><div class="qr-corner bottom-left"></div><div class="qr-corner bottom-right"></div><img class="shop-counter-qr-img" data-url="${escape(qr.url)}" src="${qr.image}" alt="QR code for ${escape(store.name)}"></div><div class="qr-standee-steps"><div class="qr-step"><b>1</b> Scan QR</div><div class="qr-step"><b>2</b> Upload & Options</div><div class="qr-step"><b>3</b> Collect Print</div></div><div class="qr-standee-actions"><button type="button" class="primary" id="print-standee">${icon('printer')} Print Counter Standee</button><button type="button" class="secondary" id="download-qr-poster">${icon('download')} Download QR poster</button><button type="button" class="secondary" id="copy-shop-url">${icon('copy')} Copy Link</button><a class="secondary" href="/?shop=${encodeURIComponent(store.slug)}" target="_blank" rel="noopener">${icon('arrow')} Customer View ↗</a></div></section></div>`;
  } else if (view === 'transactions') {
    content = `${head('Transactions')}<p class="muted">Collected ${money(summary.collected)} · Refunded ${money(summary.refunded)} · Net ${money(summary.net)}. Updates every 5 seconds.</p><section class="panel"><div class="row"><h2>Collections · ${summary.transactions} total</h2><button id="export" class="secondary">Export CSV ↓</button></div>${transactions.length ? `<div class="table-wrap"><table><thead><tr><th>Transaction</th><th>Order</th><th>Method</th><th>Collected</th><th>Refunded</th><th>Time</th></tr></thead><tbody>${transactions.map(t => `<tr><td>${escape(t.id.slice(0, 8))}</td><td>#${escape(t.order_id.slice(0, 8))}</td><td>${badge(t.method)}</td><td>${money(t.amount)}</td><td>${money(t.refund_amount || 0)}</td><td>${time(t.created)}</td></tr>`).join('')}</tbody></table></div>` : empty('No payments yet.', 'Cash and verified UPI payments will appear here.')}</section><div class="row spaced"><button class="secondary" id="previous-transactions" ${transactionOffset === 0 ? 'disabled' : ''}>Previous</button><span>Page ${Math.floor(transactionOffset / 100) + 1}</span><button class="secondary" id="next-transactions" ${transactionOffset + 100 >= summary.transactions ? 'disabled' : ''}>Next</button></div>`;
  } else {
    content = ownerDashboard({ view, head, store, orders, summary, devices, filter: queueFilter, escape, money, time, badge, empty });
  }
  workspace(content, view);
  document.querySelector('#reload').onclick = () => route();
  document.querySelector('#remote-print-btn')?.addEventListener('click', () => {
    const dialog = document.createElement('dialog');
    dialog.className = 'crop-dialog remote-print-dialog';
    dialog.innerHTML = `
      <form id="remote-print-form" method="dialog">
        <h2>${icon('printer')} Remote Print to Shop</h2>
        <p class="muted">Submit a document directly from your authenticated device to your active shop printer.</p>
        <label class="field" style="margin: 14px 0;">
          Select PDF or Image:
          <input type="file" id="remote-file" accept=".pdf,.png,.jpg,.jpeg" required>
        </label>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px;">
          <label class="field">
            Colour Mode
            <select name="color">
              <option value="bw">Black & White</option>
              <option value="color">Full Colour</option>
            </select>
          </label>
          <label class="field">
            Sides
            <select name="duplex">
              <option value="false">One-sided (Simplex)</option>
              <option value="true">Both sides (Duplex)</option>
            </select>
          </label>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px;">
          <label class="field">
            Copies
            <input type="number" name="copies" min="1" max="100" value="1" required>
          </label>
          <label class="field">
            Page Range
            <input name="range" placeholder="All pages (e.g. 1-3)">
          </label>
        </div>
        <p class="inline-error" id="remote-error" role="alert"></p>
        <div class="actions" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px;">
          <button type="button" class="secondary" id="remote-cancel">Cancel</button>
          <button type="submit" class="primary" id="remote-submit">${icon('printer')} Send to Printer</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('#remote-cancel').onclick = () => { dialog.close(); dialog.remove(); };
    dialog.querySelector('#remote-print-form').onsubmit = async (e) => {
      e.preventDefault();
      const fileInput = dialog.querySelector('#remote-file');
      if (!fileInput.files.length) return;
      const file = fileInput.files[0];
      const submitBtn = dialog.querySelector('#remote-submit');
      const errEl = dialog.querySelector('#remote-error');
      errEl.textContent = '';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Preparing & Sending...';
      try {
        const formData = new FormData(e.target);
        const base64Data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = reader.result;
            resolve(res.slice(res.indexOf(',') + 1));
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const result = await api('/api/owner/print-job', {
          method: 'POST',
          body: {
            file: { data: base64Data, name: file.name },
            fileName: file.name,
            options: {
              color: formData.get('color'),
              duplex: formData.get('duplex') === 'true',
              copies: Number(formData.get('copies')) || 1,
              range: formData.get('range') || ''
            }
          }
        });
        notify(result.message || 'Remote print job submitted successfully!');
        dialog.close();
        dialog.remove();
        await owner(view);
      } catch (err) {
        errEl.textContent = err.message || 'Failed to submit remote print job.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send to Printer';
      }
    };
  });
  document.querySelectorAll('[data-queue-filter]').forEach(button => button.onclick = async () => { queueFilter = button.dataset.queueFilter; try { await owner(view); document.querySelector(`[data-queue-filter="${queueFilter}"]`)?.focus({ preventScroll: true }); } catch (error) { notify(error.message); } });
  document.querySelector('#review-payments')?.addEventListener('click', () => { queueFilter = 'attention'; if (view === 'queue') owner(view).catch(error => notify(error.message)); });
  const autoPrintInput = document.querySelector('#autoprint-mode');
  if (autoPrintInput) {
    autoPrintInput.onchange = (e) => {
      const enabled = e.target.checked;
      localStorage.setItem('smartprint_autoprint', enabled ? 'true' : 'false');
      notify(enabled ? '🖨️ Auto-Print activated: queued jobs print automatically.' : '⏸️ Auto-Print paused.');
      owner(view);
    };
  }
  document.querySelector('#prices')?.addEventListener('submit', event => { event.preventDefault(); busy(event.submitter, async () => { const form = new FormData(event.target); await api('/api/owner/prices', { method: 'PUT', body: { bw: Math.round(Number(form.get('bw')) * 100), color: Math.round(Number(form.get('color')) * 100) } }); notify('Prices updated for new quotes.'); await owner(view); }); });
  document.querySelector('#print-standee')?.addEventListener('click', () => { window.print(); });
  document.querySelector('#download-qr-poster')?.addEventListener('click', event => busy(event.currentTarget, async () => {
    const qr = await api('/api/owner/qr');
    await downloadQrPoster(store, qr);
  }));
  document.querySelector('#copy-shop-url')?.addEventListener('click', () => {
    const shopUrl = document.querySelector('.shop-counter-qr-img').dataset.url;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(shopUrl).then(() => notify('Shop QR link copied to clipboard!')).catch(() => notify('Link: ' + shopUrl));
    } else {
      notify('Link: ' + shopUrl);
    }
  });
  document.querySelector('#previous-transactions')?.addEventListener('click', () => { transactionOffset = Math.max(0, transactionOffset - 100); owner(view); });
  document.querySelector('#next-transactions')?.addEventListener('click', () => { transactionOffset += 100; owner(view); });
  if (['owner','queue','transactions'].includes(view)) {
    watchUpdates(load, snapshot, (nextSnapshot) => {
      if (nextSnapshot && Array.isArray(nextSnapshot[1])) {
        const nextOrders = nextSnapshot[1];
        const prevQueued = orders.filter(o => o.status === 'queued').length;
        const nextQueued = nextOrders.filter(o => o.status === 'queued').length;
        if (nextQueued > prevQueued) {
          try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(587.33, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.18, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.4);
          } catch {}
          notify('🔔 New print order received in queue!');

          const autoPrint = typeof localStorage !== 'undefined' && localStorage.getItem('smartprint_autoprint') !== 'false';
          if (autoPrint) {
            const newlyQueued = nextOrders.filter(o => o.status === 'queued' && !directPrintedOrders.has(o.id));
            const onlineDevs = (nextSnapshot[4] || []).filter(d => d.active && d.heartbeat && (Date.now() - Date.parse(d.heartbeat) < 180000));
            if (onlineDevs.length === 0 && newlyQueued.length > 0) {
              for (const o of newlyQueued) {
                triggerDirectPrint(o.id);
              }
            }
          }
        }
      }
      owner(view);
    });
  }
  document.querySelector('#export')?.addEventListener('click', event => busy(event.currentTarget, async () => {
    const all = []; let until; for (let offset = 0; ; offset += 200) { const page = await api(`/api/owner/transactions?limit=200&offset=${offset}${until ? '&until=' + encodeURIComponent(until) : ''}`, { snapshot: true }); until = page.until; all.push(...page.rows); if (page.rows.length < 200) break; } const rows = [['Transaction', 'Order', 'Method', 'Amount INR', 'Refund INR', 'Created'], ...all.map(t => [t.id, t.order_id, t.method, (t.amount / 100).toFixed(2), ((t.refund_amount || 0) / 100).toFixed(2), t.created])]; const url = URL.createObjectURL(new Blob([rows.map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n')], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = 'smartprint-transactions.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }));
  document.querySelectorAll('[data-action]').forEach(button => button.onclick = () => busy(button, async () => {
    const { action, id } = button.dataset;
    if (action === 'print-direct') {
      await triggerDirectPrint(id);
      await owner(view);
      return;
    }
    if (action === 'document') { const blob = await downloadPdf(`/api/owner/orders/${id}/document`); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `smartprint-${id.slice(0,8)}.pdf`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 300000); return; }
    if (action === 'complete' && !confirm('Have you checked that all pages printed successfully? This permanently deletes the live file.')) return;
    if (action === 'resolve-failed' && !confirm('Check the printed pages and cancel any remaining job in the Windows print queue first. Confirm this order was not fulfilled and printing has stopped.')) return;
    let reference;
    if (action === 'upi-confirm') { reference = prompt('Check the credit in your OWN UPI or bank app, then enter its 12-digit reference:'); if (!reference) return; }
    if (action === 'refund') { reference = prompt('Return the money first. Enter the refund reference (or cash receipt reference):'); if (!reference) return; }
    if (action === 'cancel' && !confirm('Cancel this order and delete its file? Any collected payment still needs a refund.')) return;
    await api(`/api/owner/orders/${id}/${action}`, { method: 'POST', body: { confirmed: true, reference } });
    const actionMessages = {
      complete: 'Print confirmed. Live file securely deleted.',
      priority: '⚡ Job marked as Rush & moved to front of queue!',
      retry: '🔄 Job re-queued for printer.',
      start: 'Print started. File ready for printing.',
      cash: 'Cash payment collected. Order moved to print queue.',
      'upi-confirm': 'UPI payment confirmed. Order moved to print queue.',
      'resolve-failed': 'Print marked as stopped/failed. File retained for refund/retry.',
      cancel: 'Order cancelled and file deleted.',
      refund: 'Refund recorded.'
    };
    notify(actionMessages[action] || 'Order updated.');
    await owner(view);
  }));
}
function empty(title, body) { return `<div class="empty"><strong>${title}</strong><span class="muted">${body}</span></div>`; }
async function admin(view) {
  if (!me) { location.hash = 'login'; return; }
  if (me.role !== 'admin') { location.hash = 'owner'; return; }
  if (me.mfaRequired) { location.hash = 'security'; return; }
  const load = () => Promise.all([api('/api/admin/shops'), api('/api/admin/audit')]);
  const snapshot = await load(), [shops, events] = snapshot;
  let content;
  if (view === 'audit') content = `<div class="workhead"><div><h1>Audit log</h1><p class="muted">A record of shop access, payments and print fulfilment.</p></div><button class="secondary" id="admin-refresh">${icon('refresh')} Refresh</button></div><section class="panel"><div class="panel-heading"><h2>Recent events</h2><span class="muted">Latest 100</span></div>${events.length ? `<div class="table-wrap"><table><thead><tr><th>Action</th><th>Actor</th><th>Target</th><th>Time</th></tr></thead><tbody>${events.map(e => `<tr><td>${escape(e.action)}</td><td>${escape(e.actor.slice(0, 12))}</td><td>${escape(e.target.slice(0, 12))}</td><td>${time(e.created)}</td></tr>`).join('')}</tbody></table></div>` : empty('No events yet.', 'Administrative and fulfilment actions appear here.')}</section>`;
  else content = adminDashboard({ view, shops, events, filter: shopFilter, escape, badge, time, empty });
  workspace(content, view, true);
  document.querySelector('#admin-refresh').onclick = () => route();
  document.querySelectorAll('[data-shop-filter]').forEach(button => button.onclick = async () => { shopFilter = button.dataset.shopFilter; try { await admin(view); document.querySelector(`[data-shop-filter="${shopFilter}"]`)?.focus({ preventScroll: true }); } catch (error) { notify(error.message); } });
  document.querySelector('#review-shops')?.addEventListener('click', () => { shopFilter = 'pending'; });
  document.querySelectorAll('[data-shop]').forEach(button => button.onclick = () => busy(button, async () => { if (button.dataset.status === 'suspended' && !confirm('Suspend this shop? It will no longer accept new orders.')) return; await api(`/api/admin/shops/${button.dataset.shop}/status`, { method: 'POST', body: { status: button.dataset.status } }); notify('Shop status updated.'); await admin(view); }));
  watchUpdates(load, snapshot, () => admin(view));
}

function auth(register = false) {
  mount(`<main class="auth panel">
    <span class="eyebrow">${register ? 'JOIN SMARTPRINT' : 'WELCOME BACK'}</span>
    <h1>${register ? 'Register your shop' : 'Sign in'}</h1>
    <p class="muted">${register ? 'Register your shop. Set your prices. Start printing after admin approval.' : 'Sign in to access your shop workspace or administration platform.'}</p>
    <form id="auth-form">
      ${register ? '<label class="field">Shop name<input name="name" required maxlength="100" autocomplete="organization"></label><label class="field">Shop location<input name="location" required maxlength="200" autocomplete="street-address"></label>' : ''}
      <label class="field">Email<input name="email" type="email" required autocomplete="username"></label>
      <label class="field">Password<input name="password" type="password" required minlength="${register ? 12 : 1}" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}"></label>
      ${!register ? '<label class="field">Authenticator code (if enabled)<input name="code" inputmode="numeric" maxlength="19" placeholder="6-digit code or recovery code" autocomplete="one-time-code"></label>' : ''}
      <button class="primary wide">${register ? 'Register shop →' : 'Sign in →'}</button>
      ${!register ? '<button type="button" class="secondary wide" id="passkey-login" style="margin-top: 10px;">🔑 Sign in with Passkey</button>' : ''}
    </form>
    ${!register && health?.demo ? '<div class="notice-inline">Local demo environment active. Sign in with your registered account credentials.</div>' : ''}
    <p class="foot"><a href="${register ? '#login' : '#register'}">${register ? 'Already registered? Sign in' : 'New here? Register your shop'}</a></p>
  </main>`);

  document.querySelector('#auth-form').onsubmit = event => {
    event.preventDefault();
    busy(event.submitter, async () => {
      const data = Object.fromEntries(new FormData(event.target));
      if (register) {
        const result = await api('/api/auth/register', { method: 'POST', body: data });
        notify(result.message);
        location.hash = 'login';
      } else {
        const user = await api('/api/auth/login', {
          method: 'POST',
          body: { email: data.email, password: data.password, code: data.code || undefined }
        });
        me = user;
        location.hash = me.mfaRequired ? 'security' : (me.role === 'admin' ? 'admin' : 'owner');
      }
    });
  };

  const passkeyBtn = document.querySelector('#passkey-login');
  if (passkeyBtn) {
    passkeyBtn.onclick = () => busy(passkeyBtn, async () => {
      const email = document.querySelector('[name=email]').value.trim();
      const browser = window.SimpleWebAuthnBrowser;
      if (!browser || !browser.browserSupportsWebAuthn()) {
        throw new Error('Passkeys/WebAuthn is not supported in this browser.');
      }
      const options = await api('/api/auth/webauthn/auth-options', { method: 'POST', body: { email: email || undefined } });
      const assertion = await browser.startAuthentication({ optionsJSON: options });
      const user = await api('/api/auth/webauthn/auth-verify', {
        method: 'POST',
        body: { response: assertion, challengeKey: options.challengeKey }
      });
      me = user;
      notify('Signed in with Passkey!');
      location.hash = me.mfaRequired ? 'security' : (me.role === 'admin' ? 'admin' : 'owner');
    });
  }
}

async function route() {
  try {
    const view = location.hash.slice(1) || 'print';
    if (view === 'login' || view === 'admin-login') {
      if (me) {
        location.hash = me.mfaRequired ? 'security' : (me.role === 'admin' ? 'admin' : 'owner');
        return;
      }
      auth(false);
      return;
    }
    if (view === 'register') {
      auth(true);
      return;
    }
    if (me?.mfaRequired || view === 'security') {
      return securityPage({
        api,
        mount,
        escape,
        notify,
        onVerified: user => {
          me = user;
          location.hash = user.role === 'admin' ? 'admin' : 'owner';
          route();
        }
      });
    }
    if (view === 'account') {
      if (!me) { location.hash = 'login'; return; }
      return accountPage({
        api,
        workspace,
        notify,
        admin: me.role === 'admin',
        onSignedOut: () => { me = null; location.hash = 'login'; }
      });
    }
    if (view === 'print') await customer();
    else if (view === 'track') await tracking();
    else if (['owner', 'queue', 'settings', 'transactions', 'payments', 'printers'].includes(view)) await owner(view);
    else if (['admin', 'shops', 'audit'].includes(view)) await admin(view);
    else auth(false);
  } catch (error) {
    mount(`<main class="container"><section class="panel"><h1>We couldn’t open this page.</h1><p class="error">${escape(error.message)}</p><a href="#login">Sign in</a> · <a href="#print">Try your shop again</a></section></main>`);
  }
}
window.addEventListener('hashchange', async () => { stopUpdates(); await route(); window.scrollTo(0, 0); });
try { [health, me] = await Promise.all([api('/api/health'), api('/api/me')]); await route(); } catch (error) { app.textContent = `Unable to connect: ${error.message}`; }


