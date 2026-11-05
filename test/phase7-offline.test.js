import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from './helpers/edu.js';
import { AgentCore } from '../agent/core.js';
import { simulatedDriver } from '../agent/drivers.js';
import { sweepReservations, EXPIRY_GRACE_MS } from '../server/offline.js';

async function setup(t, name, policy = {}) {
  const ctx = await boot(t);
  const admin = await ctx.org(name), student = await ctx.member(admin.orgId, 'student');
  const info = (await ctx.call('/api/v2/edu/institution', { cookie: admin.cookie })).body;
  await ctx.call('/api/v2/edu/institution/policies', { method: 'PUT', cookie: admin.cookie, body: { version: info.version, policies: { offlineStudentPrinting: true, maxReservationMinor: 100000, ...policy } } });
  const opened = [], dirs = [];
  t.after(() => { opened.forEach(c => c.close()); dirs.forEach(d => rmSync(d, { recursive: true, force: true, maxRetries: 5 })); });
  const newAgent = async (label = 'PC') => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-')); dirs.push(dir);
    const core = new AgentCore({ dir, driver: simulatedDriver({ printers: [{ name: `${label} printer`, color: false, duplex: false }] }), url: ctx.base, vaultMode: 'file' });
    opened.push(core);
    const created = await ctx.call('/api/v2/edu/agents', { method: 'POST', cookie: admin.cookie, body: { name: label } });
    await core.enroll(created.body.enrolmentCode);
    await core.cycle();
    return core;
  };
  const credit = (amountMinor, who = student) => ctx.call(`/api/v2/edu/wallets/${who.userId}/credit`, { method: 'POST', cookie: admin.cookie, body: { amountMinor, note: 'cash', idempotencyKey: `k-${Math.random()}` } });
  const reserve = (agent, amountMinor, pin = '4321', who = student) => ctx.call('/api/v2/edu/wallet/reservations', { method: 'POST', cookie: who.cookie, body: { agentId: agent.settings.agentId, amountMinor, pin } });
  const wallet = async who => (await ctx.call('/api/v2/edu/wallet', { cookie: who.cookie })).body;
  const verify = async () => (await ctx.call('/api/v2/edu/wallets/verify', { cookie: admin.cookie })).body.problems;
  const revenue = () => ctx.number("SELECT COALESCE(SUM(b.available_minor),0) AS n FROM wallet_accounts a JOIN wallet_balances b ON b.account_id=a.id WHERE a.org_id=$1 AND a.kind='revenue'", [admin.orgId]);
  const collegeId = async who => (await ctx.db.query('SELECT college_id FROM edu_profiles WHERE user_id=$1', [who.userId]))[0].college_id;
  return { ...ctx, admin, student, newAgent, credit, reserve, wallet, verify, revenue, collegeId };
}

test('offline printing is off by default and its limits are enforced', async t => {
  const s = await setup(t, 'gate', { offlineStudentPrinting: false });
  const a = await s.newAgent();
  await s.credit(50000);
  const off = await s.reserve(a, 1000);
  assert.deepEqual([off.status, off.body.code], [403, 'offline.disabled']);
  const info = (await s.call('/api/v2/edu/institution', { cookie: s.admin.cookie })).body;
  await s.call('/api/v2/edu/institution/policies', { method: 'PUT', cookie: s.admin.cookie, body: { version: info.version, policies: { offlineStudentPrinting: true, maxReservationMinor: 5000 } } });
  assert.equal((await s.reserve(a, 50)).status, 400, 'too small');
  assert.equal((await s.reserve(a, 1000, '12')).status, 400, 'PIN too short');
  assert.equal((await s.reserve(a, 1000, 'abcd')).status, 400, 'PIN must be digits');
  assert.equal((await s.reserve(a, 6000)).status, 400, 'above the institution limit');
  assert.equal((await s.reserve(a, 3000)).status, 201);
  assert.equal((await s.reserve(a, 3000)).body.code, 'offline.limit', 'the limit covers everything already reserved');
  assert.equal((await s.call('/api/v2/edu/wallet/reservations', { method: 'POST', cookie: s.student.cookie, body: { agentId: '00000000-0000-0000-0000-000000000000', amountMinor: 1000, pin: '1234' } })).status, 404);
  const broke = await s.member(s.admin.orgId, 'student');
  assert.equal((await s.reserve(a, 1000, '1234', broke)).status, 402, 'no balance, no reservation');
  const staff = await s.member(s.admin.orgId, 'staff');
  assert.equal((await s.reserve(a, 1000, '1234', staff)).status, 403, 'only students reserve');
  assert.deepEqual(await s.verify(), []);
});

