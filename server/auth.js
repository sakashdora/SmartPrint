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
export const CHALLENGE_TTL_MS = 300000;
const saveChallenge = (key, challenge, userId = null) => {
  // Drop expired, never-used challenges so unauthenticated option requests cannot grow memory forever.
  if (webauthnChallenges.size > 1000) for (const [k, v] of webauthnChallenges) if (Date.now() > v.expires) webauthnChallenges.delete(k);
  webauthnChallenges.set(key, { challenge, userId, expires: Date.now() + CHALLENGE_TTL_MS });
};
// Single use: a challenge is removed on first lookup, whether or not verification then succeeds.
const takeChallenge = (key) => {
  if (typeof key !== 'string') return null;
  const item = webauthnChallenges.get(key);
  if (!item) return null;
  webauthnChallenges.delete(key);
  if (Date.now() > item.expires) return null;
  return item;
};

export function authRoutes(app, db, key, config, onSessionInvalidate) {
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/', maxAge: 8 * 3600000 };
  // A real Argon2id hash so unknown emails cost the same verification time as known ones.
  let dummyHash;
  const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(32).toString('hex')));

  const getRpID = (req) => {
    if (config.publicUrl) {
      try { return new URL(config.publicUrl).hostname; } catch {}
    }
    if (config.origin) {
      try {
        const h = new URL(config.origin).hostname;
        if (h && h !== '127.0.0.1' && h !== '::1') return h;
      } catch {}
    }
    if (process.env.PUBLIC_BASE_URL) {
      try {
        const h = new URL(process.env.PUBLIC_BASE_URL).hostname;
        if (h && h !== '127.0.0.1' && h !== '::1') return h;
      } catch {}
    }
    const host = (req.headers.host || 'localhost').split(':')[0];
    if (host === '127.0.0.1' || host === '::1') return 'localhost';
    return host;
  };

  // The origin inside the signed clientDataJSON must be one of the site's own configured origins. It is
  // never taken from the request's Origin/Host headers, which the client controls. Development also
  // accepts the local server's own address.
  const getExpectedOrigins = (req) => {
    const origins = new Set();
    if (config.origin) origins.add(config.origin);
    if (process.env.PUBLIC_BASE_URL) {
      try { origins.add(new URL(process.env.PUBLIC_BASE_URL).origin); } catch {}
    }
    for (const hostVar of ['RENDER_EXTERNAL_HOSTNAME', 'KOYEB_PUBLIC_DOMAIN', 'RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_STATIC_URL', 'VERCEL_URL']) {
      if (process.env[hostVar]) origins.add(`https://${process.env[hostVar]}`);
    }
    if (!config.production) {
      const port = process.env.PORT || 3000;
      for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, 'localhost:3000', '127.0.0.1:3000']) origins.add(`http://${host}`);
      // Any port on a loopback address (local dev servers and tests), never an arbitrary Host header.
      try {
        const local = new URL(`http://${req.headers.host}`);
        if (['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) origins.add(local.origin);
      } catch {}
    }
    return Array.from(origins);
  };

  const getExpectedRPIDs = (req) => {
    const set = new Set([getRpID(req)]);
    if (config.origin) {
      try { set.add(new URL(config.origin).hostname); } catch {}
    }
    if (!config.production) set.add('localhost');
    return Array.from(set).filter(h => h && h !== '127.0.0.1' && h !== '::1');
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
    const valid = typeof password === 'string' && password.length <= 128 && await checkPassword(password, user?.password ?? await getDummyHash());
    if (!user || !valid || (req.body.role && req.body.role !== user.role)) throw fail(401, 'Email, password or verification code is incorrect.');
    if (user.status === 'suspended' || user.status === 'disabled') throw fail(403, 'This account has been suspended or disabled. Please contact support.');
    if (!user.password.startsWith('$argon2')) await db.query('UPDATE users SET password=$1 WHERE id=$2', [await hashPassword(password), user.id]);
    const [mfa] = await db.query('SELECT * FROM mfa WHERE user_id=$1 AND enabled=1', [user.id]);
    const passkeys = await db.query('SELECT id FROM passkeys WHERE user_id=$1', [user.id]);
    const hasPasskeys = passkeys.length > 0;
    const hasTotp = Boolean(mfa);
    const adminMustMfa = user.role === 'admin' && (config.production || process.env.ENFORCE_MFA === 'true');
    const enforceMfa = process.env.ENFORCE_MFA === 'true' || adminMustMfa;

    let mfaSatisfied = false;
    if (hasTotp) {
      const rawCode = String(req.body.code || req.body.recovery_code || '').trim();
      if (!rawCode) {
        return res.status(401).json({
          error: 'Two-factor authentication code required.',
          mfaRequired: true,
          hasTotp: true,
          hasPasskeys
        });
      }
      const cleanCode = rawCode.replace(/[\s-]/g, '');
      const step = totpStep(decrypt(mfa, key), cleanCode, mfa.last_step);
      if (step !== null) {
        const changed = await db.query('UPDATE mfa SET last_step=$1 WHERE user_id=$2 AND last_step<$1 RETURNING user_id', [step, user.id]);
        if (!changed.length) throw fail(401, 'This verification code was already used.');
        mfaSatisfied = true;
      } else {
        const normalized = cleanCode.toUpperCase();
        if (normalized.length >= 8) {
          let recoveryCodes = [];
          try { recoveryCodes = JSON.parse(mfa.recovery_codes || '[]'); } catch {}
          const codeHash = digest(normalized);
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
    } else if (hasPasskeys && enforceMfa) {
      // User enrolled a passkey and MFA policy applies
      return res.status(401).json({
        error: 'Passkey verification required. Click "Sign in with Passkey" to complete sign-in.',
        mfaRequired: true,
        hasTotp: false,
        hasPasskeys: true
      });
    }
    if (req.sessionId) {
      await db.query('DELETE FROM sessions WHERE id=$1', [req.sessionId]);
      onSessionInvalidate?.(req.sessionId, user.id);
    }
    res.json(await session(res, user, mfaSatisfied));
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (req.sessionId) {
      await db.query('DELETE FROM sessions WHERE id=$1', [req.sessionId]);
      onSessionInvalidate?.(req.sessionId, req.user?.id);
    }
    res.clearCookie('sp_session', { path: '/', httpOnly: true, secure: config.production, sameSite: 'lax' });
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => res.json(req.user ?? null));

  app.get('/api/auth/mfa/status', requireSession, async (req, res) => {
    const [mfa] = await db.query('SELECT enabled, created, last_step FROM mfa WHERE user_id=$1 AND enabled=1', [req.user.id]);
    const passkeys = await db.query('SELECT id, device_type, backed_up, created FROM passkeys WHERE user_id=$1 ORDER BY created DESC', [req.user.id]);
    res.json({ totp: Boolean(mfa), enabledAt: mfa?.created || null, passkeys });
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
    const expectedChallenge = takeChallenge(`reg:${req.user.id}`)?.challenge;
    if (!expectedChallenge) throw fail(400, 'Passkey registration timed out. Please try again.');
    const expectedRPID = getExpectedRPIDs(req);
    const expectedOrigin = getExpectedOrigins(req);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin,
        expectedRPID,
        requireUserVerification: false
      });
    } catch {
      throw fail(400, 'Passkey registration could not be verified.');
    }
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
      onSessionInvalidate?.(req.sessionId, req.user.id);
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
    // An unguessable key per request: clients cannot overwrite or consume another user's challenge.
    const challengeKey = `auth:${token()}`;
    saveChallenge(challengeKey, options.challenge, userId || null);
    res.json({ ...options, challengeKey });
  });

  app.post('/api/auth/webauthn/auth-verify', async (req, res) => {
    const { response, challengeKey } = req.body;
    if (!response?.id || typeof challengeKey !== 'string' || !challengeKey.startsWith('auth:')) throw fail(400, 'Invalid passkey assertion.');
    // Consumed before any other check, so a challenge can never be tried twice.
    const issued = takeChallenge(challengeKey);
    if (!issued) throw fail(400, 'Authentication timed out. Please try again.');
    const [passkey] = await db.query('SELECT p.*, u.id as user_id, u.email, u.role, u.status FROM passkeys p JOIN users u ON u.id=p.user_id WHERE p.id=$1', [String(response.id)]);
    if (!passkey) throw fail(401, 'Passkey credential not recognized.');
    if (issued.userId && issued.userId !== passkey.user_id) throw fail(401, 'Passkey verification failed.');
    if (passkey.status === 'suspended' || passkey.status === 'disabled') throw fail(403, 'This account has been suspended or disabled. Please contact support.');
    const expectedRPID = getExpectedRPIDs(req);
    const expectedOrigin = getExpectedOrigins(req);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: issued.challenge,
        expectedOrigin,
        expectedRPID,
        requireUserVerification: false,
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(Buffer.from(passkey.public_key)),
          counter: Number(passkey.counter)
        }
      });
    } catch {
      throw fail(401, 'Passkey verification failed.');
    }
    if (!verification.verified) throw fail(401, 'Passkey verification failed.');
    await db.query('UPDATE passkeys SET counter=$1 WHERE id=$2', [verification.authenticationInfo.newCounter, passkey.id]);
    if (req.sessionId) {
      await db.query('DELETE FROM sessions WHERE id=$1', [req.sessionId]);
      onSessionInvalidate?.(req.sessionId, passkey.user_id);
    }
    const [user] = await db.query('SELECT id, email, role, status FROM users WHERE id=$1', [passkey.user_id]);
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
    await limitRate(db, 'mfa-setup', req.user.id, 10, 900);
    const secret = randomBytes(20), sealed = encrypt(secret, key);
    const created = new Date().toISOString();
    await db.query(
      'INSERT INTO mfa (user_id,payload,iv,tag,created,enabled) VALUES ($1,$2,$3,$4,$5,0) ON CONFLICT(user_id) DO UPDATE SET payload=$2,iv=$3,tag=$4,created=$5,enabled=0 RETURNING user_id',
      [req.user.id, sealed.payload, sealed.iv, sealed.tag, created]
    );
    const uri = `otpauth://totp/SmartPrint:${encodeURIComponent(req.user.email)}?secret=${base32(secret)}&issuer=SmartPrint&algorithm=SHA1&digits=6&period=30`;
    res.json({ image: await QRCode.toDataURL(uri), secret: base32(secret) });
  });

  app.post('/api/auth/mfa/confirm', requireSession, async (req, res) => {
    await limitRate(db, 'mfa', req.user.id, 10, 900);
    const cleanCode = String(req.body.code ?? '').replace(/[\s-]/g, '').trim();
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
      if (!row) throw fail(409, 'No pending authenticator enrollment found.');
      if (row.created && (Date.now() - Date.parse(row.created) > 15 * 60 * 1000)) {
        await tx.query('DELETE FROM mfa WHERE user_id=$1 AND enabled=0', [req.user.id]);
        throw fail(400, 'Enrollment session expired. Please start authenticator setup again.');
      }
      const step = row && totpStep(decrypt(row, key), cleanCode);
      if (step == null) throw fail(400, 'Enter the current code from your authenticator app.');
      const nowIso = new Date().toISOString();
      const changed = await tx.query('UPDATE mfa SET enabled=1,last_step=$1,recovery_codes=$2,created=$3 WHERE user_id=$4 AND enabled=0 RETURNING user_id', [step, JSON.stringify(hashedCodes), nowIso, req.user.id]);
      if (!changed.length) throw fail(409, 'Authenticator already confirmed.');
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [req.user.id]);
    });
    onSessionInvalidate?.(null, req.user.id);
    const s = await session(res, req.user, true);
    await db.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), req.user.id, 'mfa.enabled', req.user.id, new Date().toISOString()]);
    res.json({ ...s, recoveryCodes: plainRecoveryCodes });
  });

  app.post('/api/auth/mfa/verify', requireSession, async (req, res) => {
    await limitRate(db, 'mfa-ver', req.user.id, 10, 900);
    const [mfa] = await db.query('SELECT * FROM mfa WHERE user_id=$1 AND enabled=1', [req.user.id]);
    if (!mfa) throw fail(409, 'Two-factor authentication is not active.');
    const rawCode = String(req.body.code || req.body.recovery_code || '').trim();
    if (!rawCode) throw fail(400, 'Enter the 6-digit verification code from your authenticator app.');
    const cleanCode = rawCode.replace(/[\s-]/g, '');
    const step = totpStep(decrypt(mfa, key), cleanCode, mfa.last_step);
    let mfaSatisfied = false;
    if (step !== null) {
      const changed = await db.query('UPDATE mfa SET last_step=$1 WHERE user_id=$2 AND last_step<$1 RETURNING user_id', [step, req.user.id]);
      if (!changed.length) throw fail(401, 'This verification code was already used.');
      mfaSatisfied = true;
    } else {
      const normalized = cleanCode.toUpperCase();
      if (normalized.length >= 8) {
        let recoveryCodes = [];
        try { recoveryCodes = JSON.parse(mfa.recovery_codes || '[]'); } catch {}
        const codeHash = digest(normalized);
        const matchedIndex = recoveryCodes.findIndex(rc => rc.hash === codeHash && !rc.used);
        if (matchedIndex !== -1) {
          recoveryCodes[matchedIndex].used = 1;
          recoveryCodes[matchedIndex].used_at = new Date().toISOString();
          await db.query('UPDATE mfa SET recovery_codes=$1 WHERE user_id=$2', [JSON.stringify(recoveryCodes), req.user.id]);
          mfaSatisfied = true;
        }
      }
    }
    if (!mfaSatisfied) throw fail(401, 'Invalid verification code or recovery code.');
    if (req.sessionId) {
      await db.query('UPDATE sessions SET mfa=1 WHERE id=$1', [req.sessionId]);
      onSessionInvalidate?.(req.sessionId, req.user.id);
    }
    await db.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), req.user.id, 'mfa.verified', req.user.id, new Date().toISOString()]);
    const updated = await db.query('SELECT id, email, role, status FROM users WHERE id=$1', [req.user.id]);
    res.json({ ok: true, user: { ...updated[0], mfa: true, mfaRequired: false } });
  });

  app.post('/api/auth/mfa/recovery-codes/regenerate', requireSession, async (req, res) => {
    await limitRate(db, 'mfa-regen', req.user.id, 5, 900);
    const [user] = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const password = req.body.password;
    if (typeof password !== 'string' || !(await checkPassword(password, user.password))) {
      throw fail(403, 'Your current password is required to regenerate recovery codes.');
    }
    const [mfa] = await db.query('SELECT * FROM mfa WHERE user_id=$1 AND enabled=1', [req.user.id]);
    if (!mfa) throw fail(409, 'Two-factor authentication is not active.');
    const cleanCode = String(req.body.code ?? '').replace(/[\s-]/g, '').trim();
    const step = totpStep(decrypt(mfa, key), cleanCode, mfa.last_step);
    if (step === null) {
      throw fail(401, 'Enter the current 6-digit code from your authenticator app.');
    }
    const plainRecoveryCodes = Array.from({ length: 8 }, () => {
      const b = randomBytes(4).toString('hex').toUpperCase();
      return `${b.slice(0, 4)}-${b.slice(4, 8)}`;
    });
    const hashedCodes = plainRecoveryCodes.map(c => ({
      hash: digest(c.replace(/[^A-Za-z0-9]/g, '').toUpperCase()),
      used: 0
    }));
    await db.query('UPDATE mfa SET recovery_codes=$1, last_step=$2 WHERE user_id=$3 AND enabled=1', [JSON.stringify(hashedCodes), step, req.user.id]);
    await db.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), req.user.id, 'mfa.recovery_regenerated', req.user.id, new Date().toISOString()]);
    res.json({ ok: true, recoveryCodes: plainRecoveryCodes });
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
    const cleanCode = String(req.body.code || req.body.recovery_code || '').replace(/[\s-]/g, '').trim();
    const step = totpStep(decrypt(mfa, key), cleanCode);
    let codeValid = step !== null;
    if (!codeValid) {
      const rawCode = cleanCode.toUpperCase();
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
    onSessionInvalidate?.(req.sessionId, req.user.id);
    await db.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), req.user.id, 'mfa.disabled', req.user.id, new Date().toISOString()]);
    res.json({ ok: true, message: 'Two-factor authentication disabled.' });
  });

  app.post('/api/auth/password', requireSession, async (req, res) => {
    await limitRate(db, 'password', req.user.id, 5, 900);
    const [user] = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (req.user.mfaRequired || typeof req.body.current !== 'string' || req.body.current.length > 128 || !(await checkPassword(req.body.current, user.password))) throw fail(403, 'Current password and verified sign-in are required.');
    const [mfa] = await db.query('SELECT * FROM mfa WHERE user_id=$1 AND enabled=1', [user.id]);
    if (mfa && !req.user.mfa) {
      const code = String(req.body.code ?? '').trim();
      const step = code ? totpStep(decrypt(mfa, key), code, mfa.last_step) : null;
      if (step === null) {
        throw fail(401, 'Enter the current 6-digit code from your authenticator app to authorize password change.');
      }
      await db.query('UPDATE mfa SET last_step=$1 WHERE user_id=$2', [step, user.id]);
    }
    const password = req.body.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail(400, 'Use 12–128 characters.');
    const hash = await hashPassword(password);
    await db.transaction(async tx => {
      await tx.query('UPDATE users SET password=$1 WHERE id=$2', [hash, user.id]);
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
    });
    onSessionInvalidate?.(null, user.id);
    await db.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), user.id, 'password.changed', user.id, new Date().toISOString()]);
    res.clearCookie('sp_session', { path: '/' });
    res.json({ ok: true });
  });
}

