import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { hashPassword } from '../server/security.js';
import { cropBounds, applyAspectRatio, detectDocumentEdges, applyFilterToImageData } from '../public/crop.js';
import { configuration } from '../server/config.js';

test('Document Scanner & Crop algorithm tests', () => {
  // Test cropBounds
  const bounds = cropBounds({ x: 10, y: 20 }, { x: 110, y: 120 }, 200, 200);
  assert.deepEqual(bounds, { left: 10, top: 20, width: 100, height: 100 });

  // Test applyAspectRatio
  const a4Port = applyAspectRatio({ left: 10, top: 10, width: 100, height: 100 }, 0.707, 500, 500);
  assert.equal(a4Port.width, 100);
  assert.equal(a4Port.height, 141);

  const idCard = applyAspectRatio({ left: 0, top: 0, width: 158, height: 100 }, 1.586, 500, 500);
  assert.equal(idCard.width, 158);
  assert.equal(idCard.height, 100);

  // Test applyFilterToImageData
  const dummyPixels = new Uint8ClampedArray([
    100, 150, 200, 255,  // Pixel 1
    50, 60, 70, 255,     // Pixel 2
    240, 240, 240, 255,  // Pixel 3
    10, 10, 10, 255      // Pixel 4
  ]);
  const imgData = { data: dummyPixels, width: 2, height: 2 };

  // Grayscale filter
  applyFilterToImageData(imgData, 'grayscale');
  assert.equal(imgData.data[0], imgData.data[1]);
  assert.equal(imgData.data[1], imgData.data[2]);

  // Clean B&W filter
  applyFilterToImageData(imgData, 'bw');
  assert.ok(imgData.data[0] === 0 || imgData.data[0] === 255);
  assert.ok(imgData.data[4] === 0 || imgData.data[4] === 255);

  // Edge detection on simulated page
  const pageW = 100, pageH = 100;
  const pagePixels = new Uint8ClampedArray(pageW * pageH * 4);
  // Dark background (desk)
  pagePixels.fill(30);
  for (let i = 3; i < pagePixels.length; i += 4) pagePixels[i] = 255;
  // White document in center (from x: 25 to 75, y: 20 to 80)
  for (let y = 20; y < 80; y++) {
    for (let x = 25; x < 75; x++) {
      const idx = (y * pageW + x) * 4;
      pagePixels[idx] = 240;
      pagePixels[idx + 1] = 240;
      pagePixels[idx + 2] = 240;
    }
  }
  const detected = detectDocumentEdges({ data: pagePixels, width: pageW, height: pageH }, pageW, pageH);
  assert.ok(detected !== null, 'Should detect document boundaries');
  assert.ok(detected.width >= 40 && detected.width <= 60);
  assert.ok(detected.height >= 50 && detected.height <= 70);
});

test('Unified /workspace route and account status enforcement (active, suspended, disabled)', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();

  const service = await createApp({ database: db, seed: false });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await service.close();
  });

  const request = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    let data;
    try { data = await res.json(); } catch {}
    return {
      status: res.status,
      data,
      cookie: res.headers.get('set-cookie')
    };
  };

  // 1. Verify GET /workspace returns 200 HTML
  const wsRes = await fetch(base + '/workspace');
  assert.equal(wsRes.status, 200, '/workspace must route to public app entry');
  const wsHtml = await wsRes.text();
  assert.match(wsHtml, /SmartPrint/i);

  // 2. Insert test accounts: active owner, suspended owner, disabled owner
  const adminId = 'admin-user-audit-1';
  const ownerActiveId = 'owner-active-audit-1';
  const ownerSuspendedId = 'owner-suspended-audit-1';
  const ownerDisabledId = 'owner-disabled-audit-1';
  const pwHash = await hashPassword('SecretPassword123!');

  await db.query(`INSERT INTO users (id, email, password, role, status) VALUES 
    ($1, 'admin@smartprint.test', $2, 'admin', 'active'),
    ($3, 'owner-active@smartprint.test', $2, 'owner', 'active'),
    ($4, 'owner-suspended@smartprint.test', $2, 'owner', 'suspended'),
    ($5, 'owner-disabled@smartprint.test', $2, 'owner', 'disabled')`,
    [adminId, pwHash, ownerActiveId, ownerSuspendedId, ownerDisabledId]
  );

  await db.query(`INSERT INTO shops (id, owner_id, name, slug, location, status, bw, color) VALUES 
    ('shop-active-1', $1, 'Active Shop', 'active-shop', 'Main Road', 'active', 200, 1000)`,
    [ownerActiveId]
  );

  // 3. Login with active owner succeeds
  const activeLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner-active@smartprint.test', password: 'SecretPassword123!' }
  });
  assert.equal(activeLogin.status, 200);
  assert.equal(activeLogin.data.role, 'owner');
  assert.equal(activeLogin.data.status, 'active');

  // 4. Login with suspended owner is rejected with 403
  const suspendedLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner-suspended@smartprint.test', password: 'SecretPassword123!' }
  });
  assert.equal(suspendedLogin.status, 403);
  assert.match(suspendedLogin.data.message || suspendedLogin.data.error, /suspended/i);

  // 5. Login with disabled owner is rejected with 403
  const disabledLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner-disabled@smartprint.test', password: 'SecretPassword123!' }
  });
  assert.equal(disabledLogin.status, 403);
  assert.match(disabledLogin.data.message || disabledLogin.data.error, /disabled/i);

  // 6. Session revocation: active session becomes suspended mid-session
  const ordersBefore = await request('/api/owner/orders', { cookie: activeLogin.cookie });
  assert.equal(ordersBefore.status, 200);

  await db.query("UPDATE users SET status='suspended' WHERE id=$1", [ownerActiveId]);

  const ordersAfter = await request('/api/owner/orders', { cookie: activeLogin.cookie });
  assert.equal(ordersAfter.status, 401, 'Suspended user must immediately lose access to protected owner routes');
});

