import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { hashPassword, loadKey, encrypt, digest } from '../server/security.js';
import { enqueueJob, storeObject, sweepAttempts } from '../server/queue.js';

const PASSWORD = 'a-long-test-password-1';
const key = loadKey();
const pdf = async () => { const d = await PDFDocument.create(); d.addPage().drawText('agent test'); return Buffer.from(await d.save()); };

// By default every test gets a private in-memory SQLite database. With SMARTPRINT_TEST_DATABASE_URL pointing at
// a disposable PostgreSQL database (its name must contain "test"), the same tests run against PostgreSQL, where
// FOR UPDATE SKIP LOCKED and the partial unique index are the real mechanisms. Run such a pass with
// --test-concurrency=1 because every test recreates the schema.
const pgUrl = process.env.SMARTPRINT_TEST_DATABASE_URL;
async function freshDatabase() {
  if (!pgUrl) return openDatabase({ url: null, path: ':memory:' });
  const name = decodeURIComponent(new URL(pgUrl).pathname.slice(1));
  if (!/test/i.test(name) || [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL].includes(pgUrl)) throw new Error('Refusing to reset a database that is not clearly a test database.');
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect(); await admin.query('DROP SCHEMA IF EXISTS smartprint CASCADE'); await admin.end();
  return openDatabase({ url: pgUrl });
}

async function boot(t) {
  const db = await freshDatabase();
  const service = await createApp({ database: db });
  const server = service.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { await new Promise(r => server.close(r)); await service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, cookie, bearer, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const hash = await hashPassword(PASSWORD);
  // An education organization with a user in the given role, signed in.
  const org = async (name, role = 'institution_admin') => {
    const orgId = randomUUID(), userId = randomUUID(), email = `${role}-${orgId.slice(0, 6)}@${name.toLowerCase()}.test`;
    await db.query("INSERT INTO organizations (id,type,name,slug,status,created) VALUES ($1,'education',$2,$3,'active',$4)", [orgId, name, `${name}-${orgId.slice(0, 6)}`, new Date().toISOString()]);
    await db.query("INSERT INTO users (id,email,password,role) VALUES ($1,$2,$3,'customer')", [userId, email, hash]);
    await db.query("INSERT INTO memberships (id,org_id,user_id,role,created) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), orgId, userId, role, new Date().toISOString()]);
    const session = await call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    return { orgId, userId, cookie: session.cookie };
  };
  // An enrolled agent that reported printers [{name,color,duplex}]. Returns its credential and printer ids by name.
  const agent = async (admin, name = 'Agent PC', printers = [{ name: 'Mono', color: false, duplex: false }], instance = randomUUID()) => {
    const created = await call('/api/v2/edu/agents', { method: 'POST', cookie: admin.cookie, body: { name } });
    assert.equal(created.status, 201);
    const enrolled = await call('/api/agent/v2/enroll', { method: 'POST', body: { code: created.body.enrolmentCode, hostname: name, os: 'Windows 11', version: '3.0.0', instanceId: instance } });
    assert.equal(enrolled.status, 201);
    const credential = enrolled.body.credential;
    const report = await call('/api/agent/v2/printers/report', { method: 'POST', bearer: credential, headers: { 'X-Agent-Instance': instance }, body: { printers } });
    return { id: enrolled.body.agentId, credential, instance, printers: Object.fromEntries(report.body.printers.map(p => [p.name, p.id])), call: (path, opts = {}) => call(path, { ...opts, bearer: opts.bearer ?? credential, headers: { 'X-Agent-Instance': instance, ...(opts.headers || {}) } }) };
  };
  const job = async (orgId, options = {}, extra = {}) => db.transaction(async tx => {
    const objectId = await storeObject(tx, orgId, await pdf(), { encrypt, key });
    return enqueueJob(tx, { orgId, objectId, options, pages: 1, ...extra });
  });
  return { db, call, org, agent, job };
}

test('enrolment, discovery and the default pool need no setup', async t => {
  const { call, org, agent, db } = await boot(t);
  const admin = await org('alpha');
  const created = await call('/api/v2/edu/agents', { method: 'POST', cookie: admin.cookie, body: { name: 'Library PC' } });
  const code = created.body.enrolmentCode;
  const first = await call('/api/agent/v2/enroll', { method: 'POST', body: { code, hostname: 'LIB', version: '3.0.0' } });
  assert.equal(first.status, 201);
  assert.equal((await call('/api/agent/v2/enroll', { method: 'POST', body: { code } })).status, 400, 'a code works once');
  assert.equal((await call('/api/agent/v2/enroll', { method: 'POST', body: { code: 'f'.repeat(24) } })).status, 400);
  assert.equal((await call('/api/agent/v2/config')).status, 401, 'no credential, no access');
  const a = await agent(admin, 'Second PC', [{ name: 'HP LaserJet', color: false, duplex: false }, { name: 'Brother Colour', color: true, duplex: true, connection: 'usb' }]);
  const pools = (await call('/api/v2/edu/pools', { cookie: admin.cookie })).body;
  assert.equal(pools.length, 1);
  assert.equal(pools[0].is_default, 1);
  assert.equal(pools[0].printerIds.length, 2, 'new printers join the default pool automatically');
  const printers = (await call('/api/v2/edu/printers', { cookie: admin.cookie })).body;
  assert.ok(printers.every(p => p.online));
  assert.equal(printers.find(p => p.windows_name === 'HP LaserJet').cap_color, 0);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM print_attempts'))[0].n), 0);
  assert.ok(a.id);
});

test('colour and two-sided jobs are never routed to a printer that cannot do them', async t => {
  const { call, org, agent, job, db } = await boot(t);
  const admin = await org('beta');
  const mono = await agent(admin, 'Mono PC', [{ name: 'Mono', color: false, duplex: false }, { name: 'Unknown', color: undefined, duplex: undefined }]);
  // Only mono printers exist: a colour job is refused when it is submitted.
  await assert.rejects(() => job(admin.orgId, { color: 'color' }), /No online printer that supports colour/);
  await assert.rejects(() => job(admin.orgId, { duplex: true }), /two-sided/);
  const colour = await agent(admin, 'Colour PC', [{ name: 'Colour', color: true, duplex: false }]);
  const colourJob = await job(admin.orgId, { color: 'color' });
  const bwJob = await job(admin.orgId, { color: 'bw' });
  // Unknown capability never qualifies; a mono printer takes only the black & white job.
  const monoClaim = await mono.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [mono.printers.Mono, mono.printers.Unknown] } });
  assert.deepEqual(monoClaim.body.jobs.map(j => j.jobId), [bwJob]);
  const colourClaim = await colour.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [colour.printers.Colour] } });
  assert.deepEqual(colourClaim.body.jobs.map(j => j.jobId), [colourJob]);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM print_attempts WHERE state=$1', ['claimed']))[0].n), 2);
});

