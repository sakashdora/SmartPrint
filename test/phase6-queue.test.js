import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers/edu.js';

const scheduler = (call, admin, poolId, body) => call(`/api/v2/edu/pools/${poolId}/scheduler`, { method: 'PUT', cookie: admin.cookie, body });
const defaultPool = async (call, admin) => (await call('/api/v2/edu/pools', { cookie: admin.cookie })).body[0];

test('FIFO pools keep their order; the fair scheduler is opt-in per pool', async t => {
  const { org, agent, job, call, db } = await boot(t);
  const admin = await org('fifo');
  const a = await agent(admin);
  const ids = []; for (let i = 0; i < 4; i++) ids.push(await job(admin.orgId, {}, { jobClass: i % 2 ? 'student' : 'staff' }));
  const order = []; for (let i = 0; i < 4; i++) order.push((await a.printNext('Mono')).jobId);
  assert.deepEqual(order, ids, 'oldest first, whatever the class');
  assert.equal((await defaultPool(call, admin)).scheduler, 'fifo_priority');
  assert.equal((await db.query('SELECT vft FROM print_jobs LIMIT 1'))[0].vft, null, 'no fair-queue tags in a FIFO pool');
});

test('staff and students share a busy printer in proportion to their weights (3:1)', async t => {
  const { org, agent, job, call, db } = await boot(t);
  const admin = await org('weights');
  const a = await agent(admin);
  const pool = await defaultPool(call, admin);
  assert.equal((await scheduler(call, admin, pool.id, { scheduler: 'wfq_aging', weights: { staff: 3, student: 1 }, agingRate: 0, userCap: 1000 })).status, 200);
  // Both classes are backlogged; students queued first, which would win under FIFO.
  for (let i = 0; i < 40; i++) await job(admin.orgId, {}, { jobClass: 'student' });
  for (let i = 0; i < 40; i++) await job(admin.orgId, {}, { jobClass: 'staff' });
  const served = [];
  for (let i = 0; i < 40; i++) served.push((await db.query('SELECT class FROM print_jobs WHERE id=$1', [(await a.printNext('Mono')).jobId]))[0].class);
  const staff = served.filter(c => c === 'staff').length;
  assert.ok(staff >= 28 && staff <= 32, `staff got ${staff} of 40 slots, expected about 30`);
  assert.ok(served.slice(0, 8).includes('student'), 'students are not starved at the start either');
});

test('aging: a job that waited long overtakes newer work of a heavier class (no starvation)', async t => {
  const { org, agent, job, call } = await boot(t);
  const admin = await org('aging');
  const a = await agent(admin);
  const pool = await defaultPool(call, admin);
  await scheduler(call, admin, pool.id, { scheduler: 'wfq_aging', weights: { staff: 3, student: 1 }, agingRate: 0.01, userCap: 1000 });
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const students = []; for (let i = 0; i < 6; i++) students.push(await job(admin.orgId, {}, { jobClass: 'student', enqueuedAt: hourAgo }));
  for (let i = 0; i < 30; i++) await job(admin.orgId, {}, { jobClass: 'staff' });
  const first = []; for (let i = 0; i < 6; i++) first.push((await a.printNext('Mono')).jobId);
  assert.deepEqual(first.sort(), [...students].sort(), 'the six hour-old student jobs are served before the fresh staff jobs');
});

test('a job past the pool\'s maximum wait is promoted regardless of its weight', async t => {
  const { org, agent, job, call } = await boot(t);
  const admin = await org('maxwait');
  const a = await agent(admin);
  const pool = await defaultPool(call, admin);
  await scheduler(call, admin, pool.id, { scheduler: 'wfq_aging', weights: { staff: 100, student: 1 }, agingRate: 0, maxWaitSeconds: 60, userCap: 1000 });
  for (let i = 0; i < 5; i++) await job(admin.orgId, {}, { jobClass: 'staff' });
  const old = await job(admin.orgId, {}, { jobClass: 'student', enqueuedAt: new Date(Date.now() - 300000).toISOString() });
  assert.equal((await a.printNext('Mono')).jobId, old);
});

test('a class that was idle does not bank credit: its first job joins at the current virtual time', async t => {
  const { org, agent, job, call, db } = await boot(t);
  const admin = await org('clock');
  const a = await agent(admin);
  const pool = await defaultPool(call, admin);
  await scheduler(call, admin, pool.id, { scheduler: 'wfq_aging', weights: { staff: 1, student: 1 }, agingRate: 0, userCap: 1000 });
  for (let i = 0; i < 10; i++) await job(admin.orgId, {}, { jobClass: 'staff' });
  for (let i = 0; i < 6; i++) await a.printNext('Mono');
  const clock = Number((await db.query('SELECT vtime FROM printer_pools WHERE id=$1', [pool.id]))[0].vtime);
  assert.ok(clock >= 5.9);
  const late = await job(admin.orgId, {}, { jobClass: 'student' });
  const vft = Number((await db.query('SELECT vft FROM print_jobs WHERE id=$1', [late]))[0].vft);
  assert.ok(vft >= clock + 1 - 1e-9, `student tag ${vft} must start from the clock ${clock}, not from 0`);
  // It is served after at most one more staff job, not ahead of all of them.
  const next = [(await a.printNext('Mono')).jobId, (await a.printNext('Mono')).jobId];
  assert.ok(next.includes(late));
});

