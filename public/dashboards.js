import { icon } from './ui.js';

const attention = order => ['awaiting_payment', 'awaiting_confirmation', 'needs_review', 'payment_review', 'failed'].includes(order.status);
function tabs(items, selected, attribute) {
  return `<div class="filter-tabs" role="group" aria-label="Filter records">${items.map(([id, label, count]) => `<button type="button" ${attribute}="${id}" class="${id === selected ? 'selected' : ''}" aria-pressed="${id === selected}">${label}<span>${count}</span></button>`).join('')}</div>`;
}
function actions(order, money) {
  const button = (action, label, primary = false, extraClass = '') => `<button class="${primary ? 'primary' : 'secondary'} ${extraClass}" data-action="${action}" data-id="${order.id}">${label}</button>`;
  const items = [];
  if (order.status === 'awaiting_payment') {
    if (order.method === 'cash') items.push(button('cash', `Collect ${money(order.amount)}`, true));
    if (order.method === 'upi') items.push(button('upi-confirm', 'Verify UPI', true));
  }
  if (order.status === 'queued') {
    items.push(button('start', 'Start print', true));
    if (!order.priority) items.push(button('priority', '⚡ Rush Job', false, 'rush-btn'));
  }
  if (['printing', 'awaiting_confirmation', 'needs_review'].includes(order.status)) {
    items.push(button('complete', 'Confirm output', true));
    if (order.status === 'printing' && !order.automatic) items.push(button('document', 'Download for print'));
    if (['needs_review', 'failed'].includes(order.status)) items.push(button('retry', '🔄 Retry Print', false));
    items.push(button('resolve-failed', 'Print failed / stopped'));
  }
  if (order.status === 'failed') {
    items.push(button('retry', '🔄 Retry Print', true));
  }
  if (['awaiting_payment', 'queued', 'failed', 'expired', 'payment_review'].includes(order.status)) items.push(button('cancel', 'Cancel'));
  if (order.payment === 'paid' && ['cancelled', 'failed', 'expired', 'payment_review'].includes(order.status)) items.push(button('refund', 'Record refund'));
  return items.length ? `<div class="actions">${items.join('')}</div>` : `<span class="muted">${order.deleted_at ? 'File deleted' : 'Waiting for update'}</span>`;
}

