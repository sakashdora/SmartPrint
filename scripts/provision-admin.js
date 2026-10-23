import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { hashPassword, checkPassword } from '../server/security.js';
const generated = process.argv.includes('--generate');
const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase(), password = process.env.ADMIN_PASSWORD || (generated ? randomBytes(24).toString('base64url') : '');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) { console.error('Set ADMIN_EMAIL and a 12–128 character ADMIN_PASSWORD in the environment.'); process.exitCode = 1; }
else {
  const db = await openDatabase();
  let credentialFileCreated = false, committed = false;
  try {
    if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to provision the real database.');
    const existing = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing.length) throw new Error('Account exists; no password or role was changed.');
    if (generated) {
      await mkdir('.data', { recursive: true });
      await writeFile('.data/admin-access.txt', `SmartPrint initial administrator\nEmail: ${email}\nPassword: ${password}\n\nKeep this file private. Sign in, enroll an authenticator, then change the password in Account settings. Remove this file after saving the password in your password manager. Do not upload it to Vercel or Git.\n`, { flag: 'wx', mode: 0o600 });
      credentialFileCreated = true;
    }
    const id = randomUUID();
    await db.transaction(async tx => {
      await tx.query("INSERT INTO users (id,email,password,role) VALUES ($1,$2,$3,'admin')", [id, email, await hashPassword(password)]);
      await tx.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), 'operator', 'admin.provisioned', id, new Date().toISOString()]);
    });
    committed = true;
    const [saved] = await db.query('SELECT password,role FROM users WHERE id=$1', [id]);
    if (saved.role !== 'admin' || saved.password === password || !await checkPassword(password, saved.password)) throw new Error('Admin verification failed.');
    console.log(`Admin created and password hash verified in Neon.${generated ? ' Initial credentials saved privately in .data/admin-access.txt.' : ''} Sign in and enroll an authenticator.`);
  }
  catch (error) { console.error(error.code ? 'Admin provisioning failed; check database access.' : error.message); process.exitCode = 1; }
  finally { if (credentialFileCreated && !committed) await unlink('.data/admin-access.txt'); await db.close(); }
}