test('five agents claiming twenty jobs at once never take a job twice', async t => {
  const { org, agent, job, db } = await boot(t);
  const admin = await org('gamma');
  const agents = [];
  for (let i = 0; i < 5; i++) agents.push(await agent(admin, `PC ${i}`, [{ name: `P${i}`, color: false, duplex: false }]));
  const jobs = []; for (let i = 0; i < 20; i++) jobs.push(await job(admin.orgId));
  const seen = new Map();
  for (let round = 0; round < 8; round++) {
    const results = await Promise.all(agents.map(a => a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: Object.values(a.printers) } })));
    for (const [index, result] of results.entries()) for (const claimed of result.body.jobs) {
      assert.ok(!seen.has(claimed.jobId), 'a job was handed out twice');
      seen.set(claimed.jobId, agents[index].id);
      // Finish it so the printer can take the next one.
      const done = await agents[index].call(`/api/agent/v2/attempts/${claimed.attemptId}/events`, { method: 'POST', headers: { 'X-Lease-Token': claimed.leaseToken }, body: { event: 'submitted' } });
      assert.equal(done.status, 200);
      await agents[index].call(`/api/agent/v2/attempts/${claimed.attemptId}/events`, { method: 'POST', headers: { 'X-Lease-Token': claimed.leaseToken }, body: { event: 'completed', pages: 1 } });
    }
  }
  assert.equal(seen.size, 20);
  assert.deepEqual([...seen.keys()].sort(), [...jobs].sort());
  const attempts = await db.query('SELECT job_id, COUNT(*) AS n FROM print_attempts GROUP BY job_id');
  assert.ok(attempts.every(a => Number(a.n) === 1), 'exactly one attempt per job');
  assert.equal(Number((await db.query("SELECT COUNT(*) AS n FROM print_jobs WHERE status='completed'"))[0].n), 20);
});

