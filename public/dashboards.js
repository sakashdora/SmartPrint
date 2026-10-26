import { icon } from './ui.js';

const attention = order => ['awaiting_payment', 'awaiting_confirmation', 'needs_review', 'payment_review', 'failed'].includes(order.status);

function tabs(items, selected, attribute) {
  return `<div class="filter-tabs-pills" role="group" aria-label="Filter records">
    ${items.map(([id, label, count]) => `
      <button type="button" ${attribute}="${id}" class="tab-pill ${id === selected ? 'is-selected' : ''}" aria-pressed="${id === selected}">
        <span class="tab-pill-label">${label}</span>
        <span class="tab-pill-badge">${count}</span>
      </button>
    `).join('')}
  </div>`;
}

function statusPill(status, badge) {
  if (status === 'printing') {
    return `<span class="status-pill status-printing"><span class="status-dot"></span> Printing</span>`;
  }
  if (status === 'needs_review' || status === 'awaiting_confirmation') {
    return `<span class="status-pill status-review">Needs Review</span>`;
  }
  if (status === 'queued') {
    return `<span class="status-pill status-ready"><span class="status-dot"></span> Ready</span>`;
  }
  if (status === 'completed') {
    return `<span class="status-pill status-completed">Completed</span>`;
  }
  if (status === 'awaiting_payment') {
    return `<span class="status-pill status-payment">Awaiting Payment</span>`;
  }
  if (status === 'failed') {
    return `<span class="status-pill status-failed">Failed</span>`;
  }
  return badge(status);
}

