import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { hashPassword, checkPassword } from '../server/security.js';

test('Security architecture requirements verification', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  await db.migrate();

  const service = await createApp({ database: db, seed: true });
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

  // 1. Single login endpoint (/api/auth/login) - backend automatically determines role (owner)
  const ownerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(ownerLogin.status, 200);
  assert.equal(ownerLogin.data.role, 'owner');
  assert.match(ownerLogin.cookie, /sp_session=/);
  assert.match(ownerLogin.cookie, /HttpOnly/i);

  // 2. Single login endpoint (/api/auth/login) - backend automatically determines role (admin)
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.data.role, 'admin');

  // 3. Protected admin creation: public registration NEVER creates admin even if requested
  const regAttempt = await request('/api/auth/register', {
    method: 'POST',
    body: {
      email: 'hacker@example.com',
      password: 'HackerPassword!2026',
      name: 'Hacker Shop',
      location: 'Underground',
      role: 'admin' // Attempt privilege escalation
    }
  });
  assert.equal(regAttempt.status, 201);
  const [createdUser] = await db.query('SELECT role FROM users WHERE email=$1', ['hacker@example.com']);
  assert.equal(createdUser.role, 'owner', 'Role must remain owner regardless of input payload');

  // 4. Data isolation: Shop owners can access only their own shop data
  const ownerCookie = ownerLogin.cookie.split(';')[0];
  const hackerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'hacker@example.com', password: 'HackerPassword!2026' }
  });
  const hackerCookie = hackerLogin.cookie.split(';')[0];

  const ownerShop = await request('/api/owner/shop', { cookie: ownerCookie });
  const hackerShop = await request('/api/owner/shop', { cookie: hackerCookie });
  assert.notEqual(ownerShop.data.id, hackerShop.data.id);

  // 5. Backend authorization: Admin APIs reject non-admins
  const forbiddenAdminCheck = await request('/api/admin/shops', { cookie: ownerCookie });
  assert.equal(forbiddenAdminCheck.status, 403, 'Shop owners must be blocked from admin endpoints');

  // 6. Argon2id password hashing verification
  const newHash = await hashPassword('VerySecurePassword!123');
  assert.ok(newHash.startsWith('$argon2id'), 'Must hash new passwords with Argon2id');
  assert.equal(await checkPassword('VerySecurePassword!123', newHash), true);
  assert.equal(await checkPassword('WrongPassword', newHash), false);

  // 7. WebAuthn Passkeys options endpoint operates correctly
  const webauthnOpt = await request('/api/auth/webauthn/register-options', {
    method: 'POST',
    cookie: ownerCookie
  });
  assert.equal(webauthnOpt.status, 200);
  assert.equal(webauthnOpt.data.rp.name, 'SmartPrint');
  assert.ok(webauthnOpt.data.challenge);
});
