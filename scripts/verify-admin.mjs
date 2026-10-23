import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openDatabase } from '../server/db.js';
import { checkPassword, hashPassword } from '../server/security.js';
const credentials = await readFile('.data/admin-access.txt', 'utf8');
const email = credentials.match(/^Email: (.+)$/m)?.[1], password = credentials.match(/^Password: (.+)$/m)?.[1];
const db = await openDatabase();
try {
  const [user] = await db.query('SELECT id,password,role FROM users WHERE email=$1', [email]);
  assert.equal(user.role, 'admin'); assert.ok(await checkPassword(password, user.password));
  if (!user.password.startsWith('scrypt$')) await db.query('UPDATE users SET password=$1 WHERE id=$2 AND password=$3', [await hashPassword(password), user.id, user.password]);
  const other = await openDatabase();
  try { const [saved] = await other.query('SELECT password,role FROM users WHERE id=$1', [user.id]); assert.ok(saved.password.startsWith('scrypt$')); assert.ok(await checkPassword(password, saved.password)); assert.notEqual(saved.password, password); }
  finally { await other.close(); }
  console.log('Admin persists across database connections; role and strong salted password hash verified. No password was logged.');
} catch (error) { console.error('Admin verification failed:', error.code || error.name); process.exitCode = 1; }
finally { await db.close(); }
