import { randomBytes, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { token, digest, hashPassword, checkPassword, encrypt, decrypt, totpStep, base32, limitRate } from './security.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const webauthnChallenges = new Map();
const saveChallenge = (key, challenge) => {
  webauthnChallenges.set(key, { challenge, expires: Date.now() + 300000 });
};
const getChallenge = (key) => {
  const item = webauthnChallenges.get(key);
  if (!item) return null;
  webauthnChallenges.delete(key);
  if (Date.now() > item.expires) return null;
  return item.challenge;
};

export function authRoutes(app, db, key, config) {
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.production, path: '/', maxAge: 8 * 3600000 };

  const getRpID = (req) => {
    if (config.publicUrl) {
      try { return new URL(config.publicUrl).hostname; } catch {}
    }
    const host = req.headers.host || 'localhost';
    return host.split(':')[0];
  };

  const getOrigin = (req) => {
    if (req.headers.origin) return req.headers.origin;
    const proto = req.headers['x-forwarded-proto'] || (config.production ? 'https' : 'http');
    const host = req.headers.host || 'localhost:3000';
    return `${proto}://${host}`;
  };

  async function session(res, user, mfa) {
    const secret = token();
    await db.query('INSERT INTO sessions (id,user_id,expires,mfa) VALUES ($1,$2,$3,$4)', [digest(secret), user.id, new Date(Date.now() + 8 * 3600000).toISOString(), mfa ? 1 : 0]);
    res.cookie('sp_session', secret, cookieOptions);
    const adminMustMfa = user.role === 'admin' && (config.production || process.env.ENFORCE_MFA === 'true');
    const enforceMfa = process.env.ENFORCE_MFA === 'true' || adminMustMfa;
    const [shop] = user.role === 'owner' ? await db.query('SELECT status FROM shops WHERE owner_id=$1', [user.id]) : [];
    return { id: user.id, email: user.email, role: user.role, status: user.status || 'active', shopStatus: shop?.status || null, mfaRequired: Boolean(enforceMfa && !mfa) };
  }
  const requireSession = (req, res, next) => req.user ? next() : next(fail(401, 'Please sign in.'));

  app.post('/api/auth/login', async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase(), password = req.body.password;
    await limitRate(db, 'login-account', email, 10, 900);
    const [user] = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    const dummy = '$argon2id$v=19$m=65536,t=3,p=4$0000000000000000000000$0000000000000000000000000000000000000000000';
    const valid = typeof password === 'string' && password.length <= 128 && await checkPassword(password, user?.password ?? dummy);
    if (!user || !valid || (req.body.role && req.body.role !== user.role)) throw fail(401, 'Email, password or verification code is incorrect.');
    if (user.status === 'suspended' || user.status === 'disabled') throw fail(403, 'This account has been suspended or disabled. Please contact support.');
    if (!user.password.startsWith('$argon2')) await db.query('UPDATE users SET password=$1 WHERE id=$2', [await hashPassword(password), user.id]);
    const [mfa] = await db.query('SELECT * FROM mfa WHERE user_id=$1 AND enabled=1', [user.id]);
    let mfaSatisfied = false;
    if (mfa) {
      const step = totpStep(decrypt(mfa, key), req.body.code, mfa.last_step);
      if (step !== null) {
        const changed = await db.query('UPDATE mfa SET last_step=$1 WHERE user_id=$2 AND last_step<$1 RETURNING user_id', [step, user.id]);
        if (!changed.length) throw fail(401, 'This verification code was already used.');
        mfaSatisfied = true;
      } else {
        const rawCode = String(req.body.code || req.body.recovery_code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (rawCode.length >= 8) {
          let recoveryCodes = [];
          try { recoveryCodes = JSON.parse(mfa.recovery_codes || '[]'); } catch {}
          const codeHash = digest(rawCode);
          const matchedIndex = recoveryCodes.findIndex(rc => rc.hash === codeHash && !rc.used);
          if (matchedIndex !== -1) {
            recoveryCodes[matchedIndex].used = 1;
            recoveryCodes[matchedIndex].used_at = new Date().toISOString();
            await db.query('UPDATE mfa SET recovery_codes=$1 WHERE user_id=$2', [JSON.stringify(recoveryCodes), user.id]);
            mfaSatisfied = true;
          }
        }
      }
      if (!mfaSatisfied) throw fail(401, 'Enter a fresh 6-digit authenticator code or valid single-use recovery code.');
    }
    if (req.sessionId) await db.query('DELETE FROM sessions WHERE id=$1', [req.sessionId]);
    res.json(await session(res, user, mfaSatisfied));
  });

  app.post('/api/auth/logout', async (req, res) => { if (req.sessionId) await db.query('DELETE FROM sessions WHERE id=$1', [req.sessionId]); res.clearCookie('sp_session', { path: '/', secure: config.production, sameSite: 'strict' }); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => res.json(req.user ?? null));

  app.get('/api/auth/mfa/status', requireSession, async (req, res) => {
    const [mfa] = await db.query('SELECT enabled FROM mfa WHERE user_id=$1 AND enabled=1', [req.user.id]);
    const passkeys = await db.query('SELECT id, device_type, backed_up, created FROM passkeys WHERE user_id=$1 ORDER BY created DESC', [req.user.id]);
    res.json({ totp: Boolean(mfa), passkeys });
  });

  // WebAuthn Passkeys Endpoints
  app.post('/api/auth/webauthn/register-options', requireSession, async (req, res) => {
    await limitRate(db, 'webauthn-opt', req.user.id, 20, 900);
    const rpID = getRpID(req);
    const existingPasskeys = await db.query('SELECT id, transports FROM passkeys WHERE user_id=$1', [req.user.id]);
    const excludeCredentials = existingPasskeys.map(pk => ({
      id: pk.id,
      transports: JSON.parse(pk.transports || '[]')
    }));
    const options = await generateRegistrationOptions({
      rpName: 'SmartPrint',
      rpID,
      userID: Uint8Array.from(Buffer.from(req.user.id)),
      userName: req.user.email,
      userDisplayName: req.user.email.split('@')[0],
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      }
    });
    saveChallenge(`reg:${req.user.id}`, options.challenge);
    res.json(options);
  });

  app.post('/api/auth/webauthn/register-verify', requireSession, async (req, res) => {
    await limitRate(db, 'webauthn-reg', req.user.id, 10, 900);
    const expectedChallenge = getChallenge(`reg:${req.user.id}`);
    if (!expectedChallenge) throw fail(400, 'Passkey registration timed out. Please try again.');
    const rpID = getRpID(req);
    const expectedOrigin = getOrigin(req);
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: rpID
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw fail(400, 'Passkey registration could not be verified.');
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await db.query(
      'INSERT INTO passkeys (id, user_id, public_key, counter, device_type, backed_up, transports, created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [credential.id, req.user.id, Buffer.from(credential.publicKey), credential.counter, credentialDeviceType, credentialBackedUp ? 1 : 0, JSON.stringify(credential.transports || []), new Date().toISOString()]
    );
    if (req.sessionId) {
      await db.query('UPDATE sessions SET mfa=1 WHERE id=$1', [req.sessionId]);
    }
    await db.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), req.user.id, 'passkey.registered', credential.id, new Date().toISOString()]);
    res.json({ ok: true, message: 'Passkey registered successfully! Two-factor authentication is active.' });
  });

  app.post('/api/auth/webauthn/auth-options', async (req, res) => {
    let userId = req.user?.id;
    if (!userId && req.body?.email) {
      const email = String(req.body.email).trim().toLowerCase();
      const [u] = await db.query('SELECT id FROM users WHERE email=$1', [email]);
      if (u) userId = u.id;
    }
    const rpID = getRpID(req);
    let allowCredentials = undefined;
    if (userId) {
      const passkeys = await db.query('SELECT id, transports FROM passkeys WHERE user_id=$1', [userId]);
      if (passkeys.length) {
        allowCredentials = passkeys.map(p => ({
          id: p.id,
          transports: JSON.parse(p.transports || '[]')
        }));
      }
    }
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'preferred'
    });
    const challengeKey = userId ? `auth:${userId}` : `auth:${options.challenge.slice(0, 16)}`;
    saveChallenge(challengeKey, options.challenge);
    res.json({ ...options, challengeKey });
  });

  app.post('/api/auth/webauthn/auth-verify', async (req, res) => {
    const { response, challengeKey } = req.body;
    if (!response?.id) throw fail(400, 'Invalid passkey assertion.');
    const [passkey] = await db.query('SELECT p.*, u.id as user_id, u.email, u.role FROM passkeys p JOIN users u ON u.id=p.user_id WHERE p.id=$1', [response.id]);
    if (!passkey) throw fail(401, 'Passkey credential not recognized.');
    const expectedChallenge = getChallenge(challengeKey || `auth:${passkey.user_id}`);
    if (!expectedChallenge) throw fail(400, 'Authentication timed out. Please try again.');
    const rpID = getRpID(req);
    const expectedOrigin = getOrigin(req);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(Buffer.from(passkey.public_key)),
        counter: Number(passkey.counter)
      }
    });
    if (!verification.verified) throw fail(401, 'Passkey verification failed.');
    await db.query('UPDATE passkeys SET counter=$1 WHERE id=$2', [verification.authenticationInfo.newCounter, passkey.id]);
    if (req.sessionId) {
      await db.query('UPDATE sessions SET mfa=1 WHERE id=$1', [req.sessionId]);
    }
    const [user] = await db.query('SELECT id, email, role FROM users WHERE id=$1', [passkey.user_id]);
    const s = await session(res, user, true);
    await db.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), user.id, 'passkey.authenticated', passkey.id, new Date().toISOString()]);
    res.json({ ok: true, ...s });
  });

  app.delete('/api/auth/webauthn/passkeys/:id', requireSession, async (req, res) => {
    await limitRate(db, 'passkey-del', req.user.id, 5, 900);
    const changed = await db.query('DELETE FROM passkeys WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!changed.length) throw fail(404, 'Passkey not found.');
    await db.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), req.user.id, 'passkey.deleted', req.params.id, new Date().toISOString()]);
    res.json({ ok: true });
  });

  // TOTP MFA Endpoints
  app.post('/api/auth/mfa/setup', requireSession, async (req, res) => {
    const secret = randomBytes(20), sealed = encrypt(secret, key);
    const changed = await db.query('INSERT INTO mfa (user_id,payload,iv,tag) VALUES ($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET payload=$2,iv=$3,tag=$4 WHERE mfa.enabled=0 RETURNING user_id', [req.user.id, sealed.payload, sealed.iv, sealed.tag]);
    if (!changed.length) throw fail(409, 'Authenticator already enabled.');
    const uri = `otpauth://totp/SmartPrint:${encodeURIComponent(req.user.email)}?secret=${base32(secret)}&issuer=SmartPrint&algorithm=SHA1&digits=6&period=30`;
    res.json({ image: await QRCode.toDataURL(uri), secret: base32(secret) });
  });
  app.post('/api/auth/mfa/confirm', requireSession, async (req, res) => {
    await limitRate(db, 'mfa', req.user.id, 10, 900);
    const plainRecoveryCodes = Array.from({ length: 8 }, () => {
      const b = randomBytes(4).toString('hex').toUpperCase();
      return `${b.slice(0, 4)}-${b.slice(4, 8)}`;
    });
    const hashedCodes = plainRecoveryCodes.map(c => ({
      hash: digest(c.replace(/[^A-Za-z0-9]/g, '').toUpperCase()),
      used: 0
    }));
    await db.transaction(async tx => {
      const [row] = await tx.query('SELECT * FROM mfa WHERE user_id=$1 AND enabled=0', [req.user.id]);
      const step = row && totpStep(decrypt(row, key), req.body.code);
      if (step == null) throw fail(400, 'Enter the current code from your authenticator app.');
      const changed = await tx.query('UPDATE mfa SET enabled=1,last_step=$1,recovery_codes=$2 WHERE user_id=$3 AND enabled=0 RETURNING user_id', [step, JSON.stringify(hashedCodes), req.user.id]);
      if (!changed.length) throw fail(409, 'Authenticator already confirmed.');
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [req.user.id]);
    });
    const s = await session(res, req.user, true);
    res.json({ ...s, recoveryCodes: plainRecoveryCodes });
  });
  app.post('/api/auth/mfa/disable', requireSession, async (req, res) => {
    await limitRate(db, 'mfa-disable', req.user.id, 5, 900);
    const [user] = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const password = req.body.password;
    if (typeof password !== 'string' || !(await checkPassword(password, user.password))) {
      throw fail(403, 'Your current password is required to disable two-factor authentication.');
    }
    const [mfa] = await db.query('SELECT * FROM mfa WHERE user_id=$1 AND enabled=1', [req.user.id]);
    if (!mfa) throw fail(409, 'Authenticator is not active.');
    const step = totpStep(decrypt(mfa, key), req.body.code);
    let codeValid = step !== null;
    if (!codeValid) {
      const rawCode = String(req.body.code || req.body.recovery_code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      let recoveryCodes = [];
      try { recoveryCodes = JSON.parse(mfa.recovery_codes || '[]'); } catch {}
      const codeHash = digest(rawCode);
      const matched = recoveryCodes.find(rc => rc.hash === codeHash && !rc.used);
      if (matched) codeValid = true;
    }
    if (!codeValid) throw fail(401, 'Enter the current 6-digit code or an unused recovery code to verify identity.');
    await db.transaction(async tx => {
      await tx.query('DELETE FROM mfa WHERE user_id=$1', [req.user.id]);
      await tx.query('UPDATE sessions SET mfa=0 WHERE user_id=$1', [req.user.id]);
    });
    res.json({ ok: true, message: 'Two-factor authentication disabled.' });
  });
  app.post('/api/auth/password', requireSession, async (req, res) => {
    await limitRate(db, 'password', req.user.id, 5, 900);
    const [user] = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (req.user.mfaRequired || typeof req.body.current !== 'string' || req.body.current.length > 128 || !(await checkPassword(req.body.current, user.password))) throw fail(403, 'Current password and verified sign-in are required.');
    const password = req.body.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail(400, 'Use 12–128 characters.');
    const hash = await hashPassword(password);
    await db.transaction(async tx => { await tx.query('UPDATE users SET password=$1 WHERE id=$2', [hash, user.id]); await tx.query('DELETE FROM sessions WHERE user_id=$1', [user.id]); });
    res.clearCookie('sp_session', { path: '/' }); res.json({ ok: true });
  });
}