test('the database itself refuses a second live attempt for one job', async t => {
  const { org, agent, job, db } = await boot(t);
  const admin = await org('delta');
  const a = await agent(admin);
  const jobId = await job(admin.orgId);
  await a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [a.printers.Mono] } });
  await assert.rejects(() => db.query("INSERT INTO print_attempts (id,org_id,job_id,printer_id,agent_id,attempt_no,state,lease_token_hash,lease_expires,created) VALUES ($1,$2,$3,$4,$5,2,'claimed','x','2099-01-01','2026-01-01')", [randomUUID(), admin.orgId, jobId, a.printers.Mono, a.id]), /unique/i);
});

test('lease token, fencing and a finished job: nothing prints twice', async t => {
  const { org, agent, job, db } = await boot(t);
  const admin = await org('epsilon');
  const a = await agent(admin), other = await agent(admin, 'Other PC', [{ name: 'Other', color: false, duplex: false }]);
  const jobId = await job(admin.orgId);
  const claim = (await a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [a.printers.Mono] } })).body.jobs[0];
  const events = (agent, token, body, id = claim.attemptId) => agent.call(`/api/agent/v2/attempts/${id}/events`, { method: 'POST', headers: { 'X-Lease-Token': token }, body });
  const doc = token => a.call(`/api/agent/v2/attempts/${claim.attemptId}/document`, { headers: { 'X-Lease-Token': token, Range: 'bytes=0-1048575' } });
  assert.equal((await doc('wrong')).status, 409, 'wrong lease token');
  assert.equal((await other.call(`/api/agent/v2/attempts/${claim.attemptId}/document`, { headers: { 'X-Lease-Token': claim.leaseToken } })).status, 409, 'another agent cannot fetch it');
  const file = await doc(claim.leaseToken);
  assert.ok([200, 206].includes(file.status));
  assert.equal(file.body.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await events(a, 'wrong', { event: 'submitted' })).status, 409);
  assert.equal((await events(other, claim.leaseToken, { event: 'submitted' })).body.code, 'agent.fenced');
  assert.equal((await events(a, claim.leaseToken, { event: 'completed', pages: 1 })).status, 409, 'completed needs submitted first');
  assert.equal((await events(a, claim.leaseToken, { event: 'submitted' })).status, 200);
  assert.equal((await events(a, claim.leaseToken, { event: 'submitted' })).body.replay, true, 'repeated submitted is harmless');
  assert.equal((await doc(claim.leaseToken)).status, 409, 'the file is only served before submission');
  assert.equal((await events(a, claim.leaseToken, { event: 'completed', pages: 1 })).body.state, 'completed');
  assert.equal((await events(a, claim.leaseToken, { event: 'completed', pages: 1 })).body.replay, true);
  assert.equal((await events(a, claim.leaseToken, { event: 'failed', error: 'late' })).status, 409, 'a finished attempt cannot be changed');
  const [stored] = await db.query('SELECT deleted_at FROM stored_objects');
  assert.ok(stored.deleted_at, 'the document is deleted once the job printed');
  assert.equal((await db.query('SELECT status FROM print_jobs WHERE id=$1', [jobId]))[0].status, 'completed');
});