test('a reservation sets money aside for one agent; only that agent is given it, and never the PIN', async t => {
  const s = await setup(t, 'bound');
  const a = await s.newAgent('PC A'), b = await s.newAgent('PC B');
  await s.credit(10000);
  const r = await s.reserve(a, 4000, '7777');
  assert.equal(r.status, 201);
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held], [6000, 4000]);
  assert.equal(await a.fetchGrants(), 1);
  assert.equal(await b.fetchGrants(), 0, 'another agent receives nothing');
  const grants = await s.call('/api/agent/v2/offline/grants', { bearer: a.credential });
  assert.ok(!JSON.stringify(grants.body).includes('7777'), 'the PIN is never sent, only a salted verifier');
  assert.ok(grants.body.grants[0].pin.salt && grants.body.grants[0].pin.hash);
  assert.deepEqual(await s.verify(), []);
});

test('spending offline: PIN, limit, expiry, lock-out and a clock set backwards', async t => {
  const s = await setup(t, 'spend');
  const a = await s.newAgent();
  await s.credit(10000); await s.reserve(a, 1000, '2468');
  await a.fetchGrants();
  const id = await s.collegeId(s.student);
  const spend = (o = {}) => { try { return a.localSpend({ collegeId: id, pin: '2468', pages: 2, amountMinor: 300, ...o }); } catch (e) { return { code: e.code }; } };
  assert.deepEqual(spend({ pin: '0000' }), { code: 'offline.wrong_pin' });
  assert.deepEqual(spend({ collegeId: 'NOBODY' }), { code: 'offline.no_reservation' });
  assert.deepEqual(spend({ amountMinor: 1100 }), { code: 'offline.insufficient' });
  assert.deepEqual(spend(), { ok: true, remainingMinor: 700 });
  assert.deepEqual(spend(), { ok: true, remainingMinor: 400 });
  assert.deepEqual(spend({ amountMinor: 500 }), { code: 'offline.insufficient' }, 'unsynced spends count against the limit');
  // Five wrong PINs lock the reservation until the print point is online again.
  for (let i = 0; i < 4; i++) assert.deepEqual(spend({ pin: '1111' }), { code: 'offline.wrong_pin' });
  assert.deepEqual(spend({ pin: '2468' }), { code: 'offline.locked' }, 'even the right PIN is refused while locked');
  await a.fetchGrants();
  assert.equal(spend().ok, true, 'back online: the lock is cleared');
  // A clock moved backwards cannot extend a reservation; an expired one cannot be spent.
  a.settings.lastWall = Date.now() + 3600000;
  assert.deepEqual(spend({ amountMinor: 10 }), { code: 'offline.clock' });
  a.settings.lastWall = 0;
  a.db.prepare('UPDATE grants SET expires=?').run(new Date(Date.now() - 1000).toISOString());
  assert.deepEqual(spend({ amountMinor: 10 }), { code: 'offline.expired' });
});

