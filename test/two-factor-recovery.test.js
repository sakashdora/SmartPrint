import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { totp } from '../server/security.js';

test('Two-Factor Authentication: TOTP verification, single-use recovery codes, and secure disable', async t => {
  const db = await openDatabase({ url: null, path: ':memory:' });
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await service.close();
  });

  async function call(path, { method = 'GET', body, cookie } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const contentType = res.headers.get('content-type') || '';
    return {
      status: res.status,
      cookie: res.headers.get('set-cookie')?.split(';')[0],
      data: contentType.includes('json') ? await res.json() : await res.text()
    };
  }

  // 1. Initial Login
  const loginRes = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.cookie;

  // 2. Setup MFA
  const setupRes = await call('/api/auth/mfa/setup', { method: 'POST', cookie });
  assert.equal(setupRes.status, 200);
  assert.ok(setupRes.data.secret, 'Must provide base32 secret');

  // Convert base32 to buffer for TOTP generation
  const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0;
  const bytes = [];
  for (const char of setupRes.data.secret) {
    const idx = base32Alphabet.indexOf(char);
    if (idx === -1) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const secretBuffer = Buffer.from(bytes);
  const validCode = totp(secretBuffer);

  // 3. Confirm MFA & receive single-use recovery codes
  const confirmRes = await call('/api/auth/mfa/confirm', {
    method: 'POST',
    cookie,
    body: { code: validCode }
  });
  assert.equal(confirmRes.status, 200);
  assert.ok(Array.isArray(confirmRes.data.recoveryCodes), 'Must return recovery codes');
  assert.equal(confirmRes.data.recoveryCodes.length, 8, 'Must return 8 single-use recovery codes');
  const recoveryCodes = confirmRes.data.recoveryCodes;

  // 4. Test Login without 2FA code fails
  const failedLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(failedLogin.status, 401);

  // 5. Login using First Single-Use Recovery Code
  const usedCode = recoveryCodes[0];
  const recoveryLogin = await call('/api/auth/login', {
    method: 'POST',
    body: {
      email: 'owner@smartprint.local',
      password: 'SmartPrintDemo!2026',
      recovery_code: usedCode
    }
  });
  assert.equal(recoveryLogin.status, 200, 'Must login successfully using recovery code');
  assert.equal(recoveryLogin.data.mfaRequired, false);

  // 6. Test that using the same recovery code a second time is rejected (single-use enforced)
  const reuseLogin = await call('/api/auth/login', {
    method: 'POST',
    body: {
      email: 'owner@smartprint.local',
      password: 'SmartPrintDemo!2026',
      recovery_code: usedCode
    }
  });
  assert.equal(reuseLogin.status, 401, 'Reused recovery code must be rejected');

  // 7. Secure Disable MFA requires password reauthentication
  const activeCookie = recoveryLogin.cookie;
  const badDisable = await call('/api/auth/mfa/disable', {
    method: 'POST',
    cookie: activeCookie,
    body: { password: 'WrongPassword!', code: recoveryCodes[1] }
  });
  assert.equal(badDisable.status, 403, 'Must reject disable with wrong password');

  const goodDisable = await call('/api/auth/mfa/disable', {
    method: 'POST',
    cookie: activeCookie,
    body: { password: 'SmartPrintDemo!2026', code: recoveryCodes[1] }
  });
  assert.equal(goodDisable.status, 200, 'Must successfully disable 2FA with verified credentials');

  // 8. Verify login now succeeds without 2FA
  const postDisableLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(postDisableLogin.status, 200);
});