test('expired leases: unsent work is re-queued, submitted work becomes uncertain and is never retried blindly', async t => {
  const { org, agent, job, db, call } = await boot(t);
  const admin = await org('zeta');
  const a = await agent(admin);
  const events = (claim, body) => a.call(`/api/agent/v2/attempts/${claim.attemptId}/events`, { method: 'POST', headers: { 'X-Lease-Token': claim.leaseToken }, body });
  const claimNext = async () => (await a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [a.printers.Mono] } })).body.jobs[0];

  // 1. Agent vanishes right after claiming: nothing reached Windows, so the job goes back and a NEW attempt may start.
  const j1 = await job(admin.orgId);
  const stale = await claimNext();
  await db.query("UPDATE print_attempts SET lease_expires='2020-01-01T00:00:00.000Z' WHERE id=$1", [stale.attemptId]);
  await sweepAttempts(db);
  assert.equal((await db.query('SELECT status FROM print_jobs WHERE id=$1', [j1]))[0].status, 'queued');
  assert.equal((await events(stale, { event: 'submitted' })).body.code, 'agent.fenced', 'the old attempt is fenced');
  const retry = await claimNext();
  assert.equal(retry.attemptNo, 2);
  await events(retry, { event: 'submitted' });
  await events(retry, { event: 'completed', pages: 1 });

  // 2. Agent vanishes after submitting: the paper may or may not exist -> uncertain.
  const j2 = await job(admin.orgId);
  const sent = await claimNext();
  await events(sent, { event: 'submitted' });
  await db.query("UPDATE print_attempts SET lease_expires='2020-01-01T00:00:00.000Z' WHERE id=$1", [sent.attemptId]);
  await sweepAttempts(db);
  assert.equal((await db.query('SELECT status FROM print_jobs WHERE id=$1', [j2]))[0].status, 'uncertain');
  const blocked = await job(admin.orgId);
  assert.equal(await claimNext(), undefined, 'an uncertain job blocks its printer until a person decides');
  const retryUncertain = await call(`/api/v2/edu/jobs/${j2}/retry`, { method: 'POST', cookie: admin.cookie });
  assert.equal(retryUncertain.status, 409);
  assert.match(retryUncertain.body.error, /twice/);

  // 3. A late completion with the valid token proves the outcome and is accepted.
  assert.equal((await events(sent, { event: 'completed', pages: 1 })).body.state, 'completed');
  assert.equal((await db.query('SELECT status FROM print_jobs WHERE id=$1', [j2]))[0].status, 'completed');
  assert.ok(await claimNext(), 'the printer is free again');
  assert.ok(blocked);
});

test('operator decisions: failed prints may be retried, uncertain ones need a person, partial prints keep the page count', async t => {
  const { org, agent, job, db, call } = await boot(t);
  const admin = await org('eta');
  const a = await agent(admin);
  const claimNext = async () => (await a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [a.printers.Mono] } })).body.jobs[0];
  const events = (claim, body) => a.call(`/api/agent/v2/attempts/${claim.attemptId}/events`, { method: 'POST', headers: { 'X-Lease-Token': claim.leaseToken }, body });

  const j1 = await job(admin.orgId);
  const c1 = await claimNext();
  await events(c1, { event: 'failed', error: 'Printer offline' });
  assert.equal((await db.query('SELECT status FROM print_jobs WHERE id=$1', [j1]))[0].status, 'failed');
  assert.equal((await call(`/api/v2/edu/jobs/${j1}/retry`, { method: 'POST', cookie: admin.cookie })).status, 200);
  const c1b = await claimNext();
  assert.equal(c1b.attemptNo, 2);
  await events(c1b, { event: 'submitted' });
  // Failure after submission with 3 pages out: outcome is partial/uncertain, not retryable.
  await events(c1b, { event: 'failed', error: 'Paper jam', pages: 3 });
  assert.equal((await db.query('SELECT status, pages_printed FROM print_jobs WHERE id=$1', [j1]))[0].status, 'uncertain');
  assert.equal((await call(`/api/v2/edu/jobs/${j1}/cancel`, { method: 'POST', cookie: admin.cookie })).status, 409);
  assert.equal((await call(`/api/v2/edu/jobs/${j1}/resolve-uncertain`, { method: 'POST', cookie: admin.cookie, body: { printed: false, pages: 3 } })).status, 200);
  const [after] = await db.query('SELECT status, pages_printed FROM print_jobs WHERE id=$1', [j1]);
  assert.deepEqual([after.status, Number(after.pages_printed)], ['failed', 3], 'the 3 printed pages are recorded');
  assert.equal((await call(`/api/v2/edu/jobs/${j1}/retry`, { method: 'POST', cookie: admin.cookie })).status, 200);

  // A cancelled queued job deletes its document.
  const j2 = await job(admin.orgId, {}, { priorityBoost: -1 });
  assert.equal((await call(`/api/v2/edu/jobs/${j2}/cancel`, { method: 'POST', cookie: admin.cookie })).status, 200);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM stored_objects WHERE deleted_at IS NOT NULL"))[0].n >= 1, true);
});

