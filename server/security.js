import { randomBytes, scrypt, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';
const derive = promisify(scrypt);

export const token = () => randomBytes(32).toString('hex');
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export async function hashPassword(password) {
  return await argonHash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4
  });
}
export async function checkPassword(password, hash) {
  if (typeof hash !== 'string' || typeof password !== 'string') return false;
  if (hash.startsWith('$argon2')) {
    try {
      return await argonVerify(hash, password);
    } catch {
      return false;
    }
  }
  let salt, expected, options;
  if (hash.startsWith('scrypt$')) {
    const parts = hash.split('$');
    if (parts.length !== 6 || parts.slice(1,4).join(':') !== '32768:8:3') return false;
    [, , , , salt, expected] = parts; options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
  } else [salt, expected] = hash.split(':');
  if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(expected || '')) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), await derive(password, salt, 64, options));
}
export function loadKey() {
  const supplied = process.env.FILE_ENCRYPTION_KEY;
  if (supplied && !/^[a-f0-9]{64}$/i.test(supplied)) throw new Error('FILE_ENCRYPTION_KEY must contain 64 hex characters');
  if (supplied) return Buffer.from(supplied, 'hex');
  if (process.env.NODE_ENV === 'production') throw new Error('FILE_ENCRYPTION_KEY is required.');
  mkdirSync('.data', { recursive: true });
  const path = '.data/development.key';
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600 });
  return readFileSync(path);
}
export function encrypt(bytes, key) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); return { payload: Buffer.concat([cipher.update(bytes), cipher.final()]), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') }; }
export function decrypt(row, key) { const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'hex')); cipher.setAuthTag(Buffer.from(row.tag, 'hex')); return Buffer.concat([cipher.update(Buffer.from(row.payload)), cipher.final()]); }
export function totp(secret, step = Math.floor(Date.now() / 30000), digits = 6) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', secret).update(counter).digest();
  return ((hash.readUInt32BE(hash[19] & 15) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, '0');
}
export function totpStep(secret, code, lastStep = -1) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const step = Math.floor(Date.now() / 30000);
  for (const n of [step, step - 1, step + 1]) if (n > Number(lastStep) && timingSafeEqual(Buffer.from(totp(secret, n)), Buffer.from(String(code)))) return n;
  return null;
}
export function base32(bytes) { let bits = 0, value = 0, result = ''; for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { result += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value >>> (bits -= 5)) & 31]; } } if (bits) result += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value << (5 - bits)) & 31]; return result; }
export async function limitRate(db, scope, identity, max, seconds = 60) {
  const id = digest(`${scope}:${identity}`), now = new Date().toISOString(), expires = new Date(Date.now() + seconds * 1000).toISOString();
  const [row] = await db.query('INSERT INTO rate_limits (id,count,expires) VALUES ($1,1,$2) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN rate_limits.expires<$3 THEN 1 ELSE rate_limits.count+1 END, expires=CASE WHEN rate_limits.expires<$3 THEN $2 ELSE rate_limits.expires END RETURNING count', [id, expires, now]);
  if (row.count > max) throw Object.assign(new Error('Too many attempts. Please try again later.'), { status: 429 });
}
