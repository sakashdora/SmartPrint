import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { totp, hashPassword } from '../server/security.js';

test('Production Authentication Audit: Customer, Admin, and Owner Full Lifecycle Verification', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await service.close();
  });

  async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const contentType = res.headers.get('content-type') || '';
    const setCookie = res.headers.get('set-cookie');
    return {
      status: res.status,
      setCookie,
      cookie: setCookie ? setCookie.split(';')[0] : null,
      data: contentType.includes('json') ? await res.json() : await res.text()
    };
  }

  // 1. Direct navigation to /workspace serves public index.html with 200 OK
  const workspaceHtml = await call('/workspace');
  assert.equal(workspaceHtml.status, 200);
  assert.ok(typeof workspaceHtml.data === 'string' && workspaceHtml.data.includes('<title>SmartPrint'), 'Must serve HTML shell on /workspace');

  const loginHtml = await call('/login');
  assert.equal(loginHtml.status, 200);
  assert.ok(typeof loginHtml.data === 'string' && loginHtml.data.includes('<title>SmartPrint'), 'Must serve HTML shell on /login');

  // 2. Unauthenticated session check returns null
  const unauthMe = await call('/api/me');
  assert.equal(unauthMe.status, 200);
  assert.equal(unauthMe.data, null, 'Unauthenticated /api/me must return null');

  // 3. Admin authentication & session creation
  const adminLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(adminLogin.status, 200, 'Admin login must succeed');
  assert.equal(adminLogin.data.role, 'admin', 'Resolved role must be admin');
  assert.ok(adminLogin.cookie, 'Session cookie must be returned');
  assert.ok(adminLogin.setCookie.includes('SameSite=Lax'), 'Session cookie must use SameSite=Lax for external link resilience');
  assert.ok(adminLogin.setCookie.includes('HttpOnly'), 'Session cookie must be HttpOnly');

  const adminCookie = adminLogin.cookie;

  // 4. Admin session restoration via /api/me
  const adminMe = await call('/api/me', { cookie: adminCookie });
  assert.equal(adminMe.status, 200);
  assert.equal(adminMe.data.email, 'admin@smartprint.local');
  assert.equal(adminMe.data.role, 'admin');
  assert.equal(adminMe.data.password, undefined, 'Password must never be exposed');

  // 5. Admin authorization enforcement on backend
  const adminShops = await call('/api/admin/shops', { cookie: adminCookie });
  assert.equal(adminShops.status, 200, 'Admin can access /api/admin/shops');

  const adminOwnerForbidden = await call('/api/owner/shop', { cookie: adminCookie });
  assert.equal(adminOwnerForbidden.status, 403, 'Admin cannot access /api/owner endpoints without owner shop');

  // 6. Shop Owner authentication & authorization
  const ownerLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(ownerLogin.status, 200);
  assert.equal(ownerLogin.data.role, 'owner');
  const ownerCookie = ownerLogin.cookie;

  const ownerShop = await call('/api/owner/shop', { cookie: ownerCookie });
  assert.equal(ownerShop.status, 200, 'Owner can access their shop details');

  const ownerAdminForbidden = await call('/api/admin/shops', { cookie: ownerCookie });
  assert.equal(ownerAdminForbidden.status, 403, 'Owner is forbidden from /api/admin endpoints');

  // 7. Customer account creation & authentication
  const customerId = randomUUID();
  const customerEmail = 'customer.test@example.com';
  const customerPw = await hashPassword('CustomerSecurePass!2026');
  await db.query("INSERT INTO users (id, email, password, role) VALUES ($1, $2, $3, 'customer')", [customerId, customerEmail, customerPw]);

  const customerLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: customerEmail, password: 'CustomerSecurePass!2026' }
  });
  assert.equal(customerLogin.status, 200, 'Customer login must succeed');
  assert.equal(customerLogin.data.role, 'customer', 'Customer role must be preserved');
  assert.equal(customerLogin.data.email, customerEmail);
  const customerCookie = customerLogin.cookie;

  const customerMe = await call('/api/me', { cookie: customerCookie });
  assert.equal(customerMe.status, 200);
  assert.equal(customerMe.data.role, 'customer');

  // 8. Customer cannot access Owner or Admin endpoints
  const custOwnerForbidden = await call('/api/owner/shop', { cookie: customerCookie });
  assert.equal(custOwnerForbidden.status, 403, 'Customer cannot access /api/owner');

  const custAdminForbidden = await call('/api/admin/shops', { cookie: customerCookie });
  assert.equal(custAdminForbidden.status, 403, 'Customer cannot access /api/admin');

  // 9. Client cannot grant itself privileged role via login payload
  const spoofAttempt = await call('/api/auth/login', {
    method: 'POST',
    body: { email: customerEmail, password: 'CustomerSecurePass!2026', role: 'admin' }
  });
  assert.equal(spoofAttempt.status, 401, 'User cannot elevate role by passing role in login body');

  // 10. Account suspension blocks login and immediately revokes active session
  await db.query("UPDATE users SET status='suspended' WHERE id=$1", [customerId]);

  const suspendedMe = await call('/api/me', { cookie: customerCookie });
  assert.equal(suspendedMe.status, 200);
  assert.equal(suspendedMe.data, null, 'Active session for suspended user must be instantly revoked');

  const suspendedLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: customerEmail, password: 'CustomerSecurePass!2026' }
  });
  assert.equal(suspendedLogin.status, 403, 'Suspended account must be rejected with 403 Forbidden');

  // 11. Logout terminates session cleanly
  const logoutRes = await call('/api/auth/logout', { method: 'POST', cookie: adminCookie });
  assert.equal(logoutRes.status, 200);
  assert.ok(logoutRes.setCookie && (logoutRes.setCookie.toLowerCase().includes('max-age=0') || logoutRes.setCookie.toLowerCase().includes('expires=')), 'Logout must clear cookie');

  const afterLogoutMe = await call('/api/me', { cookie: adminCookie });
  assert.equal(afterLogoutMe.status, 200);
  assert.equal(afterLogoutMe.data, null, 'Session must no longer be valid after logout');
});
