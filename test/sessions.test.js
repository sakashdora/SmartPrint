import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, PASSWORD } from './helpers/edu.js';

const login = (ctx, email, agent = 'TestBrowser/1') => ctx.call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD }, headers: { 'User-Agent': agent } });
const ageSession = (ctx, cookie, minutes) => ctx.db.query('UPDATE sessions SET last_seen=$1', [new Date(Date.now() - minutes * 60000).toISOString()]).then(() => cookie);

test('a signed-in person can list their sessions and sign out their other devices', async t => {
  const ctx = await boot(t);
  const admin = await ctx.org('sessions-a');
  const other = await ctx.member(admin.orgId, 'student');
  const phone = await login(ctx, admin.email, 'Phone/2'), laptop = await login(ctx, admin.email, 'Laptop/9');
  const list = (await ctx.call('/api/auth/sessions', { cookie: laptop.cookie })).body;
  assert.ok(list.length >= 3);
  assert.equal(list.filter(s => s.current).length, 1);
  assert.ok(list.some(s => s.device === 'Phone/2'));
  assert.ok(list.every(s => !('id' in s) && s.handle.length === 16), 'the stored session id is never exposed');

  // Revoke one session by its handle; revoking the current one by handle is refused (use sign-out for that).
  const target = list.find(s => s.device === 'Phone/2');
  assert.equal((await ctx.call(`/api/auth/sessions/${target.handle}`, { method: 'DELETE', cookie: laptop.cookie })).status, 200);
  assert.equal((await ctx.call('/api/me', { cookie: phone.cookie })).body, null, 'the revoked device is signed out');
  const current = list.find(s => s.current);
  assert.equal((await ctx.call(`/api/auth/sessions/${current.handle}`, { method: 'DELETE', cookie: laptop.cookie })).status, 404);

  // Someone else's session cannot be touched.
  const theirs = (await ctx.call('/api/auth/sessions', { cookie: other.cookie })).body[0];
  assert.equal((await ctx.call(`/api/auth/sessions/${theirs.handle}`, { method: 'DELETE', cookie: laptop.cookie })).status, 404);

  // Sign out everywhere else keeps this session.
  const third = await login(ctx, admin.email, 'Tablet/1');
  const result = await ctx.call('/api/auth/sessions/revoke-others', { method: 'POST', cookie: laptop.cookie });
  assert.equal(result.status, 200);
  assert.ok(result.body.revoked >= 2);
  assert.equal((await ctx.call('/api/me', { cookie: third.cookie })).body, null);
  assert.ok((await ctx.call('/api/me', { cookie: laptop.cookie })).body, 'the session you are using survives');
  assert.equal((await ctx.call('/api/me', { cookie: other.cookie })).body.email, other.email, 'other people are unaffected');
  assert.equal((await ctx.call('/api/auth/sessions')).status, 401);
});

test('administrators are signed out after an hour idle; students keep the normal session', async t => {
  const ctx = await boot(t);
  const admin = await ctx.org('idle');
  const student = await ctx.member(admin.orgId, 'student');
  // Fresh activity keeps working.
  assert.ok((await ctx.call('/api/me', { cookie: admin.cookie })).body);
  // 30 minutes of silence is fine for everyone; 90 minutes ends the administrator's session only.
  await ageSession(ctx, null, 30);
  assert.ok((await ctx.call('/api/me', { cookie: admin.cookie })).body);
  await ageSession(ctx, null, 90);
  assert.equal((await ctx.call('/api/me', { cookie: admin.cookie })).body, null);
  assert.ok((await ctx.call('/api/me', { cookie: student.cookie })).body, 'a student is not subject to the administrator idle limit');
  assert.equal(await ctx.number('SELECT COUNT(*) AS n FROM sessions WHERE user_id=$1', [admin.userId]), 0, 'the idle session is deleted');
  // Signing in again works.
  assert.equal((await login(ctx, admin.email)).status, 200);
});

test('activity keeps an administrator signed in and is recorded at most once a minute', async t => {
  const ctx = await boot(t);
  const admin = await ctx.org('active');
  await ageSession(ctx, null, 59);
  assert.ok((await ctx.call('/api/me', { cookie: admin.cookie })).body);
  const [row] = await ctx.db.query('SELECT last_seen FROM sessions WHERE user_id=$1', [admin.userId]);
  assert.ok(Date.now() - Date.parse(row.last_seen) < 10000, 'last_seen refreshed by the request');
  await ageSession(ctx, null, 59);
  assert.ok((await ctx.call('/api/me', { cookie: admin.cookie })).body, 'still signed in because the earlier request counted as activity');
});
