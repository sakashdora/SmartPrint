import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { token, digest, hashPassword, checkPassword, encrypt, decrypt, totpStep, base32, limitRate } from './security.js';
const fail = (status, message) => Object.assign(new Error(message), { status });
export function authRoutes(app, db, key, config) {
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.production, path: '/', maxAge: 8 * 3600000 };
  async function session(res, user, mfa) {
    const secret = token();
    await db.query('INSERT INTO sessions (id,user_id,expires,mfa) VALUES ($1,$2,$3,$4)', [digest(secret), user.id, new Date(Date.now() + 8 * 3600000).toISOString(), mfa ? 1 : 0]);
    res.cookie('sp_session', secret, cookieOptions);
    return { id: user.id, email: user.email, role: user.role, mfaRequired: config.production && !mfa };
  }
  const requireSession = (req, res, next) => req.user ? next() : next(fail(401, 'Please sign in.'));
  app.post('/api/auth/login', async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase(), password = req.body.password;
    await limitRate(db, 'login-account', email, 10, 900);
    const [user] = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    const dummy = 'scrypt$32768$8$3$00000000000000000000000000000000$' + '00'.repeat(64);
    const valid = typeof password === 'string' && password.length <= 128 && await checkPassword(password, user?.password ?? dummy);
    if (!user || !valid) throw fail(401, 'Email, password or verification code is incorrect.');
    if (!user.password.startsWith('scrypt$')) await db.query('UPDATE users SET password=$1 WHERE id=$2 AND password=$3', [await hashPassword(password), user.id, user.password]);
    const [mfa] = await db.query('SELECT * FROM mfa WHERE user_id=$1 AND enabled=1', [user.id]);
    if (mfa) {
      const step = totpStep(decrypt(mfa, key), req.body.code, mfa.last_step);
      if (step === null) throw fail(401, 'Enter a fresh 6-digit authenticator code.');
      const changed = await db.query('UPDATE mfa SET last_step=$1 WHERE user_id=$2 AND last_step<$1 RETURNING user_id', [step, user.id]);
      if (!changed.length) throw fail(401, 'This verification code was already used.');
    }
    if (req.sessionId) await db.query('DELETE FROM sessions WHERE id=$1', [req.sessionId]);
    res.json(await session(res, user, Boolean(mfa)));
  });
  app.post('/api/auth/logout', async (req, res) => { if (req.sessionId) await db.query('DELETE FROM sessions WHERE id=$1', [req.sessionId]); res.clearCookie('sp_session', { path: '/', secure: config.production, sameSite: 'strict' }); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => res.json(req.user ?? null));
  app.post('/api/auth/mfa/setup', requireSession, async (req, res) => {
    const secret = randomBytes(20), sealed = encrypt(secret, key);
    const changed = await db.query('INSERT INTO mfa (user_id,payload,iv,tag) VALUES ($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET payload=$2,iv=$3,tag=$4 WHERE mfa.enabled=0 RETURNING user_id', [req.user.id, sealed.payload, sealed.iv, sealed.tag]);
    if (!changed.length) throw fail(409, 'Authenticator already enabled.');
    const uri = `otpauth://totp/SmartPrint:${encodeURIComponent(req.user.email)}?secret=${base32(secret)}&issuer=SmartPrint&algorithm=SHA1&digits=6&period=30`;
    res.json({ image: await QRCode.toDataURL(uri), secret: base32(secret) });
  });
  app.post('/api/auth/mfa/confirm', requireSession, async (req, res) => {
    await limitRate(db, 'mfa', req.user.id, 10, 900);
    await db.transaction(async tx => {
      const [row] = await tx.query('SELECT * FROM mfa WHERE user_id=$1 AND enabled=0', [req.user.id]);
      const step = row && totpStep(decrypt(row, key), req.body.code);
      if (step == null) throw fail(400, 'Enter the current code from your authenticator app.');
      const changed = await tx.query('UPDATE mfa SET enabled=1,last_step=$1 WHERE user_id=$2 AND enabled=0 RETURNING user_id', [step, req.user.id]);
      if (!changed.length) throw fail(409, 'Authenticator already confirmed.');
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [req.user.id]);
    });
    res.json(await session(res, req.user, true));
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
