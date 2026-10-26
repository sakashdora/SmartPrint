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

  // 9. Re-enable MFA and test Two-Step Login Prompt & Password Change with 2FA
  const reSetup = await call('/api/auth/mfa/setup', { method: 'POST', cookie: postDisableLogin.cookie });
  assert.equal(reSetup.status, 200);

  const reBytes = [];
  let rbits = 0, rval = 0;
  for (const char of reSetup.data.secret) {
    const idx = base32Alphabet.indexOf(char);
    if (idx === -1) continue;
    rval = (rval << 5) | idx;
    rbits += 5;
    if (rbits >= 8) {
      reBytes.push((rval >>> (rbits - 8)) & 255);
      rbits -= 8;
    }
  }
  const reSecretBuffer = Buffer.from(reBytes);
  let reCode = totp(reSecretBuffer);

  const reConfirm = await call('/api/auth/mfa/confirm', {
    method: 'POST',
    cookie: postDisableLogin.cookie,
    body: { code: reCode }
  });
  assert.equal(reConfirm.status, 200);
  const origCodes = reConfirm.data.recoveryCodes;

  // 10. Test Two-Step Login Prompt: password-only login returns 401 with mfaRequired: true
  const stepOneLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' }
  });
  assert.equal(stepOneLogin.status, 401);
  assert.equal(stepOneLogin.data.mfaRequired, true, 'Must indicate 2FA is required');

  // Step Two: Submit code alongside credentials (reset last_step to simulate next time window)
  await db.query("UPDATE mfa SET last_step=0 WHERE user_id=(SELECT id FROM users WHERE email='owner@smartprint.local')");
  reCode = totp(reSecretBuffer);
  const stepTwoLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026', code: reCode }
  });
  assert.equal(stepTwoLogin.status, 200, 'Two-step login must succeed with valid code');
  const sessionCookie = stepTwoLogin.cookie;

  // 11. Test Recovery Code Regeneration
  await db.query("UPDATE mfa SET last_step=0 WHERE user_id=(SELECT id FROM users WHERE email='owner@smartprint.local')");
  reCode = totp(reSecretBuffer);
  const regenRes = await call('/api/auth/mfa/recovery-codes/regenerate', {
    method: 'POST',
    cookie: sessionCookie,
    body: { password: 'SmartPrintDemo!2026', code: reCode }
  });
  assert.equal(regenRes.status, 200, 'Recovery codes regeneration must succeed with valid credentials');
  assert.ok(Array.isArray(regenRes.data.recoveryCodes), 'Regeneration must return recovery codes');
  assert.equal(regenRes.data.recoveryCodes.length, 8);
  const newCodes = regenRes.data.recoveryCodes;

  // Test old recovery code is now invalid
  const oldCodeLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026', recovery_code: origCodes[2] }
  });
  assert.equal(oldCodeLogin.status, 401, 'Old recovery code must be invalidated after regeneration');

  // Test new recovery code works for login
  const newCodeLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026', recovery_code: newCodes[0] }
  });
  assert.equal(newCodeLogin.status, 200, 'New recovery code must work after regeneration');
  const activeSessionCookie = newCodeLogin.cookie;

  // 12. Test Password Change requires TOTP code when session lacks verified MFA
  await db.query("UPDATE sessions SET mfa=0");
  const badPwChange = await call('/api/auth/password', {
    method: 'POST',
    cookie: activeSessionCookie,
    body: { current: 'SmartPrintDemo!2026', password: 'NewSecurePassword!2026' }
  });
  assert.equal(badPwChange.status, 401, 'Password change must require TOTP code when 2FA is active and session lacks MFA');

  await db.query("UPDATE mfa SET last_step=0 WHERE user_id=(SELECT id FROM users WHERE email='owner@smartprint.local')");
  reCode = totp(reSecretBuffer);
  const goodPwChange = await call('/api/auth/password', {
    method: 'POST',
    cookie: activeSessionCookie,
    body: { current: 'SmartPrintDemo!2026', password: 'NewSecurePassword!2026', code: reCode }
  });
  assert.equal(goodPwChange.status, 200, 'Password change must succeed with valid TOTP code');

  // Verify previous session is invalidated after password change
  const checkRevoked = await call('/api/me', { cookie: activeSessionCookie });
  assert.equal(checkRevoked.data, null, 'Active sessions must be revoked upon password change');

  // Re-login with new password and new recovery code
  const reLoginWithNewPw = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@smartprint.local', password: 'NewSecurePassword!2026', recovery_code: newCodes[1] }
  });
  assert.equal(reLoginWithNewPw.status, 200, 'Login with new password and recovery code must succeed');

  // 13. Test Enrollment Session Expiration (>15 minutes)
  // Disable MFA first using new password and another recovery code
  await call('/api/auth/mfa/disable', {
    method: 'POST',
    cookie: reLoginWithNewPw.cookie,
    body: { password: 'NewSecurePassword!2026', code: newCodes[2] }
  });

  // Start fresh enrollment
  const expireSetup = await call('/api/auth/mfa/setup', { method: 'POST', cookie: reLoginWithNewPw.cookie });
  assert.equal(expireSetup.status, 200);

  // Artificially age the enrollment creation time in the database by 20 minutes
  const pastTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await db.query("UPDATE mfa SET created=$1 WHERE user_id=(SELECT id FROM users WHERE email='owner@smartprint.local')", [pastTime]);

  const expiredConfirm = await call('/api/auth/mfa/confirm', {
    method: 'POST',
    cookie: reLoginWithNewPw.cookie,
    body: { code: '123456' }
  });
  assert.equal(expiredConfirm.status, 400, 'Expired enrollment must be rejected with 400');
  assert.match(expiredConfirm.data.error || expiredConfirm.data, /expired/i);
});