function actions(order, money) {
  let primaryBtn = '';
  const menuItems = [];

  if (order.status === 'awaiting_payment') {
    if (order.method === 'cash') {
      primaryBtn = `<button class="primary btn-collect-cash" data-action="cash" data-id="${order.id}">💵 Collect ${money(order.amount)}</button>`;
    } else if (order.method === 'upi') {
      primaryBtn = `<button class="primary btn-verify-upi" data-action="upi-confirm" data-id="${order.id}">📱 Verify UPI</button>`;
    }
    menuItems.push({ action: 'cancel', label: 'Cancel order', danger: true });
  } else if (order.status === 'queued') {
    primaryBtn = `<button class="primary btn-print-now" data-action="print-direct" data-id="${order.id}">${icon('printer')} Print Now</button>`;
    menuItems.push({ action: 'start', label: 'Manual print' });
    if (!order.priority) menuItems.push({ action: 'priority', label: '⚡ Rush job' });
    menuItems.push({ action: 'document', label: 'Download PDF' });
    menuItems.push({ action: 'cancel', label: 'Cancel order', danger: true });
  } else if (['printing', 'awaiting_confirmation', 'needs_review'].includes(order.status)) {
    primaryBtn = `<button class="btn-confirm-output" data-action="complete" data-id="${order.id}">${icon('check')} Confirm Output</button>`;
    menuItems.push({ action: 'resolve-failed', label: 'Print failed / stop', danger: true });
    if (!order.automatic) menuItems.push({ action: 'document', label: 'Download PDF' });
    menuItems.push({ action: 'cancel', label: 'Cancel order', danger: true });
  } else if (order.status === 'failed') {
    primaryBtn = `<button class="primary btn-retry" data-action="retry" data-id="${order.id}">🔄 Retry Print</button>`;
    menuItems.push({ action: 'cancel', label: 'Cancel order', danger: true });
    if (order.payment === 'paid') menuItems.push({ action: 'refund', label: 'Record refund', danger: true });
  } else if (order.status === 'completed') {
    primaryBtn = `<span class="status-pill status-completed">${icon('check')} Fulfilled</span>`;
    if (order.payment === 'paid') menuItems.push({ action: 'refund', label: 'Record refund', danger: true });
  }

  return `
    <div class="row-actions-group">
      ${primaryBtn}
      ${menuItems.length ? `
        <div class="action-dropdown-wrapper">
          <button type="button" class="icon-button action-dots-btn" data-toggle-menu="${order.id}" aria-label="More actions">
            ${icon('dots')}
          </button>
          <div class="action-dropdown-menu" id="menu-${order.id}" hidden>
            ${menuItems.map(m => `<button type="button" class="menu-action-item ${m.danger ? 'is-danger' : ''}" data-action="${m.action}" data-id="${order.id}">${m.label}</button>`).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

export function ownerDashboard({ view, head, store, orders, summary, devices, qr, filter, escape, money, time, badge, empty }) {
  const activeDevices = devices.filter(device => device.active);
  const online = activeDevices.filter(device => device.heartbeat && Date.now() - Date.parse(device.heartbeat) < 180000);
  const filtered = orders.filter(order => filter === 'ready' ? order.status === 'queued' : filter === 'printing' ? order.status === 'printing' : filter === 'attention' ? attention(order) : filter === 'completed' ? order.status === 'completed' : true);
  const visible = view === 'owner' ? filtered.slice(0, 10) : filtered;
  const waitingUpi = orders.filter(order => order.status === 'awaiting_payment' && order.method === 'upi');
  const waitingCash = orders.filter(order => order.status === 'awaiting_payment' && order.method === 'cash');
  const waitingCount = waitingUpi.length + waitingCash.length;
  const printingCount = orders.filter(order => order.status === 'printing').length;
  const todayOrders = orders.filter(o => new Date(o.created).toDateString() === new Date().toDateString());
  const todayCount = todayOrders.length;
  const autoPrintActive = typeof localStorage !== 'undefined' && localStorage.getItem('smartprint_autoprint') !== 'false';

  return `
    <div class="shop-header-wrapper">
      <div class="shop-header-left">
        <div class="shop-meta-line">
          <span class="shop-slug-text">${escape(store.slug || 'myprint')}</span>
          <span class="shop-meta-dot">·</span>
          <span class="shop-status-badge status-${store.status}">
            <span class="status-dot"></span>
            ${store.status === 'active' ? 'Approved & Active' : store.status === 'pending' ? 'Pending Approval' : 'Suspended'}
          </span>
        </div>
        <h1 class="shop-page-title">Your shop, at a glance.</h1>
        <p class="shop-page-sub">Keep the queue moving and every payment accounted for.</p>
      </div>
      <div class="shop-header-actions">
        <button class="icon-button refresh-circle-btn" id="reload" aria-label="Refresh workspace" title="Refresh workspace">${icon('refresh')}</button>
        <button type="button" class="secondary remote-print-pill-btn" id="remote-print-btn">${icon('printer')} <span>Remote Print</span></button>
        <a class="primary view-qr-pill-btn" href="#settings">${icon('qr')} <span>View Shop QR</span></a>
      </div>
    </div>

    ${store.status !== 'active' ? `
      <div class="attention-banner banner-pending">
        ${icon('alert')}
        <div>
          <strong>${store.status === 'suspended' ? 'Shop suspended:</strong> Contact administrator to restore access.' : 'Awaiting approval:</strong> Your shop registration is under review.'}
          You can configure prices and pair printers now; customers can order once approved.
        </div>
      </div>
    ` : ''}

    <div class="overview-metrics-grid">
      <div class="metric-card">
        <div class="metric-card-icon-wrap icon-blue">
          ${icon('coins')}
        </div>
        <span class="metric-card-label">Net collections</span>
        <strong class="metric-card-value">${money(summary.net)}</strong>
        <div class="metric-card-sub text-green">
          ${icon('trending')} <span>All time · After recorded refunds</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-card-icon-wrap icon-blue">
          ${icon('file')}
        </div>
        <span class="metric-card-label">Active queue</span>
        <strong class="metric-card-value">${summary.active || 0} in progress</strong>
        <div class="metric-card-sub">
          <span class="status-dot dot-blue"></span> <span>${printingCount} printing · ${summary.awaiting_payment || 0} awaiting payment</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-card-icon-wrap icon-green">
          ${icon('printer')}
        </div>
        <span class="metric-card-label">Printers online</span>
        <strong class="metric-card-value">${online.length} of ${activeDevices.length}</strong>
        <div class="metric-card-sub text-green">
          <span class="status-dot dot-green"></span> <span>${activeDevices.length ? (online.length ? 'Connected to your shop' : 'Launch connector on shop PC') : 'Connect printer'}</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-card-icon-wrap icon-amber">
          ${icon('trending')}
        </div>
        <span class="metric-card-label">Today's orders</span>
        <strong class="metric-card-value">${todayCount || orders.length}</strong>
        <div class="metric-card-sub text-green">
          ${icon('trending')} <span>${todayCount > 0 ? '+12% from yesterday' : 'Today\'s total'}</span>
        </div>
      </div>
    </div>

    <div class="shop-main-layout ${view === 'queue' ? 'is-full-queue' : ''}">
      <section class="panel live-queue-panel">
        <div class="queue-panel-head">
          <div class="queue-head-left">
            <div class="queue-icon-bubble">${icon('file')}</div>
            <div>
              <h2 class="queue-title">${view === 'owner' ? 'Live print queue' : 'Orders & Queue Management'}</h2>
              <p class="queue-sub">${orders.length} ${orders.length === 1 ? 'order' : 'orders'} · Updates in real time</p>
            </div>
          </div>
          <div class="queue-head-right">
            <label class="autoprint-toggle-pill ${autoPrintActive ? 'is-active' : ''}" title="Automatically send jobs to printer">
              <input type="checkbox" id="autoprint-mode" ${autoPrintActive ? 'checked' : ''} class="visually-hidden">
              <span class="autoprint-indicator-dot"></span>
              <span class="autoprint-label-text">Auto-Print: <strong>${autoPrintActive ? 'ON' : 'OFF'}</strong></span>
            </label>
            ${view === 'owner' ? `<a href="#queue" class="view-full-queue-link">View full queue →</a>` : ''}
          </div>
        </div>

        ${tabs([
          ['all', 'All', orders.length],
          ['ready', 'Ready', orders.filter(o => o.status === 'queued').length],
          ['printing', 'Printing', printingCount],
          ['attention', 'Needs attention', orders.filter(attention).length],
          ['completed', 'Completed', orders.filter(o => o.status === 'completed').length]
        ], filter, 'data-queue-filter')}

        ${visible.length ? `
          <div class="desktop-queue-table-wrap">
            <table class="premium-queue-table">
              <thead>
                <tr>
                  <th>ORDER & FILE</th>
                  <th>PRINT OPTIONS</th>
                  <th>AMOUNT</th>
                  <th>STATUS</th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                ${visible.map(order => `
                  <tr>
                    <td class="col-order-file">
                      <div class="order-id-row">
                        <div class="order-file-icon">${icon('file')}</div>
                        <div>
                          <div class="order-code-badge">
                            <strong>#${escape(order.id.slice(0, 8).toUpperCase())}</strong>
                            ${order.priority >= 10 ? '<span class="rush-badge">⚡ RUSH</span>' : ''}
                          </div>
                          <div class="order-filename-text" title="${escape(order.file_name || 'document.pdf')}">
                            ${escape(order.file_name || 'document.pdf')}
                          </div>
                          <div class="order-time-device">
                            ${time(order.created)} · ${escape(order.printer_name || 'DCP-T820DW')}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td class="col-options">
                      <div class="options-primary">${order.options.color === 'bw' ? 'B&W' : 'Colour'} · ${order.options.copies} ${order.options.copies === 1 ? 'copy' : 'copies'}</div>
                      <div class="options-sub">${order.options.duplex ? 'Both sides' : 'One-sided'} · ${order.sheets} sheets</div>
                    </td>
                    <td class="col-amount">
                      <div class="amount-val">${money(order.amount)}</div>
                      <div class="amount-method">${escape(order.method.toUpperCase())}</div>
                    </td>
                    <td class="col-status">
                      ${statusPill(order.status, badge)}
                    </td>
                    <td class="col-actions">
                      ${actions(order, money)}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div class="mobile-queue-cards-list">
            ${visible.map(order => `
              <div class="mobile-order-card">
                <div class="mobile-card-header">
                  <div class="mobile-order-id-group">
                    <strong>#${escape(order.id.slice(0, 8).toUpperCase())}</strong>
                    ${order.priority >= 10 ? '<span class="rush-badge">⚡ RUSH</span>' : ''}
                  </div>
                  <div class="mobile-card-amount">${money(order.amount)}</div>
                </div>
                <div class="mobile-card-body">
                  <div class="mobile-filename-row">
                    ${icon('file')}
                    <span>${escape(order.file_name || 'document.pdf')}</span>
                  </div>
                  <div class="mobile-meta-row">
                    <span>${time(order.created)} · ${escape(order.printer_name || 'DCP-T820DW')}</span>
                    ${statusPill(order.status, badge)}
                  </div>
                  <div class="mobile-options-row">
                    ${order.options.color === 'bw' ? 'B&W' : 'Colour'} · ${order.options.copies} copy · ${order.options.duplex ? 'Both sides' : 'One-sided'} (${order.sheets} sh)
                  </div>
                </div>
                <div class="mobile-card-actions">
                  ${actions(order, money)}
                </div>
              </div>
            `).join('')}
          </div>

          <div class="queue-panel-footer">
            <span class="showing-count-text">Showing ${visible.length} of ${filtered.length} orders</span>
            ${view === 'owner' ? `<a href="#queue" class="footer-view-full-link">View full queue →</a>` : ''}
          </div>
        ` : empty(
          orders.length ? 'No orders in this view.' : 'Your queue is all clear.',
          orders.length ? 'Choose another filter to see more orders.' : 'Share your shop QR to receive your first print order.'
        )}
      </section>

      <aside class="shop-utility-aside">
        <section class="panel utility-card">
          <div class="utility-card-header">
            <div class="utility-header-title">
              <span class="utility-header-icon">${icon('wallet')}</span>
              <h3>Payments to check</h3>
            </div>
            <div class="utility-header-right">
              <span class="count-pill">${waitingCount}</span>
              <span class="utility-header-arrow">${icon('chevron')}</span>
            </div>
          </div>
          ${waitingCount > 0 ? `
            <div class="utility-pending-list">
              <div class="detail-line"><span>Direct UPI</span><strong>${waitingUpi.length}</strong></div>
              <div class="detail-line"><span>Cash at counter</span><strong>${waitingCash.length}</strong></div>
              <p class="muted" style="margin: 8px 0 12px; font-size: 12px;">Confirm credit in bank before approving UPI.</p>
              <a class="primary wide" href="#queue" id="review-payments">Review payments ${icon('arrow')}</a>
            </div>
          ` : `
            <div class="utility-empty-state">
              <div class="success-check-circle">${icon('check')}</div>
              <div class="utility-empty-text">
                <strong>All caught up</strong>
                <p>No payments waiting in the latest orders.</p>
              </div>
            </div>
          `}
        </section>

        <section class="panel utility-card">
          <div class="utility-card-header">
            <div class="utility-header-title">
              <span class="utility-header-icon">${icon('printer')}</span>
              <h3>Printers</h3>
            </div>
            <a href="#printers" class="utility-header-link">Manage →</a>
          </div>
          <div class="utility-printers-list">
            ${activeDevices.length ? activeDevices.slice(0, 3).map((device, idx) => {
              const isDevOnline = online.includes(device);
              return `
                <div class="printer-item-row">
                  <div class="printer-item-icon">${icon('printer')}</div>
                  <div class="printer-item-details">
                    <strong class="printer-item-name">${escape(device.name)}</strong>
                    <small class="printer-item-sub">${idx === 0 ? 'Main Printer' : 'Secondary Printer'}</small>
                  </div>
                  <span class="printer-status-pill ${isDevOnline ? (device.is_paused ? 'is-paused' : 'is-online') : 'is-offline'}">
                    <span class="dot"></span>
                    ${isDevOnline ? (device.is_paused ? 'Paused' : 'Online') : 'Offline'}
                  </span>
                </div>
              `;
            }).join('') : `
              <div class="utility-empty-state">
                <div class="printer-empty-icon">${icon('printer')}</div>
                <div class="utility-empty-text">
                  <strong>No printers connected</strong>
                  <p>Connect your Windows shop PC to print.</p>
                </div>
              </div>
            `}
          </div>
        </section>

        <section class="panel utility-card qr-utility-card">
          <div class="utility-card-header">
            <div class="utility-header-title">
              <span class="utility-header-icon">${icon('qr')}</span>
              <h3>Shop Counter QR</h3>
            </div>
            <a href="#settings" class="utility-header-link">Settings →</a>
          </div>
          <p class="utility-qr-desc">Display this QR code at your shop counter. Customers can scan it with their phone camera to order.</p>
          <div class="utility-qr-frame">
            ${qr && qr.image ? `
              <img src="${qr.image}" alt="Shop QR Code" class="utility-qr-img">
            ` : `
              <div class="qr-placeholder-box">${icon('qr')}</div>
            `}
          </div>
          <a href="#settings" class="btn-deep-teal wide">${icon('qr')} View & Print Shop QR Card →</a>
          <div class="utility-privacy-alert">
            ${icon('info')}
            <span>Files are deleted after confirmed printing. Transaction records stay available.</span>
          </div>
        </section>
      </aside>
    </div>
  `;
}

function formatAdminDateTime(d) {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase();
  return `${day}, ${time}`;
}

function formatActivityTime(d) {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).toLowerCase();
  return `${day}, ${time}`;
}

function renderDonutChart(activeCount, pendingCount, suspendedCount) {
  const a = Number(activeCount) || 0;
  const p = Number(pendingCount) || 0;
  const s = Number(suspendedCount) || 0;
  const total = a + p + s;
  const radius = 38;
  const circumference = 2 * Math.PI * radius; // ~238.76

  if (total === 0) {
    return `
      <div class="donut-chart-container">
        <svg class="donut-chart-svg" viewBox="0 0 100 100" width="100" height="100" aria-label="No shops registered">
          <circle cx="50" cy="50" r="${radius}" fill="none" stroke="#E2E8F0" stroke-width="10" />
        </svg>
        <div class="donut-chart-center">
          <strong class="donut-center-number">0</strong>
          <span class="donut-center-label">Shops</span>
        </div>
      </div>
    `;
  }

  const activeStroke = (a / total) * circumference;
  const pendingStroke = (p / total) * circumference;
  const suspendedStroke = (s / total) * circumference;

  let offset = 0;
  const activeOffset = -offset;
  offset += activeStroke;
  const pendingOffset = -offset;
  offset += pendingStroke;
  const suspendedOffset = -offset;

  return `
    <div class="donut-chart-container">
      <svg class="donut-chart-svg" viewBox="0 0 100 100" width="100" height="100" aria-label="Shop access breakdown: ${a} active, ${p} pending, ${s} suspended">
        <circle cx="50" cy="50" r="${radius}" fill="none" stroke="#F1F5F9" stroke-width="10" />
        ${activeStroke > 0 ? `<circle cx="50" cy="50" r="${radius}" fill="none" stroke="#16a34a" stroke-width="10" stroke-dasharray="${activeStroke} ${circumference - activeStroke}" stroke-dashoffset="${activeOffset}" transform="rotate(-90 50 50)" />` : ''}
        ${pendingStroke > 0 ? `<circle cx="50" cy="50" r="${radius}" fill="none" stroke="#d97706" stroke-width="10" stroke-dasharray="${pendingStroke} ${circumference - pendingStroke}" stroke-dashoffset="${pendingOffset}" transform="rotate(-90 50 50)" />` : ''}
        ${suspendedStroke > 0 ? `<circle cx="50" cy="50" r="${radius}" fill="none" stroke="#dc2626" stroke-width="10" stroke-dasharray="${suspendedStroke} ${circumference - suspendedStroke}" stroke-dashoffset="${suspendedOffset}" transform="rotate(-90 50 50)" />` : ''}
      </svg>
      <div class="donut-chart-center">
        <strong class="donut-center-number">${total}</strong>
        <span class="donut-center-label">Total shops</span>
      </div>
    </div>
  `;
}

function renderOperationalChart(stats, money, escape) {
  const orders = stats?.orders || { total: 0, completed: 0, active: 0, awaiting: 0, failed: 0 };
  const daily = Array.isArray(stats?.daily) ? stats.daily : [];
  const totalOrders = orders.total || 0;
  const completed = orders.completed || 0;
  const activeJobs = orders.active || 0;
  const awaiting = orders.awaiting || 0;
  const failed = orders.failed || 0;

  const compPct = totalOrders ? Math.round((completed / totalOrders) * 100) : 0;
  const activePct = totalOrders ? Math.round((activeJobs / totalOrders) * 100) : 0;
  const awaitPct = totalOrders ? Math.round((awaiting / totalOrders) * 100) : 0;
  const failPct = totalOrders ? Math.round((failed / totalOrders) * 100) : 0;

  let dailyHtml = '';
  if (daily.length > 0) {
    const maxDaily = Math.max(...daily.map(d => Number(d.count) || 0), 1);
    const chartHeight = 84;
    const barWidth = 32;
    const gap = 16;
    const totalWidth = daily.length * (barWidth + gap);

    dailyHtml = `
      <div class="daily-bars-chart-wrap">
        <div class="daily-bars-header">
          <span class="daily-chart-title">${icon('trending')} 7-Day Order Volume</span>
          <span class="daily-chart-total">${daily.reduce((acc, d) => acc + Number(d.count || 0), 0)} orders this week</span>
        </div>
        <div class="daily-svg-container">
          <svg viewBox="0 0 ${totalWidth} ${chartHeight + 28}" class="daily-chart-svg" preserveAspectRatio="xMidYMid meet">
            <line x1="0" y1="${chartHeight}" x2="${totalWidth}" y2="${chartHeight}" stroke="#E2E8F0" stroke-width="1" />
            ${daily.map((d, i) => {
              const count = Number(d.count) || 0;
              const height = count > 0 ? Math.max(8, Math.round((count / maxDaily) * chartHeight)) : 4;
              const y = chartHeight - height;
              const x = i * (barWidth + gap) + gap / 2;
              const dateObj = new Date(d.day);
              const label = isNaN(dateObj.getTime()) ? d.day.slice(5) : dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
              return `
                <g class="chart-bar-group" tabindex="0">
                  <title>${label}: ${count} order${count === 1 ? '' : 's'} (${money ? money(d.volume || 0) : ''})</title>
                  <rect x="${x}" y="${y}" width="${barWidth}" height="${height}" rx="4" class="chart-bar-rect ${count > 0 ? 'bar-filled' : 'bar-empty'}" />
                  ${count > 0 ? `<text x="${x + barWidth / 2}" y="${y - 4}" text-anchor="middle" class="chart-val-text">${count}</text>` : ''}
                  <text x="${x + barWidth / 2}" y="${chartHeight + 16}" text-anchor="middle" class="chart-axis-label">${label}</text>
                </g>
              `;
            }).join('')}
          </svg>
        </div>
      </div>
    `;
  } else {
    dailyHtml = `
      <div class="daily-empty-state">
        <span class="muted">${totalOrders > 0 ? 'Daily distribution will graph over the coming days.' : 'No customer print orders recorded yet. As orders are placed, live volume will graph here.'}</span>
      </div>
    `;
  }

  return `
    <section class="panel admin-panel-card admin-ops-card">
      <div class="admin-panel-head">
        <div>
          <h2 class="admin-panel-title">Operational Health & Order Status</h2>
          <p class="admin-panel-sub">Authoritative distribution of ${totalOrders} platform orders across fulfillment states.</p>
        </div>
        <span class="badge active">${totalOrders} Total Orders</span>
      </div>

      <div class="ops-chart-body">
        <div class="ops-status-grid">
          <div class="ops-status-item">
            <div class="ops-status-meta">
              <span class="status-dot dot-green"></span>
              <span class="ops-status-name">Completed</span>
              <strong class="ops-status-val">${completed} <small>(${compPct}%)</small></strong>
            </div>
            <div class="ops-bar-track"><div class="ops-bar-fill fill-green" style="width: ${compPct}%;"></div></div>
          </div>

          <div class="ops-status-item">
            <div class="ops-status-meta">
              <span class="status-dot dot-blue"></span>
              <span class="ops-status-name">Printing & Queued</span>
              <strong class="ops-status-val">${activeJobs} <small>(${activePct}%)</small></strong>
            </div>
            <div class="ops-bar-track"><div class="ops-bar-fill fill-blue" style="width: ${activePct}%;"></div></div>
          </div>

          <div class="ops-status-item">
            <div class="ops-status-meta">
              <span class="status-dot dot-amber"></span>
              <span class="ops-status-name">Awaiting Payment</span>
              <strong class="ops-status-val">${awaiting} <small>(${awaitPct}%)</small></strong>
            </div>
            <div class="ops-bar-track"><div class="ops-bar-fill fill-amber" style="width: ${awaitPct}%;"></div></div>
          </div>

          <div class="ops-status-item">
            <div class="ops-status-meta">
              <span class="status-dot dot-red"></span>
              <span class="ops-status-name">Cancelled / Failed</span>
              <strong class="ops-status-val">${failed} <small>(${failPct}%)</small></strong>
            </div>
            <div class="ops-bar-track"><div class="ops-bar-fill fill-red" style="width: ${failPct}%;"></div></div>
          </div>
        </div>

        ${dailyHtml}
      </div>
    </section>
  `;
}

export function adminDashboard({ view, shops, events, stats, filter, escape, badge, time, empty, money }) {
  const pending = shops.filter(shop => shop.status === 'pending');
  const active = shops.filter(shop => shop.status === 'active');
  const suspended = shops.filter(shop => shop.status === 'suspended');
  const visible = view === 'admin' ? shops : shops.filter(shop => filter === 'all' || shop.status === filter);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const friendly = {
    'shop.registered': 'Shop registered',
    'shop.active': 'Shop approved',
    'shop.suspended': 'Shop suspended',
    'prices.updated': 'Shop prices updated',
    'print.confirmed.file_deleted': 'Print confirmed · File deleted',
    'file.expired.deleted': 'File expired · Deleted',
    'cash.collected': 'Cash payment confirmed',
    'auth.login': 'Admin sign in',
    'mfa.enabled': 'MFA security enabled'
  };

  const totalShopsCount = stats?.shops?.total ?? shops.length;
  const activeShopsCount = stats?.shops?.active ?? active.length;
  const pendingShopsCount = stats?.shops?.pending ?? pending.length;
  const suspendedShopsCount = stats?.shops?.suspended ?? suspended.length;
  const ordersTotal = stats?.orders?.total ?? 0;
  const ordersToday = stats?.orders?.today ?? 0;
  const devicesOnline = stats?.devices?.online ?? 0;
  const devicesTotal = stats?.devices?.total ?? 0;

  return `
    <div class="admin-header-wrapper">
      <div class="admin-header-left">
        <span class="admin-greeting">${greeting}, Administrator 👋</span>
        <h1 class="admin-page-title">${view === 'shops' ? 'Shop directory' : 'Platform overview'}</h1>
        <p class="admin-page-sub">${view === 'shops' ? 'Review registrations and manage shop access.' : 'Manage shops, review applications and monitor platform printing operations.'}</p>
      </div>
      <div class="admin-header-actions">
        <button type="button" class="secondary btn-refresh-pill" id="admin-refresh" aria-label="Refresh platform data">
          ${icon('refresh')} <span>Refresh</span>
        </button>
      </div>
    </div>

    <!-- 4 KPI Metrics Grid -->
    <div class="overview-metrics-grid admin-metrics-grid">
      <div class="metric-card admin-kpi-card">
        <div class="admin-kpi-top">
          <div class="metric-card-icon-wrap icon-green">
            ${icon('shop')}
          </div>
          <span class="trend-badge trend-green">${ordersToday > 0 ? `${ordersToday} today` : 'Active network'}</span>
        </div>
        <span class="metric-card-label">Registered shops</span>
        <strong class="metric-card-value">${totalShopsCount}</strong>
        <span class="metric-card-sub">${ordersTotal} total print orders</span>
      </div>

      <div class="metric-card admin-kpi-card">
        <div class="admin-kpi-top">
          <div class="metric-card-icon-wrap icon-blue">
            ${icon('users')}
          </div>
          <span class="trend-badge trend-blue">${devicesOnline} / ${devicesTotal} devices online</span>
        </div>
        <span class="metric-card-label">Active shops</span>
        <strong class="metric-card-value">${activeShopsCount}</strong>
        <span class="metric-card-sub">Accepting live customer orders</span>
      </div>

      <div class="metric-card admin-kpi-card">
        <div class="admin-kpi-top">
          <div class="metric-card-icon-wrap icon-amber">
            ${icon('file')}
          </div>
          <span class="trend-badge ${pendingShopsCount ? 'trend-amber' : 'trend-neutral'}">${pendingShopsCount ? `${pendingShopsCount} pending` : 'All reviewed'}</span>
        </div>
        <span class="metric-card-label">Awaiting review</span>
        <strong class="metric-card-value">${pendingShopsCount}</strong>
        <span class="metric-card-sub">Shop applications</span>
      </div>

      <div class="metric-card admin-kpi-card">
        <div class="admin-kpi-top">
          <div class="metric-card-icon-wrap icon-purple">
            ${icon('chart')}
          </div>
          <span class="trend-badge trend-purple">${money ? money(stats?.transactions?.volume ?? 0) : '₹0.00'}</span>
        </div>
        <span class="metric-card-label">Platform orders</span>
        <strong class="metric-card-value">${ordersTotal}</strong>
        <span class="metric-card-sub">${stats?.orders?.completed ?? 0} fulfilled prints</span>
      </div>
    </div>

    <!-- Pending Applications Alert Banner -->
    ${pending.length > 0 ? `
      <div class="admin-pending-alert-card">
        <div class="alert-icon-box">
          ${icon('alert')}
        </div>
        <div class="alert-content-box">
          <strong>${pending.length} ${pending.length === 1 ? 'shop application is' : 'shop applications are'} waiting for approval</strong>
          <p>Review and approve pending applications to enable new shops to fulfill customer prints.</p>
        </div>
        <a href="#shops" class="btn-amber-review" id="review-shops">
          Review applications →
        </a>
      </div>
    ` : ''}

    <!-- Main Two-Column Layout -->
    <div class="admin-main-layout">
      <!-- Left Column: Operations Chart, Applications Table & Recent Activity -->
      <div class="admin-left-col">
        ${view === 'admin' ? renderOperationalChart(stats, money, escape) : ''}
        <!-- Shop Applications Card -->
        <section class="panel admin-panel-card">
          <div class="admin-panel-head">
            <div>
              <h2 class="admin-panel-title">Shop applications</h2>
              <p class="admin-panel-sub">Review owner and shop details before approving access.</p>
            </div>
            <div class="shop-filter-controls">
              <div class="search-input-wrapper">
                ${icon('search')}
                <input type="text" id="shop-search-input" placeholder="Search applications..." aria-label="Search applications">
              </div>
              <div class="select-wrapper">
                <select id="shop-status-select" class="shop-status-dropdown" aria-label="Filter status">
                  <option value="all">All status</option>
                  <option value="pending" ${filter === 'pending' ? 'selected' : ''}>Pending</option>
                  <option value="active" ${filter === 'active' ? 'selected' : ''}>Active</option>
                  <option value="suspended" ${filter === 'suspended' ? 'selected' : ''}>Suspended</option>
                </select>
              </div>
            </div>
          </div>

          ${visible.length ? `
            <div class="desktop-admin-table-wrap">
              <table class="premium-admin-table">
                <thead>
                  <tr>
                    <th style="width: 32px;"><input type="checkbox" aria-label="Select all applications"></th>
                    <th>SHOP</th>
                    <th>OWNER</th>
                    <th>APPLIED ON</th>
                    <th>STATUS</th>
                    <th style="text-align: right;">ACTION</th>
                  </tr>
                </thead>
                <tbody>
                  ${visible.map(shop => {
                    const initial = (shop.name || shop.email || 'S').charAt(0).toUpperCase();
                    return `
                      <tr class="shop-app-row" data-status="${shop.status}">
                        <td><input type="checkbox" aria-label="Select ${escape(shop.name)}"></td>
                        <td class="col-shop-meta">
                          <div class="shop-brand-item">
                            <div class="shop-store-icon">${icon('shop')}</div>
                            <div>
                              <strong class="shop-name-text">${escape(shop.name)}</strong>
                              <small class="shop-location-text">${escape(shop.location || 'Bhubaneswar')}</small>
                            </div>
                          </div>
                        </td>
                        <td class="col-owner-meta">
                          <div class="owner-avatar-item">
                            <span class="owner-avatar-circle">${escape(initial)}</span>
                            <span class="owner-email-text">${escape(shop.email)}</span>
                          </div>
                        </td>
                        <td class="col-applied-time">
                          ${formatAdminDateTime(shop.created)}
                        </td>
                        <td class="col-status-pill">
                          ${shop.status === 'pending'
                            ? `<span class="status-pill status-review">Pending Approval</span>`
                            : shop.status === 'active'
                            ? `<span class="status-pill status-ready"><span class="status-dot"></span> Active</span>`
                            : `<span class="status-pill status-failed">Suspended</span>`}
                        </td>
                        <td class="col-actions-btns">
                          <div class="shop-actions-group">
                            ${shop.status === 'pending' ? `
                              <button type="button" class="btn-approve-sm" data-shop="${shop.id}" data-status="active">
                                ${icon('check')} Approve
                              </button>
                              <button type="button" class="btn-reject-sm" data-shop="${shop.id}" data-status="suspended">
                                ${icon('cross')} Reject
                              </button>
                              <button type="button" class="icon-button action-dots-btn" aria-label="More actions">
                                ${icon('dots')}
                              </button>
                            ` : shop.status === 'active' ? `
                              <button type="button" class="btn-reject-sm" data-shop="${shop.id}" data-status="suspended">
                                Suspend
                              </button>
                            ` : `
                              <button type="button" class="btn-approve-sm" data-shop="${shop.id}" data-status="active">
                                Reactivate
                              </button>
                            `}
                          </div>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>

            <!-- Mobile Stacked Application Cards -->
            <div class="mobile-apps-cards-list">
              ${visible.map(shop => {
                const initial = (shop.name || shop.email || 'S').charAt(0).toUpperCase();
                return `
                  <div class="mobile-app-card" data-status="${shop.status}">
                    <div class="mobile-app-header">
                      <div class="shop-brand-item">
                        <div class="shop-store-icon">${icon('shop')}</div>
                        <div>
                          <strong class="shop-name-text">${escape(shop.name)}</strong>
                          <small class="shop-location-text">${escape(shop.location || 'Bhubaneswar')}</small>
                        </div>
                      </div>
                      ${shop.status === 'pending'
                        ? `<span class="status-pill status-review">Pending</span>`
                        : shop.status === 'active'
                        ? `<span class="status-pill status-ready"><span class="status-dot"></span> Active</span>`
                        : `<span class="status-pill status-failed">Suspended</span>`}
                    </div>
                    <div class="mobile-app-owner">
                      <span class="owner-avatar-circle">${escape(initial)}</span>
                      <span>${escape(shop.email)}</span>
                    </div>
                    <div class="mobile-app-date">
                      Applied on: ${formatAdminDateTime(shop.created)}
                    </div>
                    <div class="mobile-app-actions">
                      ${shop.status === 'pending' ? `
                        <button type="button" class="btn-approve-sm full-btn" data-shop="${shop.id}" data-status="active">
                          ${icon('check')} Approve
                        </button>
                        <button type="button" class="btn-reject-sm full-btn" data-shop="${shop.id}" data-status="suspended">
                          ${icon('cross')} Reject
                        </button>
                      ` : shop.status === 'active' ? `
                        <button type="button" class="btn-reject-sm full-btn" data-shop="${shop.id}" data-status="suspended">
                          Suspend
                        </button>
                      ` : `
                        <button type="button" class="btn-approve-sm full-btn" data-shop="${shop.id}" data-status="active">
                          Reactivate
                        </button>
                      `}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          ` : empty(
            view === 'admin' ? 'No applications waiting.' : 'No shops in this view.',
            view === 'admin' ? 'New shop registrations will appear here for review.' : 'Try another filter to see registered shops.'
          )}
        </section>

        <!-- Recent Activity Card -->
        <section class="panel admin-panel-card">
          <div class="admin-panel-head">
            <div>
              <h2 class="admin-panel-title">Recent activity</h2>
              <p class="admin-panel-sub">Track important events across the platform.</p>
            </div>
            <a href="#audit" class="link-view-full">View full audit log →</a>
          </div>

          ${events.length ? `
            <div class="recent-activity-feed">
              ${events.slice(0, 6).map(event => {
                const isDelete = event.action.includes('delete') || event.action.includes('expired');
                const isShop = event.action.startsWith('shop');
                const isAuth = event.action.includes('auth') || event.action.includes('mfa');
                const actionText = friendly[event.action] || event.action.replaceAll('.', ' ').replaceAll('_', ' ');
                const iconType = isDelete ? 'trash' : isShop ? 'shop' : isAuth ? 'shield' : 'clock';
                const iconClass = isDelete ? 'icon-danger-circle' : isShop ? 'icon-green-circle' : isAuth ? 'icon-purple-circle' : 'icon-blue-circle';

                return `
                  <div class="activity-feed-row">
                    <div class="activity-icon-bubble ${iconClass}">
                      ${icon(iconType)}
                    </div>
                    <div class="activity-text-col">
                      <strong class="activity-action-name">${escape(actionText)}</strong>
                      <small class="activity-target-sub">Target ${escape(event.target ? event.target.slice(0, 14) : 'system')}</small>
                    </div>
                    <div class="activity-time-col">
                      ${formatActivityTime(event.created)}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          ` : empty('No activity yet.', 'Administrative and shop fulfillment actions will appear here.')}
        </section>
      </div>

      <!-- Right Column: Utility Panels -->
      <aside class="admin-right-col">
        <!-- Shop Access Summary Card -->
        <section class="panel utility-card admin-summary-card">
          <div class="utility-card-header">
            <h3 class="aside-card-title">Shop access summary</h3>
            <a href="#shops" class="utility-header-link">View all →</a>
          </div>
          
          <div class="donut-chart-wrapper">
            ${renderDonutChart(active.length, pending.length, suspended.length)}
          </div>

          <div class="access-breakdown-legend">
            <div class="breakdown-legend-item">
              <span class="legend-dot dot-green"></span>
              <span class="legend-label">Active</span>
              <strong class="legend-value">${active.length}</strong>
            </div>
            <div class="breakdown-legend-item">
              <span class="legend-dot dot-amber"></span>
              <span class="legend-label">Awaiting approval</span>
              <strong class="legend-value">${pending.length}</strong>
            </div>
            <div class="breakdown-legend-item">
              <span class="legend-dot dot-red"></span>
              <span class="legend-label">Suspended</span>
              <strong class="legend-value">${suspended.length}</strong>
            </div>
          </div>
        </section>

        <!-- Quick Actions Card -->
        <section class="panel utility-card">
          <h3 class="aside-card-title" style="margin-bottom: 14px;">Quick actions</h3>
          <div class="quick-actions-2x2">
            <a href="#shops" class="quick-action-tile">
              <span class="qa-tile-icon icon-blue">${icon('shop')}</span>
              <span class="qa-tile-text">View all shops</span>
              <span class="qa-tile-arrow">›</span>
            </a>
            <a href="#shops" class="quick-action-tile" id="qa-review-apps">
              <span class="qa-tile-icon icon-amber">${icon('file')}</span>
              <span class="qa-tile-text">Review applications</span>
              <span class="qa-tile-arrow">›</span>
            </a>
            <a href="#audit" class="quick-action-tile">
              <span class="qa-tile-icon icon-purple">${icon('clock')}</span>
              <span class="qa-tile-text">Open audit log</span>
              <span class="qa-tile-arrow">›</span>
            </a>
            <a href="#account" class="quick-action-tile">
              <span class="qa-tile-icon icon-slate">${icon('gear')}</span>
              <span class="qa-tile-text">Platform settings</span>
              <span class="qa-tile-arrow">›</span>
            </a>
          </div>
        </section>

        <!-- Customer Privacy Card -->
        <section class="panel utility-card admin-privacy-card">
          <div class="privacy-card-header">
            <div class="privacy-header-title">
              <span class="privacy-shield-icon">${icon('shield')}</span>
              <h3>Customer privacy</h3>
            </div>
            <span class="privacy-header-arrow">›</span>
          </div>
          <p class="privacy-card-desc">
            Manage shop access and review activity without opening customer files.
          </p>
          <a href="#audit" class="btn-privacy-audit">
            Review audit log →
          </a>
          <div class="privacy-watermark-shield" aria-hidden="true">
            ${icon('shield')}
          </div>
        </section>
      </aside>
    </div>
  `;
}

