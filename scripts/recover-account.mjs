import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { hashPassword } from '../server/security.js';
const email = String(process.argv[2] || '').trim().toLowerCase(), reason = process.env.RECOVERY_REASON;
if (!process.env.DATABASE_URL || !email.includes('@') || !reason || reason.length < 10) throw new Error('Use the operator environment: RECOVERY_REASON="reason for recovery" and npm run account:recover -- email@example.com. Verify the account holder first.');
const db = await openDatabase(); let file, committed = false;
try {
  const [user] = await db.query('SELECT id FROM users WHERE email=$1', [email]); if (!user) throw new Error('Account not found.');
  const password = randomBytes(24).toString('base64url');
  await mkdir('.data', { recursive: true }); file = `.data/recovery-${randomUUID()}.txt`;
  await writeFile(file, `Email: ${email}\nPassword: ${password}\nEnroll an authenticator on your next production sign-in. Change the password after recovery. Keep this file private.\n`, { flag: 'wx', mode: 0o600 });
  await db.transaction(async tx => {
    await tx.query('UPDATE users SET password=$1 WHERE id=$2', [await hashPassword(password), user.id]);
    await tx.query('DELETE FROM sessions WHERE user_id=$1', [user.id]); await tx.query('DELETE FROM mfa WHERE user_id=$1', [user.id]);
    await tx.query('INSERT INTO audit (id,actor,action,target,created) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), 'operator', `account.recovered:${reason.slice(0,100)}`, user.id, new Date().toISOString()]);
  }); committed = true;
  console.log(`Recovery completed; prior sessions and authenticator revoked. Credentials saved privately to ${file}.`);
} catch (error) { console.error('Recovery failed:', error.code || error.message); process.exitCode = 1; }
finally { if (file && !committed) await unlink(file); await db.close(); }