test('sync charges the student once, whatever is repeated or interrupted', async t => {
  const s = await setup(t, 'sync');
  const a = await s.newAgent();
  await s.credit(10000); await s.reserve(a, 2000, '1357');
  await a.fetchGrants();
  const id = await s.collegeId(s.student);
  a.localSpend({ collegeId: id, pin: '1357', pages: 3, amountMinor: 900 });
  a.localSpend({ collegeId: id, pin: '1357', pages: 1, amountMinor: 300 });
  const first = await a.syncOffline();
  assert.deepEqual([first.accepted, first.replayed, first.problems], [2, 0, []]);
  const w = await s.wallet(s.student);
  assert.deepEqual([w.available, w.held, await s.revenue()], [8000, 800, 1200]);
  // The same log sent again (a retry after a lost response) changes nothing.
  a.db.prepare('UPDATE spend_log SET synced=0').run();
  const again = await a.syncOffline();
  assert.deepEqual([again.accepted, again.replayed], [0, 2]);
  assert.deepEqual([(await s.wallet(s.student)).held, await s.revenue()], [800, 1200]);
  assert.equal(await s.number('SELECT spent_minor AS n FROM offline_reservations'), 1200);
  assert.deepEqual(await s.verify(), []);
});

test('the same money cannot be spent at two agents, and one agent cannot spend another\'s reservation', async t => {
  const s = await setup(t, 'double');
  const a = await s.newAgent('PC A'), b = await s.newAgent('PC B');
  await s.credit(1000);
  assert.equal((await s.reserve(a, 700, '1111')).status, 201);
  assert.equal((await s.reserve(b, 700, '2222')).status, 402, 'only ₹3.00 is left to reserve: the first reservation already took the money');
  assert.equal((await s.reserve(b, 300, '2222')).status, 201);
  await a.fetchGrants(); await b.fetchGrants();
  const id = await s.collegeId(s.student);
  // Each agent can spend only what is bound to it.
  assert.equal(a.localSpend({ collegeId: id, pin: '1111', pages: 1, amountMinor: 700 }).ok, true);
  assert.throws(() => b.localSpend({ collegeId: id, pin: '2222', pages: 1, amountMinor: 400 }), /Only ₹3\.00/);
  assert.equal(b.localSpend({ collegeId: id, pin: '2222', pages: 1, amountMinor: 300 }).ok, true);
  // A forged log entry for the other agent's reservation is refused by the server and charges nothing.
  const reservationA = (await s.db.query('SELECT id FROM offline_reservations WHERE agent_id=$1', [a.settings.agentId]))[0].id;
  b.db.prepare('INSERT INTO spend_log (reservation_id,pages,amount_minor,at) VALUES (?,?,?,?)').run(reservationA, 1, 100, new Date().toISOString());
  const forged = await b.syncOffline();
  assert.ok(forged.problems.some(p => p.problem === 'unknown_reservation'));
  await a.syncOffline();
  assert.equal(await s.revenue(), 1000, 'exactly the money that existed was charged, no more');
  assert.equal((await s.wallet(s.student)).available, 0);
  assert.deepEqual(await s.verify(), []);
  assert.ok((await s.call('/api/v2/edu/offline/cases', { cookie: s.admin.cookie })).body.some(c => c.kind === 'unknown_reservation'), 'the attempt is visible to the institution');
});

test('overspending is capped at the reservation and becomes a case for the institution', async t => {
  const s = await setup(t, 'over');
  const a = await s.newAgent();
  await s.credit(5000); await s.reserve(a, 1000, '9999');
  await a.fetchGrants();
  // A misbehaving agent claims more than was reserved.
  a.db.prepare('INSERT INTO spend_log (reservation_id,pages,amount_minor,at) SELECT id,5,1500,? FROM grants').run(new Date().toISOString());
  const result = await a.syncOffline();
  assert.deepEqual(result.problems.map(p => [p.problem, p.uncharged]), [['over_limit', 500]]);
  assert.equal(await s.revenue(), 1000, 'never more than the reserved money');
  assert.equal((await s.wallet(s.student)).available, 4000, 'the rest of the wallet is untouched');
  assert.equal((await s.call('/api/v2/edu/offline/cases', { cookie: s.admin.cookie })).body[0].kind, 'spend_over_limit');
  assert.deepEqual(await s.verify(), []);
});