test('colour work costs more virtual time than black and white', async t => {
  const { org, agent, job, call, db } = await boot(t);
  const admin = await org('colour');
  await agent(admin, [{ name: 'Colour', color: true, duplex: false }]);
  const pool = await defaultPool(call, admin);
  await scheduler(call, admin, pool.id, { scheduler: 'wfq_aging', weights: { staff: 1, student: 1 }, agingRate: 0 });
  const bw = await job(admin.orgId, { color: 'bw' }, { jobClass: 'staff', sheets: 2 });
  const col = await job(admin.orgId, { color: 'color' }, { jobClass: 'student', sheets: 2 });
  const tag = async id => Number((await db.query('SELECT vft FROM print_jobs WHERE id=$1', [id]))[0].vft);
  assert.equal(await tag(bw), 2);
  assert.equal(await tag(col), 4);
});

test('compatibility still wins under fair queueing: a colour job never goes to a mono printer', async t => {
  const { org, agent, job, call } = await boot(t);
  const admin = await org('compat');
  const mono = await agent(admin, [{ name: 'Mono', color: false, duplex: false }], 'Mono PC');
  const colour = await agent(admin, [{ name: 'Colour', color: true, duplex: false }], 'Colour PC');
  const pool = await defaultPool(call, admin);
  await scheduler(call, admin, pool.id, { scheduler: 'wfq_aging', weights: { staff: 3, student: 1 }, agingRate: 0.5 });
  const colourJob = await job(admin.orgId, { color: 'color' }, { jobClass: 'staff' });
  assert.equal(await mono.printNext('Mono'), undefined, 'the mono printer finds nothing to take');
  assert.equal((await colour.printNext('Colour')).jobId, colourJob);
});

test('per-user cap: nobody can bury the queue; operators are exempt; a cancel frees a slot', async t => {
  const { org, member, agent, job, call } = await boot(t);
  const admin = await org('cap');
  await agent(admin);
  const student = await member(admin.orgId, 'student');
  const pool = await defaultPool(call, admin);
  assert.equal((await scheduler(call, admin, pool.id, { userCap: 3 })).status, 200);
  const ids = []; for (let i = 0; i < 3; i++) ids.push(await job(admin.orgId, {}, { jobClass: 'student', submitterId: student.userId }));
  await assert.rejects(() => job(admin.orgId, {}, { jobClass: 'student', submitterId: student.userId }), /3 jobs waiting/);
  await job(admin.orgId, {}, { jobClass: 'student', submitterId: (await member(admin.orgId, 'student')).userId });
  await job(admin.orgId, {}, { jobClass: 'operator', submitterId: student.userId });
  assert.equal((await call(`/api/v2/edu/jobs/${ids[0]}/cancel`, { method: 'POST', cookie: admin.cookie })).status, 200);
  await job(admin.orgId, {}, { jobClass: 'student', submitterId: student.userId });
});

test('scheduler settings are validated, audited and limited to the institution admin of that pool', async t => {
  const { org, member, call, agent } = await boot(t);
  const a = await org('sa'), b = await org('sb');
  await agent(a); await agent(b);
  const pool = await defaultPool(call, a);
  assert.equal((await scheduler(call, a, pool.id, { scheduler: 'magic' })).status, 400);
  assert.equal((await scheduler(call, a, pool.id, { weights: { teacher: 5 } })).status, 400);
  assert.equal((await scheduler(call, a, pool.id, { weights: { staff: 0 } })).status, 400);
  assert.equal((await scheduler(call, a, pool.id, { agingRate: 5000 })).status, 400);
  assert.equal((await scheduler(call, a, pool.id, { scheduler: 'wfq_aging', weights: { staff: 2, student: 1 }, agingRate: 0.2, maxWaitSeconds: 600, userCap: 8 })).status, 200);
  const saved = await defaultPool(call, a);
  assert.deepEqual([saved.scheduler, saved.aging_rate, saved.max_wait_seconds, saved.user_cap], ['wfq_aging', 0.2, 600, 8]);
  assert.equal((await scheduler(call, b, pool.id, { scheduler: 'fifo_priority' })).status, 404, 'another institution cannot change it');
  assert.equal((await scheduler(call, await member(a.orgId, 'student'), pool.id, { scheduler: 'fifo_priority' })).status, 403);
  assert.equal((await scheduler(call, await member(a.orgId, 'print_operator'), pool.id, { scheduler: 'fifo_priority' })).status, 403);
});
