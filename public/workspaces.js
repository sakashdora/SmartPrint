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
    const local = await fetch('http://127.0.0.1:3000/api/local/printers', { signal: AbortSignal.timeout(1200) })
      .then(r => r.json()).catch(() => null);
    if (local && Array.isArray(local.printers) && local.printers.length > 0) {
      await api('/api/owner/printers/scanned-report', { method: 'POST', body: { printers: local.printers } }).catch(() => {});
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

export async function securityPage({ api, mount, escape, notify, onVerified }) {
  mount(`<main class="auth panel"><h1>Secure your account</h1><p class="muted">Use an authenticator app to protect your shop or admin account.</p><button class="primary" id="setup-mfa">Set up authenticator</button><div id="mfa-setup"></div></main>`);
  document.querySelector('#setup-mfa').onclick = async event => { event.target.disabled = true; try { const result = await api('/api/auth/mfa/setup', { method: 'POST' }); document.querySelector('#mfa-setup').innerHTML = `<img class="payment-qr" src="${result.image}" alt="Authenticator setup QR"><p>Scan with your authenticator app, or enter this setup key:</p><p class="security-code">${escape(result.secret)}</p><form id="confirm-mfa"><label class="field">6-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button class="primary">Verify and continue</button></form>`; document.querySelector('#confirm-mfa').onsubmit = async e => { e.preventDefault(); e.submitter.disabled = true; try { const user = await api('/api/auth/mfa/confirm', { method: 'POST', body: { code: new FormData(e.target).get('code') } }); onVerified(user); } catch(error) { notify(error.message); e.submitter.disabled = false; } }; } catch(error) { notify(error.message); event.target.disabled = false; } };
}

export async function trackingPage({ api, mount, money, escape, receipt, notify, refresh }) {
  if (!receipt) {
    mount(`<main class="welcome"><div class="welcome-icon">${icon('file')}</div><h1>Your print, from start to finish.</h1><p class="muted">Place an order to get your private receipt and follow its progress here.</p><div class="spaced"><a class="primary" href="#print">Print a file ${icon('arrow')}</a></div></main>`);
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
    payment = `<section class="panel upi-card">
      <h2>Pay ${money(order.amount)} directly to the shop</h2><p>Use the shop’s UPI QR or open your UPI app. Once the shop verifies the bank credit, the connected printer starts automatically.</p>
      <p>Pay to <strong>${escape(upi.payee)}</strong><br><span class="muted">${escape(upi.upi_id)}</span></p>
      <div class="upi-qr-wrap"><img class="payment-qr" src="${upi.image}" alt="UPI payment QR"></div>
      <div class="upi-links-row">
        <a class="primary wide upi-link" href="${escape(upi.uri)}">Open UPI App</a>
        <button class="secondary small copy-upi-btn" data-copy="${escape(upi.upi_id)}">Copy UPI ID</button>
      </div>
      <p class="muted small">Scan with Google Pay, PhonePe, Paytm, or BHIM.</p>
      <form id="upi-reference">
        <label class="field">After paying, enter the 12-digit UPI reference number:
          <input name="reference" inputmode="numeric" maxlength="12" pattern="[0-9]{12}" value="${escape(upi.reference || '')}" placeholder="e.g. 328901234567" required>
        </label>
        <button class="secondary wide">Share payment reference →</button>
      </form>
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
    e.target.textContent = 'Copied!';
    setTimeout(() => e.target.textContent = 'Copy UPI ID', 2000);
  });

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
export async function accountPage({ api, workspace, notify, admin, onSignedOut }) {
  workspace('<div class="workhead"><div><h1>Account settings</h1><p class="muted">Change your password. This signs you out on every device.</p></div></div><section class="panel"><form id="password-form"><label class="field">Current password<input name="current" type="password" autocomplete="current-password" maxlength="128" required></label><label class="field">New password<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label class="field">Confirm new password<input name="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button class="primary">Change password</button></form></section>', 'account', admin);
  document.querySelector('#password-form').onsubmit = async event => {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.target));
    if (values.password !== values.confirm) return notify('The new passwords do not match.');
    event.submitter.disabled = true;
    try { await api('/api/auth/password', { method: 'POST', body: { current: values.current, password: values.password } }); notify('Password changed. Sign in again.'); onSignedOut(); }
    catch (error) { notify(error.message); event.submitter.disabled = false; }
  };
}