test('cancelling and expiry return only the unspent money, once', async t => {
  const s = await setup(t, 'close');
  const a = await s.newAgent();
  await s.credit(5000);
  const r = (await s.reserve(a, 2000, '1212')).body;
  await a.fetchGrants();
  a.localSpend({ collegeId: await s.collegeId(s.student), pin: '1212', pages: 2, amountMinor: 500 });
  // Cancel: nothing moves until the agent has synced and acknowledged, so an offline agent cannot be double spent.
  assert.equal((await s.call(`/api/v2/edu/wallet/reservations/${r.id}`, { method: 'DELETE', cookie: s.student.cookie })).status, 200);
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held], [3000, 2000]);
  await a.syncOffline(); await a.fetchGrants(); await a.syncOffline();
  const w = await s.wallet(s.student);
  assert.deepEqual([w.available, w.held, await s.revenue()], [4500, 0, 500], 'the 500 spent stays spent, the other 1500 is back');
  assert.throws(() => a.localSpend({ collegeId: 'x', pin: '1212', pages: 1, amountMinor: 1 }), error => error.code === 'offline.no_reservation');
  await a.syncOffline();
  assert.equal((await s.wallet(s.student)).available, 4500, 'a repeated acknowledgement releases nothing more');
  // Expiry: an agent that never comes back does not hold the money for ever.
  const lost = (await s.reserve(a, 1000, '3434')).body;
  assert.equal((await s.wallet(s.student)).held, 1000);
  await s.db.query('UPDATE offline_reservations SET expires=$1 WHERE id=$2', [new Date(Date.now() - EXPIRY_GRACE_MS - 60000).toISOString(), lost.id]);
  await sweepReservations(s.db);
  await sweepReservations(s.db);
  assert.deepEqual([(await s.wallet(s.student)).available, (await s.wallet(s.student)).held], [4500, 0]);
  assert.equal((await s.db.query('SELECT state FROM offline_reservations WHERE id=$1', [lost.id]))[0].state, 'expired');
  // A spend that arrives after the money was returned cannot be taken from the student again.
  a.db.prepare("INSERT INTO spend_log (reservation_id,pages,amount_minor,at) VALUES (?,?,?,?)").run(lost.id, 1, 400, new Date().toISOString());
  const late = await a.syncOffline();
  assert.deepEqual(late.problems.map(p => p.problem), ['expired']);
  assert.equal((await s.wallet(s.student)).available, 4500);
  assert.equal(await s.revenue(), 500);
  assert.deepEqual(await s.verify(), []);
});

test('staff jobs printed offline are recorded once for the usage report', async t => {
  const s = await setup(t, 'staffjobs');
  const a = await s.newAgent();
  const staff = await s.member(s.admin.orgId, 'staff');
  const id = await s.collegeId(staff);
  a.recordOfflineStaffJob({ collegeId: id, pages: 4, fileName: 'circular.pdf' });
  a.recordOfflineStaffJob({ collegeId: 'UNKNOWN-STAFF', pages: 1 });
  const first = await a.syncOffline();
  assert.deepEqual([first.accepted, first.problems.map(p => p.problem)], [1, ['unknown_staff']]);
  a.db.prepare('UPDATE offline_jobs SET synced=0').run();
  assert.equal((await a.syncOffline()).replayed, 2);
  const report = (await s.call('/api/v2/edu/reports/usage', { cookie: s.admin.cookie })).body;
  assert.deepEqual([report.total.jobs, report.total.pagesPrinted, report.byClass.staff.jobs], [1, 4, 1]);
  assert.equal((await s.call('/api/v2/edu/queue?status=completed', { cookie: s.admin.cookie })).body.length, 1);
});