test('organizations are isolated: ids, agents, queues and credentials of one never work in another', async t => {
  const { org, agent, job, call, db } = await boot(t);
  const a = await org('orgA'), b = await org('orgB');
  const agentA = await agent(a, 'A PC'), agentB = await agent(b, 'B PC');
  const jobA = await job(a.orgId);
  // Lists contain only the caller's own data.
  assert.equal((await call('/api/v2/edu/printers', { cookie: b.cookie })).body.every(p => p.org_id === b.orgId), true);
  assert.equal((await call('/api/v2/edu/queue', { cookie: b.cookie })).body.length, 0);
  assert.equal((await call('/api/v2/edu/agents', { cookie: b.cookie })).body.length, 1);
  // Forged ids answer 404 and change nothing.
  const printerA = agentA.printers.Mono;
  assert.equal((await call(`/api/v2/edu/printers/${printerA}`, { method: 'PATCH', cookie: b.cookie, body: { displayName: 'hijacked' } })).status, 404);
  assert.equal((await call(`/api/v2/edu/printers/${printerA}/pause`, { method: 'POST', cookie: b.cookie })).status, 404);
  assert.equal((await call(`/api/v2/edu/printers/${printerA}/reassign`, { method: 'POST', cookie: b.cookie, body: { agentId: agentB.id } })).status, 404);
  assert.equal((await call(`/api/v2/edu/jobs/${jobA}/cancel`, { method: 'POST', cookie: b.cookie })).status, 404);
  assert.equal((await call(`/api/v2/edu/agents/${agentA.id}/revoke`, { method: 'POST', cookie: b.cookie })).status, 404);
  assert.equal((await call(`/api/v2/edu/printers/${agentB.printers.Mono}/reassign`, { method: 'POST', cookie: a.cookie, body: { agentId: agentB.id } })).status, 404);
  // Another organization's agent cannot claim, fetch or report on this organization's work.
  assert.deepEqual((await agentB.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [printerA, agentB.printers.Mono] } })).body.jobs, []);
  const claim = (await agentA.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [printerA] } })).body.jobs[0];
  assert.equal((await agentB.call(`/api/agent/v2/attempts/${claim.attemptId}/document`, { headers: { 'X-Lease-Token': claim.leaseToken } })).status, 409);
  assert.equal((await agentB.call(`/api/agent/v2/attempts/${claim.attemptId}/events`, { method: 'POST', headers: { 'X-Lease-Token': claim.leaseToken }, body: { event: 'completed' } })).status, 409);
  assert.equal((await db.query('SELECT status FROM print_jobs WHERE id=$1', [jobA]))[0].status, 'claimed');
  // Pools cannot hold printers of another organization.
  const poolB = (await call('/api/v2/edu/pools', { cookie: b.cookie })).body[0];
  assert.equal((await call(`/api/v2/edu/pools/${poolB.id}/members`, { method: 'PUT', cookie: b.cookie, body: { printerIds: [printerA] } })).status, 404);
  // Roles: a student has no institution-admin powers; shop owners and platform staff are not institution admins.
  const student = await org('orgA2', 'student'), shopOwner = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@smartprint.local', password: 'SmartPrintDemo!2026' } });
  for (const user of [student, shopOwner]) {
    assert.equal((await call('/api/v2/edu/agents', { cookie: user.cookie })).status, 403);
    assert.equal((await call('/api/v2/edu/printers', { cookie: user.cookie })).status, 403);
  }
  assert.equal((await call('/api/v2/edu/agents')).status, 401);
});

test('revoking an agent stops it at once and returns its unsent work to the queue', async t => {
  const { org, agent, job, call, db } = await boot(t);
  const admin = await org('theta');
  const a = await agent(admin);
  const jobId = await job(admin.orgId);
  const claim = (await a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [a.printers.Mono] } })).body.jobs[0];
  assert.ok(claim);
  assert.equal((await call(`/api/v2/edu/agents/${a.id}/revoke`, { method: 'POST', cookie: admin.cookie })).status, 200);
  assert.equal((await a.call('/api/agent/v2/config')).status, 401);
  assert.equal((await db.query('SELECT status FROM print_jobs WHERE id=$1', [jobId]))[0].status, 'queued');
  assert.equal((await db.query('SELECT state FROM print_attempts WHERE id=$1', [claim.attemptId]))[0].state, 'expired');
});