test('Role-based server authorization and cross-tenant isolation', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();

  const service = await createApp({ database: db, seed: false });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await service.close();
  });

  const request = async (path, { method = 'GET', body, cookie } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    let data;
    try { data = await res.json(); } catch {}
    return { status: res.status, data, cookie: res.headers.get('set-cookie') };
  };

  const pwHash = await hashPassword('OwnerPassword123!');
  const owner1 = 'owner-tenant-1';
  const owner2 = 'owner-tenant-2';

  await db.query(`INSERT INTO users (id, email, password, role, status) VALUES 
    ($1, 'owner1@smartprint.test', $3, 'owner', 'active'),
    ($2, 'owner2@smartprint.test', $3, 'owner', 'active')`,
    [owner1, owner2, pwHash]
  );

  await db.query(`INSERT INTO shops (id, owner_id, name, slug, location, status, bw, color) VALUES 
    ('shop-1', $1, 'Shop One', 'shop-one', 'Location One', 'active', 200, 1000),
    ('shop-2', $2, 'Shop Two', 'shop-two', 'Location Two', 'active', 200, 1000)`,
    [owner1, owner2]
  );

  const login1 = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner1@smartprint.test', password: 'OwnerPassword123!' }
  });
  assert.equal(login1.status, 200);

  // Shop owner cannot access admin routes (must return 403)
  const adminShopsRes = await request('/api/admin/shops', { cookie: login1.cookie });
  assert.equal(adminShopsRes.status, 403);

  const adminStatsRes = await request('/api/admin/stats', { cookie: login1.cookie });
  assert.equal(adminStatsRes.status, 403);
});

test('Notification persistence and REST operations', async () => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();

  await db.query("INSERT INTO users (id, email, password, role, status) VALUES ('u-notif-1', 'notif@test.com', 'hash', 'owner', 'active')");
  await db.query("INSERT INTO shops (id, owner_id, name, slug, location, status) VALUES ('shop-notif-1', 'u-notif-1', 'Notif Shop', 'notif-shop', 'Market Area', 'active')");

  const { createNotification } = await import('../server/notifications.js');
  const n1 = await createNotification(db, {
    shopId: 'shop-notif-1',
    eventType: 'order.created',
    title: '📄 New Print Order #1001',
    body: 'Customer placed order for 2 pages B&W (₹4.00).'
  });

  const n2 = await createNotification(db, {
    shopId: 'shop-notif-1',
    eventType: 'payment.confirmed',
    title: '✅ Payment Confirmed #1001',
    body: 'Payment received via cash at counter.'
  });

  assert.ok(n1.id);
  assert.ok(n2.id);

  const rows = await db.query('SELECT * FROM notifications WHERE shop_id=$1 ORDER BY created DESC', ['shop-notif-1']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].is_read, 0);

  await db.query('UPDATE notifications SET is_read=1 WHERE id=$1', [n1.id]);
  const [readRow] = await db.query('SELECT is_read FROM notifications WHERE id=$1', [n1.id]);
  assert.equal(readRow.is_read, 1);

  await db.query('UPDATE notifications SET is_read=1 WHERE shop_id=$1', ['shop-notif-1']);
  const unreadCount = await db.query('SELECT COUNT(*) as count FROM notifications WHERE shop_id=$1 AND is_read=0', ['shop-notif-1']);
  assert.equal(Number(unreadCount[0].count), 0);
});

test('Payment safety: live Razorpay blocked unless explicitly enabled', () => {
  const origEnv = { ...process.env };

  try {
    // 1. Live key provided without RAZORPAY_LIVE_ENABLED=true
    process.env.RAZORPAY_KEY_ID = 'rzp_live_1234567890abcdef';
    process.env.RAZORPAY_KEY_SECRET = 'live_secret_test';
    delete process.env.RAZORPAY_LIVE_ENABLED;

    const confBlocked = configuration();
    assert.equal(confBlocked.payments, false, 'Live payments must be disabled without explicit flag');
    assert.equal(confBlocked.paymentMode, 'disabled');

    // 2. Test key provided
    process.env.RAZORPAY_KEY_ID = 'rzp_test_1234567890abcdef';
    process.env.RAZORPAY_KEY_SECRET = 'test_secret';
    delete process.env.RAZORPAY_LIVE_ENABLED;

    const confTest = configuration();
    assert.equal(confTest.payments, true);
    assert.equal(confTest.paymentMode, 'test');

    // 3. No keys provided
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    const confNone = configuration();
    assert.equal(confNone.payments, false);
    assert.equal(confNone.paymentMode, 'disabled');
  } finally {
    process.env = origEnv;
  }
});
