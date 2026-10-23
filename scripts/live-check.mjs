import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const base = 'http://localhost:3000';
const health = await (await fetch(base + '/api/health')).json();
assert.equal(health.demo, false, 'This smoke check expects the real Neon-backed local app.');
assert.equal(health.office, true);
const delivery = await readFile('.data/admin-access.txt', 'utf8');
const email = delivery.match(/^Email: (.+)$/m)?.[1], password = delivery.match(/^Password: (.+)$/m)?.[1];
const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, password }) });
assert.equal(response.status, 200, 'Admin sign-in failed.');
const cookie = response.headers.get('set-cookie')?.split(';')[0], identity = await response.json();
try {
  assert.equal(identity.role, 'admin');
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: cookie } })).json(); assert.equal(me.email, email);
  const shops = await fetch(base + '/api/admin/shops', { headers: { Cookie: cookie } }); assert.equal(shops.status, 200);
  const rows = await shops.json();
  console.log(`Live local API is using Neon. Admin sign-in and persisted session verified; ${rows.length} shop registration(s) available. No credentials logged.`);
} finally { await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: base } }); }