test('credential rotation overlaps, a second installation is refused, paused printers claim nothing', async t => {
  const { org, agent, job, call, db } = await boot(t);
  const admin = await org('iota');
  const a = await agent(admin);
  const rotated = await a.call('/api/agent/v2/credentials/rotate', { method: 'POST' });
  assert.equal(rotated.status, 200);
  assert.equal((await a.call('/api/agent/v2/config')).status, 200, 'the old credential still works during the overlap');
  assert.equal((await a.call('/api/agent/v2/config', { bearer: rotated.body.credential })).status, 200);
  assert.ok((await db.query('SELECT expires FROM agent_credentials WHERE hash=$1', [digest(a.credential)]))[0].expires, 'the old credential has an expiry');
  assert.equal((await call('/api/agent/v2/config', { bearer: rotated.body.credential, headers: { 'X-Agent-Instance': 'another-machine' } })).body.code, 'agent.instance_conflict');
  await a.call('/api/agent/v2/credentials/rotate', { method: 'POST', bearer: rotated.body.credential });
  assert.equal((await a.call('/api/agent/v2/config')).status, 401, 'at most two credentials stay valid');

  await job(admin.orgId);
  assert.equal((await call(`/api/v2/edu/printers/${a.printers.Mono}/pause`, { method: 'POST', cookie: admin.cookie })).status, 200);
  const paused = await call('/api/agent/v2/jobs/claim', { method: 'POST', bearer: (await a.call('/api/agent/v2/credentials/rotate', { method: 'POST', bearer: rotated.body.credential })).body.credential, headers: { 'X-Agent-Instance': a.instance }, body: { printerIds: [a.printers.Mono] } });
  assert.deepEqual(paused.body.jobs, []);
});

test('a waiting agent is woken by a new job instead of polling', async t => {
  const { org, agent, job } = await boot(t);
  const admin = await org('kappa');
  const a = await agent(admin);
  const started = Date.now();
  const waiting = a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [a.printers.Mono], waitSeconds: 20 } });
  await new Promise(r => setTimeout(r, 400));
  await job(admin.orgId);
  const result = await waiting;
  assert.equal(result.body.jobs.length, 1);
  assert.ok(Date.now() - started < 5000, 'woken by the job, not by the 20-second wait');
});

test('an admin test print is queued for the printer and respects capability', async t => {
  const { org, agent, call } = await boot(t);
  const admin = await org('lambda');
  const a = await agent(admin, 'PC', [{ name: 'Colour', color: true, duplex: false }]);
  assert.equal((await call(`/api/v2/edu/printers/${a.printers.Colour}/test-print`, { method: 'POST', cookie: admin.cookie })).status, 201);
  const claim = (await a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [a.printers.Colour] } })).body.jobs[0];
  assert.equal(claim.options.file_name, 'SmartPrint_Diagnostic_Test.pdf');
});

test('a printer Windows reports as Offline is not offered work, even though its agent is alive', async t => {
  const { org, agent, job, call, db } = await boot(t);
  const admin = await org('offlineprinter');
  const a = await agent(admin, 'PC', [{ name: 'Mono', color: false, duplex: false, status: 'Offline' }]);
  await assert.rejects(() => job(admin.orgId), /No online printer/, 'refused at submit: nothing could print it');
  const listed = (await call('/api/v2/edu/printers', { cookie: admin.cookie })).body[0];
  assert.equal(listed.online, false);
  // It comes back: the next report says Ready and work flows again.
  await a.call('/api/agent/v2/printers/report', { method: 'POST', body: { printers: [{ name: 'Mono', color: false, duplex: false, status: 'Ready' }] } });
  const jobId = await job(admin.orgId);
  const claimJobs = async () => (await a.call('/api/agent/v2/jobs/claim', { method: 'POST', body: { printerIds: [a.printers.Mono] } })).body.jobs;
  assert.equal((await claimJobs())[0].jobId, jobId);
  // And if it goes Offline while a job is waiting, the job stays queued instead of being handed to a dead printer.
  await job(admin.orgId);
  await db.query("UPDATE print_attempts SET state='completed'");
  await a.call('/api/agent/v2/printers/report', { method: 'POST', body: { printers: [{ name: 'Mono', color: false, duplex: false, status: 'Offline' }] } });
  assert.deepEqual(await claimJobs(), []);
});
