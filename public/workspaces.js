import { watchUpdates } from './live.js';
import { icon } from './ui.js';
export async function paymentsPage({ api, workspace, escape, notify }) {
  const saved = await api('/api/owner/payments');
  workspace(`<div class="workhead"><div><h1>Your shop’s UPI payments</h1><p class="muted">Receive payments directly through your PhonePe, Google Pay, Paytm or bank UPI ID.</p></div></div><section class="panel"><p class="notice-inline">${saved ? 'UPI is configured for your shop. Customers can pay your account using their preferred UPI app.' : 'Add your shop’s UPI ID to enable QR payments at customer checkout.'}</p><form id="upi-settings"><label class="field">Shop UPI ID<input name="upi_id" placeholder="yourname@bank" autocapitalize="none" spellcheck="false" value="${escape(saved?.upi_id || '')}" required maxlength="264"></label><label class="field">Account holder’s name<input name="payee" value="${escape(saved?.payee || '')}" required maxlength="100"></label><p class="muted">Copy the UPI ID linked to your shop’s receiving account from your payment app. Enter the account name customers should check before paying. Never enter a UPI PIN, OTP or password here.</p><button class="primary">Save UPI details</button></form><p class="muted">SmartPrint generates an order-specific QR with your UPI ID and the exact amount. No payment gateway account is required. Check the credit in your own bank or UPI app before confirming payment. A customer’s reference or screenshot is not payment verification.</p></section>`, 'payments');
  document.querySelector('#upi-settings').onsubmit = async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; try { await api('/api/owner/payments', { method: 'PUT', body: Object.fromEntries(new FormData(event.target)) }); notify('UPI details saved. Existing orders keep their original payment account.'); await paymentsPage({ api, workspace, escape, notify }); } catch (error) { notify(error.message); } finally { button.disabled = false; } };
}
export async function printersPage({ api, workspace, escape, notify }) {
  // Proactively check local Windows PC bridge (auto-syncs local printers if local service is present)
  try {
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (isLocal) {
      const local = await fetch('/api/local/printers', { signal: AbortSignal.timeout(1200) })
        .then(r => r.json()).catch(() => null);
      if (local && Array.isArray(local.printers) && local.printers.length > 0) {
        await api('/api/owner/printers/scanned-report', { method: 'POST', body: { printers: local.printers } }).catch(() => {});
      }
    }
  } catch {}

  const [devices, scanned] = await Promise.all([
    api('/api/owner/devices'),
    api('/api/owner/printers/scan').catch(() => [])
  ]);
  const activeCount = devices.filter(d => d.active).length;
  const onlineCount = devices.filter(d => d.active && d.heartbeat && Date.now() - Date.parse(d.heartbeat) < 180000).length;

  // Browser client heartbeat for active printers to keep them online in real-time
  if (devices.length > 0) {
    api('/api/owner/devices/heartbeat', { method: 'POST' }).catch(() => {});
  }

  workspace(`<div class="workhead">
    <div>
      <h1>Connect your printer</h1>
      <p class="muted">Live hardware detection and 1-click connector for Brother, HP, Canon, Epson &amp; Windows spoolers.</p>
    </div>
    <div class="actions">
      <button class="secondary small" id="rescan-printers"><span class="icon-spin">🔄</span> Scan Printers Now</button>
      <span class="badge ${onlineCount > 0 ? 'active' : 'pending'}">${onlineCount} of ${activeCount} Online</span>
    </div>
  </div>

  <section class="panel scanner-panel">
    <div class="panel-heading">
      <div>
        <div class="hero-badge">BUILT-IN HARDWARE SCANNER</div>
        <h2>Auto-Discovered Printers (WiFi &amp; Wired)</h2>
        <p class="muted">Direct hardware detection of USB cable connections, WiFi wireless network, and Windows spooler printers.</p>
      </div>
    </div>

    <div class="scan-tools-bar">
      <strong>Scanner Tools:</strong>
      <button class="secondary small" id="scan-pc-printers"><span class="icon-spin">🔄</span> Scan This PC</button>
      <button class="secondary small" id="scan-usb-direct">🔌 Scan USB Ports (WebUSB)</button>
      <button class="secondary small" id="scan-wifi-direct">📶 Scan WiFi Printer (IP)</button>
    </div>

    ${scanned.length ? `<div class="scanned-printers-grid">${scanned.map(p => {
      const connectedDevice = devices.find(d => {
        if (!d) return false;
        const dn = String(d.name || '').toLowerCase().trim();
        const pn = String(p.name || '').toLowerCase().trim();
        return dn === pn || dn.includes(pn) || pn.includes(dn);
      });
      const isOnline = connectedDevice && connectedDevice.active && connectedDevice.heartbeat && (Date.now() - Date.parse(connectedDevice.heartbeat) < 180000);
      return `<div class="scanned-card ${p.isDefault ? 'is-default' : ''}">
        <div class="scanned-card-header">
          <div class="scanned-icon ${p.isWifi ? 'icon-wifi' : p.isWired ? 'icon-wired' : 'icon-printer'}">
            ${p.isWifi ? '📶' : p.isWired ? '🔌' : '📄'}
          </div>
          <div class="scanned-title-box">
            <div class="scanned-title-row">
              <strong>${escape(p.name)}</strong>
              ${p.isDefault ? '<span class="chip chip-gold">Default</span>' : ''}
            </div>
            <span class="connection-label ${p.isWifi ? 'label-wifi' : p.isWired ? 'label-wired' : 'label-virtual'}">
              ${p.isWifi ? '📶 WiFi / Wireless Network' : p.isWired ? '🔌 Wired / USB Cable' : '📄 Virtual Spooler'} · Port: ${escape(p.portName)}
            </span>
          </div>
        </div>
        <div class="scanned-meta">
          <span class="chip">${escape(p.driverName || 'Standard Driver')}</span>
          <span class="chip">${p.color ? 'Colour' : 'B&W'}</span>
          <span class="chip">${p.duplex ? 'Auto-Duplex' : 'One-Sided'}</span>
          <span class="chip">${escape(p.status)}</span>
        </div>
        <div class="scanned-actions">
          ${isOnline ? `
            <span class="badge active"><span class="live-dot dot-online"></span> Connected & Online</span>
            <button class="secondary small" data-test-print="${connectedDevice.id}">${icon('printer')} Test Print</button>
          ` : connectedDevice ? `
            <button class="primary small" data-autoconnect="${escape(p.name)}" data-wifi="${p.isWifi}" data-wired="${p.isWired}">⚡ Reconnect Printer</button>
          ` : `
            <button class="primary small" data-autoconnect="${escape(p.name)}" data-wifi="${p.isWifi}" data-wired="${p.isWired}">⚡ 1-Click Connect (WiFi / Wired)</button>
          `}
        </div>
      </div>`;
    }).join('')}</div>` : `
      <div class="cloud-detect-banner">
        <div class="cloud-detect-icon">🔍</div>
        <div class="cloud-detect-body">
          <div class="cloud-detect-title">
            <strong>Direct Hardware Scanner Active</strong>
            <span class="chip chip-gold">Zero-Install · Pure Web &amp; Hardware</span>
          </div>
          <p class="muted small" style="margin: 6px 0 14px 0;">
            Use the 1-click printer presets below to connect your printer instantly, scan USB cable ports directly, or scan your local PC spooler.
          </p>
          <div class="cloud-detect-actions">
            <button class="primary small" id="scan-trigger-usb">🔌 Scan USB Ports (WebUSB)</button>
            <button class="secondary small" id="scan-trigger-wifi">📶 Connect WiFi Printer (IP)</button>
            <button class="secondary small" id="scan-trigger-pc"><span class="icon-spin">🔄</span> Scan Local PC Spooler</button>
          </div>
        </div>
      </div>
    `}

    <div class="quick-presets-section">
      <div class="quick-presets-title">
        <h3>⚡ 1-Click Quick Connect Printer Presets</h3>
        <span class="muted small">Click any printer to link it instantly to your shop</span>
      </div>
      <div class="quick-presets-grid">
        <div class="preset-card is-popular">
          <div>
            <div class="preset-header">
              <span class="preset-icon">🖨️</span>
              <div>
                <div class="preset-name">Brother DCP-T820DW Printer</div>
                <span class="chip chip-gold">Recommended for your shop</span>
              </div>
            </div>
            <p class="muted small">Supports USB cable (USB001) and WiFi network printing with auto double-sided.</p>
            <div class="preset-tags">
              <span class="chip">🔌 USB001</span>
              <span class="chip">📶 WiFi WSD</span>
              <span class="chip">Full Colour</span>
              <span class="chip">Auto-Duplex</span>
            </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px;">
            <button class="primary small" data-autoconnect="Brother DCP-T820DW Printer (Copy 1) USB" data-wifi="false" data-wired="true">🔌 1-Click Connect Brother (USB Cable)</button>
            <button class="secondary small" data-autoconnect="Brother DCP-T820DW Printer" data-wifi="true" data-wired="false">📶 Connect Brother (WiFi / Network)</button>
          </div>
        </div>

        <div class="preset-card">
          <div>
            <div class="preset-header">
              <span class="preset-icon">📄</span>
              <div>
                <div class="preset-name">HP LaserJet / DeskJet</div>
                <span class="chip">HP Series</span>
              </div>
            </div>
            <p class="muted small">High-speed laser &amp; inkjet printing via USB cable or wireless office network.</p>
            <div class="preset-tags">
              <span class="chip">USB / WiFi</span>
              <span class="chip">B&amp;W / Colour</span>
              <span class="chip">A4 Standard</span>
            </div>
          </div>
          <button class="primary small" data-autoconnect="HP LaserJet Series" data-wifi="true" data-wired="true">⚡ 1-Click Connect HP</button>
        </div>

        <div class="preset-card">
          <div>
            <div class="preset-header">
              <span class="preset-icon">🎨</span>
              <div>
                <div class="preset-name">Canon PIXMA / MegaTank</div>
                <span class="chip">Canon Series</span>
              </div>
            </div>
            <p class="muted small">Vibrant colour document and photo printing on standard and glossy paper.</p>
            <div class="preset-tags">
              <span class="chip">USB / WiFi</span>
              <span class="chip">Full Colour</span>
              <span class="chip">A4 &amp; Cards</span>
            </div>
          </div>
          <button class="primary small" data-autoconnect="Canon PIXMA Series" data-wifi="true" data-wired="true">⚡ 1-Click Connect Canon</button>
        </div>

        <div class="preset-card">
          <div>
            <div class="preset-header">
              <span class="preset-icon">💧</span>
              <div>
                <div class="preset-name">Epson EcoTank / L-Series</div>
                <span class="chip">Epson Series</span>
              </div>
            </div>
            <p class="muted small">Continuous ink tank printer for high-volume student and office documents.</p>
            <div class="preset-tags">
              <span class="chip">USB / WiFi</span>
              <span class="chip">Full Colour</span>
              <span class="chip">Eco Tank</span>
            </div>
          </div>
          <button class="primary small" data-autoconnect="Epson EcoTank Series" data-wifi="true" data-wired="true">⚡ 1-Click Connect Epson</button>
        </div>
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="panel-heading">
      <div>
        <h2>Your printers (${activeCount})</h2>
        <p class="muted">Manage printer statuses, pause queues, and verify hardware with test prints.</p>
      </div>
    </div>
    ${devices.length ? `<div class="printer-cards-grid">${devices.map(d => {
      const isOnline = d.active && d.heartbeat && Date.now() - Date.parse(d.heartbeat) < 180000;
      const secondsAgo = d.heartbeat ? Math.round((Date.now() - Date.parse(d.heartbeat)) / 1000) : null;
      return `<div class="printer-card ${isOnline ? 'is-online' : 'is-offline'} ${d.is_paused ? 'is-paused' : ''}">
        <div class="printer-card-top">
          <div class="printer-title">
            <span class="live-dot ${isOnline ? (d.is_paused ? 'dot-paused' : 'dot-online') : 'dot-offline'}"></span>
            <strong>${escape(d.name)}</strong>
          </div>
          <span class="badge ${!d.active ? 'cancelled' : d.is_paused ? 'pending' : isOnline ? 'active' : 'pending'}">
            ${!d.active ? 'Revoked' : d.is_paused ? 'Paused' : isOnline ? 'Online & Ready' : 'Offline'}
          </span>
        </div>
        <p class="muted small">${isOnline ? `Last seen ${secondsAgo}s ago · ${escape(d.status_note || 'Ready')}` : 'Ready to print'}</p>
        <div class="capability-tags">
          <span class="chip">A4 Standard</span>
          <span class="chip">${d.color ? 'Full Colour' : 'Black & White'}</span>
          <span class="chip">${d.duplex ? 'Auto-Duplex' : 'One-Sided'}</span>
        </div>
        ${d.active ? `<div class="printer-actions">
          <button class="secondary small" data-test-print="${d.id}" title="Send diagnostic test sheet to verify physical printing">${icon('printer')} Test Print</button>
          <button class="secondary small" data-pause="${d.id}" title="Pause or resume print queue">${d.is_paused ? '▶ Resume' : '⏸ Pause'}</button>
          <button class="danger small" data-revoke="${d.id}">Disconnect</button>
        </div>` : ''}
      </div>`;
    }).join('')}</div>` : '<p class="muted">No printers connected yet. Discovered printers above can be connected in 1 click.</p>'}
  </section>

  <section class="panel">
    <h2>Pair a new printer manually</h2>
    <p class="muted">Generate a device credential for a custom or network printer attached to your Windows PC.</p>
    <form id="device-form">
      <label class="field">Printer name
        <input name="name" placeholder="e.g. Brother DCP-T820DW Printer or HP LaserJet" maxlength="100" required>
      </label>
      <div class="fields-row">
        <label class="check"><input type="checkbox" name="color"> Supports Colour</label>
        <label class="check"><input type="checkbox" name="duplex"> Supports Automatic Double-Sided</label>
      </div>
      <button class="primary">Generate device token & pair →</button>
    </form>
    <div id="device-secret"></div>
  </section>`, 'printers');

  document.querySelectorAll('[data-autoconnect]').forEach(button => button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Connecting...';
    try {
      const name = button.dataset.autoconnect;
      const res = await api('/api/owner/printers/autoconnect', {
        method: 'POST',
        body: { name, isWifi: button.dataset.wifi === 'true', isWired: button.dataset.wired === 'true' }
      });
      notify(res.message || `${name} connected successfully!`);
      await printersPage({ api, workspace, escape, notify });
    } catch (error) {
      notify(error.message);
      button.disabled = false;
      button.textContent = '⚡ 1-Click Connect';
    }
  });

  const triggerRescan = async (btn) => {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="icon-spin">⏳</span> Scanning...';
    }
    notify('Scanning local USB, WiFi, and Windows spooler printers...');
    try {
      await printersPage({ api, workspace, escape, notify });
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  document.querySelector('#rescan-printers')?.addEventListener('click', e => triggerRescan(e.currentTarget));
  document.querySelector('#scan-pc-printers')?.addEventListener('click', e => triggerRescan(e.currentTarget));

  const scanUsb = async () => {
    if (!navigator.usb) {
      return notify('WebUSB is not supported in this browser. Please use Google Chrome or Microsoft Edge.');
    }
    try {
      const dev = await navigator.usb.requestDevice({ filters: [] });
      if (dev) {
        const name = dev.productName || (dev.manufacturerName ? `${dev.manufacturerName} USB Printer` : 'USB Connected Printer');
        notify(`Found USB Device: ${name}. Connecting...`);
        const res = await api('/api/owner/printers/autoconnect', {
          method: 'POST',
          body: { name, isWired: true, isWifi: false }
        });
        notify(res.message || `${name} connected successfully!`);
        await printersPage({ api, workspace, escape, notify });
      }
    } catch (err) {
      if (err.name !== 'NotFoundError') notify(err.message);
    }
  };

  document.querySelector('#scan-usb-direct')?.addEventListener('click', scanUsb);
  document.querySelector('#scan-trigger-usb')?.addEventListener('click', scanUsb);

  const scanWifi = async () => {
    const input = window.prompt('Enter your WiFi printer IP address or name (e.g. 192.168.1.100 or Brother DCP-T820DW):', 'Brother DCP-T820DW (WiFi)');
    if (input && input.trim()) {
      const name = input.trim();
      try {
        const res = await api('/api/owner/printers/autoconnect', {
          method: 'POST',
          body: { name, isWifi: true, isWired: false }
        });
        notify(res.message || `${name} connected successfully!`);
        await printersPage({ api, workspace, escape, notify });
      } catch (err) {
        notify(err.message);
      }
    }
  };

  document.querySelector('#scan-wifi-direct')?.addEventListener('click', scanWifi);
  document.querySelector('#scan-trigger-wifi')?.addEventListener('click', scanWifi);
  document.querySelector('#scan-trigger-pc')?.addEventListener('click', e => triggerRescan(e.currentTarget));

  document.querySelector('#device-form').onsubmit = async event => {
    event.preventDefault();
    const data = new FormData(event.target);
    event.submitter.disabled = true;
    try {
      const device = await api('/api/owner/devices', {
        method: 'POST',
        body: { name: data.get('name'), color: data.has('color'), duplex: data.has('duplex') }
      });
      document.querySelector('#device-secret').innerHTML = `
        <div class="notice-inline">
          <strong>✓ ${escape(data.get('name'))} paired successfully!</strong> Ready to receive print jobs and test prints.
        </div>`;
      notify('Device paired successfully.');
      await printersPage({ api, workspace, escape, notify });
    } catch (error) {
      notify(error.message);
    } finally {
      event.submitter.disabled = false;
    }
  };

  document.querySelectorAll('[data-test-print]').forEach(button => button.onclick = async () => {
    button.disabled = true;
    try {
      const res = await api(`/api/owner/devices/${button.dataset.testPrint}/test-print`, { method: 'POST' });
      notify(res.message || 'Diagnostic test page queued! Check your printer.');
    } catch (error) {
      notify(error.message);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelectorAll('[data-pause]').forEach(button => button.onclick = async () => {
    button.disabled = true;
    try {
      const res = await api(`/api/owner/devices/${button.dataset.pause}/pause`, { method: 'POST' });
      notify(res.is_paused ? 'Printer paused. Jobs will wait in queue.' : 'Printer resumed.');
      await printersPage({ api, workspace, escape, notify });
    } catch (error) {
      notify(error.message);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelectorAll('[data-revoke]').forEach(button => button.onclick = async () => {
    if (!confirm('Disconnect this device? It will lose access to shop files and jobs.')) return;
    try {
      await api(`/api/owner/devices/${button.dataset.revoke}`, { method: 'DELETE' });
      await printersPage({ api, workspace, escape, notify });
    } catch (error) {
      notify(error.message);
    }
  });

  watchUpdates(
    () => Promise.all([api('/api/owner/devices'), api('/api/owner/printers/scan').catch(() => [])]),
    [devices, scanned],
    () => printersPage({ api, workspace, escape, notify }),
    5000
  );
}

async function ensureWebAuthnBrowser() {
  if (window.SimpleWebAuthnBrowser) return window.SimpleWebAuthnBrowser;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/simplewebauthn-browser.min.js';
    s.onload = () => resolve(window.SimpleWebAuthnBrowser);
    s.onerror = () => reject(new Error('Passkey module could not be loaded.'));
    document.head.appendChild(s);
  });
  return window.SimpleWebAuthnBrowser;
}

export async function securityPage({ api, mount, escape, notify, onVerified, onSignedOut }) {
  let status = { totp: false, passkeys: [] };
  try {
    status = await api('/api/auth/mfa/status');
  } catch (err) {
    if (err.status === 401 && typeof onSignedOut === 'function') {
      await onSignedOut();
      return;
    }
  }
  const hasPasskey = status.passkeys && status.passkeys.length > 0;
  const hasTotp = Boolean(status.totp);

  mount(`
    <main class="auth panel" style="max-width: 520px;">
      <span class="eyebrow">TWO-FACTOR AUTHENTICATION</span>
      <h1>Secure your account</h1>
      <p class="muted">Protect your account with a Passkey (recommended) or an Authenticator App (TOTP).</p>

      <div class="mfa-methods" style="display: flex; flex-direction: column; gap: 14px; margin: 20px 0;">
        <div class="mfa-card" style="border: 1px solid var(--border, #e2e8f0); border-radius: 12px; padding: 16px; background: var(--surface, #fff);">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 200px;">
              <strong style="display: flex; align-items: center; gap: 6px;">🔑 Passkey / WebAuthn <span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #e0f2fe; color: #0369a1; font-weight: 700;">RECOMMENDED</span></strong>
              <p class="muted" style="margin: 4px 0 0; font-size: 13px;">Face ID, fingerprint, or Windows Hello for instant sign-in.</p>
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              ${hasPasskey ? `
                <button class="primary" id="btn-verify-passkey" type="button">🔑 Sign in with Passkey</button>
                <button class="secondary" id="btn-register-passkey" type="button">+ Add another</button>
              ` : `
                <button class="primary" id="btn-register-passkey" type="button">Register Passkey</button>
              `}
            </div>
          </div>
          ${hasPasskey ? `<p style="color: #16a34a; font-size: 12px; margin: 8px 0 0;">✓ ${status.passkeys.length} passkey(s) registered</p>` : ''}
        </div>

        <div class="mfa-card" style="border: 1px solid var(--border, #e2e8f0); border-radius: 12px; padding: 16px; background: var(--surface, #fff);">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 200px;">
              <strong style="display: flex; align-items: center; gap: 6px;">📱 Authenticator App (TOTP) <span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #f1f5f9; color: #475569;">SUPPORTED</span></strong>
              <p class="muted" style="margin: 4px 0 0; font-size: 13px;">Google Authenticator, Microsoft Authenticator, or 1Password.</p>
            </div>
            <button class="secondary" id="setup-mfa" type="button">${hasTotp ? 'Reconfigure' : 'Set up'}</button>
          </div>
          ${hasTotp ? `<p style="color: #16a34a; font-size: 12px; margin: 8px 0 0;">✓ Authenticator app active</p>` : ''}
        </div>
      </div>

      ${hasTotp ? `
        <div class="mfa-card" style="border: 1px solid #bbf7d0; background: #f0fdf4; border-radius: 12px; padding: 16px; margin-bottom: 14px;">
          <strong style="color: #15803d; font-size: 14px; display: block; margin-bottom: 4px;">Sign in with your Authenticator code:</strong>
          <p style="margin: 0 0 10px; font-size: 12.5px; color: #166534;">Enter the 6-digit code from your authenticator app to complete sign-in.</p>
          <form id="verify-totp-form" style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <input name="code" type="text" pattern="[0-9]{6}" maxlength="6" inputmode="numeric" placeholder="000000" required autocomplete="one-time-code" style="max-width: 150px; padding: 8px 12px; font-family: monospace; font-size: 16px; letter-spacing: 2px;">
            <button class="primary" type="submit" id="btn-verify-totp-submit">Verify Code →</button>
          </form>
          <div id="totp-verify-error" class="inline-error" style="display:none; color: #dc2626; font-size: 13px; margin-top: 8px;"></div>
        </div>
      ` : ''}

      <div id="mfa-setup"></div>

      <div style="text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border, #e2e8f0);">
        <button type="button" id="btn-security-logout" class="secondary small" style="background: transparent; border: none; color: var(--muted, #64748b); cursor: pointer; text-decoration: underline; font-size: 13px;">
          ← Sign out and switch account
        </button>
      </div>
    </main>
  `);

  document.querySelector('#btn-security-logout')?.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    if (typeof onSignedOut === 'function') {
      await onSignedOut();
    } else {
      location.hash = 'login';
      location.reload();
    }
  });

  const verifyPasskeyBtn = document.querySelector('#btn-verify-passkey');
  if (verifyPasskeyBtn) {
    verifyPasskeyBtn.onclick = async () => {
      verifyPasskeyBtn.disabled = true;
      try {
        if (location.hostname === '127.0.0.1') {
          location.href = location.href.replace('//127.0.0.1', '//localhost');
          return;
        }
        const browser = await ensureWebAuthnBrowser();
        if (!browser || !browser.browserSupportsWebAuthn()) {
          throw new Error('Passkeys/WebAuthn is not supported in this browser.');
        }
        const options = await api('/api/auth/webauthn/auth-options', { method: 'POST' });
        const assertion = await browser.startAuthentication({ optionsJSON: options });
        const user = await api('/api/auth/webauthn/auth-verify', {
          method: 'POST',
          body: { response: assertion, challengeKey: options.challengeKey }
        });
        notify('Passkey verified successfully!');
        onVerified(user);
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
          notify('Passkey sign-in cancelled.');
        } else {
          notify(err.message || 'Passkey verification failed.');
        }
        verifyPasskeyBtn.disabled = false;
      }
    };
  }

  const passkeyBtn = document.querySelector('#btn-register-passkey');
  if (passkeyBtn) {
    passkeyBtn.onclick = async () => {
      passkeyBtn.disabled = true;
      try {
        if (location.hostname === '127.0.0.1') {
          location.href = location.href.replace('//127.0.0.1', '//localhost');
          return;
        }
        const browser = await ensureWebAuthnBrowser();
        if (!browser || !browser.browserSupportsWebAuthn()) {
          throw new Error('Passkeys/WebAuthn is not supported in this browser.');
        }
        const options = await api('/api/auth/webauthn/register-options', { method: 'POST' });
        const attestation = await browser.startRegistration({ optionsJSON: options });
        const res = await api('/api/auth/webauthn/register-verify', { method: 'POST', body: attestation });
        notify(res.message || 'Passkey registered successfully!');
        const updated = await api('/api/me');
        onVerified(updated);
      } catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
          notify('Passkey registration cancelled.');
        } else {
          notify(err.message || 'Could not register passkey.');
        }
        passkeyBtn.disabled = false;
      }
    };
  }

  const verifyTotpForm = document.querySelector('#verify-totp-form');
  if (verifyTotpForm) {
    verifyTotpForm.onsubmit = async e => {
      e.preventDefault();
      const errEl = document.querySelector('#totp-verify-error');
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
      const submitBtn = document.querySelector('#btn-verify-totp-submit');
      submitBtn.disabled = true;
      try {
        const code = new FormData(e.target).get('code');
        const res = await api('/api/auth/mfa/verify', { method: 'POST', body: { code } });
        notify('Two-factor authentication verified!');
        onVerified(res.user);
      } catch (err) {
        notify(err.message);
        if (errEl) {
          errEl.textContent = err.message || 'Invalid verification code.';
          errEl.style.display = 'block';
        }
        submitBtn.disabled = false;
      }
    };
  }

  const setupMfaBtn = document.querySelector('#setup-mfa');
  if (setupMfaBtn) {
    setupMfaBtn.onclick = async event => {
      event.target.disabled = true;
      try {
        const result = await api('/api/auth/mfa/setup', { method: 'POST' });
        document.querySelector('#mfa-setup').innerHTML = `
          <div style="background: var(--surface-hover, #f8fafc); border-radius: 12px; padding: 16px; margin-top: 12px; border: 1px solid var(--border, #e2e8f0);">
            <img class="payment-qr" src="${result.image}" alt="Authenticator setup QR" style="max-width: 180px; margin: 0 auto; display: block;">
            <p style="text-align: center; margin: 10px 0 6px; font-size: 13px;">Scan with your authenticator app, or enter key:</p>
            <p class="security-code" style="text-align: center; font-family: monospace; font-size: 14px; font-weight: bold; letter-spacing: 2px;">${escape(result.secret)}</p>
            <form id="confirm-mfa" style="margin-top: 12px;">
              <label class="field">6-digit verification code
                <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required>
              </label>
              <button class="primary wide" style="margin-top: 8px;">Confirm & Enable 2FA</button>
            </form>
          </div>
        `;
        document.querySelector('#confirm-mfa').onsubmit = async e => {
          e.preventDefault();
          e.submitter.disabled = true;
          try {
            const user = await api('/api/auth/mfa/confirm', { method: 'POST', body: { code: new FormData(e.target).get('code') } });
            notify('Authenticator confirmed! Two-factor authentication is active.');
            if (user.recoveryCodes && user.recoveryCodes.length > 0) {
              document.querySelector('#mfa-setup').innerHTML = `
                <div style="background: var(--surface-hover, #f8fafc); border-radius: 12px; padding: 20px; margin-top: 14px; border: 1px solid var(--border, #e2e8f0);">
                  <strong style="display: block; font-size: 15px; margin-bottom: 6px; color: #16a34a;">✓ Two-factor authentication is enabled</strong>
                  <p style="font-size: 13px; margin: 0 0 12px;" class="muted">Save these single-use recovery codes in a safe place. If you ever lose your authenticator app, each code can be used once to sign in.</p>
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-family: monospace; font-size: 13px; font-weight: 700; background: #fff; padding: 12px; border-radius: 8px; border: 1px solid #cbd5e1; margin-bottom: 14px;">
                    ${user.recoveryCodes.map(code => `<div style="padding: 4px 6px; text-align: center; letter-spacing: 1px;">${escape(code)}</div>`).join('')}
                  </div>
                  <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                    <button type="button" class="secondary" id="copy-recovery-codes">📋 Copy all codes</button>
                    <button type="button" class="primary" id="mfa-proceed-btn">Continue to Workspace →</button>
                  </div>
                </div>
              `;
              document.querySelector('#copy-recovery-codes')?.addEventListener('click', () => {
                navigator.clipboard.writeText(user.recoveryCodes.join('\n')).then(() => notify('Recovery codes copied to clipboard!'));
              });
              document.querySelector('#mfa-proceed-btn')?.addEventListener('click', () => {
                onVerified(user);
              });
            } else {
              onVerified(user);
            }
          } catch(error) {
            notify(error.message);
            e.submitter.disabled = false;
          }
        };
      } catch(error) {
        notify(error.message);
        event.target.disabled = false;
      }
    };
  }
}