export function ownerDashboard({ view, head, store, orders, summary, devices, filter, escape, money, time, badge, empty }) {
  const activeDevices = devices.filter(device => device.active);
  const online = activeDevices.filter(device => device.heartbeat && Date.now() - Date.parse(device.heartbeat) < 90000);
  const filtered = orders.filter(order => filter === 'ready' ? order.status === 'queued' : filter === 'printing' ? order.status === 'printing' : filter === 'attention' ? attention(order) : filter === 'completed' ? order.status === 'completed' : true);
  const visible = view === 'owner' ? filtered.slice(0, 10) : filtered;
  const waitingUpi = orders.filter(order => order.status === 'awaiting_payment' && order.method === 'upi');
  const waitingCash = orders.filter(order => order.status === 'awaiting_payment' && order.method === 'cash');
  const printingCount = orders.filter(order => order.status === 'printing').length;
  const metrics = [
    ['Net collections', money(summary.net), 'All time · After recorded refunds'],
    ['Active Queue', `${summary.active} in progress`, `${printingCount} currently printing · ${summary.awaiting_payment} awaiting payment`],
    ['Printers online', `${online.length} of ${activeDevices.length}`, activeDevices.length ? (online.length ? 'Connected to your shop' : 'Launch connector on shop PC') : 'Connect your first printer'],
  ];
  return `${head(view === 'owner' ? 'Your shop, at a glance.' : 'Print queue & orders')}
    ${store.status !== 'active' ? `<div class="attention-banner banner-pending">${icon('alert')}<div><strong>Awaiting Admin Approval:</strong> Your shop registration is under review by a Platform Administrator. You can configure prices and pair printers now; customers will be able to place orders once approved.</div></div>` : ''}
    <div class="metrics metrics-three">${metrics.map(([label, value, note]) => `<div class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('')}</div>
    <div class="dashboard-grid"><section class="panel queue-panel"><div class="panel-heading"><div><h2>${view === 'owner' ? 'Live print queue' : 'Orders & Queue Management'}</h2><p class="muted">${orders.length === 200 ? 'Latest 200 orders' : `${orders.length} ${orders.length === 1 ? 'order' : 'orders'}`} · Updates in real time</p></div>${view === 'owner' ? '<a href="#queue">View full queue →</a>' : ''}</div>
    ${tabs([['all', 'All', orders.length], ['ready', 'Ready', orders.filter(o => o.status === 'queued').length], ['printing', 'Printing', printingCount], ['attention', 'Needs attention', orders.filter(attention).length], ['completed', 'Completed', orders.filter(o => o.status === 'completed').length]], filter, 'data-queue-filter')}
    ${visible.length ? `<div class="table-wrap"><table class="responsive-table order-table"><thead><tr><th>Order & File</th><th>Print options</th><th>Amount</th><th>Status</th><th>Next step</th></tr></thead><tbody>${visible.map((order, idx) => `<tr>
      <td data-label="Order & File">
        <div class="order-cell-head">
          <strong>#${escape(order.id.slice(0, 8).toUpperCase())}</strong>
          ${order.priority >= 10 ? '<span class="rush-badge">⚡ RUSH</span>' : ''}
        </div>
        <div class="order-filename-row">${icon('file')}<span>${escape(order.file_name || 'document.pdf')}</span></div>
        <small class="muted">${time(order.created)}${order.printer_name ? ` · 🖨️ ${escape(order.printer_name)}` : ''}</small>
      </td>
      <td data-label="Print options">${order.options.color === 'bw' ? 'B&W' : 'Colour'} · ${order.options.copies} ${order.options.copies === 1 ? 'copy' : 'copies'}<small>${order.options.duplex ? 'Both sides' : 'One-sided'} · ${order.sheets} sheets</small></td>
      <td data-label="Amount"><strong>${money(order.amount)}</strong><small>${escape(order.method.toUpperCase())} · ${escape(order.payment)}</small></td>
      <td data-label="Status">${badge(order.status)}</td>
      <td data-label="Next step">${actions(order, money)}</td>
    </tr>`).join('')}</tbody></table></div>` : empty(orders.length ? 'No orders in this view.' : 'Your queue is all clear.', orders.length ? 'Choose another filter to see more orders.' : 'Share your shop QR to receive your first print order.')}
    <div class="panel-foot">${icon('shield')} Confirm the physical output before marking a print complete. Live documents are securely wiped upon completion.</div></section>
    <aside class="dashboard-aside"><section class="panel"><div class="panel-heading"><h2>Payments to check</h2>${icon('wallet')}</div>${waitingUpi.length || waitingCash.length ? `<div class="attention-number">${waitingUpi.length + waitingCash.length}<span>awaiting verification</span></div><div class="detail-line"><span>Direct UPI</span><strong>${waitingUpi.length}</strong></div><div class="detail-line"><span>Cash at counter</span><strong>${waitingCash.length}</strong></div><p class="muted">Check the credit in your own bank or UPI app before confirming a UPI payment.</p><a class="primary wide" href="#queue" id="review-payments">Review queue ${icon('arrow')}</a>` : `<div class="quiet-state">${icon('check')}<strong>All caught up</strong><p>No payments waiting in the latest orders.</p></div>`}</section>
    <section class="panel"><div class="panel-heading"><h2>Printers</h2><a href="#printers">Manage</a></div>${activeDevices.length ? activeDevices.slice(0, 4).map(device => {
      const isDevOnline = online.includes(device);
      return `<div class="printer-row">
        <div class="printer-row-title">${icon('printer')}<span>${escape(device.name)}</span></div>
        <span class="connection ${isDevOnline ? (device.is_paused ? 'paused' : 'online') : 'offline'}">${isDevOnline ? (device.is_paused ? 'Paused' : 'Online') : 'Offline'}</span>
      </div>`;
    }).join('') : `<div class="quiet-state">${icon('printer')}<strong>No printers connected</strong><p>Connect your Windows shop computer to receive print jobs.</p><a href="#printers">Set up a printer ${icon('arrow')}</a></div>`}</section>
    <p class="aside-note">${icon('lock')} Files are deleted after confirmed printing. Transaction records stay available.</p></aside></div>`;
}

export function adminDashboard({ view, shops, events, filter, escape, badge, time, empty }) {
  const pending = shops.filter(shop => shop.status === 'pending');
  const active = shops.filter(shop => shop.status === 'active');
  const suspended = shops.filter(shop => shop.status === 'suspended');
  const visible = view === 'admin' ? pending.slice(0, 5) : shops.filter(shop => filter === 'all' || shop.status === filter);
  const table = visible.length ? `<div class="table-wrap"><table class="responsive-table shop-table"><thead><tr><th>Shop</th><th>Owner</th><th>Status</th><th>Action</th></tr></thead><tbody>${visible.map(shop => `<tr><td data-label="Shop"><strong>${escape(shop.name)}</strong><small>${escape(shop.location)}</small></td><td data-label="Owner" class="owner-email">${escape(shop.email)}</td><td data-label="Status">${badge(shop.status)}</td><td data-label="Action">${shop.status === 'pending' ? `<div class="actions"><button class="primary small" data-shop="${shop.id}" data-status="active">✅ Approve Shop</button><button class="danger small" data-shop="${shop.id}" data-status="suspended">❌ Reject</button></div>` : `<button class="${shop.status === 'active' ? 'danger small' : 'primary small'}" data-shop="${shop.id}" data-status="${shop.status === 'active' ? 'suspended' : 'active'}">${shop.status === 'active' ? 'Suspend shop' : 'Reactivate'}</button>`}</td></tr>`).join('')}</tbody></table></div>` : empty(view === 'admin' ? 'No applications waiting.' : 'No shops in this view.', view === 'admin' ? 'New shop registrations will appear here for review.' : 'Try another filter to see registered shops.');
  const friendly = { 'shop.registered': 'Shop registered', 'shop.active': 'Shop approved', 'shop.suspended': 'Shop suspended', 'prices.updated': 'Shop prices updated', 'print.confirmed.file_deleted': 'Print confirmed · File deleted', 'cash.collected': 'Cash payment confirmed' };
  return `<div class="workhead"><div><h1>${view === 'shops' ? 'Shop directory' : 'Platform overview'}</h1><p class="muted">${view === 'shops' ? 'Review registrations and manage shop access.' : 'Manage shops, review applications and follow recent activity.'}</p></div><button class="secondary" id="admin-refresh">${icon('refresh')} Refresh</button></div>
    <div class="metrics metrics-three">${[['Registered shops', shops.length, 'Across your platform'], ['Active shops', active.length, 'Accepting customer orders'], ['Awaiting review', pending.length, 'Shop applications']].map(([title, value, note]) => `<div class="metric"><span>${title}</span><strong>${value}</strong><small>${note}</small></div>`).join('')}</div>
    ${view === 'admin' && pending.length ? `<div class="attention-banner">${icon('alert')}<span>${pending.length} ${pending.length === 1 ? 'shop is' : 'shops are'} waiting for approval</span><a href="#shops" id="review-shops">Review applications ${icon('arrow')}</a></div>` : ''}
    <div class="dashboard-grid"><div><section class="panel"><div class="panel-heading"><div><h2>${view === 'admin' ? 'Shop applications' : 'Registered shops'}</h2><p class="muted">Review owner and shop details before approving access.</p></div>${view === 'admin' ? '<a href="#shops">View all shops</a>' : ''}</div>${view === 'shops' ? tabs([['all', 'All', shops.length], ['pending', 'Pending', pending.length], ['active', 'Active', active.length], ['suspended', 'Suspended', suspended.length]], filter, 'data-shop-filter') : ''}${table}</section>
    ${view === 'admin' ? `<section class="panel"><div class="panel-heading"><h2>Recent activity</h2><a href="#audit">View audit log</a></div>${events.length ? `<ul class="activity-list">${events.slice(0, 5).map(event => `<li>${icon(event.action.startsWith('shop') ? 'shop' : 'clock')}<div><strong>${escape(friendly[event.action] || event.action.replaceAll('.', ' ').replaceAll('_', ' '))}</strong><small>Target ${escape(event.target.slice(0, 12))}</small></div><time>${time(event.created)}</time></li>`).join('')}</ul>` : empty('No activity yet.', 'Shop and fulfilment actions will appear here.')}</section>` : ''}</div>
    <aside class="dashboard-aside"><section class="panel"><h2>Shop access</h2><div class="detail-line"><span>Active</span><strong>${active.length}</strong></div><div class="detail-line"><span>Awaiting approval</span><strong>${pending.length}</strong></div><div class="detail-line"><span>Suspended</span><strong>${suspended.length}</strong></div><p class="muted">Only approved, active shops can accept new print orders.</p></section><section class="panel"><div class="panel-heading"><h2>Customer privacy</h2>${icon('shield')}</div><p class="muted">Manage shop access and review activity without opening customer files.</p><a href="#audit">Review audit log ${icon('arrow')}</a></section></aside></div>`;
}