export async function trackingPage({ api, mount, money, escape, receipt, notify, refresh }) {
  if (!receipt) {
    mount(`<main class="customer-order-shell" style="max-width: 580px; margin: 40px auto; padding: 24px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 class="customer-page-title" style="font-size: 26px; margin: 0 0 8px;">Track your print order</h1>
        <p class="customer-page-subtitle" style="font-size: 14px; margin: 0;">Follow the live queue and status of your print job, or look up a placed order with your receipt token.</p>
      </div>
      <div class="panel" style="padding: 24px; border-radius: 12px; background: var(--surface, #fff); border: 1px solid var(--border, #e2e8f0);">
        <form id="track-lookup-form">
          <label class="field">
            Order ID
            <input name="orderId" placeholder="e.g. order UUID" required autocomplete="off">
          </label>
          <label class="field" style="margin-top: 12px;">
            Receipt Token
            <input name="orderToken" placeholder="Private order token" required autocomplete="off">
          </label>
          <button class="primary wide" style="margin-top: 16px;">Track this order →</button>
        </form>
      </div>
      <div style="text-align: center; margin-top: 24px;">
        <a class="secondary" href="#print">Place a new print order →</a>
      </div>
    </main>`);
    document.querySelector('#track-lookup-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const orderId = fd.get('orderId').trim();
      const orderToken = fd.get('orderToken').trim();
      try {
        const order = await api(`/api/orders/${orderId}`, { token: orderToken });
        const savedReceipt = { id: order.id, token: orderToken };
        sessionStorage.setItem('receipt', JSON.stringify(savedReceipt));
        trackingPage({ api, mount, money, escape, receipt: savedReceipt, notify, refresh });
      } catch (err) {
        notify(err.message || 'Could not find order. Please verify your Order ID and secret token.');
      }
    });
    return;
  }
  const order = await api(`/api/orders/${receipt.id}`, { token: receipt.token });
  const labels = {
    awaiting_payment: 'Waiting for payment',
    queued: 'Ready in print queue',
    printing: 'Printing your document',
    awaiting_confirmation: 'Checking physical print output',
    completed: 'Print complete · Ready for pickup',
    expired: 'File expired',
    cancelled: 'Order cancelled',
    failed: 'Shop assistance needed',
    needs_review: 'Shop is checking the printer',
    payment_review: 'Payment received — shop assistance needed'
  };

  const steps = [
    { key: 'placed', label: 'Order Placed', done: true },
    { key: 'payment', label: 'Payment', done: order.payment === 'paid' },
    { key: 'queued', label: 'In Queue', done: ['queued', 'printing', 'awaiting_confirmation', 'completed'].includes(order.status) },
    { key: 'printing', label: 'Printing', done: ['printing', 'awaiting_confirmation', 'completed'].includes(order.status) },
    { key: 'completed', label: 'Ready', done: order.status === 'completed' }
  ];

  let payment = '';
  if (order.method === 'upi' && order.status === 'awaiting_payment') {
    const upi = await api(`/api/orders/${receipt.id}/upi`, { token: receipt.token });
    const formattedAmount = (order.amount / 100).toFixed(2);
    payment = `<section class="panel upi-card">
      <h2>Pay ${money(order.amount)} directly to the shop</h2>
      <p class="muted">Pay using the shop’s dynamic UPI QR or choose your payment app below. The exact amount and order reference are prefilled.</p>
      
      <p>Pay to <strong>${escape(upi.payee)}</strong><br><span class="muted">${escape(upi.upi_id)}</span></p>
      <div class="upi-qr-wrap"><img class="payment-qr" src="${upi.image}" alt="UPI payment QR for ${escape(upi.payee)}"></div>
      
      <div class="upi-app-selection">
        <strong>Open directly in your payment app:</strong>
        <div class="upi-app-grid">
          <a class="upi-app-btn phonepe" href="${escape(upi.apps?.phonepe || upi.uri)}" target="_blank" rel="noopener">
            📱 PhonePe
          </a>
          <a class="upi-app-btn gpay" href="${escape(upi.apps?.gpay || upi.uri)}" target="_blank" rel="noopener">
            🌐 Google Pay
          </a>
          <a class="upi-app-btn paytm" href="${escape(upi.apps?.paytm || upi.uri)}" target="_blank" rel="noopener">
            💳 Paytm
          </a>
          <a class="upi-app-btn bhim" href="${escape(upi.apps?.bhim || upi.uri)}" target="_blank" rel="noopener">
            🏦 BHIM / UPI
          </a>
        </div>
      </div>

      <div class="copy-actions-row">
        <button class="secondary small copy-upi-btn" data-copy="${escape(upi.upi_id)}">📋 Copy UPI ID</button>
        <button class="secondary small copy-amount-btn" data-copy="${escape(formattedAmount)}">📋 Copy ₹${formattedAmount}</button>
      </div>

      <p class="muted small" style="margin-top: 14px;">Once payment is credited, the shop confirms it and printing starts immediately.</p>
      <form id="upi-reference">
        <label class="field">After paying, enter the 12-digit UPI reference number:
          <input name="reference" inputmode="numeric" maxlength="12" pattern="[0-9]{12}" value="${escape(upi.reference || '')}" placeholder="e.g. 328901234567" required>
        </label>
        <button class="primary wide">Share payment reference →</button>
      </form>
    </section>`;
  } else if (order.method === 'online' && order.status === 'awaiting_payment') {
    payment = `<section class="panel online-pay-card">
      <span class="online-pay-badge">Instant Verification</span>
      <h2>Pay ${money(order.amount)} Online</h2>
      <p class="muted">Pay securely using Google Pay, PhonePe, Paytm, Cards, or Netbanking. Once confirmed by the gateway, your document enters the print queue automatically.</p>
      <button id="pay-online-btn" class="primary wide" style="margin-top: 12px; font-size: 1.05rem;">
        💳 Pay ${money(order.amount)} Online Now →
      </button>
      <p class="inline-error" id="online-pay-error" role="alert"></p>
    </section>`;
  }

  mount(`<main class="container tracking">
    <a href="#print" class="back-link">← Print another file</a>
    <section class="panel spaced">
      <div class="tracking-top">
        <div>
          <span class="badge ${order.status === 'completed' ? 'active' : order.status === 'printing' ? 'printing-badge' : 'pending'}">
            ${labels[order.status] || escape(order.status)}
          </span>
          <h1 class="order-id-title">Order #${escape(order.id.slice(0, 8).toUpperCase())}</h1>
          <p class="muted tracking-filename">${icon('file')} ${escape(order.file_name || 'document.pdf')}</p>
        </div>
        <div class="total-badge">
          <span>Amount</span>
          <strong>${money(order.amount)}</strong>
        </div>
      </div>

      <div class="live-stepper" role="progressbar" aria-label="Order progress">
        ${steps.map((s, idx) => `
          <div class="stepper-node ${s.done ? 'is-complete' : ''} ${s.key === order.status ? 'is-current' : ''}">
            <div class="stepper-circle">${s.done ? '✓' : idx + 1}</div>
            <span class="stepper-label">${s.label}</span>
          </div>
        `).join('')}
      </div>

      ${order.status === 'queued' ? `
        <div class="queue-notice-card">
          <div class="queue-stat">
            <span class="queue-pos-num">#${order.queue_position || 1}</span>
            <div>
              <strong>Current Queue Position</strong>
              <p class="muted small">Printing starts automatically when a compatible connected printer is ready.</p>
            </div>
          </div>
        </div>
      ` : ''}

      <div class="order-specs-grid">
        <div><span>Pages</span><strong>${order.pages} pages</strong></div>
        <div><span>Paper</span><strong>${order.sheets} sheets (A4)</strong></div>
        <div><span>Copies</span><strong>${order.options.copies} copies</strong></div>
        <div><span>Color Mode</span><strong>${order.options.color === 'bw' ? 'Black & White' : 'Full Colour'}</strong></div>
        <div><span>Sides</span><strong>${order.options.duplex ? 'Both sides' : 'Single-sided'}</strong></div>
        <div><span>Payment</span><strong>${escape(order.payment)} (${escape(order.method)})</strong></div>
      </div>

      ${order.status === 'awaiting_payment' && order.method === 'cash' ? `
        <div class="notice-inline">
          <strong>Cash at counter:</strong> Pay ${money(order.amount)} to the shop owner to start printing.
        </div>
      ` : ''}

      <div class="tracking-actions">
        <button id="refresh" class="secondary">${icon('refresh')} Refresh status</button>
      </div>
      <p class="foot">${order.deleted_at ? 'The live print file has been permanently deleted from server memory after confirmed printing.' : 'Your file is securely encrypted in transit and deleted upon completion.'}</p>
    </section>
    ${payment}
  </main>`);

  document.querySelector('#refresh').onclick = refresh;
  watchUpdates(() => api(`/api/orders/${receipt.id}`, { token: receipt.token }), order, refresh);

  document.querySelector('.copy-upi-btn')?.addEventListener('click', e => {
    navigator.clipboard.writeText(e.target.dataset.copy);
    e.target.textContent = '✓ UPI ID Copied!';
    setTimeout(() => e.target.textContent = '📋 Copy UPI ID', 2000);
  });

  document.querySelector('.copy-amount-btn')?.addEventListener('click', e => {
    navigator.clipboard.writeText(e.target.dataset.copy);
    e.target.textContent = '✓ Amount Copied!';
    setTimeout(() => e.target.textContent = `📋 Copy ₹${e.target.dataset.copy}`, 2000);
  });

  const payOnlineBtn = document.querySelector('#pay-online-btn');
  if (payOnlineBtn) {
    payOnlineBtn.onclick = async () => {
      payOnlineBtn.disabled = true;
      payOnlineBtn.textContent = 'Loading checkout...';
      const errorEl = document.querySelector('#online-pay-error');
      if (errorEl) errorEl.textContent = '';

      try {
        const orderData = await api(`/api/orders/${receipt.id}/payment`, { method: 'POST', token: receipt.token });

        if (!window.Razorpay) {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://checkout.razorpay.com/v1/checkout.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load online payment gateway. Please check internet connection.'));
            document.head.appendChild(script);
          });
        }

        const rzp = new window.Razorpay({
          key: orderData.key,
          amount: orderData.amount,
          currency: orderData.currency || 'INR',
          name: 'SmartPrint',
          description: `Order #${receipt.id.slice(0, 8).toUpperCase()}`,
          order_id: orderData.order_id,
          handler: async response => {
            payOnlineBtn.textContent = 'Verifying payment...';
            try {
              await api(`/api/orders/${receipt.id}/payment/verify`, {
                method: 'POST',
                token: receipt.token,
                body: {
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_signature: response.razorpay_signature
                }
              });
              notify('✅ Payment verified! Your document is queued for printing.');
              refresh();
            } catch (vErr) {
              if (errorEl) errorEl.textContent = 'Payment received by gateway, awaiting server confirmation: ' + vErr.message;
              refresh();
            }
          },
          modal: {
            ondismiss: () => {
              payOnlineBtn.disabled = false;
              payOnlineBtn.textContent = `💳 Pay ${money(order.amount)} Online Now →`;
            }
          }
        });
        rzp.open();
      } catch (err) {
        if (errorEl) errorEl.textContent = err.message || 'Could not initiate online payment.';
        payOnlineBtn.disabled = false;
        payOnlineBtn.textContent = `💳 Pay ${money(order.amount)} Online Now →`;
      }
    };
  }

  document.querySelector('#upi-reference')?.addEventListener('submit', async event => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      const result = await api(`/api/orders/${receipt.id}/upi`, { method: 'POST', token: receipt.token, body: { reference: new FormData(event.target).get('reference') } });
      notify(result.message);
    } catch(error) {
      notify(error.message);
    } finally {
      event.submitter.disabled = false;
    }
  });
}
export async function accountPage({ api, workspace, notify, admin, onSignedOut, escape }) {
  const esc = escape || (v => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
  let status = { totp: false, enabledAt: null, passkeys: [] };
  try { status = await api('/api/auth/mfa/status'); } catch {}
  const hasTotp = Boolean(status.totp);
  const passkeys = Array.isArray(status.passkeys) ? status.passkeys : [];

  const render = () => {
    const content = `
      <div class="workhead">
        <div>
          <h1>Account settings</h1>
          <p class="muted">Manage your credentials, passkeys, and two-factor authentication.</p>
        </div>
      </div>

      <div class="grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 20px; align-items: start;">
        <!-- Card 1: Password Management -->
        <section class="panel">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <h2 style="margin: 0; font-size: 18px;">Password &amp; Authentication</h2>
            <span class="badge active">Active</span>
          </div>
          <p class="muted" style="margin: 0 0 16px; font-size: 13px;">Changing your password will invalidate all existing active sessions.</p>
          
          <form id="password-form">
            <label class="field">Current password
              <input name="current" type="password" autocomplete="current-password" maxlength="128" required placeholder="Enter current password">
            </label>
            <label class="field">New password
              <input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="Minimum 12 characters">
            </label>
            <label class="field">Confirm new password
              <input name="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required placeholder="Confirm new password">
            </label>
            ${hasTotp ? `
              <label class="field">6-digit Authenticator Code
                <input name="code" type="text" pattern="[0-9]{6}" maxlength="6" inputmode="numeric" placeholder="000000" autocomplete="one-time-code">
                <small class="muted" style="display:block;margin-top:4px;">Required to authorize password changes while 2FA is active.</small>
              </label>
            ` : ''}
            <button class="primary wide" style="margin-top: 10px;" id="btn-change-password">Update password</button>
          </form>
        </section>

        <!-- Card 2: Passkeys (WebAuthn) -->
        <section class="panel" id="passkey-card">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <h2 style="margin: 0; font-size: 18px;">🔑 Passkeys (WebAuthn)</h2>
            <span class="badge ${passkeys.length ? 'active' : 'suspended'}">${passkeys.length ? `${passkeys.length} Active` : 'Not Configured'}</span>
          </div>
          <p class="muted" style="margin: 0 0 16px; font-size: 13px;">
            Sign in instantly using Touch ID, Face ID, Windows Hello, or hardware security keys without typing a password.
          </p>

          ${passkeys.length > 0 ? `
            <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px;">
              ${passkeys.map(pk => `
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; background: var(--surface-subtle, #f8fafc); border: 1px solid var(--border, #e2e8f0); border-radius: 10px; padding: 12px 14px;">
                  <div style="min-width: 0;">
                    <strong style="display: flex; align-items: center; gap: 6px; font-size: 13.5px;">
                      🔑 Passkey <span style="font-size: 11px; font-weight: normal; color: var(--muted, #64748b);">${pk.device_type === 'singleDevice' ? '(Platform)' : '(Multi-device)'}</span>
                    </strong>
                    <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px; flex-wrap: wrap;">
                      <span class="muted" style="font-size: 12px;">Registered: ${new Date(pk.created).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      ${pk.backed_up ? '<span class="pill" style="font-size: 10px; padding: 1px 6px;">Cloud Synced</span>' : '<span class="pill" style="font-size: 10px; padding: 1px 6px;">Device Bound</span>'}
                    </div>
                  </div>
                  <button type="button" class="secondary btn-delete-passkey" data-id="${esc(pk.id)}" style="color: #dc2626; border-color: #fecaca; padding: 5px 10px; font-size: 12px; white-space: nowrap;">Remove</button>
                </div>
              `).join('')}
            </div>
          ` : `
            <div style="background: var(--surface-subtle, #f8fafc); border: 1px solid var(--border, #e2e8f0); border-radius: 12px; padding: 14px; margin-bottom: 16px;">
              <p class="muted" style="margin: 0; font-size: 13px;">No passkeys registered yet. Add a passkey to sign in seamlessly with biometric authentication.</p>
            </div>
          `}

          <button type="button" class="primary wide" id="btn-account-add-passkey">+ Register New Passkey</button>
          <div id="account-passkey-status" style="margin-top: 10px;"></div>
        </section>

        <!-- Card 3: Two-Factor Authentication (TOTP) -->
        <section class="panel" id="totp-card">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <h2 style="margin: 0; font-size: 18px;">📱 Authenticator App (TOTP)</h2>
            <span class="badge ${hasTotp ? 'active' : 'suspended'}">${hasTotp ? 'Active (RFC 6238)' : 'Not Configured'}</span>
          </div>
          <p class="muted" style="margin: 0 0 16px; font-size: 13px;">
            Protect your shop queue and administrative controls with Google Authenticator, Microsoft Authenticator, or 1Password.
          </p>

          ${hasTotp ? `
            <div style="background: var(--surface-subtle, #f0fdf4); border: 1px solid #bbf7d0; border-radius: 12px; padding: 16px; margin-bottom: 16px;">
              <strong style="display: flex; align-items: center; gap: 8px; color: #15803d; font-size: 14px;">
                ${icon('check')} Authenticator app is active
              </strong>
              <p style="margin: 6px 0 0; font-size: 13px; color: #166534;">
                A 6-digit TOTP verification code from your authenticator app is required whenever you sign in.
              </p>
              ${status.enabledAt ? `<small class="muted" style="display:block;margin-top:8px;">Active since: ${new Date(status.enabledAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>` : ''}
            </div>

            <div style="display: flex; gap: 10px; flex-wrap: wrap;">
              <button type="button" class="secondary" id="btn-reconfig-mfa">🔄 Reconfigure App</button>
              <button type="button" class="secondary" id="btn-regen-recovery">🔑 Regenerate Recovery Codes</button>
              <button type="button" class="secondary" id="btn-disable-2fa" style="color: #dc2626; border-color: #fecaca;">Disable 2FA</button>
            </div>
            
            <div id="account-mfa-action-area" style="margin-top: 14px;"></div>
          ` : `
            <div style="background: var(--surface-subtle, #f8fafc); border: 1px solid var(--border, #e2e8f0); border-radius: 12px; padding: 16px; margin-bottom: 16px;">
              <strong style="display: flex; align-items: center; gap: 6px; font-size: 14px;">
                📱 Time-based One-Time Password (TOTP)
              </strong>
              <p class="muted" style="margin: 6px 0 0; font-size: 13px;">
                Generates offline verification codes that change every 30 seconds for secure multi-factor authentication.
              </p>
            </div>
            
            <button type="button" class="primary wide" id="btn-enable-2fa">📱 Set up Authenticator App →</button>
            <div id="account-mfa-setup-area" style="margin-top: 14px;"></div>
          `}
        </section>
      </div>
    `;

    workspace(content, 'account', admin);
    wireHandlers();
  };

  const wireHandlers = () => {
    // Password change submission
    const passwordForm = document.querySelector('#password-form');
    if (passwordForm) {
      passwordForm.onsubmit = async event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.target));
        if (values.password !== values.confirm) return notify('The new passwords do not match.');
        if (values.password.length < 12) return notify('Password must contain at least 12 characters.');
        const btn = event.submitter || document.querySelector('#btn-change-password');
        btn.disabled = true;
        try {
          await api('/api/auth/password', {
            method: 'POST',
            body: { current: values.current, password: values.password, code: values.code || undefined }
          });
          notify('Password changed successfully. Please sign in again.');
          onSignedOut();
        } catch (error) {
          notify(error.message);
          btn.disabled = false;
        }
      };
    }

    // Register Passkey
    const addPasskeyBtn = document.querySelector('#btn-account-add-passkey');
    if (addPasskeyBtn) {
      addPasskeyBtn.onclick = async () => {
        addPasskeyBtn.disabled = true;
        const statusDiv = document.querySelector('#account-passkey-status');
        if (statusDiv) statusDiv.innerHTML = '<p class="muted" style="font-size: 13px;">Initiating passkey registration prompt...</p>';
        try {
          if (location.hostname === '127.0.0.1') {
            location.href = location.href.replace('//127.0.0.1', '//localhost');
            return;
          }
          const browser = await ensureWebAuthnBrowser();
          if (!browser || !browser.browserSupportsWebAuthn()) {
            throw new Error('Passkeys/WebAuthn is not supported in this browser.');
          }
          const options = await api('/api/auth/webauthn/register-options', { method: 'POST' });
          const attestation = await browser.startRegistration({ optionsJSON: options });
          const res = await api('/api/auth/webauthn/register-verify', { method: 'POST', body: attestation });
          notify(res.message || 'Passkey registered successfully!');
          await accountPage({ api, workspace, notify, admin, onSignedOut, escape });
        } catch (err) {
          if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
            notify('Passkey registration cancelled.');
            if (statusDiv) statusDiv.innerHTML = '';
            addPasskeyBtn.disabled = false;
            return;
          }
          notify(err.message || 'Could not register passkey.');
          if (statusDiv) statusDiv.innerHTML = `<p class="inline-error" style="color: #dc2626; font-size: 13px; margin-top: 6px;">${esc(err.message)}</p>`;
          addPasskeyBtn.disabled = false;
        }
      };
    }

    // Delete Passkey
    document.querySelectorAll('.btn-delete-passkey').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm('Are you sure you want to remove this passkey? You will not be able to use it to sign in.')) return;
        btn.disabled = true;
        try {
          await api(`/api/auth/webauthn/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
          notify('Passkey removed successfully.');
          await accountPage({ api, workspace, notify, admin, onSignedOut, escape });
        } catch (err) {
          notify(err.message || 'Could not remove passkey.');
          btn.disabled = false;
        }
      };
    });

    // Start TOTP Setup Flow (for both Enable and Reconfigure)
    const startTotpSetup = async (triggerBtn) => {
      triggerBtn.disabled = true;
      const container = document.querySelector('#account-mfa-setup-area') || document.querySelector('#account-mfa-action-area');
      if (!container) return;
      container.innerHTML = '<p class="muted" style="font-size: 13px;">Generating secure authenticator setup key...</p>';
      try {
        const result = await api('/api/auth/mfa/setup', { method: 'POST' });
        container.innerHTML = `
          <div style="background: var(--surface-hover, #f8fafc); border-radius: 12px; padding: 18px; border: 1px solid var(--border, #e2e8f0); margin-top: 10px;">
            <h3 style="margin: 0 0 8px; font-size: 15px;">1. Scan QR with Authenticator App</h3>
            <p class="muted" style="margin: 0 0 12px; font-size: 13px;">Open Google Authenticator, Microsoft Authenticator, or 1Password and scan:</p>
            
            <div style="text-align: center; margin: 12px 0;">
              <img src="${result.image}" alt="TOTP QR Code" style="max-width: 170px; border-radius: 8px; border: 1px solid var(--border, #cbd5e1); padding: 4px; background: #fff; display: inline-block;">
            </div>
            
            <p class="muted" style="margin: 10px 0 4px; font-size: 12px; text-align: center;">Or manually enter this secret setup key:</p>
            <div style="display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 14px;">
              <code style="font-family: monospace; font-size: 14px; font-weight: 700; background: #fff; padding: 6px 10px; border-radius: 6px; border: 1px solid #cbd5e1; letter-spacing: 1.5px;">${esc(result.secret)}</code>
              <button type="button" class="secondary" id="btn-copy-totp-key" style="padding: 6px 10px; font-size: 12px;">Copy</button>
            </div>

            <h3 style="margin: 16px 0 8px; font-size: 15px;">2. Enter 6-digit Code to Confirm</h3>
            <form id="confirm-mfa-form">
              <label class="field">6-digit Code
                <input name="code" type="text" pattern="[0-9]{6}" maxlength="6" inputmode="numeric" required placeholder="000000" autocomplete="one-time-code" autofocus>
              </label>
              <div style="display: flex; gap: 10px; margin-top: 10px;">
                <button class="primary" style="flex: 1;" id="btn-submit-mfa-confirm">Confirm &amp; Enable 2FA</button>
                <button type="button" class="secondary" id="btn-cancel-mfa-setup">Cancel</button>
              </div>
            </form>
          </div>
        `;

        document.querySelector('#btn-copy-totp-key')?.addEventListener('click', () => {
          navigator.clipboard.writeText(result.secret).then(() => notify('Setup key copied to clipboard!'));
        });

        document.querySelector('#btn-cancel-mfa-setup')?.addEventListener('click', () => {
          container.innerHTML = '';
          triggerBtn.disabled = false;
        });

        document.querySelector('#confirm-mfa-form').onsubmit = async e => {
          e.preventDefault();
          const submitBtn = document.querySelector('#btn-submit-mfa-confirm');
          submitBtn.disabled = true;
          try {
            const res = await api('/api/auth/mfa/confirm', {
              method: 'POST',
              body: { code: new FormData(e.target).get('code') }
            });
            notify('✅ Two-Factor Authentication is active!');
            
            if (res.recoveryCodes && res.recoveryCodes.length > 0) {
              container.innerHTML = `
                <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 12px; padding: 20px; margin-top: 10px;">
                  <strong style="color: #15803d; font-size: 15px; display: block; margin-bottom: 6px;">✓ 2FA Enabled &amp; Single-Use Recovery Codes Generated</strong>
                  <p style="font-size: 13px; color: #166534; margin: 0 0 12px;">
                    Store these 8 single-use recovery codes in a secure password manager. If you ever lose access to your authenticator device, each code can be used once to sign in.
                  </p>
                  <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; font-family: monospace; font-size: 13px; font-weight: 700; background: #fff; padding: 12px; border-radius: 8px; border: 1px solid #cbd5e1; margin-bottom: 14px;">
                    ${res.recoveryCodes.map(code => `<div style="padding: 4px; text-align: center; letter-spacing: 1px; color: #1e293b;">${esc(code)}</div>`).join('')}
                  </div>
                  <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                    <button type="button" class="secondary" id="btn-copy-recovery-codes">📋 Copy all recovery codes</button>
                    <button type="button" class="primary" id="btn-done-mfa-setup">Done</button>
                  </div>
                </div>
              `;

              document.querySelector('#btn-copy-recovery-codes')?.addEventListener('click', () => {
                navigator.clipboard.writeText(res.recoveryCodes.join('\n')).then(() => notify('Recovery codes copied to clipboard!'));
              });

              document.querySelector('#btn-done-mfa-setup')?.addEventListener('click', async () => {
                await accountPage({ api, workspace, notify, admin, onSignedOut, escape });
              });
            } else {
              await accountPage({ api, workspace, notify, admin, onSignedOut, escape });
            }
          } catch (err) {
            notify(err.message);
            submitBtn.disabled = false;
          }
        };
      } catch (err) {
        notify(err.message);
        container.innerHTML = '';
        triggerBtn.disabled = false;
      }
    };

    // Enable / Reconfigure 2FA
    const enableBtn = document.querySelector('#btn-enable-2fa');
    if (enableBtn) enableBtn.onclick = () => startTotpSetup(enableBtn);

    const reconfigBtn = document.querySelector('#btn-reconfig-mfa');
    if (reconfigBtn) reconfigBtn.onclick = () => startTotpSetup(reconfigBtn);

    // Regenerate Recovery Codes Click
    const regenBtn = document.querySelector('#btn-regen-recovery');
    if (regenBtn) {
      regenBtn.onclick = () => {
        const area = document.querySelector('#account-mfa-action-area');
        area.innerHTML = `
          <div style="background: var(--surface-hover, #f8fafc); border: 1px solid var(--border, #cbd5e1); border-radius: 12px; padding: 16px;">
            <h3 style="margin: 0 0 6px; font-size: 14px;">Regenerate Recovery Codes</h3>
            <p class="muted" style="margin: 0 0 12px; font-size: 12.5px;">
              Generating new recovery codes will immediately invalidate all previously issued recovery codes.
            </p>
            <form id="regen-recovery-form">
              <label class="field">Current password
                <input name="password" type="password" required autocomplete="current-password" placeholder="Confirm your password">
              </label>
              <label class="field">Current 6-digit Authenticator Code
                <input name="code" type="text" pattern="[0-9]{6}" maxlength="6" inputmode="numeric" required placeholder="000000" autocomplete="one-time-code">
              </label>
              <div style="display: flex; gap: 8px; margin-top: 10px;">
                <button class="primary" id="btn-submit-regen">Generate New Codes</button>
                <button type="button" class="secondary" id="btn-cancel-regen">Cancel</button>
              </div>
            </form>
          </div>
        `;

        document.querySelector('#btn-cancel-regen')?.addEventListener('click', () => { area.innerHTML = ''; });
        document.querySelector('#regen-recovery-form').onsubmit = async e => {
          e.preventDefault();
          const btn = document.querySelector('#btn-submit-regen');
          btn.disabled = true;
          try {
            const formData = new FormData(e.target);
            const res = await api('/api/auth/mfa/recovery-codes/regenerate', {
              method: 'POST',
              body: { password: formData.get('password'), code: formData.get('code') }
            });
            notify('✅ New recovery codes generated successfully!');
            area.innerHTML = `
              <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 12px; padding: 16px;">
                <strong style="color: #15803d; font-size: 14px; display: block; margin-bottom: 6px;">New Recovery Codes</strong>
                <p style="font-size: 12.5px; color: #166534; margin: 0 0 10px;">Make sure to copy and save these codes. Previous codes are now invalid.</p>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; font-family: monospace; font-size: 13px; font-weight: 700; background: #fff; padding: 10px; border-radius: 8px; border: 1px solid #cbd5e1; margin-bottom: 10px;">
                  ${res.recoveryCodes.map(code => `<div style="padding: 4px; text-align: center; letter-spacing: 1px;">${esc(code)}</div>`).join('')}
                </div>
                <div style="display: flex; gap: 8px;">
                  <button type="button" class="secondary" id="btn-copy-new-codes">📋 Copy codes</button>
                  <button type="button" class="primary" id="btn-close-regen">Done</button>
                </div>
              </div>
            `;
            document.querySelector('#btn-copy-new-codes')?.addEventListener('click', () => {
              navigator.clipboard.writeText(res.recoveryCodes.join('\n')).then(() => notify('Recovery codes copied!'));
            });
            document.querySelector('#btn-close-regen')?.addEventListener('click', () => { area.innerHTML = ''; });
          } catch (err) {
            notify(err.message);
            btn.disabled = false;
          }
        };
      };
    }

    // Disable 2FA Click
    const disableBtn = document.querySelector('#btn-disable-2fa');
    if (disableBtn) {
      disableBtn.onclick = () => {
        const area = document.querySelector('#account-mfa-action-area');
        area.innerHTML = `
          <div style="background: #fff1f2; border: 1px solid #fecdd3; border-radius: 12px; padding: 16px;">
            <h3 style="margin: 0 0 6px; font-size: 14px; color: #9f1239;">Disable Two-Factor Authentication</h3>
            <p style="margin: 0 0 12px; font-size: 12.5px; color: #be123c;">
              Warning: Disabling 2FA lowers account security. Re-authentication with your current password and a valid 2FA code is required.
            </p>
            <form id="disable-2fa-form">
              <label class="field">Current password
                <input name="password" type="password" required autocomplete="current-password" placeholder="Confirm your password">
              </label>
              <label class="field">6-digit Authenticator Code or Recovery Code
                <input name="code" type="text" maxlength="19" required placeholder="6-digit code or recovery code" autocomplete="one-time-code">
              </label>
              <div style="display: flex; gap: 8px; margin-top: 10px;">
                <button class="primary" style="background: #dc2626; border-color: #dc2626;" id="btn-confirm-disable">Yes, Disable 2FA</button>
                <button type="button" class="secondary" id="btn-cancel-disable">Cancel</button>
              </div>
            </form>
          </div>
        `;

        document.querySelector('#btn-cancel-disable')?.addEventListener('click', () => { area.innerHTML = ''; });
        document.querySelector('#disable-2fa-form').onsubmit = async e => {
          e.preventDefault();
          const btn = document.querySelector('#btn-confirm-disable');
          btn.disabled = true;
          try {
            const formData = new FormData(e.target);
            await api('/api/auth/mfa/disable', {
              method: 'POST',
              body: { password: formData.get('password'), code: formData.get('code') }
            });
            notify('Two-factor authentication disabled.');
            await accountPage({ api, workspace, notify, admin, onSignedOut, escape });
          } catch (err) {
            notify(err.message);
            btn.disabled = false;
          }
        };
      };
    }
  };

  render();
}
